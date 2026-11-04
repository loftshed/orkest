import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = path.resolve(__dirname, "..", "skills", "orchestrate", "scripts");
const RUN_AGENT_SCRIPT = path.join(SCRIPTS_DIR, "run_agent.py");

export const CLEANUP_SCHEMA = "ork.cleanup.v1";
export const DEFAULT_GRACE_MINUTES = 15;
export const DEFAULT_KEEP_BACKUPS = 1;
export const DEFAULT_OLDER_THAN = "14d";

export function cleanupHelpText() {
  return [
    "Usage: ork cleanup [status|run] [options]",
    "",
    "Audit, prune, and optionally migrate legacy Orkest / agent-executor state.",
    "",
    "Actions:",
    "  status                  Read-only audit of reclaimable state and legacy paths",
    "  run                     Execute cleanup (default when action is omitted)",
    "",
    "Options:",
    "  --dry-run, -n           Preview what would be pruned or migrated without mutating",
    "  --migrate-legacy        Atomically migrate ~/.cache/agent-executor and ~/.config/agent-executor",
    "                          to ~/.cache/orchestrate and ~/.config/orchestrate with symlinks",
    "  --grace-minutes <min>   Minimum age in minutes before pruning locks/worktrees/runtimes (default: 15)",
    "  --keep-backups <count>  Number of newest .mailbox-bak.* backups to retain per file (default: 1)",
    "  --older-than <duration> Cutoff passed to run_agent.py prune (default: 14d)",
    "  --cwd <dir>             Repository working directory for worktree repair/inspection",
    "  --json                  Output structured JSON (schema: ork.cleanup.v1)",
    "  --help, -h              Show this help message",
  ].join("\n");
}

export function parseCleanupArgs(argv = [], context = {}) {
  const args = Array.isArray(argv) ? [...argv] : [];
  let action = null;
  let isDryRun = false;
  let isMigrateLegacy = false;
  let graceMinutes = DEFAULT_GRACE_MINUTES;
  let keepBackups = DEFAULT_KEEP_BACKUPS;
  let olderThan = DEFAULT_OLDER_THAN;
  let isJson = false;
  let isHelp = false;
  let cwd = path.resolve(context.cwd || process.cwd());

  for (let i = 0; i < args.length; i += 1) {
    const token = String(args[i] ?? "");
    if (token === "--help" || token === "-h") {
      isHelp = true;
      continue;
    }
    if (token === "--dry-run" || token === "-n") {
      isDryRun = true;
      continue;
    }
    if (token === "--migrate-legacy") {
      isMigrateLegacy = true;
      continue;
    }
    if (token === "--json") {
      isJson = true;
      continue;
    }
    if (token === "--grace-minutes" || token.startsWith("--grace-minutes=")) {
      const raw = token.includes("=") ? token.slice("--grace-minutes=".length) : args[++i];
      const parsed = Number(raw);
      if (raw === undefined || !Number.isFinite(parsed) || parsed < 0) {
        const err = new Error(`Invalid --grace-minutes value: ${raw ?? ""}`);
        err.exitCode = 2;
        throw err;
      }
      graceMinutes = parsed;
      continue;
    }
    if (token === "--keep-backups" || token.startsWith("--keep-backups=")) {
      const raw = token.includes("=") ? token.slice("--keep-backups=".length) : args[++i];
      const parsed = Number(raw);
      if (raw === undefined || !Number.isSafeInteger(parsed) || parsed < 0) {
        const err = new Error(`Invalid --keep-backups value: ${raw ?? ""}`);
        err.exitCode = 2;
        throw err;
      }
      keepBackups = parsed;
      continue;
    }
    if (token === "--older-than" || token.startsWith("--older-than=")) {
      const raw = token.includes("=") ? token.slice("--older-than=".length) : args[++i];
      if (!raw || !String(raw).trim()) {
        const err = new Error("Missing value for --older-than");
        err.exitCode = 2;
        throw err;
      }
      olderThan = String(raw).trim();
      continue;
    }
    if (token === "--cwd" || token.startsWith("--cwd=")) {
      const raw = token.includes("=") ? token.slice("--cwd=".length) : args[++i];
      if (!raw || !String(raw).trim()) {
        const err = new Error("Missing value for --cwd");
        err.exitCode = 2;
        throw err;
      }
      cwd = path.resolve(String(raw).trim());
      continue;
    }
    if (token.startsWith("-")) {
      const err = new Error(`Unknown cleanup option: ${token}`);
      err.exitCode = 2;
      throw err;
    }
    if (action === null && (token === "status" || token === "run")) {
      action = token;
      continue;
    }
    const err = new Error(`Unknown cleanup action or argument: ${token}`);
    err.exitCode = 2;
    throw err;
  }

  const resolvedAction = action || "run";
  const resolvedDryRun = resolvedAction === "status" || isDryRun;

  return {
    action: resolvedAction,
    dryRun: resolvedDryRun,
    migrateLegacy: isMigrateLegacy,
    graceMinutes,
    graceMs: Math.round(graceMinutes * 60 * 1000),
    keepBackups,
    olderThan,
    json: isJson,
    help: isHelp,
    cwd,
  };
}

function lstatSafe(targetPath) {
  try {
    return fs.lstatSync(targetPath);
  } catch {
    return null;
  }
}

function statSafe(targetPath) {
  try {
    return fs.statSync(targetPath);
  } catch {
    return null;
  }
}

