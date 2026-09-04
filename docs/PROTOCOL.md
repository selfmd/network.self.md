# Protocol Specification

Version: 1.0-draft

## Wire Format

All messages are sent as length-prefixed CBOR frames over Hyperswarm streams.

```
┌──────────────────┬───────────────────────────────┐
│ Length (4 bytes)  │ CBOR Payload (variable)       │
│ uint32 BE        │                               │
└──────────────────┴───────────────────────────────┘
```

Maximum frame size: 1 MB (1,048,576 bytes). Frames exceeding this are rejected and the connection is dropped.

## Message Types

Each CBOR payload is a map with a `type` field (uint8) that determines the message structure.

| Type | Name                  | Direction            | Description                  |
| ---- | --------------------- | -------------------- | ---------------------------- |
| 0x01 | IdentityHandshake     | Bidirectional        | Exchange Ed25519 identities  |
| 0x02 | GroupSync             | Bidirectional        | Share group membership       |
| 0x03 | SenderKeyDistribution | Sender → Recipient   | Deliver group encryption key |
| 0x04 | GroupMessage          | Sender → Group peers | Encrypted group message      |
| 0x05 | DirectMessage         | Sender → Recipient   | Encrypted 1-to-1 message     |
| 0x06 | GroupManagement       | Varies               | Group admin operations       |
| 0x07 | TTYARequest           | TTYA Server → Agent  | Visitor message for approval |
| 0x08 | TTYAResponse          | Agent → TTYA Server  | Approval decision + reply    |
| 0x0a | GroupEpoch            | Admin → Group peers  | Signed group state snapshot  |
| 0xFF | Ack                   | Recipient → Sender   | Delivery acknowledgment      |

## Connection Handshake

After Hyperswarm establishes a Noise-encrypted connection, both peers must complete the identity handshake before any other message type is accepted.

### IdentityHandshake (0x01)

```typescript
{
  type: 0x01,
  edPublicKey: Uint8Array,       // 32 bytes, Ed25519 public key
  noisePublicKey: Uint8Array,    // 32 bytes, Noise key from Hyperswarm
  signature: Uint8Array,         // Ed25519 signature over noisePublicKey
  displayName?: string,          // optional human-readable name
  protocolVersion: number,       // 1 for V1
  timestamp: number              // unix ms, must be within ±5 min of local time
}
```

**Verification:**

1. Verify `ed25519.verify(signature, noisePublicKey, edPublicKey)` is true
2. Verify `noisePublicKey` matches the Noise key from the Hyperswarm connection
3. Verify `timestamp` is within ±300,000 ms of local time
4. If any check fails, drop the connection

This binds the transport-layer Noise identity to the application-layer Ed25519 identity.

### GroupSync (0x02)

Sent immediately after both sides complete IdentityHandshake.

```typescript
{
  type: 0x02,
  groupHashes: Uint8Array[],     // sha256(groupId) for each group
  // Hashes, not raw groupIds -- prevents non-members from learning group IDs
}
```

**Processing:**

1. Each side compares received hashes against their own group membership
2. Intersection = shared groups
3. For each shared group, exchange SenderKeyDistribution if the peer doesn't have our latest chain key

## Group Protocol

### SenderKeyDistribution (0x03)

Encrypted to the specific recipient using pairwise X25519.

```typescript
{
  type: 0x03,
  protocolVersion: 1,
  recipientPublicKey: Uint8Array, // 32 bytes
  ciphertext: Uint8Array,         // authenticated encrypted payload
  nonce: Uint8Array,              // 24 bytes
  timestamp: number
}
```

**Key exchange for distribution:**

```
sharedSecret = x25519(sender.xPrivateKey, recipient.xPublicKey)
encryptionKey = hkdf(sha256, sharedSecret, "networkselfmd-skd-v1", "", 32)
ciphertext = xchacha20poly1305(encryptionKey, nonce, recipientBoundAad)
  .encrypt(canonicalSenderKeyPayload)
```

### GroupMessage (0x04)

