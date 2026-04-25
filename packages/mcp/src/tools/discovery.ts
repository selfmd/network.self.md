import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Agent } from '@networkselfmd/node';

export function registerDiscoveryTools(server: McpServer, agent: Agent): void {
  server.tool(
    'discover_states',
    'List public states discovered from the network',
    {},
    async () => {
      const states = agent.listDiscoveredGroups();
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            states: states.map(s => ({
              stateId: Buffer.from(s.groupId).toString('hex'),
              name: s.name,
              selfMd: s.selfMd,
              memberCount: s.memberCount,
            })),
          }),
        }],
      };
    },
  );

  server.tool(
    'join_public_state',
    'Join a discovered public state',
    {
      stateId: z.string().describe('State ID (hex)'),
    },
    async ({ stateId }) => {
      await agent.joinPublicGroup(stateId);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ success: true, stateId }),
        }],
      };
    },
  );

  server.tool(
    'make_state_public',
    'Make an existing state public with a self.md',
    {
      stateId: z.string().describe('State ID (hex)'),
      selfMd: z.string().describe('Self.md content describing the state'),
    },
    async ({ stateId, selfMd }) => {
      agent.makeGroupPublic(stateId, selfMd);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ success: true, stateId }),
        }],
      };
    },
  );

  server.tool(
    'found_public_state',
    'Found a new public state with self.md',
    {
      name: z.string().describe('Name for the new state'),
      selfMd: z.string().describe('Self.md content describing the state'),
    },
    async ({ name, selfMd }) => {
      const result = await agent.createGroup(name, { public: true, selfMd });
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            stateId: Buffer.from(result.groupId).toString('hex'),
            name,
          }),
        }],
      };
    },
  );
}