function realpathSafe(targetPath) {
  try {
    return fs.realpathSync(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

export function isPidAlive(pid) {
  const num = Number(pid);
  if (!Number.isSafeInteger(num) || num <= 0) {
    return false;
  }
  try {
    process.kill(num, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function treeSizeBytes(targetPath) {
  const st = lstatSafe(targetPath);
  if (!st) {
    return 0;
  }
  if (st.isSymbolicLink() || st.isFile()) {
    return st.size || 0;
  }
  if (!st.isDirectory()) {
    return 0;
  }
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(targetPath);
  } catch {
    return 0;
  }
  for (const name of entries) {
    total += treeSizeBytes(path.join(targetPath, name));
  }
  return total;
}

export function resolveCleanupPaths(context = {}) {
  const env = context.env || process.env;
  const homeDir = path.resolve(context.homeDir || env.HOME || os.homedir());
  const xdgCacheBase = path.resolve(
    context.xdgCacheHome || env.XDG_CACHE_HOME || path.join(homeDir, ".cache"),
  );
  const xdgConfigBase = path.resolve(
    context.xdgConfigHome || env.XDG_CONFIG_HOME || path.join(homeDir, ".config"),
  );
  const xdgDatabase = path.resolve(
    context.xdgDataHome || env.XDG_DATA_HOME || path.join(homeDir, ".local", "share"),
  );

  const orchestrateCacheDir = path.join(xdgCacheBase, "orchestrate");
  const legacyCacheDir = path.join(xdgCacheBase, "agent-executor");
  const orchestrateConfigDir = path.join(xdgConfigBase, "orchestrate");
  const legacyConfigDir = path.join(xdgConfigBase, "agent-executor");

  let cacheHome;
  const explicitCache = context.cacheHome || env.ORCHESTRATE_HOME || env.AGENT_EXECUTOR_HOME;
  if (explicitCache) {
    cacheHome = path.resolve(explicitCache);
  } else if (fs.existsSync(orchestrateCacheDir) || !fs.existsSync(legacyCacheDir)) {
    cacheHome = orchestrateCacheDir;
  } else {
    cacheHome = legacyCacheDir;
  }

  let configHome;
  const explicitConfig =
    context.configHome || env.ORCHESTRATE_CONFIG_HOME || env.AGENT_EXECUTOR_CONFIG_HOME;
  if (explicitConfig) {
    configHome = path.resolve(explicitConfig);
  } else if (fs.existsSync(orchestrateConfigDir) || !fs.existsSync(legacyConfigDir)) {
    configHome = orchestrateConfigDir;
  } else {
    configHome = legacyConfigDir;
  }

  return {
    homeDir,
    xdgCacheBase,
    xdgConfigBase,
    xdgDatabase,
    orchestrateCacheDir,
    legacyCacheDir,
    orchestrateConfigDir,
    legacyConfigDir,
    cacheHome,
    configHome,
  };
}

function parseLockHolder(lockPath) {
  try {
    const raw = fs.readFileSync(lockPath, "utf8").trim();
    if (!raw) {
      return { pid: null, released: false, forceHeld: false, raw: "" };
    }
    if (/^\d+$/.test(raw)) {
      return { pid: Number(raw), released: false, forceHeld: false, raw };
    }
    const parsed = JSON.parse(raw);
    return {
      pid: parsed?.pid !== undefined && parsed?.pid !== null ? Number(parsed.pid) : null,
      released: Boolean(parsed?.released),
      forceHeld: Boolean(parsed?.forceHeld),
      acquiredAt: parsed?.acquiredAt || null,
      birthEpochMs: Number.isFinite(parsed?.birthEpochMs) ? Number(parsed.birthEpochMs) : null,
      worktree:
        parsed?.worktree ||
        parsed?.worktreePath ||
        parsed?.cwd ||
        parsed?.repo ||
        parsed?.path ||
        null,
      runId: parsed?.runId || parsed?.run || parsed?.session || null,
      raw,
    };
  } catch {
    return { pid: null, released: false, forceHeld: false, raw: "" };
  }
}

function isFlockHeldByAnotherProcess(lockPath) {
  if (!fs.existsSync(lockPath)) {
    return false;
  }
  const py = spawnSync(
    "python3",
    [
      "-c",
      [
        "import fcntl, sys",
        "path = sys.argv[1]",
        "with open(path, 'a+b') as f:",
        "    try:",
        "        fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)",
        "        fcntl.flock(f.fileno(), fcntl.LOCK_UN)",
        "    except OSError:",
        "        sys.exit(11)",
      ].join("\n"),
      lockPath,
    ],
    { encoding: "utf8", timeout: 3000 },
  );
  return py.status === 11;
}

function writeLockInPlace(lockPath, payloadObj) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const payload = JSON.stringify(payloadObj) + "\n";
  const fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_RDWR, 0o600);
  try {
    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, payload, 0, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function isCleanupLockHeld(lockPath, { graceMs = 900_000, nowMs = Date.now() } = {}) {
  const existingStat = lstatSafe(lockPath);
  if (!existingStat) {
    return false;
  }
  const holder = parseLockHolder(lockPath);
  if (holder.released && !isFlockHeldByAnotherProcess(lockPath)) {
    return false;
  }
  const hasLivePid = holder.forceHeld || (holder.pid && isPidAlive(holder.pid));
  const isFlockHeld = isFlockHeldByAnotherProcess(lockPath);
  const ageMs = Math.max(0, nowMs - existingStat.mtimeMs);
  return Boolean(hasLivePid || isFlockHeld || (!holder.pid && !holder.released && ageMs < graceMs));
}

function withCleanupMutexGate(lockPath, fn, { staleGateMs = 5000 } = {}) {
  const gatePath = `${lockPath}.gate`;
  fs.mkdirSync(path.dirname(gatePath), { recursive: true, mode: 0o700 });
  let gateFd = null;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    try {
      gateFd = fs.openSync(
        gatePath,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
        0o600,
      );
      const gatePayload = JSON.stringify({ pid: process.pid, createdAtMs: Date.now() }) + "\n";
      fs.writeSync(gateFd, gatePayload, 0, "utf8");
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      const gateStat = lstatSafe(gatePath);
      const gateHolder = parseLockHolder(gatePath);
      const gateAge = gateStat ? Math.max(0, Date.now() - gateStat.mtimeMs) : 0;
      const deadHolder = gateHolder.pid && !isPidAlive(gateHolder.pid);
      if (deadHolder || (!gateHolder.pid && gateAge > staleGateMs) || gateAge > staleGateMs * 6) {
        try {
          fs.unlinkSync(gatePath);
          continue;
        } catch {
          // Concurrent reclaim; retry
        }
      }
      if (attempt < 24) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
  }
  if (gateFd === null) {
    const err = new Error(
      `Another ork cleanup process is already acquiring lock (gate: ${gatePath})`,
    );
    err.code = "CLEANUP_LOCKED";
    err.exitCode = 1;
    throw err;
  }
  try {
    return fn();
  } finally {
    try {
      fs.closeSync(gateFd);
    } catch {
      // Ignore
    }
    try {
      fs.unlinkSync(gatePath);
    } catch {
      // Ignore
    }
  }
}

export function acquireCleanupLock(
  lockPath,
  { dryRun = false, graceMs = 900_000, nowMs = Date.now() } = {},
) {
  const lockToken = crypto.randomUUID();
  withCleanupMutexGate(lockPath, () => {
    if (isCleanupLockHeld(lockPath, { graceMs, nowMs })) {
      const err = new Error(`Another ork cleanup process is already running (lock: ${lockPath})`);
      err.code = "CLEANUP_LOCKED";
      err.exitCode = 1;
      throw err;
    }

    if (!dryRun) {
      // Never unlink singleton cleanup.lock; overwrite in-place on the same inode inside the atomic mutex gate.
      writeLockInPlace(lockPath, {
        pid: process.pid,
        lockToken,
        released: false,
        acquiredAt: new Date(nowMs).toISOString(),
        birthEpochMs: nowMs,
      });
    }
  });

  if (dryRun) {
    return {
      lockPath,
      acquired: false,
      dryRun: true,
      release() {},
    };
  }

  let isReleased = false;
  return {
    lockPath,
    lockToken,
    acquired: true,
    dryRun: false,
    release(alternatePaths = []) {
      if (isReleased) {
        return;
      }
      isReleased = true;
      const seenRealpaths = new Set();
      for (const candidate of [lockPath, ...alternatePaths]) {
        try {
          if (!candidate || !fs.existsSync(candidate)) {
            continue;
          }
          const real = realpathSafe(candidate);
          if (seenRealpaths.has(real)) {
            continue;
          }
          seenRealpaths.add(real);
          withCleanupMutexGate(candidate, () => {
            const current = parseLockHolder(candidate);
            if (current.released || !current.pid || current.pid === process.pid) {
              writeLockInPlace(candidate, {
                pid: null,
                released: true,
                releasedByPid: process.pid,
                releasedAt: new Date().toISOString(),
              });
            }
          });
        } catch {
          // Best-effort in-place release
        }
      }
    },
  };
}

function mergeDirectoryContents(
  srcDir,
  dstDir,
  { relPrefix = "", conflicts = [], dryRun = false } = {},
) {
  if (!dryRun) {
    fs.mkdirSync(dstDir, { recursive: true, mode: 0o700 });
  }
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    const srcPath = path.join(srcDir, entry.name);
    const dstPath = path.join(dstDir, entry.name);
    const dstStat = lstatSafe(dstPath);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      if (dstStat && dstStat.isDirectory() && !dstStat.isSymbolicLink()) {
        mergeDirectoryContents(srcPath, dstPath, { relPrefix: relPath, conflicts, dryRun });
        if (!dryRun) {
          try {
            if (fs.readdirSync(srcPath).length === 0) {
              fs.rmdirSync(srcPath);
            }
          } catch {
            // Keep non-empty directory when conflicts remain inside
          }
        }
      } else if (dstStat) {
        // Directory in legacyDir conflicts with non-directory in dstDir: preserve both
        conflicts.push(relPath);
      } else {
        if (!dryRun) {
          fs.renameSync(srcPath, dstPath);
        }
      }
    } else if (!dstStat) {
      if (!dryRun) {
        fs.renameSync(srcPath, dstPath);
      }
    } else if (dstStat.isDirectory() && !dstStat.isSymbolicLink()) {
      // File/symlink in legacyDir conflicts with directory in dstDir: preserve both
      conflicts.push(relPath);
    } else if (entry.isSymbolicLink() && dstStat.isSymbolicLink()) {
      const srcTarget = fs.readlinkSync(srcPath);
      const dstTarget = fs.readlinkSync(dstPath);
      if (srcTarget === dstTarget) {
        if (!dryRun) {
          fs.unlinkSync(srcPath);
        }
      } else {
        conflicts.push(relPath);
      }
    } else if (entry.isFile() && dstStat.isFile() && !dstStat.isSymbolicLink()) {
      const srcBuf = fs.readFileSync(srcPath);
      const dstBuf = fs.readFileSync(dstPath);
      if (Buffer.compare(srcBuf, dstBuf) === 0) {
        if (!dryRun) {
          fs.unlinkSync(srcPath);
        }
      } else {
        conflicts.push(relPath);
      }
    } else {
      conflicts.push(relPath);
    }
  }
  return conflicts;
}

function atomicRenameSwapWithSymlink(legacyDir, newDir, symlinkTarget = "orchestrate") {
  const pyCode = [
    "import ctypes, os, sys",
    "legacy_dir, new_dir, target = sys.argv[1], sys.argv[2], sys.argv[3]",
    "os.symlink(target, new_dir)",
    "if sys.platform == 'darwin':",
    "    posix_lib = ctypes.CDLL(None, use_errno=True)",
    "    rc = posix_lib.renamex_np(os.fsencode(legacy_dir), os.fsencode(new_dir), 0x00000002)",
    "    if rc == 0:",
    "        print('rename_swap')",
    "        sys.exit(0)",
    "os.unlink(new_dir)",
    "sys.exit(2)",
  ].join("\n");

  const res = spawnSync("python3", ["-c", pyCode, legacyDir, newDir, symlinkTarget], {
    encoding: "utf8",
    timeout: 5000,
  });

  if (
    res.status === 0 &&
    lstatSafe(legacyDir)?.isSymbolicLink() &&
    lstatSafe(newDir)?.isDirectory()
  ) {
    return "rename_swap";
  }

  // Clean up any temporary symlink at newDir before portable fallback
  if (lstatSafe(newDir)?.isSymbolicLink()) {
    try {
      fs.unlinkSync(newDir);
    } catch {
      // Ignore
    }
  }
  fs.renameSync(legacyDir, newDir);
  const tmpLink = `${legacyDir}.tmp-link.${process.pid}`;
  try {
    fs.unlinkSync(tmpLink);
  } catch {
    // Ignore
  }
  fs.symlinkSync(symlinkTarget, tmpLink);
  fs.renameSync(tmpLink, legacyDir);
  return "rename_then_symlink";
}

export function migrateLegacyDirectory(
  legacyDir,
  newDir,
  { dryRun = false, symlinkTarget = "orchestrate" } = {},
) {
  const legacyStat = lstatSafe(legacyDir);
  const newStat = lstatSafe(newDir);

  if (legacyStat?.isSymbolicLink()) {
    const linkValue = fs.readlinkSync(legacyDir);
    const resolvedTarget = path.resolve(path.dirname(legacyDir), linkValue);
    if (resolvedTarget === path.resolve(newDir) && newStat?.isDirectory()) {
      return {
        status: "already_migrated",
        strategy: "none",
        from: legacyDir,
        to: newDir,
        symlinkTarget: linkValue,
        changed: false,
      };
    }
  }

  if (!legacyStat) {
    if (dryRun) {
      return {
        status: newStat?.isDirectory() ? "would_link" : "would_create_and_link",
        strategy: "symlink",
        from: legacyDir,
        to: newDir,
        symlinkTarget,
        changed: true,
      };
    }
    fs.mkdirSync(newDir, { recursive: true, mode: 0o700 });
    fs.symlinkSync(symlinkTarget, legacyDir);
    return {
      status: newStat?.isDirectory() ? "linked" : "created_and_linked",
      strategy: "symlink",
      from: legacyDir,
      to: newDir,
      symlinkTarget,
      changed: true,
    };
  }

  if (legacyStat.isDirectory() && !newStat) {
    if (dryRun) {
      return {
        status: "would_migrate",
        strategy: "rename_swap",
        from: legacyDir,
        to: newDir,
        symlinkTarget,
        changed: true,
      };
    }
    fs.mkdirSync(path.dirname(newDir), { recursive: true, mode: 0o700 });
    const strategy = atomicRenameSwapWithSymlink(legacyDir, newDir, symlinkTarget);
    return {
      status: "migrated",
      strategy,
      from: legacyDir,
      to: newDir,
      symlinkTarget,
      changed: true,
    };
  }

  if (legacyStat.isDirectory() && newStat?.isDirectory()) {
    const conflicts = mergeDirectoryContents(legacyDir, newDir, { dryRun });
    if (conflicts.length > 0) {
      return {
        status: dryRun ? "would_conflict_preserve" : "conflict_preserved",
        strategy: "merge_conflict_preserved",
        from: legacyDir,
        to: newDir,
        symlinkTarget,
        changed: !dryRun,
        legacyDataPreserved: true,
        conflicts,
      };
    }
    if (dryRun) {
      return {
        status: "would_merge_and_migrate",
        strategy: "merge_and_swap",
        from: legacyDir,
        to: newDir,
        symlinkTarget,
        changed: true,
        conflicts: [],
      };
    }
    fs.rmSync(legacyDir, { recursive: true, force: true });
    const tmpLink = `${legacyDir}.tmp-link.${process.pid}`;
    fs.symlinkSync(symlinkTarget, tmpLink);
    fs.renameSync(tmpLink, legacyDir);
    return {
      status: "merged_and_migrated",
      strategy: "merge_and_swap",
      from: legacyDir,
      to: newDir,
      symlinkTarget,
      changed: true,
      conflicts: [],
    };
  }

  return {
    status: "skipped",
    strategy: "none",
    from: legacyDir,
    to: newDir,
    symlinkTarget,
    changed: false,
  };
}

function discoverWorktreeParentRepo(wtDir, fallbackCwd) {
  const metaPath = path.join(wtDir, "meta.json");
  if (fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      const candidate = meta?.parentCwd || meta?.repository || meta?.repoRoot || meta?.cwd;
      if (candidate && fs.existsSync(candidate)) {
        return path.resolve(candidate);
      }
    } catch {
      // Ignore invalid meta.json
    }
  }
  const dotGitPath = path.join(wtDir, ".git");
  const st = lstatSafe(dotGitPath);
  if (st?.isFile()) {
    try {
      const content = fs.readFileSync(dotGitPath, "utf8").trim();
      const match = content.match(/^gitdir:\s*(.+)$/m);
      if (match) {
        const gitdir = path.resolve(wtDir, match[1].trim());
        const worktreesDir = path.dirname(gitdir);
        const mainDotGit = path.dirname(worktreesDir);
        if (path.basename(worktreesDir) === "worktrees" && path.basename(mainDotGit) === ".git") {
          const parentRepo = path.dirname(mainDotGit);
          if (fs.existsSync(parentRepo)) {
            return parentRepo;
          }
        }
      }
    } catch {
      // Ignore unreadable .git file
    }
  }
  if (fallbackCwd && fs.existsSync(path.join(fallbackCwd, ".git"))) {
    return path.resolve(fallbackCwd);
  }
  return null;
}

export function repairWorktreesAfterMigration(
  cacheDir,
  { dryRun = false, cwd = process.cwd() } = {},
) {
  const worktreesRoot = path.join(cacheDir, "worktrees");
  if (!fs.existsSync(worktreesRoot)) {
    return [];
  }
  const repaired = [];
  let entries;
  try {
    entries = fs.readdirSync(worktreesRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) {
      continue;
    }
    const wtPath = path.join(worktreesRoot, entry.name);
    const canonicalWtPath = realpathSafe(wtPath);
    const parentRepo = discoverWorktreeParentRepo(wtPath, cwd);
    if (!parentRepo) {
      continue;
    }
    if (dryRun) {
      repaired.push({
        worktree: canonicalWtPath,
        parentRepo,
        status: "would_repair",
      });
      continue;
    }
    const gitRepair = spawnSync("git", ["-C", parentRepo, "worktree", "repair", canonicalWtPath], {
      encoding: "utf8",
      timeout: 10_000,
    });
    const metaPath = path.join(canonicalWtPath, "meta.json");
    if (fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
        let isUpdated = false;
        for (const key of ["worktreePath", "path"]) {
          if (typeof meta[key] !== "string" || meta[key] === canonicalWtPath) {
            continue;
          }

          meta[key] = canonicalWtPath;
          isUpdated = true;
        }
        if (isUpdated) {
          fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n", "utf8");
        }
      } catch {
        // Ignore meta update errors
      }
    }
    repaired.push({
      worktree: canonicalWtPath,
      parentRepo,
      status: gitRepair.status === 0 ? "repaired" : "repair_failed",
      exitCode: gitRepair.status ?? 1,
    });
  }
  return repaired;
}

function collectActiveRunIds(cacheHome) {
  const activeRunIds = new Set();
  for (const dirName of ["runs-v1", "jobs-v1"]) {
    const dirPath = path.join(cacheHome, dirName);
    if (!fs.existsSync(dirPath)) {
      continue;
    }
    let entries;
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const resPath = path.join(dirPath, entry.name, "result.json");
      if (fs.existsSync(resPath)) {
        continue;
      }
      const st = statSafe(path.join(dirPath, entry.name));
      if (st && Date.now() - st.mtimeMs < 60 * 60 * 1000) {
        activeRunIds.add(entry.name);
      }
    }
  }
  const peersDir = path.join(cacheHome, "mailbox-v1", "peers");
  if (fs.existsSync(peersDir)) {
    try {
      for (const file of fs.readdirSync(peersDir)) {
        if (!file.endsWith(".json")) {
          continue;
        }
        const peer = JSON.parse(fs.readFileSync(path.join(peersDir, file), "utf8"));
        if (!(peer?.pid && isPidAlive(peer.pid))) {
          continue;
        }

        if (peer.run) {
          activeRunIds.add(String(peer.run));
        }
        if (peer.session) {
          activeRunIds.add(String(peer.session));
        }
      }
    } catch {
      // Ignore unreadable peer files
    }
  }
  return activeRunIds;
}

