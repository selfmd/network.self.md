import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApprovalQueue } from '../approval.js';

function mockWebSocket(): any {
  return {
    close: vi.fn(),
    send: vi.fn(),
    readyState: 1,
  };
}

describe('ApprovalQueue', () => {
  let queue: ApprovalQueue;

  beforeEach(() => {
    queue = new ApprovalQueue({
      maxPending: 3,
      autoApprove: false,
      sessionTimeout: 60000,
    });
  });

  it('adds a visitor with pending status', () => {
    const ws = mockWebSocket();
    const session = queue.addVisitor('v1', 'hello', 'ip-hash-1', ws);
    expect(session).not.toBeNull();
    expect(session!.status).toBe('pending');
    expect(session!.visitorId).toBe('v1');
    expect(session!.firstMessage).toBe('hello');
  });

  it('returns null when queue is full', () => {
    for (let i = 0; i < 3; i++) {
      queue.addVisitor(`v${i}`, 'hi', `ip${i}`, mockWebSocket());
    }
    const result = queue.addVisitor('v99', 'hi', 'ip99', mockWebSocket());
    expect(result).toBeNull();
  });

  it('returns null for blocked IPs', () => {
    queue.block('bad-ip');
    const result = queue.addVisitor('v1', 'hi', 'bad-ip', mockWebSocket());
    expect(result).toBeNull();
  });

  it('approves a pending visitor and returns session token', () => {
    queue.addVisitor('v1', 'hello', 'ip1', mockWebSocket());
    const token = queue.approve('v1');
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);
    expect(queue.isApproved('v1')).toBe(true);
  });

  it('rejects a pending visitor', () => {
    queue.addVisitor('v1', 'hello', 'ip1', mockWebSocket());
    queue.reject('v1');
    const session = queue.getSession('v1');
    expect(session!.status).toBe('rejected');
    expect(queue.isApproved('v1')).toBe(false);
  });

  it('blocks an IP and marks pending sessions as blocked', () => {
    queue.addVisitor('v1', 'hello', 'ip1', mockWebSocket());
    queue.addVisitor('v2', 'hi', 'ip1', mockWebSocket());
    queue.block('ip1');

    expect(queue.isBlocked('ip1')).toBe(true);
    expect(queue.getSession('v1')!.status).toBe('blocked');
    expect(queue.getSession('v2')!.status).toBe('blocked');
  });

  it('returns pending sessions', () => {
    queue.addVisitor('v1', 'hello', 'ip1', mockWebSocket());
    queue.addVisitor('v2', 'hi', 'ip2', mockWebSocket());
    queue.approve('v1');

    const pending = queue.getPending();
    expect(pending.length).toBe(1);
    expect(pending[0].visitorId).toBe('v2');
  });

  it('throws when approving unknown visitor', () => {
    expect(() => queue.approve('unknown')).toThrow('Unknown visitor');
  });

  it('throws when approving non-pending visitor', () => {
    queue.addVisitor('v1', 'hello', 'ip1', mockWebSocket());
    queue.approve('v1');
    expect(() => queue.approve('v1')).toThrow('cannot approve');
  });

  it('removes a visitor', () => {
    queue.addVisitor('v1', 'hello', 'ip1', mockWebSocket());
    queue.remove('v1');
    expect(queue.getSession('v1')).toBeUndefined();
    expect(queue.size).toBe(0);
  });

  it('cleans up expired sessions', () => {
    const ws = mockWebSocket();
    const session = queue.addVisitor('v1', 'hello', 'ip1', ws);
    // Manually set lastMessageAt to the past
    session!.lastMessageAt = Date.now() - 120000;

    queue.cleanup();
    expect(queue.getSession('v1')).toBeUndefined();
    expect(ws.close).toHaveBeenCalled();
  });

  describe('auto-approve mode', () => {
    let autoQueue: ApprovalQueue;

    beforeEach(() => {
      autoQueue = new ApprovalQueue({
        maxPending: 10,
        autoApprove: true,
        sessionTimeout: 60000,
      });
    });

    it('auto-approves new visitors', () => {
      const session = autoQueue.addVisitor('v1', 'hi', 'ip1', mockWebSocket());
      expect(session!.status).toBe('approved');
      expect(session!.sessionToken).toBeTruthy();
      expect(autoQueue.isApproved('v1')).toBe(true);
    });
  });
});
