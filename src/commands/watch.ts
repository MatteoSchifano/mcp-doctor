/**
 * `watch` — polls an endpoint, built for watching a deploy come up. One line
 * per round, plus a readable diff whenever something changes state.
 */

import { runCheck, type CheckOptions } from './check.ts';
import { summaryLine } from '../report/human.ts';
import { color } from '../util/color.ts';
import type { Report } from '../types.ts';

export interface WatchOptions extends CheckOptions {
  intervalMs: number;
  /** Stop after N rounds; `0` = forever. */
  maxIterations?: number;
  onReport?: (report: Report, iteration: number) => void;
}

export async function runWatch(opts: WatchOptions, write: (s: string) => void = (s) => process.stdout.write(s)): Promise<number> {
  let previous: Report | undefined;
  let iteration = 0;
  let lastExit = 0;

  for (;;) {
    iteration++;
    const report = await runCheck(opts);
    lastExit = report.exitCode;
    opts.onReport?.(report, iteration);

    const stamp = color.gray(new Date().toISOString().slice(11, 19));
    write(`${stamp}  ${summaryLine(report)}\n`);

    if (previous) {
      for (const line of diffReports(previous, report)) write(`          ${line}\n`);
    }
    previous = report;

    if (opts.maxIterations && iteration >= opts.maxIterations) break;
    await sleep(opts.intervalMs);
  }
  return lastExit;
}

export function diffReports(before: Report, after: Report): string[] {
  const beforeById = new Map(before.results.map((r) => [r.id, r]));
  const lines: string[] = [];
  for (const result of after.results) {
    const old = beforeById.get(result.id);
    if (!old) continue;
    if (old.status === result.status) continue;
    if (result.status === 'pass') lines.push(`${color.green('✓')} ${result.title}: fixed`);
    else if (old.status === 'pass') lines.push(`${color.red('✗')} ${result.title}: regressed — ${result.detail ?? ''}`);
  }
  return lines;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
