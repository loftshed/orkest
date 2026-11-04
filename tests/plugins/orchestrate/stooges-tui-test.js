import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  focusAgentPane,
  notifyHerdrTransitions,
  runHordeTui,
  runStoogesTui,
} from "../../../plugins/orchestrate/bin/horde-tui.mjs";
import * as hordeTuiModule from "../../../plugins/orchestrate/bin/horde-tui.mjs";
import { runTui } from "../../../plugins/orchestrate/bin/stooges-tui.mjs";
import * as stoogesTuiModule from "../../../plugins/orchestrate/bin/stooges-tui.mjs";
import * as factoryModule from "../../../plugins/orchestrate/lib/factory.mjs";
import * as foundryModule from "../../../plugins/orchestrate/lib/foundry.mjs";
import * as hordeRoomModule from "../../../plugins/orchestrate/lib/horde-room.mjs";
import { HordeView, normalizeAgent } from "../../../plugins/orchestrate/lib/horde-view.mjs";
import * as hordeViewModule from "../../../plugins/orchestrate/lib/horde-view.mjs";
import {
  addMembers,
  createRoom,
  parseTeam,
  readRoom,
  roomPath,
  updateRoom,
  validateRoom,
} from "../../../plugins/orchestrate/lib/stooges-room.mjs";
import * as stoogesRoomModule from "../../../plugins/orchestrate/lib/stooges-room.mjs";
import {
  normalizeModelAndEffort,
  shortAgentName,
  StoogesView,
} from "../../../plugins/orchestrate/lib/stooges-view.mjs";
import * as stoogesViewModule from "../../../plugins/orchestrate/lib/stooges-view.mjs";
import {
  ANSI,
  cellWidth,
  displayWidth,
  fit,
  fitStyled,
  frame,
  GLYPHS,
  glyphTier,
  plain,
  progressBar,
  renderPanel,
  renderTable,
  tone,
  wrapText,
} from "../../../plugins/orchestrate/lib/tui-box.mjs";

