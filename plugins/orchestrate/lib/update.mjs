import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { cacheHome, configHome } from "./runtime-paths.mjs";

export const DEFAULT_UPDATE_INTERVAL_MS = 30 * 60 * 1000;
const UPDATE_SUBCOMMANDS = new Set(["run", "check", "status", "enable", "disable"]);
const UPDATE_FLAGS = new Set(["--check", "--apply", "--auto", "--force", "--quiet", "--json"]);
const UPDATE_HELP_TEXT = `Usage: ork update [run|check|status|enable|disable] [options]

Commands:
  run       Check for and apply a fast-forward update (the default)
  check     Check whether an update is available
  status    Show auto-update settings and the last update status
  enable    Apply updates automatically, without asking
  disable   Only prompt for updates (the default)

Options:
  --check   Run the check command
  --apply   Run the update command
  --auto    Apply automatic-update throttling
  --force   Ignore automatic-update throttling
  --quiet   Suppress output unless an update succeeds
  --json    Print the result as JSON
  -h, --help  Show this help
`;

const DEFAULT_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SHA40_RE = /^[0-9a-f]{40}$/iu;

async function readOptionalJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeJsonFile(filePath, data) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

async function execCommand(exec, command, args, options = {}) {
  if (exec === execFile) {
    return new Promise((resolve, reject) => {
      execFile(
        command,
        args,
        { timeout: options.timeout ?? 15_000, maxBuffer: 1024 * 1024, cwd: options.cwd },
        (error, stdout = "", stderr = "") => {
          if (error) {
            error.stdout = stdout;
            error.stderr = stderr;
            reject(error);
            return;
          }
          resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") });
        },
      );
    });
  }
  let callbackResult = null;
  let callbackError = null;
  const finish = (err, stdout = "", stderr = "") => {
    callbackError = err;
    callbackResult = { stdout: String(stdout || ""), stderr: String(stderr || "") };
  };
  const maybePromise =
    exec.length >= 4 ? exec(command, args, options, finish) : exec(command, args, finish);
  if (maybePromise && typeof maybePromise.then === "function") {
    const awaited = await maybePromise;
    if (typeof awaited === "string") return { stdout: awaited, stderr: "" };
    if (awaited && typeof awaited === "object" && "stdout" in awaited) {
      return {
        stdout: String(awaited.stdout || ""),
        stderr: String(awaited.stderr || ""),
      };
    }
  } else if (typeof maybePromise === "string") {
    return { stdout: maybePromise, stderr: "" };
  } else if (maybePromise && typeof maybePromise === "object" && "stdout" in maybePromise) {
    return {
      stdout: String(maybePromise.stdout || ""),
      stderr: String(maybePromise.stderr || ""),
    };
  }
  if (callbackError) throw callbackError;
  return callbackResult || { stdout: "", stderr: "" };
}

async function resolveGitDirs(repoRoot) {
  if (!repoRoot) return null;
  const dotGit = path.join(repoRoot, ".git");
  let info;
  try {
    info = await stat(dotGit);
  } catch {
    return null;
  }
  if (info.isDirectory()) {
    return { gitDir: dotGit, commonDir: dotGit };
  }
  if (!info.isFile()) return null;
  let pointer;
  try {
    pointer = (await readFile(dotGit, "utf8")).trim();
  } catch {
    return null;
  }
  if (!pointer.startsWith("gitdir:")) return null;
  const gitDir = path.resolve(repoRoot, pointer.slice(7).trim());
  let commonDir = gitDir;
  try {
    const commonRel = (await readFile(path.join(gitDir, "commondir"), "utf8")).trim();
    if (commonRel) commonDir = path.resolve(gitDir, commonRel);
  } catch {
    // Standalone gitdir without commondir file.
  }
  return { gitDir, commonDir };
}

export async function resolveOrkestRepoRoot(options = {}) {
  if (options.repoRoot) return options.repoRoot;
  const candidate = options.defaultRepoRoot || DEFAULT_REPO_ROOT;
  const dirs = await resolveGitDirs(candidate);
  if (dirs) {
    if (dirs.commonDir !== dirs.gitDir && path.basename(dirs.commonDir) === ".git") {
      return path.dirname(dirs.commonDir);
    }
    return candidate;
  }
  const home = options.home || homedir();
  try {
    const linkedSkill = await realpath(path.join(home, ".agents", "skills", "orchestrate"));
    const primaryRoot = path.resolve(linkedSkill, "../../../..");
    if (await resolveGitDirs(primaryRoot)) return primaryRoot;
  } catch {
    // Fall back to DEFAULT_REPO_ROOT when no global skill link exists.
  }
  return candidate;
}

