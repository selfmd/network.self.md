import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { generateIdentity } from '@networkselfmd/core';
import type { AgentIdentity } from '@networkselfmd/core';
import { PeerSession } from '../../network/connection.js';

// Shared test helpers for GroupManager-style tests. Kept under __tests__ so
// they ship only with test scope and never end up in dist output.

export function makeIdentity(displayName: string): AgentIdentity {
  return generateIdentity(displayName);
}

export function makeMockSocket() {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    write: () => true,
    end: () => {},
    destroy: () => {},
    on: (event: string, handler: (...args: unknown[]) => void) => {
      const arr = handlers.get(event) ?? [];
      arr.push(handler);
      handlers.set(event, arr);
    },
    removeAllListeners: (event?: string) => {
      if (event) handlers.delete(event);
      else handlers.clear();
    },
    remotePublicKey: randomBytes(32),
  };
}

export function makeMockSession(peerIdentity: AgentIdentity): PeerSession {
  const session = new PeerSession(makeMockSocket());
  session.setVerified(
    peerIdentity.edPublicKey,
    peerIdentity.fingerprint,
    peerIdentity.displayName,
  );
  return session;
}

export function makeMockSwarm(options: {
  sessions?: PeerSession[];
  sessionByFingerprint?: Map<string, PeerSession>;
} = {}) {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    getSession: (fingerprint: string) => options.sessionByFingerprint?.get(fingerprint),
    getAllSessions: (): PeerSession[] => options.sessions ?? [],
    join: async () => undefined,
    leave: async () => undefined,
  });
}
