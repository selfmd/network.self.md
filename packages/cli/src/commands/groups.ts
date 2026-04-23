import os from 'node:os';
import path from 'node:path';
import chalk from 'chalk';
import { Agent } from '@networkselfmd/node';

function getDataDir(): string {
  return process.env.L2S_DATA_DIR || path.join(os.homedir(), '.networkselfmd');
}

async function withAgent<T>(fn: (agent: Agent) => Promise<T>): Promise<T> {
  const agent = new Agent({ dataDir: getDataDir() });
  await agent.start();
  try {
    return await fn(agent);
  } finally {
    await agent.stop();
  }
}

export async function createGroup(name: string): Promise<void> {
  await withAgent(async (agent) => {
    const group = await agent.createGroup(name);
    const groupIdHex = Buffer.from(group.groupId).toString('hex');

    console.log(chalk.bold('\nGroup created!\n'));
    console.log(`  ${chalk.dim('Group ID:')}  ${groupIdHex}`);
    console.log(`  ${chalk.dim('Name:')}      ${group.name}`);
    console.log();
    console.log(chalk.dim('Share the Group ID with others so they can join.'));
    console.log();
  });
}

export async function joinGroup(groupId: string): Promise<void> {
  await withAgent(async (agent) => {
    await agent.joinGroup(groupId);

    console.log(chalk.green(`\nJoined group ${groupId}\n`));
  });
}

export async function listGroups(): Promise<void> {
  await withAgent(async (agent) => {
    const groups = agent.listGroups();

    if (groups.length === 0) {
      console.log(chalk.dim('\nNo groups yet. Create one with: networkselfmd create-group --name <name>\n'));
      return;
    }

    console.log(chalk.bold('\nGroups:\n'));

    // Table header
    const idWidth = 16;
    const nameWidth = 20;
    const membersWidth = 10;
    const roleWidth = 10;

    console.log(
      chalk.dim(
        padRight('ID', idWidth) +
        padRight('Name', nameWidth) +
        padRight('Members', membersWidth) +
        padRight('Role', roleWidth)
      )
    );
    console.log(chalk.dim('─'.repeat(idWidth + nameWidth + membersWidth + roleWidth)));

    for (const group of groups) {
      const groupIdHex = Buffer.from(group.groupId).toString('hex');
      console.log(
        padRight(truncate(groupIdHex, idWidth - 2), idWidth) +
        padRight(truncate(group.name, nameWidth - 2), nameWidth) +
        padRight(String(group.memberCount ?? '?'), membersWidth) +
        padRight(group.role ?? 'member', roleWidth)
      );
    }

    console.log();
  });
}

function padRight(str: string, width: number): string {
  return str.length >= width ? str : str + ' '.repeat(width - str.length);
}

function truncate(str: string, maxLen: number): string {
  return str.length <= maxLen ? str : str.slice(0, maxLen - 1) + '…';
}
