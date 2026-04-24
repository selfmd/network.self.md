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
} from '@networkselfmd/core';
