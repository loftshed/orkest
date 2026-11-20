import { execFileSync, fork, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  collectActiveWorktreeAllowPaths,
  createFoundryAttempt,
  foundryLauncherAlive,
  foundryPrTransitions,
  foundryRun,
  FoundryStateError,
  loadFoundryState,
  normalizeFoundryPr,
  processIdentity,
  readFoundryState,
  resolveFoundryStatePath,
  updateFoundryAttempt,
  writeFoundryState,
} from "../../../src/lib/foundry.mjs";
import {
  discoverManagedWorktrees,
  evaluateNextCandidates,
  nextCommand,
  readNextLedger,
} from "../../../src/lib/next.mjs";
import {
  discoverSmeltableWorktrees,
  smelterCli,
  smeltWorktree,
} from "../../../src/lib/smelter.mjs";
import { acquireWorkspaceLease } from "../../../src/lib/workspace-lease.mjs";
import { listWorktreePorts } from "../../../src/lib/worktree-ports.mjs";

function fixture() {
  const rawRoot = mkdtempSync(path.join(tmpdir(), "orkest-state-"));
  const root = realpathSync(rawRoot);
  const file = resolveFoundryStatePath(root);
  mkdirSync(path.dirname(file), { recursive: true });
  return { root, file };
}

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function worktreeFixture() {
  const rawRoot = mkdtempSync(path.join(tmpdir(), "orkest-state-git-"));
  const root = realpathSync(rawRoot);
  const repo = path.join(root, "repo");
  const worktree = path.join(root, "worktree");
  mkdirSync(repo);
  git(repo, "init", "-b", "main");
  writeFileSync(path.join(repo, "tracked.txt"), "base\n");
  git(repo, "add", "tracked.txt");
  git(
    repo,
    "-c",
    "user.name=Lease Test",
    "-c",
    "user.email=lease@example.invalid",
    "commit",
    "-m",
    "base",
  );
  git(repo, "worktree", "add", "-b", "candidate", worktree);
  const file = resolveFoundryStatePath(worktree);
  mkdirSync(path.dirname(file), { recursive: true });
  const gitDirectory = path.dirname(path.dirname(file));
  writeFileSync(
    path.join(gitDirectory, "orkest.json"),
    JSON.stringify({ disposable: true, slug: "candidate", parentCwd: repo }),
  );
  writeFileSync(path.join(worktree, "tracked.txt"), "dirty candidate\n");
  return { root, repo, worktree, file };
}

const sink = { write() {} };

