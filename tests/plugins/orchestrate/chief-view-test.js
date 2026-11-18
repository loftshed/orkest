import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runHordeTui } from "../../../plugins/orchestrate/bin/horde-tui.mjs";
import {
  chiefEntries,
  chiefPaneTarget,
  chiefRoomPill,
  chiefSummary,
  ChiefView,
  chiefWorkerSummary,
} from "../../../plugins/orchestrate/lib/chief-view.mjs";
import { createRoom, parseTeam } from "../../../plugins/orchestrate/lib/horde-room.mjs";
import { HordeView } from "../../../plugins/orchestrate/lib/horde-view.mjs";
import { displayWidth, plain } from "../../../plugins/orchestrate/lib/tui-box.mjs";

const execute = promisify(execFile);
const cli = path.resolve("plugins/orchestrate/bin/ork.mjs");
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
    expect(chief.handleMouse({ x: 1, y: 1, action: "scroll-down" })).toBe(true);
    expect(chief.selectedKey).toBe("session:solo-1");
    chief.render(80);
    const help = chief.targets.find((item) => item.id === "help");
    expect(chief.handleMouse({ x: help.x, y: help.y, button: 0, action: "press" })).toBe(true);
    expect(chief.overlay).toBe("help");
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

  it("marks a room view with ★ chief, and the Chief's own room as its desk", () => {
    const other = new HordeView(
      { ...room(), chief: { session: "someone-else" } },
      { now: () => 5000, tier: "unicode" },
    );
    expect(text(other.render(100))).toContain("★ chief");
    expect(text(other.render(100))).not.toContain("chief desk");
    const desk = new HordeView(
      { ...room(), chief: { session: "coord-session" } },
      { now: () => 5000, tier: "ascii" },
    );
    expect(text(desk.render(100))).toContain("* chief desk");
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
      expect(latest()).toContain("★ chief");
      await press("\u{7F}", "ORK CHIEF");
      await press("\t", "Chief window build");
      await press("\u{1B}", "ORK CHIEF");
      await press("\u{1B}[B", "Docs refresh");
      await press("\r", "Docs build");
      expect(loadRoom).toHaveBeenLastCalledWith("room-docs");
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
