import { Decoder, Encoder } from 'cbor-x';
import { sha256 } from '@noble/hashes/sha256';
import { sign, verify } from '../crypto/signatures.js';

const encoder = new Encoder({ useRecords: false });
const decoder = new Decoder({ mapsAsObjects: true, useRecords: false });
const textEncoder = new TextEncoder();

export interface GroupMemberEntry {
  publicKey: Uint8Array;
  role: 'admin' | 'member';
}

export interface GroupEpoch {
  version: number;
  prevHash: Uint8Array;
  groupId: string;
  members: GroupMemberEntry[];
  /** Immutable creation time covered by the epoch signature and hash. */
  createdAt: number;
  createdBy: Uint8Array;
}

export interface SignedGroupEpoch {
  epoch: GroupEpoch;
  signature: Uint8Array;
  hash: Uint8Array;
}

export const GROUP_EPOCH_FORMAT_VERSION = 1;
export const MAX_EPOCH_BYTES = 256 * 1024;
export const MAX_GROUP_MEMBERS = 1024;
const EPOCH_DOMAIN = 'network.self.md/GroupEpoch';
const ZERO_HASH = new Uint8Array(32);

/** Canonical, domain-separated representation used for signing and hashing. */
export function serializeEpoch(epoch: GroupEpoch): Uint8Array {
  assertEpoch(epoch);
  return encoder.encode([
    EPOCH_DOMAIN,
    GROUP_EPOCH_FORMAT_VERSION,
    epoch.version,
    canonicalBytes(epoch.prevHash),
    epoch.groupId,
    epoch.members.map((member) => [
      canonicalBytes(member.publicKey),
      member.role,
    ]),
    epoch.createdAt,
    canonicalBytes(epoch.createdBy),
  ]);
}

export function deserializeEpoch(data: Uint8Array): GroupEpoch {
  if (
    !(data instanceof Uint8Array) ||
    data.length === 0 ||
    data.length > MAX_EPOCH_BYTES
  ) {
    throw new Error('Invalid group epoch: encoded size is out of range');
  }

  let decoded: unknown;
  try {
    decoded = decoder.decode(data);
  } catch (error) {
    throw new Error('Invalid group epoch: malformed CBOR', { cause: error });
  }
  if (!Array.isArray(decoded) || decoded.length !== 8) {
    throw new Error('Invalid group epoch: fields do not match schema');
  }

  const [
    domain,
    formatVersion,
    version,
    prevHash,
    groupId,
    rawMembers,
    createdAt,
    createdBy,
  ] = decoded;
  if (domain !== EPOCH_DOMAIN || formatVersion !== GROUP_EPOCH_FORMAT_VERSION) {
    throw new Error(
      'Invalid group epoch: unsupported domain or format version',
    );
  }

  const epoch = {
    version,
    prevHash,
    groupId,
    members: decodeMembers(rawMembers),
    createdAt,
    createdBy,
  } as GroupEpoch;
  assertEpoch(epoch);

  return {
    ...epoch,
    prevHash: new Uint8Array(epoch.prevHash),
    createdBy: new Uint8Array(epoch.createdBy),
    members: epoch.members.map((member) => ({
      publicKey: new Uint8Array(member.publicKey),
      role: member.role,
    })),
  };
}

export function hashEpoch(serialized: Uint8Array): Uint8Array {
  return sha256(serialized);
}

export function createSignedEpoch(
  epoch: GroupEpoch,
  privateKey: Uint8Array,
): SignedGroupEpoch {
  const serialized = serializeEpoch(epoch);
  return {
    epoch,
    signature: sign(serialized, privateKey),
    hash: hashEpoch(serialized),
  };
}

