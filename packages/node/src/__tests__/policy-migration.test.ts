import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { AgentDatabase, PolicyConfigRepository, PolicyAuditRepository } from '../storage/index.js';
import { legacyPolicyMigrations } from './fixtures/legacy-policy-schema.js';

describe('policy migration to the current transport schema', () => {
  for (const version of [2, 3, 9]) {
    it(`upgrades schema ${version} without losing policy config or audit`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'nsmd-policy-migration-'));
      const database = new AgentDatabase(dir);
      try {
        const db = database.getDb();
        if (version < 9) {
          for (const migration of legacyPolicyMigrations.slice(0, version)) db.exec(migration);
          new PolicyConfigRepository(db).save({ interests: ['keep-me'], requireMention: false });
          if (version === 3) new PolicyAuditRepository(db).insert({ auditId: 'retained', receivedAt: 1,
            eventKind: 'dm', messageId: 'old', senderFingerprint: 'abc', byteLength: 3,
            action: 'ask', reason: 'addressed-unknown-sender', addressedToMe: true,
            senderTrusted: false, matchedInterests: [], gateRejected: false });
        } else {
          database.migrate();
          db.exec('DROP TABLE policy_config; DROP TABLE policy_audit; UPDATE schema_version SET version = 9');
        }
        db.prepare("INSERT INTO messages (id, content, timestamp, type) VALUES ('preserved', 'owner-private history', 1, 'direct')").run();
        database.migrate(); database.migrate();
        expect(db.prepare('SELECT version FROM schema_version').get()).toEqual({ version: 10 });
        if (version < 9) expect(new PolicyConfigRepository(db).load()).toEqual({ interests: ['keep-me'], requireMention: false });
        expect(new PolicyAuditRepository(db).count()).toBe(version === 3 ? 1 : 0);
        expect(db.prepare("SELECT content FROM messages WHERE id = 'preserved'").get()).toEqual({ content: 'owner-private history' });
        for (const table of ['dm_ratchet_states', 'discovered_groups', 'delivery_inbox', 'policy_config', 'policy_audit']) {
          expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)).toEqual({ name: table });
        }
      } finally { database.close(); rmSync(dir, { recursive: true, force: true }); }
    });
  }
});
