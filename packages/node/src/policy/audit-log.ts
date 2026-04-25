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

  // Append an entry. Returns the entry as recorded (callers can use the
  // returned reference but must NOT mutate it; the log holds a reference
  // to the same object).
  record(entry: PolicyAuditEntry): PolicyAuditEntry {
    this.buf.push(entry);
    if (this.buf.length > this.max) {
      this.buf.splice(0, this.buf.length - this.max);
    }
    return entry;
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