function resolveBaseRefForWorktree(wtDir, parentRepo, meta) {
  const candidates = [];
  if (meta?.baseBranch) {
    candidates.push(String(meta.baseBranch));
  }
  if (meta?.targetBranch) {
    candidates.push(String(meta.targetBranch));
  }
  if (meta?.baseCommit) {
    candidates.push(String(meta.baseCommit));
  }
  candidates.push("main", "master");

  for (const ref of candidates) {
    const commitSelector = [ref, "^{commit}"].join("");
    const verify = spawnSync(
      "git",
      ["-C", wtDir, "rev-parse", "--verify", "--quiet", commitSelector],
      {
        encoding: "utf8",
        timeout: 5000,
      },
    );
    if (verify.status === 0 && verify.stdout.trim()) {
      return verify.stdout.trim();
    }
  }

  if (parentRepo && fs.existsSync(parentRepo)) {
    const parentHead = spawnSync(
      "git",
      ["-C", parentRepo, "rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
      {
        encoding: "utf8",
        timeout: 5000,
      },
    );
    if (parentHead.status === 0 && parentHead.stdout.trim()) {
      return parentHead.stdout.trim();
    }
  }
  return null;
}

const LOCK_SUBDIRS = ["worktree-locks-v1", "locks", "coordinator-locks"];
const PRUNABLE_LOCK_SUBDIRS = ["locks", "coordinator-locks"];

function sha256Hex(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function isLockEntryActive(lockFile, st, { graceMs = 900_000, nowMs = Date.now() } = {}) {
  const holder = parseLockHolder(lockFile);
  if (holder.released && !isFlockHeldByAnotherProcess(lockFile)) {
    return false;
  }
  const hasLivePid = Boolean(holder.forceHeld || (holder.pid && isPidAlive(holder.pid)));
  const isFlockHeld = isFlockHeldByAnotherProcess(lockFile);
  const ageMs = Math.max(0, nowMs - st.mtimeMs);
  const isRecentUnclaimed = !holder.pid && !holder.released && ageMs < graceMs;
  return Boolean(hasLivePid || isFlockHeld || isRecentUnclaimed);
}

export function hasActiveWorktreeLease(
  cacheHome,
  wtDir,
  entryNameOrMeta = null,
  maybeMeta = null,
  { graceMs = 900_000, nowMs = Date.now() } = {},
) {
  const entryName =
    typeof entryNameOrMeta === "string" && entryNameOrMeta
      ? entryNameOrMeta
      : path.basename(path.resolve(wtDir));
  const meta =
    typeof entryNameOrMeta === "object" && entryNameOrMeta !== null ? entryNameOrMeta : maybeMeta;
  const wtAbs = path.resolve(wtDir);
  const wtReal = realpathSafe(wtDir);
  const hashCandidates = new Set([
    sha256Hex(wtAbs).slice(0, 16),
    sha256Hex(wtReal).slice(0, 16),
    sha256Hex(wtAbs),
    sha256Hex(wtReal),
  ]);
  const tokenCandidates = new Set(
    [entryName, meta?.slug, meta?.id, meta?.runId, meta?.session, meta?.taskId]
      .filter(Boolean)
      .map(String),
  );

  for (const subDir of LOCK_SUBDIRS) {
    const lockDir = path.join(cacheHome, subDir);
    if (!fs.existsSync(lockDir)) {
      continue;
    }
    let files;
    try {
      files = fs.readdirSync(lockDir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".lock") || file === "cleanup.lock") {
        continue;
      }
      const lockPath = path.join(lockDir, file);
      const st = statSafe(lockPath);
      if (!st) {
        continue;
      }
      const stem = file.slice(0, -".lock".length);
      const holder = parseLockHolder(lockPath);
      const isMatchesHash = hashCandidates.has(stem);
      const isMatchesToken =
        tokenCandidates.has(stem) ||
        [...tokenCandidates].some(
          (tok) => tok && (stem.includes(tok) || (holder.runId && String(holder.runId) === tok)),
        );
      const matchesPath =
        (holder.worktree &&
          (path.resolve(holder.worktree) === wtAbs || realpathSafe(holder.worktree) === wtReal)) ||
        (holder.raw &&
          (holder.raw.includes(wtAbs) ||
            holder.raw.includes(wtReal) ||
            holder.raw.includes(entryName)));

      if (
        (isMatchesHash || isMatchesToken || matchesPath) &&
        isLockEntryActive(lockPath, st, { graceMs, nowMs })
      ) {
        return true;
      }
    }
  }
  return false;
}

export function pruneStaleLocks(
  cacheHome,
  { dryRun = false, graceMs = 900_000, nowMs = Date.now() } = {},
) {
  const pruned = [];
  const kept = [];
  let bytesReclaimed = 0;

  // Never unlink persistent flock targets in worktree-locks-v1; record their inodes in kept.
  const wtLockDir = path.join(cacheHome, "worktree-locks-v1");
  if (fs.existsSync(wtLockDir)) {
    try {
      const sortedWtLocks = fs.readdirSync(wtLockDir).sort((a, b) => a.localeCompare(b));
      for (const file of sortedWtLocks) {
        if (file.endsWith(".lock")) {
          kept.push(path.join(wtLockDir, file));
        }
      }
    } catch {
      // Ignore unreadable worktree-locks-v1
    }
  }

  for (const subDir of PRUNABLE_LOCK_SUBDIRS) {
    const lockDir = path.join(cacheHome, subDir);
    if (!fs.existsSync(lockDir)) {
      continue;
    }
    let files;
    try {
      files = fs.readdirSync(lockDir).sort((a, b) => a.localeCompare(b));
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".lock") || file === "cleanup.lock") {
        continue;
      }
      const lockPath = path.join(lockDir, file);
      const st = statSafe(lockPath);
      if (!st) {
        continue;
      }
      const ageMs = Math.max(0, nowMs - st.mtimeMs);
      if (ageMs < graceMs || isLockEntryActive(lockPath, st, { graceMs, nowMs })) {
        kept.push(lockPath);
        continue;
      }
      const size = st.size || 0;
      bytesReclaimed += size;
      pruned.push(lockPath);
      if (!dryRun) {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // Ignore concurrent removal
        }
      }
    }
  }

  return { pruned, kept, bytesReclaimed };
}

