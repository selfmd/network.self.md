import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Agent } from '@networkselfmd/node';

const TTYA_NOT_IMPLEMENTED = { error: 'TTYA is not yet implemented in the Agent API' };

export function registerTTYATools(server: McpServer, agent: Agent): void {
  server.tool(
    'ttya_start',
    'Start the TTYA web server for visitor interactions (not yet implemented)',
    {
      port: z.number().optional().describe('Port to listen on (default: 3000)'),
      autoApprove: z.boolean().optional().describe('Auto-approve all visitors'),
    },
    async () => {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(TTYA_NOT_IMPLEMENTED) }],
        isError: true,
      };
    },
  );

  server.tool(
    'ttya_pending',
    'List pending visitors waiting for approval (not yet implemented)',
    {},
    async () => {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(TTYA_NOT_IMPLEMENTED) }],
        isError: true,
      };
    },
  );

  server.tool(
    'ttya_approve',
    'Approve a pending visitor (not yet implemented)',
    {
      visitorId: z.string().describe('ID of the visitor to approve'),
    },
    async () => {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(TTYA_NOT_IMPLEMENTED) }],
        isError: true,
      };
    },
  );

  server.tool(
    'ttya_reject',
    'Reject a pending visitor (not yet implemented)',
    {
      visitorId: z.string().describe('ID of the visitor to reject'),
    },
    async () => {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(TTYA_NOT_IMPLEMENTED) }],
        isError: true,
      };
    },
  );

  server.tool(
    'ttya_reply',
    'Reply to a visitor (not yet implemented)',
    {
      visitorId: z.string().describe('ID of the visitor to reply to'),
      content: z.string().describe('Reply message content'),
    },
    async () => {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(TTYA_NOT_IMPLEMENTED) }],
        isError: true,
      };
    },
  );
}
