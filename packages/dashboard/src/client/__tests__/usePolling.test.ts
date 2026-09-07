/** @vitest-environment jsdom */
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePolling } from '../hooks/usePolling.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const response = (value: unknown) => ({ ok: true, json: async () => value }) as Response;

describe('usePolling request lifecycle', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('does not display the previous state while the next state loads', async () => {
    const next = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(response('state A')).mockReturnValueOnce(next.promise));
    const { result, rerender } = renderHook(({ url }) => usePolling<string>(url), { initialProps: { url: '/a' } });
    await act(async () => {});
    expect(result.current.data).toBe('state A');

    rerender({ url: '/b' });
    expect(result.current.data).toBeNull();
    await act(async () => { next.resolve(response('state B')); });
    expect(result.current.data).toBe('state B');
  });

  it('ignores a late response after navigation and aborts the old request', async () => {
    const old = deferred<Response>();
    const fetchMock = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(response('state B'));
    vi.stubGlobal('fetch', fetchMock);
    const { result, rerender } = renderHook(({ url }) => usePolling<string>(url), { initialProps: { url: '/a' } });
    rerender({ url: '/b' });
    await act(async () => {});
    await act(async () => { old.resolve(response('state A')); });
    expect(result.current.data).toBe('state B');
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it('waits for a slow response before scheduling another request', async () => {
    const slow = deferred<Response>();
    const fetchMock = vi.fn().mockReturnValueOnce(slow.promise).mockResolvedValue(response('updated'));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => usePolling<string>('/a', 1000));
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { slow.resolve(response('initial')); });
    expect(result.current.data).toBe('initial');
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.data).toBe('updated');
  });

  it('retains the last successful response on transient failure and recovers', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(response('initial'))
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce(response('recovered')));
    const { result } = renderHook(() => usePolling<string>('/a', 1000));
    await act(async () => {});
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(result.current).toEqual({ data: 'initial', error: '503' });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(result.current).toEqual({ data: 'recovered', error: null });
  });

  it('aborts requests and stops polling when unmounted', async () => {
    const pending = deferred<Response>();
    const fetchMock = vi.fn().mockReturnValue(pending.promise);
    vi.stubGlobal('fetch', fetchMock);
    const { unmount } = renderHook(() => usePolling('/a', 1000));
    unmount();
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    await act(async () => { pending.resolve(response('late')); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
