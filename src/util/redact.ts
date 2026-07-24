/**
 * A diagnostic tool that leaks credentials is worse than the problem it
 * solves. Everything that reaches output — human, JSON, verbose included —
 * goes through here.
 */

const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
  'mcp-session-id',
  'x-auth-token',
]);

export const REDACTED = '[redacted]';

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SENSITIVE_HEADERS.has(k.toLowerCase()) ? REDACTED : v;
  }
  return out;
}

/**
 * `WWW-Authenticate` must stay visible (it's diagnostic), but it can carry an
 * `error_description` with a token fragment inside.
 */
export function redactChallenge(value: string | undefined): string | undefined {
  if (!value) return value;
  return value.replace(/((?:token|access_token|id_token)\s*=\s*")[^"]*(")/gi, `$1${REDACTED}$2`);
}

/** Strips anything that looks like a bearer token out of arbitrary text. */
export function redactText(text: string): string {
  return text
    .replace(/\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi, `Bearer ${REDACTED}`)
    .replace(/\beyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]*/g, REDACTED)
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{16,})\b/g, REDACTED)
    .replace(/\b(sk-[A-Za-z0-9]{16,})\b/g, REDACTED);
}

export function snippet(text: string, max = 200): string {
  const clean = redactText(text).replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}
