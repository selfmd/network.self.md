import { Encoder, Decoder } from 'cbor-x';
import type { ProtocolMessage } from './types.js';
import { MessageType } from './types.js';

const encoder = new Encoder({ useRecords: false });
const decoder = new Decoder({ mapsAsObjects: true, useRecords: false });

export const MAX_FRAME_SIZE = 1_048_576;
const MAX_TEXT_SIZE = 65_536;
const FINGERPRINT = /^[ybndrfg8ejkmcpqxot1uwisza345h769]{32}$/;

function fail(field: string, reason: string): never {
  throw new Error(`Invalid message: ${field} ${reason}`);
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    fail('payload', 'must be a map');
  return value as Record<string, unknown>;
}

function keys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key))
      fail(key, 'is required');
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(key, 'is not allowed');
  }
}

function bytes(
  value: unknown,
  field: string,
  length?: number,
  min = 0,
): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array)) fail(field, 'must be bytes');
  if (length !== undefined && value.length !== length)
    fail(field, `must be ${length} bytes`);
  if (value.length < min) fail(field, `must be at least ${min} bytes`);
}

function integer(
  value: unknown,
  field: string,
  max = 0xffff_ffff,
): asserts value is number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > max
  ) {
    fail(field, `must be an integer from 0 to ${max}`);
  }
}

function timestamp(value: unknown): asserts value is number {
  integer(value, 'timestamp', Number.MAX_SAFE_INTEGER);
}

function string(
  value: unknown,
  field: string,
  min: number,
  max: number,
): asserts value is string {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    fail(field, `must be a string of ${min}-${max} characters`);
  }
}

function optionalString(
  value: unknown,
  field: string,
  min: number,
  max: number,
): void {
  if (value !== undefined) string(value, field, min, max);
}

function fingerprint(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !FINGERPRINT.test(value))
    fail(field, 'must be a valid fingerprint');
}

function validateHandshake(m: Record<string, unknown>): void {
  keys(
    m,
    [
      'type',
      'edPublicKey',
      'xPublicKey',
      'noisePublicKey',
      'signature',
      'protocolVersion',
      'timestamp',
    ],
    ['displayName'],
  );
  bytes(m.edPublicKey, 'edPublicKey', 32);
  bytes(m.xPublicKey, 'xPublicKey', 32);
  bytes(m.noisePublicKey, 'noisePublicKey', 32);
  bytes(m.signature, 'signature', 64);
  if (m.protocolVersion !== 2) fail('protocolVersion', 'must be 2');
  timestamp(m.timestamp);
  optionalString(m.displayName, 'displayName', 1, 128);
}

function validateGroupSync(m: Record<string, unknown>): void {
  keys(m, ['type', 'groupId', 'members', 'epoch', 'timestamp']);
  bytes(m.groupId, 'groupId', 32);
  if (!Array.isArray(m.members) || m.members.length > 1024)
    fail('members', 'must be an array with at most 1024 entries');
  for (const member of m.members) bytes(member, 'members[]', 32);
  integer(m.epoch, 'epoch');
  timestamp(m.timestamp);
}

function validateSenderKeyDistribution(m: Record<string, unknown>): void {
  keys(m, [
    'type',
    'groupId',
    'chainKey',
    'chainIndex',
    'signingPublicKey',
    'senderFingerprint',
    'recipientFingerprint',
    'timestamp',
    'signature',
  ]);
  bytes(m.groupId, 'groupId', 32);
  bytes(m.chainKey, 'chainKey', 32);
  integer(m.chainIndex, 'chainIndex');
  bytes(m.signingPublicKey, 'signingPublicKey', 32);
  fingerprint(m.senderFingerprint, 'senderFingerprint');
  fingerprint(m.recipientFingerprint, 'recipientFingerprint');
  timestamp(m.timestamp);
  bytes(m.signature, 'signature', 64);
}

