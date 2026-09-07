# Simultaneous direct-message initialization

A first outgoing direct message initializes a Double Ratchet sender. If both
peers send before receiving, these are two independent initial sessions. Neither
sender can decrypt the other initial message using its own sending root.

The runtime resolves this race while preserving the Double Ratchet algorithms.
Reliable delivery requires identity-handshake protocol 3 with the fixed
`reliable-delivery-v1` capability; all participants must upgrade. There is no
silent downgrade to legacy delivery.

1. Before the first outbound frame, persist the sending ratchet and a bootstrap
   eligibility deadline. New reliable senders also persist a nonsecret
   `bootstrapPending` marker. Neither marker contains an identity private key or
   shared secret. Existing stored ratchets without eligibility cannot acquire it
   from a decryption failure.
2. Validate the incoming signed envelope and reserve its durable replay ID.
   Try the current ratchet without mutating its stored state.
3. Only an existing, unexpired marker permits trying an initial receiver,
   derived transiently from the unlocked identity and authenticated peer key.
   This candidate accepts only the initial chain (`previousChainLength = 0`).
   Authentication/decryption failure commits neither a ratchet nor a replay ID.
4. After successful collision decryption, both peers choose the initial session
   initiated by the lexicographically smaller fingerprint. The smaller peer
   preserves its sender; the larger peer adopts the authenticated receiver.
5. The winner retains one receive-only state pinned to the losing initial
   ratchet public key, so delayed first messages still arrive. Its root and
   sending secrets are removed. It cannot start another DH chain, and it retains
   at most 256 skipped message keys in total.

A canonical reply can overtake an initial message on the losing branch. The
smaller peer therefore retains eligibility until that branch arrives or the
deadline expires. When the larger peer successfully receives on its original
session, it immediately drops eligibility: a smaller peer with a competing
session would have kept that competing session rather than replied on this one.

For legacy raw messages, the original bootstrap window remains ten minutes.
Reliable messages instead use their authenticated delivery expiry, bounded to
seven days from enqueue. New authenticated reliable work may renew initial
eligibility while the new sender has received neither a canonical message nor a
competing first message. Renewal changes only a nonsecret deadline; it does not
reset an established ratchet.

After a competing first message succeeds, the winning sender retains at most
one pinned receive-only chain and 256 skipped keys. If its canonical branch has
not received yet, that bounded state can remain inactive across idle periods,
including restarts beyond seven days. Authenticated reliable work may renew its
eligibility deadline, but the receiver is never re-derived or reset. An expired
packet is still rejected.

When the canonical branch receives, renewal ends. The pinned receiver can only
drain until the authenticated packet's expiry (at most its seven-day delivery
window), then lazy cleanup removes it. The losing sender adopts the canonical
receiver and drops bootstrap eligibility. Retention before convergence is
therefore bounded in state size, not by a universal ten-minute or seven-day age.
This is not a physical key-erasure guarantee. Old sessions already affected by
a collision are not automatically repaired, and decrypt failure never resets
an established session.

The existing encrypted-identity boundary is preserved: the initial receiver is
never serialized with the static X25519 private key. As before, operational
ratchet state and stored message history are not encrypted by the identity
passphrase. The active record retains its flat ratchet fields, but older
versions do not understand the reliable bootstrap marker/receiver lifecycle.
Protocol 3 rejects older peers, and downgrading a pending collision is unsupported.

Regression coverage uses real runtime signing, replay validation, SQLite and
ratchets with a controlled transport: simultaneous sends, first-delivery and
post-collision restarts, reordered initial chains, an overtaking canonical
reply, tampering, replay after ledger expiry, bounded skipped keys, pinned
losing keys, protected identity storage and legacy sequential sessions.
