/**
 * Ork Chief: the machine-wide Master Orchestrator desk.
 *
 * One session per machine may hold the Chief desk (`<mailboxRoot>/chief.json`). The Chief
 * observes every room and standalone session on the machine, routes messages to them, and
 * spawns autonomous room orchestrators that report back to it. Reads never mutate state.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { listRawRooms, mailboxRoot, updateRawRoom } from "./horde-room.mjs";
import { isTerminalDisplayState, memberDisplayState } from "./member-state.mjs";
import { belongsToRoom, isPeerLive, newRoom, roomOwnerSessions } from "./rooms.mjs";
import { checkRepoPolicyForSide } from "./side.mjs";
import {
  provisionWorktree,
  resolveRepositoryRoot,
  validateWorktreeSlug,
} from "./worktree-provision.mjs";

export const CHIEF_SCHEMA = "ork.chief.v1";
export const CHIEF_STATUS_SCHEMA = "ork.chief.status.v1";
export const CHIEF_SPAWN_SCHEMA = "ork.chief.spawn.v1";
export const CHIEF_SEND_SCHEMA = "ork.chief.send.v1";
export const CHIEF_FOCUS_TEXT = "Ork Chief — machine-wide master orchestrator";

const SCRIPTS_DIR = fileURLToPath(new URL("../skills/orchestrate/scripts/", import.meta.url));
const PEER_MAILBOX_PY = path.join(SCRIPTS_DIR, "peer_mailbox.py");
const RUN_AGENT_PY = path.join(SCRIPTS_DIR, "run_agent.py");
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const KINDS = new Set(["done", "escalation", "question", "update"]);
const COORDINATOR_ENGINES = new Set(["agy", "claude", "codex", "opencode"]);
const NATIVE_UNREACHABLE =
  "ork chief routes between independent top-level sessions; native subagent tools cannot address them";
/** Without a PID we trust a fresh binding briefly, then require a live peer record. */
const UNVERIFIED_BINDING_GRACE_MS = 10 * 60 * 1000;
const RECENT_ROOM_MS = 2 * 60 * 60 * 1000;
const RECENT_MISSION_MS = 24 * 60 * 60 * 1000;
const MAX_GOAL_CHARS = 12_000;
const MAX_REPORT_CHARS = 600;

const WORKING_STATES = new Set([
  "active",
  "busy",
  "dispatched",
  "in-progress",
  "in_progress",
  "launching",
  "running",
  "starting",
  "working",
]);
const BLOCKED_STATES = new Set(["blocked", "failed", "rejected", "stale"]);
const AWAITING_STATES = new Set([
  "awaiting-input",
  "awaiting_input",
  "input",
  "needs-input",
  "needs_input",
  "waiting-input",
  "waiting_for_input",
]);

// ---------------------------------------------------------------------------
// Small helpers

function iso(nowMs) {
  return new Date(nowMs).toISOString();
}

function stampMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value) return NaN;
  return Date.parse(value);
}

