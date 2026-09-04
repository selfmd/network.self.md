import type Database from 'better-sqlite3';
import type { DoubleRatchetState, SignedGroupEpoch } from '@networkselfmd/core';
import { serializeEpoch, deserializeEpoch, hashEpoch } from '@networkselfmd/core';

// Local types for DB rows
export interface StoredIdentity {
  id: number;
  ed_private_key: Buffer;
  ed_public_key: Buffer;
  display_name: string | null;
  created_at: number;
}

export interface StoredPeer {
  public_key: Buffer;
  fingerprint: string;
  display_name: string | null;
  trusted: number;
  last_seen: number | null;
}

export interface StoredGroup {
  group_id: Buffer;
  name: string;
  role: string;
  created_at: number;
  joined_at: number | null;
  is_public: number;
  self_md: string | null;
  creator_public_key: Buffer | null;
  genesis_hash: Buffer | null;
}

export interface StoredGroupMember {
  group_id: Buffer;
  public_key: Buffer;
  role: string;
}

export interface StoredMessage {
  id: string;
  group_id: Buffer | null;
  sender_public_key: Buffer | null;
  peer_public_key: Buffer | null;
  content: string;
  timestamp: number;
  type: string;
}

export interface StoredSenderKey {
  group_id: Buffer;
  public_key: Buffer;
  chain_key: Buffer;
  chain_index: number;
  generation_id: Buffer | null;
  distribution_sequence: number;
  epoch_version: number;
  epoch_hash: Buffer | null;
}

export interface StoredKeyData {
  id: number;
  salt: Buffer;
  nonce: Buffer;
  ciphertext: Buffer;
}

export interface MessageQueryOptions {
  groupId?: Uint8Array;
  peerPublicKey?: Uint8Array;
  limit?: number;
  before?: string;
}

export class IdentityRepository {
  constructor(private db: Database.Database) {}

  save(
    edPrivateKey: Uint8Array,
    edPublicKey: Uint8Array,
    displayName?: string,
  ): void {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO identity (id, ed_private_key, ed_public_key, display_name, created_at)
       VALUES (1, ?, ?, ?, ?)`,
    );
    stmt.run(
      Buffer.from(edPrivateKey),
      Buffer.from(edPublicKey),
      displayName ?? null,
      Date.now(),
    );
  }

  load(): StoredIdentity | undefined {
    return this.db
      .prepare('SELECT * FROM identity WHERE id = 1')
      .get() as StoredIdentity | undefined;
  }

  saveEncryptedKeys(salt: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array): void {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO key_storage (id, salt, nonce, ciphertext)
       VALUES (1, ?, ?, ?)`,
    );
    stmt.run(Buffer.from(salt), Buffer.from(nonce), Buffer.from(ciphertext));
  }

  loadEncryptedKeys(): StoredKeyData | undefined {
    return this.db
      .prepare('SELECT * FROM key_storage WHERE id = 1')
      .get() as StoredKeyData | undefined;
  }
}

export class PeerRepository {
  constructor(private db: Database.Database) {}

  upsert(
    publicKey: Uint8Array,
    fingerprint: string,
    displayName?: string,
  ): void {
    const stmt = this.db.prepare(
      `INSERT INTO peers (public_key, fingerprint, display_name, last_seen)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(public_key) DO UPDATE SET
         fingerprint = excluded.fingerprint,
         display_name = COALESCE(excluded.display_name, peers.display_name),
         last_seen = excluded.last_seen`,
    );
    stmt.run(Buffer.from(publicKey), fingerprint, displayName ?? null, Date.now());
  }

  find(publicKey: Uint8Array): StoredPeer | undefined {
    return this.db
      .prepare('SELECT * FROM peers WHERE public_key = ?')
      .get(Buffer.from(publicKey)) as StoredPeer | undefined;
  }

  list(): StoredPeer[] {
    return this.db.prepare('SELECT * FROM peers ORDER BY last_seen DESC').all() as StoredPeer[];
  }

  trust(publicKey: Uint8Array): void {
    this.db
      .prepare('UPDATE peers SET trusted = 1 WHERE public_key = ?')
      .run(Buffer.from(publicKey));
  }