function inspectGitWorktreeRegistration(parentRepo, wtDir) {
  const wtAbs = path.resolve(wtDir);
  const wtReal = realpathSafe(wtDir);
  let isRegistered = false;
  let isLocked = false;

  // 1. Check .git file pointer in wtDir -> <repo>/.git/worktrees/<name>/locked
  const dotGitPath = path.join(wtDir, ".git");
  const dotGitStat = lstatSafe(dotGitPath);
  if (dotGitStat?.isFile()) {
    try {
      const content = fs.readFileSync(dotGitPath, "utf8").trim();
      const match = content.match(/^gitdir:\s*(.+)$/m);
      if (match) {
        const gitdir = path.resolve(wtDir, match[1].trim());
        if (fs.existsSync(gitdir)) {
          isRegistered = true;
          if (fs.existsSync(path.join(gitdir, "locked"))) {
            isLocked = true;
          }
        }
      }
    } catch {
      // Ignore unreadable .git file
    }
  }

  if (parentRepo && fs.existsSync(parentRepo)) {
    // 2. Check <parentRepo>/.git/worktrees/<entry> metadata directly
    const gitWorktreesDir = path.join(parentRepo, ".git", "worktrees");
    if (fs.existsSync(gitWorktreesDir)) {
      try {
        for (const entryName of fs.readdirSync(gitWorktreesDir)) {
          const adminDir = path.join(gitWorktreesDir, entryName);
          const gitdirFile = path.join(adminDir, "gitdir");
          let isMatchesEntry = entryName === path.basename(wtAbs);
          if (!isMatchesEntry && fs.existsSync(gitdirFile)) {
            const targetDotGit = path.resolve(adminDir, fs.readFileSync(gitdirFile, "utf8").trim());
            const targetWt = path.dirname(targetDotGit);
            if (targetWt === wtAbs || realpathSafe(targetWt) === wtReal) {
              isMatchesEntry = true;
            }
          }
          if (!isMatchesEntry) {
            continue;
          }

          isRegistered = true;
          if (fs.existsSync(path.join(adminDir, "locked"))) {
            isLocked = true;
          }
        }
      } catch {
        // Ignore
      }
    }

    // 3. Check `git worktree list --porcelain`
    const listRes = spawnSync("git", ["-C", parentRepo, "worktree", "list", "--porcelain"], {
      encoding: "utf8",
      timeout: 5000,
    });
    if (listRes.status === 0 && listRes.stdout) {
      const blocks = listRes.stdout.trim().split(/\n\s*\n/);
      for (const block of blocks) {
        const lines = block.split("\n").map((l) => l.trim());
        const wtLine = lines.find((l) => l.startsWith("worktree "));
        if (!wtLine) {
          continue;
        }
        const listedPath = wtLine.slice("worktree ".length).trim();
        if (!(path.resolve(listedPath) === wtAbs || realpathSafe(listedPath) === wtReal)) {
          continue;
        }

        isRegistered = true;
        if (lines.some((l) => l === "locked" || l.startsWith("locked "))) {
          isLocked = true;
        }
      }
    }
  }

  return { registered: isRegistered, locked: isLocked };
}

