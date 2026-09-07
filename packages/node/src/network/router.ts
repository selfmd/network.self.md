import type { ProtocolMessage } from '@networkselfmd/core';
import type { PeerSession } from './connection.js';

export type MessageHandler = (
  session: PeerSession,
  message: ProtocolMessage,
) => void | Promise<void>;

export class MessageRouter {
  private handlers = new Map<number, MessageHandler[]>();

  on(messageType: number, handler: MessageHandler): void {
    const existing = this.handlers.get(messageType) ?? [];
    existing.push(handler);
    this.handlers.set(messageType, existing);
  }

  off(messageType: number, handler: MessageHandler): void {
    const existing = this.handlers.get(messageType);
    if (!existing) return;
    const idx = existing.indexOf(handler);
    if (idx !== -1) {
      existing.splice(idx, 1);
    }
  }

  async route(session: PeerSession, message: ProtocolMessage): Promise<void> {
    if (session.state !== 'ready') {
      throw new Error(
        `Rejected protocol message ${message.type}: session is not ready`,
      );
    }
    if (message.type === 0x01) {
      throw new Error(
        'Rejected protocol message: IdentityHandshake is invalid after handshake',
      );
    }
    const handlers = this.handlers.get(message.type);
    if (!handlers || handlers.length === 0) {
      throw new Error(
        `Rejected unsupported protocol message type: ${message.type}`,
      );
    }

    for (const handler of handlers) {
      try {
        await handler(session, message);
      } catch (err) {
        // Emit error on session for upstream handling
        session.emit('routeError', err, message);
      }
    }
  }
}
