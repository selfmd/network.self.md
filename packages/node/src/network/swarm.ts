import { EventEmitter } from 'node:events';
import Hyperswarm from 'hyperswarm';
import { deriveKey } from '@networkselfmd/core';
import type { AgentIdentity } from '@networkselfmd/core';
import { PeerSession } from './connection.js';
import { performHandshake } from './handshake.js';
import type { HandshakeResult } from './handshake.js';
import { MessageRouter } from './router.js';

export interface SwarmManagerOptions {
  identity: AgentIdentity;
  bootstrap?: Array<{ host: string; port: number }>;
  acceptPeerIdentity?: (result: HandshakeResult) => void | Promise<void>;
}

export const MAX_PENDING_HANDSHAKES = 64;

export class SwarmManager extends EventEmitter {
  private swarm: Hyperswarm | null = null;
  private sessions = new Map<string, PeerSession>();
  private topics = new Set<string>();
  private identity: AgentIdentity;
  private bootstrap?: Array<{ host: string; port: number }>;
  private acceptPeerIdentity?: SwarmManagerOptions['acceptPeerIdentity'];
  private pendingHandshakes = 0;
  readonly router: MessageRouter;

  constructor(options: SwarmManagerOptions) {
    super();
    this.identity = options.identity;
    this.bootstrap = options.bootstrap;
    this.acceptPeerIdentity = options.acceptPeerIdentity;
    this.router = new MessageRouter();
  }

  async start(): Promise<void> {
    const swarmOpts: Record<string, unknown> = {};
    if (this.bootstrap) {
      swarmOpts.bootstrap = this.bootstrap;
    }
    swarmOpts.seed = Buffer.from(
      deriveKey(
        this.identity.edPrivateKey,
        'networkselfmd-noise-transport-v1',
        '',
        32,
      ),
    );

    this.swarm = new Hyperswarm(swarmOpts);

    this.swarm.on('connection', (socket: unknown, peerInfo: unknown) => {
      this.handleConnection(socket, peerInfo).catch((err) => {
        this.emit('error', err);
      });
    });
  }

  private async handleConnection(
    socket: unknown,
    _peerInfo: unknown,
  ): Promise<void> {
    if (this.pendingHandshakes >= MAX_PENDING_HANDSHAKES) {
      try {
        (socket as ConstructorParameters<typeof PeerSession>[0]).destroy();
      } catch {
        // The transport may already be closing.
      }
      return;
    }

    this.pendingHandshakes += 1;
    try {
      const result = await performHandshake(
        socket as ConstructorParameters<typeof PeerSession>[0],
        this.identity,
      );

      try {
        await this.acceptPeerIdentity?.(result);
      } catch (error) {
        result.session.destroy();
        throw error;
      }

      const { session, peerFingerprint } = result;
      if (session.state !== 'verified') {
        session.destroy();
        throw new Error('Connection closed before peer registration');
      }

      // Attach lifecycle handlers before publishing the session. A replaced
      // session may close asynchronously, so it may only delete itself.
      session.on('message', (message) => {
        this.router.route(session, message).catch((err) => {
          this.emit('error', err);
        });
      });

      session.on('close', () => {
        if (this.sessions.get(peerFingerprint) !== session) return;
        this.sessions.delete(peerFingerprint);
        this.emit('peer:disconnected', {
          peerPublicKey: result.peerPublicKey,
          peerFingerprint,
        });
      });

      session.on('error', (err) => {
        this.emit('error', err);
      });

      const existingSession = this.sessions.get(peerFingerprint);
      this.sessions.set(peerFingerprint, session);
      if (existingSession && existingSession !== session) {
        existingSession.close();
      }

      session.setReady();
      this.emit('peer:connected', result);
      this.emit('peer:verified', result);
    } catch (err) {
      this.emit('error', err);
    } finally {
      this.pendingHandshakes -= 1;
    }
  }

  async join(topic: Buffer): Promise<void> {
    if (!this.swarm) {
      throw new Error('Swarm not started');
    }
    const topicHex = topic.toString('hex');
    if (this.topics.has(topicHex)) {
      return;
    }

    const discovery = this.swarm.join(topic, { server: true, client: true });
    await discovery.flushed();
    this.topics.add(topicHex);
  }

  async leave(topic: Buffer): Promise<void> {
    if (!this.swarm) return;
    const topicHex = topic.toString('hex');
    if (!this.topics.has(topicHex)) return;

    await this.swarm.leave(topic);
    this.topics.delete(topicHex);
  }

  getSession(fingerprint: string): PeerSession | undefined {
    return this.sessions.get(fingerprint);
  }

  getAllSessions(): PeerSession[] {
    return Array.from(this.sessions.values());
  }

  getSessionCount(): number {
    return this.sessions.size;
  }

  async stop(): Promise<void> {
    for (const session of this.sessions.values()) {
      session.close();
    }
    this.sessions.clear();
    this.topics.clear();

    if (this.swarm) {
      await this.swarm.destroy();
      this.swarm = null;
    }
  }
}
