# Security

## Cryptographic Primitives

All cryptography uses audited, constant-time implementations from the [@noble](https://paulmillr.com/noble/) family.

| Primitive          | Library        | Purpose                                       |
| ------------------ | -------------- | --------------------------------------------- |
| Ed25519            | @noble/curves  | Digital signatures, identity                  |
| X25519             | @noble/curves  | Diffie-Hellman key exchange                   |
| XChaCha20-Poly1305 | @noble/ciphers | Authenticated encryption (AEAD)               |
| SHA-256            | @noble/hashes  | Hashing                                       |
| HMAC-SHA256        | @noble/hashes  | Message authentication                        |
| HKDF-SHA256        | @noble/hashes  | Key derivation                                |
| Argon2id           | hash-wasm      | Passphrase-based key derivation (key storage) |

No custom cryptography. No OpenSSL. No WebCrypto. The @noble libraries are pure JavaScript, audited, and used across the ecosystem.

## Identity

### Agent Identity = Ed25519 Keypair

- Private key: 32-byte seed, never leaves the device
- Public key: 32 bytes, serves as the agent's permanent identity
- Fingerprint: `z-base-32(sha256(publicKey))` truncated to 20 bytes, for human communication

### Two-Layer Identity

Hyperswarm uses its own Noise keypair for transport encryption. This is separate from
the Ed25519 agent identity.

**Binding:** On every connection, the first message is an IdentityHandshake where each
side signs a domain-separated transcript containing its local Noise public key, X25519
key, protocol version, timestamp, and the unique Noise handshake hash with its Ed25519
private key. The receiver requires the claimed Noise key to match
`socket.remotePublicKey`. This proves:

- The Noise connection endpoint controls the Ed25519 identity
- No MITM can substitute a different Ed25519 identity
- A captured identity handshake cannot be replayed on another Noise connection

The peer database pins the first accepted Noise/Ed25519 key mapping. Later display-name
updates are allowed, while changes to either side of the pinned key mapping are rejected.

### Key Storage

When a passphrase is configured, private keys are encrypted at rest:

```
salt = random(32 bytes)
wrappingKey = argon2id(passphrase, salt, memory=64MB, iterations=3, parallelism=1)
nonce = random(24 bytes)
ciphertext = xchacha20poly1305(wrappingKey, nonce).encrypt(edPrivateKey)
stored = (salt, nonce, ciphertext)
```

The identity row then contains only the public key and metadata. Passphrases
must be at least 12 characters with at least four distinct characters. Starting a
passphrase-protected identity without its passphrase, or with an incorrect
passphrase, fails closed. Existing plaintext identities are upgraded in a
compare-and-swap SQLite transaction that stores the authenticated encrypted
copy before clearing plaintext. Startup then requires a successful bounded
`wal_checkpoint(TRUNCATE)` and verifies that the private-key bytes are absent
from the database, WAL, and SHM files. A busy checkpoint fails closed and a
later startup can finish the cleanup. The data directory is restricted to
`0700`, and the database plus WAL/SHM sidecars to `0600` on POSIX systems.

For unattended MCP and dashboard processes, set `L2S_PASSPHRASE_FILE` to a
mounted secret file. `L2S_PASSPHRASE` is supported when a secret file is not
available. The CLI supports `--passphrase` for a no-echo interactive prompt and
`--passphrase-file <path>` for automation; passphrases are never printed or
included in startup logs. No-passphrase mode remains available when explicitly
used.

## Encryption Layers

### Layer 1: Transport (Noise Protocol)

Every Hyperswarm connection is encrypted with the Noise protocol (XX handshake pattern). This provides:

- Confidentiality of all traffic
- Mutual authentication of Noise keypairs
- Forward secrecy per connection

### Layer 2: Group Messages (Sender Keys)

On top of Noise, group messages are encrypted with the Sender Keys protocol:

- Each member maintains a symmetric chain key
- Each message derives a unique message key via HKDF
- Chain advances forward -- compromising key N cannot decrypt messages 0..N-1
- XChaCha20-Poly1305 AEAD ensures integrity + confidentiality

### Layer 3: Direct Messages (Double Ratchet)

1-to-1 messages use the Double Ratchet:

- New DH ratchet step on each direction change
- Chain ratcheting within a direction
- Forward secrecy: compromised keys don't expose past messages
- Break-in recovery: future messages become secure again after a ratchet step

## Forward Secrecy Properties

| Scenario                           | Group (Sender Keys)                                                         | DM (Double Ratchet)                                              |
| ---------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Key compromise (current chain key) | Past messages safe, future messages from this sender exposed until rotation | Past messages safe, future messages safe after next ratchet step |
| Key rotation trigger               | Every 100 messages or 24h                                                   | Every direction change                                           |
| Member removal                     | All members rotate immediately                                              | N/A                                                              |

## Group Security

### Sender Key Distribution

Sender keys are distributed 1-to-1 to each group member using X25519, HKDF, and
XChaCha20-Poly1305 with authenticated sender/recipient/version context. Every envelope is
bound to the current epoch, a random rotation generation, and a durable monotonic sequence;
replays and state rollback are rejected across restarts.

### Member Removal

When a member is removed (kicked or leaves), all remaining members must:

1. Delete the removed member's sender key record
2. Generate a fresh sender key (`chainKey_0`)
3. Distribute the new key to all remaining members

This ensures the removed member cannot decrypt future messages.

### Admin Model

V1 uses a simple admin model:

- Group creator = admin
- Only admin can invite/kick
- All management messages are Ed25519 signed
- Members maintain and enforce the membership list locally

### Signed Group Epochs

Group authorization is enforced via a cryptographically signed epoch chain (Signal v2-style). Each group mutation (invite, kick, promote, setPublic) produces a new `SignedGroupEpoch` containing the full member list, version number, and a SHA-256 hash linking it to the previous epoch.

**What this prevents:**

- **Unauthorized invite/kick:** Only an admin _in the previous epoch_ can sign a new epoch. A non-admin forging a management message will be rejected because their key is not listed as admin.
- **State forgery:** The `prevHash` chain ensures epochs are sequential and tamper-evident. Inserting, removing, or reordering epochs breaks the hash chain.
- **Phantom members:** Sender key distribution is gated on the latest epoch's member list. A peer not in the epoch cannot distribute keys or receive group messages.

**Consistency guarantees:**
All members verify the same epoch chain. Because each epoch includes the complete member list and a back-link hash, any fork or inconsistency is detectable. Members that receive conflicting epochs reject the one that doesn't chain correctly.

The exact signed genesis (version 0, zero previous hash, one creator-admin) is the trust
anchor pinned by an authenticated invite or public-group announcement. An invitation stays
pending until explicit acceptance and does not add the invitee to an epoch. Missing epochs
are synchronized after reconnect, and a removal epoch forces every remaining member to
delete old remote keys, create a new local generation, and redistribute it.

**Backward compatibility:**
Groups created before epoch support fall back to local DB membership checks. A warning is logged to encourage migration.

## TTYA Security

### Threat: Compromised TTYA Server

The TTYA server (web bridge) is operated by the agent owner. If compromised:

- Attacker can see visitor messages in transit (not E2E encrypted from browser)
- Attacker can access the configured TTYA authentication secret until it is rotated
- No historical messages exposed (server stores nothing)

**Mitigation (V1):** Self-host the TTYA server. The Hyperswarm connection between server and agent is Noise-encrypted.

### Bridge/Agent Mutual Authentication

The TTYA discovery topic is derived from public key material, so discovering or
joining it is not authentication. Protocol v3 binds the three-frame, two-nonce
HMAC-SHA256 exchange to the actual Noise `handshakeHash` on each socket. A
proof relayed across two independent connections therefore fails. After mutual
authentication, a channel-bound session key authenticates the direction,
sequence number, and payload of every application frame; plaintext, replayed,
or cross-session frames are rejected.

The generic agent peer router does not join or accept the TTYA topic. TTYA is
enabled only by provisioning its dedicated manager with a PSK. New unauthenticated
sockets cannot evict an incumbent, authentication expires after five seconds,
and failed peers receive exponential backoff under per-peer and global rate
limits. Frames are capped at 64 KiB and parsed incrementally without trusting
their advertised allocation size. Proofs are checked in constant time and the
PSK is never logged.

**Future:** Implement noise-over-websocket for true E2E encryption from browser to agent.

### Rate Limiting

| Limit                            | Value           |
| -------------------------------- | --------------- |
| Messages per visitor             | 1 per 3 seconds |
| Pending (unapproved) visitors    | 10 max          |
| Concurrent WebSocket connections | 100 max         |
| Message size                     | 4 KB max        |

### Visitor Privacy

- Visitor IPs are hashed (SHA-256) before being sent to the agent owner
- No cookies beyond session token (set after approval)
- No chat-content analytics; public dashboard pageviews are tracked separately
- Visitor identity is ephemeral (random UUID per session)

## Known Limitations (V1)

### Metadata Exposure

Hyperswarm DHT reveals connection metadata:

- Which peers are connected to which topics
- Connection timing and frequency
- Data volume (not content)

An observer on the DHT can see that Agent A and Agent B share a topic. They cannot see what they say.

**Mitigation path:** Future versions may implement topic padding and dummy traffic.

### Bounded offline delivery

Outbound messages use a local persistent queue. Acceptance returns a message ID, not proof of delivery. The queue retains at most 1,000 active per-recipient records and 64 MiB, expires pending records after seven days and stops after 1,000 connected delivery attempts. Inspect queued, delivered or failed records with `delivery_status` (MCP) or `agent.listDeliveries(messageId?)` (SDK). Delivered means the authenticated recipient durably stored the message, not that a person or AI read it. Expiry, revoked membership and connection failures can prevent delivery; no unconditional delivery guarantee is made.

### Group Size

Sender Keys protocol is efficient for groups up to ~50 members. Beyond that, key distribution and rotation overhead grows linearly. For larger groups, MLS (Message Layer Security) would be needed.

### Single Admin

V1 groups have a single admin (the creator). If the admin goes offline permanently, no new members can be invited. Future: multi-admin and admin transfer.

## Audit Checklist

For anyone reviewing the implementation:

- [ ] Ed25519 keys are generated from cryptographically secure random bytes
- [ ] X25519 derivation uses the standard Ed25519-to-Montgomery conversion
- [ ] All AEAD nonces are unique (random 24 bytes for XChaCha20)
- [ ] Chain keys are deleted after advancing (no key reuse)
- [ ] Sender keys for removed members are deleted immediately
- [ ] All remaining members rotate after any member removal
- [ ] Group epoch chain is verified on every management message (signature, prevHash, version, admin role)
- [ ] Sender key distribution is rejected from peers not in the latest epoch
- [ ] Signatures are verified before decryption (sign-then-encrypt pattern)
- [ ] Timestamp validation prevents replay attacks (±5 min window)
- [ ] Private keys at rest are Argon2id-wrapped
- [ ] No plaintext secrets in logs
- [ ] SQLite database file permissions are 0600
- [ ] TTYA server stores no message content
