import type Database from 'better-sqlite3';
import type {
  PolicyConfig,
  PolicyAuditEntry,
  PolicyAction,
  PolicyReason,
  InboundMessageKind,
} from '@networkselfmd/core';
import { POLICY_REASONS } from '@networkselfmd/core';

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
