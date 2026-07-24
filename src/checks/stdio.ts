import type { Check, StdioEvidence } from '../types.ts';
import { fail, pass } from './helpers.ts';
import { snippet } from '../util/redact.ts';

function stdio(ctx: { evidence: { kind: string } }): StdioEvidence | undefined {
  return ctx.evidence.kind === 'stdio' ? (ctx.evidence as StdioEvidence) : undefined;
}

export const stdioChecks: Check[] = [
  {
    id: 'stdio.startup',
    category: 'stdio',
    appliesTo: 'stdio',
    description: 'The process starts and stays alive long enough to answer.',
    run(ctx) {
      const e = stdio(ctx);
      if (!e) return [];
      const base = { id: 'stdio.startup', category: 'stdio' as const, title: 'process startup', severity: 'error' as const };
      if (e.spawnError) {
        return [
          fail(base, e.spawnError, `Command "${e.command}" is not executable. Check the path and that dependencies are installed.`),
        ];
      }
      if (e.exitCode !== null && e.exitCode !== 0 && e.era === 'unknown') {
        return [
          fail(
            base,
            `exited with code ${e.exitCode}${e.signal ? ` (${e.signal})` : ''}`,
            `The process dies before speaking JSON-RPC. First line of stderr: ${snippet(e.stderrSnippet.split('\n')[0] ?? '(empty)', 120)}`,
            { exitCode: e.exitCode, stderr: snippet(e.stderrSnippet, 400) },
          ),
        ];
      }
      if (e.era === 'unknown') {
        return [
          fail(
            base,
            'no response to tools/list or initialize',
            `The process stays alive but does not speak JSON-RPC over stdin/stdout. Check that the server is started in stdio mode and is not, say, listening on a port. stderr: ${snippet(e.stderrSnippet || '(empty)', 160)}`,
            { stderr: snippet(e.stderrSnippet, 400) },
          ),
        ];
      }
      return [pass(base, 'process started and responsive')];
    },
  },

  {
    id: 'stdio.stdout-purity',
    category: 'stdio',
    appliesTo: 'stdio',
    description: 'No non-JSON output on stdout: the silent killer of the stdio transport.',
    run(ctx) {
      const e = stdio(ctx);
      if (!e) return [];
      const base = {
        id: 'stdio.stdout-purity',
        category: 'stdio' as const,
        title: 'stdout purity',
        severity: 'error' as const,
      };
      if (e.stdoutNonJsonLines.length === 0) return [pass(base, 'JSON-RPC messages only')];
      const sample = e.stdoutNonJsonLines.slice(0, 3).map((l) => snippet(l, 90));
      return [
        fail(
          base,
          `${e.stdoutNonJsonLines.length} non-JSON lines on stdout`,
          `stdout *is* the JSON-RPC channel: anything else corrupts it and the client reports only "failed to connect". Move logging to stderr (console.error, or a logger configured with stream: process.stderr). Lines found: ${sample.join(' | ')}`,
          { lines: sample, total: e.stdoutNonJsonLines.length },
        ),
      ];
    },
  },
];
