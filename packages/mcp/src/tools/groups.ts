import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Agent } from '@networkselfmd/node';

export function registerGroupTools(server: McpServer, agent: Agent): void {
  server.tool(
    'state_found',
    'Found a new state',
    {
      name: z.string().describe('Name for the new state'),
    },
    async ({ name }) => {
      const result = await agent.createGroup(name);
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

  server.tool(
    'state_list',
    'List all states this agent belongs to',
    {},
    async () => {
      const states = agent.listGroups();
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            states: states.map(s => ({
              id: Buffer.from(s.groupId).toString('hex'),
              name: s.name,
              memberCount: s.memberCount,
              role: s.role,
              selfMd: s.selfMd,
              isPublic: s.isPublic,
            })),
          }),
        }],
      };
    },
  );

  server.tool(
    'state_members',
    'List members of a state',
    {
      stateId: z.string().describe('State ID (hex)'),
    },
    async ({ stateId }) => {
      const members = agent.getGroupMembers(stateId);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            members: members.map(m => ({
              publicKey: Buffer.from(m.publicKey).toString('hex'),
              displayName: m.displayName,
              fingerprint: m.fingerprint,
              role: m.role,
            })),
          }),
        }],
      };
    },
  );

  server.tool(
    'state_invite',
    'Invite a peer to a state',
    {
      stateId: z.string().describe('State ID (hex)'),
      peerPublicKey: z.string().describe('Public key of the peer to invite'),
    },
    async ({ stateId, peerPublicKey }) => {
      await agent.inviteToGroup(stateId, peerPublicKey);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ success: true }),
        }],
      };
    },
  );

  server.tool(
    'state_join',
    'Join a state by ID',
    {
      stateId: z.string().describe('State ID (hex) to join'),
    },
    async ({ stateId }) => {
      await agent.joinGroup(stateId);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ success: true }),
        }],
      };
    },
  );

  server.tool(
    'state_leave',
    'Leave a state',
    {
      stateId: z.string().describe('State ID (hex) to leave'),
    },
    async ({ stateId }) => {
      await agent.leaveGroup(stateId);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ success: true }),
        }],
      };
    },
  );
}