export function pruneDisposableWorktrees(
  cacheHome,
  { dryRun = false, graceMs = 900_000, cwd = process.cwd(), nowMs = Date.now() } = {},
) {
  const worktreesRoot = path.join(cacheHome, "worktrees");
  const pruned = [];
  const kept = [];
  let bytesReclaimed = 0;

  if (!fs.existsSync(worktreesRoot)) {
    return { pruned, kept, bytesReclaimed };
  }

  const activeRunIds = collectActiveRunIds(cacheHome);
  let entries;
  try {
    entries = fs.readdirSync(worktreesRoot, { withFileTypes: true });
  } catch {
    return { pruned, kept, bytesReclaimed };
  }

  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) {
      continue;
    }
    const wtDir = path.join(worktreesRoot, entry.name);
    const st = statSafe(wtDir);
    if (!st) {
      continue;
    }

    let meta = null;
    const metaPath = path.join(wtDir, "meta.json");
    if (fs.existsSync(metaPath)) {
      try {
        meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      } catch {
        meta = null;
      }
    }

    if (meta && (meta.disposable === false || meta.keep === true)) {
      kept.push({ path: wtDir, name: entry.name, reason: "non_disposable" });
      continue;
    }

    const ageMs = Math.max(0, nowMs - st.mtimeMs);
    if (ageMs < graceMs) {
      kept.push({ path: wtDir, name: entry.name, reason: "within_grace_window" });
      continue;
    }

    const activePid = meta?.pid && isPidAlive(Number(meta.pid));
    const activeRun =
      (meta?.runId && activeRunIds.has(String(meta.runId))) ||
      (meta?.session && activeRunIds.has(String(meta.session)));
    const lockFile = path.join(wtDir, ".orkest-lock");
    const lockHeld =
      (fs.existsSync(lockFile) && isFlockHeldByAnotherProcess(lockFile)) ||
      hasActiveWorktreeLease(cacheHome, wtDir, entry.name, meta, { graceMs, nowMs });
    if (activePid || activeRun || lockHeld) {
      kept.push({ path: wtDir, name: entry.name, reason: "active_run" });
      continue;
    }

    const parentRepo = discoverWorktreeParentRepo(wtDir, cwd);
    const gitRegBefore = inspectGitWorktreeRegistration(parentRepo, wtDir);
    if (gitRegBefore.locked) {
      kept.push({ path: wtDir, name: entry.name, reason: "git_locked" });
      continue;
    }

    const statusRes = spawnSync("git", ["-C", wtDir, "status", "--porcelain"], {
      encoding: "utf8",
      timeout: 5000,
    });
    if (statusRes.status !== 0) {
      kept.push({ path: wtDir, name: entry.name, reason: "invalid_git_worktree" });
      continue;
    }

    const statusLines = statusRes.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.endsWith(" meta.json") && line !== "?? meta.json");
    if (statusLines.length > 0) {
      kept.push({ path: wtDir, name: entry.name, reason: "dirty_worktree" });
      continue;
    }

    const baseCommit = resolveBaseRefForWorktree(wtDir, parentRepo, meta);
    if (!baseCommit) {
      kept.push({ path: wtDir, name: entry.name, reason: "unverified_base_branch" });
      continue;
    }

    const aheadRes = spawnSync("git", ["-C", wtDir, "rev-list", "--count", `${baseCommit}..HEAD`], {
      encoding: "utf8",
      timeout: 5000,
    });
    const aheadCount = aheadRes.status === 0 ? Number(aheadRes.stdout.trim()) : NaN;
    if (!Number.isSafeInteger(aheadCount) || aheadCount > 0) {
      kept.push({
        path: wtDir,
        name: entry.name,
        reason: "unmerged_commits",
        commitsAhead: Number.isSafeInteger(aheadCount) ? aheadCount : null,
      });
      continue;
    }

    const bytes = treeSizeBytes(wtDir);
    if (!dryRun) {
      if (parentRepo && fs.existsSync(parentRepo)) {
        const rmWt = spawnSync("git", ["-C", parentRepo, "worktree", "remove", "--force", wtDir], {
          encoding: "utf8",
          timeout: 10_000,
        });
        if (rmWt.status !== 0 && fs.existsSync(wtDir)) {
          const gitRegAfter = inspectGitWorktreeRegistration(parentRepo, wtDir);
          if (gitRegAfter.locked) {
            kept.push({ path: wtDir, name: entry.name, reason: "git_locked" });
            continue;
          }
          if (gitRegAfter.registered) {
            kept.push({ path: wtDir, name: entry.name, reason: "git_remove_refused" });
            continue;
          }
          fs.rmSync(wtDir, { recursive: true, force: true });
        }
      } else {
        fs.rmSync(wtDir, { recursive: true, force: true });
      }
    }
    bytesReclaimed += bytes;
    pruned.push({
      path: wtDir,
      name: entry.name,
      bytes,
      dryRun,
    });
  }

  return { pruned, kept, bytesReclaimed };
}

