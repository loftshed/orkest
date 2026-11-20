import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runHordeTui } from "../../../src/bin/horde-tui.mjs";
import {
  chiefEntries,
  chiefPaneTarget,
  chiefPortBadge,
  chiefPrBadge,
  chiefRoomPill,
  chiefSummary,
  ChiefView,
  chiefWorkerSummary,
} from "../../../src/lib/chief-view.mjs";
import { createRoom, parseTeam } from "../../../src/lib/horde-room.mjs";
import { HordeView } from "../../../src/lib/horde-view.mjs";
import { displayWidth, plain } from "../../../src/lib/tui-box.mjs";

const execute = promisify(execFile);
const cli = path.resolve("src/bin/ork.mjs");
const NOW = Date.parse("2026-11-18T06:00:00.000Z");
const SERVER = "orkest-label-0123456789ab";
const temporary = [];

beforeEach(() => vi.stubEnv("NO_COLOR", ""));
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function status() {
  return {
    schema: "ork.chief.status.v1",
    generatedAt: "2026-11-18T06:00:00.000Z",
    machine: "kahuna",
    chief: {
      schema: "ork.chief.v1",
      live: true,
      session: "chief-session-1",
      name: "Ork Chief",
      engine: "claude",
      model: "opus-5.5",
      paneId: "%9",
      terminalServer: SERVER,
      boundAt: "2026-11-18T05:30:00.000Z",
    },
    staleChief: null,
    summary: { orchestrators: 3, working: 5, blocked: 1, attention: 2, standalone: 2 },
    rooms: [
      {
        id: "room-docs",
        title: "Docs refresh",
        cwd: "/code/orkest",
        repo: { name: "orkest", path: "/code/orkest" },
        branch: "main",
        worktree: null,
        coordinator: {
          session: "coord-docs",
          name: "Quill",
          engine: "codex",
          model: "gpt-5.5",
          status: "idle",
          paneId: "%3",
          terminalServer: SERVER,
        },
        counts: { working: 0, blocked: 0, done: 2, idle: 0, total: 2 },
        stage: "done",
        task: "Docs merged",
        attention: [],
        latest: null,
        parentChief: null,
        updatedAt: "2026-11-18T05:30:00.000Z",
      },
      {
        id: "room-chief",
        title: "Ork Chief side window",
        goal: "Ship the machine-wide Chief overview",
        cwd: "/code/orkest/.worktrees/pr7-ork-chief",
        repo: { name: "orkest", path: "/code/orkest" },
        branch: "feat/ork-chief",
        worktree: { slug: "pr7-ork-chief", path: "/code/orkest/.worktrees/pr7-ork-chief" },
        coordinator: {
          session: "coord-chief",
          name: "Lumen",
          engine: "claude",
          model: "opus-5.5",
          effort: "high",
          status: "busy",
          paneId: "%4",
          terminalServer: SERVER,
        },
        counts: { working: 3, blocked: 1, done: 1, idle: 0, total: 5 },
        stage: "implementing",
        task: "Wiring Chief view into horde-tui",
        attention: [{ kind: "blocked", from: "verifier", text: "Needs a key decision" }],
        latest: { from: "chief-tui", text: "Chief view renders in narrow panes" },
        parentChief: { session: "chief-session-1", name: "Ork Chief" },
        updatedAt: "2026-11-18T05:59:00.000Z",
      },
      {
        id: "room-auth",
        title: "Auth rewrite",
        goal: "Replace session cookies with tokens",
        cwd: "/code/webapp/.worktrees/auth",
        repo: { name: "webapp", path: "/code/webapp" },
        branch: "feat/auth",
        worktree: { slug: "auth", path: "/code/webapp/.worktrees/auth" },
        coordinator: {
          session: "coord-auth",
          name: "Vega",
          engine: "agy",
          model: "gemini-3-pro",
          status: "working",
        },
        counts: { working: 2, blocked: 0, done: 0, idle: 1, total: 3 },
        stage: "testing",
        task: "Running integration tests",
        attention: [{ kind: "escalation", from: "Vega", text: "Need the prod DB policy" }],
        latest: null,
        parentChief: { session: "chief-session-1", name: "Ork Chief" },
        updatedAt: "2026-11-18T05:58:00.000Z",
      },
    ],
    standalone: [
      {
        session: "solo-1",
        name: "Scout",
        engine: "claude",
        model: "haiku",
        status: "busy",
        stage: "working",
        task: "Triage flaky test",
        cwd: "/code/api",
        repo: { name: "api", path: "/code/api" },
        branch: "main",
        paneId: "%7",
        terminalServer: SERVER,
        updatedAt: "2026-11-18T05:59:30.000Z",
      },
      {
        session: "solo-2",
        name: "Notes",
        engine: "codex",
        model: "gpt-5.5",
        status: "idle",
        stage: "",
        task: "",
        cwd: "/code/notes",
        repo: { name: "notes", path: "/code/notes" },
        updatedAt: "2026-11-18T05:20:00.000Z",
      },
    ],
    inbox: [],
    desk: [],
    accounts: [],
  };
}

function view(options = {}) {
  return new ChiefView(status(), { now: () => NOW, tier: "unicode", height: 40, ...options });
}

function text(lines) {
  return lines.map((line) => plain(line)).join("\n");
}

function expectFits(lines, width) {
  for (const line of lines) expect(displayWidth(plain(line))).toBeLessThanOrEqual(width);
}

