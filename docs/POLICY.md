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

### Legacy event compatibility — `'group:message'` is NOT gated

`GroupManager.emit('group:message', { ... content })` is preserved
unchanged for backward compatibility with consumers that pre-date the
inbound bridge. Its payload includes the decoded plaintext as `content`.

This event:

- **bypasses** `PolicyGate.evaluate`,
- is **not** mediated by `AgentPolicy.decide`,
- does **not** appear in the audit log,
- does **not** participate in dedup.

A consumer that listens on `'group:message'` and logs the payload — or
forwards it to a public surface — would leak plaintext past the gate.
The privacy invariant above applies to gate / audit / decision / MCP
audit surfaces only; it does **not** automatically apply to legacy
consumers.

New code should listen on `'inbound:message'` (post-gate) and inspect
`PolicyDecision` / `PolicyAuditEntry` for context. The legacy event will
be re-evaluated for deprecation once external consumers have migrated;
removing it is out of scope for the hardening PR.

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

## Configuring the policy gate

Configuration is owner-local. There are three equivalent surfaces:

1. **Programmatic** — pass `policyConfig` to `new Agent({ ... })`.
2. **MCP tools** (owner-private, local-only): `get_policy_config`,
   `set_policy_config`, `add_policy_trusted_fingerprint`,
   `remove_policy_trusted_fingerprint`, `add_policy_interest`,
   `remove_policy_interest`.
3. **CLI** (under the `policy` parent command):

   ```
   networkselfmd policy get
   networkselfmd policy set --interests=coffee,deploy --require-mention=true
   networkselfmd policy set --reset
   networkselfmd policy trust add abcd1234
   networkselfmd policy trust remove abcd1234
   networkselfmd policy interest add ship-it
   networkselfmd policy interest remove ship-it
   ```

### Precedence

On `Agent.start()`:

- If a row exists in the local `policy_config` table, **the persisted
  config wins** and `AgentOptions.policyConfig` is ignored. Once an
  operator has tightened/loosened policy via CLI, MCP, or
  `agent.setPolicyConfig`, that setting survives restart.
- Otherwise the `AgentOptions.policyConfig` value is used as a
  first-time default. **It is NOT auto-persisted.** Programmatic
  defaults stay programmatic until the operator opts in via
  `setPolicyConfig`.
- If neither is present, the runtime default is `{}` — strict,
  ignore-everything.

`agent.resetPolicyConfig()` clears the persisted row and reverts the
runtime to `AgentOptions.policyConfig` (or `{}`).

> **CLI `policy set --reset`** clears the persisted row but reverts to
> the empty default `{}` — the CLI has no programmatic AgentOptions
> context to fall back on. Operators who want different defaults
> should pass `AgentOptions.policyConfig` to their long-running agent
> process; the next agent restart will then pick those up because the
> persisted row is empty after reset.

> **`AgentOptions.policyConfig` is validated at `Agent.start()`.**
> A JS caller that passes an off-spec config (e.g. via JSON.parse, or
> the TypeScript escape hatch `as never`) will see
> `PolicyConfigValidationError` thrown synchronously from `start()`.
> Persisted configs that already exist on disk are not re-validated on
> load — they were validated at the time they were written, and a
> corrupt JSON list is degraded to an empty array rather than throwing.

### Validation and bounds

`Agent.setPolicyConfig` validates input with the pure
`validatePolicyConfig` helper before persisting. Bounds (frozen as
`POLICY_LIMITS`):

- `trustedFingerprints`: ≤256 entries; each 4–64 chars matching
  `/^[a-z0-9]+$/`. Mixed-case input is trim+lowercased, not rejected.
- `interests`: ≤256 entries; each non-empty after trim, ≤64 chars.
- `requireMention`: boolean.
- `mentionPrefixLen`: integer in `[1, 64]`.

Lists are deduplicated while preserving order. Unknown keys on the
input (e.g. an attacker-supplied `plaintext` field) are stripped from
the sanitized output and never reach persistence.

