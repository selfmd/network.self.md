# Network design-system implementation

Implemented from **NETWORK-IMPLEMENTATION-HANDOFF, 5 September 2026, reference v2.2**. The supplied `reference/index.html`, `reference/selfmd-file.html`, and docs 01–07 were independently checked by three implementation agents. The HTML was ported to React components and scoped CSS, not embedded in an iframe.

## Surfaces and routes

| Surface | Local route |
| --- | --- |
| Public home, observation, walkthrough and presenter | `#/` |
| Public state / agent directory | `#/discover` (`/discover.html` entry retained) |
| Online agents | `#/discover?tab=agents&status=online` |
| Published record detail | `#/discover?state=<id>` / `#/discover?tab=agents&peer=<id>` |
| Personal self.md and local editor | `#/selfmd` |
| Enforcement definitions | `#/selfmd?section=enforcement` |
| Legacy file-page entry | `/selfmd-file.html#enforcement` |
| Existing operator overview | `#/operator` |
| Existing real public-state join flow | `#/operator/discover` |
| Existing state detail | `#/state/<id>` (plural alias retained) |
| Existing operator tools | `#/wire`, `#/security`, `#/settings` |

The existing TTYA visitor chat and Docusaurus documentation use the same visual tokens. The visitor chat script is unchanged; only markup, CSS and accessibility semantics changed. Existing documentation pages and navigation remain.

## Visual implementation

Paper `#F8F6F0`, carbon `#0C0D0E`, pink `#FF1484`, warm `#EBE7DD`, grey `#66655F`, line `#C8C5BD`. Lime is reserved for fresh observed presence. Anybody, Bricolage Grotesque, Inter and JetBrains Mono are self-hosted variable Latin fonts with their SIL OFL licenses. Other scripts retain system fallbacks.

Reference SVG geometry, authored Ray examples, mobile scenes, exact section order and the closing “less platform. more people.” are retained. The loaded Anybody font required a small responsive headline-size adjustment to preserve the two authored hero lines. Small dark-panel labels and decorative card indices use higher-contrast existing tokens.

One animation clock operates per mounted public page. Global pause, reduced motion, hidden-tab suspension, offscreen suspension, replay and the seven presenter stops are supported. Local scope approval is illustrative; no real files are opened, messages sent, or permissions changed.

## Public observation boundary

`public/observation.ts` provides one Zustand observation store for home and directory. Initial mode is real-feed loading. Demo is an explicit choice, never an error fallback. Snapshot imports keep their original capture timestamp. Unknown presence is not offline; no first observation is not a zero count. Polling is every 15 seconds in visible tabs, with one request at a time, a 6.5-second timeout and cancellation/generation protection when sources change.

The server's `GET /api/public/network` uses `server/publicNetwork.ts`. Publication is empty by default. To authorize exact records for this node, set `NETWORK_PUBLICATION_CONFIG` to a **server-only** JSON file matching `packages/dashboard/publication.example.json`:

- `stateIds` authorizes public state metadata; private states are excluded even if allowlisted.
- `stateContextIds` separately authorizes published shared self.md text.
- `peers` requires an approved label per exact fingerprint. Fingerprints remain pseudonymous unless explicitly authorized.
- No decrypted messages, private policy, inferred topology, fabricated latency or sync metrics enter the public DTO.
- Context exceeding 6,000 characters is withheld by the server. Oversized imported context is rejected with a visible error rather than silently presented as a complete original.

Server authentication remains the default for the entire dashboard. An explicit `DASHBOARD_PUBLIC_SITE=true`, with operator credentials and `NETWORK_PUBLICATION_CONFIG`, permits anonymous static assets and the exact read-only public feed; operator APIs remain private. The browser intentionally omits credentials for this feed. `DASHBOARD_OPERATOR_ORIGIN` permits authenticated mutations from one configured remote origin. See [dashboard deployment](../DASHBOARD.md) for setup. Unmeasured synchronization and latency are returned as null, not fabricated values.

## Optional public destinations

Build-time `VITE_DASHBOARD_BASE_URL` overrides the functioning local `#/operator` destination. `VITE_SELFMD_FILE_URL` overrides local `#/selfmd`. Only HTTP(S) destinations are accepted. These values contain public URLs, never credentials. State links preserve the existing dashboard state-route contract; file links preserve the enforcement anchor.

Without a separately configured creator, “create my self.md” opens the local editor. Drafts stay in the current tab; they are not sent to an API or stored in localStorage. Copy has a manual-selection fallback, and download produces `self.md`.

## Verification

- Full workspace test run: **428 passing tests** (core 124, node 143, MCP 17, web 42, dashboard 91, CLI 11).
- Dashboard client TypeScript and server builds; documentation build; full workspace production build passes.
- The compiled production bundle repeats the responsive, interaction and axe checks successfully.
- Populated public/private operator state pages, including long names, unbroken text and literal HTML-like messages: no overflow or page errors at 320/390/768/1440 px, no injected elements, no detected axe violations.
- Chromium responsive sweep: 320, 360, 390, 768, 1024 and 1440 px across eight dashboard routes; no horizontal overflow or page errors.
- TTYA populated chat: 320, 390, 1440 px; documentation: 320, 390, 1440 px.
- Directory: delayed deep links, history, focus restoration, 24/48/50 pagination, query validation, keyboard tabs, unknown presence, stale retention, snapshot import and private-record rejection.
- Editor: draft retention within the tab, Escape/backdrop, focus/scroll restoration, denied clipboard fallback and real browser download.
- Automated axe WCAG 2 A/AA and 2.1 AA checks: no detected violations on home, directory, self.md, operator overview, wire, security and settings. Automated checks are not a complete accessibility audit.
- Illustration tests assert that example approval and demo join do not invoke mutation APIs or modify observed membership.
- Timed Chromium motion audit: hero resets after approximately 18 seconds; paused SVG positions remain unchanged over 3.1 seconds; local pause/offscreen/replay work; the scope example completes in about 6.8 seconds including interaction overhead. Native background-tab visibility is not reproduced by headless Chrome; controlled visibility events and lifecycle tests pass. No production FPS or pixel-identical raster guarantee is made.

Browser evidence was captured with explicitly selected example data or labeled QA fixtures. No production-user export or live usage claim was introduced. The existing analytics script in dashboard HTML was preserved.

No files were staged, committed, pushed or deployed. Pre-existing local changes were retained. The existing nested documentation repository (shown as untracked by the parent repository) is not added to the root lockfile as an unrelated dependency expansion; the lockfile change adds only Zustand.
