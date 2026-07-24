/**
 * Collection phase: one network pass, gathering everything the checks need.
 * Checks never touch the network — which makes them pure, testable against
 * synthetic evidence, and documentable automatically.
 *
 * No side effects on the server under test: discovery, list, and deliberately
 * invalid requests only. Never `tools/call`.
 */

import { lookup } from 'node:dns/promises';
import { connect as tlsConnect } from 'node:tls';
import {
  HEADERS,
  METHOD_DISCOVER,
  REVISION_LEGACY,
  REVISION_MODERN,
  WELL_KNOWN,
  CLIENT_INFO,
} from '../protocol.ts';
import { isJsonRpcError, isJsonRpcResult, probeGet, probeOptions, rpc } from '../transport/http.ts';
import { redactChallenge, snippet } from '../util/redact.ts';
import type { AuthEvidence, Era, HttpEvidence, RpcOutcome, ToolDef } from '../types.ts';

export interface ProbeOptions {
  token?: string;
  timeoutMs?: number;
  certWarnDays?: number;
  /** Skip the auth checks when the user already knows the server is public. */
  skipAuth?: boolean;
}

export async function probeHttp(rawUrl: string, opts: ProbeOptions = {}): Promise<HttpEvidence> {
  const url = new URL(rawUrl);
  const evidence: HttpEvidence = {
    kind: 'http',
    url: url.toString(),
    host: url.hostname,
    era: 'unknown',
    eraEvidence: 'not determined',
    auth: { tokenProvided: Boolean(opts.token) },
  };

  evidence.dns = await probeDns(url.hostname);
  evidence.tls = url.protocol === 'https:' ? await probeTls(url) : { checked: false, valid: true };

  // 1. Reachability and routing. A valid JSON-RPC request that comes back as
  //    an HTML 404 is the "missing location block" case, not a broken server.
  const first = await rpc(url.toString(), 'tools/list', {}, { token: opts.token, timeoutMs: opts.timeoutMs });
  evidence.reachable = first.networkError
    ? { status: 0, ms: first.durationMs, error: first.networkError }
    : { status: first.status, ms: first.durationMs };
  evidence.routing = describeRouting(first);

  if (first.networkError) {
    evidence.eraEvidence = `endpoint unreachable (${first.networkError})`;
    return evidence;
  }

  // 2. Era detection. This is the procedure the spec describes: try the modern
  //    request and, on a 400, inspect the body before concluding anything —
  //    modern servers use 400 for legitimate errors too.
  const era = await detectEra(url.toString(), first, opts);
  evidence.era = era.era;
  evidence.eraEvidence = era.evidence;
  evidence.negotiatedVersion = era.negotiatedVersion;
  evidence.serverInfo = era.serverInfo;
  evidence.capabilities = era.capabilities;
  if (era.sessionHeader) evidence.sessionHeaderSeen = era.sessionHeader;

  const listOutcome = era.listOutcome;

  // 3. tools/list.
  const tools = extractTools(listOutcome);
  if (tools.error) evidence.toolsListError = tools.error;
  if (tools.tools) evidence.tools = tools.tools;
  evidence.listResultMeta = extractListMeta(listOutcome);

  // 4. server/discover (modern era only: it does not exist in the legacy era).
  evidence.discover = await probeDiscover(url.toString(), opts, evidence.era);

  // 5. Routing header conformance.
  evidence.headerConformance = await probeHeaderConformance(url.toString(), opts);

  // 6. JSON-RPC validity of error responses.
  evidence.errorShape = await probeErrorShape(url.toString(), opts);

  // 7. CORS.
  evidence.cors = await probeCors(url.toString());

  // 8. Auth.
  if (!opts.skipAuth) {
    evidence.auth = await probeAuth(url, opts, evidence.auth, tools.tools?.length);
  }

  return evidence;
}

/* ------------------------------ base network ----------------------------- */

