/**
 * JSON-RPC over Streamable HTTP with bare `fetch`.
 *
 * The SDK is deliberately not used here: it abstracts away exactly the errors
 * this tool needs to diagnose (the reverse proxy's 404, a 400 with a
 * meaningful body, missing headers, non-conforming responses). We need the
 * raw status, headers and body.
 */

import { HEADERS, buildMeta, REVISION_MODERN } from '../protocol.ts';
import type { RpcOutcome } from '../types.ts';

export interface RpcOptions {
  /** Bearer token, if the user supplied one. Never logged. */
  token?: string;
  timeoutMs?: number;
  /** Extra or overriding headers (used by the conformance checks). */
  headers?: Record<string, string>;
  /** `false` to omit the 2026-07-28 headers and test how the server reacts. */
  modernHeaders?: boolean;
  /** `false` to omit `_meta` (legacy-style request). */
  meta?: boolean;
  protocolVersion?: string;
  /** Value for `Mcp-Name`, when the method has a named target. */
  targetName?: string;
  signal?: AbortSignal;
}

let nextId = 1;

export function rpcBody(method: string, params: Record<string, unknown> | undefined, opts: RpcOptions): string {
  const withMeta = opts.meta !== false;
  const merged: Record<string, unknown> = { ...(params ?? {}) };
  if (withMeta) merged._meta = buildMeta(opts.protocolVersion ?? REVISION_MODERN);
  return JSON.stringify({
    jsonrpc: '2.0',
    id: nextId++,
    method,
    ...(Object.keys(merged).length > 0 ? { params: merged } : {}),
  });
}

export function rpcHeaders(method: string, opts: RpcOptions): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    // Modern servers may answer in JSON or SSE: advertise both.
    accept: 'application/json, text/event-stream',
    'user-agent': 'mcp-doctor/0.3.0',
    [HEADERS.protocolVersion]: opts.protocolVersion ?? REVISION_MODERN,
  };
  if (opts.modernHeaders !== false) {
    headers[HEADERS.method] = method;
    if (opts.targetName) headers[HEADERS.name] = opts.targetName;
  }
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  return { ...headers, ...(opts.headers ?? {}) };
}

export async function rpc(
  url: string,
  method: string,
  params: Record<string, unknown> | undefined,
  opts: RpcOptions = {},
): Promise<RpcOutcome> {
  const started = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000);
  const signal = opts.signal ? AbortSignal.any([controller.signal, opts.signal]) : controller.signal;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: rpcHeaders(method, opts),
      body: rpcBody(method, params, opts),
      redirect: 'manual',
      signal,
    });
    const bodyText = await readBody(res);
    return {
      ok: res.ok,
      status: res.status,
      durationMs: Math.round(performance.now() - started),
      headers: headersToObject(res.headers),
      bodyText,
      json: parseMaybeSse(bodyText),
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      durationMs: Math.round(performance.now() - started),
      headers: {},
      bodyText: '',
      networkError: describeError(err),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function probeGet(url: string, opts: RpcOptions = {}): Promise<RpcOutcome> {
  const started = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 10_000);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'user-agent': 'mcp-doctor/0.3.0',
        ...(opts.headers ?? {}),
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    const bodyText = await readBody(res);
    return {
      ok: res.ok,
      status: res.status,
      durationMs: Math.round(performance.now() - started),
      headers: headersToObject(res.headers),
      bodyText,
      json: safeJson(bodyText),
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      durationMs: Math.round(performance.now() - started),
      headers: {},
      bodyText: '',
      networkError: describeError(err),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function probeOptions(url: string, origin: string): Promise<RpcOutcome> {
  const started = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetch(url, {
      method: 'OPTIONS',
      headers: {
        origin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': `content-type, ${HEADERS.protocolVersion}`,
        'user-agent': 'mcp-doctor/0.3.0',
      },
      signal: controller.signal,
    });
    return {
      ok: res.ok,
      status: res.status,
      durationMs: Math.round(performance.now() - started),
      headers: headersToObject(res.headers),
      bodyText: '',
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      durationMs: Math.round(performance.now() - started),
      headers: {},
      bodyText: '',
      networkError: describeError(err),
    };
  } finally {
    clearTimeout(timeout);
  }
}

/** Bounded read: a wrong endpoint can answer with megabytes of HTML. */
async function readBody(res: Response, maxBytes = 512 * 1024): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
      if (total >= maxBytes) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

export function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * A Streamable HTTP server may answer with `text/event-stream` even for a
 * single request: the JSON-RPC payload sits in the first `data:` event.
 */
export function parseMaybeSse(text: string): unknown {
  const direct = safeJson(text);
  if (direct !== undefined) return direct;
  const dataLines = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim());
  for (const line of dataLines) {
    const parsed = safeJson(line);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

export function describeError(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    if (err.name === 'AbortError' || err.name === 'TimeoutError') return 'timeout';
    if (cause?.code) return `${cause.code}${cause.message ? `: ${cause.message}` : ''}`;
    return err.message;
  }
  return String(err);
}

export function isJsonRpcError(json: unknown): json is { jsonrpc: '2.0'; error: { code: number; message: string } } {
  return (
    typeof json === 'object' &&
    json !== null &&
    'error' in json &&
    typeof (json as { error: unknown }).error === 'object' &&
    (json as { error: unknown }).error !== null
  );
}

export function isJsonRpcResult(
  json: unknown,
): json is { jsonrpc: '2.0'; id: unknown; result: Record<string, unknown> } {
  return typeof json === 'object' && json !== null && 'result' in json;
}
