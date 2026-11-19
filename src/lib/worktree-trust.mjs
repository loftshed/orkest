import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  writeSync,
} from "node:fs";
import path from "node:path";

import { configHome } from "./runtime-paths.mjs";
import { hashWorktreeInputs, parseWorktreeConfig, planWorktreeInputs } from "./worktree-env.mjs";

export const TRUST_SCHEMA = "ork.worktree.setup-trust.v1";
const TRUST_DIR = "worktree-trust";
const MAX_RECORD_BYTES = 64 * 1024;

function trustError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function gitOut(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Reviewed-checkout identity: the commit plus whether the tree has any uncommitted change. */
export function checkoutState(cwd) {
  const commit = gitOut(cwd, ["rev-parse", "--verify", "HEAD"]).trim();
  const dirty = gitOut(cwd, ["status", "--porcelain", "--untracked-files=normal"]).trim();
  return { commit, clean: dirty === "" };
}

function trustDirectory(env, { create }) {
  const home = configHome(env);
  const directory = path.join(home, TRUST_DIR);
  if (create) {
    mkdirSync(home, { recursive: true });
    try {
      mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  let info;
  try {
    info = lstatSync(directory);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw trustError("ORK_WORKTREE_TRUST_UNSAFE", `${directory} must be a real directory`);
  }
  if (info.uid !== process.getuid() || (info.mode & 0o077) !== 0) {
    throw trustError(
      "ORK_WORKTREE_TRUST_UNSAFE",
      `${directory} must be owned by you with mode 0700`,
    );
  }
  return directory;
}

function recordPath(directory, canonicalRepo) {
  const id = createHash("sha256").update(canonicalRepo).digest("hex");
  return path.join(directory, `${id}.json`);
}

function readRecord(file) {
  let fd;
  try {
    fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw trustError("ORK_WORKTREE_TRUST_UNSAFE", `Cannot read trust record: ${error.code}`);
  }
  try {
    const info = fstatSync(fd);
    if (
      !info.isFile() ||
      info.uid !== process.getuid() ||
      (info.mode & 0o077) !== 0 ||
      info.size > MAX_RECORD_BYTES
    ) {
      throw trustError("ORK_WORKTREE_TRUST_UNSAFE", `${file} is not a private user-owned file`);
    }
    const buffer = Buffer.alloc(info.size);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    try {
      return JSON.parse(buffer.subarray(0, length).toString("utf8"));
    } catch {
      return null;
    }
  } finally {
    closeSync(fd);
  }
}

function argvDigest(argv) {
  return createHash("sha256").update(JSON.stringify(argv)).digest("hex");
}

function inputsDigest(inputs) {
  return createHash("sha256")
    .update(JSON.stringify(inputs.map(({ path: rel, sha256 }) => [rel, sha256])))
    .digest("hex");
}

/**
 * What an operator is asked to approve: canonical repo, argv, the config hash, the reviewed commit and
 * the ignored or untracked files (`.env*`, `.worktreeinclude`, `copyFiles`) that setup will be able to read.
 */
export function describeWorktreeSetup(repoRoot) {
  const parsed = parseWorktreeConfig(repoRoot);
  const argv = parsed.config.setupCommand;
  if (!argv) return null;
  const inputs = planWorktreeInputs(parsed.repoRoot, { extraIncludes: parsed.config.copyFiles });
  return {
    repo: parsed.repoRoot,
    argv,
    configSha256: parsed.sha256,
    argvSha256: argvDigest(argv),
    inputs,
    inputsSha256: inputsDigest(inputs),
    ...checkoutState(parsed.repoRoot),
  };
}

/**
 * Record explicit approval for the exact config bytes and the reviewed checkout commit.
 * Refuses a dirty checkout: the grant must describe committed, reviewable code.
 */
export function approveWorktreeSetup(repoRoot, { env = process.env } = {}) {
  const description = describeWorktreeSetup(repoRoot);
  if (!description) {
    throw trustError("ORK_WORKTREE_TRUST_NOTHING", "No setupCommand is configured to approve");
  }
  if (!description.clean) {
    throw trustError(
      "ORK_WORKTREE_TRUST_DIRTY",
      "The checkout has uncommitted changes; commit or stash them so the approval covers reviewable code",
    );
  }
  const directory = trustDirectory(env, { create: true });
  const file = recordPath(directory, description.repo);
  const record = {
    schema: TRUST_SCHEMA,
    repo: description.repo,
    configSha256: description.configSha256,
    argv: description.argv,
    argvSha256: description.argvSha256,
    inputsSha256: description.inputsSha256,
    inputPaths: description.inputs.map((input) => input.path).slice(0, 200),
    commit: description.commit,
    approvedAt: new Date().toISOString(),
  };
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const fd = openSync(
    temporary,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeSync(fd, `${JSON.stringify(record, null, 2)}\n`);
  } finally {
    closeSync(fd);
  }
  chmodSync(temporary, 0o600);
  renameSync(temporary, file);
  return { ...record, recordPath: file };
}

/** Environment PATH reduced to absolute directories outside the repository and worktree. */
export function trustedSetupPath(rawPath, excludedRoots = []) {
  const roots = excludedRoots.map((root) => path.resolve(root));
  const kept = String(rawPath ?? "")
    .split(path.delimiter)
    .filter((entry) => {
      if (!path.isAbsolute(entry)) return false;
      const resolved = path.resolve(entry);
      return roots.every((root) => resolved !== root && !resolved.startsWith(`${root}${path.sep}`));
    });
  return kept.length > 0 ? kept.join(path.delimiter) : "/usr/local/bin:/usr/bin:/bin";
}

/** Untracked or ignored entries in a fresh worktree that no reviewed input explains. */
function unreviewedEntries(worktreePath, allowed) {
  const output = execFileSync(
    "git",
    ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored"],
    { cwd: worktreePath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return output
    .split("\0")
    .filter((entry) => entry.startsWith("?? ") || entry.startsWith("!! "))
    .map((entry) => entry.slice(3))
    .filter((entry) => !allowed.has(entry.replace(/\/$/u, "")));
}

/**
 * Decide whether a parsed config's setup command may run in `worktreePath`. Trust needs: same
 * canonical repo, same config bytes and argv, the approved commit checked out and clean, the same
 * copied-in inputs (`.env*`, `copyFiles`) as reviewed, and, for a first run, no other ignored or
 * untracked files. A retry (`firstRun: false`) may see artifacts its earlier approved run left.
 */
export function evaluateSetupTrust(
  parsed,
  worktreePath,
  { env = process.env, firstRun = true } = {},
) {
  const argv = parsed.config.setupCommand;
  if (!argv) return { trusted: false, reason: "no-setup" };
  let record;
  try {
    const directory = trustDirectory(env, { create: false });
    record = directory ? readRecord(recordPath(directory, parsed.repoRoot)) : null;
  } catch (error) {
    return { trusted: false, reason: "unsafe-record", detail: error.message };
  }
  if (!record || record.schema !== TRUST_SCHEMA) return { trusted: false, reason: "not-approved" };
  if (record.repo !== parsed.repoRoot) return { trusted: false, reason: "repo-mismatch" };
  if (record.configSha256 !== parsed.sha256 || record.argvSha256 !== argvDigest(argv)) {
    return { trusted: false, reason: "config-changed" };
  }
  try {
    const state = checkoutState(realpathSync(worktreePath));
    if (state.commit !== record.commit) return { trusted: false, reason: "checkout-changed" };
    if (!state.clean) return { trusted: false, reason: "checkout-dirty" };

    const planned = planWorktreeInputs(parsed.repoRoot, { extraIncludes: parsed.config.copyFiles });
    if (
      inputsDigest(planned) !== record.inputsSha256 ||
      inputsDigest(hashWorktreeInputs(worktreePath, planned)) !== record.inputsSha256
    ) {
      return { trusted: false, reason: "inputs-changed" };
    }
    if (firstRun) {
      const allowed = new Set([
        ...planned.map((input) => input.path),
        ...parsed.config.symlinkDirs,
      ]);
      const extra = unreviewedEntries(realpathSync(worktreePath), allowed);
      if (extra.length > 0) {
        return { trusted: false, reason: "unreviewed-files", detail: extra.slice(0, 3).join(", ") };
      }
    }
  } catch (error) {
    return { trusted: false, reason: "checkout-unverifiable", detail: error.message };
  }
  return { trusted: true, reason: "approved", commit: record.commit };
}
