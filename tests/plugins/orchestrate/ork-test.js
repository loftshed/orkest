import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { HALL_HELP, hallCommand } from "../../../plugins/orchestrate/bin/hall.mjs";
import { coordinatorArguments } from "../../../plugins/orchestrate/bin/ork.mjs";
import {
  extractIssueArchetype,
  extractTaskSpec,
  factoryCommand,
  hasDisjointPaths,
  matchIssuesToPools,
  matchIssueToPool,
  planBatch,
  selectSparePool,
  selectSparePools,
} from "../../../plugins/orchestrate/lib/factory.mjs";
import * as hallModule from "../../../plugins/orchestrate/lib/hall.mjs";
import * as roomsModule from "../../../plugins/orchestrate/lib/rooms.mjs";
import {
  cacheHome,
  configPath,
  envFirst,
} from "../../../plugins/orchestrate/lib/runtime-paths.mjs";
import {
  createRoom,
  mailboxRoot,
  parseTeam,
  refreshMemberWorktrees,
  updateRoom,
} from "../../../plugins/orchestrate/lib/stooges-room.mjs";
import * as swarmModule from "../../../plugins/orchestrate/lib/swarm.mjs";

const exec = promisify(execFile);
const cli = path.resolve("plugins/orchestrate/bin/ork.mjs");
const temporary = [];

describe("coordinator launch arguments", () => {
  it.each([
    ["codex", ["--yolo"], ["--yolo", "the coordinator prompt"]],
    [
      "claude",
      ["--remote-control=Orkest", "--dangerously-skip-permissions"],
      ["--remote-control=Orkest", "--dangerously-skip-permissions", "the coordinator prompt"],
    ],
    [
      "agy",
      ["--remote-control", "--dangerously-skip-permissions"],
      [
        "--remote-control",
        "--dangerously-skip-permissions",
        "--prompt-interactive",
        "the coordinator prompt",
      ],
    ],
    ["opencode", ["--auto"], ["--auto", "--prompt", "the coordinator prompt"]],
  ])("passes launch options to %s before its prompt", (engine, flags, expected) => {
    expect(coordinatorArguments(engine, "the coordinator prompt", flags)).toEqual(expected);
  });

  it("omits prompt arguments when launching a coordinator for first-message hook delivery", () => {
    expect(
      coordinatorArguments("agy", "", ["--remote-control", "--dangerously-skip-permissions"]),
    ).toEqual(["--remote-control", "--dangerously-skip-permissions"]);
    expect(coordinatorArguments("claude", "", ["--permission-mode", "auto"])).toEqual([
      "--permission-mode",
      "auto",
    ]);
    expect(coordinatorArguments("codex", "")).toEqual([]);
  });
});
async function sandbox() {
  const dir = await mkdtemp(path.join(tmpdir(), "ork-cli-test-"));
  temporary.push(dir);
  const config = path.join(dir, "routes.json");
  const monitor = path.join(dir, "monitor.json");
  await writeFile(config, JSON.stringify({ routes: {} }));
  await writeFile(monitor, JSON.stringify({ accounts: [] }));
  const env = {
    ...process.env,
    AGENT_EXECUTOR_HOME: dir,
    AGENT_EXECUTOR_CONFIG: config,
    MONITOR_CONFIG: monitor,
    MONITOR_CACHE_DIR: path.join(dir, "monitor-cache"),
    LANG: "en_US.UTF-8",
    NO_COLOR: "1",
    TERM: "xterm-256color",
  };
  return { dir, config, run: (args) => exec(process.execPath, [cli, ...args], { env }) };
}
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("ork routes", () => {
  it("wraps strengths at spaces and splits only oversized words", async () => {
    const app = await sandbox();
    for (const [strength, expected] of [
      [
        "complex coding, agentic workflows, professional software work",
        ["complex coding, agentic workflows,", "professional software work"],
      ],
      ["x".repeat(50), ["x".repeat(36), "x".repeat(14)]],
    ]) {
      await writeFile(
        app.config,
        JSON.stringify({
          routes: { "debug-invariants": { engine: "codex", model: "gpt:sol" } },
          families: {
            gpt: {
              engine: "codex",
              tiers: { sol: "fixture" },
              tier_strengths: { sol: [strength] },
            },
          },
        }),
      );
      const { stdout } = await app.run([
        "routes",
        "--archetype",
        "debug-invariants",
        "--width",
        "110",
      ]);
      expect(stdout).toContain("┌ Routes");
      for (const line of expected) expect(stdout).toContain(line);
    }
  });

  it("lists the six task archetypes with ordered candidates and tier strengths", async () => {
    const app = await sandbox();
    const result = JSON.parse((await app.run(["routes", "--json"])).stdout);
    expect(result.schema).toBe("ork.routes.v1");
    expect(
      result.routes.map((route) => route.archetype).sort((a, b) => a.localeCompare(b)),
    ).toEqual([
      "architecture-conductor",
      "debug-invariants",
      "independent-review",
      "mechanical-sweep",
      "structural-refactor",
      "ui-design-system",
    ]);
    for (const route of result.routes) {
      expect(route.candidates.length).toBeGreaterThan(0);
      for (const candidate of route.candidates) {
        expect(candidate).toMatchObject({
          engine: expect.any(String),
          model: expect.any(String),
          tier_strengths: expect.any(Array),
        });
      }
    }
  });

  it("filters an archetype and respects the configured primary candidate", async () => {
    const app = await sandbox();
    await writeFile(
      app.config,
      JSON.stringify({
        routes: {
          "debug-invariants": { engine: "claude", model: "claude:fast", effort: "medium" },
        },
      }),
    );
    const result = JSON.parse(
      (await app.run(["routes", "--archetype", "debug-invariants", "--json"])).stdout,
    );
    expect(result.routes).toHaveLength(1);
    expect(result.routes[0]).toMatchObject({
      archetype: "debug-invariants",
      candidates: [
        expect.objectContaining({ engine: "claude", model: "claude:fast", effort: "medium" }),
      ],
    });
    const printed = (await app.run(["routes", "--archetype", "debug-invariants", "--width", "80"]))
      .stdout;
    expect(printed).toContain("debug-invariants");
    expect(printed).toContain("claude:fast");
    expect(printed).not.toContain("\u{1B}");
  });

  it("frames route summaries at compact, medium and wide widths", async () => {
    const app = await sandbox();
    for (const width of [40, 64, 80]) {
      const { stdout } = await app.run([
        "routes",
        "--archetype",
        "debug-invariants",
        "--width",
        String(width),
      ]);
      expect(stdout).toContain("Routes");
      expect(stdout.split("\n").every((line) => line.length <= width)).toBe(true);
    }
  });
});

