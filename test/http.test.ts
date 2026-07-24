/** End-to-end tests against fixture servers that get things wrong on purpose. */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startFixture } from './fixtures/http-fixture.ts';
import { probeHttp } from '../src/probe/http-probe.ts';
import { buildReport } from '../src/commands/check.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { buildMigrationReport } from '../src/commands/migrate.ts';
import type { CheckResult } from '../src/types.ts';

function find(results: CheckResult[], id: string): CheckResult {
  const found = results.find((r) => r.id === id);
  assert.ok(found, `check ${id} missing`);
  return found;
}

test('clean modern server: no errors', async () => {
  const fixture = await startFixture('modern-clean');
  try {
    const evidence = await probeHttp(fixture.url, { timeoutMs: 4000 });
    assert.equal(evidence.era, 'modern');
    const report = buildReport(evidence, DEFAULT_CONFIG, {});
    assert.equal(report.summary.errors, 0, JSON.stringify(report.results.filter((r) => r.status === 'fail'), null, 2));
    assert.equal(report.exitCode, 0);
  } finally {
    await fixture.close();
  }
});

test('legacy server: era detected, no false errors about 2026-07-28 methods', async () => {
  const fixture = await startFixture('legacy');
  try {
    const evidence = await probeHttp(fixture.url, { timeoutMs: 4000 });
    assert.equal(evidence.era, 'legacy');
    assert.equal(evidence.negotiatedVersion, '2025-11-25');
    assert.ok(evidence.sessionHeaderSeen, 'the legacy session must be observed');
    const report = buildReport(evidence, DEFAULT_CONFIG, {});
    assert.equal(find(report.results, 'protocol.discover').status, 'skip');
    assert.equal(report.summary.errors, 0);
  } finally {
    await fixture.close();
  }
});

test('reverse proxy with no location block: a specific diagnosis, not "failed to connect"', async () => {
  const fixture = await startFixture('proxy-404');
  try {
    const evidence = await probeHttp(fixture.url, { timeoutMs: 4000 });
    const report = buildReport(evidence, DEFAULT_CONFIG, {});
    const routing = find(report.results, 'transport.path-routing');
    assert.equal(routing.status, 'fail');
    assert.match(routing.remediation ?? '', /location block/);
    assert.equal(report.exitCode, 2);
  } finally {
    await fixture.close();
  }
});

test('broken tools: duplicates, invalid schema, missing descriptions', async () => {
  const fixture = await startFixture('broken-tools');
  try {
    const evidence = await probeHttp(fixture.url, { timeoutMs: 4000 });
    const report = buildReport(evidence, DEFAULT_CONFIG, {});
    assert.equal(find(report.results, 'tools.names').status, 'fail');
    assert.equal(find(report.results, 'tools.list').status, 'fail');
    assert.equal(find(report.results, 'tools.descriptions').status, 'fail');
    assert.equal(find(report.results, 'protocol.discover').status, 'fail');
    assert.ok(report.summary.errors >= 2);
  } finally {
    await fixture.close();
  }
});

test('protected server: the 401 and the OAuth metadata are recognised', async () => {
  const fixture = await startFixture('auth-required');
  try {
    const evidence = await probeHttp(fixture.url, { token: 'test-token', timeoutMs: 4000 });
    assert.equal(evidence.auth.challenge?.status, 401);
    assert.equal(evidence.auth.challenge?.wellFormed, true);
    assert.deepEqual(evidence.auth.requiredScopes, ['mcp:read']);
    const report = buildReport(evidence, DEFAULT_CONFIG, {});
    assert.equal(find(report.results, 'auth.challenge').status, 'pass');
    assert.equal(find(report.results, 'auth.protected-resource-metadata').status, 'pass');
    assert.equal(find(report.results, 'auth.scopes').status, 'pass');
  } finally {
    await fixture.close();
  }
});

test('OAuth advertised but not enforced: a security error', async () => {
  const fixture = await startFixture('auth-declared-not-enforced');
  try {
    const evidence = await probeHttp(fixture.url, { timeoutMs: 4000 });
    const report = buildReport(evidence, DEFAULT_CONFIG, {});
    const anon = find(report.results, 'auth.unauthenticated-access');
    assert.equal(anon.status, 'fail');
    assert.equal(anon.severity, 'error');
  } finally {
    await fixture.close();
  }
});

test('non-JSON-RPC error response: caught', async () => {
  const fixture = await startFixture('bad-error-shape');
  try {
    const evidence = await probeHttp(fixture.url, { timeoutMs: 4000 });
    const report = buildReport(evidence, DEFAULT_CONFIG, {});
    assert.equal(find(report.results, 'protocol.error-shape').status, 'fail');
  } finally {
    await fixture.close();
  }
});

test('migrate on a legacy server lists handshake, sessions and discover', async () => {
  const fixture = await startFixture('legacy');
  try {
    const evidence = await probeHttp(fixture.url, { timeoutMs: 4000 });
    const migration = buildMigrationReport(evidence);
    assert.equal(migration.currentEra, 'legacy');
    assert.equal(migration.compatibleWithModernClients, false);
    const todo = migration.items.filter((i) => !i.done).map((i) => i.id);
    assert.ok(todo.includes('handshake'));
    assert.ok(todo.includes('sessions'));
    assert.ok(todo.includes('discover'));
    assert.equal(migration.exitCode, 2);
  } finally {
    await fixture.close();
  }
});

test('migrate on a clean modern server says there is nothing to do', async () => {
  const fixture = await startFixture('modern-clean');
  try {
    const evidence = await probeHttp(fixture.url, { timeoutMs: 4000 });
    const migration = buildMigrationReport(evidence);
    assert.equal(migration.compatibleWithModernClients, true);
    assert.equal(migration.effort, 'none');
    assert.equal(migration.exitCode, 0);
  } finally {
    await fixture.close();
  }
});
