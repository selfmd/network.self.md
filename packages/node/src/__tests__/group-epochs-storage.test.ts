import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  generateIdentity,
  createGenesisEpoch,
  createSignedEpoch,
  type GroupEpoch,
} from '@networkselfmd/core';
import { AgentDatabase, GroupEpochRepository } from '../storage/index.js';

function generateKeypair() {
  const identity = generateIdentity();
  return { privateKey: identity.edPrivateKey, publicKey: identity.edPublicKey };
}

let dataDir: string;
let database: AgentDatabase;
let repo: GroupEpochRepository;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'nsmd-epoch-test-'));
  database = new AgentDatabase(dataDir);
  database.migrate();
  repo = new GroupEpochRepository(database.getDb());
});

afterEach(() => {
  database.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('GroupEpochRepository', () => {
  it('saves and retrieves a genesis epoch', () => {
    const admin = generateKeypair();
    const epoch = createGenesisEpoch('g1', admin.publicKey);
    const signed = createSignedEpoch(epoch, admin.privateKey);

    repo.saveEpoch(signed);

    const loaded = repo.getLatestEpoch('g1');
    expect(loaded).not.toBeNull();
    expect(loaded!.epoch.version).toBe(0);
    expect(loaded!.epoch.groupId).toBe('g1');
    expect(loaded!.epoch.members.length).toBe(1);
    expect(loaded!.epoch.members[0].role).toBe('admin');
    expect(new Uint8Array(loaded!.signature)).toEqual(signed.signature);
    expect(new Uint8Array(loaded!.hash)).toEqual(signed.hash);
  });

  it('returns null for non-existent group', () => {
    expect(repo.getLatestEpoch('nonexistent')).toBeNull();
  });

  it('getLatestEpoch returns highest version', () => {
    const admin = generateKeypair();
    const member = generateKeypair();

    const e0 = createGenesisEpoch('g1', admin.publicKey);
    const s0 = createSignedEpoch(e0, admin.privateKey);
    repo.saveEpoch(s0);

    const e1: GroupEpoch = {
      version: 1,
      prevHash: s0.hash,
      groupId: 'g1',
      members: [
        { publicKey: admin.publicKey, role: 'admin' },
        { publicKey: member.publicKey, role: 'member' },
      ],
      timestamp: Date.now(),
      createdBy: admin.publicKey,
    };
    const s1 = createSignedEpoch(e1, admin.privateKey);
    repo.saveEpoch(s1);

    const latest = repo.getLatestEpoch('g1');
    expect(latest!.epoch.version).toBe(1);
    expect(latest!.epoch.members.length).toBe(2);
  });

  it('getEpochChain returns all epochs in order', () => {
    const admin = generateKeypair();

    const e0 = createGenesisEpoch('g1', admin.publicKey);
    const s0 = createSignedEpoch(e0, admin.privateKey);
    repo.saveEpoch(s0);

    const e1: GroupEpoch = {
      version: 1,
      prevHash: s0.hash,
      groupId: 'g1',
      members: [{ publicKey: admin.publicKey, role: 'admin' }],
      timestamp: Date.now(),
      createdBy: admin.publicKey,
    };
    const s1 = createSignedEpoch(e1, admin.privateKey);
    repo.saveEpoch(s1);

    const e2: GroupEpoch = {
      version: 2,
      prevHash: s1.hash,
      groupId: 'g1',
      members: [{ publicKey: admin.publicKey, role: 'admin' }],
      timestamp: Date.now(),
      createdBy: admin.publicKey,
    };
    const s2 = createSignedEpoch(e2, admin.privateKey);
    repo.saveEpoch(s2);

    const chain = repo.getEpochChain('g1');
    expect(chain.length).toBe(3);
    expect(chain[0].epoch.version).toBe(0);
    expect(chain[1].epoch.version).toBe(1);
    expect(chain[2].epoch.version).toBe(2);
  });

  it('getEpochByVersion retrieves specific version', () => {
    const admin = generateKeypair();

    const e0 = createGenesisEpoch('g1', admin.publicKey);
    const s0 = createSignedEpoch(e0, admin.privateKey);
    repo.saveEpoch(s0);

    const e1: GroupEpoch = {
      version: 1,
      prevHash: s0.hash,
      groupId: 'g1',
      members: [{ publicKey: admin.publicKey, role: 'admin' }],
      timestamp: Date.now(),
      createdBy: admin.publicKey,
    };
    const s1 = createSignedEpoch(e1, admin.privateKey);
    repo.saveEpoch(s1);

    const v0 = repo.getEpochByVersion('g1', 0);
    expect(v0!.epoch.version).toBe(0);

    const v1 = repo.getEpochByVersion('g1', 1);
    expect(v1!.epoch.version).toBe(1);

    const v99 = repo.getEpochByVersion('g1', 99);
    expect(v99).toBeNull();
  });

  it('isolates epochs between groups', () => {
    const admin = generateKeypair();

    const e1 = createGenesisEpoch('g1', admin.publicKey);
    repo.saveEpoch(createSignedEpoch(e1, admin.privateKey));

    const e2 = createGenesisEpoch('g2', admin.publicKey);
    repo.saveEpoch(createSignedEpoch(e2, admin.privateKey));

    expect(repo.getEpochChain('g1').length).toBe(1);
    expect(repo.getEpochChain('g2').length).toBe(1);
    expect(repo.getLatestEpoch('g1')!.epoch.groupId).toBe('g1');
    expect(repo.getLatestEpoch('g2')!.epoch.groupId).toBe('g2');
  });

  it('schema migration creates group_epochs table', () => {
    const db = database.getDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain('group_epochs');
  });

  it('preserves member public keys through roundtrip', () => {
    const admin = generateKeypair();
    const member = generateKeypair();

    const epoch: GroupEpoch = {
      version: 0,
      prevHash: new Uint8Array(32),
      groupId: 'g1',
      members: [
        { publicKey: admin.publicKey, role: 'admin' },
        { publicKey: member.publicKey, role: 'member' },
      ],
      timestamp: Date.now(),
      createdBy: admin.publicKey,
    };
    const signed = createSignedEpoch(epoch, admin.privateKey);
    repo.saveEpoch(signed);

    const loaded = repo.getLatestEpoch('g1')!;
    expect(new Uint8Array(loaded.epoch.members[0].publicKey)).toEqual(admin.publicKey);
    expect(new Uint8Array(loaded.epoch.members[1].publicKey)).toEqual(member.publicKey);
    expect(new Uint8Array(loaded.epoch.createdBy)).toEqual(admin.publicKey);
  });
});
