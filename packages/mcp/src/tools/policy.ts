import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Agent, PolicyAuditEntry } from '@networkselfmd/node';

// MCP-facing audit DTO. Metadata-only by construction. Every field on
// PolicyAuditEntry is already privacy-safe (see core/policy/audit.ts),
// but we explicitly enumerate the projection so a future field added to
// PolicyAuditEntry does NOT auto-propagate through the MCP surface
// without a deliberate code change here. Defence in depth.
export interface PolicyAuditDTO {
  auditId: string;
  receivedAt: number;
  eventKind: 'group' | 'dm' | 'unknown';
  messageId?: string;
  groupIdHex?: string;
  senderFingerprint?: string;
  byteLength: number;
  action: 'act' | 'ask' | 'ignore';
  reason: string;
  addressedToMe: boolean;
  senderTrusted: boolean;
  matchedInterests: string[];
  gateRejected: boolean;
}

export function toPolicyAuditDTO(entry: PolicyAuditEntry): PolicyAuditDTO {
  return {
    auditId: entry.auditId,
    receivedAt: entry.receivedAt,
    eventKind: entry.eventKind,
    messageId: entry.messageId,
    groupIdHex: entry.groupIdHex,
    senderFingerprint: entry.senderFingerprint,
    byteLength: entry.byteLength,
    action: entry.action,
    reason: entry.reason,
    addressedToMe: entry.addressedToMe,
    senderTrusted: entry.senderTrusted,
    matchedInterests: entry.matchedInterests.slice(),
    gateRejected: entry.gateRejected,
  };
}

export function registerPolicyTools(server: McpServer, agent: Agent): void {
  server.tool(
    'get_policy_audit_recent',
    'Owner-private, local-only, read-only, metadata-only. Returns recent policy gate decisions for debugging — never includes plaintext, ciphertext, decrypted body, tool args, raw event payloads, or private key material. Safe to inspect; do NOT forward results to public dashboards, census, or shared logs.',
    {
      limit: z.number().int().positive().max(1000).optional().describe('Maximum number of audit entries to return (default 50, newest last; capped at 1000)'),
    },
    async ({ limit }) => {
      const entries = agent.policyAudit.recent(limit ?? 50).map(toPolicyAuditDTO);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ entries }),
        }],
      };
    },
  );
}