export async function readLocalGitHeadSha(repoRoot) {
  const dirs = await resolveGitDirs(repoRoot);
  if (!dirs) return null;
  let headRaw;
  try {
    headRaw = (await readFile(path.join(dirs.gitDir, "HEAD"), "utf8")).trim();
  } catch {
    return null;
  }
  if (SHA40_RE.test(headRaw)) return headRaw.toLowerCase();
  if (!headRaw.startsWith("ref:")) return null;
  const refName = headRaw.slice(4).trim();
  if (!refName) return null;
  for (const baseDir of [dirs.gitDir, dirs.commonDir]) {
    try {
      const refSha = (await readFile(path.join(baseDir, refName), "utf8")).trim();
      if (SHA40_RE.test(refSha)) return refSha.toLowerCase();
    } catch {
      // Ref may live in commonDir or packed-refs.
    }
  }
  try {
    const packed = await readFile(path.join(dirs.commonDir, "packed-refs"), "utf8");
    for (const line of packed.split(/\r?\n/u)) {
      if (!line || line.startsWith("#") || line.startsWith("^")) continue;
      const space = line.indexOf(" ");
      if (space !== 40 || line.slice(41).trim() !== refName) continue;
      const sha = line.slice(0, 40);
      if (SHA40_RE.test(sha)) return sha.toLowerCase();
    }
  } catch {
    // No packed-refs file present.
  }
  return null;
}

export function getUpdateStatePath(options = {}) {
  const dir = options.cacheDir || cacheHome(options.env);
  return path.join(dir, "auto-update-v1.json");
}

export function getUpdateConfigPath(options = {}) {
  if (options.configPath) return options.configPath;
  const dir = options.configDir || configHome(options.env);
  return path.join(dir, "config.json");
}

export async function readAutoUpdateConfig(options = {}) {
  const configPath = getUpdateConfigPath(options);
  const parsed = (await readOptionalJson(configPath)) || {};
  let raw = {};
  if (parsed.auto_update && typeof parsed.auto_update === "object") {
    raw = parsed.auto_update;
  } else if (parsed.autoUpdate && typeof parsed.autoUpdate === "object") {
    raw = parsed.autoUpdate;
  }
  // `enabled` means "apply updates without asking"; by default they wait for the user to accept.
  const isEnabled = raw.enabled === true;
  const rawMinutes = Number(raw.intervalMinutes ?? raw.interval_minutes ?? 30);
  const intervalMinutes = Number.isFinite(rawMinutes) && rawMinutes > 0 ? rawMinutes : 30;
  const remote = typeof raw.remote === "string" && raw.remote.trim() ? raw.remote.trim() : "origin";
  const branch = typeof raw.branch === "string" && raw.branch.trim() ? raw.branch.trim() : "main";
  return { enabled: isEnabled, intervalMinutes, remote, branch };
}

export async function setAutoUpdateEnabled(isEnabled, options = {}) {
  const configPath = getUpdateConfigPath(options);
  const current = (await readOptionalJson(configPath)) || {};
  const existingAuto =
    current.auto_update && typeof current.auto_update === "object" ? current.auto_update : {};
  current.auto_update = {
    ...existingAuto,
    enabled: Boolean(isEnabled),
  };
  await writeJsonFile(configPath, current);
  return readAutoUpdateConfig(options);
}

export async function checkOrkestUpdate(options = {}) {
  const exec = options.exec || execFile;
  const repoRoot = await resolveOrkestRepoRoot(options);
  const cfg = await readAutoUpdateConfig(options);
  const remote = options.remote || cfg.remote || "origin";
  const git = async (args, timeout = 15_000) =>
    (await execCommand(exec, "git", ["-C", repoRoot, ...args], { cwd: repoRoot, timeout })).stdout;

  const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  const statusPorcelain = await git(["status", "--porcelain"]);
  const localSha = (await git(["rev-parse", "HEAD"])).trim();
  const isDirty = statusPorcelain.trim() !== "";
  const targetBranch = options.branch || cfg.branch || (branch === "master" ? "master" : "main");
  const isAllowedBranch =
    options.allowBranch === true ||
    branch === "main" ||
    branch === "master" ||
    branch === targetBranch;

  if (isDirty || !isAllowedBranch) {
    return {
      ok: true,
      status: "skipped_dirty_or_branch",
      branch,
      remote,
      targetBranch,
      dirty: isDirty,
      localSha,
      updateAvailable: false,
    };
  }

  await git(["fetch", "--quiet", remote, targetBranch], 15_000);
  const remoteRef = `${remote}/${targetBranch}`;
  const remoteSha = (await git(["rev-parse", remoteRef])).trim();
  const commitsBehind =
    Math.trunc(Number((await git(["rev-list", "--count", `HEAD..${remoteRef}`])).trim())) || 0;
  const commitsAhead =
    Math.trunc(Number((await git(["rev-list", "--count", `${remoteRef}..HEAD`])).trim())) || 0;
  const isUpdateAvailable = commitsBehind > 0 && commitsAhead === 0;

  return {
    ok: true,
    status: isUpdateAvailable ? "update_available" : "up_to_date",
    branch,
    remote,
    targetBranch,
    dirty: false,
    localSha,
    remoteSha,
    commitsBehind,
    commitsAhead,
    updateAvailable: isUpdateAvailable,
  };
}

