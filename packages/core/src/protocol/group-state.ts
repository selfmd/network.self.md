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

export function serializeEpoch(epoch: GroupEpoch): Uint8Array {
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
  if (
    !(data instanceof Uint8Array) ||
    data.length === 0 ||
    data.length > 1_048_576
  ) {
    throw new Error('Invalid group epoch: encoded size is out of range');
  }
  const decoded: unknown = decoder.decode(data);
  if (
    typeof decoded !== 'object' ||
    decoded === null ||
    Array.isArray(decoded)
  ) {
    throw new Error('Invalid group epoch: payload must be a map');
  }
  const obj = decoded as Record<string, unknown>;
  const expected = [
    'version',
    'prevHash',
    'groupId',
    'members',
    'timestamp',
    'createdBy',
  ];
  if (
    Object.keys(obj).length !== expected.length ||
    expected.some((key) => !Object.prototype.hasOwnProperty.call(obj, key))
  ) {
    throw new Error('Invalid group epoch: fields do not match schema');
  }
  if (
    !Number.isSafeInteger(obj.version) ||
    (obj.version as number) < 0 ||
    (obj.version as number) > 0xffff_ffff
  ) {
    throw new Error('Invalid group epoch: version is out of range');
  }
  if (!(obj.prevHash instanceof Uint8Array) || obj.prevHash.length !== 32) {
    throw new Error('Invalid group epoch: prevHash must be 32 bytes');
  }
  if (
    typeof obj.groupId !== 'string' ||
    obj.groupId.length < 1 ||
    obj.groupId.length > 128
  ) {
    throw new Error('Invalid group epoch: groupId length is out of range');
  }
  if (
    !Array.isArray(obj.members) ||
    obj.members.length === 0 ||
    obj.members.length > 1024
  ) {
    throw new Error('Invalid group epoch: members count is out of range');
  }
  const seen = new Set<string>();
  const members = obj.members.map((value) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('Invalid group epoch: member must be a map');
    }
    const member = value as Record<string, unknown>;
    if (
      Object.keys(member).length !== 2 ||
      !Object.prototype.hasOwnProperty.call(member, 'publicKey') ||
      !Object.prototype.hasOwnProperty.call(member, 'role')
    ) {
      throw new Error('Invalid group epoch: member fields do not match schema');
    }
    if (
      !(member.publicKey instanceof Uint8Array) ||
      member.publicKey.length !== 32
    ) {
      throw new Error('Invalid group epoch: member publicKey must be 32 bytes');
    }
    if (member.role !== 'admin' && member.role !== 'member') {
      throw new Error('Invalid group epoch: member role is invalid');
    }
    const key = Array.from(member.publicKey, (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
    if (seen.has(key)) throw new Error('Invalid group epoch: duplicate member');
    seen.add(key);
    return {
      publicKey: new Uint8Array(member.publicKey),
      role: member.role as 'admin' | 'member',
    };
  });
  if (!Number.isSafeInteger(obj.timestamp) || (obj.timestamp as number) < 0) {
    throw new Error('Invalid group epoch: timestamp is out of range');
  }
  if (!(obj.createdBy instanceof Uint8Array) || obj.createdBy.length !== 32) {
    throw new Error('Invalid group epoch: createdBy must be 32 bytes');
  }
  return {
    version: obj.version as number,
    prevHash: new Uint8Array(obj.prevHash),
    groupId: obj.groupId,
    members,
    timestamp: obj.timestamp as number,
    createdBy: new Uint8Array(obj.createdBy),
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
  const signature = sign(serialized, privateKey);
  const hash = hashEpoch(serialized);
  return { epoch, signature, hash };
}

export function verifyEpoch(
  signed: SignedGroupEpoch,
  expectedPrevHash: Uint8Array,
): boolean {
  const serialized = serializeEpoch(signed.epoch);

  if (!verify(signed.signature, serialized, signed.epoch.createdBy)) {
    return false;
  }

  if (!bytesEqual(signed.epoch.prevHash, expectedPrevHash)) {
    return false;
  }

  const isAdmin = signed.epoch.members.some(
    (m) =>
      m.role === 'admin' && bytesEqual(m.publicKey, signed.epoch.createdBy),
  );
  if (!isAdmin) {
    return false;
  }

  return true;
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
