import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Agent, PolicyAuditEntry, PolicyConfig } from '@networkselfmd/node';
import { PolicyConfigValidationError, POLICY_LIMITS } from '@networkselfmd/node';

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

// MCP-facing config DTO. PolicyConfig is already metadata-only by
// design (operator-supplied trusted fingerprints, interest keywords,
// boolean flags, integer prefix length). The DTO mirrors it
// explicitly — like toPolicyAuditDTO above, this is a defence-in-depth
// projection so future PolicyConfig additions don't auto-propagate
// over MCP without a deliberate code change.
export interface PolicyConfigDTO {
  trustedFingerprints?: string[];
  interests?: string[];
  requireMention?: boolean;
  mentionPrefixLen?: number;
}

export function toPolicyConfigDTO(c: PolicyConfig): PolicyConfigDTO {
  const out: PolicyConfigDTO = {};
  if (c.trustedFingerprints !== undefined) {
    out.trustedFingerprints = c.trustedFingerprints.slice();
  }
  if (c.interests !== undefined) out.interests = c.interests.slice();
  if (c.requireMention !== undefined) out.requireMention = c.requireMention;
  if (c.mentionPrefixLen !== undefined) out.mentionPrefixLen = c.mentionPrefixLen;
  return out;
}

function describeValidationError(err: unknown): string {
  if (err instanceof PolicyConfigValidationError) {
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return 'unknown error';
}

// Common operator-control disclaimer attached to every policy mutation
// tool description. Keeps the privacy/scope reminders consistent and
// in plain sight of MCP clients.
const OPERATOR_DISCLAIMER =
  ' Owner-private, local-only operator control. No tool execution, no plaintext storage, no payments. Do NOT forward results to public dashboards, census, or shared logs.';

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

  server.tool(
    'get_policy_config',
    'Read the current policy gate configuration (trusted fingerprints, interest keywords, mention behavior).' + OPERATOR_DISCLAIMER,
    {},
    async () => ({
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ config: toPolicyConfigDTO(agent.getPolicyConfig()) }),
      }],
    }),
  );

  // Bounded zod schemas mirror the runtime validator in the node
  // package. Defence-in-depth — even if a buggy MCP client gets past
  // the zod layer, validatePolicyConfig at the agent boundary will
  // catch it.
  const fingerprintList = z
    .array(z.string().min(POLICY_LIMITS.minFingerprintLength).max(POLICY_LIMITS.maxFingerprintLength))
    .max(POLICY_LIMITS.maxTrustedFingerprints);
  const interestList = z
    .array(z.string().min(1).max(POLICY_LIMITS.maxInterestLength))
    .max(POLICY_LIMITS.maxInterests);

  server.tool(
    'set_policy_config',
    'Replace the policy gate configuration. Validates input; on bad shape returns an error and does NOT modify state.' + OPERATOR_DISCLAIMER,
    {
      trustedFingerprints: fingerprintList.optional(),
      interests: interestList.optional(),
      requireMention: z.boolean().optional(),
      mentionPrefixLen: z
        .number()
        .int()
        .min(POLICY_LIMITS.minMentionPrefixLen)
        .max(POLICY_LIMITS.maxMentionPrefixLen)
        .optional(),
    },
    async (args) => {
      try {
        agent.setPolicyConfig(args);
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ ok: false, error: describeValidationError(err) }),
          }],
          isError: true,
        };
      }
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ ok: true, config: toPolicyConfigDTO(agent.getPolicyConfig()) }),
        }],
      };
    },
  );

  // Convenience: add a single trusted fingerprint without re-supplying
  // the rest of the config. Idempotent (no error if already present).
  server.tool(
    'add_policy_trusted_fingerprint',
    'Add a peer fingerprint to the trusted list. Idempotent.' + OPERATOR_DISCLAIMER,
    {
      fingerprint: z
        .string()
        .min(POLICY_LIMITS.minFingerprintLength)
        .max(POLICY_LIMITS.maxFingerprintLength),
    },
    async ({ fingerprint }) => {
      try {
        const cur = agent.getPolicyConfig();
        const set = new Set(cur.trustedFingerprints ?? []);
        set.add(fingerprint);
        agent.updatePolicyConfig({ trustedFingerprints: Array.from(set) });
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: describeValidationError(err) }) }],
          isError: true,
        };
      }
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ ok: true, trustedFingerprints: agent.getPolicyConfig().trustedFingerprints ?? [] }),
        }],
      };
    },
  );

  server.tool(
    'remove_policy_trusted_fingerprint',
    'Remove a peer fingerprint from the trusted list. Idempotent.' + OPERATOR_DISCLAIMER,
    {
      fingerprint: z
        .string()
        .min(POLICY_LIMITS.minFingerprintLength)
        .max(POLICY_LIMITS.maxFingerprintLength),
    },
    async ({ fingerprint }) => {
      try {
        const cur = agent.getPolicyConfig();
        const next = (cur.trustedFingerprints ?? []).filter((fp) => fp !== fingerprint.toLowerCase());
        agent.updatePolicyConfig({ trustedFingerprints: next });
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: describeValidationError(err) }) }],
          isError: true,
        };
      }
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ ok: true, trustedFingerprints: agent.getPolicyConfig().trustedFingerprints ?? [] }),
        }],
      };
    },
  );

  server.tool(
    'add_policy_interest',
    'Add an interest keyword to the policy. Idempotent.' + OPERATOR_DISCLAIMER,
    {
      keyword: z.string().min(1).max(POLICY_LIMITS.maxInterestLength),
    },
    async ({ keyword }) => {
      try {
        const cur = agent.getPolicyConfig();
        const set = new Set(cur.interests ?? []);
        set.add(keyword);
        agent.updatePolicyConfig({ interests: Array.from(set) });
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: describeValidationError(err) }) }],
          isError: true,
        };
      }
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ ok: true, interests: agent.getPolicyConfig().interests ?? [] }),
        }],
      };
    },
  );

  server.tool(
    'remove_policy_interest',
    'Remove an interest keyword from the policy. Idempotent.' + OPERATOR_DISCLAIMER,
    {
      keyword: z.string().min(1).max(POLICY_LIMITS.maxInterestLength),
    },
    async ({ keyword }) => {
      try {
        const cur = agent.getPolicyConfig();
        const next = (cur.interests ?? []).filter((k) => k !== keyword);
        agent.updatePolicyConfig({ interests: next });
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: describeValidationError(err) }) }],
          isError: true,
        };
      }
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ ok: true, interests: agent.getPolicyConfig().interests ?? [] }),
        }],
      };
    },
  );
}
