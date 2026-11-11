import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync } from "node:fs";
import path from "node:path";

// Foundry re-exports this shared helper; importing its CLI module also loads factory configuration.
import { bootstrapWorktreeInclude } from "./worktree-env.mjs";

function defaultExec(command, args, options) {
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

function execute(exec, args, options) {
  let result;
  try {
    result = exec("git", args, options);
  } catch (error) {
    result = {
      status: error.status ?? 1,
      stdout: error.stdout?.toString() ?? "",
      stderr: error.stderr?.toString() || error.message,
    };
  }
  return result;
}

export function resolveRepositoryRoot(cwd, exec = defaultExec) {
  const result = execute(exec, ["rev-parse", "--show-toplevel"], { cwd });
  if (result.status !== 0) {
    const detail = result.stderr?.trim() || "git rev-parse failed";
    throw new Error(`Room working directory is not a git repository: ${cwd}: ${detail}`);
  }
  return path.resolve(result.stdout.trim());
}

/** The branch checked out in `cwd`, or "" when its HEAD is detached. */
export function currentBranch(cwd, exec = defaultExec) {
  const result = execute(exec, ["symbolic-ref", "--short", "-q", "HEAD"], { cwd });
  return result.status === 0 ? String(result.stdout ?? "").trim() : "";
}

export function validateWorktreeSlug(slug) {
  if (typeof slug !== "string" || !/^[a-z0-9-]+$/u.test(slug))
    throw new Error("Worktree slug must use lowercase letters, digits, and dashes");
  return slug;
}

/** Create a disposable worktree inside the repository and copy its local includes. */
export function provisionWorktree(repoRoot, { slug, branch, exec = defaultExec } = {}) {
  validateWorktreeSlug(slug);
  if (typeof branch !== "string" || !branch)
    throw new Error("Worktree branch must be a non-empty string");

  const parentCwd = path.resolve(repoRoot);
  const worktreesRoot = path.join(parentCwd, ".worktrees");
  const worktreePath = path.join(worktreesRoot, slug);
  try {
    lstatSync(worktreePath);
    const error = new Error(`Worktree path already exists: ${worktreePath}`);
    error.stage = "path-exists";
    throw error;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  try {
    mkdirSync(worktreesRoot, { recursive: true });
  } catch (error_) {
    const error = new Error(
      `Failed to prepare worktree directory ${worktreesRoot}: ${error_.message}`,
      { cause: error_ },
    );
    error.stage = "mkdir";
    throw error;
  }
  const result = execute(exec, ["worktree", "add", "-b", branch, worktreePath, "HEAD"], {
    cwd: parentCwd,
  });
  if (result.status !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || "git worktree add failed";
    const error = new Error(`Failed to provision worktree for branch ${branch}: ${detail}`);
    error.stage = "add";
    error.stderr = result.stderr;
    throw error;
  }

  try {
    bootstrapWorktreeInclude(parentCwd, worktreePath, { overwrite: false });
  } catch (error_) {
    const error = new Error(`Failed to bootstrap worktree ${worktreePath}: ${error_.message}`, {
      cause: error_,
    });
    error.stage = "bootstrap";
    throw error;
  }

  return { path: worktreePath, branch, slug, parentCwd };
}
