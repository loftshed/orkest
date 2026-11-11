import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { shouldUseColor } from "../../monitor/lib/render.mjs";
import { CACHE_DIR, CONFIG_PATH } from "../../monitor/lib/store.mjs";
import { readAgentDiff } from "../lib/agent-diff.mjs";
import { createAgentPreview } from "../lib/agent-preview.mjs";
import {
  buildAgentProcesses,
  descendantsOf,
  inferServiceProcessName,
  isInternalOrHarnessProcess,
  parseProcessTable,
} from "../lib/agent-processes.mjs";
import { readDiffMarks, writeDiffMarks } from "../lib/diff-marks.mjs";
import {
  createHerdrLifecycleSubscriber,
  isCurrentHerdrAgent,
  verifiedHerdrAgentPane,
} from "../lib/herdr-context.mjs";
import { markHerdrViewClosed, syncHerdrViewLabel } from "../lib/herdr-view-state.mjs";
import { createRoom, mailboxRoot, readRoom } from "../lib/horde-room.mjs";
import { fit, HordeView, shortAgentName } from "../lib/horde-view.mjs";
import {
  isTerminalDisplayState,
  MEMBER_OUTCOMES,
  memberDisplayState,
} from "../lib/member-state.mjs";
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
const ORKEST_TMUX_SERVER = /^orkest-label-[0-9a-f]{12}$/u;

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
  agentProcesses: {},
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

