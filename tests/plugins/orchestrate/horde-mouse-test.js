import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runHordeTui } from "../../../plugins/orchestrate/bin/horde-tui.mjs";
import { herdrEndpoint } from "../../../plugins/orchestrate/lib/herdr-context.mjs";
import { HordeView } from "../../../plugins/orchestrate/lib/horde-view.mjs";
import { displayWidth, plain } from "../../../plugins/orchestrate/lib/tui-box.mjs";
import { actionBar, hitTest } from "../../../plugins/orchestrate/lib/tui-components.mjs";

const HERDR_SOCKET_PATH = path.join(tmpdir(), "orkest-mouse-test-herdr.sock");
const HERDR_ENDPOINT = herdrEndpoint({ HERDR_SOCKET_PATH });

beforeEach(() => vi.stubEnv("NO_COLOR", ""));
afterEach(() => vi.unstubAllEnvs());

function room() {
  return {
    id: "clicks",
    title: "Review changes",
    cwd: "/workspace/project",
    conductor: {},
    agents: [
      {
        id: "alpha",
        name: "alpha",
        status: "running",
        herdrPaneId: "w1:p2",
        herdrEndpoint: HERDR_ENDPOINT,
        nativeSession: "alpha-session",
        output: ["Inspecting changes"],
      },
      {
        id: "beta",
        name: "beta",
        status: "running",
        herdrPaneId: "w1:p3",
        herdrEndpoint: HERDR_ENDPOINT,
        nativeSession: "beta-session",
      },
      { id: "background", name: "background", status: "completed", output: ["Review finished"] },
    ],
  };
}

function pointAt(view, text, width = 80) {
  const lines = view.render(width).map(plain);
  const index = lines.findIndex((line) => line.includes(text));
  expect(index, `Expected visible control: ${text}`).toBeGreaterThanOrEqual(0);
  return { x: displayWidth(lines[index].slice(0, lines[index].indexOf(text))) + 1, y: index + 1 };
}

function click(view, text, width) {
  return view.handleMouse({ ...pointAt(view, text, width), action: "press", button: 0 });
}