describe("chief overview model", () => {
  it("groups rooms by repository with the most urgent repository and room first", () => {
    const entries = chiefEntries(status());
    expect(entries.map((entry) => entry.key)).toEqual([
      "room:room-chief",
      "room:room-docs",
      "room:room-auth",
      "session:solo-1",
      "session:solo-2",
    ]);
    expect(entries.map((entry) => entry.repo)).toEqual([
      "orkest",
      "orkest",
      "webapp",
      "api",
      "notes",
    ]);
  });

  it("derives pills, worker summaries and machine totals", () => {
    const [docs, chief, auth] = status().rooms;
    expect(chiefRoomPill(chief)).toEqual({ label: "blocked", tone: "warning" });
    expect(chiefRoomPill(auth)).toEqual({ label: "escalated", tone: "warning" });
    expect(chiefRoomPill(docs)).toEqual({ label: "done", tone: "success" });
    expect(chiefWorkerSummary(chief.counts)).toBe("3 working · 1 blocked · 1 done");
    expect(chiefWorkerSummary(chief.counts, { compact: true })).toBe("3▶ 1⚠ 1✓");
    expect(chiefWorkerSummary(chief.counts, { compact: true, tier: "ascii" })).toBe("3> 1! 1+");
    expect(chiefWorkerSummary({})).toBe("no workers");
    const fallback = chiefSummary({ ...status(), summary: undefined });
    expect(fallback).toEqual({
      orchestrators: 3,
      working: 5,
      blocked: 1,
      attention: 2,
      standalone: 2,
    });
  });

  it("normalizes pane targets for focusAgentPane and rejects pane-less members", () => {
    expect(chiefPaneTarget(status().rooms[0].coordinator)).toMatchObject({
      paneId: "%3",
      terminalServer: SERVER,
      session: { id: "coord-docs" },
    });
    expect(chiefPaneTarget(status().rooms[2].coordinator)).toBeNull();
    expect(chiefPaneTarget(null)).toBeNull();
  });
});

describe("chief overview rendering", () => {
  it("renders a 50-column side split with every repository, room and standalone session", () => {
    const lines = view().render(50);
    const output = text(lines);
    expectFits(lines, 50);
    expect(lines).toHaveLength(40);
    expect(output).toContain("★ ORK CHIEF");
    expect(output).toContain("★ Ork Chief · opus-5.5 · bound 30m ago");
    expect(output).toMatch(/3 orch · 5▶ · 1⚠ · !2 · 2 solo/u);
    expect(output).toContain("▾ orkest · 2 rooms");
    expect(output).toContain("▾ webapp · 1 room");
    expect(output).toContain("▾ Sessions · 2 not in a room");
    expect(output).toMatch(/▸ ⚠ Ork Chief side wind.*!1 3▶ 1⚠ 1✓ · blocked/u);
    expect(output).toContain("blocked: Needs a key decision");
    expect(output).toContain("escalation: Need the prod DB policy");
    expect(output).toContain("Scout · api · (main)");
    expect(output).toContain("Goal Ship the machine-wide Chief overview");
    expect(output).toContain("Enter Open room");
  });

  it("renders a wide pane with models, full worker counts and the selected room's details", () => {
    const lines = view({ lastRoomId: "room-chief" }).render(120);
    const output = text(lines);
    expectFits(lines, 120);
    expect(output).toContain("3 orchestrators · 5 working · 1 blocked · 2 need you · 2 solo");
    expect(output).toMatch(
      /Ork Chief side window · wt:pr7-ork-chief !1 +opus-5\.5 \/ high · 3 working · 1 blocked · 1 done · blocked/u,
    );
    expect(output).toMatch(/Auth rewrite · wt:auth !1 +gemini-3-pro · 2 working · escalated/u);
    expect(output).toContain("Team 3 working · 1 blocked · 1 done (5 total)");
    expect(output).toContain("Needs verifier: Needs a key decision");
    expect(output).toContain("Latest chief-tui: Chief view renders in narrow panes");
    expect(output).toContain("Where /code/orkest wt:pr7-ork-chief");
    expect(output).toContain("Room view");
  });

  it("keeps the selection visible in short panes and falls back to ASCII glyphs", () => {
    const short = view({ height: 14, tier: "ascii" });
    for (let index = 0; index < 4; index++) short.handleInput("\u{1B}[B");
    const output = text(short.render(50));
    expect(short.selectedKey).toBe("session:solo-2");
    expect(output).toContain("+ ORK CHIEF");
    expect(output).toContain("> - Notes");
    expect(output).not.toContain("Goal ");
  });

  it("shows unread chief mail, stale chiefs and an empty machine clearly", () => {
    const stale = new ChiefView(
      {
        ...status(),
        chief: null,
        staleChief: { session: "old", name: "Old Chief", reason: "pid exited" },
        inbox: [{ kind: "done", from: "Vega", text: "Merged" }],
        roomsError: "database is newer than this Orkest",
      },
      { now: () => NOW, tier: "unicode" },
    );
    const staleText = text(stale.render(80));
    expect(staleText).toContain("★ stale chief Old Chief · pid exited");
    expect(staleText).toContain("✉ 1 unread for Chief");
    expect(staleText).toContain("rooms unavailable: database is newer than this Orkest");
    const empty = new ChiefView({ rooms: [], standalone: [] }, { now: () => NOW });
    const emptyText = text(empty.render(50)).replaceAll(/[\s│]+/gu, " ");
    expect(emptyText).toContain("No chief bound · ork chief bind");
    expect(emptyText).toContain("No active orchestrators or sessions on this machine.");
    expect(empty.handleInput("\r")).toBe(false);
  });
});

