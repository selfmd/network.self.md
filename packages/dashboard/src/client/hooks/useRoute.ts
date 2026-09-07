import { useState, useEffect } from "react";

export type Route =
  | { page: "home" }
  | { page: "operator" }
  | { page: "operator-discover" }
  | { page: "selfmd" }
  | { page: "state"; stateId: string }
  | { page: "discover" }
  | { page: "wire" }
  | { page: "security" }
  | { page: "settings" };

function parseHash(): Route {
  const fragment = window.location.hash.slice(1);
  const hash = (
    fragment.startsWith("/")
      ? fragment
      : window.location.pathname.endsWith("/selfmd-file.html")
        ? "/selfmd"
        : window.location.pathname.endsWith("/discover.html")
          ? "/discover"
          : "/"
  )
    .split("?")[0]
    .split("#")[0];
  if (hash === "/operator") return { page: "operator" };
  if (hash === "/operator/discover") return { page: "operator-discover" };
  if (hash === "/selfmd" || hash === "/selfmd-file") return { page: "selfmd" };
  const stateMatch = hash.match(/^\/states?\/(.+)$/);
  if (stateMatch) {
    try {
      return { page: "state", stateId: decodeURIComponent(stateMatch[1]) };
    } catch {
      return { page: "home" };
    }
  }
  if (hash === "/discover") return { page: "discover" };
  if (hash === "/wire") return { page: "wire" };
  if (hash === "/security") return { page: "security" };
  if (hash === "/settings") return { page: "settings" };
  return { page: "home" };
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(parseHash);

  useEffect(() => {
    const handler = () => setRoute(parseHash());
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);

  return route;
}

export function navigate(path: string) {
  window.location.hash = path;
}
