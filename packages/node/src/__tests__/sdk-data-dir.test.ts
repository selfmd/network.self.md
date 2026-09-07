import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const home = vi.hoisted(() => ({ path: '' }));
vi.mock('node:os', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:os')>(),
  homedir: () => home.path,
}));
vi.mock('hyperswarm', () => ({ default: class {
  on() {}
  join() { return { flushed: async () => {} }; }
  async leave() {}
  async destroy() {}
} }));
import { Agent } from '../agent.js';
import { resolveDataDir } from '../data-dir.js';

beforeEach(() => { home.path = mkdtempSync(join(tmpdir(), 'nsmd-sdk-home-')); });
afterEach(() => { rmSync(home.path, { recursive: true, force: true }); });

describe('SDK data directory', () => {
  it('uses the same persisted identity through home shorthand and an absolute path', async () => {
    const first = new Agent({ dataDir: '~/agent', displayName: 'Home agent' });
    let fingerprint: string;
    try {
      await first.start();
      fingerprint = first.identity.fingerprint;
    } finally { await first.stop(); }
    const reopened = new Agent({ dataDir: join(home.path, 'agent') });
    try {
      await reopened.start();
      expect(reopened.identity.fingerprint).toBe(fingerprint!);
      expect(reopened.identity.displayName).toBe('Home agent');
    } finally { await reopened.stop(); }
  });

  it('expands a bare home shorthand and preserves ordinary path meaning', () => {
    expect(resolveDataDir('~')).toBe(home.path);
    expect(resolveDataDir('./data')).toBe(resolve('data'));
    expect(resolveDataDir('~someone/data')).toBe(resolve('~someone/data'));
  });
});
