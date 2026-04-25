# Inbound Policy Gate

The inbound policy gate is the **single chokepoint** between authenticated
network reception and any agent-runtime side effect. Every event that
reaches the agent runtime — meaning anything that lands in
`Agent.inboundQueue` or fires `inbound:message` on the Agent — has passed
through the gate. Events that fail any gate check do not produce
side effects.

## Inbound event lifecycle

```
[ network frame ]
        │
        ▼
GroupManager.handleGroupMessage          (packages/node/src/groups/group-manager.ts)
  ├─ verifyMessageSignature
  ├─ buffersEqual(senderPublicKey, transport peer key)
  ├─ isMember(groupId, senderPublicKey)        ← protocol-layer auth
  ├─ SenderKeys.decrypt
  ├─ messageRepo.insert (owner-private store, plaintext at rest by design)
  ├─ emit('group:message', legacy)             ← unchanged for back-compat
  ├─ emit('inbound:message', PrivateInboundMessageEvent)   ── consumed by gate
  └─ emit('activity:message', PublicActivityEvent)         ── metadata-only
        │
        ▼
PolicyGate.evaluate(ev)                  (packages/node/src/policy/policy-gate.ts)
  1. validateInboundEvent(ev)            → fail-closed: malformed-event / unknown-event-kind
  2. dedup check                         → fail-closed: duplicate-event
  3. for kind='group': isMember recheck  → fail-closed: not-a-member  (defence-in-depth)
  4. AgentPolicy.decide(ev)              → pure: act | ask | ignore
  5. PolicyAuditLog.record(entry)        → metadata-only PolicyAuditEntry
  6. mark messageId in dedup             ← only here, post-audit
  7. emit('decision', decision)
        │
   ┌────┴────────────────────┐
   ▼                         ▼
 allowed: true             allowed: false
   │                         │
   ▼                         ▼
 inboundQueue.push       (no side effect)
 emit('inbound:message')
 emit('policy:audit', entry)
 emit('policy:decision', decision)
```

## Where policy is enforced

- **Authenticity / decryption / membership** are enforced at the protocol
  layer in `GroupManager.handleGroupMessage` *before* the gate ever sees
  an event. The gate trusts that any event it receives has already been
  authenticated by the network layer.
- **Structural validity, deduplication, defence-in-depth membership, and
  the act/ask/ignore decision** are enforced at the gate.
- **No agent-runtime side effect happens before the gate.** That includes
  the `Agent.inboundQueue.push`, the public `inbound:message` event, and
  any future tool/handler invocation. The gate is the only writer.

`messageRepo.insert` runs *before* the gate but is the protocol layer's
write to the owner-private message store. The privacy invariant below
explicitly does not constrain that store.

## Decision table

`AgentPolicy.decide` is a pure function over (config, self-identity,
event). It produces a `PolicyDecision { action, reason, ... }`.

| addressedToMe | senderTrusted | matched interest | action | reason |
|---|---|---|---|---|
| ✓ | ✓ | * | `act` | `addressed-and-trusted` |
| ✓ | ✗ | ✓ | `ask` | `addressed-matches-interest` |
| ✓ | ✗ | ✗ | `ask` | `addressed-unknown-sender` |
| ✗ | ✓ | ✓ | `ask` | `trusted-interest-hit` |
| ✗ | ✗ | ✓ | `ask` | `interest-hit` |
| ✗ | ✓ | ✗ | `ignore` | `trusted-no-signal` |
| ✗ | ✗ | ✗ | `ignore` | `not-addressed` |

`addressedToMe` is true when the plaintext (strict UTF-8 decode) contains
`@<first N chars of fingerprint>` or `@<displayName>` token-bounded, OR
when `requireMention: false` is set on the config.

## Reason codes (stable vocabulary)

The full list is exported as `POLICY_REASONS` from `@networkselfmd/core`
and locked by tests. Two groups:

**Decision reasons** (`AgentPolicy.decide` output):

- `not-addressed`
- `addressed-and-trusted`
- `addressed-unknown-sender`
- `addressed-matches-interest`
- `trusted-interest-hit`
- `interest-hit`
- `trusted-no-signal`

