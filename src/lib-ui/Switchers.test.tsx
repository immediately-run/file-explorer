// The two `.viewswitch` segmented controls (LayoutSwitcher, LensSwitcher) against
// the APG Radio Group contract the interaction standards adopt by reference:
// roving tabindex (the checked radio is the group's one tab stop), arrows that
// move selection AND check, and Home/End. Rendered headless with local state —
// no SDK, matching FileExplorerView.test.tsx's approach.
import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import LayoutSwitcher from "./LayoutSwitcher";
import LensSwitcher from "./LensSwitcher";
import type { Layout } from "./types";

function Harness({
  initial,
}: {
  initial: Layout;
}) {
  const [value, setValue] = useState<Layout>(initial);
  return <LayoutSwitcher value={value} onChange={setValue} />;
}

function LensHarness({ initial }: { initial: "app" | "session" }) {
  const [value, setValue] = useState(initial);
  return <LensSwitcher value={value} onChange={setValue} />;
}

describe("LayoutSwitcher (APG radio group)", () => {
  it("only the checked radio is a tab stop (roving tabindex)", () => {
    render(<Harness initial="tree" />);
    expect(screen.getByRole("radio", { name: "Tree view" })).toHaveAttribute("tabindex", "0");
    for (const name of ["List view", "Column view", "Icon view"]) {
      expect(screen.getByRole("radio", { name })).toHaveAttribute("tabindex", "-1");
    }
  });

  it("ArrowRight moves selection AND check, and focus follows", async () => {
    render(<Harness initial="tree" />);
    screen.getByRole("radio", { name: "Tree view" }).focus();
    await userEvent.setup().keyboard("{ArrowRight}");
    const list = screen.getByRole("radio", { name: "List view" });
    expect(list).toHaveAttribute("aria-checked", "true");
    expect(list).toHaveAttribute("tabindex", "0");
    expect(list).toHaveFocus();
    expect(screen.getByRole("radio", { name: "Tree view" })).toHaveAttribute("tabindex", "-1");
  });

  it("ArrowLeft wraps from the first radio to the last", async () => {
    render(<Harness initial="tree" />);
    screen.getByRole("radio", { name: "Tree view" }).focus();
    await userEvent.setup().keyboard("{ArrowLeft}");
    expect(screen.getByRole("radio", { name: "Icon view" })).toHaveAttribute("aria-checked", "true");
  });

  it("End jumps to the last radio and Home back to the first", async () => {
    render(<Harness initial="tree" />);
    screen.getByRole("radio", { name: "Tree view" }).focus();
    const user = userEvent.setup();
    await user.keyboard("{End}");
    expect(screen.getByRole("radio", { name: "Icon view" })).toHaveFocus();
    await user.keyboard("{Home}");
    expect(screen.getByRole("radio", { name: "Tree view" })).toHaveFocus();
  });
});

describe("LensSwitcher (APG radio group)", () => {
  it("names the group and options in space vocabulary, with roving tabindex", () => {
    render(<LensHarness initial="app" />);
    expect(screen.getByRole("radiogroup", { name: "Spaces lens" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "This app's spaces" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("radio", { name: "The session's spaces" })).toHaveAttribute("tabindex", "-1");
  });

  it("ArrowDown moves selection AND check from App to Session", async () => {
    render(<LensHarness initial="app" />);
    screen.getByRole("radio", { name: "This app's spaces" }).focus();
    await userEvent.setup().keyboard("{ArrowDown}");
    const session = screen.getByRole("radio", { name: "The session's spaces" });
    expect(session).toHaveAttribute("aria-checked", "true");
    expect(session).toHaveFocus();
  });
});
