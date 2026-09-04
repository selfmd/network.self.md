import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Agent } from '@networkselfmd/node';
import { attachAgentLogging } from './agentEvents.js';
import { buildApp } from './routes.js';
import { dashboardAgentOptions, dashboardServerOptions } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const agentOptions = dashboardAgentOptions();
  const serverOptions = await dashboardServerOptions();

  // Dashboard IS an agent — it joins the P2P network, discovers peers and states
  const agent = new Agent(agentOptions);

  attachAgentLogging(agent);

  await agent.start();
  console.log(`Agent started: ${agent.identity.fingerprint}`);
  console.log(`Display name: ${agent.identity.displayName ?? '(none)'}`);
  console.log(`Data dir: ${agentOptions.dataDir}`);

  const app = await buildApp({ agent, auth: serverOptions.auth });

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

  await app.listen({ port: serverOptions.port, host: serverOptions.host });
  console.log(
    `Dashboard: http://${serverOptions.host === '0.0.0.0' ? 'localhost' : serverOptions.host}:${serverOptions.port}`,
  );

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
