import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { dashboardAgentOptions } from '../config.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe('dashboard protected startup', () => {
  it('passes L2S_PASSPHRASE_FILE through to Agent', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'nsmd-dashboard-startup-'));
    dirs.push(dataDir);
    const secretPath = join(dataDir, 'secret');
    writeFileSync(secretPath, 'dashboard-provider-passphrase\n', { mode: 0o600 });

    const options = dashboardAgentOptions({
      L2S_DATA_DIR: dataDir,
      L2S_PASSPHRASE_FILE: secretPath,
    });
    expect(options.dataDir).toBe(dataDir);
    expect(options.passphrase).toBeUndefined();
    expect(await options.secretProvider!()).toBe('dashboard-provider-passphrase');
  });

  it('passes a direct service passphrase through to Agent options', () => {
    const options = dashboardAgentOptions({
      L2S_PASSPHRASE: 'dashboard-direct-passphrase',
    });
    expect(options.passphrase).toBe('dashboard-direct-passphrase');
    expect(options.secretProvider).toBeUndefined();
  });
});
