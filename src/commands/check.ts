import { loadConfig, mergeConfig } from '../config.ts';
import { exitCodeFor, runChecks, summarize } from '../checks/index.ts';
import { probeHttp } from '../probe/http-probe.ts';
import { probeStdio } from '../probe/stdio-probe.ts';
import { REVISION_MODERN } from '../protocol.ts';
import type { DoctorConfig, Evidence, Report } from '../types.ts';

export interface CheckOptions {
  target?: string;
  stdioCommand?: string;
  stdioArgs?: string[];
  token?: string;
  timeoutMs?: number;
  strict?: boolean;
  skipAuth?: boolean;
  disable?: string[];
  targetRevision?: string;
}

export async function gatherEvidence(opts: CheckOptions): Promise<Evidence> {
  if (opts.stdioCommand) {
    return probeStdio(opts.stdioCommand, opts.stdioArgs ?? [], { timeoutMs: opts.timeoutMs });
  }
  if (!opts.target) throw new Error('no target: pass a URL, or --stdio -- <command>');
  return probeHttp(opts.target, {
    token: opts.token,
    timeoutMs: opts.timeoutMs,
    skipAuth: opts.skipAuth,
  });
}

export async function resolveConfig(opts: CheckOptions): Promise<DoctorConfig> {
  const fileConfig = await loadConfig();
  if (!opts.disable || opts.disable.length === 0) return fileConfig;
  return mergeConfig({ ...fileConfig, disabled: [...fileConfig.disabled, ...opts.disable] });
}

export function buildReport(evidence: Evidence, config: DoctorConfig, opts: CheckOptions): Report {
  const results = runChecks({
    evidence,
    config,
    targetRevision: opts.targetRevision ?? REVISION_MODERN,
  });
  const summary = summarize(results);
  return {
    target: evidence.kind === 'http' ? evidence.url : `${evidence.command} ${evidence.args.join(' ')}`.trim(),
    mode: evidence.kind,
    era: evidence.era,
    negotiatedVersion: evidence.negotiatedVersion,
    results,
    summary,
    exitCode: exitCodeFor(summary, opts.strict ?? false),
  };
}

export async function runCheck(opts: CheckOptions): Promise<Report> {
  const [evidence, config] = await Promise.all([gatherEvidence(opts), resolveConfig(opts)]);
  return buildReport(evidence, config, opts);
}
