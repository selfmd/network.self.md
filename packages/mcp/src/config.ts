import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { secretFileProvider } from '@networkselfmd/node';
import type { AgentOptions } from '@networkselfmd/node';

export function mcpAgentOptions(
  env: NodeJS.ProcessEnv = process.env,
): AgentOptions {
  const passphraseFile = env.L2S_PASSPHRASE_FILE;
  const configured = env.L2S_DATA_DIR;
  const dataDir = configured === '~'
    ? homedir()
    : configured?.startsWith('~/')
      ? resolve(homedir(), configured.slice(2))
      : configured || resolve(homedir(), '.networkselfmd');
  return {
    dataDir,
    passphrase: passphraseFile ? undefined : env.L2S_PASSPHRASE,
    secretProvider: passphraseFile ? secretFileProvider(passphraseFile) : undefined,
  };
}
