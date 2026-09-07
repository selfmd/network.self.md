import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  generateIdentity,
  MessageType,
  signAuthenticatedMessage,
} from '@networkselfmd/core';
import type { GroupManagementMessage } from '@networkselfmd/core';
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

describe('group invite admission context', () => {
  const admin = generateIdentity();
  const invitee = generateIdentity();
  let dir: string;
  let database: AgentDatabase;
  let groups: GroupRepository;
  let epochs: GroupEpochRepository;
  let invites: GroupInviteRepository;
  let replay: ProtocolReplayRepository;
  let manager: GroupManager;
  let errors: Error[];
  let session: PeerSession;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nsmd-invite-context-'));
    database = new AgentDatabase(dir);
    database.migrate();
    const db = database.getDb();
    groups = new GroupRepository(db);
    epochs = new GroupEpochRepository(db);
    invites = new GroupInviteRepository(db);
    replay = new ProtocolReplayRepository(db);
    session = {
      state: 'ready',
      peerPublicKey: invitee.edPublicKey,
      peerFingerprint: invitee.fingerprint,
      peerCapabilities: new Set(),
      send: vi.fn(),
    } as unknown as PeerSession;
    const swarm = { join: vi.fn(), getSession: () => session } as unknown as SwarmManager;
    manager = new GroupManager({
      identity: admin,
      swarm,
      groups,
      epochs,
      invites,
      replay,
      messages: new MessageRepository(db),
      senderKeys: new SenderKeyRepository(db),
      peers: new PeerRepository(db),
      bootstraps: new GroupBootstrapRepository(db),
    });
    errors = [];
    manager.on('error', (error: Error) => errors.push(error));
  });

  afterEach(() => {
    database.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function accept(groupId: Uint8Array, inviteId: string): GroupManagementMessage {
    const genesis = epochs.getEpochByVersion(Buffer.from(groupId).toString('hex'), 0)!;
    return signAuthenticatedMessage<GroupManagementMessage>(
      {
        type: MessageType.GroupManagement,
        action: 'accept',
        groupId,
        inviteId,
        targetFingerprint: invitee.fingerprint,
        epochVersion: 0,
        epochHash: genesis.hash,
        senderFingerprint: invitee.fingerprint,
        recipientFingerprint: admin.fingerprint,
        timestamp: Date.now(),
      },
      invitee.edPrivateKey,
    );
  }

  it('rejects an invitation reused for another private group without consuming it', async () => {
    const allowed = await manager.createGroup('allowed');
    const privateGroup = await manager.createGroup('private');
    await manager.inviteToGroup(allowed.groupId, invitee.edPublicKey);
    const invitation = vi.mocked(session.send).mock.calls.map(([message]) => message).find((message) => message.type === MessageType.GroupManagement) as GroupManagementMessage;
    await manager.handleGroupManagement(session, accept(privateGroup.groupId, invitation.inviteId!));

    expect(errors.at(-1)?.message).toMatch(/invite mismatch/i);
    expect(epochs.getLatestEpoch(Buffer.from(privateGroup.groupId).toString('hex'))?.epoch.version).toBe(0);
    expect(groups.getMembers(privateGroup.groupId)).toHaveLength(1);
    expect(invites.findById(invitation.inviteId!)).toBeDefined();
    expect(replay.count()).toBe(0);

    await manager.handleGroupManagement(session, accept(allowed.groupId, invitation.inviteId!));
    expect(epochs.getLatestEpoch(Buffer.from(allowed.groupId).toString('hex'))?.epoch.version).toBe(1);
    expect(groups.getMembers(allowed.groupId)).toHaveLength(2);
    expect(invites.findById(invitation.inviteId!)).toBeUndefined();
    expect(replay.count()).toBe(1);
  });
});
