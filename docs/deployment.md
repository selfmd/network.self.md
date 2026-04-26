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
  networkselfmd-dashboard
```

Open `http://127.0.0.1:3001`.

## Environment

See `.env.example`.

- `PORT` — HTTP port, default `3001`
- `HOST` — bind host, default `127.0.0.1` locally; Docker sets `0.0.0.0` inside the container and the example port mapping still binds to localhost on the host
- `L2S_DATA_DIR` — persistent agent identity/network data directory
- `AGENT_NAME` — display name announced by the dashboard agent

## Health checks

- `GET /healthz` — process is alive
- `GET /api/status` — dashboard agent/runtime status
