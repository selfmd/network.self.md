import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { secretFileProvider } from '@networkselfmd/node';
import type { AgentOptions } from '@networkselfmd/node';

export function mcpAgentOptions(
  env: NodeJS.ProcessEnv = process.env,
): AgentOptions {
  const passphraseFile = env.L2S_PASSPHRASE_FILE;
  return {
    dataDir: env.L2S_DATA_DIR || resolve(homedir(), '.networkselfmd'),
    passphrase: env.L2S_PASSPHRASE,
    secretProvider: passphraseFile ? secretFileProvider(passphraseFile) : undefined,
  };
}
