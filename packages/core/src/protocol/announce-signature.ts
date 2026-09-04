import { sha256 } from '@noble/hashes/sha256';
import { sign, verify } from '../crypto/signatures.js';
import { deserializeEpoch, verifyGenesisEpoch } from './group-state.js';
import type { SignedGroupEpoch } from './group-state.js';
import type { NetworkAnnounceMessage } from './types.js';

export const NETWORK_ANNOUNCE_VERSION = 2;
export const MAX_ANNOUNCE_GROUPS = 64;
export const MAX_ANNOUNCE_AGE_MS = 5 * 60 * 1000;
const DOMAIN = new TextEncoder().encode('network.self.md/NetworkAnnounce/v2\0');
const textEncoder = new TextEncoder();
type AnnounceGroup = NetworkAnnounceMessage['groups'][number];

export function canonicalAnnouncePayload(
  protocolVersion: number,
  groups: AnnounceGroup[],
  timestamp: number,
): Uint8Array {
  assertAnnouncePayload(protocolVersion, groups, timestamp);
  const parts: Uint8Array[] = [
    DOMAIN,
    u16(protocolVersion),
    u64(timestamp),
    u16(groups.length),
  ];
  for (const group of groups) {
    parts.push(
      group.groupId,
      lp(textEncoder.encode(group.name)),
      lp(textEncoder.encode(group.selfMd)),
      u32(group.memberCount),
      lp(group.genesisEpochData),
      group.genesisSignature,
      group.genesisHash,
    );
  }
  return concatBytes(...parts);
}

export function signAnnounce(
  groups: AnnounceGroup[],
  timestamp: number,
  privateKey: Uint8Array,
  protocolVersion: number = NETWORK_ANNOUNCE_VERSION,
): Uint8Array {
  return sign(
    canonicalAnnouncePayload(protocolVersion, groups, timestamp),
    privateKey,
  );
}

export function verifyAnnounce(
  groups: AnnounceGroup[],
  timestamp: number,
  signature: Uint8Array,
  publicKey: Uint8Array,
  protocolVersion: number = NETWORK_ANNOUNCE_VERSION,
): boolean {
  try {
    return (
      signature instanceof Uint8Array &&
      signature.length === 64 &&
      verify(
        signature,
        canonicalAnnouncePayload(protocolVersion, groups, timestamp),
        publicKey,
      )
    );
  } catch {
    return false;
  }
}

export function networkAnnounceId(message: NetworkAnnounceMessage): Uint8Array {
  const payload = canonicalAnnouncePayload(
    message.protocolVersion,
    message.groups,
    message.timestamp,
  );
  return sha256(concatBytes(payload, message.signature));
}

/** Exhaustive announce schema validation, optionally including freshness. */
export function assertAnnounceShape(
  message: Pick<
    NetworkAnnounceMessage,
    'protocolVersion' | 'groups' | 'timestamp' | 'signature'
  >,
  now?: number,
): void {
  if ('type' in message) {
    assertExactKeys(
      message as unknown as Record<string, unknown>,
      ['type', 'protocolVersion', 'groups', 'signature', 'timestamp'],
      'NetworkAnnounce',
    );
  }
  assertAnnouncePayload(
    message.protocolVersion,
    message.groups,
    message.timestamp,
  );
  assertBytes(message.signature, 64, 'NetworkAnnounce signature');
  if (
    now !== undefined &&
    Math.abs(now - message.timestamp) > MAX_ANNOUNCE_AGE_MS
  ) {
    throw new Error('Stale NetworkAnnounce');
  }
  for (const group of message.groups) {
    assertExactKeys(
      group as unknown as Record<string, unknown>,
      [
        'groupId',
        'name',
        'selfMd',
        'memberCount',
        'genesisEpochData',
        'genesisSignature',
        'genesisHash',
      ],
      'announced group',
    );
  }
}

export function verifyAnnouncedGroupAuthority(
  group: AnnounceGroup,
  announcerPublicKey: Uint8Array,
): boolean {
  try {
    const signed: SignedGroupEpoch = {
      epoch: deserializeEpoch(group.genesisEpochData),
      signature: group.genesisSignature,
      hash: group.genesisHash,
    };
    return verifyGenesisEpoch(signed, toHex(group.groupId), announcerPublicKey);
  } catch {
    return false;
  }
}

function assertAnnouncePayload(
  protocolVersion: number,
  groups: AnnounceGroup[],
  timestamp: number,
): void {
  if (protocolVersion !== NETWORK_ANNOUNCE_VERSION) {
    throw new Error('Unsupported NetworkAnnounce version');
  }
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new Error('Invalid NetworkAnnounce timestamp');
  }
  if (!Array.isArray(groups) || groups.length > MAX_ANNOUNCE_GROUPS) {
    throw new Error('Too many announced groups');
  }
  let previous = '';
  for (const group of groups) {
    if (!group || typeof group !== 'object') {
      throw new Error('Invalid announced group');
    }
    assertBytes(group.groupId, 32, 'group id');
    const id = toHex(group.groupId);
    if (previous && id <= previous) {
      throw new Error('NetworkAnnounce groups are not canonical');
    }
    previous = id;
    assertString(group.name, 1, 128, 'group name');
    assertString(group.selfMd, 0, 16 * 1024, 'self.md');
    if (
      !Number.isSafeInteger(group.memberCount) ||
      group.memberCount < 1 ||
      group.memberCount > 100_000
    ) {
      throw new Error('Invalid member count');
    }
    if (
      !(group.genesisEpochData instanceof Uint8Array) ||
      group.genesisEpochData.length === 0 ||
      group.genesisEpochData.length > 4096
    ) {
      throw new Error('Invalid genesis epoch data');
    }
    assertBytes(group.genesisSignature, 64, 'genesis signature');
    assertBytes(group.genesisHash, 32, 'genesis hash');
  }
}

function assertBytes(value: unknown, length: number, label: string): void {
  if (!(value instanceof Uint8Array) || value.length !== length) {
    throw new Error(`Invalid ${label}`);
  }
}

function assertString(
  value: unknown,
  min: number,
  maxBytes: number,
  label: string,
): void {
  if (typeof value !== 'string') throw new Error(`Invalid ${label}`);
  const length = textEncoder.encode(value).length;
  if (length < min || length > maxBytes) throw new Error(`Invalid ${label}`);
}

function u16(value: number): Uint8Array {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value, false);
  return out;
}

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, false);
  return out;
}

function u64(value: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value), false);
  return out;
}

function lp(value: Uint8Array): Uint8Array {
  return concatBytes(u32(value.length), value);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(
    parts.reduce((length, part) => length + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function toHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: string[],
  label: string,
): void {
  const keys = Object.keys(value);
  if (
    keys.length !== allowed.length ||
    keys.some((key) => !allowed.includes(key))
  ) {
    throw new Error(`Invalid ${label} schema`);
  }
}
