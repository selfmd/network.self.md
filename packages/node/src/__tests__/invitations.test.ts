import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateIdentity } from '@networkselfmd/core';
import { Agent } from '../agent.js';
import { AgentDatabase, GroupInviteRepository } from '../storage/index.js';

describe('persisted incoming invitations', () => {
  it('lists only unexpired incoming invitations for this identity after reopening', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nsmd-invitation-inbox-'));
    let database = new AgentDatabase(dir);
    database.migrate();
    const identity = generateIdentity();
    const inviter = generateIdentity();
    const repo = new GroupInviteRepository(database.getDb());
    const now = Date.now();
    const save = (id: string, created_at = now, direction: 'incoming' | 'outgoing' = 'incoming', inviteePublicKey = identity.edPublicKey) => repo.save({
      invite_id: id, group_name: 'private builders', groupId: new Uint8Array(32).fill(1),
      inviterPublicKey: inviter.edPublicKey, inviteePublicKey,
      genesisEpochData: new Uint8Array([1]), genesisSignature: new Uint8Array(64),
      genesisHash: new Uint8Array(32), direction, created_at,
    });
    try {
      save('valid');
      save('expired', now - 24 * 60 * 60 * 1000 - 1000);
      save('outgoing', now, 'outgoing');
      save('other-recipient', now, 'incoming', inviter.edPublicKey);
      save(`public:${identity.fingerprint}`);
      database.close();
      database = new AgentDatabase(dir);
      const reopened = new GroupInviteRepository(database.getDb());
      const agent = new Agent({ dataDir: dir });
      Object.assign(agent, { identity, isRunning: true, groupInviteRepo: reopened });
      expect(agent.listGroupInvitations()).toEqual([{
        inviteId: 'valid', groupId: new Uint8Array(32).fill(1), name: 'private builders',
        inviterPublicKey: inviter.edPublicKey, inviterFingerprint: inviter.fingerprint,
        createdAt: now, expiresAt: now + 24 * 60 * 60 * 1000,
      }]);
      reopened.delete('valid');
      expect(agent.listGroupInvitations()).toEqual([]);
    } finally { database.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
