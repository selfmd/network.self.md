import path from 'node:path';
import { homedir } from 'node:os';
import { secretFileProvider } from '@networkselfmd/node';
import type { AgentOptions } from '@networkselfmd/node';

export function dashboardAgentOptions(
  env: NodeJS.ProcessEnv = process.env,
): AgentOptions {
  const passphraseFile = env.L2S_PASSPHRASE_FILE;
  const home = env.HOME || homedir();
  const configured = env.L2S_DATA_DIR;
  const dataDir = configured === '~'
    ? home
    : configured?.startsWith('~/')
      ? path.resolve(home, configured.slice(2))
      : configured || path.join(home, '.networkselfmd');
  return {
    dataDir,
    displayName: env.AGENT_NAME,
    passphrase: passphraseFile ? undefined : env.L2S_PASSPHRASE,
    secretProvider: passphraseFile ? secretFileProvider(passphraseFile) : undefined,
  };
}

export interface DashboardBasicAuth {
  username: string;
  password: string;
}

export interface DashboardServerOptions {
  host: string;
  port: number;
  auth?: DashboardBasicAuth;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

export async function dashboardServerOptions(
  env: NodeJS.ProcessEnv = process.env,
): Promise<DashboardServerOptions> {
  const host = env.HOST ?? '127.0.0.1';
  const port = Number(env.PORT ?? '3001');
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }

  if (env.DASHBOARD_PASSWORD && env.DASHBOARD_PASSWORD_FILE) {
    throw new Error(
      'Use either DASHBOARD_PASSWORD or DASHBOARD_PASSWORD_FILE, not both',
    );
  }
  const password = env.DASHBOARD_PASSWORD_FILE
    ? await secretFileProvider(env.DASHBOARD_PASSWORD_FILE)()
    : env.DASHBOARD_PASSWORD;
  const username = env.DASHBOARD_USERNAME;
  if ((username && !password) || (!username && password)) {
    throw new Error(
      'DASHBOARD_USERNAME and a dashboard password must be configured together',
    );
  }

  let auth: DashboardBasicAuth | undefined;
  if (username && password) {
    if (username.length > 128 || username.includes(':')) {
      throw new Error('DASHBOARD_USERNAME must be at most 128 characters and contain no colon');
    }
    if (Buffer.byteLength(password, 'utf8') < 16) {
      throw new Error('Dashboard password must be at least 16 UTF-8 bytes');
    }
    auth = { username, password };
  }

  if (!LOOPBACK_HOSTS.has(host) && !auth) {
    throw new Error(
      'Dashboard authentication is required when HOST is not loopback',
    );
  }
  return { host, port, auth };
}
