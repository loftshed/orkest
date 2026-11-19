import { execFileSync } from "node:child_process";
import { chmodSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  bootstrapWorktreeInclude,
  DEFAULT_ROUTES,
  enforceScopedVerifyCommand,
  factoryCommand,
  parseIssueDependencies,
  planBatch,
  poolSummary,
  resolveFoundryStatePath,
  resolveTaskSpecPath,
} from "../../../plugins/orchestrate/lib/factory.mjs";
import {
  collectActiveWorktreeAllowPaths,
  countCommitsAhead,
  FOUNDRY_STATE_SCHEMA,
  foundryCli,
  foundryGroom,
  foundryRun as foundryRunImpl,
  foundryStatus,
  isLaneDeniedByPolicy,
  loadFactoryPolicy,
  poolSupportsCandidate,
  readFoundryState,
  selectSparePools,
  writeFoundryState,
} from "../../../plugins/orchestrate/lib/foundry.mjs";
import {
  alignCanonicalPath,
  buildColdReviewQuestion,
  classifyBlastRadius,
  discoverSmeltableWorktrees,
  getBranchDiffFiles,
  parseColdReviewFindings,
  runSmeltCli,
  selectColdReviewerEngine,
  smelterCli,
  smeltWorktree,
} from "../../../plugins/orchestrate/lib/smelter.mjs";
import { retainFixtures } from "../../helpers/retain-fixtures.js";

// Foundry tests model Git explicitly too; no fallback can reach the host Git binary.
function foundryRun(args, options) {
  return foundryRunImpl(args, {
    execVerifyFn: async () => ({ exitCode: 0, ok: true, output: "explicit fixture verifier" }),
    execFileSyncFn: (cmd, argv) => {
      if (cmd === "git" && argv[0] === "rev-list") return "1\n";
      if (cmd === "git" && argv[0] === "rev-parse") return "fixture-head\n";
      return "";
    },
    ...options,
  });
}

const temporary = [];

async function makeTempDir(prefix = "ork-smelter-test-") {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  temporary.push(dir);
  return dir;
}

async function createRegisteredWorktree(repoRoot, wtPath, branch) {
  await mkdir(repoRoot, { recursive: true });
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], { cwd: repoRoot, stdio: "ignore" });
  } catch {
    execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "ignore" });
    await writeFile(path.join(repoRoot, "README.md"), "base\n");
    execFileSync("git", ["add", "README.md"], { cwd: repoRoot, stdio: "ignore" });
    execFileSync(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "init"],
      { cwd: repoRoot, stdio: "ignore" },
    );
  }
  execFileSync("git", ["worktree", "add", "-b", branch, wtPath, "main"], {
    cwd: repoRoot,
    stdio: "ignore",
  });
  return execFileSync("git", ["rev-parse", "--absolute-git-dir"], {
    cwd: wtPath,
    encoding: "utf8",
  }).trim();
}

afterEach(async () => {
  process.exitCode = 0;
  await retainFixtures(temporary.splice(0));
});

