import React from 'react';
import { PassThrough, Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink';
import type { Agent } from '@networkselfmd/node';
import { ChatView } from '../components/ChatView.js';

const groupId = 'ab'.repeat(32);
const ownKey = new Uint8Array(32).fill(1);
const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

function mountChat(history: Array<{ id: string; content: string; timestamp: number }> = []) {
  const stdin = new PassThrough();
  Object.assign(stdin, { isTTY: true, setRawMode: vi.fn(), ref: vi.fn(), unref: vi.fn() });
  let frame = '';
  const stdout = new Writable({ write(chunk, _encoding, callback) { frame = chunk.toString(); callback(); } });
  Object.assign(stdout, { columns: 120, rows: 40 });
  const agent = Object.assign(new EventEmitter(), {
    identity: { edPublicKey: ownKey, fingerprint: 'my-agent', displayName: 'Alice' },
    listGroups: () => [{ groupId: Buffer.from(groupId, 'hex'), name: 'builders', memberCount: 1 }],
    listPeers: () => [],
    getMessages: () => history.map((message) => ({ ...message, senderPublicKey: ownKey })),
    sendGroupMessage: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  });
  const app = render(<ChatView agent={agent as unknown as Agent} groupId={groupId} />, {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  cleanups.push(() => { app.unmount(); app.cleanup(); stdin.destroy(); stdout.destroy(); });
  return { agent, stdin, frame: () => frame };
}

describe('terminal chat', () => {
  it('renders the latest history chronologically with the newest message visible', async () => {
    const chat = mountChat(Array.from({ length: 30 }, (_, index) => ({
      id: String(30 - index), content: `history-${String(30 - index).padStart(2, '0')}`, timestamp: 30 - index,
    })));
    await vi.waitFor(() => expect(chat.frame()).toContain('history-30'));
    expect(chat.frame()).not.toContain('history-01');
    expect(chat.frame().indexOf('history-11')).toBeLessThan(chat.frame().indexOf('history-30'));
    expect(chat.frame()).toContain('you');
  });

  it('displays incoming messages only for the active group', async () => {
    const chat = mountChat();
    await vi.waitFor(() => expect(chat.agent.listenerCount('group:message')).toBe(1));
    chat.agent.emit('group:message', {
      groupId: Buffer.from(groupId, 'hex'), senderFingerprint: 'remote-agent', content: 'incoming hello', timestamp: Date.now(),
    });
    chat.agent.emit('group:message', {
      groupId: Buffer.alloc(32), senderFingerprint: 'remote-agent', content: 'other conversation', timestamp: Date.now(),
    });
    await vi.waitFor(() => expect(chat.frame()).toContain('incoming hello'));
    expect(chat.frame()).not.toContain('other conversation');
  });

  it('retains a failed message for retry and shows an error', async () => {
    const chat = mountChat();
    chat.agent.sendGroupMessage.mockRejectedValue(new Error('offline'));
    await vi.waitFor(() => expect(chat.agent.listenerCount('group:message')).toBe(1));
    chat.stdin.write('retry this message');
    await vi.waitFor(() => expect(chat.frame()).toContain('retry this message'));
    chat.stdin.write('\r');
    await vi.waitFor(() => expect(chat.frame()).toContain('Failed to send message'));
    expect(chat.frame()).toContain('retry this message');
    expect(chat.frame()).not.toMatch(/you.*retry this message/);
  });

  it('shows a successfully sent message without waiting for a remote echo', async () => {
    const chat = mountChat();
    await vi.waitFor(() => expect(chat.agent.listenerCount('group:message')).toBe(1));
    chat.stdin.write('hello builders');
    await vi.waitFor(() => expect(chat.frame()).toContain('hello builders'));
    chat.stdin.write('\r');
    await vi.waitFor(() => expect(chat.agent.sendGroupMessage).toHaveBeenCalledWith(groupId, 'hello builders'));
    await vi.waitFor(() => expect(chat.frame()).toMatch(/you.*hello builders/));
  });
});
