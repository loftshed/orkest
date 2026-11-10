import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { listRawRooms, readRawRoom, updateRawRoom } from "./horde-room.mjs";
import { bootstrapWorktreeInclude } from "./worktree-env.mjs";
import { provisionWorktree } from "./worktree-provision.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLUGIN_ROOT = path.resolve(__dirname, "..");
const SCRIPTS_DIR = path.join(PLUGIN_ROOT, "skills", "orchestrate", "scripts");
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
  --engine <engine>     Engine override (codex, claude, agy, opencode)
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
    model: null,
    effort: null,
    allowPaths: ["."],
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
    } else {
      positional.push(token);
    }
  }

  return {
    options,
    rawIdea: positional.join(" ").trim(),
  };
}

function resolveMailboxDir(env = process.env) {
  const explicit = (env.ORCHESTRATE_MAILBOX_DIR || env.PEER_MAILBOX_DIR || "").trim();
  if (explicit) return path.resolve(explicit);
  return path.join(os.homedir(), ".PeerMailbox");
}

function resolveAgentCacheDir(env = process.env) {
  const xdg = (env.XDG_CACHE_HOME || "").trim();
  const base = xdg ? path.resolve(xdg) : path.join(os.homedir(), ".cache");
  return path.join(base, "agent-executor");
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
  if (res.status === 0 && res.stdout.trim()) {
    return res.stdout.trim();
  }
  return path.resolve(cwd);
}

/**
 * Locate the active Swarm Room for this session or working directory, if one exists.
 */
