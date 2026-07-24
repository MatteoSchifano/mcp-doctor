import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runChecks, summarize, exitCodeFor, ALL_CHECKS } from '../src/checks/index.ts';
import { DEFAULT_CONFIG, isDisabled, mergeConfig } from '../src/config.ts';
import { REVISION_MODERN, compareRevisions, eraOfRevision } from '../src/protocol.ts';
import type { CheckResult, HttpEvidence } from '../src/types.ts';

function baseEvidence(overrides: Partial<HttpEvidence> = {}): HttpEvidence {
  return {
    kind: 'http',
    url: 'https://mcp.example.com/mcp',
    host: 'mcp.example.com',
    era: 'modern',
    eraEvidence: 'synthetic',
    negotiatedVersion: REVISION_MODERN,
    dns: { addresses: ['1.2.3.4'], ms: 10 },
    tls: { checked: true, valid: true, daysToExpiry: 61, validTo: '2026-09-01' },
    reachable: { status: 200, ms: 84 },
    routing: { status: 200, contentType: 'application/json', bodySnippet: '{}', looksLikeProxy404: false },
    headerConformance: { acceptsWithoutMcpMethod: false, echoesMcpName: true },
    discover: { supported: true, toolNames: ['search_docs'] },
    tools: [
      {
        name: 'search_docs',
        description: 'Search the indexed documentation and return the relevant passages.',
        inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
        outputSchema: { type: 'object' },
        annotations: { readOnlyHint: true },
      },
    ],
    listResultMeta: { ttlMs: 300_000, cacheScope: 'server' },
    errorShape: { checked: true, valid: true, detail: 'code -32601' },
    cors: { checked: true, status: 204, allowOrigin: '*' },
    auth: {
      tokenProvided: false,
      protectedResourceMetadata: {
        url: 'https://mcp.example.com/.well-known/oauth-protected-resource',
        status: 200,
        ok: true,
        authorizationServers: ['https://auth.example.com'],
        scopesSupported: ['mcp:read'],
      },
      authorizationServerMetadata: {
        url: 'https://auth.example.com/.well-known/oauth-authorization-server',
        status: 200,
        ok: true,
      },
      challenge: { status: 401, wwwAuthenticate: 'Bearer scope="mcp:read"', wellFormed: true },
      requiredScopes: ['mcp:read'],
    },
    ...overrides,
  };
}

function run(evidence: HttpEvidence): CheckResult[] {
  return runChecks({ evidence, config: DEFAULT_CONFIG, targetRevision: REVISION_MODERN });
}

function byId(results: CheckResult[], id: string): CheckResult {
  const found = results.find((r) => r.id === id);
  assert.ok(found, `check ${id} missing from the results`);
  return found;
}

test('a healthy server produces neither errors nor warnings', () => {
  const results = run(baseEvidence());
  const summary = summarize(results);
  assert.equal(summary.errors, 0, JSON.stringify(results.filter((r) => r.status === 'fail'), null, 2));
  assert.equal(summary.warnings, 0);
  assert.equal(exitCodeFor(summary, true), 0);
});

test('the reverse-proxy 404 is told apart from an application 404', () => {
  const results = run(
    baseEvidence({
      routing: { status: 404, contentType: 'text/html', bodySnippet: '404 Not Found nginx', looksLikeProxy404: true },
    }),
  );
  const routing = byId(results, 'transport.path-routing');
  assert.equal(routing.status, 'fail');
  assert.match(routing.detail ?? '', /reverse proxy/);
  assert.match(routing.remediation ?? '', /location block/);
});

test('duplicate tool names are an error, not a warning', () => {
  const results = run(
    baseEvidence({
      tools: [
        { name: 'search', description: 'Search things in the indexed documentation.', inputSchema: { type: 'object' } },
        { name: 'search', description: 'Another tool with the exact same name, and nobody notices.', inputSchema: { type: 'object' } },
      ],
    }),
  );
  const names = byId(results, 'tools.names');
  assert.equal(names.status, 'fail');
  assert.equal(names.severity, 'error');
  assert.match(names.detail ?? '', /duplicate/);
});

