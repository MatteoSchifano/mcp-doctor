/**
 * Minimal stdio client.
 *
 * The diagnostic value here is not "speaking JSON-RPC" — an SDK does that.
 * It is observing *everything* the process writes to stdout, including the
 * lines that are not JSON-RPC: one stray `console.log` corrupts the channel
 * and the client reports nothing but "failed to connect".
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { buildMeta, REVISION_MODERN } from '../protocol.ts';
import { safeJson } from './http.ts';

export interface StdioSession {
  send(method: string, params?: Record<string, unknown>, opts?: { meta?: boolean; timeoutMs?: number }): Promise<unknown>;
  notify(method: string, params?: Record<string, unknown>): void;
  readonly nonJsonStdout: string[];
  readonly stderr: string[];
  /** Populated when the process never started at all (ENOENT, permissions, …). */
  readonly failure: { message?: string };
  readonly exit: Promise<{ code: number | null; signal: string | null }>;
  close(): Promise<{ code: number | null; signal: string | null }>;
}

export interface StdioSpawnResult {
  session?: StdioSession;
  spawnError?: string;
}

export function startStdioServer(command: string, args: string[], env?: Record<string, string>): StdioSpawnResult {
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
  } catch (err) {
    return { spawnError: err instanceof Error ? err.message : String(err) };
  }

  const nonJsonStdout: string[] = [];
  const stderr: string[] = [];
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  let nextId = 1;
  let stdoutBuffer = '';
  const failure: { message?: string } = {};

  const exit = new Promise<{ code: number | null; signal: string | null }>((resolveExit) => {
    child.on('exit', (code, signal) => resolveExit({ code, signal }));
    child.on('error', (err) => {
      failure.message = err.message;
      resolveExit({ code: null, signal: null });
    });
  });

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdoutBuffer += chunk;
    let idx: number;
    while ((idx = stdoutBuffer.indexOf('\n')) >= 0) {
      const line = stdoutBuffer.slice(0, idx).replace(/\r$/, '');
      stdoutBuffer = stdoutBuffer.slice(idx + 1);
      if (line.trim() === '') continue;
      const parsed = safeJson(line);
      if (parsed === undefined) {
        // This is the diagnosis nobody performs by hand.
        if (nonJsonStdout.length < 20) nonJsonStdout.push(line);
        continue;
      }
      dispatch(parsed);
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    for (const line of chunk.split(/\r?\n/)) {
      if (line.trim() !== '' && stderr.length < 50) stderr.push(line);
    }
  });

  function dispatch(message: unknown): void {
    if (typeof message !== 'object' || message === null) return;
    const id = (message as { id?: unknown }).id;
    if (typeof id !== 'number') return; // server notification: ignored
    const entry = pending.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(id);
    entry.resolve(message);
  }

  const session: StdioSession = {
    nonJsonStdout,
    stderr,
    failure,
    exit,
    send(method, params, opts = {}) {
      const id = nextId++;
      const merged: Record<string, unknown> = { ...(params ?? {}) };
      if (opts.meta !== false) merged._meta = buildMeta(REVISION_MODERN);
      const payload = JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        ...(Object.keys(merged).length > 0 ? { params: merged } : {}),
      });
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`timeout on ${method}`));
        }, opts.timeoutMs ?? 8_000);
        pending.set(id, { resolve, reject, timer });
        if (failure.message) {
          clearTimeout(timer);
          pending.delete(id);
          reject(new Error(failure.message));
          return;
        }
        child.stdin.write(`${payload}\n`, (err) => {
          if (err) {
            clearTimeout(timer);
            pending.delete(id);
            reject(err);
          }
        });
      });
    },
    notify(method, params) {
      const payload = JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) });
      child.stdin.write(`${payload}\n`, () => {});
    },
    async close() {
      for (const entry of pending.values()) clearTimeout(entry.timer);
      pending.clear();
      child.stdin.end();
      const timer = setTimeout(() => child.kill('SIGTERM'), 1_000);
      const result = await exit;
      clearTimeout(timer);
      if (!child.killed) child.kill('SIGKILL');
      return result;
    },
  };

  return { session };
}

/** Waits for the process to settle, or to exit immediately with an error. */
export function settle(session: StdioSession, ms = 500): Promise<{ exitedEarly: boolean; code: number | null; signal: string | null }> {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve({ exitedEarly: false, code: null, signal: null });
    }, ms);
    void session.exit.then(({ code, signal }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ exitedEarly: true, code, signal });
    });
  });
}
