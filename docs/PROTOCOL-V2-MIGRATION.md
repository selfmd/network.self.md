# Protocol v2 authentication migration

Protocol v2 is a wire-breaking, fail-closed upgrade. A v2 node advertises
`protocolVersion: 2` during `IdentityHandshake` and rejects v1 handshakes; there is no
downgrade mode. Deploy peers that need to communicate with one another in the same
maintenance window.

## Wire changes

All CBOR message maps now use exhaustive schemas. Missing fields, unknown fields,
invalid enum values, unsafe or out-of-range integers, oversized text/binary values,
and incorrectly sized keys, nonces, hashes, or signatures are rejected before routing.

The following messages gained a 64-byte Ed25519 `signature` over a canonical,
domain-separated v2 payload:

- `SenderKeyDistribution` also gains `senderFingerprint` and
  `recipientFingerprint`. Its signature binds both identities, `groupId`, key material,
  `chainIndex`, and `timestamp`.
- `GroupMessage` signs `senderFingerprint`, `groupId`, `chainIndex`, `nonce`,
  `ciphertext`, and `timestamp`.
- `DirectMessage` signs both fingerprints, ratchet key and counters, `nonce`,
  `ciphertext`, and `timestamp`.
- `GroupManagement` also gains both fingerprints and signs them with the group,
  action, optional target/name, and timestamp. Broadcast operations therefore create a
  separately signed message for each recipient.

Signatures are verified against the Ed25519 identity authenticated by the active Noise
session. Sender and recipient fields must match that session and the local identity.
Messages older or newer than five minutes are rejected. Accepted signed messages are
recorded in the new SQLite `protocol_replay` table before decryption or state mutation,
so exact replays remain rejected after process restart.

`GroupEpoch` nested CBOR is now schema-validated and its outer group, timestamp, and
hash must match the signed epoch. Unsupported/dead message types and management actions
are rejected by the routing/phase gate instead of being implicitly accepted or ignored.

## Operational impact

Database migration 5 adds the durable replay ledger automatically. The ledger must be
preserved with `agent.db`; deleting it removes cross-restart replay history. Existing
identities, groups, ratchet state, sender keys, messages, and epochs require no data
conversion, but application traffic cannot resume until both endpoints run protocol v2.