test('an invalid inputSchema is an error naming the offending tools', () => {
  const results = run(
    baseEvidence({
      tools: [
        { name: 'ok_tool', description: 'A perfectly fine, well-described tool.', inputSchema: { type: 'object' } },
        { name: 'bad_tool', description: 'Invalid schema, the client cannot validate arguments.', inputSchema: 'string' },
      ],
    }),
  );
  const list = byId(results, 'tools.list');
  assert.equal(list.status, 'fail');
  assert.equal(list.severity, 'error');
  assert.match(list.remediation ?? '', /bad_tool/);
});

test('a required list naming nonexistent fields is caught', () => {
  const results = run(
    baseEvidence({
      tools: [
        {
          name: 'list_all',
          description: 'List every item available in the collection.',
          inputSchema: { type: 'object', properties: { a: { type: 'string' } }, required: ['b'] },
        },
      ],
    }),
  );
  assert.equal(byId(results, 'tools.list').status, 'fail');
});

test('missing descriptions are a warning and name the tools', () => {
  const results = run(
    baseEvidence({
      tools: [
        { name: 'search_docs', inputSchema: { type: 'object' } },
        { name: 'get_item', inputSchema: { type: 'object' } },
      ],
    }),
  );
  const descriptions = byId(results, 'tools.descriptions');
  assert.equal(descriptions.status, 'fail');
  assert.equal(descriptions.severity, 'warn');
  assert.match(descriptions.remediation ?? '', /search_docs/);
  assert.match(descriptions.remediation ?? '', /get_item/);
});

test('quality checks can be disabled individually and by category', () => {
  const config = mergeConfig({ disabled: ['tools.descriptions'] });
  assert.equal(isDisabled(config, 'tools.descriptions'), true);
  assert.equal(isDisabled(config, 'tools.names'), false);
  assert.equal(isDisabled(mergeConfig({ disabled: ['tools.*'] }), 'tools.names'), true);

  const evidence = baseEvidence({ tools: [{ name: 'x', inputSchema: { type: 'object' } }] });
  const results = runChecks({ evidence, config, targetRevision: REVISION_MODERN });
  assert.equal(results.some((r) => r.id === 'tools.descriptions'), false);
});

test('missing OAuth discovery is an error on a protected server', () => {
  const evidence = baseEvidence();
  evidence.auth.protectedResourceMetadata = {
    url: 'https://mcp.example.com/.well-known/oauth-protected-resource',
    status: 404,
    ok: false,
  };
  const discovery = byId(run(evidence), 'auth.protected-resource-metadata');
  assert.equal(discovery.status, 'fail');
  assert.equal(discovery.severity, 'error');
  assert.match(discovery.remediation ?? '', /metadata document/);
});

test('missing OAuth discovery is not a problem on a knowingly public server', () => {
  const evidence = baseEvidence();
  evidence.auth.protectedResourceMetadata = { url: 'x', status: 404, ok: false };
  evidence.auth.challenge = { status: 200, wellFormed: false };
  evidence.auth.unauthenticated = { status: 200, allowed: true, toolCount: 1 };
  const discovery = byId(run(evidence), 'auth.protected-resource-metadata');
  assert.equal(discovery.status, 'pass');
});

test('a server that advertises OAuth but does not enforce it is an error', () => {
  const evidence = baseEvidence();
  evidence.auth.challenge = { status: 200, wellFormed: false };
  evidence.auth.unauthenticated = { status: 200, allowed: true, toolCount: 12 };
  const anon = byId(run(evidence), 'auth.unauthenticated-access');
  assert.equal(anon.status, 'fail');
  assert.equal(anon.severity, 'error');
});

