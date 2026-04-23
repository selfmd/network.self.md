import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Agent } from '@networkselfmd/node';

export function registerIdentityTools(server: McpServer, agent: Agent): void {
  server.tool(
    'agent_init',
    'Initialize the agent (starts networking and loads or generates identity)',
    {
      displayName: z.string().optional().describe('Human-readable display name for this agent'),
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
            publicKey: Buffer.from(identity.edPublicKey).toString('base64'),
          }),
        }],
      };
    },
  );

  server.tool(
    'agent_status',
    'Show current agent status including identity, peers, groups, and TTYA',
    {},
    async () => {
      const groups = agent.listGroups();
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            identity: agent.identity ? {
              fingerprint: agent.identity.fingerprint,
              displayName: agent.identity.displayName,
            } : null,
            peerCount: agent.peers.size,
            groups: groups.map(g => ({
              id: Buffer.from(g.groupId).toString('hex'),
              name: g.name,
              memberCount: g.memberCount,
            })),
            ttyaStatus: 'not implemented',
          }),
        }],
      };
    },
  );
}
