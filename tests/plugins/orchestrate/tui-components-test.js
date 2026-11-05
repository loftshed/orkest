import { describe, expect, it } from "vitest";

import { HordeView } from "../../../plugins/orchestrate/lib/horde-view.mjs";
import { displayWidth, plain, tone } from "../../../plugins/orchestrate/lib/tui-box.mjs";
import {
  sectionHeading,
  statusRow,
  treeCard,
} from "../../../plugins/orchestrate/lib/tui-components.mjs";
import { DEFAULT_THEME, resolveTheme } from "../../../plugins/orchestrate/lib/tui-theme.mjs";

describe("terminal presentation components", () => {
  it("keeps the completion state readable when a worker label is long", () => {
    const row = statusRow("A long consultation name ".repeat(8), "reported complete", 50);
    expect(row).toContain("…");
    expect(row).toMatch(/ \| reported complete$/u);
    expect(displayWidth(row)).toBe(50);
  });

  it("fits long Unicode labels and prefixes at narrow widths", () => {
    for (const width of [1, 4, 20, 70]) {
      const prefix = "│  ├─";
      const heading = sectionHeading("Review ".repeat(20), "1 agent", width, { prefix });
      const row = statusRow("Review ".repeat(20), "idle", width, { prefix });
      expect(displayWidth(heading)).toBeLessThanOrEqual(width);
      expect(displayWidth(row)).toBeLessThanOrEqual(width);
    }
    expect(sectionHeading("worktree-name".repeat(8), "1 agent", 30)).toMatch(/ · 1 agent$/u);
    expect(treeCard("Worker", ["Task"], 4, { topPrefix: "│ ", midPrefix: "├─" })[1]).toBe("├─Ta");
  });

  it("isolates semantic theme overrides and honours disabled colour", () => {
    const custom = {
      enabled: true,
      theme: resolveTheme({ border: "35", heading: "33", success: "34" }),
    };
    expect(sectionHeading("Project", "1 agent", 30, { prefix: "│ ", color: custom })).toContain(
      "\u{1B}[35m",
    );
    expect(statusRow("Worker", "done", 30, { color: custom, style: "success" })).toContain(
      "\u{1B}[34m",
    );
    expect(tone("Worker", "success", { ...custom, enabled: false })).toBe("Worker");
    const room = {
      id: "theme",
      cwd: "/workspace/project",
      title: "Theme",
      conductor: {},
      agents: [],
    };
    const customView = new HordeView(room, { color: true, theme: { border: "35" } });
    const defaultView = new HordeView(room, { color: true });
    expect(customView.render(80)[0]).toContain("\u{1B}[35m");
    expect(defaultView.render(80)[0]).toContain("\u{1B}[36m");
    expect(DEFAULT_THEME.success).toBe("32");
    expect(() => resolveTheme({ border: "unsafe\u{1B}" })).toThrow("Invalid terminal theme token");
  });

  it("reserves navigation and pages through workers in distinct worktrees", () => {
    const room = {
      id: "layout",
      cwd: "/workspace/project",
      title: "Audit",
      conductor: { status: "session unavailable" },
      quotaError: "Quota unavailable",
      services: [{ kind: "port", port: 5017, name: "preview" }],
      agents: Array.from({ length: 4 }, (_, index) => ({
        id: `worker-${index}`,
        name: `worker-${index}`,
        engine: "claude",
        model: "haiku",
        cwd: `/worktrees/audit-${index}`,
        parent: "conductor",
        status: "running",
      })),
    };
    for (const height of [24, 32]) {
      const view = new HordeView(room, { height, tier: "unicode" });
      const seen = new Set();
      for (let page = 0; page < 4; page++) {
        const rendered = plain(view.render(80).join("\n"));
        expect(rendered).toContain("q close view");
        expect(rendered).toContain("Coordinator session unavailable");
        expect(rendered).not.toContain("Tell the coordinator");
        for (let index = 0; index < 4; index++)
          if (rendered.includes(`worker-${index}`)) seen.add(index);
        view.handleInput("n");
      }
      expect([...seen].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
    }
  });
});
