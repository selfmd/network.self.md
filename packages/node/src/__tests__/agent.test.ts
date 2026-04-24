import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock external modules that won't be available in test
vi.mock('hyperswarm', () => {
  return {
    default: class MockHyperswarm {
      on() {}
      join() {
        return { flushed: () => Promise.resolve() };
      }
      leave() {
        return Promise.resolve();
      }
      destroy() {
        return Promise.resolve();
      }
    },
  };
});

vi.mock('hyperdht', () => {
  return {
    default: class MockHyperDHT {},
  };
});

import { Agent } from '../agent.js';

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'nsmd-agent-test-'));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('Agent', () => {
  it('should create an agent instance', () => {
    const agent = new Agent({ dataDir });
    expect(agent).toBeDefined();
    expect(agent.isRunning).toBe(false);
  });

  it('should start and stop', async () => {
    const agent = new Agent({
      dataDir,
      displayName: 'TestBot',
    });

    await agent.start();
    expect(agent.isRunning).toBe(true);
    expect(agent.identity).toBeDefined();
    expect(agent.identity.displayName).toBe('TestBot');
    expect(agent.identity.fingerprint).toBeDefined();

    await agent.stop();
    expect(agent.isRunning).toBe(false);
  });

  it('should persist and reload identity', async () => {
    // First run
    const agent1 = new Agent({
      dataDir,
      displayName: 'PersistBot',
    });
    await agent1.start();
    const fingerprint = agent1.identity.fingerprint;
    await agent1.stop();

    // Second run
    const agent2 = new Agent({ dataDir });
    await agent2.start();
    expect(agent2.identity.fingerprint).toBe(fingerprint);
    await agent2.stop();
  });

  it('should create a group', async () => {
    const agent = new Agent({
      dataDir,
      displayName: 'GroupBot',
    });
    await agent.start();

    const group = await agent.createGroup('Test Group');
    expect(group).toBeDefined();
    expect(group.name).toBe('Test Group');
    expect(group.role).toBe('admin');
    expect(group.groupId).toBeInstanceOf(Uint8Array);

    const groups = agent.listGroups();
    expect(groups.length).toBe(1);
    expect(groups[0].name).toBe('Test Group');

    await agent.stop();
  });

  it('should list peers (empty initially)', async () => {
    const agent = new Agent({ dataDir });
    await agent.start();

    const peers = agent.listPeers();
    expect(peers).toEqual([]);

    await agent.stop();
  });

  it('should query messages (empty initially)', async () => {
    const agent = new Agent({ dataDir });
    await agent.start();

    const messages = agent.getMessages({});
    expect(messages).toEqual([]);

    await agent.stop();
  });

  it('should not start twice', async () => {
    const agent = new Agent({ dataDir });
    await agent.start();
    await agent.start(); // should be no-op
    expect(agent.isRunning).toBe(true);
    await agent.stop();
  });

  it('should not stop when not running', async () => {
    const agent = new Agent({ dataDir });
    await agent.stop(); // should be no-op
    expect(agent.isRunning).toBe(false);
  });

  it('should get group members after creating group', async () => {
    const agent = new Agent({
      dataDir,
      displayName: 'MemberBot',
    });
    await agent.start();

    const group = await agent.createGroup('Members Test');
    const groupIdHex = Buffer.from(group.groupId).toString('hex');
    const members = agent.getGroupMembers(groupIdHex);

    expect(members.length).toBe(1);
    expect(members[0].role).toBe('admin');

    await agent.stop();
  });

  it('should leave a group', async () => {
    const agent = new Agent({ dataDir });
    await agent.start();

    const group = await agent.createGroup('Leave Test');
    const groupIdHex = Buffer.from(group.groupId).toString('hex');

    expect(agent.listGroups().length).toBe(1);

    await agent.leaveGroup(groupIdHex);
    expect(agent.listGroups().length).toBe(0);

    await agent.stop();
  });

  describe('passphrase-protected identity', () => {
    it('round-trips identity and derives matching X25519 keys', async () => {
      const passphrase = 'correct horse battery staple';

      const a1 = new Agent({ dataDir, passphrase, displayName: 'Vault' });
      await a1.start();
      const fp1 = a1.identity.fingerprint;
      const edPriv1 = Buffer.from(a1.identity.edPrivateKey).toString('hex');
      const xPriv1 = Buffer.from(a1.identity.xPrivateKey).toString('hex');
      const xPub1 = Buffer.from(a1.identity.xPublicKey).toString('hex');
      await a1.stop();

      // Reload with the same passphrase — identity must match bit-for-bit.
      const a2 = new Agent({ dataDir, passphrase });
      await a2.start();
      expect(a2.identity.fingerprint).toBe(fp1);
      expect(Buffer.from(a2.identity.edPrivateKey).toString('hex')).toBe(edPriv1);
      // X25519 keys must be recomputed via edwardsToMontgomery, not a
      // placeholder HKDF — so the hex must match the first run exactly.
      expect(Buffer.from(a2.identity.xPrivateKey).toString('hex')).toBe(xPriv1);
      expect(Buffer.from(a2.identity.xPublicKey).toString('hex')).toBe(xPub1);
      await a2.stop();
    });

    it('does not persist the raw Ed25519 private key in the identity table when a passphrase is set', async () => {
      const agent = new Agent({ dataDir, passphrase: 'test-passphrase' });
      await agent.start();
      await agent.stop();

      // Re-open the SQLite file directly (not through the repository) to
      // verify the ed_private_key column is empty when passphrase-protected.
      const { default: Database } = await import('better-sqlite3');
      const db = new Database(join(dataDir, 'agent.db'));
      try {
        const row = db
          .prepare('SELECT ed_private_key, LENGTH(ed_private_key) AS len FROM identity WHERE id = 1')
          .get() as { ed_private_key: Buffer; len: number };
        expect(row).toBeDefined();
        expect(row.len).toBe(0);
        // The encrypted copy must be present.
        const encrypted = db
          .prepare('SELECT LENGTH(ciphertext) AS len FROM key_storage WHERE id = 1')
          .get() as { len: number };
        expect(encrypted.len).toBeGreaterThan(0);
      } finally {
        db.close();
      }
    });
  });

  describe('direct messages', () => {
    it('explicitly fails with a NotImplemented-style error', async () => {
      const agent = new Agent({ dataDir });
      await agent.start();

      await expect(
        agent.sendDirectMessage('00'.repeat(32), 'hello'),
      ).rejects.toThrow(/not yet implemented/i);

      await agent.stop();
    });
  });
});
