import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";

import {
  collectActiveWorktreeAllowPaths,
  createFoundryAttempt,
  foundryLauncherAlive,
  FoundryStateError,
  loadFoundryState,
  processIdentity,
  readFoundryState,
  resolveFoundryStatePath,
  updateFoundryAttempt,
  writeFoundryState,
} from "../../../plugins/orchestrate/lib/foundry.mjs";
import {
  discoverManagedWorktrees,
  evaluateNextCandidates,
  nextCommand,
  readNextLedger,
} from "../../../plugins/orchestrate/lib/next.mjs";
import {
  discoverSmeltableWorktrees,
  smelterCli,
  smeltWorktree,
} from "../../../plugins/orchestrate/lib/smelter.mjs";

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "orkest-state-"));
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
  const root = mkdtempSync(path.join(tmpdir(), "orkest-state-git-"));
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

  it("a concurrent real reader observes only complete atomic states", async () => {
    const f = fixture();
    writeFoundryState(f.root, { generation: 0, payload: "0".repeat(100_000) });
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
import {readFileSync} from 'node:fs';
let reading=true, count=0; const errors=[];
process.stdin.resume();
process.stdin.on('end',()=>{reading=false;});
console.log(JSON.stringify({status:'ready'}));
function read() {
  try { const state=JSON.parse(readFileSync(process.argv[1],'utf8')); if(state.payload!==String(state.generation).repeat(100000)) errors.push('mixed state'); count++; }
  catch(error) { errors.push(error.message); }
  if(reading) setImmediate(read); else console.log(JSON.stringify({count, errors, generation:JSON.parse(readFileSync(process.argv[1],'utf8')).generation}));
}
read();
`,
        f.file,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    const closed = new Promise((resolve) => child.once("close", resolve));
    try {
      expect(JSON.parse((await lines.next()).value)).toEqual({ status: "ready" });
      for (let i = 1; i <= 100; i++)
        writeFoundryState(f.root, { generation: i, payload: String(i).repeat(100_000) });
      child.stdin.end();
      const result = JSON.parse((await lines.next()).value);
      expect(result).toMatchObject({ errors: [], generation: 100 });
      expect(result.count).toBeGreaterThan(1);
    } finally {
      child.stdin.end();
      await closed;
    }
    expect(readdirSync(path.dirname(f.file))).toEqual(["foundry-state.json"]);
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
});
