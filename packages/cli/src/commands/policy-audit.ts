import os from 'node:os';
import path from 'node:path';
import chalk from 'chalk';
import {
  AgentDatabase,
  PolicyAuditRepository,
  POLICY_AUDIT_LIMITS,
} from '@networkselfmd/node';
import type { PolicyAuditEntry } from '@networkselfmd/node';

// ---------------------------------------------------------------------------
// CLI policy-audit commands are owner-private, local-only operator
// controls. They MUST NOT instantiate Agent / start the swarm / rejoin
// groups / join the TTYA topic. The promise to the operator is "this
// just reads or trims a row in your local SQLite", and that is exactly
// what these handlers do — they go straight to AgentDatabase +
// PolicyAuditRepository with no network in sight.
//
// Output is metadata-only: only the columns of PolicyAuditEntry are
// printed. There is no plaintext / ciphertext / decrypted body / raw
// event payload exposed by these commands.
// ---------------------------------------------------------------------------

function getDataDir(): string {
  return process.env.L2S_DATA_DIR || path.join(os.homedir(), '.networkselfmd');
}

function withRepo<T>(fn: (repo: PolicyAuditRepository) => T): T {
  const db = new AgentDatabase(getDataDir());
  db.migrate();
  try {
    return fn(new PolicyAuditRepository(db.getDb()));
  } finally {
    db.close();
  }
}

function fail(msg: string): never {
  console.error(chalk.red(msg));
  process.exit(1);
}

function parseInteger(raw: string | undefined, field: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n)) fail(`--${field} must be an integer (got "${raw}")`);
  return n;
}

function clampLimit(raw: number | undefined): number {
  if (raw === undefined) return 50;
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  return Math.min(Math.floor(raw), POLICY_AUDIT_LIMITS.maxRecentLimit);
}

function formatTime(ms: number): string {
  return new Date(ms).toISOString();
}

function actionStyle(action: string): string {
  if (action === 'act') return chalk.green(action);
  if (action === 'ask') return chalk.yellow(action);
  return chalk.dim(action);
}

function printEntries(entries: PolicyAuditEntry[]): void {
  console.log(chalk.bold('\nPolicy audit (newest first)\n'));
  if (entries.length === 0) {
    console.log(chalk.dim('  (none)\n'));
    return;
  }
  for (const e of entries) {
    const blocked = e.gateRejected ? chalk.red('blocked') : chalk.dim('passed');
    console.log(
      `  ${chalk.dim(formatTime(e.receivedAt))}  ${actionStyle(e.action)}  ` +
        `${chalk.cyan(e.reason)}  ${blocked}`,
    );
    const meta: string[] = [];
    meta.push(`kind=${e.eventKind}`);
    if (e.messageId) meta.push(`messageId=${e.messageId}`);
    if (e.groupIdHex) meta.push(`groupId=${e.groupIdHex.slice(0, 12)}…`);
    if (e.senderFingerprint) meta.push(`from=${e.senderFingerprint.slice(0, 12)}…`);
    meta.push(`bytes=${e.byteLength}`);
    if (e.matchedInterests.length > 0) meta.push(`matched=${e.matchedInterests.join(',')}`);
    console.log(`    ${chalk.dim(meta.join('  '))}`);
  }
  console.log();
}

export interface PolicyAuditRecentOpts {
  limit?: string;
}

export async function policyAuditRecent(opts: PolicyAuditRecentOpts = {}): Promise<void> {
  const rawLimit = parseInteger(opts.limit, 'limit');
  const limit = clampLimit(rawLimit);
  const entries = withRepo((repo) => repo.recent({ limit }));
  printEntries(entries);
}

export interface PolicyAuditPruneOpts {
  maxEntries?: string;
  olderThanMs?: string;
}

export async function policyAuditPrune(opts: PolicyAuditPruneOpts = {}): Promise<void> {
  const maxEntries = parseInteger(opts.maxEntries, 'max-entries');
  const olderThanMs = parseInteger(opts.olderThanMs, 'older-than-ms');
  if (maxEntries === undefined && olderThanMs === undefined) {
    fail('Pass at least one of --max-entries <N> or --older-than-ms <N>.');
  }
  if (maxEntries !== undefined && (maxEntries < 1 || maxEntries > POLICY_AUDIT_LIMITS.defaultMaxEntries * 100)) {
    fail(`--max-entries out of range`);
  }
  const removed = withRepo((repo) => repo.prune({
    maxEntries: maxEntries ?? undefined,
    olderThanMs: olderThanMs ?? undefined,
  }));
  console.log(chalk.green(`\nPruned ${removed} row(s) from policy_audit.\n`));
}

export async function policyAuditClear(): Promise<void> {
  withRepo((repo) => repo.clear());
  console.log(chalk.yellow('\nCleared policy_audit (all rows removed).\n'));
}
