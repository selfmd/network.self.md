import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import chalk from 'chalk';
import { Agent } from '@networkselfmd/node';

function getDataDir(): string {
  return process.env.L2S_DATA_DIR || path.join(os.homedir(), '.networkselfmd');
}

export async function initAgent(name?: string): Promise<void> {
  const dataDir = getDataDir();

  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
    console.log(chalk.green(`Created data directory: ${dataDir}`));
  }

  const agent = new Agent({ dataDir, displayName: name });
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
