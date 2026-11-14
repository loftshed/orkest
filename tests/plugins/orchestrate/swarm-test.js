import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";

import { main as orkMain } from "../../../plugins/orchestrate/bin/ork.mjs";
import { roomsCommand } from "../../../plugins/orchestrate/bin/rooms.mjs";
import { parseTeam, readRoom, updateRoom } from "../../../plugins/orchestrate/lib/horde-room.mjs";
import {
  agentFolder,
  HordeView,
  worktreeBadge,
} from "../../../plugins/orchestrate/lib/horde-view.mjs";
import {
  bindSession,
  dispatchMember,
  growRoom,
  keepWorktree,
  newRoom,
  observeRoom,
} from "../../../plugins/orchestrate/lib/rooms.mjs";
import { pauseBranch, reserveLead } from "../../../plugins/orchestrate/lib/swarm.mjs";
import { retainFixtures } from "../../helpers/retain-fixtures.js";

const execute = promisify(execFile);
const cli = fileURLToPath(new URL("../../../plugins/orchestrate/bin/ork.mjs", import.meta.url));
const directories = [];
async function fixture({ maxAgents = 6, maxDepth = 3 } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "ork-swarm-"));
  directories.push(root);
  const room = await newRoom([], {
    id: "test-swarm",
    cwd: root,
    root,
    engine: "codex",
    title: "Fix cache",
    objective: "Fix cache",
    swarm: { maxAgents, maxDepth },
  });
  return { root, room };
}
afterEach(async () => {
  await retainFixtures(directories.splice(0));
});

it("creates a conversational room through the CLI without launching a model in JSON mode", async () => {
  const { root } = await fixture();
  const result = await execute(
    process.execPath,
    [cli, "horde", "Fix a cache failure", "--engine", "agy", "--max-agents", "4", "--json"],
    {
      env: { ...process.env, AGENT_EXECUTOR_HOME: root },
    },
  );
  const room = JSON.parse(result.stdout);
  expect(room).toMatchObject({
    objective: "Fix a cache failure",
    conductor: { engine: "agy", status: "awaiting session" },
    swarm: { maxAgents: 4, maxDepth: 3 },
    agents: [],
  });
  expect((await readRoom(room.id, path.join(root, "mailbox-v1"))).objective).toBe(
    "Fix a cache failure",
  );
});

it.each(["agy", "codex", "claude", "opencode"])(
  "opens %s through its short command with the goal left for the conversation",
  async (engine) => {
    const { root } = await fixture();
    const result = await execute(process.execPath, [cli, engine, "--json", "--max-agents", "4"], {
      env: { ...process.env, AGENT_EXECUTOR_HOME: root },
    });
    const room = JSON.parse(result.stdout);
    expect(room).toMatchObject({
      objective: "",
      title: "New swarm",
      conductor: { engine, status: "awaiting session" },
      swarm: { maxAgents: 4 },
      agents: [],
    });
  },
);

it("lets a native lead build another branch while sharing the root's member limit", async () => {
  const { root, room } = await fixture({ maxAgents: 3 });
  await growRoom(room.id, parseTeam("codex:host-default"), root);
  const lead = await reserveLead(room.id, "host-default-1", "Investigate cache", { root });
  expect(lead).toMatchObject({
    status: "native_handoff",
    engine: "codex",
    member: "host-default-1",
  });
  expect(await readFile(lead.briefPath, "utf8")).toContain("Your assignment: Investigate cache");
  await growRoom(room.id, parseTeam("agy:flash,claude:haiku"), root, "host-default-1");
  await expect(growRoom(room.id, parseTeam("codex:luna"), root)).rejects.toThrow(
    "Swarm agent limit reached",
  );
  expect(
    (await readRoom(room.id, root)).agents.map((member) => [member.id, member.parent]),
  ).toEqual([
    ["host-default-1", "conductor"],
    ["flash-1", "host-default-1"],
    ["haiku-1", "host-default-1"],
  ]);
});