  untrust(publicKey: Uint8Array): void {
    this.db
      .prepare('UPDATE peers SET trusted = 0 WHERE public_key = ?')
      .run(Buffer.from(publicKey));
  }

  updateLastSeen(publicKey: Uint8Array): void {
    this.db
      .prepare('UPDATE peers SET last_seen = ? WHERE public_key = ?')
      .run(Date.now(), Buffer.from(publicKey));
  }
}

export class GroupRepository {
  constructor(private db: Database.Database) {}

  create(groupId: Uint8Array, name: string, role: string = 'admin', creatorPublicKey?: Uint8Array, genesisHash?: Uint8Array): void {
    const now = Date.now();
    const stmt = this.db.prepare(
      `INSERT INTO groups (group_id, name, role, created_at, joined_at, creator_public_key, genesis_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    stmt.run(Buffer.from(groupId), name, role, now, now, creatorPublicKey ? Buffer.from(creatorPublicKey) : null, genesisHash ? Buffer.from(genesisHash) : null);
  }

  join(groupId: Uint8Array, name: string, role: string = 'member', creatorPublicKey?: Uint8Array, genesisHash?: Uint8Array): void {
    const now = Date.now();
    const stmt = this.db.prepare(
      `INSERT INTO groups (group_id, name, role, created_at, joined_at, creator_public_key, genesis_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(group_id) DO UPDATE SET name = excluded.name, joined_at = excluded.joined_at
       WHERE (groups.genesis_hash IS NULL OR groups.genesis_hash = excluded.genesis_hash)`,
    );
    const result = stmt.run(Buffer.from(groupId), name, role, now, now, creatorPublicKey ? Buffer.from(creatorPublicKey) : null, genesisHash ? Buffer.from(genesisHash) : null);
    if (result.changes !== 1) throw new Error('Group authority mismatch');
  }

  leave(groupId: Uint8Array): void {
    this.db.prepare('DELETE FROM groups WHERE group_id = ?').run(Buffer.from(groupId));
    this.db.prepare('DELETE FROM group_members WHERE group_id = ?').run(Buffer.from(groupId));
    this.db.prepare('DELETE FROM sender_keys WHERE group_id = ?').run(Buffer.from(groupId));
  }

  find(groupId: Uint8Array): StoredGroup | undefined {
    return this.db
      .prepare('SELECT * FROM groups WHERE group_id = ?')
      .get(Buffer.from(groupId)) as StoredGroup | undefined;
  }

  pinAuthority(groupId: Uint8Array, creatorPublicKey: Uint8Array, genesisHash: Uint8Array): void {
    const result = this.db.prepare(`UPDATE groups SET creator_public_key = ?, genesis_hash = ?
      WHERE group_id = ? AND (genesis_hash IS NULL OR genesis_hash = ?)`)
      .run(Buffer.from(creatorPublicKey), Buffer.from(genesisHash), Buffer.from(groupId), Buffer.from(genesisHash));
    if (result.changes !== 1) throw new Error('Group authority mismatch');
  }

  list(): StoredGroup[] {
    return this.db.prepare('SELECT * FROM groups ORDER BY joined_at DESC').all() as StoredGroup[];
  }

  addMember(groupId: Uint8Array, publicKey: Uint8Array, role: string = 'member'): void {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO group_members (group_id, public_key, role)
       VALUES (?, ?, ?)`,
    );
    stmt.run(Buffer.from(groupId), Buffer.from(publicKey), role);
  }

  removeMember(groupId: Uint8Array, publicKey: Uint8Array): void {
    this.db
      .prepare('DELETE FROM group_members WHERE group_id = ? AND public_key = ?')
      .run(Buffer.from(groupId), Buffer.from(publicKey));
  }

  getMembers(groupId: Uint8Array): StoredGroupMember[] {
    return this.db
      .prepare('SELECT * FROM group_members WHERE group_id = ?')
      .all(Buffer.from(groupId)) as StoredGroupMember[];
  }

  setPublic(groupId: Uint8Array, isPublic: boolean, selfMd?: string): void {
    const group = this.find(groupId);
    if (!group) {
      throw new Error('Group not found');
    }
    if (group.role !== 'admin') {
      throw new Error('Only admin can change group visibility');
    }
    this.db
      .prepare('UPDATE groups SET is_public = ?, self_md = COALESCE(?, self_md) WHERE group_id = ?')
      .run(isPublic ? 1 : 0, selfMd ?? null, Buffer.from(groupId));
  }

  listPublic(): StoredGroup[] {
    return this.db
      .prepare('SELECT * FROM groups WHERE is_public = 1')
      .all() as StoredGroup[];
  }
}

export class MessageRepository {
  constructor(private db: Database.Database) {}

