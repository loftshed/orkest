import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  bootstrapWorktreeInclude,
  DEFAULT_ROUTES,
  factoryCommand,
  parseIssueDependencies,
  planBatch,
  poolSummary,
  resolveTaskSpecPath,
} from "../../../plugins/orchestrate/lib/factory.mjs";
import {
  foundryCli,
  foundryGroom,
  foundryRun,
  foundryStatus,
} from "../../../plugins/orchestrate/lib/foundry.mjs";
import {
  classifyBlastRadius,
  discoverSmeltableWorktrees,
  selectColdReviewerEngine,
  smelterCli,
  smeltWorktree,
} from "../../../plugins/orchestrate/lib/smelter.mjs";

const temporary = [];

async function makeTempDir(prefix = "ork-smelter-test-") {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  temporary.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
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
    const gitDir = path.join(rootDir, "gitdir-wt-63");
    await mkdir(repoRoot, { recursive: true });
    await mkdir(worktreePath, { recursive: true });
    await mkdir(gitDir, { recursive: true });
    await writeFile(path.join(worktreePath, ".git"), `gitdir: ${gitDir}\n`);
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
    const gitDir63 = path.join(rootDir, "gitdir-63");
    const gitDirKeep = path.join(rootDir, "gitdir-keep");

    await mkdir(repoRoot, { recursive: true });
    await mkdir(wtDisposable, { recursive: true });
    await mkdir(wtKeep, { recursive: true });
    await mkdir(path.join(gitDir63, "orkest"), { recursive: true });
    await mkdir(gitDirKeep, { recursive: true });

    await writeFile(path.join(wtDisposable, ".git"), `gitdir: ${gitDir63}\n`);
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

    await writeFile(path.join(wtKeep, ".git"), `gitdir: ${gitDirKeep}\n`);
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

  it("executes the 4-stage smeltWorktree pipeline with dry-run, injectable callbacks, scope enforcement, and strategy support", async () => {
    const repoRoot = "/tmp/mock-repo";
    const worktreePath = "/tmp/mock-wt-63";
    const baseWorktree = {
      allowPaths: ["plugins/orchestrate/lib/smelter.mjs", "tests/plugins/orchestrate/"],
      branch: "feat/issue-63",
      disposable: true,
      engine: "claude",
      issue: 63,
      parentCwd: repoRoot,
      path: worktreePath,
      slug: "wt-63",
      verifyCommand: "./scripts/check.sh",
    };

    const recordedCmds = [];
    const execMock = (cmd, args, opts) => {
      recordedCmds.push({ args, cmd, cwd: opts?.cwd });
      if (cmd === "git" && args[0] === "status") return "";
      if (cmd === "git" && args[0] === "diff") {
        return "plugins/orchestrate/lib/smelter.mjs\ntests/plugins/orchestrate/smelter-test.js\n";
      }
      return "ok";
    };

    const dryRunRes = await smeltWorktree(baseWorktree, {
      dryRun: true,
      execFileSyncFn: execMock,
      targetBranch: "main",
    });
    expect(dryRunRes.dryRun).toBe(true);
    expect(dryRunRes.blastRadius).toBe("medium");
    expect(dryRunRes.reviewerEngine).toBe("codex");
    expect(dryRunRes.pruned).toBe(false);
    expect(dryRunRes.stages.rebaseAndScope.status).toBe("dry-run");
    expect(dryRunRes.stages.heavyGate.status).toBe("dry-run");
    expect(dryRunRes.stages.coldReview.status).toBe("dry-run");
    expect(dryRunRes.stages.smeltAndPrune.status).toBe("dry-run");
    // Only git status and git diff run during dry-run:
    expect(recordedCmds.map((c) => [c.cmd, ...c.args])).toEqual([
      ["git", "status", "--porcelain"],
      ["git", "diff", "--name-only", "main...HEAD"],
    ]);

    recordedCmds.length = 0;
    const gateCalls = [];
    const reviewCalls = [];
    const fullRes = await smeltWorktree(baseWorktree, {
      execFileSyncFn: execMock,
      gateRunner: async (info) => {
        gateCalls.push(info);
        return "gate passed";
      },
      reviewRunner: async (info) => {
        reviewCalls.push(info);
        return "review passed";
      },
      strategy: "local",
      targetBranch: "main",
    });

    expect(fullRes.ok).toBe(true);
    expect(fullRes.pruned).toBe(true);
    expect(gateCalls).toHaveLength(1);
    expect(gateCalls[0].command).toEqual(["ork", "gate", "--heavy", "--", "./scripts/check.sh"]);
    expect(reviewCalls).toHaveLength(1);
    expect(reviewCalls[0].args).toEqual([
      "consult",
      "--intent",
      "review",
      "--engine",
      "codex",
      "--read",
      worktreePath,
      "--diff",
      "main",
    ]);
    expect(recordedCmds.map((c) => [c.cmd, ...c.args])).toEqual([
      ["git", "status", "--porcelain"],
      ["git", "diff", "--name-only", "main...HEAD"],
      ["git", "rebase", "main"],
      ["git", "merge", "--ff-only", "feat/issue-63"],
      ["git", "worktree", "remove", worktreePath],
      ["git", "branch", "-d", "feat/issue-63"],
    ]);

    // Kept worktree (disposable: false) should not be removed in local strategy:
    recordedCmds.length = 0;
    const keepRes = await smeltWorktree(
      { ...baseWorktree, disposable: false },
      {
        execFileSyncFn: execMock,
        skipReview: true,
        strategy: "local",
      },
    );
    expect(keepRes.pruned).toBe(false);
    expect(recordedCmds.map((c) => [c.cmd, ...c.args])).toEqual([
      ["git", "status", "--porcelain"],
      ["git", "diff", "--name-only", "main...HEAD"],
      ["git", "rebase", "main"],
      ["ork", "gate", "--heavy", "--", "./scripts/check.sh"],
      ["git", "merge", "--ff-only", "feat/issue-63"],
    ]);

    // PR strategy pushes and opens a PR via gh pr create:
    recordedCmds.length = 0;
    const prRes = await smeltWorktree(baseWorktree, {
      execFileSyncFn: execMock,
      skipReview: true,
      strategy: "pr",
      targetBranch: "main",
    });
    expect(prRes.strategy).toBe("pr");
    expect(recordedCmds.map((c) => [c.cmd, ...c.args])).toContainEqual([
      "gh",
      "pr",
      "create",
      "--base",
      "main",
      "--head",
      "feat/issue-63",
      "--fill",
    ]);

    // Scope audit rejects modifications outside allow_paths:
    await expect(
      smeltWorktree(baseWorktree, {
        changedPaths: ["plugins/orchestrate/bin/ork.mjs"],
        execFileSyncFn: execMock,
      }),
    ).rejects.toThrow(/Scope audit failed/u);

    // Dirty worktree is rejected in Stage 1:
    await expect(
      smeltWorktree(baseWorktree, {
        execFileSyncFn: (cmd, args) => (cmd === "git" && args[0] === "status" ? " M dirty.js" : ""),
      }),
    ).rejects.toThrow(/uncommitted changes/u);
  });

  it("supports smelterCli status --json and run --dry-run --json", async () => {
    const rootDir = await makeTempDir("ork-smelter-cli-");
    const repoRoot = path.join(rootDir, "repo");
    const wtPath = path.join(rootDir, "wt-63");
    const gitDir = path.join(rootDir, "gitdir-63");
    await mkdir(repoRoot, { recursive: true });
    await mkdir(wtPath, { recursive: true });
    await mkdir(path.join(gitDir, "orkest"), { recursive: true });
    await writeFile(path.join(wtPath, ".git"), `gitdir: ${gitDir}\n`);
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
      if (cmd === "git" && args[0] === "diff") return "plugins/orchestrate/lib/smelter.mjs\n";
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
});
