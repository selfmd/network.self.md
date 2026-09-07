# Integration release candidate

Source candidate: `f96b1a92e694c4d0593888b78ed0adee7bfa522e`.
PR base: `selfmd/main` at `3db4179`; prepared as an unstaged integration diff after verification.
Target repository: `selfmd/network.self.md`.

## Source reconciliation

- `shmlkv/network.self.md#2`: included through parent `b9eb846`.
- `shmlkv/network.self.md#3`: public component sources already match this candidate; preserve the newer publication/authentication integration in `f96b1a9`.
- `selfmd/network.self.md#9`: all commits are ancestors of this candidate, including the subsequent security integration.
- `selfmd/network.self.md#8`: its three-file hero restyling overlaps the newer design. Retain the candidate's public home, operator UI, metadata, and styles when reconciling main. No routes or pages are removed.
- `selfmd/network.self.md#1`: historical transport implementation; do not replace current signed epochs, transport binding, or working DM handling with it.
- Policy PRs #2–#6 require a separate forward port, including fresh migrations after schema 9 and delivery/audit integration tests. They do not implement tool execution.

## Verification gate

Initialize the exact documentation submodule before installing:

```sh
git submodule update --init --recursive
npx --yes pnpm@10.33.2 install --frozen-lockfile
npx --yes pnpm@10.33.2 build
npx --yes pnpm@10.33.2 typecheck
npx --yes pnpm@10.33.2 --filter @networkselfmd/dashboard exec tsc -p tsconfig.client.json
npx --yes pnpm@10.33.2 test
npx --yes pnpm@10.33.2 verify:packages
docker build -t networkselfmd-dashboard:release-candidate .
node scripts/verify-dashboard-image.mjs
```

The package verifier exports the pinned submodule into its clean archive. CI initializes submodules in both jobs, checks TypeScript explicitly, and boots the Docker image to verify publication and authentication. The image uses a workspace production install instead of `pnpm prune --prod`, which produced a built image missing the runtime workspace dependency.

## Rollout

1. Record the deployed revision and stop writers before taking a consistent backup of the complete data directory and separate mounted secrets. Preserve ownership and permissions.
2. Build one candidate revision and test two isolated nodes: simultaneous DM, offline/restart delivery, receipts, group leave/reinvite/rejoin, and manifesto synchronization.
3. Upgrade all connected participants to handshake protocol 3 together. No protocol downgrade is supported. Database migration is additive to version 9.
4. Run the dashboard with persistent `/data`, mounted password/passphrase files, and HTTPS at the reverse proxy. Configure `DASHBOARD_OPERATOR_ORIGIN` to the exact external origin.
5. Enable anonymous publication only with `DASHBOARD_PUBLIC_SITE=true` and an explicit `NETWORK_PUBLICATION_CONFIG` allowlist. Verify anonymous feed access and rejection of anonymous private API requests.
6. Verify `/healthz`, authenticated `/api/status`, real peer connectivity and actual delivery. A healthy HTTP process alone does not establish network readiness.
7. Roll back by stopping the upgraded processes and restoring the old revision together with its consistent pre-upgrade data backup. Do not point old software at an upgraded database.

Deployment host, domains, running peer inventory, and final verification results are pending. No production deployment is implied by this document.

## Local verification, 2026-09-07

- pnpm 10.33.2, Node 25.6.0: frozen installation, production build including Docusaurus, workspace TypeScript and separate dashboard-client TypeScript passed.
- 503 tests passed: core 128, node 177, web 42, MCP 29, dashboard 116, CLI 11. This includes local-DHT network tests.
- Five npm tarballs passed clean-archive contents, consumer imports, CLI help, and MCP entry-point checks.
- Docker uses Node 22 on Linux arm64. Initial image compilation passed but startup failed because `pnpm prune --prod` removed workspace links. Production installation now preserves those links. Container smoke passed: anonymous HTML/feed, empty publication allowlist, authenticated status, rejection of anonymous private APIs and unapproved mutation origins.
- No commits, staging, publication or production mutations were performed.