**Fail-closed reasons** (gate-level rejection — `decide` is not invoked):

- `malformed-event` — structural validation failed (missing/wrong-typed
  fields, empty messageId/fingerprint, etc).
- `unknown-event-kind` — `kind` is neither `'group'` nor `'dm'`.
- `duplicate-event` — `messageId` was already evaluated successfully.
- `not-a-member` — gate-level membership recheck failed for a group
  event. The protocol layer enforces this too; the gate adds an
  independent check so direct in-process injections (tests, future
  transports) cannot bypass authorization.

Audit entries with `gateRejected: true` carry one of the fail-closed
reasons. Entries with `gateRejected: false` carry one of the decision
reasons. Both are first-class debug surfaces.

## Privacy invariant

**No plaintext, ciphertext, decrypted body, tool args, raw event payload,
or private key material ever appears in:**

- `PolicyDecision`
- `PolicyAuditEntry`
- `PolicyAuditLog` ring buffer
- `'policy:decision'` / `'policy:audit'` events on Agent
- the MCP `get_policy_audit_recent` tool output (`PolicyAuditDTO`)
- console / stdout / stderr writes from the policy gate code path

What *is* allowed in audit/decision/MCP surfaces:

- event kind (`group | dm | unknown`)
- `messageId`, `groupIdHex`, `senderFingerprint` (all already-public
  identifiers)
- `byteLength` of the plaintext (size only, no content)
- decision booleans and the kebab-case reason token
- the audit's own `auditId` and `receivedAt` timestamp

Three independent test layers enforce this:

1. Adversarial integration tests
   (`packages/node/src/__tests__/policy-gate-adversarial.test.ts`) embed
   a canary in plaintext and assert it never appears in serialized audit
   or decision payloads.
2. Fuzz tests (`policy-gate-fuzz.test.ts`) run 500 iterations with random
   plaintext containing a fixed canary, intercepting all console + stdout
   + stderr writes for the duration. Zero captured lines may contain the
   canary; zero audit serializations either.
3. The MCP DTO test (`packages/mcp/src/__tests__/policy-audit-dto.test.ts`)
   pollutes a `PolicyAuditEntry` with `plaintext` / `decryptedBody` /
   `toolArgs` fields and verifies `toPolicyAuditDTO` strips them — the
   DTO is an explicit projection, not a spread copy, so future
   `PolicyAuditEntry` additions do not auto-leak.

`messageRepo.messages.content` (SQLite, owner-private) is **outside** the
gate's privacy surface. That column stores the plaintext at rest for the
owner's own `getMessages` read API, by design and from the original
schema. The hardening in this PR does not change the message store and
does not extend the privacy invariant to it.

## Dedup retry-poison invariant

The dedup set is updated **only** in step 6 of `PolicyGate.evaluate`,
after validation, membership recheck, the pure decision, and the audit
write all succeeded. If any earlier step fails, or if `audit.record`
throws, the `messageId` is **not** added — a legitimate retry with the
same `messageId` will be re-evaluated rather than silently denied as a
duplicate. Tests in
`packages/node/src/__tests__/policy-gate-unit.test.ts` cover the three
poison scenarios (validation fail / membership fail / audit throw) and
the eviction-at-capacity behavior.

## Future extension point — tool execution (NOT IMPLEMENTED)

When a `PolicyDecision { action: 'act' }` is produced, this PR does
nothing beyond emitting the decision. The deliberate extension point is:

```ts
agent.on('policy:decision', (decision) => {
  if (decision.action !== 'act') return;
  // (future PR) lookup handler/tool, validate args, invoke out-of-band
});
```

`AgentPolicy.decide` must remain pure. Tool execution / side effects
belong **outside** the gate, on a separate consumer that subscribes to
`'policy:decision'`. Anything that requires I/O, network, or filesystem
access does not belong inside `decide`.

This PR explicitly does not implement:

- per-interest or per-action handler invocation
- tool calls / agent action execution
- payments or token economics
- server-trust assumptions
- protocol-level "addressed" metadata (mentions stay in plaintext)
- DM events (the DM receive path is fail-closed in `Agent.handleDirectMessage`
  until DM signing / Double Ratchet lands)
