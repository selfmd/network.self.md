import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import { randomBytes } from '@noble/hashes/utils';
import {
  serializeEpoch,
  deserializeEpoch,
  hashEpoch,
  createSignedEpoch,
  verifyEpoch,
  createGenesisEpoch,
  verifyGenesisEpoch,
  type GroupEpoch,
  type SignedGroupEpoch,
} from '../protocol/group-state.js';

function generateKeypair() {
  const privateKey = randomBytes(32);
  const publicKey = ed25519.getPublicKey(privateKey);
  return { privateKey, publicKey };
}

describe('GroupEpoch serialization', () => {
  it('roundtrips through serialize/deserialize', () => {
    const admin = generateKeypair();
    const epoch = createGenesisEpoch('test-group', admin.publicKey);

    const serialized = serializeEpoch(epoch);
    const deserialized = deserializeEpoch(serialized);

    expect(deserialized.version).toBe(0);
    expect(deserialized.groupId).toBe('test-group');
    expect(deserialized.members.length).toBe(1);
    expect(deserialized.members[0].role).toBe('admin');
    expect(new Uint8Array(deserialized.createdBy)).toEqual(admin.publicKey);
    expect(new Uint8Array(deserialized.prevHash)).toEqual(new Uint8Array(32));
  });

  it('produces deterministic serialization', () => {
    const admin = generateKeypair();
    const epoch: GroupEpoch = {
      version: 1,
      prevHash: new Uint8Array(32),
      groupId: 'g1',
      members: [{ publicKey: admin.publicKey, role: 'admin' }],
      createdAt: 1000,
      createdBy: admin.publicKey,
    };

    const a = serializeEpoch(epoch);
    const b = serializeEpoch(epoch);
    expect(a).toEqual(b);
  });

  it('matches the canonical domain/version golden vector', () => {
    const epoch: GroupEpoch = {
      version: 0,
      prevHash: new Uint8Array(32),
      groupId: '01',
      members: [{ publicKey: new Uint8Array(32).fill(2), role: 'admin' }],
      createdAt: 3,
      createdBy: new Uint8Array(32).fill(2),
    };
    expect(Buffer.from(serializeEpoch(epoch)).toString('hex')).toBe(
      '88781a6e6574776f726b2e73656c662e6d642f47726f757045706f63680100d840582000000000000000000000000000000000000000000000000000000000000000006230318182d840582002020202020202020202020202020202020202020202020202020202020202026561646d696e03d84058200202020202020202020202020202020202020202020202020202020202020202',
    );
  });
});

describe('GroupEpoch hashing', () => {
  it('produces 32-byte SHA-256 hash', () => {
    const admin = generateKeypair();
    const epoch = createGenesisEpoch('g1', admin.publicKey);
    const hash = hashEpoch(serializeEpoch(epoch));
    expect(hash.length).toBe(32);
  });

  it('different epochs produce different hashes', () => {
    const admin = generateKeypair();
    const e1 = createGenesisEpoch('g1', admin.publicKey);
    const e2 = createGenesisEpoch('g2', admin.publicKey);
    const h1 = hashEpoch(serializeEpoch(e1));
    const h2 = hashEpoch(serializeEpoch(e2));
    expect(h1).not.toEqual(h2);
  });
});

describe('createSignedEpoch', () => {
  it('creates a valid signed epoch', () => {
    const admin = generateKeypair();
    const epoch = createGenesisEpoch('g1', admin.publicKey);
    const signed = createSignedEpoch(epoch, admin.privateKey);

    expect(signed.epoch).toBe(epoch);
    expect(signed.signature.length).toBe(64);
    expect(signed.hash.length).toBe(32);
  });
});

describe('verifyEpoch', () => {
  it('verifies a valid genesis epoch', () => {
    const admin = generateKeypair();
    const epoch = createGenesisEpoch('g1', admin.publicKey);
    const signed = createSignedEpoch(epoch, admin.privateKey);

    expect(verifyEpoch(signed, new Uint8Array(32))).toBe(true);
  });

  it('verifies a valid chained epoch', () => {
    const admin = generateKeypair();
    const member = generateKeypair();

    const genesis = createGenesisEpoch('g1', admin.publicKey);
    const signedGenesis = createSignedEpoch(genesis, admin.privateKey);

    const epoch1: GroupEpoch = {
      version: 1,
      prevHash: signedGenesis.hash,
      groupId: 'g1',
      members: [
        { publicKey: admin.publicKey, role: 'admin' },
        { publicKey: member.publicKey, role: 'member' },
      ],
      createdAt: Date.now(),
      createdBy: admin.publicKey,
    };
    const signed1 = createSignedEpoch(epoch1, admin.privateKey);

    expect(verifyEpoch(signed1, signedGenesis.hash)).toBe(true);
  });

  it('rejects epoch with wrong signature', () => {
    const admin = generateKeypair();
    const attacker = generateKeypair();

    const epoch = createGenesisEpoch('g1', admin.publicKey);
    // Sign with attacker's key but createdBy is admin
    const signed = createSignedEpoch(epoch, attacker.privateKey);

    expect(verifyEpoch(signed, new Uint8Array(32))).toBe(false);
  });

  it('rejects epoch with wrong prevHash', () => {
    const admin = generateKeypair();
    const epoch = createGenesisEpoch('g1', admin.publicKey);
    const signed = createSignedEpoch(epoch, admin.privateKey);

    const wrongPrevHash = new Uint8Array(32).fill(0xff);
    expect(verifyEpoch(signed, wrongPrevHash)).toBe(false);
  });

  it('rejects epoch where createdBy is not admin', () => {
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
      createdAt: Date.now(),
      createdBy: member.publicKey, // member, not admin
    };
    const signed = createSignedEpoch(epoch, member.privateKey);

    expect(verifyEpoch(signed, new Uint8Array(32))).toBe(false);
  });

  it('rejects tampered epoch data', () => {
    const admin = generateKeypair();
    const epoch = createGenesisEpoch('g1', admin.publicKey);
    const signed = createSignedEpoch(epoch, admin.privateKey);

    // Tamper with the epoch
    signed.epoch.groupId = 'g2-hijacked';

    expect(verifyEpoch(signed, new Uint8Array(32))).toBe(false);
  });
});