describe("ork telemetry", () => {
  it("summarizes local receipts and renders rates without running models", async () => {
    const app = await sandbox();
    const runs = path.join(app.dir, "runs with spaces");
    for (const [id, status, duration] of [
      ["one", "COMPLETE", 1000],
      ["two", "FAILED", 3000],
    ]) {
      const run = path.join(runs, id);
      await mkdir(run, { recursive: true });
      await writeFile(
        path.join(run, "result.json"),
        JSON.stringify({
          task_archetype: "debug-invariants",
          engine: "codex",
          model: "fixture-model",
          effort: "high",
          status,
          duration_ms: duration,
          verification: { passed: status === "COMPLETE" },
        }),
      );
    }
    const result = JSON.parse((await app.run(["telemetry", "--runs-dir", runs, "--json"])).stdout);
    expect(result).toMatchObject({
      runs: 2,
      skipped_results: 0,
      groups: [
        {
          task_archetype: "debug-invariants",
          engine: "codex",
          model: "fixture-model",
          runs: 2,
          accepted_rate: 0.5,
          first_pass_rate: 0.5,
          median_duration_ms: 2000,
        },
      ],
    });
    const printed = (await app.run(["telemetry", "--runs-dir", runs, "--width", "120"])).stdout;
    expect(printed).toContain("┌ Telemetry");
    expect(printed).toContain("debug-invariants");
    expect(printed).toMatch(/50(?:\.0)?%/u);
    expect(printed).toContain("2.0s");
    expect(printed.split("\n").every((line) => line.length <= 120)).toBe(true);
    expect(printed).not.toContain("\u{1B}");
    const narrow = (await app.run(["telemetry", "--runs-dir", runs, "--width", "40"])).stdout;
    expect(narrow).toContain("95% confidence");
    expect(narrow.split("\n").every((line) => line.length <= 40)).toBe(true);
  });
});

