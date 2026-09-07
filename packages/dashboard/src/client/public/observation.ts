import { create } from "zustand";

export interface PublicState {
  id: string;
  name: string;
  isPublic: true;
  memberCount: number | null;
  selfMd: string | null;
}
export interface PublicPeer {
  id: string;
  name: string;
  online: boolean | null;
}
export interface PublicObservation {
  schemaVersion: 1;
  source: "public-node" | "public-snapshot" | "demo";
  observedAt: string | null;
  node: { id: string; name: string };
  states: PublicState[];
  peers: PublicPeer[];
  links: [];
  counts: {
    publicStates: number;
    onlineAgents: number | null;
    unknown: number;
  };
}
export type ObservationMode =
  "node" | "demo" | "snapshot" | "stale" | "error" | "loading";
const record = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new Error("Expected a public network snapshot.");
  return v as Record<string, unknown>;
};
const idOf = (v: unknown) => {
  if (typeof v !== "string" || !v.trim() || v.length > 160)
    throw new Error("Invalid published ID.");
  return v;
};
export function normalizeObservation(value: unknown): PublicObservation {
  const raw = record(value);
  if (
    raw.schemaVersion !== 1 ||
    (raw.source !== "public-node" && raw.source !== "public-snapshot")
  )
    throw new Error("Unsupported public snapshot format.");
  if (
    typeof raw.observedAt !== "string" ||
    !Number.isFinite(Date.parse(raw.observedAt)) ||
    Date.parse(raw.observedAt) > Date.now() + 60000
  )
    throw new Error("Invalid observation date.");
  if (
    !Array.isArray(raw.states) ||
    !Array.isArray(raw.peers) ||
    raw.states.length > 1000 ||
    raw.peers.length > 1000
  )
    throw new Error("A snapshot may contain up to 1,000 states and agents.");
  const node = record(raw.node);
  const states: PublicState[] = [],
    peers: PublicPeer[] = [];
  const stateIds = new Set<string>(),
    peerIds = new Set<string>();
  for (const value of raw.states) {
    const item = record(value),
      id = idOf(item.id);
    if (item.isPublic !== true)
      throw new Error("Private records cannot be imported.");
    if (typeof item.selfMd === "string" && item.selfMd.length > 6000)
      throw new Error(
        "Published context exceeds 6,000 characters. Import an approved excerpt.",
      );
    if (stateIds.has(id)) continue;
    stateIds.add(id);
    states.push({
      id,
      name: typeof item.name === "string" ? item.name.slice(0, 100) : id,
      isPublic: true,
      memberCount:
        typeof item.memberCount === "number" &&
        Number.isSafeInteger(item.memberCount) &&
        item.memberCount >= 0
          ? item.memberCount
          : null,
      selfMd:
        typeof item.selfMd === "string" ? item.selfMd.slice(0, 6000) : null,
    });
  }
  for (const value of raw.peers) {
    const item = record(value),
      id = idOf(item.id);
    if (peerIds.has(id)) continue;
    peerIds.add(id);
    peers.push({
      id,
      name: typeof item.name === "string" ? item.name.slice(0, 100) : id,
      online: typeof item.online === "boolean" ? item.online : null,
    });
  }
  return {
    schemaVersion: 1,
    source: raw.source as "public-node" | "public-snapshot",
    observedAt: raw.observedAt,
    node: {
      id: idOf(node.id),
      name:
        typeof node.name === "string"
          ? node.name.slice(0, 100)
          : "public observer",
    },
    states,
    peers,
    links: [],
    counts: {
      publicStates: states.length,
      onlineAgents:
        peers.length && peers.every((p) => p.online === null)
          ? null
          : peers.filter((p) => p.online === true).length,
      unknown: peers.filter((p) => p.online === null).length,
    },
  };
}
export const DEMO_OBSERVATION: PublicObservation = {
  schemaVersion: 1,
  source: "demo",
  observedAt: null,
  node: { id: "demo-you", name: "you" },
  peers: [
    { id: "demo-ray", name: "Ray’s agent", online: true },
    { id: "demo-orbit", name: "orbit", online: true },
    { id: "demo-tiamat", name: "tiamat", online: false },
    { id: "demo-scribe", name: "scribe@l", online: true },
    { id: "demo-planner", name: "planner@a", online: true },
    { id: "demo-noise", name: "noisecraft", online: false },
  ],
  states: [
    {
      id: "demo-builders",
      name: "builders",
      isPublic: true,
      memberCount: 3,
      selfMd:
        "# builders\nwe’re here to build, not perform busy.\nleave the next person a useful trail.",
    },
    {
      id: "demo-fieldnotes",
      name: "field notes",
      isPublic: true,
      memberCount: 2,
      selfMd:
        "# field notes\nkeep the useful bits.\nask before sharing someone’s context.",
    },
    {
      id: "demo-afterhours",
      name: "after hours",
      isPublic: true,
      memberCount: 4,
      selfMd:
        "# after hours\nsome conversations need a room.\nthis is an example, not a real state.",
    },
  ],
  links: [],
  counts: { publicStates: 3, onlineAgents: 4, unknown: 0 },
};
interface ObservationStore {
  data: PublicObservation | null;
  mode: ObservationMode;
  loading: boolean;
  error: string | null;
  feedPath: string;
  refresh: () => Promise<void>;
  setMode: (mode: "node" | "demo") => void;
  importSnapshot: (value: unknown) => void;
  setFeedPath: (path: string) => void;
}
let generation = 0,
  controller: AbortController | null = null;
