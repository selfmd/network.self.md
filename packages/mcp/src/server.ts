import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Agent } from '@networkselfmd/node';
import { registerIdentityTools } from './tools/identity.js';
import { registerGroupTools } from './tools/groups.js';
import { registerMessagingTools } from './tools/messaging.js';
import { registerTTYATools } from './tools/ttya.js';
import { registerPeerTools } from './tools/peers.js';
import { registerResources } from './resources.js';

export function createServer(agent: Agent): McpServer {
  const server = new McpServer({
    name: 'networkselfmd',
    version: '0.1.0',
  });

  registerIdentityTools(server, agent);
  registerGroupTools(server, agent);
  registerMessagingTools(server, agent);
  registerTTYATools(server, agent);
  registerPeerTools(server, agent);
  registerResources(server, agent);

  return server;
}