it("does not turn another harness or an existing audited worker into a subswarm lead", async () => {
  const { root, room } = await fixture();
  await growRoom(room.id, parseTeam("agy:flash,codex:luna"), root);
  await expect(reserveLead(room.id, "flash-1", "Research", { root })).rejects.toThrow(
    "parent's native harness",
  );
  await reserveLead(room.id, "luna-1", "Research", { root });
  expect(await reserveLead(room.id, "luna-1", "Research", { root })).toMatchObject({
    status: "pending_attachment",
    session: null,
  });
  await bindSession(room.id, "luna-1", { root, engine: "codex", session: "native-child-1" });
  expect(await reserveLead(room.id, "luna-1", "Research", { root })).toMatchObject({
    status: "attached",
    session: { id: "native-child-1" },
  });
  await expect(reserveLead(room.id, "luna-1", "Different task", { root })).rejects.toThrow(
    "already has an assignment",
  );
  await expect(
    bindSession(room.id, "luna-1", { root, engine: "codex", session: "duplicate-child" }),
  ).rejects.toThrow("already has a native session");
});

it("rejects excessive depth, unknown parents and cycles without changing the saved tree", async () => {
  const { root, room } = await fixture({ maxDepth: 2 });
  await growRoom(room.id, parseTeam("codex:host-default"), root);
  await reserveLead(room.id, "host-default-1", "Explore", { root });
  await growRoom(room.id, parseTeam("codex:host-default"), root, "host-default-1");
  await reserveLead(room.id, "host-default-2", "Inspect", { root });
  await expect(growRoom(room.id, parseTeam("agy:flash"), root, "host-default-2")).rejects.toThrow(
    "depth limit",
  );
  await expect(growRoom(room.id, parseTeam("agy:flash"), root, "missing")).rejects.toThrow(
    "existing lead",
  );
  await expect(
    updateRoom(
      room.id,
      (current) => {
        current.agents[0].parent = "host-default-2";
        return current;
      },
      { root },
    ),
  ).rejects.toThrow("cycle");
  expect((await readRoom(room.id, root)).agents.map((member) => member.parent)).toEqual([
    "conductor",
    "host-default-1",
  ]);
});

it("enforces the shared limit under competing branch additions", async () => {
  const { root, room } = await fixture({ maxAgents: 1 });
  const outcomes = await Promise.allSettled([
    growRoom(room.id, parseTeam("agy:flash"), root),
    growRoom(room.id, parseTeam("claude:haiku"), root),
  ]);
  expect(outcomes.map((result) => result.status).sort((a, b) => a.localeCompare(b))).toEqual([
    "fulfilled",
    "rejected",
  ]);
  expect((await readRoom(room.id, root)).agents.map((member) => member.status)).toEqual(["queued"]);
});

it("pauses new descendants while preserving recovery of previously dispatched work", async () => {
  const { root, room } = await fixture();
  await growRoom(room.id, parseTeam("codex:host-default,agy:flash"), root);
  await reserveLead(room.id, "host-default-1", "Lead investigation", { root });
  await growRoom(room.id, parseTeam("claude:haiku"), root, "host-default-1");
  const task = {
    schema: "agent-executor.task.v1",
    task_id: "cache-task",
    repository: room.cwd,
    runs: [],
    decisions: [],
    updated_at: "2026-10-30T20:00:00Z",
  };
  const run = async (args) => {
    if (args[0] === "show") return structuredClone(task);
    const request = args[args.indexOf("--request-id") + 1];
    const record = task.runs.find((entry) => entry.request_id === request) || {
      request_id: request,
      run_id: "cache-run",
      status: "active",
      engine: args[args.indexOf("--engine") + 1],
      transport: "executor",
    };
    if (!task.runs.includes(record)) task.runs.push(record);
    return record;
  };
  const options = { root, taskDir: room.cwd, run };
  await dispatchMember(room.id, "flash-1", options);
  await pauseBranch(room.id, "conductor", true, { root });
  await pauseBranch(room.id, "host-default-1", false, { root });
  await expect(dispatchMember(room.id, "haiku-1", options)).rejects.toThrow("conductor is paused");
  await expect(
    reserveLead(room.id, "host-default-1", "Lead investigation", { root }),
  ).rejects.toThrow("paused");
  expect((await dispatchMember(room.id, "flash-1", options)).dispatch.run_id).toBe("cache-run");
  expect(task.runs.map((entry) => entry.run_id)).toEqual(["cache-run"]);
  await pauseBranch(room.id, "conductor", false, { root });
  expect((await dispatchMember(room.id, "haiku-1", options)).room.agents.at(-1).status).toBe(
    "running",
  );
  await expect(reserveLead(room.id, "flash-1", "Take over", { root })).rejects.toThrow(
    "parent's native harness",
  );
});

