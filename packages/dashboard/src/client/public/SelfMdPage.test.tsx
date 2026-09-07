/** @vitest-environment jsdom */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXAMPLE_POLICY, SelfMdPage } from "./SelfMdPage";

beforeEach(() => {
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function openDraft() {
  const trigger = screen.getAllByRole("button", {
    name: /create my self.md/,
  })[0];
  fireEvent.click(trigger);
  return {
    trigger,
    editor: screen.getByRole("textbox", {
      name: "self.md / editable Markdown",
    }) as HTMLTextAreaElement,
  };
}

describe("local policy draft", () => {
  it("retains a draft through closing and restores trigger focus without changing permissions", () => {
    render(<SelfMdPage />);
    const { trigger, editor } = openDraft();
    expect(editor.value).toBe(EXAMPLE_POLICY);
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.change(editor, { target: { value: "# My policy\nAsk first." } });
    fireEvent.click(screen.getByRole("button", { name: "close draft editor" }));
    expect(document.activeElement).toBe(trigger);
    expect(document.body.style.overflow).not.toBe("hidden");
    openDraft();
    expect(editor.value).toBe("# My policy\nAsk first.");
    expect(screen.getByRole("status").textContent).toContain(
      "no agent connected",
    );
  });

  it("offers manual selection when clipboard access fails", async () => {
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    render(<SelfMdPage />);
    const { editor } = openDraft();
    fireEvent.click(screen.getByRole("button", { name: "copy text" }));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("Ctrl+C"),
    );
    expect(editor.selectionStart).toBe(0);
    expect(editor.selectionEnd).toBe(EXAMPLE_POLICY.length);
  });

  it("downloads the edited Markdown and rejects an empty draft", () => {
    const createObjectURL = vi.fn().mockReturnValue("blob:local-policy");
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL: vi.fn() });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    render(<SelfMdPage />);
    const { editor } = openDraft();
    fireEvent.change(editor, { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "save self.md ↓" }));
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toContain(
      "at least one term",
    );
    fireEvent.change(editor, { target: { value: "# Policy\nAsk first." } });
    fireEvent.click(screen.getByRole("button", { name: "save self.md ↓" }));
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(click).toHaveBeenCalledOnce();
    expect(screen.getByRole("status").textContent).toContain(
      "permissions have not changed",
    );
  });
});
