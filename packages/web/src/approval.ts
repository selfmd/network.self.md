/**
 * Visitor approval queue for TTYA.
 *
 * Manages the state machine for visitor sessions:
 *   pending -> approved | rejected | blocked
 */

import { createId } from '@paralleldrive/cuid2';
import type { WebSocket } from '@fastify/websocket';

export interface VisitorSession {
  visitorId: string;
  status: 'pending' | 'approved' | 'rejected' | 'blocked';
  firstMessage: string;
  ipHash: string;
  timestamp: number;
  sessionToken?: string;
  websocket: WebSocket;
  lastMessageAt: number;
}

export interface ApprovalQueueConfig {
  maxPending: number;
  autoApprove: boolean;
  sessionTimeout: number;
}

export class ApprovalQueue {
  private sessions = new Map<string, VisitorSession>();
  private blockedIps = new Set<string>();
  private config: ApprovalQueueConfig;

  constructor(config: ApprovalQueueConfig) {
    this.config = config;
  }

  /**
   * Register a new visitor. Returns the session if added, null if queue is full or IP is blocked.
   */
  addVisitor(
    visitorId: string,
    firstMessage: string,
    ipHash: string,
    ws: WebSocket,
  ): VisitorSession | null {
    if (this.blockedIps.has(ipHash)) {
      return null;
    }

    const pendingCount = this.getPending().length;
    if (pendingCount >= this.config.maxPending) {
      return null;
    }

    const now = Date.now();
    const session: VisitorSession = {
      visitorId,
      status: this.config.autoApprove ? 'approved' : 'pending',
      firstMessage,
      ipHash,
      timestamp: now,
      websocket: ws,
      lastMessageAt: now,
    };

    if (this.config.autoApprove) {
      session.sessionToken = createId();
    }

    this.sessions.set(visitorId, session);
    return session;
  }

  /**
   * Approve a pending visitor. Returns the session token.
   */
  approve(visitorId: string): string {
    const session = this.sessions.get(visitorId);
    if (!session) {
      throw new Error(`Unknown visitor: ${visitorId}`);
    }
    if (session.status !== 'pending') {
      throw new Error(`Visitor ${visitorId} is ${session.status}, cannot approve`);
    }

    session.status = 'approved';
    session.sessionToken = createId();
    return session.sessionToken;
  }

  /**
   * Reject a pending visitor.
   */
  reject(visitorId: string): void {
    const session = this.sessions.get(visitorId);
    if (!session) {
      throw new Error(`Unknown visitor: ${visitorId}`);
    }
    session.status = 'rejected';
  }

  /**
   * Block an IP hash. All current sessions from that IP are also rejected.
   */
  block(ipHash: string): void {
    this.blockedIps.add(ipHash);

    for (const session of this.sessions.values()) {
      if (session.ipHash === ipHash && session.status === 'pending') {
        session.status = 'blocked';
      }
    }
  }

  isApproved(visitorId: string): boolean {
    const session = this.sessions.get(visitorId);
    return session?.status === 'approved';
  }

  isBlocked(ipHash: string): boolean {
    return this.blockedIps.has(ipHash);
  }

  getSession(visitorId: string): VisitorSession | undefined {
    return this.sessions.get(visitorId);
  }

  getPending(): VisitorSession[] {
    const result: VisitorSession[] = [];
    for (const session of this.sessions.values()) {
      if (session.status === 'pending') {
        result.push(session);
      }
    }
    return result;
  }

  /**
   * Update the lastMessageAt timestamp for a visitor.
   */
  touch(visitorId: string): void {
    const session = this.sessions.get(visitorId);
    if (session) {
      session.lastMessageAt = Date.now();
    }
  }

  /**
   * Remove expired sessions (older than sessionTimeout).
   */
  cleanup(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.lastMessageAt > this.config.sessionTimeout) {
        try {
          session.websocket.close();
        } catch {
          // websocket may already be closed
        }
        this.sessions.delete(id);
      }
    }
  }

  /**
   * Remove a specific visitor session.
   */
  remove(visitorId: string): void {
    this.sessions.delete(visitorId);
  }

  /**
   * Total active sessions count.
   */
  get size(): number {
    return this.sessions.size;
  }
}
