import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizeObservation,
  startObservation,
  useObservation,
  validateFeedPath,
} from "./observation";
const snapshot = () => ({
  schemaVersion: 1,
  source: "public-node",
  observedAt: new Date().toISOString(),
  node: { id: "observer", name: "approved observer" },
  states: [
    {
      id: "aa",
      name: "Builders",
      isPublic: true,
      memberCount: 3,
      selfMd: "# Shared\nAsk first.",
    },
  ],
  peers: [
    { id: "peer-a", name: "Ray", online: true },
    { id: "peer-b", name: "Unknown", online: null },
  ],
  links: [{ source: "a", target: "b" }],
});
afterEach(() => {
  useObservation.getState().setMode("demo");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
describe("public observation boundary", () => {
  it("deduplicates IDs without merging names and drops arbitrary fields and topology", () => {
    const raw = snapshot();
    raw.states.push({ ...raw.states[0] }, { ...raw.states[0], id: "bb" });
    const data = normalizeObservation(raw);
    expect(data.states).toHaveLength(2);
    expect(data.counts).toEqual({
      publicStates: 2,
      onlineAgents: 1,
      unknown: 1,
    });
    expect(data.links).toEqual([]);
    expect(data.states[0].name).toBe("Builders");
  });
  it("rejects any private record even when its ID duplicates a public record", () => {
    const raw = snapshot();
    raw.states.push({ ...raw.states[0], isPublic: false });
    expect(() => normalizeObservation(raw)).toThrow("Private");
  });
  it("keeps unknown presence distinct from offline and empty success", () => {
    const raw = snapshot();
    raw.peers = [{ id: "unknown", name: "not published", online: null }];
    expect(normalizeObservation(raw).counts.onlineAgents).toBeNull();
    raw.peers = [];
    expect(normalizeObservation(raw).counts.onlineAgents).toBe(0);
  });
  it("rejects malformed and future observations", () => {
    expect(() =>
      normalizeObservation({ ...snapshot(), observedAt: "bad" }),
    ).toThrow("date");
    expect(() =>
      normalizeObservation({
        ...snapshot(),
        observedAt: new Date(Date.now() + 120000).toISOString(),
      }),
    ).toThrow("date");
    expect(() =>
      normalizeObservation({ ...snapshot(), schemaVersion: 2 }),
    ).toThrow("format");
  });
  it("permits only fixed same-origin public paths", () => {
    expect(validateFeedPath("/api/public/network")).toBe("/api/public/network");
    for (const path of [
      "https://evil.test/api/public/network",
      "//evil.test",
      "/api/states",
      "/api/public/../states",
      "/api/public/network?q=a",
      "/api/public/network#secret",
    ])
      expect(() => validateFeedPath(path)).toThrow();
  });
  it("does not let a late node response replace an imported snapshot", async () => {
    let finish!: (r: unknown) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      ),
    );
    useObservation.getState().setMode("node");
    const raw = snapshot();
    raw.node.name = "snapshot chosen";
    useObservation.getState().importSnapshot(raw);
    finish({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      text: async () => JSON.stringify(snapshot()),
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(useObservation.getState().mode).toBe("snapshot");
    expect(useObservation.getState().data?.node.name).toBe("snapshot chosen");
  });
  it("keeps the last successful observation on refresh error", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          text: async () => JSON.stringify(snapshot()),
        })
        .mockRejectedValueOnce(new Error("offline")),
    );
    useObservation.setState({
      data: null,
      mode: "node",
      loading: false,
      error: null,
    });
    await useObservation.getState().refresh();
    expect(useObservation.getState().mode).toBe("node");
    await useObservation.getState().refresh();
    expect(useObservation.getState().mode).toBe("stale");
    expect(useObservation.getState().data?.states[0].name).toBe("Builders");
    expect(useObservation.getState().error).toBe("offline");
  });
  it("rejects HTML fallback without showing example data", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue({
          ok: true,
          headers: new Headers({ "content-type": "text/html" }),
        }),
    );
    useObservation.setState({
      data: null,
      mode: "node",
      loading: false,
      error: null,
    });
    await useObservation.getState().refresh();
    expect(useObservation.getState().mode).toBe("error");
    expect(useObservation.getState().data).toBeNull();
  });
});

const jsonResponse = (value: unknown) => ({
  ok: true,
  headers: new Headers({ "content-type": "application/json" }),
  text: async () => JSON.stringify(value),
});
function nodeMode() {
  useObservation.setState({
    data: null,
    mode: "node",
    loading: false,
    error: null,
    feedPath: "/api/public/network",
  });
}

