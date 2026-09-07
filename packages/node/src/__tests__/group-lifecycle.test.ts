import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  generateIdentity,
  serializeEpoch,
  encodeMessage,
  decodeMessage,
  MessageType,
  SENDER_KEY_CAPABILITY,
  signAuthenticatedMessage,
} from '@networkselfmd/core';
import type { GroupManagementMessage, ProtocolMessage } from '@networkselfmd/core';
import { Agent } from '../agent.js';
import { GroupManager, GROUP_KEY_MAX_AGE_MS } from '../groups/group-manager.js';
import type { PeerSession } from '../network/connection.js';
import type { SwarmManager } from '../network/swarm.js';
import {
  AgentDatabase,
  DiscoveredGroupRepository,
  GroupBootstrapRepository,
  GroupEpochRepository,
  GroupInviteRepository,
  GroupRepository,
  MessageRepository,
  PeerRepository,
  ProtocolReplayRepository,
  SenderKeyRepository,
} from '../storage/index.js';

describe('group metadata and timed key rotation', () => {
  const cleanup: Array<() => void> = [];
  afterEach(() => {
    vi.useRealTimers();
    for (const close of cleanup.splice(0)) close();
  });

  function createNode() {
    const dir = mkdtempSync(join(tmpdir(), 'nsmd-group-rejoin-'));
    const database = new AgentDatabase(dir);
    database.migrate();
    cleanup.push(() => {
      manager.stopKeyRotation();
      database.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const db = database.getDb();
    const identity = generateIdentity();
    const sessions = new Map<string, PeerSession>();
    const keys = new SenderKeyRepository(db);
    const epochs = new GroupEpochRepository(db);
    const groups = new GroupRepository(db);
    const discovered = new DiscoveredGroupRepository(db);
    const manager = new GroupManager({
      identity,
      swarm: {
        join: vi.fn().mockResolvedValue(undefined),
        leave: vi.fn().mockResolvedValue(undefined),
        getSession: (fingerprint: string) => sessions.get(fingerprint),
      } as unknown as SwarmManager,
      groups,
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
    const agent = new Agent({ dataDir: dir });
    Object.assign(agent, { identity, groupRepo: groups, groupEpochRepo: epochs,
      discoveredGroupRepo: discovered, groupManager: manager,
      swarm: { getAllSessions: () => [] },
    });
    return { identity, sessions, keys, epochs, manager, errors, groups, discovered, agent, database, dir };
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
          peerCapabilities: new Set([SENDER_KEY_CAPABILITY, 'group-epoch-v1', 'group-metadata-v1']),
          send: vi.fn((message: ProtocolMessage) => queue.push({ from, to, message: decodeMessage(encodeMessage(message)) })),
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

  it('preserves verified public metadata on join and synchronizes later creator changes', async () => {
    const admin = createNode(), member = createNode();
    const flush = connect([admin, member]);
    const { groupId } = await admin.agent.createGroup('public', { public: true, selfMd: 'initial rules' });
    const hex = Buffer.from(groupId).toString('hex');
    const genesis = admin.epochs.getEpochByVersion(hex, 0)!;
    member.discovered.upsert(groupId, 'public', 'initial rules', 1, admin.identity.edPublicKey,
      serializeEpoch(genesis.epoch), genesis.signature, genesis.hash, Date.now());
    await member.agent.joinPublicGroup(hex);
    expect(member.groups.find(groupId)).toMatchObject({ self_md: 'initial rules', is_public: 1 });
    await flush();
    admin.agent.updateGroupManifest(hex, 'updated rules');
    await flush();
    expect(member.groups.find(groupId)).toMatchObject({ self_md: 'updated rules', is_public: 1 });
    expect(member.errors).not.toHaveBeenCalled();
  });

  it('delivers private manifests only after admission and rejects tampering or non-admin changes', async () => {
    const admin = createNode(), member = createNode(), outsider = createNode();
    const flush = connect([admin, member, outsider]);
    const { groupId } = await admin.agent.createGroup('private', { selfMd: 'private rules' });
    const hex = Buffer.from(groupId).toString('hex');
    expect(admin.groups.find(groupId)).toMatchObject({ self_md: 'private rules', is_public: 0 });
    await admin.manager.inviteToGroup(groupId, member.identity.edPublicKey);
    await flush();
    await member.agent.joinGroup(hex);
    await flush();
    expect(member.groups.find(groupId)).toMatchObject({ self_md: 'private rules', is_public: 0 });
    expect(admin.sessions.get(outsider.identity.fingerprint)!.send).not.toHaveBeenCalled();
    const sent = vi.mocked(admin.sessions.get(member.identity.fingerprint)!.send).mock.calls
      .map(([message]) => message).find(message => message.type === MessageType.GroupManagement && message.action === 'metadata') as GroupManagementMessage;
    member.errors.mockClear();
    for (const changes of [{ selfMd: 'tampered' }, { isPublic: true }, { metadataVersion: 100 }]) {
      await member.manager.handleGroupManagement(member.sessions.get(admin.identity.fingerprint)!, { ...sent, ...changes });
    }
    const forged = signAuthenticatedMessage<GroupManagementMessage>({ ...sent,
      senderFingerprint: outsider.identity.fingerprint, recipientFingerprint: member.identity.fingerprint,
      selfMd: 'forged', metadataVersion: 100,
    }, outsider.identity.edPrivateKey);
    await member.manager.handleGroupManagement(member.sessions.get(outsider.identity.fingerprint)!, forged);
    expect(member.errors).toHaveBeenCalledTimes(4);
    expect(member.groups.find(groupId)!.self_md).toBe('private rules');
    admin.agent.updateGroupManifest(hex, 'new private rules');
    await flush();
    expect(member.groups.find(groupId)!.self_md).toBe('new private rules');
    const stale = signAuthenticatedMessage<GroupManagementMessage>({ ...sent, timestamp: Date.now() + 1 }, admin.identity.edPrivateKey);
    await member.manager.handleGroupManagement(member.sessions.get(admin.identity.fingerprint)!, stale);
    expect(member.groups.find(groupId)!.self_md).toBe('new private rules');
    expect(() => member.agent.updateGroupManifest(hex, 'not allowed')).toThrow(/admin/);
  });

  it('keeps generation age through ratchet updates and rotates after 24 hours on timer', async () => {
    vi.useFakeTimers();
    const node = createNode();
    const { groupId } = await node.agent.createGroup('rotation');
    const before = node.keys.load(groupId, node.identity.edPublicKey)!;
    await vi.advanceTimersByTimeAsync(GROUP_KEY_MAX_AGE_MS - 60_000);
    await node.manager.distributeSenderKeys(groupId);
    expect(node.keys.load(groupId, node.identity.edPublicKey)!.generation_created_at).toBe(before.generation_created_at);
    node.manager.startKeyRotation();
    await vi.advanceTimersByTimeAsync(60_000);
    const after = node.keys.load(groupId, node.identity.edPublicKey)!;
    expect(after.generation_id).not.toEqual(before.generation_id);
    expect(after.distribution_sequence).toBeGreaterThan(before.distribution_sequence);
    expect(after.generation_created_at).toBe(Date.now());
    node.manager.stopKeyRotation();
  });

  it('authenticates missed removal and later epochs before reinviting an offline former member', async () => {
    const admin = createNode(), former = createNode(), newcomer = createNode();
    const flush = connect([admin, former, newcomer]);
    const { groupId } = await admin.agent.createGroup('offline reinvite', { selfMd: 'current rules' });
    const hex = Buffer.from(groupId).toString('hex');
    await admin.manager.inviteToGroup(groupId, former.identity.edPublicKey);
    await flush();
    await former.manager.joinGroup(groupId);
    await flush();
    const toFormer = admin.sessions.get(former.identity.fingerprint)!;
    const toAdmin = former.sessions.get(admin.identity.fingerprint)!;
    admin.sessions.delete(former.identity.fingerprint);
    former.sessions.delete(admin.identity.fingerprint);
    await admin.manager.kickFromGroup(groupId, former.identity.edPublicKey);
    await admin.manager.inviteToGroup(groupId, newcomer.identity.edPublicKey);
    await flush();
    await newcomer.manager.joinGroup(groupId);
    await flush();
    expect(former.epochs.getLatestEpoch(hex)!.epoch.version).toBe(1);
    expect(admin.epochs.getLatestEpoch(hex)!.epoch.version).toBe(3);
    admin.sessions.set(former.identity.fingerprint, toFormer);
    former.sessions.set(admin.identity.fingerprint, toAdmin);
    await admin.manager.inviteToGroup(groupId, former.identity.edPublicKey);
    await flush();
    expect(former.epochs.getLatestEpoch(hex)!.epoch.version).toBe(3);
    expect(former.groups.find(groupId)).toBeUndefined();
    expect(former.keys.listForGroup(groupId)).toHaveLength(0);
    expect(former.groups.findRetainedAuthority(groupId)!.creator_public_key)
      .toEqual(Buffer.from(admin.identity.edPublicKey));
    expect(() => former.groups.join(groupId, 'replacement', 'member', newcomer.identity.edPublicKey, new Uint8Array(32)))
      .toThrow(/authority mismatch/i);
    await former.manager.joinGroup(groupId);
    await flush();
    expect(former.groups.getMembers(groupId)).toHaveLength(3);
    expect(former.groups.find(groupId)!.self_md).toBe('current rules');
    expect(former.keys.listForGroup(groupId).length).toBeGreaterThanOrEqual(2);
  });

  it('rotates a persisted expired generation lazily before the next send', async () => {
    vi.useFakeTimers();
    const node = createNode();
    const { groupId } = await node.agent.createGroup('lazy');
    const before = node.keys.load(groupId, node.identity.edPublicKey)!;
    await vi.advanceTimersByTimeAsync(GROUP_KEY_MAX_AGE_MS + 1);
    // Reconstruct the manager and repositories from a new SQLite connection.
    const reopened = new AgentDatabase(node.dir);
    reopened.migrate();
    const db = reopened.getDb();
    const restored = new GroupManager({ identity: node.identity,
      swarm: { getSession: () => undefined } as unknown as SwarmManager,
      groups: new GroupRepository(db), epochs: new GroupEpochRepository(db),
      senderKeys: new SenderKeyRepository(db), invites: new GroupInviteRepository(db),
      replay: new ProtocolReplayRepository(db), messages: new MessageRepository(db),
      peers: new PeerRepository(db), bootstraps: new GroupBootstrapRepository(db),
    });
    try {
      expect(new SenderKeyRepository(db).load(groupId, node.identity.edPublicKey)!.generation_created_at).toBe(before.generation_created_at);
      await restored.sendGroupMessage(groupId, 'after a day offline');
    } finally { reopened.close(); }
    const after = node.keys.load(groupId, node.identity.edPublicKey)!;
    expect(after.generation_id).not.toEqual(before.generation_id);
    expect(after.generation_created_at).toBe(Date.now());
  });

  it('rotates reliable delivery encryption after 100 uses across manager restarts', async () => {
    const node = createNode();
    const { groupId } = await node.agent.createGroup('delivery rotation');
    const before = node.keys.load(groupId, node.identity.edPublicKey)!;
    for (let index = 0; index < 100; index++) {
      await node.manager.rotateExpiredKey(groupId);
      node.manager.encryptDelivery(groupId, `attempt ${index}`);
    }
    expect(node.keys.load(groupId, node.identity.edPublicKey)!.chain_index).toBe(100);
    const db = node.database.getDb();
    const restored = new GroupManager({ identity: node.identity,
      swarm: { getSession: () => undefined } as unknown as SwarmManager,
      groups: new GroupRepository(db), epochs: new GroupEpochRepository(db),
      senderKeys: new SenderKeyRepository(db), invites: new GroupInviteRepository(db),
      replay: new ProtocolReplayRepository(db), messages: new MessageRepository(db),
      peers: new PeerRepository(db), bootstraps: new GroupBootstrapRepository(db),
    });
    await restored.rotateExpiredKey(groupId);
    const next = restored.encryptDelivery(groupId, 'attempt 101');
    expect(next.chainIndex).toBe(0);
    expect(next.generationId).not.toEqual(new Uint8Array(before.generation_id!));
  });
});
