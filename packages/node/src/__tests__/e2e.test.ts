import { describe, it, expect, afterAll } from 'vitest';
import { Agent } from '../agent.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Use hyperdht's testnet helper to create an isolated local DHT
// @ts-expect-error - testnet.js is not typed
import createTestnet from 'hyperdht/testnet.js';

let testnet: {
  bootstrap: Array<{ host: string; port: number }>;
  destroy: () => Promise<void>;
};

afterAll(async () => {
  if (testnet) {
    await testnet.destroy();
  }
});

function waitForPeers(a1: Agent, a2: Agent, timeout: number): Promise<void> {
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

function waitForEvent(
  agent: Agent,
  event: string,
  timeout: number,
): Promise<unknown> {
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

describe('Agent E2E', () => {
  it('two agents use authenticated invite provenance to join a group', async () => {
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

      // Connect first so the signed, recipient-bound invite can be delivered.
      await waitForPeers(agent1, agent2, 15000);

      const group = await agent1.createGroup('test-e2e');
      const groupIdHex = Buffer.from(group.groupId).toString('hex');
      const bobPkHex = Buffer.from(agent2.identity.edPublicKey).toString('hex');
      const invited = waitForEvent(agent2, 'group:invited', 10000);
      await agent1.inviteToGroup(groupIdHex, bobPkHex);
      await invited;
      await agent2.joinGroup(groupIdHex);
      expect(
        agent2
          .listGroups()
          .some(
            (candidate) =>
              Buffer.from(candidate.groupId).toString('hex') === groupIdHex,
          ),
      ).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 1000));
      const receivedByBob = waitForEvent(agent2, 'group:message', 10000);
      await agent1.sendGroupMessage(groupIdHex, 'hello from Alice');
      await expect(receivedByBob).resolves.toMatchObject({ content: 'hello from Alice' });

      const receivedByAlice = waitForEvent(agent1, 'group:message', 10000);
      await agent2.sendGroupMessage(groupIdHex, 'hi Alice, Bob here');
      await expect(receivedByAlice).resolves.toMatchObject({ content: 'hi Alice, Bob here' });
    } finally {
      await agent1.stop();
      await agent2.stop();
      rmSync(dir1, { recursive: true, force: true });
      rmSync(dir2, { recursive: true, force: true });
    }
  }, 30000);
});