function findTargetRoom(mailboxDir, { roomId, session, cwd }) {
  if (roomId) {
    try {
      return { root: mailboxDir, data: readRawRoom(roomId, mailboxDir) };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const entries = listRawRooms(mailboxDir);

  const resolvedCwd = cwd ? path.resolve(cwd) : null;
  let cwdMatch = null;

  for (const entry of entries) {
    try {
      const data = entry;
      if (!data || typeof data !== "object") continue;
      if (roomId && (data.id === roomId || data.roomId === roomId)) {
        return { root: mailboxDir, data };
      }
      if (session) {
        const parentSession = data.parent?.session;
        const memberMatch =
          Array.isArray(data.agents) &&
          data.agents.some((agent) => agent && agent.session === session);
        if (parentSession === session || memberMatch) {
          return { root: mailboxDir, data };
        }
      }
      if (!cwdMatch && resolvedCwd) {
        const roomCwd = data.cwd || data.repoRoot || data.parent?.cwd;
        if (roomCwd && path.resolve(roomCwd) === resolvedCwd) {
          cwdMatch = { root: mailboxDir, data };
        }
      }
    } catch {
      // Ignore malformed room file
    }
  }

  return cwdMatch;
}

/**
 * Register a `side-<N>` member inside a Swarm Room atomically so
 * `/swarm` and `ork next` track its live progress and completion without touching
 * the parent session's mailbox inbox.
 */
async function registerSideMemberInRoom(roomRecord, sideSpec) {
  if (!roomRecord || !roomRecord.root || !roomRecord.data) {
    return { roomId: null, memberId: sideSpec.defaultMemberId };
  }
  const saved = await updateRawRoom(
    roomRecord.data.id,
    (room) => {
      const agents = Array.isArray(room.agents) ? room.agents : [];
      const existingSideNums = agents
        .map((agent) => {
          const match = String(agent?.id || "").match(/^side-(\d+)$/);
          return match ? Number(match[1]) : 0;
        })
        .filter((n) => Number.isFinite(n) && n > 0);
      const nextNum = existingSideNums.length > 0 ? Math.max(...existingSideNums) + 1 : 1;
      const memberId = `side-${nextNum}`;
      const nowIso = new Date().toISOString();

      const memberEntry = {
        id: memberId,
        role: "side",
        sideMode: sideSpec.mode,
        sideId: sideSpec.sideId,
        engine: sideSpec.engine || "auto",
        model: sideSpec.model || null,
        effort: sideSpec.effort || null,
        status: "running",
        mission: sideSpec.idea,
        title: sideSpec.title,
        isolatedInbox: true,
        keepWorktree: Boolean(sideSpec.worktreePath),
        createdAt: nowIso,
        updatedAt: nowIso,
      };

      if (sideSpec.worktreePath) {
        memberEntry.worktree = {
          path: sideSpec.worktreePath,
          branch: sideSpec.branch,
        };
      }

      if (sideSpec.taskDir) {
        memberEntry.dispatch = {
          taskDir: sideSpec.taskDir,
          runId: sideSpec.runId || null,
          kind: sideSpec.kind,
          status: "running",
          startedAt: nowIso,
        };
      }

      room.agents = [...agents, memberEntry];
      room.updatedAt = nowIso;

      return room;
    },
    { root: roomRecord.root },
  );
  const member = saved.agents.find((agent) => agent.sideId === sideSpec.sideId);
  return { roomId: saved.id, memberId: member.id };
}

function provisionSideWorktree(repoRoot, shortId, runCmd) {
  const worktreesRoot = path.join(repoRoot, ".worktrees");
  const worktreePath = path.join(worktreesRoot, `wt-side-${shortId}`);
  const branch = `ork/side-${shortId}`;

  try {
    provisionWorktree(repoRoot, { slug: `wt-side-${shortId}`, branch, exec: runCmd });
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

    bootstrapWorktreeInclude(repoRoot, worktreePath, { overwrite: false });
  }

  return { worktreePath, branch };
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

function resolveConfigDir(env = process.env, explicitConfigDir = null) {
  if (explicitConfigDir) return path.resolve(explicitConfigDir);
  const xdg = (env.XDG_CONFIG_HOME || "").trim();
  const base = xdg ? path.resolve(xdg) : path.join(os.homedir(), ".config");
  return path.join(base, "agent-executor");
}

function collectDenyEntries(policyObj) {
  if (!policyObj || typeof policyObj !== "object") return [];
  const raw =
    policyObj.deny ||
    policyObj.denied ||
    policyObj.denied_harnesses ||
    policyObj.denied_engines ||
    [];
  return Array.isArray(raw)
    ? raw
        .map((x) =>
          String(x || "")
            .trim()
            .toLowerCase(),
        )
        .filter(Boolean)
    : [];
}

/**
 * Check repository harness denylist policies from `<configHome>/config.json` (`repo_policies`)
 * and `<repoRoot>/.orkest/policy.json`.
 */
export function checkRepoPolicyForSide(repoRoot, engine = null, options = {}) {
  const resolvedRepo = path.resolve(repoRoot || process.cwd());
  const repoBase = path.basename(resolvedRepo);
  const env = options.env || process.env;
  const configDir = resolveConfigDir(env, options.configDir);
  const denySet = new Set();

  // 1. Check <configHome>/config.json repo_policies
  const configFile = path.join(configDir, "config.json");
  if (fs.existsSync(configFile)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(configFile, "utf8"));
      const policies = cfg?.repo_policies;
      if (Array.isArray(policies)) {
        for (const entry of policies) {
          if (!entry || typeof entry !== "object") continue;
          const target = entry.repo || entry.path || entry.pattern || "";
          if (
            target === "*" ||
            target === repoBase ||
            (target && path.resolve(target) === resolvedRepo) ||
            (target && resolvedRepo.endsWith(target))
          ) {
            for (const item of collectDenyEntries(entry)) denySet.add(item);
          }
        }
      } else if (policies && typeof policies === "object") {
        for (const [key, entry] of Object.entries(policies)) {
          if (
            key === "*" ||
            key === repoBase ||
            path.resolve(key) === resolvedRepo ||
            resolvedRepo.endsWith(key)
          ) {
            for (const item of collectDenyEntries(entry)) denySet.add(item);
          }
        }
      }
    } catch {
      // Ignore malformed config.json
    }
  }

  // 2. Check <repoRoot>/.orkest/policy.json
  const repoPolicyFile = path.join(resolvedRepo, ".orkest", "policy.json");
  if (fs.existsSync(repoPolicyFile)) {
    try {
      const repoPolicy = JSON.parse(fs.readFileSync(repoPolicyFile, "utf8"));
      for (const item of collectDenyEntries(repoPolicy)) denySet.add(item);
    } catch {
      // Ignore malformed .orkest/policy.json
    }
  }

  const hasExplicitEngine = Boolean(options.engine || engine);
  const requested = String(engine || options.engine || "codex").toLowerCase();
  const personalClaudeConfigDir = path.join(os.homedir(), ".claude-personal");

  const isClaudeAllDenied =
    denySet.has("claude-all") ||
    denySet.has("all") ||
    ((denySet.has("claude") || denySet.has("claude-work")) &&
      (denySet.has("plaude") || denySet.has("claude-personal")));
  const isWorkClaudeDenied = denySet.has("claude-work") || denySet.has("claude");

  const isDenied = (eng) => {
    if (denySet.has("all")) return true;
    if (eng === "claude") return isClaudeAllDenied;
    if (eng === "plaude")
      return isClaudeAllDenied || denySet.has("plaude") || denySet.has("claude-personal");
    if (eng === "agy" || eng === "gemini") return denySet.has("agy") || denySet.has("gemini");
    return denySet.has(eng);
  };

  if (hasExplicitEngine) {
    if (isDenied(requested)) {
      return {
        ok: false,
        status: "policy_denied",
        engine: requested,
        deny: [...denySet],
        error: `Engine '${requested}' is denied by repository policy for ${resolvedRepo}.`,
      };
    }
    if ((requested === "claude" && isWorkClaudeDenied) || requested === "plaude") {
      return {
        ok: true,
        status: "allowed",
        engine: "claude",
        profile: "plaude",
        claudeConfigDir: personalClaudeConfigDir,
        extraArgs: ["--claude-config-dir", personalClaudeConfigDir],
        deny: [...denySet],
      };
    }
    return {
      ok: true,
      status: "allowed",
      engine: requested === "gemini" ? "agy" : requested,
      profile: null,
      claudeConfigDir: null,
      extraArgs: [],
      deny: [...denySet],
    };
  }

  // No explicit --engine passed; default is "codex", falling back to ["agy", "plaude", "claude", "opencode"]
  const candidates = ["codex", "agy", "plaude", "claude", "opencode"];
  for (const candidate of candidates) {
    if (isDenied(candidate)) continue;
    if (candidate === "plaude" || (candidate === "claude" && isWorkClaudeDenied)) {
      return {
        ok: true,
        status: "allowed",
        engine: "claude",
        profile: "plaude",
        fallbackFrom: candidate === "codex" ? null : "codex",
        claudeConfigDir: personalClaudeConfigDir,
        extraArgs: ["--claude-config-dir", personalClaudeConfigDir],
        deny: [...denySet],
      };
    }
    return {
      ok: true,
      status: "allowed",
      engine: candidate,
      profile: null,
      fallbackFrom: candidate === "codex" ? null : "codex",
      claudeConfigDir: null,
      extraArgs: [],
      deny: [...denySet],
    };
  }

  return {
    ok: false,
    status: "policy_denied",
    engine: requested,
    deny: [...denySet],
    error: `All candidate engines are denied by repository policy for ${resolvedRepo}.`,
  };
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
      "--note",
      classified.idea,
      "--format",
      "json",
    ];
    const res = runCmd("python3", args, {
      cwd,
      env: buildIsolatedEnv(env, isolatedCoordSession, mailboxDir),
    });
    let workItem = null;
    if (res.status === 0 && res.stdout.trim()) {
      try {
        workItem = JSON.parse(res.stdout.trim());
      } catch {
        workItem = { raw: res.stdout.trim() };
      }
    } else if (res.status !== 0) {
      throw new Error(`Failed to park side mission on workboard: ${res.stderr || res.stdout}`);
    }
    const workId = workItem?.id || workItem?.work_id || sideId;
    const summary = `Parked side mission ${workId} ("${classified.title}") on the workboard — visible in /swarm and ork next.`;
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
    configDir: context.configDir,
    env,
  });
  if (!policyCheck.ok) {
    const payload = {
      schema: "ork.side.v1",
      sideId,
      mode: classified.mode,
      status: "policy_denied",
      engine: policyCheck.engine,
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
    const wt = provisionSideWorktree(repoRoot, shortId, runCmd);
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

  const isolatedEnv = buildIsolatedEnv(env, isolatedCoordSession, mailboxDir);
  if (policyCheck.claudeConfigDir) {
    isolatedEnv.CLAUDE_CONFIG_DIR = policyCheck.claudeConfigDir;
  }
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
    dispatchArgs.push(...policyCheck.extraArgs);
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
  const resolvedEngine = dispatchInfo.engine || options.engine || "auto";
  const resolvedModel = dispatchInfo.model || options.model || null;

  const { roomId, memberId } = await registerSideMemberInRoom(roomRecord, {
    defaultMemberId: sideId,
    mode: classified.mode,
    sideId,
    engine: resolvedEngine,
    profile: policyCheck.profile || null,
    claudeConfigDir: policyCheck.claudeConfigDir || null,
    model: resolvedModel,
    effort: options.effort,
    idea: classified.idea,
    title: classified.title,
    worktreePath,
    branch,
    taskDir,
    runId,
    kind,
  });

  const summary =
    classified.mode === "investigate"
      ? `Launched read-only side mission ${memberId} ("${classified.title}") in the background — visible in /swarm and ork next.`
      : `Launched side mission ${memberId} ("${classified.title}") in isolated worktree ${
          worktreePath ? path.basename(worktreePath) : branch
        } — visible in /swarm and ork next.`;

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
    profile: policyCheck.profile || null,
    claudeConfigDir: policyCheck.claudeConfigDir || null,
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

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const cliArgs = process.argv.slice(2);
  const wantsJson = cliArgs.includes("--json");
  try {
    const result = await sideCommand(cliArgs);
    if (wantsJson) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    }
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