const exec = promisify(execFile);
const cli = path.resolve("plugins/orchestrate/bin/ork.mjs");
const temporary = [];
async function directory() {
  const dir = await mkdtemp(path.join(tmpdir(), "stooges-test-"));
  temporary.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function fixture(team = "claude:haiku,agy:flash,codex:luna:max") {
  const room = createRoom(parseTeam(team), { id: "sample-room", now: 1000 });
  room.conductor.status = "running";
  room.agents[0].status = "running";
  room.agents[0].output = ["Inspecting source", "Found two candidates"];
  room.agents[1].status = "blocked";
  room.agents[1].question = "Which branch should I review?";
  room.agents[1].output = ["Waiting for branch"];
  room.messages = [
    { from: "haiku-1", text: "Source inspected" },
    { from: "haiku-1", text: "Source inspected" },
  ];
  return room;
}

describe("swarm rooms", () => {
  it("expands mixed-provider teams with effort and distinct member identities", () => {
    const room = createRoom(parseTeam("claude:haiku*2,agy:flash*2,codex:luna:max"));
    expect(
      room.agents.map(({ id, model, effort, status }) => ({ id, model, effort, status })),
    ).toEqual([
      { id: "haiku-1", model: "haiku", effort: undefined, status: "queued" },
      { id: "haiku-2", model: "haiku", effort: undefined, status: "queued" },
      { id: "flash-1", model: "gemini:fast", effort: undefined, status: "queued" },
      { id: "flash-2", model: "gemini:fast", effort: undefined, status: "queued" },
      { id: "luna-1", model: "gpt:luna", effort: "max", status: "queued" },
    ]);
  });

  it.each([
    "",
    "claude:haiku*0",
    "claude:haiku*65",
    "codex",
    "unknown:luna",
    "codex::",
    "agy:flash,",
  ])("rejects invalid team %s", (team) => {
    expect(() => parseTeam(team)).toThrow();
  });

  it("preserves concurrent additions and existing conductor output", async () => {
    const root = await directory();
    await updateRoom("sample-room", () => fixture(), { root, create: true });
    await Promise.all([
      updateRoom("sample-room", (room) => addMembers(room, parseTeam("claude:haiku")), { root }),
      updateRoom("sample-room", (room) => addMembers(room, parseTeam("claude:haiku")), { root }),
    ]);
    const room = await readRoom("sample-room", root);
    expect(room.agents.map((agent) => agent.id)).toEqual([
      "haiku-1",
      "flash-1",
      "luna-1",
      "haiku-2",
      "haiku-3",
    ]);
    expect(room.agents[0].output).toEqual(["Inspecting source", "Found two candidates"]);
    expect(room.conductor.status).toBe("running");
  });

  it("rejects path escapes and malformed members", () => {
    expect(roomPath("safe", "/cache")).toBe("/cache/rooms/safe.json");
    expect(() => roomPath("../escape", "/cache")).toThrow("Room ID");
    const room = fixture();
    room.agents[0].id = undefined;
    expect(() => validateRoom(room)).toThrow("Invalid or duplicate");
    const invalidWorktree = fixture();
    invalidWorktree.agents[0].worktree = { disposable: "yes" };
    expect(() => validateRoom(invalidWorktree)).toThrow("Invalid member worktree metadata");
  });

  it("rejects a stored room whose identity differs from its filename", async () => {
    const root = await directory();
    await updateRoom("sample-room", () => fixture(), { root, create: true });
    await writeFile(
      roomPath("sample-room", root),
      JSON.stringify({ ...fixture(), id: "other-room" }),
    );
    await expect(readRoom("sample-room", root)).rejects.toThrow(/identity|match/iu);
  });

  it("leaves the old room intact when an update fails", async () => {
    const root = await directory();
    await updateRoom("sample-room", () => fixture(), { root, create: true });
    await expect(
      updateRoom("sample-room", (room) => ({ ...room, id: "other" }), { root }),
    ).rejects.toThrow("identity");
    expect((await readRoom("sample-room", root)).id).toBe("sample-room");
    await updateRoom("sample-room", (room) => addMembers(room, parseTeam("claude:haiku")), {
      root,
    });
    expect((await readRoom("sample-room", root)).agents.at(-1).id).toBe("haiku-2");
  });
});

describe("tui-box primitives and HordeView unification", () => {
  it("exports reusable box, width, and table primitives from tui-box and aliases HordeView", () => {
    expect(HordeView).toBe(StoogesView);
    expect(ANSI.cyan).toBe("36");
    expect(GLYPHS.unicode.topLeft).toBe("┌");
    expect(cellWidth("a")).toBe(1);
    expect(cellWidth("界")).toBe(2);
    expect(plain("\u{1B}[31mhi\u{1B}[0m")).toBe("hi");
    expect(fit("hello", 3)).toBe("hel");
    const styled = fitStyled(tone("hello", "cyan", true), 8);
    expect(displayWidth(styled)).toBe(8);
    expect(frame("box", ["row"], 10)).toHaveLength(3);
    expect(renderPanel("panel", ["body"], 16)).toHaveLength(3);
    expect(renderTable(["A", "B"], [["1", "2"]], 12)).toHaveLength(3);
  });

  it("uses two card columns on a wide terminal and stacked cards when narrow", () => {
    const view = new HordeView(fixture(), { now: () => 2000 });
    const wide = view.render(120);
    expect(wide.some((line) => line.includes("1 luna-1") && line.includes("2 flash-1"))).toBe(true);
    expect(wide.some((line) => line.includes("? help"))).toBe(true);
    const narrow = view.render(70);
    expect(narrow.some((line) => line.includes("1 luna-1") && line.includes("2 flash-1"))).toBe(
      false,
    );
    expect(narrow.join("\n")).toContain("1 luna-1");
    expect(narrow.join("\n")).toContain("2 flash-1");
    expect(narrow.join("\n")).toContain("3 haiku-1");
    expect(narrow.join("\n")).toContain("3/64 slots · page 1/1");
  });

  it("focuses and pins detail while new output arrives", () => {
    const room = fixture("claude:haiku*2,agy:flash*2");
    const view = new StoogesView(room, { now: () => 2000 });
    view.handleInput("2");
    view.handleInput("p");
    view.handleInput("1");
    expect(view.render(90).join("\n")).toContain("PIN ");
    const changed = structuredClone(room);
    changed.agents[2].output.push("Branch selected");
    view.setRoom(changed);
    expect(view.render(90).join("\n")).toContain("Branch selected");
    view.handleInput("2");
    view.handleInput("p");
    const unpinned = view.render(90).join("\n");
    expect(unpinned).not.toContain("PIN ");
    expect(unpinned).toContain("FOCUS ");
  });

  it("supports more than nine members with page-local number keys", () => {
    const view = new StoogesView(fixture("claude:haiku*12"));
    view.handleInput("n");
    view.handleInput("3");
    const rendered = view.render(80).join("\n");
    expect(view.focusId).toBe("haiku-1");
    expect(rendered).toContain("3 haiku-1");
    expect(rendered).toContain("page 2/2");
  });

  it("keeps focus, detail and navigation visible on a short terminal", () => {
    const room = fixture("claude:haiku*9");
    room.agents[0].output = ["First agent result"];
    const view = new StoogesView(room, { height: 18 });
    view.render(80);
    for (let index = 0; index < 8; index++) view.handleInput("\u{1B}[B");
    const lines = view.render(80);
    expect(lines.length).toBeLessThanOrEqual(18);
    expect(lines.join("\n")).toContain("haiku-1");
    expect(lines.join("\n")).toContain("FOCUS ");
    expect(lines.join("\n")).toContain("First agent result");
    expect(lines.join("\n")).toContain("q close view");
  });

  it("fits Unicode and strips injected terminal controls", () => {
    const room = fixture();
    room.agents[2].output = ["\u{1B}[2J界界 👩‍💻 safe\u{7}"];
    const lines = new StoogesView(room).render(32);
    expect(lines.every((line) => displayWidth(line) <= 32)).toBe(true);
    expect(lines.join("\n")).toContain("safe");
    expect(lines.join("\n")).not.toContain("\u{1B}");
  });

  it("frames responsive layouts within terminal width and uses tone-colored ANSI safely", () => {
    const room = fixture();
    room.agents[2].status = "running";
    room.agents[2].output = ["\u{1B}[31munsafe\u{1B}[0m 👩‍💻 界\nnext line"];
    const view = new StoogesView(room, { now: () => 2000, height: 28, color: true });
    for (const width of [40, 47, 48, 63, 64, 79, 80, 120]) {
      const lines = view.render(width);
      expect(lines.every((line) => displayWidth(line) <= width)).toBe(true);
      expect(lines.join("\n")).not.toContain("\u{1B}[31munsafe");
    }
    expect(view.render(80).join("\n")).toContain("\u{1B}[36m");
    expect(view.render(80).join("\n")).toContain("\u{1B}[36;1m");
    expect(view.render(80).join("\n")).toContain("next line");
  });

  it("offers explicit glyph tiers, locale-safe fallback, and eighth-step bars", () => {
    expect(glyphTier({ ORK_GLYPHS: "nerd", LANG: "C" })).toBe("nerd");
    expect(glyphTier({ TERM: "dumb", LANG: "en_US.UTF-8" })).toBe("ascii");
    expect(glyphTier({ TERM: "xterm-256color" })).toBe("ascii");
    expect(progressBar(0.125, 4, "unicode")).toBe("▌░░░");
    expect(displayWidth("\u{F0000}")).toBe(1);
    expect(displayWidth("\u{E0A0}")).toBe(1);
    expect(displayWidth("󰚩")).toBe(1);
    expect(wrapText("界", 1)).toEqual(["?"]);
    const ascii = new StoogesView(fixture(), { height: 24, tier: "ascii" }).render(40);
    expect(ascii.join("\n")).toContain("+ Swarm · sample-room");
    expect(ascii.every((line) => displayWidth(line) <= 40)).toBe(true);
    const nerd = new StoogesView(fixture(), { height: 24, tier: "nerd" }).render(80);
    expect(nerd.join("\n")).toContain("╭ Swarm · sample-room");
    expect(nerd.join("\n")).toContain("󰔛");
    expect(nerd.join("\n")).toContain("󰀪");
    expect(nerd.every((line) => displayWidth(line) <= 80)).toBe(true);
  });

  it("displays short Martian names and deduplicates model effort suffixes in HordeView", () => {
    expect(shortAgentName({ id: "haiku-1" })).toBe("haiku-1");
    expect(shortAgentName({ id: "builder-67-statusline-nerdfont" })).toBe(
      "builder-67-statusline-nerdfont",
    );
    expect(shortAgentName({ name: "builder-67-statusline-nerdfont" })).toBe(
      "builder-67-statusline-nerdfont",
    );
    expect(shortAgentName({ name: "gribble-gemini-4-argon-medium-orkest-1f" })).toBe("gribble");
    expect(shortAgentName({ id: "flash-1", name: "gribble-gemini-4-argon-medium-orkest-1f" })).toBe(
      "gribble",
    );
    expect(normalizeModelAndEffort("Gemini 4 Argon (Medium)", "medium")).toEqual({
      model: "Gemini 4 Argon",
      effort: "medium",
    });
    expect(normalizeModelAndEffort("gemini-4-argon-medium", "—")).toEqual({
      model: "gemini-4-argon",
      effort: "medium",
    });
    expect(normalizeModelAndEffort("gpt-oss-120b-medium", "")).toEqual({
      model: "gpt-oss-120b",
      effort: "medium",
    });

    const room = fixture("claude:haiku,agy:flash");
    room.conductor.name = "gribble-gemini-4-argon-medium-orkest-1f";
    room.conductor.resolvedModel = "Gemini 4 Argon (Medium)";
    room.conductor.resolvedEffort = "medium";
    room.agents[0].status = "completed";
    room.agents[0].name = "snorfle-opus-high-orkest-23";
    room.agents[1].status = "running";
    room.agents[1].name = "snoobix-gemini-4-argon-medium-orkest-56";
    room.agents[1].resolvedModel = "gemini-4-argon-medium";
    room.agents[1].resolvedEffort = "—";
    const rendered = new StoogesView(room, { height: 28, tier: "nerd" }).render(90).join("\n");
    expect(rendered).toContain("gribble · folder:");
    expect(rendered).not.toContain("gribble-gemini-4-argon-medium-orkest-1f");
    expect(rendered).toContain("Gemini 4 Argon / medium");
    expect(rendered).not.toContain("(Medium) / medium");
    expect(rendered).toContain("1 snoobix");
    expect(rendered).toContain("gemini-4-argon / medium");
    expect(rendered).toContain("󰄬 2 snorfle");
  });

  it("renders an empty room, key help and a coalesced log overlay", () => {
    const room = fixture();
    room.agents = [];
    const view = new StoogesView(room, { height: 24 });
    expect(view.render(80).join("\n")).toContain(
      "The coordinator will add agents as work is assigned.",
    );
    view.handleInput("?");
    expect(view.render(80).join("\n")).toContain("Key reference");
    view.handleInput("\u{1B}");
    view.handleInput("g");
    expect(view.render(80).join("\n")).toContain("haiku-1: Source inspected (×2)");
    expect(view.render(80).join("\n")).toContain("Room log");
  });

  it("renders quota pills from monitor account data right below the coordinator card", () => {
    const room = fixture();
    room.accounts = [
      {
        id: "test",
        short: "CX",
        provider: "codex",
        pools: [{ id: "default", label: "Codex", windowIds: ["week"] }],
        windows: [
          {
            id: "week",
            label: "Weekly",
            windowMins: 10_080,
            usedPct: 20,
            remainingPct: 80,
            resetsAt: 1000 + 86_400_000,
          },
        ],
      },
    ];
    const rendered = new StoogesView(room, { now: () => 1000 }).render(100).join("\n");
    expect(rendered).toContain("Quota");
    expect(rendered).toContain("CX Weekly");
    expect(rendered).toContain("80% left");
  });

  it("renders all configured quota accounts and splits Antigravity pools onto separate lines", () => {
    const room = fixture();
    room.accounts = [
      {
        id: "claude-work",
        short: "CW",
        provider: "claude",
        windows: [
          { id: "5h", label: "5-hour", remainingPct: 89, resetsAt: 1_793_766_600_000 },
          {
            id: "week",
            label: "weekly",
            kind: "weekly",
            remainingPct: 48,
            resetsAt: 1_794_013_200_000,
          },
          {
            id: "week-fable",
            label: "Fable weekly",
            kind: "weekly",
            remainingPct: 97,
            resetsAt: 1_794_013_200_000,
            scope: "Fable",
          },
        ],
      },
      {
        id: "claude-personal",
        short: "CP",
        provider: "claude",
        windows: [
          { id: "5h", label: "5-hour", remainingPct: 100 },
          { id: "week", label: "weekly", remainingPct: 86 },
        ],
      },
      {
        id: "codex",
        short: "CX",
        provider: "codex",
        credits: { hasCredits: true, unlimited: false, balance: 45_916 },
        windows: [
          {
            id: "weekly",
            label: "weekly",
            kind: "weekly",
            remainingPct: 0,
            resetsAt: 1_794_013_200_000,
          },
        ],
      },
      {
        id: "antigravity",
        short: "AG",
        provider: "antigravity",
        windows: [
          {
            id: "gemini-weekly",
            label: "Gemini weekly",
            kind: "weekly",
            remainingPct: 77,
            resetsAt: 1_794_013_200_000,
            pool: "gemini",
          },
          { id: "gemini-5h", label: "Gemini 5-hour", remainingPct: 86, pool: "gemini" },
          {
            id: "claude-gpt-weekly",
            label: "Claude & GPT weekly",
            remainingPct: 10,
            pool: "claude-gpt",
          },
          {
            id: "claude-gpt-5h",
            label: "Claude & GPT 5-hour",
            remainingPct: 100,
            pool: "claude-gpt",
          },
        ],
      },
    ];
    const nowMs = 1_793_754_000_000;
    const resetDay = new Date(1_794_013_200_000).toLocaleDateString("en-US", { weekday: "short" });
    const rendered = new StoogesView(room, { now: () => nowMs, height: 32 }).render(90).join("\n");
    expect(rendered).toContain("CW ");
    expect(rendered).toContain(`5h 89% · wk 48% · Fable wk 97% · resets in 3d (${resetDay})`);
    expect(rendered).toContain("CP ");
    expect(rendered).toContain("5h 100% · wk 86%");
    expect(rendered).toContain(`weekly 0% left · 45,916 cr · resets in 3d (${resetDay})`);
    expect(rendered).toContain(`Gemini · wk 77% · 5h 86% · resets in 3d (${resetDay})`);
    expect(rendered).toContain("Claude/GPT · wk 10% · 5h 100%");
  });

  it("collapses unfocused completed agents to 1-line rows and cycles hide/expand with c", () => {
    const room = fixture("claude:haiku*3");
    room.agents[0].status = "completed";
    room.agents[0].objective = "First task done";
    room.agents[1].status = "completed";
    room.agents[1].objective = "Second task done";
    room.agents[2].status = "running";
    room.agents[2].objective = "Third task working";
    room.agents[2].observedAt = new Date(980_000).toISOString();

    const view = new StoogesView(room, { now: () => 1_000_000, height: 28, tier: "unicode" });
    const collapsed = view.render(90).join("\n");
    // Most recent running agent (haiku-3) is #1 and focused; older completed agents (haiku-2, haiku-1) collapse below it
    expect(collapsed).toContain("┌ 1 haiku-3");
    expect(collapsed).toContain("step 2/4 · live");
    expect(collapsed).toContain("├─ ✓ 2 haiku-2");
    expect(collapsed).toContain("Second task done");
    expect(collapsed).toContain("└─ ✓ 3 haiku-1");
    expect(collapsed).toContain("First task done");

    // Press c -> hidden mode
    view.handleInput("c");
    const hidden = view.render(90).join("\n");
    expect(hidden).not.toContain("2 haiku-2");
    expect(hidden).not.toContain("3 haiku-1");
    expect(hidden).toContain("2 completed hidden (press c to expand)");

    // Press c -> expanded mode
    view.handleInput("c");
    const expanded = view.render(90).join("\n");
    expect(expanded).toContain("┌ 2 haiku-2");
    expect(expanded).toContain("┌ 3 haiku-1");
  });

  it("orders agents from most recent to least recent so new agents push old ones off the bottom", () => {
    const room = fixture("claude:haiku*2");
    room.agents[0].status = "completed";
    room.agents[0].observedAt = "2026-11-04T02:00:00Z";
    room.agents[1].status = "completed";
    room.agents[1].observedAt = "2026-11-04T03:00:00Z";
    const view = new StoogesView(room, { height: 24, tier: "unicode" });
    expect(view.room.agents.map((agent) => agent.id)).toEqual(["haiku-2", "haiku-1"]);
    expect(view.focusId).toBe("haiku-2");

    const updated = structuredClone(room);
    addMembers(updated, parseTeam("agy:pro"));
    view.setRoom(updated);
    expect(view.room.agents.map((agent) => agent.id)).toEqual(["pro-1", "haiku-2", "haiku-1"]);
    expect(view.focusId).toBe("pro-1");
  });

  it("renders outer tree rails, contrasting headers, and wt:<slug> badges for disposable worktrees in swarm view", () => {
    const room = fixture("agy:pro@ui-designer,claude:haiku@reviewer");
    room.title = "Worktree grouping";
    room.cwd = "/workspace/orkest";
    room.conductor = { engine: "agy", role: "lead", status: "working" };
    room.swarm = { maxAgents: 6, maxDepth: 3 };
    room.agents[0].cwd = "/workspace/orkest";
    room.agents[1].cwd = "/cache/worktrees/orkest/wt-50";
    room.agents[1].worktree = {
      path: "/cache/worktrees/orkest/wt-50",
      branch: "feat/wt-50",
      disposable: true,
      parentCwd: "/workspace/orkest",
      slug: "wt-50",
    };

    const unicodeLines = new StoogesView(room, { height: 28, tier: "unicode", color: true }).render(
      90,
    );
    expect(unicodeLines.every((line) => displayWidth(line) <= 90)).toBe(true);
    const unicodeText = unicodeLines.join("\n");
    expect(unicodeText).toContain("orkest · 2 agents · /workspace/orkest");
    expect(unicodeText).toContain("FOCUS wt:wt-50");
    expect(unicodeText).toContain("\u{1B}[48;5;24;97;1m");
    expect(unicodeText).toContain("\u{1B}[48;5;236;97;1m");

    const asciiText = new StoogesView(room, { height: 28, tier: "ascii" }).render(85).join("\n");
    expect(asciiText).toContain("| orkest · 2 agents · /workspace/orkest");
    expect(asciiText).toContain("| + 1 haiku-1");
    expect(asciiText).toContain("+-|Awaiting assignment");
    expect(asciiText).toContain("| + 2 pro-1");
    expect(asciiText).toContain("`-|Awaiting assignment");
    expect(asciiText).toContain("wt:wt-50");
  });
});

describe("ork CLI", () => {
  it("prints offline fixtures and JSON without creating a room", async () => {
    const dir = await directory();
    const file = path.join(dir, "fixture.json");
    await writeFile(file, JSON.stringify(fixture()));
    const env = {
      ...process.env,
      AGENT_EXECUTOR_HOME: dir,
      LANG: "en_US.UTF-8",
      NO_COLOR: "1",
      TERM: "xterm-256color",
    };
    const printed = await exec(
      process.execPath,
      [cli, "stooges", "--fixture", file, "--print", "--width", "70"],
      { env },
    );
    expect(printed.stdout).toContain("┌ Swarm · sample-room");
    expect(printed.stdout).toContain("3/64 slots");
    expect(printed.stdout).toContain("? help");
    expect(printed.stdout).not.toContain("\u{1B}");
    const json = await exec(process.execPath, [cli, "stooges", "--fixture", file, "--json"], {
      env,
    });
    expect(JSON.parse(json.stdout).agents[0].output).toEqual([
      "Inspecting source",
      "Found two candidates",
    ]);
    await expect(
      readFile(path.join(dir, "mailbox-v1/rooms/sample-room.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["--width", "0"],
    ["--width", "Infinity"],
    ["--unknown"],
    ["--team", "claude:haiku", "--preset", "scout-swarm"],
    ["--print", "--json"],
    ["spawn", "--team", "claude:haiku"],
    ["--preset", "missing"],
  ])("rejects invalid options %j before creating rooms", async (...args) => {
    const dir = await directory();
    await expect(
      exec(process.execPath, [cli, "stooges", ...args], {
        env: { ...process.env, AGENT_EXECUTOR_HOME: dir },
      }),
    ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("ork:") });
    await expect(readFile(path.join(dir, "mailbox-v1/rooms"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each([
    "not json",
    "{}",
    JSON.stringify({ schema: "agent-executor.room.v1", id: "../escape", agents: [] }),
  ])("rejects invalid fixture %s without creating a room", async (contents) => {
    const dir = await directory();
    const file = path.join(dir, "fixture.json");
    await writeFile(file, contents);
    await expect(
      exec(process.execPath, [cli, "stooges", "--fixture", file, "--print"], {
        env: { ...process.env, AGENT_EXECUTOR_HOME: dir },
      }),
    ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("ork:") });
  });

  it("creates a preset room and appends queued agents to the same durable room", async () => {
    const dir = await directory();
    const env = { ...process.env, AGENT_EXECUTOR_HOME: dir };
    const created = await exec(
      process.execPath,
      [cli, "stooges", "--preset", "scout-swarm", "--json"],
      { env },
    );
    const room = JSON.parse(created.stdout);
    expect(room.agents.map((agent) => agent.id)).toEqual([
      "haiku-1",
      "haiku-2",
      "flash-1",
      "flash-2",
      "luna-1",
    ]);
    const spawned = await exec(
      process.execPath,
      [cli, "stooges", "spawn", "--attach-room", room.id, "--team", "claude:haiku", "--json"],
      { env },
    );
    expect(JSON.parse(spawned.stdout).agents.at(-1)).toMatchObject({
      id: "haiku-3",
      status: "queued",
    });
    expect((await readRoom(room.id, path.join(dir, "mailbox-v1"))).agents).toHaveLength(6);
  });
});

describe("terminal lifecycle", () => {
  it.each([false, true])("restores terminal state after q when raw mode was %s", async (wasRaw) => {
    vi.useFakeTimers();
    // eslint-disable-next-line unicorn/prefer-event-target -- Node readline requires a stream EventEmitter API.
    const input = new EventEmitter();
    input.isTTY = true;
    input.isRaw = wasRaw;
    input.setRawMode = vi.fn((raw) => {
      input.isRaw = raw;
    });
    input.resume = vi.fn();
    input.pause = vi.fn();
    const output = { isTTY: true, rows: 24, columns: 80, write: vi.fn() };
    const signals = { SIGINT: process.listeners("SIGINT"), SIGTERM: process.listeners("SIGTERM") };
    const load = vi.fn(async () => fixture());
    let running;
    try {
      running = runTui(load, { input, output, quota: false });
      await vi.advanceTimersByTimeAsync(0);
      expect(input.isRaw).toBe(true);
      expect(output.write.mock.calls.flat().join("")).toContain("\u{1B}[?1049h\u{1B}[?25l");
      input.emit("keypress", "q", { name: "q" });
      await running;
      expect(input.isRaw).toBe(wasRaw);
      expect(input.pause).toHaveBeenCalledOnce();
      expect(input.listenerCount("keypress")).toBe(0);
      expect(input.listenerCount("end")).toBe(0);
      expect(process.listeners("SIGINT")).toEqual(signals.SIGINT);
      expect(process.listeners("SIGTERM")).toEqual(signals.SIGTERM);
      expect(output.write.mock.calls.flat().join("")).toContain("\u{1B}[?25h\u{1B}[?1049l");
      expect(vi.getTimerCount()).toBe(0);
      const frames = output.write.mock.calls.length;
      const loads = load.mock.calls.length;
      await vi.advanceTimersByTimeAsync(2000);
      expect(output.write).toHaveBeenCalledTimes(frames);
      expect(load).toHaveBeenCalledTimes(loads);
    } finally {
      input.emit("keypress", "q", { name: "q" });
      await running;
      vi.useRealTimers();
    }
  });

  it("does not write the same frame on every timer tick and redraws on resize", async () => {
    vi.useFakeTimers();
    // eslint-disable-next-line unicorn/prefer-event-target -- Readline keypress and terminal resize use Node stream events.
    const input = new EventEmitter();
    input.isTTY = true;
    input.isRaw = false;
    input.setRawMode = vi.fn();
    input.resume = vi.fn();
    input.pause = vi.fn();
    // eslint-disable-next-line unicorn/prefer-event-target -- Readline keypress and terminal resize use Node stream events.
    const output = new EventEmitter();
    output.isTTY = true;
    output.rows = 24;
    output.columns = 80;
    output.write = vi.fn();
    const running = runTui(
      async () => {
        const room = fixture();
        for (const agent of room.agents) agent.status = "completed";
        return room;
      },
      { input, output, quota: false },
    );
    try {
      await vi.advanceTimersByTimeAsync(0);
      const initialWrites = output.write.mock.calls.length;
      await vi.advanceTimersByTimeAsync(600);
      expect(output.write).toHaveBeenCalledTimes(initialWrites);
      output.columns = 90;
      output.emit("resize");
      expect(output.write).toHaveBeenCalledTimes(initialWrites + 1);
      input.emit("keypress", "q", { name: "q" });
      await running;
      expect(input.setRawMode).toHaveBeenLastCalledWith(false);
      expect(output.listenerCount("resize")).toBe(0);
    } finally {
      input.emit("keypress", "q", { name: "q" });
      await running;
      vi.useRealTimers();
    }
  });

  it("restores terminal state when painting fails after entering the alternate screen", async () => {
    vi.useFakeTimers();
    // eslint-disable-next-line unicorn/prefer-event-target -- Readline keypress uses the Node stream EventEmitter API.
    const input = new EventEmitter();
    input.isTTY = true;
    input.isRaw = false;
    input.setRawMode = vi.fn((raw) => {
      input.isRaw = raw;
    });
    input.resume = vi.fn();
    input.pause = vi.fn();
    const output = { isTTY: true, rows: 24, columns: 80, write: vi.fn() };
    output.write
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new Error("terminal write failed");
      });
    try {
      await expect(runTui(async () => fixture(), { input, output, quota: false })).rejects.toThrow(
        "terminal write failed",
      );
      expect(input.isRaw).toBe(false);
      expect(input.pause).toHaveBeenCalledOnce();
      expect(output.write.mock.calls.at(-1)[0]).toContain("\u{1B}[?1049l");
    } finally {
      vi.useRealTimers();
    }
  });

  it("supports o-key pane focus, focusAgentPane, notifyHerdrTransitions, and primary module shim parity", async () => {
    expect(stoogesRoomModule.createRoom).toBe(hordeRoomModule.createRoom);
    expect(stoogesRoomModule.WORKFORCE_ROLES).toBe(hordeRoomModule.WORKFORCE_ROLES);
    expect(stoogesViewModule.HordeView).toBe(hordeViewModule.HordeView);
    expect(stoogesTuiModule.runHordeTui).toBe(hordeTuiModule.runHordeTui);
    expect(runStoogesTui).toBe(runHordeTui);
    expect(runTui).toBe(runHordeTui);
    expect(factoryModule.foundryCommand).toBe(foundryModule.foundryCommand);
    expect(factoryModule.runSmelterPass).toBe(foundryModule.runSmelterPass);
    expect(foundryModule.runFoundryPass).toBe(foundryModule.runSmelterPass);
    expect(typeof foundryModule.resolveWorktreeGitDir).toBe("function");

    const normalized = normalizeAgent(
      { id: "a1", progress: { herdrPaneId: "herdr-pane-9", paneId: "%9" } },
      { cwd: "/workspace" },
    );
    expect(normalized.herdrPaneId).toBe("herdr-pane-9");
    expect(normalized.paneId).toBe("%9");

    const room = fixture("claude:haiku,agy:flash");
    room.agents[0].herdrPaneId = "pane-haiku-1";
    room.agents[1].paneId = "%42";
    const focusedCalls = [];
    const view = new HordeView(room, {
      height: 24,
      tier: "unicode",
      onFocusPane: (agent) => {
        focusedCalls.push(agent);
      },
    });
    expect(view.render(80).join("\n")).toContain("o open");
    expect(view.handleKey("o")).toBe(true);
    expect(view.lastFocusedAgentId).toBe(view.focusId);
    expect(focusedCalls).toHaveLength(1);
    expect(focusedCalls[0].paneId).toBe("%42");

    view.handleKey("\u{1B}[B");
    expect(view.handleKey("o")).toBe(true);
    expect(focusedCalls).toHaveLength(2);
    expect(focusedCalls[1].herdrPaneId).toBe("pane-haiku-1");

    const execCalls = [];
    const mockExec = (cmd, args) => {
      execCalls.push([cmd, args]);
    };
    await focusAgentPane({ id: "a1", herdrPaneId: "hp-1", paneId: "%1" }, { exec: mockExec });
    await focusAgentPane({ id: "a2", paneId: "%2" }, { exec: mockExec });
    expect(
      await focusAgentPane({ id: "a-bad-1", herdrPaneId: "-malicious-flag" }, { exec: mockExec }),
    ).toBe(false);
    expect(await focusAgentPane({ id: "a-bad-2", paneId: "bad\npane" }, { exec: mockExec })).toBe(
      false,
    );
    expect(
      await focusAgentPane(
        { id: "a3", herdrPaneId: "hp-err" },
        {
          exec: () => {
            throw new Error("herdr unavailable");
          },
        },
      ),
    ).toBe(false);
    expect(
      await focusAgentPane(
        { id: "a4", herdrPaneId: "hp-cb-err" },
        {
          exec: (_cmd, _args, cb) => {
            cb(new Error("command failed"));
          },
        },
      ),
    ).toBe(false);
    expect(execCalls).toEqual([
      ["herdr", ["pane", "focus", "--pane", "hp-1"]],
      ["tmux", ["select-pane", "-t", "%2"]],
    ]);

    const notificationCalls = [];
    const notificationExec = (cmd, args) => {
      notificationCalls.push([cmd, args]);
    };

    // Initial startup seed (prevAgents = null) records existing blocked/complete states without notifying:
    const seededSet = new Set();
    expect(
      notifyHerdrTransitions(
        null,
        [{ id: "a1", person: "gribble", stage: "blocked", summary: "Already blocked" }],
        seededSet,
        { env: { HERDR_PANE_ID: "hp-1" }, exec: notificationExec },
      ),
    ).toBe(false);
    expect(seededSet.has("a1:blocked:Already blocked")).toBe(true);
    expect(notificationCalls).toHaveLength(0);

    const seededCompleteSet = new Set();
    expect(
      notifyHerdrTransitions(
        null,
        [{ id: "a1", person: "gribble", stage: "completed", summary: "Already done" }],
        seededCompleteSet,
        { env: { HERDR_PANE_ID: "hp-1" }, exec: notificationExec },
      ),
    ).toBe(false);
    expect(seededCompleteSet.has("room:all-complete")).toBe(true);
    expect(notificationCalls).toHaveLength(0);

    // Empty/missing previous stage does not count as active for all-complete transition:
    const emptyStageSet = new Set();
    expect(
      notifyHerdrTransitions(
        [{ id: "a1", person: "gribble", stage: "", summary: "" }],
        [{ id: "a1", person: "gribble", stage: "completed", summary: "Done" }],
        emptyStageSet,
        { env: { HERDR_PANE_ID: "hp-1" }, exec: notificationExec },
      ),
    ).toBe(false);
    expect(notificationCalls).toHaveLength(0);

    const notifiedSet = new Set();
    const prev = [
      { id: "a1", person: "gribble", stage: "working", summary: "Writing tests" },
      { id: "a2", person: "snoobix", stage: "working", summary: "Refactoring" },
    ];
    const nextBlocked = [
      { id: "a1", person: "gribble", stage: "blocked", summary: "Need confirmation" },
      { id: "a2", person: "snoobix", stage: "working", summary: "Refactoring" },
    ];
    // No-op when Herdr env vars are absent:
    notifyHerdrTransitions(prev, nextBlocked, notifiedSet, { env: {}, exec: notificationExec });
    expect(notificationCalls).toHaveLength(0);

    // Fires edge-triggered blocked notification when HERDR_PANE_ID is present:
    notifyHerdrTransitions(prev, nextBlocked, notifiedSet, {
      env: { HERDR_PANE_ID: "hp-1" },
      exec: notificationExec,
    });
    expect(notificationCalls).toEqual([
      [
        "herdr",
        [
          "notification",
          "show",
          "Orkest: gribble blocked",
          "--body",
          "Need confirmation",
          "--sound",
          "request",
        ],
      ],
    ]);
    expect(notifiedSet.has("a1:blocked:Need confirmation")).toBe(true);

    // Deduplicated on repeated poll with same state:
    notifyHerdrTransitions(prev, nextBlocked, notifiedSet, {
      env: { HERDR_PANE_ID: "hp-1" },
      exec: notificationExec,
    });
    expect(notificationCalls).toHaveLength(1);

    // Fires all-complete notification when all agents finish after at least one was active:
    const nextDone = [
      { id: "a1", person: "gribble", stage: "completed", summary: "Done" },
      { id: "a2", person: "snoobix", stage: "completed", summary: "Done" },
    ];
    notifyHerdrTransitions(nextBlocked, nextDone, notifiedSet, {
      env: { HERDR_SOCKET: "/tmp/herdr.sock" },
      exec: notificationExec,
    });
    expect(notificationCalls).toHaveLength(2);
    expect(notificationCalls[1]).toEqual([
      "herdr",
      [
        "notification",
        "show",
        "Orkest: Horde complete",
        "--body",
        "All 2 agents finished.",
        "--sound",
        "done",
      ],
    ]);
    expect(notifiedSet.has("room:all-complete")).toBe(true);
  });

  it("renders redesigned orchestrator card, collapsible inline quota, and running services footer", async () => {
    const room = fixture("claude:haiku,agy:flash");
    room.title = "Swarm View Upgrade";
    room.conductor = {
      ...room.conductor,
      name: "gribble-gemini-4-argon-medium-orkest-1f",
      engine: "agy",
      branch: "feat/swarm-view",
      herdrPaneId: "pane-lead-1",
      status: "running",
      progress: {
        name: "gribble-gemini-4-argon-medium-orkest-1f",
        model: "Gemini 4 Argon (Medium)",
        effort: "—",
        goal: "Ship Swarm View v2",
        task: "Coordinating slice 2A",
        reportedAt: new Date(10_000).toISOString(),
      },
    };
    room.accounts = [
      {
        id: "codex",
        short: "C",
        windows: [
          { id: "five_hour", label: "5h", remainingPct: 92 },
          { id: "weekly", label: "wk", remainingPct: 81 },
        ],
      },
      {
        id: "claude",
        short: "K",
        windows: [{ id: "weekly", label: "wk", remainingPct: 64 }],
      },
    ];
    room.services = [
      {
        kind: "port",
        port: 3004,
        pid: 4242,
        name: "vite",
        worktree: "wt:slice-2a",
        owner: "haiku-1",
        uptime: "04:12",
      },
      {
        kind: "docker",
        port: 5432,
        name: "orkest-postgres-1",
        image: "postgres:16",
        worktree: "orkest",
        uptime: "12 minutes",
      },
    ];
    expect(() => validateRoom(structuredClone(room))).not.toThrow();

    const view = new HordeView(room, {
      height: 34,
      tier: "unicode",
      now: () => 20_000,
    });
    const expandedText = view.render(100).join("\n");
    expect(expandedText).toContain(
      "Orchestrator: gribble · folder: orkest (feat/swarm-view) · agy · pane-lead-1",
    );
    expect(expandedText).toContain("Ship Swarm View v2 — Coordinating slice 2A");
    expect(expandedText).toContain("u collapse");
    expect(expandedText).toContain("Services");
    expect(expandedText).toContain("2 running · :3004 :5432 · v collapse");
    expect(expandedText).toContain(":3004  vite (pid 4242) · wt:slice-2a · by haiku-1 · up 04:12");
    expect(expandedText).toContain(":5432  docker postgres:16 · orkest · up 12 minutes");
    expect(expandedText).toContain("· u quota · v services");

    // Toggle quota to collapsed 1-line inline bar with 'u':
    expect(view.handleKey("u")).toBe(true);
    expect(view.quotaMode).toBe("collapsed");
    const collapsedText = view.render(100).join("\n");
    expect(collapsedText).toContain("Quota [u]");
    expect(collapsedText).toContain("C 92%·81%");
    expect(collapsedText).toContain("K 64%");
    expect(collapsedText).not.toContain("u collapse");

    // Toggle back to expanded with 'u':
    expect(view.handleKey("u")).toBe(true);
    expect(view.quotaMode).toBe("expanded");

    // Toggle services to collapsed 1-line inline bar with 'v':
    expect(view.handleKey("v")).toEqual({
      type: "services-toggle",
      servicesMode: "collapsed",
    });
    expect(view.servicesMode).toBe("collapsed");
    const collapsedServicesText = view.render(100).join("\n");
    expect(collapsedServicesText).toContain("Services [v]");
    expect(collapsedServicesText).toContain(
      "2 running · :3004 vite (wt:slice-2a) · :5432 docker postgres:16 (orkest)",
    );
    expect(collapsedServicesText).not.toContain("v collapse");

    // Toggle services back to expanded with 'v':
    expect(view.handleKey("v")).toEqual({
      type: "services-toggle",
      servicesMode: "expanded",
    });
    expect(view.servicesMode).toBe("expanded");

    // Render Update [U] notifier banner and trigger pull-update with Shift+U ('U'):
    view.setRoom({
      ...room,
      update: { available: true, commitsBehind: 3, remoteSha: "a1b2c3d4" },
    });
    const updateAvailableText = view.render(100).join("\n");
    expect(updateAvailableText).toContain(
      "Update [U]  ↑ 3 new commits on origin/main · press U to pull & update",
    );
    expect(updateAvailableText).toContain("· U update");
    expect(view.handleKey("U")).toEqual({ type: "pull-update" });
    // Lowercase 'u' still toggles quotaMode:
    expect(view.handleKey("u")).toBe(true);
    expect(view.quotaMode).toBe("collapsed");
    expect(view.handleKey("u")).toBe(true);
    expect(view.quotaMode).toBe("expanded");

    // Verify repo-denied account filtering in horde-tui:
    const sampleAccounts = [
      { id: "claude", provider: "claude", label: "Claude Work", short: "K" },
      { id: "plaude", provider: "claude", label: "Claude Personal", short: "P" },
      { id: "codex", provider: "codex", label: "Codex", short: "C" },
      { id: "antigravity", provider: "antigravity", label: "Gemini", short: "G" },
    ];
    expect(
      hordeTuiModule.filterAccountsByRepoPolicy(sampleAccounts, ["claude-work"]).map((a) => a.id),
    ).toEqual(["plaude", "codex", "antigravity"]);
    expect(
      hordeTuiModule
        .filterAccountsByRepoPolicy(sampleAccounts, ["plaude", "codex"])
        .map((a) => a.id),
    ).toEqual(["claude", "antigravity"]);

    // Test probeRoomServices & cachedServices with mocked lsof, ps, and docker ps output
    // (including internal agy / codex IPC ephemeral ports that must be filtered out):
    const probeRoom = {
      id: "room-svc-probe",
      cwd: "/Users/dev/orkest",
      conductor: { id: "conductor", name: "gribble", pid: 9000 },
      agents: [
        {
          id: "worker-1",
          name: "snoobix",
          pid: 9100,
          worktree: {
            disposable: true,
            path: "/Users/dev/orkest/.worktrees/wt-ui",
            slug: "wt-ui",
          },
        },
      ],
    };
    const mockExec = (cmd, args, cb) => {
      if (cmd === "lsof" && args.includes("-sTCP:LISTEN")) {
        cb(
          null,
          [
            "p9105",
            "c node",
            "n127.0.0.1:4173",
            "p9000",
            "c agy",
            "n127.0.0.1:58406",
            "p9100",
            "c codex",
            "n127.0.0.1:60693",
            "p9999",
            "c python",
            "n*:8000",
            "",
          ].join("\n"),
        );
        return;
      }
      if (cmd === "ps") {
        cb(
          null,
          [
            " 9105  9100 02:15 node /Users/dev/orkest/node_modules/.bin/vite --port 4173",
            " 9000     1 15:00 agy --workspace /Users/dev/orkest",
            " 9100  9000 12:00 codex --full-auto",
            " 9999     1 10:00 python -m http.server",
            "",
          ].join("\n"),
        );
        return;
      }
      if (cmd === "lsof" && args.includes("cwd")) {
        cb(
          null,
          [
            "p9105",
            "n/Users/dev/orkest/.worktrees/wt-ui",
            "p9000",
            "n/Users/dev/orkest",
            "p9100",
            "n/Users/dev/orkest/.worktrees/wt-ui",
            "p9999",
            "n/tmp/unrelated",
            "",
          ].join("\n"),
        );
        return;
      }
      if (cmd === "docker") {
        cb(
          null,
          `${JSON.stringify({
            Names: "orkest-redis-1",
            Image: "redis:7-alpine",
            Ports: "0.0.0.0:6379->6379/tcp",
            Labels:
              "com.docker.compose.project=orkest,com.docker.compose.project.working_dir=/Users/dev/orkest",
            RunningFor: "5 minutes ago",
          })}\n`,
        );
        return;
      }
      cb(null, "");
    };
    const services = await hordeTuiModule.cachedServices(probeRoom, {
      exec: mockExec,
      now: () => 1000,
      force: true,
    });
    expect(services).toEqual([
      {
        kind: "port",
        port: 4173,
        pid: 9105,
        name: "vite",
        cwd: "/Users/dev/orkest/.worktrees/wt-ui",
        worktree: "wt:wt-ui",
        owner: "snoobix",
        uptime: "02:15",
      },
      {
        kind: "docker",
        name: "orkest-redis-1",
        image: "redis:7-alpine",
        port: 6379,
        ports: "0.0.0.0:6379->6379/tcp",
        cwd: "/Users/dev/orkest",
        worktree: "orkest",
        uptime: "5 minutes",
      },
    ]);
    const cached = await hordeTuiModule.cachedServices(probeRoom, {
      exec: () => {
        throw new Error("should use cache");
      },
      now: () => 2000,
      ttlMs: 60_000,
    });
    expect(cached).toHaveLength(2);
  });
});
