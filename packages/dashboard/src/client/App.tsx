import { useMemo, useState } from 'react';
import { usePolling } from './hooks/usePolling';
import { useRoute } from './hooks/useRoute';
import { StatusBar } from './components/StatusBar';
import { PeerList } from './components/PeerList';
import { StateList } from './components/StateList';
import { StatePage } from './components/StatePage';
import { ToastProvider, useToast } from './components/Toast';
import { TTYAPanel } from './components/TTYAPanel';
import type { ApiStatus, ApiPeer, ApiState, ApiDiscoveredState, ApiJoinResponse } from './types';

const SETUP_PROMPT = `git clone https://github.com/selfmd/network.self.md.git
cd network.self.md
pnpm install && pnpm build
npx networkselfmd init --name my-agent
npx networkselfmd states`;

function CopySetupButton() {
  const toast = useToast();
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(SETUP_PROMPT).then(() => {
      setCopied(true);
      toast(SETUP_PROMPT);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return <button className="btn btn-glow" onClick={handleCopy}>{copied ? 'copied' : 'copy setup'}</button>;
}

function Chrome({ children }: { children: React.ReactNode }) {
  const route = useRoute();
  const nav = [
    ['/', 'overview'],
    ['/discover', 'public states'],
    ['/wire', 'wire'],
    ['/security', 'keys'],
    ['/settings', 'settings'],
  ];

  return (
    <div className="app-shell">
      <div className="noise-layer" />
      <nav className="topnav animate-in">
        <a href="#/" className="brand" aria-label="network.self.md home">
          <span className="brand-mark">self</span><b>network</b><span>.md</span>
        </a>
        <div className="nav-links" aria-label="dashboard navigation">
          {nav.map(([href, label]) => (
            <a key={href} href={`#${href}`} className={route.page === routeFor(href) ? 'active' : ''}>{label}</a>
          ))}
        </div>
        <a className="github-link" href="/docs" target="_blank" rel="noopener noreferrer">docs ↗</a>
        <a className="github-link" href="https://github.com/selfmd/network.self.md" target="_blank" rel="noopener noreferrer">github ↗</a>
      </nav>
      {children}
    </div>
  );
}

function routeFor(href: string) {
  if (href === '/discover') return 'discover';
  if (href === '/wire') return 'wire';
  if (href === '/security') return 'security';
  if (href === '/settings') return 'settings';
  return 'home';
}

function HeroStats({ status }: { status: ApiStatus | null }) {
  const caps = status?.capabilities;
  return (
    <div className="status-grid">
      <div className="stat-card"><span>agents online</span><b>{status?.peersOnline ?? '—'}</b><em>{status?.peersTotal ?? 0} known</em></div>
      <div className="stat-card"><span>states</span><b>{status?.stateCount ?? '—'}</b><em>joined + discovered</em></div>
      <div className="stat-card"><span>sync</span><b>{status?.syncPct ?? 100}%</b><em>local node</em></div>
      <div className="stat-card"><span>capabilities</span><b>{caps?.discovery ? 'discovery' : 'local'}</b><em>{caps?.wireTrace ? 'wire trace live' : 'wire trace gated'}</em></div>
    </div>
  );
}

function HomePage() {
  const { data: status, error } = usePolling<ApiStatus>('/api/status');
  const { data: peers } = usePolling<ApiPeer[]>('/api/peers');
  const { data: states } = usePolling<ApiState[]>('/api/states');
  const { data: discovered } = usePolling<ApiDiscoveredState[]>('/api/discovery/states');

  const topStates = useMemo(() => (states ?? []).slice(0, 5), [states]);

  return (
    <main className="page dashboard-home">
      <section className="surface-card hero-card animate-in">
        <div className="card-chrome"><span /><span /><span /><code>/mesh/live</code></div>
        <div className="hero-grid">
          <div>
            <div className="eyebrow">encrypted p2p network state</div>
            <h1>agents dial agents.<br /><span>state moves on the wire.</span></h1>
            <p className="hero-desc">A local dashboard for sovereign shared context: states, public states, rooms and agents. Protocol, not platform.</p>
            <div className="hero-actions"><CopySetupButton /><a className="btn btn-secondary" href="#/discover">discover public states</a></div>
          </div>
          <div className="identity-card">
            <span className="dot online" />
            <code>{status?.agentFingerprint ?? 'no identity yet'}</code>
            <small>{status?.agentDisplayName ?? 'identity is a keypair, not an account'}</small>
          </div>
        </div>
        <HeroStats status={status} />
      </section>

      {error && <div className="error-banner animate-in">daemon unavailable · {error}</div>}
      <StatusBar status={status} />

      <div className="dashboard-grid animate-in delay-2">
        <section className="surface-card span-7">
          <div className="card-title"><span className="dot online" /> states <a href="#/discover">discover ↗</a></div>
          <StateList states={topStates} />
        </section>
        <section className="surface-card span-5">
          <div className="card-title"><span className="dot purple" /> agents</div>
          <PeerList peers={peers} />
        </section>
        <section className="surface-card span-5">
          <div className="card-title"><span className="dot cyan" /> public state radar</div>
          {(discovered?.length ?? 0) === 0 ? (
            <div className="empty">No public states discovered yet. Keep the node online; gossip needs peers.</div>
          ) : (
            <div className="list-stack compact">
              {discovered!.slice(0, 4).map((s) => (
                <a className="row link-row" href={`#/state/${encodeURIComponent(s.id)}`} key={s.id}>
                  <span className="row-name">{s.name}</span><span className="row-meta">{s.memberCount} agents</span>
                </a>
              ))}
            </div>
          )}
        </section>
        <section className="surface-card span-7">
          <div className="card-title"><span className="dot warn" /> ttya visitors</div>
          <TTYAPanel />
        </section>
      </div>
    </main>
  );
}

function DiscoveryPage() {
  const { data: status } = usePolling<ApiStatus>('/api/status');
  const { data: discovered, error } = usePolling<ApiDiscoveredState[]>('/api/discovery/states', 7000);
  const toast = useToast();
  const [joining, setJoining] = useState<string | null>(null);

  async function joinState(id: string) {
    setJoining(id);
    try {
      const res = await fetch(`/api/discovery/states/${encodeURIComponent(id)}/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const body = (await res.json()) as ApiJoinResponse;
      if (!body.ok) throw new Error(body.message);
      toast(`joined state: ${body.state.name}`);
      window.location.hash = `/state/${encodeURIComponent(body.state.id)}`;
    } catch (err: any) {
      toast(`join failed: ${err.message ?? err}`);
    } finally {
      setJoining(null);
    }
  }

  return (
    <main className="page animate-in">
      <section className="surface-card hero-card compact-hero">
        <div className="card-chrome"><span /><span /><span /><code>/discover/public-states</code></div>
        <div className="eyebrow">public state discovery</div>
        <h1>read the manifesto before you join.</h1>
        <p className="hero-desc">Public states are discoverable encrypted contexts with a self.md contract. Join only what you actually want your agents to inhabit.</p>
      </section>
      {error && <div className="error-banner">discovery unavailable · {error}</div>}
      {status?.capabilities?.discovery === false && <div className="error-banner">this node reports discovery disabled</div>}
      <section className="dashboard-grid">
        {(discovered ?? []).map((s) => (
          <article className="surface-card public-state-card span-6" key={s.id}>
            <div className="card-title"><span className="dot cyan" /> {s.name}<span className="badge green">public state</span></div>
            <pre className="manifesto small">{s.selfMd ?? 'No self.md manifesto announced yet.'}</pre>
            <div className="card-footer"><span>{s.memberCount} agents</span><button className="btn" disabled={joining === s.id} onClick={() => joinState(s.id)}>{joining === s.id ? 'joining…' : 'join state'}</button></div>
          </article>
        ))}
        {discovered && discovered.length === 0 && <div className="surface-card span-12 empty rich">No public states found yet. That is a real network state, not a fake empty-table tragedy.</div>}
      </section>
    </main>
  );
}

function WirePage() {
  const { data: status } = usePolling<ApiStatus>('/api/status');
  const enabled = status?.capabilities?.wireTrace;
  return (
    <main className="page animate-in">
      <section className="surface-card hero-card compact-hero">
        <div className="card-chrome"><span /><span /><span /><code>/wire/events</code></div>
        <div className="eyebrow">wire inspector</div>
        <h1>{enabled ? 'wire trace online.' : 'trace unavailable.'}</h1>
        <p className="hero-desc">This surface only renders structured wire events. Until the daemon exposes them, the UI refuses to hallucinate traffic.</p>
      </section>
      <section className="surface-card"><div className="empty rich">Backend capability <code>wireTrace</code> is {enabled ? 'enabled' : 'disabled'}.</div></section>
    </main>
  );
}

function SecurityPage() {
  const { data: status } = usePolling<ApiStatus>('/api/status');
  const caps = status?.capabilities;
  return (
    <main className="page animate-in">
      <section className="surface-card hero-card compact-hero">
        <div className="card-chrome"><span /><span /><span /><code>/security/keys</code></div>
        <div className="eyebrow">keys</div>
        <h1>identity is a keypair.</h1>
        <p className="hero-desc">Key rotation, revoke and export controls stay disabled until the daemon exposes the underlying operations.</p>
      </section>
      <section className="dashboard-grid">
        <div className="surface-card span-4"><div className="card-title">key rotation</div><button className="btn" disabled={!caps?.keyRotation}>rotate</button></div>
        <div className="surface-card span-4"><div className="card-title">device revoke</div><button className="btn" disabled={!caps?.keyRevoke}>revoke</button></div>
        <div className="surface-card span-4"><div className="card-title">identity export</div><button className="btn" disabled={!caps?.keyExport}>export</button></div>
      </section>
    </main>
  );
}

function SettingsPage() {
  return (
    <main className="page animate-in">
      <section className="surface-card hero-card compact-hero">
        <div className="card-chrome"><span /><span /><span /><code>/settings/local</code></div>
        <div className="eyebrow">local node settings</div>
        <h1>loopback first. no surprise platform.</h1>
        <p className="hero-desc">The dashboard is intended for a local daemon bound to 127.0.0.1. Exposing it publicly requires VPN, Access, or a real reverse-proxy auth decision.</p>
      </section>
    </main>
  );
}

function Router() {
  const route = useRoute();
  return (
    <Chrome>
      {route.page === 'home' && <HomePage />}
      {route.page === 'state' && <StatePage stateId={route.stateId} />}
      {route.page === 'discover' && <DiscoveryPage />}
      {route.page === 'wire' && <WirePage />}
      {route.page === 'security' && <SecurityPage />}
      {route.page === 'settings' && <SettingsPage />}
    </Chrome>
  );
}

export function App() {
  return <ToastProvider><Router /></ToastProvider>;
}
