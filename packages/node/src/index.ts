export { Agent, IdentityKeyStorageError } from './agent.js';
export type {
  AgentOptions,
  IdentityKeyStorageErrorCode,
  MemberInfo,
  Message,
} from './agent.js';
export { secretFileProvider } from './secrets.js';
export type { SecretProvider } from './secrets.js';

export { AgentDatabase } from './storage/database.js';
export {
  IdentityRepository,
  PeerRepository,
  GroupRepository,
  MessageRepository,
  SenderKeyRepository,
  DiscoveredGroupRepository,
  RatchetStateRepository,
} from './storage/repositories.js';

export { PeerSession } from './network/connection.js';
export { SwarmManager } from './network/swarm.js';
export { MessageRouter } from './network/router.js';
export { performHandshake } from './network/handshake.js';

export { GroupManager } from './groups/group-manager.js';

export { TTYAManager } from './ttya/ttya-manager.js';
export type {
  TTYARequest,
  TTYAResponse,
  TTYAVisitor,
} from './ttya/ttya-manager.js';

export * from './policy/agent-policy.js';
export * from './policy/policy-gate.js';
export * from './policy/audit-log.js';
export * from './policy/validate-config.js';
export * from './events/inbound-queue.js';
export * from './storage/policy.js';

export type { PolicyConfig, PolicyDecision, PolicyAuditEntry, PrivateInboundMessageEvent, PublicActivityEvent } from '@networkselfmd/core';

export { resolveDataDir } from './data-dir.js';
