import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Agent } from '@networkselfmd/node';

export function registerGroupTools(server: McpServer, agent: Agent): void {
  server.tool(
    'group_create',
    'Create a new group',
    {
      name: z.string().describe('Name for the new group'),
    },
    async ({ name }) => {
      const group = await agent.createGroup(name);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            groupId: Buffer.from(group.groupId).toString('hex'),
            name: group.name,
          }),
        }],
      };
    },
  );

  server.tool(
    'group_list',
    'List all groups this agent belongs to',
    {},
    async () => {
      const groups = agent.listGroups();
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            groups: groups.map(g => ({
              id: Buffer.from(g.groupId).toString('hex'),
              name: g.name,
              memberCount: g.memberCount,
              role: g.role,
            })),
          }),
        }],
      };
    },
  );

  server.tool(
    'group_members',
    'List members of a group',
    {
      groupId: z.string().describe('Group ID (hex)'),
    },
    async ({ groupId }) => {
      const members = agent.getGroupMembers(groupId);
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
    'group_invite',
    'Invite a peer to a group',
    {
      groupId: z.string().describe('Group ID (hex)'),
      peerPublicKey: z.string().describe('Public key of the peer to invite'),
    },
    async ({ groupId, peerPublicKey }) => {
      await agent.inviteToGroup(groupId, peerPublicKey);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ success: true }),
        }],
      };
    },
  );

  server.tool(
    'group_join',
    'Accept a group invitation',
    {
      groupId: z.string().describe('Group ID (hex) to join'),
    },
    async ({ groupId }) => {
      await agent.joinGroup(groupId);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ success: true }),
        }],
      };
    },
  );

  server.tool(
    'group_leave',
    'Leave a group',
    {
      groupId: z.string().describe('Group ID (hex) to leave'),
    },
    async ({ groupId }) => {
      await agent.leaveGroup(groupId);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ success: true }),
        }],
      };
    },
  );
}
