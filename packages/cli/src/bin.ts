#!/usr/bin/env node

import { Command } from 'commander';
import { initAgent } from './commands/init.js';
import { createGroup, joinGroup, listGroups } from './commands/groups.js';
import { listPeers } from './commands/peers.js';
import { showStatus } from './commands/status.js';
import { startChat } from './commands/chat.js';
import { startTTYA } from './commands/ttya.js';
import { agentSecretOptions } from './agent-options.js';

const program = new Command();

program
  .name('networkselfmd')
  .description('Terminal interface for network.self.md P2P AI agent network')
  .version('0.1.0')
  .option(
    '--passphrase',
    'Prompt for the identity passphrase without echoing input',
  )
  .option('--passphrase-file <path>', 'Read the identity passphrase from a secret file');

async function secrets(command: Command) {
  return agentSecretOptions(command.optsWithGlobals());
}

program
  .command('init')
  .description('Initialize agent identity')
  .option('--name <name>', 'Agent name')
  .action(async (opts, command) => {
    await initAgent(opts.name, await secrets(command));
  });

program
  .command('create-group')
  .description('Create a new group')
  .requiredOption('--name <name>', 'Group name')
  .action(async (opts, command) => {
    await createGroup(opts.name, await secrets(command));
  });

program
  .command('create-state')
  .description('Create a new state (alias for create-group)')
  .requiredOption('--name <name>', 'State name')
  .action(async (opts, command) => {
    await createGroup(opts.name, await secrets(command));
  });

program
  .command('join-group')
  .description('Join an existing group')
  .argument('<groupId>', 'Group ID to join')
  .action(async (groupId: string, _opts, command) => {
    await joinGroup(groupId, await secrets(command));
  });

program
  .command('join-state')
  .description('Join an existing state (alias for join-group)')
  .argument('<stateId>', 'State ID to join')
  .action(async (stateId: string, _opts, command) => {
    await joinGroup(stateId, await secrets(command));
  });

program
  .command('chat')
  .description('Enter interactive chat')
  .requiredOption('--group <groupId>', 'Group ID to chat in')
  .action(async (opts, command) => {
    await startChat(opts.group, await secrets(command));
  });

program
  .command('groups')
  .description('List groups')
  .action(async (_opts, command) => {
    await listGroups(await secrets(command));
  });

program
  .command('states')
  .description('List states (alias for groups)')
  .action(async (_opts, command) => {
    await listGroups(await secrets(command));
  });

program
  .command('peers')
  .description('List peers')
  .action(async (_opts, command) => {
    await listPeers(await secrets(command));
  });

program
  .command('ttya')
  .description('Experimental browser bridge (deferred, unsupported)')
  .option('--port <port>', 'Port to listen on', '8080')
  .option('--auto-approve', 'Auto-approve visitor requests')
  .option(
    '--psk-file <path>',
    'Path to a raw TTYA PSK file (created if absent)',
  )
  .action(async (opts, command) => {
    const port = Number.parseInt(opts.port, 10);
    if (!Number.isInteger(port) || port < 0 || port > 65_535) {
      throw new Error('Port must be an integer between 0 and 65535');
    }
    await startTTYA(
      port,
      opts.autoApprove ?? false,
      await secrets(command),
      opts.pskFile,
    );
  });

program
  .command('status')
  .description('Show agent status')
  .action(async (_opts, command) => {
    await showStatus(await secrets(command));
  });

await program.parseAsync();
