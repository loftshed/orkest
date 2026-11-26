import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { knownEngines } from "./families-schema.mjs";
import { commandInvocation } from "./harness-command.mjs";
import {
  isActiveRoom,
  isClosedRoom,
  listRawRooms,
  mailboxRoot,
  readRawRoom,
  requireActiveRoom,
  updateRoom,
  workforceRoleInfo,
} from "./horde-room.mjs";
import {
  CANONICAL_HARNESSES,
  isHarnessAllowed,
  loadConfiguredAccounts,
  normalizeAccountTags,
  resolveConfiguredAccount,
  resolveRepoPolicy,
} from "./policy.mjs";
import { cacheHome } from "./runtime-paths.mjs";
import { worktreeLaunchEnv } from "./worktree-env.mjs";
import { prepareWorktree, provisionWorktree } from "./worktree-provision.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCRIPTS_DIR = path.resolve(__dirname, "../py");
const COORDINATOR_PY = path.join(SCRIPTS_DIR, "coordinator.py");
const PEER_MAILBOX_PY = path.join(SCRIPTS_DIR, "peer_mailbox.py");

export const SIDE_HELP = `Usage: ork side [options] "<idea>"

Launch or park a side mission without derailing the active session
or polluting the parent agent's mailbox inbox / context window.

Modes:
  --execute             Isolated git worktree + background worker (default)
  --investigate         Read-only background scout (also triggered by trailing '?' or 'ask:'/'check:')
  --later, --park       Park on the Peer Mailbox workboard (0 tokens, 0 background processes)
  --issue               File a GitHub issue with label agent:raw
  --mode <mode>         Explicit mode: auto | execute | investigate | park | issue

Options:
  --engine <engine>     Engine or account alias override (codex, claude, agy, opencode, or account alias)
  --account <id>        Account ID or alias override (from monitor config)
  --model <model>       Model override
  --effort <level>      Effort level override (low, medium, high, max)
  --allow-paths <csv>   Comma-separated allow_paths for execute mode (default: ".")
  --room <id>           Swarm room ID to register side-<N> in (auto-detected if omitted)
  --session <id>        Originating session ID (used only to locate active room, never for inbox wake)
  --harness <name>      Originating harness name
  --cwd <dir>           Working directory (defaults to process.cwd())
  --dry-run             Return planned side-mission metadata without side effects
  --json                Output JSON (schema: ork.side.v1)
  -h, --help            Show this help message
`;

const ISSUE_PREFIX_RE = /^issue:\s*(.+)$/is;
const PARK_PREFIX_RE = /^(?:later|todo|park):\s*(.+)$/is;
const INVESTIGATE_PREFIX_RE = /^(?:ask|check|investigate):\s*(.+)$/is;
const QUESTION_LEAD_RE =
  /^(?:why|how|what|where|when|who|which|is|are|can|does|do|should|find\s+out)\b/i;

/**
 * Classify a side-mission idea into one of: "execute" | "investigate" | "park" | "issue"
 * and return the cleaned idea text and a concise title.
 */
export function classifySideMode(rawInput = "", options = {}) {
  let idea = String(rawInput || "").trim();
  const requestedMode =
    options.mode && options.mode !== "auto" ? String(options.mode).toLowerCase() : null;

  let mode = requestedMode;

  const issueMatch = idea.match(ISSUE_PREFIX_RE);
  const parkMatch = idea.match(PARK_PREFIX_RE);
  const investigateMatch = idea.match(INVESTIGATE_PREFIX_RE);

  if (issueMatch) {
    idea = issueMatch[1].trim();
    if (!mode) mode = "issue";
  } else if (parkMatch) {
    idea = parkMatch[1].trim();
    if (!mode) mode = "park";
  } else if (investigateMatch) {
    idea = investigateMatch[1].trim();
    if (!mode) mode = "investigate";
  }

  if (!mode) {
    if (options.issue) {
      mode = "issue";
    } else if (options.later || options.park) {
      mode = "park";
    } else if (options.investigate) {
      mode = "investigate";
    } else if (options.execute) {
      mode = "execute";
    } else if (idea.endsWith("?") || QUESTION_LEAD_RE.test(idea)) {
      mode = "investigate";
    } else {
      mode = "execute";
    }
  }

  const firstLine = idea.split(/\r?\n/, 1)[0].trim();
  const title = firstLine.length > 72 ? `${firstLine.slice(0, 69).trimEnd()}...` : firstLine;

  return {
    mode,
    idea,
    title: title || "Side mission",
  };
}

function applyBooleanSideFlag(token, options) {
  switch (token) {
    case "-h":
    case "--help": {
      options.help = true;
      return true;
    }
    case "--json": {
      options.json = true;
      return true;
    }
    case "--dry-run": {
      options.dryRun = true;
      return true;
    }
    case "--execute": {
      options.execute = true;
      options.mode = "execute";
      return true;
    }
    case "--investigate": {
      options.investigate = true;
      options.mode = "investigate";
      return true;
    }
    case "--later":
    case "--park": {
      options.later = true;
      options.park = true;
      options.mode = "park";
      return true;
    }
    case "--issue": {
      options.issue = true;
      options.mode = "issue";
      return true;
    }
    default: {
      return false;
    }
  }
}

/**
 * Parse CLI arguments for `ork side`.
 */
export function parseSideArgs(argv = []) {
  const args = Array.isArray(argv) ? [...argv] : [];
  const options = {
    mode: "auto",
    execute: false,
    investigate: false,
    later: false,
    park: false,
    issue: false,
    engine: null,
    account: null,
    model: null,
    effort: null,
    allowPaths: ["."],
    claudeConfigDir: null,
    room: null,
    session: null,
    harness: null,
    cwd: null,
    dryRun: false,
    json: false,
    help: false,
  };
  const positional = [];

  for (let i = 0; i < args.length; i += 1) {
    const token = String(args[i] ?? "");
    if (token === "--") {
      positional.push(...args.slice(i + 1).map(String));
      break;
    }
    if (applyBooleanSideFlag(token, options)) {
      continue;
    }
    if (token === "--mode" && i + 1 < args.length) {
      options.mode = String(args[++i]).toLowerCase();
    } else if (token.startsWith("--mode=")) {
      options.mode = token.slice("--mode=".length).toLowerCase();
    } else if (token === "--engine" && i + 1 < args.length) {
      options.engine = String(args[++i]);
    } else if (token.startsWith("--engine=")) {
      options.engine = token.slice("--engine=".length);
    } else if (token === "--account" && i + 1 < args.length) {
      options.account = String(args[++i]);
    } else if (token.startsWith("--account=")) {
      options.account = token.slice("--account=".length);
    } else if (token === "--model" && i + 1 < args.length) {
      options.model = String(args[++i]);
    } else if (token.startsWith("--model=")) {
      options.model = token.slice("--model=".length);
    } else if (token === "--effort" && i + 1 < args.length) {
      options.effort = String(args[++i]);
    } else if (token.startsWith("--effort=")) {
      options.effort = token.slice("--effort=".length);
    } else if (token === "--allow-paths" && i + 1 < args.length) {
      options.allowPaths = String(args[++i])
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
    } else if (token.startsWith("--allow-paths=")) {
      options.allowPaths = token
        .slice("--allow-paths=".length)
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
    } else if (token === "--room" && i + 1 < args.length) {
      options.room = String(args[++i]);
    } else if (token.startsWith("--room=")) {
      options.room = token.slice("--room=".length);
    } else if (token === "--session" && i + 1 < args.length) {
      options.session = String(args[++i]);
    } else if (token.startsWith("--session=")) {
      options.session = token.slice("--session=".length);
    } else if (token === "--harness" && i + 1 < args.length) {
      options.harness = String(args[++i]);
    } else if (token.startsWith("--harness=")) {
      options.harness = token.slice("--harness=".length);
    } else if (token === "--cwd" && i + 1 < args.length) {
      options.cwd = String(args[++i]);
    } else if (token.startsWith("--cwd=")) {
      options.cwd = token.slice("--cwd=".length);
    } else if (token === "--claude-config-dir" && i + 1 < args.length) {
      options.claudeConfigDir = String(args[++i]);
    } else if (token.startsWith("--claude-config-dir=")) {
      options.claudeConfigDir = token.slice("--claude-config-dir=".length);
    } else {
      positional.push(token);
    }
  }

  return {
    options,
    rawIdea: positional.join(" ").trim(),
  };
}