  insert(message: {
    id: string;
    groupId?: Uint8Array;
    senderPublicKey?: Uint8Array;
    peerPublicKey?: Uint8Array;
    content: string;
    timestamp: number;
    type: string;
  }): void {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO messages (id, group_id, sender_public_key, peer_public_key, content, timestamp, type)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    stmt.run(
      message.id,
      message.groupId ? Buffer.from(message.groupId) : null,
      message.senderPublicKey ? Buffer.from(message.senderPublicKey) : null,
      message.peerPublicKey ? Buffer.from(message.peerPublicKey) : null,
      message.content,
      message.timestamp,
      message.type,
    );
  }

  query(options: MessageQueryOptions): StoredMessage[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (options.groupId) {
      conditions.push('group_id = ?');
      params.push(Buffer.from(options.groupId));
    }

    if (options.peerPublicKey) {
      conditions.push('(sender_public_key = ? OR peer_public_key = ?)');
      params.push(Buffer.from(options.peerPublicKey), Buffer.from(options.peerPublicKey));
    }

    if (options.before) {
      conditions.push('id < ?');
      params.push(options.before);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = options.limit ?? 50;

    return this.db
      .prepare(`SELECT * FROM messages ${where} ORDER BY timestamp DESC LIMIT ?`)
      .all(...params, limit) as StoredMessage[];
  }
}

export interface StoredDiscoveredGroup {
  group_id: Buffer;
  name: string;
  self_md: string | null;
  member_count: number;
  announced_by: Buffer;
  last_announced: number;
  authority_key: Buffer;
  genesis_hash: Buffer;
  genesis_epoch_data: Buffer;
  genesis_signature: Buffer;
}

export class DiscoveredGroupRepository {
  constructor(private db: Database.Database) {}

  upsert(
    groupId: Uint8Array,
    name: string,
    selfMd: string | undefined,
    memberCount: number,
    announcedBy: Uint8Array,
    genesisEpochData: Uint8Array,
    genesisSignature: Uint8Array,
    genesisHash: Uint8Array,
    announcedAt = Date.now(),
  ): boolean {
    const stmt = this.db.prepare(
      `INSERT INTO discovered_groups (group_id, name, self_md, member_count, announced_by, last_announced, authority_key, genesis_hash, genesis_epoch_data, genesis_signature)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(group_id) DO UPDATE SET
         name = excluded.name,
         self_md = COALESCE(excluded.self_md, discovered_groups.self_md),
         member_count = excluded.member_count,
         announced_by = excluded.announced_by,
         last_announced = excluded.last_announced
       WHERE discovered_groups.genesis_hash = excluded.genesis_hash
         AND discovered_groups.authority_key = excluded.authority_key`,
    );
    const result = stmt.run(Buffer.from(groupId), name, selfMd ?? null, memberCount, Buffer.from(announcedBy), announcedAt, Buffer.from(announcedBy), Buffer.from(genesisHash), Buffer.from(genesisEpochData), Buffer.from(genesisSignature));
    this.prune(announcedAt);
    return result.changes === 1;
  }

  list(): StoredDiscoveredGroup[] {
    return this.db
      .prepare('SELECT * FROM discovered_groups ORDER BY last_announced DESC')
      .all() as StoredDiscoveredGroup[];
  }

  find(groupId: Uint8Array): StoredDiscoveredGroup | undefined {
    return this.db
      .prepare('SELECT * FROM discovered_groups WHERE group_id = ?')
      .get(Buffer.from(groupId)) as StoredDiscoveredGroup | undefined;
  }

  remove(groupId: Uint8Array): void {
    this.db.prepare('DELETE FROM discovered_groups WHERE group_id = ?').run(Buffer.from(groupId));
  }

