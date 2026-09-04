import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { argon2id } from 'hash-wasm';
import { SENDER_KEY_CAPABILITY, encrypt } from '@networkselfmd/core';
import { secretFileProvider } from '../secrets.js';

const mockSwarmState = vi.hoisted(() => ({
  instances: [] as Array<{ joins: Array<{ options: unknown }> }>,
}));

// Mock external modules that won't be available in test
vi.mock('hyperswarm', () => {
  return {
    default: class MockHyperswarm {
      joins: Array<{ options: unknown }> = [];
      constructor() {
        mockSwarmState.instances.push(this);
      }
      on() {}
      join(_topic: Uint8Array, options: unknown) {
        this.joins.push({ options });
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

import { Agent, IdentityKeyStorageError } from '../agent.js';

let dataDir: string;

beforeEach(() => {
  mockSwarmState.instances.length = 0;
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

  it('rejects a short TTYA PSK before retaining caller state', () => {
    expect(
      () => new Agent({ dataDir, ttyaAuthSecret: new Uint8Array(31) }),
    ).toThrow(/at least 32 random bytes/i);
  });

  it('starts the isolated TTYA manager only when a PSK is provisioned', async () => {
    const secret = new Uint8Array(32).fill(9);
    const agent = new Agent({ dataDir, ttyaAuthSecret: secret });
    secret.fill(0);
    await agent.start();

    expect(agent.isTTYAEnabled).toBe(true);
    expect(mockSwarmState.instances).toHaveLength(2);
    expect(mockSwarmState.instances[0].joins).toHaveLength(1);
    expect(mockSwarmState.instances[1].joins).toEqual([
      expect.objectContaining({ options: { server: true, client: false } }),
    ]);

    await agent.stop();
  });

  it('should start and stop', async () => {
    const agent = new Agent({
      dataDir,
      displayName: 'TestBot',
    });

    await agent.start();
    expect(agent.isRunning).toBe(true);
    expect(agent.isTTYAEnabled).toBe(false);
    expect(mockSwarmState.instances).toHaveLength(1);
    expect(mockSwarmState.instances[0].joins).toHaveLength(1);
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

  it('should persist passphrase-protected identities without plaintext key bytes', async () => {
    const agent1 = new Agent({
      dataDir,
      displayName: 'ProtectedBot',
      passphrase: 'correct horse battery staple',
    });
    await agent1.start();
    const fingerprint = agent1.identity.fingerprint;
    const privateKey = Buffer.from(agent1.identity.edPrivateKey);
    await agent1.stop();

    const dbPath = join(dataDir, 'agent.db');
    const db = new Database(dbPath, { readonly: true });
    const identityRow = db.prepare('SELECT ed_private_key FROM identity WHERE id = 1').get() as {
      ed_private_key: Buffer | null;
    };
    const keyRow = db.prepare('SELECT ciphertext FROM key_storage WHERE id = 1').get() as {
      ciphertext: Buffer;
    };
    db.close();

    expect(identityRow.ed_private_key).toBeNull();
    expect(keyRow.ciphertext.equals(privateKey)).toBe(false);
    expect(readFileSync(dbPath).includes(privateKey)).toBe(false);

    const agent2 = new Agent({
      dataDir,
      passphrase: 'correct horse battery staple',
    });
    await agent2.start();
    expect(agent2.identity.fingerprint).toBe(fingerprint);
    await agent2.stop();
  });

  it('should fail closed when an encrypted identity has a missing or wrong passphrase', async () => {
    const protectedAgent = new Agent({ dataDir, passphrase: 'right-passphrase' });
    await protectedAgent.start();
    await protectedAgent.stop();

    await expect(new Agent({ dataDir }).start()).rejects.toMatchObject({
      name: 'IdentityKeyStorageError',
      code: 'PASSPHRASE_REQUIRED',
    } satisfies Partial<IdentityKeyStorageError>);

    await expect(
      new Agent({ dataDir, passphrase: 'wrong-passphrase' }).start(),
    ).rejects.toMatchObject({
      name: 'IdentityKeyStorageError',
      code: 'UNLOCK_FAILED',
    } satisfies Partial<IdentityKeyStorageError>);
  });

  it.each(['', 'short', 'aaaaaaaaaaaa'])(
    'should reject an empty or weak passphrase without creating storage (%j)',
    async (passphrase) => {
      await expect(new Agent({ dataDir, passphrase }).start()).rejects.toMatchObject({
        code: 'INVALID_PASSPHRASE',
      } satisfies Partial<IdentityKeyStorageError>);
      expect(() => readFileSync(join(dataDir, 'agent.db'))).toThrow();
    },
  );

  it('should obtain a passphrase lazily from a secret file provider', async () => {
    const secretPath = join(dataDir, 'identity-secret');
    await import('node:fs/promises').then(({ writeFile }) =>
      writeFile(secretPath, 'provider-passphrase\n', { mode: 0o600 }),
    );
    const first = new Agent({ dataDir, secretProvider: secretFileProvider(secretPath) });
    await first.start();
    const fingerprint = first.identity.fingerprint;
    await first.stop();

    const second = new Agent({ dataDir, secretProvider: secretFileProvider(secretPath) });
    await second.start();
    expect(second.identity.fingerprint).toBe(fingerprint);
    await second.stop();
  });

  it('should safely migrate an existing plaintext identity when opened with a passphrase', async () => {
    const plaintextAgent = new Agent({ dataDir, displayName: 'MigrationBot' });
    await plaintextAgent.start();
    const fingerprint = plaintextAgent.identity.fingerprint;
    const privateKey = Buffer.from(plaintextAgent.identity.edPrivateKey);
    await plaintextAgent.stop();

    const migratedAgent = new Agent({ dataDir, passphrase: 'migration-passphrase' });
    await migratedAgent.start();
    expect(migratedAgent.identity.fingerprint).toBe(fingerprint);
    await migratedAgent.stop();

    const dbPath = join(dataDir, 'agent.db');
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare(
      `SELECT identity.ed_private_key, key_storage.ciphertext
       FROM identity JOIN key_storage ON key_storage.id = identity.id
       WHERE identity.id = 1`,
    ).get() as { ed_private_key: Buffer | null; ciphertext: Buffer };
    db.close();

    expect(row.ed_private_key).toBeNull();
    expect(row.ciphertext.length).toBeGreaterThan(privateKey.length);
    expect(readFileSync(dbPath).includes(privateKey)).toBe(false);

    const restartedAgent = new Agent({ dataDir, passphrase: 'migration-passphrase' });
    await restartedAgent.start();
    expect(restartedAgent.identity.fingerprint).toBe(fingerprint);
    await restartedAgent.stop();
  });

  it('should make concurrent plaintext migration starts converge on one encrypted identity', async () => {
    const plaintext = new Agent({ dataDir });
    await plaintext.start();
    const fingerprint = plaintext.identity.fingerprint;
    await plaintext.stop();

    const first = new Agent({ dataDir, passphrase: 'shared-concurrent-passphrase' });
    const second = new Agent({ dataDir, passphrase: 'shared-concurrent-passphrase' });
    await Promise.all([first.start(), second.start()]);
    expect(first.identity.fingerprint).toBe(fingerprint);
    expect(second.identity.fingerprint).toBe(fingerprint);
    await Promise.all([first.stop(), second.stop()]);

    const inspected = new Database(join(dataDir, 'agent.db'), { readonly: true });
    expect(inspected.prepare('SELECT COUNT(*) AS count FROM identity').get()).toEqual({ count: 1 });
    expect(inspected.prepare('SELECT COUNT(*) AS count FROM key_storage').get()).toEqual({ count: 1 });
    inspected.close();
  });

  it('should not let a concurrent migration loser replace the winner with another passphrase', async () => {
    const plaintext = new Agent({ dataDir });
    await plaintext.start();
    const fingerprint = plaintext.identity.fingerprint;
    await plaintext.stop();

    const candidates = [
      {
        passphrase: 'first-concurrent-passphrase',
        agent: new Agent({ dataDir, passphrase: 'first-concurrent-passphrase' }),
      },
      {
        passphrase: 'second-concurrent-passphrase',
        agent: new Agent({ dataDir, passphrase: 'second-concurrent-passphrase' }),
      },
    ];
    const results = await Promise.allSettled(candidates.map(({ agent }) => agent.start()));
    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1);

    const winnerIndex = results.findIndex(({ status }) => status === 'fulfilled');
    expect(candidates[winnerIndex].agent.identity.fingerprint).toBe(fingerprint);
    await candidates[winnerIndex].agent.stop();

    const restarted = new Agent({
      dataDir,
      passphrase: candidates[winnerIndex].passphrase,
    });
    await restarted.start();
    expect(restarted.identity.fingerprint).toBe(fingerprint);
    await restarted.stop();
  });

  it('should fail closed on a busy WAL and recover after the plaintext snapshot can be removed', async () => {
    const plaintext = new Agent({ dataDir });
    await plaintext.start();
    const fingerprint = plaintext.identity.fingerprint;
    const privateKey = Buffer.from(plaintext.identity.edPrivateKey);
    await plaintext.stop();

    const dbPath = join(dataDir, 'agent.db');
    const reader = new Database(dbPath, { readonly: true });
    reader.exec('BEGIN');
    reader.prepare('SELECT ed_private_key FROM identity WHERE id = 1').get();

    await expect(
      new Agent({ dataDir, passphrase: 'busy-wal-passphrase' }).start(),
    ).rejects.toMatchObject({
      code: 'PLAINTEXT_ERASURE_FAILED',
    } satisfies Partial<IdentityKeyStorageError>);
    expect(readFileSync(dbPath).includes(privateKey)).toBe(true);

    reader.exec('ROLLBACK');
    reader.close();

    const recovered = new Agent({ dataDir, passphrase: 'busy-wal-passphrase' });
    await recovered.start();
    expect(recovered.identity.fingerprint).toBe(fingerprint);
    await recovered.stop();
    for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      if (existsSync(path)) expect(readFileSync(path).includes(privateKey)).toBe(false);
    }
  });

  it('should type an orphaned encrypted row and recover it without overwriting ciphertext', async () => {
    const protectedAgent = new Agent({ dataDir, passphrase: 'orphan-recovery-passphrase' });
    await protectedAgent.start();
    const fingerprint = protectedAgent.identity.fingerprint;
    await protectedAgent.stop();

    const dbPath = join(dataDir, 'agent.db');
    const db = new Database(dbPath);
    const before = db.prepare('SELECT * FROM key_storage WHERE id = 1').get() as {
      salt: Buffer;
      nonce: Buffer;
      ciphertext: Buffer;
    };
    db.prepare('DELETE FROM identity WHERE id = 1').run();
    db.close();

    await expect(new Agent({ dataDir }).start()).rejects.toMatchObject({
      code: 'KEY_STORAGE_ORPHANED',
    } satisfies Partial<IdentityKeyStorageError>);

    const afterFailure = new Database(dbPath, { readonly: true });
    const unchanged = afterFailure.prepare('SELECT * FROM key_storage WHERE id = 1').get() as typeof before;
    afterFailure.close();
    expect(unchanged.salt).toEqual(before.salt);
    expect(unchanged.nonce).toEqual(before.nonce);
    expect(unchanged.ciphertext).toEqual(before.ciphertext);

    const recovered = new Agent({ dataDir, passphrase: 'orphan-recovery-passphrase' });
    await recovered.start();
    expect(recovered.identity.fingerprint).toBe(fingerprint);
    await recovered.stop();
  });

  it('should type corrupt orphaned key storage without overwriting it', async () => {
    const db = new (await import('../storage/database.js')).AgentDatabase(dataDir);
    db.migrate();
    const sqlite = db.getDb();
    sqlite.prepare(
      'INSERT INTO key_storage (id, salt, nonce, ciphertext) VALUES (1, ?, ?, ?)',
    ).run(Buffer.alloc(1), Buffer.alloc(24), Buffer.alloc(48));
    db.close();

    await expect(
      new Agent({ dataDir, passphrase: 'corrupt-row-passphrase' }).start(),
    ).rejects.toMatchObject({ code: 'KEY_STORAGE_CORRUPT' } satisfies Partial<IdentityKeyStorageError>);

    const inspected = new Database(join(dataDir, 'agent.db'), { readonly: true });
    expect((inspected.prepare('SELECT length(salt) AS length FROM key_storage').get() as { length: number }).length).toBe(1);
    expect(inspected.prepare('SELECT COUNT(*) AS count FROM identity').get()).toEqual({ count: 0 });
    inspected.close();
  });

  it('should fail closed and then clean up a legacy identity containing both key copies', async () => {
    const legacyAgent = new Agent({ dataDir, displayName: 'LegacyProtectedBot' });
    await legacyAgent.start();
    const fingerprint = legacyAgent.identity.fingerprint;
    const privateKey = Buffer.from(legacyAgent.identity.edPrivateKey);
    await legacyAgent.stop();

    const passphrase = 'legacy-passphrase';
    const salt = crypto.getRandomValues(new Uint8Array(32));
    const wrappingKey = new Uint8Array(await argon2id({
      password: passphrase,
      salt,
      parallelism: 1,
      iterations: 3,
      memorySize: 65536,
      hashLength: 32,
      outputType: 'binary',
    }));
    const { ciphertext, nonce } = encrypt(wrappingKey, privateKey);
    const dbPath = join(dataDir, 'agent.db');
    const legacyDb = new Database(dbPath);
    legacyDb.prepare(
      `INSERT INTO key_storage (id, salt, nonce, ciphertext) VALUES (1, ?, ?, ?)`,
    ).run(Buffer.from(salt), Buffer.from(nonce), Buffer.from(ciphertext));
    legacyDb.close();

    await expect(new Agent({ dataDir }).start()).rejects.toMatchObject({
      code: 'PASSPHRASE_REQUIRED',
    } satisfies Partial<IdentityKeyStorageError>);
    await expect(
      new Agent({ dataDir, passphrase: 'wrong-legacy-passphrase' }).start(),
    ).rejects.toMatchObject({ code: 'UNLOCK_FAILED' } satisfies Partial<IdentityKeyStorageError>);

    const upgradedAgent = new Agent({ dataDir, passphrase });
    await upgradedAgent.start();
    expect(upgradedAgent.identity.fingerprint).toBe(fingerprint);
    await upgradedAgent.stop();

    const inspectedDb = new Database(dbPath, { readonly: true });
    const upgradedRow = inspectedDb
      .prepare('SELECT ed_private_key FROM identity WHERE id = 1')
      .get() as { ed_private_key: Buffer | null };
    inspectedDb.close();
    expect(upgradedRow.ed_private_key).toBeNull();
    expect(readFileSync(dbPath).includes(privateKey)).toBe(false);
  });

  it('should create a group', async () => {
    const agent = new Agent({
      dataDir,
      displayName: 'GroupBot',
    });
    await agent.start();

    const group = await agent.createGroup('Test Group');
    expect(group).toBeDefined();
    expect(group.groupId).toBeInstanceOf(Uint8Array);
    expect(group.topic).toBeInstanceOf(Buffer);

    const groups = agent.listGroups();
    expect(groups.length).toBe(1);
    expect(groups[0].name).toBe('Test Group');
    expect(groups[0].role).toBe('admin');
    expect(groups[0].isPublic).toBe(false);

    await agent.stop();
  });

  it('does not amplify sender-key state or traffic for a discovery-only peer', async () => {
    const agent = new Agent({ dataDir, displayName: 'GroupBot' });
    await agent.start();
    const group = await agent.createGroup('Private group');
    const database = new Database(join(dataDir, 'agent.db'));
    const readSequence = () =>
      (
        database
          .prepare(
            'SELECT distribution_sequence FROM sender_keys WHERE group_id = ? AND public_key = ?',
          )
          .get(
            Buffer.from(group.groupId),
            Buffer.from(agent.identity.edPublicKey),
          ) as { distribution_sequence: number }
      ).distribution_sequence;
    const sequenceBefore = readSequence();
    const send = vi.fn();
    const outsiderPublicKey = new Uint8Array(32).fill(0x51);
    const outsiderSession = {
      peerPublicKey: outsiderPublicKey,
      peerXPublicKey: new Uint8Array(32).fill(0x52),
      peerCapabilities: new Set([SENDER_KEY_CAPABILITY, 'group-epoch-v1']),
      send,
    };

    (
      agent as unknown as {
        swarm: { emit(event: string, value: unknown): void };
      }
    ).swarm.emit('peer:verified', {
      session: outsiderSession,
      peerPublicKey: outsiderPublicKey,
      peerFingerprint: 'discovery-only-peer',
      peerCapabilities: [...outsiderSession.peerCapabilities],
      peerNoisePublicKey: new Uint8Array(32),
      peerProtocolVersion: 2,
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(readSequence()).toBe(sequenceBefore);
    expect(send).not.toHaveBeenCalled();

    database.close();
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

  it('should not crash on emitted error events', () => {
    const agent = new Agent({ dataDir });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // This would crash the process without the default error listener
    expect(() => {
      agent.emit('error', new Error('peer handshake failed'));
    }).not.toThrow();

    expect(consoleSpy).toHaveBeenCalledWith(
      '[Agent error]',
      'peer handshake failed',
    );

    consoleSpy.mockRestore();
  });

  it('should still deliver errors to custom listeners', () => {
    const agent = new Agent({ dataDir });
    const errors: Error[] = [];

    agent.on('error', (err: Error) => {
      errors.push(err);
    });

    agent.emit('error', new Error('swarm connection lost'));

    // Custom listener received it
    expect(errors.length).toBe(1);
    expect(errors[0].message).toBe('swarm connection lost');
  });
});
