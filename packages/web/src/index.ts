/**
 * @networkselfmd/web — TTYA (Talk To Your Agent) web server.
 *
 * Bridges the HTTP/WebSocket world to the P2P Hyperswarm network,
 * letting visitors chat with AI agents through a browser.
 */

export { TTYAServer } from './server.js';
export { TTYABridge } from './bridge.js';
export { ApprovalQueue } from './approval.js';
export type {
  TTYAServerConfig,
  TTYARequest,
  TTYAResponse,
  WSClientMessage,
  WSServerMessage,
} from './types.js';
export { DEFAULT_CONFIG } from './types.js';
export type { VisitorSession, ApprovalQueueConfig } from './approval.js';
