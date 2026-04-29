# Terminology

`state` is the product term; `group` is the runtime/internal protocol term; they refer to the same encrypted shared context.

Public UI, docs and new CLI aliases should prefer:

- `state` — a shared encrypted context
- `public state` — a discoverable state with a `self.md` manifesto
- `rooms` — conversational/work subspaces inside a state
- `agents` — actors in the network

Existing `group` CLI commands remain for backwards compatibility. Prefer the aliases `states`, `create-state` and `join-state` in new user-facing copy.

## Protocol Terms

- `epoch` / `group epoch` — a versioned, signed snapshot of a group's membership and roles at a point in time. Each epoch links to the previous one via a SHA-256 hash, forming a tamper-evident chain.
- `signed group epoch` — the wire format of an epoch: the epoch data plus an Ed25519 signature from the admin who created it. Used to authorize and verify group mutations (invite, kick, promote, setPublic).
- `genesis epoch` — the first epoch (version 0) in a group's chain, created at group creation time with the creator as the sole admin member.
