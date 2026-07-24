import type { Check, HttpEvidence } from '../types.ts';
import { fail, pass, skip } from './helpers.ts';

function http(ctx: { evidence: { kind: string } }): HttpEvidence | undefined {
  return ctx.evidence.kind === 'http' ? (ctx.evidence as HttpEvidence) : undefined;
}

export const transportChecks: Check[] = [
  {
    id: 'transport.dns-tls',
    category: 'transport',
    appliesTo: 'http',
    description: 'DNS resolution, certificate validity and days until expiry.',
    run(ctx) {
      const e = http(ctx);
      if (!e) return [];
      const base = {
        id: 'transport.dns-tls',
        category: 'transport' as const,
        title: 'DNS + TLS',
        severity: 'error' as const,
      };

      if (e.dns?.error) {
        return [
          fail(
            base,
            `DNS does not resolve: ${e.dns.error}`,
            `Check that ${e.host} exists and is publicly resolvable. If the server is internal, run mcp-doctor from the same network.`,
          ),
        ];
      }
      if (!e.tls?.checked) {
        return [pass(base, `DNS ok (${e.dns?.addresses[0] ?? '—'}), plaintext endpoint: TLS not applicable`)];
      }
      if (!e.tls.valid) {
        return [
          fail(
            base,
            `invalid certificate: ${e.tls.error ?? 'unknown reason'}`,
            'An invalid certificate makes every MCP client fail before any request is sent. Renew it, or fix the certificate chain.',
            { issuer: e.tls.issuer, validTo: e.tls.validTo },
          ),
        ];
      }
      const days = e.tls.daysToExpiry;
      const warnDays = ctx.config.certWarnDays;
      if (typeof days === 'number' && days <= warnDays) {
        return [
          {
            ...base,
            severity: 'warn',
            status: 'fail',
            detail: days < 0 ? 'certificate expired' : `certificate expires in ${days} days`,
            remediation:
              'Renew before expiry: the moment it lapses, the server becomes unreachable for every client at once.',
            data: { validTo: e.tls.validTo, daysToExpiry: days },
          },
        ];
      }
      return [
        pass(base, `valid certificate${typeof days === 'number' ? `, expires in ${days} days` : ''}`, {
          issuer: e.tls.issuer,
          validTo: e.tls.validTo,
        }),
      ];
    },
  },

  {
    id: 'transport.reachable',
    category: 'transport',
    appliesTo: 'http',
    description: 'The endpoint answers, and how fast.',
    run(ctx) {
      const e = http(ctx);
      if (!e) return [];
      const base = {
        id: 'transport.reachable',
        category: 'transport' as const,
        title: 'endpoint reachable',
        severity: 'error' as const,
      };
      if (!e.reachable || e.reachable.error) {
        return [
          fail(
            base,
            e.reachable?.error ?? 'no response',
            'The server is not answering at all. Check that the process is running and the port is exposed: no other check means anything while this one fails.',
          ),
        ];
      }
      const { status, ms } = e.reachable;
      if (ms > ctx.config.slowMs) {
        return [
          {
            ...base,
            severity: 'warn',
            status: 'fail',
            detail: `${status} in ${ms}ms`,
            remediation: `Past ${ctx.config.slowMs}ms clients tend to time out on their first requests. Look at cold starts and backend latency.`,
            data: { status, ms },
          },
        ];
      }
      return [pass(base, `${status} in ${ms}ms`, { status, ms })];
    },
  },

  {
    id: 'transport.path-routing',
    category: 'transport',
    appliesTo: 'http',
    description: 'The MCP path is routed: tells a reverse-proxy 404 apart from an application 404.',
    run(ctx) {
      const e = http(ctx);
      if (!e?.routing) return [];
      const base = {
        id: 'transport.path-routing',
        category: 'transport' as const,
        title: 'path routing',
        severity: 'error' as const,
      };
      const path = new URL(e.url).pathname;

      if (e.routing.looksLikeProxy404) {
        return [
          fail(
            base,
            `404 with a ${e.routing.contentType ?? 'non-JSON'} body: the reverse proxy is answering, not your MCP server`,
            `There is no location block for ${path}. Clients report this as "failed to connect", indistinguishable from a server that is simply down. Add the proxy_pass to the MCP process.`,
            { status: 404, contentType: e.routing.contentType, body: e.routing.bodySnippet },
          ),
        ];
      }
      if (e.routing.status === 404) {
        return [
          fail(
            base,
            '404 from the server',
            `Path ${path} is not served. Check where the MCP app is mounted: it is often /mcp while the configured URL points at the root.`,
          ),
        ];
      }
      if (e.routing.status >= 500) {
        return [
          fail(
            base,
            `HTTP ${e.routing.status}`,
            'Server-side error on the very first request. Check your application logs: the client receives nothing it can use.',
            { body: e.routing.bodySnippet },
          ),
        ];
      }
      if (e.routing.status >= 300 && e.routing.status < 400) {
        return [
          {
            ...base,
            severity: 'warn',
            status: 'fail',
            detail: `HTTP ${e.routing.status}: redirect on POST`,
            remediation:
              'Several clients do not follow redirects on JSON-RPC POSTs. Serve the endpoint directly on the published URL.',
          },
        ];
      }
      return [pass(base, `POST ${path} routed correctly`)];
    },
  },

  {
    id: 'transport.cors',
    category: 'transport',
    appliesTo: 'http',
    description: 'CORS headers for browser-originated clients.',
    run(ctx) {
      const e = http(ctx);
      if (!e?.cors) return [];
      const base = { id: 'transport.cors', category: 'transport' as const, title: 'CORS', severity: 'warn' as const };
      if (!e.cors.checked) return [skip(base, 'preflight not performed')];
      if (!e.cors.allowOrigin) {
        return [
          fail(
            base,
            `OPTIONS preflight → ${e.cors.status}, no Access-Control-Allow-Origin`,
            'Browser-originated clients (Claude.ai and friends) will not be able to connect. If this server is only meant for local clients, disable this check with "transport.cors" in .mcp-doctor.json.',
            { status: e.cors.status },
          ),
        ];
      }
      return [pass(base, `Allow-Origin: ${e.cors.allowOrigin}`)];
    },
  },
];
