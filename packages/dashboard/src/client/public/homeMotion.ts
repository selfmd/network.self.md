import { useEffect, useRef, type RefObject } from "react";

export type ScopePhase = "review" | "approved" | "done" | "declined";
type MotionOptions = {
  paused: boolean;
  reduced: boolean;
  chapter: number;
  filmPaused: boolean;
  replay: number;
  scope: ScopePhase;
  onScopeDone: () => void;
};
const clamp = (n: number) => Math.max(0, Math.min(1, n));
const ease = (n: number) => {
  const t = clamp(n);
  return 6 * t ** 5 - 15 * t ** 4 + 10 * t ** 3;
};
const smooth = (n: number) => {
  const t = clamp(n);
  return t * t * (3 - 2 * t);
};

/** One page clock; SVG positions are transient DOM values, never per-frame React state. */
export function useHomeMotion(
  root: RefObject<HTMLElement>,
  options: MotionOptions,
) {
  const current = useRef(options);
  current.current = options;
  const times = useRef({ hero: 0, film: 0, scope: 0, policy: 0, mesh: 0 });
  const redraw = useRef<() => void>(() => {});
  useEffect(() => {
    times.current.film = options.reduced ? 12 : 0;
    redraw.current();
  }, [options.chapter, options.replay, options.reduced]);
  useEffect(() => {
    times.current.scope = options.scope === "done" ? 7 : 0;
    redraw.current();
  }, [options.scope]);
  useEffect(() => {
    const host = root.current;
    if (!host) return;
    const find = (id: string) => host.querySelector(`#${id}`);
    const attr = (id: string, key: string, value: string | number) =>
      find(id)?.setAttribute(key, String(value));
    const txt = (id: string, value: string) => {
      const node = find(id);
      if (node && node.textContent !== value) node.textContent = value;
    };
    function drawHero() {
      const t = times.current.hero % 18;
      const travel = t < 8 ? ease((t - 2) / 5) : 1 - ease((t - 11) / 5);
      const x = 152 + travel * 210,
        y = 116 + travel * 42 - Math.sin(travel * Math.PI) * 30;
      attr(
        "heroMessage",
        "transform",
        `translate(${x} ${y}) rotate(${-10 + travel * 20} 40 25)`,
      );
      attr(
        "heroMessage",
        "opacity",
        current.current.reduced
          ? 1
          : t < 0.9
            ? smooth(t / 0.9)
            : t > 17
              ? smooth(18 - t)
              : 1,
      );
      txt("heroMessageText", t < 10 ? "hello.md" : "hello-back.md");
      txt(
        "heroExchange",
        t < 2
          ? "01 / say hello"
          : t < 8
            ? "02 / a direct line"
            : t < 11
              ? "03 / a conversation"
              : t < 17
                ? "04 / back to you"
                : "01 / say hello",
      );
      const drift = current.current.reduced
        ? 0
        : Math.sin((times.current.hero * Math.PI) / 18) * 2.5;
      attr("heroLeft", "transform", `translate(0 ${drift})`);
      attr("heroRight", "transform", `translate(0 ${-drift})`);
    }
    function drawFilm() {
      const t = times.current.film % 18;
      const progress = find("filmProgress") as HTMLElement | null;
      if (progress) progress.style.transform = `scaleX(${t / 18})`;
      attr("chapterProgress", "aria-valuenow", Math.round((t / 18) * 100));
      if (current.current.chapter === 0) {
        const outbound = ease((t - 2) / 4.8),
          inbound = ease((t - 11) / 4.8);
        attr(
          "p2pPacket",
          "transform",
          `translate(${t < 10 ? 365 + outbound * 269 : 634 - inbound * 269} 167)`,
        );
        attr(
          "mobileP2pPacket",
          "transform",
          `translate(164 ${t < 10 ? 115 + outbound * 70 : 185 - inbound * 70})`,
        );
        for (const id of ["p2pPacket", "mobileP2pPacket"])
          attr(id, "opacity", t < 2 || t > 16.2 ? 0 : 1);
        for (const id of ["p2pReply", "mobileP2pReply"])
          attr(id, "opacity", smooth((t - 7) / 1.1) * (1 - ease((t - 16) / 2)));
        txt(
          "p2pLeftStatus",
          t < 2
            ? "composing"
            : t < 7
              ? "message travelling"
              : t < 15.5
                ? "message delivered"
                : "reply received",
        );
        txt(
          "p2pRightStatus",
          t < 7
            ? "waiting"
            : t < 10
              ? "received"
              : t < 15.5
                ? "reply travelling"
                : "conversation started",
        );
        txt(
          "filmPhase",
          t < 2
            ? "01 / compose"
            : t < 7
              ? "02 / send"
              : t < 11
                ? "03 / receive"
                : "04 / reply",
        );
      } else if (current.current.chapter === 1) {
        const settle = 1 - ease((t - 15.5) / 2.5),
          lift = smooth((t - 3) / 3) * settle;
        attr("sharedDoc", "transform", `translate(0 ${-146 * lift})`);
        attr("mobileSharedDoc", "transform", `translate(0 ${-142 * lift})`);
        attr("stateMember", "opacity", smooth(t - 9) * settle);
        txt("stateMemberText", t < 12 ? "+1" : "02");
        attr(
          "stateRight",
          "opacity",
          0.45 + 0.55 * smooth((t - 8) / 2) * settle,
        );
        txt(
          "filmPhase",
          t < 3
            ? "01 / create state"
            : t < 8
              ? "02 / read self.md"
              : t < 12
                ? "03 / invite peer"
                : "04 / shared context",
        );
      } else {
        const approved = smooth((t - 8) / 2) * (1 - ease((t - 15.5) / 2.5));
        attr("humanGate", "transform", `translate(0 ${-72 * approved})`);
        attr("humanGate", "opacity", 1 - approved * 0.85);
        attr("humanApprove", "opacity", 1 - approved * 0.6);
        attr("mobileHumanGate", "opacity", 1 - approved * 0.9);
        txt("humanGateText", t < 8 ? "admin invites" : "invitation accepted");
        txt("mobileHumanText", t < 8 ? "admin invites" : "joined");
        txt(
          "visitorStatus",
          t < 8 ? "waiting for an invitation" : "joined the state",
        );
        txt(
          "filmPhase",
          t < 3
            ? "01 / connected peer"
            : t < 8
              ? "02 / admin invites"
              : t < 11
                ? "03 / peer accepts"
                : "04 / shared state",
        );
      }
    }
    function drawScope() {
      const running = ["approved", "done"].includes(current.current.scope),
        t = times.current.scope;
      const open = running ? smooth((t - 0.5) / 2) : 0;
      attr("scopeGate", "transform", `translate(0 ${-20 * open})`);
      attr("scopeGate", "opacity", 1 - 0.65 * open);
      attr("scopePacket", "opacity", running && t > 1.5 && t < 6 ? 1 : 0);
      attr(
        "scopePacket",
        "transform",
        `translate(${163 + ease((t - 1.5) / 4.5) * 288} 97)`,
      );
      attr(
        "scopeOutput",
        "opacity",
        running ? 0.3 + 0.7 * smooth((t - 5) / 1.5) : 0.3,
      );
      if (current.current.scope === "approved" && t >= 6.5)
        current.current.onScopeDone();
    }
    function drawPolicy() {
      const t = times.current.policy % 26;
      const y =
        t < 4.5
          ? 0
          : t < 6.5
            ? 57 * ease((t - 4.5) / 2)
            : t < 11
              ? 57
              : t < 13
                ? 57 + 57 * ease((t - 11) / 2)
                : t < 17.5
                  ? 114
                  : t < 19.5
                    ? 114 + 57 * ease((t - 17.5) / 2)
                    : t < 24
                      ? 171
                      : 171 * (1 - ease((t - 24) / 2));
      attr("policyHighlight", "transform", `translate(0 ${y})`);
      attr(
        "policyHighlightMobile",
        "transform",
        `translate(0 ${(y * 48) / 57})`,
      );
      for (const id of ["policySeal", "policySealMobile"])
        attr(
          id,
          "transform",
          `translate(0 ${Math.sin((times.current.policy * Math.PI) / 18) * 1.5})`,
        );
    }
    function drawMesh() {
      host
        ?.querySelectorAll<SVGGElement>("[data-mesh-index]")
        .forEach((node) => {
          const index = Number(node.dataset.meshIndex);
          const t = times.current.mesh;
          node.setAttribute(
            "transform",
            `translate(${Math.sin((t / 37) * Math.PI * 2 + index) * 3} ${Math.sin((t / 48) * Math.PI * 2 + index * 1.3) * 3})`,
          );
        });
    }
    redraw.current = () => {
      drawHero();
      drawFilm();
      drawScope();
      drawPolicy();
      drawMesh();
    };
    if (current.current.reduced) {
      times.current.hero = 8;
      times.current.film = 12;
    }
    redraw.current();
    type Scene = keyof typeof times.current;
    const visible: Record<Scene, boolean> = {
      hero: false,
      film: false,
      scope: false,
      policy: false,
      mesh: false,
    };
    const draw: Record<Scene, () => void> = {
      hero: drawHero,
      film: drawFilm,
      scope: drawScope,
      policy: drawPolicy,
      mesh: drawMesh,
    };
    let frame: number | null = null,
      previous: number | null = null;
    const start = () => {
      if (
        frame !== null ||
        document.hidden ||
        current.current.paused ||
        current.current.reduced ||
        !Object.values(visible).some(Boolean)
      )
        return;
      frame = requestAnimationFrame(tick);
    };
    function tick(now: number) {
      frame = null;
      const dt =
        previous === null ? 0 : Math.min((now - previous) / 1000, 0.05);
      previous = now;
      if (
        !document.hidden &&
        !current.current.paused &&
        !current.current.reduced
      ) {
        for (const name of Object.keys(visible) as Scene[]) {
          if (
            !visible[name] ||
            (name === "film" && current.current.filmPaused) ||
            (name === "scope" && current.current.scope !== "approved")
          )
            continue;
          times.current[name] += dt;
          draw[name]();
        }
      }
      start();
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries)
          visible[(entry.target as HTMLElement).dataset.scene as Scene] =
            entry.isIntersecting;
        previous = null;
        start();
      },
      { rootMargin: "50px" },
    );
    for (const [selector, name] of [
      [".hero-art", "hero"],
      ["#productFilm", "film"],
      [".permission-machine", "scope"],
      [".policy-visual", "policy"],
      [".mesh-wrap", "mesh"],
    ]) {
      const node = host.querySelector<HTMLElement>(selector);
      if (node) {
        node.dataset.scene = name;
        observer.observe(node);
      }
    }
    const visibility = () => {
      previous = null;
      if (document.hidden && frame !== null) {
        cancelAnimationFrame(frame);
        frame = null;
      } else start();
    };
    document.addEventListener("visibilitychange", visibility);
    start();
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", visibility);
      if (frame !== null) cancelAnimationFrame(frame);
      redraw.current = () => {};
    };
  }, [root, options.paused, options.reduced]);
}
