import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  generateIdentity,
  MessageType,
  SENDER_KEY_CAPABILITY,
  signAuthenticatedMessage,
} from '@networkselfmd/core';
import type { GroupManagementMessage, ProtocolMessage } from '@networkselfmd/core';
import { GroupManager } from '../groups/group-manager.js';
import type { PeerSession } from '../network/connection.js';
import type { SwarmManager } from '../network/swarm.js';
import {
  AgentDatabase,
  GroupBootstrapRepository,
  GroupEpochRepository,
  GroupInviteRepository,
  GroupRepository,
  MessageRepository,
  PeerRepository,
  ProtocolReplayRepository,
  SenderKeyRepository,
} from '../storage/index.js';

describe('group rejoin key recovery', () => {
  const cleanup: Array<() => void> = [];
  afterEach(() => {
    for (const close of cleanup.splice(0)) close();
  });

  function createNode() {
    const dir = mkdtempSync(join(tmpdir(), 'nsmd-group-rejoin-'));
    const database = new AgentDatabase(dir);
    database.migrate();
    cleanup.push(() => {
      database.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const db = database.getDb();
    const identity = generateIdentity();
    const sessions = new Map<string, PeerSession>();
    const keys = new SenderKeyRepository(db);
    const epochs = new GroupEpochRepository(db);
    const manager = new GroupManager({
      identity,
      swarm: {
        join: vi.fn().mockResolvedValue(undefined),
        leave: vi.fn().mockResolvedValue(undefined),
        getSession: (fingerprint: string) => sessions.get(fingerprint),
      } as unknown as SwarmManager,
      groups: new GroupRepository(db),
      epochs,
      senderKeys: keys,
      invites: new GroupInviteRepository(db),
      replay: new ProtocolReplayRepository(db),
      messages: new MessageRepository(db),
      peers: new PeerRepository(db),
      bootstraps: new GroupBootstrapRepository(db),
    });
    const errors = vi.fn();
    manager.on('error', errors);
    return { identity, sessions, keys, epochs, manager, errors };
  }

  type TestNode = ReturnType<typeof createNode>;

  function connect(nodes: TestNode[]) {
    const queue: Array<{ from: TestNode; to: TestNode; message: ProtocolMessage }> = [];
    for (const from of nodes) {
      for (const to of nodes) {
        if (from === to) continue;
        from.sessions.set(to.identity.fingerprint, {
          state: 'ready',
          peerPublicKey: to.identity.edPublicKey,
          peerXPublicKey: to.identity.xPublicKey,
          peerFingerprint: to.identity.fingerprint,
          peerCapabilities: new Set([SENDER_KEY_CAPABILITY, 'group-epoch-v1']),
          send: vi.fn((message: ProtocolMessage) => queue.push({ from, to, message })),
        } as unknown as PeerSession);
      }
    }
    return async () => {
      let delivered = 0;
      while (queue.length) {
        if (++delivered > 1000) throw new Error('Unexpected protocol loop');
        const { from, to, message } = queue.shift()!;
        const session = to.sessions.get(from.identity.fingerprint)!;
        switch (message.type) {
          case MessageType.GroupManagement:
            await to.manager.handleGroupManagement(session, message);
            break;
          case MessageType.GroupEpoch:
            to.manager.handleGroupEpoch(session, message);
            break;
          case MessageType.SenderKeyDistribution:
            to.manager.handleSenderKeyDistribution(session, message);
            break;
          case MessageType.GroupMessage:
            await to.manager.handleGroupMessage(session, message);
            break;
        }
      }
    };
  }

  it('receives every member after leaving and rejoining without reconnecting', async () => {
    const [admin, returning, member] = [createNode(), createNode(), createNode()];
    const flush = connect([admin, returning, member]);
    const { groupId } = await admin.manager.createGroup('three members');
    for (const node of [returning, member]) {
      await admin.manager.inviteToGroup(groupId, node.identity.edPublicKey);
      await flush();
      await node.manager.joinGroup(groupId);
      await flush();
    }
    const received = vi.fn();
    returning.manager.on('group:message', received);
    await member.manager.sendGroupMessage(groupId, 'before leaving');
    await flush();
    expect(received).toHaveBeenCalledWith(expect.objectContaining({ content: 'before leaving' }));
    const oldSequence = returning.keys.getDistributionSequence(groupId, member.identity.edPublicKey);

    await returning.manager.leaveGroup(groupId);
    expect(returning.keys.listForGroup(groupId)).toHaveLength(0);
    await admin.manager.inviteToGroup(groupId, returning.identity.edPublicKey);
    await flush();
    await returning.manager.joinGroup(groupId);
    await flush();

    expect(returning.keys.listForGroup(groupId)).toHaveLength(3);
    expect(returning.keys.getDistributionSequence(groupId, member.identity.edPublicKey)).toBeGreaterThan(oldSequence);
    returning.errors.mockClear();
    for (const node of [admin, member]) {
      await node.manager.sendGroupMessage(groupId, node.identity.fingerprint);
      await flush();
      expect(received).toHaveBeenCalledWith(expect.objectContaining({ content: node.identity.fingerprint }));
    }
    expect(returning.errors).not.toHaveBeenCalled();
  });

  it('does not distribute keys for replayed or non-member sync requests', async () => {
    const [admin, member, outsider] = [createNode(), createNode(), createNode()];
    const flush = connect([admin, member, outsider]);
    const { groupId } = await admin.manager.createGroup('private');
    await admin.manager.inviteToGroup(groupId, member.identity.edPublicKey);
    await flush();
    await member.manager.joinGroup(groupId);
    await flush();
    const latest = admin.epochs.getLatestEpoch(Buffer.from(groupId).toString('hex'))!;
    const request = (node: TestNode) => signAuthenticatedMessage<GroupManagementMessage>({
      type: MessageType.GroupManagement,
      action: 'sync-request',
      groupId,
      epochVersion: latest.epoch.version,
      epochHash: latest.hash,
      senderFingerprint: node.identity.fingerprint,
      recipientFingerprint: admin.identity.fingerprint,
      timestamp: Date.now(),
    }, node.identity.edPrivateKey);
    const session = admin.sessions.get(member.identity.fingerprint)!;
    const message = request(member);
    const before = admin.keys.getDistributionSequence(groupId, admin.identity.edPublicKey);
    await admin.manager.handleGroupManagement(session, message);
    await flush();
    const after = admin.keys.getDistributionSequence(groupId, admin.identity.edPublicKey);
    expect(after).toBeGreaterThan(before);
    await admin.manager.handleGroupManagement(session, message);
    await admin.manager.handleGroupManagement(admin.sessions.get(outsider.identity.fingerprint)!, request(outsider));
    expect(admin.keys.getDistributionSequence(groupId, admin.identity.edPublicKey)).toBe(after);
    expect(admin.sessions.get(outsider.identity.fingerprint)!.send).not.toHaveBeenCalled();
    expect(admin.errors).toHaveBeenCalledTimes(2);
  });
});
