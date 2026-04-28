import type Database from 'better-sqlite3';
import type { DoubleRatchetState } from '@networkselfmd/core';

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

  create(groupId: Uint8Array, name: string, role: string = 'admin'): void {
    const now = Date.now();
    const stmt = this.db.prepare(
      `INSERT INTO groups (group_id, name, role, created_at, joined_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    stmt.run(Buffer.from(groupId), name, role, now, now);
  }

  join(groupId: Uint8Array, name: string, role: string = 'member'): void {
    const now = Date.now();
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO groups (group_id, name, role, created_at, joined_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    stmt.run(Buffer.from(groupId), name, role, now, now);
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
}

export class DiscoveredGroupRepository {
  constructor(private db: Database.Database) {}

  upsert(
    groupId: Uint8Array,
    name: string,
    selfMd: string | undefined,
    memberCount: number,
    announcedBy: Uint8Array,
  ): void {
    const stmt = this.db.prepare(
      `INSERT INTO discovered_groups (group_id, name, self_md, member_count, announced_by, last_announced)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(group_id) DO UPDATE SET
         name = excluded.name,
         self_md = COALESCE(excluded.self_md, discovered_groups.self_md),
         member_count = excluded.member_count,
         announced_by = excluded.announced_by,
         last_announced = excluded.last_announced`,
    );
    stmt.run(Buffer.from(groupId), name, selfMd ?? null, memberCount, Buffer.from(announcedBy), Date.now());
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
}

export class SenderKeyRepository {
  constructor(private db: Database.Database) {}

  store(
    groupId: Uint8Array,
    publicKey: Uint8Array,
    chainKey: Uint8Array,
    chainIndex: number,
  ): void {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO sender_keys (group_id, public_key, chain_key, chain_index)
       VALUES (?, ?, ?, ?)`,
    );
    stmt.run(Buffer.from(groupId), Buffer.from(publicKey), Buffer.from(chainKey), chainIndex);
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
