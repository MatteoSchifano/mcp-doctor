/**
 * The check registry.
 *
 * Every check is a pure function `(context) => CheckResult[]`: adding one
 * never touches the core, and the README catalogue is generated from here
 * (`mcp-doctor list-checks`).
 */

import { transportChecks } from './transport.ts';
import { protocolChecks } from './protocol.ts';
import { authChecks } from './auth.ts';
import { toolChecks } from './tools.ts';
import { stdioChecks } from './stdio.ts';
import { cacheChecks } from './cache.ts';
import { isDisabled } from '../config.ts';
import { CATEGORY_ORDER } from '../types.ts';
import type { Check, CheckContext, CheckResult, Report } from '../types.ts';

export const ALL_CHECKS: Check[] = [
  ...transportChecks,
  ...protocolChecks,
  ...authChecks,
  ...toolChecks,
  ...stdioChecks,
  ...cacheChecks,
];

export function selectChecks(mode: 'http' | 'stdio', ctx: CheckContext): Check[] {
  return ALL_CHECKS.filter(
    (check) => (check.appliesTo === 'both' || check.appliesTo === mode) && !isDisabled(ctx.config, check.id),
  );
}

export function runChecks(ctx: CheckContext): CheckResult[] {
  const mode = ctx.evidence.kind;
  const results: CheckResult[] = [];
  for (const check of selectChecks(mode, ctx)) {
    try {
      results.push(...check.run(ctx));
    } catch (err) {
      results.push({
        id: check.id,
        category: check.category,
        title: check.id,
        status: 'fail',
        severity: 'warn',
        detail: `the check itself threw: ${err instanceof Error ? err.message : String(err)}`,
        remediation: 'Please report this as an mcp-doctor bug: a check must never throw.',
      });
    }
  }
  return sortResults(results);
}

function sortResults(results: CheckResult[]): CheckResult[] {
  return [...results].sort((a, b) => {
    const ca = CATEGORY_ORDER.indexOf(a.category);
    const cb = CATEGORY_ORDER.indexOf(b.category);
    if (ca !== cb) return ca - cb;
    return 0;
  });
}

export function summarize(results: CheckResult[]): Report['summary'] {
  let errors = 0;
  let warnings = 0;
  let infos = 0;
  let passed = 0;
  let skipped = 0;
  for (const r of results) {
    if (r.status === 'pass') passed++;
    else if (r.status === 'skip') skipped++;
    else if (r.severity === 'error') errors++;
    else if (r.severity === 'warn') warnings++;
    else infos++;
  }
  return { errors, warnings, infos, passed, skipped };
}

/** `0` all clear or info only, `1` warnings present with `--strict`, `2` at least one error. */
export function exitCodeFor(summary: Report['summary'], strict: boolean): number {
  if (summary.errors > 0) return 2;
  if (strict && summary.warnings > 0) return 1;
  return 0;
}

export { transportChecks, protocolChecks, authChecks, toolChecks, stdioChecks, cacheChecks };
