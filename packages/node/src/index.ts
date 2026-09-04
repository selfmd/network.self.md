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
