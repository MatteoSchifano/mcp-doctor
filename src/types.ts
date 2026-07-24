/**
 * Shared types. No logic here: checks are pure functions
 * `(context) => CheckResult[]`, and this module defines the contract.
 */

export type Severity = 'error' | 'warn' | 'info';
export type CheckStatus = 'pass' | 'fail' | 'skip';

export type CategoryId = 'transport' | 'protocol' | 'auth' | 'tools' | 'stdio' | 'cache';

export const CATEGORY_LABEL: Record<CategoryId, string> = {
  transport: 'TRANSPORT',
  protocol: 'PROTOCOL',
  auth: 'AUTH',
  tools: 'TOOLS',
  stdio: 'STDIO',
  cache: 'CACHE',
};

export const CATEGORY_ORDER: CategoryId[] = ['transport', 'protocol', 'auth', 'tools', 'stdio', 'cache'];

export interface CheckResult {
  /** Stable identifier, used by config to disable the check. */
  id: string;
  category: CategoryId;
  /** Short label, left column of the human output. */
  title: string;
  status: CheckStatus;
  /** Severity applied when `status === 'fail'`. */
  severity: Severity;
  /** Detail line, to the right of the title. */
  detail?: string;
  /** How to fix it. Effectively mandatory on every failure. */
  remediation?: string;
  /** Structured data for `--json` output. Never credentials. */
  data?: Record<string, unknown>;
}

export interface Check {
  id: string;
  category: CategoryId;
  /** Which transport this check makes sense on. */
  appliesTo: 'http' | 'stdio' | 'both';
  /** One-line description, used to generate the catalogue in the README. */
  description: string;
  run(ctx: CheckContext): CheckResult[];
}

/* ------------------------------------------------------------------ *
 * Evidence gathered by the probe phase. Checks never touch the network.
 * ------------------------------------------------------------------ */

export type Era = 'modern' | 'legacy' | 'unknown';

export interface ToolDef {
  name?: unknown;
  description?: unknown;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface RpcOutcome {
  ok: boolean;
  status: number;
  durationMs: number;
  headers: Record<string, string>;
  bodyText: string;
  json?: unknown;
  /** Network or parse failure, not an application-level error. */
  networkError?: string;
}

export interface HttpEvidence {
  kind: 'http';
  url: string;
  host: string;
  dns?: { addresses: string[]; ms: number; error?: string };
  tls?: {
    checked: boolean;
    valid: boolean;
    issuer?: string;
    subject?: string;
    validTo?: string;
    daysToExpiry?: number;
    error?: string;
  };
  reachable?: { status: number; ms: number; error?: string };
  routing?: { status: number; contentType?: string; bodySnippet: string; looksLikeProxy404: boolean };
  era: Era;
  eraEvidence: string;
  negotiatedVersion?: string;
  serverInfo?: { name?: string; version?: string };
  capabilities?: Record<string, unknown>;
  sessionHeaderSeen?: string;
  headerConformance?: {
    /** The server accepts a request with no `Mcp-Method` header. */
    acceptsWithoutMcpMethod: boolean;
    /** The server echoes `Mcp-Name` back on responses. */
    echoesMcpName: boolean;
  };
  discover?: { supported: boolean; toolNames: string[]; raw?: unknown; error?: string };
  tools?: ToolDef[];
  toolsListError?: string;
  listResultMeta?: { ttlMs?: unknown; cacheScope?: unknown };
  errorShape?: { checked: boolean; valid: boolean; detail: string };
  cors?: { checked: boolean; allowOrigin?: string; allowHeaders?: string; allowMethods?: string; status: number };
  auth: AuthEvidence;
}

export interface AuthEvidence {
  tokenProvided: boolean;
  protectedResourceMetadata?: {
    url: string;
    status: number;
    ok: boolean;
    authorizationServers?: string[];
    scopesSupported?: string[];
  };
  authorizationServerMetadata?: { url: string; status: number; ok: boolean };
  challenge?: { status: number; wwwAuthenticate?: string; wellFormed: boolean };
  /** tools/list with no credential: a 200 on a protected server is a problem. */
  unauthenticated?: { status: number; allowed: boolean; toolCount?: number };
  requiredScopes?: string[];
}

export interface StdioEvidence {
  kind: 'stdio';
  command: string;
  args: string[];
  spawnError?: string;
  exitCode: number | null;
  signal: string | null;
  /** Lines written to stdout that are not JSON-RPC: the silent killer. */
  stdoutNonJsonLines: string[];
  stderrSnippet: string;
  era: Era;
  eraEvidence: string;
  negotiatedVersion?: string;
  serverInfo?: { name?: string; version?: string };
  discover?: { supported: boolean; toolNames: string[]; error?: string };
  tools?: ToolDef[];
  toolsListError?: string;
  listResultMeta?: { ttlMs?: unknown; cacheScope?: unknown };
}

export type Evidence = HttpEvidence | StdioEvidence;

export interface DoctorConfig {
  /** Check ids to skip. Supports the category prefix form: `tools.*`. */
  disabled: string[];
  /** Threshold for the "description too short" check. */
  minDescriptionLength: number;
  /** Days below which certificate expiry becomes a warning. */
  certWarnDays: number;
  /** Latency above which the endpoint is flagged as slow (ms). */
  slowMs: number;
}

export interface CheckContext {
  evidence: Evidence;
  config: DoctorConfig;
  /** Target revision for the protocol checks. */
  targetRevision: string;
}

export interface Report {
  target: string;
  mode: 'http' | 'stdio';
  era: Era;
  negotiatedVersion?: string;
  results: CheckResult[];
  summary: { errors: number; warnings: number; infos: number; passed: number; skipped: number };
  exitCode: number;
}
