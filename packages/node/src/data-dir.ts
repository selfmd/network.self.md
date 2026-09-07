import { homedir } from 'node:os';
import { resolve } from 'node:path';

/** Expand the same home shorthand accepted by the CLI and MCP entry points. */
export function resolveDataDir(dataDir: string): string {
  if (dataDir === '~') return homedir();
  if (dataDir.startsWith('~/')) return resolve(homedir(), dataDir.slice(2));
  return resolve(dataDir);
}
