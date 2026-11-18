// Orca IDE terminal identity, CLI resolution and the small state files the Orca worker shares
// with the Swarm View. Node built-ins only: this runs inside Orca's plugin worker, whose
// environment is stripped to PATH, HOME and a few locale and session variables.

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { accessSync, constants, realpathSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { cacheHome } from "./runtime-paths.mjs";

export const ORCA_TERMINALS_SCHEMA = "orkest.orca-terminals.v1";
export const ORCA_VIEW_SCHEMA = "orkest.orca-view.v1";
export const ORCA_VIEW_TITLE_PREFIX = "Orkest Swarm";

/** On Linux these are the GNOME Orca screen reader, never the Orca IDE CLI. */
const SCREEN_READER_PATHS = Object.freeze(["/usr/bin/orca", "/bin/orca"]);
const TERMINAL_HANDLE = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/u;

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

/** A terminal handle that is safe to pass as a CLI argument; otherwise "". */
export function orcaTerminalHandle(value) {
  const handle = text(value);
  return TERMINAL_HANDLE.test(handle) ? handle : "";
}

function realpathOr(file, realpath) {
  try {
    return realpath(file);
  } catch {
    return file;
  }
}

/** Whether `file` is the Linux screen reader that shares the `orca` name. */
export function isScreenReaderOrca(
  file,
  { platform = process.platform, realpath = realpathSync } = {},
) {
  if (platform !== "linux" || !file) return false;
  const resolved = realpathOr(file, realpath);
  return SCREEN_READER_PATHS.some(
    (candidate) => file === candidate || resolved === realpathOr(candidate, realpath),
  );
}

function isExecutable(file) {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The absolute path of an executable on `env.PATH`, or null. */
export function findExecutable(name, env = process.env, { exists = isExecutable } = {}) {
  if (!name) return null;
  if (name.includes("/") || name.includes("\\")) return exists(name) ? name : null;
  const directories = String(env.PATH || "").split(path.delimiter);
  for (const directory of directories) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    if (exists(candidate)) return candidate;
  }
  return null;
}

/**
 * The Orca IDE CLI for this environment, as an absolute path, or null.
 * Order: `ORCA_CLI_COMMAND`, `orca-dev` in a dev checkout, `orca` (only when it is not the
 * Linux screen reader), then `orca-ide`. An explicit choice never falls through to another
 * executable, which could target a different Orca build.
 */
export function resolveOrcaCli(
  env = process.env,
  { platform = process.platform, which = findExecutable, realpath = realpathSync } = {},
) {
  const guard = (file) => (file && !isScreenReaderOrca(file, { platform, realpath }) ? file : null);
  const explicit = text(env.ORCA_CLI_COMMAND);
  if (explicit) return guard(which(explicit, env));
  if (text(env.ORCA_DEV_REPO_ROOT)) return guard(which("orca-dev", env));
  const orca = guard(which("orca", env));
  if (platform !== "linux") return orca;
  return orca || guard(which("orca-ide", env));
}

/** The Orca terminal this process runs in, from the PTY environment, or null outside Orca. */
export function orcaPaneContext(env = process.env) {
  const paneKey = text(env.ORCA_PANE_KEY) || text(env.ORCA_AGENT_PANE);
  if (!paneKey) return null;
  return {
    paneKey,
    terminalHandle: orcaTerminalHandle(env.ORCA_TERMINAL_HANDLE),
    tabId: text(env.ORCA_TAB_ID),
    worktreeId: text(env.ORCA_WORKTREE_ID),
    environment: text(env.ORCA_ENVIRONMENT),
    launchToken: text(env.ORCA_AGENT_LAUNCH_TOKEN) || text(env.ORCA_AGENT_LAUNCH),
  };
}

/** The Orca terminal handle recorded for an agent, member or progress record. */
export function agentOrcaTerminal(agent) {
  return orcaTerminalHandle(agent?.orcaTerminalHandle || agent?.progress?.orcaTerminalHandle);
}

/** An agent's Orca terminal is reachable from here: same Orca environment, and we run in Orca. */
export function isCurrentOrcaAgent(agent, env = process.env) {
  if (!agentOrcaTerminal(agent) || !orcaPaneContext(env)) return false;
  const recorded = text(agent?.orcaEnvironment || agent?.progress?.orcaEnvironment);
  return recorded === text(env.ORCA_ENVIRONMENT);
}

/** The Orkest cache for `env`, taking home from `env.HOME`: Orca workers receive HOME and PATH. */
export function orcaCacheHome(env = process.env) {
  return cacheHome(env, { home: env.HOME || homedir() });
}

export function orcaTerminalsPath(env = process.env) {
  return path.join(orcaCacheHome(env), "orca-terminals-v1.json");
}

export function orcaViewKey(room) {
  return createHash("sha256").update(String(room)).digest("hex");
}

export function orcaViewsDirectory(env = process.env) {
  return path.join(orcaCacheHome(env), "orca-views-v1");
}

export function orcaViewPath(room, env = process.env) {
  return path.join(orcaViewsDirectory(env), `${orcaViewKey(room)}.json`);
}

export function orcaViewTitle(room) {
  return `${ORCA_VIEW_TITLE_PREFIX} · ${String(room).slice(0, 64)}`;
}

/** A JSON object from `file`, or null when it is missing or malformed. */
export async function readJsonState(file) {
  try {
    const data = JSON.parse(await readFile(file, "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

/** Replace `file` atomically, private to this user. */
export async function writeJsonState(file, data) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(data)}\n`, { mode: 0o600 });
    await rename(temporary, file);
  } catch (error) {
    try {
      await unlink(temporary);
    } catch {
      // Nothing was written.
    }
    throw error;
  }
}

export async function readOrcaTerminals(env = process.env) {
  const data = await readJsonState(orcaTerminalsPath(env));
  if (data?.schema !== ORCA_TERMINALS_SCHEMA || typeof data.terminals !== "object") {
    return { schema: ORCA_TERMINALS_SCHEMA, terminals: {} };
  }
  return data;
}

export async function readOrcaView(room, env = process.env) {
  const data = await readJsonState(orcaViewPath(room, env));
  return data?.schema === ORCA_VIEW_SCHEMA && data.room === room ? data : null;
}

/** Record that the Swarm View for a view-state file was closed by its owner. */
export async function markOrcaViewClosed(file, now = Date.now()) {
  const record = await readJsonState(file);
  if (record?.schema !== ORCA_VIEW_SCHEMA || record.closed) return false;
  await writeJsonState(file, { ...record, closed: true, closedAt: new Date(now).toISOString() });
  return true;
}

/** Auto-dismiss an Orca companion Swarm View pane by recording closure and calling Orca CLI best-effort. */
export async function closeOrcaCompanionPane(
  file,
  { env = process.env, exec = execFile, now = Date.now } = {},
) {
  if (!file || env?.ORKEST_CHIEF_VIEW === "1") {
    return { dismissed: false, reason: "not_companion" };
  }
  const record = await readJsonState(file);
  const terminalId = orcaTerminalHandle(record?.terminalId);
  if (
    record?.schema !== ORCA_VIEW_SCHEMA ||
    Boolean(record.chief) ||
    !record.sourceTerminalId ||
    !terminalId
  ) {
    return { dismissed: false, reason: "not_companion" };
  }
  const timestamp = typeof now === "function" ? now() : now;
  await writeJsonState(file, {
    ...record,
    closed: true,
    autoDismissed: true,
    closedAt: new Date(timestamp).toISOString(),
  });
  const cli = resolveOrcaCli(env);
  if (cli) {
    await new Promise((resolve) => {
      exec(
        cli,
        ["terminal", "close", "--terminal", terminalId, "--json"],
        { env, timeout: 5000 },
        () => resolve(),
      );
    });
  }
  return { dismissed: true, terminalId };
}
