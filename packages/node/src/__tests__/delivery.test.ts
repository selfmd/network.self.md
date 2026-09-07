import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeMessage, encodeMessage, MessageType, DELIVERY_TTL_MS, signDelivery } from '@networkselfmd/core';
import type { ProtocolMessage, ReliableDeliveryMessage, DeliveryReceiptMessage } from '@networkselfmd/core';
import { HANDSHAKE_CAPABILITIES } from '../network/handshake.js';

vi.mock('../network/swarm.js', async () => {
  const { EventEmitter } = await import('node:events');
  const { MessageRouter } = await import('../network/router.js');
  return { SwarmManager: class extends EventEmitter {
    sessions = new Map(); router = new MessageRouter();
    async start() {} async stop() { this.sessions.clear(); }
    async join() {} async leave() {}
    getSession(fp: string) { return this.sessions.get(fp); }
    getAllSessions() { return [...this.sessions.values()]; }
  } };
});
import { Agent } from '../agent.js';

const agents: Agent[] = [];
const dirs: string[] = [];
const traffic: Array<{ to: Agent; session: any; packet: ProtocolMessage }> = [];
afterEach(async () => {
  await Promise.all(agents.splice(0).map(agent => agent.stop()));
  vi.useRealTimers(); traffic.length = 0;
  dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true }));
});
async function start(dir?: string): Promise<Agent> {
  if (!dir) { dir = mkdtempSync(join(tmpdir(), 'nsmd-delivery-')); dirs.push(dir); }
  const agent = new Agent({ dataDir: dir });
  agent.removeAllListeners('error'); agent.on('error', () => {});
  agents.push(agent); await agent.start(); return agent;
}
function internals(agent: Agent): any { return agent; }
function pk(agent: Agent) { return Buffer.from(agent.identity.edPublicKey).toString('hex'); }
function connect(a: Agent, b: Agent) {
  const ab = Object.assign(new EventEmitter(), {
    state: 'ready', peerPublicKey: b.identity.edPublicKey, peerXPublicKey: b.identity.xPublicKey,
    peerFingerprint: b.identity.fingerprint, peerCapabilities: new Set(HANDSHAKE_CAPABILITIES),
    send: (packet: ProtocolMessage) => traffic.push({ to: b, session: ba, packet: decodeMessage(encodeMessage(packet)) }),
  });
  const ba = Object.assign(new EventEmitter(), {
    state: 'ready', peerPublicKey: a.identity.edPublicKey, peerXPublicKey: a.identity.xPublicKey,
    peerFingerprint: a.identity.fingerprint, peerCapabilities: new Set(HANDSHAKE_CAPABILITIES),
    send: (packet: ProtocolMessage) => traffic.push({ to: a, session: ab, packet: decodeMessage(encodeMessage(packet)) }),
  });
  internals(a).swarm.sessions.set(b.identity.fingerprint, ab);
  internals(b).swarm.sessions.set(a.identity.fingerprint, ba);
  internals(a).deliveryRepo.reconnect(b.identity.edPublicKey);
  internals(b).deliveryRepo.reconnect(a.identity.edPublicKey);
  return { ab, ba };
}
async function drain(drop: (packet: ProtocolMessage) => boolean = () => false) {
  let n = 0;
  while (traffic.length) {
    if (++n > 10000) throw new Error('Transport loop');
    const item = traffic.shift()!;
    if (!drop(item.packet)) await internals(item.to).swarm.router.route(item.session, item.packet);
  }
}
async function pump(...peers: Agent[]) {
  for (let i = 0; i < 6; i++) {
    await Promise.all(peers.map(agent => internals(agent).deliveryManager.flush()));
    await drain();
  }
}
async function group(a: Agent, b: Agent) {
  connect(a, b);
  const gid = Buffer.from((await a.createGroup('deliveries')).groupId).toString('hex');
  await a.inviteToGroup(gid, pk(b)); await drain();
  await b.joinGroup(gid); await drain();
  return gid;
}

