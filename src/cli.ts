/**
 * Hand-rolled argument parsing: no dependencies, because the tool has to run
 * in a minimal CI without an `npm install`.
 */

import { runCheck, gatherEvidence, type CheckOptions } from './commands/check.ts';
import { buildMigrationReport, migrationJson, renderMigration } from './commands/migrate.ts';
import { runWatch } from './commands/watch.ts';
import { renderHuman } from './report/human.ts';
import { renderJson } from './report/json.ts';
import { ALL_CHECKS } from './checks/index.ts';
import { REVISION_LEGACY, REVISION_MODERN } from './protocol.ts';
import { color } from './util/color.ts';

export const VERSION = '0.3.0';

export interface ParsedArgs {
  command: 'check' | 'migrate' | 'watch' | 'list-checks' | 'help' | 'version';
  target?: string;
  stdioCommand?: string;
  stdioArgs: string[];
  json: boolean;
  strict: boolean;
  verbose: boolean;
  skipAuth: boolean;
  token?: string;
  timeoutMs: number;
  intervalMs: number;
  maxIterations: number;
  disable: string[];
  error?: string;
}

const COMMANDS = new Set(['check', 'migrate', 'watch', 'list-checks']);

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    command: 'check',
    stdioArgs: [],
    json: false,
    strict: false,
    verbose: false,
    skipAuth: false,
    timeoutMs: 10_000,
    intervalMs: 10_000,
    maxIterations: 0,
    disable: [],
  };

  const args = [...argv];
  if (args.length === 0) return { ...parsed, command: 'help' };

  // The first token is a command only if we recognise it: `mcp-doctor <url>`
  // has to work as a shorthand for `check`.
  const first = args[0];
  if (first && COMMANDS.has(first)) {
    parsed.command = first as ParsedArgs['command'];
    args.shift();
  } else if (first === '--help' || first === '-h') {
    return { ...parsed, command: 'help' };
  } else if (first === '--version' || first === '-V') {
    return { ...parsed, command: 'version' };
  }

  let stdioMode = false;
  while (args.length > 0) {
    const arg = args.shift() as string;

    if (stdioMode) {
      if (!parsed.stdioCommand) parsed.stdioCommand = arg;
      else parsed.stdioArgs.push(arg);
      continue;
    }

    switch (arg) {
      case '--':
        stdioMode = true;
        break;
      case '--stdio':
        // `--stdio -- node server.js` and `--stdio node server.js` are equivalent.
        if (args[0] === '--') args.shift();
        stdioMode = true;
        break;
      case '--json':
        parsed.json = true;
        break;
      case '--strict':
        parsed.strict = true;
        break;
      case '--verbose':
      case '-v':
        parsed.verbose = true;
        break;
      case '--no-auth':
        parsed.skipAuth = true;
        break;
      case '--help':
      case '-h':
        return { ...parsed, command: 'help' };
      case '--version':
      case '-V':
        return { ...parsed, command: 'version' };
      case '--auth-token': {
        const value = args.shift();
        if (!value) return { ...parsed, error: '--auth-token needs a value' };
        parsed.token = value;
        break;
      }
      case '--timeout': {
        const value = Number(args.shift());
        if (!Number.isFinite(value) || value <= 0) return { ...parsed, error: '--timeout needs a number of milliseconds' };
        parsed.timeoutMs = value;
        break;
      }
      case '--interval': {
        const value = Number(args.shift());
        if (!Number.isFinite(value) || value <= 0) return { ...parsed, error: '--interval needs a number of seconds' };
        parsed.intervalMs = value * 1000;
        break;
      }
      case '--iterations': {
        const value = Number(args.shift());
        if (!Number.isFinite(value) || value < 0) return { ...parsed, error: '--iterations needs a number' };
        parsed.maxIterations = value;
        break;
      }
      case '--disable': {
        const value = args.shift();
        if (!value) return { ...parsed, error: '--disable needs a check id' };
        parsed.disable.push(...value.split(',').map((s) => s.trim()).filter(Boolean));
        break;
      }
      default:
        if (arg.startsWith('-')) return { ...parsed, error: `unknown option: ${arg}` };
        if (!parsed.target) parsed.target = normalizeUrl(arg);
        else return { ...parsed, error: `unexpected argument: ${arg}` };
    }
  }

  if (!parsed.target && !parsed.stdioCommand && parsed.command !== 'list-checks') {
    return { ...parsed, error: 'a URL is required, or --stdio -- <command>' };
  }
  return parsed;
}