  prune(now = Date.now(), maxRows = 1000, maxAgeMs = 24 * 60 * 60 * 1000): void {
    this.db.prepare('DELETE FROM discovered_groups WHERE last_announced < ?').run(now - maxAgeMs);
    this.db.prepare(`DELETE FROM discovered_groups WHERE group_id IN (
      SELECT group_id FROM discovered_groups ORDER BY last_announced DESC LIMIT -1 OFFSET ?
    )`).run(maxRows);
  }
}

export class SenderKeyRepository {
  constructor(private db: Database.Database) {}

  store(
    groupId: Uint8Array,
    publicKey: Uint8Array,
    chainKey: Uint8Array,
    chainIndex: number,
    generationId: Uint8Array = new Uint8Array(16),
    distributionSequence = -1,
    epochVersion = 0,
    epochHash: Uint8Array = new Uint8Array(32),
  ): void {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO sender_keys (group_id, public_key, chain_key, chain_index, generation_id, distribution_sequence, epoch_version, epoch_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    stmt.run(Buffer.from(groupId), Buffer.from(publicKey), Buffer.from(chainKey), chainIndex, Buffer.from(generationId), distributionSequence, epochVersion, Buffer.from(epochHash));
  }

  storeIfNewer(groupId: Uint8Array, publicKey: Uint8Array, chainKey: Uint8Array, chainIndex: number, generationId: Uint8Array, sequence: number, epochVersion: number, epochHash: Uint8Array): boolean {
    return this.db.transaction(() => {
      const existing = this.load(groupId, publicKey);
      if (existing && (sequence <= existing.distribution_sequence || (existing.generation_id?.equals(Buffer.from(generationId)) && chainIndex < existing.chain_index))) return false;
      this.store(groupId, publicKey, chainKey, chainIndex, generationId, sequence, epochVersion, epochHash);
      return true;
    })();
  }

  load(groupId: Uint8Array, publicKey: Uint8Array): StoredSenderKey | undefined {
    return this.db
      .prepare('SELECT * FROM sender_keys WHERE group_id = ? AND public_key = ?')
      .get(Buffer.from(groupId), Buffer.from(publicKey)) as StoredSenderKey | undefined;
  }

  delete(groupId: Uint8Array, publicKey: Uint8Array): void {
    this.db
      .prepare('DELETE FROM sender_keys WHERE group_id = ? AND public_key = ?')
      .run(Buffer.from(groupId), Buffer.from(publicKey));
  }

  listForGroup(groupId: Uint8Array): StoredSenderKey[] {
    return this.db
      .prepare('SELECT * FROM sender_keys WHERE group_id = ?')
      .all(Buffer.from(groupId)) as StoredSenderKey[];
  }

  deleteForGroup(groupId: Uint8Array): void {
    this.db
      .prepare('DELETE FROM sender_keys WHERE group_id = ?')
      .run(Buffer.from(groupId));
  }
}

export interface StoredGroupInvite {
  invite_id: string;
  group_id: Buffer;
  group_name: string;
  inviter_public_key: Buffer;
  invitee_public_key: Buffer;
  genesis_epoch_data: Buffer;
  genesis_signature: Buffer;
  genesis_hash: Buffer;
  direction: 'incoming' | 'outgoing';
  created_at: number;
}

export class GroupInviteRepository {
  constructor(private db: Database.Database) {}

