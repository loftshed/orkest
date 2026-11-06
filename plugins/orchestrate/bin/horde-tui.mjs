import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { shouldUseColor } from "../../monitor/lib/render.mjs";
import { CACHE_DIR, CONFIG_PATH } from "../../monitor/lib/store.mjs";
import { createAgentPreview } from "../lib/agent-preview.mjs";
import { markHerdrViewClosed, syncHerdrViewLabel } from "../lib/herdr-view-state.mjs";
import { createRoom, mailboxRoot, readRoom } from "../lib/horde-room.mjs";
import { fit, HordeView, shortAgentName } from "../lib/horde-view.mjs";
import { configHome } from "../lib/runtime-paths.mjs";
import {
  createTerminalInput,
  MOUSE_DISABLE,
  MOUSE_ENABLE,
  TERMINAL_INPUT_DISABLE,
  TERMINAL_INPUT_ENABLE,
} from "../lib/tui-input.mjs";
import {
  checkOrkestUpdate,
  getUpdateStatePath,
  readLocalGitHeadSha,
  resolveOrkestRepoRoot,
  runOrkestUpdate,
} from "../lib/update.mjs";

export const UPDATE_SUCCESS_TTL_MS = 15_000;

const PANE_ID_RE = /^[A-Za-z0-9_.:%][A-Za-z0-9_.:%-]{0,63}$/u;

const TERMINAL_STAGES = new Set([
  "completed",
  "complete",
  "reported complete",
  "failed",
  "canceled",
  "cancelled",
  "rejected",
]);

const quotaCache = {
  snapshotPath: "",
  snapshotMtimeMs: -1,
  configPath: "",
  configMtimeMs: -1,
  accounts: null,
};

const serviceCache = {
  key: "",
  fetchedAt: 0,
  services: [],
};

const updateCache = {
  fetchedAt: 0,
  statePath: "",
  stateMtimeMs: -1,
  sharedState: null,
  status: null,
};

function syncUpdateCacheAsCurrent(landedSha, stamp = Date.now()) {
  updateCache.fetchedAt = stamp;
  updateCache.status = {
    available: false,
    commitsBehind: 0,
    localSha: landedSha || updateCache.status?.remoteSha || updateCache.status?.localSha,
    remoteSha: landedSha || updateCache.status?.remoteSha,
    dirty: false,
    status: "up_to_date",
  };
}

async function readSharedUpdateState(options = {}) {
  const statePath = getUpdateStatePath(options);
  try {
    const info = await stat(statePath);
    if (updateCache.statePath === statePath && updateCache.stateMtimeMs === info.mtimeMs) {
      return updateCache.sharedState;
    }
    const parsed = JSON.parse(await readFile(statePath, "utf8"));
    updateCache.statePath = statePath;
    updateCache.stateMtimeMs = info.mtimeMs;
    updateCache.sharedState = parsed;
    return parsed;
  } catch {
    return null;
  }
}

export function resolvePullUpdateOutcome(res, nowMs = Date.now()) {
  if (res?.ok && res.updated) {
    const landedSha = res.toSha || res.remoteSha || res.localSha;
    syncUpdateCacheAsCurrent(landedSha, nowMs);
    return {
      updateState: {
        available: false,
        status: "updated",
        toSha: landedSha,
        commitsBehind: res.commitsBehind,
        completedAt: nowMs,
      },
      notice: "",
    };
  }
  if (res?.ok && res.status === "up_to_date") {
    syncUpdateCacheAsCurrent(res.localSha || res.remoteSha, nowMs);
    return {
      updateState: null,
      notice: "Orkest is already up to date.",
    };
  }
  return {
    updateState: {
      available: false,
      status: "error",
      message: res?.error || res?.status || "Update failed",
    },
    notice: "",
  };
}

async function runExecOutput(exec, command, args) {
  try {
    if (exec === execFile) {
      return await new Promise((resolve) => {
        execFile(command, args, { timeout: 1500, maxBuffer: 512 * 1024 }, (err, stdout = "") =>
          resolve(err ? "" : String(stdout || "")),
        );
      });
    }
    let callbackStdout = "";
    let callbackErr = null;
    const result = exec(command, args, (err, stdout = "") => {
      callbackErr = err;
      callbackStdout = String(stdout || "");
    });
    if (result && typeof result.then === "function") {
      const awaited = await result;
      if (typeof awaited === "string") return awaited;
      if (awaited && typeof awaited.stdout === "string") return awaited.stdout;
    } else if (typeof result === "string") {
      return result;
    } else if (result && typeof result.stdout === "string") {
      return result.stdout;
    }
    return callbackErr ? "" : callbackStdout;
  } catch {
    return "";
  }
}

