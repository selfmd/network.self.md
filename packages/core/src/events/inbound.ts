export type InboundMessageKind = 'group' | 'dm';

// Local-only. Carries decrypted plaintext. Never serialized to public
// surfaces (census, heartbeat, logs). Consumers: owner's agent runtime.
export interface PrivateInboundMessageEvent {
  kind: InboundMessageKind;
  messageId: string;
  groupId?: Uint8Array;
  senderPublicKey: Uint8Array;
  senderFingerprint: string;
  plaintext: Uint8Array;
  timestamp: number;
  receivedAt: number;
}

// Metadata-only. Safe for public logs, census, future heartbeat/dashboard.
// Never contains plaintext or ciphertext bytes.
export interface PublicActivityEvent {
  kind: InboundMessageKind;
  groupIdHex?: string;
  senderFingerprint: string;
  timestamp: number;
  byteLength: number;
}
