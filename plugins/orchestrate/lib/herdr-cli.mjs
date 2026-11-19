import { execFile } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";

import { canonicalHerdrEndpoint, herdrEndpoint, isHerdrId } from "./herdr-context.mjs";

/**
 * Structured Herdr CLI operations (Herdr 0.9.5 syntax, checked against `--help` and a disposable
 * isolated server). Every call is argv-only, time-bounded and never goes through a shell.
 *
 * Verified syntax notes:
 * - `--` is not an option terminator in this CLI (it is rejected as an unknown option), so free
 *   text is only ever passed as a positional that cannot be mistaken for an option, or as the
 *   value following an option that takes one (`--body <TEXT>` accepts dash-leading values).
 * - Identifiers are validated against the host syntax and never start with a dash.
 */

const DEFAULT_TIMEOUT_MS = 2500;
const MAX_BUFFER = 512 * 1024;
const NOTIFICATION_SOUNDS = new Set(["none", "done", "request"]);
const MAX_TITLE = 120;
const MAX_BODY = 400;

export class HerdrCliError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = "HerdrCliError";
    this.code = code;
  }
}

function binaryPath(env) {
  return env?.HERDR_BIN_PATH || "herdr";
}

/** Run one Herdr command and resolve its stdout. Rejects with a coded HerdrCliError. */
export function runHerdr(args, { env = process.env, exec = execFile, cwd, timeoutMs } = {}) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
    return Promise.reject(new HerdrCliError("invalid_argument", "Herdr arguments must be strings"));
  }
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let isSettled = false;
    let guard;
    const settle = (error, stdout) => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(guard);
      if (!error) {
        resolve(String(stdout ?? ""));
      } else if (error.code === "ENOENT") {
        reject(new HerdrCliError("missing_binary", "The Herdr CLI is not available", error));
      } else if (error.killed || error.signal === "SIGTERM" || error.code === "ETIMEDOUT") {
        reject(new HerdrCliError("timeout", "Herdr did not answer in time", error));
      } else {
        reject(new HerdrCliError("failed", `Herdr rejected the request: ${error.message}`, error));
      }
    };
    // A wedged host must not hang a UI flow even when the executor ignores its own timeout.
    guard = setTimeout(() => settle({ killed: true, message: "timeout" }), timeout + 500);
    guard.unref?.();
    try {
      const binary = binaryPath(env);
      const callback = (error, stdout) => settle(error, stdout);
      // Injected executors written as (command, args, callback) cannot take options.
      const result =
        exec === execFile || exec.length !== 3
          ? exec(
              binary,
              args,
              { env, ...(cwd && { cwd }), timeout, maxBuffer: MAX_BUFFER, windowsHide: true },
              callback,
            )
          : exec(binary, args, callback);
      if (result && typeof result.then === "function") {
        void (async () => {
          try {
            const value = await result;
            if (typeof value === "string") settle(null, value);
            else if (typeof value?.stdout === "string") settle(null, value.stdout);
          } catch (error) {
            settle(error || new Error("failed"));
          }
        })();
      }
    } catch (error) {
      settle(error);
    }
  });
}

/** Parse Herdr's JSON envelope and return its `result` object. */
function parseResult(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new HerdrCliError("invalid_result", "Herdr returned malformed JSON", error);
  }
  if (parsed?.error) {
    throw new HerdrCliError(
      "failed",
      `Herdr rejected the request: ${String(parsed.error.message || parsed.error.code || "error")}`,
    );
  }
  const result = parsed?.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new HerdrCliError("invalid_result", "Herdr returned no result object");
  }
  return result;
}

function requireId(value, label) {
  if (!isHerdrId(value)) throw new HerdrCliError("invalid_argument", `Invalid Herdr ${label}`);
  return value;
}

function targetEndpoint(target) {
  const value = target?.herdrEndpoint || target?.progress?.herdrEndpoint;
  return typeof value === "string" ? value : "";
}

/** The target must belong to this process's Herdr server; there is no focused-pane fallback. */
function requireLocalEndpoint(target, env) {
  if (env?.HERDR_ENV !== "1") throw new HerdrCliError("not_herdr", "Not running inside Herdr");
  const recorded = canonicalHerdrEndpoint(targetEndpoint(target));
  let local;
  try {
    local = herdrEndpoint(env);
  } catch (error) {
    throw new HerdrCliError("endpoint_mismatch", "Cannot resolve the Herdr endpoint", error);
  }
  if (!recorded || recorded !== local) {
    throw new HerdrCliError("endpoint_mismatch", "The target belongs to another Herdr server");
  }
}

