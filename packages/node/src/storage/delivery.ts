import type Database from 'better-sqlite3';

export interface OutboxRecord {
  id: string; peer_public_key: Buffer; group_id: Buffer | null;
  content: string; content_hash: string; created_at: number; expires_at: number;
  group_epoch_version: number | null;
  attempts: number; next_attempt_at: number; packet: Buffer | null;
  status: 'queued' | 'delivered' | 'failed'; error: string | null;
}
export const MAX_OUTBOX_ROWS = 1000;
export const MAX_OUTBOX_BYTES = 64 * 1024 * 1024;
export const MAX_INBOX_ROWS = 100_000;

export class DeliveryRepository {
  constructor(private db: Database.Database) {}
  transaction<T>(fn: () => T): T { return this.db.transaction(fn)(); }
  enqueue(rows: Array<Pick<OutboxRecord, 'id' | 'peer_public_key' | 'group_id' | 'content' | 'content_hash' | 'created_at' | 'expires_at' | 'group_epoch_version'>>): void {
    this.prune();
    const current = this.db.prepare("SELECT COUNT(*) count, COALESCE(SUM(length(CAST(content AS BLOB))*2 + 4096),0) bytes FROM delivery_outbox WHERE status='queued'")
      .get() as { count: number; bytes: number };
    // Reserve room for ciphertext/envelope in addition to queued plaintext.
    if (current.count + rows.length > MAX_OUTBOX_ROWS || current.bytes + rows.reduce((sum, row) => sum + Buffer.byteLength(row.content) * 2 + 4096, 0) > MAX_OUTBOX_BYTES) {
      throw new Error('Delivery outbox is full');
    }
    const insert = this.db.prepare('INSERT INTO delivery_outbox(id,peer_public_key,group_id,content,content_hash,created_at,expires_at,group_epoch_version) VALUES (?,?,?,?,?,?,?,?)');
    for (const row of rows) insert.run(row.id, row.peer_public_key, row.group_id, row.content, row.content_hash, row.created_at, row.expires_at, row.group_epoch_version);
  }
  heads(now = Date.now()): OutboxRecord[] {
    this.prune(now);
    const rows = this.db.prepare("SELECT * FROM delivery_outbox WHERE status='queued' ORDER BY created_at, rowid").all() as OutboxRecord[];
    const seen = new Set<string>();
    return rows.filter(row => {
      const peer = row.peer_public_key.toString('hex');
      if (seen.has(peer)) return false;
      seen.add(peer);
      return row.next_attempt_at <= now;
    });
  }
  attempt(row: OutboxRecord, packet: Uint8Array): void {
    const delay = Math.min(60_000, 2000 * 2 ** Math.min(row.attempts, 5));
    this.db.prepare("UPDATE delivery_outbox SET packet=?,attempts=attempts+1,next_attempt_at=?,error=NULL WHERE id=? AND peer_public_key=? AND status='queued'")
      .run(Buffer.from(packet), Date.now() + delay, row.id, row.peer_public_key);
  }
  reconnect(peer: Uint8Array): void {
    this.db.prepare("UPDATE delivery_outbox SET next_attempt_at=0 WHERE peer_public_key=? AND status='queued'").run(Buffer.from(peer));
  }
  fail(row: OutboxRecord, error: string): void {
    this.db.prepare("UPDATE delivery_outbox SET status='failed',error=?,packet=NULL,content='' WHERE id=? AND peer_public_key=?")
      .run(error, row.id, row.peer_public_key);
  }
  defer(row: OutboxRecord, error: string): void {
    this.db.prepare("UPDATE delivery_outbox SET next_attempt_at=?,error=? WHERE id=? AND peer_public_key=? AND status='queued'")
      .run(Date.now() + 5000, error.slice(0, 256), row.id, row.peer_public_key);
  }
  delivered(id: string, peer: Uint8Array): boolean {
    return this.db.prepare("UPDATE delivery_outbox SET status='delivered',packet=NULL,error=NULL,content='' WHERE id=? AND peer_public_key=? AND status='queued' AND attempts>0")
      .run(id, Buffer.from(peer)).changes === 1;
  }
  received(sender: string, id: string, hash: string): boolean {
    const row = this.db.prepare('SELECT content_hash FROM delivery_inbox WHERE sender_fingerprint=? AND id=?').get(sender, id) as { content_hash: string } | undefined;
    if (row && row.content_hash !== hash) throw new Error('Delivery ID reused for different content');
    return !!row;
  }
  accept(sender: string, id: string, hash: string, expiresAt: number): void {
    this.db.prepare('DELETE FROM delivery_inbox WHERE expires_at < ?').run(Date.now());
    const count = this.db.prepare('SELECT COUNT(*) count FROM delivery_inbox').get() as { count: number };
    if (count.count >= MAX_INBOX_ROWS) throw new Error('Delivery receipt ledger is full');
    this.db.prepare('INSERT INTO delivery_inbox(sender_fingerprint,id,content_hash,expires_at) VALUES (?,?,?,?)').run(sender, id, hash, expiresAt);
  }
  list(id?: string): Array<{ id: string; peerPublicKey: string; status: string; attempts: number; error: string | null }> {
    this.prune();
    const rows = id ? this.db.prepare('SELECT * FROM delivery_outbox WHERE id=?').all(id)
      : this.db.prepare('SELECT * FROM delivery_outbox ORDER BY created_at DESC LIMIT 1000').all();
    return (rows as OutboxRecord[]).map(row => ({ id: row.id, peerPublicKey: row.peer_public_key.toString('hex'), status: row.status, attempts: row.attempts, error: row.error }));
  }
  private prune(now = Date.now()): void {
    this.db.prepare("UPDATE delivery_outbox SET status='failed',error='Delivery expired or retry limit reached',packet=NULL,content='' WHERE status='queued' AND (expires_at <= ? OR attempts>=1000)").run(now);
    this.db.prepare("DELETE FROM delivery_outbox WHERE status!='queued' AND rowid NOT IN (SELECT rowid FROM delivery_outbox WHERE status!='queued' ORDER BY created_at DESC LIMIT 1000)").run();
    this.db.prepare('DELETE FROM delivery_inbox WHERE expires_at < ?').run(now);
  }
}
