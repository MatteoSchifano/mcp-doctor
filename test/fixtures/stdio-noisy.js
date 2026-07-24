#!/usr/bin/env node
// Fixture: an stdio server that logs to stdout instead of stderr.
// This is the silent killer — the JSON-RPC channel gets corrupted and the
// client reports nothing but "failed to connect".

console.log('[boot] starting the MCP server…');
console.log('[boot] loaded 2 tools');

const TOOLS = [
  {
    name: 'ping',
    description: 'Returns pong. Only useful to check the transport works at all.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
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
      respond(message.id, { tools: TOOLS });
    } else if (message.method === 'initialize') {
      respond(message.id, { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'noisy', version: '0.0.1' } });
    } else {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } })}\n`);
    }
  }
});

function respond(id, result) {
  console.log('[debug] answering', id); // this one lands on stdout too
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}
