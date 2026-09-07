import { Encoder, Decoder } from 'cbor-x';
import type { ProtocolMessage } from './types.js';
import { MessageType } from './types.js';
import {
  deserializeEpoch,
  hashEpoch,
  verifyGenesisEpoch,
} from './group-state.js';
import { SENDER_KEY_PROTOCOL_VERSION } from './sender-keys.js';

const encoder = new Encoder({ useRecords: false });
const decoder = new Decoder({ mapsAsObjects: true, useRecords: false });

export const MAX_FRAME_SIZE = 1_048_576;
const MAX_TEXT_SIZE = 65_536;
const MAX_CIPHERTEXT_SIZE = MAX_TEXT_SIZE + 16;
const MAX_EPOCH_SIZE = 256 * 1024;
const MAX_GENESIS_SIZE = 4096;
const FINGERPRINT = /^[ybndrfg8ejkmcpqxot1uwisza345h769]{32}$/;
const textEncoder = new TextEncoder();

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
  const length =
    typeof value === 'string' ? textEncoder.encode(value).length : -1;
  if (typeof value !== 'string' || length < min || length > max) {
    fail(field, `must be a string of ${min}-${max} UTF-8 bytes`);
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
    ['displayName', 'capabilities'],
  );
  bytes(m.edPublicKey, 'edPublicKey', 32);
  bytes(m.xPublicKey, 'xPublicKey', 32);
  bytes(m.noisePublicKey, 'noisePublicKey', 32);
  bytes(m.signature, 'signature', 64);
  if (m.protocolVersion !== 3) fail('protocolVersion', 'must be 3');
  timestamp(m.timestamp);
  optionalString(m.displayName, 'displayName', 1, 128);
  if (m.capabilities !== undefined) {
    if (!Array.isArray(m.capabilities) || m.capabilities.length > 32)
      fail('capabilities', 'must be an array with at most 32 entries');
    const seen = new Set<string>();
    for (const capability of m.capabilities) {
      string(capability, 'capabilities[]', 1, 128);
      if (seen.has(capability)) fail('capabilities', 'must not contain duplicates');
      seen.add(capability);
    }
  }
}

function validateGroupSync(m: Record<string, unknown>): void {
  keys(m, ['type', 'groupId', 'members', 'epoch', 'timestamp']);
  bytes(m.groupId, 'groupId', 32);
  if (!Array.isArray(m.members) || m.members.length > 1024)
    fail('members', 'must be an array with at most 1024 entries');
  const seen = new Set<string>();
  for (const member of m.members) {
    bytes(member, 'members[]', 32);
    const key = toHex(member);
    if (seen.has(key)) fail('members', 'must not contain duplicates');
    seen.add(key);
  }
  integer(m.epoch, 'epoch');
  timestamp(m.timestamp);
}

function validateSenderKeyDistribution(m: Record<string, unknown>): void {
  keys(m, [
    'type',
    'protocolVersion',
    'recipientPublicKey',
    'ciphertext',
    'nonce',
    'timestamp',
  ]);
  if (m.protocolVersion !== SENDER_KEY_PROTOCOL_VERSION)
    fail('protocolVersion', `must be ${SENDER_KEY_PROTOCOL_VERSION}`);
  bytes(m.recipientPublicKey, 'recipientPublicKey', 32);
  bytes(m.ciphertext, 'ciphertext', undefined, 16);
  if ((m.ciphertext as Uint8Array).length > MAX_TEXT_SIZE)
    fail('ciphertext', 'is too large');
  bytes(m.nonce, 'nonce', 24);
  timestamp(m.timestamp);
}

