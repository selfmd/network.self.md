import { sign, verify } from '../crypto/signatures.js';
import { deserializeEpoch, verifyGenesisEpoch } from './group-state.js';
import type { NetworkAnnounceMessage } from './types.js';
import type { SignedGroupEpoch } from './group-state.js';

export const NETWORK_ANNOUNCE_VERSION = 1;
export const MAX_ANNOUNCE_GROUPS = 64;
export const MAX_ANNOUNCE_AGE_MS = 5 * 60 * 1000;
const DOMAIN = new TextEncoder().encode('network.self.md/NetworkAnnounce/v1\0');
const textEncoder = new TextEncoder();
type AnnounceGroup = NetworkAnnounceMessage['groups'][number];

export function canonicalAnnouncePayload(protocolVersion: number, groups: AnnounceGroup[], timestamp: number): Uint8Array {
  assertAnnounceShape({ protocolVersion, groups, timestamp, signature: new Uint8Array(64) });
  const parts: Uint8Array[] = [DOMAIN, u16(protocolVersion), u64(timestamp), u16(groups.length)];
  for (const group of groups) {
    parts.push(group.groupId, lp(textEncoder.encode(group.name)), lp(textEncoder.encode(group.selfMd)), u32(group.memberCount), lp(group.genesisEpochData), group.genesisSignature, group.genesisHash);
  }
  return concatBytes(...parts);
}

export function signAnnounce(
  groups: AnnounceGroup[],
  timestamp: number,
  privateKey: Uint8Array,
  protocolVersion = NETWORK_ANNOUNCE_VERSION,
): Uint8Array {
  return sign(canonicalAnnouncePayload(protocolVersion, groups, timestamp), privateKey);
}

export function verifyAnnounce(
  groups: AnnounceGroup[],
  timestamp: number,
  signature: Uint8Array,
  publicKey: Uint8Array,
  protocolVersion = NETWORK_ANNOUNCE_VERSION,
): boolean {
  try {
    return signature instanceof Uint8Array && signature.length === 64 && verify(signature, canonicalAnnouncePayload(protocolVersion, groups, timestamp), publicKey);
  } catch {
    return false;
  }
}

export function assertAnnounceShape(message: Pick<NetworkAnnounceMessage, 'protocolVersion' | 'groups' | 'timestamp' | 'signature'>, now?: number): void {
  if ('type' in message) assertExactKeys(message as unknown as Record<string, unknown>, ['type', 'protocolVersion', 'groups', 'signature', 'timestamp'], 'NetworkAnnounce');
  if (message.protocolVersion !== NETWORK_ANNOUNCE_VERSION) throw new Error('Unsupported NetworkAnnounce version');
  if (!Number.isSafeInteger(message.timestamp) || message.timestamp < 0) throw new Error('Invalid NetworkAnnounce timestamp');
  if (now !== undefined && Math.abs(now - message.timestamp) > MAX_ANNOUNCE_AGE_MS) throw new Error('Stale NetworkAnnounce');
  if (!(message.signature instanceof Uint8Array) || message.signature.length !== 64) throw new Error('Invalid NetworkAnnounce signature');
  if (!Array.isArray(message.groups) || message.groups.length > MAX_ANNOUNCE_GROUPS) throw new Error('Too many announced groups');
  const seen = new Set<string>();
  let previous = '';
  for (const group of message.groups) {
    if (!group || typeof group !== 'object') throw new Error('Invalid announced group');
    assertExactKeys(group as unknown as Record<string, unknown>, ['groupId', 'name', 'selfMd', 'memberCount', 'genesisEpochData', 'genesisSignature', 'genesisHash'], 'announced group');
    assertBytes(group.groupId, 32, 'group id');
    const id = toHex(group.groupId);
    if (seen.has(id)) throw new Error('Duplicate announced group');
    if (previous && id <= previous) throw new Error('NetworkAnnounce groups are not canonical');
    previous = id;
    seen.add(id);
    assertString(group.name, 1, 128, 'group name');
    assertString(group.selfMd, 0, 16 * 1024, 'self.md');
    if (!Number.isSafeInteger(group.memberCount) || group.memberCount < 1 || group.memberCount > 100_000) throw new Error('Invalid member count');
    if (!(group.genesisEpochData instanceof Uint8Array) || group.genesisEpochData.length === 0 || group.genesisEpochData.length > 4096) throw new Error('Invalid genesis epoch data');
    assertBytes(group.genesisSignature, 64, 'genesis signature');
    assertBytes(group.genesisHash, 32, 'genesis hash');
  }
}

export function verifyAnnouncedGroupAuthority(group: AnnounceGroup, announcerPublicKey: Uint8Array): boolean {
  try {
    const signed: SignedGroupEpoch = { epoch: deserializeEpoch(group.genesisEpochData), signature: group.genesisSignature, hash: group.genesisHash };
    return verifyGenesisEpoch(signed, toHex(group.groupId), announcerPublicKey);
  } catch {
    return false;
  }
}

function assertBytes(value: unknown, length: number, label: string): asserts value is Uint8Array { if (!(value instanceof Uint8Array) || value.length !== length) throw new Error(`Invalid ${label}`); }
function assertString(value: unknown, min: number, maxBytes: number, label: string): asserts value is string { if (typeof value !== 'string') throw new Error(`Invalid ${label}`); const length = textEncoder.encode(value).length; if (length < min || length > maxBytes) throw new Error(`Invalid ${label}`); }
function u16(value: number): Uint8Array { const out = new Uint8Array(2); new DataView(out.buffer).setUint16(0, value, false); return out; }
function u32(value: number): Uint8Array { const out = new Uint8Array(4); new DataView(out.buffer).setUint32(0, value, false); return out; }
function u64(value: number): Uint8Array { const out = new Uint8Array(8); new DataView(out.buffer).setBigUint64(0, BigInt(value), false); return out; }
function lp(value: Uint8Array): Uint8Array { return concatBytes(u32(value.length), value); }
function concatBytes(...parts: Uint8Array[]): Uint8Array { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let offset = 0; for (const part of parts) { out.set(part, offset); offset += part.length; } return out; }
function toHex(value: Uint8Array): string { return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join(''); }
function assertExactKeys(value: Record<string, unknown>, allowed: string[], label: string): void { const keys = Object.keys(value); if (keys.length !== allowed.length || keys.some((key) => !allowed.includes(key))) throw new Error(`Invalid ${label} schema`); }