describe('durable authenticated delivery', () => {
  it('queues offline first DMs, survives restart and dispatches with fresh signed timestamps', async () => {
    let a = await start(); const b = await start();
    const id = await a.sendDirectMessage(pk(b), 'offline first contact');
    expect(a.listDeliveries(id)[0]).toMatchObject({ status: 'queued', attempts: 0 });
    const dir = internals(a).options.dataDir;
    await a.stop();
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000);
    a = await start(dir); connect(a, b); await pump(a, b);
    expect(a.listDeliveries(id)[0].status).toBe('delivered');
    expect(b.getMessages({ peerPublicKey: pk(a) }).map(m => m.content)).toEqual(['offline first contact']);
  });

  it('retries a lost receipt without decrypting/storing twice and preserves ciphertext', async () => {
    const a = await start(); const b = await start(); connect(a, b);
    const id = await a.sendDirectMessage(pk(b), 'exactly once');
    await internals(a).deliveryManager.flush();
    const first = traffic.find(item => item.packet.type === MessageType.ReliableDelivery)!.packet as ReliableDeliveryMessage;
    await drain(packet => packet.type === MessageType.DeliveryReceipt);
    expect(a.listDeliveries(id)[0].status).toBe('queued');
    const before = internals(b).ratchetStateRepo.loadSession(a.identity.fingerprint);
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 11 * 60 * 1000);
    internals(a).deliveryRepo.reconnect(b.identity.edPublicKey);
    await internals(a).deliveryManager.flush();
    const retry = traffic.find(item => item.packet.type === MessageType.ReliableDelivery)!.packet as ReliableDeliveryMessage;
    expect(retry.message.ciphertext).toEqual(first.message.ciphertext);
    expect(retry.timestamp).toBeGreaterThan(first.timestamp);
    await drain();
    expect(internals(b).ratchetStateRepo.loadSession(a.identity.fingerprint)).toEqual(before);
    expect(b.getMessages({ peerPublicKey: pk(a) })).toHaveLength(1);
    expect(a.listDeliveries(id)[0].status).toBe('delivered');
  });

  it('keeps simultaneous first-attempt eligibility across days and restart', async () => {
    let a = await start(); let b = await start(); connect(a, b);
    await Promise.all([a.sendDirectMessage(pk(b), 'a first'), b.sendDirectMessage(pk(a), 'b first')]);
    await Promise.all([internals(a).deliveryManager.flush(), internals(b).deliveryManager.flush()]);
    traffic.length = 0; // both first frames were lost when the transport failed
    const da = internals(a).options.dataDir, db = internals(b).options.dataDir;
    await Promise.all([a.stop(), b.stop()]);
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 2 * 24 * 60 * 60 * 1000);
    a = await start(da); b = await start(db); connect(a, b); await pump(a, b);
    expect(a.listDeliveries()[0].status).toBe('delivered');
    expect(b.listDeliveries()[0].status).toBe('delivered');
    await a.sendDirectMessage(pk(b), 'still converged'); await pump(a, b);
    expect(b.getMessages({ peerPublicKey: pk(a) }).some(m => m.content === 'still converged')).toBe(true);
  });

  it.each([false, true])('recovers new DM work after both original first frames expire (one-way: %s)', async (oneWay) => {
    let a = await start(); let b = await start(); connect(a, b);
    const old = await Promise.all([a.sendDirectMessage(pk(b), 'expired a'), b.sendDirectMessage(pk(a), 'expired b')]);
    await Promise.all([internals(a).deliveryManager.flush(), internals(b).deliveryManager.flush()]);
    traffic.length = 0;
    const da = internals(a).options.dataDir, db = internals(b).options.dataDir;
    await Promise.all([a.stop(), b.stop()]);
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + DELIVERY_TTL_MS + 1);
    a = await start(da); b = await start(db); connect(a, b);
    expect(a.listDeliveries(old[0])[0].status).toBe('failed');
    expect(b.listDeliveries(old[1])[0].status).toBe('failed');
    const [low, high] = [a, b].sort((x, y) => x.identity.fingerprint < y.identity.fingerprint ? -1 : 1);
    const fresh = await high.sendDirectMessage(pk(low), 'fresh high');
    if (!oneWay) await low.sendDirectMessage(pk(high), 'fresh low');
    await pump(a, b);
    expect(high.listDeliveries(fresh)[0].status).toBe('delivered');
    if (oneWay) {
      expect(internals(low).ratchetStateRepo.loadSession(high.identity.fingerprint).initialReceiver.state.sendChainKey).toBeNull();
      vi.setSystemTime(Date.now() + DELIVERY_TTL_MS + 1);
      const later = await high.sendDirectMessage(pk(low), 'one-way after another idle week');
      await pump(a, b);
      expect(high.listDeliveries(later)[0].status).toBe('delivered');
    }
    const reply = await low.sendDirectMessage(pk(high), 'canonical response'); await pump(a, b);
    expect(low.listDeliveries(reply)[0].status).toBe('delivered');
    const converged = await high.sendDirectMessage(pk(low), 'canonical follow-up'); await pump(a, b);
    expect(high.listDeliveries(converged)[0].status).toBe('delivered');
    expect(internals(low).ratchetStateRepo.loadSession(high.identity.fingerprint).bootstrapPending).toBeUndefined();
    expect(internals(high).ratchetStateRepo.loadSession(low.identity.fingerprint).bootstrapPending).toBeUndefined();
  });

  it('rejects spoofed receipts and altered envelopes before acknowledging or changing inbox', async () => {
    const a = await start(); const b = await start(); const c = await start();
    const { ab, ba } = connect(a, b);
    const id = await a.sendDirectMessage(pk(b), 'authenticated');
    await internals(a).deliveryManager.flush();
    const packet = traffic.shift()!.packet as ReliableDeliveryMessage;
    await internals(b).deliveryManager.receive(ba, { ...packet, contentHash: '00'.repeat(32) });
    expect(b.getMessages({ peerPublicKey: pk(a) })).toHaveLength(0);
    const { signature: originalSignature, ...unsignedPacket } = packet;
    await internals(b).deliveryManager.receive(ba, signDelivery<ReliableDeliveryMessage>(
      { ...unsignedPacket, contentHash: '00'.repeat(32) }, a.identity.edPrivateKey));
    expect(internals(b).ratchetStateRepo.loadSession(a.identity.fingerprint)).toBeNull();
    expect(internals(b).deliveryRepo.received(a.identity.fingerprint, id, packet.contentHash)).toBe(false);
    expect(b.getMessages({ peerPublicKey: pk(a) })).toHaveLength(0);
    const forged = signDelivery<DeliveryReceiptMessage>({ type: MessageType.DeliveryReceipt,
      id, senderFingerprint: b.identity.fingerprint, recipientFingerprint: a.identity.fingerprint, timestamp: Date.now() }, c.identity.edPrivateKey);
    internals(a).deliveryManager.receipt(ab, forged);
    expect(a.listDeliveries(id)[0].status).toBe('queued');
    await internals(b).deliveryManager.receive(ba, packet); await drain();
    expect(a.listDeliveries(id)[0].status).toBe('delivered');
  });

  it('namespaces equal delivery IDs from different authenticated senders', async () => {
    const a = await start(); const b = await start(); const c = await start();
    connect(a, b); connect(c, b);
    await Promise.all([a.sendDirectMessage(pk(b), 'from a'), c.sendDirectMessage(pk(b), 'from c')]);
    await Promise.all([internals(a).deliveryManager.flush(), internals(c).deliveryManager.flush()]);
    for (const item of traffic.splice(0)) {
      if (item.packet.type !== MessageType.ReliableDelivery) continue;
      const { signature: _, ...body } = item.packet;
      const sender = body.senderFingerprint === a.identity.fingerprint ? a : c;
      await internals(b).deliveryManager.receive(item.session, signDelivery<ReliableDeliveryMessage>({ ...body, id: 'same-wire-id' }, sender.identity.edPrivateKey));
    }
    expect(b.getMessages({ peerPublicKey: pk(a) }).map(m => m.content)).toEqual(['from a']);
    expect(b.getMessages({ peerPublicKey: pk(c) }).map(m => m.content)).toEqual(['from c']);
  });

  it('rolls back a prepared DM ratchet when committing its outbox attempt fails', async () => {
    const a = await start(); const b = await start(); connect(a, b);
    vi.spyOn(internals(a).deliveryRepo, 'attempt').mockImplementationOnce(() => { throw new Error('simulated storage failure'); });
    const id = await a.sendDirectMessage(pk(b), 'atomic retry');
    await internals(a).deliveryManager.flush();
    expect(internals(a).ratchetStateRepo.loadSession(b.identity.fingerprint)).toBeNull();
    expect(traffic).toHaveLength(0);
    internals(a).deliveryRepo.reconnect(b.identity.edPublicKey);
    await pump(a, b);
    expect(a.listDeliveries(id)[0].status).toBe('delivered');
    expect(b.getMessages({ peerPublicKey: pk(a) }).map(m => m.content)).toEqual(['atomic retry']);
  });

  it('rejects a full outbox before storing a local message or advancing a ratchet', async () => {
    const a = await start(); const b = await start();
    const now = Date.now();
    internals(a).deliveryRepo.transaction(() => internals(a).deliveryRepo.enqueue(Array.from({ length: 1000 }, (_, i) => ({
      id: String(i), peer_public_key: Buffer.from(b.identity.edPublicKey), group_id: null,
      group_epoch_version: null, content: 'queued', content_hash: 'ab'.repeat(32), created_at: now, expires_at: now + DELIVERY_TTL_MS,
    }))));
    await expect(a.sendDirectMessage(pk(b), 'over capacity')).rejects.toThrow(/full/);
    expect(a.getMessages({ peerPublicKey: pk(b) })).toHaveLength(0);
    expect(internals(a).ratchetStateRepo.loadSession(b.identity.fingerprint)).toBeNull();
  });

  it('refreshes SenderKeys for queued group messages after expiry of wire timestamps and rotation', async () => {
    const a = await start(); const b = await start(); const gid = await group(a, b);
    internals(a).swarm.sessions.clear(); internals(b).swarm.sessions.clear();
    const one = await a.sendGroupMessage(gid, 'offline group one');
    const two = await a.sendGroupMessage(gid, 'offline group two');
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
    connect(a, b); await pump(a, b);
    expect(a.listDeliveries(one)[0].status).toBe('delivered');
    expect(a.listDeliveries(two)[0].status).toBe('delivered');
    expect(b.getMessages({ groupId: gid }).map(m => m.content).sort()).toEqual(['offline group one', 'offline group two']);
  });

  it.each([true, false])('does not deliver to a revoked recipient even after reinvite (sync removal first: %s)', async (syncFirst) => {
    const a = await start(); const b = await start(); const gid = await group(a, b);
    internals(a).swarm.sessions.clear(); internals(b).swarm.sessions.clear();
    const id = await a.sendGroupMessage(gid, 'before revocation');
    await a.kickFromGroup(gid, pk(b));
    const { ab } = connect(a, b);
    if (syncFirst) {
      internals(a).groupManager.sendEpochChain(Buffer.from(gid, 'hex'), ab, 0);
      await drain();
    }
    await a.inviteToGroup(gid, pk(b)); await drain();
    await b.joinGroup(gid); await drain(); await pump(a, b);
    expect(a.listDeliveries(id)[0]).toMatchObject({ status: 'failed' });
    expect(b.getMessages({ groupId: gid }).some(m => m.content === 'before revocation')).toBe(false);
  });

  it('retries one group recipient with fresh keys without losing later work for another', async () => {
    const a = await start(); const b = await start(); const c = await start();
    const gid = await group(a, b); connect(a, c);
    await a.inviteToGroup(gid, pk(c)); await drain(); await c.joinGroup(gid); await drain();
    internals(a).swarm.sessions.clear(); internals(b).swarm.sessions.clear(); internals(c).swarm.sessions.clear();
    const first = await a.sendGroupMessage(gid, 'one');
    const second = await a.sendGroupMessage(gid, 'two');
    connect(a, b); connect(a, c);
    await internals(a).deliveryManager.flush();
    await drain(packet => packet.type === MessageType.DeliveryReceipt && packet.senderFingerprint === b.identity.fingerprint);
    await pump(a, c);
    expect(c.getMessages({ groupId: gid }).map(m => m.content).sort()).toEqual(['one', 'two']);
    internals(a).deliveryRepo.reconnect(b.identity.edPublicKey); await pump(a, b, c);
    expect(b.getMessages({ groupId: gid }).map(m => m.content).sort()).toEqual(['one', 'two']);
    expect(a.listDeliveries(first).every(row => row.status === 'delivered')).toBe(true);
    expect(a.listDeliveries(second).every(row => row.status === 'delivered')).toBe(true);
  });

  it('expires queued work visibly and rejects packets after their signed lifetime', async () => {
    const a = await start(); const b = await start(); const { ba } = connect(a, b);
    const id = await a.sendDirectMessage(pk(b), 'expires'); await internals(a).deliveryManager.flush();
    const packet = traffic.shift()!.packet as ReliableDeliveryMessage;
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + DELIVERY_TTL_MS + 1);
    expect(a.listDeliveries(id)[0]).toMatchObject({ status: 'failed' });
    const { signature: _, ...body } = packet;
    await internals(b).deliveryManager.receive(ba, signDelivery<ReliableDeliveryMessage>({ ...body, timestamp: Date.now() }, a.identity.edPrivateKey));
    expect(b.getMessages({ peerPublicKey: pk(a) })).toHaveLength(0);
  });
});


