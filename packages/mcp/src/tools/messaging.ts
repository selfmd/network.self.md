import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Agent, PrivateInboundMessageEvent } from '@networkselfmd/node';

export interface InboundEventDTO {
  kind: 'group' | 'dm';
  messageId: string;
  groupIdHex?: string;
  senderPublicKeyHex: string;
  senderFingerprint: string;
  plaintextUtf8?: string;
  plaintextBase64: string;
  timestamp: number;
  receivedAt: number;
}

export function toInboundEventDTO(ev: PrivateInboundMessageEvent): InboundEventDTO {
  const dto: InboundEventDTO = {
    kind: ev.kind,
    messageId: ev.messageId,
    groupIdHex: ev.groupId ? Buffer.from(ev.groupId).toString('hex') : undefined,
    senderPublicKeyHex: Buffer.from(ev.senderPublicKey).toString('hex'),
    senderFingerprint: ev.senderFingerprint,
    plaintextBase64: Buffer.from(ev.plaintext).toString('base64'),
    timestamp: ev.timestamp,
    receivedAt: ev.receivedAt,
  };
  // Strict UTF-8 decode. If plaintext isn't valid UTF-8, omit the field —
  // consumers fall back to plaintextBase64.
  try {
    dto.plaintextUtf8 = new TextDecoder('utf-8', { fatal: true }).decode(ev.plaintext);
  } catch {
    // non-UTF-8 payload — plaintextUtf8 stays undefined
  }
  return dto;
}

export function registerMessagingTools(server: McpServer, agent: Agent): void {
  server.tool(
    'send_group_message',
    'Send an encrypted message to a group',
    {
      groupId: z.string().describe('Group ID (hex)'),
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
    'get_pending_inbound_events',
    'Owner-private, local-only. Drains pending inbound (authenticated, decrypted) message events for the owner\'s agent runtime so it can decide act | ask | ignore. Results may contain plaintext — do NOT forward them to public dashboards, census, heartbeat, shared logs, or any non-owner surface.',
    {
      limit: z.number().optional().describe('Maximum number of events to drain (default 50)'),
    },
    async ({ limit }) => {
      const events = agent.inboundQueue.drain(limit ?? 50);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ events: events.map(toInboundEventDTO) }),
        }],
      };
    },
  );

  server.tool(
    'read_messages',
    'Read recent messages from a group or direct conversation',
    {
      groupId: z.string().optional().describe('Group ID to read messages from'),
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