test('a legacy server stays usable but is flagged as incompatible', () => {
  const results = run(
    baseEvidence({ era: 'legacy', negotiatedVersion: '2025-11-25', discover: { supported: false, toolNames: [] } }),
  );
  const era = byId(results, 'protocol.era');
  assert.equal(era.severity, 'info');
  assert.match(era.remediation ?? '', /migrate/);
  // Revision-specific checks must not fire false errors on a legacy server.
  assert.equal(byId(results, 'protocol.discover').status, 'skip');
  assert.equal(byId(results, 'cache.list-hints').status, 'skip');
  assert.equal(summarize(results).errors, 0);
});

test('discover inconsistent with tools/list warns and lists the delta', () => {
  const results = run(baseEvidence({ discover: { supported: true, toolNames: ['search_docs', 'ghost_tool'] } }));
  const discover = byId(results, 'protocol.discover');
  assert.equal(discover.status, 'fail');
  assert.deepEqual((discover.data as { onlyInDiscover: string[] }).onlyInDiscover, ['ghost_tool']);
});

test('non-JSON-RPC error responses are a protocol error', () => {
  const results = run(
    baseEvidence({ errorShape: { checked: true, valid: false, detail: 'HTTP 500, body: Internal Server Error' } }),
  );
  const shape = byId(results, 'protocol.error-shape');
  assert.equal(shape.status, 'fail');
  assert.equal(shape.severity, 'error');
});

test('an expiring certificate warns; an expired one warns with different wording', () => {
  const soon = byId(run(baseEvidence({ tls: { checked: true, valid: true, daysToExpiry: 5 } })), 'transport.dns-tls');
  assert.equal(soon.severity, 'warn');
  assert.match(soon.detail ?? '', /expires in 5 days/);

  const expired = byId(run(baseEvidence({ tls: { checked: true, valid: true, daysToExpiry: -2 } })), 'transport.dns-tls');
  assert.match(expired.detail ?? '', /expired/);
});

test('exit codes follow the severity table', () => {
  assert.equal(exitCodeFor({ errors: 0, warnings: 0, infos: 3, passed: 10, skipped: 0 }, false), 0);
  assert.equal(exitCodeFor({ errors: 0, warnings: 2, infos: 0, passed: 10, skipped: 0 }, false), 0);
  assert.equal(exitCodeFor({ errors: 0, warnings: 2, infos: 0, passed: 10, skipped: 0 }, true), 1);
  assert.equal(exitCodeFor({ errors: 1, warnings: 0, infos: 0, passed: 10, skipped: 0 }, false), 2);
});

test('every registered check has a unique id and a description', () => {
  const ids = new Set<string>();
  for (const check of ALL_CHECKS) {
    assert.equal(ids.has(check.id), false, `duplicate id: ${check.id}`);
    ids.add(check.id);
    assert.ok(check.description.length > 10, `${check.id} has no useful description`);
  }
});

test('every failure carries a remediation', () => {
  const evidence = baseEvidence({
    era: 'unknown',
    routing: { status: 404, contentType: 'text/html', bodySnippet: '404', looksLikeProxy404: true },
    tools: undefined,
    toolsListError: 'no response',
    discover: { supported: false, toolNames: [] },
    errorShape: { checked: true, valid: false, detail: 'HTTP 500' },
  });
  for (const result of run(evidence)) {
    if (result.status !== 'fail') continue;
    assert.ok(
      result.remediation && result.remediation.length > 20,
      `${result.id} fails without telling anyone how to fix it`,
    );
  }
});

test('the protocol helpers order revisions correctly', () => {
  assert.equal(compareRevisions('2025-11-25', '2026-07-28'), -1);
  assert.equal(compareRevisions('2026-07-28', '2026-07-28'), 0);
  assert.equal(eraOfRevision('2026-07-28'), 'modern');
  assert.equal(eraOfRevision('2025-11-25'), 'legacy');
  assert.equal(eraOfRevision('9999-01-01'), 'unknown');
});
