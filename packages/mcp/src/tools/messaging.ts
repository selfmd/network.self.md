import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Agent } from '@networkselfmd/node';

export function registerMessagingTools(server: McpServer, agent: Agent): void {
  server.tool(
    'send_state_message',
    `Send an encrypted message to a state you belong to. All members will receive it.
Get the stateId from state_list. You must be a member of the state (use state_join first).`,
    {
      stateId: z.string().describe('State ID (hex) to send the message to — get from state_list'),
      content: z.string().describe('Message text'),
    },
    async ({ stateId, content }) => {
      await agent.sendGroupMessage(stateId, content);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ sent: true }),
        }],
      };
    },
  );

  server.tool(
    'send_direct_message',
    `Send an encrypted direct message to a specific peer (not through a state).
The peer must be online and connected. Get their public key from peer_list.`,
    {
      peerPublicKey: z.string().describe('Public key (hex) of the recipient — get from peer_list'),
      content: z.string().describe('Message text'),
    },
    async ({ peerPublicKey, content }) => {
      await agent.sendDirectMessage(peerPublicKey, content);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ sent: true }),
        }],
      };
    },
  );

  server.tool(
    'read_messages',
    `Read recent messages. Provide EITHER stateId (for state messages) or peerPublicKey (for direct messages).
Returns messages with sender info, content, and timestamp. Most recent first.`,
    {
      stateId: z.string().optional().describe('State ID (hex) to read messages from'),
      peerPublicKey: z.string().optional().describe('Peer public key (hex) for direct messages'),
      limit: z.number().optional().describe('Max messages to return (default 50)'),
      before: z.string().optional().describe('Return messages before this message ID (for pagination)'),
    },
    async ({ stateId, peerPublicKey, limit, before }) => {
      const messages = agent.getMessages({
        groupId: stateId,
        peerPublicKey,
        limit,
        before,
      });
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            messages: messages.map(m => ({
              id: m.id,
              senderPublicKey: m.senderPublicKey
                ? Buffer.from(m.senderPublicKey).toString('hex')
                : undefined,
              content: m.content,
              timestamp: m.timestamp,
              type: m.type,
            })),
          }),
        }],
      };
    },
  );
}