  save(invite: Omit<StoredGroupInvite, 'group_id' | 'inviter_public_key' | 'invitee_public_key' | 'genesis_epoch_data' | 'genesis_signature' | 'genesis_hash'> & {
    groupId: Uint8Array; inviterPublicKey: Uint8Array; inviteePublicKey: Uint8Array;
    genesisEpochData: Uint8Array; genesisSignature: Uint8Array; genesisHash: Uint8Array;
  }): void {
    this.db.prepare(`INSERT OR REPLACE INTO group_invites
      (invite_id, group_id, group_name, inviter_public_key, invitee_public_key, genesis_epoch_data, genesis_signature, genesis_hash, direction, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      invite.invite_id, Buffer.from(invite.groupId), invite.group_name,
      Buffer.from(invite.inviterPublicKey), Buffer.from(invite.inviteePublicKey),
      Buffer.from(invite.genesisEpochData), Buffer.from(invite.genesisSignature), Buffer.from(invite.genesisHash),
      invite.direction, invite.created_at,
    );
    this.db.prepare(`DELETE FROM group_invites WHERE invite_id IN (
      SELECT invite_id FROM group_invites ORDER BY created_at DESC LIMIT -1 OFFSET 256
    )`).run();
  }

  findIncoming(groupId: Uint8Array): StoredGroupInvite | undefined {
    return this.db.prepare("SELECT * FROM group_invites WHERE group_id = ? AND direction = 'incoming' AND created_at >= ? ORDER BY created_at DESC LIMIT 1").get(Buffer.from(groupId), Date.now() - 24 * 60 * 60 * 1000) as StoredGroupInvite | undefined;
  }

  findById(inviteId: string): StoredGroupInvite | undefined {
    return this.db.prepare('SELECT * FROM group_invites WHERE invite_id = ? AND created_at >= ?').get(inviteId, Date.now() - 24 * 60 * 60 * 1000) as StoredGroupInvite | undefined;
  }

  delete(inviteId: string): void { this.db.prepare('DELETE FROM group_invites WHERE invite_id = ?').run(inviteId); }

  deleteIncoming(groupId: Uint8Array): void {
    this.db.prepare("DELETE FROM group_invites WHERE group_id = ? AND direction = 'incoming'").run(Buffer.from(groupId));
  }
}

export class NetworkAnnounceStateRepository {
  constructor(private db: Database.Database) {}

  accept(peerPublicKey: Uint8Array, timestamp: number, now = Date.now(), limit = 10, windowMs = 60_000): boolean {
    const transaction = this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM network_announce_state WHERE peer_public_key = ?').get(Buffer.from(peerPublicKey)) as { last_timestamp: number; window_started: number; message_count: number } | undefined;
      if (row && timestamp <= row.last_timestamp) return false;
      const inWindow = Boolean(row && now - row.window_started < windowMs);
      const count = inWindow ? row!.message_count + 1 : 1;
      if (count > limit) return false;
      this.db.prepare(`INSERT OR REPLACE INTO network_announce_state
        (peer_public_key, last_timestamp, window_started, message_count) VALUES (?, ?, ?, ?)`)
        .run(Buffer.from(peerPublicKey), timestamp, inWindow ? row!.window_started : now, count);
      this.db.prepare('DELETE FROM network_announce_state WHERE window_started < ?').run(now - 24 * 60 * 60 * 1000);
      this.db.prepare(`DELETE FROM network_announce_state WHERE peer_public_key IN (
        SELECT peer_public_key FROM network_announce_state ORDER BY last_timestamp DESC LIMIT -1 OFFSET 10000
      )`).run();
      return true;
    });
    return transaction();
  }
}

// --- Hex encoding helpers for Uint8Array serialization ---

function toHex(arr: Uint8Array): string {
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

interface SerializedRatchetState {
  rootKey: string;
  sendChainKey: string | null;
  receiveChainKey: string | null;
  sendRatchetPrivate: string;
  sendRatchetPublic: string;
  receiveRatchetPublic: string | null;
  sendMessageNumber: number;
  receiveMessageNumber: number;
  previousChainLength: number;
  skippedKeys: Array<[string, string]>;
}

function serializeRatchetState(state: DoubleRatchetState): string {
  const serialized: SerializedRatchetState = {
    rootKey: toHex(state.rootKey),
    sendChainKey: state.sendChainKey ? toHex(state.sendChainKey) : null,
    receiveChainKey: state.receiveChainKey ? toHex(state.receiveChainKey) : null,
    sendRatchetPrivate: toHex(state.sendRatchetPrivate),
    sendRatchetPublic: toHex(state.sendRatchetPublic),
    receiveRatchetPublic: state.receiveRatchetPublic ? toHex(state.receiveRatchetPublic) : null,
    sendMessageNumber: state.sendMessageNumber,
    receiveMessageNumber: state.receiveMessageNumber,
    previousChainLength: state.previousChainLength,
    skippedKeys: Array.from(state.skippedKeys.entries()).map(([k, v]) => [k, toHex(v)]),
  };
  return JSON.stringify(serialized);
}

function deserializeRatchetState(json: string): DoubleRatchetState {
  const s: SerializedRatchetState = JSON.parse(json);
  return {
    rootKey: fromHex(s.rootKey),
    sendChainKey: s.sendChainKey ? fromHex(s.sendChainKey) : null,
    receiveChainKey: s.receiveChainKey ? fromHex(s.receiveChainKey) : null,
    sendRatchetPrivate: fromHex(s.sendRatchetPrivate),
    sendRatchetPublic: fromHex(s.sendRatchetPublic),
    receiveRatchetPublic: s.receiveRatchetPublic ? fromHex(s.receiveRatchetPublic) : null,
    sendMessageNumber: s.sendMessageNumber,
    receiveMessageNumber: s.receiveMessageNumber,
    previousChainLength: s.previousChainLength,
    skippedKeys: new Map(s.skippedKeys.map(([k, v]) => [k, fromHex(v)])),
  };
}

export class RatchetStateRepository {
  constructor(private db: Database.Database) {}

  save(peerFingerprint: string, state: DoubleRatchetState): void {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO dm_ratchet_states (peer_fingerprint, state_json, updated_at)
       VALUES (?, ?, ?)`,
    );
    stmt.run(peerFingerprint, serializeRatchetState(state), Date.now());
  }