On bad input `setPolicyConfig` throws `PolicyConfigValidationError`
with a structured `errors` array; the persisted row and live
configuration are untouched.

### Examples

Trust a peer and react to "deploy" mentions, requiring an explicit
@-mention:

```ts
agent.setPolicyConfig({
  trustedFingerprints: ['abcd1234'],
  interests: ['deploy'],
  requireMention: true,
  mentionPrefixLen: 8,
});
```

CLI equivalent:

```
networkselfmd policy set \
  --trusted=abcd1234 \
  --interests=deploy \
  --require-mention=true \
  --mention-prefix-len=8
```

Open the gate to all group messages (no @-mention required), useful
for a chatbot scenario where every message wants attention:

```
networkselfmd policy set --require-mention=false
```

### Privacy boundaries — operator config surface

The privacy invariant on the gate / audit / decision / MCP audit
surfaces extends here, with one expected exception: operator-supplied
configuration values **are persisted** because that is the entire
purpose. What's persisted:

- trusted fingerprints (already public identifiers)
- interest keywords (operator-chosen literal strings)
- the two flags (`requireMention`, `mentionPrefixLen`)

What's **never** persisted, even by accident:

- message plaintext / decoded content
- ciphertext / nonces / chain keys
- private keys or any encrypted-at-rest material
- raw event payloads
- tool args (no tool execution)

The schema enforces this — the `policy_config` table has columns only
for the four configurable fields plus an `updated_at` timestamp. A
test asserts the exact column set so future drift fails loudly. The
existing owner-private message store (`messages.content`) is unrelated
to the policy surface and unchanged in this PR.

### Local-only warning for MCP/CLI tools

The MCP policy tools and the CLI subcommands are operator controls.
They modify local state only. They MUST NOT be:

- exposed through a public web UI
- proxied to remote callers
- forwarded to dashboards, census, or shared logs
- used to drive automated decisions on behalf of other accounts

There is **no tool execution** in this PR. `act` decisions still
require the consumer to wire `agent.on('policy:decision', ...)`
themselves and dispatch out-of-band — and that wiring is an
owner-side concern, not a policy-tool concern.

## Durable audit trail

PR #6 turns the in-memory `PolicyAuditLog` into a durable, owner-local,
metadata-only audit trail that survives restart. The in-memory log
stays as a runtime convenience; the operator-truth surface for "recent
decisions across restart" is the persisted SQLite table.

### Storage

Schema v3 adds a `policy_audit` table with exactly these columns:

```
audit_id           TEXT PRIMARY KEY
received_at        INTEGER NOT NULL
inserted_at        INTEGER NOT NULL
event_kind         TEXT NOT NULL    -- 'group' | 'dm' | 'unknown'
message_id         TEXT             -- nullable
group_id_hex       TEXT             -- nullable
sender_fingerprint TEXT             -- nullable
byte_length        INTEGER NOT NULL
action             TEXT NOT NULL    -- 'act' | 'ask' | 'ignore'
reason             TEXT NOT NULL
addressed_to_me    INTEGER NOT NULL
sender_trusted     INTEGER NOT NULL
matched_interests  TEXT NOT NULL    -- JSON array
gate_rejected      INTEGER NOT NULL
allowed            INTEGER NOT NULL -- derived: action != 'ignore' && !gate_rejected
```

This is the entire surface. There is **no column** for plaintext,
content, body, payload, tool args, private-key bytes, ciphertext,
secrets, or passwords — by intent, and pinned by a column-set test
that fails loudly on any future drift.

`allowed` is a **DB-only derived convenience** for analytics queries
(e.g. `SELECT COUNT(*) FROM policy_audit WHERE allowed = 1`). It is
intentionally NOT part of `PolicyAuditEntry`, the MCP DTO
(`toPolicyAuditDTO`), or CLI output — the public vocabulary stays
`action` + `gateRejected`, which together are sufficient to derive
allowed-ness without expanding the operator-facing surface.

### Reads fail closed on corrupt rows