export function validateFeedPath(path: string) {
  if (
    !/^\/api\/public\/[a-zA-Z0-9/_-]+$/.test(path) ||
    path.includes("//") ||
    path.includes("..")
  )
    throw new Error("Use a same-origin path inside /api/public/.");
  return path;
}
export const useObservation = create<ObservationStore>((set, get) => ({
  data: null,
  mode: "loading",
  loading: false,
  error: null,
  feedPath: "/api/public/network",
  async refresh() {
    if (get().loading || get().mode === "demo" || get().mode === "snapshot")
      return;
    const current = ++generation;
    controller?.abort();
    controller = new AbortController();
    const signal = controller.signal,
      timer = setTimeout(
        () => controller?.signal === signal && controller.abort(),
        6500,
      );
    set({ loading: true });
    try {
      const response = await fetch(get().feedPath, {
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        signal,
        headers: { Accept: "application/json" },
      });
      if (!response.ok)
        throw new Error(`Public feed unavailable (${response.status}).`);
      if (!response.headers.get("content-type")?.includes("application/json"))
        throw new Error("The public feed did not return JSON.");
      const text = await response.text();
      if (text.length > 2_000_000) throw new Error("Public feed is too large.");
      const data = normalizeObservation(JSON.parse(text));
      if (current !== generation) return;
      const age = Date.now() - Date.parse(data.observedAt!);
      set({
        data,
        mode:
          data.source === "public-snapshot"
            ? "snapshot"
            : age >= 60000
              ? "stale"
              : "node",
        loading: false,
        error: null,
      });
    } catch (error) {
      if (current === generation)
        set({
          mode: get().data ? "stale" : "error",
          loading: false,
          error:
            error instanceof Error
              ? error.message
              : "Could not load the public view.",
        });
    } finally {
      clearTimeout(timer);
    }
  },
  setMode(mode) {
    generation++;
    controller?.abort();
    set({
      mode: mode === "demo" ? "demo" : "loading",
      data: mode === "demo" ? DEMO_OBSERVATION : null,
      loading: false,
      error: null,
    });
    if (mode === "node") void get().refresh();
  },
  importSnapshot(value) {
    const data = normalizeObservation(value);
    generation++;
    controller?.abort();
    set({ data, mode: "snapshot", loading: false, error: null });
  },
  setFeedPath(path) {
    validateFeedPath(path);
    set({ feedPath: path });
    get().setMode("node");
  },
}));
export function startObservation() {
  const tick = () => {
    const state = useObservation.getState();
    if (document.hidden) return;
    if (
      state.mode === "node" &&
      state.data?.observedAt &&
      Date.now() - Date.parse(state.data.observedAt) >= 60000
    )
      useObservation.setState({ mode: "stale" });
    void useObservation.getState().refresh();
  };
  tick();
  const interval = setInterval(tick, 15000);
  document.addEventListener("visibilitychange", tick);
  return () => {
    clearInterval(interval);
    document.removeEventListener("visibilitychange", tick);
    generation++;
    controller?.abort();
    useObservation.setState({ loading: false });
  };
}
export function observationLabel(mode: ObservationMode) {
  return mode === "demo"
    ? "example data"
    : mode === "snapshot"
      ? "snapshot"
      : mode === "stale"
        ? "stale observation"
        : mode === "node"
          ? "node view"
          : mode === "loading"
            ? "connecting"
            : "feed unavailable";
}
export function formatCount(value: number | null | undefined) {
  return value == null ? "—" : String(value).padStart(2, "0");
}
