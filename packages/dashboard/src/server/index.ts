import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Agent } from '@networkselfmd/node';
import { buildApp } from './routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const dataDir = process.env.L2S_DATA_DIR ?? path.join(process.env.HOME ?? '~', '.networkselfmd');

  // Dashboard IS an agent — it joins the P2P network, discovers peers and states
  const agent = new Agent({
    dataDir,
    displayName: process.env.AGENT_NAME,
  });

  await agent.start();
  console.log(`Agent started: ${agent.identity.fingerprint}`);
  console.log(`Display name: ${agent.identity.displayName ?? '(none)'}`);
  console.log(`Data dir: ${dataDir}`);

  // Log network events
  agent.on('peer:connected', (info: any) => {
    console.log(`Peer connected: ${info.displayName ?? info.fingerprint}`);
  });
  agent.on('peer:disconnected', (info: any) => {
    console.log(`Peer disconnected: ${info.fingerprint}`);
  });
  agent.on('network:announce', (data: any) => {
    console.log(`Received announce from ${data.peerFingerprint}: ${data.groups.length} states`);
  });

  const app = await buildApp({ agent });

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

  // Graceful shutdown
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
      console.log('\nShutting down...');
      await app.close();
      await agent.stop();
      process.exit(0);
    });
  }
}

main().catch((err) => {
  console.error('Failed to start dashboard:', err);
  process.exit(1);
});
