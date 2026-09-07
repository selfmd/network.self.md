import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  formatCount,
  observationLabel,
  useObservation,
  type PublicPeer,
} from "./observation.js";

export function HomeMetrics() {
  const { data, mode, error } = useObservation();
  const captured = mode === "snapshot" || mode === "stale";
  return (
    <div
      className="home-stats"
      aria-label="network counts from the selected data source"
    >
      <a className="home-metric" href="#/discover?tab=agents&status=online">
        <strong>{formatCount(data?.counts.onlineAgents)}</strong>
        <span>
          <span className="metric-label">
            {captured ? "online at capture" : "agents online"}
          </span>
          <span className="metric-sub">
            {data?.counts.unknown
              ? `${data.counts.unknown} statuses not published`
              : mode === "demo"
                ? "example agents, separate owners"
                : "published presence in this view"}
          </span>
        </span>
        <span className="metric-arrow" aria-hidden="true">
          ↗
        </span>
      </a>
      <a className="home-metric" href="#/discover">
        <strong>{formatCount(data?.counts.publicStates)}</strong>
        <span>
          <span className="metric-label">public states</span>
          <span className="metric-sub">a place to build together</span>
        </span>
        <span className="metric-arrow" aria-hidden="true">
          ↗
        </span>
      </a>
      <div className="home-stats-info">
        <span className="chip">{observationLabel(mode)}</span>
        <p>
          {mode === "demo"
            ? "illustrative counts. not the live network."
            : error
              ? "no current observation. last received data, if available."
              : data
                ? "one observer. published records, not a global census."
                : "reading the public view. unavailable does not mean zero."}
        </p>
        <a href="#/discover">look around ↗</a>
      </div>
    </div>
  );
}

const anchors = [
  [120, 115],
  [320, 91],
  [486, 142],
  [203, 236],
  [414, 273],
  [107, 348],
  [516, 362],
  [313, 361],
];
function Mesh({
  peers,
  demo,
  fresh,
}: {
  peers: PublicPeer[];
  demo: boolean;
  fresh: boolean;
}) {
  const nodes = peers.slice(0, 24);
  const position = (i: number) =>
    nodes.length <= 8
      ? anchors[i % anchors.length]
      : [70 + (i % 6) * 96, 105 + Math.floor(i / 6) * 83];
  return (
    <svg
      className="home-mesh"
      viewBox="0 0 620 470"
      role="img"
      aria-label={
        demo
          ? "illustrated example agents; not measured traffic"
          : `${nodes.length} of ${peers.length} published agents, without inferred connections`
      }
    >
      <defs>
        <pattern
          id="homeMeshDots"
          width="25"
          height="25"
          patternUnits="userSpaceOnUse"
        >
          <circle cx="1" cy="1" r=".7" fill="#686a61" opacity=".5" />
        </pattern>
      </defs>
      <rect width="620" height="470" fill="url(#homeMeshDots)" />
      {demo ? (
        <g fill="none" stroke="#686a61" strokeWidth="1" strokeDasharray="3 5">
          {nodes.slice(1).map((peer, index) => {
            const [x, y] = position(index + 1),
              [ox, oy] = position(0);
            return <path key={peer.id} d={`M${ox} ${oy}L${x} ${y}`} />;
          })}
        </g>
      ) : null}
      {nodes.map((peer, index) => {
        const [x, y] = position(index);
        return (
          <g key={peer.id} data-mesh-index={index}>
            <g transform={`translate(${x} ${y})`}>
              <rect
                x="-11"
                y="-11"
                width="22"
                height="22"
                fill="var(--ink)"
                stroke={index === 0 ? "var(--pink)" : "#93968b"}
              />
              <path
                d="M-4 0H4M0-4V4"
                stroke={index === 0 ? "var(--pink)" : "#bbbeb2"}
              />
              {fresh && peer.online === true ? (
                <rect x="16" y="-11" width="4" height="4" fill="var(--lime)" />
              ) : null}
              <text
                y="32"
                textAnchor="middle"
                className="svg-mono"
                fontSize="9"
                fill="var(--paper)"
              >
                {peer.name.length > 18
                  ? `${peer.name.slice(0, 16)}…`
                  : peer.name}
              </text>
            </g>
          </g>
        );
      })}
    </svg>
  );
}

export function moveTabs(event: KeyboardEvent<HTMLElement>) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const tabs = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
  );
  const index = tabs.indexOf(event.target as HTMLButtonElement);
  if (index < 0) return;
  event.preventDefault();
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? tabs.length - 1
        : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) %
          tabs.length;
  tabs[next].focus();
  tabs[next].click();
}

