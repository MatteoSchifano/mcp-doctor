/**
 * Every protocol constant lives here, and only here.
 *
 * The 2026-07-28 revision is recent and details can still move: isolating the
 * constants in a single module is the explicit mitigation for that risk. If
 * the spec renames a `_meta` key or a header, this file changes and nothing
 * else does.
 *
 * Sources:
 *  - https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/
 *  - https://modelcontextprotocol.io/specification/draft/basic/transports/streamable-http
 */

/** The "modern" revision: stateless, no handshake, identity carried in `_meta`. */
export const REVISION_MODERN = '2026-07-28';

/** Last finalized revision of the previous era: handshake + sessions. */
export const REVISION_LEGACY = '2025-11-25';

/** In ascending chronological order. */
export const KNOWN_REVISIONS = [
  '2024-11-05',
  '2025-03-26',
  '2025-06-18',
  '2025-11-25',
  '2026-07-28',
] as const;

/** The boundary between the two eras: from here on the protocol is stateless. */
export const MODERN_FROM = REVISION_MODERN;

export const HEADERS = {
  protocolVersion: 'MCP-Protocol-Version',
  /** Added in 2026-07-28: lets gateways route without reading the body. */
  method: 'Mcp-Method',
  /** Added in 2026-07-28: the tool or resource a call targets. */
  name: 'Mcp-Name',
  /** Legacy era only: removed in 2026-07-28. */
  session: 'Mcp-Session-Id',
} as const;

/** `_meta` keys a modern client uses to carry its own identity. */
export const META_KEYS = {
  protocolVersion: 'io.modelcontextprotocol/protocol-version',
  clientInfo: 'io.modelcontextprotocol/client-info',
  clientCapabilities: 'io.modelcontextprotocol/client-capabilities',
} as const;

/** Method introduced in 2026-07-28 for capability discovery. */
export const METHOD_DISCOVER = 'server/discover';

export const CLIENT_INFO = { name: 'mcp-doctor', version: '0.3.0' } as const;

export const WELL_KNOWN = {
  protectedResource: '/.well-known/oauth-protected-resource',
  authorizationServer: '/.well-known/oauth-authorization-server',
} as const;

/** Standard JSON-RPC codes, used to work out *why* a 400 is a 400. */
export const JSONRPC_ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

export function revisionIndex(rev: string): number {
  return (KNOWN_REVISIONS as readonly string[]).indexOf(rev);
}

export function isKnownRevision(rev: string): boolean {
  return revisionIndex(rev) >= 0;
}

/** `-1` if a < b, `0` if equal, `1` if a > b. Unknown revisions compare lexicographically. */
export function compareRevisions(a: string, b: string): number {
  const ia = revisionIndex(a);
  const ib = revisionIndex(b);
  if (ia >= 0 && ib >= 0) return Math.sign(ia - ib);
  return a === b ? 0 : a < b ? -1 : 1;
}

export function eraOfRevision(rev: string | undefined): 'modern' | 'legacy' | 'unknown' {
  if (!rev) return 'unknown';
  if (!isKnownRevision(rev)) return 'unknown';
  return compareRevisions(rev, MODERN_FROM) >= 0 ? 'modern' : 'legacy';
}

/** Builds the `_meta` block a modern client attaches to every request. */
export function buildMeta(protocolVersion: string = REVISION_MODERN): Record<string, unknown> {
  return {
    [META_KEYS.protocolVersion]: protocolVersion,
    [META_KEYS.clientInfo]: { ...CLIENT_INFO },
    [META_KEYS.clientCapabilities]: {},
  };
}
