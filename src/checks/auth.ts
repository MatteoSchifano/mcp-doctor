import { WELL_KNOWN } from '../protocol.ts';
import type { Check, HttpEvidence } from '../types.ts';
import { fail, pass, skip } from './helpers.ts';

export const authChecks: Check[] = [
  {
    id: 'auth.protected-resource-metadata',
    category: 'auth',
    appliesTo: 'http',
    description: 'The OAuth Protected Resource Metadata document is exposed and readable.',
    run(ctx) {
      if (ctx.evidence.kind !== 'http') return [];
      const e = ctx.evidence as HttpEvidence;
      const base = {
        id: 'auth.protected-resource-metadata',
        category: 'auth' as const,
        title: 'OAuth discovery',
        severity: 'error' as const,
      };
      const meta = e.auth.protectedResourceMetadata;
      if (!meta) return [skip(base, 'not checked')];

      // The metadata document only matters if the server *asks* for a
      // credential. A 400 "not initialized" is not a 401: don't demand OAuth.
      const status = e.auth.challenge?.status ?? 0;
      const demandsAuth = status === 401 || status === 403;
      const isPublic = e.auth.unauthenticated?.allowed === true;

      if (!meta.ok && isPublic) {
        return [pass(base, 'public server, no OAuth flow to discover')];
      }
      if (!meta.ok && !demandsAuth) {
        return [
          skip(base, `anonymous request → ${status || 'no response'}: the server asks for no credential, nothing to discover`),
        ];
      }
      if (!meta.ok) {
        return [
          fail(
            base,
            `${WELL_KNOWN.protectedResource} → ${meta.status === 0 ? 'unreachable' : meta.status}`,
            'Clients cannot discover the authorization server. Expose the metadata document, or the flow dies before the token request and the user just sees "failed to connect".',
            { url: meta.url, status: meta.status },
          ),
        ];
      }
      if (!meta.authorizationServers || meta.authorizationServers.length === 0) {
        return [
          fail(
            base,
            'metadata present but has no authorization_servers',
            'The authorization_servers field is how a client learns where to ask for a token. Without it, the document is useless.',
            { url: meta.url },
          ),
        ];
      }
      return [pass(base, `${meta.authorizationServers.length} authorization servers declared`, { url: meta.url })];
    },
  },

  {
    id: 'auth.authorization-server-metadata',
    category: 'auth',
    appliesTo: 'http',
    description: 'The declared authorization server answers on its own metadata document.',
    run(ctx) {
      if (ctx.evidence.kind !== 'http') return [];
      const e = ctx.evidence as HttpEvidence;
      const base = {
        id: 'auth.authorization-server-metadata',
        category: 'auth' as const,
        title: 'authorization server',
        severity: 'error' as const,
      };
      const meta = e.auth.authorizationServerMetadata;
      if (!meta) return [skip(base, 'no authorization server declared')];
      if (!meta.ok) {
        return [
          fail(
            base,
            `${meta.url} → ${meta.status === 0 ? 'unreachable' : meta.status}`,
            'The protected resource metadata points at an issuer that does not answer. The OAuth flow fails at the second step — after the client has already shown the user a login screen.',
            { url: meta.url, status: meta.status },
          ),
        ];
      }
      return [pass(base, 'metadata reachable', { url: meta.url })];
    },
  },

  {
    id: 'auth.challenge',
    category: 'auth',
    appliesTo: 'http',
    description: 'The 401 carries a well-formed `WWW-Authenticate` header.',
    run(ctx) {
      if (ctx.evidence.kind !== 'http') return [];
      const e = ctx.evidence as HttpEvidence;
      const base = { id: 'auth.challenge', category: 'auth' as const, title: '401 challenge', severity: 'error' as const };
      const challenge = e.auth.challenge;
      if (!challenge) return [skip(base, 'not checked')];
      if (challenge.status !== 401) {
        return [skip(base, `anonymous request → ${challenge.status}, no challenge to validate`)];
      }
      if (!challenge.wwwAuthenticate) {
        return [
          fail(
            base,
            '401 with no WWW-Authenticate',
            'The client has no idea what kind of credential it needs or where to get one, so it cannot start the OAuth flow. Answer with: WWW-Authenticate: Bearer resource_metadata="…".',
          ),
        ];
      }
      if (!challenge.wellFormed) {
        return [
          fail(
            base,
            `non-conforming challenge: ${challenge.wwwAuthenticate}`,
            'The scheme must be Bearer. MCP clients do not handle other schemes.',
          ),
        ];
      }
      return [pass(base, 'WWW-Authenticate present and well-formed', { challenge: challenge.wwwAuthenticate })];
    },
  },

  {
    id: 'auth.scopes',
    category: 'auth',
    appliesTo: 'http',
    description: 'Scopes required by the challenge match the ones declared in the metadata.',
    run(ctx) {
      if (ctx.evidence.kind !== 'http') return [];
      const e = ctx.evidence as HttpEvidence;
      const base = { id: 'auth.scopes', category: 'auth' as const, title: 'scopes', severity: 'warn' as const };
      const required = e.auth.requiredScopes;
      const declared = e.auth.protectedResourceMetadata?.scopesSupported;
      if (!required || required.length === 0) return [skip(base, 'no scopes required by the challenge')];
      if (!declared || declared.length === 0) {
        return [
          fail(
            base,
            `required ${required.join(', ')}, nothing in scopes_supported`,
            'Add scopes_supported to the protected resource metadata: the client has to request the right scopes on its first attempt, otherwise the user authorizes twice.',
            { required },
          ),
        ];
      }
      const missing = required.filter((s) => !declared.includes(s));
      if (missing.length > 0) {
        return [
          fail(
            base,
            `required but not declared: ${missing.join(', ')}`,
            'The server demands scopes that never appear in scopes_supported. Clients will only request them by guessing.',
            { required, declared },
          ),
        ];
      }
      return [pass(base, `${required.length} scopes consistent with the metadata`, { required })];
    },
  },

  {
    id: 'auth.unauthenticated-access',
    category: 'auth',
    appliesTo: 'http',
    description: 'A server that advertises OAuth must not serve tools to anonymous requests.',
    run(ctx) {
      if (ctx.evidence.kind !== 'http') return [];
      const e = ctx.evidence as HttpEvidence;
      const base = {
        id: 'auth.unauthenticated-access',
        category: 'auth' as const,
        title: 'anonymous access',
        severity: 'error' as const,
      };
      const anon = e.auth.unauthenticated;
      const challengeStatus = e.auth.challenge?.status ?? 0;
      if (!anon && challengeStatus === 401) return [pass(base, 'anonymous requests rejected with 401')];
      if (!anon) return [skip(base, 'no response to the anonymous request')];
      if (!anon.allowed) return [pass(base, `anonymous request → ${anon.status}`)];

      const declaresOAuth = e.auth.protectedResourceMetadata?.ok === true;
      if (declaresOAuth) {
        return [
          fail(
            base,
            `tools/list without a credential → 200 with ${anon.toolCount ?? '?'} tools`,
            'The server publishes OAuth protected resource metadata but does not enforce authentication. Anyone who knows the URL can enumerate and call the tools.',
            { toolCount: anon.toolCount },
          ),
        ];
      }
      return [
        {
          ...base,
          severity: 'info',
          status: 'pass',
          detail: `public server: ${anon.toolCount ?? 0} tools reachable without a credential`,
          data: { toolCount: anon.toolCount },
        },
      ];
    },
  },
];
