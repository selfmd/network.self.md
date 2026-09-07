import chalk from 'chalk';
import { Agent } from '@networkselfmd/node';
import type { AgentOptions } from '@networkselfmd/node';
import { getDataDir } from '../agent-options.js';

type Secrets = Pick<AgentOptions, 'passphrase' | 'secretProvider'>;

async function withAgent<T>(fn: (agent: Agent) => Promise<T>, secrets: Secrets): Promise<T> {
  const agent = new Agent({ dataDir: getDataDir(), ...secrets });
  await agent.start();
  try {
    return await fn(agent);
  } finally {
    await agent.stop();
  }
}

export async function createGroup(name: string, secrets: Secrets = {}): Promise<void> {
  await withAgent(async (agent) => {
    const result = await agent.createGroup(name);
    const stateId = Buffer.from(result.groupId).toString('hex');

    console.log(chalk.bold('\nState founded!\n'));
    console.log(`  ${chalk.dim('State ID:')}  ${stateId}`);
    console.log(`  ${chalk.dim('Name:')}      ${name}`);
    console.log();
    console.log(chalk.dim('Private states require an admin invitation before joining. Use MCP state_invite to invite a connected peer.'));
    console.log();
  }, secrets);
}

export async function joinGroup(groupId: string, secrets: Secrets = {}): Promise<void> {
  await withAgent(async (agent) => {
    await agent.joinGroup(groupId);

    console.log(chalk.green(`\nJoined state ${groupId}\n`));
  }, secrets);
}

export async function listGroups(secrets: Secrets = {}): Promise<void> {
  await withAgent(async (agent) => {
    const states = agent.listGroups();

    if (states.length === 0) {
      console.log(chalk.dim('\nNo states yet. Found one with: networkselfmd create-group --name <name>\n'));
      return;
    }

    console.log(chalk.bold('\nStates:\n'));

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

    for (const state of states) {
      const stateId = Buffer.from(state.groupId).toString('hex');
      console.log(
        padRight(truncate(stateId, idWidth - 2), idWidth) +
        padRight(truncate(state.name, nameWidth - 2), nameWidth) +
        padRight(String(state.memberCount ?? '?'), membersWidth) +
        padRight(state.role ?? 'member', roleWidth)
      );
    }

    console.log();
  }, secrets);
}

function padRight(str: string, width: number): string {
  return str.length >= width ? str : str + ' '.repeat(width - str.length);
}

function truncate(str: string, maxLen: number): string {
  return str.length <= maxLen ? str : str.slice(0, maxLen - 1) + '…';
}
