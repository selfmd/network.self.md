#!/usr/bin/env node

import { Command } from 'commander';
import { initAgent } from './commands/init.js';
import { createGroup, joinGroup, listGroups } from './commands/groups.js';
import { listPeers } from './commands/peers.js';
import { showStatus } from './commands/status.js';
import { startChat } from './commands/chat.js';
import { startTTYA } from './commands/ttya.js';

const program = new Command();

program
  .name('networkselfmd')
  .description('Terminal interface for network.self.md P2P AI agent network')
  .version('0.1.0');

program
  .command('init')
  .description('Initialize agent identity')
  .option('--name <name>', 'Agent name')
  .action(async (opts) => {
    await initAgent(opts.name);
  });

program
  .command('create-group')
  .description('Create a new group')
  .requiredOption('--name <name>', 'Group name')
  .action(async (opts) => {
    await createGroup(opts.name);
  });

program
  .command('join-group')
  .description('Join an existing group')
  .argument('<groupId>', 'Group ID to join')
  .action(async (groupId: string) => {
    await joinGroup(groupId);
  });

program
  .command('chat')
  .description('Enter interactive chat')
  .requiredOption('--group <groupId>', 'Group ID to chat in')
  .action(async (opts) => {
    await startChat(opts.group);
  });

program
  .command('groups')
  .description('List groups')
  .action(async () => {
    await listGroups();
  });

program
  .command('peers')
  .description('List peers')
  .action(async () => {
    await listPeers();
  });

program
  .command('ttya')
  .description('Start TTYA server')
  .option('--port <port>', 'Port to listen on', '8080')
  .option('--auto-approve', 'Auto-approve visitor requests')
  .action(async (opts) => {
    await startTTYA(parseInt(opts.port, 10), opts.autoApprove ?? false);
  });

program
  .command('status')
  .description('Show agent status')
  .action(async () => {
    await showStatus();
  });

program.parse();
