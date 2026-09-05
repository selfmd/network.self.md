import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

import { agentSecretOptions, getDataDir, readHiddenPassphrase } from '../agent-options.js';

const dirs: string[] = [];
afterEach(() => {
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
  vi.unstubAllEnvs();
});

describe('CLI protected startup', () => {
  it('expands a quoted home-directory data path', () => {
    vi.stubEnv('L2S_DATA_DIR', '~/.networkselfmd');
    expect(getDataDir()).toBe(join(homedir(), '.networkselfmd'));
    vi.stubEnv('L2S_DATA_DIR', '~');
    expect(getDataDir()).toBe(homedir());
  });

  it('passes a passphrase file provider through to Agent', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nsmd-cli-startup-'));
    dirs.push(directory);
    const secretPath = join(directory, 'secret');
    writeFileSync(secretPath, 'cli-provider-passphrase\n', { mode: 0o600 });

    const options = await agentSecretOptions({ passphraseFile: secretPath });
    expect(options.passphrase).toBeUndefined();
    expect(await options.secretProvider!()).toBe('cli-provider-passphrase');
  });

  it('refuses interactive passphrase input without a TTY', async () => {
    await expect(readHiddenPassphrase()).rejects.toThrow(
      '--passphrase-file',
    );
  });
});