function oneLine(value, max = 200) {
  if (typeof value !== "string") return "";
  const text = value.replaceAll(/\s+/gu, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readJson(file, maxBytes = 256 * 1024) {
  try {
    if (statSync(file).size > maxBytes) return null;
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/** Mirrors the mailbox's file naming for a session ID. */
export function sessionKey(session) {
  if (typeof session !== "string" || !SESSION_ID_RE.test(session)) return null;
  const key = session.replaceAll(":", "%3A");
  if (session === session.toLowerCase() && key.length <= 128) return key;
  const digest = createHash("sha1").update(session).digest("hex").slice(0, 10);
  return `${key.slice(0, 128)}~${digest}`;
}

export function sessionFromEnv(env = process.env) {
  for (const name of [
    "AGENT_MAILBOX_SESSION",
    "CLAUDE_CODE_SESSION_ID",
    "ANTIGRAVITY_CONVERSATION_ID",
    "CODEX_THREAD_ID",
  ]) {
    const value = env?.[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function engineOf(harness) {
  if (harness === "gemini") return "agy";
  return typeof harness === "string" && harness ? harness : null;
}

function defaultRunMailbox(args, { env = process.env } = {}) {
  const result = spawnSync("python3", [PEER_MAILBOX_PY, ...args], {
    encoding: "utf8",
    env,
    timeout: 30_000,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout || "",
    stderr: result.stderr || result.error?.message || "",
  };
}

function defaultLaunch(command, { cwd, env = process.env } = {}) {
  const [executable, ...args] = command;
  const result = spawnSync(executable, args, { cwd, encoding: "utf8", env, timeout: 120_000 });
  return {
    status: result.status ?? 1,
    stdout: result.stdout || "",
    stderr: result.stderr || result.error?.message || "",
  };
}

async function defaultQuotaReader(cwd, options) {
  const { cachedQuota } = await import("../bin/horde-tui.mjs");
  return cachedQuota(cwd, options);
}

// ---------------------------------------------------------------------------
// Git metadata without spawning git (status runs on every TUI refresh)

const gitCache = new Map();

export function gitInfo(cwd) {
  if (typeof cwd !== "string" || !path.isAbsolute(cwd))
    return { branch: "", repo: null, worktree: null };
  const cached = gitCache.get(cwd);
  if (cached && Date.now() - cached.at < 5000) return cached.info;
  let directory = path.resolve(cwd);
  let info = {
    branch: "",
    repo: { name: path.basename(directory), path: directory },
    worktree: null,
  };
  for (let depth = 0; depth < 64; depth++) {
    const dotGit = path.join(directory, ".git");
    let stats;
    try {
      stats = statSync(dotGit);
    } catch {
      stats = null;
    }
    if (stats) {
      info = describeCheckout(directory, dotGit, stats.isDirectory());
      break;
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  gitCache.set(cwd, { at: Date.now(), info });
  return info;
}

function describeCheckout(directory, dotGit, isDirectory) {
  let gitDirectory = dotGit;
  let repoPath = directory;
  let worktree = null;
  if (!isDirectory) {
    try {
      const match = /^gitdir:\s*(.+)$/mu.exec(readFileSync(dotGit, "utf8"));
      if (match) gitDirectory = path.resolve(directory, match[1].trim());
    } catch {
      /* An unreadable .git file leaves the checkout unclassified. */
    }
    const marker = `${path.sep}.git${path.sep}worktrees${path.sep}`;
    const index = gitDirectory.lastIndexOf(marker);
    if (index !== -1) {
      repoPath = gitDirectory.slice(0, index);
      worktree = { path: directory, slug: path.basename(directory) };
    }
  }
  let branch = "";
  try {
    const head = readFileSync(path.join(gitDirectory, "HEAD"), "utf8");
    branch = /^ref:\s*refs\/heads\/(.+)$/mu.exec(head)?.[1]?.trim() || "";
  } catch {
    /* Detached or unreadable HEAD: no branch. */
  }
  return { branch, repo: { name: path.basename(repoPath), path: repoPath }, worktree };
}

// ---------------------------------------------------------------------------
// Peers

export function readPeers(root = mailboxRoot(), { now = Date.now() } = {}) {
  let entries;
  try {
    entries = readdirSync(path.join(root, "peers"));
  } catch {
    return [];
  }
  const host = hostname();
  const peers = [];
  const sorted = entries.toSorted((left, right) => left.localeCompare(right));
  for (const entry of sorted) {
    if (!entry.endsWith(".json")) continue;
    const peer = readJson(path.join(root, "peers", entry), 64 * 1024);
    if (
      !isPlainObject(peer) ||
      peer.schema !== "agent-executor.peer.v1" ||
      typeof peer.session !== "string" ||
      typeof peer.name !== "string" ||
      typeof peer.cwd !== "string"
    )
      continue;
    if (peer.machine && peer.machine !== host) continue;
    peers.push({ ...peer, live: isPeerLive(peer, now) });
  }
  return peers;
}

function isRunPeer(peer) {
  return Boolean(peer.run) || peer.session.startsWith("run-");
}

function paneFields(...sources) {
  const pick = (key) => {
    for (const source of sources) {
      const value = source?.[key] ?? source?.progress?.[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return null;
  };
  return {
    herdrPaneId: pick("herdrPaneId"),
    herdrEndpoint: pick("herdrEndpoint"),
    paneId: pick("paneId"),
    terminalServer: pick("terminalServer"),
  };
}

// ---------------------------------------------------------------------------
// chief.json

export function chiefPath(root = mailboxRoot()) {
  return path.join(root, "chief.json");
}

function chiefLiveness(binding, peers, now) {
  if (binding.machine && binding.machine !== hostname())
    return { live: false, reason: "bound on another machine" };
  const peer = peers.find((candidate) => candidate.session === binding.session);
  if (peer?.live) return { live: true, peer };
  const alive = pidAlive(binding.pid);
  if (alive === false) return { live: false, reason: `process ${binding.pid} exited` };
  if (alive && !peer) return { live: true, peer: null };
  if (peer && !peer.live) return { live: false, reason: "mailbox peer is no longer live" };
  const ageMs = now - stampMs(binding.boundAt);
  if (Number.isFinite(ageMs) && ageMs <= UNVERIFIED_BINDING_GRACE_MS) return { live: true, peer };
  return { live: false, reason: "no live process or mailbox peer" };
}

/** The live Chief binding, or null. `includeStale` returns stale bindings flagged instead. */
export function readChiefBinding({
  root = mailboxRoot(),
  now = Date.now(),
  includeStale = false,
  peers,
} = {}) {
  const binding = readJson(chiefPath(root));
  if (
    !isPlainObject(binding) ||
    binding.schema !== CHIEF_SCHEMA ||
    typeof binding.session !== "string"
  )
    return null;
  const liveness = chiefLiveness(binding, peers || readPeers(root, { now }), now);
  if (liveness.live) {
    const peer = liveness.peer;
    return {
      ...binding,
      ...(peer && {
        name: peer.name || binding.name,
        model: peer.model || binding.model || null,
        ...Object.fromEntries(
          Object.entries(paneFields(peer)).map(([key, value]) => [
            key,
            value || binding[key] || null,
          ]),
        ),
      }),
      live: true,
      stale: false,
    };
  }
  return includeStale
    ? { ...binding, live: false, stale: true, staleReason: liveness.reason }
    : null;
}

export async function bindChief({
  root = mailboxRoot(),
  env = process.env,
  session,
  clear = false,
  force = false,
  now = Date.now(),
  runMailbox = defaultRunMailbox,
} = {}) {
  const self = session || sessionFromEnv(env);
  const current = readChiefBinding({ root, now, includeStale: true });
  const file = chiefPath(root);
  if (clear) {
    if (!current) return { action: "none", binding: null, previous: null };
    if (!force && !current.stale && current.session !== self)
      throw new Error(
        `The Chief desk is held by live session ${current.name || current.session}; pass --force to clear it`,
      );
    rmSync(file, { force: true });
    return { action: "cleared", binding: null, previous: current };
  }
  if (!self || !SESSION_ID_RE.test(self))
    throw new Error(
      "Pass --session <id> (or run inside an agent session with AGENT_MAILBOX_SESSION)",
    );
  const peer = readPeers(root, { now }).find((candidate) => candidate.session === self) || null;
  const panes = paneFields(peer, {
    herdrPaneId: env.HERDR_PANE_ID,
    paneId: env.TMUX_PANE,
  });
  const isSame = current?.session === self;
  const binding = {
    schema: CHIEF_SCHEMA,
    session: self,
    name: peer?.name || self,
    engine: engineOf(peer?.harness),
    model: peer?.model || null,
    cwd: peer?.checkout || peer?.cwd || process.cwd(),
    machine: hostname(),
    pid: Number.isSafeInteger(peer?.pid) ? peer.pid : null,
    pidBirth: peer?.pidBirth || null,
    ...panes,
    boundAt: isSame ? current.boundAt : iso(now),
    previous:
      current && !isSame
        ? {
            session: current.session,
            name: current.name || current.session,
            boundAt: current.boundAt || null,
            releasedAt: iso(now),
          }
        : current?.previous || null,
  };
  writeJsonAtomic(file, binding);
  const focus = runMailbox(["focus", "--session", self, "--text", CHIEF_FOCUS_TEXT], { env });
  let isNotified = false;
  if (current && !isSame && !current.stale) {
    const notice = runMailbox(
      [
        "send",
        "--session",
        self,
        "--to",
        current.session,
        "--scope",
        "cross-project",
        "--no-wake",
        "--native-unreachable",
        NATIVE_UNREACHABLE,
        "--text",
        `[chief] The Chief desk was taken by ${binding.name}. You are no longer the machine Chief.`,
      ],
      { env },
    );
    isNotified = notice.status === 0;
  }
  let action = "bound";
  if (isSame) action = "refreshed";
  else if (current && !current.stale) action = "taken";
  return {
    action,
    binding,
    previous: current && !isSame ? current : null,
    focus: focus.status === 0,
    notified: isNotified,
    desk: listDesk(root).length,
  };
}

// ---------------------------------------------------------------------------
// Chief desk: durable reports addressed to a Chief that is not currently live

function deskDir(root) {
  return path.join(root, "chief", "desk");
}

export function listDesk(root = mailboxRoot()) {
  let entries;
  try {
    entries = readdirSync(deskDir(root));
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.endsWith(".json"))
    .sort((left, right) => left.localeCompare(right))
    .map((entry) => ({
      file: path.join(deskDir(root), entry),
      ...readJson(path.join(deskDir(root), entry)),
    }))
    .filter((item) => typeof item.text === "string");
}

export function ackDesk(root = mailboxRoot()) {
  const items = listDesk(root);
  for (const item of items) rmSync(item.file, { force: true });
  return items.length;
}

function recordDesk(root, item, now) {
  const id = `${now}-${randomBytes(3).toString("hex")}`;
  const record = { schema: "ork.chief.desk.v1", id, ...item, at: iso(now) };
  writeJsonAtomic(path.join(deskDir(root), `${id}.json`), record);
  return record;
}

// ---------------------------------------------------------------------------
// Status snapshot

function classify(state, member) {
  const stage = member?.progress?.stage;
  if (AWAITING_STATES.has(state) || AWAITING_STATES.has(stage)) return "awaiting";
  if (BLOCKED_STATES.has(state) || state === "conductor_takeover") return "blocked";
  if (state === "review" && member?.runtimeState === "running") return "working";
  if (WORKING_STATES.has(state)) return "working";
  if (
    isTerminalDisplayState(state) ||
    ["answered", "cancelled", "finished", "reported"].includes(state)
  )
    return "done";
  return "idle";
}

function roomSessions(room) {
  const sessions = new Set(roomOwnerSessions(room));
  const members = room.agents || [];
  for (const member of members) {
    const ids = [member.session?.id, member.mailboxSession, member.nativeSession];
    for (const id of ids) if (typeof id === "string" && id) sessions.add(id);
  }
  if (room.chief?.mission?.session) sessions.add(room.chief.mission.session);
  return sessions;
}

function readInbox(root, session, limit = 200) {
  const key = sessionKey(session);
  if (!key) return [];
  const directory = path.join(root, "inbox", key);
  let entries;
  try {
    entries = readdirSync(directory).filter((entry) => entry.endsWith(".json"));
  } catch {
    return [];
  }
  return entries
    .sort((left, right) => left.localeCompare(right))
    .slice(-limit)
    .map((entry) => readJson(path.join(directory, entry), 64 * 1024))
    .filter(
      (message) => isPlainObject(message) && !message.readAt && typeof message.text === "string",
    );
}

function messageKind(text) {
  const match = /^\[chief:(\w+)\]/u.exec(text);
  if (match?.[1] === "escalation") return "escalation";
  if (match?.[1] === "question") return "awaiting-input";
  return "unread";
}

function coordinatorOf(room, peers) {
  const conductor = room.conductor || {};
  const owners = new Set(roomOwnerSessions(room));
  if (room.chief?.mission?.session) owners.add(room.chief.mission.session);
  const peer =
    peers.find((candidate) => candidate.live && owners.has(candidate.session)) ||
    peers.find((candidate) => owners.has(candidate.session)) ||
    null;
  const launchPid = room.chief?.launch?.pid;
  const pid = peer?.pid ?? conductor.pid ?? launchPid ?? null;
  let isLive = Boolean(peer?.live);
  if (!isLive && Number.isSafeInteger(launchPid)) isLive = pidAlive(launchPid) === true;
  if (!isLive && !peer && Number.isSafeInteger(conductor.pid))
    isLive = pidAlive(conductor.pid) === true;
  const session =
    peer?.session ||
    conductor.session?.id ||
    conductor.mailboxSession ||
    room.promotion?.session ||
    room.chief?.mission?.session ||
    null;
  return {
    session,
    name:
      peer?.name ||
      conductor.name ||
      session ||
      `${conductor.engine || "agent"}:${room.title || room.id}`,
    engine: conductor.engine || engineOf(peer?.harness),
    model: conductor.model || peer?.model || room.chief?.launch?.model || null,
    effort: conductor.effort || peer?.effort || room.chief?.launch?.effort || null,
    status: (isLive && peer?.state) || conductor.status || (isLive ? "running" : "idle"),
    pid: Number.isSafeInteger(pid) ? pid : null,
    live: isLive,
    ...paneFields(peer, conductor, {
      herdrPaneId: room.herdrCoordinatorPaneId,
      herdrEndpoint: room.herdrEndpoint,
    }),
  };
}

function summarizeRoom(room, { peers, inbox }) {
  const counts = { working: 0, blocked: 0, done: 0, idle: 0, total: 0 };
  const attention = [];
  const members = room.agents || [];
  for (const member of members) {
    const state = memberDisplayState(member);
    const bucket = classify(state, member);
    counts.total++;
    if (bucket === "awaiting") {
      counts.blocked++;
      attention.push({
        kind: "awaiting-input",
        from: member.id,
        text: oneLine(member.progress?.task || member.blocker || state),
        at: member.updatedAt || null,
      });
    } else {
      counts[bucket]++;
      if (bucket === "blocked")
        attention.push({
          kind: "blocked",
          from: member.id,
          text: oneLine(member.blocker || member.progress?.task || state),
          at: member.updatedAt || null,
        });
    }
  }
  const coordinator = coordinatorOf(room, peers);
  const conductorStage = room.conductor?.progress?.stage;
  if (AWAITING_STATES.has(conductorStage) || AWAITING_STATES.has(room.conductor?.status))
    attention.push({
      kind: "awaiting-input",
      from: coordinator.name,
      text: oneLine(room.conductor?.progress?.task || "Coordinator is waiting for input"),
      at: room.conductor?.progress?.updatedAt || null,
    });
  const sessions = roomSessions(room);
  for (const message of inbox) {
    if (!sessions.has(message.from?.session)) continue;
    message.claimed = true;
    attention.push({
      kind: messageKind(message.text),
      from: message.from?.name || message.from?.session,
      text: oneLine(message.text.replace(/^\[chief:\w+\]\s*/u, "")),
      at: message.sentAt || null,
    });
  }
  const hasBinding = Boolean(coordinator.session || room.chief?.launch);
  const missionOpen = room.chief && !["done", "failed"].includes(room.chief.state);
  if (hasBinding && !coordinator.live && (counts.working > 0 || missionOpen))
    attention.push({
      kind: "stale-coordinator",
      from: coordinator.name,
      text: "Coordinator session is not live",
      at: null,
    });
  const checkout = room.conductor?.worktree?.path || room.conductor?.cwd || room.cwd;
  const git = gitInfo(checkout);
  const worktree = room.conductor?.worktree?.path
    ? {
        slug: room.conductor.worktree.slug || path.basename(room.conductor.worktree.path),
        path: room.conductor.worktree.path,
      }
    : git.worktree;
  const last = (room.messages || []).at(-1);
  const latest = last
    ? {
        from: typeof last === "string" ? "peer-mailbox" : last.from || "peer-mailbox",
        text: oneLine(typeof last === "string" ? last : last.text),
        at: typeof last === "string" ? null : last.at || last.sentAt || null,
      }
    : null;
  const parent = room.chief?.parent;
  return {
    id: room.id,
    title: room.title || room.id,
    objective: oneLine(room.objective || "", 400),
    goal: room.chief?.goal ? oneLine(room.chief.goal, 400) : null,
    cwd: room.cwd || null,
    repo: git.repo,
    branch: room.conductor?.worktree?.branch || git.branch || "",
    worktree,
    coordinator,
    counts,
    stage: conductorStage || room.chief?.state || coordinator.status || "",
    task: oneLine(room.conductor?.progress?.task || room.objective || room.chief?.goal || "", 160),
    attention,
    latest,
    parentChief: parent ? { session: parent.session || null, name: parent.name || null } : null,
    updatedAt: room.updatedAt ? iso(stampMs(room.updatedAt)) : null,
    updatedMs: stampMs(room.updatedAt) || 0,
  };
}

function isActiveRoom(summary, room, now) {
  if (
    summary.coordinator.live ||
    summary.counts.working > 0 ||
    summary.counts.blocked > 0 ||
    summary.attention.some((item) => item.kind !== "stale-coordinator")
  )
    return true;
  // A Chief mission stays visible until it reports done or fails, even if its runner died.
  if (room.chief && !["done", "failed"].includes(room.chief.state)) return true;
  const spawnedMs = stampMs(room.chief?.spawnedAt);
  if (Number.isFinite(spawnedMs) && now - spawnedMs < RECENT_MISSION_MS) return true;
  return now - summary.updatedMs < RECENT_ROOM_MS;
}

function standaloneOf(peer) {
  const git = gitInfo(peer.checkout || peer.cwd);
  return {
    session: peer.session,
    name: peer.name,
    engine: engineOf(peer.harness),
    model: peer.model || null,
    status: peer.state || "active",
    stage: peer.progress?.stage || peer.taskStatus || "",
    task: oneLine(peer.focus || peer.progress?.task || "", 160),
    cwd: peer.checkout || peer.cwd,
    repo: git.repo,
    branch: peer.branch || git.branch || "",
    ...paneFields(peer),
    updatedAt: peer.lastSeenAt || null,
  };
}

export async function chiefStatus({
  root = mailboxRoot(),
  env = process.env,
  now = Date.now(),
  quota = true,
  all = false,
  cwd,
  listRooms = listRawRooms,
  quotaReader = defaultQuotaReader,
  peers: providedPeers,
} = {}) {
  const peers = providedPeers || readPeers(root, { now });
  const chief = readChiefBinding({ root, now, includeStale: true, peers });
  const host = hostname();
  let rawRooms = [];
  let roomsError;
  try {
    rawRooms = listRooms(root).filter(
      (room) => isPlainObject(room) && (!room.machine || room.machine === host),
    );
  } catch (error) {
    roomsError = error.message;
  }
  const inbox = chief?.live ? readInbox(root, chief.session) : [];
  const rooms = [];
  const boundSessions = new Set();
  const roomMatchers = [];
  for (const room of rawRooms) {
    if (room.archivedAt || room.status === "archived" || room.status === "closed") continue;
    for (const session of roomSessions(room)) boundSessions.add(session);
    const summary = summarizeRoom(room, { peers, inbox });
    if (!all && !isActiveRoom(summary, room, now)) continue;
    rooms.push(summary);
    const memberPaths = new Set(
      (room.agents || [])
        .map(
          (member) =>
            member.worktree?.path || (member.dispatch || member.worktree ? member.cwd : null),
        )
        .filter((value) => typeof value === "string" && value !== room.cwd)
        .map((value) => path.resolve(value)),
    );
    roomMatchers.push({
      room,
      summary,
      roomCwd: room.cwd ? path.resolve(room.cwd) : null,
      memberPaths,
    });
  }
  const standalone = [];
  for (const peer of peers) {
    if (
      !peer.live ||
      isRunPeer(peer) ||
      boundSessions.has(peer.session) ||
      chief?.session === peer.session
    )
      continue;
    const peerCwd = path.resolve(peer.checkout || peer.cwd);
    const owner = roomMatchers.find(
      ({ room, roomCwd, memberPaths }) =>
        roomCwd && belongsToRoom({ peerCwd, roomCwd, peer, room, memberPaths }),
    );
    if (owner) {
      owner.summary.counts.total++;
      if (peer.state === "busy") owner.summary.counts.working++;
      else owner.summary.counts.idle++;
      continue;
    }
    standalone.push(standaloneOf(peer));
  }
  const unattributed = inbox
    .filter((message) => !message.claimed)
    .map((message) => ({
      kind: messageKind(message.text),
      from: message.from?.name || message.from?.session || "unknown",
      text: oneLine(message.text.replace(/^\[chief:\w+\]\s*/u, "")),
      at: message.sentAt || null,
    }));
  const desk = listDesk(root).map((item) =>
    Object.fromEntries(Object.entries(item).filter(([key]) => key !== "file")),
  );
  rooms.sort(
    (left, right) =>
      right.attention.length - left.attention.length || right.updatedMs - left.updatedMs,
  );
  for (const room of rooms) {
    delete room.updatedMs;
  }
  const attentionItems = rooms.flatMap((room) => room.attention);
  const summary = {
    orchestrators: rooms.length,
    working:
      rooms.reduce((total, room) => total + room.counts.working, 0) +
      standalone.filter((peer) => peer.status === "busy").length,
    blocked: rooms.reduce((total, room) => total + room.counts.blocked, 0),
    attention: attentionItems.length + unattributed.length + desk.length,
    escalations:
      [...attentionItems, ...unattributed].filter((item) => item.kind === "escalation").length +
      desk.filter((item) => item.kind === "escalation").length,
    standalone: standalone.length,
    unread: inbox.length,
  };
  const status = {
    schema: CHIEF_STATUS_SCHEMA,
    generatedAt: iso(now),
    machine: host,
    chief: chief?.live ? chief : null,
    staleChief: chief?.stale
      ? { session: chief.session, name: chief.name || chief.session, reason: chief.staleReason }
      : null,
    summary,
    rooms,
    standalone,
    inbox: unattributed,
    desk,
    accounts: [],
  };
  if (roomsError) status.roomsError = roomsError;
  if (quota) {
    try {
      status.accounts = (await quotaReader(cwd || chief?.cwd || process.cwd(), { env })) || [];
    } catch (error) {
      status.quotaError = error.message;
    }
  }
  return status;
}

// ---------------------------------------------------------------------------
// Target resolution

function candidateOf(kind, label, session, extra = {}) {
  return { kind, label, session, ...extra };
}

/**
 * Resolve a send target. Tiers are tried in order; the first tier with exactly one distinct
 * session wins, and a tier with several distinct sessions is an ambiguity error.
 */
export function resolveChiefTarget(target, { status, rooms = [], peers = [] } = {}) {
  const wanted = String(target || "")
    .trim()
    .replace(/^@/u, "");
  if (!wanted) throw new Error("Pass --to <target>");
  const lower = wanted.toLowerCase();
  const livePeers = peers.filter((peer) => peer.live);
  const roomCoordinator = (room) =>
    status?.rooms?.find((summary) => summary.id === room.id)?.coordinator?.session ||
    room.conductor?.session?.id ||
    room.conductor?.mailboxSession ||
    room.chief?.mission?.session ||
    null;
  const tiers = [
    [
      "session",
      () => [
        ...livePeers
          .filter((peer) => peer.session === wanted)
          .map((peer) => candidateOf("session", peer.name, peer.session)),
        ...(status?.rooms || [])
          .filter((room) => room.coordinator?.session === wanted)
          .map((room) =>
            candidateOf("session", room.coordinator.name, wanted, { roomId: room.id }),
          ),
      ],
    ],
    [
      "chief",
      () => {
        if (lower !== "chief") return [];
        const chief = status?.chief;
        if (!chief) {
          const error = new Error("No live Chief is bound on this machine");
          error.code = "chief_unavailable";
          throw error;
        }
        return [candidateOf("chief", chief.name || chief.session, chief.session, { chief: true })];
      },
    ],
    [
      "room",
      () => {
        const room = rooms.find((candidate) => candidate.id === wanted);
        if (!room) return [];
        const session = roomCoordinator(room);
        if (!session) throw new Error(`Room ${room.id} has no coordinator session to message yet`);
        return [candidateOf("room", room.title || room.id, session, { roomId: room.id })];
      },
    ],
    [
      "name",
      () => [
        ...livePeers
          .filter((peer) => peer.name.toLowerCase() === lower)
          .map((peer) => candidateOf("name", peer.name, peer.session)),
        ...(status?.rooms || [])
          .filter(
            (room) => room.coordinator?.session && room.coordinator.name?.toLowerCase() === lower,
          )
          .map((room) =>
            candidateOf("name", room.coordinator.name, room.coordinator.session, {
              roomId: room.id,
            }),
          ),
      ],
    ],
    [
      "branch",
      () => [
        ...(status?.rooms || [])
          .filter(
            (room) =>
              room.coordinator?.session &&
              (room.branch === wanted || room.worktree?.slug === wanted),
          )
          .map((room) =>
            candidateOf(
              "branch",
              `${room.title} (${room.branch || room.worktree?.slug})`,
              room.coordinator.session,
              {
                roomId: room.id,
              },
            ),
          ),
        ...(status?.standalone || [])
          .filter((peer) => peer.branch === wanted)
          .map((peer) => candidateOf("branch", `${peer.name} (${peer.branch})`, peer.session)),
      ],
    ],
    [
      "repo",
      () => [
        ...(status?.rooms || [])
          .filter((room) => room.coordinator?.session && room.repo?.name?.toLowerCase() === lower)
          .map((room) =>
            candidateOf("repo", `${room.title} (${room.repo.name})`, room.coordinator.session, {
              roomId: room.id,
            }),
          ),
        ...(status?.standalone || [])
          .filter((peer) => peer.repo?.name?.toLowerCase() === lower)
          .map((peer) => candidateOf("repo", `${peer.name} (${peer.repo.name})`, peer.session)),
      ],
    ],
  ];
  for (const [tier, collect] of tiers) {
    const found = collect();
    const distinct = new Map(found.map((candidate) => [candidate.session, candidate]))
      .values()
      .toArray();
    if (distinct.length === 1) return { ...distinct[0], tier };
    if (distinct.length > 1) {
      const error = new Error(
        `Target "${wanted}" is ambiguous (${tier}); candidates:\n${distinct
          .map(
            (candidate) =>
              `  ${candidate.session}  ${candidate.label}${candidate.roomId ? `  [room ${candidate.roomId}]` : ""}`,
          )
          .join("\n")}`,
      );
      error.code = "ambiguous";
      error.exitCode = 2;
      error.candidates = distinct;
      throw error;
    }
  }
  const error = new Error(
    `No room, branch, repository, agent or session matches "${wanted}"; run ork chief status`,
  );
  error.code = "not_found";
  throw error;
}

// ---------------------------------------------------------------------------
// send

const MISSION_STATES = {
  done: "done",
  escalation: "blocked",
  question: "blocked",
  update: "running",
};

/** A child's report moves its mission state, so finished missions stop raising attention. */
async function recordMissionReport({ rooms, sender, env, kind, text, root, now }) {
  const room =
    rooms.find((candidate) => candidate.chief?.mission?.session === sender) ||
    (env.ORK_CHIEF_MISSION_SESSION === sender && env.ORK_CHIEF_ROOM
      ? rooms.find((candidate) => candidate.id === env.ORK_CHIEF_ROOM && candidate.chief)
      : null);
  if (!room) return null;
  const state = MISSION_STATES[kind || "update"];
  await updateRawRoom(
    room.id,
    (current) => {
      if (!current.chief) return current;
      current.chief.state = state;
      current.chief.reportedAt = iso(now);
      current.chief.lastReport = { kind: kind || "update", text: oneLine(text, MAX_REPORT_CHARS) };
      if (current.conductor) current.conductor.status = state === "done" ? "completed" : state;
      return current;
    },
    { root },
  );
  return { roomId: room.id, state };
}

export async function chiefSend({
  to,
  message,
  from,
  kind,
  noWake = false,
  root = mailboxRoot(),
  env = process.env,
  now = Date.now(),
  runMailbox = defaultRunMailbox,
  listRooms = listRawRooms,
} = {}) {
  const text = String(message || "").trim();
  if (!text) throw new Error("Message text is empty");
  if (kind !== undefined && kind !== null && !KINDS.has(kind))
    throw new Error(`--kind must be one of ${[...KINDS].join(", ")}`);
  const sender = from || sessionFromEnv(env);
  if (!sender || !SESSION_ID_RE.test(sender))
    throw new Error("Pass --from <session> (or set AGENT_MAILBOX_SESSION)");
  const peers = readPeers(root, { now });
  const status = await chiefStatus({ root, env, now, quota: false, listRooms, peers });
  let rooms;
  try {
    rooms = listRooms(root);
  } catch {
    rooms = [];
  }
  const body = kind ? `[chief:${kind}] ${text}` : text;
  const mission = await recordMissionReport({ rooms, sender, env, kind, text, root, now });
  let target;
  try {
    target = resolveChiefTarget(to, { status, rooms, peers });
  } catch (error) {
    if (error.code !== "chief_unavailable") throw error;
    const record = recordDesk(
      root,
      { from: sender, kind: kind || "update", text: oneLine(text, MAX_REPORT_CHARS * 4) },
      now,
    );
    return {
      schema: CHIEF_SEND_SCHEMA,
      mission,
      status: "queued",
      desk: record,
      target: { tier: "chief", session: null },
      woke: false,
    };
  }
  if (target.session === sender) throw new Error("That target is this session");
  const args = [
    "send",
    "--session",
    sender,
    "--to",
    target.session,
    "--scope",
    "cross-project",
    "--format",
    "json",
    "--native-unreachable",
    NATIVE_UNREACHABLE,
    "--text",
    body,
  ];
  if (noWake) args.push("--no-wake");
  const result = runMailbox(args, { env });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "peer_mailbox send failed").trim();
    if (target.chief) {
      const record = recordDesk(
        root,
        { from: sender, kind: kind || "update", text: oneLine(text, MAX_REPORT_CHARS * 4) },
        now,
      );
      return {
        schema: CHIEF_SEND_SCHEMA,
        mission,
        status: "queued",
        desk: record,
        target,
        woke: false,
        error: detail,
      };
    }
    throw new Error(`Mailbox delivery to ${target.label} failed: ${detail}`);
  }
  let delivery;
  try {
    delivery = JSON.parse(result.stdout);
  } catch {
    delivery = { raw: result.stdout.trim() };
  }
  return {
    schema: CHIEF_SEND_SCHEMA,
    mission,
    status: "sent",
    target,
    from: sender,
    woke: !noWake && Boolean(delivery?.wake) && delivery.wake.status !== "skipped",
    delivery,
  };
}

// ---------------------------------------------------------------------------
// spawn

function slugify(text, max = 32) {
  return (
    String(text || "")
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/gu, "-")
      .replaceAll(/^-+|-+$/gu, "")
      .slice(0, max)
      .replaceAll(/-+$/gu, "") || "mission"
  );
}

function shellQuote(value) {
  return /^[\w./:=@-]+$/u.test(value) ? value : `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

export function missionBrief({ roomId, goal, workspace, branch, chief, missionSession, title }) {
  const orkBin = fileURLToPath(new URL("../bin/ork.mjs", import.meta.url));
  const report = (kindName, sample) =>
    `node ${shellQuote(orkBin)} chief send --from ${missionSession} --to chief --kind ${kindName} "${sample}"`;
  return `# Ork Chief mission: ${title}

You are the autonomous **room orchestrator** for this mission, spawned by the machine Chief
(${chief?.name || "the bound Chief"}). Coordinate the work end to end in this workspace.

- Room: \`${roomId}\` (visible in \`ork chief status\` and the Chief View)
- Workspace: \`${workspace}\`${branch ? `\n- Branch: \`${branch}\`` : ""}
- Your Chief mailbox identity: \`${missionSession}\`

## Goal

${goal}

## Reporting contract (keep the Chief's context small)

1. First action: register and announce yourself: \`${report("update", "started: <one-line plan>")}\`
2. Report **only** milestones, blockers and completion, each at most ${MAX_REPORT_CHARS} characters:
   status, branch/PR, blocker, next ask. Put detail in files inside the workspace and send the path.
   - Blocked or need a decision: \`--kind escalation\` (or \`--kind question\`).
   - Finished: \`--kind done\` with branch, verification run and remaining risks.
3. Between steps, read Chief instructions:
   \`python3 ${shellQuote(PEER_MAILBOX_PY)} inbox --session ${missionSession}\`
4. Never push, merge, or spend paid credits unless the Chief tells you the user allowed it.
`;
}

function parseLaunchOutput(stdout) {
  const fields = {};
  const lines = String(stdout || "").split(/\r?\n/u);
  for (const line of lines) {
    const match = /^AGENT_([A-Z_]+)=(.*)$/u.exec(line.trim());
    if (match) fields[match[1]] = match[2];
  }
  const pid = Number(fields.JOB_PID);
  return {
    status: fields.JOB_STATUS || null,
    pid: Number.isSafeInteger(pid) && pid > 0 ? pid : null,
    job: fields.JOB || null,
    result: fields.RESULT || null,
    event: fields.EVENT || null,
    runMailbox: fields.MAILBOX || null,
  };
}

export async function chiefSpawn({
  cwd,
  worktree,
  branch,
  goal,
  goalFile,
  title,
  engine,
  model,
  effort,
  route,
  dryRun = false,
  timeout = "8h",
  root = mailboxRoot(),
  env = process.env,
  now = Date.now(),
  exec,
  launch = defaultLaunch,
  provision = provisionWorktree,
} = {}) {
  if (!cwd) throw new Error("Pass --cwd <repository>");
  let goalText = typeof goal === "string" ? goal.trim() : "";
  if (goalFile) {
    if (goalText) throw new Error("Choose --goal or --goal-file");
    goalText = readFileSync(path.resolve(goalFile), "utf8").trim();
  }
  if (!goalText) throw new Error("Pass --goal <text> or --goal-file <path>");
  if (goalText.length > MAX_GOAL_CHARS)
    throw new Error(`Goal must be at most ${MAX_GOAL_CHARS} characters`);
  if (engine === "gemini") engine = "agy";
  if (engine && !COORDINATOR_ENGINES.has(engine))
    throw new Error(`Unsupported engine ${engine}; choose ${[...COORDINATOR_ENGINES].join(", ")}`);
  const repoRoot = resolveRepositoryRoot(path.resolve(cwd), exec);
  const missionTitle = oneLine(title || goalText.split(/\r?\n/u, 1)[0], 80);
  const suffix = randomBytes(2).toString("hex");
  const isWorktreeRequested = Boolean(worktree || branch);
  let slug = null;
  let branchName = null;
  if (isWorktreeRequested) {
    slug =
      typeof worktree === "string" && worktree ? worktree : slugify(branch || missionTitle, 40);
    if (!(typeof worktree === "string" && worktree)) slug = `${slugify(slug, 40)}-${suffix}`;
    validateWorktreeSlug(slug);
    branchName = branch || `chief/${slug}`;
  }
  const roomId = `chief-${slug || `${slugify(missionTitle, 40)}-${suffix}`}`.slice(0, 64);
  const missionSession = `${roomId}-orch`;
  const plannedWorkspace = isWorktreeRequested ? path.join(repoRoot, ".worktrees", slug) : repoRoot;
  let policy = { ok: true, engine: engine || null, extraArgs: [] };
  if (engine) {
    policy = checkRepoPolicyForSide(repoRoot, engine, { env });
    if (!policy.ok)
      throw new Error(policy.error || `Engine ${engine} is denied by repository policy`);
  }
  const launchEngine = policy.engine || engine || null;
  // A route picks its own engine; otherwise a long-lived orchestrator defaults to Claude.
  const selectedEngine = launchEngine || (route ? null : "claude");
  const roomEngine = selectedEngine || "claude";
  const chief = readChiefBinding({ root, now });
  const parent = {
    alias: "chief",
    session: chief?.session || null,
    name: chief?.name || null,
    boundAt: chief?.boundAt || null,
  };
  const missionDir = path.join(root, "chief", "missions", roomId);
  const briefPath = path.join(missionDir, "brief.md");
  const jobDir = path.join(missionDir, "job");
  const command = [
    "python3",
    RUN_AGENT_PY,
    "--cwd",
    plannedWorkspace,
    "--brief",
    briefPath,
    "--transport",
    "executor",
    "--detach",
    "--job-dir",
    jobDir,
    "--notify",
    "none",
    "--allow-path",
    ".",
    "--timeout",
    timeout,
    ...(route ? ["--route", route] : []),
    ...(selectedEngine ? ["--engine", selectedEngine] : []),
    ...(model ? ["--model", model] : []),
    ...(effort ? ["--effort", effort] : []),
    ...(policy.extraArgs || []),
  ];
  const brief = missionBrief({
    roomId,
    goal: goalText,
    workspace: plannedWorkspace,
    branch: branchName,
    chief,
    missionSession,
    title: missionTitle,
  });
  const warnings = [];
  if (!chief)
    warnings.push("No live Chief is bound; reports will queue on the Chief desk until one binds");
  if (!isWorktreeRequested)
    warnings.push(
      "The mission runs in the main checkout and holds its worktree lease; use --worktree to run several missions in one repository",
    );
  const plan = {
    schema: CHIEF_SPAWN_SCHEMA,
    dryRun,
    status: dryRun ? "planned" : "launching",
    roomId,
    title: missionTitle,
    repo: { name: path.basename(repoRoot), path: repoRoot },
    workspace: plannedWorkspace,
    worktree: isWorktreeRequested ? { slug, branch: branchName, path: plannedWorkspace } : null,
    parentChief: parent,
    missionSession,
    engine: selectedEngine,
    route: route || null,
    model: model || null,
    effort: effort || null,
    briefPath,
    jobDir,
    command,
    ...(dryRun && { brief }),
    warnings,
  };
  if (dryRun) return plan;

  let workspace = repoRoot;
  let worktreeInfo = null;
  if (isWorktreeRequested) {
    worktreeInfo = provision(repoRoot, { slug, branch: branchName, ...(exec && { exec }) });
    workspace = worktreeInfo.path;
  }
  await newRoom([], {
    id: roomId,
    cwd: workspace,
    title: missionTitle,
    objective: goalText,
    engine: roomEngine,
    model: model || undefined,
    group: path.basename(repoRoot),
    root,
  });
  const spawnedAt = iso(now);
  await updateRawRoom(
    roomId,
    (room) => {
      room.conductor = {
        ...room.conductor,
        status: "launching",
        mailboxSession: missionSession,
        ...(effort && { effort }),
        ...(worktreeInfo && {
          worktree: {
            disposable: false,
            path: worktreeInfo.path,
            branch: worktreeInfo.branch,
            slug: worktreeInfo.slug,
            parentCwd: worktreeInfo.parentCwd,
          },
        }),
      };
      room.chief = {
        parent,
        goal: goalText,
        spawnedAt,
        state: "launching",
        mission: { session: missionSession, briefPath, jobDir },
        launch: {
          engine: selectedEngine,
          route: route || null,
          model: model || null,
          effort: effort || null,
        },
      };
      return room;
    },
    { root },
  );
  mkdirSync(missionDir, { recursive: true, mode: 0o700 });
  writeFileSync(briefPath, brief, { mode: 0o600 });
  const finalCommand = command.map((part) => (part === plannedWorkspace ? workspace : part));
  const launched = launch(finalCommand, {
    cwd: workspace,
    env: { ...env, ORK_CHIEF_ROOM: roomId, ORK_CHIEF_MISSION_SESSION: missionSession },
  });
  const info = parseLaunchOutput(launched.stdout);
  const isOk = launched.status === 0;
  await updateRawRoom(
    roomId,
    (room) => {
      room.chief.state = isOk ? "running" : "failed";
      room.chief.launch = {
        ...room.chief.launch,
        status: isOk ? info.status || "started" : "failed",
        pid: info.pid,
        job: info.job,
        result: info.result,
        runMailbox: info.runMailbox,
        launchedAt: iso(now),
        ...(!isOk && {
          error: oneLine(launched.stderr || launched.stdout || "launch failed", 400),
        }),
      };
      room.conductor.status = isOk ? "running" : "failed";
      if (info.pid) room.conductor.pid = info.pid;
      return room;
    },
    { root },
  );
  return {
    ...plan,
    status: isOk ? "launched" : "failed",
    workspace,
    worktree: worktreeInfo
      ? { slug: worktreeInfo.slug, branch: worktreeInfo.branch, path: worktreeInfo.path }
      : null,
    command: finalCommand,
    launch: { ...info, exitCode: launched.status },
    ...(!isOk && { error: oneLine(launched.stderr || launched.stdout || "launch failed", 400) }),
  };
}

export function chiefExists(root = mailboxRoot()) {
  return existsSync(chiefPath(root));
}
