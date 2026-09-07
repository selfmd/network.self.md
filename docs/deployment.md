# Deployment

The dashboard is a local network agent with a browser UI. Treat it like an operator console, not a public SaaS page.

## Safety rule

Do **not** expose the dashboard directly to the public internet. It can show local node identity, peers, states, and decrypted room messages for states this node has joined.

Put it behind one of:

- Tailscale / WireGuard / private network
- Cloudflare Access
- reverse proxy with authentication
- an internal-only host

## Docker

```bash
docker build -t networkselfmd-dashboard .

docker run --rm \
  -p 127.0.0.1:3001:3001 \
  -v networkselfmd-data:/data \
  -e DASHBOARD_USERNAME=operator \
  -e DASHBOARD_PASSWORD_FILE=/run/secrets/dashboard-password \
  -v /secure/dashboard-password:/run/secrets/dashboard-password:ro \
  networkselfmd-dashboard
```

Open `http://127.0.0.1:3001`.

## Environment

See `.env.example`.

- `PORT` — HTTP port, default `3001`
- `HOST` — bind host, default `127.0.0.1` locally; Docker sets `0.0.0.0` inside the container and the example port mapping still binds to localhost on the host
- `L2S_DATA_DIR` — persistent agent identity/network data directory
- `L2S_PASSPHRASE_FILE` — preferred path to a mounted identity passphrase secret
- `L2S_PASSPHRASE` — identity passphrase fallback when a secret file is unavailable
- `AGENT_NAME` — display name announced by the dashboard agent
- `DASHBOARD_USERNAME` — HTTP Basic username; required for non-loopback `HOST`
- `DASHBOARD_PASSWORD_FILE` — preferred mounted password file (minimum 16 UTF-8 bytes)
- `DASHBOARD_PASSWORD` — password fallback; do not combine with the file option

The dashboard serves `/healthz` without credentials for container probes. The
HTML application and every `/api/*` route require Basic authentication whenever
credentials are configured. Startup fails closed if `HOST` is non-loopback and
credentials are absent.

## Health checks

- `GET /healthz` — process is alive
- `GET /api/status` — dashboard agent/runtime status
