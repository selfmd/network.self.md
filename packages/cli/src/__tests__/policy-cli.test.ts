import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { AgentDatabase } from '@networkselfmd/node';

it('registers real policy CLI commands without creating an identity or starting a node', () => {
  const directory = mkdtempSync(join(tmpdir(), 'nsmd-policy-cli-'));
  const run = (...args: string[]) => execFileSync(process.execPath,
    [fileURLToPath(new URL('../../dist/bin.js', import.meta.url)), 'policy', ...args],
    { encoding: 'utf8', env: { ...process.env, L2S_DATA_DIR: directory }, timeout: 10000 });
  try {
    expect(run('--help')).toContain('audit');
    expect(run('set', '--interests', 'coffee')).toContain('coffee');
    expect(run('get')).toContain('coffee');
    expect(run('audit', 'recent')).toMatch(/no|empty/i);
    const database = new AgentDatabase(directory);
    try { expect(database.getDb().prepare('SELECT COUNT(*) AS n FROM identity').get()).toEqual({ n: 0 }); }
    finally { database.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
