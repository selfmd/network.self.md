import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { agentSecretOptions, readHiddenPassphrase } from '../agent-options.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe('CLI protected startup', () => {
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