/** The same mailbox root as rooms and peer_mailbox.py; ORCHESTRATE_MAILBOX_DIR pins a test or hook store. */
function resolveMailboxDir(env = process.env) {
  const explicit = (env.ORCHESTRATE_MAILBOX_DIR || "").trim();
  if (explicit) return path.resolve(explicit);
  return mailboxRoot(env);
}

function resolveAgentCacheDir(env = process.env) {
  return cacheHome(env);
}

function defaultRunCommand(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd || process.cwd(),
    env: opts.env || process.env,
    encoding: "utf8",
    timeout: opts.timeout ?? 30_000,
  });
  return {
    status: res.status ?? (res.error ? 1 : 0),
    stdout: String(res.stdout || ""),
    stderr: String(res.stderr || ""),
    error: res.error || null,
  };
}

function resolveGitRoot(cwd, runCmd) {
  const res = runCmd("git", ["rev-parse", "--show-toplevel"], { cwd });
  if (res && !res.error && res.status === 0 && res.stdout.trim()) {
    return res.stdout.trim();
  }
  const stderr = String(res?.stderr || "").toLowerCase();
  if (res && !res.error && res.status === 128 && stderr.includes("not a git repository")) {
    return path.resolve(cwd);
  }
  const detail =
    res?.error?.message ||
    res?.stderr?.trim() ||
    `git exited with status ${res?.status ?? "unknown"}`;
  throw new Error(`Failed to resolve git repository root for ${cwd}: ${detail}`);
}

function sameDirectory(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const resolve = (value) => {
    try {
      return fs.realpathSync(value);
    } catch {
      return path.resolve(value);
    }
  };
  return resolve(left) === resolve(right);
}

/** Session IDs a room records for its conductor and members (agent-executor.room.v1). */
function roomSessionIds(room) {
  const ids = new Set();
  const add = (value) => {
    if (typeof value === "string" && value) ids.add(value);
  };
  for (const member of [room.conductor, ...(Array.isArray(room.agents) ? room.agents : [])]) {
    if (!member || typeof member !== "object") continue;
    add(member.session?.id);
    add(member.mailboxSession);
    add(member.nativeSession);
    if (Array.isArray(member.previousSessions)) for (const id of member.previousSessions) add(id);
  }
  add(room.promotion?.session);
  return ids;
}

/**
 * Locate the open Swarm Room for this session or checkout. An explicit room ID wins; otherwise a
 * recorded session binding outranks a checkout match. Closed rooms and other machines are skipped.
 */
function findTargetRoom(mailboxDir, { roomId, session, cwd }) {
  if (roomId) {
    let data;
    try {
      data = readRawRoom(roomId, mailboxDir);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return null;
    }
    requireActiveRoom(data);
    if (isClosedRoom(data)) throw new Error(`Room ${data.id} is closed`);
    return { root: mailboxDir, data };
  }
  // Discovery by session or checkout only considers current rooms; history is never adopted.
  const entries = listRawRooms(mailboxDir, { lifecycle: "active" });
  let cwdMatch = null;
  for (const data of entries) {
    if (!data || typeof data !== "object" || data.schema !== "agent-executor.room.v1") continue;
    if (
      !isActiveRoom(data) ||
      isClosedRoom(data) ||
      (data.machine && data.machine !== os.hostname())
    )
      continue;
    if (session && roomSessionIds(data).has(session)) return { root: mailboxDir, data };
    if (!cwdMatch && cwd && sameDirectory(data.cwd, cwd)) cwdMatch = { root: mailboxDir, data };
  }
  return cwdMatch;
}

/**
 * Register a `side-<N>` member under the room's update protocol: the ID is allocated from a fresh
 * read inside the update, and the member is validated against the room schema before commit.
 */
async function registerSideMemberInRoom(roomRecord, sideSpec) {
  if (!roomRecord || !roomRecord.root || !roomRecord.data) {
    return { roomId: null, memberId: sideSpec.defaultMemberId };
  }
  const workforceRole = sideSpec.mode === "investigate" ? "scout" : "builder";
  let saved;
  try {
    saved = await updateRoom(
      roomRecord.data.id,
      (room) => {
        requireActiveRoom(room);
        const agents = Array.isArray(room.agents) ? room.agents : [];
        const existing = agents.find((agent) => agent?.sideId === sideSpec.sideId);
        if (existing) return room;
        const existingSideNums = agents
          .map((agent) => /^side-(\d+)$/u.exec(String(agent?.id || ""))?.[1])
          .map(Number)
          .filter((n) => Number.isFinite(n) && n > 0);
        const nextNum = existingSideNums.length > 0 ? Math.max(...existingSideNums) + 1 : 1;
        const nowIso = new Date().toISOString();
        const memberEntry = {
          id: `side-${nextNum}`,
          parent: "conductor",
          role: "worker",
          ...(workforceRoleInfo(workforceRole) && { workforceRole }),
          engine: sideSpec.engine,
          ...(sideSpec.accountId && { accountId: sideSpec.accountId }),
          ...(sideSpec.accountAlias && { accountAlias: sideSpec.accountAlias }),
          ...(sideSpec.claudeConfigDir && { claudeConfigDir: sideSpec.claudeConfigDir }),
          model: sideSpec.model,
          ...(sideSpec.effort && { effort: sideSpec.effort }),
          label: `side-${sideSpec.mode}`,
          status: "running",
          objective: sideSpec.idea,
          output: [],
          sideMode: sideSpec.mode,
          sideId: sideSpec.sideId,
          mission: sideSpec.idea,
          title: sideSpec.title,
          isolatedInbox: true,
          keepWorktree: Boolean(sideSpec.worktreePath),
          ...(sideSpec.cwd && { cwd: path.resolve(sideSpec.cwd) }),
          createdAt: nowIso,
          updatedAt: nowIso,
        };
        if (sideSpec.worktreePath) {
          memberEntry.worktree = {
            path: path.resolve(sideSpec.worktreePath),
            ...(sideSpec.branch && { branch: sideSpec.branch }),
            disposable: false,
            ...(sideSpec.repoRoot && { parentCwd: path.resolve(sideSpec.repoRoot) }),
            slug: path.basename(sideSpec.worktreePath),
          };
        }
        if (sideSpec.taskDir && sideSpec.taskId && sideSpec.requestId) {
          memberEntry.dispatch = {
            taskDir: path.resolve(sideSpec.taskDir),
            taskId: sideSpec.taskId,
            requestId: sideSpec.requestId,
            transport: "executor",
            kind: sideSpec.kind,
            ...(sideSpec.runId && { runId: sideSpec.runId }),
            startedAt: nowIso,
          };
        }
        room.agents = [...agents, memberEntry];
        return room;
      },
      { root: roomRecord.root },
    );
  } catch (error) {
    throw new Error(
      `Side mission ${sideSpec.sideId} was dispatched (${sideSpec.taskDir}) but could not join room ${roomRecord.data.id}: ${error.message}`,
      { cause: error },
    );
  }
  const member = saved.agents.find((agent) => agent.sideId === sideSpec.sideId);
  return { roomId: saved.id, memberId: member.id };
}

