import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";

// Foundry re-exports this shared helper; importing its CLI module also loads factory configuration.
import {
  bootstrapWorktreeInclude,
  linkWorktreeDirs,
  parseWorktreeConfig,
  previewWorktreeLinks,
} from "./worktree-env.mjs";
import { listWorktreePorts } from "./worktree-ports.mjs";
import { processStartIdentity, WORKER_PATH } from "./worktree-setup-worker.mjs";
import { evaluateSetupTrust, trustedSetupPath } from "./worktree-trust.mjs";

const SETUP_MARKER = "orkest-setup.json";
const SETUP_LOCK = "orkest-setup.lock";
const SETUP_GUARD = "orkest-setup.recover";
const SETUP_HISTORY = "orkest-setup.history.jsonl";
const DEFAULT_SETUP_TIMEOUT_MS = 120_000;
const MAX_SETUP_TIMEOUT_MS = 600_000;
const WORKER_SLACK_MS = 15_000;
const WORKER_ENV_KEYS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "ORCHESTRATE_HOME",
  "AGENT_EXECUTOR_HOME",
  "ORCHESTRATE_CONFIG",
  "AGENT_EXECUTOR_CONFIG",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
];
const SETUP_ENV_KEYS = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TERM", "TZ"];

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
export function provisionWorktree(
  repoRoot,
  { slug, branch, exec = defaultExec, env = process.env } = {},
) {
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

  const prepared = prepareWorktree(parentCwd, worktreePath, { slug, env, overwrite: false });

  return { path: worktreePath, branch, slug, parentCwd, prepared };
}

function bootstrapFailure(worktreePath, substage, error, code) {
  if (error?.stage === "bootstrap" && error.substage === substage) return error;
  const wrapped = new Error(
    `Failed to bootstrap worktree ${worktreePath} (${substage}): ${error.message}`,
    { cause: error },
  );
  wrapped.stage = "bootstrap";
  wrapped.substage = substage;
  wrapped.code = code || error.code || "ORK_WORKTREE_PREPARE_FAILED";
  return wrapped;
}

