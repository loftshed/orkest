import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readFoundryState, writeFoundryState } from "../../../plugins/orchestrate/lib/foundry.mjs";
import {
  acquireNextLock,
  buildRepairDispatchSpec,
  EXIT_HUMAN_APPROVAL,
  NEXT_LEDGER_SCHEMA,
  NEXT_SCHEMA,
  nextCommand,
  readNextLedger,
  releaseNextLock,
  writeNextLedger,
} from "../../../plugins/orchestrate/lib/next.mjs";
import { retainFixtures } from "../../helpers/retain-fixtures.js";

const temporary = [];

async function makeTempDir(prefix = "ork-next-test-") {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  temporary.push(dir);
  return dir;
}

afterEach(async () => {
  process.exitCode = 0;
  await retainFixtures(temporary.splice(0));
});

async function createMockWorktree(
  rootDir,
  repoRoot,
  {
    allowPaths = ["plugins/orchestrate/lib/next.mjs"],
    branch = "feat/issue-101",
    disposable = true,
    engine = "codex",
    issue = 101,
    slug = "wt-101",
    statePatch = null,
    verifyCommand = "vitest run tests/plugins/orchestrate/next-test.js",
  } = {},
) {
  const wtPath = path.join(rootDir, slug);
  const gitDir = path.join(rootDir, `gitdir-${slug}`);
  await mkdir(wtPath, { recursive: true });
  await mkdir(path.join(gitDir, "orkest"), { recursive: true });
  await writeFile(path.join(wtPath, ".git"), `gitdir: ${gitDir}\n`);
  await writeFile(
    path.join(gitDir, "orkest.json"),
    JSON.stringify({
      branch,
      disposable,
      engine,
      issue,
      parentCwd: repoRoot,
      slug,
    }),
  );
  await writeFile(
    path.join(gitDir, "orkest", "task-spec.json"),
    JSON.stringify({
      allow_paths: allowPaths,
      development_checks: [verifyCommand],
      objective: `Resolve #${issue}`,
      schema: "agent-executor.task-spec.v1",
      verify_command: verifyCommand,
    }),
  );
  if (statePatch) {
    writeFoundryState(wtPath, {
      branch,
      issue: { number: issue, title: `Issue ${issue}` },
      verifyCommand,
      worktreeSlug: slug,
      ...statePatch,
    });
  }
  return { branch, gitDir, issue, path: wtPath, slug, worktreePath: wtPath };
}

