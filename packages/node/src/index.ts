export { Agent } from './agent.js';
export type { AgentOptions, MemberInfo, Message } from './agent.js';

export { AgentDatabase } from './storage/database.js';
export {
  IdentityRepository,
  PeerRepository,
  GroupRepository,
  MessageRepository,
  SenderKeyRepository,
} from './storage/repositories.js';

export { PeerSession } from './network/connection.js';
export { SwarmManager } from './network/swarm.js';
export { MessageRouter } from './network/router.js';
export { performHandshake } from './network/handshake.js';

export { GroupManager } from './groups/group-manager.js';

export { InboundEventQueue } from './events/inbound-queue.js';
export type { InboundEventHandler, InboundEventQueueOptions } from './events/inbound-queue.js';
export type {
  InboundMessageKind,
  PrivateInboundMessageEvent,
  PublicActivityEvent,
  PolicyAction,
  PolicyReason,
  PolicyDecisionReason,
  PolicyFailClosedReason,
  PolicyDecision,
  PolicyConfig,
  PolicyAuditEntry,
} from '@networkselfmd/core';
export { POLICY_REASONS, redactPlaintext } from '@networkselfmd/core';

export { AgentPolicy } from './policy/agent-policy.js';
export type { AgentPolicyOptions } from './policy/agent-policy.js';

export { PolicyGate } from './policy/policy-gate.js';
export type { PolicyGateOptions, GateOutcome, IsMemberFn } from './policy/policy-gate.js';

export { PolicyAuditLog } from './policy/audit-log.js';
export type { PolicyAuditLogOptions } from './policy/audit-log.js';

export { validateInboundEvent } from './policy/validate.js';
export type { ValidationResult } from './policy/validate.js';

export {
  validatePolicyConfig,
  formatValidationErrors,
  PolicyConfigValidationError,
  POLICY_LIMITS,
} from './policy/validate-config.js';
export type {
  ValidationError as PolicyConfigValidationItem,
  ValidatedConfig,
} from './policy/validate-config.js';

export {
  PolicyConfigRepository,
  PolicyAuditRepository,
  POLICY_AUDIT_LIMITS,
} from './storage/index.js';
export type {
  StoredPolicyAuditRow,
  PolicyAuditRepositoryOptions,
  PolicyAuditRecentOptions,
  PolicyAuditPruneOptions,
} from './storage/index.js';
