import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import {
  fingerprintFromPublicKey,
  signMessage,
  MessageType,
  SenderKeys,
} from '@networkselfmd/core';
import type {
  AgentIdentity,
  GroupManagementMessage,
  GroupEncryptedMessage,
  SenderKeyDistributionMessage,
} from '@networkselfmd/core';
import {
  AgentDatabase,
  GroupRepository,
  MessageRepository,
  SenderKeyRepository,
  PeerRepository,
} from '../storage/index.js';
import { GroupManager } from '../groups/group-manager.js';
import { PeerSession } from '../network/connection.js';
import { makeIdentity, makeMockSession, makeMockSwarm } from './test-utils/group-harness.js';

describe('GroupManager signature + admin gating', () => {
  let dataDir: string;
  let database: AgentDatabase;
  let groupRepo: GroupRepository;
  let messageRepo: MessageRepository;
  let senderKeyRepo: SenderKeyRepository;
  let peerRepo: PeerRepository;
  let alice: AgentIdentity; // admin
  let bob: AgentIdentity;   // member
  let mallory: AgentIdentity; // unrelated attacker
  let groupId: Uint8Array;
  let manager: GroupManager;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'nsmd-gm-test-'));
    database = new AgentDatabase(dataDir);
    database.migrate();
    const db = database.getDb();
    groupRepo = new GroupRepository(db);
    messageRepo = new MessageRepository(db);
    senderKeyRepo = new SenderKeyRepository(db);
    peerRepo = new PeerRepository(db);

    alice = makeIdentity('Alice');
    bob = makeIdentity('Bob');
    mallory = makeIdentity('Mallory');
    groupId = new Uint8Array(32).fill(0xab);

    // Seed: Bob's local view. Bob is a member, Alice is the admin.
    groupRepo.create(groupId, 'test', 'member');
    groupRepo.addMember(groupId, bob.edPublicKey, 'member');
    groupRepo.addMember(groupId, alice.edPublicKey, 'admin');
    groupRepo.addMember(groupId, mallory.edPublicKey, 'member');

    // Bob runs the GroupManager — he's the "receiver" in these tests.
    manager = new GroupManager({
      identity: bob,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      swarm: makeMockSwarm() as any,
      groups: groupRepo,
      messages: messageRepo,
      senderKeys: senderKeyRepo,
      peers: peerRepo,
    });
  });

  afterEach(() => {
    database.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function collectErrors(): Error[] {
    const errs: Error[] = [];
    manager.on('error', (e: Error) => errs.push(e));
    return errs;
  }

  it('accepts a kick signed by the group admin', () => {
    const errs = collectErrors();
    const kick = signMessage<GroupManagementMessage>(
      {
        type: MessageType.GroupManagement,
        action: 'kick',
        groupId,
        targetFingerprint: mallory.fingerprint,
        timestamp: Date.now(),
        senderPublicKey: alice.edPublicKey,
      },
      alice.edPrivateKey,
    );

    const session = makeMockSession(alice);
    manager.handleGroupManagement(session, kick);

    expect(errs).toHaveLength(0);
    const members = groupRepo.getMembers(groupId).map((m) => fingerprintFromPublicKey(new Uint8Array(m.public_key)));
    expect(members).not.toContain(mallory.fingerprint);
  });

  it('rejects an unsigned kick (empty signature)', () => {
    const errs = collectErrors();
    const forged: GroupManagementMessage = {
      type: MessageType.GroupManagement,
      action: 'kick',
      groupId,
      targetFingerprint: mallory.fingerprint,
      timestamp: Date.now(),
      senderPublicKey: alice.edPublicKey,
      signature: new Uint8Array(0),
    };

    // Session peer impersonates Alice at transport — but without a real
    // signature we must still reject.
    const session = makeMockSession(alice);
    manager.handleGroupManagement(session, forged);

    expect(errs.length).toBeGreaterThanOrEqual(1);
    expect(errs[0].message).toMatch(/invalid signature/i);
    // Mallory must still be a member.
    const members = groupRepo.getMembers(groupId).map((m) => fingerprintFromPublicKey(new Uint8Array(m.public_key)));
    expect(members).toContain(mallory.fingerprint);
  });

  it('rejects a kick whose signature does not match the transport peer', () => {
    const errs = collectErrors();
    // Alice actually signs, but the message arrives on a session where the
    // transport peer is Mallory — we must reject the mismatch.
    const kick = signMessage<GroupManagementMessage>(
      {
        type: MessageType.GroupManagement,
        action: 'kick',
        groupId,
        targetFingerprint: bob.fingerprint,
        timestamp: Date.now(),
        senderPublicKey: alice.edPublicKey,
      },
      alice.edPrivateKey,
    );

    const session = makeMockSession(mallory);
    manager.handleGroupManagement(session, kick);

    expect(errs.length).toBeGreaterThanOrEqual(1);
    expect(errs[0].message).toMatch(/invalid signature/i);
  });

  it('rejects a kick from a non-admin member with a valid signature', () => {
    const errs = collectErrors();
    const kick = signMessage<GroupManagementMessage>(
      {
        type: MessageType.GroupManagement,
        action: 'kick',
        groupId,
        targetFingerprint: bob.fingerprint,
        timestamp: Date.now(),
        senderPublicKey: mallory.edPublicKey,
      },
      mallory.edPrivateKey,
    );

    const session = makeMockSession(mallory);
    manager.handleGroupManagement(session, kick);

    expect(errs.length).toBeGreaterThanOrEqual(1);
    expect(errs[0].message).toMatch(/not an admin/i);
    // Bob should still be present.
    const members = groupRepo.getMembers(groupId).map((m) => fingerprintFromPublicKey(new Uint8Array(m.public_key)));
    expect(members).toContain(bob.fingerprint);
  });

  it('rejects an invite from a non-admin of a known group', () => {
    const errs = collectErrors();
    const invite = signMessage<GroupManagementMessage>(
      {
        type: MessageType.GroupManagement,
        action: 'invite',
        groupId,
        targetFingerprint: bob.fingerprint,
        groupName: 'test',
        timestamp: Date.now(),
        senderPublicKey: mallory.edPublicKey,
      },
      mallory.edPrivateKey,
    );

    const session = makeMockSession(mallory);
    const invitedEvents: unknown[] = [];
    manager.on('group:invited', (e) => invitedEvents.push(e));
    manager.handleGroupManagement(session, invite);

    expect(errs.length).toBeGreaterThanOrEqual(1);
    expect(errs[0].message).toMatch(/not an admin/i);
    expect(invitedEvents).toHaveLength(0);
  });

  it('rejects a group message signed by the wrong key', async () => {
    const errs: Error[] = [];
    manager.on('error', (e) => errs.push(e));

    // Put a valid sender key for Alice so we'd decrypt if signature passed.
    const aliceState = SenderKeys.generate();
    senderKeyRepo.store(groupId, alice.edPublicKey, aliceState.chainKey, 0);

    const plaintext = new TextEncoder().encode('pwned');
    const enc = SenderKeys.encrypt(aliceState, plaintext);

    // Mallory signs but claims to be Alice (senderPublicKey = alice.pk) —
    // signature won't verify against Alice's public key.
    const forged: GroupEncryptedMessage = {
      type: MessageType.GroupMessage,
      groupId,
      senderFingerprint: alice.fingerprint,
      senderPublicKey: alice.edPublicKey,
      chainIndex: enc.chainIndex,
      ciphertext: enc.ciphertext,
      nonce: enc.nonce,
      timestamp: Date.now(),
      signature: randomBytes(64),
    };

    const session = makeMockSession(alice);
    await manager.handleGroupMessage(session, forged);

    expect(errs.length).toBeGreaterThanOrEqual(1);
    expect(errs[0].message).toMatch(/invalid signature/i);
    // No stored message.
    expect(messageRepo.query({ groupId }).length).toBe(0);
  });

  it('rejects sender key distribution from an unknown group member', () => {
    const errs = collectErrors();
    const stranger = makeIdentity('Stranger');
    const distribution = signMessage<SenderKeyDistributionMessage>(
      {
        type: MessageType.SenderKeyDistribution,
        groupId,
        chainKey: new Uint8Array(32).fill(0x33),
        chainIndex: 0,
        signingPublicKey: stranger.edPublicKey,
        timestamp: Date.now(),
      },
      stranger.edPrivateKey,
    );

    manager.handleSenderKeyDistribution(distribution);

    expect(errs.length).toBeGreaterThanOrEqual(1);
    expect(errs[0].message).toMatch(/unknown group member/i);
    expect(senderKeyRepo.load(groupId, stranger.edPublicKey)).toBeUndefined();
    const members = groupRepo.getMembers(groupId).map((m) => fingerprintFromPublicKey(new Uint8Array(m.public_key)));
    expect(members).not.toContain(stranger.fingerprint);
  });

  it('distributes sender keys only to known group members', async () => {
    const bobState = SenderKeys.generate();
    senderKeyRepo.store(groupId, bob.edPublicKey, bobState.chainKey, 0);

    const aliceSession = makeMockSession(alice);
    const stranger = makeIdentity('Stranger');
    const strangerSession = makeMockSession(stranger);
    const aliceSent: unknown[] = [];
    const strangerSent: unknown[] = [];
    aliceSession.send = ((message: unknown) => { aliceSent.push(message); }) as PeerSession['send'];
    strangerSession.send = ((message: unknown) => { strangerSent.push(message); }) as PeerSession['send'];

    manager = new GroupManager({
      identity: bob,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      swarm: makeMockSwarm({
        sessions: [aliceSession, strangerSession],
        sessionByFingerprint: new Map([
          [alice.fingerprint, aliceSession],
          [stranger.fingerprint, strangerSession],
        ]),
      }) as any,
      groups: groupRepo,
      messages: messageRepo,
      senderKeys: senderKeyRepo,
      peers: peerRepo,
    });

    await manager.distributeSenderKeys(groupId);

    expect(aliceSent).toHaveLength(1);
    expect(strangerSent).toHaveLength(0);
  });

  it('does not demote an existing admin when re-invited', async () => {
    const adminGroupId = new Uint8Array(32).fill(0xef);
    groupRepo.create(adminGroupId, 'admin-group', 'admin');
    groupRepo.addMember(adminGroupId, alice.edPublicKey, 'admin');
    groupRepo.addMember(adminGroupId, mallory.edPublicKey, 'admin');
    const aliceState = SenderKeys.generate();
    senderKeyRepo.store(adminGroupId, alice.edPublicKey, aliceState.chainKey, 0);

    const mallorySession = makeMockSession(mallory);
    mallorySession.send = (() => {}) as PeerSession['send'];
    manager = new GroupManager({
      identity: alice,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      swarm: makeMockSwarm({
        sessions: [mallorySession],
        sessionByFingerprint: new Map([[mallory.fingerprint, mallorySession]]),
      }) as any,
      groups: groupRepo,
      messages: messageRepo,
      senderKeys: senderKeyRepo,
      peers: peerRepo,
    });

    await manager.inviteToGroup(adminGroupId, mallory.edPublicKey);

    const malloryMember = groupRepo
      .getMembers(adminGroupId)
      .find((m) => fingerprintFromPublicKey(new Uint8Array(m.public_key)) === mallory.fingerprint);
    expect(malloryMember?.role).toBe('admin');
  });

  it('keeps the inviter as admin after invite-to-join flow so kicks are honored', async () => {
    const cleanGroupId = new Uint8Array(32).fill(0xcd);
    const invite = signMessage<GroupManagementMessage>(
      {
        type: MessageType.GroupManagement,
        action: 'invite',
        groupId: cleanGroupId,
        targetFingerprint: bob.fingerprint,
        groupName: 'clean-flow',
        timestamp: Date.now(),
        senderPublicKey: alice.edPublicKey,
      },
      alice.edPrivateKey,
    );

    manager.handleGroupManagement(makeMockSession(alice), invite);
    await manager.joinGroup(cleanGroupId, 'clean-flow');
    groupRepo.addMember(cleanGroupId, mallory.edPublicKey, 'member');

    const kick = signMessage<GroupManagementMessage>(
      {
        type: MessageType.GroupManagement,
        action: 'kick',
        groupId: cleanGroupId,
        targetFingerprint: mallory.fingerprint,
        timestamp: Date.now(),
        senderPublicKey: alice.edPublicKey,
      },
      alice.edPrivateKey,
    );
    const errs = collectErrors();

    manager.handleGroupManagement(makeMockSession(alice), kick);

    expect(errs).toHaveLength(0);
    const members = groupRepo.getMembers(cleanGroupId).map((m) => fingerprintFromPublicKey(new Uint8Array(m.public_key)));
    expect(members).toContain(alice.fingerprint);
    expect(members).not.toContain(mallory.fingerprint);
  });

  it('rejects a sender key distribution with an invalid signature', () => {
    const errs = collectErrors();
    const bad: SenderKeyDistributionMessage = {
      type: MessageType.SenderKeyDistribution,
      groupId,
      chainKey: new Uint8Array(32).fill(0x42),
      chainIndex: 0,
      signingPublicKey: alice.edPublicKey,
      timestamp: Date.now(),
      signature: randomBytes(64), // garbage
    };
    manager.handleSenderKeyDistribution(bad);

    expect(errs.length).toBeGreaterThanOrEqual(1);
    expect(errs[0].message).toMatch(/invalid signature/i);
    // Nothing stored.
    expect(senderKeyRepo.load(groupId, alice.edPublicKey)).toBeUndefined();
  });
});
