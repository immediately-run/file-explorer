// R3-827 — the cascade proof: with `data-theme="light"` on <html>, the panel's
// tokens must come from the app's light palette (index.css), NOT from the
// library's dark seed (lib-ui/styles.css `:where(.fx-root)` block). The seed is
// declared DIRECTLY on the view root, and a direct declaration beats an
// inherited custom property at any specificity — the bug the venue screenshot
// showed (host light, panel dark) was exactly this. jsdom over the real
// stylesheets is the same instrument the review's verification used.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8");

const PANEL_DARK = "#0a0b11";
const PANEL_LIGHT = "#f6f4fb";

const mountWithSheets = (theme: "light" | null) => {
  if (theme) document.documentElement.setAttribute("data-theme", theme);
  for (const rel of ["index.css", "lib-ui/styles.css"]) {
    const style = document.createElement("style");
    style.textContent = read(rel);
    document.head.appendChild(style);
  }
  const panel = document.createElement("section");
  panel.className = "panel fx-root";
  document.body.appendChild(panel);
  return panel;
};

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

describe("the light palette reaches the panel (R3-827)", () => {
  it("dark (no attribute): the panel carries the library's dark seed", () => {
    const panel = mountWithSheets(null);
    expect(getComputedStyle(panel).getPropertyValue("--bg").trim()).toBe(PANEL_DARK);
  });

  it("light: the library seed steps aside and the app's light tokens inherit in", () => {
    const panel = mountWithSheets("light");
    expect(getComputedStyle(panel).getPropertyValue("--bg").trim()).toBe(PANEL_LIGHT);
    expect(getComputedStyle(panel).getPropertyValue("--ink").trim()).toBe("#1c1726");
  });

  it("light: the gradient surfaces carry a light-safe foreground (WCAG 2.2 AA)", () => {
    mountWithSheets("light");
    for (const cls of ["cta", "crow--path", "viewswitch__btn--active"]) {
      const el = document.createElement("button");
      el.className = cls;
      document.body.appendChild(el);
      expect(getComputedStyle(el).color.trim()).toBe("rgb(255, 255, 255)");
      el.remove();
    }
  });
});