/** Validate a WorkspaceInfo record (upstream `src/api/schema/workspaces.rs`). */
function validWorkspace(workspace, expectedId) {
  if (!workspace || typeof workspace !== "object" || !isHerdrId(workspace.workspace_id)) {
    throw new HerdrCliError("invalid_result", "Herdr returned a malformed workspace");
  }
  if (expectedId !== undefined && workspace.workspace_id !== expectedId) {
    throw new HerdrCliError("invalid_result", "Herdr returned a different workspace");
  }
  const checkout = workspace.worktree;
  if (
    checkout !== undefined &&
    (!checkout ||
      typeof checkout !== "object" ||
      typeof checkout.repo_root !== "string" ||
      typeof checkout.checkout_path !== "string" ||
      typeof checkout.is_linked_worktree !== "boolean")
  ) {
    throw new HerdrCliError("invalid_result", "Herdr returned a malformed workspace worktree");
  }
  return workspace;
}

/** Workspace lookup: `herdr workspace get <id>` answers `type: "workspace_info"`. */
export async function lookupWorkspace(workspaceId, options = {}) {
  requireId(workspaceId, "workspace ID");
  const result = parseResult(await runHerdr(["workspace", "get", workspaceId], options));
  if (result.type !== "workspace_info") {
    throw new HerdrCliError("invalid_result", "Herdr returned an unexpected workspace result");
  }
  return validWorkspace(result.workspace, workspaceId);
}

/**
 * Agent inspection: `herdr agent get <target>` answers `type: "agent_info"` whose agent always
 * carries terminal_id, workspace_id, tab_id and pane_id. `lenient` (pane verification only)
 * accepts records without those keys but still checks any that are present.
 */
export async function inspectAgent(target, { lenient = false, ...options } = {}) {
  requireId(target, "agent target");
  const result = parseResult(await runHerdr(["agent", "get", target], options));
  const agent = result.agent;
  if (result.type !== "agent_info" || !agent || typeof agent !== "object") {
    throw new HerdrCliError("invalid_result", "Herdr returned an unexpected agent result");
  }
  for (const key of ["workspace_id", "tab_id", "pane_id"]) {
    const value = agent[key];
    if (value === undefined ? !lenient : !isHerdrId(value)) {
      throw new HerdrCliError("invalid_result", `Herdr returned a malformed agent ${key}`);
    }
  }
  const terminal = agent.terminal_id;
  if (terminal === undefined ? !lenient : typeof terminal !== "string" || !terminal) {
    throw new HerdrCliError("invalid_result", "Herdr returned a malformed agent terminal_id");
  }
  return agent;
}

/**
 * Resolve the current pane of an agent session. Commands need the current pane ID, while Herdr's
 * agent API also accepts a pre-move alias. Resolves null when the pane no longer holds `session`.
 */
export async function resolveAgentPane(pane, session, options = {}) {
  if (!isHerdrId(pane) || typeof session !== "string" || !session) return null;
  let target = pane;
  async function agentFor(id) {
    try {
      const agent = await inspectAgent(id, { ...options, lenient: true });
      return agent.pane_id === undefined || agent.pane_id === id ? agent : null;
    } catch {
      return null;
    }
  }
  let agent = await agentFor(target);
  if (!agent) {
    let canonical;
    try {
      const current = parseResult(await runHerdr(["pane", "current", "--pane", target], options));
      canonical = current.pane?.pane_id;
    } catch {
      return null;
    }
    if (!isHerdrId(canonical) || canonical === pane) return null;
    target = canonical;
    agent = await agentFor(target);
  }
  const ref = agent?.agent_session;
  return ref?.kind === "id" && ref.value === session ? target : null;
}

function realDirectory(candidate) {
  try {
    const real = realpathSync(candidate);
    return statSync(real).isDirectory() ? real : "";
  } catch {
    return "";
  }
}

/**
 * Canonical path of an existing worktree owned by `target`, or throws. The path comes only from
 * the trusted target record and must sit inside `root` (default: the worktree's own parent).
 */
