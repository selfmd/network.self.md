import { Encoder } from 'cbor-x';
import { describe, expect, it } from 'vitest';
import {
  decodeMessage,
  encodeMessage,
  createGenesisEpoch,
  createSignedEpoch,
  generateIdentity,
  MessageType,
  signAuthenticatedMessage,
  serializeEpoch,
  verifyAuthenticatedMessage,
} from '../index.js';
import type {
  DirectEncryptedMessage,
  GroupEncryptedMessage,
  GroupManagementMessage,
  ProtocolMessage,
} from '../index.js';

const rawEncoder = new Encoder({ useRecords: false });
const fpA = 'y'.repeat(32);
const fpB = 'b'.repeat(32);
const bytes = (length: number, fill: number) =>
  new Uint8Array(length).fill(fill);
const anchorIdentity = generateIdentity();
const anchorGroupId = bytes(32, 1);
const anchorGenesis = createSignedEpoch(
  createGenesisEpoch(
    Buffer.from(anchorGroupId).toString('hex'),
    anchorIdentity.edPublicKey,
    1,
  ),
  anchorIdentity.edPrivateKey,
);
const anchorEpochData = serializeEpoch(anchorGenesis.epoch);

const goldenMessages: ProtocolMessage[] = [
  {
    type: MessageType.IdentityHandshake,
    edPublicKey: bytes(32, 1),
    xPublicKey: bytes(32, 2),
    noisePublicKey: bytes(32, 3),
    signature: bytes(64, 4),
    displayName: 'agent',
    protocolVersion: 2,
    timestamp: 1,
  },
  {
    type: MessageType.GroupSync,
    groupId: bytes(32, 1),
    members: [bytes(32, 2)],
    epoch: 0,
    timestamp: 2,
  },
  {
    type: MessageType.SenderKeyDistribution,
    protocolVersion: 1,
    recipientPublicKey: bytes(32, 1),
    ciphertext: bytes(16, 2),
    nonce: bytes(24, 3),
    timestamp: 4,
  },
  {
    type: MessageType.GroupMessage,
    groupId: bytes(32, 1),
    senderFingerprint: fpA,
    chainIndex: 2,
    epochVersion: 3,
    epochHash: bytes(32, 2),
    ciphertext: bytes(16, 3),
    nonce: bytes(24, 4),
    timestamp: 5,
    signature: bytes(64, 6),
  },
  {
    type: MessageType.DirectMessage,
    recipientFingerprint: fpB,
    senderFingerprint: fpA,
    ratchetPublicKey: bytes(32, 1),
    previousChainLength: 2,
    messageNumber: 3,
    ciphertext: bytes(16, 4),
    nonce: bytes(24, 5),
    timestamp: 6,
    signature: bytes(64, 7),
  },
  {
    type: MessageType.GroupManagement,
    groupId: bytes(32, 1),
    action: 'kick',
    targetFingerprint: fpB,
    senderFingerprint: fpA,
    recipientFingerprint: fpB,
    timestamp: 7,
    signature: bytes(64, 8),
  },
  {
    type: MessageType.TTYARequest,
    visitorId: 'visitor',
    message: 'hello',
    ipHash: 'hash',
    timestamp: 8,
  },
  {
    type: MessageType.TTYAResponse,
    visitorId: 'visitor',
    message: 'reply',
    timestamp: 9,
  },
  {
    type: MessageType.NetworkAnnounce,
    protocolVersion: 2,
    groups: [
      {
        groupId: bytes(32, 1),
        name: 'group',
        selfMd: '',
        memberCount: 1,
        genesisEpochData: anchorEpochData,
        genesisSignature: anchorGenesis.signature,
        genesisHash: anchorGenesis.hash,
      },
    ],
    signature: bytes(64, 2),
    timestamp: 10,
  },
  {
    type: MessageType.GroupEpoch,
    protocolVersion: 2,
    groupId: bytes(32, 1),
    epochData: anchorEpochData,
    signature: anchorGenesis.signature,
    hash: anchorGenesis.hash,
    senderFingerprint: fpA,
    recipientFingerprint: fpB,
    envelopeSignature: bytes(64, 5),
    timestamp: 11,
  },
  { type: MessageType.Ack, messageId: 'id', timestamp: 12 },
];

