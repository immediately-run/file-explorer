// The summarize modal's dialog contract (R-IX-1): focus moves in on open, Tab
// is contained, Escape closes, and focus returns to the invoker. The SDK chat
// stream and the sandbox fs are the suite's usual hoisted fakes.
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  readFile: vi.fn(() => Promise.resolve(new TextEncoder().encode("the file body"))),
  uploadFile: vi.fn((): Promise<void> => Promise.resolve()),
  chat: vi.fn(() =>
    (async function* () {
      yield { type: "text-delta", text: "A summary." };
    })(),
  ),
}));

vi.mock("@immediately-run/sdk", () => ({
  chat: (opts: unknown) => h.chat(opts),
  uploadFile: (path: string, bytes: Uint8Array) => h.uploadFile(path, bytes),
}));

vi.mock("./mountFs", () => ({
  readFile: (path: string) => h.readFile(path),
}));

import SummaryModal from "./SummaryModal";

const target = {
  absPath: "/mnt/abc/src/index.ts",
  rootPath: "/mnt/abc",
  name: "index.ts",
  writable: true,
};

beforeEach(() => {
  h.readFile.mockClear();
  h.uploadFile.mockClear();
  h.chat.mockClear();
});

afterEach(() => {
  document.body.innerHTML = "";
});

async function renderOpen(userOnClose = () => {}) {
  const trigger = document.createElement("button");
  trigger.textContent = "Summarize…";
  document.body.appendChild(trigger);
  trigger.focus();
  // Close must actually unmount the modal (as the app does), or the hook's
  // focus-return cleanup never runs.
  let unmount: () => void = () => {};
  const onClose = () => {
    unmount();
    userOnClose();
  };
  const utils = render(<SummaryModal target={target} onClose={onClose} />);
  unmount = utils.unmount;
  // The stream runs once on mount; give it real ticks to reach `done` (the
  // Save button renders then). vi.waitFor misbehaves inside this suite's act
  // environment; a bounded settle sleep is the sibling suites' pattern.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
  return { trigger };
}

describe("SummaryModal dialog contract", () => {
  it("focus moves IN on open and the stream phases render", async () => {
    await renderOpen();
    const dialog = screen.getByRole("dialog", { name: "Summary of index.ts" });
    // Focus is inside the dialog (its first control or the panel itself).
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("Tab is contained within the modal", async () => {
    const user = userEvent.setup();
    await renderOpen();
    const dialog = screen.getByRole("dialog") as HTMLElement;
    const focusables = () =>
      [...dialog.querySelectorAll<HTMLElement>("button:not([disabled])")];
    const last = focusables().at(-1)!;
    last.focus();
    await user.keyboard("{Tab}"); // forward from the last control wraps to the first
    expect(document.activeElement).toBe(focusables()[0]);
  });

  it("Escape closes and focus RETURNS to the invoker", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { trigger } = await renderOpen(onClose);
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveFocus();
  });

  it("Save names its busy state while the write is in flight, then reports saved", async () => {
    const user = userEvent.setup();
    let resolveUpload!: () => void;
    h.uploadFile.mockReturnValue(
      new Promise<void>((res) => {
        resolveUpload = res;
      }),
    );
    await renderOpen();

    const save = screen.getByRole("button", { name: "Save summary" });
    await user.click(save);
    expect(save).toBeDisabled();
    expect(save).toHaveTextContent("Saving…");

    await act(async () => resolveUpload());
    expect(await screen.findByText(/Saved \/src\/index\.ts\.summary\.md/)).toBeInTheDocument();
  });
});

describe("SummaryModal save failure", () => {

  it("a failed save renders its reason at stream-done and announces the failure", async () => {
    const user = userEvent.setup();
    h.uploadFile.mockRejectedValueOnce(Object.assign(new Error("read-only"), {}));
    const heard: string[] = [];
    const { subscribeToAnnouncements } = await import("../announce");
    const unsubscribe = subscribeToAnnouncements((msg) => heard.push(msg));
    try {
      await renderOpen();
      expect(
        await screen.findByRole("button", { name: "Save summary" }),
      ).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Save summary" }));

      // The reason renders while the stream result stays on screen (the save
      // failure is not the stream's error state)…
      expect(
        await screen.findByText(/Couldn.t save: read-only/),
      ).toBeInTheDocument();
      expect(screen.getByText(/A summary\./)).toBeInTheDocument();
      // …and both halves announced through the one channel.
      expect(heard).toContain("Saving summary of index.ts…");
      expect(heard.some((m) => m.startsWith("Couldn't save: read-only"))).toBe(true);
    } finally {
      unsubscribe();
    }
  });
});