`PolicyAuditRepository.recent()` validates every enum / boolean /
numeric field per row. A row whose `event_kind`, `action`, `reason`,
`addressed_to_me`, `sender_trusted`, `gate_rejected`, or `byte_length`
is out of spec is mapped to a fail-closed metadata-only stub:
`eventKind="unknown"`, `action="ignore"`, `reason="malformed-event"`,
`gateRejected=true`. The original `auditId` and `receivedAt` are
preserved (best-effort) so operators can correlate, but no other
field of a corrupt row ever surfaces as if it were a normal decision.
`matched_interests` JSON corruption already degrades to `[]` via the
shared `parseStringArray` helper.

### Privacy boundary

What persists:

- per-decision metadata listed above
- operator identifiers already public in protocol (`group_id_hex`,
  `sender_fingerprint`)
- the size of the (decrypted) plaintext as `byte_length`, content-free
- operator-supplied `matched_interests` config tokens (these came from
  `PolicyConfig`, not from the message)

What never persists, even by accident:

- decoded message plaintext / content / body
- ciphertext / nonces / chain keys
- private keys or any encrypted-at-rest material
- raw event payloads
- tool args (no tool execution)

Three independent test layers enforce this end-to-end:

1. Repository tests — schema column-set, plaintext canary on insert,
   polluted-entry projection.
2. Persistence integration tests — feed canary plaintext through the
   real gate; raw SQL read of every column never contains the canary;
   100-iteration intercepted console / stdout / stderr canary.
3. Cross-restart MCP test — write through the gate, restart the
   Agent, read via the durable repo + `toPolicyAuditDTO` +
   `JSON.stringify`; the canary must not appear at any step.

### Retention

- `POLICY_AUDIT_LIMITS.defaultMaxEntries = 5000` rows on disk
  (overridable via `AgentOptions.policyAuditDbMax`).
- `POLICY_AUDIT_LIMITS.maxRecentLimit = 1000` per `recent()` /
  MCP / CLI fetch — clamped at the repo, the MCP zod schema, and the
  CLI parser.
- Prune-on-insert: each `insert()` evicts the oldest rows when the
  count exceeds the configured cap. `Agent.start()` runs one
  `prune()` to enforce retention after a downgrade.
- `prune({ olderThanMs })` deletes by age for operator-driven trim.

### Retry-poison invariant

`PolicyAuditLog.record()` runs `persist(entry)` **before** pushing to
the in-memory ring. A throw from persist propagates with the in-memory
log unchanged. The gate's `evaluate()` then throws too, and
`markDedup()` never runs — exactly the contract preserved since PR #4
polish. A legitimate retry of the same `messageId` is re-evaluated
rather than silently denied as a duplicate.

### MCP

`get_policy_audit_recent` reads from the durable repo when present
(production after `Agent.start()`), and falls back to the in-memory
log only for Agents constructed without `start()` (test ergonomics).
Both paths project through the same `toPolicyAuditDTO`, so the privacy
invariant is identical.

### CLI

```
networkselfmd policy audit recent [--limit N]
networkselfmd policy audit prune  --max-entries N
networkselfmd policy audit prune  --older-than-ms N
networkselfmd policy audit clear
```

These commands are owner-private and **local-only**. They do not
instantiate `Agent` or call `agent.start()` — they go straight to
`AgentDatabase` + `PolicyAuditRepository` over the local SQLite file.
A source-level guard test fails if a future change reintroduces an
`Agent` import or `agent.start()` call into `commands/policy-audit.ts`.

CLI output is metadata-only (the columns of `PolicyAuditEntry`); group
IDs and fingerprints are truncated for screen layout. There is no
flag or command in this PR that prints raw event payloads, plaintext,
or any content-bearing field.

### Out of scope (still)

- Tool execution / `act` handlers.
- Payments / token economics.
- DM event gating (still fail-closed in `Agent.handleDirectMessage`).
- Audit fan-out to remote sinks (durable here means owner-local SQLite
  only, no relays).
- Touching `messages.content` (the existing owner-private message
  store is unchanged).

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
