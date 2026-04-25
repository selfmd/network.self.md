import type Database from 'better-sqlite3';
import type {
  PolicyConfig,
  PolicyAuditEntry,
  PolicyAction,
  PolicyReason,
  InboundMessageKind,
} from '@networkselfmd/core';
import { POLICY_REASONS } from '@networkselfmd/core';

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

export interface StoredPolicyAuditRow {
  audit_id: string;
  received_at: number;
  inserted_at: number;
  event_kind: string;
  message_id: string | null;
  group_id_hex: string | null;
  sender_fingerprint: string | null;
  byte_length: number;
  action: string;
  reason: string;
  addressed_to_me: number;
  sender_trusted: number;
  matched_interests: string;
  gate_rejected: number;
  allowed: number;
}

// Bounds + clamps for the durable audit. Frozen so the constants cannot
// be mutated at runtime by buggy or hostile code.
export const POLICY_AUDIT_LIMITS = Object.freeze({
  // Default ring size for the persisted log. Larger than the in-memory
  // bound (1000) because durability is the whole point — operators want
  // to see decisions across restarts and a few hours of activity.
  defaultMaxEntries: 5000,
  // Hard cap on a single recent() / MCP / CLI fetch. Matches the existing
  // MCP audit cap from PR #4 polish.
  maxRecentLimit: 1000,
});

export interface PolicyAuditRepositoryOptions {
  // Maximum number of rows retained on disk. Defaults to
  // POLICY_AUDIT_LIMITS.defaultMaxEntries. Prune-on-insert evicts the
  // oldest rows when a new insert would push the table over the cap.
  maxEntries?: number;
}

export interface PolicyAuditRecentOptions {
  // Page size; clamped to POLICY_AUDIT_LIMITS.maxRecentLimit.
  limit?: number;
  // Page backward by inserted_at strictly less than this timestamp.
  before?: number;
}

export interface PolicyAuditPruneOptions {
  // Override the per-call retention cap. Defaults to the repository's
  // configured maxEntries.
  maxEntries?: number;
  // If set, also delete rows older than (now - olderThanMs).
  olderThanMs?: number;
}

// Owner-local, metadata-only audit log persisted in SQLite.
//
// Privacy: writes via explicit field projection (no Object.assign /
// spread of arbitrary entry data). The schema has no column for
// plaintext, content, body, payload, tool_args, or private_key
// material — a column-set test pins this. Reads reconstruct the typed
// PolicyAuditEntry the same way, so a corrupt matched_interests JSON
// degrades to [] rather than throwing through to public surfaces.
//
// The repository is the durable source of truth for operator reads
// (MCP, CLI, future dashboards). PolicyAuditLog (the in-memory ring)
// stays as a runtime convenience and event-emission conduit; it is
// not the cross-restart surface.
export class PolicyAuditRepository {
  private maxEntries: number;
  private insertStmt: Database.Statement;
  private deleteOldestStmt: Database.Statement;

  constructor(private db: Database.Database, opts: PolicyAuditRepositoryOptions = {}) {
    this.maxEntries = Math.max(1, opts.maxEntries ?? POLICY_AUDIT_LIMITS.defaultMaxEntries);
    // Prepare hot-path statements once. INSERT OR REPLACE is defensive
    // against an auditId collision (which createId makes vanishingly
    // unlikely, but the row PK is intentional).
    this.insertStmt = this.db.prepare(
      `INSERT OR REPLACE INTO policy_audit (
        audit_id, received_at, inserted_at, event_kind, message_id,
        group_id_hex, sender_fingerprint, byte_length, action, reason,
        addressed_to_me, sender_trusted, matched_interests, gate_rejected, allowed
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.deleteOldestStmt = this.db.prepare(
      `DELETE FROM policy_audit WHERE audit_id IN (
        SELECT audit_id FROM policy_audit ORDER BY inserted_at ASC, audit_id ASC LIMIT ?
      )`,
    );
  }

  insert(entry: PolicyAuditEntry): void {
    // Explicit projection — never spread the entry. New fields on
    // PolicyAuditEntry will not auto-flow into the schema; adding a
    // column requires a deliberate migration + change here.
    //
    // `allowed` is a DB-only derived column for analytics queries
    // (e.g. `SELECT COUNT(*) FROM policy_audit WHERE allowed = 1`).
    // It is intentionally NOT part of PolicyAuditEntry, the MCP DTO,
    // or CLI output — the public vocabulary stays `action` +
    // `gateRejected`, which together are sufficient to derive
    // allowed-ness without expanding the operator-facing surface.
    const insertedAt = Date.now();
    const allowed = entry.action !== 'ignore' && !entry.gateRejected ? 1 : 0;
    this.insertStmt.run(
      entry.auditId,
      entry.receivedAt,
      insertedAt,
      entry.eventKind,
      entry.messageId ?? null,
      entry.groupIdHex ?? null,
      entry.senderFingerprint ?? null,
      entry.byteLength,
      entry.action,
      entry.reason,
      entry.addressedToMe ? 1 : 0,
      entry.senderTrusted ? 1 : 0,
      JSON.stringify(entry.matchedInterests ?? []),
      entry.gateRejected ? 1 : 0,
      allowed,
    );
    // Prune-on-insert. Cheap (one COUNT + at most one DELETE).
    const surplus = this.count() - this.maxEntries;
    if (surplus > 0) this.deleteOldestStmt.run(surplus);
  }

  recent(opts: PolicyAuditRecentOptions = {}): PolicyAuditEntry[] {
    const limit = clampLimit(opts.limit ?? 50);
    let rows: StoredPolicyAuditRow[];
    if (opts.before !== undefined) {
      rows = this.db
        .prepare(
          `SELECT * FROM policy_audit
           WHERE inserted_at < ?
           ORDER BY inserted_at DESC, audit_id DESC
           LIMIT ?`,
        )
        .all(opts.before, limit) as StoredPolicyAuditRow[];
    } else {
      rows = this.db
        .prepare(
          `SELECT * FROM policy_audit
           ORDER BY inserted_at DESC, audit_id DESC
           LIMIT ?`,
        )
        .all(limit) as StoredPolicyAuditRow[];
    }
    return rows.map(rowToEntry);
  }

  prune(opts: PolicyAuditPruneOptions = {}): number {
    let deleted = 0;
    if (opts.olderThanMs !== undefined) {
      const cutoff = Date.now() - Math.max(0, opts.olderThanMs);
      const result = this.db
        .prepare(`DELETE FROM policy_audit WHERE inserted_at < ?`)
        .run(cutoff);
      deleted += result.changes;
    }
    const cap = Math.max(1, opts.maxEntries ?? this.maxEntries);
    const surplus = this.count() - cap;
    if (surplus > 0) {
      const result = this.deleteOldestStmt.run(surplus);
      deleted += result.changes;
    }
    return deleted;
  }

  count(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM policy_audit`)
      .get() as { n: number };
    return row.n;
  }

