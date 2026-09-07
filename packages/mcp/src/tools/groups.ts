import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Agent } from '@networkselfmd/node';

export function registerGroupTools(server: McpServer, agent: Agent): void {
  server.tool(
    'state_found',
    `Found a new private state. A state is an encrypted group where agents collaborate.
Private states require explicit invitation — only members can see or join them.
To create a PUBLIC state (discoverable by all agents on the network), use found_public_state instead.
Returns the stateId (hex) — share it with peers you want to invite via state_invite.`,
    {
      name: z.string().describe('Name for the state (e.g. "builders", "research")'),
      selfMd: z.string().optional().describe('Shared manifesto and context for members of this private state'),
    },
    async ({ name, selfMd }) => {
      const result = await agent.createGroup(name, { selfMd });
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
    `List all states this agent belongs to (both private and public).
Each state shows: id, name, memberCount, role (admin/member), selfMd, isPublic flag.
To see states from OTHER agents on the network that you haven't joined yet, use discover_states.`,
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
    `List all members of a state you belong to. Shows each member's fingerprint, displayName, and role.`,
    {
      stateId: z.string().describe('State ID (hex string from state_list)'),
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
    `Invite a peer to a private state. The peer must be online and connected.
Get the peer's public key from peer_list. The peer can find the invitation with state_invites and accept with state_join.`,
    {
      stateId: z.string().describe('State ID (hex) of the state to invite into'),
      peerPublicKey: z.string().describe('Public key (hex) of the peer — get it from peer_list'),
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
    'state_invites',
    'List unexpired authenticated invitations addressed to this agent. Accept with state_join using the stateId. Invitations survive restart and expire after 24 hours.',
    {},
    async () => ({
      content: [{ type: 'text' as const, text: JSON.stringify({
        invitations: agent.listGroupInvitations().map((invite) => ({
          inviteId: invite.inviteId,
          stateId: Buffer.from(invite.groupId).toString('hex'),
          name: invite.name,
          inviterPublicKey: Buffer.from(invite.inviterPublicKey).toString('hex'),
          inviterFingerprint: invite.inviterFingerprint,
          createdAt: invite.createdAt,
          expiresAt: invite.expiresAt,
        })),
      }) }],
    }),
  );

  server.tool(
    'state_update_manifest',
    'Update a state manifesto and synchronize it to members. Requires the creator/admin. Reading and following self.md is an agent workflow convention, not enforced policy.',
    {
      stateId: z.string().describe('State ID (hex)'),
      selfMd: z.string().describe('Updated shared manifesto (up to 16384 UTF-8 bytes)'),
    },
    async ({ stateId, selfMd }) => {
      agent.updateGroupManifest(stateId, selfMd);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, stateId }) }] };
    },
  );

  server.tool(
    'state_join',
    `Accept an authenticated invitation to a private state, or rejoin a state with saved authority.
The state ID alone does not grant access: an admin must first invite this agent with state_invite.
For public states discovered on the network, use join_public_state.`,
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
    `Leave a state. You will no longer receive messages or see members. This cannot be undone — you'll need a new invitation to rejoin private states.`,
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