describe("clickable Swarm View", () => {
  it.each(["nerd", "unicode", "ascii"])(
    "returns to the current session's live chat in %s tier",
    (tier) => {
      const data = room();
      data.herdrCoordinatorPaneId = "w1:p2";
      data.conductor = { name: "Current session", session: { id: "session-current" } };
      const onFocusPane = vi.fn();
      const onPreview = vi.fn();
      const view = new HordeView(data, { height: 40, onFocusPane, onPreview, tier });
      click(view, "3 alpha", 120);
      expect(onFocusPane.mock.calls[0][0]).toMatchObject({ id: "alpha", herdrPaneId: "w1:p2" });
      expect(onPreview).not.toHaveBeenCalled();
      expect(view.render(120).map(plain).join("\n")).not.toContain("Return to chat");
      view.setRoom(data);
      view.handleInput("\r");
      expect(onFocusPane.mock.calls).toHaveLength(2);
      const header = tier === "nerd" ? "ork: \u{F06A9} Current session" : "ork: Current session";
      click(view, header, 120);
      expect(onFocusPane.mock.calls.at(-1)[0]).toMatchObject({
        id: "conductor",
        herdrPaneId: "w1:p2",
      });
      expect(onPreview).not.toHaveBeenCalled();
    },
  );

  it("keeps quota to one summary row until its chevron is clicked", () => {
    const data = room();
    data.accounts = [
      { short: "CX", windows: [{ remainingPct: 88 }, { remainingPct: 47 }] },
      { short: "CL", windows: [{ remainingPct: 76 }] },
    ];
    const view = new HordeView(data, { height: 32, tier: "nerd" });
    const collapsed = view.render(80).map(plain);
    expect(collapsed.filter((line) => line.includes("Quota"))).toHaveLength(0);
    expect(collapsed.join("\n")).toContain("CX ━━── 47%  CL ━━━─ 76%");
    expect(collapsed.join("\n")).toContain("\u{F054}");
    expect(collapsed.join("\n")).not.toContain("u collapse");
    click(view, "CX ━━── 47%");
    expect(view.quotaMode).toBe("expanded");
    expect(view.render(80).map(plain).join("\n")).toContain("\u{F078} Quota");
    click(view, "\u{F078} Quota");
    expect(view.quotaMode).toBe("collapsed");
  });

  it.each([40, 80, 160])("toggles quota windows by pointer and keyboard at width %i", (width) => {
    const data = room();
    data.accounts = [
      {
        short: "CL",
        windows: [
          { kind: "5h", remainingPct: 90 },
          { kind: "weekly", remainingPct: 30 },
        ],
      },
    ];
    const view = new HordeView(data, { height: 32 });
    expect(view.render(width).map(plain).join("\n")).toContain("90%");
    click(view, "5h", width);
    expect(view.quotaMode).toBe("collapsed");
    expect(view.render(width).map(plain).join("\n")).toContain("30%");
    expect(view.quotaWindow).toBe("weekly");
    view.setRoom(data);
    expect(view.quotaWindow).toBe("weekly");
    click(view, "wk", width);
    expect(view.render(width).map(plain).join("\n")).toContain("90%");
    for (const [label, nextWindow, percentage] of [
      ["5h", "weekly", "30%"],
      ["wk", "5h", "90%"],
    ]) {
      const point = pointAt(view, label, width);
      view.handleMouse({ ...point, x: point.x + 1, action: "press", button: 0 });
      expect(view.quotaWindow).toBe(nextWindow);
      expect(view.quotaMode).toBe("collapsed");
      expect(view.render(width).map(plain).join("\n")).toContain(percentage);
    }
    // The space and disclosure after the window label still expand the drawer.
    for (const offset of [2, 3]) {
      const point = pointAt(view, "5h", width);
      view.handleMouse({ ...point, x: point.x + offset, action: "press", button: 0 });
      expect(view.quotaMode).toBe("expanded");
      expect(view.quotaWindow).toBe("5h");
      view.handleInput("u");
    }
    view.handleInput("w");
    expect(view.render(width).map(plain).join("\n")).toContain("30%");
    click(view, "CL", width);
    expect(view.quotaMode).toBe("expanded");
    view.handleInput("u");
    expect(view.quotaMode).toBe("collapsed");
  });

  it("keeps shortcuts in a discoverable menu instead of button labels", () => {
    const view = new HordeView(room(), { height: 24, tier: "nerd" });
    const text = view.render(80).map(plain).join("\n");
    expect(text).toContain("\u{F11C} Shortcuts");
    expect(text).toContain("\u{F086} View chat");
    expect(text).not.toContain("View chat Enter");
    expect(text).not.toContain("Close view");
    click(view, "Shortcuts");
    expect(view.render(80).map(plain).join("\n")).toContain("Enter       Preview");
    for (let index = 0; index < 12; index++) click(view, "Down");
    expect(view.render(80).map(plain).join("\n")).toContain("q or Ctrl-C Quit");
  });

  it("shows only Back (without a redundant Return to chat button) while previewing another agent", () => {
    const data = room();
    data.herdrCoordinatorPaneId = "w1:p2";
    const onFocusPane = vi.fn();
    const view = new HordeView(data, { height: 32, onFocusPane });
    expect(view.render(160).map(plain).join("\n")).not.toContain("Return to chat");
    view.setPreview({
      agentId: "beta",
      title: "beta",
      kind: "terminal",
      text: "Another agent's chat",
      loading: false,
    });
    const rendered = view.render(160).map(plain).join("\n");
    expect(rendered).toContain("Back");
    expect(rendered).not.toContain("Return to chat");
    click(view, "Back", 160);
    expect(view.preview).toBeNull();
  });

  it("keeps both Antigravity meters visible in a narrow compact strip", () => {
    const data = room();
    data.accounts = [
      {
        short: "AG",
        provider: "antigravity",
        windows: [
          { pool: "claude-gpt", remainingPct: 22 },
          { pool: "gemini", remainingPct: 79 },
        ],
      },
    ];
    const view = new HordeView(data, { height: 32, tier: "nerd" });
    const text = view.render(40).map(plain).join("\n");
    expect(text).toContain("Claude/GPT");
    expect(text).toContain("22%");
    expect(text).toContain("Gemini");
    expect(text).toContain("79%");
    expect(view.quotaMode).toBe("collapsed");
    expect(view.render(40).every((line) => displayWidth(line) <= 40)).toBe(true);
  });
  it("routes terminal mouse input to an inline read-only preview without zooming the pane", async () => {
    // eslint-disable-next-line unicorn/prefer-event-target -- The TUI consumes Node terminal stream events.
    const input = Object.assign(new EventEmitter(), {
      isTTY: true,
      isRaw: false,
      setRawMode: vi.fn(),
      resume() {},
      pause() {},
    });
    let outputText = "";
    const output = {
      isTTY: true,
      rows: 32,
      columns: 160,
      write: (text) => {
        outputText += text;
      },
    };
    const commands = [];
    const exec = (command, args, options, callback) => {
      commands.push([command, ...args]);
      let text = "{}";
      switch (args[1]) {
        case "layout": {
          text = JSON.stringify({ result: { layout: { zoomed: false } } });
          break;
        }
        case "get": {
          text = JSON.stringify({
            result: {
              type: "agent_info",
              agent: { agent_session: { kind: "id", value: "beta-session" } },
            },
          });

          break;
        }
        case "read": {
          {
            text = "Agent beta chat\nAssistant: inspecting changes";
            // No default
          }
          break;
        }
      }
      callback(null, text);
    };
    const running = runHordeTui(async () => room(), {
      input,
      output,
      exec,
      env: { HERDR_ENV: "1", HERDR_SOCKET_PATH, HERDR_PANE_ID: "w1:p9" },
      quota: false,
      services: false,
      update: false,
    });
    try {
      await vi.waitFor(() => expect(outputText).toContain("View chat"));
      const { x, y } = pointAt(new HordeView(room(), { height: 32 }), "2 beta", 160);
      input.emit("data", `\u{1B}[<0;${x};${y}M`);
      await vi.waitFor(() => expect(outputText).toContain("Agent beta chat"));
      expect(outputText).toContain("Live screen · read only");
      expect(commands).toContainEqual([
        "herdr",
        "agent",
        "read",
        "w1:p3",
        "--source",
        "visible",
        "--lines",
        "200",
      ]);
      expect(commands).not.toContainEqual(["herdr", "pane", "zoom", "--pane", "w1:p9", "--on"]);
    } finally {
      input.emit("data", "q");
      await running;
    }
    expect(outputText).toContain("\u{1B}[?1003l");
    expect(input.setRawMode.mock.calls).toEqual([[true], [false]]);
  });
  it("opens a clicked agent and preserves its selection through refresh", () => {
    const onPreview = vi.fn();
    const view = new HordeView(room(), { height: 40, onPreview, color: true, tier: "nerd" });
    const initial = view.render(80).join("\n");
    expect(initial).toContain("\u{1B}[48;5;237;97m 2 beta \u{1B}[0m");
    expect(initial).toContain(" \u{F054} ");
    const betaPoint = pointAt(view, "2 beta");
    view.handleMouse({ ...betaPoint, action: "move", button: 0 });
    expect(view.render(80).join("\n")).toContain("\u{1B}[7;1m 2 beta \u{1B}[0m");
    click(view, "2 beta");
    expect(onPreview.mock.calls[0][0]).toMatchObject({ id: "beta", herdrPaneId: "w1:p3" });
    view.setRoom(room());
    expect(view.focusId).toBe("beta");
    expect(plain(view.render(80).join("\n"))).toContain("▸ 2 beta");
    expect(plain(view.render(80).join("\n"))).not.toContain("FOCUS");
  });

  it("opens either column and collapsed agent rows using the visible layout", () => {
    const opened = [];
    const view = new HordeView(room(), {
      height: 40,
      completedMode: "expanded",
      onPreview: (agent) => {
        opened.push(agent.id);
        view.setPreview({
          agentId: agent.id,
          title: agent.name,
          kind: agent.herdrPaneId ? "terminal" : "activity",
          text: (agent.output || []).join("\n"),
        });
      },
    });
    click(view, "2 beta", 120);
    click(view, "Back", 120);
    view.handleInput("c");
    click(view, "1 background", 120);
    expect(opened).toEqual(["beta", "background"]);
    expect(view.render(120).join("\n")).toContain("Review finished");
    expect(view.render(120).join("\n")).toContain("Recorded activity");
  });

  it.each([40, 80, 120])(
    "wraps footer controls and keeps them clickable at %i columns",
    (width) => {
      const view = new HordeView(room(), { height: 32, color: true });
      click(view, "Shortcuts", width);
      expect(plain(view.render(width).join("\n"))).toContain("Keyboard shortcuts");
      click(view, "Back", width);
      expect(plain(view.render(width).join("\n"))).toContain("Review changes");
      click(view, "Inactive", width);
      expect(view.completedMode).toBe("hidden");
      expect(plain(view.render(width).join("\n"))).not.toContain("Mouse on");
      view.handleInput("m");
      expect(view.mouseEnabled).toBe(false);
      expect(plain(view.render(width).join("\n"))).toContain(
        "Mouse off — press m to re-enable mouse",
      );
      view.handleInput("m");
      expect(view.mouseEnabled).toBe(true);
      expect(plain(view.render(width).join("\n"))).not.toContain("Close view");
      expect(view.handleInput("q")).toEqual({ type: "close-view" });
      expect(view.render(width).every((line) => displayWidth(line) <= width)).toBe(true);
    },
  );

  it("does not activate controls on hover, release, or a right click", () => {
    const view = new HordeView(room(), { height: 32 });
    const point = pointAt(view, "Log");
    for (const [button, action] of [
      [0, "move"],
      [0, "release"],
      [2, "press"],
    ]) {
      expect(view.handleMouse({ ...point, button, action })).toBe(false);
    }
    expect(view.overlay).toBeUndefined();
    click(view, "Shortcuts");
    expect(view.overlay).toBe("help");
  });

  it("renders the live preview in a container below the focused agent card and switches or closes inline", () => {
    const onPreview = vi.fn();
    const view = new HordeView(room(), { height: 32, onPreview });
    view.focusId = "alpha";
    view.setPreview({
      agentId: "alpha",
      title: "alpha",
      kind: "terminal",
      text: "Current chat screen",
      loading: false,
    });
    const rendered = view.render(160).map(plain);
    const joined = rendered.join("\n");
    expect(joined).toContain("Live screen · read only");
    expect(joined).toContain("Current chat screen");
    expect(joined).toContain("3 alpha");
    expect(joined).not.toContain("2 beta");
    expect(joined).not.toContain("1 background");
    click(view, "Next", 160);
    expect(onPreview.mock.calls[0][0]).toMatchObject({ id: "background" });
    expect(click(view, "Back", 160)).toEqual({ type: "close-preview" });
    expect(view.preview).toBeNull();
    view.setPreview({
      agentId: "alpha",
      title: "alpha",
      kind: "terminal",
      text: "Current chat screen",
      loading: false,
    });
    expect(click(view, "3 alpha", 160)).toEqual({ type: "close-preview" });
    expect(view.preview).toBeNull();
    expect(rendered.every((line) => displayWidth(line) <= 160)).toBe(true);
  });

  it("offers a return to the agent list when a preview fills a narrow terminal", () => {
    const view = new HordeView(room(), { height: 24 });
    view.setPreview({
      agentId: "alpha",
      title: "alpha",
      kind: "terminal",
      text: "Current chat screen",
      loading: false,
    });
    expect(view.render(44).map(plain).join("\n")).toContain("Current chat screen");
    expect(click(view, "Back", 44)).toEqual({ type: "close-preview" });
    expect(view.render(44).every((line) => displayWidth(line) <= 44)).toBe(true);
  });

  it("scrolls preview text without changing agents, and follows again on request", () => {
    const view = new HordeView(room(), { height: 24 });
    view.setPreview({
      agentId: "alpha",
      title: "alpha",
      kind: "terminal",
      text: Array.from({ length: 80 }, (_, index) => `Chat line ${index + 1}`).join("\n"),
      loading: false,
    });
    expect(view.render(160).map(plain).join("\n")).toContain("Chat line 80");
    const focused = view.focusId;
    view.handleMouse({ x: 4, y: 10, action: "scroll-up", button: 4 });
    expect(view.render(160).map(plain).join("\n")).not.toContain("Chat line 80");
    expect(view.focusId).toBe(focused);
    const held = view
      .render(160)
      .map(plain)
      .filter((line) => line.includes("Chat line"));
    view.setPreview({ ...view.preview, text: `${view.preview.text}\nChat line 81` });
    expect(
      view
        .render(160)
        .map(plain)
        .filter((line) => line.includes("Chat line")),
    ).toEqual(held);
    click(view, "Follow", 160);
    expect(view.render(160).map(plain).join("\n")).toContain("Chat line 81");
    view.handleInput("\u{1B}[5~");
    expect(view.render(160).map(plain).join("\n")).not.toContain("Chat line 81");
    view.handleInput("\u{1B}[6~");
    expect(view.render(160).map(plain).join("\n")).toContain("Chat line 81");
  });

  it("anchors long recorded responses while allowing manual scrolling and refresh", () => {
    const view = new HordeView(room(), { height: 24 });
    const actions = Array.from({ length: 40 }, (_, i) => `Action ${i}`).join("\n");
    const answer = Array.from({ length: 60 }, (_, i) => `Answer line ${i + 1}`).join("\n");
    const text = `Recent activity:\n${actions}\n\nResponse:\n${answer}`;
    view.setPreview({ agentId: "alpha", title: "alpha", kind: "activity", text });
    const rendered = () => view.render(80).map(plain).join("\n");
    expect(rendered()).toContain("Response:");
    expect(rendered()).toContain("Answer line 1");
    view.handleInput("\u{1B}[6~");
    expect(rendered()).toContain("Answer line 20");
    const held = rendered();
    view.setPreview({ ...view.preview, text: `${text}\nNew final line` });
    expect(rendered()).toBe(held);
    for (let i = 0; i < 10; i++) view.handleInput("\u{1B}[6~");
    expect(rendered()).toContain("Answer line 60");
    view.handleInput("r");
    expect(rendered()).toContain("Response:");
    view.handleMouse({ x: 4, y: 10, action: "scroll-up", button: 4 });
    expect(rendered()).toContain("Action 39");
    view.handleInput("r");
    view.setPreview({
      ...view.preview,
      text: `Recent activity:\n${actions}\n\nResponse:\nShort answer`,
    });
    expect(rendered()).toContain("Action 39");
    expect(rendered()).toContain("Response:");
    expect(rendered()).toContain("Short answer");
  });

  it("renders semantic button colors and retains labels without color", () => {
    const actions = [
      { id: "open", label: "Open", key: "o", primary: true },
      { id: "disabled", label: "Next", key: "n", disabled: true },
      { id: "close", label: "Close", key: "q", danger: true },
    ];
    const colored = actionBar(actions, 80, { color: true });
    expect(colored.lines.join("")).toContain("\u{1B}[48;5;237;97;1m");
    expect(colored.lines.join("")).toContain("\u{1B}[41;97;1m");
    const mono = actionBar(actions, 12);
    expect(mono.lines).toEqual([" Open ", " Next ", " Close "]);
    expect(hitTest(mono.targets, 4, 1)).toMatchObject({ id: "open" });
    expect(hitTest(mono.targets, 4, 2)).toBeUndefined();
    expect(hitTest(mono.targets, 4, 3)).toMatchObject({ id: "close" });
  });

  it("hides Inactive when no agents are inactive, expands hidden inactive rows on click, and clicks bottom Update bubble", () => {
    const activeOnly = room();
    activeOnly.agents = activeOnly.agents.filter((agent) => agent.status === "running");
    const activeView = new HordeView(activeOnly, { height: 32 });
    expect(activeView.render(80).map(plain).join("\n")).not.toContain("Inactive");

    const withInactive = room();
    withInactive.update = { available: true, commitsBehind: 2, remoteSha: "abc1234" };
    const view = new HordeView(withInactive, { height: 32, completedMode: "hidden" });
    expect(click(view, "1 inactive hidden", 80)).toBe(true);
    expect(view.completedMode).toBe("expanded");
    expect(click(view, "click to update", 80)).toEqual({ type: "pull-update" });
  });
});