it("projects current session status and nesting without treating a lead report as accepted work", async () => {
  const { root, room } = await fixture();
  await growRoom(room.id, parseTeam("codex:host-default,claude:haiku"), root);
  await reserveLead(room.id, "host-default-1", "Investigate", { root });
  await growRoom(room.id, parseTeam("agy:flash"), root, "host-default-1");
  await bindSession(room.id, "host-default-1", { root, engine: "codex", session: "lead-session" });
  const observed = await observeRoom(room.id, {
    root,
    progress: async () => ({
      "host-default-1": {
        name: "example-gpt-test-high-cache-aa",
        model: "runtime-model",
        effort: "high",
        stage: "complete",
        task: "Investigate",
        statusHealth: "fresh",
      },
    }),
  });
  expect(observed.agents[0]).toMatchObject({
    name: "example-gpt-test-high-cache-aa",
    status: "reported complete",
  });
  // A room-bound member stays reviewable: progress alone never marks it untracked.
  expect(observed.agents[0].completion).toBeUndefined();
  const view = new HordeView(observed, { height: 30, tier: "unicode" });
  const output = view.render(85).join("\n");
  expect(output).toContain("│ ┌ ▸ 1 haiku-1");
  expect(output).toContain("├─┤ Awaiting assignment");
  expect(output).toContain("│ ┌ 2 example (lead)");
  expect(output).toContain("└─┤ Investigate");
  expect(output).toContain("│ ┌ 3 flash-1");
  expect(output).toContain("└─┤ Awaiting assignment");
  expect(output).toContain("runtime-model / high | reported (awaiting review)");
  const absent = await observeRoom(room.id, { root, progress: async () => ({}) });
  expect(absent.agents[0].status).toBe("session unavailable");
});

it("records a conversation's objective and pauses through the public room commands", async () => {
  const { root, room } = await fixture();
  const stdout = { write() {} };
  await roomsCommand(
    ["objective", "--room", room.id, "--objective", "Repair cache\nand verify recovery"],
    { root, stdout },
  );
  await roomsCommand(["pause", "--room", room.id], { root, stdout });
  expect(await readRoom(room.id, root)).toMatchObject({
    title: "Repair cache and verify recovery",
    objective: "Repair cache\nand verify recovery",
    conductor: { paused: true },
  });
  await roomsCommand(["resume", "--room", room.id], { root, stdout });
  expect((await readRoom(room.id, root)).conductor.paused).toBe(false);
});

