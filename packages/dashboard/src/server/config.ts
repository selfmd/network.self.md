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
  operatorOrigin?: string;
  publicSite?: boolean;
}

export function validateOperatorOrigin(value: string): string {
  const url = new URL(value);
  if (!/^https?:\/\/[^/?#]+\/?$/i.test(value) || url.hostname.includes('*') ||
      !['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash || value !== value.trim()) {
    throw new Error('DASHBOARD_OPERATOR_ORIGIN must be an exact HTTP(S) origin without credentials, path, query or fragment');
  }
  return url.origin;
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
  const operatorOrigin = env.DASHBOARD_OPERATOR_ORIGIN === undefined
    ? undefined
    : validateOperatorOrigin(env.DASHBOARD_OPERATOR_ORIGIN);
  if (operatorOrigin && !auth) {
    throw new Error('DASHBOARD_OPERATOR_ORIGIN requires dashboard authentication');
  }
  if (env.DASHBOARD_PUBLIC_SITE !== undefined && !['true', 'false'].includes(env.DASHBOARD_PUBLIC_SITE)) {
    throw new Error('DASHBOARD_PUBLIC_SITE must be true or false');
  }
  const publicSite = env.DASHBOARD_PUBLIC_SITE === 'true';
  if (publicSite && (!auth || !env.NETWORK_PUBLICATION_CONFIG)) {
    throw new Error('DASHBOARD_PUBLIC_SITE requires dashboard authentication and NETWORK_PUBLICATION_CONFIG');
  }
  return { host, port, auth, ...(operatorOrigin ? { operatorOrigin } : {}), ...(publicSite ? { publicSite } : {}) };
}