describe("observation lifecycle and freshness", () => {
  it("rejects coerced source arrays and oversized context without changing a selected snapshot", () => {
    const raw = snapshot();
    useObservation.getState().importSnapshot(raw);
    const selected = useObservation.getState().data;
    expect(() =>
      normalizeObservation({ ...raw, source: ["public-node"] }),
    ).toThrow("format");
    expect(() =>
      useObservation
        .getState()
        .importSnapshot({
          ...raw,
          states: [{ ...raw.states[0], selfMd: "x".repeat(6001) }],
        }),
    ).toThrow("6,000");
    expect(useObservation.getState().data).toBe(selected);
    expect(useObservation.getState().mode).toBe("snapshot");
  });
  it("accepts tolerated clock skew, marks old node captures stale, and preserves capture dates", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-05T12:00:00Z"));
    const raw = snapshot();
    raw.observedAt = "2026-09-05T11:59:00Z";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(raw)));
    nodeMode();
    await useObservation.getState().refresh();
    expect(useObservation.getState().mode).toBe("stale");
    expect(useObservation.getState().data?.observedAt).toBe(raw.observedAt);
    expect(
      normalizeObservation({ ...raw, observedAt: "2026-09-05T12:01:00Z" })
        .observedAt,
    ).toBe("2026-09-05T12:01:00Z");
    expect(() =>
      normalizeObservation({ ...raw, observedAt: "2026-09-05T12:01:00.001Z" }),
    ).toThrow("date");
  });
  it("aborts timed-out requests after 6.5 seconds and exposes unknown counts on first failure", async () => {
    vi.useFakeTimers();
    let signal!: AbortSignal;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url, options) => {
        signal = options.signal;
        return new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () =>
            reject(new Error("timed out")),
          ),
        );
      }),
    );
    nodeMode();
    const pending = useObservation.getState().refresh();
    await vi.advanceTimersByTimeAsync(6499);
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(signal.aborted).toBe(true);
    expect(useObservation.getState().mode).toBe("error");
    expect(useObservation.getState().data).toBeNull();
    expect(useObservation.getState().loading).toBe(false);
  });
  it("allows only one background request and omits credentials while refusing redirects", async () => {
    let finish!: (value: unknown) => void;
    const fetch = vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetch);
    nodeMode();
    const pending = useObservation.getState().refresh();
    await useObservation.getState().refresh();
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]).toEqual([
      "/api/public/network",
      expect.objectContaining({
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        headers: { Accept: "application/json" },
      }),
    ]);
    finish(jsonResponse(snapshot()));
    await pending;
    expect(useObservation.getState().loading).toBe(false);
  });
  it("does not let a late rejection overwrite explicit demo selection", async () => {
    let fail!: (error: Error) => void;
    let signal!: AbortSignal;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url, options) => {
        signal = options.signal;
        return new Promise((_resolve, reject) => {
          fail = reject;
        });
      }),
    );
    nodeMode();
    const pending = useObservation.getState().refresh();
    useObservation.getState().setMode("demo");
    expect(signal.aborted).toBe(true);
    fail(new Error("late network failure"));
    await pending;
    expect(useObservation.getState().mode).toBe("demo");
    expect(useObservation.getState().error).toBeNull();
    expect(useObservation.getState().data?.source).toBe("demo");
  });
  it("polls only visible tabs, marks stale data before refresh, and cleans up polling", async () => {
    vi.useFakeTimers();
    const document = new EventTarget() as EventTarget & { hidden: boolean };
    document.hidden = false;
    vi.stubGlobal("document", document);
    const raw = snapshot();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(raw))
      .mockImplementation(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetch);
    nodeMode();
    const stop = startObservation();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledOnce();
    document.hidden = true;
    await vi.advanceTimersByTimeAsync(60000);
    expect(fetch).toHaveBeenCalledOnce();
    document.hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(useObservation.getState().mode).toBe("stale");
    expect(fetch).toHaveBeenCalledTimes(2);
    stop();
    expect(useObservation.getState().loading).toBe(false);
    await vi.advanceTimersByTimeAsync(60000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("imports public-node data as a snapshot without rewriting its provenance or timestamp", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const raw = snapshot();
    raw.observedAt = "2020-01-01T00:00:00Z";
    useObservation.getState().importSnapshot(raw);
    await useObservation.getState().refresh();
    expect(fetch).not.toHaveBeenCalled();
    expect(useObservation.getState().mode).toBe("snapshot");
    expect(useObservation.getState().data?.source).toBe("public-node");
    expect(useObservation.getState().data?.observedAt).toBe(raw.observedAt);
  });
});