  load(peerFingerprint: string): DoubleRatchetState | null {
    const row = this.db
      .prepare('SELECT state_json FROM dm_ratchet_states WHERE peer_fingerprint = ?')
      .get(peerFingerprint) as { state_json: string } | undefined;
    if (!row) return null;
    return deserializeRatchetState(row.state_json);
  }

  delete(peerFingerprint: string): void {
    this.db
      .prepare('DELETE FROM dm_ratchet_states WHERE peer_fingerprint = ?')
      .run(peerFingerprint);
  }
}

interface StoredGroupEpochRow {
  id: number;
  group_id: string;
  version: number;
  prev_hash: Buffer;
  epoch_data: Buffer;
  signature: Buffer;
  hash: Buffer;
  created_by: Buffer;
  created_at: number;
}

export class GroupEpochRepository {
  constructor(private db: Database.Database) {}

  saveEpoch(signed: SignedGroupEpoch): void {
    const serialized = serializeEpoch(signed.epoch);
    const stmt = this.db.prepare(
      `INSERT INTO group_epochs (group_id, version, prev_hash, epoch_data, signature, hash, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(group_id, version) DO NOTHING`,
    );
    const result = stmt.run(
      signed.epoch.groupId,
      signed.epoch.version,
      Buffer.from(signed.epoch.prevHash),
      Buffer.from(serialized),
      Buffer.from(signed.signature),
      Buffer.from(signed.hash),
      Buffer.from(signed.epoch.createdBy),
      signed.epoch.timestamp,
    );
    if (result.changes === 0) {
      const existing = this.getEpochByVersion(signed.epoch.groupId, signed.epoch.version);
      if (!existing || !Buffer.from(existing.hash).equals(Buffer.from(signed.hash))) {
        throw new Error('Conflicting group epoch overwrite');
      }
    }
  }

  getLatestEpoch(groupId: string): SignedGroupEpoch | null {
    const row = this.db
      .prepare('SELECT * FROM group_epochs WHERE group_id = ? ORDER BY version DESC LIMIT 1')
      .get(groupId) as StoredGroupEpochRow | undefined;
    if (!row) return null;
    return this.rowToSignedEpoch(row);
  }

  getEpochChain(groupId: string): SignedGroupEpoch[] {
    const rows = this.db
      .prepare('SELECT * FROM group_epochs WHERE group_id = ? ORDER BY version ASC')
      .all(groupId) as StoredGroupEpochRow[];
    return rows.map((r) => this.rowToSignedEpoch(r));
  }

  getEpochByVersion(groupId: string, version: number): SignedGroupEpoch | null {
    const row = this.db
      .prepare('SELECT * FROM group_epochs WHERE group_id = ? AND version = ?')
      .get(groupId, version) as StoredGroupEpochRow | undefined;
    if (!row) return null;
    return this.rowToSignedEpoch(row);
  }

  private rowToSignedEpoch(row: StoredGroupEpochRow): SignedGroupEpoch {
    const epoch = deserializeEpoch(new Uint8Array(row.epoch_data));
    return {
      epoch,
      signature: new Uint8Array(row.signature),
      hash: new Uint8Array(row.hash),
    };
  }
}
