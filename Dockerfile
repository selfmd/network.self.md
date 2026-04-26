FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update   && apt-get install -y --no-install-recommends python3 make g++ ca-certificates   && rm -rf /var/lib/apt/lists/*   && corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages

RUN pnpm install --frozen-lockfile   && pnpm -r build   && pnpm prune --prod

ENV NODE_ENV=production   PORT=3001   HOST=0.0.0.0   L2S_DATA_DIR=/data   AGENT_NAME=network-selfmd-dashboard

RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 3001
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3   CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3001) + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "packages/dashboard/dist/server/index.js"]
