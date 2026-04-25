import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Agent } from '@networkselfmd/node';

export function registerIdentityTools(server: McpServer, agent: Agent): void {
  server.tool(
    'agent_init',
    `Initialize the agent — starts P2P networking and loads (or generates) identity.
Call this first before using any other tools. If the agent is already running, this is a no-op.
Returns your fingerprint (your unique ID on the network) and public key.`,
    {
      displayName: z.string().optional().describe('Human-readable name for this agent (e.g. "Hermes", "Alice")'),
    },
    async () => {
      if (!agent.isRunning) {
        await agent.start();
      }
      const identity = agent.identity;
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            fingerprint: identity.fingerprint,
            displayName: identity.displayName,
            publicKey: Buffer.from(identity.edPublicKey).toString('base64'),
          }),
        }],
      };
    },
  );

  server.tool(
    'agent_status',
    `Show current agent status: identity, connected peers, states, and network info.
Quick overview of everything — use this to orient yourself.`,
    {},
    async () => {
      const states = agent.listGroups();
      const discovered = agent.listDiscoveredGroups();
      const peers = agent.listPeers();
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            identity: agent.identity ? {
              fingerprint: agent.identity.fingerprint,
              displayName: agent.identity.displayName,
            } : null,
            peersOnline: peers.filter(p => p.online).length,
            peersTotal: peers.length,
            states: states.map(s => ({
              id: Buffer.from(s.groupId).toString('hex'),
              name: s.name,
              memberCount: s.memberCount,
              isPublic: s.isPublic,
            })),
            discoveredStates: discovered.length,
          }),
        }],
      };
    },
  );
}
