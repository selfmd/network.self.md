import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { getChatHTML } from '../static-content.js';

function createChat() {
  const elements = new Map<string, any>();
  const document = {
    getElementById(id: string) {
      if (!elements.has(id)) elements.set(id, {
        style: {}, disabled: false, value: '', textContent: '',
        appendChild: vi.fn(), addEventListener: vi.fn(),
      });
      return elements.get(id);
    },
    createElement() { return {}; },
  };
  const sockets: any[] = [];
  const timers: Array<() => void> = [];
  class FakeWebSocket {
    readyState = 1;
    send = vi.fn();
    constructor() { sockets.push(this); }
  }
  const script = getChatHTML('test-agent').match(/<script>([\s\S]*?)<\/script>/)![1];
  runInNewContext(script, {
    document, WebSocket: FakeWebSocket,
    location: { protocol: 'http:', host: 'localhost' },
    setTimeout(callback: () => void) { timers.push(callback); },
  });
  sockets[0].onopen();
  return { elements, sockets, timers };
}

describe('visitor chat browser behavior', () => {
  it('preserves rejection and does not reconnect after the owner declines', () => {
    const { elements, sockets, timers } = createChat();
    sockets[0].onmessage({ data: JSON.stringify({ type: 'status', status: 'rejected' }) });
    sockets[0].onclose();
    for (const callback of timers) callback();
    expect(elements.get('status-text').textContent).toBe('declined');
    expect(elements.get('send-btn').disabled).toBe(true);
    expect(sockets).toHaveLength(1);
  });

  it('keeps a draft and prevents click and Enter sends while approval is pending', () => {
    const { elements, sockets } = createChat();
    sockets[0].onmessage({ data: JSON.stringify({ type: 'status', status: 'pending' }) });
    const input = elements.get('msg-input');
    input.value = 'Save this draft';
    const button = elements.get('send-btn');
    expect(button.disabled).toBe(true);
    button.addEventListener.mock.calls.find(([event]: [string]) => event === 'click')[1]();
    input.addEventListener.mock.calls.find(([event]: [string]) => event === 'keydown')[1]({ key: 'Enter', shiftKey: false, preventDefault() {} });
    expect(sockets[0].send).not.toHaveBeenCalled();
    expect(input.value).toBe('Save this draft');
    sockets[0].onmessage({ data: JSON.stringify({ type: 'status', status: 'approved' }) });
    expect(button.disabled).toBe(false);
    button.addEventListener.mock.calls.find(([event]: [string]) => event === 'click')[1]();
    expect(sockets[0].send).toHaveBeenCalledWith(JSON.stringify({ type: 'message', content: 'Save this draft' }));
  });

  it('reconnects after an unexpected transport close', () => {
    const { sockets, timers } = createChat();
    sockets[0].onclose();
    for (const callback of timers) callback();
    expect(sockets).toHaveLength(2);
  });
});