describe("chief overview input", () => {
  it("drills into rooms, focuses panes and toggles modes from the keyboard", () => {
    const chief = view();
    expect(chief.handleInput("\t")).toBe(true);
    expect(chief.notice).toContain("press Enter to open its room");
    expect(chief.handleInput("\r")).toMatchObject({ type: "chief-drill", roomId: "room-chief" });
    expect(chief.lastRoomId).toBe("room-chief");
    expect(chief.handleInput("\t")).toEqual({
      type: "chief-mode",
      mode: "room",
      roomId: "room-chief",
    });
    expect(chief.handleInput("f")).toMatchObject({
      type: "chief-focus",
      target: { paneId: "%4", session: { id: "coord-chief" } },
    });
    expect(chief.handleInput("C")).toMatchObject({
      type: "chief-focus-chief",
      target: { paneId: "%9", session: { id: "chief-session-1" } },
    });
    chief.handleInput("\u{1B}[B");
    chief.handleInput("\u{1B}[B");
    expect(chief.selectedKey).toBe("room:room-auth");
    expect(chief.handleInput("o")).toBe(true);
    expect(chief.notice).toBe("This orchestrator has no live terminal pane.");
    chief.handleInput("j");
    expect(chief.handleInput("\r")).toMatchObject({
      type: "chief-focus",
      target: { paneId: "%7", session: { id: "solo-1" } },
    });
    expect(chief.handleInput("m")).toEqual({ type: "mouse-toggle", enabled: false });
    expect(chief.handleInput("?")).toBe(true);
    expect(text(chief.render(60))).toContain("Chief shortcuts");
    expect(chief.handleInput("\u{1B}")).toBe(true);
    expect(chief.overlay).toBeUndefined();
    expect(chief.handleInput("q")).toEqual({ type: "close-view" });
  });

  it("explains when no Chief pane can be focused", () => {
    const chief = new ChiefView({ ...status(), chief: null }, { now: () => NOW });
    expect(chief.handleInput("C")).toBe(true);
    expect(chief.notice).toContain("No Chief is bound");
  });

  it("selects on the first click, drills on the second and scrolls with the wheel", () => {
    const chief = view();
    chief.render(80);
    const target = chief.targets.find((item) => item.entryKey === "room:room-auth");
    expect(target).toBeDefined();
    const click = { x: target.x + 2, y: target.y, button: 0, action: "press" };
    expect(chief.handleMouse(click)).toBe(true);
    expect(chief.selectedKey).toBe("room:room-auth");
    expect(chief.handleMouse(click)).toMatchObject({ type: "chief-drill", roomId: "room-auth" });
    expect(chief.handleMouse({ x: 1, y: 1, action: "scroll-down" })).toBe(false);
    expect(chief.selectedKey).toBe("room:room-auth");
    chief.render(80);
    const help = chief.targets.find((item) => item.id === "help");
    expect(chief.handleMouse({ x: help.x, y: help.y, button: 0, action: "press" })).toBe(true);
    expect(chief.overlay).toBe("help");
  });
});

function keysOf(chief) {
  return chief.visible.map((entry) => entry.key);
}

function typeText(chief, value) {
  for (const character of value) chief.handleKey(character);
}

function deskItems(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `d-${index}`,
    kind: "question",
    from: "Lumen",
    text: `Desk item ${index}`,
    at: `2026-11-18T05:${String(10 + index).padStart(2, "0")}:00.000Z`,
  }));
}

describe("chief wheel invariant", () => {
  it("keeps selection, close confirmation and mode on wheel ticks on every main selection", () => {
    for (const entry of view().visible) {
      const chief = view({ confirmClose: true, lastRoomId: "room-chief" });
      chief.selectedKey = entry.key;
      chief.handleKey("q");
      chief.render(100);
      for (const action of ["scroll-up", "scroll-down"]) {
        expect(chief.handleMouse({ x: 4, y: 4, button: 4, action })).toBe(false);
      }
      expect(chief.selectedKey).toBe(entry.key);
      expect(chief.closeArmedAt).toBe(NOW);
      expect(chief.lastRoomId).toBe("room-chief");
      expect(chief.overlay).toBeUndefined();
    }
  });

  it("leaves selection and the help overlay untouched on wheel ticks", () => {
    const chief = view();
    chief.handleKey("?");
    chief.render(80);
    const selected = chief.selectedKey;
    for (const action of ["scroll-up", "scroll-down"]) {
      expect(chief.handleMouse({ x: 1, y: 1, action })).toBe(false);
    }
    expect(chief.selectedKey).toBe(selected);
    expect(chief.overlay).toBe("help");
  });
});

describe("chief search, attention and selection", () => {
  it("matches each searchable field case-insensitively and Esc restores the list", () => {
    const cases = {
      webapp: ["room:room-auth"],
      "feat/ork": ["room:room-chief"],
      PR7: ["room:room-chief"],
      "docs refresh": ["room:room-docs"],
      "room-auth": ["room:room-auth"],
      lumen: ["room:room-chief"],
      "coord-auth": ["room:room-auth"],
      scout: ["session:solo-1"],
      "solo-2": ["session:solo-2"],
      NOTES: ["session:solo-2"],
    };
    for (const [query, expected] of Object.entries(cases)) {
      const chief = view();
      chief.handleKey("/");
      typeText(chief, query);
      expect(keysOf(chief), query).toEqual(expected);
      chief.handleKey("\u{1B}");
      expect(chief.prompt).toBeNull();
      expect(chief.query).toBe("");
      expect(keysOf(chief)).toHaveLength(5);
    }
  });

  it("treats typed q, a, x, i, / and spaces as filter text and keeps the filter on Enter", () => {
    const chief = view();
    chief.handleKey("/");
    typeText(chief, "auth");
    expect(chief.handleKey("\r")).toBe(true);
    expect(chief.prompt).toBeNull();
    expect(chief.query).toBe("auth");
    expect(keysOf(chief)).toEqual(["room:room-auth"]);
    expect(chief.handleKey("\u{7F}")).toBe(false);
  });

  it("intersects the attention filter with search and reports no match without moving selection", () => {
    const chief = view();
    chief.handleKey("a");
    expect(keysOf(chief)).toEqual(["room:room-chief", "room:room-auth"]);
    chief.handleKey("/");
    typeText(chief, "docs");
    expect(keysOf(chief)).toEqual([]);
    expect(chief.notice).toContain("No match");
    expect(chief.selectedKey).toBe("room:room-chief");
    expect(chief.handleKey("\r")).toBe(true);
    chief.handleKey("\u{1B}");
    expect(chief.attentionOnly).toBe(false);
    expect(keysOf(chief)).toHaveLength(5);
  });

  it("wraps n once through visible attention entries and reports when nothing matches", () => {
    const chief = view();
    expect(chief.selectedKey).toBe("room:room-chief");
    chief.handleKey("n");
    expect(chief.selectedKey).toBe("room:room-auth");
    chief.handleKey("n");
    expect(chief.selectedKey).toBe("room:room-chief");
    chief.handleKey("/");
    typeText(chief, "zzz");
    chief.handleKey("\r");
    expect(chief.handleKey("n")).toBe(true);
    expect(chief.notice).toContain("Nothing");
    expect(chief.selectedKey).toBe("room:room-chief");
  });
});