describe("ork quota", () => {
  it("supports isolated JSON, line and refresh output with no configured providers", async () => {
    const app = await sandbox();
    const result = JSON.parse((await app.run(["quota", "--json"])).stdout);
    expect(result.accounts).toEqual([]);
    expect((await app.run(["quota", "--line"])).stdout.trim()).toBe("");
    expect((await app.run(["quota", "--refresh"])).stdout).toContain("Monitor");
  });
});

describe("ork gate", () => {
  it("passes the gate's output and exit code through", async () => {
    const app = await sandbox();
    const env = { ...process.env, AGENT_GATE_DIR: path.join(app.dir, "gate") };
    const { stdout } = await exec(process.execPath, [cli, "gate", "status"], { env });
    expect(stdout).toContain("gate: free");
    await expect(
      exec(process.execPath, [cli, "gate", "--", "rm", "-rf", "nothing"], { env }),
    ).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("test, build, typecheck and lint commands only"),
    });
  });
});

describe("ork command validation", () => {
  it.each([
    ["routes", "--runs-dir", "/tmp"],
    ["routes", "--refresh"],
    ["routes", "--archetype", "unknown"],
    ["routes", "--width", "0"],
    ["telemetry", "--team", "claude:haiku"],
    ["telemetry", "--width", "NaN"],
    ["quota", "--json", "--line"],
    ["quota", "--archetype", "debug-invariants"],
  ])("rejects unrelated or invalid command options %j", async (...args) => {
    const app = await sandbox();
    await expect(app.run(args)).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("ork:"),
    });
  });
});

