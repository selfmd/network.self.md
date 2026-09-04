# Protocol Specification

Version: 2.0-draft

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
  xPublicKey: Uint8Array,        // 32 bytes, X25519 public key used for DMs
  noisePublicKey: Uint8Array,    // 32 bytes, Noise key from Hyperswarm
  signature: Uint8Array,         // Ed25519 signature over the bound transcript
  displayName?: string,          // optional human-readable name
  protocolVersion: number,       // 2; other versions are incompatible
  capabilities: ["sender-key-v2", "group-epoch-v1"],
  timestamp: number              // unix ms, must be within ±5 min of local time
}
```

**Verification:**
Version 2 is intentionally not wire-compatible with version 1. A peer that sends any
other `protocolVersion` fails the handshake explicitly and its stream is destroyed.
The v2 capability profile is fixed: peers must advertise exactly `sender-key-v2` and
`group-epoch-v1`; missing, duplicate, or unknown capabilities fail the handshake.

The signature covers exactly 178 canonical bytes; no CBOR encoding, field lengths, or
optional fields participate in this transcript:

| Offset | Size | Encoding    | Value                                     |
| ------ | ---- | ----------- | ----------------------------------------- |
| 0      | 38   | ASCII bytes | `network.self.md/identity-handshake/v2\0` |
| 38     | 4    | uint32 BE   | `protocolVersion` (= 2)                   |
| 42     | 32   | raw bytes   | sender's `noisePublicKey`                 |
| 74     | 32   | raw bytes   | sender's `xPublicKey`                     |
| 106    | 8    | uint64 BE   | `timestamp` in Unix milliseconds          |
| 114    | 64   | raw bytes   | connection's Noise `handshakeHash`        |

1. Require protocol version 2 and exact key/signature/transcript field lengths
2. Verify `noisePublicKey` matches `socket.remotePublicKey`
3. Verify `timestamp` is within ±300,000 ms of local time
4. Verify the Ed25519 signature over the full transcript, including `socket.handshakeHash`
5. Reject a second identity handshake on an already-verified connection
6. If any check fails, drop the connection

Before authentication, any application frame is a protocol violation and destroys the
stream; such frames are never accumulated for later replay. Once the handshake has been
validated, a post-handshake tail may arrive before routing is installed (including split
transport chunks). That tail is bounded to 65,536 framed bytes and released atomically by
the transition to `ready`; any excess destroys the stream.

This binds the transport-layer Noise identity and DM key to the application-layer
Ed25519 identity, and prevents a captured handshake from being replayed on another
Noise connection.

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
  protocolVersion: 2,
  recipientPublicKey: Uint8Array, // 32-byte recipient Ed25519 key
  ciphertext: Uint8Array,         // encrypted payload below
  nonce: Uint8Array,              // 24 bytes
  timestamp: number
}

// XChaCha20-Poly1305 plaintext (never exposed on the wire)
{
  protocolVersion: 2,
  groupId: Uint8Array,
  generationId: Uint8Array,      // 16-byte random identifier, replaced on rotation
  sequence: number,              // durable, strictly increasing per group/sender
  chainKey: Uint8Array,
  chainIndex: number,
  signingPublicKey: Uint8Array,
  epochVersion: number,
  epochHash: Uint8Array,
  timestamp: number
}
```

**Key exchange for distribution:**

```
sharedSecret = x25519(sender.xPrivateKey, recipient.xPublicKey)
context = type || protocolVersion || sender.edPublicKey || recipient.edPublicKey || timestamp
encryptionKey = hkdf(sha256, sharedSecret,
  "networkselfmd-sender-key-distribution-key-v1", context, 32)
aad = "networkselfmd-sender-key-distribution-aad-v1" || context
ciphertext = xchacha20poly1305(encryptionKey, nonce, aad).encrypt(payload)
```

The receiver derives the key from the authenticated session's X25519 key,
requires `signingPublicKey` to equal `session.peerPublicKey`, and accepts the
payload only when sender and recipient are members of the referenced latest
signed epoch. Unknown groups, stale epochs, and nonmembers are rejected without
storing any sender-key record. The receiver durably rejects a sequence that is not newer
than the stored sequence and rejects a chain-index rollback within one generation.

### NetworkAnnounce (0x09)

Network announcements use a fixed binary signing payload prefixed with
`network.self.md/NetworkAnnounce/v1\0`. Groups are sorted by their 32-byte ID and all
strings/blobs use explicit big-endian length prefixes. Each entry includes the exact signed
genesis epoch (v0, zero previous hash, one creator-admin); the authenticated announcer must
be that creator. Receivers enforce schema and size limits, ±5 minute freshness, monotonic
durable replay state, 10 announcements/minute/peer, 64 groups/message, and a bounded
1,000-row/24-hour discovery cache. An existing group ID can only be updated by the pinned
creator and genesis hash.

