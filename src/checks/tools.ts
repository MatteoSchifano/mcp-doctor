/**
 * Tool quality checks.
 *
 * These are opinion, not spec: a server can be perfectly conformant and still
 * ship tools the model will never pick. That's why none of them is an `error`
 * except the ones the spec is explicit about (names, schemas), and all of them
 * can be switched off from `.mcp-doctor.json`.
 */

import type { Check, ToolDef } from '../types.ts';
import { fail, pass, skip } from './helpers.ts';

const TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,128}$/;

function toolsOf(ctx: { evidence: { tools?: ToolDef[]; toolsListError?: string } }): ToolDef[] | undefined {
  return ctx.evidence.tools;
}

function nameOf(tool: ToolDef, index: number): string {
  return typeof tool.name === 'string' && tool.name.length > 0 ? tool.name : `#${index}`;
}

export const toolChecks: Check[] = [
  {
    id: 'tools.list',
    category: 'tools',
    appliesTo: 'both',
    description: '`tools/list` responds and every tool has a plausible JSON Schema as `inputSchema`.',
    run(ctx) {
      const base = { id: 'tools.list', category: 'tools' as const, title: 'tools/list', severity: 'error' as const };
      const tools = toolsOf(ctx);
      if (!tools) {
        return [
          fail(
            base,
            ctx.evidence.toolsListError ?? 'no response',
            'Without tools/list the server is unusable: it is the first thing every client calls. Check the method is registered and does not require session state the client has no way to establish.',
          ),
        ];
      }
      const invalid: string[] = [];
      tools.forEach((tool, i) => {
        const schema = tool.inputSchema;
        if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
          invalid.push(`${nameOf(tool, i)} (inputSchema missing or not an object)`);
          return;
        }
        const s = schema as Record<string, unknown>;
        if (s.type !== 'object') {
          invalid.push(`${nameOf(tool, i)} (inputSchema.type ≠ "object")`);
          return;
        }
        if (s.properties !== undefined && (typeof s.properties !== 'object' || s.properties === null)) {
          invalid.push(`${nameOf(tool, i)} (properties is not an object)`);
          return;
        }
        if (s.required !== undefined && !Array.isArray(s.required)) {
          invalid.push(`${nameOf(tool, i)} (required is not an array)`);
          return;
        }
        if (Array.isArray(s.required) && typeof s.properties === 'object' && s.properties !== null) {
          const props = Object.keys(s.properties as Record<string, unknown>);
          const orphans = (s.required as unknown[]).filter((r) => typeof r === 'string' && !props.includes(r));
          if (orphans.length > 0) {
            invalid.push(`${nameOf(tool, i)} (required names fields that don't exist: ${orphans.join(', ')})`);
          }
        }
      });

      if (invalid.length > 0) {
        return [
          fail(
            base,
            `${tools.length} tools, ${invalid.length} with an invalid inputSchema`,
            `An invalid schema either breaks client-side validation or, worse, lets malformed arguments through to your server. To fix: ${invalid.slice(0, 5).join('; ')}${invalid.length > 5 ? ' …' : ''}`,
            { invalid },
          ),
        ];
      }
      return [pass(base, `${tools.length} tools, all with a valid inputSchema`, { count: tools.length })];
    },
  },

  {
    id: 'tools.names',
    category: 'tools',
    appliesTo: 'both',
    description: 'Tool names are present, unique, and match the allowed pattern.',
    run(ctx) {
      const base = { id: 'tools.names', category: 'tools' as const, title: 'names', severity: 'error' as const };
      const tools = toolsOf(ctx);
      if (!tools) return [skip(base, 'tools/list unavailable')];

      const seen = new Map<string, number>();
      const malformed: string[] = [];
      tools.forEach((tool, i) => {
        if (typeof tool.name !== 'string' || tool.name.length === 0) {
          malformed.push(`#${i} (name missing)`);
          return;
        }
        if (!TOOL_NAME_RE.test(tool.name)) malformed.push(`${tool.name} (disallowed characters)`);
        seen.set(tool.name, (seen.get(tool.name) ?? 0) + 1);
      });
      const duplicates = [...seen.entries()].filter(([, n]) => n > 1).map(([name, n]) => `"${name}" ×${n}`);

      if (duplicates.length > 0) {
        return [
          fail(
            base,
            `duplicate names: ${duplicates.join(', ')}`,
            'Clients index tools by name: the duplicate overwrites the earlier one and one of the two becomes unreachable, with no visible error anywhere.',
            { duplicates },
          ),
        ];
      }
      if (malformed.length > 0) {
        return [
          fail(
            base,
            `${malformed.length} non-conforming names`,
            `Use only [a-zA-Z0-9_-]. To fix: ${malformed.slice(0, 5).join(', ')}${malformed.length > 5 ? ' …' : ''}`,
            { malformed },
          ),
        ];
      }
      return [pass(base, `${tools.length} unique, conforming names`)];
    },
  },

  {
    id: 'tools.descriptions',
    category: 'tools',
    appliesTo: 'both',
    description: 'Every tool has a description long enough to be useful to the model.',
    run(ctx) {
      const base = { id: 'tools.descriptions', category: 'tools' as const, title: 'descriptions', severity: 'warn' as const };
      const tools = toolsOf(ctx);
      if (!tools) return [skip(base, 'tools/list unavailable')];

      const missing: string[] = [];
      const tooShort: string[] = [];
      tools.forEach((tool, i) => {
        const d = tool.description;
        if (typeof d !== 'string' || d.trim().length === 0) missing.push(nameOf(tool, i));
        else if (d.trim().length < ctx.config.minDescriptionLength) tooShort.push(nameOf(tool, i));
      });

      if (missing.length > 0) {
        return [
          fail(
            base,
            `${missing.length} tools with no description`,
            `A tool with no description technically works, but the model will never choose it: the description is the only signal it has. To write: ${missing.join(', ')}`,
            { missing, tooShort },
          ),
        ];
      }
      if (tooShort.length > 0) {
        return [
          fail(
            base,
            `${tooShort.length} descriptions under ${ctx.config.minDescriptionLength} characters`,
            `Describe when to use the tool, not just what it does: ${tooShort.join(', ')}. Threshold tunable via "minDescriptionLength" in .mcp-doctor.json.`,
            { tooShort },
          ),
        ];
      }
      return [pass(base, 'all present')];
    },
  },

  {
    id: 'tools.annotations',
    category: 'tools',
    appliesTo: 'both',
    description: '`readOnlyHint` / `destructiveHint` declared, so clients can decide when to ask for confirmation.',
    run(ctx) {
      const base = { id: 'tools.annotations', category: 'tools' as const, title: 'annotations', severity: 'warn' as const };
      const tools = toolsOf(ctx);
      if (!tools || tools.length === 0) return [skip(base, 'tools/list unavailable')];

      const withAnnotations = tools.filter((t) => {
        const a = t.annotations;
        return typeof a === 'object' && a !== null && ('readOnlyHint' in a || 'destructiveHint' in a);
      });

      if (withAnnotations.length === 0) {
        return [
          fail(
            base,
            'no tool declares readOnlyHint',
            'Without annotations a client cannot tell a read from a destructive write, so it either confirms everything or nothing. Declare at least readOnlyHint on your read-only tools.',
          ),
        ];
      }
      if (withAnnotations.length < tools.length) {
        const missing = tools.filter((t) => !withAnnotations.includes(t)).map((t, i) => nameOf(t, i));
        return [
          fail(
            base,
            `${tools.length - withAnnotations.length}/${tools.length} tools without annotations`,
            `To annotate: ${missing.slice(0, 6).join(', ')}${missing.length > 6 ? ' …' : ''}`,
            { missing },
          ),
        ];
      }
      return [pass(base, `all ${tools.length} tools annotated`)];
    },
  },

  {
    id: 'tools.output-schema',
    category: 'tools',
    appliesTo: 'both',
    description: '`outputSchema` present where the response has structure.',
    run(ctx) {
      const base = { id: 'tools.output-schema', category: 'tools' as const, title: 'outputSchema', severity: 'info' as const };
      const tools = toolsOf(ctx);
      if (!tools || tools.length === 0) return [skip(base, 'tools/list unavailable')];
      const withOutput = tools.filter((t) => typeof t.outputSchema === 'object' && t.outputSchema !== null);
      if (withOutput.length === tools.length) return [pass(base, 'declared on every tool')];
      return [
        {
          ...base,
          status: 'fail',
          severity: 'info',
          detail: `${tools.length - withOutput.length}/${tools.length} tools without outputSchema`,
          remediation:
            'Where the response is structured, declaring it lets clients validate it and lets the model know what to expect before it calls.',
        },
      ];
    },
  },
];
