import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { roomsCommand } from "../../../src/bin/rooms.mjs";
import { parseTeam, readRoom, updateRoom } from "../../../src/lib/horde-room.mjs";
import { integrateMemberWorktree } from "../../../src/lib/room-integrate.mjs";
import { newRoom } from "../../../src/lib/rooms.mjs";
import { discoverSmeltableWorktrees } from "../../../src/lib/smelter.mjs";
import { provisionWorktree } from "../../../src/lib/worktree-provision.mjs";
import { retainFixtures } from "../../helpers/retain-fixtures.js";

const directories = [];
const memberId = "luna-1";
const message = "feat(room): integrate accepted result";
const allowedPaths = ["allowed"];
const verificationCommands = ["node --version", "git --version"];
const scriptsDir = fileURLToPath(new URL("../../../src/py", import.meta.url));

function captureAcceptedSnapshot(checkout) {
  const script = [
    "import json, sys",
    "from pathlib import Path",
    "sys.path.insert(0, sys.argv[1])",
    "import run_agent as runner",
    "repo = Path(sys.argv[2])",
    'print(json.dumps({"git_after": runner.git_state(repo, []), "git_identity_after": runner.git_identity(repo)}))',
  ].join("\n");
  return JSON.parse(
    execFileSync("python3", ["-B", "-c", script, scriptsDir, checkout], { encoding: "utf8" }),
  );
}

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
  allowed = allowedPaths,
  reportedChangedPaths,
  commitCount = 0,
  useSymlink = false,
  setup,
} = {}) {
  const realRepo = await repository(branch);
  let repo = realRepo;
  if (useSymlink) {
    const symlinkRoot = await directory();
    repo = path.join(symlinkRoot, "repo-link");
    await symlink(realRepo, repo);
  }
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
  if (worktree && commitCount > 0) {
    for (let index = 1; index <= commitCount; index += 1) {
      const filePath = path.join(worktree.path, "allowed", `commit-${index}.txt`);
      await writeFile(filePath, `committed change ${index}\n`);
      execFileSync("git", ["add", `allowed/commit-${index}.txt`], { cwd: worktree.path });
      execFileSync("git", ["commit", "-m", `chore(worker): worker commit ${index}`], {
        cwd: worktree.path,
        stdio: "ignore",
      });
    }
  }
  if (!clean && worktree && commitCount === 0) {
    await writeFile(path.join(worktree.path, "allowed", "change.txt"), "accepted change\n");
  }
  if (setup) {
    await setup({ repo, realRepo, worktree, checkout });
  }

  const defaultReported = () => {
    if (noWorktree) return [];
    if (commitCount > 0) {
      return Array.from({ length: commitCount }, (_, index) => `allowed/commit-${index + 1}.txt`);
    }
    return clean ? [] : ["allowed/change.txt"];
  };
  const snapshot = captureAcceptedSnapshot(checkout);
  const resultPath = path.join(taskDir, "result.json");
  const result = {
    schema: "agent-executor.result.v1",
    status: "completed",
    engine: "codex",
    model: "gpt-test-model",
    repository: checkout,
    objective: "Implement the accepted room task",
    allowed_paths: [...allowed],
    verification_commands: [...verificationCommands],
    run_delta: { changed_paths: reportedChangedPaths ?? defaultReported() },
    verification: { status: "passed", commands: [...verificationCommands] },
    git_after: snapshot.git_after,
    git_identity_after: snapshot.git_identity_after,
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
  const taskPath = path.join(taskDir, "task.json");
  await writeFile(taskPath, `${JSON.stringify(task, null, 2)}\n`);
  const run = async (args) => {
    if (args[0] !== "show") throw new Error(`Unexpected coordinator command: ${args.join(" ")}`);
    return JSON.parse(await readFile(taskPath, "utf8"));
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

  return { repo, realRepo, root, taskDir, room, worktree, checkout, result, resultPath, task, run };
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
      if (args[0] === "commit" || args[0] === "commit-tree") {
        return { status: 1, stdout: "", stderr: "commit hook refused" };
      }
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

  function noIdentityExec(rootDir) {
    return (command, args, options = {}) =>
      testExec(command, args, {
        ...options,
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: path.join(rootDir, "missing-global-gitconfig"),
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "user.useConfigOnly",
          GIT_CONFIG_VALUE_0: "true",
          GIT_AUTHOR_NAME: "",
          GIT_AUTHOR_EMAIL: "",
          GIT_COMMITTER_NAME: "",
          GIT_COMMITTER_EMAIL: "",
        },
      });
  }

  it.each([1, 2])(
    "integrates a clean worktree %i-commit ahead without git identity or mutating commits",
    async (count) => {
      const f = await fixture({ clean: true, commitCount: count });
      execFileSync("git", ["config", "--unset", "user.name"], { cwd: f.repo });
      execFileSync("git", ["config", "--unset", "user.email"], { cwd: f.repo });
      const before = await captureState(f);
      const originalSubject = git(f.worktree.path, "log", "-1", "--format=%s");
      const originalParent = git(f.worktree.path, "rev-parse", "HEAD^");

      const result = await integrateMemberWorktree(f.room.id, memberId, {
        root: f.root,
        run: f.run,
        exec: noIdentityExec(f.root),
        message,
      });

      expect(result.integration).toEqual({
        integrationId: expect.any(String),
        commit: before.checkout.head,
        targetBranch: "main",
        targetOid: before.repo.head,
        taskSpecSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        message,
        at: expect.any(String),
      });
      expect(Object.hasOwn(result.integration, "commitSha")).toBe(false);
      expect(git(f.worktree.path, "rev-parse", "HEAD")).toBe(before.checkout.head);
      expect(git(f.worktree.path, "rev-parse", "HEAD^")).toBe(originalParent);
      expect(git(f.worktree.path, "log", "-1", "--format=%s")).toBe(originalSubject);
      expect((await captureState(f)).checkout.index).toEqual(before.checkout.index);
      expect((await captureState(f)).repo).toEqual(before.repo);
      expect(result.foundryState).toMatchObject({
        branch: "ork/room-luna-1",
        commitsAhead: count,
        headSha: before.checkout.head,
        status: "verified",
        targetBranch: "main",
        verifyCommand: verificationCommands.join(" && "),
      });
      const discovered = discoverSmeltableWorktrees(f.repo);
      const worktreePath = await realpath(f.worktree.path);
      expect(discovered.find((item) => item.path === worktreePath)).toMatchObject({
        branch: "ork/room-luna-1",
        commitsAhead: count,
        foundryState: { status: "verified", headSha: before.checkout.head },
      });
    },
  );

  it("integrates clean-ahead when target advances independently and refuses behind-only or unrelated history", async () => {
    const aheadDiverged = await fixture({ clean: true, commitCount: 1 });
    await writeFile(path.join(aheadDiverged.repo, "allowed", "target-advance.txt"), "target\n");
    execFileSync("git", ["add", "allowed/target-advance.txt"], { cwd: aheadDiverged.repo });
    execFileSync("git", ["commit", "-m", "chore: advance target"], {
      cwd: aheadDiverged.repo,
      stdio: "ignore",
    });
    const aheadResult = await integrate(aheadDiverged);
    expect(aheadResult.foundryState.commitsAhead).toBe(1);

    const behind = await fixture({ clean: true, commitCount: 0 });
    await writeFile(path.join(behind.repo, "allowed", "target-advance.txt"), "target\n");
    execFileSync("git", ["add", "allowed/target-advance.txt"], { cwd: behind.repo });
    execFileSync("git", ["commit", "-m", "chore: advance target"], {
      cwd: behind.repo,
      stdio: "ignore",
    });
    await expectRefusalUnchanged(behind, "worktree is clean");

    const unrelated = await fixture({ clean: true, commitCount: 0 });
    execFileSync("git", ["checkout", "--orphan", "ork/orphan"], {
      cwd: unrelated.worktree.path,
      stdio: "ignore",
    });
    execFileSync("git", ["rm", "-rf", "."], { cwd: unrelated.worktree.path, stdio: "ignore" });
    await mkdir(path.join(unrelated.worktree.path, "allowed"), { recursive: true });
    await writeFile(path.join(unrelated.worktree.path, "allowed", "orphan.txt"), "orphan\n");
    execFileSync("git", ["add", "allowed/orphan.txt"], { cwd: unrelated.worktree.path });
    execFileSync("git", ["commit", "-m", "chore: orphan commit"], {
      cwd: unrelated.worktree.path,
      stdio: "ignore",
    });
    execFileSync("git", ["branch", "-f", "ork/room-luna-1", "HEAD"], {
      cwd: unrelated.worktree.path,
    });
    execFileSync("git", ["checkout", "-q", "ork/room-luna-1"], { cwd: unrelated.worktree.path });
    await expectRefusalUnchanged(unrelated, "unrelated history");
  });

  it("enforces scope on committed paths, reported paths, renames, sibling prefixes, newlines, and traversal", async () => {
    const fHiddenCommit = await fixture({
      clean: true,
      commitCount: 0,
      reportedChangedPaths: [],
    });
    await writeFile(path.join(fHiddenCommit.worktree.path, "outside.txt"), "hidden\n");
    execFileSync("git", ["add", "outside.txt"], { cwd: fHiddenCommit.worktree.path });
    execFileSync("git", ["commit", "-m", "chore: out of scope"], {
      cwd: fHiddenCommit.worktree.path,
      stdio: "ignore",
    });
    await expectRefusalUnchanged(fHiddenCommit, "outside accepted allowed_paths");

    const fCleanBadReport = await fixture({
      clean: true,
      commitCount: 1,
      reportedChangedPaths: ["allowed/commit-1.txt", "outside/reported.txt"],
    });
    await expectRefusalUnchanged(fCleanBadReport, "outside accepted allowed_paths");

    const fRename = await fixture({ clean: true, commitCount: 0, reportedChangedPaths: [] });
    await writeFile(path.join(fRename.repo, "outside-old.txt"), "rename me\n");
    execFileSync("git", ["add", "outside-old.txt"], { cwd: fRename.repo });
    execFileSync("git", ["commit", "-m", "chore: seed outside on main"], {
      cwd: fRename.repo,
      stdio: "ignore",
    });
    execFileSync("git", ["reset", "--hard", "main"], {
      cwd: fRename.worktree.path,
      stdio: "ignore",
    });
    execFileSync("git", ["mv", "outside-old.txt", "allowed/moved.txt"], {
      cwd: fRename.worktree.path,
    });
    execFileSync("git", ["commit", "-m", "chore: move into allowed"], {
      cwd: fRename.worktree.path,
      stdio: "ignore",
    });
    await expectRefusalUnchanged(fRename, "outside accepted allowed_paths");

    const fPrefix = await fixture({ clean: true, commitCount: 0, reportedChangedPaths: [] });
    await mkdir(path.join(fPrefix.worktree.path, "allowed-other"));
    await writeFile(path.join(fPrefix.worktree.path, "allowed-other", "sibling.txt"), "sibling\n");
    execFileSync("git", ["add", "allowed-other/sibling.txt"], { cwd: fPrefix.worktree.path });
    execFileSync("git", ["commit", "-m", "chore: sibling prefix"], {
      cwd: fPrefix.worktree.path,
      stdio: "ignore",
    });
    await expectRefusalUnchanged(fPrefix, "outside accepted allowed_paths");

    const fNewline = await fixture({
      clean: true,
      commitCount: 0,
      reportedChangedPaths: [],
      setup: async ({ worktree }) => {
        await writeFile(path.join(worktree.path, "allowed", "line\nbreak.txt"), "nl\n");
        execFileSync("git", ["add", "allowed/line\nbreak.txt"], { cwd: worktree.path });
        execFileSync("git", ["commit", "-m", "chore: newline file"], {
          cwd: worktree.path,
          stdio: "ignore",
        });
      },
    });
    const newlineResult = await integrate(fNewline);
    expect(newlineResult.integration.commit).toBeTruthy();

    await expectRefusalUnchanged(
      await fixture({ allowed: ["../outside"] }),
      "no valid allowed_paths scope",
    );
    await expectRefusalUnchanged(
      await fixture({ allowed: ["allowed/.."] }),
      "no valid allowed_paths scope",
    );
    await expectRefusalUnchanged(
      await fixture({ clean: true, commitCount: 1, reportedChangedPaths: ["../outside.txt"] }),
      "outside accepted allowed_paths",
    );
    await expectRefusalUnchanged(
      await fixture({
        clean: true,
        commitCount: 1,
        reportedChangedPaths: ["allowed/../outside.txt"],
      }),
      "outside accepted allowed_paths",
    );
  });

  it("refuses escaping orkest/ symlinks, unmerged index, in-progress states, and pre-existing metadata", async () => {
    const fSymlink = await fixture({ clean: true, commitCount: 1 });
    const escapeTarget = await directory();
    const gitDirSymlink = git(fSymlink.worktree.path, "rev-parse", "--absolute-git-dir");
    await symlink(escapeTarget, path.join(gitDirSymlink, "orkest"));
    await expectRefusalUnchanged(fSymlink, "invalid or a symlink");
    expect(await readdir(escapeTarget)).toEqual([]);

    const fUnmerged = await fixture();
    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: fUnmerged.worktree.path,
      input: "conflict\n",
      encoding: "utf8",
    }).trim();
    execFileSync("git", ["update-index", "--index-info"], {
      cwd: fUnmerged.worktree.path,
      input: `100644 ${blob} 1\tallowed/conflict.txt\n100644 ${blob} 2\tallowed/conflict.txt\n`,
      encoding: "utf8",
    });
    await expectRefusalUnchanged(fUnmerged, "unmerged index entries");

    const fRebase = await fixture({ clean: true, commitCount: 1 });
    const gitDirRebase = git(fRebase.worktree.path, "rev-parse", "--absolute-git-dir");
    await mkdir(path.join(gitDirRebase, "rebase-merge"));
    await expectRefusalUnchanged(fRebase, "in-progress Git operation");

    const fPreExisting = await fixture({ clean: true, commitCount: 1 });
    const gitDirExisting = git(fPreExisting.worktree.path, "rev-parse", "--absolute-git-dir");
    await writeFile(path.join(gitDirExisting, "orkest.json"), '{"existing":true}\n');
    await expectRefusalUnchanged(fPreExisting, "already has Orkest merge-queue metadata");
    expect(await readFile(path.join(gitDirExisting, "orkest.json"), "utf8")).toBe(
      '{"existing":true}\n',
    );
  });

  it("rolls back cleanly on injected updateRoom failure for both dirty and clean-ahead worktrees", async () => {
    const fDirty = await fixture();
    const dirtyBefore = await captureState(fDirty);
    const dirtyGitDir = git(fDirty.worktree.path, "rev-parse", "--absolute-git-dir");
    await expect(
      integrateMemberWorktree(fDirty.room.id, memberId, {
        root: fDirty.root,
        run: fDirty.run,
        exec: testExec,
        message,
        updateRoom: async () => {
          throw new Error("injected updateRoom failure");
        },
      }),
    ).rejects.toThrow("injected updateRoom failure");
    expect(await captureState(fDirty)).toEqual(dirtyBefore);
    await expect(lstat(path.join(dirtyGitDir, "orkest.json"))).rejects.toThrow();
    await expect(lstat(path.join(dirtyGitDir, "orkest"))).rejects.toThrow();

    const fClean = await fixture({ clean: true, commitCount: 1 });
    const cleanBefore = await captureState(fClean);
    const cleanGitDir = git(fClean.worktree.path, "rev-parse", "--absolute-git-dir");
    await expect(
      integrateMemberWorktree(fClean.room.id, memberId, {
        root: fClean.root,
        run: fClean.run,
        exec: testExec,
        message,
        updateRoom: async () => {
          throw new Error("injected updateRoom failure");
        },
      }),
    ).rejects.toThrow("injected updateRoom failure");
    expect(await captureState(fClean)).toEqual(cleanBefore);
    await expect(lstat(path.join(cleanGitDir, "orkest.json"))).rejects.toThrow();
    await expect(lstat(path.join(cleanGitDir, "orkest"))).rejects.toThrow();
    const retried = await integrate(fClean);
    expect(retried.integration.commit).toBe(cleanBefore.checkout.head);
  });

  it("canonicalizes symlinked repository and worktree paths", async () => {
    const f = await fixture({ clean: true, commitCount: 1, useSymlink: true });
    const result = await integrate(f);
    expect(result.worktreePath).toBe(await realpath(f.worktree.path));
    expect(result.foundryState.status).toBe("verified");
  });

  it("refuses unreviewed edits after acceptance on both dirty and clean worktrees (#2)", async () => {
    const fDirty = await fixture();
    await writeFile(path.join(fDirty.worktree.path, "allowed", "change.txt"), "unreviewed edit\n");
    await expectRefusalUnchanged(fDirty, "no longer matches accepted result fingerprint");

    const fClean = await fixture({ clean: true, commitCount: 1 });
    await writeFile(path.join(fClean.worktree.path, "allowed", "extra.txt"), "unreviewed commit\n");
    execFileSync("git", ["add", "allowed/extra.txt"], { cwd: fClean.worktree.path });
    execFileSync("git", ["commit", "-m", "chore: unreviewed in-scope commit"], {
      cwd: fClean.worktree.path,
      stdio: "ignore",
    });
    await expectRefusalUnchanged(fClean, "no longer matches accepted git_identity_after.head");
  });

  it("refuses replacement dispatch mid-flight inside room update (#3)", async () => {
    const f = await fixture({ clean: true, commitCount: 1 });
    const before = await captureState(f);
    const gitDir = git(f.worktree.path, "rev-parse", "--absolute-git-dir");
    await expect(
      integrateMemberWorktree(f.room.id, memberId, {
        root: f.root,
        run: f.run,
        exec: testExec,
        message,
        updateRoom: async (roomId, updater, opts) =>
          updateRoom(
            roomId,
            (current) => {
              const member = current.agents.find((agent) => agent.id === memberId);
              member.dispatch = { ...member.dispatch, requestId: "request-2", runId: "run-2" };
              return updater(current);
            },
            opts,
          ),
      }),
    ).rejects.toThrow("Member dispatch changed during integration");
    expect(await captureState({ ...f, root: f.root })).toMatchObject({
      checkout: before.checkout,
      repo: before.repo,
    });
    await expect(lstat(path.join(gitDir, "orkest.json"))).rejects.toThrow();
    await expect(lstat(path.join(gitDir, "orkest"))).rejects.toThrow();
  });

  it("serializes concurrent integrations, preserves staged index on failure, and guards HEAD rollback (#1)", async () => {
    const fConcurrent = await fixture();
    const first = integrateMemberWorktree(fConcurrent.room.id, memberId, {
      root: fConcurrent.root,
      run: fConcurrent.run,
      exec: testExec,
      message,
    });
    const second = integrateMemberWorktree(fConcurrent.room.id, memberId, {
      root: fConcurrent.root,
      run: fConcurrent.run,
      exec: testExec,
      message,
    });
    const outcomes = await Promise.allSettled([first, second]);
    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((item) => item.status === "rejected")).toHaveLength(1);
    expect(outcomes.find((item) => item.status === "rejected").reason.message).toMatch(
      /already integrated/,
    );

    // Pre-existing staged index entries survive a failed integration without being overwritten.
    const fStaged = await fixture({
      setup: async ({ worktree }) => {
        await writeFile(path.join(worktree.path, "allowed", "staged.txt"), "staged v1\n");
        execFileSync("git", ["add", "allowed/staged.txt"], { cwd: worktree.path });
        await writeFile(path.join(worktree.path, "allowed", "staged.txt"), "unstaged v2\n");
      },
    });
    const beforeStaged = await captureState(fStaged);
    const failCommitExec = (command, args, options = {}) => {
      if (args[0] === "commit" || args[0] === "commit-tree") {
        return { status: 1, stdout: "", stderr: "hook failed" };
      }
      return testExec(command, args, options);
    };
    await expect(
      integrateMemberWorktree(fStaged.room.id, memberId, {
        root: fStaged.root,
        run: fStaged.run,
        exec: failCommitExec,
        message,
      }),
    ).rejects.toThrow("hook failed");
    expect(await captureState(fStaged)).toEqual(beforeStaged);

    // Rollback must NOT reset HEAD if another writer moved HEAD after our commit.
    const fMovedHead = await fixture();
    let externalCommitSha = "";
    await expect(
      integrateMemberWorktree(fMovedHead.room.id, memberId, {
        root: fMovedHead.root,
        run: fMovedHead.run,
        exec: testExec,
        message,
        updateRoom: async () => {
          await writeFile(
            path.join(fMovedHead.worktree.path, "allowed", "other.txt"),
            "external\n",
          );
          execFileSync("git", ["add", "allowed/other.txt"], { cwd: fMovedHead.worktree.path });
          execFileSync("git", ["commit", "-m", "chore: external writer"], {
            cwd: fMovedHead.worktree.path,
            stdio: "ignore",
          });
          externalCommitSha = git(fMovedHead.worktree.path, "rev-parse", "HEAD");
          throw new Error("trigger rollback after external commit");
        },
      }),
    ).rejects.toThrow("trigger rollback after external commit");
    expect(git(fMovedHead.worktree.path, "rev-parse", "HEAD")).toBe(externalCommitSha);
  });

  it("refuses tampered gitdir backlinks, revert/sequencer state, reverted out-of-scope commits, and moving target (#4, #5, #12, #13, #14)", async () => {
    // #4: Backlink verification rejects a tampered or symlinked gitdir backlink, and symlinked orkest.json.
    const fBacklink = await fixture({ clean: true, commitCount: 1 });
    const gitDirBacklink = git(fBacklink.worktree.path, "rev-parse", "--absolute-git-dir");
    const backlinkFile = path.join(gitDirBacklink, "gitdir");
    const realDotGit = path.join(fBacklink.worktree.path, ".git");
    await rm(backlinkFile);
    await symlink(realDotGit, backlinkFile);
    await expect(
      integrateMemberWorktree(fBacklink.room.id, memberId, {
        root: fBacklink.root,
        run: fBacklink.run,
        exec: (command, args, options = {}) => {
          if (args[0] === "worktree" && args[1] === "list") {
            return { status: 0, stdout: `worktree ${fBacklink.worktree.path}\n`, stderr: "" };
          }
          return testExec(command, args, options);
        },
        message,
      }),
    ).rejects.toThrow("backlink");

    const fMarkerLink = await fixture({ clean: true, commitCount: 1 });
    const gitDirMarkerLink = git(fMarkerLink.worktree.path, "rev-parse", "--absolute-git-dir");
    const markerEscapeFile = path.join(await directory(), "escape.json");
    await symlink(markerEscapeFile, path.join(gitDirMarkerLink, "orkest.json"));
    await expectRefusalUnchanged(fMarkerLink, "already has Orkest merge-queue metadata");
    await expect(lstat(markerEscapeFile)).rejects.toThrow();

    // #14: REVERT_HEAD and sequencer block integration.
    for (const opState of ["REVERT_HEAD", "sequencer"]) {
      const fOp = await fixture({ clean: true, commitCount: 1 });
      const gitDirOp = git(fOp.worktree.path, "rev-parse", "--absolute-git-dir");
      if (opState === "sequencer") {
        await mkdir(path.join(gitDirOp, opState));
      } else {
        await writeFile(
          path.join(gitDirOp, opState),
          `${git(fOp.worktree.path, "rev-parse", "HEAD")}\n`,
        );
      }
      await expectRefusalUnchanged(fOp, `in-progress Git operation (${opState})`);
    }

    // #12: Out-of-scope file changed and then reverted inside branch commits is still caught.
    const fRevertedOutOfScope = await fixture({
      clean: true,
      commitCount: 0,
      reportedChangedPaths: ["allowed/ok.txt"],
      setup: async ({ worktree }) => {
        await writeFile(path.join(worktree.path, "outside.txt"), "oops\n");
        execFileSync("git", ["add", "outside.txt"], { cwd: worktree.path });
        execFileSync("git", ["commit", "-m", "chore: touch outside"], {
          cwd: worktree.path,
          stdio: "ignore",
        });
        execFileSync("git", ["rm", "outside.txt"], { cwd: worktree.path, stdio: "ignore" });
        await writeFile(path.join(worktree.path, "allowed", "ok.txt"), "ok\n");
        execFileSync("git", ["add", "allowed/ok.txt"], { cwd: worktree.path });
        execFileSync("git", ["commit", "-m", "chore: revert outside and add ok"], {
          cwd: worktree.path,
          stdio: "ignore",
        });
      },
    });
    await expectRefusalUnchanged(fRevertedOutOfScope, "outside accepted allowed_paths");

    // #13: Target branch advancing to absorb candidate commit during integration is caught at publication.
    const fTargetAbsorbed = await fixture({ clean: true, commitCount: 1 });
    const candidateHead = git(fTargetAbsorbed.worktree.path, "rev-parse", "HEAD");
    let revListCalls = 0;
    const wrappedExec = (command, args, options = {}) => {
      const res = testExec(command, args, options);
      if (args[0] === "rev-list" && args.includes("--count")) {
        revListCalls += 1;
        if (revListCalls === 1) {
          // Advance targetBranch to candidateHead after initial check, before publication revalidation.
          execFileSync("git", ["update-ref", "refs/heads/main", candidateHead], {
            cwd: fTargetAbsorbed.repo,
          });
        }
      }
      return res;
    };
    await expect(
      integrateMemberWorktree(fTargetAbsorbed.room.id, memberId, {
        root: fTargetAbsorbed.root,
        run: fTargetAbsorbed.run,
        exec: wrappedExec,
        message,
      }),
    ).rejects.toThrow("not ahead of its target branch main");

    // #5: Complete foundryState exists on disk before marker is published.
    const fAtomic = await fixture({ clean: true, commitCount: 1 });
    let stateSeenDuringRoomUpdate = null;
    await integrateMemberWorktree(fAtomic.room.id, memberId, {
      root: fAtomic.root,
      run: fAtomic.run,
      exec: testExec,
      message,
      updateRoom: async (roomId, updater, opts) => {
        const atomicGitDir = git(fAtomic.worktree.path, "rev-parse", "--absolute-git-dir");
        stateSeenDuringRoomUpdate = JSON.parse(
          await readFile(path.join(atomicGitDir, "orkest", "foundry-state.json"), "utf8"),
        );
        return updateRoom(roomId, updater, opts);
      },
    });
    expect(stateSeenDuringRoomUpdate).toMatchObject({
      schema: "ork.foundry.state.v2",
      status: "verified",
      targetBranch: "main",
    });
  });

  it("refuses concurrent index changes, compensates room integration on post-persist failure, and supports dirty retry (#1, #2, #3, #11)", async () => {
    // 1. Concurrent `git add` after staging snapshot aborts before overwriting live index and compensates room integration.
    const fConcurrentIndex = await fixture();
    const beforeConcurrent = await captureState(fConcurrentIndex);
    const wrappedExec = (command, args, options = {}) => {
      const res = testExec(command, args, options);
      if (
        args[0] === "--no-optional-locks" &&
        args[1] === "status" &&
        options?.env?.GIT_INDEX_FILE
      ) {
        // Simulate another process running `git add` right before live index swap.
        writeFileSync(
          path.join(fConcurrentIndex.worktree.path, "allowed", "concurrent.txt"),
          "concurrent staged\n",
        );
        execFileSync("git", ["add", "allowed/concurrent.txt"], {
          cwd: fConcurrentIndex.worktree.path,
        });
      }
      return res;
    };
    await expect(
      integrateMemberWorktree(fConcurrentIndex.room.id, memberId, {
        root: fConcurrentIndex.root,
        run: fConcurrentIndex.run,
        exec: wrappedExec,
        message,
      }),
    ).rejects.toThrow("index changed concurrently");
    // Room integration was cleared via CAS so member is NOT permanently stuck integrated.
    const roomAfterAbort = await readRoom(fConcurrentIndex.room.id, fConcurrentIndex.root);
    expect(roomAfterAbort.agents[0].integration).toBeUndefined();
    // Branch ref was rolled back to original headSha and concurrent staged file survived.
    expect(git(fConcurrentIndex.worktree.path, "rev-parse", "HEAD")).toBe(
      beforeConcurrent.checkout.head,
    );
    expect(git(fConcurrentIndex.worktree.path, "diff", "--cached", "--name-only")).toContain(
      "allowed/concurrent.txt",
    );

    // 2. Dirty integration rollback after update-ref allows a clean retry on the same accepted result (#2, #11).
    const fDirtyRetry = await fixture();
    const dirtyBefore = await captureState(fDirtyRetry);
    let shouldFailPostUpdate = false;
    const failAfterRefExec = (command, args, options = {}) => {
      const res = testExec(command, args, options);
      if (
        !shouldFailPostUpdate &&
        args[0] === "update-ref" &&
        String(args[2] || "").startsWith("orkest:integrate:")
      ) {
        shouldFailPostUpdate = true;
        // Force post-update-ref status check to fail cleanly via injected status failure.
        return res;
      }
      if (
        shouldFailPostUpdate &&
        args[0] === "--no-optional-locks" &&
        args[1] === "status" &&
        options?.env?.GIT_INDEX_FILE
      ) {
        shouldFailPostUpdate = false;
        return { status: 0, stdout: " M allowed/injected-dirty.txt\n", stderr: "" };
      }
      return res;
    };
    await expect(
      integrateMemberWorktree(fDirtyRetry.room.id, memberId, {
        root: fDirtyRetry.root,
        run: fDirtyRetry.run,
        exec: failAfterRefExec,
        message,
      }),
    ).rejects.toThrow("left the member worktree dirty");
    const dirtyAfterAbort = await captureState(fDirtyRetry);
    expect(dirtyAfterAbort.checkout).toEqual(dirtyBefore.checkout);
    expect(dirtyAfterAbort.repo).toEqual(dirtyBefore.repo);
    expect(dirtyAfterAbort.room.agents[0]).toEqual(dirtyBefore.room.agents[0]);
    // Retrying dirty integration against original acceptance now succeeds!
    const retriedDirty = await integrate(fDirtyRetry);
    expect(retriedDirty.integration.message).toBe("feat(room): accepted change");
    expect(git(fDirtyRetry.worktree.path, "status", "--porcelain")).toBe("");
  });

  it("enforces tree_oid, authoritative task.json chain, side-branch scope, room integration verification, and large payloads (#4, #5, #7, #12, #19)", async () => {
    // #4: Restoring one of two accepted edits back to HEAD before integration is caught by tree_oid.
    const fRestored = await fixture({
      clean: false,
      setup: async ({ worktree }) => {
        await writeFile(path.join(worktree.path, "allowed", "second.txt"), "second\n");
      },
      reportedChangedPaths: ["allowed/change.txt", "allowed/second.txt"],
    });
    await writeFile(
      path.join(fRestored.worktree.path, "allowed", "change.txt"),
      "accepted change\n",
    );
    await rm(path.join(fRestored.worktree.path, "allowed", "second.txt"));
    await expectRefusalUnchanged(fRestored, "no longer matches accepted result fingerprint");

    // #5: Missing task.json or pending correction run superseding accepted run is refused (both upfront and at room commit).
    const fMissingTask = await fixture({ clean: true, commitCount: 1 });
    await rm(path.join(fMissingTask.taskDir, "task.json"));
    await expectRefusalUnchanged(fMissingTask, "accepted result");

    const fMissingTaskInRoomTx = await fixture({ clean: true, commitCount: 1 });
    await expect(
      integrateMemberWorktree(fMissingTaskInRoomTx.room.id, memberId, {
        root: fMissingTaskInRoomTx.root,
        run: fMissingTaskInRoomTx.run,
        exec: testExec,
        message,
        updateRoom: async (roomId, updater, opts) => {
          await rm(path.join(fMissingTaskInRoomTx.taskDir, "task.json"));
          return updateRoom(roomId, updater, opts);
        },
      }),
    ).rejects.toThrow("task.json is missing");

    const fSuperseded = await fixture({ clean: true, commitCount: 1 });
    const supersededTaskPath = path.join(fSuperseded.taskDir, "task.json");
    const supersededTask = JSON.parse(await readFile(supersededTaskPath, "utf8"));
    supersededTask.runs.push({
      run_id: "run-correction-2",
      parent_run_id: "run-1",
      kind: "correction",
      engine: "codex",
      model: "gpt-test-model",
      transport: "executor",
      status: "active",
    });
    await writeFile(supersededTaskPath, `${JSON.stringify(supersededTask, null, 2)}\n`);
    await expectRefusalUnchanged(fSuperseded, "accepted result");

    // #12: Out-of-scope file committed and reverted on a merged second-parent side branch is caught.
    const fSideBranch = await fixture({
      clean: true,
      commitCount: 0,
      reportedChangedPaths: ["allowed/ok.txt"],
      setup: async ({ worktree }) => {
        const startBranch = git(worktree.path, "symbolic-ref", "--short", "HEAD");
        execFileSync("git", ["checkout", "-b", "ork/side-branch"], {
          cwd: worktree.path,
          stdio: "ignore",
        });
        await writeFile(path.join(worktree.path, "outside.txt"), "side bad\n");
        execFileSync("git", ["add", "outside.txt"], { cwd: worktree.path });
        execFileSync("git", ["commit", "-m", "chore: side out of scope"], {
          cwd: worktree.path,
          stdio: "ignore",
        });
        execFileSync("git", ["rm", "outside.txt"], { cwd: worktree.path, stdio: "ignore" });
        execFileSync("git", ["commit", "-m", "chore: revert side out of scope"], {
          cwd: worktree.path,
          stdio: "ignore",
        });
        execFileSync("git", ["checkout", startBranch], { cwd: worktree.path, stdio: "ignore" });
        await writeFile(path.join(worktree.path, "allowed", "ok.txt"), "ok\n");
        execFileSync("git", ["add", "allowed/ok.txt"], { cwd: worktree.path });
        execFileSync("git", ["commit", "-m", "chore: allowed main line"], {
          cwd: worktree.path,
          stdio: "ignore",
        });
        execFileSync("git", ["merge", "--no-ff", "ork/side-branch", "-m", "chore: merge side"], {
          cwd: worktree.path,
          stdio: "ignore",
        });
      },
    });
    await expectRefusalUnchanged(fSideBranch, "outside accepted allowed_paths");

    // #7: Smelter rejects a worktree whose orkest.json integrationId does not match the durable room record.
    const fUncommittedMarker = await fixture({ clean: true, commitCount: 1 });
    await integrate(fUncommittedMarker);
    await updateRoom(
      fUncommittedMarker.room.id,
      (current) => {
        delete current.agents[0].integration;
        return current;
      },
      { root: fUncommittedMarker.root },
    );
    expect(
      discoverSmeltableWorktrees(fUncommittedMarker.repo, {
        mailboxRoot: fUncommittedMarker.root,
      }),
    ).toEqual([]);

    // #19: Large result (>200KB) passes verifyCandidateFingerprint via stdin without E2BIG.
    const fLarge = await fixture({
      clean: true,
      commitCount: 1,
      setup: async () => {},
    });
    const largeTracked = Array.from(
      { length: 4000 },
      (_, i) => `allowed/nonexistent-${i}-${"x".repeat(30)}.txt`,
    );
    fLarge.result.tracked_paths = largeTracked;
    const snapScript = [
      "import json, sys",
      "from pathlib import Path",
      "sys.path.insert(0, sys.argv[1])",
      "import run_agent as runner",
      "req = json.loads(sys.stdin.read())",
      'repo = Path(req["repo"])',
      'print(json.dumps({"git_after": runner.git_state(repo, req["tracked"]), "git_identity_after": runner.git_identity(repo)}))',
    ].join("\n");
    const largeSnap = JSON.parse(
      execFileSync("python3", ["-B", "-c", snapScript, scriptsDir], {
        input: JSON.stringify({ repo: fLarge.worktree.path, tracked: largeTracked }),
        encoding: "utf8",
      }),
    );
    fLarge.result.git_after = largeSnap.git_after;
    fLarge.result.git_identity_after = largeSnap.git_identity_after;
    const largeBytes = `${JSON.stringify(fLarge.result)}\n`;
    await writeFile(fLarge.resultPath, largeBytes);
    const largeSha = createHash("sha256").update(largeBytes).digest("hex");
    const largeTaskPath = path.join(fLarge.taskDir, "task.json");
    const largeTask = JSON.parse(await readFile(largeTaskPath, "utf8"));
    largeTask.runs[0].result_sha256 = largeSha;
    await writeFile(largeTaskPath, `${JSON.stringify(largeTask, null, 2)}\n`);
    const largeResult = await integrate(fLarge);
    expect(largeResult.integration.commit).toBeTruthy();
  });

  it("recovers interrupted integrations via durable tx journal and enforces index snapshot, hooks, missing index, and atomic target ref CAS (#1, #3, #9, #12, #15)", async () => {
    // #1a: Interrupted before persistRoom (uncommitted tx journal + metadata on disk) rolls back and succeeds on retry.
    const fCrashPreRoom = await fixture();
    const gitDirPreRoom = git(fCrashPreRoom.worktree.path, "rev-parse", "--absolute-git-dir");
    await mkdir(path.join(gitDirPreRoom, "orkest"), { recursive: true });
    await writeFile(
      path.join(gitDirPreRoom, "orkest", "integrate-tx-pre-room-1.json"),
      JSON.stringify({
        schema: "ork.integrate.tx.v1",
        integrationId: "pre-room-1",
        roomId: fCrashPreRoom.room.id,
        memberId,
      }),
    );
    await writeFile(path.join(gitDirPreRoom, "orkest", "foundry-state.json"), '{"partial":true}\n');
    await writeFile(path.join(gitDirPreRoom, "orkest", "task-spec.json"), '{"partial":true}\n');
    const recoveredPre = await integrate(fCrashPreRoom);
    expect(recoveredPre.integration.commit).toBeTruthy();
    await expect(
      lstat(path.join(gitDirPreRoom, "orkest", "integrate-tx-pre-room-1.json")),
    ).rejects.toThrow();

    // #1b: Interrupted AFTER persistRoom (before update-ref, swapIndex, writeMarker) rolls forward on retry.
    const fCrashPostRoom = await fixture();
    const gitDirPostRoom = git(fCrashPostRoom.worktree.path, "rev-parse", "--absolute-git-dir");
    const preHead = git(fCrashPostRoom.worktree.path, "rev-parse", "HEAD");
    const targetHead = git(fCrashPostRoom.repo, "rev-parse", "refs/heads/main^{commit}");
    const privIdx = path.join(fCrashPostRoom.root, "tmp-idx");
    execFileSync("git", ["add", "-A"], {
      cwd: fCrashPostRoom.worktree.path,
      env: { ...process.env, GIT_INDEX_FILE: privIdx },
    });
    const treeSha = execFileSync("git", ["write-tree"], {
      cwd: fCrashPostRoom.worktree.path,
      env: { ...process.env, GIT_INDEX_FILE: privIdx },
      encoding: "utf8",
    }).trim();
    const committedSha = execFileSync(
      "git",
      ["commit-tree", treeSha, "-p", preHead, "-m", message],
      { cwd: fCrashPostRoom.worktree.path, encoding: "utf8" },
    ).trim();
    const liveIdxBytes = await readFile(path.join(gitDirPostRoom, "index"));
    const liveIdxSha = createHash("sha256").update(liveIdxBytes).digest("hex");
    const txId = "post-room-tx-1";
    const postTaskSpec = {
      schema: "agent-executor.task-spec.v1",
      objective: "Recover",
      allow_paths: allowedPaths,
      development_checks: verificationCommands,
      verify_command: verificationCommands.join(" && "),
      engine: "codex",
      model: "gpt-test-model",
    };
    const canonicalSha = (obj) => {
      const sort = (v) => {
        if (Array.isArray(v)) return v.map(sort);
        if (v && typeof v === "object") {
          const keys = Object.keys(v).sort((a, b) => a.localeCompare(b));
          return Object.fromEntries(keys.map((k) => [k, sort(v[k])]));
        }
        return v;
      };
      return createHash("sha256")
        .update(JSON.stringify(sort(obj)))
        .digest("hex");
    };
    const postIntegration = {
      integrationId: txId,
      commit: committedSha,
      targetBranch: "main",
      targetOid: targetHead,
      taskSpecSha256: canonicalSha(postTaskSpec),
      message,
      at: "2026-11-18T00:00:00.000Z",
    };
    await updateRoom(
      fCrashPostRoom.room.id,
      (current) => {
        current.agents[0].integration = postIntegration;
        return current;
      },
      { root: fCrashPostRoom.root },
    );
    await mkdir(path.join(gitDirPostRoom, "orkest"), { recursive: true });
    const postFoundryState = {
      schema: "ork.foundry.state.v2",
      branch: "ork/room-luna-1",
      commitsAhead: 1,
      headSha: committedSha,
      integrationId: txId,
      mailboxRoot: fCrashPostRoom.root,
      memberId,
      roomId: fCrashPostRoom.room.id,
      status: "verified",
      targetBranch: "main",
      worktreePath: fCrashPostRoom.worktree.path,
      worktreeSlug: memberId,
    };
    await writeFile(
      path.join(gitDirPostRoom, "orkest", `integrate-tx-${txId}.json`),
      JSON.stringify({
        schema: "ork.integrate.tx.v1",
        integrationId: txId,
        roomId: fCrashPostRoom.room.id,
        memberId,
        worktreePath: fCrashPostRoom.worktree.path,
        branch: "ork/room-luna-1",
        branchRef: "refs/heads/ork/room-luna-1",
        targetBranch: "main",
        targetRef: "refs/heads/main",
        expectedTargetOid: targetHead,
        headSha: preHead,
        commit: committedSha,
        isClean: false,
        message,
        at: postIntegration.at,
        liveIndexRel: "index",
        originalIndexSha256: liveIdxSha,
        taskSpec: {
          schema: "agent-executor.task-spec.v1",
          objective: "Recover",
          allow_paths: allowedPaths,
          development_checks: verificationCommands,
          verify_command: verificationCommands.join(" && "),
          engine: "codex",
          model: "gpt-test-model",
        },
        foundryState: postFoundryState,
        marker: {
          branch: "ork/room-luna-1",
          commit: committedSha,
          createdAt: postIntegration.at,
          disposable: true,
          engine: "codex",
          integrationId: txId,
          mailboxRoot: fCrashPostRoom.root,
          memberId,
          parentCwd: fCrashPostRoom.repo,
          roomId: fCrashPostRoom.room.id,
          slug: memberId,
        },
      }),
    );
    const recoveredPost = await integrate(fCrashPostRoom);
    expect(recoveredPost.integration).toEqual(postIntegration);
    expect(git(fCrashPostRoom.worktree.path, "rev-parse", "HEAD")).toBe(committedSha);
    expect(git(fCrashPostRoom.worktree.path, "status", "--porcelain")).toBe("");
    const postMarker = JSON.parse(await readFile(path.join(gitDirPostRoom, "orkest.json"), "utf8"));
    expect(postMarker.integrationId).toBe(txId);
    const postJournalStat = lstat(path.join(gitDirPostRoom, "orkest", `integrate-tx-${txId}.json`));
    await expect(postJournalStat).rejects.toThrow();

    // #3: Index-only edit right after liveIndexSnapshot capture (during task.json read) is caught at final CAS.
    const fSnapshotRace = await fixture();
    let hasInjectedSnapshotRace = false;
    const runSnapshotRace = () =>
      integrateMemberWorktree(fSnapshotRace.room.id, memberId, {
        root: fSnapshotRace.root,
        run: fSnapshotRace.run,
        exec: testExec,
        message,
        updateRoom: async (roomId, updater, opts) => {
          if (!hasInjectedSnapshotRace) {
            hasInjectedSnapshotRace = true;
            execFileSync("git", ["add", "allowed/change.txt"], {
              cwd: fSnapshotRace.worktree.path,
            });
          }
          return updateRoom(roomId, updater, opts);
        },
      });
    await expect(runSnapshotRace()).rejects.toThrow("index changed concurrently");
    expect(git(fSnapshotRace.worktree.path, "diff", "--cached", "--name-only")).toContain(
      "allowed/change.txt",
    );

    // #9: Target branch advancing after validation fails the atomic update-ref transaction.
    const fTargetRace = await fixture();
    const beforeTargetRace = await captureState(fTargetRace);
    const runTargetRace = () =>
      integrateMemberWorktree(fTargetRace.room.id, memberId, {
        root: fTargetRace.root,
        run: fTargetRace.run,
        exec: testExec,
        message,
        updateRoom: async (roomId, updater, opts) => {
          const res = await updateRoom(roomId, updater, opts);
          // Advance main after room persists, right before atomic update-ref --stdin.
          await writeFile(path.join(fTargetRace.repo, "allowed", "race.txt"), "race\n");
          execFileSync("git", ["add", "allowed/race.txt"], { cwd: fTargetRace.repo });
          execFileSync("git", ["commit", "-m", "chore: advance main"], {
            cwd: fTargetRace.repo,
            stdio: "ignore",
          });
          return res;
        },
      });
    await expect(runTargetRace()).rejects.toThrow(/update-ref/);
    expect(git(fTargetRace.worktree.path, "rev-parse", "HEAD")).toBe(
      beforeTargetRace.checkout.head,
    );
    expect(
      (await readRoom(fTargetRace.room.id, fTargetRace.root)).agents[0].integration,
    ).toBeUndefined();

    // #12: Executable pre-commit & commit-msg hooks run with GIT_INDEX_FILE; failures propagate cleanly.
    const fHooks = await fixture();
    const hooksDir = path.join(fHooks.repo, ".custom-hooks");
    await mkdir(hooksDir, { recursive: true });
    execFileSync("git", ["config", "core.hooksPath", hooksDir], { cwd: fHooks.worktree.path });
    const hookLog = path.join(fHooks.root, "hooks.log");
    const preCommitPath = path.join(hooksDir, "pre-commit");
    await writeFile(
      preCommitPath,
      `#!/bin/sh\necho "pre-commit:$GIT_INDEX_FILE" >> "${hookLog}"\nexit 1\n`,
      { mode: 0o755 },
    );
    await expectRefusalUnchanged(fHooks, "pre-commit hook failed");
    expect(await readFile(hookLog, "utf8")).toContain("pre-commit:");

    await writeFile(
      preCommitPath,
      `#!/bin/sh\necho "pre-commit-ok:$GIT_INDEX_FILE" >> "${hookLog}"\nexit 0\n`,
      { mode: 0o755 },
    );
    const commitMsgPath = path.join(hooksDir, "commit-msg");
    await writeFile(
      commitMsgPath,
      `#!/bin/sh\necho "commit-msg:$1:$GIT_INDEX_FILE" >> "${hookLog}"\nexit 0\n`,
      { mode: 0o755 },
    );
    const hooked = await integrate(fHooks);
    expect(hooked.integration.commit).toBeTruthy();
    const hookLogText = await readFile(hookLog, "utf8");
    expect(hookLogText).toContain("pre-commit-ok:");
    expect(hookLogText).toContain("commit-msg:");

    // #15: Missing live index file on dirty worktree succeeds cleanly.
    const fMissingIdx = await fixture({
      reportedChangedPaths: ["allowed/base.txt", "allowed/change.txt"],
      setup: async ({ worktree }) => {
        const missingIdxGitDir = git(worktree.path, "rev-parse", "--absolute-git-dir");
        await rm(path.join(missingIdxGitDir, "index"));
      },
    });
    const integratedMissingIdx = await integrate(fMissingIdx);
    expect(integratedMissingIdx.integration.commit).toBeTruthy();
    expect(git(fMissingIdx.worktree.path, "status", "--porcelain")).toBe("");
  });

  it("validates journal fields against durable room record and reclaims only own abandoned index.lock (#4, #6)", async () => {
    // #4: Tampered journal ref/index/commit/targetBranch is refused before any metadata or ref writes.
    const fTamper = await fixture();
    const gitDirTamper = git(fTamper.worktree.path, "rev-parse", "--absolute-git-dir");
    const preHeadTamper = git(fTamper.worktree.path, "rev-parse", "HEAD");
    const targetHeadTamper = git(fTamper.repo, "rev-parse", "HEAD");
    execFileSync("git", ["add", "-A"], { cwd: fTamper.worktree.path });
    const treeTamper = git(fTamper.worktree.path, "write-tree");
    const committedTamper = git(
      fTamper.worktree.path,
      "commit-tree",
      treeTamper,
      "-p",
      preHeadTamper,
      "-m",
      message,
    );
    execFileSync("git", ["reset", "--mixed", preHeadTamper], {
      cwd: fTamper.worktree.path,
      stdio: "ignore",
    });
    const liveIdxTamper = await readFile(path.join(gitDirTamper, "index"));
    const liveIdxShaTamper = createHash("sha256").update(liveIdxTamper).digest("hex");
    const txTamperId = "tamper-tx-1";
    const tamperTaskSpec = {
      schema: "agent-executor.task-spec.v1",
      objective: "Recover",
      allow_paths: allowedPaths,
      development_checks: verificationCommands,
      verify_command: verificationCommands.join(" && "),
      engine: "codex",
      model: "gpt-test-model",
    };
    const tamperTaskSpecSha = createHash("sha256")
      .update(
        JSON.stringify({
          allow_paths: tamperTaskSpec.allow_paths,
          development_checks: tamperTaskSpec.development_checks,
          engine: tamperTaskSpec.engine,
          model: tamperTaskSpec.model,
          objective: tamperTaskSpec.objective,
          schema: tamperTaskSpec.schema,
          verify_command: tamperTaskSpec.verify_command,
        }),
      )
      .digest("hex");
    await updateRoom(
      fTamper.room.id,
      (current) => {
        current.agents[0].integration = {
          integrationId: txTamperId,
          commit: committedTamper,
          targetBranch: "main",
          targetOid: targetHeadTamper,
          taskSpecSha256: tamperTaskSpecSha,
          message,
          at: "2026-11-18T00:00:00.000Z",
        };
        return current;
      },
      { root: fTamper.root },
    );
    await mkdir(path.join(gitDirTamper, "orkest"), { recursive: true });
    const baseJournal = {
      schema: "ork.integrate.tx.v1",
      integrationId: txTamperId,
      roomId: fTamper.room.id,
      memberId,
      worktreePath: fTamper.worktree.path,
      branch: "ork/room-luna-1",
      branchRef: "refs/heads/main", // tampered ref destination!
      targetBranch: "main",
      targetRef: "refs/heads/main",
      expectedTargetOid: targetHeadTamper,
      headSha: preHeadTamper,
      commit: committedTamper,
      isClean: false,
      message,
      at: "2026-11-18T00:00:00.000Z",
      liveIndexRel: "../../outside-index", // tampered traversal!
      indexLockToken: "lock-tok-tamper",
      originalIndexSha256: liveIdxShaTamper,
      taskSpec: {
        schema: "agent-executor.task-spec.v1",
        objective: "Recover",
        allow_paths: allowedPaths,
        development_checks: verificationCommands,
        verify_command: verificationCommands.join(" && "),
        engine: "codex",
        model: "gpt-test-model",
      },
      foundryState: {
        schema: "ork.foundry.state.v2",
        branch: "ork/room-luna-1",
        commitsAhead: 1,
        headSha: committedTamper,
        integrationId: txTamperId,
        mailboxRoot: fTamper.root,
        memberId,
        roomId: fTamper.room.id,
        status: "verified",
        targetBranch: "main",
        worktreePath: fTamper.worktree.path,
        worktreeSlug: memberId,
      },
      marker: {
        branch: "ork/room-luna-1",
        commit: committedTamper,
        createdAt: "2026-11-18T00:00:00.000Z",
        disposable: true,
        engine: "codex",
        integrationId: txTamperId,
        mailboxRoot: fTamper.root,
        memberId,
        parentCwd: fTamper.repo,
        roomId: fTamper.room.id,
        slug: memberId,
      },
    };
    const journalFile = path.join(gitDirTamper, "orkest", `integrate-tx-${txTamperId}.json`);
    await writeFile(journalFile, JSON.stringify(baseJournal));
    await expect(integrate(fTamper)).rejects.toThrow(/ref destinations/);
    // Metadata was NOT written before validation failed!
    await expect(lstat(path.join(gitDirTamper, "orkest", "foundry-state.json"))).rejects.toThrow();
    await expect(lstat(path.join(gitDirTamper, "orkest", "task-spec.json"))).rejects.toThrow();
    expect(git(fTamper.repo, "rev-parse", "refs/heads/main")).toBe(targetHeadTamper);

    // Tampered liveIndexRel with ".." is also rejected before writes.
    await writeFile(
      journalFile,
      JSON.stringify({ ...baseJournal, branchRef: "refs/heads/ork/room-luna-1" }),
    );
    await expect(integrate(fTamper)).rejects.toThrow(/index path/);
    await expect(lstat(path.join(gitDirTamper, "orkest", "foundry-state.json"))).rejects.toThrow();

    // Tampered tx.taskSpec (e.g. forged verify_command / allow_paths) is rejected before writing task-spec.json (#4).
    await writeFile(
      journalFile,
      JSON.stringify({
        ...baseJournal,
        branchRef: "refs/heads/ork/room-luna-1",
        liveIndexRel: "index",
        taskSpec: {
          ...baseJournal.taskSpec,
          allow_paths: ["."],
          verify_command: "echo pwned",
        },
      }),
    );
    await expect(integrate(fTamper)).rejects.toThrow(/taskSpec/);
    await expect(lstat(path.join(gitDirTamper, "orkest", "task-spec.json"))).rejects.toThrow();
    await expect(lstat(path.join(gitDirTamper, "orkest", "foundry-state.json"))).rejects.toThrow();

    // Uncommitted journal with traversal integrationId cannot unlink files outside orkest/ (#5).
    const fTraversal = await fixture();
    const gitDirTraversal = git(fTraversal.worktree.path, "rev-parse", "--absolute-git-dir");
    const victimFile = path.join(gitDirTraversal, "victim.txt");
    await writeFile(victimFile, "must-remain\n");
    await mkdir(path.join(gitDirTraversal, "orkest"), { recursive: true });
    await writeFile(
      path.join(gitDirTraversal, "orkest", "integrate-tx-evil-1.json"),
      JSON.stringify({
        schema: "ork.integrate.tx.v1",
        integrationId: "../../victim.txt",
        roomId: fTraversal.room.id,
        memberId,
      }),
    );
    await expect(integrate(fTraversal)).rejects.toThrow(
      /malformed integration transaction journal/,
    );
    expect(await readFile(victimFile, "utf8")).toBe("must-remain\n");

    // #6: Abandoned own index.lock (matching integrationId + indexLockToken) is reclaimed,
    // while an external index.lock is never reclaimed.
    const fLock = await fixture();
    const gitDirLock = git(fLock.worktree.path, "rev-parse", "--absolute-git-dir");
    const preHeadLock = git(fLock.worktree.path, "rev-parse", "HEAD");
    const targetHeadLock = git(fLock.repo, "rev-parse", "HEAD");
    execFileSync("git", ["add", "-A"], { cwd: fLock.worktree.path });
    const treeLock = git(fLock.worktree.path, "write-tree");
    const committedLock = git(
      fLock.worktree.path,
      "commit-tree",
      treeLock,
      "-p",
      preHeadLock,
      "-m",
      message,
    );
    execFileSync("git", ["reset", "--mixed", preHeadLock], {
      cwd: fLock.worktree.path,
      stdio: "ignore",
    });
    const liveIdxLock = await readFile(path.join(gitDirLock, "index"));
    const liveIdxShaLock = createHash("sha256").update(liveIdxLock).digest("hex");
    const txLockId = "lock-tx-1";
    const lockToken = "own-lock-token-123";
    await updateRoom(
      fLock.room.id,
      (current) => {
        current.agents[0].integration = {
          integrationId: txLockId,
          commit: committedLock,
          targetBranch: "main",
          targetOid: targetHeadLock,
          taskSpecSha256: tamperTaskSpecSha,
          message,
          at: "2026-11-18T00:00:00.000Z",
        };
        return current;
      },
      { root: fLock.root },
    );
    await mkdir(path.join(gitDirLock, "orkest"), { recursive: true });
    await writeFile(
      path.join(gitDirLock, "orkest", `integrate-tx-${txLockId}.json`),
      JSON.stringify({
        ...baseJournal,
        integrationId: txLockId,
        roomId: fLock.room.id,
        worktreePath: fLock.worktree.path,
        branchRef: "refs/heads/ork/room-luna-1",
        expectedTargetOid: targetHeadLock,
        headSha: preHeadLock,
        commit: committedLock,
        liveIndexRel: "index",
        indexLockToken: lockToken,
        originalIndexSha256: liveIdxShaLock,
        foundryState: {
          ...baseJournal.foundryState,
          headSha: committedLock,
          integrationId: txLockId,
          mailboxRoot: fLock.root,
          roomId: fLock.room.id,
          worktreePath: fLock.worktree.path,
        },
        marker: {
          ...baseJournal.marker,
          commit: committedLock,
          integrationId: txLockId,
          mailboxRoot: fLock.root,
          parentCwd: fLock.repo,
          roomId: fLock.room.id,
        },
      }),
    );

    // External 0-byte index.lock is NOT reclaimed.
    const nativeIndexLock = path.join(gitDirLock, "index.lock");
    await writeFile(nativeIndexLock, "");
    await expect(integrate(fLock)).rejects.toThrow(/index lock is held by another process/);
    expect(await readFile(nativeIndexLock, "utf8")).toBe("");

    // Own abandoned index.lock carrying matching token IS reclaimed and recovery finishes cleanly.
    await writeFile(nativeIndexLock, `orkest-index-lock-v1:${txLockId}:${lockToken}\n`);
    const recoveredLock = await integrate(fLock);
    expect(recoveredLock.integration.commit).toBe(committedLock);
    expect(git(fLock.worktree.path, "status", "--porcelain")).toBe("");
    await expect(lstat(nativeIndexLock)).rejects.toThrow();
  });
});