function candidateBackupDirectories(paths) {
  const { homeDir, xdgConfigBase, orchestrateConfigDir, legacyConfigDir } = paths;
  const dirs = new Set([
    homeDir,
    path.join(homeDir, ".local", "bin"),
    orchestrateConfigDir,
    legacyConfigDir,
    path.join(xdgConfigBase, "opencode"),
    path.join(xdgConfigBase, "opencode", "skills"),
    path.join(homeDir, ".claude"),
    path.join(homeDir, ".claude", "commands"),
    path.join(homeDir, ".claude", "skills"),
    path.join(homeDir, ".codex"),
    path.join(homeDir, ".codex", "skills"),
    path.join(homeDir, ".gemini"),
    path.join(homeDir, ".gemini", "config"),
    path.join(homeDir, ".gemini", "config", "skills"),
    path.join(homeDir, ".gemini", "antigravity"),
    path.join(homeDir, ".gemini", "antigravity", "skills"),
    path.join(homeDir, ".agents", "skills"),
    path.join(homeDir, "Library", "LaunchAgents"),
  ]);

  try {
    const homeItems = fs.readdirSync(homeDir, { withFileTypes: true });
    for (const item of homeItems) {
      if (!(item.isDirectory() && item.name.startsWith(".claude-"))) {
        continue;
      }

      const profileDir = path.join(homeDir, item.name);
      dirs.add(profileDir);
      dirs.add(path.join(profileDir, "commands"));
      dirs.add(path.join(profileDir, "skills"));
    }
  } catch {
    // Ignore
  }

  return [...dirs];
}

function parseMailboxBakKey(filePath) {
  const baseName = path.basename(filePath);
  const idx = baseName.indexOf(".mailbox-bak.");
  if (idx <= 0) {
    return null;
  }
  const targetName = baseName.slice(0, idx);
  const suffix = baseName.slice(idx + ".mailbox-bak.".length);
  const stamp = /^\d+$/.test(suffix) ? BigInt(suffix) : 0n;
  const st = lstatSafe(filePath);
  return {
    filePath,
    targetKey: path.join(path.dirname(filePath), targetName),
    stamp,
    mtimeMs: st?.mtimeMs ?? 0,
    size: treeSizeBytes(filePath),
    isDirectory: Boolean(st?.isDirectory() && !st?.isSymbolicLink()),
  };
}