describe("chief compose line", () => {
  it("keeps composing keys as text and emits the frozen reply exactly once", () => {
    const chief = view();
    expect(chief.handleKey("r")).toBe(true);
    expect(chief.prompt).toMatchObject({
      kind: "reply",
      target: "room-chief",
      targetLabel: "Ork Chief side window",
    });
    typeText(chief, "qax i/ ok");
    expect(chief.handleKey("\r")).toEqual({
      type: "chief-reply",
      target: "room-chief",
      targetLabel: "Ork Chief side window",
      text: "qax i/ ok",
    });
    expect(chief.prompt).toBeNull();
    expect(chief.handleKey("\r")).toMatchObject({ type: "chief-drill", roomId: "room-chief" });
  });

  it("retains the prompt for whitespace Enter and trims a real reply", () => {
    const chief = view({ lastRoomId: undefined });
    chief.handleKey("r");
    typeText(chief, " ".repeat(3));
    expect(chief.handleKey("\r")).toBe(true);
    expect(chief.prompt.text).toBe(" ".repeat(3));
    chief.handleKey("\u{7F}");
    typeText(chief, " hi ");
    expect(chief.handleKey("\r")).toMatchObject({ type: "chief-reply", text: "hi" });
  });

  it("removes whole graphemes on backspace and cancels on Esc", () => {
    const chief = view();
    chief.handleKey("r");
    typeText(chief, "中文");
    chief.handleKey("\u{7F}");
    expect(chief.prompt.text).toBe("中");
    typeText(chief, "👨‍👩‍👧");
    chief.handleKey("\b");
    expect(chief.prompt.text).toBe("中");
    typeText(chief, "x");
    expect(chief.handleKey("\u{1B}")).toBe(true);
    expect(chief.prompt).toBeNull();
    expect(chief.notice).toBe("Reply cancelled.");
  });

  it("filters terminal control characters out of typed text", () => {
    const chief = view();
    chief.handleKey("r");
    chief.handleKey("\u{7}");
    chief.handleKey("a\tb\u{1B}[31m");
    expect(chief.prompt.text).toBe("ab");
  });

  it("cancels with a notice when a refresh removes the original target", () => {
    const chief = view();
    chief.handleKey("r");
    typeText(chief, "hi");
    const without = {
      ...status(),
      rooms: status().rooms.filter((room) => room.id !== "room-chief"),
    };
    chief.setStatus(without);
    expect(chief.prompt).toBeNull();
    expect(chief.notice).toContain("no longer listed");
  });

  it("replies to a standalone session by its raw session ID", () => {
    const chief = view();
    chief.handleKey("\u{1B}[B");
    chief.handleKey("\u{1B}[B");
    chief.handleKey("\u{1B}[B");
    expect(chief.selectedKey).toBe("session:solo-1");
    chief.handleKey("r");
    typeText(chief, "ok");
    expect(chief.handleKey("\r")).toEqual({
      type: "chief-reply",
      target: "solo-1",
      targetLabel: "Scout",
      text: "ok",
    });
  });
});

describe("chief desk drawer", () => {
  function deskView(extra = {}) {
    return new ChiefView(
      {
        ...status(),
        desk: [
          {
            id: "d-b",
            kind: "escalation",
            from: "Vega",
            text: "Desk beta",
            at: "2026-11-18T05:55:00.000Z",
          },
          {
            id: "d-c",
            kind: "done",
            from: "Quill",
            text: "Desk gamma",
            at: "2026-11-18T05:55:00.000Z",
          },
        ],
        inbox: [
          {
            id: "i-a",
            kind: "question",
            from: "",
            text: "Inbox alpha",
            at: "2026-11-18T05:59:00.000Z",
          },
        ],
        ...extra,
      },
      { now: () => NOW, tier: "unicode", height: 40 },
    );
  }

  it("lists newest first with an ID tie-break and closes on i or Esc", () => {
    const chief = deskView();
    chief.handleKey("i");
    const output = text(chief.render(100));
    expect(output).toContain("Chief desk & inbox");
    expect(output.indexOf("Inbox alpha")).toBeLessThan(output.indexOf("Desk beta"));
    expect(output.indexOf("Desk beta")).toBeLessThan(output.indexOf("Desk gamma"));
    expect(output).toContain("Unattributed · question");
    expect(chief.handleKey("\u{1B}")).toBe(true);
    expect(chief.drawerOpen).toBe(false);
    chief.handleKey("i");
    expect(chief.handleKey("i")).toBe(true);
    expect(chief.drawerOpen).toBe(false);
  });

  it("acknowledges only while open and only identified items", () => {
    const chief = deskView();
    expect(chief.handleKey("A")).toBe(false);
    chief.handleKey("i");
    expect(chief.handleKey("A")).toEqual({ type: "chief-ack-desk" });
    const legacy = new ChiefView(
      { ...status(), desk: [{ kind: "done", from: "Quill", text: "No id" }] },
      { now: () => NOW, tier: "unicode" },
    );
    legacy.handleKey("i");
    expect(legacy.handleKey("A")).toBe(true);
    expect(legacy.notice).toContain("no item IDs");
    const empty = new ChiefView({ ...status(), desk: [], inbox: [] }, { now: () => NOW });
    empty.handleKey("i");
    expect(text(empty.render(80))).toContain("Nothing is waiting for Chief.");
    expect(empty.handleKey("A")).toBe(true);
    expect(empty.notice).toContain("Nothing is waiting");
  });

  it("scrolls a clamped drawer with keys and wheel while selection stays put", () => {
    const chief = new ChiefView(
      { ...status(), desk: deskItems(7) },
      { now: () => NOW, height: 40 },
    );
    chief.handleKey("i");
    chief.render(100);
    const selected = chief.selectedKey;
    for (let index = 0; index < 6; index++) chief.handleKey("\u{1B}[B");
    expect(chief.drawerOffset).toBe(2);
    expect(chief.handleMouse({ x: 1, y: 1, action: "scroll-up" })).toBe(true);
    expect(chief.drawerOffset).toBe(1);
    for (let index = 0; index < 4; index++) chief.handleMouse({ x: 1, y: 1, action: "scroll-up" });
    expect(chief.drawerOffset).toBe(0);
    expect(chief.handleMouse({ x: 1, y: 1, action: "scroll-up" })).toBe(false);
    expect(chief.selectedKey).toBe(selected);
  });

  it("does not let a click through the drawer reach a list row", () => {
    const chief = deskView();
    chief.render(100);
    chief.handleKey("i");
    chief.render(100);
    const drawer = chief.targets.find((target) => target.id === "drawer");
    expect(drawer).toBeDefined();
    const selected = chief.selectedKey;
    expect(
      chief.handleMouse({ x: drawer.x + 3, y: drawer.y + 1, button: 0, action: "press" }),
    ).toBe(false);
    expect(chief.selectedKey).toBe(selected);
  });

  it("clamps the drawer offset after a resize shrinks the drawer", () => {
    const chief = new ChiefView(
      { ...status(), desk: deskItems(7) },
      { now: () => NOW, height: 40 },
    );
    chief.handleKey("i");
    chief.render(100);
    chief.handleMouse({ x: 1, y: 1, action: "scroll-down" });
    chief.handleMouse({ x: 1, y: 1, action: "scroll-down" });
    expect(chief.drawerOffset).toBe(2);
    chief.height = 12;
    const lines = chief.render(100);
    expect(chief.drawerOffset).toBeLessThanOrEqual(chief.drawerMaxOffset());
    expect(lines).toHaveLength(12);
    expect(text(lines)).toContain("of 7");
  });
});