  clear(): void {
    this.db.prepare(`DELETE FROM policy_audit`).run();
  }
}

function clampLimit(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(Math.floor(n), POLICY_AUDIT_LIMITS.maxRecentLimit);
}

const VALID_KINDS: ReadonlySet<InboundMessageKind | 'unknown'> = new Set([
  'group',
  'dm',
  'unknown',
]);
const VALID_ACTIONS: ReadonlySet<PolicyAction> = new Set(['act', 'ask', 'ignore']);
const VALID_REASONS: ReadonlySet<PolicyReason> = new Set(POLICY_REASONS);

// Fail-closed stub returned for any row whose enum / boolean / numeric
// fields are out of spec. Preserves auditId + receivedAt so operators
// can correlate with the underlying corrupt row, and forces every
// other public field into a safe metadata-only state. The reason token
// `malformed-event` is the same one the gate uses for structurally
// invalid inbound events; reusing it here keeps the public vocabulary
// stable.
function corruptStub(row: StoredPolicyAuditRow): PolicyAuditEntry {
  return {
    auditId:
      typeof row.audit_id === 'string' && row.audit_id.length > 0
        ? row.audit_id
        : 'corrupt',
    receivedAt: Number.isFinite(row.received_at) ? row.received_at : 0,
    eventKind: 'unknown',
    messageId: undefined,
    groupIdHex: undefined,
    senderFingerprint: undefined,
    byteLength: 0,
    action: 'ignore',
    reason: 'malformed-event',
    addressedToMe: false,
    senderTrusted: false,
    matchedInterests: [],
    gateRejected: true,
  };
}

function isValidBoolInt(n: unknown): boolean {
  return n === 0 || n === 1;
}

function isNonNegativeFiniteInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && Number.isInteger(n) && n >= 0;
}

// Reconstruct a typed entry via explicit field-by-field projection AND
// validate every enum / boolean / numeric field. Corrupt rows are
// mapped to a fail-closed metadata-only stub (eventKind=unknown,
// action=ignore, reason=malformed-event, gateRejected=true) — a
// corrupt row never surfaces as if it were a normal allowed/blocked
// decision. matched_interests JSON is already defensively parsed by
// parseStringArray; corrupt JSON degrades to [] without throwing.
function rowToEntry(row: StoredPolicyAuditRow): PolicyAuditEntry {
  const eventKind = VALID_KINDS.has(row.event_kind as InboundMessageKind | 'unknown')
    ? (row.event_kind as PolicyAuditEntry['eventKind'])
    : null;
  const action = VALID_ACTIONS.has(row.action as PolicyAction)
    ? (row.action as PolicyAction)
    : null;
  const reason = VALID_REASONS.has(row.reason as PolicyReason)
    ? (row.reason as PolicyReason)
    : null;

  if (
    eventKind === null ||
    action === null ||
    reason === null ||
    !isValidBoolInt(row.addressed_to_me) ||
    !isValidBoolInt(row.sender_trusted) ||
    !isValidBoolInt(row.gate_rejected) ||
    !isNonNegativeFiniteInt(row.byte_length)
  ) {
    return corruptStub(row);
  }

  return {
    auditId: row.audit_id,
    receivedAt: row.received_at,
    eventKind,
    messageId: row.message_id ?? undefined,
    groupIdHex: row.group_id_hex ?? undefined,
    senderFingerprint: row.sender_fingerprint ?? undefined,
    byteLength: row.byte_length,
    action,
    reason,
    addressedToMe: row.addressed_to_me === 1,
    senderTrusted: row.sender_trusted === 1,
    matchedInterests: parseStringArray(row.matched_interests),
    gateRejected: row.gate_rejected === 1,
  };
}
