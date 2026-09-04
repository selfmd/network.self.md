import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { dashboardAgentOptions, dashboardServerOptions } from '../config.js';

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

  it('fails closed on a non-loopback bind without dashboard authentication', async () => {
    await expect(dashboardServerOptions({ HOST: '0.0.0.0' })).rejects.toThrow(
      /authentication is required/i,
    );
  });

  it('allows an unauthenticated loopback-only dashboard', async () => {
    await expect(
      dashboardServerOptions({ HOST: '127.0.0.1', PORT: '3001' }),
    ).resolves.toEqual({ host: '127.0.0.1', port: 3001, auth: undefined });
  });

  it('loads dashboard authentication from an owner secret file', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'nsmd-dashboard-auth-'));
    dirs.push(dataDir);
    const secretPath = join(dataDir, 'dashboard-secret');
    writeFileSync(secretPath, 'a-strong-dashboard-password\n', { mode: 0o600 });

    await expect(
      dashboardServerOptions({
        HOST: '0.0.0.0',
        DASHBOARD_USERNAME: 'operator',
        DASHBOARD_PASSWORD_FILE: secretPath,
      }),
    ).resolves.toEqual({
      host: '0.0.0.0',
      port: 3001,
      auth: { username: 'operator', password: 'a-strong-dashboard-password' },
    });
  });

  it('rejects partial, ambiguous, or weak dashboard credentials', async () => {
    await expect(
      dashboardServerOptions({ DASHBOARD_USERNAME: 'operator' }),
    ).rejects.toThrow(/configured together/i);
    await expect(
      dashboardServerOptions({
        DASHBOARD_USERNAME: 'operator',
        DASHBOARD_PASSWORD: 'short',
      }),
    ).rejects.toThrow(/at least 16/i);
    await expect(
      dashboardServerOptions({
        DASHBOARD_USERNAME: 'operator',
        DASHBOARD_PASSWORD: 'a-strong-dashboard-password',
        DASHBOARD_PASSWORD_FILE: '/unused',
      }),
    ).rejects.toThrow(/either/i);
  });
});