function validateGroupMessage(m: Record<string, unknown>): void {
  keys(m, [
    'type',
    'groupId',
    'senderFingerprint',
    'chainIndex',
    'generationId',
    'epochVersion',
    'epochHash',
    'ciphertext',
    'nonce',
    'timestamp',
    'signature',
  ]);
  bytes(m.groupId, 'groupId', 32);
  fingerprint(m.senderFingerprint, 'senderFingerprint');
  integer(m.chainIndex, 'chainIndex');
  bytes(m.generationId, 'generationId', 16);
  integer(m.epochVersion, 'epochVersion');
  bytes(m.epochHash, 'epochHash', 32);
  bytes(m.ciphertext, 'ciphertext', undefined, 16);
  if ((m.ciphertext as Uint8Array).length > MAX_CIPHERTEXT_SIZE)
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
  if ((m.ciphertext as Uint8Array).length > MAX_CIPHERTEXT_SIZE)
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
    [
      'targetFingerprint',
      'groupName',
      'selfMd',
      'isPublic',
      'metadataVersion',
      'inviteId',
      'epochVersion',
      'epochHash',
      'genesisEpochData',
      'genesisSignature',
      'genesisHash',
    ],
  );
  bytes(m.groupId, 'groupId', 32);
  if (
    ![
      'create',
      'invite',
      'accept',
      'sync-request',
      'join',
      'leave',
      'kick',
      'promote',
      'metadata',
    ].includes(m.action as string)
  )
    fail('action', 'is invalid');
  fingerprint(m.senderFingerprint, 'senderFingerprint');
  fingerprint(m.recipientFingerprint, 'recipientFingerprint');
  timestamp(m.timestamp);
  bytes(m.signature, 'signature', 64);
  if (m.targetFingerprint !== undefined)
    fingerprint(m.targetFingerprint, 'targetFingerprint');
  optionalString(m.groupName, 'groupName', 1, 128);
  if (m.action === 'metadata') {
    if (typeof m.selfMd !== 'string') fail('selfMd', 'is required for metadata');
    optionalString(m.selfMd, 'selfMd', 0, 16 * 1024);
    if (typeof m.isPublic !== 'boolean') fail('isPublic', 'must be boolean');
    integer(m.metadataVersion, 'metadataVersion');
    integer(m.epochVersion, 'epochVersion');
    bytes(m.epochHash, 'epochHash', 32);
  } else if (m.selfMd !== undefined || m.isPublic !== undefined || m.metadataVersion !== undefined) {
    fail('metadata', 'fields require metadata action');
  }
  optionalString(m.inviteId, 'inviteId', 1, 128);
  if (m.epochVersion !== undefined) integer(m.epochVersion, 'epochVersion');
  if (m.epochHash !== undefined) bytes(m.epochHash, 'epochHash', 32);
  if (m.genesisEpochData !== undefined) {
    bytes(m.genesisEpochData, 'genesisEpochData', undefined, 1);
    if ((m.genesisEpochData as Uint8Array).length > MAX_GENESIS_SIZE)
      fail('genesisEpochData', 'is too large');
  }
  if (m.genesisSignature !== undefined)
    bytes(m.genesisSignature, 'genesisSignature', 64);
  if (m.genesisHash !== undefined) bytes(m.genesisHash, 'genesisHash', 32);
  if (
    (m.action === 'invite' || m.action === 'kick' || m.action === 'promote') &&
    m.targetFingerprint === undefined
  ) {
    fail('targetFingerprint', `is required for ${String(m.action)}`);
  }
  if (m.action === 'invite') {
    if (m.groupName === undefined) fail('groupName', 'is required for invite');
    if (m.inviteId === undefined) fail('inviteId', 'is required for invite');
    if (m.epochVersion === undefined)
      fail('epochVersion', 'is required for invite');
    if (m.epochHash === undefined) fail('epochHash', 'is required for invite');
    if (m.genesisEpochData === undefined)
      fail('genesisEpochData', 'is required for invite');
    if (m.genesisSignature === undefined)
      fail('genesisSignature', 'is required for invite');
    if (m.genesisHash === undefined)
      fail('genesisHash', 'is required for invite');
    validateGenesisAnchor(
      m.groupId as Uint8Array,
      m.genesisEpochData as Uint8Array,
      m.genesisSignature as Uint8Array,
      m.genesisHash as Uint8Array,
      'invite',
    );
  } else if (m.action === 'accept') {
    if (m.targetFingerprint === undefined)
      fail('targetFingerprint', 'is required for accept');
    if (m.inviteId === undefined) fail('inviteId', 'is required for accept');
    if (m.epochVersion === undefined)
      fail('epochVersion', 'is required for accept');
    if (m.epochHash === undefined) fail('epochHash', 'is required for accept');
  } else if (m.action === 'sync-request') {
    if (m.epochVersion === undefined)
      fail('epochVersion', 'is required for sync-request');
    if (m.epochHash === undefined)
      fail('epochHash', 'is required for sync-request');
  } else if (
    m.genesisEpochData !== undefined ||
    m.genesisSignature !== undefined ||
    m.genesisHash !== undefined
  ) {
    fail('genesisEpochData', 'is only allowed for invite');
  }
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
  keys(m, ['type', 'protocolVersion', 'groups', 'signature', 'timestamp']);
  if (m.protocolVersion !== 2) fail('protocolVersion', 'must be 2');
  if (!Array.isArray(m.groups) || m.groups.length > 64)
    fail('groups', 'must be an array with at most 64 entries');
  let previous = '';
  for (const item of m.groups) {
    const group = object(item);
    keys(group, [
      'groupId',
      'name',
      'selfMd',
      'memberCount',
      'genesisEpochData',
      'genesisSignature',
      'genesisHash',
    ]);
    bytes(group.groupId, 'groups[].groupId', 32);
    const id = Array.from(group.groupId as Uint8Array, (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
    if (previous && id <= previous)
      fail('groups', 'must contain unique group IDs in ascending order');
    previous = id;
    string(group.name, 'groups[].name', 1, 128);
    string(group.selfMd, 'groups[].selfMd', 0, 16 * 1024);
    integer(group.memberCount, 'groups[].memberCount', 100_000);
    if ((group.memberCount as number) < 1)
      fail('groups[].memberCount', 'must be at least 1');
    bytes(group.genesisEpochData, 'groups[].genesisEpochData', undefined, 1);
    if ((group.genesisEpochData as Uint8Array).length > MAX_GENESIS_SIZE)
      fail('groups[].genesisEpochData', 'is too large');
    bytes(group.genesisSignature, 'groups[].genesisSignature', 64);
    bytes(group.genesisHash, 'groups[].genesisHash', 32);
    validateGenesisAnchor(
      group.groupId as Uint8Array,
      group.genesisEpochData as Uint8Array,
      group.genesisSignature as Uint8Array,
      group.genesisHash as Uint8Array,
      'groups[]',
    );
  }
  bytes(m.signature, 'signature', 64);
  timestamp(m.timestamp);
}

function validateGroupEpoch(m: Record<string, unknown>): void {
  keys(m, [
    'type',
    'protocolVersion',
    'groupId',
    'epochData',
    'signature',
    'hash',
    'senderFingerprint',
    'recipientFingerprint',
    'envelopeSignature',
    'timestamp',
  ]);
  if (m.protocolVersion !== 2) fail('protocolVersion', 'must be 2');
  bytes(m.groupId, 'groupId', 32);
  bytes(m.epochData, 'epochData', undefined, 1);
  if ((m.epochData as Uint8Array).length > MAX_EPOCH_SIZE)
    fail('epochData', 'is too large');
  bytes(m.signature, 'signature', 64);
  bytes(m.hash, 'hash', 32);
  fingerprint(m.senderFingerprint, 'senderFingerprint');
  fingerprint(m.recipientFingerprint, 'recipientFingerprint');
  bytes(m.envelopeSignature, 'envelopeSignature', 64);
  timestamp(m.timestamp);
  let epoch;
  try {
    epoch = deserializeEpoch(m.epochData as Uint8Array);
  } catch {
    fail('epochData', 'contains an invalid group epoch');
  }
  if (epoch.groupId !== toHex(m.groupId as Uint8Array))
    fail('epochData', 'groupId does not match envelope');
  if (!bytesEqual(hashEpoch(m.epochData as Uint8Array), m.hash as Uint8Array))
    fail('hash', 'does not match epochData');
}

function validateGenesisAnchor(
  groupId: Uint8Array,
  epochData: Uint8Array,
  signature: Uint8Array,
  hash: Uint8Array,
  field: string,
): void {
  try {
    const epoch = deserializeEpoch(epochData);
    if (
      !verifyGenesisEpoch(
        { epoch, signature, hash },
        toHex(groupId),
        epoch.createdBy,
      )
    ) {
      fail(field, 'contains an invalid genesis trust anchor');
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith('Invalid message:')
    ) {
      throw error;
    }
    fail(field, 'contains an invalid genesis trust anchor');
  }
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

function validateAck(m: Record<string, unknown>): void {
  keys(m, ['type', 'messageId', 'timestamp']);
  string(m.messageId, 'messageId', 1, 128);
  timestamp(m.timestamp);
}

function validateDelivery(m: Record<string, unknown>): void {
  keys(m, ['type', 'id', 'senderFingerprint', 'recipientFingerprint', 'timestamp', 'signature',
    ...(m.type === MessageType.ReliableDelivery ? ['contentHash', 'createdAt', 'expiresAt', 'message'] : [])]);
  string(m.id, 'id', 1, 128);
  fingerprint(m.senderFingerprint, 'senderFingerprint');
  fingerprint(m.recipientFingerprint, 'recipientFingerprint');
  timestamp(m.timestamp);
  bytes(m.signature, 'signature', 64);
  if (m.type === MessageType.ReliableDelivery) {
    timestamp(m.createdAt); timestamp(m.expiresAt);
    if (typeof m.contentHash !== 'string' || !/^[0-9a-f]{64}$/.test(m.contentHash)) fail('contentHash', 'invalid');
    const inner = object(m.message);
    if (inner.type === MessageType.GroupMessage) validateGroupMessage(inner);
    else if (inner.type === MessageType.DirectMessage) validateDirectMessage(inner);
    else fail('message', 'must be group or direct');
  }
}

export function validateProtocolMessage(
  value: unknown,
): asserts value is ProtocolMessage {
  const m = object(value);
  if (!Object.prototype.hasOwnProperty.call(m, 'type'))
    fail('type', 'is required');
  if (!Number.isInteger(m.type)) fail('type', 'must be an integer');
  switch (m.type) {
    case MessageType.ReliableDelivery:
    case MessageType.DeliveryReceipt:
      validateDelivery(m);
      break;
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