describe("strict Foundry state with retained fixtures", () => {
  it("distinguishes missing, legacy, v1, v2, corrupt and unsupported", () => {
    const f = fixture();
    expect(loadFoundryState(f.root)).toMatchObject({
      kind: "missing",
      state: null,
      path: f.file,
      error: null,
    });
    expect(readFoundryState(f.root)).toBeNull();
    for (const state of [
      { attemptCount: 4 },
      { schema: "ork.foundry.state.v1", status: "verified" },
      { schema: "ork.foundry.state.v2", attemptCount: 7 },
    ]) {
      writeFileSync(f.file, JSON.stringify(state));
      expect(loadFoundryState(f.root)).toMatchObject({ kind: "ok", state });
      expect(readFoundryState(f.root)).toEqual(state);
    }
    for (const value of [
      "null",
      "[]",
      "42",
      '{"schema":"ork.foundry.state.v999"}',
      '{"schema":null}',
    ]) {
      writeFileSync(f.file, value);
      expect(loadFoundryState(f.root).kind).toBe("unsupported");
      expect(() => readFoundryState(f.root)).toThrow(FoundryStateError);
    }
    writeFileSync(f.file, '{"attemptCount":77,');
    expect(loadFoundryState(f.root).kind).toBe("corrupt");
    expect(() => readFoundryState(f.root)).toThrow(FoundryStateError);
  });

  it("round trips state larger than a synchronous child-process output buffer", () => {
    const f = fixture();
    for (const size of [200_000, 850_000, 1_200_000]) {
      const payload = "x".repeat(size);
      const saved = writeFoundryState(f.root, { payload });
      expect(readFoundryState(f.root)).toEqual(saved);
    }
  });

  it.each([
    ["corrupt", Buffer.from([255, 0, 123])],
    ["corrupt", Buffer.concat([Buffer.from('{"note":"'), Buffer.from([255]), Buffer.from('"}')])],
    ["unsupported", Buffer.from('{"schema":"future","attemptCount":99}')],
  ])(
    "preserves %s bytes and remains closed across repeated writes and discovery",
    (kind, bytes) => {
      const f = fixture();
      writeFileSync(f.file, bytes);
      const backup = `${f.file}.${kind}-${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}`;
      for (let i = 0; i < 2; i++) {
        try {
          writeFoundryState(f.root, { status: "verified", attemptCount: 1 });
          throw new Error("write unexpectedly succeeded");
        } catch (error) {
          expect(error).toMatchObject({
            name: "FoundryStateError",
            kind,
            path: f.file,
            preservedPath: backup,
          });
        }
        expect(loadFoundryState(f.root).kind).toBe(kind);
        expect(readFileSync(f.file)).toEqual(bytes);
        expect(readFileSync(backup)).toEqual(bytes);
      }
      const filenames = readdirSync(path.dirname(f.file));
      expect(new Set(filenames)).toEqual(new Set([path.basename(f.file), path.basename(backup)]));
    },
  );

  it("never lowers attemptCount and records identity and attempt lifecycle without launching", () => {
    const f = fixture();
    writeFoundryState(f.root, { attemptCount: 6, status: "worker_failed" });
    expect(writeFoundryState(f.root, { attemptCount: 2 }).attemptCount).toBe(6);
    const launch = createFoundryAttempt(readFoundryState(f.root), {
      intent: "repair",
      route: { engine: "codex", model: "test", effort: "high" },
      now: "2026-11-09T00:00:00Z",
    });
    expect(launch).toMatchObject({
      attemptCount: 7,
      attempt: {
        number: 7,
        intent: "repair",
        status: "launching",
        endedAt: null,
        launcher: { pid: process.pid },
        route: { engine: "codex", model: "test", effort: "high" },
      },
    });
    const identity = processIdentity();
    expect(typeof identity).toBe("string");
    expect(processIdentity()).toBe(identity);
    expect(launch.attempt.launcher.processIdentity).toBe(identity);
    const state = writeFoundryState(f.root, launch);
    const running = writeFoundryState(f.root, updateFoundryAttempt(state, { status: "running" }));
    expect(running.attempt).toMatchObject({
      id: launch.attempt.id,
      status: "running",
      endedAt: null,
    });
    const failed = writeFoundryState(
      f.root,
      updateFoundryAttempt(running, {
        status: "uncertain",
        error: "lost result",
        now: "2026-11-09T01:00:00Z",
      }),
    );
    expect(failed).toMatchObject({
      attemptCount: 7,
      attempt: { status: "uncertain", error: "lost result", endedAt: "2026-11-09T01:00:00Z" },
    });
  });

  it("uses a stable live process identity and does not retain it after that process exits", async () => {
    const child = spawn(process.execPath, ["-e", "process.stdin.resume(); console.log('ready');"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    const closed = new Promise((resolve) => child.once("close", resolve));
    try {
      expect((await lines.next()).value).toBe("ready");
      const identity = processIdentity(child.pid);
      const attemptState = createFoundryAttempt(null, { pid: child.pid });
      expect(foundryLauncherAlive(attemptState)).toBe(true);
      expect(typeof identity).toBe("string");
      expect(identity.length).toBeGreaterThan(0);
      expect(processIdentity(child.pid)).toBe(identity);
      child.stdin.end();
      expect(await closed).toBe(0);
      expect(processIdentity(child.pid)).not.toBe(identity);
      expect(foundryLauncherAlive(attemptState)).toBe(false);
      const originalPath = process.env.PATH;
      try {
        process.env.PATH = fixture().root; // No ps: absence cannot be distinguished from an unavailable identity.
        expect(foundryLauncherAlive(attemptState)).toBe(true);
      } finally {
        process.env.PATH = originalPath;
      }
    } finally {
      child.stdin.end();
      await closed;
    }
  });

  it("a concurrent real reader observes only complete atomic states", async ({ signal }) => {
    // Every writeFoundryState call reads and writes through Python, so the wall
    // budget is explicit and failures name the phase that stalled instead of timing out silently.
    const generations = 100;
    const gate = 50;
    const budgetMs = 60_000;
    const f = fixture();
    writeFileSync(f.file, JSON.stringify({ generation: 0, payload: "0".repeat(100_000) }));
    const began = performance.now();
    const elapsed = () => Math.round(performance.now() - began);
    const writer = fork(
      new URL("../../helpers/foundry-state-writer.mjs", import.meta.url),
      [f.root, String(generations), String(gate), String(budgetMs / 2)],
      {
        detached: true,
        env: {
          ...process.env,
          ORK_FOUNDRY_TEST_TRACE: f.root,
          PYTHONPATH: fileURLToPath(new URL("../../helpers/foundry-trace", import.meta.url)),
        },
        execArgv: [],
        stdio: ["ignore", "ignore", "inherit", "ipc"],
      },
    );
    const closed = new Promise((resolve) => writer.once("close", resolve));
    let childError;
    const phases = []; // every IPC phase report from the writer
    let last = { phase: "none (no IPC message received: writer startup or IPC channel)" };
    let reads = 0;
    let highestObserved = -1;
    writer.on("error", (error) => {
      childError = error;
    });
    writer.on("message", (message) => {
      last = { ...message, receivedAt: elapsed() };
      phases.push(last);
      if (phases.length > 20) phases.splice(1, 1); // keep the first and the latest entries
    });
    // Bounded snapshot (command, state, CPU time) of the writer's process group: shows whether the
    // writer or its Python child is running, sleeping or blocked. Taken before the group is killed.
    let cachedSample;
    const sampleProcesses = () => {
      if (cachedSample) return cachedSample;
      try {
        const rows = execFileSync(
          "ps",
          ["-A", "-o", "pid=,ppid=,pgid=,stat=,etime=,time=,command="],
          {
            encoding: "utf8",
            timeout: 3000,
            maxBuffer: 4 * 1024 * 1024,
            stdio: ["ignore", "pipe", "ignore"],
          },
        )
          .split("\n")
          .filter((row) => row.trim().split(/\s+/u, 3)[2] === String(writer.pid))
          .slice(0, 10)
          .map((row) => row.trim().slice(0, 200));
        cachedSample = rows.length > 0 ? rows : ["(no live process in the writer's group)"];
      } catch (error) {
        cachedSample = [`(ps sample unavailable: ${error.code ?? error.message})`];
      }
      return cachedSample;
    };
    const pythonTrace = () =>
      ["read_state", "write_state"].flatMap((op) => {
        const file = path.join(f.root, `${op}.trace`);
        const stack = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
        return stack ? [`${op}: ${stack}`] : [];
      });
    const diagnostics = (why) =>
      `${why} after ${elapsed()}ms (budget ${budgetMs}ms): writer pid=${writer.pid} ` +
      `exit=${writer.exitCode}/${writer.signalCode}; reader reads=${reads} highestObserved=${highestObserved}; ` +
      `last writer phase=${JSON.stringify(last)}; recent phases=${JSON.stringify(phases)}; ` +
      `process sample [pid ppid pgid stat etime cputime command]=${JSON.stringify(sampleProcesses())}; Python stacks: ${pythonTrace().join("\n")}`;
    // Each write synchronously invokes Python. End the private POSIX process group together.
    const stopWriter = () => {
      if (signal.aborted) sampleProcesses();
      if (!writer.pid || writer.exitCode !== null || writer.signalCode !== null) return;
      try {
        process.kill(-writer.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    };
    signal.addEventListener("abort", stopWriter, { once: true });
    try {
      let hasObservedIntermediate = false;
      while (
        writer.pid &&
        writer.exitCode === null &&
        writer.signalCode === null &&
        !signal.aborted
      ) {
        if (childError) throw childError;
        if (elapsed() > budgetMs)
          throw new Error(diagnostics("concurrent reader exceeded its wall budget"));
        const state = JSON.parse(readFileSync(f.file, "utf8"));
        reads++;
        highestObserved = Math.max(highestObserved, state.generation);
        expect(state.payload).toBe(String(state.generation).repeat(100_000));
        if (!hasObservedIntermediate && state.generation > 0 && state.generation < generations) {
          hasObservedIntermediate = true;
          writer.send("observed");
        }
        // Pace the reader: a hot loop starves the writer's Python subprocesses on small CI runners.
        await sleep(2);
      }
      const code = await closed;
      if (childError) throw childError;
      if (code !== 0) throw new Error(diagnostics(`writer exited with code ${code}`));
      if (!hasObservedIntermediate)
        throw new Error(diagnostics("reader never saw an intermediate generation"));
      expect(JSON.parse(readFileSync(f.file, "utf8"))).toMatchObject({
        generation: generations,
        payload: String(generations).repeat(100_000),
      });
      expect(readdirSync(path.dirname(f.file))).toEqual(["foundry-state.json"]);
    } catch (error) {
      if (signal.aborted && !/phase=/u.test(String(error?.message))) {
        error.message += `\n${diagnostics("aborted by test timeout")}`;
      }
      throw error;
    } finally {
      stopWriter();
      signal.removeEventListener("abort", stopWriter);
      await closed;
    }
  });

  it.each([
    ["corrupt", '{"attemptCount":55,'],
    ["unsupported", '{"schema":"future","attemptCount":55}'],
  ])("Foundry keeps %s worktree paths reserved alongside healthy worktrees", (kind, bytes) => {
    const f = worktreeFixture();
    writeFileSync(f.file, bytes);
    writeFileSync(
      path.join(path.dirname(f.file), "task-spec.json"),
      JSON.stringify({ allow_paths: ["reserved/candidate"] }),
    );
    for (const [slug, status] of [
      ["healthy", "verified"],
      ["finished", "merged"],
    ]) {
      const worktree = path.join(f.root, slug);
      git(f.repo, "worktree", "add", "-b", slug, worktree, "main");
      const state = writeFoundryState(worktree, { status });
      const directory = path.dirname(resolveFoundryStatePath(worktree));
      writeFileSync(
        path.join(path.dirname(directory), "orkest.json"),
        JSON.stringify({ disposable: true, slug }),
      );
      writeFileSync(
        path.join(directory, "task-spec.json"),
        JSON.stringify({ allow_paths: [`reserved/${slug}`] }),
      );
      expect(state.status).toBe(status);
    }
    const paths = collectActiveWorktreeAllowPaths(f.repo);
    expect(paths).toHaveLength(2);
    expect(paths).toEqual(expect.arrayContaining([["reserved/candidate"], ["reserved/healthy"]]));
    expect(loadFoundryState(f.worktree).kind).toBe(kind);
    expect(readFileSync(f.file, "utf8")).toBe(bytes);
  });

  it.each([
    ["corrupt", '{"attemptCount":55,'],
    ["unsupported", '{"schema":"future","attemptCount":55}'],
  ])("Next reports state_unreadable when a failed smelt leaves %s state", async (kind, bytes) => {
    const f = worktreeFixture();
    git(f.worktree, "add", "tracked.txt");
    git(
      f.worktree,
      "-c",
      "user.name=Lease Test",
      "-c",
      "user.email=lease@example.invalid",
      "commit",
      "-m",
      "candidate",
    );
    writeFoundryState(f.worktree, {
      status: "verified",
      attemptCount: 7,
      allowPaths: ["tracked.txt"],
      verification: { candidate: { commit: git(f.worktree, "rev-parse", "HEAD") } },
    });
    const beforeHead = git(f.worktree, "rev-parse", "HEAD");
    const env = { ...process.env, ORCHESTRATE_HOME: path.join(f.root, "cache") };
    const previousExitCode = process.exitCode;
    try {
      const result = await nextCommand(["step", "--max-tier", "1", "--json"], {
        cwd: f.repo,
        env,
        stdout: sink,
        notifyFn() {},
        smeltWorktreeFn() {
          writeFileSync(f.file, bytes);
          throw new Error("smelt stopped");
        },
      });
      expect(result).toMatchObject({
        status: "state_unreadable",
        ok: false,
        exitCode: 4,
        execution: { status: "state_unreadable", error: "smelt stopped" },
      });
      expect(readNextLedger(f.repo, { env }).worktrees.candidate).toMatchObject({
        status: "state_unreadable",
        attemptCount: 7,
      });
    } finally {
      process.exitCode = previousExitCode;
    }
    expect(git(f.worktree, "rev-parse", "HEAD")).toBe(beforeHead);
    expect(git(f.repo, "branch", "--list", "candidate")).toContain("candidate");
    expect(loadFoundryState(f.worktree).kind).toBe(kind);
    expect(readFileSync(f.file, "utf8")).toBe(bytes);
  });

  it.each([
    ["corrupt", '{"attemptCount":55,'],
    ["unsupported", '{"schema":"future","attemptCount":55}'],
  ])(
    "Next and Smelter report and refuse %s state on a real dirty Git worktree",
    async (kind, bytes) => {
      const f = worktreeFixture();
      writeFileSync(f.file, bytes);
      const beforeHead = git(f.worktree, "rev-parse", "HEAD");
      const beforeStatus = git(f.worktree, "status", "--porcelain");
      expect(discoverManagedWorktrees(f.repo)).toMatchObject([
        { slug: "candidate", stateProblem: { kind } },
      ]);
      const evaluation = await evaluateNextCandidates({
        cwd: f.repo,
        approve: "candidate",
        includeGithub: false,
      });
      expect(evaluation.tier3).toMatchObject([{ kind: "state_unreadable", tier: 3 }]);
      expect([evaluation.tier0, evaluation.tier1, evaluation.tier2]).toEqual([[], [], []]);
      const env = { ...process.env, ORCHESTRATE_HOME: path.join(f.root, "cache") };
      const next = await nextCommand(["settle", "--json"], { cwd: f.repo, env, stdout: sink });
      expect(next).toMatchObject({ status: "noop", settledActions: [] });
      const previousExitCode = process.exitCode;
      try {
        const step = await nextCommand(["step", "--max-tier", "1", "--json"], {
          cwd: f.repo,
          env,
          stdout: sink,
          notifyFn() {},
        });
        expect(step).toMatchObject({
          status: "awaiting_human",
          executedAction: null,
          tier3Gates: [{ kind: "state_unreadable" }],
        });
      } finally {
        process.exitCode = previousExitCode;
      }
      expect(discoverSmeltableWorktrees(f.repo)).toMatchObject([
        { slug: "candidate", commitsAhead: 0, stateProblem: { kind } },
      ]);
      const status = await smelterCli(["status", "--json"], { cwd: f.repo, stdout: sink });
      expect(status.worktrees).toMatchObject([{ slug: "candidate", stateProblem: { kind } }]);
      const result = await smeltWorktree(f.worktree, { cwd: f.repo });
      expect(result).toMatchObject({
        ok: false,
        status: "state_unreadable",
        stateProblem: { kind },
      });
      const runExitCode = process.exitCode;
      let run;
      try {
        run = await smelterCli(["run", "--json", "--worktree", f.worktree], {
          cwd: f.repo,
          stdout: sink,
        });
      } finally {
        process.exitCode = runExitCode;
      }
      expect(run.results).toMatchObject([{ ok: false, status: "state_unreadable" }]);
      expect(git(f.worktree, "rev-parse", "HEAD")).toBe(beforeHead);
      expect(git(f.worktree, "status", "--porcelain")).toBe(beforeStatus);
      expect(readFileSync(f.file, "utf8")).toBe(bytes);
      expect(existsSync(f.worktree)).toBe(true);
      expect(git(f.repo, "branch", "--list", "candidate")).toContain("candidate");
    },
  );

  it("default writeFoundryState and loadFoundryState refuse symlinked orkest, symlinked .git, and broken gitdir backlink (#1)", () => {
    const f = worktreeFixture();
    const outside = path.join(f.root, "outside");
    mkdirSync(outside, { recursive: true });
    const orkestDir = path.dirname(f.file);
    rmSync(orkestDir, { recursive: true, force: true });
    symlinkSync(outside, orkestDir);

    expect(() => writeFoundryState(f.worktree, { status: "verified" })).toThrow(
      /invalid or a symlink/,
    );
    expect(existsSync(path.join(outside, "foundry-state.json"))).toBe(false);
    expect(loadFoundryState(f.worktree)).toMatchObject({
      kind: "corrupt",
      state: null,
    });

    // Replace symlink with real orkest dir, then break the adminDir gitdir backlink.
    rmSync(orkestDir, { recursive: true, force: true });
    mkdirSync(orkestDir, { recursive: true });
    const adminDir = path.dirname(orkestDir);
    const backlinkPath = path.join(adminDir, "gitdir");
    const realBacklink = readFileSync(backlinkPath, "utf8");
    const decoyDotGit = path.join(f.root, "decoy-dot-git");
    writeFileSync(decoyDotGit, "gitdir: /tmp/elsewhere\n");
    writeFileSync(backlinkPath, `${decoyDotGit}\n`);
    expect(() => writeFoundryState(f.worktree, { status: "verified" })).toThrow(/backlink/);
    writeFileSync(backlinkPath, realBacklink);

    // Symlinked .git entry in worktree is refused.
    const symlinkWt = path.join(f.root, "symlink-wt");
    mkdirSync(symlinkWt, { recursive: true });
    symlinkSync(adminDir, path.join(symlinkWt, ".git"));
    expect(() => writeFoundryState(symlinkWt, { status: "verified" })).toThrow(/symlink/);
  });

  it("default writeFoundryState refuses .git file pointing to unverified external directory (#3)", () => {
    const f = worktreeFixture();
    const emptyExternal = path.join(f.root, "empty-external-admin");
    mkdirSync(emptyExternal, { recursive: true });
    const rogueWt = path.join(f.root, "rogue-empty-wt");
    mkdirSync(rogueWt, { recursive: true });
    writeFileSync(path.join(rogueWt, ".git"), `gitdir: ${emptyExternal}\n`);

    expect(() => writeFoundryState(rogueWt, { status: "verified" })).toThrow(
      /git rev-parse --git-dir failed/,
    );
    expect(existsSync(path.join(emptyExternal, "orkest", "foundry-state.json"))).toBe(false);

    // Even with forged HEAD + commondir + gitdir backlink, an unregistered worktree is refused.
    const fakeAdmin = path.join(f.root, "forged-external-admin");
    mkdirSync(fakeAdmin, { recursive: true });
    const forgedWt = path.join(f.root, "forged-wt");
    mkdirSync(forgedWt, { recursive: true });
    const forgedDotGit = path.join(forgedWt, ".git");
    writeFileSync(forgedDotGit, `gitdir: ${fakeAdmin}\n`);
    writeFileSync(path.join(fakeAdmin, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(path.join(fakeAdmin, "commondir"), `${path.join(f.repo, ".git")}\n`);
    writeFileSync(path.join(fakeAdmin, "gitdir"), `${forgedDotGit}\n`);

    expect(() => writeFoundryState(forgedWt, { status: "verified" })).toThrow(
      /not a registered Git worktree/,
    );
    expect(existsSync(path.join(fakeAdmin, "orkest", "foundry-state.json"))).toBe(false);
  });
});

const OPEN_PR = {
  number: 231,
  url: "https://github.com/example/widgets/pull/231",
  state: "OPEN",
  repository: "example/widgets",
  baseBranch: "main",
  headBranch: "ork/feature",
  headOid: "a".repeat(40),
  createdAt: "2026-11-19T10:00:00Z",
  updatedAt: "2026-11-19T10:00:00Z",
};

// Stands in for 4C's emitChiefEvents: records exactly what the single writer hands to shared delivery.
function recorder() {
  const events = [];
  const calls = [];
  return {
    events,
    calls,
    emitEvents: (batch, options) => {
      calls.push(options);
      events.push(...batch);
    },
  };
}

describe("Foundry state pr record", () => {
  it("validates the frozen shape, keeps unknown fields and leaves old records untouched", () => {
    const f = worktreeFixture();
    const first = writeFoundryState(f.worktree, { status: "verified", custom: { keep: true } });
    const before = readFileSync(f.file, "utf8");
    expect(first.pr).toBeUndefined();
    expect(Object.hasOwn(JSON.parse(before), "pr")).toBe(false);

    const withPr = writeFoundryState(f.worktree, { pr: { ...OPEN_PR, extra: "kept" } });
    expect(withPr.custom).toEqual({ keep: true });
    expect(readFoundryState(f.worktree).pr).toMatchObject({ number: 231, extra: "kept" });

    // Later writers that never mention pr must not drop or rewrite it.
    writeFoundryState(f.worktree, { status: "worker_failed" });
    expect(readFoundryState(f.worktree).pr).toMatchObject({ number: 231, state: "OPEN" });

    const unknownMetadata = normalizeFoundryPr({ number: 7, state: "UNKNOWN" });
    expect(unknownMetadata).toMatchObject({ url: null, headOid: null, createdAt: null });
    for (const bad of [
      null,
      [],
      { ...OPEN_PR, number: 0 },
      { ...OPEN_PR, number: 1.5 },
      { ...OPEN_PR, state: "open" },
      { ...OPEN_PR, url: "ftp://example.com/1" },
      { ...OPEN_PR, createdAt: "yesterday" },
      { ...OPEN_PR, headOid: "" },
    ]) {
      expect(() => writeFoundryState(f.worktree, { pr: bad })).toThrow(/Invalid Foundry pr state/u);
    }
    expect(readFoundryState(f.worktree).pr.number).toBe(231);
  });

  it("derives opened/merged transitions once, never inventing an open for a first MERGED", () => {
    expect(foundryPrTransitions(undefined, OPEN_PR)).toEqual(["pr_opened"]);
    expect(foundryPrTransitions(OPEN_PR, { ...OPEN_PR })).toEqual([]);
    expect(foundryPrTransitions(OPEN_PR, { ...OPEN_PR, state: "MERGED" })).toEqual(["pr_merged"]);
    expect(foundryPrTransitions(undefined, { ...OPEN_PR, state: "MERGED" })).toEqual(["pr_merged"]);
    expect(
      foundryPrTransitions({ ...OPEN_PR, state: "MERGED" }, { ...OPEN_PR, state: "MERGED" }),
    ).toEqual([]);
    expect(foundryPrTransitions(OPEN_PR, { ...OPEN_PR, state: "CLOSED" })).toEqual([]);
    expect(foundryPrTransitions({ ...OPEN_PR, state: "UNKNOWN" }, OPEN_PR)).toEqual(["pr_opened"]);
  });

  it("emits at the single pinned writer, after the commit, only for a proven room", () => {
    const f = worktreeFixture();
    const bridge = recorder();
    const options = { emitEvents: bridge.emitEvents, owningRoomId: "room-a" };

    writeFoundryState(f.worktree, { status: "verified" }, options);
    expect(bridge.events).toEqual([]); // no pr metadata: nothing by itself

    writeFoundryState(f.worktree, { pr: OPEN_PR }, options);
    expect(bridge.events).toHaveLength(1);
    expect(bridge.events[0]).toMatchObject({ event: "pr_opened", roomId: "room-a", prNumber: 231 });
    expect(bridge.events[0].key).toMatch(/^[0-9a-f]{64}$/u);
    expect(bridge.events[0]).not.toHaveProperty("id");
    expect(JSON.stringify(bridge.events[0])).not.toContain(f.worktree);

    // The same GitHub answer observed again, or by a restarted process, emits nothing.
    writeFoundryState(
      f.worktree,
      { pr: { ...OPEN_PR, updatedAt: "2026-11-19T11:00:00Z" } },
      options,
    );
    expect(bridge.events).toHaveLength(1);

    writeFoundryState(f.worktree, { pr: { ...OPEN_PR, state: "MERGED" } }, options);
    expect(bridge.events.map((event) => event.event)).toEqual(["pr_opened", "pr_merged"]);
    writeFoundryState(f.worktree, { pr: { ...OPEN_PR, state: "MERGED" } }, options);
    expect(bridge.events).toHaveLength(2);
    expect(bridge.events[0].key).not.toBe(bridge.events[1].key);

    // A different record for the same PR identity gets the same deterministic id.
    const other = worktreeFixture();
    const again = recorder();
    writeFoundryState(
      other.worktree,
      { pr: OPEN_PR },
      { emitEvents: again.emitEvents, owningRoomId: "room-b" },
    );
    expect(again.events[0].key).toBe(bridge.events[0].key);

    // No proven room, a rejected write and a throwing bridge never emit or change the outcome.
    const standalone = worktreeFixture();
    const quiet = recorder();
    writeFoundryState(standalone.worktree, { pr: OPEN_PR }, { emitEvents: quiet.emitEvents });
    expect(() =>
      writeFoundryState(
        standalone.worktree,
        { pr: { ...OPEN_PR, number: -1 } },
        { emitEvents: quiet.emitEvents, owningRoomId: "room-a" },
      ),
    ).toThrow();
    expect(quiet.events).toEqual([]);
    const angry = () => {
      throw new Error("transport down");
    };
    const saved = writeFoundryState(
      standalone.worktree,
      { pr: { ...OPEN_PR, state: "MERGED" } },
      { emitEvents: angry, owningRoomId: "room-a" },
    );
    expect(saved.pr.state).toBe("MERGED");
  });
});

function foundryRepo({ config } = {}) {
  const created = mkdtempSync(path.join(tmpdir(), "orkest-foundry-prep-"));
  const root = realpathSync(created);
  const repo = path.join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Foundry Prep");
  git(repo, "config", "user.email", "prep@example.invalid");
  writeFileSync(path.join(repo, "change.txt"), "base\n");
  writeFileSync(path.join(repo, ".env"), "LOCAL=1\n");
  git(repo, "add", "change.txt");
  git(repo, "commit", "-m", "base");
  if (config !== undefined) {
    mkdirSync(path.join(repo, ".orkest"));
    writeFileSync(path.join(repo, ".orkest", "worktree.json"), JSON.stringify(config));
  }
  return { root, repo, env: { ...process.env, ORCHESTRATE_HOME: path.join(root, "cache") } };
}

function foundryOptions(f, extra = {}) {
  const now = Date.now();
  const task = {
    schema: "agent-executor.task-spec.v1",
    objective: "Prepare",
    allow_paths: ["change.txt"],
    development_checks: ["true"],
  };
  return {
    cwd: f.repo,
    env: f.env,
    stdout: { write() {} },
    execGhFn: async () => [
      {
        number: 301,
        title: "Prepare worktree",
        labels: [{ name: "agent:ready" }],
        body: `\`\`\`json task-spec\n${JSON.stringify(task)}\n\`\`\``,
      },
    ],
    getAccountsFn: async () => [
      {
        fetchedAt: now,
        id: "codex-test",
        label: "Codex",
        ok: true,
        provider: "codex",
        route: "--engine codex",
        pools: [{ families: ["gpt"], id: "codex", label: "Codex", windowIds: ["week"] }],
        windows: [
          {
            id: "week",
            label: "Weekly",
            remainingPct: 85,
            resetsAt: now + 3 * 24 * 3600 * 1000,
            windowMins: 10_080,
          },
        ],
      },
    ],
    ...extra,
  };
}

describe("Foundry disposable worktree preparation", () => {
  it("prepares the real created worktree under its lease and launches the harness with port env", async () => {
    const f = foundryRepo({ config: { version: 1, ports: { names: ["WEB_PORT", "API_PORT"] } } });
    const seen = path.join(f.root, "harness-env.json");
    const order = [];
    let leaseBusyDuringPrepare = null;
    const result = await foundryRun(["--json"], {
      ...foundryOptions(f),
      prepareWorktreeFn: async (repoRoot, worktreePath, options) => {
        order.push("prepare");
        leaseBusyDuringPrepare = !(await acquireWorkspaceLease(worktreePath, { env: f.env }))
          .acquired;
        const { prepareWorktree } = await import("../../../src/lib/worktree-provision.mjs");
        return prepareWorktree(repoRoot, worktreePath, options);
      },
      execAgentFn: async (_args, options) => {
        order.push("launch");
        // A real child process stands in for the harness and reports the env it was launched with.
        execFileSync(
          process.execPath,
          [
            "-e",
            `require("node:fs").writeFileSync(${JSON.stringify(seen)}, JSON.stringify({web: process.env.WEB_PORT, api: process.env.API_PORT, all: process.env.ORKEST_WORKTREE_PORTS, cwd: process.cwd()}))`,
          ],
          { cwd: options.cwd, env: options.env },
        );
        return { status: "completed" };
      },
    });
    expect(order).toEqual(["prepare", "launch"]);
    expect(leaseBusyDuringPrepare).toBe(true);
    const worktreePath = result.worktreePath;
    expect(readFileSync(path.join(worktreePath, ".env"), "utf8")).toBe("LOCAL=1\n");

    const ports = listWorktreePorts({ repoRoot: f.repo, worktreePath, env: f.env });
    expect(ports.map((entry) => entry.name)).toEqual(["API_PORT", "WEB_PORT"]);
    const harness = JSON.parse(readFileSync(seen, "utf8"));
    expect(harness.web).toBe(String(ports.find((p) => p.name === "WEB_PORT").port));
    expect(harness.api).toBe(String(ports.find((p) => p.name === "API_PORT").port));
    expect(JSON.parse(harness.all)).toEqual({
      API_PORT: ports[0].port,
      WEB_PORT: ports[1].port,
    });
    expect(realpathSync(harness.cwd)).toBe(realpathSync(worktreePath));
  });

  it("keeps a worktree whose preparation failed and resumes it on retry without duplicate effects", async () => {
    const f = foundryRepo({ config: { version: 1, surprise: 1 } });
    let launches = 0;
    const options = foundryOptions(f, {
      execAgentFn: async () => {
        launches += 1;
        return { status: "completed" };
      },
    });
    const worktrees = () => {
      const listed = git(f.repo, "worktree", "list", "--porcelain");
      return listed.split("\n").filter((line) => line.startsWith("worktree ")).length;
    };

    let thrown;
    try {
      await foundryRun(["--json"], options);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ stage: "bootstrap", substage: "config" });
    expect(launches).toBe(0);
    expect(worktrees()).toBe(2);
    const cacheWorktrees = path.join(f.env.ORCHESTRATE_HOME, "worktrees", "repo");
    const [slug] = readdirSync(cacheWorktrees);
    expect(loadFoundryState(path.join(cacheWorktrees, slug)).kind).toBe("missing");

    // Fix the config; the same worktree is resumed rather than rejected or duplicated.
    writeFileSync(
      path.join(f.repo, ".orkest", "worktree.json"),
      JSON.stringify({ version: 1, ports: { names: ["WEB_PORT"] } }),
    );
    const retry = await foundryRun(["--json"], options);
    expect(retry.worktreePath).toBe(path.join(cacheWorktrees, slug));
    expect(launches).toBe(1);
    expect(worktrees()).toBe(2);
    expect(readdirSync(cacheWorktrees)).toEqual([slug]);
    expect(
      listWorktreePorts({ repoRoot: f.repo, worktreePath: retry.worktreePath, env: f.env }),
    ).toHaveLength(1);
  });
});