function validateGroupMessage(m: Record<string, unknown>): void {
  keys(m, [
    'type',
    'groupId',
    'senderFingerprint',
    'chainIndex',
    'ciphertext',
    'nonce',
    'timestamp',
    'signature',
  ]);
  bytes(m.groupId, 'groupId', 32);
  fingerprint(m.senderFingerprint, 'senderFingerprint');
  integer(m.chainIndex, 'chainIndex');
  bytes(m.ciphertext, 'ciphertext', undefined, 16);
  if ((m.ciphertext as Uint8Array).length > MAX_FRAME_SIZE)
    fail('ciphertext', 'is too large');
  bytes(m.nonce, 'nonce', 24);
  timestamp(m.timestamp);
  bytes(m.signature, 'signature', 64);
}

function validateDirectMessage(m: Record<string, unknown>): void {
  keys(m, [
    'type',
    'recipientFingerprint',
    'senderFingerprint',
    'ratchetPublicKey',
    'previousChainLength',
    'messageNumber',
    'ciphertext',
    'nonce',
    'timestamp',
    'signature',
  ]);
  fingerprint(m.recipientFingerprint, 'recipientFingerprint');
  fingerprint(m.senderFingerprint, 'senderFingerprint');
  bytes(m.ratchetPublicKey, 'ratchetPublicKey', 32);
  integer(m.previousChainLength, 'previousChainLength');
  integer(m.messageNumber, 'messageNumber');
  bytes(m.ciphertext, 'ciphertext', undefined, 16);
  if ((m.ciphertext as Uint8Array).length > MAX_FRAME_SIZE)
    fail('ciphertext', 'is too large');
  bytes(m.nonce, 'nonce', 24);
  timestamp(m.timestamp);
  bytes(m.signature, 'signature', 64);
}

function validateGroupManagement(m: Record<string, unknown>): void {
  keys(
    m,
    [
      'type',
      'groupId',
      'action',
      'senderFingerprint',
      'recipientFingerprint',
      'timestamp',
      'signature',
    ],
    ['targetFingerprint', 'groupName'],
  );
  bytes(m.groupId, 'groupId', 32);
  if (
    !['create', 'invite', 'join', 'leave', 'kick', 'promote'].includes(
      m.action as string,
    )
  )
    fail('action', 'is invalid');
  fingerprint(m.senderFingerprint, 'senderFingerprint');
  fingerprint(m.recipientFingerprint, 'recipientFingerprint');
  timestamp(m.timestamp);
  bytes(m.signature, 'signature', 64);
  if (m.targetFingerprint !== undefined)
    fingerprint(m.targetFingerprint, 'targetFingerprint');
  optionalString(m.groupName, 'groupName', 1, 256);
  if (
    (m.action === 'invite' || m.action === 'kick' || m.action === 'promote') &&
    m.targetFingerprint === undefined
  ) {
    fail('targetFingerprint', `is required for ${String(m.action)}`);
  }
  if (m.action === 'invite' && m.groupName === undefined)
    fail('groupName', 'is required for invite');
}

function validateTTYARequest(m: Record<string, unknown>): void {
  keys(m, ['type', 'visitorId', 'message', 'ipHash', 'timestamp']);
  string(m.visitorId, 'visitorId', 1, 128);
  string(m.message, 'message', 1, MAX_TEXT_SIZE);
  string(m.ipHash, 'ipHash', 1, 128);
  timestamp(m.timestamp);
}

function validateTTYAResponse(m: Record<string, unknown>): void {
  keys(m, ['type', 'visitorId', 'message', 'timestamp']);
  string(m.visitorId, 'visitorId', 1, 128);
  string(m.message, 'message', 0, MAX_TEXT_SIZE);
  timestamp(m.timestamp);
}

function validateNetworkAnnounce(m: Record<string, unknown>): void {
  keys(m, ['type', 'groups', 'signature', 'timestamp']);
  if (!Array.isArray(m.groups) || m.groups.length > 256)
    fail('groups', 'must be an array with at most 256 entries');
  for (const item of m.groups) {
    const group = object(item);
    keys(group, ['groupId', 'name', 'selfMd', 'memberCount']);
    bytes(group.groupId, 'groups[].groupId', 32);
    string(group.name, 'groups[].name', 1, 256);
    string(group.selfMd, 'groups[].selfMd', 0, MAX_TEXT_SIZE);
    integer(group.memberCount, 'groups[].memberCount', 1_000_000);
  }
  bytes(m.signature, 'signature', 64);
  timestamp(m.timestamp);
}

