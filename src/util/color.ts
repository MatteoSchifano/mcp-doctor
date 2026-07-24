/** Minimal ANSI colors, disabled automatically outside a TTY or with NO_COLOR. */

const enabled =
  process.env.NO_COLOR === undefined &&
  process.env.TERM !== 'dumb' &&
  Boolean(process.stdout.isTTY);

const ESC = '\u001b[';

function wrap(open: number, close: number) {
  return (s: string): string => (enabled ? `${ESC}${open}m${s}${ESC}${close}m` : s);
}

export const color = {
  enabled,
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
};

export function padEnd(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}
