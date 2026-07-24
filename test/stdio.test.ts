import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { probeStdio } from '../src/probe/stdio-probe.ts';
import { buildReport } from '../src/commands/check.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => join(here, 'fixtures', name);

test('logging to stdout: the silent killer gets named', async () => {
  const evidence = await probeStdio(process.execPath, [fixture('stdio-noisy.js')], { timeoutMs: 4000 });
  assert.ok(evidence.stdoutNonJsonLines.length > 0);
  const report = buildReport(evidence, DEFAULT_CONFIG, {});
  const purity = report.results.find((r) => r.id === 'stdio.stdout-purity');
  assert.ok(purity);
  assert.equal(purity.status, 'fail');
  assert.equal(purity.severity, 'error');
  assert.match(purity.remediation ?? '', /stderr/);
  assert.equal(report.exitCode, 2);
});

test('clean stdio server: stdout stays pure and the tools are valid', async () => {
  const evidence = await probeStdio(process.execPath, [fixture('stdio-clean.js')], { timeoutMs: 4000 });
  assert.deepEqual(evidence.stdoutNonJsonLines, []);
  assert.equal(evidence.era, 'modern');
  assert.equal(evidence.tools?.length, 1);
  const report = buildReport(evidence, DEFAULT_CONFIG, {});
  assert.equal(report.summary.errors, 0, JSON.stringify(report.results.filter((r) => r.status === 'fail'), null, 2));
});

test('process that exits immediately: exit code reported with the first stderr line', async () => {
  const evidence = await probeStdio(process.execPath, [fixture('stdio-crash.js')], { timeoutMs: 3000 });
  assert.equal(evidence.exitCode, 1);
  const report = buildReport(evidence, DEFAULT_CONFIG, {});
  const startup = report.results.find((r) => r.id === 'stdio.startup');
  assert.ok(startup);
  assert.equal(startup.status, 'fail');
  assert.match(startup.remediation ?? '', /DATABASE_URL/);
});

test('nonexistent command: a clear error, no crash', async () => {
  const evidence = await probeStdio('this-command-really-does-not-exist', [], { timeoutMs: 2000 });
  const report = buildReport(evidence, DEFAULT_CONFIG, {});
  const startup = report.results.find((r) => r.id === 'stdio.startup');
  assert.ok(startup);
  assert.equal(startup.status, 'fail');
});