describe("ork next lock, ledger, and repair spec builder", () => {
  it("manages repo-scoped locks, releases dead holders, and persists bounded ledger history", async () => {
    const rootDir = await makeTempDir("ork-next-lock-");
    const repoRoot = path.join(rootDir, "repo");
    const cacheDir = path.join(rootDir, "cache");
    await mkdir(repoRoot, { recursive: true });
    const env = { ORCHESTRATE_HOME: cacheDir };

    const lock1 = await acquireNextLock(repoRoot, { env });
    expect(lock1.acquired).toBe(true);
    await expect(acquireNextLock(repoRoot, { env })).rejects.toThrow(/already running/u);
    await releaseNextLock(lock1);

    // Only the real holder's death releases ownership; PID metadata cannot reclaim it.
    const deadLock = await acquireNextLock(repoRoot, { env });
    expect(deadLock.acquired).toBe(true);
    process.kill(deadLock.pid, "SIGKILL");
    await releaseNextLock(deadLock);
    const recoveredLock = await acquireNextLock(repoRoot, { env });
    expect(recoveredLock.acquired).toBe(true);
    await releaseNextLock(recoveredLock);

    const updatedLedger = await writeNextLedger(
      repoRoot,
      {
        historyEntry: {
          actionId: "tier1:smelt_worktree:wt-101",
          kind: "smelt_worktree",
          status: "merged",
          summary: "Smelted wt-101",
          target: "wt-101",
          tier: 1,
        },
        worktrees: {
          "wt-101": { attemptCount: 1, lastAction: "smelt_worktree", status: "merged" },
        },
      },
      { env },
    );
    expect(updatedLedger.schema).toBe(NEXT_LEDGER_SCHEMA);
    expect(readNextLedger(repoRoot, { env }).history).toHaveLength(1);
    expect(readNextLedger(repoRoot, { env }).worktrees["wt-101"].status).toBe("merged");
  });

  it("uses warm session resume (--session --resume-result) for healthy repair states and fresh cross-vendor reset for worker_failed", () => {
    const baseWorktree = {
      allowPaths: ["plugins/orchestrate/lib/next.mjs"],
      archetype: "debug-invariants",
      engine: "codex",
      slug: "wt-101",
      taskSpecPath: "/tmp/wt-101/task-spec.json",
      verifyCommand: "vitest run tests/plugins/orchestrate/next-test.js",
      worktreePath: "/tmp/wt-101",
    };

    const warmSpec = buildRepairDispatchSpec(baseWorktree, {
      attemptCount: 1,
      lastRun: {
        engine: "codex",
        model: "gpt:sol",
        resultPath: "/tmp/runs/run-101/result.json",
        sessionId: "session-101",
        status: "completed",
      },
      maxAttempts: 2,
      status: "verification_failed",
      verification: { output: "AssertionError: expected 1 to be 2" },
    });

    expect(warmSpec.mode).toBe("warm_resume");
    expect(warmSpec.engine).toBe("codex");
    expect(warmSpec.sessionId).toBe("session-101");
    expect(warmSpec.resumeResultPath).toBe("/tmp/runs/run-101/result.json");
    expect(warmSpec.args).toContain("--session");
    expect(warmSpec.args).toContain("session-101");
    expect(warmSpec.args).toContain("--resume-result");
    expect(warmSpec.args).toContain("/tmp/runs/run-101/result.json");
    expect(warmSpec.prompt).toContain("AssertionError: expected 1 to be 2");

    // Review changes requested also uses warm resume when session exists:
    const reviewWarmSpec = buildRepairDispatchSpec(baseWorktree, {
      attemptCount: 1,
      findings: "- Missing null check in next.mjs",
      lastRun: {
        engine: "codex",
        model: "gpt:sol",
        resultPath: "/tmp/runs/run-101/result.json",
        sessionId: "session-101",
        status: "completed",
      },
      maxAttempts: 2,
      status: "review_changes_requested",
    });
    expect(reviewWarmSpec.mode).toBe("warm_resume");
    expect(reviewWarmSpec.prompt).toContain("Missing null check in next.mjs");

    // worker_failed uses fresh_reset on an alternate cross-vendor route without --session:
    const freshSpec = buildRepairDispatchSpec(baseWorktree, {
      attemptCount: 1,
      lastRun: {
        engine: "codex",
        model: "gpt:sol",
        resultPath: "/tmp/runs/run-101/result.json",
        sessionId: "session-101",
        status: "failed",
      },
      maxAttempts: 2,
      status: "worker_failed",
      verification: { reason: "Builder timed out" },
    });
    expect(freshSpec.mode).toBe("fresh_reset");
    expect(freshSpec.engine).not.toBe("codex");
    expect(freshSpec.args).not.toContain("--session");
    expect(freshSpec.args).not.toContain("--resume-result");
  });
});

