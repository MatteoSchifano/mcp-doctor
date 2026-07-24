import { HEADERS, REVISION_MODERN, isKnownRevision } from '../protocol.ts';
import type { Check, HttpEvidence, StdioEvidence } from '../types.ts';
import { fail, pass, skip } from './helpers.ts';

export const protocolChecks: Check[] = [
  {
    id: 'protocol.era',
    category: 'protocol',
    appliesTo: 'both',
    description: 'Detects whether the server is modern (stateless) or legacy (handshake + sessions).',
    run(ctx) {
      const e = ctx.evidence;
      const base = { id: 'protocol.era', category: 'protocol' as const, title: 'era detected', severity: 'info' as const };
      if (e.era === 'modern') return [pass(base, 'modern (stateless, no handshake)', { evidence: e.eraEvidence })];
      if (e.era === 'legacy') {
        return [
          {
            ...base,
            status: 'fail',
            severity: 'info',
            detail: 'legacy (handshake + Mcp-Session-Id)',
            remediation: `Working, but clients that only speak ${REVISION_MODERN} will not connect. Run "mcp-doctor migrate" for the delta.`,
            data: { evidence: e.eraEvidence },
          },
        ];
      }
      return [
        fail(
          base,
          `could not determine: ${e.eraEvidence}`,
          'Neither a self-contained request nor an initialize handshake produced a valid response. Either the server does not speak MCP on this endpoint, or something else is answering (a proxy, a login page, a different API).',
        ),
      ];
    },
  },

  {
    id: 'protocol.version',
    category: 'protocol',
    appliesTo: 'both',
    description: 'The negotiated revision is a known one and consistent with the detected era.',
    run(ctx) {
      const e = ctx.evidence;
      const base = { id: 'protocol.version', category: 'protocol' as const, title: 'version', severity: 'error' as const };
      const version = e.negotiatedVersion;
      if (!version) {
        if (e.era === 'unknown') return [skip(base, 'era not determined')];
        return [
          {
            ...base,
            status: 'fail',
            severity: 'warn',
            detail: 'no version declared in the response',
            remediation: `Declare the supported revision in the ${HEADERS.protocolVersion} header: without it, clients have to guess which dialect you speak.`,
          },
        ];
      }
      if (!isKnownRevision(version)) {
        return [
          fail(
            base,
            `unknown revision: ${version}`,
            'That string matches no published revision of the specification. Check you are not sending an internal version or a placeholder.',
            { version },
          ),
        ];
      }
      return [pass(base, version, { version })];
    },
  },

  {
    id: 'protocol.routing-headers',
    category: 'protocol',
    appliesTo: 'http',
    description: `Conformance to the ${HEADERS.method} / ${HEADERS.name} headers introduced in ${REVISION_MODERN}.`,
    run(ctx) {
      if (ctx.evidence.kind !== 'http') return [];
      const e = ctx.evidence as HttpEvidence;
      const base = {
        id: 'protocol.routing-headers',
        category: 'protocol' as const,
        title: 'routing headers',
        severity: 'warn' as const,
      };
      if (e.era !== 'modern') return [skip(base, `introduced in ${REVISION_MODERN}`)];
      if (!e.headerConformance) return [skip(base, 'not checked')];

      const problems: string[] = [];
      if (e.headerConformance.acceptsWithoutMcpMethod) problems.push(`accepts requests without ${HEADERS.method}`);
      if (!e.headerConformance.echoesMcpName) problems.push(`${HEADERS.name} missing from responses`);

      if (problems.length === 0) return [pass(base, `${HEADERS.method} and ${HEADERS.name} conform`)];
      return [
        fail(
          base,
          problems.join('; '),
          `Gateways use ${HEADERS.method} and ${HEADERS.name} to route without reading the body. Without them every hop has to deserialize the JSON-RPC — it works, but it rules out deploying behind gateways that route on headers.`,
          { conformance: e.headerConformance },
        ),
      ];
    },
  },

  {
    id: 'protocol.discover',
    category: 'protocol',
    appliesTo: 'both',
    description: '`server/discover` is implemented and consistent with `tools/list`.',
    run(ctx) {
      const e = ctx.evidence;
      const base = {
        id: 'protocol.discover',
        category: 'protocol' as const,
        title: 'server/discover',
        severity: 'warn' as const,
      };
      if (e.era !== 'modern') return [skip(base, `introduced in ${REVISION_MODERN}`)];
      if (!e.discover?.supported) {
        return [
          fail(
            base,
            `not implemented${e.discover?.error ? ` (${e.discover.error})` : ''}`,
            `${REVISION_MODERN} uses server/discover to publish capabilities without a handshake. Without it, clients have to infer them by calling every list method.`,
          ),
        ];
      }
      const declared = e.discover.toolNames;
      const listed = (e.tools ?? []).map((t) => (typeof t.name === 'string' ? t.name : '')).filter(Boolean);
      if (declared.length > 0 && listed.length > 0) {
        const missing = declared.filter((n) => !listed.includes(n));
        const extra = listed.filter((n) => !declared.includes(n));
        if (missing.length > 0 || extra.length > 0) {
          return [
            fail(
              base,
              `inconsistent with tools/list (${missing.length} only in discover, ${extra.length} only in list)`,
              'The two lists must agree: a client that trusts discover will never see the tools that only appear in tools/list.',
              { onlyInDiscover: missing, onlyInList: extra },
            ),
          ];
        }
      }
      return [pass(base, `responds, ${declared.length || listed.length} tools declared`)];
    },
  },

  {
    id: 'protocol.error-shape',
    category: 'protocol',
    appliesTo: 'http',
    description: 'Error responses are well-formed JSON-RPC, not opaque 500s.',
    run(ctx) {
      if (ctx.evidence.kind !== 'http') return [];
      const e = ctx.evidence as HttpEvidence;
      const base = {
        id: 'protocol.error-shape',
        category: 'protocol' as const,
        title: 'JSON-RPC errors',
        severity: 'error' as const,
      };
      if (!e.errorShape?.checked) return [skip(base, e.errorShape?.detail ?? 'not checked')];
      if (!e.errorShape.valid) {
        return [
          fail(
            base,
            `nonexistent method → ${e.errorShape.detail}`,
            'An unknown method must produce a JSON-RPC error with a code and a message. Without it, the client cannot tell "method not supported" from "server is broken", and shows the user the same generic message either way.',
          ),
        ];
      }
      return [pass(base, `nonexistent method → well-formed error (${e.errorShape.detail})`)];
    },
  },

  {
    id: 'protocol.session-residue',
    category: 'protocol',
    appliesTo: 'http',
    description: `The server no longer emits ${HEADERS.session}, removed in ${REVISION_MODERN}.`,
    run(ctx) {
      if (ctx.evidence.kind !== 'http') return [];
      const e = ctx.evidence as HttpEvidence;
      const base = {
        id: 'protocol.session-residue',
        category: 'protocol' as const,
        title: 'session residue',
        severity: 'warn' as const,
      };
      if (e.era !== 'modern') return [skip(base, 'legacy-era server: sessions are expected')];
      if (e.sessionHeaderSeen) {
        return [
          fail(
            base,
            `${HEADERS.session} still emitted`,
            `Protocol-level sessions no longer exist in ${REVISION_MODERN}. If the server still keeps per-session state, convert it into explicit handles passed as tool arguments.`,
          ),
        ];
      }
      return [pass(base, `no ${HEADERS.session}`)];
    },
  },

  {
    id: 'protocol.stdio-era',
    category: 'protocol',
    appliesTo: 'stdio',
    description: 'Consistency of the detected era over the stdio transport.',
    run(ctx) {
      if (ctx.evidence.kind !== 'stdio') return [];
      const e = ctx.evidence as StdioEvidence;
      const base = {
        id: 'protocol.stdio-era',
        category: 'protocol' as const,
        title: 'stdio handshake',
        severity: 'warn' as const,
      };
      if (e.era === 'modern') return [pass(base, 'no handshake required')];
      if (e.era === 'legacy') {
        return [
          fail(
            base,
            'requires initialize',
            `The server only accepts the legacy handshake. A ${REVISION_MODERN} client sends the request straight away and will get an error back.`,
          ),
        ];
      }
      return [skip(base, e.eraEvidence)];
    },
  },
];
