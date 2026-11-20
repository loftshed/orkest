import { execFile } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { readAgentDiff } from "../lib/agent-diff.mjs";
import { createAgentPreview } from "../lib/agent-preview.mjs";
import {
  buildAgentProcesses,
  descendantsOf,
  inferServiceProcessName,
  isInternalOrHarnessProcess,
  parseProcessTable,
} from "../lib/agent-processes.mjs";
import { ChiefView } from "../lib/chief-view.mjs";
import { createCompanionDismissMonitor } from "../lib/companion-dismiss.mjs";
import { readDiffMarks, writeDiffMarks } from "../lib/diff-marks.mjs";
import { defaultDockerProbeGuard } from "../lib/docker-probe.mjs";
import { openWorktreePane, resolveAgentPane, showNotification } from "../lib/herdr-cli.mjs";
import {
  createHerdrLifecycleSubscriber,
  herdrPaneIdsFromRoom,
  isCurrentHerdrAgent,
} from "../lib/herdr-context.mjs";
import { markHerdrViewClosed, syncHerdrViewLabel } from "../lib/herdr-view-state.mjs";
import { createRoom, mailboxRoot, readRoom } from "../lib/horde-room.mjs";
import { fit, formatWorktreeBadge, HordeView, shortAgentName } from "../lib/horde-view.mjs";
import { resolveMacosHudBinary, sendMacosHudToast } from "../lib/macos-hud.mjs";
import {
  isTerminalDisplayState,
  MEMBER_OUTCOMES,
  memberDisplayState,
} from "../lib/member-state.mjs";
import { shouldUseColor } from "../lib/monitor/render.mjs";
import { CACHE_DIR, CONFIG_PATH } from "../lib/monitor/store.mjs";
import {
  agentOrcaTerminal,
  isCurrentOrcaAgent,
  markOrcaViewClosed,
  resolveOrcaCli,
} from "../lib/orca-context.mjs";
import {
  isHarnessAllowed,
  normalizeAccountTags,
  normalizeDenyToken,
  resolvePolicyConfigPath,
  resolveRepoPolicy,
} from "../lib/policy.mjs";
import {
  ALT_SCROLL_DISABLE,
  createTerminalInput,
  MOUSE_DISABLE,
  MOUSE_ENABLE,
  TERMINAL_INPUT_DISABLE,
  TERMINAL_INPUT_ENABLE,
} from "../lib/tui-input.mjs";

export { resetDockerProbeGuard } from "../lib/docker-probe.mjs";
export { ALT_SCROLL_DISABLE, ALT_SCROLL_ENABLE } from "../lib/tui-input.mjs";
import {
  checkOrkestUpdate,
  getUpdateStatePath,
  readLocalGitHeadSha,
  resolveOrkestRepoRoot,
  runOrkestUpdate,
} from "../lib/update.mjs";

export const REPO_POLICY_CACHE_TTL_MS = 15_000;
export const UPDATE_SUCCESS_TTL_MS = 15_000;

const execFileAsync = promisify(execFile);
const PANE_ID_RE = /^[A-Za-z0-9_.:%][A-Za-z0-9_.:%-]{0,63}$/u;
const ORKEST_TMUX_SERVER = /^orkest-label-[0-9a-f]{12}$/u;
const repoPolicyCache = new Map();

export function resetRepoPolicyCache() {
  repoPolicyCache.clear();
}

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

async function runExecDetailed(exec, command, args, env = process.env, timeoutMs = 1500) {
  try {
    if (exec === execFile) {
      return await new Promise((resolve) => {
        execFile(
          command,
          args,
          { env, timeout: timeoutMs, maxBuffer: 512 * 1024 },
          (err, stdout = "") =>
            resolve({ ok: !err, stdout: err ? "" : String(stdout || ""), error: err || null }),
        );
      });
    }
    let callbackStdout = "";
    let callbackErr = null;
    const result = exec(command, args, (err, stdout = "") => {
      callbackErr = err || null;
      callbackStdout = String(stdout || "");
    });
    if (result && typeof result.then === "function") {
      const awaited = await result;
      if (typeof awaited === "string") return { ok: true, stdout: awaited, error: null };
      if (awaited && typeof awaited.stdout === "string") {
        return { ok: true, stdout: awaited.stdout, error: null };
      }
      return {
        ok: !callbackErr,
        stdout: callbackErr ? "" : callbackStdout,
        error: callbackErr,
      };
    }
    if (typeof result === "string") return { ok: true, stdout: result, error: null };
    if (result && typeof result.stdout === "string") {
      return { ok: true, stdout: result.stdout, error: null };
    }
    return {
      ok: !callbackErr,
      stdout: callbackErr ? "" : callbackStdout,
      error: callbackErr,
    };
  } catch (error) {
    return { ok: false, stdout: "", error };
  }
}

async function runExecOutput(exec, command, args, env = process.env, timeoutMs = 1500) {
  return (await runExecDetailed(exec, command, args, env, timeoutMs)).stdout;
}