it("assigns preset workforce roles, groups agent cards by working folder, and projects on-the-fly role updates", async () => {
  const { root, room } = await fixture();
  const tempA = await mkdtemp(path.join(tmpdir(), "ork-wt-a-"));
  const tempB = await mkdtemp(path.join(tmpdir(), "ork-wt-b-"));
  const worktreeA = await realpath(tempA);
  const worktreeB = await realpath(tempB);
  directories.push(worktreeA, worktreeB);
  const stdout = { write() {} };

  await growRoom(room.id, parseTeam("claude:haiku*2@scout"), root, "conductor", {
    cwd: worktreeA,
  });
  await growRoom(room.id, parseTeam("agy:flash@implementer"), root, "conductor", {
    cwd: worktreeB,
  });
  await roomsCommand(
    ["role", "--room", room.id, "--member", "haiku-2", "--role", "reviewer", "--cwd", worktreeB],
    { root, stdout },
  );

  const saved = await readRoom(room.id, root);
  expect(saved.agents.map((agent) => [agent.id, agent.workforceRole, agent.cwd])).toEqual([
    ["haiku-1", "scout", worktreeA],
    ["haiku-2", "reviewer", worktreeB],
    ["flash-1", "builder", worktreeB],
  ]);

  const observed = await observeRoom(room.id, {
    root,
    progress: async () => ({
      "haiku-1": {
        name: "snorfle-haiku-low-wt-a-11",
        model: "haiku",
        effort: "low",
        stage: "working",
        task: "Map API endpoints",
        role: "debugger",
        cwd: worktreeA,
        statusHealth: "fresh",
      },
    }),
  });
  expect(observed.agents[0].workforceRole).toBe("debugger");

  const view = new HordeView(observed, { height: 34, tier: "unicode" });
  const output = view.render(110).join("\n");
  expect(output).toContain(`│ ${path.basename(worktreeA)} · 1 agent`);
  expect(output).toContain(`│ ${path.basename(worktreeB)} · 2 agents`);
  expect(output).toContain("│ ┌ ▸ 1 flash-1");
  expect(output).toContain("├─┤ Awaiting assignment");
  expect(output).toContain("[builder] gemini:fast | queued");
  expect(output).toContain("│ ┌ 2 haiku-2");
  expect(output).toContain("├─┤ Awaiting assignment");
  expect(output).toContain("[reviewer] haiku | queued");
  expect(output).toContain("│ ┌ 3 snorfle");
  expect(output).toMatch(/└─┤ [⣾⣽⣻⢿⡿⣟⣯⣷] Map API endpoints/u);
  expect(output).toContain("[debugger] haiku / low | working");
});