describe('policy and reliable delivery commit together', () => {
  for (const kind of ['dm', 'group'] as const) {
    for (const fault of ['audit-write', 'after-prepare'] as const) {
      it(`${kind}: rolls back ${fault} and retries without losing or duplicating the inbound event`, async () => {
        const a = await start(); const b = await start();
        b.setPolicyConfig({ requireMention: false });
        const gid = kind === 'group' ? await group(a, b) : undefined;
        if (!gid) connect(a, b);
        const observed: unknown[] = [];
        b.on('inbound:message', event => observed.push(event));
        if (fault === 'audit-write') {
          const original = b.policyAuditRepo.insert.bind(b.policyAuditRepo);
          vi.spyOn(b.policyAuditRepo, 'insert').mockImplementationOnce(entry => {
            original(entry);
            throw new Error('simulated audit write failure');
          });
        } else {
          const original = internals(b).prepareInbound.bind(b);
          vi.spyOn(internals(b), 'prepareInbound').mockImplementationOnce((event: unknown) => {
            original(event);
            throw new Error('simulated failure before commit');
          });
        }
        const content = 'private policy transaction canary';
        const id = gid ? await a.sendGroupMessage(gid, content) : await a.sendDirectMessage(pk(b), content);
        await internals(a).deliveryManager.flush(); await drain();
        const selector = gid ? { groupId: gid } : { peerPublicKey: pk(a) };
        expect(b.getMessages(selector)).toHaveLength(0);
        expect(b.policyAuditRepo.count()).toBe(0);
        expect(b.policyAudit.size()).toBe(0);
        expect(b.policyGate.dedupCount()).toBe(0);
        expect(b.inboundQueue.size()).toBe(0);
        expect(observed).toHaveLength(0);
        expect(a.listDeliveries(id)[0].status).toBe('queued');
        internals(a).deliveryRepo.reconnect(b.identity.edPublicKey);
        await pump(a, b);
        expect(a.listDeliveries(id)[0].status).toBe('delivered');
        expect(b.getMessages(selector).map(message => message.content)).toEqual([content]);
        expect(b.policyAuditRepo.count()).toBe(1);
        expect(b.policyAudit.size()).toBe(1);
        expect(b.inboundQueue.size()).toBe(1);
        expect(observed).toHaveLength(1);
        expect(JSON.stringify(b.policyAuditRepo.recent())).not.toContain(content);
        expect(b.inboundQueue.peek()[0].messageId).toBe(b.getMessages(selector)[0].id);
      });
    }
  }

  it('a broken policy observer cannot suppress later observers or delivery receipts', async () => {
    const a = await start(); const b = await start(); connect(a, b);
    const observed = vi.fn();
    b.on('policy:audit', () => { throw new Error('private observer error'); });
    b.on('policy:audit', observed);
    const id = await a.sendDirectMessage(pk(b), 'observer isolation');
    await pump(a, b);
    expect(a.listDeliveries(id)[0].status).toBe('delivered');
    expect(observed).toHaveBeenCalledTimes(1);
    expect(b.inboundQueue.size()).toBe(1);
  });
});
