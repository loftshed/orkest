import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { roomsCommand } from "../../../plugins/orchestrate/bin/rooms.mjs";
import { parseTeam, readRoom, updateRoom } from "../../../plugins/orchestrate/lib/horde-room.mjs";
import { integrateMemberWorktree } from "../../../plugins/orchestrate/lib/room-integrate.mjs";
import { newRoom } from "../../../plugins/orchestrate/lib/rooms.mjs";
import { discoverSmeltableWorktrees } from "../../../plugins/orchestrate/lib/smelter.mjs";
import { provisionWorktree } from "../../../plugins/orchestrate/lib/worktree-provision.mjs";
import { retainFixtures } from "../../helpers/retain-fixtures.js";

const directories = [];
const memberId = "luna-1";
const message = "feat(room): integrate accepted result";
const allowedPaths = ["allowed"];
const verificationCommands = ["node --version", "git --version"];

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function testExec(command, args, options = {}) {
  try {
    return {
      status: 0,
      stdout: execFileSync(command, args, { ...options, encoding: "utf8" }),
      stderr: "",
    };
  } catch (error) {
    return {
      status: error.status ?? 1,
      stdout: error.stdout?.toString() ?? "",
      stderr: error.stderr?.toString() || error.message,
    };
  }
}

async function directory() {
  const created = await mkdtemp(path.join(tmpdir(), "ork-room-integrate-"));
  const result = await realpath(created);
  directories.push(result);
  return result;
}

