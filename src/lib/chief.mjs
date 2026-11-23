import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  accessSync,
  closeSync,
  existsSync,
  fchmodSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { emitChiefEvents } from "./chief-bridge.mjs";
import { reconcileChiefIntents, recordChiefIntents } from "./chief-notification-intents.mjs";
import {
  commitAckTx,
  committedInboxIds,
  completeAckTx,
  linkDeskItem,
  pendingAckTxs,
  putDeskItem,
  readDesk,
} from "./chief-outbox.mjs";
import { readFoundryState } from "./foundry.mjs";
import { herdrEndpoint } from "./herdr-context.mjs";
import {
  CHIEF_FOCUS_TEXT,
  cleanNonChiefFocus,
  isClosedRoom,
  listRawRooms,
  mailboxRoot,
  processStarted,
  readRawRoom,
  updateRawRoom,
} from "./horde-room.mjs";
/**
 * Ork Chief: the machine-wide Master Orchestrator desk.
 *
 * One session per machine may hold the Chief desk (`<mailboxRoot>/chief.json`). The Chief
 * observes every room and standalone session on the machine, routes messages to them, and
 * spawns autonomous room orchestrators that report back to it. Reads never mutate state.
 */
import { mailboxFileMap } from "./mailbox-projection.mjs";
import { recordSessionKey } from "./mailbox-records.mjs";
import { isTerminalDisplayState, memberDisplayState } from "./member-state.mjs";
import { orcaPaneContext, orcaTerminalHandle, resolveOrcaCli } from "./orca-context.mjs";
import {
  CANONICAL_HARNESSES,
  loadConfiguredAccounts,
  normalizeAccountTags,
  resolveConfiguredAccount,
  resolvePolicyConfigPath,
} from "./policy.mjs";
import { remoteObservations } from "./remote-observations.mjs";
import { belongsToRoom, isPeerLive, newRoom, roomOwnerSessions } from "./rooms.mjs";
import { cacheHome, runtimeReference } from "./runtime-paths.mjs";
import { applyLauncherAccountEnv, checkRepoPolicyForSide } from "./side.mjs";
import { worktreePortEnv } from "./worktree-env.mjs";
import { listWorktreePorts } from "./worktree-ports.mjs";
import {
  provisionWorktree,
  resolveRepositoryRoot,
  validateWorktreeSlug,
} from "./worktree-provision.mjs";

export const CHIEF_SCHEMA = "ork.chief.v1";
export const CHIEF_STATUS_SCHEMA = "ork.chief.status.v1";
export const CHIEF_SPAWN_SCHEMA = "ork.chief.spawn.v1";
export const CHIEF_SEND_SCHEMA = "ork.chief.send.v1";
export { CHIEF_FOCUS_TEXT } from "./horde-room.mjs";

const SCRIPTS_DIR = fileURLToPath(new URL("../../src/py/", import.meta.url));
const ROUTES_DEFAULTS_PATH = fileURLToPath(runtimeReference("routes.default.json"));
const PEER_MAILBOX_PY = path.join(SCRIPTS_DIR, "peer_mailbox.py");
const RUN_AGENT_PY = path.join(SCRIPTS_DIR, "run_agent.py");
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const KINDS = new Set(["done", "escalation", "question", "update"]);
const COORDINATOR_ENGINES = new Set(CANONICAL_HARNESSES);
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
  return recordSessionKey(session);
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
  if (harness === "gemini" || harness === "antigravity") return "agy";
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

const canonicalPeerRecords = new WeakSet();

function findPeerForSession(peers, session, predicate = null) {
  if (!Array.isArray(peers) || !session) return null;
  let fallback = null;
  for (const candidate of peers) {
    if (!candidate || candidate.session !== session) continue;
    if (predicate && !predicate(candidate)) continue;
    if (canonicalPeerRecords.has(candidate)) return candidate;
    fallback ??= candidate;
  }
  return fallback;
}

export function readPeers(root = mailboxRoot(), { now = Date.now() } = {}) {
  const stored = mailboxFileMap(root, "peer");
  let entries;
  try {
    entries = stored ? stored.keys().toArray() : readdirSync(path.join(root, "peers"));
  } catch {
    return [];
  }
  const host = hostname();
  const bySession = new Map();
  const sorted = entries.toSorted((left, right) => left.localeCompare(right));
  for (const entry of sorted) {
    if (!entry.endsWith(".json")) continue;
    const peer = stored ? stored.get(entry) : readJson(path.join(root, "peers", entry), 64 * 1024);
    if (
      !isPlainObject(peer) ||
      peer.schema !== "agent-executor.peer.v1" ||
      typeof peer.session !== "string" ||
      typeof peer.name !== "string" ||
      typeof peer.cwd !== "string"
    )
      continue;
    if (peer.machine && peer.machine !== host) continue;
    const key = sessionKey(peer.session);
    const isCanonical = key !== null && entry === `${key}.json`;
    const existing = bySession.get(peer.session);
    if (existing && (!isCanonical || existing.isCanonical)) continue;
    const record = { ...peer, live: isPeerLive(peer, now) };
    if (isCanonical) canonicalPeerRecords.add(record);
    bySession.set(peer.session, { record, isCanonical });
  }
  return bySession
    .values()
    .map((item) => item.record)
    .toArray();
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
    herdrEndpoint: pick("herdrEndpoint"),
    herdrPaneId: pick("herdrPaneId"),
    orcaEnvironment: pick("orcaEnvironment"),
    orcaPaneKey: pick("orcaPaneKey"),
    orcaTabId: pick("orcaTabId"),
    orcaTerminalHandle: pick("orcaTerminalHandle"),
    orcaWorkspaceId: pick("orcaWorkspaceId"),
    paneId: pick("paneId"),
    terminalServer: pick("terminalServer"),
  };
}

// ---------------------------------------------------------------------------
// chief.json

export function chiefPath(root = mailboxRoot()) {
  return path.join(root, "chief.json");
}

function isTopLevelReplacementPeer(candidate, binding, now, host) {
  if (
    !candidate ||
    candidate.session === binding.session ||
    (candidate.machine && candidate.machine !== host) ||
    candidate.pid !== binding.pid
  ) {
    return false;
  }
  if (candidate.pidBirth && binding.pidBirth && candidate.pidBirth !== binding.pidBirth) {
    return false;
  }
  const live =
    candidate.lastSeenAt || candidate.startedAt || typeof candidate.live !== "boolean"
      ? isPeerLive(candidate, now)
      : candidate.live;
  return Boolean(
    live &&
    !isRunPeer(candidate) &&
    !candidate.isSubagent &&
    !candidate.agySubagentPending &&
    !candidate.delegatedRun &&
    !candidate.parentSession,
  );
}

function isChiefPeerLive(peer, now, getProcessStarted = processStarted) {
  if (getProcessStarted !== processStarted && peer?.pid && peer?.pidBirth) {
    const alive = pidAlive(peer.pid);
    if (alive === false) return false;
    if (alive) {
      const birth = getProcessStarted(peer.pid) || null;
      if (birth && birth !== peer.pidBirth) return false;
    }
    return isPeerLive({ ...peer, pidBirth: undefined }, now);
  }
  return isPeerLive(peer, now);
}

function chiefLiveness(binding, peers, now, { getProcessStarted = processStarted } = {}) {
  if (
    !isPlainObject(binding) ||
    binding.schema !== CHIEF_SCHEMA ||
    typeof binding.session !== "string" ||
    !binding.session
  ) {
    return { live: false, reason: "missing or invalid binding" };
  }
  const host = hostname();
  if (typeof binding.machine === "string" && binding.machine.trim() && binding.machine !== host) {
    return { live: false, reason: "bound on another machine" };
  }
  const alive = pidAlive(binding.pid);
  if (alive === false) {
    return { live: false, reason: `process ${binding.pid} exited` };
  }
  let currentBirth = null;
  if (alive && binding.pidBirth) {
    currentBirth = getProcessStarted(binding.pid) || null;
    if (currentBirth && currentBirth !== binding.pidBirth) {
      return { live: false, reason: `process ${binding.pid} was recycled` };
    }
  }
  const isVerifiedLivePid = Boolean(
    alive && (!binding.pidBirth || (currentBirth && currentBirth === binding.pidBirth)),
  );
  const ageMs = now - stampMs(binding.boundAt);
  const isInGrace = Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= UNVERIFIED_BINDING_GRACE_MS;
  if (binding.pid && !isVerifiedLivePid && !isInGrace) {
    return { live: false, reason: `process ${binding.pid} birth could not be verified` };
  }
  const peer = findPeerForSession(
    peers,
    binding.session,
    (candidate) => !isRunPeer(candidate) && (!candidate.machine || candidate.machine === host),
  );
  if (peer) {
    if (binding.pid && peer.pid && peer.pid !== binding.pid) {
      return {
        live: false,
        reason: `mailbox peer pid ${peer.pid} contradicts chief pid ${binding.pid}`,
      };
    }
    if (binding.pidBirth && peer.pidBirth && peer.pidBirth !== binding.pidBirth) {
      return {
        live: false,
        reason: "mailbox peer pidBirth contradicts chief pidBirth",
      };
    }
    const peerLive =
      peer.lastSeenAt || peer.startedAt || typeof peer.live !== "boolean"
        ? isChiefPeerLive(peer, now, getProcessStarted)
        : peer.live;
    return peerLive
      ? { live: true, peer }
      : { live: false, reason: "mailbox peer is no longer live" };
  }
  if (isVerifiedLivePid) {
    if (!isInGrace) {
      const replacement = (Array.isArray(peers) ? peers : []).find((candidate) =>
        isTopLevelReplacementPeer(candidate, binding, now, host),
      );
      if (replacement) {
        return { live: false, reason: "chief session was cleared or replaced" };
      }
    }
    return { live: true, peer: null };
  }
  if (isInGrace) {
    return { live: true, peer: null };
  }
  return { live: false, reason: "no live process or mailbox peer" };
}

const CHIEF_CAS_PY = [
  "import fcntl, json, os, sys",
  "req = json.loads(sys.stdin.readline())",
  'chief_path = req["chief_path"]',
  'lock_path = req["lock_path"]',
  'op = req["op"]',
  'expected_session = req.get("expected_session")',
  'expected_revision = req.get("expected_revision")',
  'expected_generation = req.get("expected_generation")',
  'hold_lock = bool(req.get("hold_lock"))',
  'force = bool(req.get("force"))',
  "def binding_revision(obj):",
  '    if obj is None or obj.get("__invalid__"):',
  "        return None",
  '    rev = obj.get("revision")',
  "    return rev if isinstance(rev, int) and not isinstance(rev, bool) else 0",
  "def binding_generation(obj):",
  '    if obj is None or obj.get("__invalid__"):',
  "        return None",
  '    gen = obj.get("generation")',
  "    return gen if isinstance(gen, str) and gen else None",
  "def generation_mismatch(expected_gen, actual_gen, expected_session_id):",
  "    if expected_gen is not None:",
  "        return actual_gen != expected_gen",
  "    if expected_session_id is not None:",
  "        return actual_gen is not None",
  "    return False",
  "def emit(payload):",
  "    sys.stdout.write(json.dumps(payload) + " + String.raw`"\n")`,
  "    sys.stdout.flush()",
  "os.makedirs(os.path.dirname(lock_path), mode=0o700, exist_ok=True)",
  "fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)",
  "try:",
  "    fcntl.flock(fd, fcntl.LOCK_EX)",
  "    current = None",
  "    if os.path.exists(chief_path):",
  "        try:",
  '            with open(chief_path, "r", encoding="utf-8") as fh:',
  "                parsed = json.load(fh)",
  '            if isinstance(parsed, dict) and parsed.get("schema") == "ork.chief.v1" and isinstance(parsed.get("session"), str):',
  "                current = parsed",
  "            else:",
  '                current = {"__invalid__": True}',
  "        except (OSError, ValueError):",
  '            current = {"__invalid__": True}',
  "    actual_rev = binding_revision(current)",
  "    actual_gen = binding_generation(current)",
  '    if op == "clear":',
  "        if current is None:",
  '            emit({"status": "missing"})',
  '        elif current.get("__invalid__"):',
  "            if force or expected_session is None:",
  "                try:",
  "                    os.unlink(chief_path)",
  "                except FileNotFoundError:",
  "                    pass",
  '                emit({"status": "cleared"})',
  "                if hold_lock:",
  "                    sys.stdin.readline()",
  "            else:",
  '                emit({"status": "conflict"})',
  '        elif not force and ((expected_session is not None and current.get("session") != expected_session) or (expected_revision is not None and actual_rev != expected_revision) or generation_mismatch(expected_generation, actual_gen, expected_session)):',
  '            emit({"status": "conflict", "actualSession": current.get("session"), "actualRevision": actual_rev, "actualGeneration": actual_gen})',
  "        else:",
  "            try:",
  "                os.unlink(chief_path)",
  "            except FileNotFoundError:",
  "                pass",
  '            emit({"status": "cleared"})',
  "            if hold_lock:",
  "                sys.stdin.readline()",
  '    elif op == "write":',
  '        actual_session = None if current is None else (None if current.get("__invalid__") else current.get("session"))',
  "        rev_mismatch = (expected_revision is None and actual_rev is not None) or (expected_revision is not None and actual_rev != expected_revision)",
  "        if not force and (actual_session != expected_session or rev_mismatch or generation_mismatch(expected_generation, actual_gen, expected_session)):",
  '            emit({"status": "conflict", "actualSession": actual_session, "actualRevision": actual_rev, "actualGeneration": actual_gen})',
  "        else:",
  "            parent_dir = os.path.dirname(chief_path)",
  "            os.makedirs(parent_dir, mode=0o700, exist_ok=True)",
  '            tmp_path = f"{chief_path}.{os.getpid()}.{os.urandom(4).hex()}.tmp"',
  '            with open(tmp_path, "w", encoding="utf-8") as fh:',
  '                fh.write(json.dumps(req["binding"], indent=2) + ' + String.raw`"\n")`,
  "            os.chmod(tmp_path, 0o600)",
  "            os.replace(tmp_path, chief_path)",
  '            emit({"status": "written"})',
  "            if hold_lock:",
  "                sys.stdin.readline()",
  "    else:",
  '        raise ValueError(f"unknown op: {op}")',
  "finally:",
  "    os.close(fd)",
].join("\n");