async function runExec(exec, command, args) {
  try {
    if (exec === execFile) {
      return await new Promise((resolve) => {
        execFile(command, args, (err) => resolve(!err));
      });
    }
    let callbackError = null;
    const result = exec(command, args, (err) => {
      callbackError = err;
    });
    if (result && typeof result.then === "function") {
      await result;
    }
    return !callbackError;
  } catch {
    return false;
  }
}

export async function focusAgentPane(agent, { exec = execFile } = {}) {
  if (!agent || typeof agent !== "object") return false;
  const herdrPaneId = typeof agent.herdrPaneId === "string" ? agent.herdrPaneId.trim() : "";
  if (herdrPaneId && PANE_ID_RE.test(herdrPaneId)) {
    return runExec(exec, "herdr", ["pane", "focus", "--pane", herdrPaneId]);
  }
  const paneId = typeof agent.paneId === "string" ? agent.paneId.trim() : "";
  if (paneId && PANE_ID_RE.test(paneId)) {
    const server = typeof agent.terminalServer === "string" ? agent.terminalServer.trim() : "";
    const tmuxArgs =
      server && PANE_ID_RE.test(server)
        ? ["-L", server, "select-pane", "-t", paneId]
        : ["select-pane", "-t", paneId];
    return runExec(exec, "tmux", tmuxArgs);
  }
  return false;
}

function resolveStage(agent) {
  return String(agent?.stage ?? agent?.progress?.stage ?? agent?.status ?? "")
    .trim()
    .toLowerCase();
}

export function notifyHerdrTransitions(
  prevAgents,
  nextAgents,
  notifiedSet,
  { env = process.env, exec = execFile } = {},
) {
  if (!Array.isArray(nextAgents)) return false;
  const seen = notifiedSet instanceof Set ? notifiedSet : new Set();
  const isAllTerminal =
    nextAgents.length > 0 && nextAgents.every((agent) => TERMINAL_STAGES.has(resolveStage(agent)));

  if (!Array.isArray(prevAgents)) {
    for (const agent of nextAgents) {
      if (!agent || typeof agent !== "object") continue;
      if (resolveStage(agent) === "blocked") {
        seen.add(`${agent.id}:blocked:${agent.summary}`);
      }
    }
    if (isAllTerminal) {
      seen.add("room:all-complete");
    }
    return false;
  }

  if (env?.HERDR_ENV !== "1" && !env?.HERDR_SOCKET && !env?.HERDR_PANE_ID) return false;
  if (!isAllTerminal) {
    seen.delete("room:all-complete");
  }
  let isTriggered = false;

  for (const agent of nextAgents) {
    if (!agent || typeof agent !== "object") continue;
    const stage = resolveStage(agent);
    if (stage !== "blocked") continue;
    const prev = prevAgents.find((item) => item?.id === agent.id);
    const prevStage = resolveStage(prev);
    const key = `${agent.id}:blocked:${agent.summary}`;
    if ((prevStage === "blocked" && prev?.summary === agent.summary) || seen.has(key)) continue;
    seen.add(key);
    isTriggered = true;
    void runExec(exec, "herdr", [
      "notification",
      "show",
      `Orkest: ${agent.person || agent.id} blocked`,
      "--body",
      String(agent.summary || "Needs attention"),
      "--sound",
      "request",
    ]);
  }

  const hadActive = prevAgents.some((agent) => {
    const stage = resolveStage(agent);
    return stage !== "" && !TERMINAL_STAGES.has(stage);
  });
  if (isAllTerminal && hadActive && !seen.has("room:all-complete")) {
    seen.add("room:all-complete");
    isTriggered = true;
    void runExec(exec, "herdr", [
      "notification",
      "show",
      "Orkest: Horde complete",
      "--body",
      `All ${nextAgents.length} agents finished.`,
      "--sound",
      "done",
    ]);
  }

  return isTriggered;
}

function toNotificationAgents(room) {
  return (room?.agents || []).map((agent) => ({
    ...agent,
    id: agent.id,
    person: agent.person || agent.progress?.person || shortAgentName(agent) || agent.id,
    stage: agent.stage || agent.progress?.stage || agent.status,
    summary:
      agent.summary ??
      agent.question ??
      (agent.progress?.task && agent.progress.task !== "not set"
        ? agent.progress.task
        : undefined) ??
      agent.objective ??
      "",
  }));
}