describe("foundry re-exports and factory fixes", () => {
  it("loads DEFAULT_ROUTES from routes.default.json and exposes foundry aliases", () => {
    expect(DEFAULT_ROUTES["debug-invariants"]).toMatchObject({
      engine: "codex",
      model: "gpt:sol",
    });
    expect(foundryCli).toBe(factoryCommand);
    expect(typeof foundryStatus).toBe("function");
    expect(typeof foundryGroom).toBe("function");
    expect(typeof foundryRun).toBe("function");

    expect(
      poolSummary({
        accountId: "codex-work",
        availableNowPct: 80,
        effort: "high",
        engine: "codex",
        expiring: false,
        label: "Codex Work",
        model: "gpt:sol",
        poolId: "codex",
        route: "--engine codex",
        score: 30,
        status: "available",
        surplusPts: 30,
      }),
    ).toEqual({
      accountId: "codex-work",
      availableNowPct: 80,
      effort: "high",
      engine: "codex",
      expiring: false,
      label: "Codex Work",
      model: "gpt:sol",
      poolId: "codex",
      route: "--engine codex",
      score: 30,
      status: "available",
      surplusPts: 30,
    });
  });

  it("parses Depends on #<n> and Blocked by #<n> and skips blocked issues in planBatch until blockers close", () => {
    expect(
      parseIssueDependencies(
        "Depends on #12\nAlso blocked by #34, #56 and #78.\nDepends on: #12\nUnrelated #99",
      ),
    ).toEqual([12, 34, 56, 78]);
    expect(parseIssueDependencies("No dependencies here")).toEqual([]);

    const lanes = [
      {
        accountId: "codex-work",
        availableNowPct: 85,
        families: ["gpt"],
        label: "Codex Work",
        pace: { surplus: 35 },
        poolId: "codex",
        provider: "codex",
        route: "--engine codex",
        score: 35,
        status: "available",
      },
      {
        accountId: "claude-work",
        availableNowPct: 85,
        families: ["claude"],
        label: "Claude Work",
        pace: { surplus: 30 },
        poolId: "claude",
        provider: "claude",
        route: "--engine claude",
        score: 30,
        status: "available",
      },
    ];

    const specFor = (allowPath) =>
      [
        "```json task-spec",
        JSON.stringify({
          allow_paths: [allowPath],
          development_checks: ["vitest run"],
          objective: `Update ${allowPath}`,
          schema: "agent-executor.task-spec.v1",
        }),
        "```",
      ].join("\n");

    const openBlocker12 = {
      body: specFor("plugins/a.mjs"),
      labels: ["agent:ready"],
      number: 12,
      state: "open",
      title: "Blocker 12",
    };
    const openBlocker34 = {
      body: specFor("plugins/b.mjs"),
      labels: ["agent:ready"],
      number: 34,
      state: "open",
      title: "Blocker 34",
    };
    const dependentIssue = {
      body: `Depends on #12\nBlocked by #34\n\n${specFor("plugins/c.mjs")}`,
      labels: ["agent:ready", "archetype:debug-invariants"],
      number: 50,
      state: "open",
      title: "Dependent 50",
    };

    const batchWhileOpen = planBatch([dependentIssue, openBlocker12, openBlocker34], lanes);
    expect(dependentIssue.blockedBy).toEqual([12, 34]);
    expect(batchWhileOpen.map((m) => m.issue.number)).toEqual([12, 34]);

    const closed12 = { ...openBlocker12, state: "closed" };
    const closed34 = { ...openBlocker34, state: "closed" };
    const batchAfterClosed = planBatch([dependentIssue, closed12, closed34], lanes);
    expect(dependentIssue.blockedBy).toEqual([]);
    expect(batchAfterClosed.map((m) => m.issue.number)).toEqual([50]);
  });

  it("bootstraps untracked files listed in .worktreeinclude into disposable worktrees", async () => {
    const repoRoot = await makeTempDir("ork-wt-include-src-");
    const worktreePath = await makeTempDir("ork-wt-include-dst-");

    await writeFile(
      path.join(repoRoot, ".worktreeinclude"),
      ["# Local environment files", "", ".env.local", "config/*.local.json", "nested/dir"].join(
        "\n",
      ),
    );
    await writeFile(path.join(repoRoot, ".env.local"), "SECRET=1\n");
    await mkdir(path.join(repoRoot, "config"), { recursive: true });
    await writeFile(path.join(repoRoot, "config", "app.local.json"), '{"port":4100}\n');
    await writeFile(path.join(repoRoot, "config", "tracked.json"), '{"tracked":true}\n');
    await mkdir(path.join(repoRoot, "nested", "dir"), { recursive: true });
    await writeFile(path.join(repoRoot, "nested", "dir", "token.txt"), "local-token\n");

    const copied = bootstrapWorktreeInclude(repoRoot, worktreePath);
    expect(copied).toEqual([".env.local", "config/app.local.json", "nested/dir/token.txt"]);
    expect(await readFile(path.join(worktreePath, ".env.local"), "utf8")).toBe("SECRET=1\n");
    expect(await readFile(path.join(worktreePath, "config", "app.local.json"), "utf8")).toBe(
      '{"port":4100}\n',
    );
    expect(await readFile(path.join(worktreePath, "nested", "dir", "token.txt"), "utf8")).toBe(
      "local-token\n",
    );
  });

  it("writes task-spec inside <git-dir>/orkest/task-spec.json and passes --route and --verify-command to run_agent.py", async () => {
    const rootDir = await makeTempDir("ork-factory-run-");
    const repoRoot = path.join(rootDir, "repo");
    const worktreePath = path.join(rootDir, "wt-issue-63");
    const gitDir = await createRegisteredWorktree(repoRoot, worktreePath, "feat/issue-63");
    await writeFile(
      path.join(gitDir, "orkest.json"),
      JSON.stringify({ branch: "feat/issue-63", disposable: true, issue: 63 }),
    );

    expect(resolveTaskSpecPath(worktreePath)).toBe(path.join(gitDir, "orkest", "task-spec.json"));

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
        body: [
          "```json task-spec",
          JSON.stringify({
            allow_paths: ["plugins/orchestrate/lib/factory.mjs"],
            development_checks: ["vitest run tests/plugins/orchestrate/smelter-test.js"],
            objective: "Fix factory execution args",
            schema: "agent-executor.task-spec.v1",
          }),
          "```",
        ].join("\n"),
        labels: [{ name: "agent:ready" }, { name: "archetype:debug-invariants" }],
        number: 63,
        title: "Fix factory",
      },
    ];

    let capturedArgs = null;
    const stdout = { columns: 120, isTTY: false, write: () => {} };
    const result = await foundryRun(["--json"], {
      cwd: repoRoot,
      execAgentFn: async (args) => {
        capturedArgs = args;
        return { status: "COMPLETE" };
      },
      execGhFn: async () => mockIssues,
      getAccountsFn: async () => mockAccounts,
      provisionWorktreeFn: async () => worktreePath,
      stdout,
    });

    expect(result.executed).toBe(true);
    expect(capturedArgs).not.toContain("run");
    expect(capturedArgs).not.toContain("--verify");
    expect(capturedArgs).toEqual([
      "--cwd",
      worktreePath,
      "--task-spec",
      path.join(gitDir, "orkest", "task-spec.json"),
      "--route",
      "debug-invariants",
      "--engine",
      "codex",
      "--account",
      "codex-work",
      "--model",
      "gpt:sol",
      "--verify-command",
      "vitest run tests/plugins/orchestrate/smelter-test.js",
      "--effort",
      "high",
    ]);

    const writtenSpec = JSON.parse(
      await readFile(path.join(gitDir, "orkest", "task-spec.json"), "utf8"),
    );
    expect(writtenSpec.objective).toBe("Fix factory execution args");
  });

  it("selects a secondary Codex pool (codex-2) in multi-account dispatch, forwards --account codex-2, and filters pools by route account/tags/claudeConfigDir", async () => {
    const rootDir = await makeTempDir("ork-foundry-multi-acct-");
    const repoRoot = path.join(rootDir, "repo");
    const worktreePath = path.join(rootDir, "wt-issue-64");
    const gitDir = await createRegisteredWorktree(repoRoot, worktreePath, "feat/issue-64");
    await writeFile(
      path.join(gitDir, "orkest.json"),
      JSON.stringify({ branch: "feat/issue-64", disposable: true, issue: 64 }),
    );

    const now = Date.now();
    const mockAccounts = [
      {
        fetchedAt: now,
        id: "codex-1",
        label: "Codex Primary",
        ok: true,
        pools: [{ families: ["gpt"], id: "codex", label: "Codex", windowIds: ["wk"] }],
        provider: "codex",
        route: "--engine codex",
        tags: ["work"],
        windows: [
          {
            id: "wk",
            label: "Weekly",
            remainingPct: 20,
            resetsAt: now + 6 * 24 * 3600 * 1000,
            windowMins: 10_080,
          },
        ],
      },
      {
        fetchedAt: now,
        id: "codex-2",
        alias: "codex-blue",
        aliases: ["codex-secondary"],
        label: "Codex Secondary",
        ok: true,
        pools: [{ families: ["gpt"], id: "codex", label: "Codex", windowIds: ["wk"] }],
        provider: "codex",
        route: "--engine codex",
        tags: ["personal", "blue"],
        windows: [
          {
            id: "wk",
            label: "Weekly",
            remainingPct: 92,
            resetsAt: now + 3 * 24 * 3600 * 1000,
            windowMins: 10_080,
          },
        ],
      },
    ];
    const mockIssues = [
      {
        body: [
          "```json task-spec",
          JSON.stringify({
            allow_paths: ["plugins/orchestrate/lib/foundry.mjs"],
            development_checks: ["vitest run tests/plugins/orchestrate/smelter-test.js"],
            objective: "Dispatch on secondary codex pool",
            schema: "agent-executor.task-spec.v1",
          }),
          "```",
        ].join("\n"),
        labels: [{ name: "agent:ready" }, { name: "archetype:debug-invariants" }],
        number: 64,
        title: "Multi-account foundry dispatch",
      },
    ];

    let capturedArgs = null;
    const stdout = { columns: 120, isTTY: false, write: () => {} };
    const result = await foundryRun(["--json"], {
      cwd: repoRoot,
      execAgentFn: async (args) => {
        capturedArgs = args;
        return { status: "COMPLETE" };
      },
      execGhFn: async () => mockIssues,
      getAccountsFn: async () => mockAccounts,
      provisionWorktreeFn: async () => worktreePath,
      stdout,
    });

    expect(result.executed).toBe(true);
    expect(result.pool.accountId).toBe("codex-2");
    expect(result.selectedRoute.accountId).toBe("codex-2");
    expect(capturedArgs).toEqual([
      "--cwd",
      worktreePath,
      "--task-spec",
      path.join(gitDir, "orkest", "task-spec.json"),
      "--route",
      "debug-invariants",
      "--engine",
      "codex",
      "--account",
      "codex-2",
      "--model",
      "gpt:sol",
      "--verify-command",
      "vitest run tests/plugins/orchestrate/smelter-test.js",
      "--effort",
      "high",
    ]);

    const claudePersonalDir = path.join(rootDir, ".claude-personal");
    const claudeWorkDir = path.join(rootDir, ".claude-work");
    const routeFilterLanes = [
      {
        accountId: "codex-1",
        alias: "codex-primary",
        engine: "codex",
        families: ["gpt"],
        poolId: "codex",
        score: 95,
        status: "available",
        surplusPts: 95,
        tags: ["work"],
      },
      {
        accountId: "codex-2",
        alias: "codex-blue",
        aliases: ["codex-secondary"],
        engine: "codex",
        families: ["gpt"],
        poolId: "codex",
        score: 40,
        status: "available",
        surplusPts: 40,
        tags: ["personal", "blue"],
      },
      {
        accountId: "claude-work",
        claudeConfigDir: claudeWorkDir,
        engine: "claude",
        families: ["claude"],
        poolId: "claude",
        score: 90,
        status: "available",
        surplusPts: 90,
        tags: ["work"],
      },
      {
        accountId: "claude-personal",
        claudeConfigDir: claudePersonalDir,
        engine: "claude",
        families: ["claude"],
        poolId: "claude",
        score: 35,
        status: "available",
        surplusPts: 35,
        tags: ["personal"],
      },
    ];
    const routeTaggedIssues = [
      {
        body: [
          "```json task-spec",
          JSON.stringify({
            allow_paths: ["plugins/orchestrate/lib/side.mjs"],
            development_checks: ["vitest run tests/plugins/orchestrate/side-test.js"],
            objective: "Route by account alias and tags",
            schema: "agent-executor.task-spec.v1",
          }),
          "```",
        ].join("\n"),
        labels: [{ name: "agent:ready" }, { name: "archetype:targeted-codex" }],
        number: 65,
        title: "Targeted codex route",
      },
      {
        body: [
          "```json task-spec",
          JSON.stringify({
            allow_paths: ["plugins/orchestrate/lib/chief.mjs"],
            development_checks: ["vitest run tests/plugins/orchestrate/chief-test.js"],
            objective: "Route by claudeConfigDir",
            schema: "agent-executor.task-spec.v1",
          }),
          "```",
        ].join("\n"),
        labels: [{ name: "agent:ready" }, { name: "archetype:targeted-claude" }],
        number: 66,
        title: "Targeted claude route",
      },
    ];
    const filteredBatch = planBatch(routeTaggedIssues, routeFilterLanes, [], {
      routes: {
        "targeted-claude": {
          claudeConfigDir: claudePersonalDir,
          effort: "medium",
          engine: "claude",
          model: "claude:balanced",
          tags: ["personal"],
        },
        "targeted-codex": {
          account: "codex-secondary",
          effort: "high",
          engine: "codex",
          model: "gpt:sol",
          tags: ["blue"],
        },
      },
    });
    expect(filteredBatch).toHaveLength(2);
    expect(filteredBatch[0].selectedRoute).toMatchObject({
      accountId: "codex-2",
      archetype: "targeted-codex",
      engine: "codex",
      model: "gpt:sol",
    });
    expect(filteredBatch[1].selectedRoute).toMatchObject({
      accountId: "claude-personal",
      archetype: "targeted-claude",
      engine: "claude",
      model: "claude:balanced",
    });
  });

  it("refuses unconstrained fallback when route account/tags/claudeConfigDir constraints reject all pools", async () => {
    const codexWorkOnly = [
      {
        accountId: "codex-1",
        alias: "codex-primary",
        engine: "codex",
        families: ["gpt"],
        poolId: "codex",
        score: 95,
        status: "available",
        surplusPts: 95,
        tags: ["work"],
      },
    ];
    const targetedCodexIssue = [
      {
        body: [
          "```json task-spec",
          JSON.stringify({
            allow_paths: ["plugins/orchestrate/lib/side.mjs"],
            development_checks: ["vitest run tests/plugins/orchestrate/side-test.js"],
            objective: "Require codex-secondary blue account",
            schema: "agent-executor.task-spec.v1",
          }),
          "```",
        ].join("\n"),
        labels: [{ name: "agent:ready" }, { name: "archetype:targeted-codex" }],
        number: 67,
        title: "Constrained codex issue",
      },
    ];
    expect(
      planBatch(targetedCodexIssue, codexWorkOnly, [], {
        routes: {
          "targeted-codex": {
            account: "codex-secondary",
            effort: "high",
            engine: "codex",
            model: "gpt:sol",
            tags: ["blue"],
          },
        },
      }),
    ).toEqual([]);

    const defaultClaudePool = [
      {
        accountId: "claude-default",
        engine: "claude",
        families: ["claude"],
        poolId: "claude",
        score: 90,
        status: "available",
        surplusPts: 90,
        tags: ["personal"],
      },
    ];
    const targetedClaudeIssue = [
      {
        body: [
          "```json task-spec",
          JSON.stringify({
            allow_paths: ["plugins/orchestrate/lib/chief.mjs"],
            development_checks: ["vitest run tests/plugins/orchestrate/chief-test.js"],
            objective: "Require /profiles/blue claudeConfigDir",
            schema: "agent-executor.task-spec.v1",
          }),
          "```",
        ].join("\n"),
        labels: [{ name: "agent:ready" }, { name: "archetype:targeted-claude" }],
        number: 68,
        title: "Constrained claude profile issue",
      },
    ];
    expect(
      planBatch(targetedClaudeIssue, defaultClaudePool, [], {
        routes: {
          "targeted-claude": {
            claudeConfigDir: "/profiles/blue",
            effort: "medium",
            engine: "claude",
            model: "claude:balanced",
          },
        },
      }),
    ).toEqual([]);

    const defaultDirBatch = planBatch(targetedClaudeIssue, defaultClaudePool, [], {
      routes: {
        "targeted-claude": {
          claudeConfigDir: "~/.claude",
          effort: "medium",
          engine: "claude",
          model: "claude:balanced",
        },
      },
    });
    expect(defaultDirBatch).toHaveLength(1);
    expect(defaultDirBatch[0].selectedRoute).toMatchObject({
      accountId: "claude-default",
      archetype: "targeted-claude",
      engine: "claude",
      model: "claude:balanced",
    });

    // Astra #4: poolSupportsCandidate and foundryStatus preserve accountHome on Claude lanes
    const accountHomeClaudePool = [
      {
        accountHome: "/profiles/blue",
        accountId: "claude-blue-home",
        engine: "claude",
        families: ["claude"],
        poolId: "claude",
        score: 90,
        status: "available",
        surplusPts: 90,
      },
    ];
    expect(
      planBatch(targetedClaudeIssue, accountHomeClaudePool, [], {
        routes: {
          "targeted-claude": {
            claudeConfigDir: "~/.claude",
            effort: "medium",
            engine: "claude",
            model: "claude:balanced",
          },
        },
      }),
    ).toEqual([]);
    const accountHomeMatchedBatch = planBatch(targetedClaudeIssue, accountHomeClaudePool, [], {
      routes: {
        "targeted-claude": {
          claudeConfigDir: "/profiles/blue",
          effort: "medium",
          engine: "claude",
          model: "claude:balanced",
        },
      },
    });
    expect(accountHomeMatchedBatch).toHaveLength(1);
    expect(accountHomeMatchedBatch[0].selectedRoute.accountId).toBe("claude-blue-home");

    const isolatedLane = {
      provider: "claude",
      configDir: "~/.claude",
      accountHome: "/sub/.claude",
      claudeConfigDir: null,
    };
    expect(
      poolSupportsCandidate(isolatedLane, {
        engine: "claude",
        model: "claude:balanced",
        claudeConfigDir: "/caller/.claude",
      }),
    ).toBe(false);
    expect(
      poolSupportsCandidate(isolatedLane, {
        engine: "claude",
        model: "claude:balanced",
        claudeConfigDir: "/sub/.claude",
      }),
    ).toBe(true);

    const envHomeIsolatedLane = {
      provider: "claude",
      configDir: "~/.claude",
      accountEnv: { HOME: "/sub" },
    };
    expect(
      poolSupportsCandidate(envHomeIsolatedLane, {
        engine: "claude",
        model: "claude:balanced",
        claudeConfigDir: "/caller/.claude",
      }),
    ).toBe(false);
    expect(
      poolSupportsCandidate(envHomeIsolatedLane, {
        engine: "claude",
        model: "claude:balanced",
        claudeConfigDir: "/sub/.claude",
      }),
    ).toBe(true);

    const relativeConfigLane = {
      provider: "claude",
      configDir: "cfg",
      env: { HOME: "/sub" },
    };
    const cwdCfgDir = path.join(process.cwd(), "cfg");
    expect(
      poolSupportsCandidate(relativeConfigLane, {
        engine: "claude",
        model: "claude:balanced",
        claudeConfigDir: cwdCfgDir,
      }),
    ).toBe(false);
    expect(
      poolSupportsCandidate(relativeConfigLane, {
        engine: "claude",
        model: "claude:balanced",
        claudeConfigDir: "/sub/cfg",
      }),
    ).toBe(true);

    const relativeEnvHomeLane = {
      provider: "claude",
      configDir: "cfg",
      env: { HOME: "isolated" },
    };
    const cwdIsolatedCfgDir = path.join(process.cwd(), "isolated", "cfg");
    const homeIsolatedCfgDir = path.join(homedir(), "isolated", "cfg");
    expect(
      poolSupportsCandidate(relativeEnvHomeLane, {
        engine: "claude",
        model: "claude:balanced",
        claudeConfigDir: cwdIsolatedCfgDir,
      }),
    ).toBe(false);
    expect(
      poolSupportsCandidate(relativeEnvHomeLane, {
        engine: "claude",
        model: "claude:balanced",
        claudeConfigDir: homeIsolatedCfgDir,
      }),
    ).toBe(true);

    const nowMs = Date.now();
    const statusRepo = await makeTempDir("ork-foundry-acct-home-");
    const statusPayload = await foundryStatus(["--json"], {
      activeAllowPaths: [],
      cwd: statusRepo,
      execGhFn: async () => targetedClaudeIssue,
      getAccountsFn: async () => [
        {
          accountHome: "/profiles/blue",
          fetchedAt: nowMs,
          id: "claude-blue-acct",
          label: "Claude Blue",
          ok: true,
          pools: [{ families: ["claude"], id: "claude", label: "Claude", windowIds: ["wk"] }],
          provider: "claude",
          route: "CLAUDE_CONFIG_DIR=/profiles/blue claude",
          windows: [
            {
              id: "wk",
              label: "Weekly",
              remainingPct: 90,
              resetsAt: nowMs + 3 * 24 * 3600 * 1000,
              windowMins: 10_080,
            },
          ],
        },
      ],
      policy: {
        routes: {
          "targeted-claude": {
            claudeConfigDir: "~/.claude",
            effort: "medium",
            engine: "claude",
            model: "claude:balanced",
          },
        },
      },
      stdout: { columns: 120, isTTY: false, write: () => {} },
    });
    expect(statusPayload.plannedBatch).toEqual([]);

    const matchedStatusPayload = await foundryStatus(["--json"], {
      activeAllowPaths: [],
      cwd: statusRepo,
      execGhFn: async () => targetedClaudeIssue,
      getAccountsFn: async () => [
        {
          accountHome: "/profiles/blue",
          fetchedAt: nowMs,
          id: "claude-blue-acct",
          label: "Claude Blue",
          ok: true,
          pools: [{ families: ["claude"], id: "claude", label: "Claude", windowIds: ["wk"] }],
          provider: "claude",
          route: "CLAUDE_CONFIG_DIR=/profiles/blue claude",
          windows: [
            {
              id: "wk",
              label: "Weekly",
              remainingPct: 90,
              resetsAt: nowMs + 3 * 24 * 3600 * 1000,
              windowMins: 10_080,
            },
          ],
        },
      ],
      policy: {
        routes: {
          "targeted-claude": {
            claudeConfigDir: "/profiles/blue",
            effort: "medium",
            engine: "claude",
            model: "claude:balanced",
          },
        },
      },
      stdout: { columns: 120, isTTY: false, write: () => {} },
    });
    expect(matchedStatusPayload.plannedBatch).toHaveLength(1);
    expect(matchedStatusPayload.plannedBatch[0].selectedRoute.accountId).toBe("claude-blue-acct");
  });

  it("enforces --maxWorkers=2 on vitest/jest verification commands and records foundry verification state", async () => {
    expect(enforceScopedVerifyCommand("vitest run tests/plugins/orchestrate/smelter-test.js")).toBe(
      "vitest run tests/plugins/orchestrate/smelter-test.js --maxWorkers=2",
    );
    expect(
      enforceScopedVerifyCommand(
        "vitest run tests/plugins/orchestrate/smelter-test.js --maxWorkers=4",
      ),
    ).toBe("vitest run tests/plugins/orchestrate/smelter-test.js --maxWorkers=4");
    expect(enforceScopedVerifyCommand("jest tests/foo.test.js -w 2")).toBe(
      "jest tests/foo.test.js -w 2",
    );
    expect(enforceScopedVerifyCommand("eslint tests/vitest-helper.js")).toBe(
      "eslint tests/vitest-helper.js",
    );
    expect(enforceScopedVerifyCommand("pytest tests/ -n 2")).toBe("pytest tests/ -n 2");

    const rootDir = await makeTempDir("ork-foundry-verify-");
    const repoRoot = path.join(rootDir, "repo");
    const worktreePath = path.join(rootDir, "wt-issue-72");
    const gitDir = await createRegisteredWorktree(repoRoot, worktreePath, "feat/issue-72");
    await writeFile(
      path.join(gitDir, "orkest.json"),
      JSON.stringify({ branch: "feat/issue-72", disposable: true, issue: 72 }),
    );

    expect(resolveFoundryStatePath(worktreePath)).toBe(
      path.join(gitDir, "orkest", "foundry-state.json"),
    );

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
        body: [
          "```json task-spec",
          JSON.stringify({
            allow_paths: ["plugins/orchestrate/lib/factory.mjs"],
            development_checks: ["vitest run tests/plugins/orchestrate/smelter-test.js"],
            objective: "Verify foundry gate",
            schema: "agent-executor.task-spec.v1",
          }),
          "```",
        ].join("\n"),
        labels: [{ name: "agent:ready" }],
        number: 72,
        title: "Scoped foundry verification",
      },
    ];

    const verifyCalls = [];
    const stdout = { columns: 120, isTTY: false, write: () => {} };
    const failedResult = await foundryRun(
      [
        "--verify",
        "vitest run tests/plugins/orchestrate/smelter-test.js",
        "--acceptance",
        "Scoped Vitest check passes with maxWorkers=2",
        "--json",
      ],
      {
        cwd: repoRoot,
        execAgentFn: async () => ({ status: "COMPLETE" }),
        execGhFn: async () => mockIssues,
        execVerifyFn: async (cmd, ctx) => {
          verifyCalls.push({ cmd, ctx });
          return { exitCode: 1, ok: false, output: "1 test failed" };
        },
        getAccountsFn: async () => mockAccounts,
        provisionWorktreeFn: async () => worktreePath,
        stdout,
      },
    );

    expect(verifyCalls).toEqual([
      {
        cmd: "vitest run tests/plugins/orchestrate/smelter-test.js --maxWorkers=2",
        ctx: { cwd: worktreePath, issue: 72 },
      },
    ]);
    expect(failedResult.verification).toMatchObject({
      acceptanceCriteria: ["Scoped Vitest check passes with maxWorkers=2"],
      command: "vitest run tests/plugins/orchestrate/smelter-test.js --maxWorkers=2",
      exitCode: 1,
      ok: false,
      status: "failed",
    });

    const savedState = JSON.parse(await readFile(resolveFoundryStatePath(worktreePath), "utf8"));
    expect(savedState).toMatchObject({
      acceptanceCriteria: ["Scoped Vitest check passes with maxWorkers=2"],
      attemptCount: 1,
      maxAttempts: 2,
      schema: FOUNDRY_STATE_SCHEMA,
      status: "verification_failed",
      verifyCommand: "vitest run tests/plugins/orchestrate/smelter-test.js --maxWorkers=2",
    });
  });

  it("passes --question in foundry groom and guards against 0-commit or failed builder runs", async () => {
    const rootDir = await makeTempDir("ork-foundry-groom-zero-");
    const repoRoot = path.join(rootDir, "repo");
    const worktreePath = path.join(rootDir, "wt-issue-88");
    const gitDir = await createRegisteredWorktree(repoRoot, worktreePath, "feat/issue-88");
    await writeFile(
      path.join(gitDir, "orkest.json"),
      JSON.stringify({ branch: "feat/issue-88", disposable: true, issue: 88 }),
    );

    const mockIssues = [
      {
        body: [
          "```json task-spec",
          JSON.stringify({
            allow_paths: ["plugins/orchestrate/lib/foundry.mjs"],
            development_checks: ["vitest run tests/plugins/orchestrate/smelter-test.js"],
            objective: "Guard 0-commit builder runs",
            schema: "agent-executor.task-spec.v1",
          }),
          "```",
        ].join("\n"),
        labels: [{ name: "agent:ready" }],
        number: 88,
        title: "Guard 0-commit builder",
      },
    ];

    const stdout = { columns: 120, isTTY: false, write: () => {} };
    let groomConsultArgs = null;
    const groomRes = await foundryGroom(["--issue", "88", "--json"], {
      cwd: repoRoot,
      execAgentFn: async (args) => {
        groomConsultArgs = args;
        return mockIssues[0].body;
      },
      execGhFn: async () => mockIssues[0],
      stdout,
    });
    expect(groomRes.command).toContain("run_agent.py consult --intent investigate --read");
    expect(groomConsultArgs).toContain("--question");
    expect(groomConsultArgs).not.toContain("--prompt");

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

    let wasVerifyCalled = false;
    const zeroCommitRes = await foundryRun(["--json"], {
      countCommitsAheadFn: async () => 0,
      cwd: repoRoot,
      execAgentFn: async () => ({
        result_path: "/tmp/res-88.json",
        session_id: "session-88",
        status: "completed",
      }),
      execGhFn: async () => mockIssues,
      execVerifyFn: async () => {
        wasVerifyCalled = true;
        return { exitCode: 0, ok: true, output: "pass" };
      },
      getAccountsFn: async () => mockAccounts,
      provisionWorktreeFn: async () => worktreePath,
      stdout,
    });

    expect(wasVerifyCalled).toBe(false);
    expect(zeroCommitRes.status).toBe("worker_failed");
    const stateAfterZero = readFoundryState(worktreePath);
    expect(stateAfterZero).toMatchObject({
      attemptCount: 1,
      commitsAhead: 0,
      lastRun: {
        engine: "codex",
        resultPath: "/tmp/res-88.json",
        sessionId: "session-88",
        status: "completed",
      },
      maxAttempts: 2,
      schema: FOUNDRY_STATE_SCHEMA,
      status: "worker_failed",
    });

    // Foundry commits builder changes before invoking the verifier:
    const hostGitCalls = [];
    const dirtyWorktreePath = path.join(rootDir, "wt-dirty-88");
    await mkdir(dirtyWorktreePath);
    const dirtyVerifiedRes = await foundryRun(["--json"], {
      cwd: repoRoot,
      execAgentFn: async () => ({
        result_path: "/tmp/res-88-dirty.json",
        session_id: "session-88-dirty",
        status: "completed",
      }),
      execFileSyncFn: (cmd, args) => {
        hostGitCalls.push([cmd, ...args]);
        if (cmd === "git" && args[0] === "status" && args[1] === "--porcelain") {
          return hostGitCalls.some((c) => c[1] === "commit")
            ? ""
            : " M plugins/orchestrate/lib/foundry.mjs\n";
        }
        if (cmd === "git" && args[0] === "rev-list") {
          const hasCommitted = hostGitCalls.some((c) => c[0] === "git" && c[1] === "commit");
          return hasCommitted ? "1\n" : "0\n";
        }
        if (cmd === "git" && args[0] === "rev-parse" && ["HEAD", "HEAD^{tree}"].includes(args[1])) {
          return "abcdef1234567\n";
        }
        return "";
      },
      execGhFn: async () => mockIssues,
      execVerifyFn: async () => {
        wasVerifyCalled = true;
        return { exitCode: 0, ok: true, output: "all checks passed" };
      },
      getAccountsFn: async () => mockAccounts,
      provisionWorktreeFn: async () => dirtyWorktreePath,
      stdout,
    });
    expect(wasVerifyCalled).toBe(true);
    expect(dirtyVerifiedRes.status).toBe("verified");
    expect(dirtyVerifiedRes.commitsAhead).toBe(1);
    expect(dirtyVerifiedRes.verification.committedByHost).toBe(true);
    expect(hostGitCalls).toContainEqual(["git", "add", "-A"]);
    expect(hostGitCalls).toContainEqual(["git", "commit", "-m", "feat(foundry): resolve #88"]);
    expect(readFoundryState(dirtyWorktreePath)).toMatchObject({
      commitsAhead: 1,
      headSha: "abcdef1234567",
      status: "verified",
    });

    // Also test collectActiveWorktreeAllowPaths and countCommitsAhead helper:
    const porcelain = [
      `worktree ${repoRoot}`,
      "HEAD 1111111",
      "branch refs/heads/main",
      "",
      `worktree ${worktreePath}`,
      "HEAD 2222222",
      "branch refs/heads/feat/issue-88",
      "",
    ].join("\n");
    const activePaths = collectActiveWorktreeAllowPaths(repoRoot, {
      execFileSyncFn: (cmd, args) => {
        if (cmd === "git" && args[0] === "worktree") return porcelain;
        return "";
      },
    });
    expect(activePaths).toEqual([["plugins/orchestrate/lib/foundry.mjs"]]);
    expect(
      countCommitsAhead(worktreePath, "main", {
        execFileSyncFn: () => "3\n",
      }),
    ).toEqual({ commitsAhead: 3, resolved: true });
  });
});