function provisionSideWorktree(repoRoot, shortId, runCmd, env = process.env) {
  const worktreesRoot = path.join(repoRoot, ".worktrees");
  const worktreePath = path.join(worktreesRoot, `wt-side-${shortId}`);
  const branch = `ork/side-${shortId}`;

  let prepared;
  try {
    ({ prepared } = provisionWorktree(repoRoot, {
      slug: `wt-side-${shortId}`,
      branch,
      exec: runCmd,
      env,
    }));
  } catch (error) {
    if (!["add", "path-exists"].includes(error.stage)) throw error;
    // Fallback to detached worktree if branch name already exists
    const fallbackRes = runCmd("git", ["worktree", "add", "--detach", worktreePath, "HEAD"], {
      cwd: repoRoot,
    });
    if (fallbackRes.status !== 0) {
      throw new Error(
        `Failed to provision side-mission worktree at ${worktreePath}: ${
          error.stderr || fallbackRes.stderr || "git worktree add failed"
        }`,
        { cause: error },
      );
    }

    // Same preparation as every other creation path; a failure keeps this worktree and surfaces its stage.
    prepared = prepareWorktree(repoRoot, worktreePath, {
      slug: `wt-side-${shortId}`,
      env,
      overwrite: false,
    });
  }

  return { worktreePath, branch, prepared };
}

const RAW_PROVIDER_ENV_KEYS = [
  "ANTIGRAVITY_APP_DATA_DIR",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "GEMINI_CLI_HOME",
];

/**
 * Applies account environment overrides onto a coordinator/launcher environment
 * while stripping raw provider/HOME selectors and translating custom Codex/Antigravity
 * directories to child-only `ORKEST_*_ACCOUNT_HOME` variables.
 */
export function applyLauncherAccountEnv(targetEnv, accountEnv) {
  for (const key of RAW_PROVIDER_ENV_KEYS) {
    delete targetEnv[key];
  }
  if (!accountEnv || typeof accountEnv !== "object") {
    return targetEnv;
  }
  const safeAccountEnv = { ...accountEnv };
  if (safeAccountEnv.CODEX_HOME && !safeAccountEnv.ORKEST_CODEX_ACCOUNT_HOME) {
    safeAccountEnv.ORKEST_CODEX_ACCOUNT_HOME = safeAccountEnv.CODEX_HOME;
  }
  const rawAgyHome = safeAccountEnv.ANTIGRAVITY_APP_DATA_DIR || safeAccountEnv.GEMINI_CLI_HOME;
  if (rawAgyHome && !safeAccountEnv.ORKEST_AGY_ACCOUNT_HOME) {
    safeAccountEnv.ORKEST_AGY_ACCOUNT_HOME = rawAgyHome;
  }
  delete safeAccountEnv.HOME;
  for (const key of RAW_PROVIDER_ENV_KEYS) {
    delete safeAccountEnv[key];
  }
  return Object.assign(targetEnv, safeAccountEnv);
}

function buildIsolatedEnv(baseEnv = process.env, isolatedCoordSession, mailboxDir = null) {
  const env = { ...baseEnv };
  // CRITICAL INVARIANT: Never allow a side mission to inherit the parent tab's
  // session ID as its coordinator parent_session, or completion events will be
  // routed into the parent agent's mailbox inbox and drained into its next turn!
  delete env.CLAUDE_SESSION_ID;
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CODEX_THREAD_ID;
  delete env.ANTIGRAVITY_CONVERSATION_ID;
  delete env.GEMINI_SESSION_ID;
  delete env.OPENCODE_SESSION_ID;
  env.AGENT_MAILBOX_SESSION = isolatedCoordSession;
  env.ORCHESTRATE_SESSION_ID = isolatedCoordSession;
  if (mailboxDir) {
    env.ORCHESTRATE_MAILBOX_DIR = mailboxDir;
  }
  return env;
}

function expandClaudeDir(configDir, homeDir = os.homedir()) {
  const text = String(configDir ?? "").trim();
  if (!text) return "";
  if (text === "~") return homeDir;
  if (text === "~/") return homeDir === "/" ? "/" : `${homeDir.replace(/\/+$/u, "")}/`;
  if (text.startsWith("~/")) return `${homeDir.replace(/\/+$/u, "")}/${text.slice(2)}`;
  return text;
}

function canonicalizeProfilePath(targetPath) {
  let current = path.resolve(String(targetPath));
  for (let depth = 0; depth < 40; depth += 1) {
    try {
      return fs.realpathSync(current);
    } catch {
      try {
        const stat = fs.lstatSync(current);
        if (stat.isSymbolicLink()) {
          current = path.resolve(path.dirname(current), fs.readlinkSync(current));
          continue;
        }
      } catch {
        // Fall through to parent resolution when path does not exist yet.
      }
      const parent = path.dirname(current);
      if (parent === current) return current;
      try {
        return path.join(fs.realpathSync(parent), path.basename(current));
      } catch {
        return current;
      }
    }
  }
  return current;
}

const PATH_ENV_KEYS = new Set([
  "ANTIGRAVITY_APP_DATA_DIR",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "GEMINI_CLI_HOME",
  "HOME",
  "OPENCODE_CONFIG",
  "XDG_CONFIG_HOME",
]);

function canonicalEngineName(rawEngine) {
  const cleaned = String(rawEngine || "")
    .trim()
    .toLowerCase();
  if (!cleaned) return "";
  if (cleaned === "gemini" || cleaned === "antigravity") return "agy";
  if (cleaned === "openai") return "codex";
  if (cleaned === "openrouter") return "opencode";
  if (cleaned === "anthropic") return "claude";
  return cleaned;
}

function accountBaseHome(account, homeDir) {
  const rawHome = account?.env?.HOME;
  if (typeof rawHome === "string" && rawHome.trim()) {
    return path.resolve(expandClaudeDir(rawHome.trim(), homeDir));
  }
  return homeDir;
}

function resolvedAccountClaudeDir(account, homeDir) {
  const baseHome = accountBaseHome(account, homeDir);
  const rawDir =
    account?.configDir || account?.claudeConfigDir || account?.env?.CLAUDE_CONFIG_DIR || null;
  if (typeof rawDir === "string" && rawDir.trim()) {
    return path.resolve(expandClaudeDir(rawDir.trim(), baseHome));
  }
  return path.join(baseHome, ".claude");
}

function resolvedAccountCodexHome(account, homeDir) {
  const baseHome = accountBaseHome(account, homeDir);
  const rawDir = account?.codexHome || account?.codex_home || account?.env?.CODEX_HOME || null;
  if (typeof rawDir === "string" && rawDir.trim()) {
    return path.resolve(expandClaudeDir(rawDir.trim(), baseHome));
  }
  return null;
}

function resolvedAccountAgyHome(account, homeDir) {
  const baseHome = accountBaseHome(account, homeDir);
  const rawDir =
    account?.agyHome ||
    account?.agy_home ||
    account?.geminiCliHome ||
    account?.env?.GEMINI_CLI_HOME ||
    account?.env?.ANTIGRAVITY_APP_DATA_DIR ||
    null;
  if (typeof rawDir === "string" && rawDir.trim()) {
    return path.resolve(expandClaudeDir(rawDir.trim(), baseHome));
  }
  return null;
}

