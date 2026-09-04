import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadOrCreateTTYASecret } from '../ttya-secret.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('TTYA PSK provisioning', () => {
  it('atomically creates and reuses an owner-only 32-byte raw key', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ttya-psk-'));
    directories.push(directory);
    const keyPath = join(directory, 'nested', 'ttya.psk');

    const first = loadOrCreateTTYASecret(keyPath, undefined);
    const second = loadOrCreateTTYASecret(keyPath, undefined);

    expect(first).toHaveLength(32);
    expect(second).toEqual(first);
    expect(readFileSync(keyPath)).toEqual(Buffer.from(first));
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
  });

  it('accepts canonical environment hex and rejects short secrets', () => {
    const path = join(tmpdir(), 'unused-ttya.psk');
    expect(loadOrCreateTTYASecret(path, 'ab'.repeat(32))).toEqual(
      new Uint8Array(32).fill(0xab),
    );
    expect(() => loadOrCreateTTYASecret(path, 'ab'.repeat(31))).toThrow(
      /at least 32 random bytes/i,
    );
  });
});
