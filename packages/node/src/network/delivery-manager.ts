import {
  DELIVERY_TTL_MS, RELIABLE_DELIVERY_CAPABILITY, MessageType, decodeMessage,
  encodeMessage, signAuthenticatedMessage, signDelivery, verifyDelivery,
  deliveryContentHash, fingerprintFromPublicKey, validateProtocolMessage,
} from '@networkselfmd/core';
import type {
  AgentIdentity, DirectEncryptedMessage, GroupEncryptedMessage,
  ReliableDeliveryMessage, DeliveryReceiptMessage,
} from '@networkselfmd/core';
import { DeliveryRepository, type OutboxRecord } from '../storage/delivery.js';
import type { PeerSession } from './connection.js';
import { validateReadySession, validateFreshTimestamp, MESSAGE_TIMESTAMP_TOLERANCE_MS } from './protocol-security.js';

export interface DeliveryContext {
  messageId: string;
  timestamp: number;
  bootstrapExpiresAt?: number;
  accept(content: string): void;
}
interface Options {
  identity: AgentIdentity;
  repository: DeliveryRepository;
  getSession(fingerprint: string): PeerSession | undefined;
  prepare(row: OutboxRecord, session: PeerSession): Promise<() => DirectEncryptedMessage | GroupEncryptedMessage>;
  receive(session: PeerSession, message: DirectEncryptedMessage | GroupEncryptedMessage, context: DeliveryContext): boolean | Promise<boolean>;
  onDelivered(id: string, peer: Uint8Array): void;
  onError(error: unknown): void;
}
export class DeliveryManager {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private stopped = false;
  constructor(private options: Options) {}
  start(): void {
    this.stopped = false;
    if (!this.timer) this.timer = setInterval(() => { void this.flush(); }, 1000);
    this.timer.unref?.();
    void this.flush();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }
  reconnect(peer: Uint8Array): void {
    this.options.repository.reconnect(peer);
    void this.flush();
  }
  flush(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.pump().catch(error => this.options.onError(error)).finally(() => { this.running = undefined; });
    return this.running;
  }
  private async pump(): Promise<void> {
    const { repository, identity } = this.options;
    for (const row of repository.heads()) {
      if (this.stopped) return;
      const session = this.options.getSession(fingerprintFromPublicKey(row.peer_public_key));
      if (!session || session.state !== 'ready') continue;
      if (!session.peerCapabilities.has(RELIABLE_DELIVERY_CAPABILITY)) {
        repository.fail(row, 'Peer does not support reliable delivery; upgrade all participants');
        continue;
      }
      try {
        // DM retries reuse the committed ciphertext. Group attempts refresh the
        // current sender key before encrypting, because membership/key epochs
        // may have advanced while this recipient was offline.
        const prepare = !row.group_id && row.packet ? undefined : await this.options.prepare(row, session);
        if (this.stopped) return;
        const packet = repository.transaction(() => {
          const saved = row.packet && !row.group_id ? decodeMessage(row.packet) as ReliableDeliveryMessage : undefined;
          const original = saved?.message ?? prepare!();
          const { signature: _, ...unsigned } = original;
          const message = signAuthenticatedMessage({ ...unsigned, timestamp: Date.now() }, identity.edPrivateKey) as DirectEncryptedMessage | GroupEncryptedMessage;
          const packet = signDelivery<ReliableDeliveryMessage>({
            type: MessageType.ReliableDelivery, id: row.id,
            senderFingerprint: identity.fingerprint, recipientFingerprint: session.peerFingerprint!,
            contentHash: row.content_hash, createdAt: row.created_at,
            expiresAt: row.expires_at, timestamp: message.timestamp, message,
          }, identity.edPrivateKey);
          repository.attempt(row, encodeMessage(packet));
          return packet;
        });
        // A crash here is safe: both the ratchet advance and retryable frame
        // were committed atomically, before any bytes went to the socket.
        session.send(packet);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/revoked|no longer a member|group no longer exists/i.test(message)) repository.fail(row, message);
        else repository.defer(row, message);
      }
    }
  }
  async receive(session: PeerSession, packet: ReliableDeliveryMessage): Promise<void> {
    try {
      this.authenticate(session, packet);
      const now = Date.now();
      if (packet.createdAt > now + MESSAGE_TIMESTAMP_TOLERANCE_MS || packet.expiresAt <= now ||
        packet.expiresAt <= packet.createdAt || packet.expiresAt - packet.createdAt > DELIVERY_TTL_MS) {
        throw new Error('Reliable delivery has expired or has an invalid lifetime');
      }
      if (packet.message.senderFingerprint !== packet.senderFingerprint || packet.message.timestamp !== packet.timestamp) throw new Error('Invalid nested delivery context');
      const { repository } = this.options;
      if (!repository.received(packet.senderFingerprint, packet.id, packet.contentHash)) {
        const groupId = packet.message.type === MessageType.GroupMessage ? packet.message.groupId : undefined;
        const accepted = await this.options.receive(session, packet.message, {
          messageId: `${packet.senderFingerprint}:${packet.id}`, timestamp: packet.createdAt,
          bootstrapExpiresAt: packet.expiresAt,
          accept: (content) => {
            if (deliveryContentHash(content, groupId) !== packet.contentHash) throw new Error('Reliable delivery content mismatch');
            repository.accept(packet.senderFingerprint, packet.id, packet.contentHash, packet.expiresAt + MESSAGE_TIMESTAMP_TOLERANCE_MS);
          },
        });
        if (!accepted) return;
      }
      session.send(signDelivery<DeliveryReceiptMessage>({
        type: MessageType.DeliveryReceipt, id: packet.id,
        senderFingerprint: this.options.identity.fingerprint,
        recipientFingerprint: packet.senderFingerprint, timestamp: now,
      }, this.options.identity.edPrivateKey));
    } catch (error) { this.options.onError(error); }
  }
  receipt(session: PeerSession, packet: DeliveryReceiptMessage): void {
    try {
      this.authenticate(session, packet);
      if (this.options.repository.delivered(packet.id, session.peerPublicKey!)) {
        this.options.onDelivered(packet.id, session.peerPublicKey!);
        // Receipt processing may race the current pump; the periodic tick
        // guarantees the next head will run even if flush is already active.
        void this.flush();
      }
    } catch (error) { this.options.onError(error); }
  }
  private authenticate(session: PeerSession, packet: ReliableDeliveryMessage | DeliveryReceiptMessage): void {
    validateProtocolMessage(packet);
    const peer = validateReadySession(session);
    validateFreshTimestamp(packet.timestamp);
    if (packet.senderFingerprint !== peer || packet.recipientFingerprint !== this.options.identity.fingerprint || !verifyDelivery(packet, session.peerPublicKey!)) {
      throw new Error('Invalid authenticated delivery or receipt');
    }
  }
}