### GroupMessage (0x04)

```typescript
{
  type: 0x04,
  id: string,                    // unique message ID (cuid2)
  groupId: Uint8Array,           // 32 bytes
  senderPublicKey: Uint8Array,   // 32 bytes, Ed25519
  chainIndex: number,            // sender's chain position
  nonce: Uint8Array,             // 24 bytes, random
  ciphertext: Uint8Array,        // XChaCha20-Poly1305
  signature: Uint8Array,         // Ed25519 over (groupId || chainIndex || nonce || ciphertext)
  timestamp: number              // unix ms
}
```

**Encryption:**

```
messageKey = hkdf(sha256, chainKey[chainIndex], "networkselfmd-msg-v1", "", 32)
chainKey[chainIndex + 1] = hkdf(sha256, chainKey[chainIndex], "networkselfmd-chain-v1", "", 32)
ciphertext = xchacha20poly1305(messageKey, nonce).encrypt(cbor(payload))
signature = ed25519.sign(sha256(groupId || uint32(chainIndex) || nonce || ciphertext), edPrivateKey)
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
  groupId: string,
  version: number,                 // 0 for genesis, increments by 1
  prevHash: Uint8Array,            // 32 bytes, SHA-256 of previous epoch (zeros for genesis)
  members: Array<{
    publicKey: Uint8Array,         // Ed25519 public key
    role: "admin" | "member"
  }>,
  timestamp: number,               // unix ms
  createdBy: Uint8Array,           // 32 bytes, admin's Ed25519 public key
  signature: Uint8Array            // Ed25519 over CBOR-serialized epoch data (excluding signature)
}
```

**Epoch hash:**

```
epochHash = sha256(cbor(groupId || version || prevHash || members || timestamp || createdBy))
```

**Genesis epoch (version 0):**
On group creation, the creator produces a genesis epoch with `prevHash = zeros(32)`, exactly
one member entry (the creator as admin), signed with the creator's Ed25519 key. Its creator
key and hash are pinned before any later epoch is accepted; a conflicting v0 or same-version
overwrite is rejected.

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

Invites are persisted as pending and do not mutate membership. The invitee explicitly
accepts; only then does the admin append the membership epoch and send the full chain.
On reconnect, members exchange their latest version and synchronize missing epochs offline.
Legacy local sender-key rows are migrated to a fresh v2 generation; legacy wire envelopes
are never accepted.

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

TTYA uses length-prefixed JSON frames on its dedicated Hyperswarm connection.
Each frame has a 4-byte big-endian payload length and a maximum payload of 64
KiB. Before either side accepts an application frame, the bridge and agent
complete this mutual HMAC-SHA256 handshake. `channelBinding` is the local
`@hyperswarm/secret-stream` Noise `handshakeHash`; it is never accepted from
the peer:

```text
Agent  -> Bridge: challenge(agentNonce)
Bridge -> Agent:  response(agentNonce, bridgeNonce, bridgeProof)
Agent  -> Bridge: confirmation(agentNonce, bridgeNonce, agentProof)

transcript(role) =
  "networkselfmd-ttya-auth-v3" || 0x00 || "proof" || 0x00 || role || 0x00 ||
  hex_decode(agentNonce) || hex_decode(bridgeNonce) ||
  uint16be(len(channelBinding)) || channelBinding

bridgeProof = HMAC-SHA256(authSecret, transcript("bridge"))
agentProof  = HMAC-SHA256(authSecret, transcript("agent"))
```

Both nonces are 32 fresh random bytes encoded as lowercase hexadecimal. Proofs
are checked in constant time, the roles provide reflection resistance, and the
handshake must finish within five seconds. The agent accepts no requests before
verifying `bridgeProof`; the bridge releases no queued or future visitor
requests, and accepts no approve/reject/reply responses, before verifying
`agentProof`. Authentication state and partial frames are discarded on every
disconnect. Because independent Noise connections have different transcript
hashes, an attacker cannot relay the challenge and proofs through a second
socket.

After confirmation, both sides derive a session key with HMAC-SHA256 over the
same nonces and channel binding under the `session-key` domain. Every
TTYARequest and TTYAResponse is then wrapped in a `ttya-data` frame containing
an exact-direction label, a monotonically increasing uint64 sequence, the
base64 JSON payload, and an HMAC made with that session key. Replays,
out-of-order frames, unwrapped application messages, and messages copied to a
different Noise connection close the socket.

The length parser is incremental: split headers and payloads are retained,
coalesced frames are drained in order, and a zero or greater-than-64-KiB
advertised length is rejected before allocating the body. Authentication must
finish in five seconds. An incumbent socket, including one still
authenticating, is never displaced by a new candidate; failed authentication
is subject to per-Noise-key exponential backoff plus a global sliding-window
limit.

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
