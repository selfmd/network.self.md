/** @vitest-environment jsdom */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HomePage } from "./HomePage.js";
import { DEMO_OBSERVATION, useObservation } from "./observation.js";
import { usePublicMotion } from "./motion.js";

beforeEach(() => {
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("fetch", vi.fn());
  Element.prototype.scrollIntoView = vi.fn();
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  useObservation.setState({
    data: DEMO_OBSERVATION,
    mode: "demo",
    loading: false,
    error: null,
  });
  usePublicMotion.setState({ paused: true, reduced: false });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("home illustration boundary", () => {
  it("requires a chosen context and finishes explicit approval while paused without a network request", () => {
    render(<HomePage />);
    const summary = screen.getByRole("button", {
      name: /architecture-summary.md/,
    });
    fireEvent.click(summary);
    expect(
      (
        screen.getByRole("button", {
          name: "approve once ↗",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /public-readme.md/ }));
    fireEvent.click(screen.getByRole("button", { name: "approve once ↗" }));
    expect(screen.getByRole("status").textContent).toBe(
      "example review.md returned. no real file was read or shared.",
    );
    expect((summary as HTMLButtonElement).disabled).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    expect(useObservation.getState().data).toBe(DEMO_OBSERVATION);
    fireEvent.click(screen.getByRole("button", { name: "reset ↺" }));
    fireEvent.click(screen.getByRole("button", { name: "decline" }));
    expect(screen.getByRole("status").textContent).toContain(
      "declined. no work, no file",
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it("uses keyboard tabs and advances the presenter only after a user action", () => {
    render(<HomePage />);
    const tabs = screen.getByRole("tablist", { name: "product walkthrough" });
    const direct = within(tabs).getByRole("tab", { name: /go direct/ });
    direct.focus();
    fireEvent.keyDown(direct, { key: "ArrowRight" });
    expect(
      within(tabs)
        .getByRole("tab", { name: /make a state/ })
        .getAttribute("aria-selected"),
    ).toBe("true");
    const start = screen.getByRole("button", { name: "show me ↗" });
    fireEvent.click(start);
    expect(
      screen.getByRole("region", { name: "guided walkthrough" }).textContent,
    ).toContain("meet the agents");
    fireEvent.click(screen.getByRole("button", { name: "next step" }));
    expect(
      screen.getByRole("region", { name: "guided walkthrough" }).textContent,
    ).toContain("look inside the network");
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(
      screen.queryByRole("region", { name: "guided walkthrough" }),
    ).toBeNull();
    expect(document.activeElement).toBe(start);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("distinguishes unavailable observation from a successfully empty public view", () => {
    useObservation.setState({
      data: null,
      mode: "error",
      error: "Public feed unavailable.",
    });
    const { rerender } = render(<HomePage />);
    const metrics = screen.getByLabelText(
      "network counts from the selected data source",
    );
    expect(within(metrics).getAllByText("—")).toHaveLength(2);
    useObservation.setState({
      data: {
        ...DEMO_OBSERVATION,
        states: [],
        peers: [],
        counts: { publicStates: 0, onlineAgents: 0, unknown: 0 },
      },
      mode: "node",
      error: null,
    });
    rerender(<HomePage />);
    expect(within(metrics).getAllByText("00")).toHaveLength(2);
  });
});
