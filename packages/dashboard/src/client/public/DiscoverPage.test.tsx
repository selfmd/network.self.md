/** @vitest-environment jsdom */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiscoverPage } from "./DiscoverPage";
import { DEMO_OBSERVATION, useObservation } from "./observation";

beforeEach(() => {
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
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.location.hash = "";
});

describe("published directory details", () => {
  it("removes withdrawn context and actions while keeping an accessible missing-record dialog", () => {
    window.location.hash = "#/discover?state=demo-builders";
    render(<DiscoverPage />);
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByText(/leave the next person a useful trail/, {
        selector: "pre",
      }),
    ).toBeTruthy();
    act(() =>
      useObservation.setState({ data: { ...DEMO_OBSERVATION, states: [] } }),
    );
    expect(
      within(dialog).queryByText(/leave the next person a useful trail/),
    ).toBeNull();
    expect(
      within(dialog).queryByRole("button", { name: "copy ID" }),
    ).toBeNull();
    expect(
      within(dialog).queryByRole("button", { name: /join example/ }),
    ).toBeNull();
    expect(document.activeElement).toBe(
      within(dialog).getByRole("heading", {
        name: "record no longer published",
      }),
    );
  });

  it("labels snapshot presence as captured, without fresh telemetry", () => {
    window.location.hash = "#/discover?tab=agents";
    useObservation.setState({ mode: "snapshot" });
    const { container } = render(<DiscoverPage />);
    expect(screen.getAllByText("online at capture").length).toBe(4);
    expect(container.querySelector(".presence-mark.live")).toBeNull();
  });

  it("joins the example locally without making requests or changing observation membership", () => {
    window.location.hash = "#/discover?state=demo-builders";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    render(<DiscoverPage />);
    fireEvent.click(
      screen.getByRole("button", { name: "join example state ↗" }),
    );
    expect(
      screen.getByRole("button", { name: "joined in this demo ✓" }),
    ).toHaveProperty("disabled", true);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(useObservation.getState().data?.states[0].memberCount).toBe(3);
  });
});

describe("directory query and keyboard controls", () => {
  it("falls back to all states for malformed context and sort parameters", () => {
    window.location.hash = "#/discover?context=garbage&sort=garbage";
    render(<DiscoverPage />);
    expect(
      screen
        .getByRole("button", { name: "all states" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.getByRole("combobox")).toHaveProperty("value", "name");
    expect(screen.getAllByRole("article")).toHaveLength(3);
  });

  it("switches tabs using arrow keys and keeps roving keyboard focus", async () => {
    window.location.hash = "#/discover";
    render(<DiscoverPage />);
    const states = screen.getByRole("tab", { name: /states/ });
    states.focus();
    fireEvent.keyDown(states, { key: "ArrowRight" });
    await act(async () =>
      window.dispatchEvent(new HashChangeEvent("hashchange")),
    );
    const agents = screen.getByRole("tab", { name: /agents/ });
    expect(agents.getAttribute("aria-selected")).toBe("true");
    expect(agents.tabIndex).toBe(0);
    expect(states.tabIndex).toBe(-1);
    expect(document.activeElement).toBe(agents);
  });
});