async function mtimeOrNull(filePath) {
  try {
    return (await stat(filePath)).mtimeMs;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function readRepoDeniedList(cwd, options = {}) {
  if (!cwd || typeof cwd !== "string") return [];
  const resolvedCwd = path.resolve(cwd);
  const deny = new Set();
  const collectDeny = (items) => {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (typeof item === "string" && item.trim()) deny.add(item.trim().toLowerCase());
    }
  };
  try {
    const repoPolicyPath = path.join(resolvedCwd, ".orkest", "policy.json");
    const repoPolicy = JSON.parse(await readFile(repoPolicyPath, "utf8"));
    collectDeny(repoPolicy?.deny || repoPolicy?.denied);
  } catch (error) {
    if (error.code !== "ENOENT") {
      // Ignore malformed optional policy files in TUI read path.
    }
  }
  try {
    const cfgPath = options.configPath || path.join(configHome(options.env), "config.json");
    const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
    const policies = cfg?.repo_policies || cfg?.repoPolicies;
    if (policies && typeof policies === "object" && !Array.isArray(policies)) {
      for (const [pattern, rule] of Object.entries(policies)) {
        if (!rule || typeof rule !== "object") continue;
        const resolvedPattern = path.resolve(pattern);
        if (
          resolvedCwd === resolvedPattern ||
          resolvedCwd.startsWith(`${resolvedPattern}${path.sep}`) ||
          path.basename(resolvedCwd) === pattern
        ) {
          collectDeny(rule.deny || rule.denied);
        }
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      // Ignore missing/unreadable global config in TUI read path.
    }
  }
  return [...deny];
}

export function filterAccountsByRepoPolicy(accounts, denyList = []) {
  if (!Array.isArray(accounts) || accounts.length === 0) return [];
  const deny = new Set(
    (Array.isArray(denyList) ? denyList : []).map((item) => String(item).trim().toLowerCase()),
  );
  if (deny.size === 0) return accounts.map((account) => ({ ...account }));
  return accounts
    .filter((account) => {
      const id = String(account?.id || "").toLowerCase();
      const provider = String(account?.provider || id).toLowerCase();
      const label = String(account?.label || "").toLowerCase();
      const isPersonalClaude =
        id === "plaude" ||
        id === "claude-personal" ||
        label.includes("personal") ||
        label.includes("plaude");
      const isWorkClaude = (provider === "claude" || id.startsWith("claude")) && !isPersonalClaude;
      if (
        isWorkClaude &&
        (deny.has("claude-work") || (deny.has("claude") && !deny.has("plaude")))
      ) {
        return false;
      }
      if (isPersonalClaude && (deny.has("plaude") || deny.has("claude-personal"))) {
        return false;
      }
      if ((provider === "codex" || id === "codex") && deny.has("codex")) {
        return false;
      }
      if (
        (provider === "antigravity" || id === "antigravity" || id === "agy") &&
        (deny.has("agy") || deny.has("antigravity"))
      ) {
        return false;
      }
      return !deny.has(id);
    })
    .map((account) => ({ ...account }));
}

/** Follow monitor's shared snapshot without starting provider CLIs from a display. */
export async function cachedQuota(cwd, options = {}) {
  const snapshotPath = path.join(CACHE_DIR, "snapshot.json");
  const snapshotMtimeMs = await mtimeOrNull(snapshotPath);
  if (snapshotMtimeMs === null) return [];
  const configMtimeMs = await mtimeOrNull(CONFIG_PATH);
  let baseAccounts;
  if (
    quotaCache.accounts &&
    quotaCache.snapshotPath === snapshotPath &&
    quotaCache.snapshotMtimeMs === snapshotMtimeMs &&
    quotaCache.configPath === CONFIG_PATH &&
    quotaCache.configMtimeMs === configMtimeMs
  ) {
    baseAccounts = quotaCache.accounts.map((account) => ({ ...account }));
  } else {
    let snapshot;
    try {
      snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    let config;
    try {
      config = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const entries = snapshot.accounts || {};
    const configured =
      config?.accounts ||
      Object.entries(entries).map(([id, entry]) => ({ ...entry, id: entry?.id || id }));
    const accounts = configured.map((account) => {
      const id = String(account?.id || "account");
      return {
        ...entries[id],
        ...account,
        id,
        label: account?.label || id,
        short: account?.short || id.slice(0, 2).toUpperCase(),
      };
    });
    Object.assign(quotaCache, {
      snapshotPath,
      snapshotMtimeMs,
      configPath: CONFIG_PATH,
      configMtimeMs,
      accounts,
    });
    baseAccounts = accounts.map((account) => ({ ...account }));
  }
  if (!cwd) return baseAccounts;
  const deny = await readRepoDeniedList(cwd, options);
  return filterAccountsByRepoPolicy(baseAccounts, deny);
}

export const readQuotaAccounts = cachedQuota;

function parseLsofListeners(raw) {
  const listeners = [];
  let currentPid = 0;
  let currentCmd = "";
  const rawLines = String(raw || "").split(/\r?\n/u);
  for (const line of rawLines) {
    if (!line) continue;
    const tag = line[0];
    const value = line.slice(1).trim();
    if (tag === "p") {
      currentPid = Math.trunc(Number(value)) || 0;
      currentCmd = "";
    } else if (tag === "c") {
      currentCmd = value;
    } else if (tag === "n" && currentPid > 0) {
      const portMatch = /:(\d+)$/u.exec(value);
      if (!portMatch) continue;
      const port = Math.trunc(Number(portMatch[1]));
      if (!Number.isSafeInteger(port) || port <= 0) continue;
      listeners.push({ pid: currentPid, command: currentCmd, port, endpoint: value });
    }
  }
  const byPort = new Map();
  for (const item of listeners) {
    if (!byPort.has(item.port)) byPort.set(item.port, item);
  }
  return byPort.values().toArray();
}

function parseLsofCwds(raw) {
  const cwds = new Map();
  let currentPid = 0;
  const rawLines = String(raw || "").split(/\r?\n/u);
  for (const line of rawLines) {
    if (!line) continue;
    const tag = line[0];
    const value = line.slice(1).trim();
    if (tag === "p") {
      currentPid = Math.trunc(Number(value)) || 0;
    } else if (tag === "n" && currentPid > 0 && path.isAbsolute(value)) {
      cwds.set(currentPid, value);
    }
  }
  return cwds;
}

function parsePsRows(raw) {
  const rows = new Map();
  const rawLines = String(raw || "").split(/\r?\n/u);
  for (const line of rawLines) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)(?:\s+(.*))?$/u.exec(line);
    if (!match) continue;
    const pid = Math.trunc(Number(match[1]));
    const ppid = Math.trunc(Number(match[2]));
    const etime = match[3].trim();
    const comm = match[4].trim();
    const args = (match[5] || "").trim();
    rows.set(pid, { pid, ppid, etime, comm, args });
  }
  return rows;
}

const KNOWN_SERVICE_TOKENS = [
  "vite",
  "next",
  "astro",
  "wrangler",
  "uvicorn",
  "gunicorn",
  "flask",
  "django",
  "storybook",
  "webpack",
  "parcel",
  "remix",
  "nuxt",
  "svelte",
  "esbuild",
  "rollup",
  "http-server",
  "serve",
  "prism",
  "wiremock",
  "mock",
  "postgres",
  "redis",
  "mysqld",
  "mongod",
  "minio",
  "caddy",
  "nginx",
  "rails",
  "puma",
  "spring",
  "gradle",
  "maven",
  "cargo",
  "deno",
  "bun",
];

const INTERNAL_OR_HARNESS_TOKENS = [
  "agy",
  "antigravity",
  "language_server",
  "claude",
  "plaude",
  "codex",
  "opencode",
  "cclsp",
  "tsserver",
  "vtsls",
  "rust-analyzer",
  "pyright",
  "ruff",
  "eslint",
  "mailbox_daemon",
  "peer_mailbox",
  "horde-tui",
  "agent_statusline",
  "tmux",
  "herdr",
  "code helper",
  "cursor",
  "electron",
  "crashpad",
];

function matchTokenInText(text, tokens) {
  const lower = String(text || "").toLowerCase();
  for (const token of tokens) {
    const escaped = token.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
    if (new RegExp(`(?:^|[^a-z0-9_])${escaped}(?:$|[^a-z0-9_])`, "u").test(lower)) return token;
  }
  return "";
}

function matchKnownServiceToken(command = "", comm = "", args = "") {
  return matchTokenInText(`${args} ${comm} ${command}`, KNOWN_SERVICE_TOKENS);
}

function isInternalOrHarnessProcess(command = "", comm = "", args = "", port = 0) {
  const execIdentity = `${path.basename(comm || "")} ${command} ${args}`;
  if (matchTokenInText(execIdentity, INTERNAL_OR_HARNESS_TOKENS)) {
    return true;
  }
  if (Number.isFinite(port) && port >= 49_152) {
    const knownToken = matchKnownServiceToken(command, comm, args);
    const hasExplicitPortFlag = /(?:^|\s)(?:--port(?:\s|=)|\b-p\s+\d+)/iu.test(args);
    if (!knownToken && !hasExplicitPortFlag) return true;
  }
  return false;
}

function inferServiceProcessName(command = "", comm = "", args = "") {
  const known = matchKnownServiceToken(command, comm, args);
  if (known) return known;
  const base = path.basename(comm || command || "process").trim();
  return base || "process";
}

function pathWithin(candidate, rootPath) {
  if (!candidate || !rootPath) return false;
  const resolvedCandidate = path.resolve(candidate);
  const resolvedRoot = path.resolve(rootPath);
  return (
    resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)
  );
}

/** Discover live TCP listeners and Docker containers belonging to the room's checkouts or agents. */
export async function probeRoomServices(room, { exec = execFile } = {}) {
  const explicit = Array.isArray(room?.services)
    ? room.services.filter((svc) => svc && typeof svc === "object").map((svc) => ({ ...svc }))
    : [];
  const members = [room?.conductor, ...(room?.agents || [])].filter(Boolean);
  const rootPaths = new Set();
  if (typeof room?.cwd === "string" && path.isAbsolute(room.cwd)) {
    rootPaths.add(path.resolve(room.cwd));
  }
  const ownerByPid = new Map();
  const worktreeByPath = new Map();
  for (const member of members) {
    const label = shortAgentName(member) || member.id || "agent";
    const pid = member.pid || member.progress?.pid;
    if (Number.isSafeInteger(pid) && pid > 0) ownerByPid.set(pid, label);
    const wtPath = member.worktree?.path;
    if (typeof wtPath === "string" && path.isAbsolute(wtPath)) {
      const resolvedWt = path.resolve(wtPath);
      rootPaths.add(resolvedWt);
      const slug = member.worktree?.slug || path.basename(resolvedWt);
      worktreeByPath.set(resolvedWt, {
        badge: member.worktree?.disposable ? `wt:${slug}` : slug,
        owner: label,
      });
    }
    const memberCwd = member.progress?.cwd || member.cwd || member.session?.cwd;
    if (typeof memberCwd === "string" && path.isAbsolute(memberCwd)) {
      rootPaths.add(path.resolve(memberCwd));
    }
  }
  if (rootPaths.size === 0 && ownerByPid.size === 0) return explicit;

  const discovered = [];
  const lsofOut = await runExecOutput(exec, "lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"]);
  const listeners = parseLsofListeners(lsofOut);
  if (listeners.length > 0) {
    const pids = [...new Set(listeners.map((item) => item.pid))];
    const pidArg = pids.join(",");
    const [psOut, cwdOut] = await Promise.all([
      runExecOutput(exec, "ps", ["-o", "pid=,ppid=,etime=,comm=,args=", "-p", pidArg]),
      runExecOutput(exec, "lsof", ["-a", "-p", pidArg, "-d", "cwd", "-Fn"]),
    ]);
    const psMap = parsePsRows(psOut);
    const cwdMap = parseLsofCwds(cwdOut);
    for (const listener of listeners) {
      const psInfo = psMap.get(listener.pid);
      if (isInternalOrHarnessProcess(listener.command, psInfo?.comm, psInfo?.args, listener.port)) {
        continue;
      }
      const cwd = cwdMap.get(listener.pid) || "";
      const pidOwner =
        ownerByPid.get(listener.pid) || (psInfo?.ppid ? ownerByPid.get(psInfo.ppid) : undefined);
      let matchedRoot = "";
      for (const rootPath of rootPaths) {
        if (pathWithin(cwd, rootPath) && rootPath.length > matchedRoot.length) {
          matchedRoot = rootPath;
        }
      }
      if (!pidOwner && !matchedRoot) continue;
      const wtMeta = matchedRoot ? worktreeByPath.get(matchedRoot) : undefined;
      let fallbackWorktree = "";
      if (cwd) fallbackWorktree = path.basename(cwd);
      else if (room?.cwd) fallbackWorktree = path.basename(room.cwd);
      const worktree = wtMeta?.badge || fallbackWorktree;
      const owner = pidOwner || wtMeta?.owner || "";
      const name = inferServiceProcessName(listener.command, psInfo?.comm, psInfo?.args);
      discovered.push({
        kind: "port",
        port: listener.port,
        pid: listener.pid,
        name,
        ...(cwd && { cwd }),
        ...(worktree && { worktree }),
        ...(owner && { owner }),
        ...(psInfo?.etime && { uptime: psInfo.etime }),
      });
    }
  }

  const dockerOut = await runExecOutput(exec, "docker", ["ps", "--format", "{{json .}}"]);
  const repoNames = new Set(
    [...rootPaths].map((rootPath) => path.basename(rootPath).toLowerCase()).filter(Boolean),
  );
  const dockerLines = String(dockerOut || "").split(/\r?\n/u);
  for (const line of dockerLines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let row;
    try {
      row = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const labels = String(row.Labels || "");
    const names = String(row.Names || "").trim();
    const mounts = String(row.Mounts || "");
    const workingDirMatch = /com\.docker\.compose\.project\.working_dir=([^,]+)/u.exec(labels);
    const projectMatch = /com\.docker\.compose\.project=([^,]+)/u.exec(labels);
    const workingDir = workingDirMatch ? workingDirMatch[1].trim() : "";
    const project = projectMatch ? projectMatch[1].trim().toLowerCase() : "";
    const hasMatchingPath = [...rootPaths].some(
      (rootPath) =>
        (workingDir && pathWithin(workingDir, rootPath)) || (mounts && mounts.includes(rootPath)),
    );
    const hasMatchingProject =
      (project && repoNames.has(project)) ||
      (names && [...repoNames].some((repo) => names.toLowerCase().includes(repo)));
    if (!hasMatchingPath && !hasMatchingProject) continue;
    const rawPorts = String(row.Ports || "").trim();
    const hostPortMatch = /:(\d+)->/u.exec(rawPorts);
    discovered.push({
      kind: "docker",
      name: names || "container",
      image: String(row.Image || "").trim() || names || "container",
      ...(hostPortMatch && { port: Math.trunc(Number(hostPortMatch[1])) }),
      ...(rawPorts && { ports: rawPorts }),
      ...(workingDir && { cwd: workingDir, worktree: path.basename(workingDir) }),
      ...(row.RunningFor && {
        uptime: String(row.RunningFor)
          .replace(/\s+ago$/iu, "")
          .trim(),
      }),
    });
  }

  const seenKeys = new Set();
  const merged = [];
  for (const svc of [...explicit, ...discovered]) {
    const key =
      svc.kind === "docker"
        ? `docker:${svc.name || svc.image || svc.port || ""}`
        : `port:${svc.port || svc.name || ""}:${svc.pid || ""}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    merged.push(svc);
  }
  return merged;
}

export async function cachedServices(
  room,
  { exec = execFile, now = Date.now, ttlMs = 5000, force = false } = {},
) {
  const key = String(room?.id || room?.cwd || "default");
  const stamp = typeof now === "function" ? now() : now;
  if (
    !force &&
    serviceCache.key === key &&
    stamp - serviceCache.fetchedAt < ttlMs &&
    Array.isArray(serviceCache.services)
  ) {
    return serviceCache.services.map((svc) => ({ ...svc }));
  }
  const services = await probeRoomServices(room, { exec });
  serviceCache.key = key;
  serviceCache.fetchedAt = stamp;
  serviceCache.services = services;
  return services.map((svc) => ({ ...svc }));
}

export async function cachedUpdateStatus({
  now = Date.now,
  ttlMs = 10 * 60 * 1000,
  force = false,
  checkFn = checkOrkestUpdate,
  exec = execFile,
  env = process.env,
  repoRoot,
  cacheDir,
} = {}) {
  const stamp = typeof now === "function" ? now() : now;
  if (!force && updateCache.status && stamp - updateCache.fetchedAt < ttlMs) {
    if (!updateCache.status.available) {
      return { ...updateCache.status };
    }
    const shouldCheckDisk =
      repoRoot !== undefined || cacheDir !== undefined || checkFn === checkOrkestUpdate;
    if (!shouldCheckDisk) {
      return { ...updateCache.status };
    }
    const resolvedRoot =
      repoRoot !== undefined || checkFn === checkOrkestUpdate
        ? await resolveOrkestRepoRoot({ repoRoot, env })
        : null;
    const [localHead, sharedState] = await Promise.all([
      resolvedRoot ? readLocalGitHeadSha(resolvedRoot) : null,
      cacheDir !== undefined || checkFn === checkOrkestUpdate
        ? readSharedUpdateState({ cacheDir, env })
        : null,
    ]);
    const targetSha = updateCache.status.remoteSha;
    const isTargetAlreadyLanded =
      Boolean(targetSha) &&
      (localHead === targetSha ||
        sharedState?.toSha === targetSha ||
        sharedState?.localSha === targetSha ||
        (sharedState?.status === "up_to_date" && sharedState?.remoteSha === targetSha));
    if (isTargetAlreadyLanded) {
      syncUpdateCacheAsCurrent(targetSha, stamp);
      return { ...updateCache.status };
    }
    if (localHead && updateCache.status.localSha && localHead !== updateCache.status.localSha) {
      if (
        sharedState?.toSha === localHead ||
        (sharedState?.status === "up_to_date" && sharedState?.localSha === localHead)
      ) {
        syncUpdateCacheAsCurrent(localHead, stamp);
        return { ...updateCache.status };
      }
    } else {
      return { ...updateCache.status };
    }
  }
  const checkOptions = {
    exec,
    ...(repoRoot && { repoRoot }),
    ...(cacheDir && { cacheDir }),
    ...(env && env !== process.env && { env }),
  };
  const res = await checkFn(checkOptions);
  const status = {
    available: Boolean(res?.updateAvailable || res?.available),
    commitsBehind: res?.commitsBehind || 0,
    localSha: res?.localSha,
    remoteSha: res?.remoteSha,
    dirty: Boolean(res?.dirty),
    status: res?.updateAvailable || res?.available ? "available" : res?.status || "up_to_date",
  };
  updateCache.fetchedAt = stamp;
  updateCache.status = status;
  return { ...status };
}

/** Own only terminal state; workers and room membership survive closing the display. */
export async function runHordeTui(
  load,
  {
    input = process.stdin,
    output = process.stdout,
    quota = true,
    services,
    update,
    updateCheck = checkOrkestUpdate,
    updateRunner = runOrkestUpdate,
    env = process.env,
    theme,
    exec = execFile,
  } = {},
) {
  if (!input.isTTY || !output.isTTY)
    throw new Error("Interactive view needs a terminal; use --print or --json");
  const enableServices = services ?? Boolean(quota && exec === execFile);
  const enableUpdate = update ?? Boolean(quota && exec === execFile);
  const loadRoom =
    typeof load === "function"
      ? load
      : async () => {
          const roomId = typeof load === "string" && load ? load : env?.ORKEST_ROOM_ID;
          return roomId ? readRoom(roomId, mailboxRoot(env)) : createRoom([]);
        };
  const initialRoom = await loadRoom();
  const notifiedSet = new Set();
  let prevAgents = toNotificationAgents(initialRoom);
  notifyHerdrTransitions(null, prevAgents, notifiedSet, { env, exec });
  let isNavigationPending = false;
  const view = new HordeView(initialRoom, {
    height: output.rows || 32,
    color: shouldUseColor(output),
    theme,
    inHerdr: Boolean(env?.HERDR_ENV === "1" || env?.ORKEST_HERDR_VIEW_STATE),
    onFocusPane: (agent) => {
      if (isNavigationPending) return;
      isNavigationPending = true;
      view.notice = `Opening ${shortAgentName(agent)}...`;
      void previewController
        .close()
        .then((snapshot) => !snapshot?.error && !isStopped && focusAgentPane(agent, { exec }))
        .then((opened) => {
          isNavigationPending = false;
          if (isStopped) return;
          view.notice = opened
            ? `Opened ${shortAgentName(agent)}`
            : "Could not open chat. Its terminal may have closed.";
          paint();
        });
    },
    onPreview: (agent) => {
      void previewController.open(agent);
    },
  });
  let isBusy = false;
  let errorText = "";
  let isStopped = false;
  let isRawModeChanged = false;
  let isInputResumed = false;
  let isAlternateScreen = false;
  let isCursorHidden = false;
  let isInputModeOwned = false;
  let lastLines = [];
  let terminalError;
  let timer;
  let refreshTimer;
  let resolveExit;
  let closeViewPromise;
  let updateState = null;
  const wasRaw = Boolean(input.isRaw);
  const width = () => output.columns || 80;
  const height = () => output.rows || 32;
  const refresh = async () => {
    if (isBusy || isStopped) return;
    isBusy = true;
    try {
      const room = await loadRoom();
      if (quota) {
        try {
          const accounts = await cachedQuota(room?.cwd, { env });
          if (accounts.length > 0) room.accounts = accounts;
        } catch (error) {
          room.quotaError = error.message;
        }
      }
      if (enableServices) {
        try {
          const discovered = await cachedServices(room, { exec });
          if (discovered.length > 0) room.services = discovered;
        } catch {
          // Service discovery is best-effort and must never disrupt the TUI.
        }
      }
      if (
        updateState?.status === "updated" &&
        Number.isFinite(updateState.completedAt) &&
        Date.now() - updateState.completedAt >= UPDATE_SUCCESS_TTL_MS
      ) {
        updateState = null;
      }
      if (updateState) {
        room.update = updateState;
      } else if (enableUpdate && !room.update) {
        try {
          const checked = await cachedUpdateStatus({ checkFn: updateCheck, exec, env });
          if (checked?.available) room.update = checked;
        } catch {
          // Update check is best-effort and must never disrupt the TUI.
        }
      }
      view.setRoom(room);
      try {
        await syncHerdrViewLabel(room, { env, exec });
      } catch {
        // Pane title sync is best-effort and must never disrupt the TUI.
      }
      const previewAgent = room.agents?.find((agent) => agent.id === view.preview?.agentId);
      if (view.preview && !previewAgent) await previewController.close();
      else await previewController.refresh(previewAgent);
      const nextAgents = toNotificationAgents(room);
      notifyHerdrTransitions(prevAgents, nextAgents, notifiedSet, { env, exec });
      prevAgents = nextAgents;
      errorText = "";
    } catch (error) {
      errorText = error.message;
    } finally {
      isBusy = false;
    }
    paint();
  };
  const paint = () => {
    if (isStopped) return;
    try {
      view.height = height();
      const lines = view.render(width());
      if (errorText && lines.length > 0) lines[lines.length - 1] = fit(errorText, width());
      const visible = lines.slice(0, Math.max(1, view.height));
      // Overwrite in place (\x1b[K clears trailing cells after drawing) inside synchronized output
      // (\x1b[?2026h ... \x1b[?2026l), updating only changed rows to prevent background-bar flicker.
      if (lastLines.length === visible.length) {
        const patches = [];
        for (const [index, line] of visible.entries()) {
          if (line !== lastLines[index]) {
            patches.push(`\u{1B}[${index + 1};1H${line}\u{1B}[K`);
          }
        }
        if (patches.length > 0) {
          output.write(`\u{1B}[?2026h${patches.join("")}\u{1B}[?2026l`);
          lastLines = visible;
        }
      } else {
        const frame = visible.map((line) => `${line}\u{1B}[K`).join("\r\n");
        output.write(`\u{1B}[?2026h\u{1B}[H${frame}\u{1B}[J\u{1B}[?2026l`);
        lastLines = visible;
      }
    } catch (error) {
      terminalError = error;
      cleanup();
    }
  };
  const previewController = createAgentPreview({
    env,
    exec,
    onChange: (snapshot) => {
      if (isStopped) return;
      view.setPreview(snapshot);
      paint();
    },
  });
  const cleanup = () => {
    if (isStopped) return;
    isStopped = true;
    clearInterval(timer);
    clearInterval(refreshTimer);
    input.off("data", onData);
    terminalInput.dispose();
    input.off("end", cleanup);
    input.off("close", cleanup);
    process.off("SIGINT", cleanup);
    process.off("SIGTERM", cleanup);
    process.off("SIGHUP", cleanup);
    output.off?.("resize", onResize);
    try {
      if (isRawModeChanged) input.setRawMode(wasRaw);
    } catch (error) {
      // Still restore the visible terminal even if the stream has already closed.
      terminalError ??= error;
    }
    if (isInputResumed) {
      try {
        input.pause();
      } catch (error) {
        terminalError ??= error;
      }
    }
    if (isAlternateScreen || isCursorHidden) {
      try {
        output.write(
          `${isInputModeOwned ? TERMINAL_INPUT_DISABLE : ""}${isCursorHidden ? "\u{1B}[?25h" : ""}${isAlternateScreen ? "\u{1B}[?1049l" : ""}`,
        );
      } catch (error) {
        terminalError ??= error;
      }
    }
    lastLines = [];
    resolveExit?.();
  };
  const closeView = async () => {
    try {
      await markHerdrViewClosed(initialRoom.id, env);
    } catch (error) {
      terminalError ??= error;
    } finally {
      cleanup();
    }
  };
  const handleAction = (action) => {
    if (action && typeof action === "object" && action.type === "close-view") {
      if (closeViewPromise) return;
      closeViewPromise = closeView();
    } else {
      if (action && typeof action === "object" && action.type === "close-preview") {
        void previewController.close();
      }
      if (action && typeof action === "object" && action.type === "mouse-toggle") {
        output.write(action.enabled ? MOUSE_ENABLE : MOUSE_DISABLE);
      }
      if (action && typeof action === "object" && action.type === "pull-update") {
        updateState = { available: false, status: "updating" };
        if (view.room) view.setRoom({ ...view.room, update: updateState });
        paint();
        void (async () => {
          try {
            const res = await updateRunner({ force: true, exec, env });
            const outcome = resolvePullUpdateOutcome(res);
            updateState = outcome.updateState;
            if (outcome.notice) view.notice = outcome.notice;
          } catch (error) {
            updateState = {
              available: false,
              status: "error",
              message: error.message,
            };
          }
          if (view.room) {
            const nextRoom = { ...view.room };
            if (updateState) nextRoom.update = updateState;
            else delete nextRoom.update;
            view.setRoom(nextRoom);
          }
          paint();
        })();
        return;
      }
      paint();
    }
  };
  const terminalInput = createTerminalInput({
    onKey: (text, key) => {
      const value = key?.sequence || text || "";
      handleAction(
        text === "q" || (key?.ctrl && key.name === "c")
          ? { type: "close-view" }
          : view.handleInput(value),
      );
    },
    onMouse: (event) => {
      if (view.mouseEnabled) handleAction(view.handleMouse(event));
    },
  });
  const onData = (chunk) => terminalInput.write(chunk);
  const onResize = () => {
    lastLines = [];
    paint();
  };
  try {
    input.setRawMode(true);
    isRawModeChanged = true;
    input.resume();
    isInputResumed = true;
    output.write("\u{1B}[?1049h\u{1B}[?25l");
    isAlternateScreen = true;
    isCursorHidden = true;
    isInputModeOwned = true;
    output.write(TERMINAL_INPUT_ENABLE);
    await new Promise((resolve) => {
      resolveExit = resolve;
      timer = setInterval(() => {
        if (view.needsAnimation) paint();
      }, 120);
      refreshTimer = setInterval(refresh, 1000);
      input.on("data", onData);
      input.on("end", cleanup);
      input.on("close", cleanup);
      process.on("SIGINT", cleanup);
      process.on("SIGTERM", cleanup);
      process.on("SIGHUP", cleanup);
      output.on?.("resize", onResize);
      paint();
      void refresh();
    });
  } finally {
    cleanup();
    await closeViewPromise;
    const remainingPreview = await previewController.dispose();
    if (remainingPreview?.error) terminalError ??= new Error(remainingPreview.error);
  }
  if (terminalError) throw terminalError;
}

export const runStoogesTui = runHordeTui;
export const runTui = runHordeTui;

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  await runHordeTui();
}
