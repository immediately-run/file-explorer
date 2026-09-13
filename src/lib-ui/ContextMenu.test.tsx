// The context menu's dialog/menu contract (R-IX-1): focus moves in on open,
// arrows move the items, Escape closes, Tab is LEAVE (the menu closes behind
// the browser's move, and that move stands), and every close path returns
// focus to the invoker — never to <body>. The harness mounts the menu the way
// the view does: conditionally, from a real trigger, unmounted on close.
import { useState } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import ContextMenu from "./ContextMenu";

const ITEMS = [
  { key: "a", label: "Alpha", onSelect: () => {} },
  { key: "b", label: "Beta", onSelect: () => {} },
  { key: "c", label: "Gamma", onSelect: () => {} },
];

function Harness({ onClose }: { onClose: () => void }) {
  // The invoker is the trigger, captured as the view captures it (the row).
  const [invoker, setInvoker] = useState<HTMLElement | null>(null);
  return (
    <div>
      <button
        onClick={(e) => setInvoker(e.currentTarget)}
        onContextMenu={(e) => {
          e.preventDefault();
          setInvoker(e.currentTarget);
        }}
      >
        open the menu
      </button>
      <button>elsewhere</button>
      {invoker && (
        <ContextMenu
          anchor={{ x: 10, y: 10, invoker, items: ITEMS }}
          onClose={() => {
            setInvoker(null);
            onClose();
          }}
        />
      )}
    </div>
  );
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("ContextMenu contract", () => {
  it("focus moves in on open and RETURNS to the invoker on Escape", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const trigger = screen.getByRole("button", { name: "open the menu" });
    trigger.focus();
    await user.click(trigger);

    // Focus moved in — to the first item.
    expect(screen.getByRole("menuitem", { name: "Alpha" })).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveFocus(); // not <body> — the invoker
  });

  it("ArrowDown/ArrowUp cycle the items", async () => {
    const user = userEvent.setup();
    render(<Harness onClose={() => {}} />);
    await user.click(screen.getByRole("button", { name: "open the menu" }));
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Beta" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Gamma" })).toHaveFocus();
    await user.keyboard("{ArrowUp}{ArrowUp}");
    expect(screen.getByRole("menuitem", { name: "Alpha" })).toHaveFocus();
  });

  it("Tab is leave: the menu closes behind the browser's own move", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    await user.click(screen.getByRole("button", { name: "open the menu" }));
    await user.keyboard("{Tab}");
    expect(onClose).toHaveBeenCalledTimes(1);
    // The browser's move stood — focus did NOT snap back to the trigger.
    expect(screen.getByRole("button", { name: "open the menu" })).not.toHaveFocus();
  });

  it("an outside pointer press dismisses the menu and returns focus to the invoker", async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const trigger = screen.getByRole("button", { name: "open the menu" });
    fireEvent.contextMenu(trigger);
    expect(screen.getByRole("menuitem", { name: "Alpha" })).toHaveFocus();

    fireEvent.pointerDown(screen.getByRole("button", { name: "elsewhere" }), { pointerId: 1 });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveFocus();
  });
});