it("groups disposable git worktrees under their parent folder, renders wt:<slug> badges, and promotes them with worktree-keep", async () => {
  const { root, room } = await fixture();
  const gitWorktreeDir = path.join(room.cwd, ".git", "worktrees", "wt-50");
  await mkdir(gitWorktreeDir, { recursive: true });
  const tempDisposable = await mkdtemp(path.join(tmpdir(), "ork-disposable-"));
  const disposableDir = path.join(await realpath(tempDisposable), "wt-50");
  await mkdir(disposableDir, { recursive: true });
  const tempPersistent = await mkdtemp(path.join(tmpdir(), "ork-persistent-"));
  const persistentDir = await realpath(tempPersistent);
  directories.push(tempDisposable, persistentDir);

  const markerPath = path.join(gitWorktreeDir, "orkest.json");
  await writeFile(path.join(disposableDir, ".git"), `gitdir: ${gitWorktreeDir}\n`);
  await writeFile(
    markerPath,
    JSON.stringify(
      {
        schema: "orkest.worktree.v1",
        disposable: true,
        parentCwd: room.cwd,
        roomId: room.id,
        slug: "wt-50",
        branch: "feat/issue-50",
      },
      null,
      2,
    ),
  );

  await growRoom(room.id, parseTeam("agy:pro@ui-designer"), root, "conductor", {
    cwd: disposableDir,
  });
  await growRoom(room.id, parseTeam("claude:haiku@scout"), root, "conductor", {
    cwd: room.cwd,
  });
  await growRoom(room.id, parseTeam("codex:luna@reviewer"), root, "conductor", {
    cwd: persistentDir,
  });

  const saved = await readRoom(room.id, root);
  expect(saved.agents[0].worktree).toEqual({
    path: disposableDir,
    branch: "feat/issue-50",
    disposable: true,
    parentCwd: room.cwd,
    slug: "wt-50",
  });
  expect(saved.agents[1].worktree).toBeUndefined();
  expect(saved.agents[2].worktree).toBeUndefined();

  expect(agentFolder(saved.agents[0], saved)).toBe(room.cwd);
  expect(worktreeBadge(saved.agents[0], saved)).toBe("wt:wt-50");
  expect(agentFolder(saved.agents[2], saved)).toBe(persistentDir);
  expect(worktreeBadge(saved.agents[2], saved)).toBe("");

  const view = new HordeView(saved, { height: 36, tier: "unicode", color: true });
  const coloredOutput = view.render(110).join("\n");
  expect(coloredOutput).not.toContain("\u{1B}[48;5;24;97;1m");
  expect(coloredOutput).toContain("\u{1B}[48;5;237;97;1m");

  const plainView = new HordeView(saved, { height: 36, tier: "unicode" });
  const output = plainView.render(140).join("\n");
  expect(output).toContain(`│ ${path.basename(room.cwd)} · 2 agents`);
  expect(output).toContain(`│ ${path.basename(persistentDir)} · 1 agent`);
  expect(output).not.toContain(`wt-50 · 1 agent`);
  expect(output).toContain("▸ 1 luna-1");
  expect(output).toContain("wt:wt-50");

  const stdout = { write() {} };
  await roomsCommand(["worktree-keep", "--room", room.id, "--member", "pro-1"], { root, stdout });

  const markerAfterKeep = JSON.parse(await readFile(markerPath, "utf8"));
  expect(markerAfterKeep.disposable).toBe(false);

  const promotedRoom = await observeRoom(room.id, { root });
  expect(promotedRoom.agents[0].worktree).toMatchObject({
    path: disposableDir,
    disposable: false,
    parentCwd: room.cwd,
    slug: "wt-50",
  });
  expect(agentFolder(promotedRoom.agents[0], promotedRoom)).toBe(disposableDir);
  expect(worktreeBadge(promotedRoom.agents[0], promotedRoom)).toBe("");

  const promotedOutput = new HordeView(promotedRoom, { height: 36, tier: "unicode" })
    .render(140)
    .join("\n");
  expect(promotedOutput).toContain(`wt-50 · 1 agent`);
  expect(promotedOutput).toContain(`${path.basename(room.cwd)} · 1 agent`);

  await updateRoom(
    room.id,
    (current) => {
      current.agents[1].worktree = {
        path: disposableDir,
        disposable: true,
        parentCwd: room.cwd,
        slug: "wt-inline",
      };
      return current;
    },
    { root },
  );
  await keepWorktree(room.id, "haiku-1", { root });
  expect((await readRoom(room.id, root)).agents[1].worktree.disposable).toBe(false);
});

it("persists conductor.model and forwards --model for interactive coordinator launches", async () => {
  const { root, room: existingRoom } = await fixture();
  const result = await execute(
    process.execPath,
    [cli, "agy", "--model", "gemini-pro-orchestrator", "--json"],
    {
      env: { ...process.env, AGENT_EXECUTOR_HOME: root },
    },
  );
  const created = JSON.parse(result.stdout);
  expect(created.conductor).toMatchObject({
    engine: "agy",
    model: "gemini-pro-orchestrator",
    status: "awaiting session",
  });
  expect((await readRoom(created.id, path.join(root, "mailbox-v1"))).conductor.model).toBe(
    "gemini-pro-orchestrator",
  );

  const previousHome = process.env.AGENT_EXECUTOR_HOME;
  process.env.AGENT_EXECUTOR_HOME = root;
  try {
    const launches = [];
    const ttyStdout = { isTTY: true, columns: 100, write() {} };
    await orkMain(["agy", "-m", "gemini-pro-orchestrator"], {
      stdout: ttyStdout,
      runTerminal: async (script, args) => {
        launches.push({ script, args });
        return 0;
      },
    });
    expect(launches).toHaveLength(1);
    expect(launches[0].script).toBe("agent_statusline_tmux.py");
    expect(launches[0].args.slice(-3)).toEqual(["agy", "--model", "gemini-pro-orchestrator"]);

    // Existing --model/--harness-arg prevents duplicating --model.
    await orkMain(["agy", "--model", "gemini-pro-orchestrator", "--harness-arg=--model=custom"], {
      stdout: ttyStdout,
      runTerminal: async (script, args) => {
        launches.push({ script, args });
        return 0;
      },
    });
    expect(launches[1].args.slice(-2)).toEqual(["agy", "--model=custom"]);

    await expect(
      orkMain(["agy", "--attach-room", existingRoom.id, "--model", "gemini-pro-orchestrator"], {
        stdout: ttyStdout,
      }),
    ).rejects.toThrow("keeps its coordinator");
    await expect(orkMain(["agy", "--model", " ".repeat(3), "--json"])).rejects.toThrow(
      "--model requires a value",
    );
    await expect(orkMain(["opencode", "--model", "glm:flash", "--json"])).rejects.toThrow(
      "OpenCode interactive sessions do not accept --model",
    );
  } finally {
    if (previousHome === undefined) delete process.env.AGENT_EXECUTOR_HOME;
    else process.env.AGENT_EXECUTOR_HOME = previousHome;
  }
});

