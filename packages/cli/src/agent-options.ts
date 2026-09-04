import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { createInterface } from 'node:readline/promises';
import { secretFileProvider } from '@networkselfmd/node';
import type { AgentOptions } from '@networkselfmd/node';

export interface CliSecretOptions {
  passphrase?: boolean;
  passphraseFile?: string;
}

export function getDataDir(): string {
  return process.env.L2S_DATA_DIR || path.join(os.homedir(), '.networkselfmd');
}

export async function agentSecretOptions(
  options: CliSecretOptions,
): Promise<Pick<AgentOptions, 'passphrase' | 'secretProvider'>> {
  const filePath = options.passphraseFile ?? process.env.L2S_PASSPHRASE_FILE;
  if (options.passphrase && filePath) {
    throw new Error('Use either --passphrase or --passphrase-file, not both');
  }
  if (options.passphrase) return { passphrase: await readHiddenPassphrase() };
  if (filePath) return { secretProvider: secretFileProvider(filePath) };
  return {};
}

export async function readHiddenPassphrase(): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      '--passphrase requires an interactive terminal; use --passphrase-file instead',
    );
  }

  process.stdout.write('Identity passphrase: ');
  const mutedOutput = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const input = createInterface({
    input: process.stdin,
    output: mutedOutput,
    terminal: true,
  });
  try {
    return await input.question('');
  } finally {
    input.close();
    process.stdout.write('\n');
  }
}
