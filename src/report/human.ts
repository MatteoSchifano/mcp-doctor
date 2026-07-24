import { CATEGORY_LABEL, CATEGORY_ORDER } from '../types.ts';
import type { CategoryId, CheckResult, Report } from '../types.ts';
import { color, padEnd } from '../util/color.ts';

const GLYPH = {
  pass: color.green('✓'),
  error: color.red('✗'),
  warn: color.yellow('⚠'),
  info: color.blue('·'),
  skip: color.gray('–'),
};

function glyphFor(result: CheckResult): string {
  if (result.status === 'pass') return GLYPH.pass;
  if (result.status === 'skip') return GLYPH.skip;
  if (result.severity === 'error') return GLYPH.error;
  if (result.severity === 'warn') return GLYPH.warn;
  return GLYPH.info;
}

export interface RenderOptions {
  /** Also show skipped checks. */
  verbose?: boolean;
  /** Width of the title column. */
  titleWidth?: number;
}

export function renderHuman(report: Report, opts: RenderOptions = {}): string {
  const lines: string[] = [];
  const visible = report.results.filter((r) => opts.verbose || r.status !== 'skip');
  const titleWidth =
    opts.titleWidth ?? Math.min(26, Math.max(18, ...visible.map((r) => r.title.length)));

  lines.push('');
  lines.push(`  ${color.bold('mcp-doctor')}  ${report.target}`);
  lines.push('');

  for (const category of CATEGORY_ORDER) {
    const inCategory = visible.filter((r) => r.category === category);
    if (inCategory.length === 0) continue;
    lines.push(`  ${color.bold(CATEGORY_LABEL[category as CategoryId])}`);
    for (const result of inCategory) {
      lines.push(`  ${glyphFor(result)} ${padEnd(result.title, titleWidth)} ${color.dim(result.detail ?? '')}`.trimEnd());
      if (result.status === 'fail' && result.remediation) {
        for (const line of wrap(result.remediation, 62)) {
          lines.push(`    ${color.gray('→')} ${color.gray(line)}`);
        }
      }
    }
    lines.push('');
  }

  lines.push(`  ${summaryLine(report)}`);
  lines.push('');
  return lines.join('\n');
}

export function summaryLine(report: Report): string {
  const { errors, warnings, infos, passed, skipped } = report.summary;
  const parts: string[] = [];
  if (errors > 0) parts.push(color.red(`${errors} ${errors === 1 ? 'error' : 'errors'}`));
  if (warnings > 0) parts.push(color.yellow(`${warnings} ${warnings === 1 ? 'warning' : 'warnings'}`));
  if (infos > 0) parts.push(color.blue(`${infos} info`));
  if (parts.length === 0) parts.push(color.green(`no problems (${passed} checks passed)`));
  else parts.push(color.dim(`${passed} passed`));
  if (skipped > 0) parts.push(color.gray(`${skipped} skipped`));
  return parts.join(color.dim(', '));
}

/** Word wrapping, so remediation text fits the box. */
export function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (current.length === 0) current = word;
    else if (current.length + 1 + word.length <= width) current += ` ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}
