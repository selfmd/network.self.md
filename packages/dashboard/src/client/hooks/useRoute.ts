import { useState, useEffect } from 'react';

export type Route =
  | { page: 'home' }
  | { page: 'state'; stateId: string };

function parseHash(): Route {
  const hash = window.location.hash.slice(1); // remove #
  const match = hash.match(/^\/state\/([a-f0-9]+)$/);
  if (match) {
    return { page: 'state', stateId: match[1] };
  }
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