export async function runOrkestUpdate(options = {}) {
  const exec = options.exec || execFile;
  const repoRoot = await resolveOrkestRepoRoot(options);
  const nowMs = typeof options.now === "function" ? options.now() : (options.now ?? Date.now());
  const nowIso = new Date(nowMs).toISOString();
  const statePath = getUpdateStatePath(options);
  const existingState = (await readOptionalJson(statePath)) || {};
  const cfg = await readAutoUpdateConfig(options);

  if (options.auto === true) {
    const intervalMs =
      options.intervalMs ??
      (Number.isFinite(cfg.intervalMinutes) && cfg.intervalMinutes > 0
        ? cfg.intervalMinutes * 60 * 1000
        : DEFAULT_UPDATE_INTERVAL_MS);
    const lastCheckedMs =
      typeof existingState.lastCheckedAt === "number"
        ? existingState.lastCheckedAt
        : Date.parse(existingState.lastCheckedAt || "");
    if (!options.force && Number.isFinite(lastCheckedMs) && nowMs - lastCheckedMs < intervalMs) {
      return {
        ok: true,
        status: "throttled",
        updated: false,
        lastCheckedAt: existingState.lastCheckedAt,
      };
    }
  }

  const check = await checkOrkestUpdate({ ...options, repoRoot });
  const nextState = {
    ...existingState,
    lastCheckedAt: nowIso,
    status: check.status,
    ...(check.localSha && { localSha: check.localSha }),
    ...(check.remoteSha && { remoteSha: check.remoteSha }),
  };

  // Without opt-in, a background check only records that an update is waiting.
  const isRecordOnly = options.auto === true && !cfg.enabled;
  if (check.status !== "update_available" || isRecordOnly) {
    if (check.status === "update_available") nextState.commitsBehind = check.commitsBehind;
    await writeJsonFile(statePath, nextState);
    return { ...check, updated: false };
  }

  const remoteRef = `${check.remote}/${check.targetBranch}`;
  await execCommand(exec, "git", ["-C", repoRoot, "merge", "--ff-only", remoteRef], {
    cwd: repoRoot,
    timeout: 15_000,
  });

  let migrationReport;
  let migrationError;
  if (!options.skipPostInstall) {
    const installMailboxPath = path.join(
      repoRoot,
      "plugins/orchestrate/skills/orchestrate/scripts/install_mailbox.py",
    );
    await execCommand(exec, "python3", [installMailboxPath], {
      cwd: repoRoot,
      timeout: 15_000,
    });
    try {
      let migrationRunner = typeof options.cleanupFn === "function" ? options.cleanupFn : null;
      if (!migrationRunner) {
        const mod = await import("./cleanup.mjs");
        migrationRunner = mod.migrateLegacyState;
      }
      if (typeof migrationRunner !== "function") {
        throw new TypeError("cleanup.mjs does not export migrateLegacyState");
      }
      migrationReport = await migrationRunner({
        migrateLegacy: true,
        dryRun: false,
        ...options,
      });
    } catch (error) {
      migrationError = error instanceof Error ? error.message : String(error);
    }
  }

  const updatedState = {
    ...nextState,
    status: "updated",
    lastUpdatedAt: nowIso,
    fromSha: check.localSha,
    toSha: check.remoteSha,
    localSha: check.remoteSha,
    remoteSha: check.remoteSha,
    commitsBehind: check.commitsBehind,
  };
  await writeJsonFile(statePath, updatedState);

  return {
    ok: true,
    status: "updated",
    updated: true,
    branch: check.branch,
    fromSha: check.localSha,
    toSha: check.remoteSha,
    commitsBehind: check.commitsBehind,
    ...(migrationReport !== undefined && migrationReport !== null && { cleanup: migrationReport }),
    ...(migrationError !== undefined && { migrationError }),
  };
}

