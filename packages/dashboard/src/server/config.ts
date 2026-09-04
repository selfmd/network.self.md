import path from 'node:path';
import { secretFileProvider } from '@networkselfmd/node';
import type { AgentOptions } from '@networkselfmd/node';

export function dashboardAgentOptions(
  env: NodeJS.ProcessEnv = process.env,
): AgentOptions {
  const passphraseFile = env.L2S_PASSPHRASE_FILE;
  return {
    dataDir: env.L2S_DATA_DIR ?? path.join(env.HOME ?? '~', '.networkselfmd'),
    displayName: env.AGENT_NAME,
    passphrase: env.L2S_PASSPHRASE,
    secretProvider: passphraseFile ? secretFileProvider(passphraseFile) : undefined,
  };
}
