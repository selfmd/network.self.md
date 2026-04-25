import type { PolicyAuditEntry } from '@networkselfmd/core';

export interface PolicyAuditLogOptions {
  // Maximum number of entries to retain. Older entries are dropped FIFO.
  // Default: 1000.
  max?: number;
  // Optional synchronous persistence callback. Called inside record()
  // BEFORE the in-memory ring is mutated. If it throws, record() throws
  // and the in-memory log is unchanged — that propagation is the
  // mechanism that preserves the gate's retry-poison invariant: the
  // gate's evaluate() will throw, markDedup() never runs, and a
  // legitimate retry of the same messageId is re-evaluated.
  persist?: (entry: PolicyAuditEntry) => void;
}

// Bounded in-memory ring buffer of policy decisions. Privacy: every
// PolicyAuditEntry is metadata-only by construction (see audit.ts). The
// audit log itself adds no content fields.
//
// This is intentionally non-persistent. Durability would require a SQLite
// migration; that lives in a follow-up PR. The in-memory log is enough
// for live debug, MCP recent-N reads, and post-mortem within a single
// process lifetime.
export class PolicyAuditLog {
  private buf: PolicyAuditEntry[] = [];
  private max: number;
  private persist?: (entry: PolicyAuditEntry) => void;

  constructor(options: PolicyAuditLogOptions = {}) {
    this.max = Math.max(1, options.max ?? 1000);
    this.persist = options.persist;
  }

  // Append an entry. The log stores an independent, deeply-frozen copy:
  // mutating the input after record() does not corrupt the stored row,
  // and callers that read entries back via recent() cannot mutate them.
  // Audit integrity must not depend on caller discipline.
  //
  // Order of operations: persist FIRST, then push to the in-memory ring.
  // A throw from persist propagates with the in-memory log unchanged —
  // exactly the contract the gate's retry-poison invariant relies on.
  record(entry: PolicyAuditEntry): PolicyAuditEntry {
    const stored = freezeAuditEntry(cloneAuditEntry(entry));
    if (this.persist) this.persist(stored);
    this.buf.push(stored);
    if (this.buf.length > this.max) {
      this.buf.splice(0, this.buf.length - this.max);
    }
    return stored;
  }

  // Most recent N entries, newest last. Returns a copy.
  recent(limit?: number): PolicyAuditEntry[] {
    if (limit === undefined || limit >= this.buf.length) return this.buf.slice();
    return this.buf.slice(this.buf.length - limit);
  }

  size(): number {
    return this.buf.length;
  }

  clear(): void {
    this.buf = [];
  }
}

// Deep clone the whole entry. structuredClone is available in Node ≥17;
// the fields on PolicyAuditEntry are all structured-clone safe (strings,
// numbers, booleans, optional strings, string[]). New non-cloneable
// field types added later should fail at record() time, which is the
// loud-failure we want.
function cloneAuditEntry(entry: PolicyAuditEntry): PolicyAuditEntry {
  return structuredClone(entry);
}

// Freeze the entry and any contained array reference so callers cannot
// mutate the audit trail through a returned reference. Strict mode
// (which TypeScript-emitted ESM runs in) throws on assignment to a
// frozen property, surfacing accidental writes loudly during
// development.
function freezeAuditEntry(entry: PolicyAuditEntry): PolicyAuditEntry {
  Object.freeze(entry.matchedInterests);
  return Object.freeze(entry);
}
