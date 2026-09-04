import chalk from 'chalk';
import { Agent } from '@networkselfmd/node';
import type { AgentOptions } from '@networkselfmd/node';
import { getDataDir } from '../agent-options.js';

export async function showStatus(
  secrets: Pick<AgentOptions, 'passphrase' | 'secretProvider'> = {},
): Promise<void> {
  const dataDir = getDataDir();
  const agent = new Agent({ dataDir, ...secrets });
  await agent.start();

  try {
    const identity = agent.identity;
    const peers = agent.listPeers();
    const groups = agent.listGroups();

    console.log(chalk.bold('\nAgent Status\n'));

    console.log(chalk.underline('Identity'));
    console.log(`  ${chalk.dim('Name:')}         ${identity.displayName || '(unnamed)'}`);
    console.log(`  ${chalk.dim('Fingerprint:')}  ${identity.fingerprint}`);
    console.log();

    console.log(chalk.underline('Network'));
    console.log(`  ${chalk.dim('Peers:')}   ${peers.length}`);
    console.log(`  ${chalk.dim('Online:')}  ${peers.filter(p => p.online).length}`);
    console.log(`  ${chalk.dim('Groups:')}  ${groups.length}`);
    console.log();

    console.log(chalk.underline('Data'));
    console.log(`  ${chalk.dim('Directory:')}  ${dataDir}`);
    console.log();
  } finally {
    await agent.stop();
  }
}