describe('protocol runtime validation', () => {
  it.each(goldenMessages)(
    'golden round-trips message type $type',
    (message) => {
      expect(decodeMessage(encodeMessage(message))).toEqual(message);
    },
  );

  it.each([
    ['wrong key size', { ...goldenMessages[0], edPublicKey: bytes(31, 1) }],
    ['bad envelope version', { ...goldenMessages[2], protocolVersion: 2 }],
    ['wrong nonce size', { ...goldenMessages[3], nonce: bytes(12, 1) }],
    ['non-integer counter', { ...goldenMessages[4], messageNumber: 1.5 }],
    ['missing action field', { ...goldenMessages[5], action: undefined }],
    ['extra field', { ...goldenMessages[10], unexpected: true }],
    [
      'duplicate group members',
      {
        ...goldenMessages[1],
        members: [bytes(32, 2), bytes(32, 2)],
      },
    ],
    [
      'oversized ciphertext',
      { ...goldenMessages[3], ciphertext: bytes(65_553, 1) },
    ],
    [
      'oversized UTF-8 display name',
      { ...goldenMessages[0], displayName: 'é'.repeat(65) },
    ],
    ['invalid nested epoch', { ...goldenMessages[9], epochData: bytes(1, 2) }],
    [
      'invalid announced genesis',
      {
        ...goldenMessages[8],
        groups: [
          {
            ...(
              goldenMessages[8] as Extract<
                ProtocolMessage,
                { type: typeof MessageType.NetworkAnnounce }
              >
            ).groups[0],
            genesisHash: bytes(32, 0),
          },
        ],
      },
    ],
  ])('rejects malformed payload: %s', (_label, malformed) => {
    expect(() => decodeMessage(rawEncoder.encode(malformed))).toThrow(
      /invalid message/i,
    );
  });

  it.each(
    goldenMessages.map((message) => [
      message.type,
      { ...message, unexpected: true },
    ]),
  )('rejects unknown fields for message type %s', (_type, malformed) => {
    expect(() => decodeMessage(rawEncoder.encode(malformed))).toThrow(
      /is not allowed/i,
    );
  });

  it('rejects malformed CBOR without exposing decoder errors', () => {
    expect(() => decodeMessage(new Uint8Array([0xff]))).toThrow(
      /invalid message/i,
    );
  });
});

describe('authenticated protocol payloads', () => {
  const sender = generateIdentity();
  const recipient = generateIdentity();

  function signedMessages() {
    const timestamp = 1_700_000_000_000;
    return [
      signAuthenticatedMessage<GroupEncryptedMessage>(
        {
          type: MessageType.GroupMessage,
          groupId: bytes(32, 1),
          senderFingerprint: sender.fingerprint,
          chainIndex: 3,
          epochVersion: 1,
          epochHash: bytes(32, 8),
          ciphertext: bytes(16, 2),
          nonce: bytes(24, 3),
          timestamp,
        },
        sender.edPrivateKey,
      ),
      signAuthenticatedMessage<DirectEncryptedMessage>(
        {
          type: MessageType.DirectMessage,
          senderFingerprint: sender.fingerprint,
          recipientFingerprint: recipient.fingerprint,
          ratchetPublicKey: bytes(32, 1),
          previousChainLength: 2,
          messageNumber: 3,
          ciphertext: bytes(16, 4),
          nonce: bytes(24, 5),
          timestamp,
        },
        sender.edPrivateKey,
      ),
      signAuthenticatedMessage<GroupManagementMessage>(
        {
          type: MessageType.GroupManagement,
          groupId: bytes(32, 1),
          action: 'kick',
          targetFingerprint: recipient.fingerprint,
          senderFingerprint: sender.fingerprint,
          recipientFingerprint: recipient.fingerprint,
          timestamp,
        },
        sender.edPrivateKey,
      ),
    ];
  }

  it.each(signedMessages())(
    'verifies an intact signed message type $type',
    (message) => {
      expect(verifyAuthenticatedMessage(message, sender.edPublicKey)).toBe(
        true,
      );
    },
  );

  it('keeps signatures valid across Buffer/Uint8Array wire normalization', () => {
    const timestamp = 1_700_000_000_000;
    const message = signAuthenticatedMessage<GroupManagementMessage>(
      {
        type: MessageType.GroupManagement,
        groupId: Buffer.alloc(32, 1),
        action: 'kick',
        targetFingerprint: recipient.fingerprint,
        senderFingerprint: sender.fingerprint,
        recipientFingerprint: recipient.fingerprint,
        timestamp,
      },
      sender.edPrivateKey,
    );
    const decoded = decodeMessage(
      encodeMessage(message),
    ) as GroupManagementMessage;
    expect(verifyAuthenticatedMessage(decoded, sender.edPublicKey)).toBe(true);
  });

  it.each(signedMessages())(
    'rejects context/ciphertext swaps for type $type',
    (message) => {
      const swapped =
        message.type === MessageType.DirectMessage ||
        message.type === MessageType.GroupManagement
          ? { ...message, recipientFingerprint: fpB }
          : { ...message, groupId: bytes(32, 9) };
      expect(verifyAuthenticatedMessage(swapped, sender.edPublicKey)).toBe(
        false,
      );
    },
  );

  it.each(signedMessages())(
    'rejects forged signatures for type $type',
    (message) => {
      expect(
        verifyAuthenticatedMessage(
          { ...message, signature: bytes(64, 0) },
          sender.edPublicKey,
        ),
      ).toBe(false);
    },
  );

  it.each(signedMessages())(
    'binds every encrypted/key/action field for type $type',
    (message) => {
      let tampered;
      switch (message.type) {
        case MessageType.GroupMessage:
        case MessageType.DirectMessage:
          tampered = {
            ...message,
            ciphertext: bytes(16, 9),
            nonce: bytes(24, 9),
          };
          break;
        case MessageType.GroupManagement:
          tampered = { ...message, action: 'promote' as const };
          break;
      }
      expect(verifyAuthenticatedMessage(tampered, sender.edPublicKey)).toBe(
        false,
      );
    },
  );
});