export function trustedWorktreePath(target, root) {
  const worktree = target?.worktree;
  const claimed = worktree?.path;
  if (typeof claimed !== "string" || !path.isAbsolute(claimed)) {
    throw new HerdrCliError("invalid_argument", "The target has no worktree path");
  }
  const parent = root || worktree.parentCwd;
  const realRoot =
    typeof parent === "string" && path.isAbsolute(parent) ? realDirectory(parent) : "";
  const realWorktree = realDirectory(claimed);
  if (!realRoot || !realWorktree) {
    throw new HerdrCliError("invalid_argument", "The worktree or its root is missing");
  }
  if (!realWorktree.startsWith(realRoot + path.sep)) {
    throw new HerdrCliError("invalid_argument", "The worktree is outside its root");
  }
  try {
    statSync(path.join(realWorktree, ".git"));
  } catch {
    throw new HerdrCliError("invalid_argument", "The path is not a Git worktree checkout");
  }
  return { root: realRoot, worktree: realWorktree };
}

function sameDirectory(left, right) {
  const a = typeof left === "string" && path.isAbsolute(left) ? realDirectory(left) : "";
  return Boolean(a) && a === realDirectory(right);
}

/**
 * Open (or focus) the pane of an existing worktree: `herdr worktree open`. Herdr rejects
 * `--workspace` together with `--cwd` (upstream `src/cli/worktree.rs`), so exactly one source is
 * sent: the hinted workspace when Herdr confirms it is the non-linked parent workspace of the
 * trusted root, otherwise the trusted root as `--cwd`. It never runs `worktree create` or passes
 * `--trust-repository`, so Git history is untouched.
 */
export async function openWorktreePane(target, { root, workspaceId, ...options } = {}) {
  const env = options.env || process.env;
  requireLocalEndpoint(target, env);
  const paths = trustedWorktreePath(target, root);
  if (workspaceId !== undefined) requireId(workspaceId, "workspace ID");
  let source = ["--cwd", paths.root];
  if (workspaceId !== undefined) {
    try {
      const checkout = (await lookupWorkspace(workspaceId, options)).worktree;
      if (
        checkout &&
        !checkout.is_linked_worktree &&
        sameDirectory(checkout.repo_root, paths.root)
      ) {
        source = ["--workspace", workspaceId];
      }
    } catch {
      // An unverifiable hint is dropped in favour of the explicit root.
    }
  }
  const args = ["worktree", "open", ...source, "--path", paths.worktree, "--focus"];
  const result = parseResult(await runHerdr(args, { ...options, cwd: paths.root }));
  const { workspace, tab, root_pane: pane, worktree, already_open: alreadyOpen } = result;
  const isValid =
    result.type === "worktree_opened" &&
    isHerdrId(workspace?.workspace_id) &&
    isHerdrId(tab?.tab_id) &&
    isHerdrId(pane?.pane_id) &&
    typeof worktree?.path === "string" &&
    typeof alreadyOpen === "boolean";
  if (!isValid) {
    throw new HerdrCliError("invalid_result", "Herdr returned an unexpected worktree result");
  }
  if (!sameDirectory(worktree.path, paths.worktree)) {
    throw new HerdrCliError("invalid_result", "Herdr opened a different worktree");
  }
  return {
    workspaceId: workspace.workspace_id,
    tabId: tab.tab_id,
    paneId: pane.pane_id,
    alreadyOpen,
  };
}

function cleanText(value, limit) {
  return String(value ?? "")
    .replaceAll(/\p{Cc}+/gu, " ")
    .trim()
    .slice(0, limit);
}

/**
 * One native notification (`herdr notification show <TITLE> --body <TEXT> --sound <SOUND>`).
 * Resolves false when Herdr is unavailable or rejects the call, so callers can fall back.
 */
export async function showNotification({ title, body, sound } = {}, options = {}) {
  let text = cleanText(title, MAX_TITLE);
  if (!text || (sound !== undefined && !NOTIFICATION_SOUNDS.has(sound))) return false;
  // The positional title would parse as an option if it led with a dash.
  if (text.startsWith("-")) text = `Orkest: ${text}`;
  const args = ["notification", "show", text];
  const message = cleanText(body, MAX_BODY);
  if (message) args.push("--body", message);
  if (sound !== undefined) args.push("--sound", sound);
  try {
    const stdout = await runHerdr(args, options);
    if (stdout.trim()) {
      try {
        if (JSON.parse(stdout)?.error) return false;
      } catch {
        // Plain-text acknowledgements are acceptable.
      }
    }
    return true;
  } catch {
    return false;
  }
}