describe("ork next 4-tier waterfall execution", () => {
  it("drains Tier 0 housekeeping (pruning merged worktrees and escalating exhausted repairs) and executes Tier 1 smelt before Tier 2", async () => {
    const rootDir = await makeTempDir("ork-next-tiers-");
    const repoRoot = path.join(rootDir, "repo");
    const cacheDir = path.join(rootDir, "cache");
    await mkdir(repoRoot, { recursive: true });
    const env = { ORCHESTRATE_HOME: cacheDir };

    const wtMerged = await createMockWorktree(rootDir, repoRoot, {
      branch: "feat/issue-100",
      issue: 100,
      slug: "wt-100",
      statePatch: { commitsAhead: 0, status: "merged" },
    });
    const wtVerifiedLow = await createMockWorktree(rootDir, repoRoot, {
      allowPaths: ["tests/plugins/orchestrate/next-test.js"],
      branch: "feat/issue-101",
      issue: 101,
      slug: "wt-101",
      statePatch: {
        blastRadius: "low",
        commitsAhead: 1,
        status: "verified",
        verification: { candidate: { commit: "3333333" } },
      },
    });
    const wtVerifiedMed = await createMockWorktree(rootDir, repoRoot, {
      allowPaths: ["plugins/orchestrate/lib/next.mjs"],
      branch: "feat/issue-102",
      issue: 102,
      slug: "wt-102",
      statePatch: {
        blastRadius: "medium",
        commitsAhead: 1,
        status: "verified",
        verification: { candidate: { commit: "2222222" } },
      },
    });

    let wasPrunedMerged = false;
    const porcelain = () =>
      [
        `worktree ${repoRoot}`,
        "HEAD 1111111",
        "branch refs/heads/main",
        "",
        ...(wasPrunedMerged
          ? []
          : [`worktree ${wtMerged.path}`, "HEAD 1111111", "branch refs/heads/feat/issue-100", ""]),
        `worktree ${wtVerifiedMed.path}`,
        "HEAD 2222222",
        "branch refs/heads/feat/issue-102",
        "",
        `worktree ${wtVerifiedLow.path}`,
        "HEAD 3333333",
        "branch refs/heads/feat/issue-101",
        "",
      ].join("\n");

    const execMock = (cmd, args, opts) => {
      if (cmd === "git" && args[0] === "worktree" && args[1] === "list") return porcelain();
      if (cmd === "git" && args[0] === "worktree" && args[1] === "remove") {
        if (args[2] === wtMerged.path) wasPrunedMerged = true;
        return "";
      }
      if (cmd === "git" && args[0] === "rev-list") {
        if (opts?.cwd === wtMerged.path) return "0\n";
        return "1\n";
      }
      if (cmd === "git" && ["status", "ls-files", "diff"].includes(args[0])) return "";
      if (cmd === "git" && args[0] === "rev-parse" && args[1] === "HEAD")
        return opts?.cwd === wtVerifiedLow.path ? "3333333\n" : "2222222\n";
      return "main-sha-1\n";
    };

    const stdout = { columns: 120, isTTY: false, write: () => {} };
    const statusPlan = await nextCommand(["status", "--json"], {
      cwd: repoRoot,
      env,
      execFileSyncFn: execMock,
      stdout,
    });
    expect(statusPlan.schema).toBe(NEXT_SCHEMA);
    expect(statusPlan.nextAction.kind).toBe("prune_merged_worktree");

    const smeltedSlugs = [];
    const stepRes = await nextCommand(["step", "--json"], {
      cwd: repoRoot,
      env,
      execFileSyncFn: execMock,
      smeltWorktreeFn: async (wt) => {
        smeltedSlugs.push(wt.slug);
        writeFoundryState(wt.worktreePath, { status: "merged" });
        return { ok: true, pruned: true, status: "merged" };
      },
      stdout,
    });

    // Tier 0 auto-drained wt-100 prune, then Tier 1 smelted lowest-blast wt-101 first:
    expect(wasPrunedMerged).toBe(true);
    expect(stepRes.settledActions).toEqual([
      expect.objectContaining({
        kind: "prune_merged_worktree",
        outcome: "pruned",
        target: "wt-100",
      }),
    ]);
    expect(stepRes.executedAction.kind).toBe("smelt_worktree");
    expect(stepRes.executedAction.target).toBe("wt-101");
    expect(smeltedSlugs).toEqual(["wt-101"]);
  });

  it("pauses with exitCode 4 on Tier 3 human approval gates and promotes awaiting_human_approval when --approve <slug> is given", async () => {
    const rootDir = await makeTempDir("ork-next-approve-");
    const repoRoot = path.join(rootDir, "repo");
    const cacheDir = path.join(rootDir, "cache");
    await mkdir(repoRoot, { recursive: true });
    const env = { ORCHESTRATE_HOME: cacheDir };

    const wtHigh = await createMockWorktree(rootDir, repoRoot, {
      allowPaths: ["plugins/orchestrate/bin/ork.mjs"],
      branch: "feat/issue-201",
      issue: 201,
      slug: "wt-201",
      statePatch: {
        blastRadius: "high",
        commitsAhead: 1,
        status: "awaiting_human_approval",
        candidate: { commit: "2222222" },
      },
    });

    const porcelain = [
      `worktree ${repoRoot}`,
      "HEAD 1111111",
      "branch refs/heads/main",
      "",
      `worktree ${wtHigh.path}`,
      "HEAD 2222222",
      "branch refs/heads/feat/issue-201",
      "",
    ].join("\n");

    const execMock = (cmd, args) => {
      if (cmd === "git" && args[0] === "worktree" && args[1] === "list") return porcelain;
      if (cmd === "git" && args[0] === "rev-list") return "1\n";
      if (cmd === "git" && ["status", "ls-files", "diff"].includes(args[0])) return "";
      if (cmd === "git" && args[0] === "rev-parse" && args[1] === "HEAD") return "2222222\n";
      return "main-sha-1\n";
    };

    const notifications = [];
    const stdout = { columns: 120, isTTY: false, write: () => {} };

    // Without --approve, ork next pauses with exitCode 4 and notifies:
    const pausedRes = await nextCommand(["step", "--json"], {
      cwd: repoRoot,
      env,
      execFileSyncFn: execMock,
      notifyFn: (title, body) => {
        notifications.push({ body, title });
      },
      stdout,
    });
    expect(pausedRes.ok).toBe(false);
    expect(pausedRes.exitCode).toBe(EXIT_HUMAN_APPROVAL);
    expect(pausedRes.status).toBe("awaiting_human");
    expect(pausedRes.gate.kind).toBe("awaiting_human_approval");
    expect(notifications).toHaveLength(1);

    process.exitCode = 0;
    let approvedCallOptions = null;
    const approvedRes = await nextCommand(["step", "--approve", "wt-201", "--json"], {
      cwd: repoRoot,
      env,
      execFileSyncFn: execMock,
      smeltWorktreeFn: async (wt, opts) => {
        approvedCallOptions = opts;
        writeFoundryState(wt.worktreePath, { status: "merged" });
        return { ok: true, pruned: true, status: "merged" };
      },
      stdout,
    });
    expect(approvedRes.ok).toBe(true);
    expect(approvedRes.exitCode).toBe(0);
    expect(approvedRes.executedAction.kind).toBe("smelt_approved");
    expect(approvedCallOptions.approveHighBlast).toBe("2222222");
  });

  it("performs bounded Tier 2 self-repair (maxAttempts=2) and escalates to needs_human on second failure", async () => {
    const rootDir = await makeTempDir("ork-next-repair-");
    const repoRoot = path.join(rootDir, "repo");
    const cacheDir = path.join(rootDir, "cache");
    await mkdir(repoRoot, { recursive: true });
    const env = { ORCHESTRATE_HOME: cacheDir };

    const wtFailed = await createMockWorktree(rootDir, repoRoot, {
      allowPaths: ["plugins/orchestrate/lib/next.mjs"],
      branch: "feat/issue-301",
      issue: 301,
      slug: "wt-301",
      statePatch: {
        attemptCount: 1,
        commitsAhead: 1,
        lastRun: {
          engine: "codex",
          model: "gpt:sol",
          resultPath: "/tmp/res-301.json",
          sessionId: "session-301",
          status: "completed",
        },
        maxAttempts: 2,
        status: "verification_failed",
        verification: { output: "1 failing test in next-test.js" },
      },
    });

    const porcelain = [
      `worktree ${repoRoot}`,
      "HEAD 1111111",
      "branch refs/heads/main",
      "",
      `worktree ${wtFailed.path}`,
      "HEAD 2222222",
      "branch refs/heads/feat/issue-301",
      "",
    ].join("\n");

    const execMock = (cmd, args) => {
      if (cmd === "git" && args[0] === "worktree" && args[1] === "list") return porcelain;
      if (cmd === "git" && args[0] === "rev-list") return "1\n";
      if (cmd === "git" && ["status", "ls-files", "diff"].includes(args[0])) return "";
      return "2222222\n";
    };

    const stdout = { columns: 120, isTTY: false, write: () => {} };
    const capturedAgentArgs = [];

    // When repair attempt #2 fails verification, it immediately transitions to needs_human (exitCode 4):
    const failedRepair = await nextCommand(["step", "--json"], {
      cwd: repoRoot,
      env,
      execAgentFn: async (args) => {
        capturedAgentArgs.push(args);
        return { commitsAhead: 1, status: "completed" };
      },
      execFileSyncFn: execMock,
      execVerifyFn: async () => ({ exitCode: 1, ok: false, output: "Still failing" }),
      notifyFn: () => {},
      stdout,
    });

    expect(capturedAgentArgs).toHaveLength(1);
    expect(capturedAgentArgs[0]).toContain("--session");
    expect(capturedAgentArgs[0]).toContain("session-301");
    expect(failedRepair.status).toBe("needs_human");
    expect(failedRepair.exitCode).toBe(EXIT_HUMAN_APPROVAL);
    expect(readFoundryState(wtFailed.path)).toMatchObject({
      attemptCount: 2,
      maxAttempts: 2,
      status: "needs_human",
    });

    // Subsequent `ork next step` refuses to retry a 3rd time and stays on Tier 3 needs_human:
    process.exitCode = 0;
    const thirdTry = await nextCommand(["step", "--json"], {
      cwd: repoRoot,
      env,
      execAgentFn: async (args) => {
        capturedAgentArgs.push(args);
        return { status: "completed" };
      },
      execFileSyncFn: execMock,
      notifyFn: () => {},
      stdout,
    });
    expect(capturedAgentArgs).toHaveLength(1);
    expect(thirdTry.status).toBe("awaiting_human");
    expect(thirdTry.exitCode).toBe(EXIT_HUMAN_APPROVAL);
    expect(thirdTry.gate.kind).toBe("needs_human");
  });

  it("dispatches disjoint issues in parallel across expiring pools and enforces loop budgets in ork next loop", async () => {
    const rootDir = await makeTempDir("ork-next-loop-");
    const repoRoot = path.join(rootDir, "repo");
    const cacheDir = path.join(rootDir, "cache");
    await mkdir(repoRoot, { recursive: true });
    const env = { ORCHESTRATE_HOME: cacheDir };

    const now = Date.now();
    const expiringAccounts = [
      {
        fetchedAt: now,
        id: "codex-work",
        label: "Codex Expiring",
        ok: true,
        pools: [{ families: ["gpt"], id: "codex", label: "Codex", windowIds: ["wk"] }],
        provider: "codex",
        route: "--engine codex",
        windows: [
          {
            id: "wk",
            label: "Weekly",
            remainingPct: 70,
            resetsAt: now + 60 * 60 * 1000,
            windowMins: 10_080,
          },
        ],
      },
      {
        fetchedAt: now,
        id: "claude-work",
        label: "Claude Expiring",
        ok: true,
        pools: [{ families: ["claude"], id: "claude", label: "Claude", windowIds: ["wk"] }],
        provider: "claude",
        route: "--engine claude",
        windows: [
          {
            id: "wk",
            label: "Weekly",
            remainingPct: 75,
            resetsAt: now + 60 * 60 * 1000,
            windowMins: 10_080,
          },
        ],
      },
    ];

    const makeIssue = (num, allowPath) => ({
      body: [
        "```json task-spec",
        JSON.stringify({
          allow_paths: [allowPath],
          development_checks: ["vitest run tests/plugins/orchestrate/next-test.js"],
          objective: `Resolve #${num}`,
          schema: "agent-executor.task-spec.v1",
        }),
        "```",
      ].join("\n"),
      labels: [{ name: "agent:ready" }, { name: "archetype:debug-invariants" }],
      number: num,
      state: "open",
      title: `Disjoint issue ${num}`,
    });

    const openIssues = [makeIssue(401, "plugins/a.mjs"), makeIssue(402, "plugins/b.mjs")];
    const stdout = { columns: 120, isTTY: false, write: () => {} };

    const planRes = await nextCommand(["plan", "--include-github", "--json"], {
      cwd: repoRoot,
      discoverWorktreesFn: async () => [],
      env,
      execFileSyncFn: () => "",
      getAccountsFn: async () => expiringAccounts,
      openIssues,
      stdout,
    });

    expect(planRes.nextAction).toMatchObject({
      issueNumbers: [401, 402],
      kind: "dispatch_foundry",
      parallelExpiring: true,
      tier: 2,
    });

    // Test ork next loop stopping on noop when no work remains:
    const loopRes = await nextCommand(["loop", "--max-steps", "3", "--json"], {
      cwd: repoRoot,
      discoverWorktreesFn: async () => [],
      env,
      execFileSyncFn: () => "",
      getAccountsFn: async () => [],
      openIssues: [],
      stdout,
    });
    expect(loopRes.mode).toBe("loop");
    expect(loopRes.status).toBe("noop");
    expect(loopRes.steps).toHaveLength(1);
  });
});

