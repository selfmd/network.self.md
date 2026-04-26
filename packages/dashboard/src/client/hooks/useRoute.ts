import { useState, useEffect } from 'react';

export type Route =
  | { page: 'home' }
  | { page: 'state'; stateId: string }
  | { page: 'discover' }
  | { page: 'wire' }
  | { page: 'security' }
  | { page: 'settings' };

function parseHash(): Route {
  const hash = window.location.hash.slice(1) || '/';
  const stateMatch = hash.match(/^\/states?\/(.+)$/);
  if (stateMatch) {
    return { page: 'state', stateId: decodeURIComponent(stateMatch[1]) };
  }
  if (hash === '/discover') return { page: 'discover' };
  if (hash === '/wire') return { page: 'wire' };
  if (hash === '/security') return { page: 'security' };
  if (hash === '/settings') return { page: 'settings' };
  return { page: 'home' };
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(parseHash);

  useEffect(() => {
    const handler = () => setRoute(parseHash());
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  }, []);

  return route;
}

export function navigate(path: string) {
  window.location.hash = path;
}