export function verifyEpoch(
  signed: SignedGroupEpoch,
  expectedPrevHash: Uint8Array,
): boolean {
  try {
    const serialized = serializeEpoch(signed.epoch);
    return (
      signed.signature instanceof Uint8Array &&
      signed.signature.length === 64 &&
      signed.hash instanceof Uint8Array &&
      signed.hash.length === 32 &&
      expectedPrevHash instanceof Uint8Array &&
      expectedPrevHash.length === 32 &&
      bytesEqual(hashEpoch(serialized), signed.hash) &&
      verify(signed.signature, serialized, signed.epoch.createdBy) &&
      bytesEqual(signed.epoch.prevHash, expectedPrevHash) &&
      signed.epoch.members.some(
        (member) =>
          member.role === 'admin' &&
          bytesEqual(member.publicKey, signed.epoch.createdBy),
      )
    );
  } catch {
    return false;
  }
}

/** Verify the exact v0 trust anchor, not merely a zero-prevHash epoch. */
export function verifyGenesisEpoch(
  signed: SignedGroupEpoch,
  expectedGroupId: string,
  expectedCreator?: Uint8Array,
): boolean {
  try {
    const { epoch } = signed;
    return (
      epoch.version === 0 &&
      epoch.groupId === expectedGroupId &&
      bytesEqual(epoch.prevHash, ZERO_HASH) &&
      epoch.members.length === 1 &&
      epoch.members[0].role === 'admin' &&
      bytesEqual(epoch.members[0].publicKey, epoch.createdBy) &&
      (!expectedCreator || bytesEqual(epoch.createdBy, expectedCreator)) &&
      verifyEpoch(signed, ZERO_HASH)
    );
  } catch {
    return false;
  }
}

export function createGenesisEpoch(
  groupId: string,
  adminPublicKey: Uint8Array,
  createdAt: number = Date.now(),
): GroupEpoch {
  return {
    version: 0,
    prevHash: new Uint8Array(ZERO_HASH),
    groupId,
    members: [{ publicKey: adminPublicKey, role: 'admin' }],
    createdAt,
    createdBy: adminPublicKey,
  };
}

function decodeMembers(value: unknown): GroupMemberEntry[] {
  if (!Array.isArray(value)) {
    throw new Error('Invalid group epoch: members must be an array');
  }
  return value.map((member) => {
    if (!Array.isArray(member) || member.length !== 2) {
      throw new Error('Invalid group epoch: member fields do not match schema');
    }
    return { publicKey: member[0], role: member[1] } as GroupMemberEntry;
  });
}

function assertEpoch(epoch: GroupEpoch): void {
  if (
    !Number.isSafeInteger(epoch.version) ||
    epoch.version < 0 ||
    epoch.version > 0xffff_ffff
  ) {
    throw new Error('Invalid group epoch: version is out of range');
  }
  assertBytes(epoch.prevHash, 32, 'prevHash');
  if (
    typeof epoch.groupId !== 'string' ||
    byteLength(epoch.groupId) < 1 ||
    byteLength(epoch.groupId) > 128
  ) {
    throw new Error('Invalid group epoch: groupId length is out of range');
  }
  if (
    !Array.isArray(epoch.members) ||
    epoch.members.length === 0 ||
    epoch.members.length > MAX_GROUP_MEMBERS
  ) {
    throw new Error('Invalid group epoch: members count is out of range');
  }
  const seen = new Set<string>();
  for (const member of epoch.members) {
    assertBytes(member.publicKey, 32, 'member publicKey');
    if (member.role !== 'admin' && member.role !== 'member') {
      throw new Error('Invalid group epoch: member role is invalid');
    }
    const key = toHex(member.publicKey);
    if (seen.has(key)) throw new Error('Invalid group epoch: duplicate member');
    seen.add(key);
  }
  if (!Number.isSafeInteger(epoch.createdAt) || epoch.createdAt < 0) {
    throw new Error('Invalid group epoch: createdAt is out of range');
  }
  assertBytes(epoch.createdBy, 32, 'createdBy');
}

function assertBytes(value: unknown, length: number, label: string): void {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new Error(`Invalid group epoch: ${label} must be ${length} bytes`);
  }
}

function byteLength(value: string): number {
  return textEncoder.encode(value).length;
}

function toHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index++) {
    difference |= a[index] ^ b[index];
  }
  return difference === 0;
}

function canonicalBytes(value: Uint8Array): Uint8Array {
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}