function resolveAccountRuntimeConfig(engine, account, homeDir, explicitClaudeConfigDir = null) {
  const baseHome = account ? accountBaseHome(account, homeDir) : homeDir;
  const accountEnv = {};
  if (account?.env && typeof account.env === "object" && !Array.isArray(account.env)) {
    for (const [key, value] of Object.entries(account.env)) {
      if (typeof value !== "string" || !value.trim()) continue;
      accountEnv[key] = PATH_ENV_KEYS.has(key)
        ? path.resolve(expandClaudeDir(value.trim(), baseHome))
        : value;
    }
  }

  let claudeConfigDir = null;
  let codexHome = null;
  let agyHome = null;
  const extraArgs = [];

  if (engine === "claude") {
    const defaultClaudeDir = canonicalizeProfilePath(path.join(homeDir, ".claude"));
    if (explicitClaudeConfigDir) {
      claudeConfigDir = explicitClaudeConfigDir;
      extraArgs.push("--claude-config-dir", explicitClaudeConfigDir);
    } else if (account) {
      const configuredDir =
        account.configDir || account.claudeConfigDir || account.env?.CLAUDE_CONFIG_DIR || null;
      if (typeof configuredDir === "string" && configuredDir.trim()) {
        const resolvedDir = path.resolve(expandClaudeDir(configuredDir.trim(), baseHome));
        if (canonicalizeProfilePath(resolvedDir) !== defaultClaudeDir) {
          claudeConfigDir = resolvedDir;
          extraArgs.push("--claude-config-dir", resolvedDir);
        }
      }
    }
  } else if (engine === "codex" && account) {
    codexHome = resolvedAccountCodexHome(account, homeDir);
    if (!codexHome && typeof account.configDir === "string" && account.configDir.trim()) {
      codexHome = path.resolve(expandClaudeDir(account.configDir.trim(), baseHome));
    }
    if (codexHome) {
      accountEnv.CODEX_HOME = codexHome;
    }
  } else if (engine === "agy" && account) {
    agyHome = resolvedAccountAgyHome(account, homeDir);
    if (!agyHome && typeof account.configDir === "string" && account.configDir.trim()) {
      agyHome = path.resolve(expandClaudeDir(account.configDir.trim(), baseHome));
    }
    if (agyHome && !accountEnv.ANTIGRAVITY_APP_DATA_DIR) {
      accountEnv.GEMINI_CLI_HOME = agyHome;
    }
  }

  if (account?.id && !extraArgs.includes("--account")) {
    extraArgs.push("--account", account.id);
  }

  // Never propagate HOME into coordinator/launcher env (it splits Orkest locks/caches);
  // translate account.env.HOME into the child-only engine override instead.
  if (accountEnv.HOME) {
    const customHome = accountEnv.HOME;
    delete accountEnv.HOME;
    if (engine === "claude" && !accountEnv.ORKEST_CLAUDE_ACCOUNT_HOME) {
      accountEnv.ORKEST_CLAUDE_ACCOUNT_HOME = customHome;
    } else if (engine === "codex" && !accountEnv.ORKEST_CODEX_ACCOUNT_HOME) {
      accountEnv.ORKEST_CODEX_ACCOUNT_HOME = codexHome || path.join(customHome, ".codex");
    } else if (engine === "agy" && !accountEnv.ORKEST_AGY_ACCOUNT_HOME) {
      accountEnv.ORKEST_AGY_ACCOUNT_HOME = agyHome || path.join(customHome, ".gemini");
    }
  }

  return {
    engine,
    accountId: account?.id || null,
    accountAlias: account?.alias || null,
    tags: account ? normalizeAccountTags(account) : [],
    claudeConfigDir,
    codexHome,
    agyHome,
    accountEnv: Object.keys(accountEnv).length > 0 ? accountEnv : null,
    extraArgs,
  };
}

function buildAccountLookupOptions(options, env, homeDir) {
  const lookup = { env, homeDir };
  if (options.monitorConfigPath) lookup.monitorConfigPath = String(options.monitorConfigPath);
  if (Array.isArray(options.accounts)) lookup.accounts = options.accounts;
  if (options.monitorConfig && typeof options.monitorConfig === "object") {
    lookup.config = options.monitorConfig;
  } else if (
    options.config &&
    typeof options.config === "object" &&
    Array.isArray(options.config.accounts)
  ) {
    lookup.config = options.config;
  }
  return lookup;
}

function pickDefaultAccountForEngine(engine, matchingAccounts, homeDir) {
  if (matchingAccounts.length === 0) return null;
  if (engine === "claude") {
    const defaultDir = canonicalizeProfilePath(path.join(homeDir, ".claude"));
    const primary = matchingAccounts.find(
      (acct) =>
        canonicalizeProfilePath(resolvedAccountClaudeDir(acct, homeDir)) === defaultDir &&
        !acct.env?.HOME,
    );
    return primary || matchingAccounts[0];
  }
  if (engine === "codex") {
    const defaultDir = canonicalizeProfilePath(path.join(homeDir, ".codex"));
    const primary = matchingAccounts.find((acct) => {
      const custom = resolvedAccountCodexHome(acct, homeDir);
      return (!custom || canonicalizeProfilePath(custom) === defaultDir) && !acct.env?.HOME;
    });
    return primary || matchingAccounts[0];
  }
  if (engine === "agy") {
    const defaultDir = canonicalizeProfilePath(path.join(homeDir, ".gemini"));
    const primary = matchingAccounts.find((acct) => {
      const custom = resolvedAccountAgyHome(acct, homeDir);
      return (!custom || canonicalizeProfilePath(custom) === defaultDir) && !acct.env?.HOME;
    });
    return primary || matchingAccounts[0];
  }
  return matchingAccounts[0];
}

function checkAccountClaudeDirContradiction(
  account,
  accountEngine,
  explicitClaudeConfigDir,
  rawExplicitClaudeDir,
  homeDir,
  deny,
) {
  if (!explicitClaudeConfigDir) return null;
  if (accountEngine !== "claude") {
    return {
      ok: false,
      status: "profile_mismatch",
      engine: accountEngine,
      accountId: account.id || null,
      deny: [...deny],
      error: `Account '${account.alias || account.id}' (provider '${accountEngine}') contradicts explicit claudeConfigDir '${rawExplicitClaudeDir}'.`,
    };
  }
  const acctDir = canonicalizeProfilePath(resolvedAccountClaudeDir(account, homeDir));
  const explicitCanonical = canonicalizeProfilePath(explicitClaudeConfigDir);
  if (acctDir !== explicitCanonical) {
    return {
      ok: false,
      status: "profile_mismatch",
      engine: "claude",
      accountId: account.id || null,
      deny: [...deny],
      error: `Account '${account.alias || account.id}' claudeConfigDir contradicts explicit claudeConfigDir '${rawExplicitClaudeDir}'.`,
    };
  }
  return null;
}

/**
 * Check repository harness denylist policies using canonical evaluation (`policy.mjs`).
 */