describe("Next distinguishes verification infrastructure from code repairs", () => {
  it.each(["gate_infrastructure_failure", "review_infrastructure_failure"])(
    "retries %s twice without repair or false review claims",
    async (status) => {
      const root = await makeTempDir("ork-next-infrastructure-retained-");
      const repo = path.join(root, "repo");
      await mkdir(repo);
      const env = { ...process.env, ORCHESTRATE_HOME: path.join(root, "cache") };
      const wt = await createMockWorktree(root, repo, {
        statePatch: {
          status,
          attemptCount: 2,
          maxAttempts: 2,
          infrastructureRetry: { candidateCommit: "candidate-sha", count: 1, maxRetries: 2 },
        },
      });
      const porcelain = `worktree ${repo}\nHEAD target-sha\nbranch refs/heads/main\n\nworktree ${wt.path}\nHEAD candidate-sha\nbranch refs/heads/${wt.branch}\n`;
      const execMock = (cmd, args) => {
        if (cmd === "git" && args[0] === "worktree" && args[1] === "list") return porcelain;
        if (cmd === "git" && args[0] === "rev-list") return "1\n";
        if (cmd === "git" && args[0] === "rev-parse")
          return args[1] === "HEAD" ? "candidate-sha\n" : "target-sha\n";
        return "";
      };
      const options = {
        cwd: repo,
        env,
        execFileSyncFn: execMock,
        stdout: { write() {} },
        notifyFn() {},
        smeltWorktreeFn: async (worktree) => {
          const state = readFoundryState(worktree.worktreePath);
          writeFoundryState(worktree.worktreePath, {
            status,
            infrastructureRetry: {
              ...state.infrastructureRetry,
              count: state.infrastructureRetry.count + 1,
            },
          });
          return { ok: false, status, retryable: true };
        },
      };
      for (const count of [2, 3]) {
        process.exitCode = 0;
        const result = await nextCommand(["step", "--json"], options);
        expect(result.executedAction).toMatchObject({ kind: "retry_infrastructure", tier: 1 });
        expect(readFoundryState(wt.path)).toMatchObject({
          status,
          attemptCount: 2,
          infrastructureRetry: { count },
        });
      }
      process.exitCode = 0;
      const exhausted = await nextCommand(["step", "--json"], options);
      expect(exhausted).toMatchObject({
        status: "awaiting_human",
        gate: { kind: "infrastructure_retry_exhausted" },
      });
      expect(exhausted.gate.summary).toContain("candidate not marked failing");
      expect(readFoundryState(wt.path)).toMatchObject({ status, attemptCount: 2 });
    },
  );
});
