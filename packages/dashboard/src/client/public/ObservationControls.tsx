import { useRef, useState } from "react";
import { formatCount, observationLabel, useObservation } from "./observation";
export function ObservationControls() {
  const {
    data,
    mode,
    loading,
    error,
    setMode,
    refresh,
    importSnapshot,
    feedPath,
    setFeedPath,
  } = useObservation();
  const input = useRef<HTMLInputElement>(null);
  const [issue, setIssue] = useState("");
  const [config, setConfig] = useState(false);
  const [path, setPath] = useState(feedPath);
  return (
    <>
      <div className="directory-strip">
        <span className={`chip ${mode === "node" ? "live" : ""}`}>
          {observationLabel(mode)}
        </span>
        <div className="strip-counts">
          <a href="#/discover?tab=agents&status=online">
            <b>{formatCount(data?.counts.onlineAgents)}</b>{" "}
            {mode === "snapshot" || mode === "stale"
              ? "online at capture"
              : "agents online"}{" "}
            ↗
          </a>
          <span>
            <b>{formatCount(data?.counts.publicStates)}</b> public states
          </span>
        </div>
        <div className="segmented" aria-label="directory data source">
          <button
            aria-pressed={mode === "demo"}
            onClick={() => setMode("demo")}
          >
            demo
          </button>
          <button
            aria-pressed={mode !== "demo"}
            onClick={() => setMode("node")}
          >
            node view
          </button>
        </div>
        <button
          className="text-btn"
          disabled={loading}
          onClick={() =>
            mode === "demo" || mode === "snapshot"
              ? setMode("node")
              : void refresh()
          }
        >
          {loading ? "refreshing…" : "refresh ↻"}
        </button>
      </div>
      <div className="directory-meta">
        <span>
          {mode === "demo"
            ? "illustrative records, not a live network census."
            : data
              ? `${data.node.name} · one observer · published records only · ${data.observedAt}`
              : "waiting for a public-safe observation."}
        </span>
        <div className="meta-links">
          <button className="text-btn" onClick={() => setConfig(!config)}>
            connect data ↗
          </button>
          <button className="text-btn" onClick={() => input.current?.click()}>
            load snapshot ↑
          </button>
        </div>
      </div>
      {config && (
        <form
          className="feed-config"
          onSubmit={(e) => {
            e.preventDefault();
            try {
              setFeedPath(path);
              setIssue("");
              setConfig(false);
            } catch (e) {
              setIssue((e as Error).message);
            }
          }}
        >
          <label htmlFor="publicFeedPath">same-origin public feed</label>
          <input
            id="publicFeedPath"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="/api/public/network"
          />
          <button className="btn" type="submit">
            connect ↗
          </button>
        </form>
      )}
      <input
        ref={input}
        hidden
        type="file"
        accept="application/json,.json"
        aria-label="import public snapshot"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          try {
            if (file.size > 2_000_000)
              throw new Error("Snapshot must be smaller than 2 MB.");
            importSnapshot(JSON.parse(await file.text()));
            setIssue("");
          } catch (error) {
            setIssue(
              error instanceof Error
                ? error.message
                : "Could not import snapshot.",
            );
          }
          e.target.value = "";
        }}
      />
      {(issue || error) && (
        <div className="public-error" role="alert">
          {issue || error}{" "}
          <button
            className="text-btn"
            onClick={() => {
              setIssue("");
              setMode("node");
            }}
          >
            retry ↻
          </button>
        </div>
      )}
    </>
  );
}
