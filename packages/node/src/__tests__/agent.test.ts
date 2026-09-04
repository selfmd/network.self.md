import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { argon2id } from 'hash-wasm';
import { encrypt } from '@networkselfmd/core';

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

import { Agent, IdentityKeyStorageError } from '../agent.js';

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