async function runExecOutput(exec, command, args, env = process.env, timeoutMs = 1500) {
  try {
    if (exec === execFile) {
      return await new Promise((resolve) => {
        execFile(
          command,
          args,
          { env, timeout: timeoutMs, maxBuffer: 512 * 1024 },
          (err, stdout = "") => resolve(err ? "" : String(stdout || "")),
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

async function runExec(exec, command, args, env = process.env) {
  try {
    if (exec === execFile) {
      return await new Promise((resolve) => {
        execFile(command, args, { env, timeout: 3000 }, (err) => resolve(!err));
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

export async function focusAgentPane(agent, { exec = execFile, env = process.env } = {}) {
  if (!agent || typeof agent !== "object") return false;
  const rawHerdrPaneId = agent.herdrPaneId || agent.progress?.herdrPaneId;
  const herdrPaneId = typeof rawHerdrPaneId === "string" ? rawHerdrPaneId.trim() : "";
  if (herdrPaneId) {
    if (!PANE_ID_RE.test(herdrPaneId) || env.HERDR_ENV !== "1" || !isCurrentHerdrAgent(agent, env))
      return false;
    const session = agent.session?.id || agent.nativeSession || agent.activitySource?.session;
    if (typeof session !== "string" || !session) return false;
    const binary = env.HERDR_BIN_PATH || "herdr";
    const pane = await verifiedHerdrAgentPane(herdrPaneId, session, (args) =>
      runExecOutput(exec, binary, args, env),
    );
    return pane ? runExec(exec, binary, ["agent", "focus", pane], env) : false;
  }
  const rawPaneId = agent.paneId || agent.progress?.paneId;
  const paneId = typeof rawPaneId === "string" ? rawPaneId.trim() : "";
  if (paneId && PANE_ID_RE.test(paneId)) {
    const rawServer = agent.terminalServer || agent.progress?.terminalServer;
    const server = typeof rawServer === "string" ? rawServer.trim() : "";
    if (!ORKEST_TMUX_SERVER.test(server)) return false;
    const tmuxArgs = ["-L", server, "select-pane", "-t", paneId];
    return runExec(exec, "tmux", tmuxArgs);
  }
  return false;
}

function notificationSummary(agents) {
  const counts = new Map();
  for (const agent of agents) {
    const state = memberDisplayState(agent || {});
    // Finished/answered members await nobody, so they neither block nor join a review summary.
    if (MEMBER_OUTCOMES[state]?.neutral) continue;
    if (!isTerminalDisplayState(state)) return null;
    counts.set(state, (counts.get(state) || 0) + 1);
  }
  if (counts.size === 0) return null;
  const entries = [...counts].sort(([a], [b]) => a.localeCompare(b));
  const label = (state) => MEMBER_OUTCOMES[state]?.label || state;
  return {
    key: `room:outcomes:${JSON.stringify(entries)}`,
    title: entries.length === 1 ? `Swarm ${label(entries[0][0])}` : "Swarm outcomes",
    body:
      entries.length === 1
        ? `All ${entries[0][1]} agents ${label(entries[0][0])}.`
        : entries.map(([state, count]) => `${count} ${label(state)}`).join(" · ") + ".",
    sound: entries.every(([state]) => ["accepted", "supported"].includes(state))
      ? "done"
      : "request",
  };
}

export function notifyHerdrTransitions(
  prevAgents,
  nextAgents,
  notifiedSet,
  { env = process.env, exec = execFile } = {},
) {
  if (!Array.isArray(nextAgents)) return false;
  const seen = notifiedSet instanceof Set ? notifiedSet : new Set();
  const summary = notificationSummary(nextAgents);

  if (!Array.isArray(prevAgents)) {
    for (const agent of nextAgents) {
      if (!agent || typeof agent !== "object") continue;
      if (memberDisplayState(agent || {}) === "blocked") {
        seen.add(`${agent.id}:blocked:${agent.summary}`);
      }
    }
    if (summary) seen.add(summary.key);
    return false;
  }

  if (env?.HERDR_ENV !== "1") return false;
  if (!summary) {
    for (const key of seen) {
      if (key.startsWith("room:outcomes:")) seen.delete(key);
    }
  }
  let isTriggered = false;

  for (const agent of nextAgents) {
    if (!agent || typeof agent !== "object") continue;
    const stage = memberDisplayState(agent || {});
    if (stage !== "blocked") continue;
    const prev = prevAgents.find((item) => item?.id === agent.id);
    const prevStage = memberDisplayState(prev || {});
    const key = `${agent.id}:blocked:${agent.summary}`;
    if ((prevStage === "blocked" && prev?.summary === agent.summary) || seen.has(key)) continue;
    seen.add(key);
    isTriggered = true;
    void runExec(
      exec,
      env.HERDR_BIN_PATH || "herdr",
      [
        "notification",
        "show",
        `Orkest: ${agent.person || agent.id} blocked`,
        "--body",
        String(agent.summary || "Needs attention"),
        "--sound",
        "request",
      ],
      env,
    );
  }

  const hadKnownState = prevAgents.some((agent) => memberDisplayState(agent || {}) !== "unknown");
  const previous = notificationSummary(prevAgents);
  if (summary && hadKnownState && summary.key !== previous?.key && !seen.has(summary.key)) {
    seen.add(summary.key);
    isTriggered = true;
    void runExec(
      exec,
      env.HERDR_BIN_PATH || "herdr",
      [
        "notification",
        "show",
        `Orkest: ${summary.title}`,
        "--body",
        summary.body,
        "--sound",
        summary.sound,
      ],
      env,
    );
  }

  return isTriggered;
}

function toNotificationAgents(room) {
  return (room?.agents || []).map((agent) => ({
    ...agent,
    id: agent.id,
    person: agent.person || agent.progress?.person || shortAgentName(agent) || agent.id,
    stage: memberDisplayState(agent),
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
  const lines = String(raw || "").split(/\r?\n/u);
  for (const line of lines) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)(?:\s+(.*))?$/u.exec(line);
    if (!match) continue;
    const pid = Math.trunc(Number(match[1]));
    const ppid = Math.trunc(Number(match[2]));
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(ppid) || ppid < 0) {
      continue;
    }
    rows.set(pid, {
      pid,
      ppid,
      etime: match[3].trim(),
      comm: match[4].trim(),
      args: (match[5] || "").trim(),
    });
  }
  return rows;
}

function pathWithin(candidate, rootPath) {
  if (!candidate || !rootPath) return false;
  const resolvedCandidate = path.resolve(candidate);
  const resolvedRoot = path.resolve(rootPath);
  return (
    resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)
  );
}

/** Discover room services and the observed process descendants attached to room members. */
async function probeRoomDiscovery(room, { exec = execFile } = {}) {
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
  if (rootPaths.size === 0 && ownerByPid.size === 0) {
    return { services: explicit, agentProcesses: {} };
  }

  const discovered = [];
  const [lsofOut, processTableOut] = await Promise.all([
    runExecOutput(exec, "lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"]),
    runExecOutput(exec, "ps", ["-axo", "pid=,ppid=,etime=,args="], process.env, 2500),
  ]);
  const listeners = parseLsofListeners(lsofOut);
  const processTable = parseProcessTable(processTableOut);
  const listenerPids = [...new Set(listeners.map((listener) => listener.pid))];
  const listenerPsOut =
    listenerPids.length > 0
      ? await runExecOutput(exec, "ps", [
          "-o",
          "pid=,ppid=,etime=,comm=,args=",
          "-p",
          listenerPids.join(","),
        ])
      : "";
  const listenerPsRows = parsePsRows(listenerPsOut);
  const ignored = new Set([process.pid, ...descendantsOf(processTable, process.pid)]);
  const memberPidCounts = new Map();
  for (const member of members) {
    const pid = member.pid || member.progress?.pid;
    if (Number.isSafeInteger(pid) && pid > 0) {
      memberPidCounts.set(pid, (memberPidCounts.get(pid) || 0) + 1);
    }
  }
  const memberPids = new Set(memberPidCounts.keys());
  const uniqueTreeRoots = new Set(
    members
      .filter((member) => {
        const pid = member.pid || member.progress?.pid;
        return (
          Number.isSafeInteger(pid) &&
          memberPidCounts.get(pid) === 1 &&
          member.sharedProcess !== true
        );
      })
      .map((member) => member.pid || member.progress?.pid),
  );
  const uniqueTreeDescendants = new Set(
    [...uniqueTreeRoots].flatMap((pid) => [...descendantsOf(processTable, pid)]),
  );
  const sharedRoots = new Set(
    members
      .filter(
        (member) =>
          member.sharedProcess === true ||
          memberPidCounts.get(member.pid || member.progress?.pid) > 1,
      )
      .map((member) => member.pid || member.progress?.pid)
      .filter((pid) => Number.isSafeInteger(pid) && pid > 0),
  );
  const processCwdCandidates = new Set();
  for (const rootPid of sharedRoots) {
    for (const pid of descendantsOf(processTable, rootPid)) {
      if (!ignored.has(pid) && !memberPids.has(pid) && !uniqueTreeDescendants.has(pid)) {
        processCwdCandidates.add(pid);
      }
    }
  }
  const cwdProbePids = [
    ...new Set([
      ...listenerPids,
      ...[...processCwdCandidates].toSorted((left, right) => left - right).slice(0, 200),
    ]),
  ];
  const [cwdOut, dockerOut] = await Promise.all([
    cwdProbePids.length > 0
      ? runExecOutput(exec, "lsof", ["-a", "-p", cwdProbePids.join(","), "-d", "cwd", "-Fn"])
      : "",
    runExecOutput(exec, "docker", ["ps", "--format", "{{json .}}"]),
  ]);
  const cwdMap = parseLsofCwds(cwdOut);
  for (const listener of listeners) {
    const psInfo = listenerPsRows.get(listener.pid);
    const comm = psInfo?.comm || "";
    if (isInternalOrHarnessProcess(listener.command, comm, psInfo?.args, listener.port)) continue;
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
    const name = inferServiceProcessName(listener.command, comm, psInfo?.args);
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
  const services = [];
  for (const svc of [...explicit, ...discovered]) {
    const key =
      svc.kind === "docker"
        ? `docker:${svc.name || svc.image || svc.port || ""}`
        : `port:${svc.port || svc.name || ""}:${svc.pid || ""}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    services.push(svc);
  }
  const processMap = buildAgentProcesses({
    table: processTable,
    members,
    listeners: [
      ...listeners.map((listener) => ({
        ...listener,
        comm: listenerPsRows.get(listener.pid)?.comm || "",
      })),
      ...services,
    ],
    cwdByPid: cwdMap,
    ignore: ignored,
  });
  const agentProcesses = Object.fromEntries(
    [...processMap].map(([id, value]) => [
      id,
      {
        processes: value.processes.map((item) => ({ ...item, ports: [...item.ports] })),
        more: value.more,
      },
    ]),
  );
  return { services, agentProcesses };
}

export async function probeRoomServices(room, options = {}) {
  try {
    return (await probeRoomDiscovery(room, options)).services;
  } catch {
    return [];
  }
}

function cloneAgentProcesses(agentProcesses) {
  return Object.fromEntries(
    Object.entries(agentProcesses || {}).map(([id, value]) => [
      id,
      {
        processes: (Array.isArray(value?.processes) ? value.processes : []).map((item) => ({
          ...item,
          ports: Array.isArray(item.ports) ? [...item.ports] : [],
        })),
        more: Number.isSafeInteger(value?.more) ? value.more : 0,
      },
    ]),
  );
}

export async function cachedRoomDiscovery(
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
    return {
      services: serviceCache.services.map((svc) => ({ ...svc })),
      agentProcesses: cloneAgentProcesses(serviceCache.agentProcesses),
    };
  }
  let snapshot;
  try {
    snapshot = await probeRoomDiscovery(room, { exec });
  } catch {
    snapshot = { services: [], agentProcesses: {} };
  }
  serviceCache.key = key;
  serviceCache.fetchedAt = stamp;
  serviceCache.services = snapshot.services;
  serviceCache.agentProcesses = snapshot.agentProcesses;
  return {
    services: snapshot.services.map((svc) => ({ ...svc })),
    agentProcesses: cloneAgentProcesses(snapshot.agentProcesses),
  };
}

export async function cachedServices(room, options = {}) {
  return (await cachedRoomDiscovery(room, options)).services;
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
    herdrConnect,
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
  let diffGeneration = 0;
  const view = new HordeView(initialRoom, {
    height: output.rows || 32,
    color: shouldUseColor(output),
    theme,
    inHerdr: Boolean(env?.HERDR_ENV === "1" || env?.ORKEST_HERDR_VIEW_STATE),
    onFocusPane: (agent) => {
      diffGeneration++;
      if (isNavigationPending) return;
      isNavigationPending = true;
      view.notice = `Opening ${shortAgentName(agent)}...`;
      void previewController
        .close()
        .then((snapshot) => !snapshot?.error && !isStopped && focusAgentPane(agent, { exec, env }))
        .then((opened) => {
          isNavigationPending = false;
          if (isStopped) return;
          view.notice = opened
            ? `Opened ${shortAgentName(agent)}`
            : "Could not open chat. Its terminal may have closed.";
          paint();
        })
        .catch(() => {
          isNavigationPending = false;
          if (isStopped) return;
          view.notice = "Could not open chat. Its terminal may have closed.";
          paint();
        });
    },
    onPreview: (agent) => {
      diffGeneration++;
      void previewController.open(agent);
    },
    onDiff: (agent) => {
      const token = ++diffGeneration;
      const root = mailboxRoot(env);
      void previewController.close();
      view.setPreview({
        agentId: agent.id,
        title: shortAgentName(agent),
        kind: "diff",
        loading: true,
        text: "",
        files: [],
        stale: false,
        marks: [],
        marksStale: false,
      });
      paint();
      void readAgentDiff(agent, { exec })
        .then(async (snapshot) => {
          if (
            isStopped ||
            token !== diffGeneration ||
            view.preview?.kind !== "diff" ||
            view.preview.agentId !== agent.id
          )
            return;
          let markState = { marks: [], stale: false };
          try {
            markState = await readDiffMarks(initialRoom.id, agent, { root });
          } catch (error) {
            view.notice = `Could not load marks: ${error.message}`;
          }
          if (
            isStopped ||
            token !== diffGeneration ||
            view.preview?.kind !== "diff" ||
            view.preview.agentId !== agent.id
          )
            return;
          view.setPreview({ ...snapshot, marks: markState.marks, marksStale: markState.stale });
          paint();
        })
        .catch(() => {
          if (
            isStopped ||
            token !== diffGeneration ||
            view.preview?.kind !== "diff" ||
            view.preview.agentId !== agent.id
          )
            return;
          view.setPreview({
            agentId: agent.id,
            title: shortAgentName(agent),
            kind: "diff",
            loading: false,
            text: "The worker diff could not be read.",
            files: [],
            stale: false,
            available: false,
          });
          paint();
        });
    },
    onMarks: (agent, marks) => {
      void writeDiffMarks(initialRoom.id, agent, marks, { root: mailboxRoot(env) }).catch(
        (error) => {
          if (isStopped || view.preview?.agentId !== agent.id) return;
          view.notice = `Could not save marks: ${error.message}`;
          paint();
        },
      );
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
          const discovered = await cachedRoomDiscovery(room, { exec });
          if (discovered.services.length > 0) room.services = discovered.services;
          room.agentProcesses = discovered.agentProcesses;
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
  const herdrSubscriber =
    env?.HERDR_ENV === "1"
      ? createHerdrLifecycleSubscriber({
          env,
          ...(herdrConnect && { connect: herdrConnect }),
          onInvalidate: () => {
            if (!isStopped) void refresh();
          },
          onReconcile: () => {
            if (!isStopped) void refresh();
          },
        })
      : null;
  const cleanup = () => {
    if (isStopped) return;
    isStopped = true;
    herdrSubscriber?.stop();
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
      await markHerdrViewClosed(initialRoom.id, env, exec);
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
      herdrSubscriber?.start();
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

export const runTui = runHordeTui;

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  await runHordeTui();
}
