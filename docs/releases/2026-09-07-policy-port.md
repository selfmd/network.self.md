# Policy forward port

Base: integration PR [#10](https://github.com/selfmd/network.self.md/pull/10), commit `7268e38`.
Branch: `codex/policy-forward-port-2026-09-07`.

## Changes

Port the functional layers of historical selfmd PRs #2 → #3 → #4 → #5 → #6 onto the current runtime. Keep the current signed group epochs, encrypted sender-key exchange, handshake v3 and reliable DM/group delivery. The old runtime in PR #1 is not reintroduced.

- Typed private inbound events and bounded local queue, plus metadata-only activity events on Agent.
- Pure act/ask/ignore decisions, validation, membership rechecks and bounded deduplication.
- Persistent configuration with validated SDK/MCP controls and network-free CLI commands.
- Metadata-only SQLite audit with retention and explicit read projections.
- DM gating: authenticated direct messages count as addressed; unknown senders produce ask. Group mention rules remain configurable.
- Message, ratchet, delivery inbox and policy audit commit in one transaction. In-memory audit, dedup and dispatch effects run after commit. Audit failure permits a clean retry.
- Schema 10 adds the policy tables and reconciles historical policy schema 2/3 without losing their config/audit. Schema 9 upgrades additively.

## Verification

The workspace suite and focused CLI subprocess test pass: core 128, node 313, web 42, MCP 44, dashboard 116, CLI 36 — 679 tests total. Full build and workspace/client TypeScript checks pass. The transactional tests inject failure after the audit write and after gate preparation for both DM and group messages, then verify successful retries without duplicate history, audit or inbound events. Legacy policy schema 2/3 and runtime schema 9 fixtures preserve data across migration.

All five npm tarballs passed consumer checks using an isolated snapshot of the unstaged source (the local archive adapter substitutes that snapshot for HEAD; the pinned docs submodule is exported normally). The Linux arm64/Node 22 Docker image built and passed the live publication/authentication smoke test. Package README additions after those checks are documentation-only. No policy changes have been staged or committed.

## Rollout and limitations

Merge/release the integration prerequisite first; policy uses the same handshake v3 and does not add another wire-version change. Back up the data directory before migrating to schema 10. For rollback, restore the previous data snapshot with its previous application revision.

The inbound queue is process-local; the audit is durable. A delivered receipt means stored, not executed. Tool execution and ask/approval UI are still outside this change. Public dashboards receive none of the private inbound or audit APIs. CLI edits require Agent restart; MCP controls affect the connected running Agent.
