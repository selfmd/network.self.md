import { readFile } from 'node:fs/promises';
import { validatePublicPublicationConfig } from './publicNetwork.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent } from '@networkselfmd/node';
import { attachAgentLogging } from './agentEvents.js';
import { buildApp } from './routes.js';
import { registerClientAssets } from './static.js';
import { dashboardAgentOptions, dashboardServerOptions } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const agentOptions = dashboardAgentOptions();
  const serverOptions = await dashboardServerOptions();

  const publication = process.env.NETWORK_PUBLICATION_CONFIG
    ? validatePublicPublicationConfig(JSON.parse(await readFile(process.env.NETWORK_PUBLICATION_CONFIG, 'utf8')))
    : undefined;

  // Dashboard IS an agent — it joins the P2P network, discovers peers and states
  const agent = new Agent(agentOptions);

  attachAgentLogging(agent);

  await agent.start();
  console.log(`Agent started: ${agent.identity.fingerprint}`);
  console.log(`Display name: ${agent.identity.displayName ?? '(none)'}`);
  console.log(`Data dir: ${agentOptions.dataDir}`);

  const app = await buildApp({ agent, auth: serverOptions.auth, publication, operatorOrigin: serverOptions.operatorOrigin, publicSite: serverOptions.publicSite });

  await registerClientAssets(app, path.resolve(__dirname, '../../dist/client'));

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
