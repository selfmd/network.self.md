import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Agent } from '@networkselfmd/node';

export function registerMessagingTools(server: McpServer, agent: Agent): void {
  server.tool(
    'send_state_message',
    'Send an encrypted message to a state',
    {
      groupId: z.string().describe('State ID (hex)'),
      content: z.string().describe('Message content'),
    },
    async ({ groupId, content }) => {
      await agent.sendGroupMessage(groupId, content);
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
    'Send an encrypted direct message to a peer',
    {
      peerPublicKey: z.string().describe('Public key of the recipient peer'),
      content: z.string().describe('Message content'),
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
    'Read recent messages from a state or direct conversation',
    {
      groupId: z.string().optional().describe('State ID to read messages from'),
      peerPublicKey: z.string().optional().describe('Peer public key for direct messages'),
      limit: z.number().optional().describe('Maximum number of messages to return'),
      before: z.string().optional().describe('Return messages before this message ID'),
    },
    async ({ groupId, peerPublicKey, limit, before }) => {
      const messages = agent.getMessages({ groupId, peerPublicKey, limit, before });
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
