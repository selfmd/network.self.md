import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createGenesisEpoch,
  createSignedEpoch,
  generateIdentity,
  MessageType,
  SenderKeys,
  signAuthenticatedMessage,
} from '@networkselfmd/core';
import type { GroupEncryptedMessage, GroupEpoch } from '@networkselfmd/core';
import { GroupManager } from '../groups/group-manager.js';
import type { PeerSession } from '../network/connection.js';
import type { SwarmManager } from '../network/swarm.js';
import {
  AgentDatabase,
  GroupBootstrapRepository,
  GroupEpochRepository,
  GroupRepository,
  MessageRepository,
  PeerRepository,
  ProtocolReplayRepository,
  SenderKeyRepository,
} from '../storage/index.js';

describe('group epoch authorization before replay reservation', () => {
  const creator = generateIdentity();
  const sender = generateIdentity();
  const recipient = generateIdentity();
  const groupId = new Uint8Array(32).fill(1);
  const groupIdHex = Buffer.from(groupId).toString('hex');
  let dir: string;
  let database: AgentDatabase;
  let groups: GroupRepository;
  let senderKeys: SenderKeyRepository;
  let epochs: GroupEpochRepository;
  let replay: ProtocolReplayRepository;
  let manager: GroupManager;
  let errors: Error[];

  const session = {
    state: 'ready',
    peerPublicKey: sender.edPublicKey,
    peerFingerprint: sender.fingerprint,
  } as PeerSession;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nsmd-group-security-'));
    database = new AgentDatabase(dir);
    database.migrate();
    const db = database.getDb();
    groups = new GroupRepository(db);
    senderKeys = new SenderKeyRepository(db);
    epochs = new GroupEpochRepository(db);
    replay = new ProtocolReplayRepository(db);
    manager = new GroupManager({
      identity: recipient,
      swarm: {} as SwarmManager,
      groups,
      messages: new MessageRepository(db),
      senderKeys,
      peers: new PeerRepository(db),
      epochs,
      replay,
      bootstraps: new GroupBootstrapRepository(db),
    });
    errors = [];
    manager.on('error', (error: Error) => errors.push(error));
  });

  afterEach(() => {
    database.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function establishEpoch(includeSender = true) {
    const genesis = createSignedEpoch(
      createGenesisEpoch(groupIdHex, creator.edPublicKey, 1),
      creator.edPrivateKey,
    );
    groups.create(
      groupId,
      'secure',
      'member',
      creator.edPublicKey,
      genesis.hash,
    );
    epochs.saveEpoch(genesis);
    const epoch: GroupEpoch = {
      version: 1,
      prevHash: genesis.hash,
      groupId: groupIdHex,
      members: [
        { publicKey: creator.edPublicKey, role: 'admin' },
        { publicKey: recipient.edPublicKey, role: 'member' },
        ...(includeSender
          ? [{ publicKey: sender.edPublicKey, role: 'member' as const }]
          : []),
      ],
      createdAt: 2,
      createdBy: creator.edPublicKey,
    };
    const signed = createSignedEpoch(epoch, creator.edPrivateKey);
    epochs.saveEpoch(signed);
    return { genesis, latest: signed };
  }

  function encryptedMessage(
    epochVersion: number,
    epochHash: Uint8Array,
    chainKey = new Uint8Array(32).fill(7),
  ): GroupEncryptedMessage {
    const encrypted = SenderKeys.encrypt(
      { chainKey, chainIndex: 0 },
      new TextEncoder().encode('hello'),
    );
    return signAuthenticatedMessage<GroupEncryptedMessage>(
      {
        type: MessageType.GroupMessage,
        groupId,
        senderFingerprint: sender.fingerprint,
        chainIndex: encrypted.chainIndex,
        epochVersion,
        epochHash,
        ciphertext: encrypted.ciphertext,
        nonce: encrypted.nonce,
        timestamp: Date.now(),
      },
      sender.edPrivateKey,
    );
  }

  it('fails closed for an unknown group without poisoning replay state', async () => {
    await manager.handleGroupMessage(
      session,
      encryptedMessage(0, new Uint8Array(32)),
    );
    expect(errors.at(-1)?.message).toMatch(/unknown or missing epoch/i);
    expect(replay.count()).toBe(0);
  });

  it('rejects stale epochs and revoked senders before claiming replay', async () => {
    const { genesis, latest } = establishEpoch(true);
    senderKeys.store(
      groupId,
      sender.edPublicKey,
      new Uint8Array(32).fill(7),
      0,
    );
    await manager.handleGroupMessage(
      session,
      encryptedMessage(genesis.epoch.version, genesis.hash),
    );
    expect(errors.at(-1)?.message).toMatch(/stale group epoch/i);
    expect(replay.count()).toBe(0);

    const revoked = createSignedEpoch(
      {
        ...latest.epoch,
        version: 2,
        prevHash: latest.hash,
        members: latest.epoch.members.filter(
          (member) =>
            !Buffer.from(member.publicKey).equals(
              Buffer.from(sender.edPublicKey),
            ),
        ),
        createdAt: 3,
      },
      creator.edPrivateKey,
    );
    epochs.saveEpoch(revoked);
    await manager.handleGroupMessage(
      session,
      encryptedMessage(revoked.epoch.version, revoked.hash),
    );
    expect(errors.at(-1)?.message).toMatch(/sender is revoked/i);
    expect(replay.count()).toBe(0);
  });

  it('commits sender-key state, message, and replay exactly once', async () => {
    const { latest } = establishEpoch(true);
    const chainKey = new Uint8Array(32).fill(7);
    senderKeys.store(groupId, sender.edPublicKey, chainKey, 0);
    const message = encryptedMessage(
      latest.epoch.version,
      latest.hash,
      chainKey,
    );
    const received: string[] = [];
    manager.on('group:message', (event: { content: string }) =>
      received.push(event.content),
    );

    await manager.handleGroupMessage(session, message);
    expect(received).toEqual(['hello']);
    expect(senderKeys.load(groupId, sender.edPublicKey)?.chain_index).toBe(1);
    expect(replay.count()).toBe(1);

    await manager.handleGroupMessage(session, message);
    expect(errors.at(-1)?.message).toMatch(/replay/i);
    expect(received).toEqual(['hello']);
    expect(senderKeys.load(groupId, sender.edPublicKey)?.chain_index).toBe(1);
  });
});
