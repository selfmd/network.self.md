# Protocol v2 authentication migration

Protocol v2 is a wire-breaking, fail-closed upgrade. A v2 node advertises
`protocolVersion: 2` during `IdentityHandshake` and rejects v1 handshakes; there is no
downgrade mode. Deploy peers that need to communicate with one another in the same
maintenance window.

## Wire changes

Every CBOR message map has an exhaustive schema. Missing or unknown fields, invalid enum
values, unsafe or out-of-range integers, oversized UTF-8/binary values, duplicate entries,
and incorrectly sized keys, nonces, hashes, or signatures are rejected before routing.
Nested group epochs and genesis anchors are decoded and verified at the same boundary.

- `SenderKeyDistribution` is now only the opaque v2 recipient envelope expected from the
  `security-02-sender-keys` integration: `recipientPublicKey`, `nonce`, `ciphertext`, and
  `timestamp`. This branch never serializes or broadcasts plaintext chain keys and does not
  duplicate the envelope encryption implementation from branch 02.
- `GroupMessage` signs the current `epochVersion` and `epochHash` in addition to its group,
  sender, chain index, nonce, ciphertext, and timestamp. Unknown groups, missing epochs,
  stale epoch contexts, and senders removed from the current epoch are rejected.
- `DirectMessage` and `GroupManagement` bind both authenticated session identities. Invites
  additionally carry an exact signed genesis v0 anchor; an unpinned group cannot be joined.
- `NetworkAnnounce` v2 uses a fixed domain-separated canonical payload, sorted unique group
  IDs, and a signed genesis anchor for every advertised group. The announcer must be the
  authenticated genesis creator.
- `GroupEpoch` uses a domain-separated/versioned canonical immutable epoch containing
  `createdAt`. Delivery uses a separate v2 recipient-bound signed envelope with a fresh
  `timestamp`, allowing an old epoch to be sent during catch-up without changing its hash or
  epoch signature.

Byte strings are normalized before canonical authentication, so Node `Buffer` and plain
`Uint8Array` values produce identical signatures across a CBOR round-trip.

## Replay durability and bounds

Authentication produces a replay reservation but does not consume it. The reservation is
inserted and promoted to `accepted` in the same SQLite transaction as the ratchet,
sender-key, epoch, discovery, and message state mutation. A missing ratchet/key, failed
decrypt, validation error, thrown callback, or process crash rolls the whole transaction
back; an authentic frame can be retried instead of being permanently poisoned.

Accepted replay rows expire after ten minutes. Expired rows are pruned on acceptance, and
the ledger rejects new reservations above 2,048 live rows per sender or 100,000 globally.
These limits exceed the five-minute wire freshness window while bounding disk and lookup
cost under adversarial traffic.

## Storage migration

Database migration 6 upgrades the migration-5 replay ledger with transactional state and
expiry columns, adds indexes for pruning/caps, pins group creator/genesis hashes, persists
authenticated discovery anchors, and adds pending invite bootstrap storage. Migration from
an existing schema-v4 database is covered by a fixture test; existing v5 replay rows are
carried forward with bounded expiry.