describe("ork factory", () => {
  const validSpecBody = [
    "## Objective",
    "Implement spare-token backlog execution.",
    "",
    "```json task-spec",
    JSON.stringify(
      {
        acceptance_criteria: ["ork factory status lists spare pools."],
        allow_paths: ["plugins/orchestrate/lib/factory.mjs"],
        development_checks: ["vitest run tests/plugins/orchestrate/ork-test.js"],
        objective: "Add ork factory subcommand",
        plan: ["Parse embedded ```json task-spec blocks from issues"],
        schema: "agent-executor.task-spec.v1",
      },
      null,
      2,
    ),
    "```",
  ].join("\n");

  it("extracts valid task-spec blocks and rejects malformed or incomplete specs", () => {
    const extracted = extractTaskSpec(validSpecBody);
    expect(extracted).toMatchObject({
      allow_paths: ["plugins/orchestrate/lib/factory.mjs"],
      objective: "Add ork factory subcommand",
      schema: "agent-executor.task-spec.v1",
    });

    const plainJsonBody = [
      "```json",
      JSON.stringify({
        allow_paths: ["plugins/monitor/lib/analyze.mjs"],
        development_checks: ["vitest run"],
        objective: "Plain JSON block with schema",
        schema: "agent-executor.task-spec.v1",
      }),
      "```",
    ].join("\n");
    expect(extractTaskSpec(plainJsonBody)).toMatchObject({
      allow_paths: ["plugins/monitor/lib/analyze.mjs"],
      objective: "Plain JSON block with schema",
    });

    expect(extractTaskSpec("No code block here")).toBeNull();
    expect(
      extractTaskSpec(
        '```json\n{"objective":"Missing schema","allow_paths":["a"],"development_checks":["test"]}\n```',
      ),
    ).toBeNull();
    expect(
      extractTaskSpec('```json task-spec\n{"objective":"Missing checks","allow_paths":["a"]}\n```'),
    ).toBeNull();
  });

  it("detects disjoint and overlapping relative allow_paths", () => {
    expect(
      hasDisjointPaths(
        ["plugins/orchestrate/lib/factory.mjs"],
        [["plugins/monitor/lib/analyze.mjs"], ["scripts/release.js"]],
      ),
    ).toBe(true);
    expect(hasDisjointPaths(["a/b"], [["a/bc"]])).toBe(true);
    expect(hasDisjointPaths(["a/b"], [["a/b/c.js"]])).toBe(false);
    expect(hasDisjointPaths(["./a/b/c.js"], [["a/b/"]])).toBe(false);
    expect(hasDisjointPaths([], [["a/b"]])).toBe(false);
  });

  it("selects available expiring or surplus pools while refusing credits, blocked, and unauthorized pools", () => {
    const lanes = [
      {
        accountId: "codex-main",
        availableNowPct: 80,
        credits: { balance: 40, hasCredits: true, text: "40 cr" },
        label: "Codex Credits",
        poolId: "codex",
        provider: "codex",
        score: -250,
        status: "credits",
        surplusPts: 50,
      },
      {
        accountId: "claude-work",
        availableNowPct: 0,
        label: "Claude Work",
        poolId: "claude",
        provider: "claude",
        score: -1005,
        status: "blocked",
        surplusPts: 30,
      },
      {
        accountId: "claude-personal",
        availableNowPct: 90,
        billing: "personal",
        label: "Claude Personal",
        poolId: "claude",
        provider: "claude",
        score: 40,
        status: "available",
        surplusPts: 40,
      },
      {
        accountId: "agy-main",
        availableNowPct: 75,
        label: "Antigravity · Gemini",
        pace: { surplus: 22 },
        poolId: "gemini",
        provider: "antigravity",
        score: 22,
        status: "available",
      },
      {
        accountId: "codex-pro",
        availableNowPct: 60,
        burnPctPerHour: 12,
        expiring: true,
        label: "Codex Expiring",
        pace: { surplus: 8 },
        poolId: "codex",
        provider: "codex",
        score: 1012,
        status: "available",
      },
    ];

    const filtered = selectSparePools(lanes, { allowPersonal: false, minSurplusPts: 15 });
    expect(filtered.map((pool) => pool.accountId)).toEqual(["codex-pro", "agy-main"]);
    expect(selectSparePool(lanes, { allowPersonal: false, minSurplusPts: 15 })?.accountId).toBe(
      "codex-pro",
    );
    expect(
      selectSparePool(lanes, {
        allowedPools: ["agy-main:gemini"],
        allowPersonal: false,
        minSurplusPts: 15,
      })?.accountId,
    ).toBe("agy-main");
  });

  it("matches archetypes and spreads multiple ready issues across distinct harnesses and models", () => {
    const lanes = [
      {
        accountId: "claude-work",
        availableNowPct: 85,
        families: ["claude"],
        label: "Claude Work",
        pace: { surplus: 28 },
        poolId: "claude",
        provider: "claude",
        route: "--engine claude",
        score: 28,
        status: "available",
      },
      {
        accountId: "agy-work",
        availableNowPct: 90,
        families: ["gemini"],
        label: "Antigravity Gemini",
        pace: { surplus: 26 },
        poolId: "gemini",
        provider: "antigravity",
        route: "--engine agy",
        score: 26,
        status: "available",
      },
      {
        accountId: "codex-work",
        availableNowPct: 80,
        families: ["gpt"],
        label: "Codex Work",
        pace: { surplus: 30 },
        poolId: "codex",
        provider: "codex",
        route: "--engine codex",
        score: 30,
        status: "available",
      },
    ];

    const makeIssue = (number, allowPath, archetypeLabel, metadataArchetype) => ({
      body: [
        "```json task-spec",
        JSON.stringify({
          allow_paths: [allowPath],
          development_checks: ["vitest run"],
          ...(metadataArchetype && { metadata: { archetype: metadataArchetype } }),
          objective: `Task for issue ${number}`,
          schema: "agent-executor.task-spec.v1",
        }),
        "```",
      ].join("\n"),
      labels: ["agent:ready", ...(archetypeLabel ? [`archetype:${archetypeLabel}`] : [])],
      number,
      state: "open",
      title: `Issue ${number}`,
    });

    const issues = [
      makeIssue(101, "plugins/a/index.mjs", "structural-refactor"),
      makeIssue(102, "plugins/b/index.mjs", "architecture-conductor"),
      makeIssue(103, "plugins/c/index.mjs", null, "debug-invariants"),
      // Overlapping path with 101 should be skipped in the same batch:
      makeIssue(104, "plugins/a/index.mjs", "mechanical-sweep"),
    ];

    expect(extractIssueArchetype(issues[0])).toBe("structural-refactor");
    expect(extractIssueArchetype(issues[2], extractTaskSpec(issues[2].body))).toBe(
      "debug-invariants",
    );

    const singleMatch = matchIssueToPool([issues[1]], lanes);
    expect(singleMatch?.selectedRoute).toMatchObject({
      archetype: "architecture-conductor",
      engine: "agy",
      model: "gemini:pro",
    });

    const batch = matchIssuesToPools(issues, lanes);
    expect(planBatch).toBe(matchIssuesToPools);
    expect(batch).toHaveLength(3);
    expect(batch.map((item) => item.issue.number)).toEqual([101, 102, 103]);

    const engines = new Set(batch.map((item) => item.selectedRoute.engine));
    const models = new Set(batch.map((item) => item.selectedRoute.model));
    expect(engines).toEqual(new Set(["claude", "agy", "codex"]));
    expect(models.size).toBe(3);

    // Even when multiple builder issues share the same archetype, batch planning spreads across harnesses:
    const homogeneousIssues = [
      makeIssue(201, "plugins/one.mjs", "debug-invariants"),
      makeIssue(202, "plugins/two.mjs", "debug-invariants"),
      makeIssue(203, "plugins/three.mjs", "debug-invariants"),
    ];
    const spreadBatch = planBatch(homogeneousIssues, lanes);
    expect(new Set(spreadBatch.map((item) => item.selectedRoute.engine))).toEqual(
      new Set(["codex", "claude", "agy"]),
    );
  });

  it("supports factoryCommand status --json, run --dry-run, and groom --dry-run with injected mocks", async () => {
    const now = Date.now();
    const mockAccounts = [
      {
        fetchedAt: now,
        id: "codex-work",
        label: "Codex Work",
        ok: true,
        pools: [{ families: ["gpt"], id: "codex", label: "Codex", windowIds: ["wk"] }],
        provider: "codex",
        route: "--engine codex",
        windows: [
          {
            id: "wk",
            label: "Weekly",
            remainingPct: 85,
            resetsAt: now + 3 * 24 * 3600 * 1000,
            windowMins: 10_080,
          },
        ],
      },
    ];
    const mockIssues = [
      {
        body: "Needs grooming into a task-spec.",
        labels: [{ name: "agent:raw" }],
        number: 55,
        title: "Raw backlog item",
      },
      {
        body: validSpecBody,
        labels: [{ name: "agent:ready" }, { name: "archetype:debug-invariants" }],
        number: 57,
        title: "Ready factory item",
      },
    ];

    const chunks = [];
    const stdout = {
      columns: 120,
      isTTY: false,
      write: (chunk) => {
        chunks.push(chunk);
      },
    };

    const status = await factoryCommand(["status", "--json"], {
      execGhFn: async () => mockIssues,
      getAccountsFn: async () => mockAccounts,
      stdout,
    });
    expect(status.schema).toBe("ork.factory.status.v1");
    expect(status.sparePools).toHaveLength(1);
    expect(status.readyIssues).toHaveLength(1);
    expect(status.rawIssues).toEqual([{ number: 55, title: "Raw backlog item" }]);
    expect(status.nextMatch).toMatchObject({
      archetype: "debug-invariants",
      branch: "feat/issue-57",
      issue: { number: 57, title: "Ready factory item" },
      selectedRoute: { engine: "codex", model: "gpt:sol" },
      worktreeSlug: "wt-issue-57",
    });

    chunks.length = 0;
    const dryRun = await factoryCommand(["run", "--dry-run"], {
      execGhFn: async () => mockIssues,
      getAccountsFn: async () => mockAccounts,
      stdout,
    });
    expect(dryRun).toMatchObject({
      branch: "feat/issue-57",
      dryRun: true,
      matched: true,
      verifyCommand: "vitest run tests/plugins/orchestrate/ork-test.js",
      worktreeSlug: "wt-issue-57",
    });
    expect(chunks.join("")).toContain("wt-issue-57");
    expect(chunks.join("")).toContain("feat/issue-57");

    chunks.length = 0;
    const groomDryRun = await factoryCommand(["groom", "--issue", "55", "--dry-run"], {
      execGhFn: async () => mockIssues[0],
      stdout,
    });
    expect(groomDryRun).toMatchObject({
      dryRun: true,
      issue: { number: 55, title: "Raw backlog item" },
      schema: "ork.factory.groom.v1",
    });
    expect(chunks.join("")).toContain("run_agent.py consult --intent investigate --read");
  });
});

