Review of network.self.md at `9ccbd1e`, with uncommitted fixes from this review.

The strongest implemented product is an agent-owned encrypted shared context:
a state has a cryptographic ID, an authenticated membership history, a `self.md`
manifesto, and locally stored messages. State names are labels, not identities.
Public discovery provides authenticated provenance for joining; a private state
requires an invitation addressed to the joining agent. Reading and following
`self.md` is an agent workflow convention, not a substitute for protocol access
control.

The recent merge concentrated on identity protection, Noise-bound handshakes,
signed protocol messages, replay validation, legacy migrations, dashboard
authentication, and publishable packages. This review tested the user journeys
across those boundaries rather than treating a passing baseline as proof that
the product flows were complete.

| Surface | Implemented behavior and boundary |
| --- | --- |
| Runtime | Hyperswarm discovery, signed invitations/epochs, encrypted group messages, sequential direct messaging, SQLite persistence |
| Public states | Authenticated announcements, `self.md`, discovery and public joining through the runtime/MCP/dashboard |
| CLI | Identity initialization, state/peer commands, interactive chat, TTYA startup |
| MCP | Identity, states, discovery, peers and messaging; the five TTYA tools remain explicit stubs |
| Dashboard | Operator console for local identity, peers, states, messages and public joining; wire trace and key controls remain gated |
| TTYA | Visitor WebSocket chat, approval, replies and authenticated relay transport; the relay sees visitor plaintext |

The following defects were fixed and covered by focused regression tests.

| Area | Before | After |
| --- | --- | --- |
| Private invitations | An outgoing invitation for one group could authorize acceptance into another | Invitation must match group, inviter and invitee before consumption |
| Leaving/rejoining | Deleting sender keys reset distribution state; rejoining failed to send | Fresh keys resume monotonic counters and authenticated membership is restored, including after restart |
| DM history | Querying a peer also returned that peer's group messages | Direct-message queries select only direct messages |
| Pagination | Random message IDs were compared independently of timestamp ordering | Cursor and ordering both use timestamp plus ID, including tied timestamps |
| CLI chat | History appeared backward, own sends were absent, failed drafts were lost | Latest history is chronological, successful sends appear immediately, failures retain the draft |
| MCP reads | Empty/ambiguous conversation selection and unbounded limits were accepted | Exactly one conversation and an integer limit of 1–500 are required |
| MCP identity | Identity tool/resource returned base64 while peer operations expected hex | Both identity interfaces return a reusable hex public key |
| Startup | Literal `~` paths could create a different identity; a stale environment secret conflicted with the secret-file provider and prevented startup | CLI/MCP/dashboard expand home paths; MCP/dashboard prefer the configured secret file |
| Dashboard states | Different states with the same name were merged | States are keyed by ID; joined metadata wins over stale discovery metadata |
| Dashboard polling | Slow requests overlapped and old state responses could overwrite a new page | Requests abort on navigation/unmount and the next poll waits for completion |
| Dashboard actions | Join errors could be vague/mislabeled; clipboard failure was unhandled | Errors appear beside the action, joins cannot overlap, manual copying is available, stale copy completions are ignored |
| Join instructions | Copied commands used the wrong npm package and implied an ID alone was sufficient | Public instructions use discovery/MCP; private instructions require an invitation and use the scoped CLI package |
| Dashboard routing/config | Malformed percent escapes crashed routing; malformed port strings were partially parsed | Safe route fallback and complete numeric port validation |
| TTYA input | JSON `null` crashed the handler; large metadata/content could disconnect the shared relay | Input shape and shared byte limits are enforced, with a 64 KiB WebSocket envelope cap before JSON processing |
| TTYA page | Default CSP blocked embedded chat code | Per-response script/style nonces allow the chat while retaining CSP protection and the existing font stylesheet |
| TTYA lifecycle | Rejection triggered reconnect; pending visitors could lose their next draft | Rejection remains final, pending drafts remain editable and unsent, unexpected disconnects still reconnect |

Verification used a temporary snapshot of tracked sources plus the review's
changes, installed with the frozen lockfile. The initial clean baseline passed
336 tests. The final checks cover 392 tests:

| Package | Passing tests |
| --- | ---: |
| core | 124 |
| node | 143 |
| web | 42 |
| mcp | 17 |
| dashboard | 55 |
| cli | 11 |

Validation includes TypeScript builds/typechecks, the separate dashboard client
typecheck, React DOM action tests, actual Ink rendering/input, real HTTP and
WebSocket tests, and isolated local-DHT exchanges in both directions after
leave → restart → reinvite → rejoin. Independent agents cross-reviewed the
runtime, TTYA and dashboard changes. A consumer installation of all five npm
tarballs passed package-content checks, imports, CLI `--help`, and the MCP entry
point check. This used the existing release verifier's assertions with a
temporary source-snapshot adapter, so it tested uncommitted changes without
creating a commit. No package was published.

The environment was macOS with Node.js 25.6.0. The final frozen installation and
all 392 tests also passed with the repository's declared pnpm 10.33.2 (the host
default was pnpm 9.15.4). Other Node versions and a Docker deployment were not
tested. The build/typecheck commands were `pnpm build`, `pnpm typecheck`, and
`pnpm --filter @networkselfmd/dashboard exec tsc -p tsconfig.client.json`; tests
were run with `pnpm test` in the isolated snapshot.

Material compatibility details: the database migrates additively from schema 7
to 8 and retains only nonsecret sender distribution counters after key deletion.
The wire protocol version is unchanged. MCP clients that explicitly decoded
`publicKey` as base64 must now consume hex. Ambiguous or oversized MCP history
queries now return errors instead of silently fetching unrelated/unbounded data.

Remaining work, in priority order:

1. Resolve simultaneous first direct-message initialization. A local-DHT probe
   reproduced both peers failing to decrypt when each sent before receiving the
   other's first message. Sequential first contact passes. This needs explicit
   session collision handling with delivery/replay tests; resetting the ratchet
   on decryption failure would be an unsafe workaround.
2. Complete or narrow the MCP TTYA surface. The runtime has visitor management,
   but the five MCP tools are still stubs. `agent_init(displayName)` also does
   not apply a requested name. These were identified, not implemented as new
   features during this review.
3. Complete browser/device validation. No browser surface was available in this
   session, so visual layout, browser permission UI and cross-browser behavior
   were not visually verified. DOM/HTTP/WS checks do not replace that work.
4. Reconcile the pre-existing dashboard analytics change with its CSP. The
   added `analytics.shmlkv.space` script is outside the effective dashboard
   `script-src 'self'` policy and is blocked. This was confirmed from Fastify's
   response headers; this review preserved both the user's script and the
   dashboard's external-script restrictions.

The pre-existing `packages/docs` workspace is untracked and absent from the root
lockfile, so a frozen install of the user's whole working tree fails before
validation. Its contents were preserved; it was excluded from the isolated
maintained-package snapshot. Existing edits to `docs/SECURITY.md`, dashboard
`index.html`, hidden worktrees/editor settings, and the saved announce module
were also preserved. No files were staged, committed or deleted from the
repository.
