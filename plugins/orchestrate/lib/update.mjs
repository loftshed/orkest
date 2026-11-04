import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { cacheHome, configHome } from "./runtime-paths.mjs";

export const DEFAULT_UPDATE_INTERVAL_MS = 30 * 60 * 1000;

const DEFAULT_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

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
  const isEnabled = raw.enabled !== false;
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
  const repoRoot = options.repoRoot || DEFAULT_REPO_ROOT;
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
  const repoRoot = options.repoRoot || DEFAULT_REPO_ROOT;
  const nowMs = typeof options.now === "function" ? options.now() : (options.now ?? Date.now());
  const nowIso = new Date(nowMs).toISOString();
  const statePath = getUpdateStatePath(options);
  const existingState = (await readOptionalJson(statePath)) || {};
  const cfg = await readAutoUpdateConfig(options);

  if (options.auto === true) {
    if (!cfg.enabled) {
      return { ok: true, status: "disabled", updated: false };
    }
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

  const check = await checkOrkestUpdate(options);
  const nextState = {
    ...existingState,
    lastCheckedAt: nowIso,
    status: check.status,
  };

  if (check.status !== "update_available") {
    await writeJsonFile(statePath, nextState);
    return { ...check, updated: false };
  }

  const remoteRef = `${check.remote}/${check.targetBranch}`;
  await execCommand(exec, "git", ["-C", repoRoot, "merge", "--ff-only", remoteRef], {
    cwd: repoRoot,
    timeout: 15_000,
  });

  let cleanupResult = null;
  if (!options.skipPostInstall) {
    const installMailboxPath = path.join(
      repoRoot,
      "plugins/orchestrate/skills/orchestrate/scripts/install_mailbox.py",
    );
    await execCommand(exec, "python3", [installMailboxPath], {
      cwd: repoRoot,
      timeout: 15_000,
    });
    let cleanupRunner = typeof options.cleanupFn === "function" ? options.cleanupFn : null;
    if (!cleanupRunner) {
      try {
        const mod = await import("./cleanup.mjs");
        cleanupRunner = mod.runCleanup || mod.cleanupOrkest || null;
      } catch {
        cleanupRunner = null;
      }
    }
    if (typeof cleanupRunner === "function") {
      try {
        cleanupResult = await cleanupRunner({
          migrateLegacy: true,
          dryRun: false,
          ...options,
        });
      } catch {
        // Legacy cleanup is best-effort during auto-update.
      }
    }
  }

  const updatedState = {
    ...nextState,
    status: "updated",
    lastUpdatedAt: nowIso,
    fromSha: check.localSha,
    toSha: check.remoteSha,
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
    ...(cleanupResult && { cleanup: cleanupResult }),
  };
}

export async function runUpdateCli(argv = [], io = {}) {
  const stdout = io.stdout || process.stdout;
  const flags = new Set(argv.filter((arg) => arg.startsWith("--")));
  const subcommand = argv.find((arg) => !arg.startsWith("--")) || "run";
  const isJsonOutput = flags.has("--json");
  const isQuiet = flags.has("--quiet");
  const options = {
    ...io,
    auto: flags.has("--auto"),
    force: flags.has("--force"),
  };

  let result;
  switch (subcommand) {
    case "enable": {
      const config = await setAutoUpdateEnabled(true, options);
      result = { ok: true, status: "enabled", autoUpdate: config };
      break;
    }
    case "disable": {
      const config = await setAutoUpdateEnabled(false, options);
      result = { ok: true, status: "disabled", autoUpdate: config };
      break;
    }
    case "status": {
      const config = await readAutoUpdateConfig(options);
      const state = (await readOptionalJson(getUpdateStatePath(options))) || {};
      result = { ok: true, status: state.status || "idle", autoUpdate: config, state };
      break;
    }
    case "check": {
      result = await checkOrkestUpdate(options);
      break;
    }
    default: {
      result = await runOrkestUpdate(options);
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
      stdout.write(`Orkest auto-update ${result.status}.\n`);
      break;
    }
    default: {
      stdout.write(`Orkest update status: ${result.status}.\n`);
      break;
    }
  }
  return result;
}
