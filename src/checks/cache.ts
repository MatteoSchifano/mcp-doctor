import { REVISION_MODERN } from '../protocol.ts';
import type { Check } from '../types.ts';
import { pass, skip } from './helpers.ts';

export const cacheChecks: Check[] = [
  {
    id: 'cache.list-hints',
    category: 'cache',
    appliesTo: 'both',
    description: '`ttlMs` / `cacheScope` on list results, introduced in 2026-07-28.',
    run(ctx) {
      const base = { id: 'cache.list-hints', category: 'cache' as const, title: 'cache hints', severity: 'info' as const };
      const e = ctx.evidence;
      if (e.era !== 'modern') return [skip(base, `introduced in ${REVISION_MODERN}`)];
      const meta = e.listResultMeta;
      const has = meta && (meta.ttlMs !== undefined || meta.cacheScope !== undefined);
      if (has) {
        return [
          pass(base, `ttlMs: ${String(meta?.ttlMs ?? '—')}, cacheScope: ${String(meta?.cacheScope ?? '—')}`, {
            ttlMs: meta?.ttlMs,
            cacheScope: meta?.cacheScope,
          }),
        ];
      }
      return [
        {
          ...base,
          status: 'fail',
          severity: 'info',
          detail: 'list result without ttlMs / cacheScope',
          remediation:
            'Without hints, every client re-runs tools/list on every session. Declaring even a generous ttlMs cuts traffic and perceived startup time.',
        },
      ];
    },
  },
];
