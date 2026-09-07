/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { CopyButton } from '../components/CopyButton';
import { ToastProvider } from '../components/Toast';
import { StateList } from '../components/StateList';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.location.hash = '';
});

describe('clipboard actions', () => {
  it('offers manual copying when clipboard access is denied', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
    render(<ToastProvider><CopyButton label="copy command" text="networkselfmd states" /></ToastProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'copy command' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('Clipboard unavailable'));
    expect(screen.getByRole('textbox', { name: 'copy command — copy manually' })).toHaveProperty('value', 'networkselfmd states');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('offers manual copying when the browser has no clipboard API', async () => {
    vi.stubGlobal('navigator', {});
    render(<CopyButton label="copy command" text="networkselfmd states" />);
    fireEvent.click(screen.getByRole('button'));
    expect(await screen.findByRole('textbox')).toHaveProperty('value', 'networkselfmd states');
  });

  it('recovers from denied access and announces a successful copy', async () => {
    const copy = vi.fn().mockRejectedValueOnce(new Error('denied')).mockResolvedValueOnce(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText: copy } });
    render(<ToastProvider><CopyButton label="copy command" text="networkselfmd states" /></ToastProvider>);
    fireEvent.click(screen.getByRole('button'));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button'));
    await screen.findByRole('button', { name: 'copied' });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('Copied to clipboard.');
    expect(copy).toHaveBeenLastCalledWith('networkselfmd states');
  });

  it('ignores clipboard completion after the command changes or unmounts', async () => {
    let finish!: () => void;
    const copy = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    vi.stubGlobal('navigator', { clipboard: { writeText: copy } });
    const { rerender, unmount } = render(<ToastProvider><CopyButton label="copy" text="state A" /></ToastProvider>);
    fireEvent.click(screen.getByRole('button'));
    rerender(<ToastProvider><CopyButton label="copy" text="state B" /></ToastProvider>);
    await act(async () => { finish(); });
    expect(screen.getByRole('button').textContent).toBe('copy');
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.click(screen.getByRole('button'));
    unmount();
    await act(async () => { finish(); });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('copies discovery instructions for public states and invitation prerequisites for private states', async () => {
    const copy = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText: copy } });
    render(<StateList states={[
      { id: '010203', name: 'public builders', isPublic: true, memberCount: 3, lastActivity: 0 },
      { id: '040506', name: 'private builders', isPublic: false, memberCount: 3, lastActivity: 0 },
    ]} />);
    const buttons = screen.getAllByRole('button', { name: 'copy join instructions' });
    await act(async () => { fireEvent.click(buttons[0]); });
    expect(copy.mock.calls[0][0]).toContain('discover_states');
    expect(copy.mock.calls[0][0]).toContain('join_public_state with {"stateId":"010203"}');
    await act(async () => { fireEvent.click(buttons[1]); });
    expect(copy.mock.calls[1][0]).toContain('Ask an admin to invite your connected agent first.');
    expect(copy.mock.calls[1][0]).toContain('npx --yes @networkselfmd/cli join-state 040506');
  });
});

const discovered = [
  { id: '010203', name: 'builders', selfMd: 'Build together.', memberCount: 3, isPublic: true, lastActivity: 0 },
  { id: '040506', name: 'research', selfMd: 'Research together.', memberCount: 5, isPublic: true, lastActivity: 0 },
];

function mockApi(post: () => Promise<unknown>) {
  const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === 'POST') return post();
    return { ok: true, json: async () => {
      if (url === '/api/discovery/states') return discovered;
      if (url.startsWith('/api/states/')) {
        return { ...discovered.find((state) => url.endsWith(state.id)), members: [], messages: [] };
      }
      return { capabilities: { discovery: true } };
    } };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('public state joining', () => {
  it('shows a server rejection beside the state and permits retry', async () => {
    window.location.hash = '#/operator/discover';
    const post = vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: { message: 'mutations require a localhost origin' } }) });
    mockApi(post);
    render(<App />);
    const buttons = await screen.findAllByRole('button', { name: 'join state' });
    fireEvent.click(buttons[0]);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('mutations require a localhost origin');
    expect(alert.closest('article')?.textContent).toContain('builders');
    expect(screen.queryByRole('status')).toBeNull();
    expect(buttons[0]).toHaveProperty('disabled', false);
    fireEvent.click(buttons[0]);
    await waitFor(() => { expect(post).toHaveBeenCalledTimes(2); });
  });

  it('prevents overlapping joins and navigates using the returned state ID', async () => {
    window.location.hash = '#/operator/discover';
    let resolve!: (value: unknown) => void;
    const pending = new Promise((done) => { resolve = done; });
    const post = vi.fn(() => pending);
    const fetchMock = mockApi(post);
    render(<App />);
    const buttons = await screen.findAllByRole('button', { name: 'join state' });
    fireEvent.click(buttons[0]);
    expect(buttons[0]).toHaveProperty('disabled', true);
    expect(buttons[1]).toHaveProperty('disabled', true);
    fireEvent.click(buttons[1]);
    expect(post).toHaveBeenCalledTimes(1);
    await act(async () => { resolve({ ok: true, json: async () => ({ ok: true, state: discovered[0] }) }); });
    expect(window.location.hash).toBe('#/state/010203');
    await screen.findByRole('heading', { name: 'builders' });
    expect(fetchMock).toHaveBeenCalledWith('/api/discovery/states/010203/join', expect.objectContaining({ method: 'POST' }));
    expect(screen.getByRole('status').textContent).toBe('joined state: builders');
  });
});

describe('operator telemetry', () => {
  it.each([null, undefined])('does not imply full synchronization when telemetry is %s', async (syncPct) => {
    window.location.hash = '#/operator';
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({ ok: true, json: async () => url === '/api/status' ? { syncPct, capabilities: { discovery: true } } : [] })));
    render(<App />);
    await screen.findByText('measurement unavailable');
    expect(screen.queryByText('100%')).toBeNull();
  });
});