export function checkRepoPolicyForSide(repoRoot, engine = null, options = {}) {
  const env = options.env || process.env;
  const homeDir = path.resolve(options.homeDir || env.HOME || os.homedir());
  let configPath = options.configPath ? path.resolve(String(options.configPath)) : undefined;
  if (!configPath && options.configDir) {
    configPath = path.join(path.resolve(String(options.configDir)), "config.json");
  }
  const policyOptions = { env, homeDir, strict: true };
  if (configPath) policyOptions.configPath = configPath;
  if (options.config) policyOptions.config = options.config;
  if (options.remote !== undefined) policyOptions.remote = options.remote;
  if (options.spawnSync) policyOptions.spawnSync = options.spawnSync;
  const policy = resolveRepoPolicy(repoRoot || process.cwd(), policyOptions);
  const resolvedRepo = policy.repo;

  const accountLookupOpts = buildAccountLookupOptions(options, env, homeDir);
  const configuredAccounts = loadConfiguredAccounts({ ...accountLookupOpts, strict: true });
  const evalOptions = {
    ...policyOptions,
    ...accountLookupOpts,
    policy,
    accounts: configuredAccounts,
  };

  const isAutoAccount = env.ORCHESTRATE_AUTO_ACCOUNT === "1";
  const rawExplicitClaudeDir = options.claudeConfigDir || options.claude_config_dir || null;
  const explicitClaudeConfigDir = rawExplicitClaudeDir
    ? path.resolve(expandClaudeDir(rawExplicitClaudeDir, homeDir))
    : null;

  const requestedAccountSelector = options.account ? String(options.account).trim() : null;
  const requestedRaw = engine || options.engine || null;
  const hasExplicitEngine = Boolean(requestedRaw);

  const allowResult = (resolvedEngine, account, fallbackFrom = null, overrideClaudeDir = null) => ({
    ok: true,
    status: "allowed",
    ...resolveAccountRuntimeConfig(resolvedEngine, account, homeDir, overrideClaudeDir),
    ...(fallbackFrom !== undefined && fallbackFrom !== null && { fallbackFrom }),
    deny: [...policy.deny],
  });

  // 1. Explicit --account <id-or-alias>
  if (requestedAccountSelector) {
    const selectedAccount = resolveConfiguredAccount(requestedAccountSelector, accountLookupOpts);
    if (!selectedAccount) {
      return {
        ok: false,
        status: "unknown_account",
        accountId: requestedAccountSelector,
        deny: [...policy.deny],
        error: `Unknown account '${requestedAccountSelector}': not found in monitor config.`,
      };
    }
    const accountEngine = canonicalEngineName(selectedAccount.provider || selectedAccount.engine);
    if (hasExplicitEngine) {
      const requestedEngine = canonicalEngineName(requestedRaw);
      const isCanonicalEngineToken = CANONICAL_HARNESSES.includes(requestedEngine);
      if (isCanonicalEngineToken) {
        if (requestedEngine !== accountEngine) {
          return {
            ok: false,
            status: "profile_mismatch",
            engine: requestedEngine,
            accountId: selectedAccount.id || null,
            deny: [...policy.deny],
            error: `Engine '${requestedRaw}' contradicts account '${selectedAccount.alias || selectedAccount.id}' (provider '${accountEngine}').`,
          };
        }
      } else {
        const requestedAcct = resolveConfiguredAccount(String(requestedRaw), accountLookupOpts);
        if (requestedAcct && requestedAcct.id !== selectedAccount.id) {
          return {
            ok: false,
            status: "profile_mismatch",
            engine: accountEngine,
            accountId: selectedAccount.id || null,
            deny: [...policy.deny],
            error: `Engine/account '${requestedRaw}' contradicts explicit account '${requestedAccountSelector}'.`,
          };
        }
        if (!requestedAcct && requestedEngine !== accountEngine) {
          return {
            ok: false,
            status: "profile_mismatch",
            engine: requestedEngine,
            accountId: selectedAccount.id || null,
            deny: [...policy.deny],
            error: `Engine '${requestedRaw}' contradicts account '${selectedAccount.alias || selectedAccount.id}' (provider '${accountEngine}').`,
          };
        }
      }
    }
    const dirMismatch = checkAccountClaudeDirContradiction(
      selectedAccount,
      accountEngine,
      explicitClaudeConfigDir,
      rawExplicitClaudeDir,
      homeDir,
      policy.deny,
    );
    if (dirMismatch) return dirMismatch;

    if (!isHarnessAllowed(resolvedRepo, selectedAccount, evalOptions)) {
      return {
        ok: false,
        status: "policy_denied",
        engine: accountEngine,
        accountId: selectedAccount.id || null,
        accountAlias: selectedAccount.alias || null,
        tags: normalizeAccountTags(selectedAccount),
        deny: [...policy.deny],
        error: `Account '${selectedAccount.alias || selectedAccount.id}' (${accountEngine}) is denied by repository policy for ${resolvedRepo}.`,
      };
    }
    return allowResult(accountEngine, selectedAccount, null, explicitClaudeConfigDir);
  }

  // 2. Explicit --engine <engine-or-account-alias>
  if (hasExplicitEngine) {
    const trimmedRaw = String(requestedRaw).trim();
    const canonicalRequested = canonicalEngineName(trimmedRaw);
    const isCanonicalOrLegacyEngine =
      CANONICAL_HARNESSES.includes(canonicalRequested) ||
      canonicalRequested === "claude-work" ||
      canonicalRequested === "claude-personal";

    const matchedByEngineToken = isCanonicalOrLegacyEngine
      ? null
      : resolveConfiguredAccount(trimmedRaw, accountLookupOpts);

    if (matchedByEngineToken) {
      const accountEngine = canonicalEngineName(
        matchedByEngineToken.provider || matchedByEngineToken.engine,
      );
      const dirMismatch = checkAccountClaudeDirContradiction(
        matchedByEngineToken,
        accountEngine,
        explicitClaudeConfigDir,
        rawExplicitClaudeDir,
        homeDir,
        policy.deny,
      );
      if (dirMismatch) return dirMismatch;
      if (!isHarnessAllowed(resolvedRepo, matchedByEngineToken, evalOptions)) {
        return {
          ok: false,
          status: "policy_denied",
          engine: accountEngine,
          accountId: matchedByEngineToken.id || null,
          accountAlias: matchedByEngineToken.alias || null,
          tags: normalizeAccountTags(matchedByEngineToken),
          deny: [...policy.deny],
          error: `Account '${matchedByEngineToken.alias || matchedByEngineToken.id}' (${accountEngine}) is denied by repository policy for ${resolvedRepo}.`,
        };
      }
      return allowResult(accountEngine, matchedByEngineToken, null, explicitClaudeConfigDir);
    }

    if (canonicalRequested === "claude-work" || canonicalRequested === "claude-personal") {
      const requiredTag = canonicalRequested === "claude-work" ? "work" : "personal";
      const matchingAccounts = configuredAccounts.filter(
        (acct) =>
          canonicalEngineName(acct.provider || acct.engine) === "claude" &&
          normalizeAccountTags(acct).includes(requiredTag),
      );
      if (explicitClaudeConfigDir) {
        const dirAccount = resolveConfiguredAccount(
          { provider: "claude", claudeConfigDir: explicitClaudeConfigDir },
          accountLookupOpts,
        );
        if (dirAccount && !normalizeAccountTags(dirAccount).includes(requiredTag)) {
          return {
            ok: false,
            status: "profile_mismatch",
            engine: canonicalRequested,
            deny: [...policy.deny],
            error: `Engine '${requestedRaw}' contradicts explicit claudeConfigDir '${rawExplicitClaudeDir}'.`,
          };
        }
        const target = dirAccount || {
          provider: "claude",
          engine: "claude",
          claudeConfigDir: explicitClaudeConfigDir,
          tags: [requiredTag],
        };
        if (!isHarnessAllowed(resolvedRepo, target, evalOptions)) {
          return {
            ok: false,
            status: "policy_denied",
            engine: canonicalRequested,
            deny: [...policy.deny],
            error: `Engine '${canonicalRequested}' is denied by repository policy for ${resolvedRepo}.`,
          };
        }
        return allowResult("claude", dirAccount, null, explicitClaudeConfigDir);
      }
      if (matchingAccounts.length > 0) {
        const allowed = matchingAccounts.find((acct) =>
          isHarnessAllowed(resolvedRepo, acct, evalOptions),
        );
        if (!allowed) {
          return {
            ok: false,
            status: "policy_denied",
            engine: canonicalRequested,
            deny: [...policy.deny],
            error: `Engine '${canonicalRequested}' is denied by repository policy for ${resolvedRepo}.`,
          };
        }
        return allowResult("claude", allowed);
      }
      if (!isHarnessAllowed(resolvedRepo, canonicalRequested, evalOptions)) {
        return {
          ok: false,
          status: "policy_denied",
          engine: canonicalRequested,
          deny: [...policy.deny],
          error: `Engine '${canonicalRequested}' is denied by repository policy for ${resolvedRepo}.`,
        };
      }
      return allowResult("claude", null);
    }

    if (explicitClaudeConfigDir && canonicalRequested !== "claude") {
      return {
        ok: false,
        status: "profile_mismatch",
        engine: canonicalRequested,
        deny: [...policy.deny],
        error: `Engine '${requestedRaw}' contradicts explicit claudeConfigDir '${rawExplicitClaudeDir}'.`,
      };
    }

    if (canonicalRequested === "claude" && explicitClaudeConfigDir) {
      const dirAccount = resolveConfiguredAccount(
        { provider: "claude", claudeConfigDir: explicitClaudeConfigDir },
        accountLookupOpts,
      );
      const target = dirAccount || {
        provider: "claude",
        engine: "claude",
        claudeConfigDir: explicitClaudeConfigDir,
        configDir: explicitClaudeConfigDir,
      };
      if (!isHarnessAllowed(resolvedRepo, target, evalOptions)) {
        return {
          ok: false,
          status: "policy_denied",
          engine: "claude",
          ...(dirAccount?.id && { accountId: dirAccount.id }),
          deny: [...policy.deny],
          error: `Engine 'claude' (claudeConfigDir '${rawExplicitClaudeDir}') is denied by repository policy for ${resolvedRepo}.`,
        };
      }
      return allowResult("claude", dirAccount, null, explicitClaudeConfigDir);
    }

    const matchingAccounts = configuredAccounts.filter(
      (acct) => canonicalEngineName(acct.provider || acct.engine) === canonicalRequested,
    );
    if (matchingAccounts.length > 0) {
      const defaultAccount = pickDefaultAccountForEngine(
        canonicalRequested,
        matchingAccounts,
        homeDir,
      );
      if (defaultAccount && isHarnessAllowed(resolvedRepo, defaultAccount, evalOptions)) {
        return allowResult(canonicalRequested, defaultAccount);
      }
      if (isAutoAccount) {
        const allowed = matchingAccounts.find((acct) =>
          isHarnessAllowed(resolvedRepo, acct, evalOptions),
        );
        if (allowed) {
          return allowResult(canonicalRequested, allowed);
        }
      }
      return {
        ok: false,
        status: "policy_denied",
        engine: canonicalRequested,
        ...(defaultAccount?.id && { accountId: defaultAccount.id }),
        deny: [...policy.deny],
        error: `Engine '${canonicalRequested}' is denied by repository policy for ${resolvedRepo}.`,
      };
    }

    if (
      !isHarnessAllowed(
        resolvedRepo,
        { provider: canonicalRequested, engine: canonicalRequested },
        evalOptions,
      )
    ) {
      return {
        ok: false,
        status: "policy_denied",
        engine: canonicalRequested,
        deny: [...policy.deny],
        error: `Engine '${canonicalRequested}' is denied by repository policy for ${resolvedRepo}.`,
      };
    }
    return allowResult(canonicalRequested, null);
  }

  // 3. Auto-selection across candidates & all N configured accounts
  const candidates =
    Array.isArray(options.candidates) && options.candidates.length > 0
      ? options.candidates
      : CANONICAL_HARNESSES;
  const defaultPrimary = canonicalEngineName(candidates[0]) || "codex";

  for (const rawCandidate of candidates) {
    const candidateStr = String(rawCandidate || "").trim();
    if (!candidateStr) continue;
    const canonicalCandidate = canonicalEngineName(candidateStr);
    const isGenericHarness =
      CANONICAL_HARNESSES.includes(canonicalCandidate) ||
      canonicalCandidate === "claude-work" ||
      canonicalCandidate === "claude-personal";
    const fallbackFrom = canonicalCandidate === defaultPrimary ? null : defaultPrimary;

    if (!isGenericHarness) {
      const acctCandidate = resolveConfiguredAccount(candidateStr, accountLookupOpts);
      if (!acctCandidate) continue;
      const acctEngine = canonicalEngineName(acctCandidate.provider || acctCandidate.engine);
      if (
        checkAccountClaudeDirContradiction(
          acctCandidate,
          acctEngine,
          explicitClaudeConfigDir,
          rawExplicitClaudeDir,
          homeDir,
          policy.deny,
        ) ||
        !isHarnessAllowed(resolvedRepo, acctCandidate, evalOptions)
      ) {
        continue;
      }
      return allowResult(acctEngine, acctCandidate, fallbackFrom, explicitClaudeConfigDir);
    }

    if (canonicalCandidate === "claude-work" || canonicalCandidate === "claude-personal") {
      const requiredTag = canonicalCandidate === "claude-work" ? "work" : "personal";
      const matching = configuredAccounts.filter(
        (acct) =>
          canonicalEngineName(acct.provider || acct.engine) === "claude" &&
          normalizeAccountTags(acct).includes(requiredTag),
      );
      if (explicitClaudeConfigDir) {
        const dirAccount = resolveConfiguredAccount(
          { provider: "claude", claudeConfigDir: explicitClaudeConfigDir },
          accountLookupOpts,
        );
        if (dirAccount && !normalizeAccountTags(dirAccount).includes(requiredTag)) continue;
        const target = dirAccount || {
          provider: "claude",
          engine: "claude",
          claudeConfigDir: explicitClaudeConfigDir,
          tags: [requiredTag],
        };
        if (!isHarnessAllowed(resolvedRepo, target, evalOptions)) continue;
        return allowResult("claude", dirAccount, fallbackFrom, explicitClaudeConfigDir);
      }
      if (matching.length > 0) {
        const allowed = matching.find((acct) => isHarnessAllowed(resolvedRepo, acct, evalOptions));
        if (!allowed) continue;
        return allowResult("claude", allowed, fallbackFrom);
      }
      if (!isHarnessAllowed(resolvedRepo, canonicalCandidate, evalOptions)) continue;
      return allowResult("claude", null, fallbackFrom);
    }

    if (canonicalCandidate === "claude" && explicitClaudeConfigDir) {
      const dirAccount = resolveConfiguredAccount(
        { provider: "claude", claudeConfigDir: explicitClaudeConfigDir },
        accountLookupOpts,
      );
      const target = dirAccount || {
        provider: "claude",
        engine: "claude",
        claudeConfigDir: explicitClaudeConfigDir,
        configDir: explicitClaudeConfigDir,
      };
      if (!isHarnessAllowed(resolvedRepo, target, evalOptions)) continue;
      return allowResult("claude", dirAccount, fallbackFrom, explicitClaudeConfigDir);
    }

    const matchingAccounts = configuredAccounts.filter(
      (acct) => canonicalEngineName(acct.provider || acct.engine) === canonicalCandidate,
    );
    if (matchingAccounts.length > 0) {
      const allowed = matchingAccounts.find((acct) =>
        isHarnessAllowed(resolvedRepo, acct, evalOptions),
      );
      if (!allowed) continue;
      return allowResult(canonicalCandidate, allowed, fallbackFrom);
    }

    if (
      isHarnessAllowed(
        resolvedRepo,
        { provider: canonicalCandidate, engine: canonicalCandidate },
        evalOptions,
      )
    ) {
      return allowResult(canonicalCandidate, null, fallbackFrom);
    }
  }

  return {
    ok: false,
    status: "policy_denied",
    engine: defaultPrimary,
    deny: [...policy.deny],
    error: `All candidate engines are denied by repository policy for ${resolvedRepo}.`,
  };
}