async function probeDns(hostname: string): Promise<HttpEvidence['dns']> {
  const started = performance.now();
  try {
    const results = await lookup(hostname, { all: true });
    return { addresses: results.map((r) => r.address), ms: Math.round(performance.now() - started) };
  } catch (err) {
    return {
      addresses: [],
      ms: Math.round(performance.now() - started),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function probeTls(url: URL): Promise<HttpEvidence['tls']> {
  const port = url.port ? Number(url.port) : 443;
  return new Promise((resolve) => {
    const socket = tlsConnect(
      { host: url.hostname, port, servername: url.hostname, rejectUnauthorized: false, timeout: 8_000 },
      () => {
        const cert = socket.getPeerCertificate();
        const authorized = socket.authorized;
        const authError = socket.authorizationError;
        const validTo = cert && cert.valid_to ? cert.valid_to : undefined;
        const daysToExpiry = validTo
          ? Math.floor((new Date(validTo).getTime() - Date.now()) / 86_400_000)
          : undefined;
        socket.end();
        resolve({
          checked: true,
          valid: authorized,
          issuer: first(cert?.issuer?.O) ?? first(cert?.issuer?.CN),
          subject: first(cert?.subject?.CN),
          validTo,
          daysToExpiry,
          error: authorized ? undefined : String(authError ?? 'invalid certificate'),
        });
      },
    );
    socket.on('timeout', () => {
      socket.destroy();
      resolve({ checked: true, valid: false, error: 'timeout during the TLS handshake' });
    });
    socket.on('error', (err) => {
      resolve({ checked: true, valid: false, error: err.message });
    });
  });
}

/** Certificate fields may be a string or an array depending on the certificate. */
function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function describeRouting(outcome: RpcOutcome): HttpEvidence['routing'] {
  const contentType = outcome.headers['content-type'];
  const body = snippet(outcome.bodyText, 160);
  const looksLikeProxy404 =
    outcome.status === 404 &&
    (contentType?.includes('text/html') === true ||
      /nginx|apache|cloudflare|not found/i.test(outcome.bodyText.slice(0, 400)));
  return { status: outcome.status, contentType, bodySnippet: body, looksLikeProxy404 };
}

/* ------------------------------ era detection ---------------------------- */

interface EraDetection {
  era: Era;
  evidence: string;
  negotiatedVersion?: string;
  serverInfo?: { name?: string; version?: string };
  capabilities?: Record<string, unknown>;
  sessionHeader?: string;
  listOutcome?: RpcOutcome;
}

export async function detectEra(url: string, modernAttempt: RpcOutcome, opts: ProbeOptions): Promise<EraDetection> {
  // The easy case: the modern, handshake-free request just worked.
  if (modernAttempt.status === 200 && isJsonRpcResult(modernAttempt.json)) {
    return {
      era: 'modern',
      evidence: 'self-contained tools/list accepted with no handshake',
      negotiatedVersion: modernAttempt.headers[HEADERS.protocolVersion.toLowerCase()] ?? REVISION_MODERN,
      listOutcome: modernAttempt,
    };
  }

  // The interesting case: a 400. It may mean "I'm legacy and don't understand
  // you", or "I'm modern and your request is wrong for a specific reason".
  if (modernAttempt.status === 400 && isJsonRpcError(modernAttempt.json)) {
    const message = String(modernAttempt.json.error.message ?? '').toLowerCase();
    const modernRejection = /unsupported protocol version|protocol version|capabilit|not supported/i.test(message);
    if (modernRejection) {
      return {
        era: 'modern',
        evidence: `400 carrying a JSON-RPC negotiation error: "${snippet(String(modernAttempt.json.error.message), 80)}"`,
        listOutcome: modernAttempt,
      };
    }
  }

  // Fallback: legacy-style handshake.
  const init = await rpc(
    url,
    'initialize',
    {
      protocolVersion: REVISION_LEGACY,
      capabilities: {},
      clientInfo: { ...CLIENT_INFO },
    },
    {
      token: opts.token,
      timeoutMs: opts.timeoutMs,
      modernHeaders: false,
      meta: false,
      protocolVersion: REVISION_LEGACY,
    },
  );

  if (init.status === 200 && isJsonRpcResult(init.json)) {
    const result = init.json.result as {
      protocolVersion?: string;
      serverInfo?: { name?: string; version?: string };
      capabilities?: Record<string, unknown>;
    };
    const sessionHeader = init.headers[HEADERS.session.toLowerCase()];
    const listOutcome = await rpc(url, 'tools/list', {}, {
      token: opts.token,
      timeoutMs: opts.timeoutMs,
      modernHeaders: false,
      meta: false,
      protocolVersion: result.protocolVersion ?? REVISION_LEGACY,
      headers: sessionHeader ? { [HEADERS.session]: sessionHeader } : undefined,
    });
    return {
      era: 'legacy',
      evidence: 'initialize handshake accepted',
      negotiatedVersion: result.protocolVersion ?? REVISION_LEGACY,
      serverInfo: result.serverInfo,
      capabilities: result.capabilities,
      sessionHeader,
      listOutcome,
    };
  }

  return {
    era: 'unknown',
    evidence:
      modernAttempt.status === 0
        ? `no usable response (${modernAttempt.networkError ?? 'network error'})`
        : `neither a self-contained request nor initialize was accepted (HTTP ${modernAttempt.status} / ${init.status})`,
    listOutcome: modernAttempt.status !== 0 ? modernAttempt : undefined,
  };
}

/* -------------------------------- tools/list ----------------------------- */

export function extractTools(outcome: RpcOutcome | undefined): { tools?: ToolDef[]; error?: string } {
  if (!outcome) return { error: 'tools/list was not attempted' };
  if (outcome.networkError) return { error: outcome.networkError };
  if (outcome.status === 401 || outcome.status === 403) {
    return { error: `HTTP ${outcome.status}: authentication required` };
  }
  if (!isJsonRpcResult(outcome.json)) {
    if (isJsonRpcError(outcome.json)) {
      return {
        error: `JSON-RPC error ${outcome.json.error.code}: ${snippet(String(outcome.json.error.message), 100)}`,
      };
    }
    return { error: `response is not JSON-RPC (HTTP ${outcome.status})` };
  }
  const tools = (outcome.json.result as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) return { error: 'result.tools missing or not an array' };
  return { tools: tools as ToolDef[] };
}

export function extractListMeta(outcome: RpcOutcome | undefined): HttpEvidence['listResultMeta'] {
  if (!outcome || !isJsonRpcResult(outcome.json)) return undefined;
  const result = outcome.json.result as Record<string, unknown>;
  const meta = (result._meta ?? {}) as Record<string, unknown>;
  return {
    ttlMs: result.ttlMs ?? meta.ttlMs,
    cacheScope: result.cacheScope ?? meta.cacheScope,
  };
}

/* ------------------------------ server/discover -------------------------- */

async function probeDiscover(url: string, opts: ProbeOptions, era: Era): Promise<HttpEvidence['discover']> {
  if (era !== 'modern') {
    return { supported: false, toolNames: [], error: 'method introduced in 2026-07-28' };
  }
  const outcome = await rpc(url, METHOD_DISCOVER, {}, { token: opts.token, timeoutMs: opts.timeoutMs });
  if (outcome.networkError) return { supported: false, toolNames: [], error: outcome.networkError };
  if (!isJsonRpcResult(outcome.json)) {
    const reason = isJsonRpcError(outcome.json) ? `JSON-RPC error ${outcome.json.error.code}` : `HTTP ${outcome.status}`;
    return { supported: false, toolNames: [], error: reason };
  }
  return { supported: true, toolNames: discoverToolNames(outcome.json.result), raw: outcome.json.result };
}

export function discoverToolNames(result: unknown): string[] {
  if (typeof result !== 'object' || result === null) return [];
  const record = result as Record<string, unknown>;
  const candidates = [record.tools, (record.capabilities as Record<string, unknown> | undefined)?.tools];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate
        .map((entry) => (typeof entry === 'string' ? entry : (entry as { name?: unknown } | null)?.name))
        .filter((n): n is string => typeof n === 'string');
    }
  }
  return [];
}

/* ---------------------------- header conformance -------------------------- */

async function probeHeaderConformance(url: string, opts: ProbeOptions): Promise<HttpEvidence['headerConformance']> {
  const withoutMethodHeader = await rpc(url, 'tools/list', {}, {
    token: opts.token,
    timeoutMs: opts.timeoutMs,
    modernHeaders: false,
  });
  const withName = await rpc(url, 'tools/list', {}, {
    token: opts.token,
    timeoutMs: opts.timeoutMs,
    targetName: 'tools/list',
  });
  return {
    acceptsWithoutMcpMethod: withoutMethodHeader.status === 200 && isJsonRpcResult(withoutMethodHeader.json),
    echoesMcpName: Boolean(withName.headers[HEADERS.name.toLowerCase()]),
  };
}

/* --------------------- JSON-RPC validity of error paths ------------------- */

async function probeErrorShape(url: string, opts: ProbeOptions): Promise<HttpEvidence['errorShape']> {
  // A method that cannot possibly exist: the response must be a well-formed
  // JSON-RPC error, not a 500 with an HTML stack trace.
  const outcome = await rpc(url, 'mcpDoctor/thisMethodDoesNotExist', {}, {
    token: opts.token,
    timeoutMs: opts.timeoutMs,
  });
  if (outcome.networkError) {
    return { checked: false, valid: false, detail: outcome.networkError };
  }
  if (!isJsonRpcError(outcome.json)) {
    return {
      checked: true,
      valid: false,
      detail: `HTTP ${outcome.status}, body: ${snippet(outcome.bodyText, 80) || '(empty)'}`,
    };
  }
  const { code, message } = outcome.json.error;
  const valid = typeof code === 'number' && typeof message === 'string' && message.length > 0;
  return {
    checked: true,
    valid,
    detail: valid ? `code ${code}` : 'code/message fields missing or of the wrong type',
  };
}

/* ---------------------------------- CORS --------------------------------- */

async function probeCors(url: string): Promise<HttpEvidence['cors']> {
  const outcome = await probeOptions(url, 'https://claude.ai');
  return {
    checked: !outcome.networkError,
    status: outcome.status,
    allowOrigin: outcome.headers['access-control-allow-origin'],
    allowHeaders: outcome.headers['access-control-allow-headers'],
    allowMethods: outcome.headers['access-control-allow-methods'],
  };
}

/* ---------------------------------- auth --------------------------------- */

async function probeAuth(
  url: URL,
  opts: ProbeOptions,
  base: AuthEvidence,
  toolCount: number | undefined,
): Promise<AuthEvidence> {
  const auth: AuthEvidence = { ...base };
  const origin = url.origin;

  // The OAuth 2.0 Protected Resource Metadata spec puts the resource path in
  // the suffix; many servers only expose the root form. Try both.
  const candidates = [
    `${origin}${WELL_KNOWN.protectedResource}${url.pathname === '/' ? '' : url.pathname}`,
    `${origin}${WELL_KNOWN.protectedResource}`,
  ];
  for (const candidate of candidates) {
    const res = await probeGet(candidate, { timeoutMs: opts.timeoutMs });
    const body = res.json as { authorization_servers?: unknown; scopes_supported?: unknown } | undefined;
    const ok = res.status === 200 && typeof body === 'object' && body !== null;
    auth.protectedResourceMetadata = {
      url: candidate,
      status: res.status,
      ok,
      authorizationServers: Array.isArray(body?.authorization_servers)
        ? body.authorization_servers.filter((v): v is string => typeof v === 'string')
        : undefined,
      scopesSupported: Array.isArray(body?.scopes_supported)
        ? body.scopes_supported.filter((v): v is string => typeof v === 'string')
        : undefined,
    };
    if (ok) break;
  }

  const issuer = auth.protectedResourceMetadata?.authorizationServers?.[0];
  if (issuer) {
    const metaUrl = `${issuer.replace(/\/$/, '')}${WELL_KNOWN.authorizationServer}`;
    const res = await probeGet(metaUrl, { timeoutMs: opts.timeoutMs });
    auth.authorizationServerMetadata = { url: metaUrl, status: res.status, ok: res.status === 200 };
  }

  // A deliberately credential-free request: how does the server answer?
  const anonymous = await rpc(url.toString(), 'tools/list', {}, { timeoutMs: opts.timeoutMs });
  if (anonymous.status === 401) {
    const challenge = redactChallenge(anonymous.headers['www-authenticate']);
    auth.challenge = {
      status: 401,
      wwwAuthenticate: challenge,
      wellFormed: Boolean(challenge && /^\s*bearer\b/i.test(challenge)),
    };
    auth.requiredScopes = parseScopes(challenge);
  } else {
    auth.challenge = { status: anonymous.status, wellFormed: false };
    const listed = extractTools(anonymous);
    auth.unauthenticated = {
      status: anonymous.status,
      allowed: Boolean(listed.tools),
      toolCount: listed.tools?.length ?? toolCount,
    };
  }

  return auth;
}

export function parseScopes(challenge: string | undefined): string[] | undefined {
  if (!challenge) return undefined;
  const match = /scope\s*=\s*"([^"]*)"/i.exec(challenge);
  if (!match?.[1]) return undefined;
  return match[1].split(/\s+/).filter(Boolean);
}
