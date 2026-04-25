#!/usr/bin/env node

import { Command } from 'commander';
import { initAgent } from './commands/init.js';
import { createGroup, joinGroup, listGroups } from './commands/groups.js';
import { listPeers } from './commands/peers.js';
import { showStatus } from './commands/status.js';
import { startChat } from './commands/chat.js';
import { startTTYA } from './commands/ttya.js';
import {
  policyGet,
  policySet,
  policyTrustAdd,
  policyTrustRemove,
  policyInterestAdd,
  policyInterestRemove,
} from './commands/policy.js';

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

// ---- Policy operator controls ----
//
// Owner-private, local-only controls for the inbound policy gate.
// See docs/POLICY.md for semantics. None of these tools execute agent
// actions or send anything over the network — they only read/update
// the local policy_config table and the live AgentPolicy.
const policy = program.command('policy').description('Inspect or update the inbound policy gate config (local only)');

policy
  .command('get')
  .description('Print the current policy configuration')
  .action(async () => {
    await policyGet();
  });

policy
  .command('set')
  .description('Update one or more policy fields (partial merge)')
  .option('--interests <list>', 'Comma-separated interest keywords')
  .option('--trusted <list>', 'Comma-separated trusted peer fingerprints')
  .option('--require-mention <bool>', 'true/false: require @-mention to count as addressed')
  .option('--mention-prefix-len <n>', 'Integer: chars of fingerprint that count as a mention prefix')
  .option('--reset', 'Wipe persisted config and revert to AgentOptions / defaults')
  .action(async (opts) => {
    await policySet(opts);
  });

const policyTrust = policy
  .command('trust')
  .description('Manage the trusted-fingerprint list');
policyTrust
  .command('add <fingerprint>')
  .description('Add a fingerprint to the trusted list')
  .action(async (fp: string) => {
    await policyTrustAdd(fp);
  });
policyTrust
  .command('remove <fingerprint>')
  .description('Remove a fingerprint from the trusted list')
  .action(async (fp: string) => {
    await policyTrustRemove(fp);
  });

const policyInterest = policy
  .command('interest')
  .description('Manage interest keywords');
policyInterest
  .command('add <keyword>')
  .description('Add an interest keyword')
  .action(async (kw: string) => {
    await policyInterestAdd(kw);
  });
policyInterest
  .command('remove <keyword>')
  .description('Remove an interest keyword')
  .action(async (kw: string) => {
    await policyInterestRemove(kw);
  });

program.parse();
