#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { main } from './cli.ts';

export { main, parseArgs, usage, catalog, VERSION } from './cli.ts';
export { runCheck, buildReport, gatherEvidence } from './commands/check.ts';
export { buildMigrationReport, renderMigration } from './commands/migrate.ts';
export { ALL_CHECKS, runChecks, summarize, exitCodeFor } from './checks/index.ts';
export { probeHttp } from './probe/http-probe.ts';
export { probeStdio } from './probe/stdio-probe.ts';
export * from './types.ts';

const entry = process.argv[1];
const invokedDirectly = entry !== undefined && import.meta.url === pathToFileURL(entry).href;

if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`errore inatteso: ${err instanceof Error ? err.stack : String(err)}\n`);
      process.exitCode = 2;
    },
  );
}
