import { Encoder } from 'cbor-x';
import { sign, verify } from '../crypto/signatures.js';
import type { NetworkAnnounceMessage } from './types.js';

const encoder = new Encoder({ useRecords: false });

type AnnounceGroup = NetworkAnnounceMessage['groups'][number];

function buildSignPayload(
  groups: AnnounceGroup[],
  timestamp: number,
): Uint8Array {
  return encoder.encode({ groups, timestamp });
}

export function signAnnounce(
  groups: AnnounceGroup[],
  timestamp: number,
  privateKey: Uint8Array,
): Uint8Array {
  return sign(buildSignPayload(groups, timestamp), privateKey);
}

export function verifyAnnounce(
  groups: AnnounceGroup[],
  timestamp: number,
  signature: Uint8Array,
  publicKey: Uint8Array,
): boolean {
  return verify(signature, buildSignPayload(groups, timestamp), publicKey);
}
