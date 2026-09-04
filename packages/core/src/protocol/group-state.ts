import { Encoder, Decoder } from 'cbor-x';
import { sha256 } from '@noble/hashes/sha256';
import { sign, verify } from '../crypto/signatures.js';

const encoder = new Encoder({ useRecords: false });
const decoder = new Decoder({ mapsAsObjects: true, useRecords: false });

export interface GroupMemberEntry {
  publicKey: Uint8Array;
  role: 'admin' | 'member';
}

export interface GroupEpoch {
  version: number;
  prevHash: Uint8Array;
  groupId: string;
  members: GroupMemberEntry[];
  timestamp: number;
  createdBy: Uint8Array;
}

export interface SignedGroupEpoch {
  epoch: GroupEpoch;
  signature: Uint8Array;
  hash: Uint8Array;
}

const ZERO_HASH = new Uint8Array(32);
const MAX_GROUP_MEMBERS = 1024;

export function serializeEpoch(epoch: GroupEpoch): Uint8Array {
  assertEpoch(epoch);
  const serializable = {
    version: epoch.version,
    prevHash: epoch.prevHash,
    groupId: epoch.groupId,
    members: epoch.members.map((m) => ({
      publicKey: m.publicKey,
      role: m.role,
    })),
    timestamp: epoch.timestamp,
    createdBy: epoch.createdBy,
  };
  return encoder.encode(serializable);
}

export function deserializeEpoch(data: Uint8Array): GroupEpoch {
  if (!(data instanceof Uint8Array) || data.length === 0 || data.length > 256 * 1024) {
    throw new Error('Invalid group epoch encoding');
  }
  const obj = decoder.decode(data) as unknown;
  if (!obj || typeof obj !== 'object') throw new Error('Invalid group epoch');
  const value = obj as Record<string, unknown>;
  const keys = Object.keys(value);
  const expectedKeys = ['version', 'prevHash', 'groupId', 'members', 'timestamp', 'createdBy'];
  if (keys.length !== expectedKeys.length || keys.some((key) => !expectedKeys.includes(key)) || !Array.isArray(value.members)) throw new Error('Invalid group epoch schema');
  for (const member of value.members) {
    if (!member || typeof member !== 'object' || Object.keys(member).length !== 2 || !('publicKey' in member) || !('role' in member)) throw new Error('Invalid group member schema');
  }
  const epoch: GroupEpoch = {
    version: value.version as number,
    prevHash: value.prevHash as Uint8Array,
    groupId: value.groupId as string,
    members: (value.members as Array<{ publicKey: Uint8Array; role: 'admin' | 'member' }>).map((m) => ({
      publicKey: m.publicKey,
      role: m.role,
    })),
    timestamp: value.timestamp as number,
    createdBy: value.createdBy as Uint8Array,
  };
  assertEpoch(epoch);
  return epoch;
}

export function hashEpoch(serialized: Uint8Array): Uint8Array {
  return sha256(serialized);
}

export function createSignedEpoch(
  epoch: GroupEpoch,
  privateKey: Uint8Array,
): SignedGroupEpoch {
  const serialized = serializeEpoch(epoch);
  const signature = sign(serialized, privateKey);
  const hash = hashEpoch(serialized);
  return { epoch, signature, hash };
}

export function verifyEpoch(
  signed: SignedGroupEpoch,
  expectedPrevHash: Uint8Array,
): boolean {
  try {
    const serialized = serializeEpoch(signed.epoch);

  if (
    !(signed.signature instanceof Uint8Array) || signed.signature.length !== 64 ||
    !(signed.hash instanceof Uint8Array) || signed.hash.length !== 32 ||
    !bytesEqual(hashEpoch(serialized), signed.hash)
  ) {
    return false;
  }

  if (!verify(signed.signature, serialized, signed.epoch.createdBy)) {
    return false;
  }

  if (!bytesEqual(signed.epoch.prevHash, expectedPrevHash)) {
    return false;
  }

  const isAdmin = signed.epoch.members.some(
    (m) => m.role === 'admin' && bytesEqual(m.publicKey, signed.epoch.createdBy),
  );
  if (!isAdmin) {
    return false;
  }

    return true;
  } catch {
    return false;
  }
}

/** Verify the exact, pinned trust anchor for a group. */
export function verifyGenesisEpoch(
  signed: SignedGroupEpoch,
  expectedGroupId: string,
  expectedCreator?: Uint8Array,
): boolean {
  try {
    const { epoch } = signed;
    if (
      epoch.version !== 0 ||
      epoch.groupId !== expectedGroupId ||
      !bytesEqual(epoch.prevHash, ZERO_HASH) ||
      epoch.members.length !== 1 ||
      epoch.members[0].role !== 'admin' ||
      !bytesEqual(epoch.members[0].publicKey, epoch.createdBy) ||
      (expectedCreator && !bytesEqual(epoch.createdBy, expectedCreator))
    ) {
      return false;
    }
    return verifyEpoch(signed, ZERO_HASH);
  } catch {
    return false;
  }
}

export function createGenesisEpoch(
  groupId: string,
  adminPublicKey: Uint8Array,
): GroupEpoch {
  return {
    version: 0,
    prevHash: new Uint8Array(ZERO_HASH),
    groupId,
    members: [{ publicKey: adminPublicKey, role: 'admin' }],
    timestamp: Date.now(),
    createdBy: adminPublicKey,
  };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function assertEpoch(epoch: GroupEpoch): void {
  if (!Number.isSafeInteger(epoch.version) || epoch.version < 0) {
    throw new Error('Invalid group epoch version');
  }
  if (!(epoch.prevHash instanceof Uint8Array) || epoch.prevHash.length !== 32) {
    throw new Error('Invalid group epoch previous hash');
  }
  if (typeof epoch.groupId !== 'string' || epoch.groupId.length === 0 || epoch.groupId.length > 128) {
    throw new Error('Invalid group epoch group id');
  }
  if (!Array.isArray(epoch.members) || epoch.members.length === 0 || epoch.members.length > MAX_GROUP_MEMBERS) {
    throw new Error('Invalid group epoch members');
  }
  const seen = new Set<string>();
  for (const member of epoch.members) {
    if (!(member.publicKey instanceof Uint8Array) || member.publicKey.length !== 32) {
      throw new Error('Invalid group member public key');
    }
    if (member.role !== 'admin' && member.role !== 'member') {
      throw new Error('Invalid group member role');
    }
    const key = Array.from(member.publicKey, (byte) => byte.toString(16).padStart(2, '0')).join('');
    if (seen.has(key)) throw new Error('Duplicate group member');
    seen.add(key);
  }
  if (!Number.isSafeInteger(epoch.timestamp) || epoch.timestamp < 0) {
    throw new Error('Invalid group epoch timestamp');
  }
  if (!(epoch.createdBy instanceof Uint8Array) || epoch.createdBy.length !== 32) {
    throw new Error('Invalid group epoch creator');
  }
}