function runChiefCas(payload, env = process.env, onHeld = null) {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", ["-c", CHIEF_CAS_PY], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let parsedResult = null;
    let isSettled = false;
    let heldPromise = null;
    let heldError = null;
    const runHeld = async (result) => {
      try {
        await onHeld(result);
      } catch (error) {
        heldError = error;
      } finally {
        child.stdin.end("release\n");
      }
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (parsedResult !== null) return;
      const nl = stdout.indexOf("\n");
      if (nl === -1) return;
      const line = stdout.slice(0, nl).trim();
      try {
        parsedResult = JSON.parse(line);
      } catch (error) {
        isSettled = true;
        child.stdin.end();
        reject(new Error(`Invalid chief lock helper output: ${error.message}`, { cause: error }));
        return;
      }
      if (onHeld && (parsedResult.status === "written" || parsedResult.status === "cleared")) {
        heldPromise = runHeld(parsedResult);
      } else {
        child.stdin.end();
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (isSettled) return;
      isSettled = true;
      reject(error);
    });
    child.on("close", async (code) => {
      if (heldPromise) {
        await heldPromise;
      }
      if (isSettled) return;
      isSettled = true;
      if (heldError) {
        reject(heldError);
        return;
      }
      if (code !== 0) {
        reject(new Error(stderr.trim() || `chief lock helper exited with ${code}`));
        return;
      }
      if (parsedResult !== null) {
        resolve(parsedResult);
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch (error) {
        reject(new Error(`Invalid chief lock helper output: ${error.message}`, { cause: error }));
      }
    });
    child.stdin.write(`${JSON.stringify({ ...payload, hold_lock: Boolean(onHeld) })}\n`);
    if (!onHeld) {
      child.stdin.end();
    }
  });
}

function bindingRevision(binding) {
  return Number.isSafeInteger(binding?.revision) ? binding.revision : 0;
}