describe("ork smelter", () => {
  it("classifies blast radius into low, medium, and high risk tiers", () => {
    expect(classifyBlastRadius([])).toBe("low");
    expect(
      classifyBlastRadius([
        "docs/architecture.md",
        "README.md",
        "tests/plugins/orchestrate/smelter-test.js",
        "tests/fixtures/room.json",
      ]),
    ).toBe("low");

    expect(
      classifyBlastRadius([
        "plugins/orchestrate/lib/smelter.mjs",
        "tests/plugins/orchestrate/smelter-test.js",
      ]),
    ).toBe("medium");

    expect(classifyBlastRadius(["plugins/orchestrate/bin/ork.mjs"])).toBe("high");
    expect(
      classifyBlastRadius(["plugins/orchestrate/skills/orchestrate/scripts/run_agent.py"]),
    ).toBe("high");
    expect(classifyBlastRadius(["plugins/orchestrate/skills/orchestrate/scripts/gate.py"])).toBe(
      "high",
    );
    expect(classifyBlastRadius([".github/workflows/release.yml"])).toBe("high");
    expect(classifyBlastRadius(["plugins/orchestrate/lib/auth-policy.mjs"])).toBe("high");
  });

  it("selects a cross-vendor cold reviewer engine", () => {
    expect(selectColdReviewerEngine("codex")).toBe("claude");
    expect(selectColdReviewerEngine("agy")).toBe("claude");
    expect(selectColdReviewerEngine("opencode")).toBe("claude");
    expect(selectColdReviewerEngine("claude")).toBe("codex");
  });

  it("discovers smeltable disposable worktrees with commits ahead of target", async () => {
    const rootDir = await makeTempDir("ork-smelter-discover-");
    const repoRoot = path.join(rootDir, "repo");
    const wtDisposable = path.join(rootDir, "wt-63");
    const wtKeep = path.join(rootDir, "wt-keep");
    const gitDir63 = await createRegisteredWorktree(repoRoot, wtDisposable, "feat/issue-63");
    const gitDirKeep = await createRegisteredWorktree(repoRoot, wtKeep, "feat/keep");

    await mkdir(path.join(gitDir63, "orkest"), { recursive: true });
    await writeFile(
      path.join(gitDir63, "orkest.json"),
      JSON.stringify({
        branch: "feat/issue-63",
        disposable: true,
        engine: "agy",
        issue: 63,
        parentCwd: repoRoot,
        slug: "wt-63",
      }),
    );
    await writeFile(
      path.join(gitDir63, "orkest", "task-spec.json"),
      JSON.stringify({
        allow_paths: ["plugins/orchestrate/lib/smelter.mjs"],
        development_checks: ["vitest run tests/plugins/orchestrate/smelter-test.js"],
        objective: "Build ork smelter",
        schema: "agent-executor.task-spec.v1",
      }),
    );

    await writeFile(
      path.join(gitDirKeep, "orkest.json"),
      JSON.stringify({
        branch: "feat/keep",
        disposable: false,
        parentCwd: repoRoot,
        slug: "wt-keep",
      }),
    );

    const porcelain = [
      `worktree ${repoRoot}`,
      "HEAD 1111111",
      "branch refs/heads/main",
      "",
      `worktree ${wtDisposable}`,
      "HEAD 2222222",
      "branch refs/heads/feat/issue-63",
      "",
      `worktree ${wtKeep}`,
      "HEAD 3333333",
      "branch refs/heads/feat/keep",
      "",
    ].join("\n");

    writeFoundryState(wtDisposable, { status: "verified" });
    const discovered = discoverSmeltableWorktrees(repoRoot, {
      execFileSyncFn: (cmd, args) => {
        if (args[0] === "worktree" && args[1] === "list") return porcelain;
        if (args[0] === "rev-list") return "2\n";
        return "";
      },
    });

    expect(discovered).toHaveLength(1);
    expect(discovered[0]).toMatchObject({
      allowPaths: ["plugins/orchestrate/lib/smelter.mjs"],
      branch: "feat/issue-63",
      commitsAhead: 2,
      disposable: true,
      engine: "agy",
      issue: 63,
      path: wtDisposable,
      slug: "wt-63",
    });
  });

  it("records dry-run evidence, pins merge and review arguments, and supports PR strategy", async () => {
    const root = await makeTempDir("ork-smelter-pipeline-");
    const wt = { path: root, branch: "builder", disposable: false, allowPaths: ["source.mjs"] };
    const commands = [];
    const execMock = (cmd, args) => {
      commands.push([cmd, ...args]);
      if (args[0] === "rev-parse") return "fixture-head";
      if (args[0] === "symbolic-ref") return "builder";
      if (args[0] === "diff") return "source.mjs\0";
      return "";
    };
    const dry = await smeltWorktree(wt, { dryRun: true, execFileSyncFn: execMock });
    expect(dry).toMatchObject({
      dryRun: true,
      pruned: false,
      evidence: {
        scope: { result: "passed" },
        candidate: { commit: "fixture-head", branch: "builder" },
      },
    });
    expect(commands.some((entry) => entry[1] === "rebase")).toBe(false);
    const reviews = [];
    const full = await smeltWorktree(wt, {
      execFileSyncFn: execMock,
      gateRunner: async () => "passed",
      reviewRunner: async (info) => {
        reviews.push(info);
        return "FINDINGS:\nnone";
      },
    });
    expect(full).toMatchObject({ ok: true, status: "merged", pruned: false });
    expect(commands).toContainEqual(["git", "rebase", "fixture-head"]);
    expect(commands).toContainEqual([
      "git",
      "update-ref",
      "refs/heads/main",
      "fixture-head",
      "fixture-head",
    ]);
    expect(reviews[0].args[reviews[0].args.indexOf("--diff") + 1]).toBe("fixture-head");
    const pr = await smeltWorktree(wt, {
      execFileSyncFn: execMock,
      skipReview: true,
      strategy: "pr",
    });
    expect(pr.status).toBe("pr_opened");
    expect(commands).toContainEqual(["git", "push", "origin", "fixture-head:refs/heads/builder"]);
    expect(reviews[0].args.at(-1)).toBe(buildColdReviewQuestion(full.evidence));
    expect(reviews[0].args.at(-1)).toContain("tests were not run");
    expect(pr.evidence.review.result).toBe("not_reviewed");
    expect(pr.stages.coldReview.findings).toBeNull();
    expect(dry.evidence.review.result).toBe("not_reviewed");
    await expect(smeltWorktree(wt, { execFileSyncFn: () => " M dirty.js" })).rejects.toThrow(
      /uncommitted changes/u,
    );
  });

  it("supports smelterCli status --json and run --dry-run --json", async () => {
    const rootDir = await makeTempDir("ork-smelter-cli-");
    const repoRoot = path.join(rootDir, "repo");
    const wtPath = path.join(rootDir, "wt-63");
    const gitDir = await createRegisteredWorktree(repoRoot, wtPath, "feat/issue-63");
    await mkdir(path.join(gitDir, "orkest"), { recursive: true });
    await writeFile(
      path.join(gitDir, "orkest.json"),
      JSON.stringify({
        branch: "feat/issue-63",
        disposable: true,
        engine: "codex",
        issue: 63,
        parentCwd: repoRoot,
        slug: "wt-63",
      }),
    );
    await writeFile(
      path.join(gitDir, "orkest", "task-spec.json"),
      JSON.stringify({
        allow_paths: ["plugins/orchestrate/lib/smelter.mjs"],
        development_checks: ["./scripts/check.sh"],
        objective: "Smelt wt-63",
        schema: "agent-executor.task-spec.v1",
      }),
    );

    const porcelain = [
      `worktree ${repoRoot}`,
      "HEAD 1111111",
      "branch refs/heads/main",
      "",
      `worktree ${wtPath}`,
      "HEAD 2222222",
      "branch refs/heads/feat/issue-63",
      "",
    ].join("\n");

    const execMock = (cmd, args) => {
      if (cmd === "git" && args[0] === "worktree" && args[1] === "list") return porcelain;
      if (cmd === "git" && args[0] === "rev-list") return "1\n";
      if (cmd === "git" && args[0] === "status") return "";
      if (cmd === "git" && args[0] === "rev-parse") return "fixture-head";
      if (cmd === "git" && args[0] === "diff") return "plugins/orchestrate/lib/smelter.mjs\0";
      return "";
    };

    const chunks = [];
    const stdout = {
      columns: 120,
      isTTY: false,
      write: (chunk) => {
        chunks.push(chunk);
      },
    };

    writeFoundryState(wtPath, { status: "verified" });
    const statusPayload = await smelterCli(["status", "--json"], {
      cwd: repoRoot,
      execFileSyncFn: execMock,
      stdout,
    });
    expect(statusPayload.schema).toBe("ork.smelter.status.v1");
    expect(statusPayload.worktrees).toHaveLength(1);

    chunks.length = 0;
    const runPayload = await smelterCli(["run", "--worktree", "wt-63", "--dry-run", "--json"], {
      cwd: repoRoot,
      execFileSyncFn: execMock,
      stdout,
    });
    expect(runPayload.schema).toBe("ork.smelter.run.v1");
    expect(runPayload.dryRun).toBe(true);
    expect(runPayload.reviewerEngine).toBe("claude");
  });

  it("falls back to installed harnesses in selectColdReviewerEngine and protects unmarked worktrees", async () => {
    expect(selectColdReviewerEngine("codex", { availableEngines: ["agy", "codex"] })).toBe("agy");
    expect(selectColdReviewerEngine("antigravity", { availableEngines: ["codex"] })).toBe("codex");
    expect(selectColdReviewerEngine("claude", { availableEngines: ["claude"] })).toBe("claude");

    const unmarkedDir = await makeTempDir("ork-unmarked-wt-");
    const result = await smeltWorktree(unmarkedDir, {
      changedPaths: ["docs/README.md"],
      dryRun: true,
      execFileSyncFn: (cmd, args) => (args[0] === "rev-parse" ? "fixture-head" : ""),
    });
    expect(result.disposable).toBe(false);
    expect(result.stages.smeltAndPrune.operations).toEqual([
      ["git", "update-ref", "refs/heads/main", "fixture-head", "fixture-head"],
    ]);
  });

  it("parses cold review FINDINGS and filters discoverSmeltableWorktrees by foundryState and canonical path", async () => {
    expect(parseColdReviewFindings(null)).toEqual({
      findings: null,
      reason: "Cold review output missing FINDINGS section",
      result: "infrastructure_failure",
      passed: false,
    });
    expect(parseColdReviewFindings("unstructured text without findings header")).toEqual({
      findings: null,
      reason: "Cold review output missing FINDINGS section",
      result: "infrastructure_failure",
      passed: false,
    });
    expect(parseColdReviewFindings({ sections: { FINDINGS: "None" } })).toEqual({
      findings: "none",
      result: "passed",
      passed: true,
    });
    expect(
      parseColdReviewFindings(
        JSON.stringify({
          sections: {
            FINDINGS: "- Bug in smelter.mjs:42\n- Missing test in smelter-test.js",
          },
        }),
      ),
    ).toEqual({
      findings: "- Bug in smelter.mjs:42\n- Missing test in smelter-test.js",
      result: "findings",
      passed: false,
    });

    const rootDir = await makeTempDir("ork-smelter-states-");
    const repoRoot = path.join(rootDir, "repo");
    const wtVerified = path.join(rootDir, "wt-verified");
    const wtFailedVerify = path.join(rootDir, "wt-failed-verify");
    const wtRebaseConflict = path.join(rootDir, "wt-rebase-conflict");

    for (const [wtPath, slug, issue, statePatch] of [
      [wtVerified, "wt-verified", 101, { status: "verified" }],
      [wtFailedVerify, "wt-failed-verify", 102, { status: "verification_failed" }],
      [
        wtRebaseConflict,
        "wt-rebase-conflict",
        103,
        {
          rebase: {
            conflictOn: {
              targetHeadSha: "main-sha-1",
              worktreeHeadSha: "wt-103-sha",
            },
          },
          status: "rebase_conflict",
        },
      ],
    ]) {
      const gitDir = await createRegisteredWorktree(repoRoot, wtPath, `feat/issue-${issue}`);
      await mkdir(path.join(gitDir, "orkest"), { recursive: true });
      await writeFile(
        path.join(gitDir, "orkest.json"),
        JSON.stringify({
          branch: `feat/issue-${issue}`,
          disposable: true,
          engine: "codex",
          issue,
          parentCwd: repoRoot,
          slug,
        }),
      );
      writeFoundryState(wtPath, statePatch);
    }
    await mkdir(repoRoot, { recursive: true });

    expect(alignCanonicalPath(repoRoot)).toBe(alignCanonicalPath(path.join(repoRoot, ".")));

    const porcelain = [
      `worktree ${repoRoot}`,
      "HEAD main-sha-1",
      "branch refs/heads/main",
      "",
      `worktree ${wtVerified}`,
      "HEAD wt-101-sha",
      "branch refs/heads/feat/issue-101",
      "",
      `worktree ${wtFailedVerify}`,
      "HEAD wt-102-sha",
      "branch refs/heads/feat/issue-102",
      "",
      `worktree ${wtRebaseConflict}`,
      "HEAD wt-103-sha",
      "branch refs/heads/feat/issue-103",
      "",
    ].join("\n");

    let currentMainSha = "main-sha-1";
    const execMock = (cmd, args) => {
      if (cmd === "git" && args[0] === "worktree") return porcelain;
      if (cmd === "git" && args[0] === "rev-list") return "1\n";
      if (cmd === "git" && args[0] === "rev-parse") return `${currentMainSha}\n`;
      return "";
    };

    const filtered = discoverSmeltableWorktrees(repoRoot, { execFileSyncFn: execMock });
    expect(filtered.map((wt) => wt.slug)).toEqual(["wt-verified"]);

    // When target branch advances to a new SHA, rebase_conflict worktree becomes eligible again:
    currentMainSha = "main-sha-2";
    const afterTargetAdvance = discoverSmeltableWorktrees(repoRoot, { execFileSyncFn: execMock });
    expect(afterTargetAdvance.map((wt) => wt.slug)).toEqual(["wt-verified", "wt-rebase-conflict"]);

    // includeAllStates returns all worktrees regardless of status:
    const allStates = discoverSmeltableWorktrees(repoRoot, {
      execFileSyncFn: execMock,
      includeAllStates: true,
    });
    expect(allStates.map((wt) => wt.slug)).toEqual([
      "wt-verified",
      "wt-failed-verify",
      "wt-rebase-conflict",
    ]);
  });

  it("persists ork.foundry.state.v2 across smeltWorktree failure, review-change, and high-blast approval gates", async () => {
    const rootDir = await makeTempDir("ork-smelter-v2-");
    const repoRoot = path.join(rootDir, "repo");
    const wtPath = path.join(rootDir, "wt-99");
    const gitDir = await createRegisteredWorktree(repoRoot, wtPath, "feat/issue-99");
    await mkdir(path.join(gitDir, "orkest"), { recursive: true });
    await writeFile(
      path.join(gitDir, "orkest.json"),
      JSON.stringify({
        branch: "feat/issue-99",
        disposable: false,
        engine: "codex",
        issue: 99,
        parentCwd: repoRoot,
        slug: "wt-99",
      }),
    );

    const baseWt = {
      allowPaths: ["plugins/orchestrate/"],
      branch: "feat/issue-99",
      disposable: false,
      engine: "codex",
      head: "wt-head-99",
      issue: 99,
      parentCwd: repoRoot,
      path: wtPath,
      slug: "wt-99",
      verifyCommand: "./scripts/check.sh",
    };

    writeFoundryState(wtPath, { status: "verified" });
    // 1. Scope violation persists scope_violated:
    await expect(
      smeltWorktree(baseWt, {
        changedPaths: ["README.md"],
        execFileSyncFn: (cmd, args) => {
          if (args[0] === "rev-parse") return "fixture-head";
          if (args[0] === "diff") return "README.md\0";
          return "";
        },
      }),
    ).resolves.toMatchObject({ status: "scope_violated" });
    expect(readFoundryState(wtPath)).toMatchObject({
      schema: FOUNDRY_STATE_SCHEMA,
      scopeViolations: ["README.md"],
      status: "scope_violated",
    });

    // 2. Rebase conflict persists rebase_conflict with SHA pins:
    await expect(
      smeltWorktree(baseWt, {
        changedPaths: ["plugins/orchestrate/lib/smelter.mjs"],
        execFileSyncFn: (cmd, args) => {
          if (cmd === "git" && args[0] === "rebase" && args[1] === "target-sha-99") {
            throw new Error("CONFLICT (content): Merge conflict");
          }
          if (cmd === "git" && args[0] === "rev-parse" && args[1] === "refs/heads/main") {
            return "target-sha-99\n";
          }
          if (args[0] === "rev-parse") return "wt-head-99";
          return "";
        },
      }),
    ).rejects.toThrow(/Merge conflict/u);
    expect(readFoundryState(wtPath)).toMatchObject({
      rebase: {
        conflictOn: {
          targetHeadSha: "target-sha-99",
          worktreeHeadSha: "wt-head-99",
        },
      },
      schema: FOUNDRY_STATE_SCHEMA,
      status: "rebase_conflict",
    });

    // 3. Heavy gate failure persists gate_failed:
    await expect(
      smeltWorktree(baseWt, {
        changedPaths: ["plugins/orchestrate/lib/smelter.mjs"],
        execFileSyncFn: (cmd, args) => (args[0] === "rev-parse" ? "fixture-head" : ""),
        gateRunner: async () => {
          throw Object.assign(new Error("Heavy gate failed"), { status: 1 });
        },
      }),
    ).resolves.toMatchObject({
      status: "gate_failed",
      evidence: { checks: [{ result: "failed", exitCode: 1 }] },
    });
    expect(readFoundryState(wtPath)).toMatchObject({
      schema: FOUNDRY_STATE_SCHEMA,
      status: "gate_failed",
    });

    // 4. Cold review findings persist review_changes_requested and skip Stage 4:
    const reviewFailRes = await smeltWorktree(baseWt, {
      changedPaths: ["plugins/orchestrate/lib/smelter.mjs"],
      execFileSyncFn: (cmd, args) => (args[0] === "rev-parse" ? "fixture-head" : ""),
      gateRunner: async () => "ok",
      reviewRunner: async () => ({
        sections: {
          FINDINGS: "- Missing error guard on line 50",
        },
      }),
    });
    expect(reviewFailRes.ok).toBe(false);
    expect(reviewFailRes.status).toBe("review_changes_requested");
    expect(reviewFailRes.findings).toBe("- Missing error guard on line 50");
    expect(reviewFailRes.stages.smeltAndPrune.status).toBe("skipped");
    expect(readFoundryState(wtPath)).toMatchObject({
      findings: "- Missing error guard on line 50",
      schema: FOUNDRY_STATE_SCHEMA,
      status: "review_changes_requested",
    });

    // 5. High blast radius local merge pauses with awaiting_human_approval until approveHighBlast is set:
    const highBlastRes = await smeltWorktree(baseWt, {
      changedPaths: ["plugins/orchestrate/bin/ork.mjs"],
      execFileSyncFn: (cmd, args) => {
        if (args[0] === "rev-parse") return "fixture-head";
        if (args[0] === "diff") return "plugins/orchestrate/bin/ork.mjs\0";
        return "";
      },
      gateRunner: async () => "ok",
      reviewRunner: async () => ({ sections: { FINDINGS: "None" } }),
      strategy: "local",
    });
    expect(highBlastRes.ok).toBe(false);
    expect(highBlastRes.awaitingApproval).toBe(true);
    expect(highBlastRes.status).toBe("awaiting_human_approval");
    expect(readFoundryState(wtPath)).toMatchObject({
      blastRadius: "high",
      schema: FOUNDRY_STATE_SCHEMA,
      status: "awaiting_human_approval",
    });

    // 6. With a matching approveHighBlast commit, high blast radius merges and records status: "merged":
    const approvedRes = await smeltWorktree(baseWt, {
      approveHighBlast: "fixture-head",
      changedPaths: ["plugins/orchestrate/bin/ork.mjs"],
      execFileSyncFn: (cmd, args) => {
        if (args[0] === "rev-parse") return "fixture-head";
        if (args[0] === "diff") return "plugins/orchestrate/bin/ork.mjs\0";
        return "";
      },
      gateRunner: async () => "ok",
      reviewRunner: async () => ({ sections: { FINDINGS: "None" } }),
      strategy: "local",
    });
    expect(approvedRes.ok).toBe(true);
    expect(approvedRes.status).toBe("merged");
    expect(readFoundryState(wtPath)).toMatchObject({
      schema: FOUNDRY_STATE_SCHEMA,
      status: "merged",
    });
  });

  it("passes --no-renames in getBranchDiffFiles to catch out-of-scope renames, reports Halted with exitCode 1 in runSmeltCli, and enforces policy.deny in selectSparePools", async () => {
    const renameWorktree = await makeTempDir("ork-smelter-rename-");
    const diffCalls = [];
    const diffFiles = getBranchDiffFiles(renameWorktree, "main", {
      execFileSyncFn: (cmd, args) => {
        diffCalls.push([cmd, ...args]);
        return "out-of-scope/secret.txt\nplugins/orchestrate/lib/smelter.mjs\n";
      },
    });
    expect(diffCalls).toEqual([["git", "diff", "--name-only", "--no-renames", "main...HEAD"]]);
    expect(diffFiles).toEqual(["out-of-scope/secret.txt", "plugins/orchestrate/lib/smelter.mjs"]);

    await expect(
      smeltWorktree(
        {
          allowPaths: ["plugins/orchestrate/lib/smelter.mjs"],
          branch: "feat/issue-rename",
          disposable: false,
          engine: "codex",
          path: renameWorktree,
          slug: "wt-rename",
        },
        {
          execFileSyncFn: (cmd, args) => {
            if (cmd === "git" && args[0] === "status") return "";
            if (cmd === "git" && args[0] === "diff") {
              expect(args).toContain("--no-renames");
              return "out-of-scope/secret.txt\0plugins/orchestrate/lib/smelter.mjs\0";
            }
            if (args[0] === "rev-parse") return "fixture-head";
            return "";
          },
        },
      ),
    ).resolves.toMatchObject({
      status: "scope_violated",
      evidence: {
        scope: { changedPaths: ["out-of-scope/secret.txt", "plugins/orchestrate/lib/smelter.mjs"] },
      },
    });

    // runSmeltCli prints "Halted ..." and sets process.exitCode = 1 when ok: false
    const rootDir = await makeTempDir("ork-smelter-halted-");
    const repoRoot = path.join(rootDir, "repo");
    const wtPath = path.join(rootDir, "wt-halted");
    const gitDir = await createRegisteredWorktree(repoRoot, wtPath, "feat/issue-halted");
    await mkdir(path.join(gitDir, "orkest"), { recursive: true });
    await writeFile(
      path.join(gitDir, "orkest.json"),
      JSON.stringify({
        branch: "feat/issue-halted",
        disposable: false,
        engine: "codex",
        issue: 77,
        parentCwd: repoRoot,
        slug: "wt-halted",
      }),
    );

    const porcelain = [
      `worktree ${repoRoot}`,
      "HEAD 1111111",
      "branch refs/heads/main",
      "",
      `worktree ${wtPath}`,
      "HEAD 2222222",
      "branch refs/heads/feat/issue-halted",
      "",
    ].join("\n");

    const chunks = [];
    const stdout = {
      columns: 120,
      isTTY: false,
      write: (chunk) => {
        chunks.push(chunk);
      },
    };
    process.exitCode = 0;
    writeFoundryState(wtPath, { status: "verified" });
    const haltedPayload = await runSmeltCli(["run", "--worktree", "wt-halted"], {
      cwd: repoRoot,
      execFileSyncFn: (cmd, args) => {
        if (cmd === "git" && args[0] === "worktree") return porcelain;
        if (cmd === "git" && args[0] === "rev-list") return "1\n";
        if (cmd === "git" && args[0] === "status") return "";
        if (cmd === "git" && args[0] === "rev-parse") return "fixture-head";
        if (cmd === "git" && args[0] === "diff") return "plugins/orchestrate/lib/smelter.mjs\0";
        return "";
      },
      gateRunner: async () => "ok",
      reviewRunner: async () => ({ sections: { FINDINGS: "- Bug found on line 10" } }),
      stdout,
    });
    expect(haltedPayload.ok).toBe(false);
    expect(process.exitCode).toBe(1);
    expect(chunks.join("")).toContain("Halted wt-halted (review_changes_requested)");
    expect(chunks.join("")).not.toContain("Smelted wt-halted");

    // selectSparePools with policy.deny filters out work, client tags, and aliases across N accounts:
    const lanes = [
      {
        accountId: "claude-w1",
        availableNowPct: 80,
        billing: "work",
        families: ["claude"],
        label: "Claude Work 1",
        pace: { surplus: 35 },
        poolId: "claude",
        provider: "claude",
        route: "--engine claude",
        score: 35,
        status: "available",
        tags: ["work"],
      },
      {
        accountId: "claude-w2",
        availableNowPct: 78,
        billing: "work",
        families: ["claude"],
        label: "Claude Work 2",
        pace: { surplus: 33 },
        poolId: "claude",
        provider: "claude",
        route: "--engine claude",
        score: 33,
        status: "available",
        tags: ["work"],
      },
      {
        accountId: "claude-p1",
        alias: "claude-alt",
        availableNowPct: 85,
        billing: "personal",
        families: ["claude"],
        label: "Claude Personal 1",
        pace: { surplus: 30 },
        personal: true,
        poolId: "claude",
        provider: "claude",
        route: "claude",
        score: 30,
        status: "available",
        tags: ["personal"],
      },
      {
        accountId: "claude-p2",
        availableNowPct: 84,
        billing: "personal",
        families: ["claude"],
        label: "Claude Personal 2",
        pace: { surplus: 29 },
        personal: true,
        poolId: "claude",
        provider: "claude",
        route: "claude",
        score: 29,
        status: "available",
        tags: ["personal"],
      },
      {
        accountId: "claude-acme",
        availableNowPct: 82,
        families: ["claude"],
        label: "Claude Acme",
        pace: { surplus: 27 },
        poolId: "claude",
        provider: "claude",
        route: "claude",
        score: 27,
        status: "available",
        tags: ["client-acme"],
      },
      {
        accountId: "agy-work",
        availableNowPct: 90,
        billing: "work",
        families: ["gemini"],
        label: "Antigravity",
        pace: { surplus: 28 },
        poolId: "gemini",
        provider: "antigravity",
        route: "--engine agy",
        score: 28,
        status: "available",
        tags: ["work"],
      },
      {
        accountId: "codex-work",
        availableNowPct: 75,
        billing: "work",
        families: ["gpt"],
        label: "Codex Work",
        pace: { surplus: 25 },
        poolId: "codex",
        provider: "codex",
        route: "--engine codex",
        score: 25,
        status: "available",
        tags: ["work"],
      },
    ];

    expect(isLaneDeniedByPolicy(lanes[0], ["claude-work"])).toBe(true);
    expect(isLaneDeniedByPolicy(lanes[1], ["work"])).toBe(true);
    expect(isLaneDeniedByPolicy(lanes[2], ["claude-work"])).toBe(false);
    expect(isLaneDeniedByPolicy(lanes[2], ["claude-alt"])).toBe(true);
    expect(isLaneDeniedByPolicy(lanes[3], ["personal"])).toBe(true);
    expect(isLaneDeniedByPolicy(lanes[4], ["client-acme"])).toBe(true);
    expect(isLaneDeniedByPolicy(lanes[0], ["claude"])).toBe(true);
    expect(isLaneDeniedByPolicy(lanes[2], ["claude"])).toBe(true);

    const spareAfterDeny = selectSparePools(lanes, { deny: ["claude-work", "client-acme"] });
    expect(spareAfterDeny.map((p) => p.accountId)).toEqual([
      "claude-p1",
      "claude-p2",
      "agy-work",
      "codex-work",
    ]);

    expect(
      selectColdReviewerEngine("claude-alt", {
        accounts: [
          { id: "claude-p1", alias: "claude-alt", provider: "claude", tags: ["personal"] },
        ],
        policy: { deny: ["codex"] },
        availableEngines: ["codex", "agy", "opencode"],
      }),
    ).toBe("agy");

    // loadFactoryPolicy merges .orkest/policy.json deny entries:
    await mkdir(path.join(repoRoot, ".orkest"), { recursive: true });
    await writeFile(
      path.join(repoRoot, ".orkest", "policy.json"),
      JSON.stringify({ deny: ["claude-work", "opencode"] }),
    );
    const loadedPolicy = await loadFactoryPolicy(repoRoot);
    expect(loadedPolicy.deny).toEqual(expect.arrayContaining(["claude-work", "opencode"]));
  });

  it("writeFoundryState accepts validated adminDir and statePath and rejects escapes (#6)", async () => {
    const rootDir = await makeTempDir("ork-foundry-admin-");
    const wt = path.join(rootDir, "worktree");
    const adminDir = path.join(rootDir, "admin-git-dir");
    const outside = path.join(rootDir, "outside.json");
    await mkdir(wt, { recursive: true });
    await mkdir(adminDir, { recursive: true });
    const statePath = path.join(adminDir, "orkest", "foundry-state.json");
    const saved = writeFoundryState(
      wt,
      { status: "verified", targetBranch: "main" },
      { adminDir, statePath, exclusive: true },
    );
    expect(saved.status).toBe("verified");
    expect(JSON.parse(await readFile(statePath, "utf8")).status).toBe("verified");
    expect(() =>
      writeFoundryState(wt, { status: "verified" }, { adminDir, statePath: outside }),
    ).toThrow(/escapes validated adminDir/);
  });

  it("canonicalizes symlinked ancestor paths like /var -> /private/var and rejects room worktrees with missing marker or unaccepted commits (#2, #7, #16)", async () => {
    // #16: Equivalent paths across a symlinked ancestor (like macOS /var -> /private/var) are accepted when final component is clean.
    const rootDir = await makeTempDir("ork-foundry-macos-");
    const realParent = path.join(rootDir, "private-var");
    const aliasParent = path.join(rootDir, "var-alias");
    const realAdmin = path.join(realParent, "admin");
    await mkdir(realAdmin, { recursive: true });
    await symlink(realParent, aliasParent);
    const wt = path.join(rootDir, "wt");
    await mkdir(wt, { recursive: true });
    const aliasStatePath = path.join(aliasParent, "admin", "orkest", "foundry-state.json");
    const savedAlias = writeFoundryState(
      wt,
      { status: "verified" },
      { adminDir: path.join(aliasParent, "admin"), statePath: aliasStatePath },
    );
    expect(savedAlias.status).toBe("verified");

    // #7 & #2: Room-integrated worktree requires freshly read on-disk orkest.json and verifies branch/OID + acceptedCommit->rebasedCommit retries.
    const realRepo = path.join(rootDir, "repo");
    const wtPath = path.join(rootDir, "room-wt");
    const mRoot = path.join(rootDir, "mailbox");
    await mkdir(realRepo, { recursive: true });
    await mkdir(mRoot, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd: realRepo, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Smelter Test"], { cwd: realRepo });
    execFileSync("git", ["config", "user.email", "smelter@example.invalid"], { cwd: realRepo });
    await writeFile(path.join(realRepo, "base.txt"), "base\n");
    execFileSync("git", ["add", "base.txt"], { cwd: realRepo });
    execFileSync("git", ["commit", "-m", "init"], { cwd: realRepo, stdio: "ignore" });
    execFileSync("git", ["worktree", "add", "-b", "ork/luna-1", wtPath, "main"], {
      cwd: realRepo,
      stdio: "ignore",
    });
    execFileSync("git", ["config", "user.name", "Smelter Test"], { cwd: wtPath });
    execFileSync("git", ["config", "user.email", "smelter@example.invalid"], { cwd: wtPath });
    await mkdir(path.join(wtPath, "allowed"), { recursive: true });
    await writeFile(path.join(wtPath, "allowed", "ok.txt"), "accepted\n");
    execFileSync("git", ["add", "allowed/ok.txt"], { cwd: wtPath });
    execFileSync("git", ["commit", "-m", "feat: accepted"], { cwd: wtPath, stdio: "ignore" });
    const acceptedCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: wtPath,
      encoding: "utf8",
    }).trim();

    const { parseTeam, updateRoom } =
      await import("../../../plugins/orchestrate/lib/horde-room.mjs");
    const { newRoom } = await import("../../../plugins/orchestrate/lib/rooms.mjs");
    const room = await newRoom(parseTeam("codex:luna:max"), {
      id: "room-smelt-check",
      cwd: realRepo,
      root: mRoot,
    });
    const integrationId = "int-1";
    await updateRoom(
      room.id,
      (current) => {
        current.agents[0].worktree = {
          path: realpathSync(wtPath),
          branch: "ork/luna-1",
          slug: "room-wt",
          disposable: true,
        };
        current.agents[0].integration = {
          integrationId,
          commit: acceptedCommit,
          targetBranch: "main",
          message: "feat: accepted",
          at: "2026-11-18T00:00:00.000Z",
        };
        return current;
      },
      { root: mRoot },
    );

    const wtGitDir = execFileSync("git", ["rev-parse", "--absolute-git-dir"], {
      cwd: wtPath,
      encoding: "utf8",
    }).trim();
    await mkdir(path.join(wtGitDir, "orkest"), { recursive: true });
    await writeFile(
      path.join(wtGitDir, "orkest", "task-spec.json"),
      JSON.stringify({
        schema: "agent-executor.task-spec.v1",
        allow_paths: ["allowed"],
        development_checks: ["true"],
        objective: "Test",
      }),
    );
    writeFoundryState(wtPath, {
      branch: "ork/luna-1",
      headSha: acceptedCommit,
      integrationId,
      mailboxRoot: mRoot,
      memberId: "luna-1",
      roomId: room.id,
      status: "verified",
      targetBranch: "main",
    });

    const cachedMarker = {
      branch: "ork/luna-1",
      commit: acceptedCommit,
      disposable: true,
      integrationId,
      mailboxRoot: mRoot,
      memberId: "luna-1",
      parentCwd: realRepo,
      roomId: room.id,
      slug: "room-wt",
    };

    // #7: Passing a cached marker when orkest.json is absent on disk is refused.
    const missingMarkerRes = await smeltWorktree(
      { path: wtPath, worktreePath: wtPath, marker: cachedMarker },
      { mailboxRoot: mRoot, skipReview: true },
    );
    expect(missingMarkerRes.ok).toBe(false);
    expect(missingMarkerRes.status).toBe("room_integration_unverified");

    // Write on-disk marker, then make an extra unaccepted commit on the branch (#2).
    await writeFile(path.join(wtGitDir, "orkest.json"), JSON.stringify(cachedMarker));
    await writeFile(path.join(wtPath, "allowed", "extra.txt"), "unaccepted\n");
    execFileSync("git", ["add", "allowed/extra.txt"], { cwd: wtPath });
    execFileSync("git", ["commit", "-m", "feat: unaccepted later commit"], {
      cwd: wtPath,
      stdio: "ignore",
    });
    const unacceptedRes = await smeltWorktree(wtPath, { mailboxRoot: mRoot, skipReview: true });
    expect(unacceptedRes.ok).toBe(false);
    expect(unacceptedRes.status).toBe("room_commit_mismatch");

    // Reset back to acceptedCommit, advance main so rebase creates a new SHA, fail gate first, then retry safely (#2).
    execFileSync("git", ["reset", "--hard", acceptedCommit], { cwd: wtPath, stdio: "ignore" });
    await writeFile(path.join(realRepo, "other.txt"), "main advance\n");
    execFileSync("git", ["add", "other.txt"], { cwd: realRepo });
    execFileSync("git", ["commit", "-m", "chore: advance main"], {
      cwd: realRepo,
      stdio: "ignore",
    });
    const failedGateRes = await smeltWorktree(wtPath, {
      mailboxRoot: mRoot,
      skipReview: true,
      gateRunner: async () => {
        const err = new Error("gate failed");
        err.status = 1;
        throw err;
      },
    });
    expect(failedGateRes.ok).toBe(false);
    expect(failedGateRes.status).toBe("gate_failed");
    const stateAfterRebase = JSON.parse(
      await readFile(path.join(wtGitDir, "orkest", "foundry-state.json"), "utf8"),
    );
    expect(stateAfterRebase.acceptedCommit).toBe(acceptedCommit);
    expect(stateAfterRebase.rebasedCommit).toBeTruthy();
    expect(stateAfterRebase.rebasedCommit).not.toBe(acceptedCommit);

    // Retry succeeds using persisted acceptedCommit -> rebasedCommit!
    const retryRes = await smeltWorktree(wtPath, {
      mailboxRoot: mRoot,
      skipReview: true,
      gateRunner: async () => "passed",
    });
    expect(retryRes.ok).toBe(true);
    expect(retryRes.status).toBe("merged");
  });

  it("enforces member.worktree checkout, member.integration.targetBranch on --worktree, and recovers post-rebase state write failure (#2, #5, #7)", async () => {
    const rootDir = await makeTempDir("ork-smelter-hardening-");
    const realRepo = path.join(rootDir, "repo");
    const mRoot = path.join(rootDir, "mailbox");
    await mkdir(realRepo, { recursive: true });
    await mkdir(mRoot, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd: realRepo, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Smelter Test"], { cwd: realRepo });
    execFileSync("git", ["config", "user.email", "smelter@example.invalid"], { cwd: realRepo });
    await writeFile(path.join(realRepo, "base.txt"), "base\n");
    execFileSync("git", ["add", "base.txt"], { cwd: realRepo });
    execFileSync("git", ["commit", "-m", "init"], { cwd: realRepo, stdio: "ignore" });
    execFileSync("git", ["branch", "release/v1", "main"], { cwd: realRepo });

    const { parseTeam, updateRoom } =
      await import("../../../plugins/orchestrate/lib/horde-room.mjs");
    const { newRoom } = await import("../../../plugins/orchestrate/lib/rooms.mjs");

    // Helper to create an integrated worktree for a target branch.
    const setupIntegratedWt = async (slug, branch, targetBranch, roomId) => {
      const wtPath = path.join(rootDir, slug);
      execFileSync("git", ["worktree", "add", "-b", branch, wtPath, targetBranch], {
        cwd: realRepo,
        stdio: "ignore",
      });
      execFileSync("git", ["config", "user.name", "Smelter Test"], { cwd: wtPath });
      execFileSync("git", ["config", "user.email", "smelter@example.invalid"], { cwd: wtPath });
      await mkdir(path.join(wtPath, "allowed"), { recursive: true });
      await writeFile(path.join(wtPath, "allowed", `${slug}.txt`), `${slug}\n`);
      execFileSync("git", ["add", `allowed/${slug}.txt`], { cwd: wtPath });
      execFileSync("git", ["commit", "-m", `feat: ${slug}`], { cwd: wtPath, stdio: "ignore" });
      const acceptedCommit = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: wtPath,
        encoding: "utf8",
      }).trim();
      const targetOid = execFileSync("git", ["rev-parse", targetBranch], {
        cwd: realRepo,
        encoding: "utf8",
      }).trim();
      const room = await newRoom(parseTeam("codex:luna:max"), {
        id: roomId,
        cwd: realRepo,
        root: mRoot,
      });
      const integrationId = `int-${slug}`;
      await updateRoom(
        room.id,
        (current) => {
          current.agents[0].worktree = {
            path: realpathSync(wtPath),
            branch,
            slug,
            disposable: true,
          };
          current.agents[0].integration = {
            integrationId,
            commit: acceptedCommit,
            targetBranch,
            targetOid,
            message: `feat: ${slug}`,
            at: "2026-11-18T00:00:00.000Z",
          };
          return current;
        },
        { root: mRoot },
      );
      const wtGitDir = execFileSync("git", ["rev-parse", "--absolute-git-dir"], {
        cwd: wtPath,
        encoding: "utf8",
      }).trim();
      await mkdir(path.join(wtGitDir, "orkest"), { recursive: true });
      await writeFile(
        path.join(wtGitDir, "orkest", "task-spec.json"),
        JSON.stringify({
          schema: "agent-executor.task-spec.v1",
          allow_paths: ["allowed"],
          development_checks: ["true"],
          objective: "Test",
        }),
      );
      writeFoundryState(wtPath, {
        branch,
        headSha: acceptedCommit,
        integrationId,
        mailboxRoot: mRoot,
        memberId: "luna-1",
        roomId: room.id,
        status: "verified",
        targetBranch,
      });
      await writeFile(
        path.join(wtGitDir, "orkest.json"),
        JSON.stringify({
          branch,
          commit: acceptedCommit,
          disposable: true,
          integrationId,
          mailboxRoot: mRoot,
          memberId: "luna-1",
          parentCwd: realRepo,
          roomId: room.id,
          slug,
        }),
      );
      return { wtPath, wtGitDir, acceptedCommit, room };
    };

    // #2: Explicit --worktree with wrong CLI target (default main vs recorded release/v1) is refused.
    const relWt = await setupIntegratedWt("rel-wt", "ork/rel-1", "release/v1", "room-rel-target");
    const mainBefore = execFileSync("git", ["rev-parse", "main"], {
      cwd: realRepo,
      encoding: "utf8",
    }).trim();
    const prevExit = process.exitCode;
    const silentOut = { write() {} };
    let wrongTargetPayload;
    try {
      wrongTargetPayload = await runSmeltCli(["run", "--worktree", relWt.wtPath, "--skip-review"], {
        cwd: realRepo,
        gateRunner: async () => "passed",
        stdout: silentOut,
      });
    } finally {
      process.exitCode = prevExit;
    }
    expect(wrongTargetPayload.results).toHaveLength(1);
    expect(wrongTargetPayload.results[0]).toMatchObject({
      ok: false,
      status: "target_branch_mismatch",
    });
    expect(
      execFileSync("git", ["rev-parse", "main"], { cwd: realRepo, encoding: "utf8" }).trim(),
    ).toBe(mainBefore);
    expect(
      execFileSync("git", ["rev-parse", "HEAD"], { cwd: relWt.wtPath, encoding: "utf8" }).trim(),
    ).toBe(relWt.acceptedCommit);

    // Explicit --target release/v1 succeeds and merges into release/v1.
    const rightTargetPayload = await runSmeltCli(
      ["run", "--worktree", relWt.wtPath, "--target", "release/v1", "--skip-review"],
      {
        cwd: realRepo,
        gateRunner: async () => "passed",
        stdout: silentOut,
      },
    );
    expect(rightTargetPayload.results[0]).toMatchObject({ ok: true, status: "merged" });

    // #7: Moved checkout (path differs from member.worktree.path) is refused without rebasing or pruning.
    const movedSetup = await setupIntegratedWt("orig-wt", "ork/moved-1", "main", "room-moved");
    const movedPath = path.join(rootDir, "relocated-wt");
    execFileSync("git", ["worktree", "move", movedSetup.wtPath, movedPath], {
      cwd: realRepo,
      stdio: "ignore",
    });
    expect(discoverSmeltableWorktrees(realRepo, { mailboxRoot: mRoot })).toEqual([]);
    const movedRes = await smeltWorktree(movedPath, { mailboxRoot: mRoot, skipReview: true });
    expect(movedRes.ok).toBe(false);
    expect(movedRes.status).toBe("room_worktree_mismatch");
    expect(
      execFileSync("git", ["rev-parse", "HEAD"], { cwd: movedPath, encoding: "utf8" }).trim(),
    ).toBe(movedSetup.acceptedCommit);

    // #5: Post-rebase state-write failure persists pendingRebase.rebasedOid beforehand and recovers cleanly on retry.
    const crashWt = await setupIntegratedWt("crash-wt", "ork/crash-1", "main", "room-crash");
    await writeFile(path.join(realRepo, "advance-main.txt"), "main moved\n");
    execFileSync("git", ["add", "advance-main.txt"], { cwd: realRepo });
    execFileSync("git", ["commit", "-m", "chore: advance main for rebase"], {
      cwd: realRepo,
      stdio: "ignore",
    });
    const orkestDir = path.join(crashWt.wtGitDir, "orkest");
    let didBreakAfterUpdateRef = false;
    try {
      const crashRes = await smeltWorktree(crashWt.wtPath, {
        mailboxRoot: mRoot,
        skipReview: true,
        execFileSyncFn: (cmd, args, opts) => {
          const out = execFileSync(cmd, args, opts);
          if (
            cmd === "git" &&
            args[0] === "update-ref" &&
            args[1] === "refs/heads/ork/crash-1" &&
            !didBreakAfterUpdateRef
          ) {
            didBreakAfterUpdateRef = true;
            chmodSync(orkestDir, 0o555);
          }
          return out;
        },
        gateRunner: async () => "passed",
      });
      expect(didBreakAfterUpdateRef).toBe(true);
      expect(crashRes.ok).toBe(false);
      expect(crashRes.status).toBe("state_write_failed");
    } finally {
      chmodSync(orkestDir, 0o755);
    }
    const postCrashHead = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: crashWt.wtPath,
      encoding: "utf8",
    }).trim();
    expect(postCrashHead).not.toBe(crashWt.acceptedCommit);
    const persistedCrashState = JSON.parse(
      await readFile(path.join(orkestDir, "foundry-state.json"), "utf8"),
    );
    expect(persistedCrashState.pendingRebase).toMatchObject({
      acceptedCommit: crashWt.acceptedCommit,
      targetBranch: "main",
      rebaseBranch: "ork/crash-1",
      rebasedOid: postCrashHead,
    });

    // Retry after restoring disk/directory permissions reconciles pendingRebase and merges cleanly!
    const recoveredRes = await smeltWorktree(crashWt.wtPath, {
      mailboxRoot: mRoot,
      skipReview: true,
      gateRunner: async () => "passed",
    });
    expect(recoveredRes.ok).toBe(true);
    expect(recoveredRes.status).toBe("merged");
    expect(
      execFileSync("git", ["rev-parse", "main"], { cwd: realRepo, encoding: "utf8" }).trim(),
    ).toBe(postCrashHead);
    expect(
      execFileSync("git", ["for-each-ref", "refs/orkest/rebase-tmp/"], {
        cwd: realRepo,
        encoding: "utf8",
      }).trim(),
    ).toBe("");

    // #6 & #7: Changed patch context on target + post-update-ref write failure recovers deterministically via rebasedOid,
    // while a partial/strayed commit that does not match pendingRebase.rebasedOid is refused.
    await writeFile(path.join(realRepo, "shared-context.txt"), "line1\nline2\nline3\nline4\n");
    execFileSync("git", ["add", "shared-context.txt"], { cwd: realRepo });
    execFileSync("git", ["commit", "-m", "chore: seed shared context"], {
      cwd: realRepo,
      stdio: "ignore",
    });
    const ctxSlug = "ctx-wt";
    const ctxBranch = "ork/ctx-1";
    const ctxPath = path.join(rootDir, ctxSlug);
    execFileSync("git", ["worktree", "add", "-b", ctxBranch, ctxPath, "main"], {
      cwd: realRepo,
      stdio: "ignore",
    });
    const ctxGitDir = execFileSync("git", ["rev-parse", "--absolute-git-dir"], {
      cwd: ctxPath,
      encoding: "utf8",
    }).trim();
    // Candidate edits line4 (leaving line1 untouched), while main later changes line1 (adjacent hunk context shifts).
    await writeFile(
      path.join(ctxPath, "shared-context.txt"),
      "line1\nline2\nline3\nline4-candidate\n",
    );
    execFileSync("git", ["add", "shared-context.txt"], { cwd: ctxPath });
    execFileSync("git", ["commit", "-m", "feat: candidate line4 change"], {
      cwd: ctxPath,
      stdio: "ignore",
    });
    const ctxAcceptedCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: ctxPath,
      encoding: "utf8",
    }).trim();
    const ctxRoom = await newRoom(parseTeam("codex:luna:max"), {
      id: "room-ctx",
      cwd: realRepo,
      root: mRoot,
    });
    await updateRoom(
      ctxRoom.id,
      (current) => {
        current.agents[0].worktree = {
          path: realpathSync(ctxPath),
          branch: ctxBranch,
          slug: ctxSlug,
          disposable: true,
        };
        current.agents[0].integration = {
          integrationId: "int-ctx-1",
          commit: ctxAcceptedCommit,
          targetBranch: "main",
        };
        return current;
      },
      { root: mRoot },
    );
    const ctxOrkestDir = path.join(ctxGitDir, "orkest");
    await mkdir(ctxOrkestDir, { recursive: true });
    await writeFile(
      path.join(ctxOrkestDir, "task-spec.json"),
      JSON.stringify({ allow_paths: ["shared-context.txt"], verify_command: "true" }),
    );
    await writeFile(
      path.join(ctxOrkestDir, "foundry-state.json"),
      JSON.stringify({
        schema: "ork.foundry.state.v2",
        roomId: "room-ctx",
        memberId: "luna-1",
        integrationId: "int-ctx-1",
        mailboxRoot: mRoot,
        status: "verified",
        targetBranch: "main",
        worktreePath: ctxPath,
        worktreeSlug: ctxSlug,
      }),
    );
    await writeFile(
      path.join(ctxGitDir, "orkest.json"),
      JSON.stringify({
        branch: ctxBranch,
        commit: ctxAcceptedCommit,
        disposable: true,
        integrationId: "int-ctx-1",
        mailboxRoot: mRoot,
        memberId: "luna-1",
        parentCwd: realRepo,
        roomId: "room-ctx",
        slug: ctxSlug,
      }),
    );
    // Advance main with changed context in the same file (line1 -> line1-main).
    await writeFile(path.join(realRepo, "shared-context.txt"), "line1-main\nline2\nline3\nline4\n");
    execFileSync("git", ["add", "shared-context.txt"], { cwd: realRepo });
    execFileSync("git", ["commit", "-m", "chore: shift context on main"], {
      cwd: realRepo,
      stdio: "ignore",
    });

    let didBreakCtx = false;
    try {
      const ctxCrash = await smeltWorktree(ctxPath, {
        mailboxRoot: mRoot,
        skipReview: true,
        execFileSyncFn: (cmd, args, opts) => {
          const out = execFileSync(cmd, args, opts);
          if (
            cmd === "git" &&
            args[0] === "update-ref" &&
            args[1] === `refs/heads/${ctxBranch}` &&
            !didBreakCtx
          ) {
            didBreakCtx = true;
            chmodSync(ctxOrkestDir, 0o555);
          }
          return out;
        },
        gateRunner: async () => "passed",
      });
      expect(didBreakCtx).toBe(true);
      expect(ctxCrash.ok).toBe(false);
      expect(ctxCrash.status).toBe("state_write_failed");
    } finally {
      chmodSync(ctxOrkestDir, 0o755);
    }
    const ctxRebasedHead = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: ctxPath,
      encoding: "utf8",
    }).trim();
    const ctxStateBeforeRetry = JSON.parse(
      await readFile(path.join(ctxOrkestDir, "foundry-state.json"), "utf8"),
    );
    expect(ctxStateBeforeRetry.pendingRebase.rebasedOid).toBe(ctxRebasedHead);

    // If a strayed/partial commit replaces HEAD on the branch, recovery refuses with room_commit_mismatch (#6).
    const strayedCommit = execFileSync(
      "git",
      [
        "commit-tree",
        `${ctxRebasedHead}^\u{7B}tree}`,
        "-p",
        ctxRebasedHead,
        "-m",
        "strayed commit",
      ],
      { cwd: ctxPath, encoding: "utf8" },
    ).trim();
    execFileSync("git", ["reset", "--hard", strayedCommit], { cwd: ctxPath, stdio: "ignore" });
    const strayedRes = await smeltWorktree(ctxPath, {
      mailboxRoot: mRoot,
      skipReview: true,
      gateRunner: async () => "passed",
    });
    expect(strayedRes.ok).toBe(false);
    expect(strayedRes.status).toBe("room_commit_mismatch");

    // Restoring the exact pendingRebase.rebasedOid recovers deterministically even with shifted patch context (#7).
    execFileSync("git", ["reset", "--hard", ctxRebasedHead], { cwd: ctxPath, stdio: "ignore" });
    const ctxRecovered = await smeltWorktree(ctxPath, {
      mailboxRoot: mRoot,
      skipReview: true,
      gateRunner: async () => "passed",
    });
    expect(ctxRecovered.ok).toBe(true);
    expect(ctxRecovered.status).toBe("merged");
    expect(
      execFileSync("git", ["rev-parse", "main"], { cwd: realRepo, encoding: "utf8" }).trim(),
    ).toBe(ctxRebasedHead);
    expect(
      execFileSync("git", ["for-each-ref", "refs/orkest/rebase-tmp/"], {
        cwd: realRepo,
        encoding: "utf8",
      }).trim(),
    ).toBe("");
  });
});