async function repository(branch = "main") {
  const repo = await directory();
  execFileSync("git", ["init", "-b", branch], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Room Integrate Tests"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "room-integrate@example.invalid"], { cwd: repo });
  await mkdir(path.join(repo, "allowed"));
  await writeFile(path.join(repo, "allowed", "base.txt"), "base\n");
  execFileSync("git", ["add", "allowed/base.txt"], { cwd: repo });
  execFileSync("git", ["commit", "-m", "test: create room repo"], {
    cwd: repo,
    stdio: "ignore",
  });
  return repo;
}

async function fixture({
  decision = "accept",
  stale = false,
  clean = false,
  noWorktree = false,
  branch = "main",
} = {}) {
  const repo = await repository(branch);
  const root = await directory();
  const taskDir = await directory();
  const room = await newRoom(parseTeam("codex:luna:max"), {
    id: "room-integrate",
    cwd: repo,
    root,
  });
  const worktree = noWorktree
    ? null
    : provisionWorktree(repo, { slug: memberId, branch: "ork/room-luna-1" });
  const checkout = worktree?.path || repo;
  if (!clean && worktree) {
    await writeFile(path.join(worktree.path, "allowed", "change.txt"), "accepted change\n");
  }

  const resultPath = path.join(taskDir, "result.json");
  const result = {
    schema: "agent-executor.result.v1",
    status: "completed",
    engine: "codex",
    model: "gpt-test-model",
    repository: checkout,
    objective: "Implement the accepted room task",
    allowed_paths: [...allowedPaths],
    verification_commands: [...verificationCommands],
    run_delta: { changed_paths: clean || noWorktree ? [] : ["allowed/change.txt"] },
    verification: { status: "passed", commands: [...verificationCommands] },
    git_after: { fingerprint: "accepted-result-fingerprint" },
    git_identity_after: { identity: "recorded" },
  };
  const resultBytes = `${JSON.stringify(result)}\n`;
  await writeFile(resultPath, resultBytes);

  const requestId = "request-1";
  const taskId = "task-1";
  const runId = "run-1";
  const task = {
    schema: "agent-executor.task.v1",
    task_id: taskId,
    repository: checkout,
    task_spec: { objective: result.objective },
    runs: [
      {
        run_id: runId,
        request_id: requestId,
        engine: "codex",
        model: result.model,
        transport: "executor",
        status: "finished",
        runner_status: "completed",
        result_path: resultPath,
        result_sha256: stale
          ? "0".repeat(64)
          : createHash("sha256").update(resultBytes).digest("hex"),
        task_spec: { objective: result.objective },
      },
    ],
    decisions:
      decision === "pending" ? [] : [{ run_id: runId, decision, at: "2026-11-10T00:00:00.000Z" }],
    updated_at: "2026-11-10T00:00:00.000Z",
  };
  const run = async (args) => {
    if (args[0] !== "show") throw new Error(`Unexpected coordinator command: ${args.join(" ")}`);
    return structuredClone(task);
  };

  if (worktree) {
    await updateRoom(
      room.id,
      (current) => {
        const member = current.agents.find((agent) => agent.id === memberId);
        member.cwd = worktree.path;
        member.worktree = { ...worktree, disposable: true };
        member.dispatch = {
          taskDir,
          taskId,
          requestId,
          runId,
          transport: "executor",
        };
        return current;
      },
      { root },
    );
  } else {
    await updateRoom(
      room.id,
      (current) => {
        const member = current.agents.find((agent) => agent.id === memberId);
        member.dispatch = { taskDir, taskId, requestId, runId, transport: "executor" };
        return current;
      },
      { root },
    );
  }

  return { repo, root, taskDir, room, worktree, checkout, result, run };
}

async function captureState({ repo, root, room, checkout }) {
  const captureGitState = async (cwd) => {
    const indexPath = git(cwd, "rev-parse", "--git-path", "index");
    const absoluteIndexPath = path.isAbsolute(indexPath) ? indexPath : path.resolve(cwd, indexPath);
    const untracked = git(cwd, "ls-files", "--others", "--exclude-standard", "-z")
      .split("\0")
      .filter(Boolean);
    return {
      head: git(cwd, "rev-parse", "HEAD"),
      index: await readFile(absoluteIndexPath),
      status: git(cwd, "status", "--porcelain=v1", "--untracked-files=all"),
      diff: git(cwd, "diff", "--binary", "HEAD"),
      untracked: (
        await Promise.all(
          untracked.map(async (filePath) => {
            const absolutePath = path.join(cwd, filePath);
            if (!(await stat(absolutePath)).isFile()) return null;
            return [filePath, await readFile(absolutePath)];
          }),
        )
      ).filter(Boolean),
    };
  };
  return {
    checkout: await captureGitState(checkout),
    repo: checkout === repo ? null : await captureGitState(repo),
    room: await readRoom(room.id, root),
  };
}

async function expectRefusalUnchanged(f, expectedError, options = {}) {
  const before = await captureState(f);
  await expect(
    integrateMemberWorktree(f.room.id, memberId, {
      root: f.root,
      run: f.run,
      exec: options.exec || testExec,
      message: options.message ?? message,
      target: options.target,
    }),
  ).rejects.toThrow(expectedError);
  expect(await captureState(f)).toEqual(before);
}

afterEach(async () => {
  await retainFixtures(directories.splice(0));
});

describe("ork hall integrate", () => {
  it("commits an accepted result and registers it with the smelter", async () => {
    const f = await fixture();
    const repositoryBefore = (await captureState(f)).repo;
    let output = "";
    const result = await roomsCommand(
      ["integrate", "--room", f.room.id, "--member", memberId, "--message", message],
      {
        root: f.root,
        run: f.run,
        exec: testExec,
        stdout: { write: (value) => (output += value) },
      },
    );
    expect(JSON.parse(output)).toMatchObject({ integration: result.integration });
    expect(result.integration).toMatchObject({ message });
    expect(git(f.worktree.path, "rev-list", "--count", "main..HEAD")).toBe("1");
    expect(git(f.worktree.path, "status", "--porcelain")).toBe("");
    expect(git(f.repo, "rev-parse", "HEAD")).toBe(repositoryBefore.head);
    expect((await captureState(f)).repo).toEqual(repositoryBefore);
    expect((await readRoom(f.room.id, f.root)).agents[0].integration).toEqual(result.integration);
    const discovered = discoverSmeltableWorktrees(f.repo);
    const worktreePath = await realpath(f.worktree.path);
    const discoveredWorktree = discovered.find((item) => item.path === worktreePath);
    expect(discoveredWorktree).toMatchObject({
      allowPaths: allowedPaths,
      branch: "ork/room-luna-1",
      engine: "codex",
      verifyCommand: verificationCommands.join(" && "),
      foundryState: { status: "verified" },
      taskSpec: { engine: "codex", model: "gpt-test-model" },
    });
    await expectRefusalUnchanged(f, "already integrated");
  });

  it("refuses pending, rejected, and stale room evidence without mutation", async () => {
    await expectRefusalUnchanged(await fixture({ decision: "pending" }), "accepted result");
    await expectRefusalUnchanged(await fixture({ decision: "reject" }), "accepted result");
    await expectRefusalUnchanged(await fixture({ stale: true }), "evidence is stale");
  });

  it("refuses members without a worktree or with a clean worktree without mutation", async () => {
    await expectRefusalUnchanged(await fixture({ noWorktree: true }), "no recorded room worktree");
    await expectRefusalUnchanged(await fixture({ clean: true }), "worktree is clean");
  });

  it("refuses a bad subject and changes outside the accepted scope without mutation", async () => {
    await expectRefusalUnchanged(await fixture(), "conventional commit subject", {
      message: "integrate this",
    });
    const f = await fixture();
    await writeFile(path.join(f.worktree.path, "outside.txt"), "out of scope\n");
    await expectRefusalUnchanged(f, "outside accepted allowed_paths");
  });

  it("refuses a missing Git identity before staging", async () => {
    const f = await fixture();
    execFileSync("git", ["config", "--unset", "user.name"], { cwd: f.repo });
    execFileSync("git", ["config", "--unset", "user.email"], { cwd: f.repo });
    const isolatedExec = (command, args, options = {}) =>
      testExec(command, args, {
        ...options,
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: path.join(f.root, "missing-global-gitconfig"),
          GIT_CONFIG_NOSYSTEM: "1",
          // Without this Git guesses an identity from the user and host name where it can (macOS),
          // so "no identity configured" would not be refused there.
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "user.useConfigOnly",
          GIT_CONFIG_VALUE_0: "true",
          GIT_AUTHOR_NAME: "",
          GIT_AUTHOR_EMAIL: "",
          GIT_COMMITTER_NAME: "",
          GIT_COMMITTER_EMAIL: "",
        },
      });
    await expectRefusalUnchanged(f, "identity must be configured", { exec: isolatedExec });
  });

  it("restores the original index if Git refuses the commit", async () => {
    const f = await fixture();
    const failCommit = (command, args, options = {}) => {
      if (args[0] === "commit") return { status: 1, stdout: "", stderr: "commit hook refused" };
      return testExec(command, args, options);
    };
    await expectRefusalUnchanged(f, "commit hook refused", { exec: failCommit });
  });
  const integrate = (f, extra = []) =>
    roomsCommand(
      [
        "integrate",
        "--room",
        f.room.id,
        "--member",
        memberId,
        "--message",
        "feat(room): accepted change",
        ...extra,
      ],
      { root: f.root, run: f.run, exec: testExec, stdout: { write: () => {} } },
    );

  it("targets the branch the room checkout is on, not a fixed name", async () => {
    const f = await fixture({ branch: "develop" });
    const result = await integrate(f);
    expect(result.targetBranch).toBe("develop");
    expect(result.foundryState.targetBranch).toBe("develop");
    expect(git(f.worktree.path, "rev-list", "--count", "develop..HEAD")).toBe("1");
    const worktreePath = await realpath(f.worktree.path);
    const listed = (target) =>
      discoverSmeltableWorktrees(f.repo, { targetBranch: target }).some(
        (item) => item.path === worktreePath,
      );
    expect(listed("develop")).toBe(true);
    // No `main` exists here, and a run for another branch must not pick this worktree up.
    expect(listed("release")).toBe(false);
  });

  it("uses an explicit --target and refuses one that does not exist", async () => {
    const f = await fixture();
    execFileSync("git", ["branch", "release"], { cwd: f.repo });
    await expectRefusalUnchanged(f, "no-such-branch", { target: "no-such-branch" });
    const result = await integrate(f, ["--target", "release"]);
    expect(result.targetBranch).toBe("release");
  });

  it("puts the worktree back when queue metadata cannot be written after the commit", async () => {
    const f = await fixture();
    const before = await captureState(f);
    const head = git(f.worktree.path, "rev-parse", "HEAD");
    // A file where the task spec's directory must go makes the write fail after the commit.
    const gitDir = git(f.worktree.path, "rev-parse", "--absolute-git-dir");
    await writeFile(path.join(gitDir, "orkest"), "in the way\n");
    await expect(integrate(f)).rejects.toThrow();
    await rm(path.join(gitDir, "orkest"));
    expect(git(f.worktree.path, "rev-parse", "HEAD")).toBe(head);
    expect(await captureState(f)).toEqual(before);
    // Nothing is left behind, so the same command now succeeds.
    expect((await integrate(f)).integration.message).toBe("feat(room): accepted change");
  });
});
