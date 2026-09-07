import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createGenesisEpoch,
  createSignedEpoch,
  generateIdentity,
} from '@networkselfmd/core';
import { GroupManager } from '../groups/group-manager.js';
import type { SwarmManager } from '../network/swarm.js';
import {
  AgentDatabase,
  GroupEpochRepository,
  GroupInviteRepository,
  GroupRepository,
  MessageRepository,
  PeerRepository,
  ProtocolReplayRepository,
  SenderKeyRepository,
  GroupBootstrapRepository,
} from '../storage/index.js';

let dataDir: string;
let database: AgentDatabase;
let groups: GroupRepository;
let epochs: GroupEpochRepository;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'nsmd-migration-security-'));
  database = new AgentDatabase(dataDir);
  database.migrate();
  groups = new GroupRepository(database.getDb());
  epochs = new GroupEpochRepository(database.getDb());
});

afterEach(() => {
  database.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function managerFor(
  identity: ReturnType<typeof generateIdentity>,
  joinSwarm: ReturnType<typeof vi.fn>,
): GroupManager {
  const db = database.getDb();
  return new GroupManager({
    identity,
    swarm: { join: joinSwarm } as unknown as SwarmManager,
    groups,
    messages: new MessageRepository(db),
    senderKeys: new SenderKeyRepository(db),
    peers: new PeerRepository(db),
    epochs,
    invites: new GroupInviteRepository(db),
    replay: new ProtocolReplayRepository(db),
    bootstraps: new GroupBootstrapRepository(db),
  });
}

describe('legacy group authority migration', () => {
  it('quarantines a legacy admin group with an attacker-signed genesis', async () => {
    const local = generateIdentity();
    const attacker = generateIdentity();
    const groupId = new Uint8Array(32).fill(11);
    const groupIdHex = Buffer.from(groupId).toString('hex');
    const maliciousGenesis = createSignedEpoch(
      createGenesisEpoch(groupIdHex, attacker.edPublicKey),
      attacker.edPrivateKey,
    );
    groups.create(groupId, 'Legacy admin', 'admin');
    epochs.saveEpoch(maliciousGenesis);
    const joinSwarm = vi.fn(async () => {});

    await managerFor(local, joinSwarm).rejoinAllGroups();

    expect(groups.find(groupId)!.creator_public_key).toBeNull();
    expect(groups.find(groupId)!.genesis_hash).toBeNull();
    expect(joinSwarm).not.toHaveBeenCalled();
  });

  it('quarantines an unpinned legacy member until an authenticated join pins it', async () => {
    const local = generateIdentity();
    const remoteAdmin = generateIdentity();
    const groupId = new Uint8Array(32).fill(12);
    const groupIdHex = Buffer.from(groupId).toString('hex');
    const genesis = createSignedEpoch(
      createGenesisEpoch(groupIdHex, remoteAdmin.edPublicKey),
      remoteAdmin.edPrivateKey,
    );
    groups.create(groupId, 'Legacy member', 'member');
    epochs.saveEpoch(genesis);
    const joinSwarm = vi.fn(async () => {});

    await managerFor(local, joinSwarm).rejoinAllGroups();

    expect(groups.find(groupId)!.creator_public_key).toBeNull();
    expect(groups.find(groupId)!.genesis_hash).toBeNull();
    expect(joinSwarm).not.toHaveBeenCalled();

    groups.join(
      groupId,
      'Authenticated member',
      'member',
      remoteAdmin.edPublicKey,
      genesis.hash,
    );
    expect(new Uint8Array(groups.find(groupId)!.creator_public_key!)).toEqual(
      remoteAdmin.edPublicKey,
    );
  });

  it('auto-pins only a local admin genesis before rejoining', async () => {
    const local = generateIdentity();
    const groupId = new Uint8Array(32).fill(13);
    const groupIdHex = Buffer.from(groupId).toString('hex');
    const genesis = createSignedEpoch(
      createGenesisEpoch(groupIdHex, local.edPublicKey),
      local.edPrivateKey,
    );
    groups.create(groupId, 'Local legacy admin', 'admin');
    groups.addMember(groupId, local.edPublicKey, 'admin');
    epochs.saveEpoch(genesis);
    const joinSwarm = vi.fn(async () => {});

    await managerFor(local, joinSwarm).rejoinAllGroups();

    expect(new Uint8Array(groups.find(groupId)!.creator_public_key!)).toEqual(
      local.edPublicKey,
    );
    expect(new Uint8Array(groups.find(groupId)!.genesis_hash!)).toEqual(
      genesis.hash,
    );
    expect(joinSwarm).toHaveBeenCalledOnce();
  });
});
