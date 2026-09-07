import fs from 'node:fs';
import chalk from 'chalk';
import { Agent } from '@networkselfmd/node';
import { getDataDir } from '../agent-options.js';
import type { AgentOptions } from '@networkselfmd/node';

export async function initAgent(
  name?: string,
  secrets: Pick<AgentOptions, 'passphrase' | 'secretProvider'> = {},
): Promise<void> {
  const dataDir = getDataDir();

  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    console.log(chalk.green(`Created data directory: ${dataDir}`));
  }

  const agent = new Agent({ dataDir, displayName: name, ...secrets });
  await agent.start();

  const identity = agent.identity;

  console.log(chalk.bold('\nAgent initialized successfully!\n'));
  console.log(`  ${chalk.dim('Name:')}         ${identity.displayName || '(unnamed)'}`);
  console.log(`  ${chalk.dim('Fingerprint:')}  ${identity.fingerprint}`);
  console.log(`  ${chalk.dim('Public Key:')}   ${Buffer.from(identity.edPublicKey).toString('hex')}`);
  console.log(`  ${chalk.dim('Data Dir:')}     ${dataDir}`);
  console.log();

  await agent.stop();
}