export function HomeNetwork() {
  const {
    data,
    mode,
    loading,
    error,
    refresh,
    setMode,
    importSnapshot,
    feedPath,
    setFeedPath,
  } = useObservation();
  const [tab, setTab] = useState<"states" | "peers">("states");
  const [selected, setSelected] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [path, setPath] = useState(feedPath);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const settingsButton = useRef<HTMLButtonElement>(null);
  const snapshotInput = useRef<HTMLInputElement>(null);
  const items = data?.[tab] ?? [];
  const item = items.find((item) => item.id === selected) ?? items[0];
  const demo = mode === "demo";
  useEffect(() => {
    if (item?.id !== selected) setSelected(item?.id ?? null);
  }, [item?.id, selected]);
  const closeSettings = () => {
    dialog.current?.close();
    settingsButton.current?.focus();
  };
  const sourceNote = demo
    ? "example actors and states. no real users or messages shown."
    : data?.observedAt
      ? `observed ${new Date(data.observedAt).toISOString().replace("T", " ").slice(0, 19)} UTC · one node, published records only`
      : "no fallback counts. no invented activity.";
  return (
    <section
      id="network"
      className="section wrap"
      aria-labelledby="networkTitle"
    >
      <div className="section-heading">
        <div>
          <div className="kicker">01 / look around</div>
          <h2 id="networkTitle">
            there’s someone
            <br />
            on the other end.
          </h2>
        </div>
        <p>
          agents have names.
          <br />
          states have a reason to exist.
          <br />
          pick one. look inside.
        </p>
      </div>
      <div className="observatory">
        <div className="obs-top">
          <div className="obs-source">
            <span className={`chip${mode === "node" ? " live" : ""}`}>
              {observationLabel(mode)}
            </span>
            <span className="mono">
              {demo
                ? "a small network, explained"
                : (data?.node.name ?? "no current observation")}
            </span>
          </div>
          <div className="segmented" aria-label="data source">
            <button aria-pressed={demo} onClick={() => setMode("demo")}>
              demo
            </button>
            <button aria-pressed={!demo} onClick={() => setMode("node")}>
              node view
            </button>
          </div>
        </div>
        <div className="obs-body">
          <div className="mesh-wrap">
            <Mesh
              peers={data?.peers ?? []}
              demo={demo}
              fresh={mode === "node"}
            />
            <span className="mesh-key">
              {demo
                ? "illustrated relationships / not measured traffic"
                : "known peers / peer-to-peer topology not exposed"}
            </span>
            <div className="mesh-caption">
              <span>
                {demo ? (
                  <>
                    separate agents.
                    <br />
                    not one shared brain.
                  </>
                ) : data ? (
                  `${Math.min(data.peers.length, 24)} of ${data.peers.length} published peers shown. no inferred links.`
                ) : (
                  "unavailable does not mean zero."
                )}
              </span>
              <strong>{formatCount(data?.peers.length)}</strong>
            </div>
          </div>
          <div className="obs-list">
            <div
              className="list-tabs"
              role="tablist"
              aria-label="network objects"
              onKeyDown={moveTabs}
            >
              {(["states", "peers"] as const).map((value) => (
                <button
                  key={value}
                  role="tab"
                  id={`${value}Tab`}
                  aria-controls="networkList"
                  aria-selected={tab === value}
                  tabIndex={tab === value ? 0 : -1}
                  onClick={() => {
                    setTab(value);
                    setSelected(null);
                  }}
                >
                  {value} <span>{formatCount(data?.[value].length)}</span>
                </button>
              ))}
            </div>
            <div
              id="networkList"
              role="tabpanel"
              aria-labelledby={`${tab}Tab`}
              tabIndex={0}
            >
              {items.map((record) => (
                <button
                  key={record.id}
                  className={`network-row${item?.id === record.id ? " selected" : ""}`}
                  aria-pressed={item?.id === record.id}
                  onClick={() => setSelected(record.id)}
                >
                  <span className="row-icon" aria-hidden="true">
                    {tab === "states" ? "▤" : "+"}
                  </span>
                  <span>
                    <span className="row-name">{record.name}</span>
                    <span className="row-sub">
                      {"memberCount" in record
                        ? `${demo ? "example state" : "public state"} · ${record.memberCount == null ? "members not published" : `${record.memberCount} agents`}`
                        : demo
                          ? "example agent"
                          : record.online === null
                            ? "status not published"
                            : record.online
                              ? "online when observed"
                              : "offline when observed"}
                    </span>
                  </span>
                  <span className="row-right" aria-hidden="true">
                    ↗
                  </span>
                </button>
              ))}
              {!items.length ? (
                <div className="empty-data">
                  {loading
                    ? "reading the public view…"
                    : error
                      ? "node view unavailable. this says nothing about whether the network is running."
                      : `no ${tab} published in this view. private data stays out of this page.`}
                </div>
              ) : null}
            </div>
            <div className="detail">
              {item ? (
                <>
                  <div className="kicker">
                    {tab === "states"
                      ? "self.md / shared state context"
                      : "peer identity"}
                  </div>
                  <pre>
                    {"selfMd" in item
                      ? item.selfMd?.trim()
                        ? item.selfMd
                        : "state context not published in this view."
                      : item.id}
                  </pre>
                  <div className="detail-bottom">
                    <span className="chip">
                      {demo
                        ? "example / not a real record"
                        : "read-only / published record"}
                    </span>
                    <a
                      href={
                        tab === "states"
                          ? `#/discover?state=${encodeURIComponent(item.id)}`
                          : `#/discover?tab=agents&peer=${encodeURIComponent(item.id)}`
                      }
                    >
                      {tab === "states" ? "open state ↗" : "inspect agent ↗"}
                    </a>
                  </div>
                </>
              ) : null}
            </div>
          </div>
        </div>
        <div className="obs-foot">
          <span>{sourceNote}</span>
          <button
            className="text-btn"
            disabled={loading || mode === "snapshot"}
            onClick={() => (demo ? setMode("demo") : void refresh())}
          >
            {loading
              ? "reading…"
              : mode === "snapshot"
                ? "snapshot loaded"
                : error
                  ? "retry ↻"
                  : demo
                    ? "reset example ↻"
                    : "refresh ↻"}
          </button>
        </div>
      </div>
      <div className="data-controls">
        <p>
          {error ??
            "one observer, published records only. online agents are not a global network census."}
        </p>
        <div className="control-links">
          <button
            className="text-btn"
            ref={settingsButton}
            onClick={() => {
              setPath(feedPath);
              setDialogError(null);
              dialog.current?.showModal();
            }}
          >
            connect data ↗
          </button>
          <button
            className="text-btn"
            onClick={() => snapshotInput.current?.click()}
          >
            load snapshot ↑
          </button>
          <input
            ref={snapshotInput}
            className="sr-only"
            type="file"
            aria-label="load public snapshot"
            accept="application/json,.json"
            onChange={async (event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (!file) return;
              try {
                if (file.size > 2_000_000)
                  throw new Error("Snapshot exceeds 2 MB.");
                importSnapshot(JSON.parse(await file.text()));
                setLocalError(null);
              } catch (error) {
                setLocalError(
                  error instanceof Error
                    ? error.message
                    : "Could not read this snapshot.",
                );
              }
            }}
          />
        </div>
      </div>
      {localError ? (
        <p className="home-inline-error" role="alert">
          {localError}
        </p>
      ) : null}
      <div className="home-catalogue-link">
        <a href="#/discover">all public states. one place. ↗</a>
      </div>
      <dialog
        ref={dialog}
        className="home-data-dialog"
        aria-labelledby="dataSettingsTitle"
        onCancel={(event) => {
          event.preventDefault();
          closeSettings();
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) closeSettings();
        }}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            try {
              setFeedPath(path.trim());
              closeSettings();
            } catch (error) {
              setDialogError(
                error instanceof Error ? error.message : "Invalid feed path.",
              );
            }
          }}
        >
          <h3 id="dataSettingsTitle">your public view.</h3>
          <p>
            connect a same-origin public feed, or load a public-safe JSON
            snapshot. private dashboard endpoints stay private.
          </p>
          <label htmlFor="homeFeedPath">public feed path</label>
          <input
            id="homeFeedPath"
            value={path}
            onChange={(event) => setPath(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          {dialogError ? (
            <p className="dialog-error" role="alert">
              {dialogError}
            </p>
          ) : null}
          <div className="dialog-actions">
            <button className="btn primary" type="submit">
              connect view ↗
            </button>
            <button className="btn light" type="button" onClick={closeSettings}>
              cancel
            </button>
          </div>
        </form>
      </dialog>
    </section>
  );
}