function validateGroupEpoch(m: Record<string, unknown>): void {
  keys(m, ['type', 'groupId', 'epochData', 'signature', 'hash', 'timestamp']);
  bytes(m.groupId, 'groupId', 32);
  bytes(m.epochData, 'epochData', undefined, 1);
  if ((m.epochData as Uint8Array).length > MAX_FRAME_SIZE)
    fail('epochData', 'is too large');
  bytes(m.signature, 'signature', 64);
  bytes(m.hash, 'hash', 32);
  timestamp(m.timestamp);
}

function validateAck(m: Record<string, unknown>): void {
  keys(m, ['type', 'messageId', 'timestamp']);
  string(m.messageId, 'messageId', 1, 128);
  timestamp(m.timestamp);
}

export function validateProtocolMessage(
  value: unknown,
): asserts value is ProtocolMessage {
  const m = object(value);
  if (!Object.prototype.hasOwnProperty.call(m, 'type'))
    fail('type', 'is required');
  if (!Number.isInteger(m.type)) fail('type', 'must be an integer');
  switch (m.type) {
    case MessageType.IdentityHandshake:
      validateHandshake(m);
      break;
    case MessageType.GroupSync:
      validateGroupSync(m);
      break;
    case MessageType.SenderKeyDistribution:
      validateSenderKeyDistribution(m);
      break;
    case MessageType.GroupMessage:
      validateGroupMessage(m);
      break;
    case MessageType.DirectMessage:
      validateDirectMessage(m);
      break;
    case MessageType.GroupManagement:
      validateGroupManagement(m);
      break;
    case MessageType.TTYARequest:
      validateTTYARequest(m);
      break;
    case MessageType.TTYAResponse:
      validateTTYAResponse(m);
      break;
    case MessageType.NetworkAnnounce:
      validateNetworkAnnounce(m);
      break;
    case MessageType.GroupEpoch:
      validateGroupEpoch(m);
      break;
    case MessageType.Ack:
      validateAck(m);
      break;
    default:
      throw new Error(`Invalid message type: ${String(m.type)}`);
  }
}

export function encodeMessage(message: ProtocolMessage): Uint8Array {
  validateProtocolMessage(message);
  return encoder.encode(message);
}

export function decodeMessage(encoded: Uint8Array): ProtocolMessage {
  if (
    !(encoded instanceof Uint8Array) ||
    encoded.length === 0 ||
    encoded.length > MAX_FRAME_SIZE
  ) {
    throw new Error('Invalid message: encoded payload size is out of range');
  }
  let decoded: unknown;
  try {
    decoded = decoder.decode(encoded);
  } catch (error) {
    throw new Error('Invalid message: malformed CBOR payload', {
      cause: error,
    });
  }
  validateProtocolMessage(decoded);
  return decoded;
}

export function frameMessage(message: ProtocolMessage): Uint8Array {
  const payload = encodeMessage(message);
  if (payload.length > MAX_FRAME_SIZE)
    throw new Error(
      `Message exceeds MAX_FRAME_SIZE: ${payload.length} > ${MAX_FRAME_SIZE}`,
    );
  const frame = new Uint8Array(4 + payload.length);
  new DataView(frame.buffer).setUint32(0, payload.length, false);
  frame.set(payload, 4);
  return frame;
}

export function parseFrame(
  buffer: Uint8Array,
): { message: ProtocolMessage; bytesConsumed: number } | null {
  if (!(buffer instanceof Uint8Array)) throw new Error('Invalid frame buffer');
  if (buffer.length < 4) return null;
  const view = new DataView(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength,
  );
  const payloadLength = view.getUint32(0, false);
  if (payloadLength === 0) throw new Error('Invalid frame: empty payload');
  if (payloadLength > MAX_FRAME_SIZE)
    throw new Error(
      `Frame exceeds MAX_FRAME_SIZE: ${payloadLength} > ${MAX_FRAME_SIZE}`,
    );
  if (buffer.length < 4 + payloadLength) return null;
  const message = decodeMessage(buffer.slice(4, 4 + payloadLength));
  return { message, bytesConsumed: 4 + payloadLength };
}