describe("ork name", () => {
  it("generates a full agent name by default", async () => {
    const app = await sandbox();
    const { stdout } = await app.run(["name"]);
    expect(stdout.trim().length).toBeGreaterThan(0);
    expect(stdout.trim()).toMatch(/^[a-z]+-[a-z0-9.-]+-[0-9a-f]{2}$/);
  });

  it("generates a Herdr-compatible short agent name with --short", async () => {
    const app = await sandbox();
    const { stdout } = await app.run(["name", "--short"]);
    const shortName = stdout.trim();
    expect(shortName.length).toBeLessThanOrEqual(32);
    expect(shortName).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
  });
});

describe("runtime-paths and mailboxRoot resolution", () => {
  it("resolves ORCHESTRATE_* before AGENT_EXECUTOR_* and falls back to existing legacy directories", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ork-runtime-paths-"));
    temporary.push(dir);
    const xdgCache = path.join(dir, "cache");
    const xdgConfig = path.join(dir, "config");

    expect(
      envFirst("ORCHESTRATE_HOME", "AGENT_EXECUTOR_HOME", {
        ORCHESTRATE_HOME: "/new/home",
        AGENT_EXECUTOR_HOME: "/old/home",
      }),
    ).toBe("/new/home");
    expect(
      envFirst("ORCHESTRATE_HOME", "AGENT_EXECUTOR_HOME", {
        ORCHESTRATE_HOME: "",
        AGENT_EXECUTOR_HOME: "/old/home",
      }),
    ).toBe("/old/home");

    expect(
      mailboxRoot({
        ORCHESTRATE_HOME: "/new/home",
        AGENT_EXECUTOR_HOME: "/old/home",
      }),
    ).toBe(path.join("/new/home", "mailbox-v1"));
    expect(mailboxRoot({ AGENT_EXECUTOR_HOME: "/old/home" })).toBe(
      path.join("/old/home", "mailbox-v1"),
    );

    const env = { XDG_CACHE_HOME: xdgCache, XDG_CONFIG_HOME: xdgConfig };
    expect(cacheHome(env)).toBe(path.join(xdgCache, "orchestrate"));
    expect(mailboxRoot(env)).toBe(path.join(xdgCache, "orchestrate", "mailbox-v1"));
    expect(configPath(env)).toBe(path.join(xdgConfig, "orchestrate", "config.json"));

    await mkdir(path.join(xdgCache, "agent-executor"), { recursive: true });
    await mkdir(path.join(xdgConfig, "agent-executor"), { recursive: true });
    await writeFile(path.join(xdgConfig, "agent-executor", "config.json"), "{}");

    expect(cacheHome(env)).toBe(path.join(xdgCache, "agent-executor"));
    expect(mailboxRoot(env)).toBe(path.join(xdgCache, "agent-executor", "mailbox-v1"));
    expect(configPath(env)).toBe(path.join(xdgConfig, "agent-executor", "config.json"));

    await mkdir(path.join(xdgCache, "orchestrate"), { recursive: true });
    await mkdir(path.join(xdgConfig, "orchestrate"), { recursive: true });
    await writeFile(path.join(xdgConfig, "orchestrate", "config.json"), "{}");

    expect(cacheHome(env)).toBe(path.join(xdgCache, "orchestrate"));
    expect(mailboxRoot(env)).toBe(path.join(xdgCache, "orchestrate", "mailbox-v1"));
    expect(configPath(env)).toBe(path.join(xdgConfig, "orchestrate", "config.json"));
  });
});

