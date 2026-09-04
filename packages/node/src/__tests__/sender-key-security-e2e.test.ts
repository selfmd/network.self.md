import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  MessageType,
  SenderKeys,
  type SenderKeyDistributionMessage,
} from '@networkselfmd/core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '../agent.js';
import type { SwarmManager } from '../network/swarm.js';

// @ts-expect-error - hyperdht's testnet helper is not typed
import createTestnet from 'hyperdht/testnet.js';

interface StoredKey {
  chain_key: Buffer;
  chain_index: number;
  generation_id: Buffer;
  distribution_sequence: number;
  epoch_version: number;
}

interface StoredEpoch {
  version: number;
  hash: Buffer;
}

function getSwarm(agent: Agent): SwarmManager {
  return (agent as unknown as { swarm: SwarmManager }).swarm;
}

function readSenderKey(
  dataDir: string,
  groupId: Uint8Array,
  publicKey: Uint8Array,
): StoredKey | undefined {
  const database = new Database(join(dataDir, 'agent.db'), { readonly: true });
  try {
    return database
      .prepare(
        'SELECT chain_key, chain_index, generation_id, distribution_sequence, epoch_version FROM sender_keys WHERE group_id = ? AND public_key = ?',
      )
      .get(Buffer.from(groupId), Buffer.from(publicKey)) as StoredKey | undefined;
  } finally {
    database.close();
  }
}

function countSenderKeys(dataDir: string, groupId: Uint8Array): number {
  const database = new Database(join(dataDir, 'agent.db'), { readonly: true });
  try {
    const row = database
      .prepare('SELECT COUNT(*) AS count FROM sender_keys WHERE group_id = ?')
      .get(Buffer.from(groupId)) as { count: number };
    return row.count;
  } finally {
    database.close();
  }
}

function readLatestEpoch(dataDir: string, groupIdHex: string): StoredEpoch {
  const database = new Database(join(dataDir, 'agent.db'), { readonly: true });
  try {
    return database
      .prepare(
        'SELECT version, hash FROM group_epochs WHERE group_id = ? ORDER BY version DESC LIMIT 1',
      )
      .get(groupIdHex) as StoredEpoch;
  } finally {
    database.close();
  }
}

async function waitUntil(
  predicate: () => boolean,
  message: string,
  timeout = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

function waitForGroupMessage(
  agent: Agent,
  timeout = 10_000,
): Promise<{ content: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Message timeout')), timeout);
    agent.once('group:message', (message) => {
      clearTimeout(timer);
      resolve(message);
    });
  });
}

