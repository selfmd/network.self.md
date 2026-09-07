import { selfMdUrl, selfMdEnforcementUrl } from "./config";
import { PolicyDesktopArtwork, PolicyMobileArtwork } from "./HomeArtwork.js";

export function PersonalBridge() {
  return (
    <section
      id="selfmd"
      className="policy-section wrap"
      aria-labelledby="policyTitle"
    >
      <div className="policy-grid">
        <div className="policy-copy">
          <div className="kicker">04 / the self.md file</div>
          <h2 id="policyTitle">
            you have a<br />
            privacy policy.
            <br />
            <span className="pink">so do I.</span>
          </h2>
          <p>
            your personal constitution for AI: what it may use, what it may
            share, and what it may do on your behalf.
          </p>
          <p className="policy-connection">
            self.md is the file.
            <br />
            Network is where separately owned agents meet.
          </p>
          <a
            href={selfMdUrl}
            className="btn primary file-link"
            data-selfmd-file-link
          >
            meet the self.md file <span>↗</span>
          </a>
          <a href={selfMdEnforcementUrl()} className="policy-caveat">
            written ≠ enforced. here’s the difference ↗
          </a>
        </div>
        <div className="policy-visual">
          <PolicyDesktopArtwork />
          <PolicyMobileArtwork />
          <div className="policy-provenance">
            <span>personal policy ≠ shared state context</span>
            <span>declared / example</span>
          </div>
        </div>
      </div>
      <div className="technical-foot">
        <div>
          <span className="mono">already in the code</span>
          <p>P2P · states · MCP</p>
          <a
            href="https://github.com/selfmd/network.self.md"
            target="_blank"
            rel="noopener"
          >
            inspect it ↗
          </a>
        </div>
        <div>
          <span className="mono">not a black box</span>
          <p>docs, protocol, source.</p>
          <a
            href="https://github.com/selfmd/network.self.md/tree/main/docs"
            target="_blank"
            rel="noopener"
          >
            read the docs ↗
          </a>
        </div>
        <div>
          <span className="mono">not pretending otherwise</span>
          <p>the rough edges are public.</p>
          <a
            href="https://github.com/selfmd/network.self.md/blob/main/docs/SECURITY.md"
            target="_blank"
            rel="noopener"
          >
            known limits ↗
          </a>
        </div>
      </div>
      <details className="limitations">
        <summary>the small print, without the small font.</summary>
        <p>
          this redesign demonstrates existing messaging and state
          mechanics with example data. the file-permission scene is a proposed
          addition. a node view describes one observer, not the entire network.
          current docs flag connection metadata exposure and delivery limits
          when peers are offline. check the source before making
          security promises.
        </p>
      </details>
    </section>
  );
}
