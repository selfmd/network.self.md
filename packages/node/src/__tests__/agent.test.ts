import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock external modules that won't be available in test
vi.mock('hyperswarm', () => {
  return {
    default: class MockHyperswarm {
      on() {}
      join() {
        return { flushed: () => Promise.resolve() };
      }
      leave() {
        return Promise.resolve();
      }
      destroy() {
        return Promise.resolve();
      }
    },
  };
});

vi.mock('hyperdht', () => {
  return {
    default: class MockHyperDHT {},
  };
});

import { Agent } from '../agent.js';

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'nsmd-agent-test-'));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('Agent', () => {
  it('should create an agent instance', () => {
    const agent = new Agent({ dataDir });
    expect(agent).toBeDefined();
    expect(agent.isRunning).toBe(false);
  });

  it('should start and stop', async () => {
    const agent = new Agent({
      dataDir,
      displayName: 'TestBot',
    });

    await agent.start();
    expect(agent.isRunning).toBe(true);
    expect(agent.identity).toBeDefined();
    expect(agent.identity.displayName).toBe('TestBot');
    expect(agent.identity.fingerprint).toBeDefined();

    await agent.stop();
    expect(agent.isRunning).toBe(false);
  });

  it('should persist and reload identity', async () => {
    // First run
    const agent1 = new Agent({
      dataDir,
      displayName: 'PersistBot',
    });
    await agent1.start();
    const fingerprint = agent1.identity.fingerprint;
    await agent1.stop();

    // Second run
    const agent2 = new Agent({ dataDir });
    await agent2.start();
    expect(agent2.identity.fingerprint).toBe(fingerprint);
    await agent2.stop();
  });

  it('should create a group', async () => {
    const agent = new Agent({
      dataDir,
      displayName: 'GroupBot',
    });
    await agent.start();

    const group = await agent.createGroup('Test Group');
    expect(group).toBeDefined();
    expect(group.name).toBe('Test Group');
    expect(group.role).toBe('admin');
    expect(group.groupId).toBeInstanceOf(Uint8Array);

    const groups = agent.listGroups();
    expect(groups.length).toBe(1);
    expect(groups[0].name).toBe('Test Group');

    await agent.stop();
  });

  it('should list peers (empty initially)', async () => {
    const agent = new Agent({ dataDir });
    await agent.start();

    const peers = agent.listPeers();
    expect(peers).toEqual([]);

    await agent.stop();
  });

  it('should query messages (empty initially)', async () => {
    const agent = new Agent({ dataDir });
    await agent.start();

    const messages = agent.getMessages({});
    expect(messages).toEqual([]);

    await agent.stop();
  });

  it('should not start twice', async () => {
    const agent = new Agent({ dataDir });
    await agent.start();
    await agent.start(); // should be no-op
    expect(agent.isRunning).toBe(true);
    await agent.stop();
  });

  it('should not stop when not running', async () => {
    const agent = new Agent({ dataDir });
    await agent.stop(); // should be no-op
    expect(agent.isRunning).toBe(false);
  });

  it('should get group members after creating group', async () => {
    const agent = new Agent({
      dataDir,
      displayName: 'MemberBot',
    });
    await agent.start();

    const group = await agent.createGroup('Members Test');
    const groupIdHex = Buffer.from(group.groupId).toString('hex');
    const members = agent.getGroupMembers(groupIdHex);

    expect(members.length).toBe(1);
    expect(members[0].role).toBe('admin');

    await agent.stop();
  });

  it('should leave a group', async () => {
    const agent = new Agent({ dataDir });
    await agent.start();

    const group = await agent.createGroup('Leave Test');
    const groupIdHex = Buffer.from(group.groupId).toString('hex');

    expect(agent.listGroups().length).toBe(1);

    await agent.leaveGroup(groupIdHex);
    expect(agent.listGroups().length).toBe(0);

    await agent.stop();
  });
});
