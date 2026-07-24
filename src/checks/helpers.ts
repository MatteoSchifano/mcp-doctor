import type { CategoryId, CheckResult, Severity } from '../types.ts';

interface Base {
  id: string;
  category: CategoryId;
  title: string;
  severity: Severity;
}

export function pass(base: Base, detail?: string, data?: Record<string, unknown>): CheckResult {
  return { ...base, status: 'pass', detail, data };
}

export function fail(
  base: Base,
  detail: string,
  remediation: string,
  data?: Record<string, unknown>,
): CheckResult {
  return { ...base, status: 'fail', detail, remediation, data };
}

export function skip(base: Base, detail: string): CheckResult {
  return { ...base, status: 'skip', detail };
}
