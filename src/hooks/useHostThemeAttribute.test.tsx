// R3-827 — the hook drives `html[data-theme]` from the host polarity: set in
// light, removed in dark (dark is the stylesheet's attribute-less default).

import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hostTheme = vi.fn<() => "light" | "dark">();
vi.mock("@immediately-run/sdk/theme", () => ({
  useHostTheme: () => hostTheme(),
}));

import { useHostThemeAttribute } from "./useHostThemeAttribute";

function Probe() {
  useHostThemeAttribute();
  return null;
}

describe("useHostThemeAttribute", () => {
  beforeEach(() => {
    hostTheme.mockReturnValue("dark");
    document.documentElement.removeAttribute("data-theme");
  });

  it("sets data-theme='light' on documentElement when the host is light", () => {
    hostTheme.mockReturnValue("light");
    render(<Probe />);
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
  });

  it("removes the attribute when the host is dark", () => {
    hostTheme.mockReturnValue("light");
    const { rerender } = render(<Probe />);
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    hostTheme.mockReturnValue("dark");
    rerender(<Probe />);
    expect(document.documentElement).not.toHaveAttribute("data-theme");
  });

  it("never writes the attribute while the host value is dark (the default stays attribute-less)", () => {
    hostTheme.mockReturnValue("dark");
    render(<Probe />);
    expect(document.documentElement).not.toHaveAttribute("data-theme");
  });
});
