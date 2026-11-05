import { describe, expect, it } from "vitest";

import { HordeView } from "../../../plugins/orchestrate/lib/horde-view.mjs";
import {
  displayWidth,
  frame,
  GLYPHS,
  plain,
  shimmerText,
  tone,
} from "../../../plugins/orchestrate/lib/tui-box.mjs";
import {
  providerMark,
  quotaAccountLabel,
  sectionHeading,
  statusRow,
  treeCard,
} from "../../../plugins/orchestrate/lib/tui-components.mjs";
import { DEFAULT_THEME, resolveTheme } from "../../../plugins/orchestrate/lib/tui-theme.mjs";

describe("terminal presentation components", () => {
  it("uses provider brands and distinct business/personal icons without losing account labels", () => {
    expect(providerMark("gemini:fast")).toBe("\u{E7F0}");
    expect(providerMark("claude:best")).toBe("\u{EC82}");
    expect(providerMark("gpt:sol")).toBe("\u{EC81}");
    expect(quotaAccountLabel({ id: "claude-work", provider: "claude", short: "CW" })).toBe(
      "\u{EC82} \u{F1AD} CW",
    );
    expect(quotaAccountLabel({ id: "claude-personal", provider: "claude", short: "CP" })).toBe(
      "\u{EC82} \u{F007} CP",
    );
    expect(quotaAccountLabel({ id: "custom", provider: "claude", short: "CL" })).toBe(
      "\u{EC82} CL",
    );
    expect(quotaAccountLabel({ provider: "antigravity", short: "AG" })).toBe("\u{E7F0}");
    expect(
      quotaAccountLabel({ id: "claude-work", provider: "claude", short: "CW" }, "unicode"),
    ).toBe("CW");
    expect(quotaAccountLabel({ provider: "codex", short: "CX" })).toBe("\u{EC81}");
    expect(quotaAccountLabel({ provider: "codex", short: "CX" }, "ascii")).toBe("CX");
    expect(providerMark("gemini", "ascii")).toBe("");
  });
  it("groups compact meters by Work and Personal while preserving brand and warning colors", () => {
    const view = new HordeView(
      {
        id: "quotas",
        conductor: {},
        agents: [],
        accounts: [
          {
            id: "claude-work",
            provider: "claude",
            short: "CW",
            windows: [
              { pool: "all", remainingPct: 80 },
              { pool: "fable", remainingPct: 40 },
            ],
          },
          {
            id: "claude-personal",
            provider: "claude",
            short: "CP",
            windows: [{ pool: "all", remainingPct: 60 }],
          },
          {
            id: "antigravity",
            provider: "antigravity",
            short: "AG",
            windows: [
              { pool: "gemini", remainingPct: 55 },
              { pool: "claude-gpt", remainingPct: 0 },
            ],
          },
          { id: "codex", provider: "codex", short: "CX", windows: [{ remainingPct: 80 }] },
        ],
      },
      { tier: "nerd", color: true, height: 40 },
    );
    const rows = view.quotaSummaryLines(150);
    expect(rows).toHaveLength(2);
    expect(plain(rows[0]).trimEnd()).toMatch(
      /^ \u{F1AD} {2}\u{EC82} all ━━━─ 80% {2}\u{EC82} fable ━━── 40% +\u{F078}$/u,
    );
    expect(plain(rows[1]).trimEnd()).toBe(
      " \u{F007}  \u{EC82} ━━── 60%  \u{E7F0} Gemini ━━── 55%  \u{E7F0} Claude/GPT ──── 0%  \u{EC81} ━━━─ 80%",
    );
    const rendered = view.render(152).join("\n");
    expect(plain(rendered)).toContain("│ Coordinator · folder: workspace");
    expect(plain(rendered)).toContain("│ \u{F1AD}  \u{EC82} all ━━━─ 80%");
    expect(rendered).toContain("\u{1B}[38;5;173m\u{EC82}\u{1B}[0m");
    expect(rendered).toContain("\u{1B}[38;5;33m\u{E7F0}\u{1B}[0m");
    expect(rendered).toContain("\u{1B}[37m\u{EC81}\u{1B}[0m");
    expect(rows.map(plain).join("\n")).not.toContain("Quota");
    expect(rows.map(plain).join("\n")).not.toContain("Work");
    expect(rows.map(plain).join("\n")).not.toContain("Personal");
    expect(rows.map(plain).join("\n")).not.toContain("AG");
    expect(rows.map(plain).join("\n")).not.toContain("CX");
    expect(rows[0]).toContain("\u{1B}[36m");
    expect(rows[1]).toContain("\u{1B}[35m");
    expect(rows[1]).toContain("\u{1B}[31m");
    expect(rows.map(plain).join("\n")).not.toContain("CW");
    expect(rows.map(plain).join("\n")).not.toContain("CP");
    const narrow = view.quotaSummaryLines(48).map(plain);
    expect(narrow.join("\n")).toContain("fable");
    expect(narrow.join("\n")).toContain("Claude/GPT");
    expect(narrow.join("\n").match(/\u{F1AD}/gu)).toHaveLength(1);
    expect(narrow.join("\n").match(/\u{F007}/gu)).toHaveLength(1);
    for (const row of narrow) expect(displayWidth(row)).toBe(48);
    view.render(152);
    const quota = view.targets.find((target) => target.id === "quota-heading");
    view.handleMouse({ x: quota.x, y: quota.y, action: "move", button: 0 });
    const hovered = view.quotaSummaryLines(150);
    expect(hovered[0]).toContain("\u{1B}[97;1m");
    expect(hovered.join("\n")).not.toContain("\u{1B}[7;1m");
    const fallback = new HordeView(view.room, { tier: "unicode", color: false });
    expect(fallback.quotaSummaryLines(150).map(plain).join("\n")).toContain("claude all ━━━─ 80%");
  });
  it("keeps uptime at the right edge while service details stay on the left", () => {
    const view = new HordeView(
      {
        id: "services",
        agents: [],
        services: [
          { port: 5179, name: "Demo server", uptime: "2m" },
          {
            port: 5180,
            name: "A very long service name that must leave room for uptime",
            uptime: "14m",
          },
        ],
      },
      { tier: "unicode", color: false },
    );
    const rows = view.serviceLines(64);
    expect(rows[0]).toContain(":5179  Demo server");
    expect(rows[0]).toMatch(/ {2,}up 2m$/u);
    expect(rows[1]).toMatch(/ {2,}up 14m$/u);
    for (const row of rows) expect(displayWidth(row)).toBe(60);
  });
  it("connects colored header titles and status badges with a horizontal rule", () => {
    const [header] = frame("Swarm", ["Current task"], 44, {
      glyphs: GLYPHS.unicode,
      color: true,
      headerTone: "swarmHeading",
      right: "2 active",
    });
    expect(plain(header)).toMatch(/^┌ Swarm ─+ 2 active ┐$/u);
    expect(header).toContain("\u{1B}[48;5;237;97;1m");
    expect(displayWidth(header)).toBe(44);
  });
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
        expect(rendered).not.toContain(" Close view ");
        expect(rendered).toContain("Coordinator session unavailable");
        expect(rendered).not.toContain("Tell the coordinator");
        for (let index = 0; index < 4; index++)
          if (rendered.includes(`worker-${index}`)) seen.add(index);
        view.handleInput("n");
      }
      expect([...seen].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
    }
  });

  it("sweeps a shimmer highlight wave across active action text and prefixes active coordinator tasks with a Braille spinner", () => {
    const color = { enabled: true, theme: DEFAULT_THEME };
    const frameA = shimmerText("Inspecting Orkest swarm pane title", 840, color);
    const frameB = shimmerText("Inspecting Orkest swarm pane title", 1440, color);
    expect(plain(frameA)).toBe("Inspecting Orkest swarm pane title");
    expect(frameA).toContain("\u{1B}[38;5;150;1m");
    expect(frameA).not.toBe(frameB);

    const room = {
      id: "shimmer-room",
      cwd: "/workspace/project",
      title: "Refine Orkest coordinator delegation",
      herdrViewPaneId: "w1:p2",
      conductor: {
        name: "glorpax",
        engine: "agy",
        model: "gemini-3.8-flash-high",
        status: "working",
        progress: {
          stage: "working",
          task: "Inspecting Orkest swarm pane title and card header",
        },
      },
      agents: [],
    };
    const view = new HordeView(room, { color: true, tier: "nerd", now: () => 840 });
    expect(view.needsAnimation).toBe(true);
    const rendered = view.render(80);
    expect(plain(rendered[0])).toContain("╭ Swarm ─");
    expect(plain(rendered[0])).not.toContain("Refine Orkest coordinator delegation");
    expect(plain(rendered[3])).toContain("│ ⣷ Inspecting Orkest swarm pane title and card header");
    expect(rendered[3]).toContain("\u{1B}[38;5;149m⣷\u{1B}[0m");
    expect(rendered[3]).toContain("\u{1B}[38;5;150;1m");
  });
});