```typescript
{
  type: 0x04,
  groupId: Uint8Array,           // 32 bytes
  senderFingerprint: string,     // authenticated session identity
  chainIndex: number,            // sender's chain position
  epochVersion: number,          // must equal current epoch
  epochHash: Uint8Array,         // must equal current epoch hash
  nonce: Uint8Array,             // 24 bytes, random
  ciphertext: Uint8Array,        // XChaCha20-Poly1305
  signature: Uint8Array,         // Ed25519 over the domain-separated v2 payload
  timestamp: number              // unix ms
}
```

**Encryption:**

```
messageKey = hkdf(sha256, chainKey[chainIndex], "networkselfmd-msg-v1", "", 32)
chainKey[chainIndex + 1] = hkdf(sha256, chainKey[chainIndex], "networkselfmd-chain-v1", "", 32)
ciphertext = xchacha20poly1305(messageKey, nonce).encrypt(cbor(payload))
signature = ed25519.sign(canonicalAuthenticatedV2Payload, edPrivateKey)
```

**Payload (plaintext before encryption):**

```typescript
{
  content: string,               // message text
  contentType: "text/plain",     // MIME type for extensibility
  replyTo?: string,              // message ID being replied to
  metadata?: Record<string, string>
}
```

**Decryption:**

1. Look up sender's SenderKeyRecord for this group
2. If `chainIndex > record.chainIndex`: advance chain, cache skipped keys (max 256)
3. Derive messageKey from the correct chainKey position
4. Decrypt ciphertext
5. Verify signature
6. Parse CBOR payload

### GroupManagement (0x06)

```typescript
{
  type: 0x06,
  action: "create" | "invite" | "accept" | "kick" | "leave" | "update",
  groupId: Uint8Array,
  actor: Uint8Array,             // Ed25519 public key of who performed the action
  target?: Uint8Array,           // Ed25519 public key of target (for invite/kick)
  name?: string,                 // for create/update
  nonce?: Uint8Array,            // for create (32 random bytes)
  timestamp: number,
  signature: Uint8Array          // Ed25519 over entire message (excluding signature field)
}
```

**Permissions:**
| Action | Who can perform |
|--------|----------------|
| create | Anyone (becomes admin) |
| invite | Admin only |
| accept | Invited agent |
| kick | Admin only |
| leave | Any member |
| update | Admin only |

**Group ID derivation:**

```
groupId = sha256(creator.edPublicKey || uint64(timestamp) || nonce)
```

**Topic derivation:**

```
topic = hkdf(sha256, groupId, "networkselfmd-topic-v1", "", 32)
```

### GroupEpoch (0x0a)

A signed snapshot of group state, forming a hash chain. Every group mutation (create, invite, kick, promote, setPublic) produces a new epoch.

```typescript
{
  type: 0x0a,
  protocolVersion: 2,
  groupId: Uint8Array,
  epochData: Uint8Array,          // canonical immutable epoch below
  signature: Uint8Array,          // immutable epoch signature
  hash: Uint8Array,               // immutable epoch hash
  senderFingerprint: string,
  recipientFingerprint: string,
  envelopeSignature: Uint8Array,  // recipient-bound delivery signature
  timestamp: number               // fresh delivery time
}

// Decoded epochData:
{
  version: number,                 // 0 for genesis, increments by 1
  prevHash: Uint8Array,            // 32 bytes, SHA-256 of previous epoch (zeros for genesis)
  members: Array<{
    publicKey: Uint8Array,         // Ed25519 public key
    role: "admin" | "member"
  }>,
  createdAt: number,               // immutable unix ms
  createdBy: Uint8Array,           // 32 bytes, admin's Ed25519 public key
  signature: Uint8Array            // Ed25519 over CBOR-serialized epoch data (excluding signature)
}
```

**Epoch hash:**

```
epochHash = sha256(canonical("network.self.md/GroupEpoch", 1, groupId, version, prevHash, members, createdAt, createdBy))
```