function normalizeUrl(value: string): string {
  if (/^https?:\/\//i.test(value)) return value;
  return `https://${value}`;
}

function toCheckOptions(args: ParsedArgs): CheckOptions {
  return {
    target: args.target,
    stdioCommand: args.stdioCommand,
    stdioArgs: args.stdioArgs,
    token: args.token ?? process.env.MCP_DOCTOR_TOKEN,
    timeoutMs: args.timeoutMs,
    strict: args.strict,
    skipAuth: args.skipAuth,
    disable: args.disable,
  };
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);

  if (args.error) {
    process.stderr.write(`${color.red('error')}: ${args.error}\n\n${usage()}\n`);
    return 2;
  }
  if (args.command === 'help') {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (args.command === 'version') {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (args.command === 'list-checks') {
    process.stdout.write(args.json ? JSON.stringify(catalog(), null, 2) : renderCatalog());
    process.stdout.write('\n');
    return 0;
  }

  try {
    if (args.command === 'migrate') {
      const evidence = await gatherEvidence(toCheckOptions(args));
      const report = buildMigrationReport(evidence);
      process.stdout.write(args.json ? `${migrationJson(report)}\n` : renderMigration(report));
      return report.exitCode;
    }

    if (args.command === 'watch') {
      return await runWatch({
        ...toCheckOptions(args),
        intervalMs: args.intervalMs,
        maxIterations: args.maxIterations,
      });
    }

    const report = await runCheck(toCheckOptions(args));
    process.stdout.write(args.json ? `${renderJson(report)}\n` : renderHuman(report, { verbose: args.verbose }));
    return report.exitCode;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${color.red('error')}: ${message}\n`);
    return 2;
  }
}

export function catalog(): Array<{ id: string; category: string; appliesTo: string; description: string }> {
  return ALL_CHECKS.map((c) => ({
    id: c.id,
    category: c.category,
    appliesTo: c.appliesTo,
    description: c.description,
  }));
}

function renderCatalog(): string {
  const rows = catalog();
  const idWidth = Math.max(...rows.map((r) => r.id.length));
  return rows
    .map((r) => `  ${color.cyan(r.id.padEnd(idWidth))}  ${color.dim(`[${r.appliesTo}]`)} ${r.description}`)
    .join('\n');
}

export function usage(): string {
  return `${color.bold('mcp-doctor')} ${VERSION} — find out why your MCP server won't connect.

  ${color.bold('USAGE')}
    mcp-doctor <url>                          shorthand for "check"
    mcp-doctor check <url>                    remote server (Streamable HTTP)
    mcp-doctor check --stdio -- node server.js local server over stdio
    mcp-doctor migrate <url>                  readiness report for ${REVISION_MODERN}
    mcp-doctor watch <url>                    poll an endpoint while it deploys
    mcp-doctor list-checks                    catalogue of available checks

  ${color.bold('OPTIONS')}
    --json                machine-readable output, for CI
    --strict              exit code 1 on warnings too
    --auth-token <tok>    bearer credential (or the MCP_DOCTOR_TOKEN env var)
    --no-auth             skip the OAuth checks (server is knowingly public)
    --disable <id,...>    disable checks by id or category (e.g. tools.*)
    --timeout <ms>        per-request timeout (default 10000)
    --interval <s>        watch interval in seconds (default 10)
    --iterations <n>      number of watch rounds, 0 = forever
    --verbose, -v         show skipped checks too
    --version, -V         print the version

  ${color.bold('EXIT CODES')}
    0  no problems, or info only
    1  warnings present (only with --strict)
    2  at least one error

  ${color.bold('PROTOCOL ERAS')}
    modern  ${REVISION_MODERN}  stateless, no handshake, identity in _meta
    legacy  ${REVISION_LEGACY}  initialize handshake + Mcp-Session-Id

  No side effects on the server under test: discovery, list and deliberately
  invalid requests only. mcp-doctor never calls a tool.`;
}
