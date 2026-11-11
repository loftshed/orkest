import { execFileSync } from "node:child_process";
import { lstat, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { resolveFoundryStatePath, resolveTaskSpecPath, writeFoundryState } from "./foundry.mjs";
import { mailboxRoot, readRoom, resolveWorktreeMarkerPath, updateRoom } from "./horde-room.mjs";
import { coordinator, memberOf, observeRoom } from "./rooms.mjs";
import { isPathAllowed } from "./smelter.mjs";
import { currentBranch, resolveRepositoryRoot } from "./worktree-provision.mjs";

function invokeGit(exec, cwd, args) {
  if (exec)
    return exec("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  try {
    return {
      status: 0,
      stdout: execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
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

function gitOutput(exec, cwd, args) {
  const result = invokeGit(exec, cwd, args);
  if (typeof result === "string") return result;
  if (!result || result.status !== 0) {
    const detail = result?.stderr?.trim() || result?.stdout?.trim() || "git command failed";
    throw new Error(`Git command failed in ${cwd}: git ${args.join(" ")}: ${detail}`);
  }
  return String(result.stdout ?? "");
}

async function pathExists(target) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function readResult(filePath) {
  try {
    const info = await stat(filePath);
    if (!info.isFile() || info.size > 4 * 1024 * 1024) return null;
    const result = JSON.parse(await readFile(filePath, "utf8"));
    return result && typeof result === "object" && !Array.isArray(result) ? result : null;
  } catch {
    return null;
  }
}

function parseNulPaths(output) {
  return String(output ?? "")
    .split("\0")
    .filter(Boolean);
}

function isValidCommitSubject(message) {
  return (
    typeof message === "string" &&
    message === message.trim() &&
    /^[a-z][a-z0-9-]*(?:\([^\r\n()]+\))?!?: \S.*$/u.test(message)
  );
}

/** Commit a reviewed, accepted room result and register it with the smelter queue. */
export async function integrateMemberWorktree(id, memberId, options = {}) {
  const { root = mailboxRoot(), run = coordinator, exec, message } = options;
  if (!isValidCommitSubject(message))
    throw new Error(
      "--message must be a single-line conventional commit subject (type(scope)?: text)",
    );

  const storedRoom = await readRoom(id, root);
  const storedMember = memberOf(storedRoom, memberId);
  if (storedMember.integration) throw new Error(`Member ${memberId} is already integrated`);
  if (!storedMember.worktree?.path)
    throw new Error(`Member ${memberId} has no recorded room worktree`);
  if (storedMember.worktree.disposable !== true)
    throw new Error(
      `Member ${memberId} worktree is not disposable and cannot enter the smelter queue`,
    );

  const repoRoot = await realpath(storedRoom.cwd);
  const worktreePath = await realpath(storedMember.worktree.path);
  if (worktreePath === repoRoot) throw new Error("Room worktree resolves to the room checkout");
  if ((await realpath(resolveRepositoryRoot(worktreePath, exec))) !== worktreePath)
    throw new Error("Recorded member path is not a Git worktree root");

  const listedWorktrees = gitOutput(exec, repoRoot, ["worktree", "list", "--porcelain"])
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => path.resolve(line.slice("worktree ".length)));
  const registered = await Promise.all(
    listedWorktrees.map(async (candidate) => {
      try {
        return (await realpath(candidate)) === worktreePath;
      } catch {
        return false;
      }
    }),
  );
  if (!registered.includes(true))
    throw new Error("Recorded path is not registered to the room repository");

  const rootCommonDir = await realpath(
    path.resolve(repoRoot, gitOutput(exec, repoRoot, ["rev-parse", "--git-common-dir"]).trim()),
  );
  const worktreeCommonDir = await realpath(
    path.resolve(
      worktreePath,
      gitOutput(exec, worktreePath, ["rev-parse", "--git-common-dir"]).trim(),
    ),
  );
  if (rootCommonDir !== worktreeCommonDir)
    throw new Error("Recorded worktree belongs to a different Git repository");
  // Where the result belongs: an explicit target, else the branch the worktree was created from,
  // else the branch the room checkout is on now. Never a guessed default.
  const targetBranch =
    options.target || storedMember.worktree.baseBranch || currentBranch(repoRoot, exec);
  if (!targetBranch)
    throw new Error(
      "Cannot tell which branch this result belongs on: the room checkout is detached; pass --target BRANCH",
    );
  gitOutput(exec, repoRoot, ["rev-parse", "--verify", `refs/heads/${targetBranch}`]);

  const observedRoom = await observeRoom(storedRoom, { root, run });
  const observedMember = memberOf(observedRoom, memberId);
  if (observedMember.verdict !== "accept")
    throw new Error(`Member ${memberId} must have an accepted result before integration`);
  if (observedMember.evidenceState === "stale")
    throw new Error(`Member ${memberId} accepted evidence is stale`);
  if (observedMember.worktree?.path !== storedMember.worktree.path)
    throw new Error("Observed member worktree differs from the recorded worktree");
  if (!observedMember.resultPath) throw new Error("Accepted member result has no result.json path");

  const result = await readResult(observedMember.resultPath);
  if (!result) throw new Error("Accepted member result.json is missing or invalid");
  if (typeof result.repository !== "string" || (await realpath(result.repository)) !== worktreePath)
    throw new Error("Accepted result repository differs from the member worktree");
  if (
    !Array.isArray(result.allowed_paths) ||
    result.allowed_paths.length === 0 ||
    result.allowed_paths.some((item) => !(typeof item === "string" && item.trim()))
  )
    throw new Error("Accepted result has no valid allowed_paths scope");
  if (
    !Array.isArray(result.verification_commands) ||
    result.verification_commands.length === 0 ||
    result.verification_commands.some((item) => !(typeof item === "string" && item.trim()))
  )
    throw new Error("Accepted result has no valid verification_commands");
  if (
    !Array.isArray(result.run_delta?.changed_paths) ||
    result.run_delta.changed_paths.some((item) => typeof item !== "string")
  )
    throw new Error("Accepted result has no valid run_delta.changed_paths");
  if (result.engine !== observedMember.engine || result.model !== observedMember.resolvedModel)
    throw new Error("Accepted result engine or model differs from the observed room run");
  if (typeof observedMember.objective !== "string" || !observedMember.objective.trim())
    throw new Error("Accepted room task has no objective for the smelter task spec");

  const branch = gitOutput(exec, worktreePath, ["symbolic-ref", "--short", "-q", "HEAD"]).trim();
  if (!branch) throw new Error("Member worktree is detached and cannot be integrated");
  if (storedMember.worktree.branch && storedMember.worktree.branch !== branch)
    throw new Error("Member worktree branch differs from the recorded room branch");
  if (branch === targetBranch) throw new Error("Member worktree is on its own target branch");

  const gitStatus = gitOutput(exec, worktreePath, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (!gitStatus.trim()) throw new Error("Member worktree is clean; there is nothing to integrate");
  const changedPaths = new Set([
    ...parseNulPaths(
      gitOutput(exec, worktreePath, ["diff", "--name-only", "--no-renames", "-z", "HEAD"]),
    ),
    ...parseNulPaths(
      gitOutput(exec, worktreePath, ["ls-files", "--others", "--exclude-standard", "-z"]),
    ),
    ...result.run_delta.changed_paths,
  ]);
  const outOfScope = [...changedPaths].filter(
    (changedPath) => !isPathAllowed(changedPath, result.allowed_paths),
  );
  if (outOfScope.length > 0)
    throw new Error(`Changed paths fall outside accepted allowed_paths: ${outOfScope.join(", ")}`);

  // Refuse before staging if either identity is unavailable; never synthesize a name or email.
  for (const identity of ["GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"]) {
    const check = invokeGit(exec, worktreePath, ["var", identity]);
    if (typeof check !== "string" && (!check || check.status !== 0))
      throw new Error("Cannot integrate: Git author and committer identity must be configured");
  }

  const markerPath = resolveWorktreeMarkerPath(worktreePath);
  if (!markerPath) throw new Error("Cannot locate the member worktree Git metadata directory");
  const taskSpecPath = resolveTaskSpecPath(worktreePath);
  const statePath = resolveFoundryStatePath(worktreePath);
  if (
    (await pathExists(markerPath)) ||
    (await pathExists(taskSpecPath)) ||
    (await pathExists(statePath))
  )
    throw new Error("Member worktree already has Orkest merge-queue metadata");

  const at = new Date().toISOString();
  const indexPath = path.resolve(
    worktreePath,
    gitOutput(exec, worktreePath, ["rev-parse", "--git-path", "index"]).trim(),
  );
  let originalIndex;
  try {
    originalIndex = await readFile(indexPath);
  } catch (error) {
    throw new Error(
      `Cannot snapshot the member worktree index before integration: ${error.message}`,
      { cause: error },
    );
  }
  const previousHead = gitOutput(exec, worktreePath, ["rev-parse", "HEAD"]).trim();
  let isCommitted = false;
  let commit;
  let foundryState;
  try {
    gitOutput(exec, worktreePath, ["add", "-A"]);
    gitOutput(exec, worktreePath, ["commit", "-m", message]);
    isCommitted = true;
    commit = gitOutput(exec, worktreePath, ["rev-parse", "HEAD"]).trim();
    if (!commit) throw new Error("Could not identify the accepted room commit");
    const commitsAhead = Number(
      gitOutput(exec, worktreePath, ["rev-list", "--count", `${targetBranch}..HEAD`]).trim(),
    );
    if (!Number.isSafeInteger(commitsAhead) || commitsAhead <= 0)
      throw new Error(`The accepted room commit is not ahead of its target branch ${targetBranch}`);
    if (gitOutput(exec, worktreePath, ["status", "--porcelain=v1", "--untracked-files=all"]).trim())
      throw new Error("Git commit left the member worktree dirty");

    const verifyCommand = result.verification_commands.join(" && ");
    const taskSpec = {
      schema: "agent-executor.task-spec.v1",
      objective: observedMember.objective,
      allow_paths: result.allowed_paths,
      development_checks: result.verification_commands,
      verify_command: verifyCommand,
      engine: result.engine,
      model: result.model,
    };
    const marker = {
      branch,
      createdAt: at,
      disposable: true,
      engine: result.engine,
      parentCwd: repoRoot,
      slug: storedMember.worktree.slug || path.basename(worktreePath),
    };
    await mkdir(path.dirname(markerPath), { recursive: true });
    await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, { flag: "wx" });
    await mkdir(path.dirname(taskSpecPath), { recursive: true });
    await writeFile(taskSpecPath, `${JSON.stringify(taskSpec, null, 2)}\n`, { flag: "wx" });
    foundryState = writeFoundryState(worktreePath, {
      branch,
      commitsAhead,
      headSha: commit,
      lastRun: {
        engine: result.engine,
        model: result.model,
        resultPath: observedMember.resultPath,
      },
      maxAttempts: 2,
      status: "verified",
      targetBranch,
      verifyCommand,
      worktreePath,
      worktreeSlug: storedMember.worktree.slug || path.basename(worktreePath),
    });
  } catch (error) {
    // Put the worktree back exactly: the worker's changes uncommitted, the index as it was, and no
    // queue metadata, so the command can simply be run again.
    await Promise.all(
      [markerPath, taskSpecPath, statePath].map((file) => rm(file, { force: true })),
    );
    if (isCommitted) gitOutput(exec, worktreePath, ["reset", "--soft", previousHead]);
    await writeFile(indexPath, originalIndex);
    throw error;
  }

  const integration = { commit, message, at };
  await updateRoom(
    id,
    (current) => {
      const currentMember = memberOf(current, memberId);
      if (currentMember.integration) throw new Error(`Member ${memberId} is already integrated`);
      if (currentMember.worktree?.path !== storedMember.worktree.path)
        throw new Error("Member worktree changed during integration");
      currentMember.integration = integration;
      return current;
    },
    { root },
  );

  return { roomId: id, memberId, worktreePath, branch, targetBranch, integration, foundryState };
}
