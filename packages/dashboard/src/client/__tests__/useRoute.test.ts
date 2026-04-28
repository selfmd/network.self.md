/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRoute } from '../hooks/useRoute.js';

describe('useRoute', () => {
  afterEach(() => {
    window.location.hash = '';
  });

  it('defaults to home when hash is empty', () => {
    window.location.hash = '';
    const { result } = renderHook(() => useRoute());
    expect(result.current).toEqual({ page: 'home' });
  });

  it('parses /discover', () => {
    window.location.hash = '#/discover';
    const { result } = renderHook(() => useRoute());
    expect(result.current).toEqual({ page: 'discover' });
  });

  it('parses /wire', () => {
    window.location.hash = '#/wire';
    const { result } = renderHook(() => useRoute());
    expect(result.current).toEqual({ page: 'wire' });
  });

  it('parses /security', () => {
    window.location.hash = '#/security';
    const { result } = renderHook(() => useRoute());
    expect(result.current).toEqual({ page: 'security' });
  });

  it('parses /settings', () => {
    window.location.hash = '#/settings';
    const { result } = renderHook(() => useRoute());
    expect(result.current).toEqual({ page: 'settings' });
  });

  it('parses /state/:id', () => {
    window.location.hash = '#/state/abc123';
    const { result } = renderHook(() => useRoute());
    expect(result.current).toEqual({ page: 'state', stateId: 'abc123' });
  });

  it('parses /states/:id (plural form)', () => {
    window.location.hash = '#/states/def456';
    const { result } = renderHook(() => useRoute());
    expect(result.current).toEqual({ page: 'state', stateId: 'def456' });
  });

  it('decodes percent-encoded state id', () => {
    window.location.hash = '#/state/hello%20world';
    const { result } = renderHook(() => useRoute());
    expect(result.current).toEqual({ page: 'state', stateId: 'hello world' });
  });

  it('falls back to home for unknown routes', () => {
    window.location.hash = '#/unknown-page';
    const { result } = renderHook(() => useRoute());
    expect(result.current).toEqual({ page: 'home' });
  });

  it('responds to hashchange events', () => {
    window.location.hash = '#/';
    const { result } = renderHook(() => useRoute());
    expect(result.current.page).toBe('home');

    act(() => {
      window.location.hash = '#/discover';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });

    expect(result.current).toEqual({ page: 'discover' });
  });
});
