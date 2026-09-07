export {
  MessageType,
  type MessageTypeValue,
  type IdentityHandshakeMessage,
  type GroupSyncMessage,
  type SenderKeyDistributionMessage,
  type GroupEncryptedMessage,
  type DirectEncryptedMessage,
  type GroupManagementMessage,
  type GroupEpochMessage,
  type TTYARequestMessage,
  type TTYAResponseMessage,
  type NetworkAnnounceMessage,
  type AckMessage,
  type ProtocolMessage,
  type AgentIdentity,
  type PeerInfo,
  type GroupInfo,
  type GroupMessage,
  type DirectMessage,
  type GroupInvite,
  type TTYAVisitorRequest,
} from './types.js';

export {
  encodeMessage,
  decodeMessage,
  frameMessage,
  parseFrame,
  validateProtocolMessage,
  MAX_FRAME_SIZE,
} from './messages.js';

export {
  authenticatedMessagePayload,
  authenticatedMessageId,
  signAuthenticatedMessage,
  verifyAuthenticatedMessage,
  type AuthenticatedProtocolMessage,
} from './message-auth.js';

export {
  NETWORK_ANNOUNCE_VERSION,
  MAX_ANNOUNCE_GROUPS,
  MAX_ANNOUNCE_AGE_MS,
  canonicalAnnouncePayload,
  assertAnnounceShape,
  signAnnounce,
  verifyAnnounce,
  networkAnnounceId,
  verifyAnnouncedGroupAuthority,
} from './announce-signature.js';

export {
  TTYA_AUTH_PROTOCOL,
  TTYA_AUTH_VERSION,
  TTYA_AUTH_NONCE_BYTES,
  TTYA_AUTH_PROOF_BYTES,
  TTYA_AUTH_SECRET_MIN_BYTES,
  TTYA_CHANNEL_BINDING_MIN_BYTES,
  TTYA_CHANNEL_BINDING_MAX_BYTES,
  MAX_TTYA_FRAME_SIZE,
  MAX_TTYA_CONTENT_BYTES,
  MAX_TTYA_USER_AGENT_BYTES,
  isTTYAAuthChallengeFrame,
  isTTYAAuthResponseFrame,
  isTTYAAuthConfirmationFrame,
  isTTYADataFrame,
  copyAndValidateTTYAAuthSecret,
  copyAndValidateTTYAChannelBinding,
  buildTTYAAuthProofPayload,
  buildTTYASessionKeyPayload,
  buildTTYADataProofPayload,
  TTYAFrameDecoder,
  type TTYAAuthRole,
  type TTYADataDirection,
  type TTYAAuthChallengeFrame,
  type TTYAAuthResponseFrame,
  type TTYAAuthConfirmationFrame,
  type TTYADataFrame,
  type TTYAAuthFrame,
} from './ttya-auth.js';

export {
  GROUP_EPOCH_ENVELOPE_VERSION,
  canonicalGroupEpochEnvelope,
  signGroupEpochEnvelope,
  verifyGroupEpochEnvelope,
  groupEpochEnvelopeId,
} from './epoch-envelope.js';

export {
  SENDER_KEY_ENVELOPE_VERSION,
  senderKeyEnvelopeId,
} from './sender-key-envelope.js';

export {
  SenderKeys,
  type SenderKeyState,
  type SenderKeyRecord,
  type SenderKeyDistributionPayload,
  SENDER_KEY_PROTOCOL_VERSION,
  SENDER_KEY_CAPABILITY,
  assertSenderKeyDistributionMessage,
} from './sender-keys.js';

export { DoubleRatchet, type DoubleRatchetState } from './double-ratchet.js';

export {
  type GroupMemberEntry,
  type GroupEpoch,
  type SignedGroupEpoch,
  serializeEpoch,
  deserializeEpoch,
  hashEpoch,
  createSignedEpoch,
  verifyEpoch,
  verifyGenesisEpoch,
  createGenesisEpoch,
  GROUP_EPOCH_FORMAT_VERSION,
  MAX_EPOCH_BYTES,
  MAX_GROUP_MEMBERS,
} from './group-state.js';
export * from './reliable-delivery.js';
