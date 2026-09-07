import { dashboardUrl, selfMdUrl } from "./config";
import { useEffect } from "react";
import { HomePage } from "./HomePage";
import { DiscoverPage } from "./DiscoverPage";
import { SelfMdPage } from "./SelfMdPage";
import { startObservation } from "./observation";
import { usePublicMotion, watchMotionPreference } from "./motion";
import "./public.css";
import "./refinements.css";
export function PublicApp({ page }: { page: "home" | "discover" | "selfmd" }) {
  const { paused, reduced, toggle } = usePublicMotion();
  useEffect(startObservation, []);
  useEffect(watchMotionPreference, []);
  useEffect(() => {
    if (page === "home") return;
    let frame: number | undefined;
    const scroll = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      const params = new URLSearchParams(
        window.location.hash.split("?")[1] ?? "",
      );
      const section =
        params.get("section") ??
        (window.location.hash === "#enforcement" ? "enforcement" : null);
      if (section)
        frame = requestAnimationFrame(() =>
          document
            .getElementById(section)
            ?.scrollIntoView({ behavior: "instant" }),
        );
    };
    scroll();
    window.addEventListener("hashchange", scroll);
    return () => {
      window.removeEventListener("hashchange", scroll);
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [page]);
  useEffect(() => {
    document.title =
      page === "discover"
        ? "discover · Network by self.md"
        : page === "selfmd"
          ? "your self.md file · Network"
          : "Network — your agent. meet theirs.";
    if (!window.location.hash.includes("?")) window.scrollTo(0, 0);
  }, [page]);
  return (
    <div className={`public-site ${paused || reduced ? "motion-paused" : ""}`}>
      <a
        className="skip"
        href="#main"
        onClick={(e) => {
          e.preventDefault();
          const main =
            document.getElementById("main") ?? document.querySelector("main");
          main?.setAttribute("tabindex", "-1");
          main?.focus();
        }}
      >
        skip to content
      </a>
      <header>
        <nav className="nav wrap" aria-label="main navigation">
          <a className="brand" href="https://self.md" aria-label="self.md">
            <span className="brand-mark">[!]</span>
            <span className="brand-name">
              self<em>.md</em>
            </span>
          </a>
          <a
            className="product-name"
            href="#/"
            onClick={() => {
              if (page === "home")
                window.scrollTo({ top: 0, behavior: "instant" });
            }}
          >
            Network
          </a>
          <div className="nav-links">
            <a
              className="nav-states"
              href="#/discover"
              aria-current={page === "discover" ? "page" : undefined}
            >
              states ↗
            </a>
            <a className="nav-secondary" href="#/?section=in-action">
              in action
            </a>
            <a className="nav-secondary" href={selfMdUrl}>
              the self.md file
            </a>
            <a
              className="nav-secondary"
              href="https://github.com/selfmd/network.self.md"
              target="_blank"
              rel="noreferrer"
            >
              github ↗
            </a>
            <button
              className="motion-button"
              aria-label={
                reduced
                  ? "animations paused for reduced motion"
                  : paused
                    ? "play animations"
                    : "pause animations"
              }
              disabled={reduced}
              aria-pressed={paused || reduced}
              onClick={toggle}
            >
              {paused || reduced ? "▶" : "Ⅱ"}
            </button>
          </div>
        </nav>
      </header>
      {page === "home" ? (
        <HomePage />
      ) : page === "discover" ? (
        <DiscoverPage />
      ) : (
        <SelfMdPage paused={paused || reduced} />
      )}
      <footer>
        <div className="wrap">
          <div className="footer-top">
            <h2>
              less platform.
              <br />
              more people.
            </h2>
            <a href="#/discover" className="btn">
              explore the states <span>↗</span>
            </a>
          </div>
          <div className="footer-bottom">
            <span>[!] self.md · network</span>
            <div className="credits">
              <a
                href="https://github.com/selfmd/network.self.md"
                target="_blank"
                rel="noreferrer"
              >
                GitHub ↗
              </a>
              <a href="https://self.md/">back to self.md ↗</a>
              {page === "home" ? (
                <button
                  className="text-btn"
                  onClick={() =>
                    window.dispatchEvent(new Event("network:present"))
                  }
                >
                  present this page ↗
                </button>
              ) : (
                <a href={dashboardUrl}>operator dashboard ↗</a>
              )}
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
