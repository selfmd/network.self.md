import Database from 'better-sqlite3';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildApp } from './routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const dataDir = process.env.L2S_DATA_DIR ?? path.join(process.env.HOME ?? '~', '.networkselfmd');
  const dbPath = path.join(dataDir, 'agent.db');

  if (!existsSync(dbPath)) {
    console.error(`Database not found: ${dbPath}`);
    console.error('Make sure your agent is running (MCP or CLI) first.');
    process.exit(1);
  }

  // Open database read-only — no Agent, no Hyperswarm
  const db = new Database(dbPath, { readonly: true });
  db.pragma('journal_mode = WAL');
  console.log(`Reading from: ${dbPath}`);

  const app = await buildApp({ db });

  // Serve static client build if it exists
  const clientDist = path.resolve(__dirname, '../../dist/client');
  if (existsSync(clientDist)) {
    const fastifyStatic = await import('@fastify/static');
    await app.register(fastifyStatic.default, {
      root: clientDist,
      wildcard: false,
    });

    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith('/api')) {
        return reply.status(404).send({ error: 'Not found' });
      }
      return reply.sendFile('index.html');
    });
  }

  const port = parseInt(process.env.PORT ?? '3001', 10);
  await app.listen({ port, host: '0.0.0.0' });
  console.log(`Dashboard: http://localhost:${port}`);
}

main().catch((err) => {
  console.error('Failed to start dashboard:', err);
  process.exit(1);
});
