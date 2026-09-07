import { DoubleRatchet } from '@networkselfmd/core';
import type { DirectEncryptedMessage, DoubleRatchetState } from '@networkselfmd/core';

// A first-send race can leave initial messages in flight on the losing chain.
// Retain at most one receiver, only within the authenticated replay window.
export const DM_BOOTSTRAP_WINDOW_MS = 10 * 60 * 1000;

export interface DirectRatchetSession {
  active: DoubleRatchetState;
  /** Only new reliable initial senders get this nonsecret renewal authority. */
  bootstrapPending?: boolean;
  // Before a collision, persist eligibility only: never the identity's static
  // X25519 private key or initial shared secret. After success, pin a receiver.
  initialReceiver?: { state?: DoubleRatchetState; expiresAt: number };
}

export function pruneDirectRatchetSession(
  session: DirectRatchetSession,
  now = Date.now(),
): DirectRatchetSession {
  return session.initialReceiver && session.initialReceiver.expiresAt <= now
    // Until the canonical branch has received a message, the peer may still
    // be sending on its pinned losing branch. Keep that one receive-only state
    // (never reconstruct it) across idle periods; storage remains bounded.
    && !(session.initialReceiver.state && session.active.receiveChainKey === null)
    ? { active: session.active, bootstrapPending: session.bootstrapPending }
    : session;
}

export function renewPendingBootstrap(session: DirectRatchetSession, expiresAt: number): DirectRatchetSession {
  const current = pruneDirectRatchetSession(session);
  if (current.active.receiveChainKey !== null || (!current.bootstrapPending && !current.initialReceiver?.state)) return current;
  return { ...current, initialReceiver: {
    ...current.initialReceiver,
    expiresAt: Math.max(current.initialReceiver?.expiresAt ?? 0, expiresAt),
  } };
}

/** Called only after the signed envelope and durable replay reservation pass. */
export function decryptDirectRatchet(
  saved: DirectRatchetSession,
  message: DirectEncryptedMessage,
  ownFingerprint: string,
  peerFingerprint: string,
  createInitialReceiver: () => DoubleRatchetState,
): { plaintext: Uint8Array; session: DirectRatchetSession } {
  const session = pruneDirectRatchetSession(saved);
  const decrypt = (state: DoubleRatchetState) => DoubleRatchet.decrypt(
    state, message.ratchetPublicKey, message.previousChainLength,
    message.messageNumber, message.nonce, message.ciphertext,
  );

  try {
    const result = decrypt(session.active);
    // A lower peer replying on our branch cannot also have a competing initial
    // branch: it would have kept that branch instead. Close bootstrap now.
    return { plaintext: result.plaintext, session: ownFingerprint > peerFingerprint
      ? { active: result.nextState }
      : { ...session, active: result.nextState, bootstrapPending: undefined } };
  } catch (error) {
    // Eligibility was persisted BEFORE our first send. Only this explicit,
    // unconsumed marker permits a transient receiver derived from the unlocked
    // identity. Established/legacy sessions never acquire this eligibility.
    // A failed attempt mutates neither state nor the persisted marker.
    const candidate = session.initialReceiver;
    if (!candidate || candidate.expiresAt <= Date.now() || message.previousChainLength !== 0) throw error;
    const receivingKey = candidate.state?.receiveRatchetPublic;
    if (receivingKey && !Buffer.from(receivingKey).equals(Buffer.from(message.ratchetPublicKey))) {
      throw error;
    }
    const result = decrypt(candidate.state ?? createInitialReceiver());
    if (result.nextState.skippedKeys.size > 256) {
      throw new Error('Too many skipped initial direct messages');
    }

    // Both peers choose the initial session started by the smaller identity.
    // The winner keeps its send ratchet; its extra receiver only drains the
    // loser's initial chain, and can never initiate another DH session.
    if (ownFingerprint < peerFingerprint) {
      const receiveOnly = {
        ...result.nextState,
        rootKey: new Uint8Array(32),
        sendChainKey: null,
        sendRatchetPrivate: new Uint8Array(32),
        sendRatchetPublic: new Uint8Array(32),
      };
      return {
        plaintext: result.plaintext,
        session: { ...session, bootstrapPending: undefined, initialReceiver: { ...candidate, state: receiveOnly } },
      };
    }
    return { plaintext: result.plaintext, session: { active: result.nextState } };
  }
}
