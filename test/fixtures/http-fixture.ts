/**
 * Fixture MCP servers that get things wrong on purpose, one per failure mode.
 * These are the most valuable part of the suite: every bug mcp-doctor claims
 * to diagnose should have a server here that reproduces it.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { HEADERS, METHOD_DISCOVER, REVISION_LEGACY, REVISION_MODERN } from '../../src/protocol.ts';

export type FixtureMode =
  | 'modern-clean'
  | 'legacy'
  | 'proxy-404'
  | 'broken-tools'
  | 'auth-required'
  | 'auth-declared-not-enforced'
  | 'bad-error-shape';

export interface Fixture {
  url: string;
  origin: string;
  close(): Promise<void>;
}

const CLEAN_TOOLS = [
  {
    name: 'search_docs',
    description: 'Search the indexed documentation and return the relevant passages.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    outputSchema: { type: 'object', properties: { passages: { type: 'array' } } },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: 'create_item',
    description: 'Create a new item in the collection named by the caller.',
    inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
    outputSchema: { type: 'object', properties: { id: { type: 'string' } } },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
];

const BROKEN_TOOLS = [
  { name: 'search', description: 'Search.', inputSchema: { type: 'object', properties: {} } },
  { name: 'search', inputSchema: { type: 'object', properties: {} } },
  { name: 'get item', description: '', inputSchema: 'not-a-schema' },
  { name: 'list_all', inputSchema: { type: 'object', properties: { a: { type: 'string' } }, required: ['b'] } },
];

export async function startFixture(mode: FixtureMode): Promise<Fixture> {
  const sessions = new Set<string>();

  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      res.writeHead(500).end('boom');
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers': `content-type, ${HEADERS.protocolVersion}`,
      });
      res.end();
      return;
    }

    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      if (mode === 'auth-required' || mode === 'auth-declared-not-enforced') {
        json(res, 200, {
          resource: `http://${req.headers.host}/mcp`,
          authorization_servers: [`http://${req.headers.host}/auth`],
          scopes_supported: ['mcp:read'],
        });
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }

    if (url.pathname === '/auth/.well-known/oauth-authorization-server') {
      json(res, 200, { issuer: `http://${req.headers.host}/auth`, token_endpoint: `http://${req.headers.host}/auth/token` });
      return;
    }

    if (mode === 'proxy-404') {
      res
        .writeHead(404, { 'content-type': 'text/html', server: 'nginx/1.24.0' })
        .end('<html><head><title>404 Not Found</title></head><body><h1>404 Not Found</h1><hr>nginx</body></html>');
      return;
    }

    if (url.pathname !== '/mcp') {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }

    const authorized = String(req.headers.authorization ?? '').startsWith('Bearer ');
    if (mode === 'auth-required' && !authorized) {
      res
        .writeHead(401, {
          'www-authenticate': `Bearer resource_metadata="http://${req.headers.host}/.well-known/oauth-protected-resource", scope="mcp:read"`,
        })
        .end();
      return;
    }

    const body = await readBody(req);
    const message = safeParse(body);
    if (!message || typeof message !== 'object') {
      json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    const { id, method } = message as { id?: unknown; method?: string };

    if (mode === 'legacy') {
      await handleLegacy(req, res, id, method);
      return;
    }

    switch (method) {
      case 'initialize':
        json(res, 400, { jsonrpc: '2.0', id, error: { code: -32601, message: 'handshake removed in 2026-07-28' } });
        return;
      case 'tools/list': {
        const headers: Record<string, string> = { [HEADERS.protocolVersion]: REVISION_MODERN };
        const name = req.headers[HEADERS.name.toLowerCase()];
        if (typeof name === 'string') headers[HEADERS.name] = name;
        const tools = mode === 'broken-tools' ? BROKEN_TOOLS : CLEAN_TOOLS;
        const result: Record<string, unknown> = { tools };
        if (mode === 'modern-clean' || mode === 'auth-required') {
          result.ttlMs = 300_000;
          result.cacheScope = 'server';
        }
        json(res, 200, { jsonrpc: '2.0', id, result }, headers);
        return;
      }
      case METHOD_DISCOVER:
        if (mode === 'broken-tools') {
          // discover advertises a tool tools/list never exposes: inconsistent.
          json(res, 200, { jsonrpc: '2.0', id, result: { tools: ['search', 'ghost_tool'] } });
          return;
        }
        json(res, 200, {
          jsonrpc: '2.0',
          id,
          result: { protocolVersion: REVISION_MODERN, tools: CLEAN_TOOLS.map((t) => ({ name: t.name })) },
        });
        return;
      default:
        if (mode === 'bad-error-shape') {
          res.writeHead(500, { 'content-type': 'text/html' }).end('<html><body>Internal Server Error</body></html>');
          return;
        }
        json(res, 200, { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${String(method)}` } });
    }
  }

  async function handleLegacy(req: IncomingMessage, res: ServerResponse, id: unknown, method: string | undefined) {
    if (method === 'initialize') {
      const sessionId = `sess-${sessions.size + 1}`;
      sessions.add(sessionId);
      json(
        res,
        200,
        {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: REVISION_LEGACY,
            capabilities: { tools: {} },
            serverInfo: { name: 'fixture-legacy', version: '1.0.0' },
          },
        },
        { [HEADERS.session]: sessionId },
      );
      return;
    }
    // A legacy server serves nothing without an initialized session: this is
    // exactly what breaks modern clients, which no longer do the handshake.
    const sessionId = req.headers[HEADERS.session.toLowerCase()];
    if (typeof sessionId !== 'string' || !sessions.has(sessionId)) {
      json(res, 400, { jsonrpc: '2.0', id, error: { code: -32600, message: 'Server not initialized' } });
      return;
    }
    if (method === 'tools/list') {
      json(res, 200, { jsonrpc: '2.0', id, result: { tools: CLEAN_TOOLS } });
      return;
    }
    json(res, 200, { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
  }

  const port = await listen(server);
  const origin = `http://127.0.0.1:${port}`;
  return {
    url: `${origin}${mode === 'proxy-404' ? '/mcp' : '/mcp'}`,
    origin,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

function json(res: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(payload));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      data += chunk;
    });
    req.on('end', () => resolve(data));
  });
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address !== null ? address.port : 0);
    });
  });
}
