import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import type { DoctorConfig } from './types.ts';

export const DEFAULT_CONFIG: DoctorConfig = {
  disabled: [],
  minDescriptionLength: 20,
  certWarnDays: 21,
  slowMs: 1500,
};

const CONFIG_FILENAMES = ['.mcp-doctor.json', 'mcp-doctor.config.json'];

/**
 * Quality checks ("description too short") are opinion, not spec: they have to
 * be individually switchable. Config is looked up by walking up from the cwd,
 * falling back to the defaults.
 */
export async function loadConfig(cwd = process.cwd()): Promise<DoctorConfig> {
  let dir = resolve(cwd);
  for (;;) {
    for (const name of CONFIG_FILENAMES) {
      try {
        const raw = await readFile(resolve(dir, name), 'utf8');
        return mergeConfig(JSON.parse(raw) as Partial<DoctorConfig>);
      } catch {
        // Missing or unreadable file: keep walking up.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return { ...DEFAULT_CONFIG };
    dir = parent;
  }
}

export function mergeConfig(partial: Partial<DoctorConfig>): DoctorConfig {
  return {
    disabled: Array.isArray(partial.disabled) ? partial.disabled.map(String) : DEFAULT_CONFIG.disabled,
    minDescriptionLength:
      typeof partial.minDescriptionLength === 'number'
        ? partial.minDescriptionLength
        : DEFAULT_CONFIG.minDescriptionLength,
    certWarnDays:
      typeof partial.certWarnDays === 'number' ? partial.certWarnDays : DEFAULT_CONFIG.certWarnDays,
    slowMs: typeof partial.slowMs === 'number' ? partial.slowMs : DEFAULT_CONFIG.slowMs,
  };
}

/** Supports the exact id (`tools.duplicate-names`) and the category glob (`tools.*`). */
export function isDisabled(config: DoctorConfig, id: string): boolean {
  return config.disabled.some((pattern) => {
    if (pattern === id) return true;
    if (pattern.endsWith('.*')) return id.startsWith(pattern.slice(0, -1));
    return false;
  });
}