export function pruneBackups(
  paths,
  { dryRun = false, keepBackups = 1, graceMs = 900_000, nowMs = Date.now() } = {},
) {
  const groups = new Map();
  for (const dir of candidateBackupDirectories(paths)) {
    if (!fs.existsSync(dir)) {
      continue;
    }
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.includes(".mailbox-bak.")) {
        continue;
      }
      const parsed = parseMailboxBakKey(path.join(dir, name));
      if (!parsed) {
        continue;
      }
      if (!groups.has(parsed.targetKey)) {
        groups.set(parsed.targetKey, []);
      }
      groups.get(parsed.targetKey).push(parsed);
    }
  }

  const prunedMailboxBackups = [];
  const keptMailboxBackups = [];
  let bytesReclaimed = 0;

  for (const [, items] of groups) {
    items.sort((a, b) => {
      if (a.stamp !== b.stamp) {
        return a.stamp > b.stamp ? -1 : 1;
      }
      if (b.mtimeMs !== a.mtimeMs) {
        return b.mtimeMs - a.mtimeMs;
      }
      return b.filePath.localeCompare(a.filePath);
    });

    for (const [index, item] of items.entries()) {
      if (index < keepBackups) {
        keptMailboxBackups.push(item.filePath);
      } else {
        prunedMailboxBackups.push(item.filePath);
        bytesReclaimed += item.size;
        if (!dryRun) {
          if (item.isDirectory) {
            fs.rmSync(item.filePath, { recursive: true, force: true });
          } else {
            try {
              fs.unlinkSync(item.filePath);
            } catch {
              // Ignore
            }
          }
        }
      }
    }
  }

  const prunedShareBackups = [];
  const keptShareBackups = [];
  for (const appName of ["agent-executor", "orchestrate"]) {
    const shareBackupsDir = path.join(paths.xdgDatabase, appName, "backups");
    if (!fs.existsSync(shareBackupsDir)) {
      continue;
    }
    let entries;
    try {
      entries = fs.readdirSync(shareBackupsDir).map((name) => {
        const fullPath = path.join(shareBackupsDir, name);
        const st = lstatSafe(fullPath);
        return {
          fullPath,
          name,
          mtimeMs: st?.mtimeMs ?? 0,
          size: treeSizeBytes(fullPath),
        };
      });
    } catch {
      continue;
    }
    entries.sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
    for (const [index, entry] of entries.entries()) {
      const isWithinGrace = nowMs - entry.mtimeMs < graceMs;
      if (index < keepBackups || isWithinGrace) {
        keptShareBackups.push(entry.fullPath);
      } else {
        prunedShareBackups.push(entry.fullPath);
        bytesReclaimed += entry.size;
        if (!dryRun) {
          fs.rmSync(entry.fullPath, { recursive: true, force: true });
        }
      }
    }
  }

  return {
    prunedMailboxBackups,
    keptMailboxBackups,
    prunedShareBackups,
    keptShareBackups,
    bytesReclaimed,
  };
}

export function pruneDaemonRuntimes(
  cacheHome,
  { dryRun = false, graceMs = 900_000, nowMs = Date.now() } = {},
) {
  const daemonDir = path.join(cacheHome, "mailbox-daemon-v1");
  const runtimesDir = path.join(daemonDir, "runtimes");
  const pruned = [];
  const kept = [];
  let bytesReclaimed = 0;

  if (!fs.existsSync(runtimesDir)) {
    return { pruned, kept, bytesReclaimed };
  }

  let activeRevision = "";
  const statePath = path.join(daemonDir, "state.json");
  if (fs.existsSync(statePath)) {
    try {
      const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
      activeRevision = String(state?.runtimeRevision || "");
    } catch {
      activeRevision = "";
    }
  }

  let entries;
  try {
    entries = fs.readdirSync(runtimesDir, { withFileTypes: true });
  } catch {
    return { pruned, kept, bytesReclaimed };
  }

  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) {
      continue;
    }
    const rtPath = path.join(runtimesDir, entry.name);
    const st = statSafe(rtPath);
    if (!st) {
      continue;
    }
    const ageMs = Math.max(0, nowMs - st.mtimeMs);
    if ((activeRevision && entry.name === activeRevision) || ageMs < graceMs) {
      kept.push(rtPath);
      continue;
    }
    const bytes = treeSizeBytes(rtPath);
    bytesReclaimed += bytes;
    pruned.push(rtPath);
    if (!dryRun) {
      fs.rmSync(rtPath, { recursive: true, force: true });
    }
  }

  return { pruned, kept, activeRevision: activeRevision || null, bytesReclaimed };
}

export function pruneStaleMailboxPeers(
  cacheHome,
  { dryRun = false, graceMs = 900_000, nowMs = Date.now() } = {},
) {
  const peersDir = path.join(cacheHome, "mailbox-v1", "peers");
  const pruned = [];
  const kept = [];
  let bytesReclaimed = 0;

  if (!fs.existsSync(peersDir)) {
    return { pruned, kept, bytesReclaimed };
  }

  const activeRunIds = collectActiveRunIds(cacheHome);
  let files;
  try {
    files = fs.readdirSync(peersDir);
  } catch {
    return { pruned, kept, bytesReclaimed };
  }

  for (const file of files) {
    if (!file.endsWith(".json")) {
      continue;
    }
    const peerPath = path.join(peersDir, file);
    const st = statSafe(peerPath);
    if (!st) {
      continue;
    }
    const ageMs = Math.max(0, nowMs - st.mtimeMs);
    if (ageMs < graceMs) {
      kept.push(peerPath);
      continue;
    }
    let peer = null;
    try {
      peer = JSON.parse(fs.readFileSync(peerPath, "utf8"));
    } catch {
      // Ignore unreadable peer JSON
    }
    const isRunEndpoint =
      file.startsWith("run-") ||
      Boolean(peer?.run) ||
      (typeof peer?.session === "string" && peer.session.startsWith("run-"));
    const hasLiveProcess = Boolean(peer?.pid && isPidAlive(Number(peer.pid)));
    const isActiveRun =
      (peer?.run && activeRunIds.has(String(peer.run))) ||
      (peer?.session && activeRunIds.has(String(peer.session)));

    if (!isRunEndpoint || hasLiveProcess || isActiveRun) {
      kept.push(peerPath);
      continue;
    }

    const size = st.size || 0;
    bytesReclaimed += size;
    pruned.push(peerPath);
    if (!dryRun) {
      try {
        fs.unlinkSync(peerPath);
      } catch {
        // Ignore concurrent removal
      }
    }
  }

  return { pruned, kept, bytesReclaimed };
}

