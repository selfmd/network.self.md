import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Agent } from '@networkselfmd/node';

export function registerMessagingTools(server: McpServer, agent: Agent): void {
  server.tool(
    'send_state_message',
    `Queue an encrypted message for current state members. Delivery is retried for up to seven days; acceptance is not a delivery receipt. Check delivery_status.
Get the stateId from state_list. You must be a member of the state (use state_join first).`,
    {
      stateId: z.string().describe('State ID (hex) to send the message to — get from state_list'),
      content: z.string().describe('Message text'),
    },
    async ({ stateId, content }) => {
      const messageId = await agent.sendGroupMessage(stateId, content);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ accepted: true, messageId }),
        }],
      };
    },
  );

  server.tool(
    'send_direct_message',
    `Queue an encrypted direct message to a known peer (not through a state).
Offline peers are retried for up to seven days. Get the public key from peer_list; check delivery_status for receipts or failure.`,
    {
      peerPublicKey: z.string().describe('Public key (hex) of the recipient — get from peer_list'),
      content: z.string().describe('Message text'),
    },
    async ({ peerPublicKey, content }) => {
      const messageId = await agent.sendDirectMessage(peerPublicKey, content);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ accepted: true, messageId }),
        }],
      };
    },
  );

  server.tool(
    'delivery_status',
    'Read per-recipient queued, delivered or failed status for outbound messages. Delivered means the recipient durably accepted the message, not that a person or AI read it.',
    { messageId: z.string().min(1).optional().describe('The messageId returned by a send tool; omit to list retained delivery records') },
    async ({ messageId }) => ({
      content: [{ type: 'text' as const, text: JSON.stringify({ deliveries: agent.listDeliveries(messageId) }) }],
    }),
  );

  server.tool(
    'read_messages',
    `Read recent messages. Provide EITHER stateId (for state messages) or peerPublicKey (for direct messages).
Returns messages with sender info, content, and timestamp. Most recent first.`,
    {
      stateId: z.string().min(1).optional().describe('State ID (hex) to read messages from'),
      peerPublicKey: z.string().min(1).optional().describe('Peer public key (hex) for direct messages'),
      limit: z.number().int().min(1).max(500).optional().describe('Max messages to return (1–500, default 50)'),
      before: z.string().optional().describe('Return messages before this message ID (for pagination)'),
    },
    async ({ stateId, peerPublicKey, limit, before }) => {
      if ((stateId === undefined) === (peerPublicKey === undefined)) {
        return {
          content: [{ type: 'text' as const, text: 'Provide exactly one of stateId or peerPublicKey.' }],
          isError: true,
        };
      }
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
