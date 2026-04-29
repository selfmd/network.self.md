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
  const obj = decoder.decode(data);
  return {
    version: obj.version,
    prevHash: new Uint8Array(obj.prevHash),
    groupId: obj.groupId,
    members: obj.members.map((m: { publicKey: Uint8Array; role: string }) => ({
      publicKey: new Uint8Array(m.publicKey),
      role: m.role as 'admin' | 'member',
    })),
    timestamp: obj.timestamp,
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
    (m) => m.role === 'admin' && bytesEqual(m.publicKey, signed.epoch.createdBy),
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