async function probeDockerPs({
  exec = execFile,
  env = process.env,
  now = Date.now,
  dockerProbe,
  checkDocker = false,
} = {}) {
  const stamp = typeof now === "function" ? now() : now;
  const shouldGuard = checkDocker || exec === execFile;
  let binaryKey = "";
  if (typeof dockerProbe === "function") {
    const ready = await dockerProbe({ env, now: stamp });
    if (!ready || ready.ok === false) return "";
    if (typeof ready.binaryKey === "string") binaryKey = ready.binaryKey;
  } else if (shouldGuard) {
    const ready = await defaultDockerProbeGuard.check({ env, now: stamp });
    if (!ready || ready.ok === false) return "";
    binaryKey = ready.binaryKey || "";
  }

  const res = await runExecDetailed(exec, "docker", ["ps", "--format", "{{json .}}"], env);
  if (!res.ok) {
    if (shouldGuard) {
      defaultDockerProbeGuard.recordFailure(res.error, { binaryKey, now: stamp });
    }
    return "";
  }
  if (shouldGuard) defaultDockerProbeGuard.recordSuccess();
  return res.stdout;
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

const chiefModule = { promise: null };

async function importChiefModule() {
  try {
    return await import("../lib/chief.mjs");
  } catch {
    return null;
  }
}

/** Load `lib/chief.mjs` lazily so plain room views never pay for (or depend on) Chief. */
export function loadChiefModule() {
  chiefModule.promise ??= importChiefModule();
  return chiefModule.promise;
}

/** The live machine-wide Chief binding, or null when none is bound or it cannot be read. */
export async function readLiveChief(env = process.env) {
  const chief = await loadChiefModule();
  if (typeof chief?.readChiefBinding !== "function") return null;
  try {
    const binding = await chief.readChiefBinding({ root: mailboxRoot(env), env });
    return binding && typeof binding === "object" && !binding.stale ? binding : null;
  } catch {
    return null;
  }
}

const CHIEF_ROOM_BACK_KEYS = new Set(["\t", "\u{1B}[Z", "\u{7F}", "\b"]);

/**
 * Open the existing worktree checkout of an agent whose terminal pane is gone. Never creates a
 * worktree.
 */
async function openAgentWorktree(agent, herdrPaneId, { exec, env, root }) {
  if (!agent.worktree?.path) return false;
  // The workspace that hosted the pane is only a hint; Herdr-side verification picks the source.
  const hosted = herdrPaneId.split(":", 1)[0];
  const workspaceId = hosted && hosted !== herdrPaneId ? hosted : undefined;
  try {
    await openWorktreePane(agent, { env, exec, root, workspaceId });
    return true;
  } catch {
    return false;
  }
}

function openFailureNotice(agent) {
  return agent?.worktree?.path
    ? "Could not open chat or its worktree. Its terminal may have closed."
    : "Could not open chat. Its terminal may have closed.";
}

/** Herdr-native notification with the macOS HUD (when installed) as fallback if Herdr declines. */
async function sendHerdrNotification(message, hud, { env, exec, exists, platform }) {
  const isShown = await showNotification(message, { env, exec });
  if (!isShown && platform === "darwin" && resolveMacosHudBinary(env, { exists })) {
    sendMacosHudToast(hud, { env, exec, exists, platform });
  }
  return isShown;
}

export async function focusAgentPane(
  agent,
  { exec = execFile, env = process.env, orcaCli, root } = {},
) {
  if (!agent || typeof agent !== "object") return false;
  const rawHerdrPaneId = agent.herdrPaneId || agent.progress?.herdrPaneId;
  const herdrPaneId = typeof rawHerdrPaneId === "string" ? rawHerdrPaneId.trim() : "";
  if (herdrPaneId) {
    if (!PANE_ID_RE.test(herdrPaneId) || env.HERDR_ENV !== "1" || !isCurrentHerdrAgent(agent, env))
      return false;
    const session = agent.session?.id || agent.nativeSession || agent.activitySource?.session;
    const binary = env.HERDR_BIN_PATH || "herdr";
    const pane =
      typeof session === "string" && session
        ? await resolveAgentPane(herdrPaneId, session, { env, exec })
        : null;
    if (pane && (await runExec(exec, binary, ["agent", "focus", pane], env))) return true;
    return openAgentWorktree(agent, herdrPaneId, { exec, env, root });
  }
  const orcaTerminal = agentOrcaTerminal(agent);
  if (orcaTerminal) {
    if (!isCurrentOrcaAgent(agent, env)) return false;
    const cli = orcaCli === undefined ? resolveOrcaCli(env) : orcaCli;
    if (!cli) return false;
    return runExec(exec, cli, ["terminal", "switch", "--terminal", orcaTerminal, "--json"], env);
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
  { env = process.env, exec = execFile, exists, platform = process.platform } = {},
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

  const isHerdr = env?.HERDR_ENV === "1";
  const isMacosHud =
    !isHerdr && platform === "darwin" && Boolean(resolveMacosHudBinary(env, { exists }));
  if (!isHerdr && !isMacosHud) return false;
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
    if (isHerdr) {
      void sendHerdrNotification(
        {
          title: `Orkest: ${agent.person || agent.id} blocked`,
          body: String(agent.summary || "Needs attention"),
          sound: "request",
        },
        {
          agent: String(agent.person || agent.id),
          body: String(agent.summary || "Needs attention"),
          sound: "request",
          status: "blocked",
          title: `${agent.person || agent.id} blocked`,
        },
        { env, exec, exists, platform },
      );
    } else {
      sendMacosHudToast(
        {
          agent: String(agent.person || agent.id),
          body: String(agent.summary || "Needs attention"),
          sound: "request",
          status: "blocked",
          title: `${agent.person || agent.id} blocked`,
        },
        { env, exec, exists, platform },
      );
    }
  }

  const hadKnownState = prevAgents.some((agent) => memberDisplayState(agent || {}) !== "unknown");
  const previous = notificationSummary(prevAgents);
  if (summary && hadKnownState && summary.key !== previous?.key && !seen.has(summary.key)) {
    seen.add(summary.key);
    isTriggered = true;
    if (isHerdr) {
      void sendHerdrNotification(
        { title: `Orkest: ${summary.title}`, body: summary.body, sound: summary.sound },
        {
          body: summary.body,
          sound: summary.sound,
          status: summary.sound === "done" ? "done" : "info",
          title: summary.title,
        },
        { env, exec, exists, platform },
      );
    } else {
      sendMacosHudToast(
        {
          body: summary.body,
          sound: summary.sound,
          status: summary.sound === "done" ? "done" : "info",
          title: summary.title,
        },
        { env, exec, exists, platform },
      );
    }
  }

  return isTriggered;
}

const CHIEF_KIND_TITLES = {
  blocked: "Worker blocked",
  escalation: "Escalation",
  failed: "Mission failed",
  question: "Question",
};

/** One display line: controls and runs of whitespace collapse, then the result is bounded. */
function singleLine(value, max) {
  const text = normalizeLine(value);
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

function normalizeLine(value) {
  if (typeof value !== "string") return "";
  return value
    .replaceAll(/\p{Cc}+/gu, " ")
    .replaceAll(/\s+/gu, " ")
    .trim();
}

function normalizeChiefKind(kind) {
  if (kind === "question" || kind === "awaiting-input") return "question";
  if (["escalation", "blocked", "failed"].includes(kind)) return kind;
  return null;
}

function listOf(value) {
  return Array.isArray(value) ? value : [];
}

function unattributedBucket(from) {
  const sender = typeof from === "string" ? from : from?.session || from?.name || "unknown";
  return `unattributed:${normalizeLine(sender) || "unknown"}`;
}

function chiefRoomLabel(room) {
  return singleLine(room.title || room.repo?.name || room.branch || room.id, 60);
}

/**
 * The drawer identities the displayed status carried, copied so later polls cannot change them.
 * A legacy status without identities yields empty lists, so nothing unidentified is acknowledged.
 */
function captureDrawerSnapshot(status) {
  const idList = (values) =>
    Array.isArray(values) ? values.filter((id) => typeof id === "string" && id) : [];
  const declared = status?.drawerSnapshot;
  if (declared && typeof declared === "object") {
    return {
      session: declared.session ?? null,
      revision: declared.revision ?? null,
      deskIds: idList(declared.deskIds),
      inboxIds: idList(declared.inboxIds),
    };
  }
  return { session: status?.chief?.session ?? null, revision: null, deskIds: [], inboxIds: [] };
}

/**
 * Every notifiable Chief item in a snapshot. Rooms and attributable desk records use their room
 * ID as the bucket; loose mail uses a stable unattributed bucket that includes its sender.
 */
function chiefTransitionCandidates(status) {
  const rooms = listOf(status.rooms).filter(
    (room) => room && typeof room === "object" && typeof room.id === "string" && room.id,
  );
  const labels = new Map(rooms.map((room) => [room.id, chiefRoomLabel(room)]));
  const failures = new Map();
  const raw = [];
  for (const room of rooms) {
    const label = labels.get(room.id);
    if (room.mission?.state === "failed") {
      const reason = normalizeLine(room.mission.reason) || "Mission failed";
      failures.set(room.id, reason);
      raw.push({ bucket: room.id, label, kind: "failed", text: reason });
    }
    for (const item of listOf(room.attention)) {
      raw.push({ bucket: room.id, label, kind: item?.kind, text: item?.text });
    }
  }
  for (const item of listOf(status.desk)) {
    if (!item || typeof item !== "object") continue;
    const roomId = typeof item.roomId === "string" && item.roomId ? item.roomId : null;
    raw.push(
      roomId
        ? { bucket: roomId, label: labels.get(roomId) || roomId, kind: item.kind, text: item.text }
        : {
            bucket: unattributedBucket(item.from),
            label: "Chief inbox",
            kind: item.kind,
            text: item.text,
          },
    );
  }
  for (const item of listOf(status.inbox)) {
    if (!item || typeof item !== "object") continue;
    raw.push({
      bucket: unattributedBucket(item.from),
      label: "Chief inbox",
      kind: item.kind,
      text: item.text,
    });
  }

  const candidates = [];
  const seenKeys = new Set();
  for (const entry of raw) {
    const kind = normalizeChiefKind(entry.kind);
    const text = normalizeLine(entry.text);
    if (!kind || !text) continue;
    const failure = failures.get(entry.bucket);
    // A failed mission's synthetic escalation repeats its reason; the failure already notified.
    if (
      kind === "escalation" &&
      failure &&
      (text === failure || text.includes(failure) || failure.includes(text))
    )
      continue;
    const key = JSON.stringify([entry.bucket, kind, text]);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    candidates.push({ key, kind, label: entry.label, text });
  }
  return candidates;
}

function notifyChief(candidate, { env, exec, exists, platform }) {
  const title = singleLine(`Chief: ${CHIEF_KIND_TITLES[candidate.kind]}`, 80);
  const body = singleLine(`${candidate.label}: ${candidate.text}`, 240);
  if (env?.HERDR_ENV === "1") {
    void sendHerdrNotification(
      { title, body, sound: "request" },
      {
        body,
        sound: "request",
        status: candidate.kind === "failed" ? "failed" : "blocked",
        title,
      },
      { env, exec, exists, platform },
    );
    return true;
  }
  if (platform !== "darwin" || !resolveMacosHudBinary(env, { exists })) return false;
  return sendMacosHudToast(
    {
      body,
      sound: "request",
      status: candidate.kind === "failed" ? "failed" : "blocked",
      title,
    },
    { env, exec, exists, platform },
  );
}

/**
 * Notify once per new Chief attention item. The first snapshot (no prevStatus) only seeds the
 * set. Items are keyed by bucket, normalized kind, and text, so timestamps, order, and repeats
 * never notify again.
 */
export function notifyChiefTransitions(
  prevStatus,
  nextStatus,
  notifiedSet,
  { env = process.env, exec = execFile, exists, platform = process.platform } = {},
) {
  if (!nextStatus || typeof nextStatus !== "object") return false;
  const seen = notifiedSet instanceof Set ? notifiedSet : new Set();
  const candidates = chiefTransitionCandidates(nextStatus);
  if (!prevStatus || typeof prevStatus !== "object") {
    for (const candidate of candidates) seen.add(candidate.key);
    return false;
  }
  let isTriggered = false;
  for (const candidate of candidates) {
    if (seen.has(candidate.key)) continue;
    seen.add(candidate.key);
    if (notifyChief(candidate, { env, exec, exists, platform })) isTriggered = true;
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

async function existingDirectoryAncestorAsync(rawPath, homeDir) {
  let target = String(rawPath || "").trim();
  if (target === "~") target = homeDir;
  else if (target.startsWith("~/")) target = path.join(homeDir, target.slice(2));
  let current;
  try {
    current = await realpath(target || process.cwd());
  } catch {
    current = path.resolve(target || process.cwd());
  }
  for (;;) {
    try {
      const info = await stat(current);
      if (info.isDirectory()) return await realpath(current);
    } catch {
      // Walk upward if stat fails.
    }
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

function isAsyncNonGitRepoError(error) {
  if (!error || error.killed || error.signal) return false;
  return (
    error.code === 128 &&
    String(error.stderr || "")
      .toLowerCase()
      .includes("not a git repository")
  );
}

function isAsyncMissingGitConfigKey(error) {
  if (!error || error.killed || error.signal) return false;
  return error.code === 1 && String(error.stderr || "").trim() === "";
}

async function resolveGitContextAsync(cwd, options = {}) {
  const homeDir = options.homeDir || options.env?.HOME || os.homedir();
  const targetDir = await existingDirectoryAncestorAsync(cwd, homeDir);
  const runAsync =
    typeof options.execAsync === "function"
      ? options.execAsync
      : (cmd, args, opts) => execFileAsync(cmd, args, opts);
  let repoRoot = targetDir;
  let remoteUrl = "";
  try {
    const topRes = await runAsync("git", ["-C", targetDir, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      timeout: 3000,
    });
    const out = String(topRes?.stdout ?? "").trim();
    if (out) repoRoot = out;
  } catch (error) {
    if (isAsyncNonGitRepoError(error)) {
      return { repoRoot, remoteUrl };
    }
    throw new Error(
      `Failed to resolve git repository root for ${targetDir}: ${error?.stderr?.trim() || error?.message || error}`,
      { cause: error },
    );
  }
  try {
    const remRes = await runAsync("git", ["-C", repoRoot, "config", "--get", "remote.origin.url"], {
      encoding: "utf8",
      timeout: 3000,
    });
    remoteUrl = String(remRes?.stdout ?? "").trim();
  } catch (error) {
    if (isAsyncMissingGitConfigKey(error) || isAsyncNonGitRepoError(error)) {
      remoteUrl = "";
    } else {
      throw new Error(
        `Failed to resolve git remote for ${repoRoot}: ${error?.stderr?.trim() || error?.message || error}`,
        { cause: error },
      );
    }
  }
  return { repoRoot, remoteUrl };
}

export async function readRepoDeniedList(cwd, options = {}) {
  if (!cwd || typeof cwd !== "string") return { available: true, deny: [] };
  const canUseCache =
    !options.config && options.remote === undefined && !options.forcePolicyRefresh;
  const cfgPath = resolvePolicyConfigPath(options);
  const cacheKey = `${cwd}\0${cfgPath}\0${options.homeDir || ""}`;
  const now = options.now ?? Date.now();
  const ttlMs = options.policyTtlMs ?? REPO_POLICY_CACHE_TTL_MS;

  if (canUseCache) {
    const cached = repoPolicyCache.get(cacheKey);
    if (cached && now - cached.resolvedAt < ttlMs) {
      const [cfgMtime, localMtime] = await Promise.all([
        mtimeOrNull(cfgPath),
        mtimeOrNull(cached.localPolicyPath),
      ]);
      if (cfgMtime === cached.configMtimeMs && localMtime === cached.localPolicyMtimeMs) {
        return { available: true, deny: cached.deny };
      }
    }
  }

  try {
    let policy;
    if (typeof options.policyResolver === "function") {
      policy = await options.policyResolver(cwd, options);
    } else {
      const { repoRoot, remoteUrl } = await resolveGitContextAsync(cwd, options);
      policy = resolveRepoPolicy(cwd, {
        ...options,
        repoRoot,
        remote: options.remote === undefined ? remoteUrl : options.remote,
        strict: true,
      });
    }
    const deny = Array.isArray(policy?.deny) ? policy.deny : [];
    const resolvedRepo = policy?.repo || cwd;
    if (canUseCache) {
      const localPolicyPath = path.join(resolvedRepo, ".orkest", "policy.json");
      const [configMtimeMs, localPolicyMtimeMs] = await Promise.all([
        mtimeOrNull(cfgPath),
        mtimeOrNull(localPolicyPath),
      ]);
      if (repoPolicyCache.size >= 64) {
        const oldestKey = repoPolicyCache.keys().next().value;
        repoPolicyCache.delete(oldestKey);
      }
      repoPolicyCache.set(cacheKey, {
        deny,
        repoRoot: resolvedRepo,
        localPolicyPath,
        configMtimeMs,
        localPolicyMtimeMs,
        resolvedAt: now,
      });
    }
    return { available: true, deny };
  } catch (error) {
    return {
      available: false,
      error: error?.message || "Repository policy evaluation failed",
    };
  }
}

export function filterAccountsByRepoPolicy(accounts, denyList = []) {
  if (!Array.isArray(accounts) || accounts.length === 0) return [];
  let rawDeny = denyList;
  if (denyList && !Array.isArray(denyList)) {
    if (denyList.available === false) return [];
    rawDeny = denyList.deny;
  }
  const normalizedDeny = (Array.isArray(rawDeny) ? rawDeny : [])
    .map((item) => normalizeDenyToken(String(item ?? "")))
    .filter(Boolean);
  if (normalizedDeny.length === 0) return accounts.map((account) => ({ ...account }));
  const policy = { deny: normalizedDeny };
  return accounts
    .filter((account) => {
      const tags = normalizeAccountTags(account);
      return isHarnessAllowed(
        null,
        {
          ...account,
          ...(tags.length > 0 && { tags }),
        },
        { policy },
      );
    })
    .map((account) => ({ ...account }));
}

/** Follow monitor's shared snapshot without starting provider CLIs from a display. */
export async function cachedQuota(cwd, options = {}) {
  const cacheDir = options.cacheDir || CACHE_DIR;
  const monitorConfigPath = options.monitorConfigPath || CONFIG_PATH;
  const snapshotPath = path.join(cacheDir, "snapshot.json");
  const snapshotMtimeMs = await mtimeOrNull(snapshotPath);
  if (snapshotMtimeMs === null) return [];
  const configMtimeMs = await mtimeOrNull(monitorConfigPath);
  let baseAccounts;
  if (
    quotaCache.accounts &&
    quotaCache.snapshotPath === snapshotPath &&
    quotaCache.snapshotMtimeMs === snapshotMtimeMs &&
    quotaCache.configPath === monitorConfigPath &&
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
      config = JSON.parse(await readFile(monitorConfigPath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const entries = snapshot.accounts || {};
    const configured =
      config?.accounts ||
      Object.entries(entries).map(([id, entry]) => ({ ...entry, id: entry?.id || id }));
    const accounts = configured.map((account) => {
      const id = String(account?.id || "account");
      const merged = {
        ...entries[id],
        ...account,
        id,
        label: account?.label || id,
        short: account?.short || id.slice(0, 2).toUpperCase(),
      };
      const tags = normalizeAccountTags(merged);
      if (tags.length > 0) merged.tags = tags;
      return merged;
    });
    Object.assign(quotaCache, {
      snapshotPath,
      snapshotMtimeMs,
      configPath: monitorConfigPath,
      configMtimeMs,
      accounts,
    });
    baseAccounts = accounts.map((account) => ({ ...account }));
  }
  if (!cwd) return baseAccounts;
  const policyState = await readRepoDeniedList(cwd, options);
  if (!policyState.available) {
    throw new Error(`Repository policy unavailable: ${policyState.error}`);
  }
  return filterAccountsByRepoPolicy(baseAccounts, policyState);
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
async function probeRoomDiscovery(
  room,
  { exec = execFile, env = process.env, now = Date.now, dockerProbe, checkDocker = false } = {},
) {
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
        badge: member.worktree?.disposable ? formatWorktreeBadge(slug) : slug,
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
    probeDockerPs({ exec, env, now, dockerProbe, checkDocker }),
  ]);
  const cwdMap = parseLsofCwds(cwdOut);
  for (const listener of listeners) {
    const psInfo = listenerPsRows.get(listener.pid);
    const comm = psInfo?.comm || "";
    if (isInternalOrHarnessProcess(listener.command, comm, psInfo?.args, listener.port, { env }))
      continue;
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
    env,
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
  {
    exec = execFile,
    env = process.env,
    now = Date.now,
    ttlMs = 5000,
    force = false,
    dockerProbe,
    checkDocker = false,
  } = {},
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
    snapshot = await probeRoomDiscovery(room, { exec, env, now, dockerProbe, checkDocker });
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
    mouse = true,
    exec = execFile,
    herdrConnect,
    chief,
    chiefHint,
    companionGraceMs,
    now,
    platform,
    exists,
  } = {},
) {
  if (!input.isTTY || !output.isTTY)
    throw new Error("Interactive view needs a terminal; use --print or --json");
  const enableServices = services ?? Boolean(quota && exec === execFile);
  const enableUpdate = update ?? Boolean(quota && exec === execFile);
  const chiefOptions = chief && typeof chief.loadStatus === "function" ? chief : null;
  const enableChiefHint = chiefHint ?? Boolean(quota && exec === execFile);
  const homeRoomId = chiefOptions?.homeRoomId || undefined;
  let mode = chiefOptions && chiefOptions.initialMode !== "room" ? "chief" : "room";
  let drilledRoomId;
  let roomGeneration = 0;
  let liveChief = null;
  let chiefRefreshedAt = 0;
  const loadRoom =
    typeof load === "function"
      ? load
      : async () => {
          const roomId = typeof load === "string" && load ? load : env?.ORKEST_ROOM_ID;
          return roomId ? readRoom(roomId, mailboxRoot(env)) : createRoom([]);
        };
  const loadActiveRoom = () =>
    drilledRoomId && typeof chiefOptions?.loadRoom === "function"
      ? chiefOptions.loadRoom(drilledRoomId)
      : loadRoom();
  const initialRoom = await loadRoom();
  const currentRoomId = () => view.room?.id || initialRoom.id;
  const notifiedSet = new Set();
  const chiefNotifiedSet = new Set();
  let isStopped = false;
  let chiefSnapshot = null;
  let chiefGeneration = 0;
  let chiefAppliedGeneration = 0;
  let isChiefActionPending = false;
  let prevAgents = toNotificationAgents(initialRoom);
  notifyHerdrTransitions(null, prevAgents, notifiedSet, {
    env,
    exec,
    ...(exists && { exists }),
    ...(platform && { platform }),
  });
  let isNavigationPending = false;
  let diffGeneration = 0;
  const view = new HordeView(initialRoom, {
    height: output.rows || 32,
    color: shouldUseColor(output),
    theme,
    mouseEnabled: mouse,
    inHerdr: Boolean(env?.HERDR_ENV === "1" || env?.ORKEST_HERDR_VIEW_STATE),
    // Only the embedded Herdr view pane retires on close; a stray q there must not close it.
    confirmClose: Boolean(env?.ORKEST_HERDR_VIEW_STATE),
    onFocusPane: (agent) => {
      diffGeneration++;
      if (isNavigationPending) return;
      isNavigationPending = true;
      view.notice = `Opening ${shortAgentName(agent)}...`;
      void previewController
        .close()
        .then(
          (snapshot) =>
            !snapshot?.error &&
            !isStopped &&
            focusAgentPane(agent, { exec, env, root: view.room?.cwd }),
        )
        .then((opened) => {
          isNavigationPending = false;
          if (isStopped) return;
          view.notice = opened ? `Opened ${shortAgentName(agent)}` : openFailureNotice(agent);
          paint();
        })
        .catch(() => {
          isNavigationPending = false;
          if (isStopped) return;
          view.notice = openFailureNotice(agent);
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
            markState = await readDiffMarks(currentRoomId(), agent, { root });
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
      void writeDiffMarks(currentRoomId(), agent, marks, { root: mailboxRoot(env) }).catch(
        (error) => {
          if (isStopped || view.preview?.agentId !== agent.id) return;
          view.notice = `Could not save marks: ${error.message}`;
          paint();
        },
      );
    },
  });
  view.chiefEnabled = Boolean(chiefOptions);
  const chiefView = chiefOptions
    ? new ChiefView(null, {
        height: output.rows || 32,
        color: shouldUseColor(output),
        theme,
        mouseEnabled: mouse,
        confirmClose: view.confirmClose,
        lastRoomId: homeRoomId,
      })
    : null;
  // Refreshes apply in start order: an older poll that resolves late cannot overwrite a newer frame.
  const refreshChief = async () => {
    const generation = ++chiefGeneration;
    try {
      const status = await chiefOptions.loadStatus();
      if (isStopped || generation < chiefAppliedGeneration) return;
      try {
        notifyChiefTransitions(chiefSnapshot, status, chiefNotifiedSet, {
          env,
          exec,
          ...(exists && { exists }),
          ...(platform && { platform }),
        });
      } catch {
        // A notification backend must never block the Chief view from updating.
      }
      chiefSnapshot = status;
      chiefAppliedGeneration = generation;
      chiefView.setStatus(status);
      liveChief =
        status?.chief &&
        typeof status.chief === "object" &&
        status.chief.live &&
        !status.chief.stale
          ? status.chief
          : null;
    } catch (error) {
      if (isStopped || generation < chiefAppliedGeneration) return;
      chiefView.notice = `Could not read Chief status: ${error.message}`;
    }
    chiefRefreshedAt = Date.now();
  };
  if (chiefView) await refreshChief();
  // Room views always create chiefView for Tab switching; only initialMode !== "room" is a Chief session.
  const isChiefSession = Boolean(chiefOptions && chiefOptions.initialMode !== "room");
  const companionDismiss = createCompanionDismissMonitor({
    chiefMode: isChiefSession,
    env,
    exec,
    ...(companionGraceMs !== undefined && { graceMs: companionGraceMs }),
    hasChiefView: isChiefSession,
    ...(now && { now }),
  });
  if (mode === "room") await companionDismiss.evaluate(initialRoom);
  const activeView = () => (mode === "chief" && chiefView ? chiefView : view);
  if (chiefView) {
    const roomInput = view.handleInput.bind(view);
    view.handleInput = (value) => {
      if (mode === "chief") {
        if (value !== "q") view.closeArmedAt = undefined;
        return chiefView.handleInput(value);
      }
      if (
        CHIEF_ROOM_BACK_KEYS.has(value) ||
        (value === "\u{1B}" && !view.preview && !view.overlay)
      ) {
        view.closeArmedAt = undefined;
        chiefView.closeArmedAt = undefined;
        return { type: "chief-mode", mode: "chief" };
      }
      return roomInput(value);
    };
    const roomMouse = view.handleMouse.bind(view);
    view.handleMouse = (event) => {
      if (event?.action === "press") {
        view.closeArmedAt = undefined;
        chiefView.closeArmedAt = undefined;
      }
      return mode === "chief" ? chiefView.handleMouse(event) : roomMouse(event);
    };
    if (typeof view.requestClose === "function") {
      const roomClose = view.requestClose.bind(view);
      view.requestClose = () => {
        if (mode === "chief") {
          view.closeArmedAt = undefined;
          return chiefView.requestClose();
        }
        return roomClose();
      };
    }
  }
  let isBusy = false;
  let errorText = "";
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
    if (chiefView && (mode === "chief" || Date.now() - chiefRefreshedAt >= 5000)) {
      await refreshChief();
    }
    if (mode === "chief") {
      await companionDismiss.evaluate(null);
      isBusy = false;
      errorText = "";
      paint();
      return;
    }
    const generation = roomGeneration;
    try {
      const room = await loadActiveRoom();
      if (generation !== roomGeneration || mode !== "room") return;
      if (chiefView) {
        if (room && typeof room === "object") room.liveChief = liveChief ?? null;
      } else if (enableChiefHint) {
        const binding = await readLiveChief(env);
        if (room && typeof room === "object") room.liveChief = binding ?? null;
      }
      if (quota) {
        try {
          const accounts = await cachedQuota(room?.cwd, { env });
          delete room.quotaError;
          if (accounts.length > 0) room.accounts = accounts;
          else delete room.accounts;
        } catch (error) {
          delete room.accounts;
          room.quotaError = error.message;
        }
      }
      if (enableServices) {
        try {
          const discovered = await cachedRoomDiscovery(room, { exec, env });
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
      // Authoritative snapshot: watch exactly the panes of members still in this room.
      herdrSubscriber?.setPaneIds(herdrPaneIdsFromRoom(room, env));
      // A drilled-in room is borrowed: the pane label and notifications stay with the home room.
      if (!drilledRoomId) {
        try {
          await syncHerdrViewLabel(room, { env, exec });
        } catch {
          // Pane title sync is best-effort and must never disrupt the TUI.
        }
      }
      const previewAgent = room.agents?.find((agent) => agent.id === view.preview?.agentId);
      if (view.preview && !previewAgent) await previewController.close();
      else await previewController.refresh(previewAgent);
      if (!drilledRoomId) {
        const nextAgents = toNotificationAgents(room);
        notifyHerdrTransitions(prevAgents, nextAgents, notifiedSet, {
          env,
          exec,
          ...(exists && { exists }),
          ...(platform && { platform }),
        });
        prevAgents = nextAgents;
      }
      const dismissDecision = await companionDismiss.evaluate(room, { drilledRoomId });
      if (isStopped || generation !== roomGeneration || mode !== "room") return;
      if (dismissDecision.action === "hold") {
        view.notice = dismissDecision.notice;
      } else if (
        dismissDecision.action === "clear-notice" &&
        view.notice === "Orchestrator exited — keeping Swarm View open while workers finish"
      ) {
        view.notice = "";
      } else if (dismissDecision.action === "dismiss") {
        cleanup();
        return;
      }
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
      const active = activeView();
      active.height = height();
      const lines = active.render(width());
      if (errorText && lines.length > 0) lines[lines.length - 1] = fit(errorText, width());
      const visible = lines.slice(0, Math.max(1, active.height));
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
          paneIds: herdrPaneIdsFromRoom(initialRoom, env),
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
      if (env.ORKEST_ORCA_VIEW_STATE) await markOrcaViewClosed(env.ORKEST_ORCA_VIEW_STATE);
    } catch (error) {
      terminalError ??= error;
    } finally {
      cleanup();
    }
  };
  const openRoom = async (roomId) => {
    drilledRoomId = roomId && roomId !== homeRoomId ? roomId : undefined;
    const generation = ++roomGeneration;
    mode = "room";
    view.closeArmedAt = undefined;
    if (chiefView) chiefView.closeArmedAt = undefined;
    lastLines = [];
    diffGeneration++;
    await previewController.close();
    view.setPreview(null);
    view.overlay = undefined;
    view.page = 0;
    view.focusFollowsLatest = true;
    view.hasExplicitFocus = false;
    view.notice = "Loading room...";
    paint();
    try {
      const room = await loadActiveRoom();
      if (isStopped || generation !== roomGeneration) return;
      if (room && typeof room === "object") room.liveChief = liveChief ?? null;
      view.setRoom(room);
      view.notice = "";
    } catch (error) {
      if (isStopped || generation !== roomGeneration) return;
      view.notice = `Could not open room: ${error.message}`;
    }
    paint();
    void refresh();
  };
  const showChief = () => {
    roomGeneration++;
    mode = "chief";
    view.closeArmedAt = undefined;
    chiefView.closeArmedAt = undefined;
    lastLines = [];
    diffGeneration++;
    void previewController.close();
    view.setPreview(null);
    chiefView.lastRoomId = drilledRoomId || homeRoomId || view.room?.id;
    paint();
    void refresh();
  };
  const focusChiefTarget = async (action) => {
    const label = action.label || "pane";
    chiefView.notice = `Opening ${label}...`;
    paint();
    let isOpened;
    try {
      isOpened = await focusAgentPane(action.target, { exec, env });
    } catch {
      isOpened = false;
    }
    if (isStopped) return;
    chiefView.notice = isOpened
      ? `Opened ${label}`
      : "Could not focus that pane. Its terminal may have closed.";
    paint();
  };
  // Production resolves the library at action time; tests may inject `chief.send|desk|close`.
  const chiefOperation = async (injected, exportName) => {
    if (typeof injected === "function") return injected;
    const chief = await loadChiefModule();
    if (typeof chief?.[exportName] !== "function")
      throw new Error(`${exportName} is unavailable in this Orkest version`);
    return chief[exportName];
  };
  const chiefContext = () => ({ root: mailboxRoot(env), env });
  const chiefLabel = (roomId) => {
    const room = chiefView.status?.rooms?.find((item) => item?.id === roomId);
    return singleLine(room ? chiefRoomLabel(room) : roomId, 60);
  };
  const runChiefAction = ({ verb, pending, task }) => {
    if (isChiefActionPending) {
      chiefView.notice = "Still finishing the last Chief action";
      paint();
      return;
    }
    isChiefActionPending = true;
    chiefView.notice = pending;
    paint();
    void (async () => {
      try {
        chiefView.notice = singleLine(await task(), 160);
      } catch (error) {
        chiefView.notice = singleLine(`Could not ${verb}: ${error?.message || error}`, 160);
      } finally {
        isChiefActionPending = false;
      }
      await refreshChief();
      if (!isStopped) paint();
    })();
  };
  const replyToChief = (action) => {
    const label = singleLine(action.targetLabel || action.target, 60);
    runChiefAction({
      verb: `send to ${label}`,
      pending: `Sending to ${label}...`,
      task: async () => {
        const send = await chiefOperation(chiefOptions.send, "chiefSend");
        const result = await send({
          to: action.target,
          kind: "update",
          message: action.text,
          ...chiefContext(),
        });
        return result?.status === "queued"
          ? `Queued for ${label}; Chief will deliver it`
          : `Sent to ${label}`;
      },
    });
  };
  const acknowledgeDesk = () => {
    // Captured now, from the frame on screen, so mail arriving during the call is never consumed.
    const snapshot = captureDrawerSnapshot(chiefView.status);
    runChiefAction({
      verb: "acknowledge the desk",
      pending: "Acknowledging the desk...",
      task: async () => {
        const desk = await chiefOperation(chiefOptions.desk, "chiefDesk");
        await desk({ ack: true, snapshot, ...chiefContext() });
        return "Acknowledged the desk and unattributed inbox";
      },
    });
  };
  const closeChiefRoom = (roomId) => {
    const label = chiefLabel(roomId);
    runChiefAction({
      verb: `close ${label}`,
      pending: `Closing ${label}...`,
      task: async () => {
        const close = await chiefOperation(chiefOptions.close, "chiefClose");
        const result = await close({ roomId, force: false, ...chiefContext() });
        return result?.status === "already-closed"
          ? `${label} was already closed`
          : `Closed ${label}`;
      },
    });
  };
  const handleAction = (action) => {
    if (chiefView && action && typeof action === "object") {
      if (action.type === "chief-drill") {
        void openRoom(action.roomId);
        return;
      }
      if (action.type === "chief-reply") {
        replyToChief(action);
        return;
      }
      if (action.type === "chief-ack-desk") {
        acknowledgeDesk();
        return;
      }
      if (action.type === "chief-close-room") {
        closeChiefRoom(action.roomId);
        return;
      }
      if (action.type === "chief-mode") {
        if (action.mode === "chief") showChief();
        else void openRoom(action.roomId);
        return;
      }
      if (action.type === "chief-focus" || action.type === "chief-focus-chief") {
        void focusChiefTarget(action);
        return;
      }
    }
    if (action && typeof action === "object" && action.type === "close-view") {
      if (closeViewPromise) return;
      closeViewPromise = closeView();
    } else {
      if (action && typeof action === "object" && action.type === "close-preview") {
        void previewController.close();
      }
      if (action && typeof action === "object" && action.type === "mouse-toggle") {
        view.mouseEnabled = action.enabled;
        if (chiefView) chiefView.mouseEnabled = action.enabled;
        output.write(
          action.enabled
            ? `${MOUSE_ENABLE}${ALT_SCROLL_DISABLE}`
            : `${MOUSE_DISABLE}${ALT_SCROLL_DISABLE}`,
        );
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
      let action;
      if (key?.ctrl && key.name === "c") action = { type: "close-view" };
      // In Chief mode the literal q goes through the view so an active compose line consumes it.
      else if (text === "q" && mode !== "chief") action = view.requestClose();
      else action = view.handleInput(value);
      handleAction(action);
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
    output.write(
      view.mouseEnabled
        ? TERMINAL_INPUT_ENABLE
        : `${MOUSE_DISABLE}\u{1B}[?2004h${ALT_SCROLL_DISABLE}`,
    );
    await new Promise((resolve) => {
      resolveExit = resolve;
      timer = setInterval(() => {
        if (activeView().needsAnimation) paint();
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
