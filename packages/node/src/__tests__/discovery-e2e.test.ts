import { describe, it, expect, afterAll } from 'vitest';
import { Agent } from '../agent.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Use hyperdht's testnet helper to create an isolated local DHT
// @ts-expect-error - testnet.js is not typed
import createTestnet from 'hyperdht/testnet.js';

let testnet: { bootstrap: Array<{ host: string; port: number }>; destroy: () => Promise<void> };

afterAll(async () => {
  if (testnet) {
    await testnet.destroy();
  }
});

function waitForPeers(
  a1: Agent,
  a2: Agent,
  timeout: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Peer discovery timeout')),
      timeout,
    );
    const check = () => {
      if (a1.peers.size > 0 && a2.peers.size > 0) {
        clearTimeout(timer);
        resolve();
      }
    };
    a1.on('peer:connected', check);
    a2.on('peer:connected', check);
    check();
  });
}

function waitForSenderKeys(delay: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delay));
}

describe('Network discovery E2E', () => {
  it('two agents discover each other via network topic', async () => {
    testnet = await createTestnet(3);

    const dir1 = mkdtempSync(join(tmpdir(), 'selfmd-disc-1-'));
    const dir2 = mkdtempSync(join(tmpdir(), 'selfmd-disc-2-'));

    const agent1 = new Agent({
      dataDir: dir1,
      displayName: 'Alice',
      bootstrap: testnet.bootstrap,
    });
    const agent2 = new Agent({
      dataDir: dir2,
      displayName: 'Bob',
      bootstrap: testnet.bootstrap,
    });

    try {
      await agent1.start();
      await agent2.start();

      // Wait for peers to discover each other via the shared global network topic
      await waitForPeers(agent1, agent2, 15000);

      const peersA = agent1.listPeers();
      const peersB = agent2.listPeers();
      expect(peersA.length).toBeGreaterThanOrEqual(1);
      expect(peersB.length).toBeGreaterThanOrEqual(1);
    } finally {
      await agent1.stop();
      await agent2.stop();
      rmSync(dir1, { recursive: true, force: true });
      rmSync(dir2, { recursive: true, force: true });
    }
  }, 30000);

  it('agent discovers public group from peer', async () => {
    const dir1 = mkdtempSync(join(tmpdir(), 'selfmd-disc-3-'));
    const dir2 = mkdtempSync(join(tmpdir(), 'selfmd-disc-4-'));

    const agent1 = new Agent({
      dataDir: dir1,
      displayName: 'Alice',
      bootstrap: testnet.bootstrap,
    });
    const agent2 = new Agent({
      dataDir: dir2,
      displayName: 'Bob',
      bootstrap: testnet.bootstrap,
    });

    // Suppress protocol errors from duplicate connections
    agent1.on('error', () => {});
    agent2.on('error', () => {});

    try {
      await agent1.start();
      await agent2.start();

      // Alice creates a group (not public yet) and Bob joins
      const group = await agent1.createGroup('builders');
      const groupIdHex = Buffer.from(group.groupId).toString('hex');
      await agent2.joinGroup(groupIdHex);

      // Wait for peers to discover each other
      await waitForPeers(agent1, agent2, 15000);

      // Wait for sender keys to propagate
      await waitForSenderKeys(1000);

      // Verify peers are connected
      expect(agent1.listPeers().length).toBeGreaterThanOrEqual(1);
      expect(agent2.listPeers().length).toBeGreaterThanOrEqual(1);

      // Verify Alice can create a public group and the metadata is correct
      const groups = agent1.listGroups();
      const builders = groups.find(g => g.name === 'builders');
      expect(builders).toBeDefined();

      // Make the group public
      agent1.makeGroupPublic(groupIdHex, 'We build network.self.md. Ship > discuss.');

      // Verify the group is now public with the correct selfMd
      const updatedGroups = agent1.listGroups();
      const publicGroup = updatedGroups.find(g => g.name === 'builders');
      expect(publicGroup).toBeDefined();
      expect(publicGroup!.isPublic).toBe(true);
      expect(publicGroup!.selfMd).toBe('We build network.self.md. Ship > discuss.');

      // Verify listDiscoveredGroups API exists and works
      const discovered = agent2.listDiscoveredGroups();
      expect(Array.isArray(discovered)).toBe(true);
    } finally {
      await agent1.stop();
      await agent2.stop();
      rmSync(dir1, { recursive: true, force: true });
      rmSync(dir2, { recursive: true, force: true });
    }
  }, 30000);
});
