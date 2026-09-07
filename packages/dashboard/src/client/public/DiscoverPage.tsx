import { selfMdUrl, dashboardStateUrl } from "./config";
import { useEffect, useMemo, useRef, useState } from "react";
import { CopyButton } from "../components/CopyButton";
import { formatCount, observationLabel, useObservation } from "./observation";
import { ObservationControls } from "./ObservationControls";
import "./directory.css";

function StateArtwork({
  index,
  peer = false,
}: {
  index: number;
  peer?: boolean;
}) {
  if (peer)
    return (
      <svg viewBox="0 0 120 90" aria-hidden="true">
        <path d="M32 14H78L97 34V78H32Z" fill="var(--ink)" />
        <path
          d="M25 7H72L90 27V71H25Z"
          fill="var(--paper)"
          stroke="var(--ink)"
        />
        <path d="M72 7V27H90" fill="none" stroke="var(--ink)" />
        <rect x="34" y="33" width="44" height="24" fill="var(--pink)" />
        <text
          x="56"
          y="50"
          textAnchor="middle"
          fontFamily="monospace"
          fontSize="15"
          fontWeight="bold"
        >
          [!]
        </text>
      </svg>
    );
  return (
    <svg viewBox="0 0 146 102" aria-hidden="true">
      {index % 3 === 0 ? (
        <>
          <path d="M31 35L87 9L125 33L69 61Z" fill="var(--ink)" />
          <path
            d="M25 48L81 20L119 44L63 74Z"
            fill="var(--paper)"
            stroke="var(--ink)"
          />
          <path
            d="M25 58L81 30L119 54L63 84Z"
            fill="var(--paper)"
            stroke="var(--ink)"
          />
          <path
            d="M25 39L81 11L119 35L63 65Z"
            fill="var(--pink)"
            stroke="var(--ink)"
          />
          <path d="M48 38L78 23M56 43L90 26M66 47L87 36" stroke="var(--ink)" />
        </>
      ) : index % 3 === 1 ? (
        <>
          <rect x="35" y="18" width="67" height="70" fill="var(--ink)" />
          <rect
            x="29"
            y="12"
            width="67"
            height="70"
            fill="var(--paper)"
            stroke="var(--ink)"
          />
          <path d="M39 33H78M39 41H67M39 49H78M39 57H65" stroke="var(--ink)" />
          <rect
            x="71"
            y="51"
            width="42"
            height="25"
            fill="var(--pink)"
            stroke="var(--ink)"
          />
          <text
            x="92"
            y="69"
            fontFamily="monospace"
            fontSize="14"
            textAnchor="middle"
          >
            [!]
          </text>
        </>
      ) : (
        <>
          <rect x="32" y="23" width="69" height="61" fill="var(--ink)" />
          <path
            d="M26 14H54L64 24H104V78H26Z"
            fill="var(--paper)"
            stroke="var(--ink)"
          />
          <rect
            x="34"
            y="35"
            width="76"
            height="38"
            fill="var(--pink)"
            stroke="var(--ink)"
          />
          <path d="M47 48H92M47 57H77" stroke="var(--ink)" />
        </>
      )}
    </svg>
  );
}
function contextDescription(text: string | null) {
  if (!text?.trim())
    return "the self.md hasn’t been published in this view. read the shared terms in your own node.";
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .join(" ") || "shared context, in the state’s own words."
  )
    .replace(/^[>*-]\s?/, "")
    .slice(0, 300);
}
function paramsNow() {
  const params = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
  if (params.has("q")) params.set("q", (params.get("q") ?? "").slice(0, 160));
  for (const [key, values] of Object.entries({
    tab: ["states", "agents"],
    context: ["all", "with", "without"],
    status: ["all", "online", "offline", "unknown"],
    sort: ["name", "members"],
  })) {
    if (params.has(key) && !values.includes(params.get(key)!))
      params.delete(key);
  }
  return params;
}
export function DiscoverPage() {
  const { data, mode, loading, refresh, setMode } = useObservation();
  const [params, setParams] = useState(paramsNow);
  const [query, setQuery] = useState(() => params.get("q") ?? "");
  const [limit, setLimit] = useState(24);
  const [joined, setJoined] = useState<Set<string>>(() => new Set());
  const search = useRef<HTMLInputElement>(null),
    dialog = useRef<HTMLDialogElement>(null),
    heading = useRef<HTMLHeadingElement>(null);
  const tab = params.get("tab") === "agents" ? "agents" : "states",
    context = params.get("context") ?? "all",
    status = params.get("status") ?? "all",
    sort = params.get("sort") ?? "name";
  const detailId = params.get(tab === "states" ? "state" : "peer");
  const hasFilters = Boolean(
    query.trim() || (tab === "states" ? context !== "all" : status !== "all"),
  );
  const fresh = mode === "node";
  const detail =
    tab === "states"
      ? data?.states.find((s) => s.id === detailId)
      : data?.peers.find((p) => p.id === detailId);
  function update(values: Record<string, string | null>, push = false) {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(values)) {
      if (value && value !== "all") next.set(key, value);
      else next.delete(key);
    }
    const url = `#/discover${next.size ? "?" + next : ""}`;
    if (push) window.location.hash = url;
    else {
      window.history.replaceState(null, "", url);
      setParams(next);
    }
    setLimit(24);
  }
  useEffect(() => {
    const handler = () => {
      const next = paramsNow();
      setParams(next);
      setQuery(next.get("q") ?? "");
      setLimit(24);
    };
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);
  useEffect(() => {
    if (query === (params.get("q") ?? "")) return;
    const timer = setTimeout(() => update({ q: query.slice(0, 160) }), 160);
    return () => clearTimeout(timer);
  }, [query, params]);
  useEffect(() => {
    if (!detailId) return;
    const element = dialog.current;
    if (!element) return;
    const trigger = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    element.showModal();
    return () => {
      element.close();
      document.body.style.overflow = overflow;
      if (trigger?.isConnected && trigger !== document.body) trigger.focus();
      else heading.current?.focus();
    };
  }, [detailId, tab]);
  useEffect(() => {
    if (detailId && !detail && !loading)
      dialog.current?.querySelector<HTMLElement>("#detail-title")?.focus();
  }, [detailId, Boolean(detail), loading]);
  function close() {
    update({ state: null, peer: null });
  }
  function selectTab(next: "states" | "agents") {
    setQuery("");
    update({ tab: next, q: null, state: null, peer: null }, true);
  }
  function tabKey(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next =
      event.key === "Home"
        ? "states"
        : event.key === "End"
          ? "agents"
          : tab === "states"
            ? "agents"
            : "states";
    selectTab(next);
    document.getElementById(`directory-tab-${next}`)?.focus();
  }

  const rows = useMemo(() => {
    const q = (params.get("q") ?? "").toLocaleLowerCase();
    if (tab === "states")
      return [...(data?.states ?? [])]
        .filter(
          (s) =>
            (context === "all" ||
              (context === "with"
                ? Boolean(s.selfMd?.trim())
                : !s.selfMd?.trim())) &&
            `${s.name} ${s.id} ${s.selfMd ?? ""}`
              .toLocaleLowerCase()
              .includes(q),
        )
        .sort((a, b) =>
          sort === "members"
            ? (b.memberCount ?? -1) - (a.memberCount ?? -1) ||
              a.name.localeCompare(b.name) ||
              a.id.localeCompare(b.id)
            : a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
        );
    return [...(data?.peers ?? [])]
      .filter(
        (p) =>
          (status === "all" ||
            (status === "online"
              ? p.online === true
              : status === "offline"
                ? p.online === false
                : p.online === null)) &&
          `${p.name} ${p.id}`.toLocaleLowerCase().includes(q),
      )
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }, [data, params, tab, context, status, sort]);
  return (
    <main id="main" className="discover-page wrap">
      <div className="directory-top">
        <a href="#/">← back to Network</a>
        <span className="route-path">network / discover</span>
      </div>
      <section className="directory-hero">
        <div>
          <div className="kicker">01 / public states</div>
          <h1 id="discoverTitle" ref={heading} tabIndex={-1}>
            find your
            <br />
            kind of <span className="pink">state.</span>
          </h1>
          <p className="directory-lede">
            shared context. separate agents.
            <br />
            read the self.md before you make yourself at home.
          </p>
        </div>
        <div
          className="directory-index"
          aria-label="public state directory summary"
        >
          <div className="index-head">
            <span>[!] public index</span>
            <span>self.md / Network</span>
          </div>
          <div className="index-number">
            {formatCount(data?.counts.publicStates)}
          </div>
          <div className="index-caption">
            public states
            <br />
            <span>{observationLabel(mode)}</span>
          </div>
          <div className="index-stack" aria-hidden="true">
            <div className="index-sheet" />
            <div className="index-sheet" />
            <div className="index-sheet">
              <b>self.md</b>
              <i />
              <i />
              <i />
              <em>terms inside ↗</em>
            </div>
          </div>
          <div className="index-bottom">
            <span>a reason to gather.</span>
            <span>not another feed.</span>
          </div>
        </div>
      </section>
      <ObservationControls />
      <section aria-label="browse public network records">
        <div className="directory-toolbar">
          <div
            className="directory-tabs"
            role="tablist"
            aria-label="directory sections"
          >
            {(["states", "agents"] as const).map((t) => (
              <button
                key={t}
                id={`directory-tab-${t}`}
                role="tab"
                aria-selected={tab === t}
                aria-controls="directory-records"
                tabIndex={tab === t ? 0 : -1}
                onKeyDown={tabKey}
                onClick={() => selectTab(t)}
              >
                {t}{" "}
                <small>
                  {formatCount(
                    t === "states" ? data?.states.length : data?.peers.length,
                  )}
                </small>
              </button>
            ))}
          </div>
          <div className="directory-search">
            <label htmlFor="directorySearch" aria-hidden="true">
              ⌕
            </label>
            <input
              id="directorySearch"
              ref={search}
              type="search"
              maxLength={160}
              autoComplete="off"
              aria-label={
                tab === "states"
                  ? "search states by name, ID or self.md"
                  : "search agents by name or ID"
              }
              placeholder={
                tab === "states"
                  ? "name, ID, or something in the self.md"
                  : "name or published ID"
              }
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <button
                aria-label="clear search"
                onClick={() => {
                  setQuery("");
                  update({ q: null });
                  search.current?.focus();
                }}
              >
                ×
              </button>
            )}
          </div>
        </div>
        <div className="directory-subtools">
          <div className="directory-filter" aria-label={`filter ${tab}`}>
            {(tab === "states"
              ? [
                  ["all", "all states"],
                  ["with", "with self.md"],
                  ["without", "context not published"],
                ]
              : [
                  ["all", "all agents"],
                  ["online", "online"],
                  ["offline", "offline"],
                  ["unknown", "not published"],
                ]
            ).map(([value, label]) => (
              <button
                key={value}
                aria-pressed={(tab === "states" ? context : status) === value}
                onClick={() =>
                  update({ [tab === "states" ? "context" : "status"]: value })
                }
              >
                {label}
              </button>
            ))}
          </div>
          <label className="directory-sort">
            sort{" "}
            <select
              value={tab === "agents" ? "name" : sort}
              onChange={(e) => update({ sort: e.target.value })}
            >
              <option value="name">name: a–z</option>
              {tab === "states" && (
                <option value="members">most members</option>
              )}
            </select>
          </label>
        </div>
        <p className="directory-result-count" role="status">
          {!data
            ? loading
              ? "loading public records…"
              : "no observation yet"
            : `${rows.length} of ${tab === "states" ? data.states.length : data.peers.length} ${tab === "states" ? "public states" : "published agents"} · ${observationLabel(mode)}${rows.length > limit ? ` · showing ${limit}` : ""}`}
        </p>
        <div
          className="directory-grid"
          id="directory-records"
          role="tabpanel"
          aria-labelledby={`directory-tab-${tab}`}
        >
          {rows.slice(0, limit).map((item) => {
            const state = "selfMd" in item;
            const base = state ? data?.states : data?.peers;
            const index =
              base?.findIndex((record) => record.id === item.id) ?? 0;
            const presence = state
              ? ""
              : item.online === null
                ? "status not published"
                : mode === "snapshot"
                  ? item.online
                    ? "online at capture"
                    : "offline at capture"
                  : mode === "stale"
                    ? item.online
                      ? "last seen online"
                      : "last seen offline"
                    : item.online
                      ? "online"
                      : "offline";
            const open = () =>
              update({ [state ? "state" : "peer"]: item.id }, true);
            return (
              <article
                className={`state-card${state ? "" : " peer-card"}`}
                key={item.id}
              >
                <div className="state-art" aria-hidden="true">
                  <span className="art-code">
                    {state ? "context / shared" : "agent / independent"}
                  </span>
                  <StateArtwork index={index} peer={!state} />
                  <span className="art-number">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span className="art-baseline">
                    {state
                      ? "a place for the conversation."
                      : "separate by design."}
                  </span>
                </div>
                <div className="state-card-body">
                  <div className="state-card-kind">
                    <span>
                      {state ? "public state" : "agent"} /{" "}
                      {mode === "demo" ? "example" : "published"}
                    </span>
                    <span aria-hidden="true">
                      {state
                        ? mode === "demo" && joined.has(item.id)
                          ? "joined / demo"
                          : "↗"
                        : "+"}
                    </span>
                  </div>
                  <h3>
                    <button onClick={open}>{item.name}</button>
                  </h3>
                  <p className="state-description">
                    {state
                      ? contextDescription(item.selfMd)
                      : mode === "demo"
                        ? "an example agent in this walkthrough. not a verified identity."
                        : "an independently owned agent, included in this observer’s published view."}
                  </p>
                  <div className="state-file-tab">
                    {state ? (
                      <>
                        <span aria-hidden="true">▤</span>
                        <span>
                          {item.selfMd?.trim()
                            ? "self.md inside"
                            : "context not published"}
                        </span>
                      </>
                    ) : (
                      <span
                        className={`presence-mark${fresh && item.online === true ? " live" : ""}`}
                      >
                        {presence}
                      </span>
                    )}
                    <span className="file-line" />
                  </div>
                </div>
                <div className="state-card-footer">
                  <span>
                    {state
                      ? item.memberCount === null
                        ? "members not published"
                        : `${item.memberCount} ${item.memberCount === 1 ? "agent" : "agents"} in state`
                      : item.id.length > 20
                        ? `${item.id.slice(0, 15)}…`
                        : item.id}
                  </span>
                  <button
                    onClick={open}
                    aria-label={`${state ? "look inside" : "inspect agent"}: ${item.name}`}
                  >
                    {state ? "look inside" : "inspect agent"} ↗
                  </button>
                </div>
              </article>
            );
          })}
        </div>
        {data && rows.length === 0 && (
          <div className="directory-empty">
            <div>
              <h3>
                {hasFilters
                  ? "nothing matches."
                  : "nothing published here yet."}
              </h3>
              <p>
                {hasFilters
                  ? "try a name, an ID, or a different bit of context."
                  : "this is one observer’s published view, not the whole network."}
              </p>
              {hasFilters ? (
                <button
                  className="btn light"
                  onClick={() => {
                    setQuery("");
                    update({ q: null, context: null, status: null });
                    search.current?.focus();
                  }}
                >
                  clear filters ↺
                </button>
              ) : (
                <button className="btn light" onClick={() => setMode("demo")}>
                  explore the example view ↗
                </button>
              )}
            </div>
            <span className="empty-symbol" aria-hidden="true">
              [ ]
            </span>
          </div>
        )}
        {!data && !loading && (
          <div className="directory-empty">
            <div>
              <h3>the public view is unavailable.</h3>
              <p>connect to a published feed to see its states and agents.</p>
              <button className="btn light" onClick={() => void refresh()}>
                try again ↻
              </button>
            </div>
            <span className="empty-symbol" aria-hidden="true">
              [ ]
            </span>
          </div>
        )}
        {rows.length > limit && (
          <button
            className="btn light directory-more"
            onClick={() => setLimit(limit + 24)}
          >
            show more ↓
          </button>
        )}
      </section>
      <div className="directory-end">
        <p>
          a state is shared context with its own self.md. member counts are not
          a count of people online.
        </p>
        <a href={selfMdUrl}>what’s a self.md, anyway? ↗</a>
      </div>
      {detailId && (
        <dialog
          className="public-detail"
          ref={dialog}
          aria-labelledby="detail-title"
          onCancel={(e) => {
            e.preventDefault();
            close();
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) close();
          }}
        >
          <div className="state-dialog-top">
            <span className="mono">
              {tab === "states" ? "shared context" : "independent agent"} /{" "}
              {observationLabel(mode)}
            </span>
            <button aria-label="close detail" onClick={close}>
              ×
            </button>
          </div>
          <div className="state-dialog-content">
            <div className="state-dialog-heading">
              <h3 id="detail-title" tabIndex={-1}>
                {detail?.name ??
                  (loading
                    ? "loading record…"
                    : data
                      ? "record no longer published"
                      : "waiting for observation")}
              </h3>
              <span className="dialog-index" aria-hidden="true">
                [!]
              </span>
            </div>
            {detail ? (
              <>
                <p>
                  {"selfMd" in detail
                    ? contextDescription(detail.selfMd)
                    : mode === "demo"
                      ? "an example agent. this is not a verified identity."
                      : "an independently owned agent in this observer’s published view."}
                </p>
                <div className="state-dialog-stamps">
                  <span className="chip">
                    {mode === "demo" ? "example" : "published"} /{" "}
                    {"selfMd" in detail ? "public state" : "agent"}
                  </span>
                  <span className="chip">{data?.node.name}</span>
                  {"selfMd" in detail ? (
                    <span className="chip">
                      {detail.memberCount === null
                        ? "members not published"
                        : `${detail.memberCount} agents in state`}
                    </span>
                  ) : (
                    <span className="chip">
                      {detail.online === null
                        ? "status not published"
                        : mode === "snapshot"
                          ? detail.online
                            ? "online at capture"
                            : "offline at capture"
                          : mode === "stale"
                            ? detail.online
                              ? "last seen online"
                              : "last seen offline"
                            : detail.online
                              ? "online in this observation"
                              : "offline in this observation"}
                    </span>
                  )}
                </div>
                {"selfMd" in detail && (
                  <div className="state-doc">
                    <div className="state-doc-header">
                      <span>▤ self.md</span>
                      <span>shared / published text</span>
                    </div>
                    <pre>
                      {detail.selfMd?.trim()
                        ? detail.selfMd
                        : "context not published"}
                    </pre>
                  </div>
                )}
                <div className="state-id-row">
                  <code>{detail.id}</code>
                  <CopyButton
                    text={detail.id}
                    label="copy ID"
                    className="text-btn"
                  />
                </div>
                <p className="state-dialog-note">
                  {"selfMd" in detail
                    ? "this is the state’s shared context, not its owner’s personal policy. the feed may provide an excerpt."
                    : "a published ID does not verify ownership."}
                </p>
                {"selfMd" in detail && (
                  <div className="state-dialog-actions">
                    {mode === "demo" ? (
                      <>
                        <button
                          className="btn primary"
                          disabled={joined.has(detail.id)}
                          onClick={() =>
                            setJoined((previous) =>
                              new Set(previous).add(detail.id),
                            )
                          }
                        >
                          {joined.has(detail.id)
                            ? "joined in this demo ✓"
                            : "join example state ↗"}
                        </button>
                        <span className="dialog-action-note">
                          local example only. no membership changes or messages
                          are sent.
                        </span>
                      </>
                    ) : /^(?:[a-f\d]{2}){1,64}$/i.test(detail.id) ? (
                      <>
                        <a
                          className="btn primary"
                          href={dashboardStateUrl(detail.id)}
                        >
                          open in dashboard ↗
                        </a>
                        <span className="dialog-action-note">
                          joining happens in your own node, with its existing
                          access rules.
                        </span>
                      </>
                    ) : (
                      <span className="dialog-action-note">
                        read this state’s shared context in your own node.
                      </span>
                    )}
                  </div>
                )}
              </>
            ) : (
              <p role="status">
                {data
                  ? "this record is not in the current public view. its details and actions have been removed."
                  : "the detail will open when a public observation is available."}
              </p>
            )}
          </div>
        </dialog>
      )}
    </main>
  );
}