describe('Sender-key distribution security E2E', () => {
  it('isolates envelopes to current members and rejects outsider, relay, and post-kick poisoning', async () => {
    const testnet = await createTestnet(3);
    const aliceDir = mkdtempSync(join(tmpdir(), 'nsmd-skd-alice-'));
    const bobDir = mkdtempSync(join(tmpdir(), 'nsmd-skd-bob-'));
    const malloryDir = mkdtempSync(join(tmpdir(), 'nsmd-skd-mallory-'));
    const alice = new Agent({
      dataDir: aliceDir,
      displayName: 'Alice',
      bootstrap: testnet.bootstrap,
    });
    const bob = new Agent({
      dataDir: bobDir,
      displayName: 'Bob',
      bootstrap: testnet.bootstrap,
    });
    const mallory = new Agent({
      dataDir: malloryDir,
      displayName: 'Mallory',
      bootstrap: testnet.bootstrap,
    });

    try {
      await Promise.all([alice.start(), bob.start(), mallory.start()]);

      const group = await alice.createGroup('sender-key-security');
      const groupId = group.groupId;
      const groupIdHex = Buffer.from(groupId).toString('hex');
      const aliceInitialKey = readSenderKey(
        aliceDir,
        groupId,
        alice.identity.edPublicKey,
      );
      expect(aliceInitialKey).toBeDefined();

      // Topic knowledge alone must not grant group membership. It only makes
      // the authenticated transport links deterministic for the adversarial test.
      await Promise.all([
        getSwarm(bob).join(group.topic),
        getSwarm(mallory).join(group.topic),
      ]);

      await waitUntil(
        () =>
          Boolean(getSwarm(alice).getSession(bob.identity.fingerprint)) &&
          Boolean(getSwarm(alice).getSession(mallory.identity.fingerprint)) &&
          Boolean(getSwarm(bob).getSession(alice.identity.fingerprint)) &&
          Boolean(getSwarm(mallory).getSession(alice.identity.fingerprint)),
        'Three-agent global discovery timeout',
      );

      const bobEnvelopes: SenderKeyDistributionMessage[] = [];
      const malloryEnvelopes: SenderKeyDistributionMessage[] = [];
      getSwarm(bob).router.on(MessageType.SenderKeyDistribution, (_session, message) => {
        bobEnvelopes.push(message as SenderKeyDistributionMessage);
      });
      getSwarm(mallory).router.on(MessageType.SenderKeyDistribution, (_session, message) => {
        malloryEnvelopes.push(message as SenderKeyDistributionMessage);
      });

      let inviteReceived = false;
      bob.once('group:invited', () => { inviteReceived = true; });
      await alice.inviteToGroup(
        groupIdHex,
        Buffer.from(bob.identity.edPublicKey).toString('hex'),
      );
      await waitUntil(() => inviteReceived, 'Pending invitation was not delivered');
      expect(bob.listGroups()).toHaveLength(0);
      await bob.joinGroup(groupIdHex);

      await waitUntil(
        () =>
          Boolean(readSenderKey(aliceDir, groupId, bob.identity.edPublicKey)) &&
          Boolean(readSenderKey(bobDir, groupId, alice.identity.edPublicKey)),
        'Member sender keys were not delivered',
      );

      expect(bobEnvelopes.length).toBeGreaterThan(0);
      expect(malloryEnvelopes).toEqual([]);
      for (const envelope of bobEnvelopes) {
        expect(envelope).not.toHaveProperty('groupId');
        expect(envelope).not.toHaveProperty('chainKey');
        expect(Buffer.from(envelope.ciphertext).includes(Buffer.from(groupId))).toBe(false);
        expect(
          Buffer.from(envelope.ciphertext).includes(aliceInitialKey!.chain_key),
        ).toBe(false);
      }
      const receivedAliceKey = readSenderKey(bobDir, groupId, alice.identity.edPublicKey)!;
      getSwarm(alice).getSession(bob.identity.fingerprint)!.send(bobEnvelopes[0]);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(readSenderKey(bobDir, groupId, alice.identity.edPublicKey)).toEqual(receivedAliceKey);

      const received = waitForGroupMessage(bob);
      await alice.sendGroupMessage(groupIdHex, 'members only');
      await expect(received).resolves.toMatchObject({ content: 'members only' });

      const latestEpoch = readLatestEpoch(aliceDir, groupIdHex);
      const fakeMalloryKey = new Uint8Array(32).fill(0xa1);
      const outsiderPayload = SenderKeys.createDistribution(
        groupId,
        { chainKey: fakeMalloryKey, chainIndex: 0 },
        mallory.identity.edPublicKey,
        latestEpoch.version,
        new Uint8Array(latestEpoch.hash),
      );
      const outsiderEnvelope = SenderKeys.encryptDistribution(
        outsiderPayload,
        mallory.identity.xPrivateKey,
        mallory.identity.edPublicKey,
        alice.identity.xPublicKey,
        alice.identity.edPublicKey,
      );
      getSwarm(mallory).getSession(alice.identity.fingerprint)!.send(outsiderEnvelope);

      const unknownGroupId = new Uint8Array(32).fill(0xb2);
      const unknownPayload = SenderKeys.createDistribution(
        unknownGroupId,
        { chainKey: new Uint8Array(32).fill(0xb3), chainIndex: 0 },
        mallory.identity.edPublicKey,
        0,
        new Uint8Array(32).fill(0xb4),
      );
      getSwarm(mallory)
        .getSession(alice.identity.fingerprint)!
        .send(
          SenderKeys.encryptDistribution(
            unknownPayload,
            mallory.identity.xPrivateKey,
            mallory.identity.edPublicKey,
            alice.identity.xPublicKey,
            alice.identity.edPublicKey,
          ),
        );

      const originalBobKey = readSenderKey(
        aliceDir,
        groupId,
        bob.identity.edPublicKey,
      )!;
      const relayedPayload = SenderKeys.createDistribution(
        groupId,
        { chainKey: new Uint8Array(32).fill(0xc1), chainIndex: 91 },
        bob.identity.edPublicKey,
        latestEpoch.version,
        new Uint8Array(latestEpoch.hash),
      );
      const relayedEnvelope = SenderKeys.encryptDistribution(
        relayedPayload,
        bob.identity.xPrivateKey,
        bob.identity.edPublicKey,
        alice.identity.xPublicKey,
        alice.identity.edPublicKey,
      );
      getSwarm(mallory).getSession(alice.identity.fingerprint)!.send(relayedEnvelope);

      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(readSenderKey(aliceDir, groupId, mallory.identity.edPublicKey)).toBeUndefined();
      expect(countSenderKeys(aliceDir, unknownGroupId)).toBe(0);
      expect(readSenderKey(aliceDir, groupId, bob.identity.edPublicKey)).toEqual(
        originalBobKey,
      );

      bobEnvelopes.length = 0;
      malloryEnvelopes.length = 0;
      await alice.kickFromGroup(
        groupIdHex,
        Buffer.from(bob.identity.edPublicKey).toString('hex'),
      );
      await waitUntil(
        () => bob.listGroups().every((candidate) =>
          Buffer.from(candidate.groupId).toString('hex') !== groupIdHex,
        ),
        'Kicked member did not leave the group',
      );
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(bobEnvelopes).toEqual([]);
      expect(malloryEnvelopes).toEqual([]);
      expect(countSenderKeys(bobDir, groupId)).toBe(0);
      expect(readSenderKey(aliceDir, groupId, bob.identity.edPublicKey)).toBeUndefined();
      const rotatedAliceKey = readSenderKey(aliceDir, groupId, alice.identity.edPublicKey)!;
      expect(rotatedAliceKey.generation_id).not.toEqual(aliceInitialKey!.generation_id);
      expect(rotatedAliceKey.epoch_version).toBeGreaterThan(aliceInitialKey!.epoch_version);

      // A formerly valid member can still reach Alice over the global topic,
      // but its old-epoch envelope must not recreate the deleted record.
      getSwarm(bob).getSession(alice.identity.fingerprint)!.send(
        SenderKeys.encryptDistribution(
          relayedPayload,
          bob.identity.xPrivateKey,
          bob.identity.edPublicKey,
          alice.identity.xPublicKey,
          alice.identity.edPublicKey,
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(readSenderKey(aliceDir, groupId, bob.identity.edPublicKey)).toBeUndefined();
    } finally {
      await Promise.allSettled([alice.stop(), bob.stop(), mallory.stop()]);
      await testnet.destroy();
      rmSync(aliceDir, { recursive: true, force: true });
      rmSync(bobDir, { recursive: true, force: true });
      rmSync(malloryDir, { recursive: true, force: true });
    }
  }, 45_000);

  it('syncs an offline removal epoch and forces every remaining sender generation to rotate', async () => {
    const testnet = await createTestnet(3);
    const aliceDir = mkdtempSync(join(tmpdir(), 'nsmd-rotate-alice-'));
    const bobDir = mkdtempSync(join(tmpdir(), 'nsmd-rotate-bob-'));
    const carolDir = mkdtempSync(join(tmpdir(), 'nsmd-rotate-carol-'));
    const alice = new Agent({ dataDir: aliceDir, bootstrap: testnet.bootstrap });
    let bob = new Agent({ dataDir: bobDir, bootstrap: testnet.bootstrap });
    const carol = new Agent({ dataDir: carolDir, bootstrap: testnet.bootstrap });
    try {
      await Promise.all([alice.start(), bob.start(), carol.start()]);
      const group = await alice.createGroup('offline-rotation');
      const groupIdHex = Buffer.from(group.groupId).toString('hex');
      await Promise.all([getSwarm(bob).join(group.topic), getSwarm(carol).join(group.topic)]);
      await waitUntil(() => Boolean(getSwarm(alice).getSession(bob.identity.fingerprint)) && Boolean(getSwarm(alice).getSession(carol.identity.fingerprint)), 'member links timeout');

      for (const member of [bob, carol]) {
        let invited = false;
        member.once('group:invited', () => { invited = true; });
        await alice.inviteToGroup(groupIdHex, Buffer.from(member.identity.edPublicKey).toString('hex'));
        await waitUntil(() => invited, 'invite timeout');
        await member.joinGroup(groupIdHex);
        await waitUntil(() => readLatestEpoch(member === bob ? bobDir : carolDir, groupIdHex)?.version === alice.getGroupMembers(groupIdHex).length - 1, 'accept epoch timeout');
      }

      await waitUntil(() => Boolean(readSenderKey(aliceDir, group.groupId, bob.identity.edPublicKey)) && Boolean(readSenderKey(bobDir, group.groupId, alice.identity.edPublicKey)), 'initial keys timeout');
      const aliceBefore = readSenderKey(aliceDir, group.groupId, alice.identity.edPublicKey)!;
      const bobBefore = readSenderKey(bobDir, group.groupId, bob.identity.edPublicKey)!;
      const bobPublicKey = bob.identity.edPublicKey;
      await bob.stop();

      await alice.kickFromGroup(groupIdHex, Buffer.from(carol.identity.edPublicKey).toString('hex'));
      const aliceAfter = readSenderKey(aliceDir, group.groupId, alice.identity.edPublicKey)!;
      expect(aliceAfter.generation_id).not.toEqual(aliceBefore.generation_id);
      expect(readSenderKey(aliceDir, group.groupId, bobPublicKey)).toBeUndefined();

      bob = new Agent({ dataDir: bobDir, bootstrap: testnet.bootstrap });
      await bob.start();
      await waitUntil(() => readLatestEpoch(bobDir, groupIdHex).version === readLatestEpoch(aliceDir, groupIdHex).version, 'offline epoch chain was not synchronized');
      await waitUntil(() => {
        const key = readSenderKey(bobDir, group.groupId, bobPublicKey);
        return Boolean(key && !key.generation_id.equals(bobBefore.generation_id));
      }, 'offline remaining sender did not rotate');
      await waitUntil(() => {
        const key = readSenderKey(aliceDir, group.groupId, bobPublicKey);
        return Boolean(key && key.epoch_version === readLatestEpoch(aliceDir, groupIdHex).version);
      }, 'rotated offline sender key was not redistributed');
    } finally {
      await Promise.allSettled([alice.stop(), bob.stop(), carol.stop()]);
      await testnet.destroy();
      rmSync(aliceDir, { recursive: true, force: true });
      rmSync(bobDir, { recursive: true, force: true });
      rmSync(carolDir, { recursive: true, force: true });
    }
  }, 45_000);
});