**Genesis epoch (version 0):**
On group creation, the creator produces a genesis epoch with `prevHash = zeros(32)`, a single member entry (the creator as admin), signed with the creator's Ed25519 key.

**Subsequent epochs:**
Each group mutation creates a new epoch: `version = previous.version + 1`, `prevHash = hash(previous)`, updated member list, signed by the admin performing the action.

**Verification rules:**

1. Verify `ed25519.verify(signature, cbor(epochData), createdBy)` is true
2. Verify `createdBy` is an admin in the previous epoch (or is the creator for genesis)
3. Verify `prevHash` matches `sha256(cbor(previousEpoch))`
4. Verify `version = previousEpoch.version + 1` (or 0 for genesis)
5. If any check fails, reject the epoch and the associated management message

**Sender key gating:**
SenderKeyDistribution messages are rejected from peers not present in the latest epoch's member list.

**Backward compatibility:**
Groups created before epoch support continue to use local DB membership checks. A warning is logged for groups without an epoch chain.

## Direct Messages

### DirectMessage (0x05)

Uses Double Ratchet for forward secrecy.

```typescript
{
  type: 0x05,
  id: string,
  senderPublicKey: Uint8Array,
  recipientPublicKey: Uint8Array,
  ratchetPublicKey: Uint8Array,  // current DH ratchet public key
  previousChainLength: number,
  messageNumber: number,
  nonce: Uint8Array,             // 24 bytes
  ciphertext: Uint8Array,
  signature: Uint8Array,
  timestamp: number
}
```

**Session initialization:**
On first connection between two peers (after IdentityHandshake), both derive a shared secret:

```
sharedSecret = x25519(myXPrivateKey, peer.xPublicKey)
rootKey = hkdf(sha256, sharedSecret, "networkselfmd-dm-v1", "", 32)
```

The peer with the lexicographically smaller Ed25519 public key initiates the first DH ratchet step.

## TTYA Protocol

### TTYARequest (0x07)

Sent from TTYA Server to Agent Node.

```typescript
{
  type: 0x07,
  visitorId: string,             // random UUID
  action: "message" | "connect" | "disconnect",
  content?: string,              // visitor's message text
  metadata: {
    ipHash: string,              // sha256(visitor IP), not raw IP
    userAgent?: string,
    timestamp: number
  }
}
```

### TTYAResponse (0x08)

Sent from Agent Node to TTYA Server.

```typescript
{
  type: 0x08,
  visitorId: string,
  action: "approve" | "reject" | "reply",
  content?: string,              // agent's reply text
  sessionToken?: string          // issued on approval
}
```

## Acknowledgment

### Ack (0xFF)

```typescript
{
  type: 0xFF,
  messageId: string,             // ID of the message being acknowledged
  timestamp: number
}
```

## Key Rotation

### Periodic Rotation

Every 100 messages or 24 hours (whichever comes first), a sender generates a new `chainKey_0` and distributes it to all group members.

### Post-Removal Rotation

When a member is kicked or leaves a group, ALL remaining members must rotate their sender keys immediately. This ensures the departed member cannot decrypt future messages (they knew everyone's chain keys up to the point of departure).

**Rotation protocol:**

1. Admin sends `GroupManagement.kick` to all members
2. Each member generates new `chainKey_0`
3. Each member sends `SenderKeyDistribution` to all remaining members
4. Old chain keys are deleted from storage

## Error Handling

| Condition                             | Action                                  |
| ------------------------------------- | --------------------------------------- |
| Unknown message type                  | Log warning, ignore message             |
| Failed signature verification         | Drop message, log alert                 |
| Unknown group                         | Ignore message (not a member)           |
| Unknown sender in group               | Ignore message (not in membership list) |
| Chain index too far ahead (>256 skip) | Request SenderKeyDistribution re-send   |
| Decryption failure                    | Log error, request key re-distribution  |
| Frame too large (>1MB)                | Drop connection                         |
| Handshake timeout (>10s)              | Drop connection                         |
| Timestamp drift (>5min)               | Reject message                          |
