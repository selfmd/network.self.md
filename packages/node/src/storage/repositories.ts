import type Database from 'better-sqlite3';
import type { PolicyConfig } from '@networkselfmd/core';

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

  /**
   * Persist the identity row. When `passphraseProtected` is true we store a
   * zero-length placeholder in place of the raw private key; the encrypted
   * copy lives in `key_storage` and is the authoritative source. This closes
   * the "plaintext private key on disk alongside the encrypted copy" leak.
   */
  save(
    edPrivateKey: Uint8Array,
    edPublicKey: Uint8Array,
    displayName?: string,
    passphraseProtected: boolean = false,
  ): void {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO identity (id, ed_private_key, ed_public_key, display_name, created_at)
       VALUES (1, ?, ?, ?, ?)`,
    );
    const storedPrivate = passphraseProtected
      ? Buffer.alloc(0)
      : Buffer.from(edPrivateKey);
    stmt.run(
      storedPrivate,
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

export interface StoredPolicyConfig {
  id: number;
  trusted_fingerprints: string | null;
  interests: string | null;
  require_mention: number | null;
  mention_prefix_len: number | null;
  updated_at: number;
}

// Owner-local policy configuration. Single-row table (id=1). NULL
// columns mean "field unset" — load() returns undefined for those so
// AgentPolicy's existing defaults apply unchanged.
//
// Privacy: this repo persists ONLY operator-supplied policy
// configuration (trusted fingerprints, interest keywords, mention
// behavior). It does NOT store message plaintext, decrypted bodies,
// raw event payloads, or any private key material — by design and by
// schema (no such columns exist on policy_config).
export class PolicyConfigRepository {
  constructor(private db: Database.Database) {}

  load(): PolicyConfig | undefined {
    const row = this.db
      .prepare('SELECT * FROM policy_config WHERE id = 1')
      .get() as StoredPolicyConfig | undefined;
    if (!row) return undefined;
    const config: PolicyConfig = {};
    if (row.trusted_fingerprints !== null) {
      config.trustedFingerprints = parseStringArray(row.trusted_fingerprints);
    }
    if (row.interests !== null) {
      config.interests = parseStringArray(row.interests);
    }
    if (row.require_mention !== null) {
      config.requireMention = row.require_mention === 1;
    }
    if (row.mention_prefix_len !== null) {
      config.mentionPrefixLen = row.mention_prefix_len;
    }
    return config;
  }

  save(config: PolicyConfig): void {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO policy_config
       (id, trusted_fingerprints, interests, require_mention, mention_prefix_len, updated_at)
       VALUES (1, ?, ?, ?, ?, ?)`,
    );
    stmt.run(
      config.trustedFingerprints !== undefined
        ? JSON.stringify(config.trustedFingerprints)
        : null,
      config.interests !== undefined ? JSON.stringify(config.interests) : null,
      config.requireMention === undefined ? null : config.requireMention ? 1 : 0,
      config.mentionPrefixLen ?? null,
      Date.now(),
    );
  }

  exists(): boolean {
    const row = this.db
      .prepare('SELECT 1 AS x FROM policy_config WHERE id = 1')
      .get() as { x: number } | undefined;
    return row !== undefined;
  }

  clear(): void {
    this.db.prepare('DELETE FROM policy_config WHERE id = 1').run();
  }
}

function parseStringArray(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    // Corrupt row — return empty rather than throwing during load.
    // setPolicyConfig will overwrite on next operator action.
    return [];
  }
}
