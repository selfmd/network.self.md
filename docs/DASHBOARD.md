# Dashboard

Build and run the dashboard from the repository:

```bash
pnpm build
pnpm --filter @networkselfmd/dashboard start
```

The default bind is `127.0.0.1:3001`. Open `http://127.0.0.1:3001/#/operator` for the operator view. The public home and directory show one observer's approved records, not a global network census. Nothing is published without an explicit allowlist.

Loopback HTTP responses omit HTTPS-upgrade and HSTS directives so Safari/WebKit
can load local scripts and styles without attempting an unavailable TLS
connection. Other CSP restrictions remain enabled; external hostnames retain
the default HTTPS security headers.

## Authenticated remote operation

Use an HTTPS reverse proxy and configure the exact browser origin, including a nondefault port if used:

```bash
HOST=0.0.0.0 \
DASHBOARD_USERNAME=operator \
DASHBOARD_PASSWORD_FILE=/run/secrets/dashboard-password \
DASHBOARD_OPERATOR_ORIGIN=https://network.example \
pnpm --filter @networkselfmd/dashboard start
```

The password must contain at least 16 UTF-8 bytes. `DASHBOARD_PASSWORD` is an alternative to the secret file; configure only one. Authentication protects operator APIs and the UI by default. The configured origin allows authenticated browser mutations such as joining discovered public states. Other remote origins are rejected; an origin is not a substitute for credentials. Localhost clients retain their existing access rules.

## Optional public site

Set `DASHBOARD_PUBLIC_SITE=true` and `NETWORK_PUBLICATION_CONFIG` to a server-only JSON file. This mode also requires operator authentication. With both configured, only built static assets and `GET`/`HEAD /api/public/network` become anonymous. Operator identity, messages, private states, peer lists and mutation endpoints remain authenticated.

```bash
HOST=0.0.0.0 \
DASHBOARD_USERNAME=operator \
DASHBOARD_PASSWORD_FILE=/run/secrets/dashboard-password \
DASHBOARD_OPERATOR_ORIGIN=https://network.example \
DASHBOARD_PUBLIC_SITE=true \
NETWORK_PUBLICATION_CONFIG=/run/config/network-publication.json \
pnpm --filter @networkselfmd/dashboard start
```

Use [publication.example.json](../packages/dashboard/publication.example.json) as the configuration shape:

- `stateIds`: exact public-state IDs whose metadata may be published. Private states remain excluded even if listed.
- `stateContextIds`: separate permission to publish shared self.md text for those states.
- `peers`: exact fingerprints mapped to explicitly approved labels. Raw fingerprints remain hidden unless `publishFingerprint` is true.
- `observerLabel`: the public name of this observer.

An empty policy publishes no records. No message history, private policy or inferred network connections is included. Context over 6,000 characters is withheld. The browser intentionally omits credentials when fetching this feed. Leave `DASHBOARD_PUBLIC_SITE` unset or `false` to retain authentication for the entire site/feed.

## Measurement and feature limits

Synchronization percentage and latency percentiles are unavailable: `/api/status` returns `null` and the operator UI labels the measurement unavailable. They are not inferred from peer count or process uptime. Wire traces and identity rotation/revoke/export controls remain explicitly disabled; the API returns 501 for those features. Group sender-key rotation is a separate runtime capability.

The homepage walkthrough uses example conversations. Its file-scope approval scene does not execute tasks or configure permissions. The self.md editor downloads/copies a local draft; it does not attach a policy to an agent.
