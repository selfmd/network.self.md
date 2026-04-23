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

function waitForMessage(
  agent: Agent,
  event: string,
  timeout: number,
): Promise<{ content: string; groupId: Uint8Array; senderFingerprint: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Message timeout')),
      timeout,
    );
    agent.once(event, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
  });
}

// Wait for sender keys to be exchanged (both sides need each other's keys)
function waitForSenderKeys(delay: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delay));
}

describe('Agent E2E', () => {
  it('two agents exchange encrypted group messages', async () => {
    testnet = await createTestnet(3);

    const dir1 = mkdtempSync(join(tmpdir(), 'nsmd-e2e-1-'));
    const dir2 = mkdtempSync(join(tmpdir(), 'nsmd-e2e-2-'));

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

      // Alice creates a group
      const group = await agent1.createGroup('test-e2e');
      const groupIdHex = Buffer.from(group.groupId).toString('hex');

      // Bob joins the same group (using the groupId)
      await agent2.joinGroup(groupIdHex);

      // Wait for peers to discover each other and complete handshake
      await waitForPeers(agent1, agent2, 15000);

      // Wait for sender key distribution to complete
      await waitForSenderKeys(1000);

      // Alice sends a message
      await agent1.sendGroupMessage(groupIdHex, 'hello from Alice');

      // Bob should receive it
      const msg = await waitForMessage(agent2, 'group:message', 10000);
      expect(msg.content).toBe('hello from Alice');

      // Bob replies
      await agent2.sendGroupMessage(groupIdHex, 'hi Alice, Bob here');
      const reply = await waitForMessage(agent1, 'group:message', 10000);
      expect(reply.content).toBe('hi Alice, Bob here');
    } finally {
      await agent1.stop();
      await agent2.stop();
      rmSync(dir1, { recursive: true, force: true });
      rmSync(dir2, { recursive: true, force: true });
    }
  }, 30000);
});
