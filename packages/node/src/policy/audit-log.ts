import type { PolicyAuditEntry } from '@networkselfmd/core';

export interface PolicyAuditLogOptions {
  // Maximum number of entries to retain. Older entries are dropped FIFO.
  // Default: 1000.
  max?: number;
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

  constructor(options: PolicyAuditLogOptions = {}) {
    this.max = Math.max(1, options.max ?? 1000);
  }

  // Append an entry. The log stores an independent, deeply-frozen copy:
  // mutating the input after record() does not corrupt the stored row,
  // and callers that read entries back via recent() cannot mutate them.
  // Audit integrity must not depend on caller discipline.
  record(entry: PolicyAuditEntry): PolicyAuditEntry {
    const stored = freezeAuditEntry(cloneAuditEntry(entry));
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