describe("hall, rooms, and unified subcommands", () => {
  it("consolidates swarm.mjs and hall.mjs exports and defaults createRoom swarm/conductor settings", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ork-hall-unit-"));
    temporary.push(dir);

    expect(swarmModule.observeRoom).toBe(roomsModule.observeRoom);
    expect(swarmModule.coordinatorBrief).toBe(roomsModule.coordinatorBrief);
    expect(swarmModule.resumeBranch).toBe(roomsModule.resumeBranch);
    expect(hallModule.observeRoom).toBe(roomsModule.observeRoom);
    expect(hallModule.createRoom).toBe(createRoom);
    expect(typeof hallCommand).toBe("function");
    expect(HALL_HELP).toContain("rooms");

    const room = createRoom(parseTeam("claude:haiku"), {
      id: "room-unit",
      cwd: dir,
    });
    expect(room.swarm).toEqual({ maxAgents: 64, maxDepth: 8 });
    expect(room.conductor.engine).toBe("claude");

    const sub = path.join(dir, "sub");
    const fakeGitDir = path.join(dir, "gitdir-sub");
    await mkdir(sub, { recursive: true });
    await mkdir(fakeGitDir, { recursive: true });
    await writeFile(path.join(sub, ".git"), `gitdir: ${fakeGitDir}\n`);
    await writeFile(
      path.join(fakeGitDir, "orkest.json"),
      JSON.stringify({ disposable: true, parentCwd: dir, slug: "wt-sub", branch: "feat/sub" }),
    );
    room.agents[0].cwd = sub;
    refreshMemberWorktrees(room);
    expect(room.agents[0].worktree).toMatchObject({
      disposable: true,
      path: path.resolve(sub),
      slug: "wt-sub",
    });
  });

  it("reads task and progress files in observeRoom without spawning Python subprocesses", async () => {
    const rawDir = await mkdtemp(path.join(tmpdir(), "ork-observe-node-"));
    const dir = await realpath(rawDir);
    temporary.push(dir);
    const root = path.join(dir, "mailbox-v1");
    const taskDir = path.join(dir, "task-1");
    await mkdir(taskDir, { recursive: true });
    const nowIso = new Date().toISOString();
    await writeFile(
      path.join(taskDir, "task.json"),
      JSON.stringify({
        schema: "agent-executor.task.v1",
        task_id: "task-1",
        repository: dir,
        runs: [
          {
            request_id: "req-1",
            run_id: "run-1",
            engine: "codex",
            transport: "executor",
            status: "active",
            last_activity: "Inspecting hall module",
          },
        ],
        decisions: [],
        updated_at: nowIso,
      }),
    );

    const sessionKey = "lead-session-1";
    await mkdir(path.join(root, "peers"), { recursive: true });
    await mkdir(path.join(root, "progress"), { recursive: true });
    await writeFile(
      path.join(root, "peers", `${sessionKey}.json`),
      JSON.stringify({
        schema: "agent-executor.peer.v1",
        session: sessionKey,
        name: "lead-agent",
        harness: "codex",
        cwd: dir,
        pid: process.pid,
        startedAt: nowIso,
        lastSeenAt: nowIso,
      }),
    );
    await writeFile(
      path.join(root, "progress", `${sessionKey}.json`),
      JSON.stringify({
        schema: "orchestrate.progress.v1",
        session: sessionKey,
        harness: "codex",
        machine: hostname(),
        checkout: dir,
        goal: "Unify Hall",
        task: "Replace Python readers",
        stage: "testing",
        files: ["plugins/orchestrate/lib/rooms.mjs"],
        updatedAt: nowIso,
      }),
    );

    const room = await roomsModule.newRoom(parseTeam("codex:luna"), {
      id: "room-node",
      cwd: dir,
      root,
    });
    await updateRoom(
      room.id,
      (current) => {
        current.conductor.session = {
          id: sessionKey,
          engine: "codex",
          machine: hostname(),
          cwd: dir,
        };
        current.agents[0].dispatch = {
          taskDir,
          taskId: "task-1",
          requestId: "req-1",
          runId: "run-1",
          transport: "executor",
        };
        return current;
      },
      { root },
    );

    const observed = await roomsModule.observeRoom(room.id, { root });
    expect(observed.conductor.progress.goal).toBe("Unify Hall");
    expect(observed.conductor.progress.task).toBe("Replace Python readers");
    expect(observed.conductor.status).toBe("testing");
    const worker = observed.agents[0];
    expect(worker.status).toBe("running");
    expect(worker.runId).toBe("run-1");
  });

  it("exposes horde, hall, foundry, smelter, radar, and gate in HELP and dispatches hall/smelter/radar", async () => {
    const app = await sandbox();
    const help = await app.run(["--help"]);
    for (const subcommand of [
      "ork horde",
      "ork hall",
      "ork foundry",
      "ork smelter",
      "ork radar",
      "ork gate",
    ]) {
      expect(help.stdout).toContain(subcommand);
    }

    const hallOut = await app.run(["hall", "list", "--json"]);
    expect(JSON.parse(hallOut.stdout)).toEqual({ rooms: [], errors: [] });

    const smelterHelp = await app.run(["smelter", "--help"]);
    expect(smelterHelp.stdout).toContain("ork smelter");

    const radarHelp = await app.run(["radar", "--help"]);
    expect(radarHelp.stdout).toContain("ork radar");
  });
});