describe("chief room close arming", () => {
  function quietStatus() {
    const value = status();
    value.rooms[2].coordinator.status = "idle";
    value.rooms[2].counts = { working: 0, blocked: 0, done: 0, idle: 3, total: 3 };
    return value;
  }

  it("closes on a second x within the interval and only for the armed room", () => {
    let nowMs = NOW;
    const chief = new ChiefView(quietStatus(), { now: () => nowMs, tier: "unicode", height: 40 });
    chief.handleKey("\u{1B}[B");
    expect(chief.selectedKey).toBe("room:room-docs");
    expect(chief.handleKey("x")).toBe(true);
    expect(chief.notice).toContain("Press x again");
    nowMs += 2000;
    expect(chief.handleKey("x")).toEqual({ type: "chief-close-room", roomId: "room-docs" });
    expect(chief.handleKey("x")).toBe(true);
  });

  it("disarms on timeout and when the selection changes to another room", () => {
    let nowMs = NOW;
    const chief = new ChiefView(quietStatus(), { now: () => nowMs, tier: "unicode", height: 40 });
    chief.handleKey("\u{1B}[B");
    chief.handleKey("x");
    nowMs += 3001;
    expect(chief.handleKey("x")).toBe(true);
    expect(chief.handleKey("x")).toEqual({ type: "chief-close-room", roomId: "room-docs" });
    chief.handleKey("x");
    chief.handleKey("\u{1B}[B");
    expect(chief.selectedKey).toBe("room:room-auth");
    expect(chief.roomClose).toBeUndefined();
    expect(chief.handleKey("x")).toBe(true);
    expect(chief.roomClose).toMatchObject({ roomId: "room-auth" });
  });

  it("refuses live rooms, standalone sessions and empty selections without arming", () => {
    const chief = view();
    chief.handleKey("x");
    expect(chief.notice).toContain("still working");
    expect(chief.roomClose).toBeUndefined();
    chief.handleKey("x");
    expect(chief.roomClose).toBeUndefined();
    chief.selectedKey = "session:solo-1";
    expect(chief.handleKey("x")).toBe(true);
    expect(chief.notice).toContain("Only orchestrator rooms");
    chief.handleKey("/");
    typeText(chief, "zzz");
    chief.handleKey("\r");
    expect(chief.handleKey("x")).toBe(true);
    expect(chief.roomClose).toBeUndefined();
  });

  it("disarms on mouse press and when the armed room disappears", () => {
    const chief = new ChiefView(quietStatus(), { now: () => NOW, tier: "unicode", height: 40 });
    chief.handleKey("\u{1B}[B");
    chief.handleKey("x");
    chief.render(80);
    const target = chief.targets.find((item) => item.entryKey === "room:room-chief");
    chief.handleMouse({ x: target.x + 2, y: target.y, button: 0, action: "press" });
    expect(chief.roomClose).toBeUndefined();
    chief.selectedKey = "room:room-docs";
    chief.handleKey("x");
    chief.setStatus({
      ...quietStatus(),
      rooms: quietStatus().rooms.filter((r) => r.id !== "room-docs"),
    });
    expect(chief.roomClose).toBeUndefined();
  });
});

