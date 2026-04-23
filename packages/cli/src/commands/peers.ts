import os from 'node:os';
import path from 'node:path';
import chalk from 'chalk';
import { Agent } from '@networkselfmd/node';

function getDataDir(): string {
  return process.env.L2S_DATA_DIR || path.join(os.homedir(), '.networkselfmd');
}

export async function listPeers(): Promise<void> {
  const agent = new Agent({ dataDir: getDataDir() });
  await agent.start();

  try {
    const peers = agent.listPeers();

    if (peers.length === 0) {
      console.log(chalk.dim('\nNo peers connected.\n'));
      return;
    }

    console.log(chalk.bold('\nPeers:\n'));

    const fpWidth = 18;
    const nameWidth = 16;
    const onlineWidth = 10;
    const trustedWidth = 10;
    const lastSeenWidth = 20;

    console.log(
      chalk.dim(
        padRight('Fingerprint', fpWidth) +
        padRight('Name', nameWidth) +
        padRight('Online', onlineWidth) +
        padRight('Trusted', trustedWidth) +
        padRight('Last Seen', lastSeenWidth)
      )
    );
    console.log(chalk.dim('─'.repeat(fpWidth + nameWidth + onlineWidth + trustedWidth + lastSeenWidth)));

    for (const peer of peers) {
      const online = peer.online ? chalk.green('yes') : chalk.red('no');
      const trusted = peer.trusted ? chalk.green('yes') : chalk.dim('no');
      const lastSeen = peer.lastSeen
        ? new Date(peer.lastSeen).toLocaleString()
        : chalk.dim('never');

      console.log(
        padRight(truncate(peer.fingerprint, fpWidth - 2), fpWidth) +
        padRight(truncate(peer.displayName || '(unknown)', nameWidth - 2), nameWidth) +
        padRight(online, onlineWidth) +
        padRight(trusted, trustedWidth) +
        lastSeen
      );
    }

    console.log();
  } finally {
    await agent.stop();
  }
}

function padRight(str: string, width: number): string {
  return str.length >= width ? str : str + ' '.repeat(width - str.length);
}

function truncate(str: string, maxLen: number): string {
  return str.length <= maxLen ? str : str.slice(0, maxLen - 1) + '…';
}