function parseUpdateCliArgs(argv) {
  if (argv.some((arg) => arg === "--help" || arg === "-h")) {
    return { help: true };
  }

  const flags = new Set();
  const requested = new Set();
  for (const arg of argv) {
    if (arg === "--check") {
      flags.add(arg);
      requested.add("check");
    } else if (arg === "--apply") {
      flags.add(arg);
      requested.add("run");
    } else if (UPDATE_FLAGS.has(arg)) {
      flags.add(arg);
    } else if (arg.startsWith("-")) {
      const error = new Error(`Unknown update flag: ${arg}`);
      error.exitCode = 2;
      throw error;
    } else if (UPDATE_SUBCOMMANDS.has(arg)) {
      requested.add(arg);
    } else {
      const error = new Error(`Unknown update subcommand: ${arg}`);
      error.exitCode = 2;
      throw error;
    }
  }

  if (requested.size > 1) {
    const error = new Error(`Conflicting update commands: ${[...requested].join(", ")}`);
    error.exitCode = 2;
    throw error;
  }

  const command = [...requested][0] || "run";
  return { flags, command };
}

function formatMigrationOutcome(result) {
  if (result.migrationError !== undefined) {
    const message = String(result.migrationError).replaceAll(/\s+/gu, " ").trim();
    return `Legacy state migration failed: ${message}.\n`;
  }

  const report = result.cleanup;
  if (!report) return "";
  const directoryReports = [report.cache, report.config].filter(Boolean);
  const repairedWorktrees = Array.isArray(report.repairedWorktrees) ? report.repairedWorktrees : [];
  const repairedCount = repairedWorktrees.filter((item) => item.status === "repaired").length;
  const failedCount =
    directoryReports.filter((item) => item.status === "conflict_preserved").length +
    repairedWorktrees.filter((item) => item.status === "repair_failed").length;
  const changed = directoryReports.some((item) => item.changed === true) || repairedCount > 0;
  if (!changed && failedCount === 0) return "";

  const cacheStatus = report.cache?.status || "unchanged";
  const configStatus = report.config?.status || "unchanged";
  return `Legacy state migration: cache=${cacheStatus}, config=${configStatus}, repaired_worktrees=${repairedCount}, failures=${failedCount}.\n`;
}

export async function runUpdateCli(argv = [], io = {}) {
  const stdout = io.stdout || process.stdout;
  const parsed = parseUpdateCliArgs(argv);
  if (parsed.help) {
    stdout.write(UPDATE_HELP_TEXT);
    return { ok: true, status: "help", help: true, exitCode: 0 };
  }

  const { flags, command: subcommand } = parsed;
  const {
    updateFn = runOrkestUpdate,
    checkFn = checkOrkestUpdate,
    setAutoUpdateEnabledFn = setAutoUpdateEnabled,
    readAutoUpdateConfigFn = readAutoUpdateConfig,
    readUpdateStateFn = readOptionalJson,
    ...baseOptions
  } = io;
  const isJsonOutput = flags.has("--json");
  const isQuiet = flags.has("--quiet");
  const options = {
    ...baseOptions,
    stdout,
    auto: flags.has("--auto"),
    force: flags.has("--force"),
  };

  let result;
  switch (subcommand) {
    case "enable": {
      const config = await setAutoUpdateEnabledFn(true, options);
      result = { ok: true, status: "enabled", autoUpdate: config };
      break;
    }
    case "disable": {
      const config = await setAutoUpdateEnabledFn(false, options);
      result = { ok: true, status: "disabled", autoUpdate: config };
      break;
    }
    case "status": {
      const config = await readAutoUpdateConfigFn(options);
      const state = (await readUpdateStateFn(getUpdateStatePath(options))) || {};
      result = { ok: true, status: state.status || "idle", autoUpdate: config, state };
      break;
    }
    case "check": {
      result = await checkFn(options);
      break;
    }
    default: {
      result = await updateFn(options);
      break;
    }
  }

  if (isJsonOutput) {
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  }
  if (isQuiet && result.status !== "updated") {
    return result;
  }
  switch (result.status) {
    case "updated": {
      stdout.write(
        `Orkest updated (${result.fromSha?.slice(0, 7)} -> ${result.toSha?.slice(0, 7)}, ${result.commitsBehind} commit${result.commitsBehind === 1 ? "" : "s"}).\n`,
      );
      stdout.write(formatMigrationOutcome(result));
      break;
    }
    case "update_available": {
      stdout.write(
        `Orkest update available (${result.commitsBehind} commit${result.commitsBehind === 1 ? "" : "s"} behind ${result.remote}/${result.targetBranch}).\n`,
      );
      break;
    }
    case "up_to_date": {
      stdout.write(`Orkest is up to date (${result.branch} @ ${result.localSha?.slice(0, 7)}).\n`);
      break;
    }
    case "enabled":
    case "disabled": {
      stdout.write(
        result.status === "enabled"
          ? "Orkest will apply updates automatically.\n"
          : "Orkest will ask before applying updates.\n",
      );
      break;
    }
    default: {
      stdout.write(`Orkest update status: ${result.status}.\n`);
      break;
    }
  }
  return result;
}