/** The coordinator task identity, from `init` output or the task record it wrote. */
function readTaskId(initStdout, taskDir) {
  for (const read of [
    () => JSON.parse(String(initStdout || "").trim()),
    () => JSON.parse(fs.readFileSync(path.join(taskDir, "task.json"), "utf8")),
  ]) {
    try {
      const taskId = read()?.task_id;
      if (typeof taskId === "string" && taskId) return taskId;
    } catch {
      // Try the next source; a side member without a task identity is registered without dispatch.
    }
  }
  return null;
}

/**
 * Execute the `ork side` command programmatically or from the CLI.
 */
export async function sideCommand(argv = [], context = {}) {
  const { options, rawIdea } = parseSideArgs(argv);
  const stdout = context.stdout || process.stdout;

  if (options.help) {
    if (!options.json && stdout?.write) {
      stdout.write(SIDE_HELP);
    }
    return {
      schema: "ork.side.v1",
      status: "help",
      help: SIDE_HELP,
    };
  }

  if (!rawIdea) {
    throw new Error(
      'Missing side-mission idea. Usage: ork side [--later|--issue|--investigate] "<idea>"',
    );
  }

  const env = context.env || process.env;
  const cwd = path.resolve(options.cwd || context.cwd || process.cwd());
  const runCmd = context.runCommand || defaultRunCommand;
  const mailboxDir = context.mailboxDir ? path.resolve(context.mailboxDir) : resolveMailboxDir(env);
  const cacheDir = context.cacheDir ? path.resolve(context.cacheDir) : resolveAgentCacheDir(env);

  const classified = classifySideMode(rawIdea, options);
  const swarmCommand = commandInvocation(options.harness, "swarm");
  const shortId =
    context.shortId || `${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
  const sideId = `side-${shortId}`;
  const isolatedCoordSession = `side-coord-${shortId}`;

  const roomRecord = findTargetRoom(mailboxDir, {
    roomId: options.room,
    session: options.session,
    cwd,
  });

  if (options.dryRun) {
    const plannedRoomId = roomRecord?.data?.id || roomRecord?.data?.roomId || options.room || null;
    const payload = {
      schema: "ork.side.v1",
      sideId,
      mode: classified.mode,
      status: "dry_run",
      title: classified.title,
      idea: classified.idea,
      cwd,
      roomId: plannedRoomId,
      isolatedInbox: true,
      parentInboxTouched: false,
      summary: `[dry-run] Would ${classified.mode} side mission (${sideId}): ${classified.title}`,
    };
    if (!options.json && stdout?.write) {
      stdout.write(`${payload.summary}\n`);
    }
    return payload;
  }

  // MODE 1: PARK (0 tokens, 0 background processes — adds item to shared workboard)
  if (classified.mode === "park") {
    const workTitle = `[side-mission] ${classified.title}`;
    const args = [
      PEER_MAILBOX_PY,
      "work",
      "create",
      "--key",
      sideId,
      "--title",
      workTitle,
      "--scope",
      classified.idea,
      "--acceptance",
      "Resolve the parked request and record the outcome on this card.",
      "--format",
      "json",
    ];
    const res = runCmd("python3", args, {
      cwd,
      env: buildIsolatedEnv(env, isolatedCoordSession, mailboxDir),
    });
    if (res.status !== 0) {
      throw new Error(`Failed to park side mission on workboard: ${res.stderr || res.stdout}`);
    }
    const { item: workItem } = JSON.parse(res.stdout);
    const workId = workItem.id;
    const summary = `Parked side mission ${workId} ("${classified.title}") on the workboard — visible in ${swarmCommand} and ork next.`;
    const payload = {
      schema: "ork.side.v1",
      sideId,
      mode: "park",
      status: "parked",
      title: classified.title,
      idea: classified.idea,
      workId,
      workItem,
      roomId: roomRecord?.data?.id || roomRecord?.data?.roomId || null,
      isolatedInbox: true,
      parentInboxTouched: false,
      summary,
    };
    if (!options.json && stdout?.write) {
      stdout.write(`${summary}\n`);
    }
    return payload;
  }

  // MODE 2: ISSUE (files a GitHub issue with label agent:raw)
  if (classified.mode === "issue") {
    const ghArgs = [
      "issue",
      "create",
      "--title",
      classified.title,
      "--body",
      classified.idea,
      "--label",
      "agent:raw",
    ];
    const res = runCmd("gh", ghArgs, { cwd, env });
    if (res.status !== 0) {
      throw new Error(`Failed to file GitHub issue for side mission: ${res.stderr || res.stdout}`);
    }
    const issueUrl = res.stdout.trim().split(/\r?\n/).pop() || "";
    const summary = `Filed side-mission issue (${issueUrl || classified.title}) with label agent:raw.`;
    const payload = {
      schema: "ork.side.v1",
      sideId,
      mode: "issue",
      status: "filed",
      title: classified.title,
      idea: classified.idea,
      issueUrl,
      isolatedInbox: true,
      parentInboxTouched: false,
      summary,
    };
    if (!options.json && stdout?.write) {
      stdout.write(`${summary}\n`);
    }
    return payload;
  }

  // MODE 3 & 4: INVESTIGATE (read-only background scout) or EXECUTE (isolated worktree + background worker)
  const repoRoot = resolveGitRoot(cwd, runCmd);
  const policyCheck = checkRepoPolicyForSide(repoRoot, options.engine, {
    ...options,
    account: options.account || context.account || null,
    claudeConfigDir: options.claudeConfigDir || context.claudeConfigDir || null,
    configDir: options.configDir || context.configDir,
    ...(context.monitorConfigPath && { monitorConfigPath: context.monitorConfigPath }),
    ...(context.monitorConfig && { monitorConfig: context.monitorConfig }),
    ...(context.accounts && { accounts: context.accounts }),
    env,
  });
  if (!policyCheck.ok) {
    const payload = {
      schema: "ork.side.v1",
      sideId,
      mode: classified.mode,
      status: policyCheck.status || "policy_denied",
      engine: policyCheck.engine,
      ...(policyCheck.accountId && { accountId: policyCheck.accountId }),
      deny: policyCheck.deny,
      error: policyCheck.error,
      isolatedInbox: true,
      parentInboxTouched: false,
      summary: policyCheck.error,
    };
    if (!options.json && stdout?.write) {
      stdout.write(`${payload.summary}\n`);
    }
    return payload;
  }

  const sideBaseDir = path.join(cacheDir, "side-missions");
  fs.mkdirSync(sideBaseDir, { recursive: true });
  const taskDir = path.join(sideBaseDir, sideId);

  let worktreePath = null;
  let branch = null;
  let targetWorkspace = repoRoot;
  let allowPaths = [];
  let kind = "investigation";

  if (classified.mode === "execute") {
    const wt = provisionSideWorktree(repoRoot, shortId, runCmd, env);
    worktreePath = wt.worktreePath;
    branch = wt.branch;
    targetWorkspace = worktreePath;
    allowPaths = options.allowPaths.length > 0 ? options.allowPaths : ["."];
    kind = "implementation";
  }

  const specPath = path.join(sideBaseDir, `${sideId}-spec.json`);
  const specPayload = {
    objective: `[Side Mission] ${classified.title}`,
    repository_root: targetWorkspace,
    current_state: `Side mission dispatched via ork side (${classified.mode} mode): ${classified.idea}`,
    pre_existing_changes: [],
    plan:
      classified.mode === "investigate"
        ? [
            `Investigate and answer: ${classified.idea}`,
            "Gather exact file/line references without modifying repository files.",
          ]
        : [
            `Implement side mission: ${classified.idea}`,
            "Verify changes with focused checks inside the isolated worktree.",
          ],
    allow_paths: allowPaths,
    track_paths: [],
    development_checks: [],
    acceptance_criteria:
      classified.mode === "investigate"
        ? [
            "Answer the question concisely with exact file and line citations.",
            "Do not modify any files in the repository.",
          ]
        : [
            "Implement the requested side mission cleanly within the isolated worktree.",
            "Run focused verification for any touched files.",
          ],
    scope_owner: classified.mode === "execute" ? "worker" : "conductor",
  };
  fs.writeFileSync(specPath, `${JSON.stringify(specPayload, null, 2)}\n`, "utf8");

  const isolatedEnv = applyLauncherAccountEnv(
    buildIsolatedEnv(env, isolatedCoordSession, mailboxDir),
    policyCheck.accountEnv,
  );
  // The worktree's allocated ports reach the launched harness through the same assembled env.
  if (worktreePath)
    Object.assign(isolatedEnv, worktreeLaunchEnv(isolatedEnv, { repoRoot, worktreePath }));
  const initRes = runCmd(
    "python3",
    [COORDINATOR_PY, "init", "--task-dir", taskDir, "--task-spec", specPath, "--host", "other"],
    { cwd: targetWorkspace, env: isolatedEnv },
  );
  if (initRes.status !== 0) {
    throw new Error(
      `Failed to initialize side-mission coordinator task: ${initRes.stderr || initRes.stdout}`,
    );
  }
  const taskId = readTaskId(initRes.stdout, taskDir);

  const defaultEngine = policyCheck.engine || options.engine || "codex";
  const defaultModelByEngine = {
    codex: "gpt-5.6-sol",
    claude: "sonnet",
    agy: "gemini-3.8-flash-high",
    opencode: "openrouter/z-ai/glm-5.3-flash",
  };
  const selectedModel = options.model || defaultModelByEngine[defaultEngine] || "gpt-5.6-sol";
  const selectedEffort = options.effort || (defaultEngine === "codex" ? "medium" : null);

  const dispatchArgs = [
    COORDINATOR_PY,
    "dispatch",
    "--task-dir",
    taskDir,
    "--kind",
    kind,
    "--background",
    "--request-id",
    `${sideId}-run-1`,
    "--engine",
    defaultEngine,
    "--model",
    selectedModel,
  ];
  if (selectedEffort) {
    dispatchArgs.push("--effort", selectedEffort);
  }
  if (Array.isArray(policyCheck.extraArgs) && policyCheck.extraArgs.length > 0) {
    const hasFlag = (flag) =>
      dispatchArgs.some((arg) => arg === flag || String(arg).startsWith(`${flag}=`));
    for (let i = 0; i < policyCheck.extraArgs.length; i += 1) {
      const token = policyCheck.extraArgs[i];
      if (token === "--claude-config-dir" || token === "--account") {
        const next = policyCheck.extraArgs[i + 1];
        if (!hasFlag(token) && typeof next === "string") {
          dispatchArgs.push(token, next);
        }
        if (i + 1 < policyCheck.extraArgs.length) i += 1;
        continue;
      }
      if (
        (String(token).startsWith("--claude-config-dir=") && hasFlag("--claude-config-dir")) ||
        (String(token).startsWith("--account=") && hasFlag("--account"))
      ) {
        continue;
      }
      dispatchArgs.push(token);
    }
  }

  const dispatchRes = runCmd("python3", dispatchArgs, {
    cwd: targetWorkspace,
    env: isolatedEnv,
  });
  if (dispatchRes.status !== 0) {
    throw new Error(
      `Failed to dispatch background side mission: ${dispatchRes.stderr || dispatchRes.stdout}`,
    );
  }

  let dispatchInfo = {};
  if (dispatchRes.stdout.trim()) {
    try {
      dispatchInfo = JSON.parse(dispatchRes.stdout.trim());
    } catch {
      dispatchInfo = {};
    }
  }

  const runId = dispatchInfo.run_id || null;
  const resolvedEngine = knownEngines().has(dispatchInfo.engine)
    ? dispatchInfo.engine
    : defaultEngine;
  const resolvedModel =
    typeof dispatchInfo.model === "string" && dispatchInfo.model
      ? dispatchInfo.model
      : selectedModel;

  const { roomId, memberId } = await registerSideMemberInRoom(roomRecord, {
    defaultMemberId: sideId,
    mode: classified.mode,
    sideId,
    engine: resolvedEngine,
    accountId: policyCheck.accountId || null,
    accountAlias: policyCheck.accountAlias || null,
    claudeConfigDir: policyCheck.claudeConfigDir || null,
    model: resolvedModel,
    effort: dispatchInfo.effort || selectedEffort,
    idea: classified.idea,
    title: classified.title,
    cwd: targetWorkspace,
    repoRoot,
    worktreePath,
    branch,
    taskDir,
    taskId,
    requestId: `${sideId}-run-1`,
    runId,
    kind,
  });

  const summary =
    classified.mode === "investigate"
      ? `Launched read-only side mission ${memberId} ("${classified.title}") in the background — visible in ${swarmCommand} and ork next.`
      : `Launched side mission ${memberId} ("${classified.title}") in isolated worktree ${
          worktreePath ? path.basename(worktreePath) : branch
        } — visible in ${swarmCommand} and ork next.`;

  const payload = {
    schema: "ork.side.v1",
    sideId,
    memberId,
    roomId,
    mode: classified.mode,
    status: "dispatched",
    kind,
    title: classified.title,
    idea: classified.idea,
    taskDir,
    runId,
    engine: resolvedEngine,
    accountId: policyCheck.accountId || null,
    accountAlias: policyCheck.accountAlias || null,
    tags: policyCheck.tags || [],
    claudeConfigDir: policyCheck.claudeConfigDir || null,
    codexHome: policyCheck.codexHome || null,
    agyHome: policyCheck.agyHome || null,
    model: resolvedModel,
    effort: options.effort || null,
    worktreePath,
    branch,
    isolatedCoordSession,
    isolatedInbox: true,
    parentInboxTouched: false,
    summary,
  };

  if (!options.json && stdout?.write) {
    stdout.write(`${summary}\n`);
  }
  return payload;
}

export async function runSideCli(argv, context = {}) {
  const result = await sideCommand(argv, context);
  if (argv.includes("--json")) {
    (context.stdout ?? process.stdout).write(`${JSON.stringify(result, null, 2)}\n`);
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const cliArgs = process.argv.slice(2);
  const wantsJson = cliArgs.includes("--json");
  try {
    await runSideCli(cliArgs);
  } catch (error) {
    if (wantsJson) {
      process.stdout.write(
        `${JSON.stringify({ schema: "ork.side.v1", status: "error", error: error.message })}\n`,
      );
    } else {
      process.stderr.write(`Error: ${error.message}\n`);
    }
    process.exitCode = 1;
  }
}
