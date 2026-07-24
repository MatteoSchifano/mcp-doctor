import type { Report } from '../types.ts';
import { redactText } from '../util/redact.ts';

/**
 * Machine-readable output for CI.
 *
 * The whole serialized payload goes through `redactText`: a safety net for the
 * case where a new check accidentally puts a credential fragment into `data`.
 */
export function renderJson(report: Report): string {
  const payload = {
    tool: 'mcp-doctor',
    version: '0.3.0',
    target: report.target,
    mode: report.mode,
    era: report.era,
    protocolVersion: report.negotiatedVersion ?? null,
    summary: report.summary,
    exitCode: report.exitCode,
    results: report.results.map((r) => ({
      id: r.id,
      category: r.category,
      title: r.title,
      status: r.status,
      severity: r.severity,
      detail: r.detail ?? null,
      remediation: r.remediation ?? null,
      data: r.data ?? null,
    })),
  };
  return redactText(JSON.stringify(payload, null, 2));
}
