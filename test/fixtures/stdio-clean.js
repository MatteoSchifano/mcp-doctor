#!/usr/bin/env node
// Fixture: a correct stdio server. Every log goes to stderr, stdout stays pure.

console.error('[boot] starting the MCP server (logs on stderr, as they should be)');

const TOOLS = [
  {
    name: 'ping',
    description: 'Returns pong. Used to verify the transport works end to end.',
    inputSchema: { type: 'object', properties: {} },
    outputSchema: { type: 'object', properties: { pong: { type: 'boolean' } } },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
];

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.id === undefined) continue;
    if (message.method === 'tools/list') {
      send(message.id, { tools: TOOLS, ttlMs: 300000, cacheScope: 'server' });
    } else if (message.method === 'server/discover') {
      send(message.id, { protocolVersion: '2026-07-28', tools: TOOLS.map((t) => ({ name: t.name })) });
    } else {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } })}\n`);
    }
  }
});

function send(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}
