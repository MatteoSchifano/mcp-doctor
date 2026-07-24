/**
 * stdio probe. The check that matters most is the dumbest one: something that
 * isn't JSON-RPC ended up on stdout.
 */

import { REVISION_LEGACY, CLIENT_INFO } from '../protocol.ts';
import { settle, startStdioServer } from '../transport/stdio.ts';
import type { StdioEvidence, ToolDef } from '../types.ts';

export interface StdioProbeOptions {
  timeoutMs?: number;
  env?: Record<string, string>;
}

export async function probeStdio(
  command: string,
  args: string[],
  opts: StdioProbeOptions = {},
): Promise<StdioEvidence> {
  const evidence: StdioEvidence = {
    kind: 'stdio',
    command,
    args,
    exitCode: null,
    signal: null,
    stdoutNonJsonLines: [],
    stderrSnippet: '',
    era: 'unknown',
    eraEvidence: 'not determined',
  };

  const { session, spawnError } = startStdioServer(command, args, opts.env);
  if (!session) {
    evidence.spawnError = spawnError ?? 'could not start the process';
    return evidence;
  }

  const startup = await settle(session, 600);
  if (startup.exitedEarly) {
    evidence.exitCode = startup.code;
    evidence.signal = startup.signal;
    evidence.spawnError = session.failure.message;
    evidence.stdoutNonJsonLines = [...session.nonJsonStdout];
    evidence.stderrSnippet = session.stderr.slice(0, 10).join('\n');
    evidence.eraEvidence = session.failure.message
      ? `the process never started: ${session.failure.message}`
      : 'the process exited before answering';
    return evidence;
  }

  // Modern request first: self-contained, no handshake.
  let listResult: unknown;
  try {
    const modern = await session.send('tools/list', {}, { timeoutMs: opts.timeoutMs ?? 6_000 });
    if (isResult(modern)) {
      evidence.era = 'modern';
      evidence.eraEvidence = 'tools/list accepted with no handshake';
      listResult = modern;
    }
  } catch (err) {
    evidence.toolsListError = err instanceof Error ? err.message : String(err);
  }

  if (evidence.era !== 'modern') {
    try {
      const init = await session.send(
        'initialize',
        { protocolVersion: REVISION_LEGACY, capabilities: {}, clientInfo: { ...CLIENT_INFO } },
        { meta: false, timeoutMs: opts.timeoutMs ?? 6_000 },
      );
      if (isResult(init)) {
        const result = init.result as { protocolVersion?: string; serverInfo?: { name?: string; version?: string } };
        evidence.era = 'legacy';
        evidence.eraEvidence = 'initialize handshake accepted';
        evidence.negotiatedVersion = result.protocolVersion;
        evidence.serverInfo = result.serverInfo;
        session.notify('notifications/initialized');
        const list = await session.send('tools/list', {}, { meta: false, timeoutMs: opts.timeoutMs ?? 6_000 });
        if (isResult(list)) listResult = list;
      }
    } catch (err) {
      evidence.toolsListError ??= err instanceof Error ? err.message : String(err);
    }
  }

  if (isResult(listResult)) {
    const result = listResult.result as Record<string, unknown>;
    if (Array.isArray(result.tools)) evidence.tools = result.tools as ToolDef[];
    else evidence.toolsListError ??= 'result.tools missing or not an array';
    const meta = (result._meta ?? {}) as Record<string, unknown>;
    evidence.listResultMeta = { ttlMs: result.ttlMs ?? meta.ttlMs, cacheScope: result.cacheScope ?? meta.cacheScope };
  }

  if (evidence.era === 'modern') {
    try {
      const discover = await session.send('server/discover', {}, { timeoutMs: opts.timeoutMs ?? 6_000 });
      if (isResult(discover)) {
        const names = Array.isArray((discover.result as { tools?: unknown }).tools)
          ? ((discover.result as { tools: unknown[] }).tools
              .map((t) => (typeof t === 'string' ? t : (t as { name?: unknown })?.name))
              .filter((n): n is string => typeof n === 'string'))
          : [];
        evidence.discover = { supported: true, toolNames: names };
      } else {
        evidence.discover = { supported: false, toolNames: [], error: 'error response' };
      }
    } catch (err) {
      evidence.discover = { supported: false, toolNames: [], error: err instanceof Error ? err.message : String(err) };
    }
  } else {
    evidence.discover = { supported: false, toolNames: [], error: 'method introduced in 2026-07-28' };
  }

  evidence.stdoutNonJsonLines = [...session.nonJsonStdout];
  evidence.stderrSnippet = session.stderr.slice(0, 10).join('\n');

  const closed = await session.close();
  evidence.exitCode = closed.code;
  evidence.signal = closed.signal;
  return evidence;
}

function isResult(value: unknown): value is { result: unknown } {
  return typeof value === 'object' && value !== null && 'result' in value;
}