describe("chief compose and drawer rendering", () => {
  function hostile() {
    const value = status();
    value.rooms[1].title = "数据库迁移 🚀 \u{1B}[31mred\u{1B}[0m\u{7}bell";
    value.rooms[1].coordinator.name = "Quill 👩🏽‍💻";
    value.desk = [
      {
        id: "h-1",
        kind: "question",
        from: "拉丝\u{1B}[2J",
        text: `${"long reply words ".repeat(20)}END-OF-TEXT`,
        at: "2026-11-18T05:59:00.000Z",
      },
    ];
    return value;
  }

  it.each([48, 100, 160])(
    "fits every line and the height at %i columns with color on and off, Unicode and ASCII",
    (width) => {
      for (const color of [false, true]) {
        for (const tier of ["unicode", "ascii"]) {
          const chief = new ChiefView(hostile(), { now: () => NOW, tier, color, height: 22 });
          chief.handleKey("i");
          chief.handleKey("r");
          typeText(chief, "a long reply ".repeat(6));
          const lines = chief.render(width);
          expect(lines).toHaveLength(22);
          expectFits(lines, width);
          expect(text(lines)).not.toContain("\u{7}");
          expect(text(lines)).not.toContain("[31m");
        }
      }
    },
  );

  it("shows the editable tail of a long reply and the drawer sender and kind at 48 columns", () => {
    const chief = new ChiefView(hostile(), { now: () => NOW, tier: "unicode", height: 22 });
    chief.handleKey("i");
    chief.handleKey("\u{1B}[B");
    chief.handleKey("\u{1B}[A");
    chief.handleKey("r");
    typeText(chief, "a long reply ".repeat(4));
    typeText(chief, "tail-marker");
    const output = text(chief.render(48));
    expect(output).toContain("Reply to");
    expect(output).toContain("tail-marker");
    expect(output).toContain("question");
    expect(output).toContain("Enter sends");
  });

  it("keeps the selection and the prompt visible at a short height with long CJK names", () => {
    const chief = new ChiefView(hostile(), { now: () => NOW, tier: "unicode", height: 14 });
    chief.lastRoomId = "room-docs";
    chief.selectedKey = "room:room-docs";
    chief.handleKey("r");
    typeText(chief, "short");
    const lines = chief.render(48);
    const output = text(lines);
    expect(lines).toHaveLength(14);
    expect(output).toContain("▸");
    expect(output).toContain("Reply to");
    expect(output).toContain("short▏");
  });

  it("shows extra room context at wide widths and the full key list in help", () => {
    const wide = text(view({ lastRoomId: "room-chief" }).render(160));
    expect(wide).toContain("Goal Ship the machine-wide Chief overview");
    const chief = view();
    chief.handleKey("?");
    const help = text(chief.render(48));
    for (const word of ["Filter", "attention", "Reply", "Chief desk", "Close the selected"]) {
      expect(help).toContain(word);
    }
  });

  it("hit-tests the rerendered frame after a resize", () => {
    const chief = view();
    chief.render(160);
    chief.render(48);
    const target = chief.targets.find((item) => item.entryKey === "room:room-auth");
    expect(target).toBeDefined();
    const click = { x: target.x + 2, y: target.y, button: 0, action: "press" };
    expect(chief.handleMouse(click)).toBe(true);
    expect(chief.selectedKey).toBe("room:room-auth");
    expect(chief.handleMouse(click)).toMatchObject({ type: "chief-drill", roomId: "room-auth" });
  });
});

describe("single-room chief hint", () => {
  function room() {
    const value = createRoom(parseTeam("claude:haiku,agy:flash"), { id: "hint-room", now: 1000 });
    value.conductor.status = "running";
    value.conductor.session = { id: "coord-session" };
    return value;
  }

  it("leaves the default room view byte-identical when no Chief is bound", () => {
    const baseline = new HordeView(room(), { now: () => 5000, tier: "unicode", color: true });
    const unbound = new HordeView(
      { ...room(), chief: null },
      { now: () => 5000, tier: "unicode", color: true },
    );
    expect(unbound.render(100)).toEqual(baseline.render(100));
    expect(text(baseline.render(100))).not.toContain("★");
  });

  it("marks only the bound Chief's own room as ★ chief desk and leaves other rooms unbadged", () => {
    const baseline = new HordeView(room(), { now: () => 5000, tier: "unicode" });
    const other = new HordeView(
      { ...room(), liveChief: { schema: "ork.chief.v1", live: true, session: "someone-else" } },
      { now: () => 5000, tier: "unicode" },
    );
    expect(other.render(100)).toEqual(baseline.render(100));
    expect(text(other.render(100))).not.toContain("★ chief");
    expect(text(other.render(100))).not.toContain("chief desk");
    const desk = new HordeView(
      { ...room(), liveChief: { schema: "ork.chief.v1", live: true, session: "coord-session" } },
      { now: () => 5000, tier: "ascii" },
    );
    expect(text(desk.render(100))).toContain("* chief desk");

    const mailboxDeskRoom = room();
    delete mailboxDeskRoom.conductor.session;
    mailboxDeskRoom.conductor.mailboxSession = "chief-desk-mailbox";
    mailboxDeskRoom.liveChief = {
      schema: "ork.chief.v1",
      live: true,
      session: "chief-desk-mailbox",
    };
    expect(
      text(new HordeView(mailboxDeskRoom, { now: () => 5000, tier: "ascii" }).render(100)),
    ).toContain("* chief desk");

    const missionMetadataOnly = new HordeView(
      { ...room(), chief: { goal: "Mission metadata", state: "running" } },
      { now: () => 5000, tier: "unicode" },
    );
    expect(text(missionMetadataOnly.render(100))).not.toContain("★ chief");
  });

  it("supports Orca pane targets and Herdr confirmClose / mouse-off hints in ChiefView", () => {
    expect(
      chiefPaneTarget({
        id: "orca-only",
        session: "sess-orca",
        orcaTerminalHandle: "term_chief",
        orcaPaneKey: "pane-chief",
        orcaWorkspaceId: "ws-1",
        orcaTabId: "tab-1",
        orcaEnvironment: "ssh:box",
      }),
    ).toEqual({
      id: "sess-orca",
      name: "",
      engine: "",
      herdrPaneId: undefined,
      herdrEndpoint: undefined,
      orcaEnvironment: "ssh:box",
      orcaPaneKey: "pane-chief",
      orcaTabId: "tab-1",
      orcaTerminalHandle: "term_chief",
      orcaWorkspaceId: "ws-1",
      paneId: undefined,
      terminalServer: undefined,
      session: { id: "sess-orca" },
    });

    let nowMs = 1000;
    const chief = new ChiefView(status(), {
      now: () => nowMs,
      height: 28,
      confirmClose: true,
      mouseEnabled: true,
      tier: "unicode",
    });
    expect(plain(chief.render(80).join("\n"))).toContain("Press q twice to close this pane");
    expect(chief.handleKey("q")).toBe(true);
    expect(chief.closeArmedAt).toBe(1000);
    expect(chief.notice).toContain("Press q again");
    // Non-q key disarms pending close.
    expect(chief.handleKey("j")).toBe(true);
    expect(chief.closeArmedAt).toBeUndefined();
    expect(chief.handleKey("q")).toBe(true);
    expect(chief.closeArmedAt).toBe(1000);
    // Mouse button press also disarms pending close.
    chief.handleMouse({ x: 0, y: 0, button: 0, action: "press" });
    expect(chief.closeArmedAt).toBeUndefined();
    expect(chief.handleKey("q")).toBe(true);
    nowMs = 2000;
    expect(chief.handleKey("q")).toEqual({ type: "close-view" });

    chief.overlay = "help";
    expect(plain(chief.render(80).join("\n"))).toContain("q twice");
    chief.overlay = undefined;
    chief.mouseEnabled = false;
    chief.notice = "";
    expect(plain(chief.render(80).join("\n"))).toContain(
      "Mouse off (select/copy) — press m to re-enable mouse",
    );
  });
});