it("drives parseTeam from families.json schema and live catalog capabilities", () => {
  const catalog = {
    platforms: {
      codex: {
        status: "live",
        models: [
          {
            id: "gpt-6.1-sol",
            supported_efforts: ["low", "medium", "high"],
            composite: false,
          },
        ],
      },
      agy: {
        status: "live",
        models: [
          {
            id: "gemini-4-carbon-low",
            family_stem: "gemini-4-carbon",
            effort_slug: "low",
            supported_efforts: ["low", "high"],
            composite: false,
          },
          {
            id: "gemini-4-carbon-high",
            family_stem: "gemini-4-carbon",
            effort_slug: "high",
            supported_efforts: ["low", "high"],
            composite: false,
          },
          {
            id: "gemini-pro-orchestrator",
            family_stem: "gemini-pro-orchestrator",
            effort_slug: null,
            supported_efforts: [],
            composite: true,
          },
        ],
      },
      claude: {
        status: "live",
        models: [
          {
            id: "opus",
            supported_efforts: ["low", "medium", "high", "max"],
            composite: false,
          },
        ],
      },
    },
  };

  const parsed = parseTeam("claude:best:high,agy:flash,codex:sol:high,agy:orchestrator", {
    catalog,
  });
  expect(parsed).toEqual([
    { engine: "claude", model: "opus", effort: "high", label: "best" },
    { engine: "agy", model: "gemini:fast", label: "flash" },
    { engine: "codex", model: "gpt:sol", effort: "high", label: "sol" },
    { engine: "agy", model: "gemini:orchestrator", label: "orchestrator" },
  ]);

  expect(parseTeam("agy:carbon:high", { catalog })).toEqual([
    { engine: "agy", model: "gemini:carbon-high", effort: "high", label: "carbon" },
  ]);

  expect(() => parseTeam("agy:orchestrator:high", { catalog })).toThrow(/composite/i);
  expect(() => parseTeam("agy:gemini-4-carbon-high:low", { catalog })).toThrow(/conflicts/i);
  expect(() => parseTeam("codex:sol:xhigh", { catalog })).toThrow(/Unsupported effort/i);
  expect(() => parseTeam("codex:gpt-6.1-sol:xhigh", { catalog })).toThrow(/Unsupported effort/i);
  expect(() => parseTeam("codex:no-such-model", { catalog, validateCatalog: true })).toThrow(
    /Unknown codex model/,
  );

  const customSchema = {
    effort_suffixes: ["turbo"],
    families: {
      acme: {
        engine: "acmecli",
        default_for_engine: true,
        default_tier: "base",
        tiers: { base: "acme-1-base" },
      },
    },
  };
  expect(parseTeam("acmecli:base:turbo", { schema: customSchema })).toEqual([
    { engine: "acmecli", model: "acme:base", effort: "turbo", label: "base" },
  ]);
});
