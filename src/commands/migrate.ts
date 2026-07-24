/**
 * `migrate` — the delta towards the 2026-07-28 revision.
 *
 * This is the command that brings people in: every MCP server author needs to
 * know whether they are ready, and wants to know it in ten seconds.
 */

import { HEADERS, METHOD_DISCOVER, REVISION_LEGACY, REVISION_MODERN } from '../protocol.ts';
import { color } from '../util/color.ts';
import { wrap } from '../report/human.ts';
import type { Evidence, HttpEvidence, Severity } from '../types.ts';

export interface MigrationItem {
  id: string;
  severity: Severity;
  title: string;
  action: string;
  done: boolean;
}

export interface MigrationReport {
  target: string;
  currentEra: 'modern' | 'legacy' | 'unknown';
  currentVersion?: string;
  items: MigrationItem[];
  compatibleWithModernClients: boolean;
  effort: 'none' | 'low' | 'medium' | 'high';
  exitCode: number;
}

export function buildMigrationReport(evidence: Evidence): MigrationReport {
  const items: MigrationItem[] = [];
  const http = evidence.kind === 'http' ? (evidence as HttpEvidence) : undefined;
  const isModern = evidence.era === 'modern';

  items.push({
    id: 'handshake',
    severity: 'error',
    title: 'handshake',
    done: isModern,
    action: isModern
      ? 'already stateless'
      : 'drop initialize/notifications-initialized; read protocolVersion and capabilities from _meta on every request',
  });

  const sessionDependent = countSessionDependentTools(evidence);
  items.push({
    id: 'sessions',
    severity: 'error',
    title: 'sessions',
    done: isModern && !http?.sessionHeaderSeen,
    action:
      isModern && !http?.sessionHeaderSeen
        ? 'no session residue'
        : `${HEADERS.session} no longer exists.${
            sessionDependent > 0
              ? ` ${sessionDependent} tools look like they depend on session state → convert them into explicit handles passed as arguments.`
              : ' Verify that no tool depends on per-connection state.'
          }`,
  });

  items.push({
    id: 'discover',
    severity: 'error',
    title: METHOD_DISCOVER,
    done: evidence.discover?.supported === true,
    action:
      evidence.discover?.supported === true
        ? 'implemented'
        : `not implemented: this is how ${REVISION_MODERN} clients discover your capabilities`,
  });

  if (http) {
    const acceptsWithout = http.headerConformance?.acceptsWithoutMcpMethod !== false;
    items.push({
      id: 'headers',
      severity: 'warn',
      title: 'headers',
      done: !acceptsWithout && http.headerConformance?.echoesMcpName === true,
      action: acceptsWithout
        ? `accepts requests without ${HEADERS.method}: gateways cannot route without deserializing the body`
        : `${HEADERS.name} missing from responses`,
    });
  }

  const hasCacheHints =
    evidence.listResultMeta !== undefined &&
    (evidence.listResultMeta.ttlMs !== undefined || evidence.listResultMeta.cacheScope !== undefined);
  items.push({
    id: 'cache',
    severity: 'warn',
    title: 'cache',
    done: hasCacheHints,
    action: hasCacheHints ? 'ttlMs / cacheScope declared' : 'list results without ttlMs / cacheScope',
  });

  const blocking = items.filter((i) => !i.done && i.severity === 'error');
  const compatible = isModern && blocking.length === 0;

  return {
    target: evidence.kind === 'http' ? evidence.url : `${evidence.command} ${evidence.args.join(' ')}`.trim(),
    currentEra: evidence.era,
    currentVersion: evidence.negotiatedVersion ?? (evidence.era === 'legacy' ? REVISION_LEGACY : undefined),
    items,
    compatibleWithModernClients: compatible,
    effort: estimateEffort(blocking.length, sessionDependent),
    exitCode: compatible ? 0 : 2,
  };
}

function estimateEffort(blocking: number, sessionDependent: number): MigrationReport['effort'] {
  if (blocking === 0) return 'none';
  if (blocking >= 3 || sessionDependent >= 5) return 'high';
  if (blocking >= 2 || sessionDependent > 0) return 'medium';
  return 'low';
}

/**
 * A declared heuristic: it looks for the usual signals of per-connection state
 * in names and descriptions. Deliberately conservative — this is a hint about
 * where to look, not a verdict, and it is presented as such.
 */
export function countSessionDependentTools(evidence: Evidence): number {
  const tools = evidence.tools ?? [];
  const signals = /\b(session|connect|disconnect|login|logout|open|close|begin|end|context|cursor|handle)\b/i;
  return tools.filter((tool) => {
    const name = typeof tool.name === 'string' ? tool.name : '';
    const description = typeof tool.description === 'string' ? tool.description : '';
    return signals.test(name) || /session state|current session/i.test(description);
  }).length;
}

export function renderMigration(report: MigrationReport): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(`  ${color.bold('mcp-doctor migrate')}  ${report.target}`);
  lines.push('');
  const eraLabel =
    report.currentEra === 'modern'
      ? `modern (${report.currentVersion ?? REVISION_MODERN})`
      : report.currentEra === 'legacy'
        ? `legacy (${report.currentVersion ?? REVISION_LEGACY})`
        : 'undetermined';
  lines.push(`  Current server: ${eraLabel} era`);
  lines.push('');

  const todo = report.items.filter((i) => !i.done);
  const done = report.items.filter((i) => i.done);

  if (todo.length > 0) {
    lines.push(`  ${color.bold('TO DO')}`);
    const width = Math.max(...report.items.map((i) => i.title.length)) + 2;
    for (const item of todo) {
      const glyph = item.severity === 'error' ? color.red('✗') : color.yellow('⚠');
      const [firstLine, ...rest] = wrap(item.action, 52);
      lines.push(`  ${glyph} ${item.title.padEnd(width)}${firstLine ?? ''}`);
      for (const line of rest) lines.push(`    ${' '.repeat(width)}${line}`);
    }
    lines.push('');
  }

  if (done.length > 0) {
    lines.push(`  ${color.bold('ALREADY DONE')}`);
    const width = Math.max(...report.items.map((i) => i.title.length)) + 2;
    for (const item of done) {
      lines.push(`  ${color.green('✓')} ${item.title.padEnd(width)}${color.dim(item.action)}`);
    }
    lines.push('');
  }

  lines.push(
    `  Compatible with modern clients: ${report.compatibleWithModernClients ? color.green('yes') : color.red('no')}`,
  );
  lines.push(`  Estimated effort: ${report.effort}`);
  lines.push('');
  return lines.join('\n');
}

export function migrationJson(report: MigrationReport): string {
  return JSON.stringify(
    {
      tool: 'mcp-doctor',
      command: 'migrate',
      targetRevision: REVISION_MODERN,
      target: report.target,
      currentEra: report.currentEra,
      currentVersion: report.currentVersion ?? null,
      compatibleWithModernClients: report.compatibleWithModernClients,
      effort: report.effort,
      items: report.items,
      exitCode: report.exitCode,
    },
    null,
    2,
  );
}