function terminal() {
  // eslint-disable-next-line unicorn/prefer-event-target -- The TUI consumes Node terminal stream events.
  const input = Object.assign(new EventEmitter(), {
    isTTY: true,
    isRaw: false,
    setRawMode: vi.fn((raw) => {
      input.isRaw = raw;
    }),
    resume() {},
    pause() {},
  });
  const output = { isTTY: true, rows: 36, columns: 60, frames: "" };
  output.write = (chunk) => {
    output.frames += chunk;
  };
  return { input, output };
}

describe("chief side window runner", () => {
  it("drills from the overview into a room and back with Enter, Backspace, Tab and Esc", async () => {
    const { input, output } = terminal();
    const rooms = new Map(
      ["room-chief", "room-docs"].map((id) => {
        const value = createRoom(parseTeam("claude:haiku"), { id, now: 1000 });
        value.title = id === "room-chief" ? "Chief window build" : "Docs build";
        if (id === "room-chief") {
          value.conductor.session = {
            id: "chief-session-1",
            engine: "claude",
            machine: "kahuna",
            cwd: "/repo",
          };
        }
        return [id, value];
      }),
    );
    const loadRoom = vi.fn(async (id) => structuredClone(rooms.get(id)));
    const exec = vi.fn((command, args, callback) => callback(null, ""));
    const running = runHordeTui(undefined, {
      input,
      output,
      exec,
      env: {},
      quota: false,
      services: false,
      update: false,
      chief: { loadStatus: async () => status(), loadRoom, initialMode: "chief" },
    });
    const latest = () => plain(output.frames);
    const press = async (key, expected) => {
      output.frames = "";
      input.emit("data", key);
      await vi.waitFor(() => expect(latest()).toContain(expected));
    };
    try {
      await vi.waitFor(() => expect(latest()).toContain("ORK CHIEF"));
      await press("\r", "Chief window build");
      expect(loadRoom).toHaveBeenCalledWith("room-chief");
      expect(latest()).toContain("★ chief desk");
      await press("\u{7F}", "ORK CHIEF");
      await press("\t", "Chief window build");
      await press("\u{1B}", "ORK CHIEF");
      await press("\u{1B}[B", "Docs refresh");
      await press("\r", "Docs build");
      expect(loadRoom).toHaveBeenLastCalledWith("room-docs");
      expect(latest().slice(latest().lastIndexOf("Swarm · Docs build"))).not.toContain("★ chief");
      await press("\t", "ORK CHIEF");
      output.frames = "";
      input.emit("data", "f");
      await vi.waitFor(() => expect(latest()).toContain("Opened Quill"));
      expect(exec).toHaveBeenCalledWith(
        "tmux",
        ["-L", SERVER, "select-pane", "-t", "%3"],
        expect.any(Function),
      );
      output.frames = "";
      input.emit("data", "C");
      await vi.waitFor(() => expect(latest()).toContain("Opened Ork Chief"));
      expect(exec).toHaveBeenCalledWith(
        "tmux",
        ["-L", SERVER, "select-pane", "-t", "%9"],
        expect.any(Function),
      );
    } finally {
      input.emit("data", "q");
      await running;
    }
  });

  it("keeps Tab and Backspace inert in a plain room view without Chief mode", async () => {
    const { input, output } = terminal();
    const room = createRoom(parseTeam("claude:haiku"), { id: "plain-room", now: 1000 });
    room.title = "Plain room";
    const running = runHordeTui(async () => structuredClone(room), {
      input,
      output,
      env: {},
      quota: false,
      services: false,
      update: false,
    });
    try {
      await vi.waitFor(() => expect(plain(output.frames)).toContain("Plain room"));
      input.emit("data", "\t");
      input.emit("data", "\u{7F}");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(plain(output.frames)).not.toContain("ORK CHIEF");
      expect(plain(output.frames)).not.toContain("★ chief");
    } finally {
      input.emit("data", "q");
      await running;
    }
  });
});

describe("ork horde --view --chief", () => {
  async function fixture() {
    const directory = await mkdtemp(path.join(tmpdir(), "chief-view-test-"));
    temporary.push(directory);
    const file = path.join(directory, "status.json");
    await writeFile(file, JSON.stringify(status()));
    return { directory, file };
  }

  it("prints the overview for a 50-column side split and passes JSON through", async () => {
    const { directory, file } = await fixture();
    const env = { ...process.env, ORK_GLYPHS: "unicode", ORCHESTRATE_HOME: directory };
    const printed = await execute(
      "node",
      [cli, "horde", "--view", "--chief", "--fixture", file, "--print", "--width", "50"],
      { env },
    );
    const lines = printed.stdout.trimEnd().split("\n");
    expectFits(lines, 50);
    expect(printed.stdout).toContain("★ ORK CHIEF");
    expect(printed.stdout).toContain("▾ Sessions · 2 not in a room");
    expect(printed.stdout).not.toMatch(/\n\n/u);
    const json = await execute("node", [cli, "horde", "--chief", "--fixture", file, "--json"], {
      env,
    });
    expect(JSON.parse(json.stdout).rooms.map((room) => room.id)).toEqual([
      "room-docs",
      "room-chief",
      "room-auth",
    ]);
  });

  it("refuses to launch work from the read-only overview", async () => {
    const { directory } = await fixture();
    await expect(
      execute("node", [cli, "horde", "--view", "--chief", "--team", "claude:haiku"], {
        env: { ...process.env, ORCHESTRATE_HOME: directory },
      }),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("--chief is a read-only overview") });
  });
});

