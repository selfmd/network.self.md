import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute as pathIsAbsolute, join } from 'node:path';
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
      L2S_PASSPHRASE: 'stale-environment-passphrase',
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

  it('expands a configured home path instead of creating another identity below the current directory', () => {
    expect(dashboardAgentOptions({ HOME: '/operator', L2S_DATA_DIR: '~/.networkselfmd' }).dataDir).toBe('/operator/.networkselfmd');
    expect(dashboardAgentOptions({ HOME: '/operator', L2S_DATA_DIR: '~' }).dataDir).toBe('/operator');
    expect(pathIsAbsolute(dashboardAgentOptions({}).dataDir!)).toBe(true);
  });

  it.each(['3001oops', '1.5', '65536', '0', 'NaN'])('rejects invalid PORT %s instead of partially parsing it', async (PORT) => {
    await expect(dashboardServerOptions({ PORT })).rejects.toThrow(/PORT must be an integer/);
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

describe('explicit remote dashboard boundaries', () => {
  const credentials = { DASHBOARD_USERNAME: 'operator', DASHBOARD_PASSWORD: 'a-strong-dashboard-password' };
  it('accepts one exact authenticated operator origin', async () => {
    expect(await dashboardServerOptions({ ...credentials, DASHBOARD_OPERATOR_ORIGIN: 'https://operator.example:443' }))
      .toMatchObject({ operatorOrigin: 'https://operator.example' });
  });
  it.each(['https://operator.example/path', 'https://operator.example/..', 'https://*.example', 'https://user:pass@operator.example', 'https://operator.example?x=1', 'https://operator.example#x', '*', 'null', 'ftp://operator.example'])('rejects unsafe origin %s', async (origin) => {
    await expect(dashboardServerOptions({ ...credentials, DASHBOARD_OPERATOR_ORIGIN: origin })).rejects.toThrow();
  });
  it('requires credentials for a configured operator origin', async () => {
    await expect(dashboardServerOptions({ DASHBOARD_OPERATOR_ORIGIN: 'https://operator.example' })).rejects.toThrow(/authentication/);
  });
  it('requires deliberate public-site opt-in, authentication and a publication file', async () => {
    await expect(dashboardServerOptions({ ...credentials, DASHBOARD_PUBLIC_SITE: 'yes' })).rejects.toThrow(/true or false/);
    await expect(dashboardServerOptions({ ...credentials, DASHBOARD_PUBLIC_SITE: 'true' })).rejects.toThrow(/NETWORK_PUBLICATION_CONFIG/);
    await expect(dashboardServerOptions({ DASHBOARD_PUBLIC_SITE: 'true', NETWORK_PUBLICATION_CONFIG: '/config/public.json' })).rejects.toThrow(/authentication/);
    expect(await dashboardServerOptions({ ...credentials, DASHBOARD_PUBLIC_SITE: 'true', NETWORK_PUBLICATION_CONFIG: '/config/public.json' })).toMatchObject({ publicSite: true });
  });
});
