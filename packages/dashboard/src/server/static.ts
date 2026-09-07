import { existsSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';

/** Only routes serving the public client build may opt out of operator authentication. */
export async function registerClientAssets(app: FastifyInstance, clientDist: string): Promise<void> {
  if (!existsSync(clientDist)) return;
  await app.register(async (assets) => {
    assets.addHook('onRoute', (route) => {
      route.config = { ...route.config, publicSiteAsset: true };
    });
    const fastifyStatic = await import('@fastify/static');
    await assets.register(fastifyStatic.default, { root: clientDist, wildcard: false });
    assets.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith('/api')) {
        return reply.status(404).send({ error: 'Not found' });
      }
      return reply.sendFile('index.html');
    });
  });
}
