import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseArgs, catalog, usage } from '../src/cli.ts';
import { redactChallenge, redactHeaders, redactText } from '../src/util/redact.ts';
import { renderJson } from '../src/report/json.ts';
import { wrap } from '../src/report/human.ts';

test('a bare URL is shorthand for check', () => {
  const args = parseArgs(['https://mcp.example.com/mcp']);
  assert.equal(args.command, 'check');
  assert.equal(args.target, 'https://mcp.example.com/mcp');
});

test('a host with no scheme is normalised to https', () => {
  assert.equal(parseArgs(['mcp.example.com/mcp']).target, 'https://mcp.example.com/mcp');
});

test('--stdio collects the command and its arguments after the separator', () => {
  const args = parseArgs(['check', '--stdio', '--', 'node', 'dist/server.js', '--flag']);
  assert.equal(args.stdioCommand, 'node');
  assert.deepEqual(args.stdioArgs, ['dist/server.js', '--flag']);
});

test('--stdio also works without the separator', () => {
  const args = parseArgs(['check', '--stdio', 'node', 'server.js']);
  assert.equal(args.stdioCommand, 'node');
  assert.deepEqual(args.stdioArgs, ['server.js']);
});

test('the CI options are parsed', () => {
  const args = parseArgs([
    'check',
    'https://x.dev/mcp',
    '--json',
    '--strict',
    '--timeout',
    '2500',
    '--disable',
    'tools.*,cache.list-hints',
  ]);
  assert.equal(args.json, true);
  assert.equal(args.strict, true);
  assert.equal(args.timeoutMs, 2500);
  assert.deepEqual(args.disable, ['tools.*', 'cache.list-hints']);
});

test('an unknown option is an error, never silent behaviour', () => {
  assert.match(parseArgs(['check', 'https://x.dev/mcp', '--turbo']).error ?? '', /unknown option/);
});

test('with no target the parser says so', () => {
  assert.match(parseArgs(['check']).error ?? '', /URL/);
});

test('a bare --help is not mistaken for a target', () => {
  assert.equal(parseArgs(['--help']).command, 'help');
  assert.equal(parseArgs(['-h']).command, 'help');
  assert.equal(parseArgs(['--version']).command, 'version');
  assert.equal(parseArgs([]).command, 'help');
});

test('the check catalogue is generated from the registry', () => {
  const rows = catalog();
  assert.ok(rows.length >= 15);
  assert.ok(rows.every((r) => r.id.includes('.')));
  assert.match(usage(), /mcp-doctor/);
});

test('sensitive headers never leave in the clear', () => {
  const redacted = redactHeaders({ authorization: 'Bearer topsecret', 'content-type': 'application/json' });
  assert.equal(redacted.authorization, '[redacted]');
  assert.equal(redacted['content-type'], 'application/json');
});

test('tokens and JWTs are redacted out of free text', () => {
  assert.match(redactText('Authorization: Bearer abc123XYZ'), /\[redacted\]/);
  assert.match(redactText('eyJhbGciOi.eyJzdWIiOi.signature'), /\[redacted\]/);
  assert.doesNotMatch(redactText('Bearer abc123XYZ'), /abc123XYZ/);
});

test('the challenge stays readable but carries no embedded token', () => {
  const challenge = redactChallenge('Bearer realm="x", token="secret", scope="mcp:read"');
  assert.match(challenge ?? '', /scope="mcp:read"/);
  assert.doesNotMatch(challenge ?? '', /secret/);
});

test('JSON output still goes through the final redaction pass', () => {
  const json = renderJson({
    target: 'https://x.dev/mcp',
    mode: 'http',
    era: 'modern',
    results: [
      {
        id: 'x',
        category: 'auth',
        title: 'x',
        status: 'fail',
        severity: 'error',
        detail: 'Authorization: Bearer superSecret123456',
      },
    ],
    summary: { errors: 1, warnings: 0, infos: 0, passed: 0, skipped: 0 },
    exitCode: 2,
  });
  assert.doesNotMatch(json, /superSecret123456/);
});

test('remediation wrapping never breaks a word', () => {
  const lines = wrap('a remediation long enough that it has to wrap at least once somewhere', 30);
  assert.ok(lines.length > 1);
  assert.ok(lines.every((l) => l.length <= 30));
});
