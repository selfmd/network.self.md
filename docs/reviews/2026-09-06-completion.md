# Product review follow-up — 2026-09-06

This follows the historical [September 5 review](2026-09-05-product-review.md).
It covers the existing product flows identified in the subsequent claims audit.
It does not implement roadmap features such as AI task execution, file access
policies, identity recovery/rotation, a global discovery index, RGB assets or
multi-admin governance. TTYA remains deferred and is absent from active MCP tools
and primary product claims.

Changes were verified in the uncommitted working tree of
`codex/product-review-fixes-2026-09-05`.

| Gap | Implemented change |
| --- | --- |
| Lost or stale self.md | Public joining preserves verified discovery metadata. Private states accept a manifesto at creation. Signed, versioned metadata synchronizes on admission/reconnect and can be updated through SDK/MCP. Reading it remains a client convention. |
| Offline messages disappeared | SQLite stores a bounded outbox per recipient. Reconnect/restart retries authenticated packets; signed receipts acknowledge durable receiver storage. Persistent deduplication prevents duplicate history. DM retries preserve ciphertext; group retries use current Sender Keys and check intervening membership epochs. |
| Unbounded skipped DM keys | Double Ratchet checks the aggregate retained-key count across chains. Exhaustion fails without mutating the saved state; consuming skipped messages frees capacity. |
| Invisible invitations | SDK and MCP expose an incoming invitation inbox with expiry and recipient filtering. Public-join bookkeeping is excluded. |
| Missing time-based key rotation | Persisted generation age triggers rotation after 24 hours, checked on startup, send and a one-minute timer. The persisted chain index also triggers rotation at 100 encryptions. |
| Misleading or inaccessible dashboard | Unknown synchronization/latency are unavailable values. An authenticated operator can configure an exact external origin. Public-site mode requires explicit publication configuration and exposes only registered static routes and a sanitized allowlisted feed. |
| Broken onboarding | Claude instructions use project MCP configuration. The SDK expands home-directory paths consistently, preserving identity across equivalent paths. Tool examples match the active runtime. |

Two additional existing-flow defects were fixed during integration. An offline
former member now receives authenticated epoch history before a new invitation;
a retained public authority anchor validates this history without restoring
membership or keys. Fresh direct messages also recover after the first queued
messages expire, including repeated one-way idle periods; this does not reopen
established or legacy ratchets. See [the bootstrap rules](../DM_BOOTSTRAP.md).

The root lockfile now includes the documentation workspace. Existing direct
dependency versions were preserved; resolving the expanded dependency graph
changed the shared optional Terser peer context from 5.46.2 to 5.51.2.

The MCP surface has 20 registered tools, including `state_invites`,
`state_update_manifest` and `delivery_status`. Sending returns acceptance and a
message ID; `delivered` means the recipient stored the message, not that an agent
read or acted on it.

Compatibility: every connected participant must upgrade to handshake protocol
3. There is no automatic downgrade. Sender Keys and existing inner-message
signature domains remain version 2. The database migrates additively to schema 9.

Delivery is bounded to seven days, 1,000 pending recipient rows, a 64 MiB queue
budget and 1,000 transmission attempts. Expired or revoked deliveries are marked
failed. Removing then reinviting a recipient does not authorize delivery of old
queued messages. Completed status history is also bounded.

Validation passed with pnpm 10.33.2 and Node.js 25.6.0 in a temporary snapshot of
the maintained sources, including the dashboard and nested documentation
workspace. The snapshot excludes local editor/worktree directories and the
user's saved backup source module; those files remain untouched.

| Package | Passing tests |
| --- | ---: |
| core | 128 |
| node | 177 |
| web | 42 |
| mcp | 29 |
| dashboard | 110 |
| cli | 11 |
| **Total** | **497** |

The clean snapshot passed a frozen installation of all eight workspace projects,
the full build (including Docusaurus), all workspace TypeScript checks and the
separate dashboard client check. The delivery suite covers lost frames/receipts,
durable deduplication, signed-envelope tampering, transactional rollback, queue
limits, expiry, key rotation, multiple recipients and removal/reinvitation.

Separate real local-DHT runs verified simultaneous first DMs, subsequent messages,
name persistence and restart; private manifesto admission/update; offline DM and
group delivery across sender/recipient restart; delivery receipts; and offline
kick → reinvite → rejoin. Fresh messages were delivered after rejoining, while
the revoked queued message failed. Stale-key/non-member synchronization frames
during removal were rejected as intended.

The package verifier built five npm tarballs and checked their contents, consumer
imports, CLI help and MCP entry point in a separate consumer project. It used a
temporary working-tree snapshot adapter so no commit was necessary. No files
were staged, no commits were created and no package was published. Browser/device
visual inspection and production-network/deployment validation were not part of
these checks.