describe("chief worktree badges", () => {
  const withWorktree = (worktree, title = "Badge room", extra = {}) => {
    const data = status();
    data.rooms = [
      {
        ...data.rooms[0],
        id: "room-badge",
        title,
        worktree: { slug: "badge", path: "/code/orkest/.worktrees/badge", ...worktree },
        ...extra,
      },
    ];
    data.standalone = [];
    return data;
  };
  const render = (data, width, options = {}) =>
    new ChiefView(data, { now: () => NOW, tier: "unicode", height: 20, ...options }).render(width);
  const ports = [
    { name: "api", port: 31_042 },
    { name: "web", port: 31_043 },
    { name: "db", port: 31_044 },
  ];

  it("derives :port (+N) and #number state badges, with [] / null for absent data", () => {
    expect(chiefPortBadge({ worktree: { ports } })).toBe(":31042 (+2)");
    expect(chiefPortBadge({ worktree: { ports: [ports[0]] } })).toBe(":31042");
    expect(chiefPortBadge({ worktree: { ports: [] } })).toBe("");
    expect(chiefPortBadge({ worktree: {} })).toBe("");
    expect(chiefPortBadge({ worktree: { ports: [{ port: "x" }, null, { port: 70_000 }] } })).toBe(
      "",
    );
    expect(chiefPrBadge({ worktree: { pr: { number: 231, state: "OPEN" } } })).toEqual({
      text: "● #231 open",
      tone: "running",
    });
    expect(chiefPrBadge({ worktree: { pr: { number: 231, state: "MERGED" } } }, "ascii")).toEqual({
      text: "+ #231 merged",
      tone: "success",
    });
    expect(chiefPrBadge({ worktree: { pr: { number: 7, state: "weird" } } }).text).toBe(
      "? #7 unknown",
    );
    expect(chiefPrBadge({ worktree: { pr: { number: 0, state: "OPEN" } } })).toBeNull();
    expect(chiefPrBadge({ worktree: { pr: null } })).toBeNull();
    expect(chiefPrBadge({})).toBeNull();
  });

  it("attaches normalized ports and pr to entries and searches them", () => {
    const entries = chiefEntries(withWorktree({ ports, pr: { number: 231, state: "OPEN" } }));
    expect(entries[0].ports).toHaveLength(3);
    expect(entries[0].pr).toEqual({ number: 231, state: "OPEN" });
    const bare = chiefEntries(status());
    for (const entry of bare) {
      expect(entry.ports).toEqual([]);
      expect(entry.pr).toBeNull();
    }
    const chief = new ChiefView(withWorktree({ ports, pr: { number: 231, state: "OPEN" } }), {
      now: () => NOW,
      tier: "unicode",
      height: 20,
    });
    chief.handleKey("/");
    for (const character of "#231") chief.handleKey(character);
    expect(text(chief.render(100))).toContain("Badge room");
  });

  it.each([48, 100, 160])("shows both badges within %i columns, Unicode and ASCII", (width) => {
    for (const tier of ["unicode", "ascii"]) {
      const data = withWorktree({ ports, pr: { number: 231, state: "MERGED" } });
      const lines = render(data, width, { tier, color: true });
      expectFits(lines, width);
      const output = text(lines);
      expect(output).toContain(tier === "ascii" ? "+ #231 merged" : "✓ #231 merged");
      if (width >= 100) expect(output).toContain(":31042 (+2)");
    }
  });

  it("shortens the name before dropping the port badge and always keeps the PR state at 48", () => {
    const long = "A very long room name that must be abbreviated";
    const both = withWorktree({ ports, pr: { number: 231, state: "OPEN" } }, long);
    const medium = text(render(both, 60));
    expect(medium).toContain(":31042 (+2)");
    expect(medium).toContain("#231 open");
    expect(medium).toContain("…");
    const narrow = text(render(both, 48));
    expect(narrow).toContain("#231 open");
    for (const state of ["OPEN", "MERGED", "CLOSED", "UNKNOWN"]) {
      const data = withWorktree({ ports, pr: { number: 231, state } }, long);
      const lines = render(data, 48);
      expectFits(lines, 48);
      expect(text(lines)).toContain(`#231 ${state.toLowerCase()}`);
    }
    const portOnly = text(render(withWorktree({ ports }, long), 48));
    expect(portOnly).toMatch(/:31042|\.\.\.|…/u);
  });

  it("omits badges entirely for legacy and absent worktree data", () => {
    for (const worktree of [{}, { ports: [], pr: null }, { ports: undefined }]) {
      const data = withWorktree(worktree);
      const output = text(render(data, 100));
      const hasBadge = /#\d|:\d{4,5}/u.test(output);
      expect(hasBadge).toBe(false);
    }
    const bare = withWorktree(null);
    expect(text(render(bare, 100))).toContain("Badge room");
  });

  it("keeps widths with CJK, combining marks and emoji names, selected or not", () => {
    for (const name of [
      "日本語のとても長い部屋の名前です",
      "e\u{301}e\u{301}e\u{301}e\u{301} ñ̃ñ̃ room",
      "🚀🚀 launch pad deploy room",
    ]) {
      for (const width of [48, 100, 160]) {
        const data = withWorktree({ ports, pr: { number: 231, state: "OPEN" } }, name);
        const chief = new ChiefView(data, {
          now: () => NOW,
          tier: "unicode",
          height: 20,
          color: true,
        });
        chief.selectedKey = "room:room-badge";
        const lines = chief.render(width);
        expectFits(lines, width);
        expect(text(lines)).toContain("#231 open");
        expectFits(
          new ChiefView(data, { now: () => NOW, tier: "unicode", height: 20 }).render(width),
          width,
        );
      }
    }
  });

  it("never offers an external call: rendering reads only the snapshot", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    render(withWorktree({ ports, pr: { number: 231, state: "OPEN" } }), 100);
    vi.unstubAllGlobals();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