function invokeRunnerPrune(
  cacheHome,
  { dryRun = false, olderThan = DEFAULT_OLDER_THAN, context = {} } = {},
) {
  if (typeof context.runRunnerPrune === "function") {
    return context.runRunnerPrune({ cacheHome, dryRun, olderThan });
  }
  const args = [RUN_AGENT_SCRIPT, "prune", "--older-than", olderThan];
  if (dryRun) {
    args.push("--dry-run");
  }
  const env = {
    ...(context.env || process.env),
    ORCHESTRATE_HOME: cacheHome,
    AGENT_EXECUTOR_HOME: cacheHome,
  };
  const res = spawnSync("python3", args, {
    encoding: "utf8",
    env,
    timeout: 15_000,
  });
  if (res.status === 0 && res.stdout.trim()) {
    try {
      return JSON.parse(res.stdout.trim());
    } catch {
      // Fall through
    }
  }
  return {
    dry_run: dryRun,
    cache: cacheHome,
    events: 0,
    jobs: 0,
    runs: 0,
    consults: 0,
    locks: 0,
    mailbox: 0,
    bytes: 0,
    error: res.stderr ? res.stderr.trim() : null,
  };
}

export function formatCleanupReport(report) {
  const lines = [
    `Orkest Cleanup (${report.action}${report.dryRun ? ", dry-run" : ""})`,
    `  Cache home: ${report.paths.cacheHome}`,
    `  Config home: ${report.paths.configHome}`,
    `  Worktrees pruned: ${report.worktrees.pruned.length} (kept: ${report.worktrees.kept.length})`,
    `  Daemon runtimes pruned: ${report.daemonRuntimes.pruned.length} (kept: ${report.daemonRuntimes.kept.length})`,
    `  Backups pruned: ${report.backups.prunedMailboxBackups.length + report.backups.prunedShareBackups.length}`,
    `  Runner artifacts pruned: events=${report.runnerPrune.events ?? 0}, jobs=${report.runnerPrune.jobs ?? 0}, runs=${report.runnerPrune.runs ?? 0}, consults=${report.runnerPrune.consults ?? 0}, locks=${report.runnerPrune.locks ?? 0}`,
    `  Total bytes reclaimed: ${report.totalBytesReclaimed}`,
  ];
  if (report.migration) {
    lines.push(
      `  Legacy migration: cache=${report.migration.cache.status}, config=${report.migration.config.status}, repaired_worktrees=${report.migration.repairedWorktrees.length}`,
    );
  }
  return lines.join("\n") + "\n";
}

export function cleanupCommand(argv = [], context = {}) {
  const parsed = parseCleanupArgs(argv, context);
  const stdout = context.stdout || process.stdout;

  if (parsed.help) {
    const text = cleanupHelpText() + "\n";
    if (!context.silent && stdout?.write) {
      stdout.write(text);
    }
    return {
      schema: CLEANUP_SCHEMA,
      action: "help",
      help: true,
      exitCode: 0,
    };
  }

  const nowMs = typeof context.nowMs === "number" ? context.nowMs : Date.now();
  const initialPaths = resolveCleanupPaths(context);
  const initialLockPath = path.join(initialPaths.cacheHome, "cleanup.lock");

  const lock = acquireCleanupLock(initialLockPath, {
    dryRun: parsed.dryRun,
    graceMs: parsed.graceMs,
    nowMs,
  });

  try {
    let migration = null;
    if (parsed.migrateLegacy) {
      const cacheMig = migrateLegacyDirectory(
        initialPaths.legacyCacheDir,
        initialPaths.orchestrateCacheDir,
        {
          dryRun: parsed.dryRun,
          symlinkTarget: "orchestrate",
        },
      );
      const configMig = migrateLegacyDirectory(
        initialPaths.legacyConfigDir,
        initialPaths.orchestrateConfigDir,
        {
          dryRun: parsed.dryRun,
          symlinkTarget: "orchestrate",
        },
      );
      const targetCacheForRepair =
        !parsed.dryRun || fs.existsSync(initialPaths.orchestrateCacheDir)
          ? initialPaths.orchestrateCacheDir
          : initialPaths.legacyCacheDir;
      const repairedWorktrees = repairWorktreesAfterMigration(targetCacheForRepair, {
        dryRun: parsed.dryRun,
        cwd: parsed.cwd,
      });
      migration = {
        requested: true,
        cache: cacheMig,
        config: configMig,
        repairedWorktrees,
      };
    }

    const activePaths = resolveCleanupPaths(context);
    const worktrees = pruneDisposableWorktrees(activePaths.cacheHome, {
      dryRun: parsed.dryRun,
      graceMs: parsed.graceMs,
      cwd: parsed.cwd,
      nowMs,
    });
    const staleLocks = pruneStaleLocks(activePaths.cacheHome, {
      dryRun: parsed.dryRun,
      graceMs: parsed.graceMs,
      nowMs,
    });
    const daemonRuntimes = pruneDaemonRuntimes(activePaths.cacheHome, {
      dryRun: parsed.dryRun,
      graceMs: parsed.graceMs,
      nowMs,
    });
    const stalePeers = pruneStaleMailboxPeers(activePaths.cacheHome, {
      dryRun: parsed.dryRun,
      graceMs: parsed.graceMs,
      nowMs,
    });
    const backups = pruneBackups(activePaths, {
      dryRun: parsed.dryRun,
      keepBackups: parsed.keepBackups,
      graceMs: parsed.graceMs,
      nowMs,
    });
    const rawRunnerPrune = invokeRunnerPrune(activePaths.cacheHome, {
      dryRun: parsed.dryRun,
      olderThan: parsed.olderThan,
      context,
    });
    const runnerPrune = {
      ...rawRunnerPrune,
      locks: parsed.dryRun
        ? Math.max(Number(rawRunnerPrune?.locks || 0), staleLocks.pruned.length)
        : Number(rawRunnerPrune?.locks || 0) + staleLocks.pruned.length,
      mailbox: Number(rawRunnerPrune?.mailbox || 0) + stalePeers.pruned.length,
    };

    const totalBytesReclaimed =
      worktrees.bytesReclaimed +
      staleLocks.bytesReclaimed +
      daemonRuntimes.bytesReclaimed +
      stalePeers.bytesReclaimed +
      backups.bytesReclaimed +
      Number(rawRunnerPrune?.bytes || 0);

    const report = {
      schema: CLEANUP_SCHEMA,
      action: parsed.action,
      dryRun: parsed.dryRun,
      graceMinutes: parsed.graceMinutes,
      keepBackups: parsed.keepBackups,
      olderThan: parsed.olderThan,
      paths: {
        homeDir: activePaths.homeDir,
        cacheHome: activePaths.cacheHome,
        configHome: activePaths.configHome,
        orchestrateCacheDir: activePaths.orchestrateCacheDir,
        legacyCacheDir: activePaths.legacyCacheDir,
        orchestrateConfigDir: activePaths.orchestrateConfigDir,
        legacyConfigDir: activePaths.legacyConfigDir,
      },
      migration,
      worktrees,
      locks: staleLocks,
      staleLocks,
      daemonRuntimes,
      backups,
      runnerPrune,
      totalBytesReclaimed,
      exitCode: 0,
    };

    if (!context.silent && stdout?.write) {
      if (parsed.json) {
        stdout.write(JSON.stringify(report, null, 2) + "\n");
      } else {
        stdout.write(formatCleanupReport(report));
      }
    }

    return report;
  } finally {
    lock.release([
      path.join(initialPaths.orchestrateCacheDir, "cleanup.lock"),
      path.join(initialPaths.legacyCacheDir, "cleanup.lock"),
    ]);
  }
}

export default cleanupCommand;