function pick(env, keys) {
  const out = {};
  for (const key of keys) {
    const value = env?.[key] ?? (key === "PATH" ? process.env.PATH : undefined);
    if (typeof value === "string" && value) out[key] = value;
  }
  return out;
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function worktreeGitDir(worktreePath) {
  return realpathSync(
    execFileSync("git", ["rev-parse", "--absolute-git-dir"], {
      cwd: worktreePath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim(),
  );
}

function readSetupMarker(gitDir) {
  try {
    return JSON.parse(readFileSync(path.join(gitDir, SETUP_MARKER), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    // An unreadable marker cannot prove setup finished.
    return { state: "running", unreadable: true };
  }
}

function writeSetupMarker(gitDir, marker) {
  const target = path.join(gitDir, SETUP_MARKER);
  const temporary = `${target}.${process.pid}.tmp`;
  const fd = openSync(
    temporary,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeSync(fd, `${JSON.stringify(marker, null, 2)}\n`);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, target);
}

function setupError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Append-only record of claims, results and recoveries; survives crashes and recovery moves. */
function appendHistory(gitDir, entry) {
  try {
    const fd = openSync(
      path.join(gitDir, SETUP_HISTORY),
      fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeSync(
        fd,
        `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...entry })}\n`,
      );
    } finally {
      closeSync(fd);
    }
  } catch {
    // History is diagnostic; losing a line never changes setup behavior.
  }
}

/** Create `file` with complete content or fail with EEXIST: link() never replaces an existing name. */
function createExclusive(file, record) {
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const fd = openSync(
    temporary,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeSync(fd, `${JSON.stringify(record)}\n`);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(temporary, file);
  } finally {
    unlinkSync(temporary);
  }
}

/** The owner record, null when the file vanished, or `{ unreadable: true }`. */
function readOwner(file) {
  try {
    const record = JSON.parse(readFileSync(file, "utf8"));
    return record && typeof record === "object" && typeof record.token === "string"
      ? record
      : { unreadable: true };
  } catch (error) {
    return error.code === "ENOENT" ? null : { unreadable: true };
  }
}

function isProcessAlive(pid, start) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code !== "EPERM") return false;
  }
  const identity = processStartIdentity(pid);
  return !(start && identity) || identity === start;
}

/** Live while the claiming process, its helper or the setup process it started still runs. */
function isOwnerAlive(owner) {
  return [
    [owner.pid, owner.start],
    [owner.workerPid, owner.workerStart],
    [owner.setupPid, owner.setupStart],
  ].some(([pid, start]) => isProcessAlive(pid, start));
}

function ownerRecord() {
  return {
    token: randomBytes(12).toString("hex"),
    pid: process.pid,
    start: processStartIdentity(process.pid),
    claimedAt: new Date().toISOString(),
  };
}

function releaseOwned(file, token) {
  const owner = readOwner(file);
  if (owner?.token === token) {
    try {
      unlinkSync(file);
    } catch {
      // Already gone.
    }
  }
}

/**
 * Take the durable exclusive setup claim. A live owner is waited for (bounded); a dead one means
 * the earlier setup was interrupted and must be recovered explicitly.
 */
function acquireSetupClaim(gitDir, { waitMs }) {
  const lockPath = path.join(gitDir, SETUP_LOCK);
  const record = ownerRecord();
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      createExclusive(lockPath, record);
      appendHistory(gitDir, { event: "claimed", token: record.token });
      return {
        lockPath,
        token: record.token,
        release: () => releaseOwned(lockPath, record.token),
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const owner = readOwner(lockPath);
    if (owner === null) continue; // Released between our attempts.
    if (owner.unreadable) {
      throw setupError(
        "ORK_WORKTREE_SETUP_ACTIVE",
        `Cannot verify who owns ${lockPath}; inspect it before retrying`,
      );
    }
    if (!isOwnerAlive(owner)) {
      throw setupError(
        "ORK_WORKTREE_SETUP_INTERRUPTED",
        `Setup in ${gitDir} was interrupted (its owner, pid ${owner.pid}, is gone) and may have partly run. Inspect the worktree, then call recoverInterruptedSetup() and retry.`,
      );
    }
    if (Date.now() >= deadline) {
      throw setupError(
        "ORK_WORKTREE_SETUP_ACTIVE",
        `Setup is already running in this worktree (pid ${owner.pid}); retry when it finishes`,
      );
    }
    sleepSync(25);
  }
}

/**
 * Explicit recovery for an interrupted setup. It is mutually exclusive with setup claims: a live
 * owner (or an unreadable claim) refuses recovery. Otherwise the stale claim and any `running`
 * marker are moved aside under timestamped names (nothing is deleted) so the next prepare may run
 * setup again. Inspect the worktree first; non-idempotent setup may have left partial effects.
 */
export function recoverInterruptedSetup(worktreePath) {
  const gitDir = worktreeGitDir(worktreePath);
  const lockPath = path.join(gitDir, SETUP_LOCK);
  const markerPath = path.join(gitDir, SETUP_MARKER);
  const guardPath = path.join(gitDir, SETUP_GUARD);
  const guard = ownerRecord();
  try {
    createExclusive(guardPath, guard);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const other = readOwner(guardPath);
    if (!other || other.unreadable || isOwnerAlive(other)) {
      throw setupError("ORK_WORKTREE_SETUP_ACTIVE", "Another recovery is in progress");
    }
    renameSync(guardPath, `${guardPath}.stale-${Date.now()}-${randomBytes(3).toString("hex")}`);
    createExclusive(guardPath, guard);
  }
  const moved = [];
  const stamp = () => `interrupted-${Date.now()}-${randomBytes(3).toString("hex")}`;
  let ownLock = null;
  try {
    const owner = readOwner(lockPath);
    if (owner) {
      if (owner.unreadable || isOwnerAlive(owner)) {
        throw setupError(
          "ORK_WORKTREE_SETUP_ACTIVE",
          "Setup is still running in this worktree; recovery refused",
        );
      }
      const aside = `${lockPath}.${stamp()}`;
      renameSync(lockPath, aside);
      moved.push(aside);
    }
    const marker = readSetupMarker(gitDir);
    if (!owner && (!marker || marker.state !== "running")) {
      return { recovered: false, ...(marker && { state: marker.state }) };
    }
    // Hold a claim while the marker moves so a concurrent prepare cannot start in between.
    const record = ownerRecord();
    try {
      createExclusive(lockPath, record);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      throw setupError(
        "ORK_WORKTREE_SETUP_ACTIVE",
        "A setup claimed this worktree during recovery",
      );
    }
    ownLock = record.token;
    if (marker?.state === "running") {
      const aside = `${markerPath}.${stamp()}`;
      renameSync(markerPath, aside);
      moved.push(aside);
    }
    appendHistory(gitDir, { event: "recovered", moved: moved.map((file) => path.basename(file)) });
    return {
      recovered: true,
      movedTo: moved.find((file) => file.includes(SETUP_MARKER)) ?? moved[0],
      moved,
    };
  } finally {
    if (ownLock) releaseOwned(lockPath, ownLock);
    releaseOwned(guardPath, guard.token);
  }
}

function defaultRunWorker(request, { timeoutMs }) {
  const env = pick(request.env, WORKER_ENV_KEYS);
  const result = spawnSync(process.execPath, [WORKER_PATH], {
    input: JSON.stringify(request),
    env,
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.signal) {
    return {
      crashed: true,
      reason: result.error?.code || result.signal || result.error?.message,
    };
  }
  try {
    return { output: JSON.parse(result.stdout.trim().split("\n").at(-1)) };
  } catch {
    return { crashed: true, reason: `worker exited ${result.status} without a result` };
  }
}

/**
 * The one place every successful `git worktree add` finishes through: copies local includes,
 * creates configured links, allocates ports and runs trusted setup. Synchronous for its callers;
 * the asynchronous work (bind probes, setup process) runs in one bounded worker child, and only
 * when the checkout actually configures ports or an approved setup command.
 *
 * A failure keeps the worktree and throws an error with `stage: "bootstrap"`, a specific
 * `substage` (config, copy, link, ports, setup) and a `code`. Calling again retries safely.
 */
export function prepareWorktree(
  repoRoot,
  worktreePath,
  {
    slug = path.basename(worktreePath),
    env = process.env,
    overwrite = false,
    warn = (message) => process.stderr.write(`${message}\n`),
    runWorker = defaultRunWorker,
    setupTimeoutMs,
    claimWaitMs,
  } = {},
) {
  const parentCwd = path.resolve(repoRoot);
  const outcome = {
    copied: [],
    linked: [],
    ports: null,
    setup: { status: "none" },
    warnings: [],
  };

  let parsed;
  try {
    parsed = parseWorktreeConfig(parentCwd);
  } catch (error) {
    throw bootstrapFailure(worktreePath, "config", error);
  }
  const { config } = parsed;
  if (config.symlinkDirs.length > 0) {
    try {
      previewWorktreeLinks(parentCwd, worktreePath, config.symlinkDirs);
    } catch (error) {
      throw bootstrapFailure(worktreePath, "link", error);
    }
  }

  try {
    outcome.copied = bootstrapWorktreeInclude(parentCwd, worktreePath, {
      overwrite,
      extraIncludes: config.copyFiles,
    });
  } catch (error) {
    throw bootstrapFailure(worktreePath, "copy", error);
  }
  if (config.symlinkDirs.length > 0) {
    try {
      outcome.linked = linkWorktreeDirs(parentCwd, worktreePath, config.symlinkDirs);
    } catch (error) {
      throw bootstrapFailure(worktreePath, "link", error);
    }
  }

  let isWantsPorts = Boolean(config.ports);
  if (isWantsPorts) {
    // Reuse is a plain read; only a missing slot needs the helper's bind probes.
    try {
      const existing = listWorktreePorts({ repoRoot: parentCwd, worktreePath, env });
      const byName = new Map(existing.map((row) => [row.name, row.port]));
      if (config.ports.names.every((name) => byName.has(name))) {
        outcome.ports = Object.fromEntries(
          config.ports.names.map((name) => [name, byName.get(name)]),
        );
        isWantsPorts = false;
      }
    } catch (error) {
      throw bootstrapFailure(worktreePath, "ports", error);
    }
  }
  const requestedTimeout = Number(setupTimeoutMs ?? env?.ORKEST_WORKTREE_SETUP_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(requestedTimeout)
    ? Math.min(Math.max(requestedTimeout, 1000), MAX_SETUP_TIMEOUT_MS)
    : DEFAULT_SETUP_TIMEOUT_MS;
  let claim = null;
  let gitDir = null;
  if (config.setupCommand) {
    try {
      gitDir = worktreeGitDir(worktreePath);
      claim = acquireSetupClaim(gitDir, {
        waitMs: claimWaitMs ?? timeoutMs + WORKER_SLACK_MS * 2,
      });
    } catch (error) {
      throw bootstrapFailure(worktreePath, "setup", error);
    }
  }
  try {
    let isRunSetup = false;
    if (config.setupCommand) {
      try {
        const marker = readSetupMarker(gitDir);
        const isSameInputs =
          marker?.configSha256 === parsed.sha256 &&
          marker?.argvSha256 === digest(config.setupCommand);
        if (marker?.state === "running") {
          const error = new Error(
            `Setup for ${worktreePath} was interrupted and may have partly run. Inspect the worktree, then recover with recoverInterruptedSetup() (moves the marker aside) and retry.`,
          );
          error.code = "ORK_WORKTREE_SETUP_INTERRUPTED";
          throw error;
        }
        if (marker?.state === "done" && isSameInputs) {
          outcome.setup = { status: "already-done" };
        } else {
          const trust = evaluateSetupTrust(parsed, worktreePath, { env, firstRun: !marker });
          if (trust.trusted) {
            isRunSetup = true;
          } else {
            outcome.setup = { status: "skipped-untrusted", reason: trust.reason };
            const message = `Worktree setup skipped (${trust.reason}): approve it with "ork setup --trust-worktree --cwd ${parsed.repoRoot}"`;
            outcome.warnings.push(message);
            warn(message);
          }
        }
      } catch (error) {
        throw bootstrapFailure(worktreePath, "setup", error);
      }
    }

    if (!isWantsPorts && !isRunSetup) return outcome;

    const request = {
      repoRoot: parsed.repoRoot,
      worktreePath: path.resolve(worktreePath),
      slug,
      env: pick(env, WORKER_ENV_KEYS),
      ports: isWantsPorts ? config.ports : null,
      knownPorts: outcome.ports,
      claim: claim ? { lockPath: claim.lockPath, token: claim.token } : null,
      setup: null,
    };
    let marker = null;
    if (isRunSetup) {
      request.setup = {
        argv: config.setupCommand,
        timeoutMs,
        env: {
          ...pick(env, SETUP_ENV_KEYS),
          // Repo-local and relative PATH entries would let checkout files shadow trusted tools.
          PATH: trustedSetupPath(env?.PATH ?? process.env.PATH, [parsed.repoRoot, worktreePath]),
          ORKEST_REPO_ROOT: parsed.repoRoot,
          ORKEST_WORKTREE_PATH: path.resolve(worktreePath),
          ORKEST_WORKTREE_SLUG: String(slug),
        },
      };
      marker = {
        state: "running",
        configSha256: parsed.sha256,
        argvSha256: digest(config.setupCommand),
        startedAt: new Date().toISOString(),
        pid: process.pid,
      };
      try {
        writeSetupMarker(gitDir, marker);
        appendHistory(gitDir, { event: "setup-started", token: claim?.token });
      } catch (error) {
        throw bootstrapFailure(worktreePath, "setup", error);
      }
    }

    const result = runWorker(request, {
      timeoutMs: (isRunSetup ? timeoutMs : 0) + 10_000 + WORKER_SLACK_MS,
    });
    if (result.crashed) {
      const error = new Error(
        isRunSetup
          ? `Worktree helper died (${result.reason}) while setup may have been running; setup is marked interrupted`
          : `Worktree helper failed (${result.reason}) while allocating ports`,
      );
      error.code = isRunSetup ? "ORK_WORKTREE_SETUP_INTERRUPTED" : "ORK_PORTS_FAILED";
      throw bootstrapFailure(worktreePath, isRunSetup ? "setup" : "ports", error);
    }
    const { output } = result;
    outcome.ports = output.ports ?? outcome.ports;
    if (output.error) {
      if (isRunSetup)
        writeSetupMarker(gitDir, { ...marker, state: "failed", failedBefore: "ports" });
      const error = new Error(output.error.message);
      error.code = output.error.code;
      throw bootstrapFailure(worktreePath, output.error.substage || "ports", error);
    }
    if (isRunSetup) {
      const setup = output.setup;
      outcome.setup = {
        status: setup.status,
        exitCode: setup.exitCode,
        outputTail: setup.outputTail,
      };
      appendHistory(gitDir, {
        event: "setup-finished",
        status: setup.status,
        exitCode: setup.exitCode ?? null,
      });
      if (setup.status === "done") {
        writeSetupMarker(gitDir, {
          ...marker,
          state: "done",
          finishedAt: new Date().toISOString(),
        });
      } else {
        writeSetupMarker(gitDir, {
          ...marker,
          state: "failed",
          exitCode: setup.exitCode ?? null,
          finishedAt: new Date().toISOString(),
        });
        const error = new Error(
          `Setup command ${setup.status === "timeout" ? "timed out" : `exited with ${setup.exitCode ?? setup.error}`}. Output tail:\n${setup.outputTail}`,
        );
        error.code =
          setup.status === "timeout" ? "ORK_WORKTREE_SETUP_TIMEOUT" : "ORK_WORKTREE_SETUP_FAILED";
        throw bootstrapFailure(worktreePath, "setup", error);
      }
    }
    return outcome;
  } finally {
    claim?.release();
  }
}