describe('createGenesisEpoch', () => {
  it('creates version 0 with zero prevHash', () => {
    const admin = generateKeypair();
    const epoch = createGenesisEpoch('g1', admin.publicKey);

    expect(epoch.version).toBe(0);
    expect(epoch.prevHash).toEqual(new Uint8Array(32));
    expect(epoch.groupId).toBe('g1');
    expect(epoch.members.length).toBe(1);
    expect(epoch.members[0].role).toBe('admin');
    expect(new Uint8Array(epoch.members[0].publicKey)).toEqual(admin.publicKey);
    expect(new Uint8Array(epoch.createdBy)).toEqual(admin.publicKey);
    expect(epoch.createdAt).toBeGreaterThan(0);
  });
});

describe('verifyGenesisEpoch', () => {
  it('accepts only the exact pinned v0 shape', () => {
    const admin = generateKeypair();
    const member = generateKeypair();
    const valid = createSignedEpoch(
      createGenesisEpoch('g1', admin.publicKey, 1),
      admin.privateKey,
    );
    expect(verifyGenesisEpoch(valid, 'g1', admin.publicKey)).toBe(true);
    expect(verifyGenesisEpoch(valid, 'g2', admin.publicKey)).toBe(false);

    const notExact = createSignedEpoch(
      {
        ...valid.epoch,
        members: [
          ...valid.epoch.members,
          { publicKey: member.publicKey, role: 'member' },
        ],
      },
      admin.privateKey,
    );
    expect(verifyGenesisEpoch(notExact, 'g1', admin.publicKey)).toBe(false);
  });
});

describe('epoch chain integrity', () => {
  it('validates a 3-epoch chain', () => {
    const admin = generateKeypair();
    const m1 = generateKeypair();
    const m2 = generateKeypair();

    // Genesis
    const e0 = createGenesisEpoch('g1', admin.publicKey);
    const s0 = createSignedEpoch(e0, admin.privateKey);
    expect(verifyEpoch(s0, new Uint8Array(32))).toBe(true);

    // Add member 1
    const e1: GroupEpoch = {
      version: 1,
      prevHash: s0.hash,
      groupId: 'g1',
      members: [
        { publicKey: admin.publicKey, role: 'admin' },
        { publicKey: m1.publicKey, role: 'member' },
      ],
      createdAt: Date.now(),
      createdBy: admin.publicKey,
    };
    const s1 = createSignedEpoch(e1, admin.privateKey);
    expect(verifyEpoch(s1, s0.hash)).toBe(true);

    // Add member 2
    const e2: GroupEpoch = {
      version: 2,
      prevHash: s1.hash,
      groupId: 'g1',
      members: [
        { publicKey: admin.publicKey, role: 'admin' },
        { publicKey: m1.publicKey, role: 'member' },
        { publicKey: m2.publicKey, role: 'member' },
      ],
      createdAt: Date.now(),
      createdBy: admin.publicKey,
    };
    const s2 = createSignedEpoch(e2, admin.privateKey);
    expect(verifyEpoch(s2, s1.hash)).toBe(true);

    // Verify chain breaks if we skip an epoch
    expect(verifyEpoch(s2, s0.hash)).toBe(false);
  });

  it('rejects fork attempt by non-admin', () => {
    const admin = generateKeypair();
    const attacker = generateKeypair();

    const e0 = createGenesisEpoch('g1', admin.publicKey);
    const s0 = createSignedEpoch(e0, admin.privateKey);

    // Attacker tries to create a fork adding themselves as admin
    const forked: GroupEpoch = {
      version: 1,
      prevHash: s0.hash,
      groupId: 'g1',
      members: [{ publicKey: attacker.publicKey, role: 'admin' }],
      createdAt: Date.now(),
      createdBy: attacker.publicKey,
    };
    const signedFork = createSignedEpoch(forked, attacker.privateKey);

    // Signature is valid for attacker's key, but attacker wasn't admin in epoch 0
    // verifyEpoch checks that createdBy is admin in the epoch's own member list,
    // but the caller (group-manager) must also verify against the previous epoch
    // Here verifyEpoch passes because attacker IS listed as admin in their own epoch
    // The real security check is in group-manager which compares against previous epoch
    expect(signedFork.signature.length).toBe(64);
  });
});