/** The live Chief binding, or null. `includeStale` returns stale bindings flagged instead. */
export function readChiefBinding({
  root = mailboxRoot(),
  now = Date.now(),
  includeStale = false,
  peers,
  getProcessStarted = processStarted,
} = {}) {
  const binding = readJson(chiefPath(root));
  if (
    !isPlainObject(binding) ||
    binding.schema !== CHIEF_SCHEMA ||
    typeof binding.session !== "string"
  )
    return null;
  const revision = bindingRevision(binding);
  const liveness = chiefLiveness(binding, peers || readPeers(root, { now }), now, {
    getProcessStarted,
  });
  if (liveness.live) {
    const peer = liveness.peer;
    return {
      ...binding,
      revision,
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
    ? { ...binding, revision, live: false, stale: true, staleReason: liveness.reason }
    : null;
}

function clearChiefFocus(session, { root, env, runMailbox }) {
  if (!session || !SESSION_ID_RE.test(session)) return false;
  const mailboxEnv =
    runMailbox === defaultRunMailbox && root && !env?.ORCHESTRATE_MAILBOX_DIR
      ? { ...env, ORCHESTRATE_MAILBOX_DIR: root }
      : env;
  const res = runMailbox(
    ["focus", "--session", session, "--clear", "--only-if", CHIEF_FOCUS_TEXT],
    { env: mailboxEnv },
  );
  return res.status === 0;
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
  const file = chiefPath(root);
  const lockFile = path.join(root, "chief.lock");

  if (clear) {
    const current = readChiefBinding({ root, now, includeStale: true });
    if (!current) return { action: "none", binding: null, previous: null };
    if (!force && !current.stale && current.session !== self)
      throw new Error(
        `The Chief desk is held by live session ${current.name || current.session}; pass --force to clear it`,
      );
    const cas = await runChiefCas(
      {
        op: "clear",
        chief_path: file,
        lock_path: lockFile,
        expected_session: current.session,
        expected_revision: bindingRevision(current),
        expected_generation: current.generation ?? null,
        force: Boolean(force),
      },
      env,
      () => {
        // Focus reconciliation runs under chief.lock so a displaced Chief cannot clear a newer winner's focus.
        const latestAfterClear = readJson(file);
        const activeWinnerSession =
          isPlainObject(latestAfterClear) &&
          latestAfterClear.schema === CHIEF_SCHEMA &&
          typeof latestAfterClear.session === "string"
            ? latestAfterClear.session
            : null;
        if (activeWinnerSession !== current.session) {
          clearChiefFocus(current.session, { root, env, runMailbox });
        }
        if (activeWinnerSession) return;
        const peers = readPeers(root, { now });
        for (const candidate of peers) {
          if (candidate.session !== current.session && candidate.focus === CHIEF_FOCUS_TEXT) {
            clearChiefFocus(candidate.session, { root, env, runMailbox });
          }
        }
      },
    );
    if (cas.status === "missing") return { action: "none", binding: null, previous: null };
    if (cas.status !== "cleared") {
      throw new Error("Concurrent Chief desk update conflict while clearing; retry");
    }
    return { action: "cleared", binding: null, previous: current };
  }

  if (!self || !SESSION_ID_RE.test(self))
    throw new Error(
      "Pass --session <id> (or run inside an agent session with AGENT_MAILBOX_SESSION)",
    );

  const MAX_CAS_ATTEMPTS = 16;

  const peers = readPeers(root, { now });
  const peer = findPeerForSession(peers, self);
  const panes = paneFields(peer, {
    herdrPaneId: env.HERDR_PANE_ID,
    orcaEnvironment: env.ORCA_ENVIRONMENT,
    orcaPaneKey: env.ORCA_PANE_KEY || env.ORCA_AGENT_PANE,
    orcaTabId: env.ORCA_TAB_ID,
    orcaTerminalHandle: env.ORCA_TERMINAL_HANDLE || env.ORCA_TERMINAL_ID,
    orcaWorkspaceId: env.ORCA_WORKSPACE_ID || env.ORCA_WORKTREE_ID,
    paneId: env.TMUX_PANE,
  });

  let current = null;
  let isSame = false;
  let binding = null;
  let isWritten = false;
  let isFocused = false;
  let isStillWinner = false;

  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
    current = readChiefBinding({ root, now, includeStale: true });
    isSame = current?.session === self;
    const expectedRevision = current ? bindingRevision(current) : null;
    const nextRevision = (expectedRevision ?? 0) + 1;
    binding = {
      schema: CHIEF_SCHEMA,
      revision: nextRevision,
      generation: randomUUID(),
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
    const cas = await runChiefCas(
      {
        op: "write",
        chief_path: file,
        lock_path: lockFile,
        expected_session: current?.session ?? null,
        expected_revision: expectedRevision,
        expected_generation: current?.generation ?? null,
        force: Boolean(force && attempt === MAX_CAS_ATTEMPTS - 1),
        binding,
      },
      env,
      () => {
        // Reconcile focus atomically while chief.lock is held so no newer Chief can overlap.
        const latestAfterWrite = readJson(file);
        const latestRev =
          isPlainObject(latestAfterWrite) && latestAfterWrite.schema === CHIEF_SCHEMA
            ? bindingRevision(latestAfterWrite)
            : null;
        isStillWinner =
          isPlainObject(latestAfterWrite) &&
          latestAfterWrite.schema === CHIEF_SCHEMA &&
          latestAfterWrite.session === self &&
          latestRev === binding.revision &&
          latestAfterWrite.generation === binding.generation;
        if (!isStillWinner) return;
        const focus = runMailbox(["focus", "--session", self, "--text", CHIEF_FOCUS_TEXT], { env });
        isFocused = focus.status === 0;
        const clearedSessions = new Set();
        if (current && !isSame && current.session) {
          clearChiefFocus(current.session, { root, env, runMailbox });
          clearedSessions.add(current.session);
        }
        const latestPeers = readPeers(root, { now });
        for (const candidate of latestPeers) {
          if (
            candidate.session === self ||
            clearedSessions.has(candidate.session) ||
            candidate.focus !== CHIEF_FOCUS_TEXT
          ) {
            continue;
          }
          clearChiefFocus(candidate.session, { root, env, runMailbox });
          clearedSessions.add(candidate.session);
        }
      },
    );
    if (cas.status === "written") {
      isWritten = true;
      break;
    }
  }
  if (!isWritten) {
    throw new Error("Concurrent Chief desk binding conflict; retry");
  }

  let isNotified = false;
  if (isStillWinner && current && !isSame && !current.stale) {
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
    focus: isFocused,
    notified: isNotified,
    desk: listDesk(root).length,
  };
}

// ---------------------------------------------------------------------------
// Chief desk: durable reports addressed to a Chief that is not currently live

// ---------------------------------------------------------------------------
// Guarded filesystem helpers: trusted roots, private directories, bounded reads

const ROOM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const EVENT_FILE_RE = /^([0-9a-f]{32})\.json$/u;

export function isValidRoomId(value) {
  return typeof value === "string" && ROOM_ID_RE.test(value);
}

/** Canonical absolute path: realpath of the nearest existing ancestor plus the missing components. */
export function canonicalPath(target) {
  const absolute = path.resolve(String(target));
  const missing = [];
  let current = absolute;
  for (;;) {
    try {
      return path.join(realpathSync(current), ...missing.toReversed());
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

/** Containment by path components: equal paths, or a descendant. Never a string prefix. */
export function isWithinPath(child, parent) {
  const relative = path.relative(parent, child);
  if (relative === "") return true;
  if (path.isAbsolute(relative)) return false;
  return relative.split(path.sep)[0] !== "..";
}

function readBoundedJsonFile(file, maxBytes = 256 * 1024) {
  let stat;
  try {
    stat = lstatSync(file);
  } catch (error) {
    if (error.code === "ENOENT") return { missing: true };
    return { error: "unreadable" };
  }
  if (!stat.isFile() || stat.size > maxBytes) return { error: "unsafe" };
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    return isPlainObject(value) ? { value } : { error: "malformed" };
  } catch {
    return { error: "malformed" };
  }
}

function assertPrivateDirectory(directory) {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error(`Not a directory: ${directory}`);
  if (typeof process.getuid === "function" && stat.uid !== process.getuid())
    throw new Error(`Foreign owner for ${directory}`);
  if ((stat.mode & 0o022) !== 0) throw new Error(`Writable by others: ${directory}`);
}

/**
 * The mailbox client reads `<cache>/mailbox-v1`, where the cache comes from ORCHESTRATE_HOME. A
 * hook's sanitized environment lacks it, so it is derived from the trusted root. A root with any
 * other name cannot be reached by that client, so the caller queues instead (null).
 */
function mailboxStoreEnv(root, env, runMailbox) {
  if (runMailbox !== defaultRunMailbox) return env;
  if (path.basename(root) !== "mailbox-v1") return null;
  return { ...env, ORCHESTRATE_HOME: path.dirname(root) };
}

/** Sleeps for a bounded interval; the desk and mission locks poll with it. */
function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Exclusive lock file (O_EXCL, no-follow). A holder whose process is dead is broken; a live one
 * is waited for up to `timeoutMs`. The lock is released even when `fn` throws.
 */
async function withExclusiveLock(lockFile, fn, { timeoutMs = 15_000 } = {}) {
  mkdirSync(path.dirname(lockFile), { recursive: true, mode: 0o700 });
  const started = Date.now();
  for (;;) {
    try {
      const fd = openSync(
        lockFile,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
        0o600,
      );
      writeSync(fd, `${process.pid}\n`);
      closeSync(fd);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const holder = Number(readFileSync(lockFile, "utf8"));
      if (pidAlive(holder) !== true) {
        try {
          unlinkSync(lockFile);
        } catch {
          // Another process broke it first.
        }
        continue;
      }
      if (Date.now() - started > timeoutMs)
        throw new Error(`Timed out waiting for ${lockFile}`, { cause: error });
      await sleepMs(10 + Math.floor(Math.random() * 20));
    }
  }
  try {
    return await fn();
  } finally {
    try {
      unlinkSync(lockFile);
    } catch {
      // Already removed.
    }
  }
}

function missionLockPath(root, roomId) {
  return path.join(root, "chief", "locks", `${roomId}.lock`);
}

/** Active desk items from the canonical store: puts minus acknowledged IDs. */
export function listDesk(root = mailboxRoot()) {
  return readDesk(root);
}

function validRoomIdOrNull(value) {
  return isValidRoomId(value) ? value : null;
}

/** Acknowledges every item currently on the desk. Kept for callers that do not take a snapshot. */
export async function ackDesk(root = mailboxRoot()) {
  const deskIds = listDesk(root).map((item) => item.id);
  await commitAcknowledgement({ root, deskIds, inboxIds: [], session: null, runMailbox: null });
  return deskIds.length;
}

const ACK_TRANSACTION_SCHEMA = "ork.chief.ack.v1";

function isStringId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 200;
}

/** Applies the mailbox half of a committed transaction. Safe to repeat: every step is idempotent. */
async function finishAcknowledgement(root, record, { runMailbox, env }) {
  const { inboxIds = [], session = null } = record;
  if (inboxIds.length > 0) {
    if (!session || typeof runMailbox !== "function") {
      const error = new Error("Mailbox acknowledgment needs the Chief session");
      error.code = "mailbox_ack_unavailable";
      throw error;
    }
    const storeEnv = mailboxStoreEnv(root, env, runMailbox);
    if (!storeEnv) {
      const error = new Error("This mailbox root cannot be reached by the mailbox client");
      error.code = "mailbox_ack_unavailable";
      throw error;
    }
    const result = runMailbox(["ack", "--session", session, ...inboxIds], { env: storeEnv });
    if (result.status !== 0) {
      const error = new Error(
        `Mailbox acknowledgment failed; retry ork chief inbox --ack: ${(result.stderr || result.stdout || "").trim()}`,
      );
      error.code = "mailbox_ack_failed";
      throw error;
    }
  }
  completeAckTx(root, record.id);
}

/**
 * Durably commits one acknowledged-ID set (desk rows and redacted events in one transaction), then
 * applies the mailbox half. Callers pass explicit IDs only, so mail or desk items that arrive
 * after the snapshot survive.
 */
export async function commitAcknowledgement({
  root = mailboxRoot(),
  deskIds = [],
  inboxIds = [],
  session = null,
  runMailbox = null,
  env = process.env,
  now = Date.now(),
} = {}) {
  const desk = [...new Set(deskIds)];
  const inbox = [...new Set(inboxIds)];
  if (desk.length === 0 && inbox.length === 0) return { desk: 0, inbox: 0 };
  const record = {
    schema: ACK_TRANSACTION_SCHEMA,
    id: randomBytes(16).toString("hex"),
    state: "committed",
    session,
    deskIds: desk,
    inboxIds: inbox,
    at: iso(now),
  };
  commitAckTx(root, record);
  await finishAcknowledgement(root, record, { runMailbox, env });
  return { desk: desk.length, inbox: inbox.length };
}

/** Retries transactions whose backing writes did not finish. Explicit IDs make this idempotent. */
export async function resumeAcknowledgements(
  root = mailboxRoot(),
  { runMailbox = null, env } = {},
) {
  let resumed = 0;
  for (const record of pendingAckTxs(root)) {
    await finishAcknowledgement(root, record, { runMailbox, env });
    resumed++;
  }
  return resumed;
}

function recordDesk(root, item, now, { id } = {}) {
  const record = {
    schema: "ork.chief.desk.v1",
    id: id || `${now}-${randomBytes(3).toString("hex")}`,
    roomId: validRoomIdOrNull(item.roomId),
    ...item,
    at: iso(now),
  };
  putDeskItem(root, record);
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

/** Every unread message, honoring committed acknowledgment transactions that are not yet applied. */
function readUnreadInbox(root, session) {
  const key = sessionKey(session);
  if (!key) return [];
  const directory = path.join(root, "inbox", key);
  const stored = mailboxFileMap(root, "inbox", key);
  let entries;
  try {
    entries = stored
      ? stored.keys().toArray()
      : readdirSync(directory).filter((entry) => entry.endsWith(".json"));
  } catch {
    return [];
  }
  const hidden = new Set(committedInboxIds(root));
  return entries
    .sort((left, right) => left.localeCompare(right))
    .map((entry) => (stored ? stored.get(entry) : readJson(path.join(directory, entry), 64 * 1024)))
    .filter(
      (message) =>
        isPlainObject(message) &&
        !message.readAt &&
        typeof message.text === "string" &&
        typeof message.id === "string" &&
        !hidden.has(message.id),
    );
}

function readInbox(root, session, limit = 200) {
  return readUnreadInbox(root, session).slice(-limit);
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
      herdrEndpoint: room.herdrEndpoint,
      herdrPaneId: room.herdrCoordinatorPaneId,
      orcaEnvironment: room.orcaEnvironment,
      orcaPaneKey: room.orcaCoordinatorPaneKey,
      orcaTabId: room.orcaCoordinatorTabId,
      orcaTerminalHandle: room.orcaCoordinatorTerminalId,
      orcaWorkspaceId: room.orcaWorkspaceId,
    }),
  };
}

const PR_STATES = new Set(["OPEN", "MERGED", "CLOSED", "UNKNOWN"]);

function projectPorts(entries) {
  if (!Array.isArray(entries)) return [];
  return entries
    .filter(
      (entry) =>
        isPlainObject(entry) &&
        typeof entry.name === "string" &&
        Number.isSafeInteger(entry.port) &&
        entry.port > 0 &&
        entry.port < 65_536,
    )
    .map((entry) => ({ name: entry.name, port: entry.port }));
}

function projectPr(pr) {
  if (!isPlainObject(pr) || !Number.isSafeInteger(pr.number) || pr.number <= 0) return null;
  const state = typeof pr.state === "string" ? pr.state.toUpperCase() : "UNKNOWN";
  return {
    number: pr.number,
    state: PR_STATES.has(state) ? state : "UNKNOWN",
    url: typeof pr.url === "string" && /^https:\/\//u.test(pr.url) ? pr.url : null,
  };
}

/**
 * Reads the saved worktree facts once per path for a whole snapshot: ports from the allocation
 * database and the pull request from the saved Foundry state. Both are local reads; rendering and
 * status never call GitHub. A missing or unreadable source maps to `[]` / `null`.
 */
function createWorktreeProjector({
  env,
  readPorts = listWorktreePorts,
  readPr = (worktreePath) => readFoundryState(worktreePath)?.pr,
}) {
  const seen = new Map();
  return (worktree, repoPath) => {
    const key = worktree?.path ? path.resolve(worktree.path) : null;
    if (!key) return { ports: [], pr: null };
    if (!seen.has(key)) {
      let projected = { ports: [], pr: null };
      if (existsSync(key)) {
        try {
          projected.ports = projectPorts(
            readPorts({ repoRoot: repoPath || key, worktreePath: key, env }),
          );
        } catch {
          projected.ports = [];
        }
        try {
          projected.pr = projectPr(readPr(key));
        } catch {
          projected.pr = null;
        }
      }
      seen.set(key, projected);
    }
    const found = seen.get(key);
    return { ports: found.ports.map((entry) => ({ ...entry })), pr: found.pr && { ...found.pr } };
  };
}

function summarizeRoom(room, { peers, inbox, projectWorktree }) {
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
    mission: isPlainObject(room.chief)
      ? {
          state: room.chief.state ?? null,
          reason: room.chief.exit?.reason ?? room.chief.report?.reason ?? null,
        }
      : null,
    objective: oneLine(room.objective || "", 400),
    goal: room.chief?.goal ? oneLine(room.chief.goal, 400) : null,
    cwd: room.cwd || null,
    repo: git.repo,
    branch: room.conductor?.worktree?.branch || git.branch || "",
    worktree: worktree
      ? { ...worktree, ...(projectWorktree?.(worktree, git.repo?.path) ?? { ports: [], pr: null }) }
      : worktree,
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

/** A detached mission whose coordinator is gone reads its exit evidence; the room itself is untouched. */
function projectDetachedExit(room, { root, now, peers }) {
  if (room.chief?.launch?.mode !== "detached" || coordinatorOf(room, peers).live) return room;
  const exit = readMissionExit(room, { root, now });
  if (!exit.state) return room;
  const copy = structuredClone(room);
  copy.chief.state = exit.state;
  copy.chief.exit = { state: exit.state, reason: exit.reason, eventId: exit.eventId ?? null };
  if (copy.conductor) copy.conductor.status = exit.state === "done" ? "completed" : "failed";
  return copy;
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
    task: oneLine(cleanNonChiefFocus(peer) || peer.progress?.task || "", 160),
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
  readPorts,
  readPr,
} = {}) {
  const peers = providedPeers || readPeers(root, { now });
  const chief = readChiefBinding({ root, now, includeStale: true, peers });
  const projectWorktree = createWorktreeProjector({ env, readPorts, readPr });
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
  for (const original of rawRooms) {
    if (isClosedRoom(original)) continue;
    // Observational projection: a dead detached coordinator reads its own artifacts, never writes.
    const room = projectDetachedExit(original, { root, now, peers });
    const summary = summarizeRoom(room, { peers, inbox, projectWorktree });
    if (!all && !isActiveRoom(summary, room, now)) continue;
    for (const session of roomSessions(room)) boundSessions.add(session);
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
      (chief?.live && chief?.session === peer.session)
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
      id: message.id,
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
    drawerSnapshot: {
      session: chief?.live ? chief.session : null,
      revision: chief?.live && chief.revision != null ? String(chief.revision) : null,
      deskIds: desk.map((item) => item.id),
      inboxIds: unattributed.map((item) => item.id).filter(Boolean),
    },
    accounts: [],
  };
  try {
    const remotes = remoteObservations(root);
    if (remotes.length > 0) status.remoteObservations = remotes;
  } catch (error) {
    status.remoteObservationsError = error.message;
  }
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
const TERMINAL_MISSION_STATES = new Set(["cancelled", "done", "failed"]);

/** A child's report moves its mission state, so finished missions stop raising attention. */
const REPORT_EVENTS = new Set(["done", "escalation", "question"]);

async function recordMissionReport({
  rooms,
  sender,
  env,
  kind,
  text,
  root,
  now,
  locked = false,
  sourceId = null,
  events = null,
}) {
  const room =
    rooms.find((candidate) => candidate.chief?.mission?.session === sender) ||
    (env.ORK_CHIEF_MISSION_SESSION === sender && env.ORK_CHIEF_ROOM
      ? rooms.find((candidate) => candidate.id === env.ORK_CHIEF_ROOM && candidate.chief)
      : null);
  if (!room) return null;
  const nextState = MISSION_STATES[kind || "update"];
  let effectiveState = nextState;
  let isTransition = false;
  const notification = () =>
    isTransition && sourceId && REPORT_EVENTS.has(kind)
      ? [{ event: kind, roomId: room.id, key: `report:${sourceId}` }]
      : [];
  const record = () =>
    updateRawRoom(
      room.id,
      (current) => {
        isTransition = false;
        if (!current.chief) return current;
        // A terminal mission never reopens: a late update, repeated hook or manual retry keeps it.
        const isPreserved = TERMINAL_MISSION_STATES.has(current.chief.state);
        isTransition = !isPreserved;
        effectiveState = isPreserved ? current.chief.state : nextState;
        current.chief.state = effectiveState;
        current.chief.reportedAt = iso(now);
        current.chief.lastReport = {
          kind: kind || "update",
          text: oneLine(text, MAX_REPORT_CHARS),
        };
        if (current.conductor && !isPreserved) {
          current.conductor.status = effectiveState === "done" ? "completed" : effectiveState;
        }
        return current;
      },
      {
        root,
        onCommit: (db) => {
          if (!events) recordChiefIntents(db, notification(), env);
        },
      },
    );
  if (locked) await record();
  else await withExclusiveLock(missionLockPath(root, room.id), record);
  // The write committed: queue the event for delivery by the caller once its locks are released.
  events?.push(...notification());
  return { roomId: room.id, state: effectiveState };
}

// ---------------------------------------------------------------------------
// Detached mission exit: completion hook, read-only classifier, reconciliation

const EXECUTOR_JOB_SCHEMA = "agent-executor.job.v1";
const EXECUTOR_COMPLETION_SCHEMA = "agent-executor.completion.v1";
const CHIEF_ENTRY = fileURLToPath(new URL("../bin/chief.mjs", import.meta.url));
const RESULT_GRACE_MS = 60_000;
const UNSUCCESSFUL_RESULTS = new Set([
  "provider_quota_exhausted",
  "timed_out",
  "failed",
  "error",
  "cancelled",
  "rejected",
]);

function missionReportId(roomId, eventId, generation) {
  const basis = eventId ? `event:${eventId}` : `generation:${generation || "none"}`;
  return `chief-report-${createHash("sha256").update(`${roomId}\0${basis}`).digest("hex").slice(0, 32)}`;
}

function shellSingleQuote(value) {
  if (/[\0\n\r]/u.test(value)) throw new Error("Hook paths cannot contain control characters");
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

/** Workspaces the hook must stay out of: the repository, the planned checkout, and any --add-dir. */
function workspacesOf(command = []) {
  const found = [];
  for (let index = 0; index < command.length; index++) {
    const next = command[index + 1];
    if (command[index] === "--add-dir" && next) found.push(next);
    const cwd = command[index + 1];
    if (command[index] === "--cwd" && cwd) found.push(cwd);
  }
  return found;
}

function assertTrustedExecutable(file, workspaces, label) {
  const real = realpathSync(file);
  const stat = statSync(real);
  if (!stat.isFile()) throw new Error(`${label} is not a file: ${real}`);
  if ((stat.mode & 0o022) !== 0) throw new Error(`${label} is writable by others: ${real}`);
  for (const workspace of workspaces) {
    if (isWithinPath(real, canonicalPath(workspace)))
      throw new Error(
        `${label} is inside a writable executor workspace; install Orkest outside it`,
      );
  }
  return real;
}

/**
 * Plans the mission's completion hook without writing. The script runs trusted absolute Node and
 * Chief entry points, embeds the validated room and mailbox root, and forwards "$1" as --event.
 */
export function planCompletionHook({
  root = mailboxRoot(),
  roomId,
  workspaces = [],
  nodePath = process.execPath,
  entryPath = CHIEF_ENTRY,
} = {}) {
  if (!isValidRoomId(roomId)) throw new Error(`Invalid room ID for the completion hook: ${roomId}`);
  const canonicalRoot = canonicalPath(root);
  const hooksDir = path.join(canonicalRoot, "chief", "hooks");
  const hookFile = path.join(hooksDir, roomId);
  const scopes = workspaces.map((workspace) => canonicalPath(workspace));
  if (scopes.some((scope) => isWithinPath(hookFile, scope)))
    throw new Error("The completion hook must be outside every executor workspace");
  const node = assertTrustedExecutable(nodePath, scopes, "Node");
  const entry = assertTrustedExecutable(entryPath, scopes, "The Chief entry point");
  const script = [
    "#!/bin/sh",
    "# orkest-chief-completion-hook: v1",
    `# room: ${roomId}`,
    `exec ${shellSingleQuote(node)} ${shellSingleQuote(entry)} reconcile ${roomId} --hook --mailbox-root ${shellSingleQuote(canonicalRoot)} --event "$1"`,
    "",
  ].join("\n");
  return { path: hookFile, directory: hooksDir, root: canonicalRoot, node, entry, script };
}

/** Creates the hook exclusively and without following links. Re-running with the same script is a no-op. */
export function installCompletionHook(plan) {
  // The trusted root was canonicalized, so anything below it must be a real directory, never a link.
  for (const component of [path.join(plan.root, "chief"), plan.directory]) {
    let stat = null;
    try {
      stat = lstatSync(component);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (stat?.isSymbolicLink()) throw new Error(`Refusing a symlinked mission path: ${component}`);
  }
  mkdirSync(path.dirname(plan.directory), { recursive: true, mode: 0o700 });
  mkdirSync(plan.directory, { recursive: true, mode: 0o700 });
  assertPrivateDirectory(plan.directory);
  try {
    const fd = openSync(
      plan.path,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o700,
    );
    try {
      writeSync(fd, plan.script);
      fchmodSync(fd, 0o700);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const stat = lstatSync(plan.path);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error(`Completion hook path is not a regular file: ${plan.path}`, { cause: error });
    if (readFileSync(plan.path, "utf8") !== plan.script)
      throw new Error(`Completion hook already exists with different content: ${plan.path}`, {
        cause: error,
      });
  }
  return plan.path;
}

/**
 * Classifies a detached mission from its owned artifacts. It only reads: no locks, writes, mailbox
 * calls or hook installation, so chief status can call it safely.
 */
export function readMissionExit(
  room,
  {
    root = mailboxRoot(),
    now = Date.now(),
    manual = false,
    eventPath = null,
    processAlive = pidAlive,
    processBirth = processStarted,
  } = {},
) {
  const decide = (evidence, extra = {}) => ({ evidence, state: null, reason: null, ...extra });
  if (!isPlainObject(room) || !isValidRoomId(room.id) || !isPlainObject(room.chief))
    return decide("none", { reason: "no_mission" });
  const launch = isPlainObject(room.chief.launch) ? room.chief.launch : {};
  const jobDir = path.join(canonicalPath(root), "chief", "missions", room.id, "job");
  if (launch.jobDir && canonicalPath(launch.jobDir) !== canonicalPath(jobDir))
    return decide("uncertain", { reason: "job_dir_mismatch" });
  const manifestRead = readBoundedJsonFile(path.join(jobDir, "job.json"));
  if (manifestRead.missing) return decide("none", { reason: "no_manifest" });
  if (manifestRead.error) return decide("uncertain", { reason: "manifest_unreadable" });
  const manifest = manifestRead.value;
  if (manifest.schema !== EXECUTOR_JOB_SCHEMA)
    return decide("uncertain", { reason: "manifest_schema" });
  if (
    typeof manifest.job_dir !== "string" ||
    canonicalPath(manifest.job_dir) !== canonicalPath(jobDir)
  )
    return decide("uncertain", { reason: "manifest_job_dir" });
  if (typeof launch.completionDir !== "string")
    return decide("uncertain", { reason: "completion_store_untrusted" });
  const completionDir = canonicalPath(launch.completionDir);

  // A steered job's live segment is recorded in steering.json; events of older segments are superseded.
  const steeringRead = readBoundedJsonFile(path.join(jobDir, "steering.json"));
  if (steeringRead.error) return decide("uncertain", { reason: "steering_unreadable" });
  const segment = steeringRead.value ?? manifest;
  const resultFile = canonicalPath(String(segment.result_path ?? ""));
  if (steeringRead.value) {
    if (!isWithinPath(resultFile, jobDir))
      return decide("uncertain", { reason: "result_outside_job" });
  } else if (resultFile !== canonicalPath(path.join(jobDir, "run", "result.json"))) {
    return decide("uncertain", { reason: "result_path_mismatch" });
  }

  // A PID alone is not identity: a reused PID with a different birth time is treated as not ours.
  const pid = Number.isSafeInteger(manifest.pid) ? manifest.pid : (launch.pid ?? null);
  let identity = processAlive(pid) === true ? "unverified" : "dead";
  if (identity === "unverified" && launch.pidBirth)
    identity = processBirth(pid) === launch.pidBirth ? "verified" : "reused";
  const isOwnProcessAlive = identity === "verified" || identity === "unverified";

  const resultRead = readBoundedJsonFile(resultFile, 1024 * 1024);
  if (resultRead.missing) {
    if (isOwnProcessAlive) return decide("live", { pid, identity, reason: "running" });
    const launchedMs = stampMs(launch.launchedAt);
    const startupFinished = launch.status && launch.status !== "launching";
    if (
      manual &&
      startupFinished &&
      Number.isFinite(launchedMs) &&
      now - launchedMs >= RESULT_GRACE_MS
    )
      return decide("dead", {
        pid,
        identity,
        state: "failed",
        reason: "runner_exited_without_result",
      });
    return decide("uncertain", { pid, identity, reason: "no_result" });
  }
  if (resultRead.error) return decide("uncertain", { reason: "result_unreadable" });
  const result = resultRead.value;

  const eventFile = canonicalPath(String(segment.completion_event_path ?? ""));
  const nameMatch = EVENT_FILE_RE.exec(path.basename(eventFile));
  if (!nameMatch || path.dirname(eventFile) !== completionDir)
    return decide("uncertain", { reason: "event_outside_store" });
  const eventId = nameMatch[1];
  if (steeringRead.value && segment.completion_event_id && segment.completion_event_id !== eventId)
    return decide("uncertain", { reason: "steering_event_mismatch" });
  if (eventPath && canonicalPath(eventPath) !== eventFile)
    return decide("superseded", { reason: "event_not_current" });
  const eventRead = readBoundedJsonFile(eventFile);
  if (eventRead.missing) return decide("uncertain", { reason: "event_missing" });
  if (eventRead.error) return decide("uncertain", { reason: "event_unreadable" });
  const event = eventRead.value;
  if (event.schema !== EXECUTOR_COMPLETION_SCHEMA || event.event_id !== eventId)
    return decide("uncertain", { reason: "event_identity" });
  if (typeof event.result_path !== "string" || canonicalPath(event.result_path) !== resultFile)
    return decide("uncertain", { reason: "event_result_mismatch" });
  if (
    typeof event.repository !== "string" ||
    !room.cwd ||
    canonicalPath(event.repository) !== canonicalPath(room.cwd)
  )
    return decide("uncertain", { reason: "repository_mismatch" });
  if (event.status !== result.status) return decide("uncertain", { reason: "status_mismatch" });

  const base = { pid, identity, eventId, resultPath: resultFile, status: result.status };
  if (result.status === "completed") {
    const exitCode = result.exit_code ?? event.exit_code ?? 0;
    if (exitCode !== 0)
      return decide("final", { ...base, state: "failed", reason: "exit_code_nonzero" });
    if (result.task_outcome != null && result.task_outcome !== "complete")
      return decide("final", {
        ...base,
        state: "failed",
        reason: `task_${oneLine(String(result.task_outcome), 40)}`,
      });
    return decide("final", { ...base, state: "done", reason: "completed" });
  }
  if (UNSUCCESSFUL_RESULTS.has(result.status))
    return decide("final", { ...base, state: "failed", reason: result.status });
  return decide("uncertain", { ...base, reason: "status_not_final" });
}

function missionBodyOf(roomId, outcome) {
  return outcome.state === "done"
    ? `[chief:done] ${roomId} completed; its branch and verification are in the room.`
    : `[chief:escalation] ${roomId} failed: ${outcome.reason}`;
}

/** Writes a pending mission outcome once; a repeat or a conflicting late exit never reopens it. */
async function recordMissionOutcome(root, roomId, outcome, { now = Date.now(), env, bridge } = {}) {
  let decision = { status: "unchanged" };
  await updateRawRoom(
    roomId,
    (room) => {
      const chief = room.chief;
      if (!isPlainObject(chief)) return room;
      if (isClosedRoom(room)) {
        decision = { status: "closed" };
        return room;
      }
      const id = missionReportId(roomId, outcome.eventId, chief.launch?.generation);
      if (TERMINAL_MISSION_STATES.has(chief.state)) {
        if (chief.state !== outcome.state && chief.state === "done") {
          chief.exitAfterReport = {
            state: outcome.state,
            reason: outcome.reason,
            eventId: outcome.eventId ?? null,
            at: iso(now),
          };
          decision = { status: "late-failure-recorded" };
        } else {
          decision = { status: "already-recorded" };
        }
        return room;
      }
      chief.state = outcome.state;
      decision = { status: "recorded", reportId: id, state: outcome.state };
      chief.exit = {
        state: outcome.state,
        reason: outcome.reason,
        eventId: outcome.eventId ?? null,
      };
      chief.report = {
        id,
        kind: outcome.state === "done" ? "done" : "escalation",
        reason: outcome.reason,
        body: missionBodyOf(roomId, outcome),
        status: "pending",
        at: iso(now),
      };
      if (room.conductor) room.conductor.status = outcome.state === "done" ? "completed" : "failed";
      return room;
    },
    {
      root,
      onCommit: (db) => {
        if (!bridge && decision.status === "recorded")
          recordChiefIntents(
            db,
            [
              {
                event: decision.state === "done" ? "done" : "failed",
                roomId,
                key: `outcome:${decision.reportId}`,
              },
            ],
            env,
          );
      },
    },
  );
  return decision;
}

function isRestingPeer(root, session, env) {
  const key = sessionKey(session);
  if (!key) return false;
  const marker = path.join(root, "handoff-rest", `${key}.json`);
  if (!existsSync(marker) || readJson(marker, 4096)?.released) return false;
  const result = spawnSync(
    "python3",
    [
      "-I",
      "-c",
      "import pathlib, sys; sys.path.insert(0, sys.argv[1]); import handoff_rest; " +
        "print(int(handoff_rest.resting(pathlib.Path(sys.argv[2]), sys.argv[3])))",
      SCRIPTS_DIR,
      root,
      session,
    ],
    { encoding: "utf8", timeout: 5000, env: { ...env, ORCHESTRATE_HOME: path.dirname(root) } },
  );
  // Only a confirmed rest holds mail: a slow or failing check must not silence a session that still leads.
  return result.status === 0 && result.stdout.trim() === "1";
}

/** Ensures the desk holds one item for the report, then requests delivery if a Chief is live. */
async function deliverMissionReport(room, { root, env, now, runMailbox }) {
  const report = room.chief?.report;
  if (!report || !isStringId(report.id)) return { status: "none" };
  putDeskItem(root, {
    schema: "ork.chief.desk.v1",
    id: report.id,
    roomId: room.id,
    from: room.chief?.mission?.session ?? null,
    kind: report.kind === "done" ? "done" : "escalation",
    text: report.body,
    at: report.at ?? iso(now),
  });
  if (report.status === "delivered") return { status: "delivered", id: report.id };
  const chief = readChiefBinding({ root, now });
  const missionSession = room.chief?.mission?.session;
  if (!chief || !missionSession || isRestingPeer(root, chief.session, env))
    return { status: "queued", id: report.id };
  const storeEnv = mailboxStoreEnv(root, env, runMailbox);
  if (!storeEnv) return { status: "queued", id: report.id, error: "mailbox root unreachable" };
  const result = runMailbox(
    [
      "send",
      "--session",
      missionSession,
      "--to",
      chief.session,
      "--scope",
      "cross-project",
      "--format",
      "json",
      "--native-unreachable",
      NATIVE_UNREACHABLE,
      "--id",
      report.id,
      "--text",
      report.body,
    ],
    { env: storeEnv },
  );
  if (result.status !== 0) return { status: "queued", id: report.id, error: "delivery failed" };
  let messageId = null;
  try {
    const delivered = JSON.parse(result.stdout);
    messageId = isStringId(delivered?.id) ? delivered.id : null;
  } catch {
    messageId = null;
  }
  if (!messageId) return { status: "queued", id: report.id, error: "delivery receipt missing" };
  linkDeskItem(root, report.id, messageId);
  await updateRawRoom(
    room.id,
    (current) => {
      if (current.chief?.report?.id === report.id) {
        current.chief.report.messageId = messageId;
        current.chief.report.status = "delivered";
        current.chief.report.deliveredAt = iso(now);
        current.chief.report.destination = chief.session;
      }
      return current;
    },
    { root },
  );
  return { status: "delivered", id: report.id };
}

/**
 * Reconciles a detached mission. Every decision is written before slow delivery, and a repeat
 * resumes pending delivery with the same stable report ID.
 */
export async function chiefReconcile({
  roomId,
  event = null,
  hook = false,
  root = mailboxRoot(),
  env = process.env,
  now = Date.now(),
  runMailbox = defaultRunMailbox,
  bridge,
} = {}) {
  if (!isValidRoomId(roomId)) throw new Error("Pass a valid room ID");
  try {
    readRawRoom(roomId, root);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const missing = new Error(`No room ${roomId}`);
    missing.code = "not_found";
    throw missing;
  }
  if (event && env.AGENT_EVENT && path.resolve(env.AGENT_EVENT) !== path.resolve(event))
    throw new Error("AGENT_EVENT does not match the --event argument");
  const events = [];
  let result;
  try {
    result = await withExclusiveLock(missionLockPath(root, roomId), async () => {
      const current = readRawRoom(roomId, root);
      if (isClosedRoom(current))
        return { schema: "ork.chief.reconcile.v1", roomId, status: "closed", delivery: null };
      const exit = readMissionExit(current, {
        root,
        now,
        manual: !hook,
        eventPath: event || env.AGENT_EVENT || null,
      });
      if (env.AGENT_RESULT && exit.resultPath && path.resolve(env.AGENT_RESULT) !== exit.resultPath)
        return {
          schema: "ork.chief.reconcile.v1",
          roomId,
          status: "superseded",
          evidence: exit.evidence,
        };
      let decision = { status: "none" };
      if (exit.state)
        decision = await recordMissionOutcome(root, roomId, exit, { now, env, bridge });
      // Only the recorded terminal outcome is an event; its durable report ID is the identity.
      if (decision.status === "recorded")
        events.push({
          event: decision.state === "done" ? "done" : "failed",
          roomId,
          key: `outcome:${decision.reportId}`,
        });
      const latest = readRawRoom(roomId, root);
      const delivery = latest.chief?.report
        ? await deliverMissionReport(latest, { root, env, now, runMailbox })
        : null;
      if (hook && exit.evidence === "none")
        return { schema: "ork.chief.reconcile.v1", roomId, status: "retry", reason: exit.reason };
      return {
        schema: "ork.chief.reconcile.v1",
        roomId,
        status: decision.status,
        evidence: exit.evidence,
        state: latest.chief?.state ?? null,
        decided: exit.state ?? null,
        reason: exit.reason ?? null,
        delivery,
      };
    });
  } finally {
    // The terminal outcome is already committed, even if slow delivery above failed.
    if (bridge) await emitChiefEvents(events, { env, bridge });
    else await reconcileChiefIntents(root, env);
  }
  return result;
}

/**
 * A child's `done` is decided under its mission lock, so it cannot race a reconcile into two
 * completion reports. Every other send runs unlocked, as before.
 */
export async function chiefSend(options = {}) {
  const env = options.env ?? process.env;
  const root = options.root ?? mailboxRoot();
  const sender = options.from || sessionFromEnv(env);
  if (options.kind === "done" && sender) {
    const listRooms = options.listRooms ?? listRawRooms;
    let owner = null;
    try {
      owner = listRooms(root).find((room) => room.chief?.mission?.session === sender) ?? null;
    } catch {
      owner = null;
    }
    if (owner) {
      const events = options.bridge ? [] : null;
      const result = await withExclusiveLock(missionLockPath(root, owner.id), () =>
        chiefSendBody({ ...options, lockedMission: owner.id, events }),
      );
      if (options.bridge) await emitChiefEvents(events, { env, bridge: options.bridge });
      else await reconcileChiefIntents(root, env);
      return result;
    }
  }
  const events = options.bridge ? [] : null;
  const result = await chiefSendBody({ ...options, events });
  if (options.bridge) await emitChiefEvents(events, { env, bridge: options.bridge });
  else await reconcileChiefIntents(root, env);
  return result;
}

async function chiefSendBody({
  to,
  message,
  from,
  kind,
  noWake: suppliedNoWake,
  root = mailboxRoot(),
  env = process.env,
  now = Date.now(),
  runMailbox = defaultRunMailbox,
  listRooms = listRawRooms,
  lockedMission = null,
  events = null,
} = {}) {
  const text = String(message || "").trim();
  if (!text) throw new Error("Message text is empty");
  if (kind !== undefined && kind !== null && !KINDS.has(kind))
    throw new Error(`--kind must be one of ${[...KINDS].join(", ")}`);
  // Updates are quiet by default; questions, escalations, done reports and sends with no kind still wake.
  const noWake = suppliedNoWake ?? kind === "update";
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
  const ownMission = rooms.find((candidate) => candidate.chief?.mission?.session === sender);
  // Under the mission lock the state is re-read, so a reconcile that just recorded done is seen.
  const missionState = lockedMission
    ? readRawRoom(lockedMission, root).chief?.state
    : ownMission?.chief?.state;
  if (kind === "done" && missionState === "done") {
    // One completion per mission: a repeated or raced done never queues or wakes a second report.
    return {
      schema: CHIEF_SEND_SCHEMA,
      mission: { roomId: ownMission.id, state: "done" },
      status: "already-reported",
      target: null,
      woke: false,
    };
  }
  let target;
  let isChiefUnavailable = false;
  try {
    target = resolveChiefTarget(to, { status, rooms, peers });
  } catch (error) {
    if (error.code !== "chief_unavailable") throw error;
    isChiefUnavailable = true;
    target = { tier: "chief", session: null, chief: true };
  }
  if (target.session && target.session === sender) throw new Error("That target is this session");
  if (target.session && isRestingPeer(root, target.session, env)) {
    if (!target.chief) throw new Error(`${target.label} is resting after a quota handoff`);
    isChiefUnavailable = true;
  }
  if (isChiefUnavailable) {
    const record = recordDesk(
      root,
      { from: sender, kind: kind || "update", text: oneLine(text, MAX_REPORT_CHARS * 4) },
      now,
    );
    const mission = await recordMissionReport({
      rooms,
      sender,
      env,
      kind,
      text,
      root,
      now,
      locked: lockedMission !== null,
      sourceId: `desk:${record.id}`,
      events,
    });
    return {
      schema: CHIEF_SEND_SCHEMA,
      mission,
      status: "queued",
      desk: record,
      target: { tier: "chief", session: null },
      woke: false,
    };
  }
  const isTargetChief =
    Boolean(target.chief) ||
    Boolean(status?.chief?.session && target.session === status.chief.session);
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
      const mission = isTargetChief
        ? await recordMissionReport({
            rooms,
            sender,
            env,
            kind,
            text,
            root,
            now,
            locked: lockedMission !== null,
            sourceId: `desk:${record.id}`,
            events,
          })
        : null;
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
  const mission = isTargetChief
    ? await recordMissionReport({
        rooms,
        sender,
        env,
        kind,
        text,
        root,
        now,
        locked: lockedMission !== null,
        sourceId: `msg:${
          typeof delivery?.id === "string" && delivery.id
            ? delivery.id
            : createHash("sha256").update(`${sender}\0${body}\0${now}`).digest("hex").slice(0, 32)
        }`,
        events,
      })
    : null;
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

// ---------------------------------------------------------------------------
// Digest, acknowledgment and close

const DIGEST_SCHEMA = "ork.chief.inbox.v1";
const CLOSE_SCHEMA = "ork.chief.close.v1";
const DIGEST_TEXT_GROUPS = 5;

function askPriority(kind) {
  if (kind === "escalation") return 0;
  if (kind === "question" || kind === "awaiting-input") return 1;
  return 2;
}

/** Text mode shows at most five groups; with more, four are shown and the rest are named in a footer. */
export function displayedDigestGroups(groups) {
  return groups.length > DIGEST_TEXT_GROUPS
    ? groups.slice(0, DIGEST_TEXT_GROUPS - 1)
    : groups.slice(0, DIGEST_TEXT_GROUPS);
}

function openRoomIndex(rooms) {
  const bySession = new Map();
  const byId = new Map();
  for (const room of rooms) {
    if (!isPlainObject(room) || !isValidRoomId(room.id) || isClosedRoom(room)) continue;
    byId.set(room.id, room);
    for (const session of roomSessions(room)) bySession.set(session, room.id);
  }
  return { bySession, byId };
}

function attributeMessage(message, index) {
  if (isValidRoomId(message.roomId) && index.byId.has(message.roomId)) return message.roomId;
  const session = message.from?.session;
  return (typeof session === "string" && index.bySession.get(session)) || null;
}

/** Builds the complete digest from every unread Chief message and every desk item. Read-only. */
function buildDigest({ root, rooms, chief }) {
  const index = openRoomIndex(rooms);
  const desk = listDesk(root);
  const deskById = new Map(desk.map((item) => [item.id, item]));
  const groups = new Map();
  const groupFor = (roomId) => {
    const key = roomId ?? "";
    if (!groups.has(key)) groups.set(key, { roomId, items: [], deskIds: [], inboxIds: [] });
    return groups.get(key);
  };
  for (const item of desk) {
    const roomId = item.roomId && index.byId.has(item.roomId) ? item.roomId : null;
    const group = groupFor(roomId);
    group.items.push({
      source: "desk",
      id: item.id,
      kind: item.kind,
      from: item.from || "unknown",
      text: oneLine(item.text, 200),
      at: item.at || null,
    });
    group.deskIds.push(item.id);
  }
  const mail = chief?.live ? readUnreadInbox(root, chief.session) : [];
  for (const message of mail) {
    // A mailbox copy of a desk report shares its stable report ID, so the digest shows it once.
    const linked =
      (typeof message.clientId === "string" && deskById.get(message.clientId)) ||
      desk.find((item) => item.mailboxId === message.id);
    if (linked) {
      const group = groupFor(linked.roomId);
      group.inboxIds.push(message.id);
      continue;
    }
    const group = groupFor(attributeMessage(message, index));
    group.items.push({
      source: "inbox",
      id: message.id,
      kind: messageKind(message.text),
      from: message.from?.name || message.from?.session || "unknown",
      text: oneLine(message.text.replace(/^\[chief:\w+\]\s*/u, ""), 200),
      at: message.sentAt || null,
    });
    group.inboxIds.push(message.id);
  }
  const ranked = groups
    .values()
    .map((group) => {
      const asks = group.items.toSorted(
        (left, right) =>
          askPriority(left.kind) - askPriority(right.kind) ||
          (stampMs(right.at) || 0) - (stampMs(left.at) || 0),
      );
      const room = group.roomId ? index.byId.get(group.roomId) : null;
      const latestMs = Math.max(0, ...asks.map((ask) => stampMs(ask.at) || 0));
      return {
        rank: {
          escalation: asks.some((ask) => ask.kind === "escalation"),
          question: asks.some((ask) => askPriority(ask.kind) === 1),
          latestMs,
        },
        group: {
          roomId: group.roomId,
          state: room ? room.chief?.state || room.conductor?.status || "open" : "unattributed",
          latest: latestMs ? iso(latestMs) : null,
          asks,
          deskIds: group.deskIds,
          inboxIds: group.inboxIds,
        },
      };
    })
    .toArray();
  ranked.sort(
    (left, right) =>
      Number(right.rank.escalation) - Number(left.rank.escalation) ||
      Number(right.rank.question) - Number(left.rank.question) ||
      right.rank.latestMs - left.rank.latestMs ||
      String(left.group.roomId ?? "~").localeCompare(String(right.group.roomId ?? "~")),
  );
  return ranked.map(({ group }) => group);
}

/**
 * Digest of the machine's Chief queue. With ack, acknowledges every item in the groups returned
 * (or only the displayed groups for ackScope "displayed"), by explicit ID.
 */
export async function chiefInbox({
  root = mailboxRoot(),
  env = process.env,
  now = Date.now(),
  ack = false,
  ackScope = "all",
  runMailbox = defaultRunMailbox,
  listRooms = listRawRooms,
  peers: providedPeers,
} = {}) {
  const peers = providedPeers || readPeers(root, { now });
  const chief = readChiefBinding({ root, now, peers });
  let rooms;
  try {
    rooms = listRooms(root).filter(
      (room) => isPlainObject(room) && (!room.machine || room.machine === hostname()),
    );
  } catch {
    rooms = [];
  }
  const groups = buildDigest({ root, rooms, chief });
  const payload = {
    schema: DIGEST_SCHEMA,
    groups,
    acknowledged: { desk: 0, inbox: 0 },
  };
  if (ack) {
    await resumeAcknowledgements(root, { runMailbox, env });
    const chosen = ackScope === "displayed" ? displayedDigestGroups(groups) : groups;
    const deskIds = chosen.flatMap((group) => group.deskIds);
    const inboxIds = chosen.flatMap((group) => group.inboxIds);
    if (inboxIds.length > 0 && !chief?.live)
      throw new Error("No live Chief is bound; mail cannot be acknowledged");
    payload.acknowledged = await commitAcknowledgement({
      root,
      deskIds,
      inboxIds,
      session: chief?.live ? chief.session : null,
      runMailbox,
      env,
      now,
    });
  }
  return payload;
}

/**
 * Acknowledges exactly the IDs in a drawer snapshot. A changed Chief session or revision, or an ID
 * that is not currently on the desk or the unattributed queue, fails closed.
 */
export async function chiefDesk({
  root = mailboxRoot(),
  env = process.env,
  now = Date.now(),
  ack = false,
  snapshot = null,
  runMailbox = defaultRunMailbox,
  listRooms = listRawRooms,
  peers: providedPeers,
} = {}) {
  if (!ack) return { schema: "ork.chief.desk.v1", items: listDesk(root) };
  if (!isPlainObject(snapshot)) throw new Error("Acknowledging the desk needs a snapshot");
  const peers = providedPeers || readPeers(root, { now });
  const chief = readChiefBinding({ root, now, peers });
  const deskIds = Array.isArray(snapshot.deskIds) ? snapshot.deskIds : [];
  const inboxIds = Array.isArray(snapshot.inboxIds) ? snapshot.inboxIds : [];
  if (snapshot.session != null) {
    if (
      !chief?.live ||
      chief.session !== snapshot.session ||
      String(chief.revision) !== String(snapshot.revision)
    )
      throw Object.assign(new Error("The Chief changed since this view; refresh and retry"), {
        code: "snapshot_changed",
      });
  } else if (inboxIds.length > 0) {
    throw Object.assign(new Error("A desk-only snapshot cannot acknowledge mailbox items"), {
      code: "snapshot_invalid",
    });
  }
  const currentDesk = new Set(listDesk(root).map((item) => item.id));
  if (deskIds.some((id) => !(typeof id === "string" && currentDesk.has(id))))
    throw Object.assign(
      new Error("A desk item in this view is no longer queued; refresh and retry"),
      {
        code: "snapshot_stale",
      },
    );
  if (inboxIds.length > 0) {
    let rooms;
    try {
      rooms = listRooms(root);
    } catch {
      rooms = [];
    }
    const index = openRoomIndex(rooms);
    const unattributed = new Set(
      readUnreadInbox(root, chief.session)
        .filter((message) => !attributeMessage(message, index))
        .map((message) => message.id),
    );
    if (inboxIds.some((id) => !unattributed.has(id)))
      throw Object.assign(
        new Error("A mail item in this view is no longer unread; refresh and retry"),
        {
          code: "snapshot_stale",
        },
      );
  }
  const result = await commitAcknowledgement({
    root,
    deskIds,
    inboxIds,
    session: snapshot.session ?? null,
    runMailbox,
    env,
    now,
  });
  return {
    schema: "ork.chief.desk.v1",
    items: listDesk(root),
    acknowledged: result,
  };
}

/** Closes tracking for a mission: never kills a process, closes a terminal or deletes files. */
export async function chiefClose({
  roomId,
  target,
  force = false,
  root = mailboxRoot(),
  env = process.env,
  now = Date.now(),
  listRooms = listRawRooms,
  runMailbox = defaultRunMailbox,
  peers: providedPeers,
} = {}) {
  const peers = providedPeers || readPeers(root, { now });
  let room = null;
  let resolvedId = null;
  if (isValidRoomId(roomId)) {
    try {
      room = readRawRoom(roomId, root);
      resolvedId = roomId;
    } catch {
      room = null;
    }
  }
  if (!room) {
    const wanted = target ?? roomId;
    if (!wanted) throw new Error("Pass the room, branch or session to close");
    const status = await chiefStatus({ root, env, now, quota: false, all: true, listRooms, peers });
    const found = resolveChiefTarget(wanted, { status, rooms: listRooms(root), peers });
    if (!found.roomId) {
      const error = new Error(`${wanted} is a standalone session, not a Chief mission`);
      error.code = "not_mission";
      throw error;
    }
    room = readRawRoom(found.roomId, root);
    resolvedId = found.roomId;
  }
  if (!isPlainObject(room.chief)) {
    const error = new Error(`${resolvedId} is not a Chief mission`);
    error.code = "not_mission";
    throw error;
  }
  if (room.machine && room.machine !== hostname()) {
    const error = new Error(`${resolvedId} belongs to another machine`);
    error.code = "foreign_machine";
    throw error;
  }
  const chief = readChiefBinding({ root, now, peers });
  // Captured before the room closes, so its mail still attributes to it during cleanup.
  const ownSessions = roomSessions(room);
  let status = "closed";
  await withExclusiveLock(missionLockPath(root, resolvedId), async () => {
    const current = readRawRoom(resolvedId, root);
    if (isClosedRoom(current)) {
      status = "already-closed";
      return;
    }
    const summary = summarizeRoom(current, { peers, inbox: [] });
    const live = summary.coordinator.live || summary.counts.working > 0;
    if (live && !force) {
      const error = new Error(
        `${resolvedId} is live; stop it first or pass --force to stop tracking it`,
      );
      error.code = "room_live";
      throw error;
    }
    await updateRawRoom(
      resolvedId,
      (next) => {
        next.status = "closed";
        next.closedAt ||= iso(now);
        return next;
      },
      { root },
    );
  });
  // Cleanup repeats on every close, so an interrupted acknowledgment completes now.
  await resumeAcknowledgements(root, { runMailbox, env });
  const deskIds = listDesk(root)
    .filter((item) => item.roomId === resolvedId)
    .map((item) => item.id);
  let inboxIds = [];
  if (chief?.live) {
    inboxIds = readUnreadInbox(root, chief.session)
      .filter((message) => message.roomId === resolvedId || ownSessions.has(message.from?.session))
      .map((message) => message.id);
  }
  if (deskIds.length > 0 || inboxIds.length > 0)
    await commitAcknowledgement({
      root,
      deskIds,
      inboxIds,
      session: chief?.live ? chief.session : null,
      runMailbox,
      env,
      now,
    });
  return { schema: CLOSE_SCHEMA, roomId: resolvedId, status };
}

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
   If Chief sends \`--kind question\`, answer from the code via \`--kind update\` (or fold it into
   your active milestone or \`--kind done\` report if mid-step) without making extra edits or
   expanding scope.
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

function loadConfiguredRoutes(env = process.env) {
  let routes = {};
  try {
    const defaults = JSON.parse(readFileSync(ROUTES_DEFAULTS_PATH, "utf8"));
    if (isPlainObject(defaults?.routes)) {
      routes = { ...defaults.routes };
    }
  } catch (error) {
    throw new Error(`Cannot load default routes: ${error.message}`, { cause: error });
  }
  const cfgPath = resolvePolicyConfigPath({ env });
  if (cfgPath && existsSync(cfgPath)) {
    let userCfg;
    try {
      userCfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    } catch (error) {
      throw new Error(`Cannot load routes from ${cfgPath}: ${error.message}`, { cause: error });
    }
    if (isPlainObject(userCfg?.routes)) {
      for (const [role, entry] of Object.entries(userCfg.routes)) {
        const hasEngine = typeof entry?.engine === "string" && entry.engine.trim();
        const hasAccount = typeof entry?.account === "string" && entry.account.trim();
        if (!isPlainObject(entry) || (!hasEngine && !hasAccount)) {
          throw new Error(`${cfgPath}: route ${JSON.stringify(role)} needs at least an engine`);
        }
        routes[role] = { ...entry };
      }
    }
  }
  return routes;
}

function defaultIsEngineInstalled(engine, env = process.env) {
  const binary = engine === "antigravity" || engine === "gemini" ? "agy" : engine;
  if (!binary) return false;
  const pathEnv = String(env?.PATH || "");
  if (!pathEnv) return false;
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const full = path.join(dir, binary);
    try {
      accessSync(full, fsConstants.X_OK);
      if (!statSync(full).isDirectory()) return true;
    } catch {
      // Keep scanning PATH directories.
    }
  }
  return false;
}

function normalizeRouteCandidate(
  routeName,
  entry,
  { isAlternate = false, env = process.env } = {},
) {
  const hasEngine = typeof entry?.engine === "string" && entry.engine.trim();
  const hasAccount = typeof entry?.account === "string" && entry.account.trim();
  if (!isPlainObject(entry) || (!hasEngine && !hasAccount)) {
    throw new Error(`Route ${JSON.stringify(routeName)} needs an engine`);
  }
  let routeEngine = null;
  let accountFromEngine = null;
  if (hasEngine) {
    const rawEngine = entry.engine.trim().toLowerCase();
    const normalized = engineOf(rawEngine);
    if (normalized && COORDINATOR_ENGINES.has(normalized)) {
      routeEngine = normalized;
    } else {
      const matchedAcct = resolveConfiguredAccount(rawEngine, { env });
      if (matchedAcct) {
        routeEngine = engineOf(
          String(matchedAcct.provider || "")
            .trim()
            .toLowerCase(),
        );
        accountFromEngine = matchedAcct.id || rawEngine;
      }
    }
    if (!routeEngine || !COORDINATOR_ENGINES.has(routeEngine)) {
      throw new Error(`Route ${JSON.stringify(routeName)} has unsupported engine ${entry.engine}`);
    }
  }
  const explicitRouteAccount = hasAccount ? entry.account.trim() : accountFromEngine;
  if (!routeEngine && explicitRouteAccount) {
    const matchedAcct = resolveConfiguredAccount(explicitRouteAccount, { env });
    if (matchedAcct) {
      routeEngine = engineOf(
        String(matchedAcct.provider || "")
          .trim()
          .toLowerCase(),
      );
    }
    if (!routeEngine || !COORDINATOR_ENGINES.has(routeEngine)) {
      throw new Error(
        `Route ${JSON.stringify(routeName)} references unknown account ${explicitRouteAccount}`,
      );
    }
  }
  const claudeConfigDir = entry.claudeConfigDir || entry.claude_config_dir || null;
  const tags = entry.tags === undefined ? [] : normalizeAccountTags({ tags: entry.tags });
  return {
    engine: routeEngine,
    routeEngine,
    account: explicitRouteAccount || null,
    tags,
    model: typeof entry.model === "string" && entry.model.trim() ? entry.model.trim() : null,
    effort: typeof entry.effort === "string" && entry.effort.trim() ? entry.effort.trim() : null,
    variant:
      typeof entry.variant === "string" && entry.variant.trim() ? entry.variant.trim() : null,
    claudeConfigDir: claudeConfigDir ? String(claudeConfigDir) : null,
    isAlternate,
  };
}

function evaluateRouteCandidatePolicy(
  repoRoot,
  candidate,
  { env, account = null, claudeConfigDir = null } = {},
) {
  const effectiveAccount = account || candidate.account || null;
  const effectiveClaudeDir = claudeConfigDir || candidate.claudeConfigDir || null;
  const baseOpts = {
    env,
    ...(effectiveClaudeDir && { claudeConfigDir: effectiveClaudeDir }),
  };

  if (effectiveAccount) {
    const policy = checkRepoPolicyForSide(repoRoot, candidate.routeEngine, {
      ...baseOpts,
      account: effectiveAccount,
    });
    if (policy.ok && candidate.tags.some((tag) => !(policy.tags || []).includes(tag))) {
      return {
        ok: false,
        status: "tag_mismatch",
        engine: candidate.routeEngine,
        deny: policy.deny || [],
        error: `Account '${effectiveAccount}' does not match route tags [${candidate.tags.join(", ")}].`,
      };
    }
    return policy;
  }

  if (candidate.tags.length > 0) {
    const configured = loadConfiguredAccounts({ env }).filter((acct) => {
      const acctEngine = engineOf(
        String(acct.provider || "")
          .trim()
          .toLowerCase(),
      );
      if (acctEngine !== candidate.routeEngine) return false;
      const acctTags = normalizeAccountTags(acct);
      return candidate.tags.every((tag) => acctTags.includes(tag));
    });
    if (configured.length === 0) {
      return {
        ok: false,
        status: "policy_denied",
        engine: candidate.routeEngine,
        deny: [],
        error: `No configured ${candidate.routeEngine} account matches route tags [${candidate.tags.join(", ")}]`,
      };
    }
    let firstDenied = null;
    for (const acct of configured) {
      const policy = checkRepoPolicyForSide(repoRoot, candidate.routeEngine, {
        ...baseOpts,
        account: acct.id,
      });
      if (policy.ok) return policy;
      firstDenied ??= policy;
    }
    return firstDenied;
  }

  return checkRepoPolicyForSide(repoRoot, candidate.routeEngine, baseOpts);
}

function resolveRouteForChiefSpawn(
  routeName,
  explicitEngine,
  env = process.env,
  { repoRoot, account = null, claudeConfigDir = null, isInstalled = defaultIsEngineInstalled } = {},
) {
  const routes = loadConfiguredRoutes(env);
  if (!Object.hasOwn(routes, routeName)) {
    throw new Error(
      `Unknown --route ${JSON.stringify(routeName)}; configured: ${Object.keys(routes)
        .toSorted((a, b) => a.localeCompare(b))
        .join(", ")}`,
    );
  }
  const entry = routes[routeName];
  const primary = normalizeRouteCandidate(routeName, entry, { isAlternate: false, env });
  if (explicitEngine) {
    if (explicitEngine !== primary.routeEngine && explicitEngine !== primary.engine) {
      return null;
    }
    const policy = evaluateRouteCandidatePolicy(repoRoot, primary, {
      env,
      account,
      claudeConfigDir,
    });
    if (policy.ok) {
      const execEngine = policy.engine || primary.routeEngine;
      if (!isInstalled(execEngine, env)) {
        throw new Error(
          `Route ${JSON.stringify(routeName)} executable '${execEngine}' is not installed on PATH`,
        );
      }
    }
    return { candidate: primary, policy, primary };
  }

  const rawAlternates = Array.isArray(entry.alternates) ? entry.alternates : [];
  const candidates = [
    primary,
    ...rawAlternates.map((alt) =>
      normalizeRouteCandidate(routeName, alt, { isAlternate: true, env }),
    ),
  ];

  const unavailableEngines = [];
  let firstPolicyError = null;
  for (const candidate of candidates) {
    const policy = evaluateRouteCandidatePolicy(repoRoot, candidate, {
      env,
      account,
      claudeConfigDir,
    });
    if (!policy.ok) {
      firstPolicyError ??= policy.error;
      continue;
    }
    const execEngine = policy.engine || candidate.routeEngine;
    if (isInstalled(execEngine, env)) {
      return { candidate, policy, primary };
    }
    unavailableEngines.push(execEngine);
  }

  if (unavailableEngines.length > 0) {
    throw new Error(
      `Route ${JSON.stringify(routeName)} has no installed executable (checked: ${unavailableEngines.join(", ")})`,
    );
  }
  throw new Error(
    firstPolicyError ||
      `All candidates for route ${JSON.stringify(routeName)} are denied by policy`,
  );
}

function appendClaudeConfigDirOnce(args, claudeConfigDir) {
  const next = Array.isArray(args) ? [...args] : [];
  if (!claudeConfigDir) return next;
  const hasFlag = next.some(
    (token) => token === "--claude-config-dir" || String(token).startsWith("--claude-config-dir="),
  );
  if (!hasFlag) {
    next.push("--claude-config-dir", claudeConfigDir);
  }
  return next;
}

// ---------------------------------------------------------------------------
// Interactive spawn: the harness runs in a pane of the caller's own multiplexer

const INTERACTIVE_ENGINES = new Set(["claude", "codex"]);
const TMUX_PANE_RE = /^%\d+$/u;

function interactiveError(message) {
  return Object.assign(new Error(message), { code: "interactive_unavailable" });
}

function executableOnPath(name, env = process.env) {
  const dirs = String(env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean);
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      if (statSync(candidate).isFile()) {
        accessSync(candidate, fsConstants.X_OK);
        return candidate;
      }
    } catch {
      // Not here; keep searching.
    }
  }
  return null;
}

function defaultExec(file, args, { env, timeout = 20_000 } = {}) {
  const result = spawnSync(file, args, { encoding: "utf8", env, timeout });
  if (result.error) {
    throw Object.assign(new Error(result.error.message), {
      code: result.error.code,
      killed: result.error.code === "ETIMEDOUT",
    });
  }
  if (result.status !== 0) {
    throw Object.assign(new Error((result.stderr || result.stdout || "command failed").trim()), {
      status: result.status,
    });
  }
  return result.stdout;
}

const QUOTA_DECISION_PY = `
import inspect, json, sys
sys.path.insert(0, sys.argv[1])
import quota
engine, model, payload = sys.argv[2], sys.argv[3], json.loads(sys.argv[4])
view = quota.snapshot()
if view is None:
    print(json.dumps({"status": "unknown", "label": None}))
    raise SystemExit(0)
params = inspect.signature(quota.check).parameters
kwargs = {key: value for key, value in payload.items() if key in params}
result = quota.check(engine, model, view, **kwargs)
print(json.dumps({"status": result.get("status") or "unknown", "label": result.get("label")}))
`;

/**
 * The same decision run_agent's quota gate makes (quota.check on a live monitor snapshot), so an
 * interactive route and a detached run agree. Unknown quota is not treated as usable here.
 */
function defaultQuotaDecision({ engine, model, policy, env }) {
  const payload = {
    account_id: policy.accountId || null,
    account_alias: policy.accountAlias || null,
    claude_config_dir: policy.claudeConfigDir || null,
    codex_home: policy.codexHome || null,
    agy_home: policy.agyHome || null,
    tags: policy.tags || null,
  };
  const result = spawnSync(
    "python3",
    ["-I", "-c", QUOTA_DECISION_PY, SCRIPTS_DIR, engine, model || "", JSON.stringify(payload)],
    { encoding: "utf8", env, timeout: 120_000 },
  );
  try {
    return JSON.parse(result.stdout.trim().split("\n").at(-1));
  } catch {
    return { status: "unknown", label: null };
  }
}

/** Refuses what the detached gate refuses (blocked, credits) and what it cannot judge (unknown). */
function assertInteractiveQuota(decision) {
  if (decision.status === "blocked" || decision.status === "credits")
    throw interactiveError(
      `${decision.label || "The selected account"} is ${decision.status}; an interactive run would bill or stall`,
    );
  if (decision.status === "unknown" || !decision.status)
    throw interactiveError(
      "Quota for the interactive route cannot be established; start monitor or pick a measured route",
    );
  return decision.status;
}

/** The pane ID tmux reports for TMUX_PANE, or an empty string when tmux cannot answer. */
function tmuxPaneOrEmpty(env, exec) {
  try {
    return exec("tmux", ["display-message", "-p", "-t", env.TMUX_PANE, "#{pane_id}"], {
      env,
    }).trim();
  } catch {
    return "";
  }
}

/** Herdr, then Orca, then tmux. A binary on PATH alone never establishes a session. */
export function selectInteractiveBackend(env = process.env, { exec = defaultExec } = {}) {
  if (env.HERDR_ENV === "1") {
    if (!executableOnPath("herdr", env))
      throw interactiveError(
        "Herdr is the active session, but its herdr executable is not on PATH",
      );
    return { backend: "herdr", endpoint: herdrEndpoint(env) };
  }
  const context = orcaPaneContext(env);
  if (context) {
    const cli = resolveOrcaCli(env);
    if (!cli) throw interactiveError("Orca is the active session, but no Orca CLI is available");
    return { backend: "orca", cli, context };
  }
  if (TMUX_PANE_RE.test(env.TMUX_PANE || "")) {
    if (!executableOnPath("tmux", env))
      throw interactiveError("tmux is the active session, but tmux is not on PATH");
    const current = tmuxPaneOrEmpty(env, exec);
    if (current !== env.TMUX_PANE)
      throw interactiveError("TMUX_PANE does not identify a current tmux pane");
    return { backend: "tmux", pane: env.TMUX_PANE, server: env.TMUX?.split(",", 1)[0] || null };
  }
  throw interactiveError("No interactive session: run --interactive inside Herdr, Orca or tmux");
}

/** The private launcher runs the harness on the child PTY with the account environment and brief. */
function interactiveLauncher({
  roomId,
  missionSession,
  workspace,
  engine,
  model,
  briefPath,
  accountEnv,
  root,
}) {
  const exports = Object.entries(accountEnv || {})
    .filter(([key]) => /^[A-Z_][A-Z0-9_]*$/u.test(key))
    .map(([key, value]) => `export ${key}=${shellSingleQuote(String(value))}`);
  const harness = [
    engine,
    ...(model && engine === "claude" ? ["--model", model] : []),
    ...(model && engine === "codex" ? ["-m", model] : []),
  ];
  const statusline = fileURLToPath(
    new URL("../../src/py/agent_statusline_tmux.py", import.meta.url),
  );
  return [
    "#!/bin/sh",
    "# orkest-chief-interactive-launch: v1",
    `export ORK_CHIEF_ROOM=${shellSingleQuote(roomId)}`,
    `export ORK_CHIEF_MISSION_SESSION=${shellSingleQuote(missionSession)}`,
    `export AGENT_MAILBOX_SESSION=${shellSingleQuote(missionSession)}`,
    ...(path.basename(root) === "mailbox-v1"
      ? [`export ORCHESTRATE_HOME=${shellSingleQuote(path.dirname(root))}`]
      : []),
    ...exports,
    `cd ${shellSingleQuote(workspace)} || exit 1`,
    `exec python3 ${shellSingleQuote(statusline)} --room ${shellSingleQuote(roomId)} --cwd ${shellSingleQuote(workspace)} -- ${harness.map((part) => shellSingleQuote(part)).join(" ")} "$(cat ${shellSingleQuote(briefPath)})"`,
    "",
  ].join("\n");
}

/** The argv a backend would run for the split and launch, shown by dry-run without running it. */
function interactivePreviewArgv(selection, { workspace, launcher }) {
  if (selection.backend === "herdr")
    return [
      "herdr",
      "pane",
      "split",
      "--current",
      "--direction",
      "right",
      "--cwd",
      workspace,
      "--no-focus",
    ];
  if (selection.backend === "orca")
    return [
      selection.cli,
      "terminal",
      "split",
      "--terminal",
      selection.context.terminalHandle,
      "--direction",
      "vertical",
      "--command",
      launcher,
      "--json",
    ];
  return [
    "tmux",
    "new-window",
    "-d",
    "-P",
    "-F",
    "#{pane_id}",
    "-t",
    selection.pane,
    "-c",
    workspace,
    launcher,
  ];
}

/**
 * Splits the caller's pane (or tab/terminal) and starts the launcher there. Returns the persisted
 * identity; never retries a launch, since a timed-out split may already have opened a pane.
 */
function launchInteractive(selection, { workspace, launcher, exec, env, sibling = false }) {
  if (selection.backend === "herdr") {
    const split = JSON.parse(
      exec(
        "herdr",
        ["pane", "split", "--current", "--direction", "right", "--cwd", workspace, "--no-focus"],
        { env },
      ),
    );
    const paneId = split?.result?.pane?.pane_id;
    if (typeof paneId !== "string" || !paneId)
      throw new Error("Herdr split did not return a pane ID");
    exec("herdr", ["pane", "run", paneId, shellSingleQuote(launcher)], { env });
    return { herdrPaneId: paneId, herdrEndpoint: selection.endpoint, paneId };
  }
  if (selection.backend === "orca") {
    let stdout;
    try {
      stdout = exec(
        selection.cli,
        [
          "terminal",
          "split",
          "--terminal",
          selection.context.terminalHandle,
          "--direction",
          "vertical",
          "--command",
          sibling ? shellSingleQuote(launcher) : launcher,
          "--json",
        ],
        { env },
      );
    } catch (error) {
      if (error.killed)
        throw new Error("Orca did not confirm the split; check the workspace before retrying", {
          cause: error,
        });
      throw error;
    }
    const handle = orcaTerminalHandle(JSON.parse(stdout)?.result?.split?.handle);
    if (!handle) throw new Error("Orca split the pane without naming its terminal");
    return {
      orcaTerminalHandle: handle,
      orcaWorkspaceId: selection.context.worktreeId,
      orcaTabId: selection.context.tabId,
      orcaEnvironment: selection.context.environment,
      orcaPaneKey: selection.context.paneKey,
    };
  }
  const tmuxCommand = sibling ? ["split-window", "-h"] : ["new-window"];
  const paneId = exec(
    "tmux",
    [
      ...tmuxCommand,
      "-d",
      "-P",
      "-F",
      "#{pane_id}",
      "-t",
      selection.pane,
      "-c",
      workspace,
      sibling ? shellSingleQuote(launcher) : launcher,
    ],
    { env },
  ).trim();
  if (!TMUX_PANE_RE.test(paneId)) throw new Error(`tmux returned an unexpected pane: ${paneId}`);
  return { tmuxPane: paneId, paneId, terminalServer: selection.server };
}

/** Launch a prepared command beside its calling pane. Null means discovery failed before any split. */
export function launchSiblingPane({ workspace, launcher, env = process.env, exec = defaultExec }) {
  let selection;
  try {
    if (env.HERDR_ENV === "1" && !env.HERDR_PANE_ID) return null;
    selection = selectInteractiveBackend(env, { exec });
    if (selection.backend === "herdr") {
      const current = JSON.parse(exec("herdr", ["pane", "current", "--current"], { env }));
      if (!current?.result?.pane?.pane_id) return null;
    } else if (selection.backend === "orca") {
      const terminals = JSON.parse(exec(selection.cli, ["terminal", "list", "--json"], { env }));
      const rows = (terminals?.result || terminals)?.terminals;
      if (
        !selection.context.terminalHandle ||
        !Array.isArray(rows) ||
        rows.every((row) => row.handle !== selection.context.terminalHandle)
      )
        return null;
    }
  } catch {
    return null;
  }
  return {
    backend: selection.backend,
    ...launchInteractive(selection, { workspace, launcher, exec, env, sibling: true }),
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
  account,
  claudeConfigDir,
  model,
  effort,
  route,
  dryRun = false,
  timeout,
  interactive = false,
  quotaDecision = defaultQuotaDecision,
  root = mailboxRoot(),
  env = process.env,
  now = Date.now(),
  exec,
  interactiveExec = defaultExec,
  launch = defaultLaunch,
  provision = provisionWorktree,
  isEngineInstalled = defaultIsEngineInstalled,
} = {}) {
  if (!cwd) throw new Error("Pass --cwd <repository>");
  if (interactive && timeout !== undefined)
    throw interactiveError(
      "--timeout applies to detached missions; interactive panes have no runner timeout",
    );
  let goalText = typeof goal === "string" ? goal.trim() : "";
  if (goalFile) {
    if (goalText) throw new Error("Choose --goal or --goal-file");
    goalText = readFileSync(path.resolve(goalFile), "utf8").trim();
  }
  if (!goalText) throw new Error("Pass --goal <text> or --goal-file <path>");
  if (goalText.length > MAX_GOAL_CHARS)
    throw new Error(`Goal must be at most ${MAX_GOAL_CHARS} characters`);
  let requestedAccount = typeof account === "string" && account.trim() ? account.trim() : null;
  if (engine === "gemini" || engine === "antigravity") engine = "agy";
  if (engine && !COORDINATOR_ENGINES.has(engine)) {
    const matchedEngineAcct = resolveConfiguredAccount(engine, { env });
    if (matchedEngineAcct) {
      if (requestedAccount) {
        const matchedExplicit = resolveConfiguredAccount(requestedAccount, { env });
        if (matchedExplicit && matchedExplicit.id !== matchedEngineAcct.id) {
          throw new Error(
            `Engine/account '${engine}' contradicts explicit --account '${requestedAccount}'`,
          );
        }
      }
      requestedAccount ||= matchedEngineAcct.id || engine;
      engine = engineOf(
        String(matchedEngineAcct.provider || "")
          .trim()
          .toLowerCase(),
      );
    } else {
      throw new Error(
        `Unsupported engine ${engine}; choose ${[...COORDINATOR_ENGINES].join(", ")}`,
      );
    }
  }
  const repoRoot = resolveRepositoryRoot(path.resolve(cwd), exec);
  const missionTitle = oneLine(title || goalText.split(/\r?\n/u, 1)[0], 80);
  const isExplicitWorktree = typeof worktree === "string" && Boolean(worktree);
  let existingRoomIds;
  try {
    existingRoomIds = new Set(listRawRooms(root).map((room) => room.id));
  } catch {
    existingRoomIds = new Set();
  }
  const isWorktreeRequested = Boolean(worktree || branch);
  let slug = null;
  let branchName = null;
  let roomId = null;
  for (let attempt = 0; attempt < 16; attempt++) {
    const suffix = randomBytes(2).toString("hex");
    if (isWorktreeRequested) {
      slug = isExplicitWorktree ? worktree : `${slugify(branch || missionTitle, 40)}-${suffix}`;
      validateWorktreeSlug(slug);
      branchName = branch || `chief/${slug}`;
      roomId = `chief-${slug}`.slice(0, 64);
    } else {
      roomId = `chief-${slugify(missionTitle, 40)}-${suffix}`.slice(0, 64);
    }
    if (!existingRoomIds.has(roomId)) break;
    if (isExplicitWorktree) throw new Error(`Room ${roomId} already exists`);
  }
  if (existingRoomIds.has(roomId)) throw new Error(`Room ${roomId} already exists`);
  const missionSession = `${roomId}-orch`;
  const plannedWorkspace = isWorktreeRequested ? path.join(repoRoot, ".worktrees", slug) : repoRoot;

  let resolvedRoute = null;
  if (route) {
    resolvedRoute = resolveRouteForChiefSpawn(route, engine || null, env, {
      repoRoot,
      account: requestedAccount,
      claudeConfigDir: claudeConfigDir || null,
      isInstalled: isEngineInstalled,
    });
  }

  let policy;
  if (resolvedRoute) {
    policy = resolvedRoute.policy;
  } else if (engine || requestedAccount || claudeConfigDir) {
    policy = checkRepoPolicyForSide(repoRoot, engine || null, {
      env,
      ...(requestedAccount && { account: requestedAccount }),
      ...(claudeConfigDir && { claudeConfigDir }),
    });
  } else {
    policy = checkRepoPolicyForSide(repoRoot, null, {
      env,
      candidates: ["claude", "codex", "agy", "opencode"],
    });
  }
  if (!policy.ok) {
    throw new Error(
      policy.error ||
        `Engine ${engine || resolvedRoute?.candidate?.engine || "claude"} is denied by repository policy`,
    );
  }

  const routeCandidate = resolvedRoute?.candidate || null;
  const routePrimary = resolvedRoute?.primary || null;
  const selectedEngine = policy.engine || engine || routeCandidate?.engine;
  if (!selectedEngine) {
    throw new Error("Unable to resolve an allowed engine for mission spawn");
  }
  if (!isEngineInstalled(selectedEngine, env)) {
    throw new Error(`Engine '${selectedEngine}' is not installed on PATH`);
  }
  // Preflight: the backend and quota decision are proven before any room, worktree or hook exists.
  const selection = interactive ? selectInteractiveBackend(env, { exec: interactiveExec }) : null;
  if (interactive && !INTERACTIVE_ENGINES.has(selectedEngine))
    throw interactiveError(
      `Interactive launch supports ${[...INTERACTIVE_ENGINES].join(" and ")}; run ${selectedEngine} detached instead`,
    );
  const quotaStatus = interactive
    ? assertInteractiveQuota(
        await quotaDecision({
          engine: selectedEngine,
          model: model || routeCandidate?.model || "",
          policy,
          env,
        }),
      )
    : null;
  const resolvedModel = model || routeCandidate?.model || null;
  const resolvedEffort = effort || routeCandidate?.effort || null;
  const roomEngine = selectedEngine;
  const resolvedHomeDir = path.resolve(env.HOME || homedir());
  const defaultWorkClaudeDir = path.join(resolvedHomeDir, ".claude");
  const isAlternateClaudeProfileSwitch = Boolean(
    routeCandidate?.isAlternate && selectedEngine === "claude" && !policy.claudeConfigDir,
  );
  const effectiveClaudeConfigDir =
    policy.claudeConfigDir || (isAlternateClaudeProfileSwitch ? defaultWorkClaudeDir : null);
  const extraArgs = appendClaudeConfigDirOnce(policy.extraArgs, effectiveClaudeConfigDir);
  const hasAccountFlag = extraArgs.some(
    (token) => token === "--account" || String(token).startsWith("--account="),
  );
  const explicitAccountToForward =
    !hasAccountFlag && (requestedAccount || routeCandidate?.account)
      ? policy.accountId || requestedAccount || routeCandidate?.account
      : null;
  const shouldForwardRouteFlag = Boolean(
    route && !(routeCandidate?.isAlternate && routePrimary?.routeEngine === selectedEngine),
  );
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
    timeout ?? "8h",
    ...(shouldForwardRouteFlag ? ["--route", route] : []),
    "--engine",
    selectedEngine,
    ...(explicitAccountToForward ? ["--account", explicitAccountToForward] : []),
    ...(resolvedModel ? ["--model", resolvedModel] : []),
    ...(resolvedEffort ? ["--effort", resolvedEffort] : []),
    ...(selectedEngine === "opencode" && routeCandidate?.variant
      ? ["--variant", routeCandidate.variant]
      : []),
    ...extraArgs,
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
  const missionGeneration = randomBytes(8).toString("hex");
  const completionDir = path.join(cacheHome(env), "completions-v1");
  // Planning validates the hook location and trusted Node/entry without writing anything.
  const hookPlan = interactive
    ? null
    : planCompletionHook({
        root,
        roomId,
        workspaces: [repoRoot, plannedWorkspace, ...workspacesOf(command)],
      });
  if (hookPlan) command.push("--completion-hook", hookPlan.path);
  const interactiveLauncherPath = path.join(missionDir, "interactive-launch.sh");
  const warnings = [];
  if (quotaStatus === "low")
    warnings.push("The selected interactive account is low on included quota");
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
    accountId: policy.accountId || null,
    accountAlias: policy.accountAlias || null,
    tags: policy.tags || [],
    claudeConfigDir: effectiveClaudeConfigDir || null,
    codexHome: policy.codexHome || null,
    agyHome: policy.agyHome || null,
    route: route || null,
    model: resolvedModel,
    effort: resolvedEffort,
    briefPath,
    jobDir,
    completionHook: hookPlan?.path ?? null,
    backend: selection?.backend ?? null,
    command: selection
      ? interactivePreviewArgv(selection, {
          workspace: plannedWorkspace,
          launcher: interactiveLauncherPath,
        })
      : command,
    ...(dryRun && { brief }),
    warnings,
  };
  if (dryRun) return plan;

  let workspace = repoRoot;
  let worktreeInfo = null;
  if (isWorktreeRequested) {
    worktreeInfo = provision(repoRoot, { slug, branch: branchName, env, ...(exec && { exec }) });
    workspace = worktreeInfo.path;
  }
  const portEnv = worktreeInfo ? worktreePortEnv({ env, repoRoot, worktreePath: workspace }) : {};
  await newRoom([], {
    id: roomId,
    cwd: workspace,
    title: missionTitle,
    objective: goalText,
    engine: roomEngine,
    model: resolvedModel || undefined,
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
        ...(policy.accountId && { accountId: policy.accountId }),
        ...(policy.accountAlias && { accountAlias: policy.accountAlias }),
        ...(policy.claudeConfigDir && { claudeConfigDir: policy.claudeConfigDir }),
        ...(resolvedEffort && { effort: resolvedEffort }),
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
          // Identity the reconciler checks before any launch: expected job and trusted store.
          mode: interactive ? "interactive" : "detached",
          status: "launching",
          roomId,
          generation: missionGeneration,
          ...(hookPlan && { jobDir, completionDir, hook: hookPlan.path }),
          ...(selection && { backend: selection.backend }),
          engine: selectedEngine,
          ...(policy.accountId && { accountId: policy.accountId }),
          ...(policy.accountAlias && { accountAlias: policy.accountAlias }),
          ...(policy.claudeConfigDir && { claudeConfigDir: policy.claudeConfigDir }),
          route: route || null,
          model: resolvedModel || null,
          effort: resolvedEffort || null,
        },
      };
      return room;
    },
    { root },
  );
  mkdirSync(missionDir, { recursive: true, mode: 0o700 });
  writeFileSync(briefPath, brief, { mode: 0o600 });
  if (selection) {
    // Interactive: the harness runs in the pane itself. No detached runner, hook or timeout.
    writeFileSync(
      interactiveLauncherPath,
      interactiveLauncher({
        roomId,
        missionSession,
        workspace,
        engine: selectedEngine,
        model: resolvedModel,
        briefPath,
        accountEnv: { ...policy.accountEnv, ...portEnv },
        root,
      }),
      { mode: 0o700 },
    );
    let launchedPane;
    try {
      launchedPane = launchInteractive(selection, {
        workspace,
        launcher: interactiveLauncherPath,
        exec: interactiveExec,
        env,
      });
    } catch (error) {
      const message = oneLine(error.message, 400);
      await updateRawRoom(
        roomId,
        (room) => {
          room.chief.state = "failed";
          room.chief.launch = { ...room.chief.launch, status: "failed", error: message };
          if (room.conductor) room.conductor.status = "failed";
          return room;
        },
        { root },
      );
      return {
        ...plan,
        status: "failed",
        workspace,
        worktree: worktreeInfo
          ? { slug: worktreeInfo.slug, branch: worktreeInfo.branch, path: worktreeInfo.path }
          : null,
        launch: { backend: selection.backend, exitCode: null },
        error: message,
      };
    }
    await updateRawRoom(
      roomId,
      (room) => {
        room.chief.state = "running";
        room.chief.launch = {
          ...room.chief.launch,
          status: "launched",
          backend: selection.backend,
          ...launchedPane,
          launchedAt: iso(now),
        };
        if (room.conductor) {
          room.conductor.status = "running";
          Object.assign(room.conductor, launchedPane);
        }
        return room;
      },
      { root },
    );
    return {
      ...plan,
      status: "launched",
      workspace,
      worktree: worktreeInfo
        ? { slug: worktreeInfo.slug, branch: worktreeInfo.branch, path: worktreeInfo.path }
        : null,
      launch: { backend: selection.backend, ...launchedPane, exitCode: 0 },
    };
  }
  // The hook must exist before the executor starts, because a fast run can publish its event at once.
  try {
    installCompletionHook(
      planCompletionHook({ root, roomId, workspaces: [workspace, ...workspacesOf(command)] }),
    );
  } catch (error) {
    await updateRawRoom(
      roomId,
      (room) => {
        room.chief.state = "failed";
        room.chief.launch = {
          ...room.chief.launch,
          status: "failed",
          error: oneLine(error.message, 400),
        };
        if (room.conductor) room.conductor.status = "failed";
        return room;
      },
      { root },
    );
    return {
      ...plan,
      status: "failed",
      workspace,
      worktree: worktreeInfo
        ? { slug: worktreeInfo.slug, branch: worktreeInfo.branch, path: worktreeInfo.path }
        : null,
      command,
      launch: { exitCode: null },
      error: oneLine(error.message, 400),
    };
  }
  const finalCommand = command.map((part) => (part === plannedWorkspace ? workspace : part));
  const launchEnv = applyLauncherAccountEnv(
    {
      ...env,
      ...portEnv,
      ORK_CHIEF_ROOM: roomId,
      ORK_CHIEF_MISSION_SESSION: missionSession,
    },
    policy.accountEnv,
  );
  if (env.HOME !== undefined) {
    launchEnv.HOME = env.HOME;
  }
  const launched = launch(finalCommand, {
    cwd: workspace,
    env: launchEnv,
  });
  const info = parseLaunchOutput(launched.stdout);
  const isOk = launched.status === 0;
  await updateRawRoom(
    roomId,
    (room) => {
      // An early hook may already have written a terminal state; the launch never overwrites it.
      const isTerminal = TERMINAL_MISSION_STATES.has(room.chief.state);
      if (!isTerminal) room.chief.state = isOk ? "running" : "failed";
      const pidBirth = isOk && info.pid ? processStarted(info.pid) : undefined;
      room.chief.launch = {
        ...room.chief.launch,
        status: isOk ? info.status || "started" : "failed",
        pid: info.pid,
        ...(pidBirth && { pidBirth }),
        job: info.job,
        result: info.result,
        event: info.event,
        runMailbox: info.runMailbox,
        launchedAt: iso(now),
        ...(!isOk && {
          error: oneLine(launched.stderr || launched.stdout || "launch failed", 400),
        }),
      };
      if (!isTerminal && room.conductor) room.conductor.status = isOk ? "running" : "failed";
      if (info.pid && room.conductor) room.conductor.pid = info.pid;
      return room;
    },
    { root },
  );
  if (isOk) {
    // The manifest now exists: publish any exit that a fast hook saw before it did.
    const reconcileEnv = { ...env };
    delete reconcileEnv.AGENT_EVENT;
    delete reconcileEnv.AGENT_RESULT;
    try {
      await chiefReconcile({ roomId, hook: true, root, env: reconcileEnv, now });
    } catch {
      // The reconcile runs again on the next status or manual reconcile.
    }
  }
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
