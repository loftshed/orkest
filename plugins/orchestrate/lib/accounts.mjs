// Universal accounts: `ork account add|list|tag|remove|sync`.
//
// Monitor's `accounts[]` is the single source of truth. Every mutation runs under the same
// flock domain as Monitor's repository-policy writer: `<canonical-config-target>.lock`.
// Federating the profiles into the harness configs is delegated to `install_mailbox.py`
// (`--account-sync` / `--shell-sync`) AFTER the config lock is released.
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { detectConfig } from "../../monitor/lib/init.mjs";
import { resolvePolicyConfigPath } from "../../monitor/lib/policy.mjs";

export const ACCOUNT_SCHEMA = "ork.account.v1";
export const ACCOUNT_USAGE = [
  "Usage:",
  "  ork account add <claude|codex|agy|opencode> --profile <slug> [--id <id>] [--alias <cmd>]",
  "                  [--tag <tag> ...] [--label <text>] [--short <2ch>] [--config-dir <path>]",
  "                  [--no-sync] [--json]",
  "  ork account list [--json]",
  "  ork account tag <id-or-alias> <add|remove|set> <tag...>",
  "  ork account remove <id-or-alias> [--purge-profile] [--json]",
  "  ork account sync [--dry-run] [--json]",
].join("\n");

const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;
const ALIAS_RE = /^[a-z][a-z0-9_-]*$/;
const MARKER_VERSION = "# orkest-managed-alias: v1";
const PROFILE_MARKER = ".orkest-account.json";
const SCRIPT = fileURLToPath(
  new URL("../skills/orchestrate/scripts/install_mailbox.py", import.meta.url),
);

const PROVIDERS = {
  claude: { stored: "claude", bin: "claude", short: "CL", dir: (s) => `.claude-${s}` },
  codex: { stored: "codex", bin: "codex", short: "CX", dir: (s) => `.codex-${s}` },
  agy: { stored: "antigravity", bin: "agy", short: "AG", dir: (s) => `.antigravity-${s}` },
  opencode: { stored: "opencode", bin: "opencode", short: "OC", dir: (s) => `.opencode-${s}` },
};
const STORED_TO_CLI = {
  claude: "claude",
  codex: "codex",
  antigravity: "agy",
  opencode: "opencode",
};
const HARNESS_NAMES = new Set([
  "claude",
  "codex",
  "agy",
  "antigravity",
  "gemini",
  "opencode",
  "ork",
]);
const STRIPPED_ENV = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY"];
// cspell:disable -- shell builtin and hook names
const RESERVED = new Set(
  // POSIX utilities and shell builtins, bash/zsh builtins and reserved words, installer hooks.
  (
    "if then else elif fi case esac for select while until do done in function time coproc foreach repeat " +
    "nocorrect noglob exec eval export unset set local declare typeset readonly return exit break continue " +
    "shift source alias unalias command builtin type which whence cd pwd echo printf read test true false " +
    "trap wait kill jobs fg bg umask ulimit env sh bash zsh dash fish sudo git python python3 node npm ls cat " +
    "rm mv cp mkdir chmod chown grep rg sed awk find xargs ocodex oclaude oagy oopencode precmd preexec chpwd " +
    "periodic zshexit zshaddhistory zsh_directory_name command_not_found_handle command_not_found_handler " +
    "let bindkey compgen complete dirs disown enable fc getopts hash help history logout popd pushd suspend " +
    "times unlimit vared whence zle zstyle zmodload autoload emulate rehash sched setopt unsetopt ulimit " +
    "chgrp ln ps tar make man more less vi vim nano ssh scp curl wget ping tee touch sort head tail"
  ).split(/\s+/),
);
// cspell:enable

class AccountError extends Error {
  constructor(message, code = "invalid") {
    super(message);
    this.code = code;
  }
}

/* ------------------------------------------------------------------ context */

function resolveContext(context = {}) {
  const env = context.env || process.env;
  const rawHome = context.home || env.HOME || os.homedir();
  let home = rawHome;
  try {
    home = fs.realpathSync(rawHome);
  } catch {
    // keep the lexical home
  }
  const platform = context.platform || process.platform;
  const monitorConfig = env.MONITOR_CONFIG || path.join(home, ".config", "monitor", "config.json");
  const configPath = resolvePolicyConfigPath({ configPath: monitorConfig, homeDir: home, env });
  return {
    ...context,
    env,
    home,
    platform,
    configPath,
    canonicalConfig: canonicalizeLinkTarget(configPath),
    localBin: path.join(home, ".local", "bin"),
  };
}

/** Follow a (possibly dangling) config-file symlink chain to the real write target. */
function canonicalizeLinkTarget(file) {
  let current = path.resolve(file);
  for (let hop = 0; hop < 40; hop += 1) {
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
        try {
          return path.join(fs.realpathSync(path.dirname(current)), path.basename(current));
        } catch {
          return current;
        }
      }
      throw error;
    }
    if (!stat.isSymbolicLink()) {
      return path.join(fs.realpathSync(path.dirname(current)), path.basename(current));
    }
    current = path.resolve(path.dirname(current), fs.readlinkSync(current));
  }
  throw new AccountError(`too many symbolic links resolving ${file}`);
}

/* --------------------------------------------------------------- validation */

function hasControl(text) {
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function requireSlug(value, what) {
  if (typeof value !== "string" || !SLUG_RE.test(value) || value === "." || value === "..") {
    throw new AccountError(`${what} must match ^[a-z0-9][a-z0-9_-]*$`);
  }
  return value;
}

const WIDE_RE =
  /[\u{1100}-\u{115F}\u{2E80}-\u{A4CF}\u{AC00}-\u{D7A3}\u{F900}-\u{FAFF}\u{FE30}-\u{FE6F}\u{FF00}-\u{FF60}\u{FFE0}-\u{FFE6}\u{1F300}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u;

function codePointWidthOne(cp) {
  if (cp < 32 || (cp >= 127 && cp < 160)) return false;
  const ch = String.fromCodePoint(cp);
  if (WIDE_RE.test(ch)) return false;
  return !/[\p{M}\p{Cf}\p{Cc}\p{Zl}\p{Zp}]/u.test(ch);
}

function requireShort(value) {
  const points = [...String(value)];
  if (points.length !== 2 || points.some((ch) => !codePointWidthOne(ch.codePointAt(0)))) {
    throw new AccountError("--short must be two printable single-cell characters");
  }
  return points.join("");
}

function cleanLabel(value) {
  const text = String(value).trim();
  if (!text || hasControl(text)) {
    throw new AccountError("--label must be non-empty text without control characters");
  }
  return text;
}

function normalizeTags(list, { validate }) {
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const tag = String(raw);
    if (validate) requireSlug(tag, `tag "${tag}"`);
    if (seen.has(tag)) {
      continue;
    }

    seen.add(tag);
    out.push(tag);
  }
  return out;
}

function shellQuote(value) {
  const text = String(value);
  if (hasControl(text)) throw new AccountError("control character in path");
  return `'${text.replaceAll("'", String.raw`'\''`)}'`;
}

/* ----------------------------------------------------------------- profiles */

function profileEnv(cli, home) {
  switch (cli) {
    case "claude": {
      return { configDir: home, env: {} };
    }
    case "codex": {
      return { env: { CODEX_HOME: home } };
    }
    case "agy": {
      return { env: { ANTIGRAVITY_APP_DATA_DIR: home, GEMINI_CLI_HOME: home } };
    }
    default: {
      return {
        env: {
          XDG_CONFIG_HOME: path.join(home, "config"),
          XDG_DATA_HOME: path.join(home, "data"),
          XDG_STATE_HOME: path.join(home, "state"),
          XDG_CACHE_HOME: path.join(home, "cache"),
        },
      };
    }
  }
}

function expandTilde(value, ctx) {
  if (value === "~") return ctx.home;
  if (value.startsWith("~/")) return path.join(ctx.home, value.slice(2));
  return value;
}

/** The profile root recorded on an account, or null for a legacy default/unrecorded account. */
function accountHome(account, ctx) {
  const env = account?.env && typeof account.env === "object" ? account.env : {};
  const raw =
    account?.configDir ||
    env.CODEX_HOME ||
    env.ANTIGRAVITY_APP_DATA_DIR ||
    env.GEMINI_CLI_HOME ||
    (env.XDG_CONFIG_HOME ? path.dirname(String(env.XDG_CONFIG_HOME)) : "");
  if (typeof raw !== "string" || !raw) return null;
  return path.resolve(expandTilde(raw, ctx));
}

function defaultHomeFor(account, ctx) {
  const cli = STORED_TO_CLI[account.provider];
  const names = {
    claude: ".claude",
    codex: ".codex",
    agy: ".gemini",
    opencode: ".config/opencode",
  };
  return cli ? path.join(ctx.home, names[cli]) : null;
}

function within(parent, child) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Validate and canonicalize a managed profile root; never follows a symlink under home. */
function resolveProfileHome(requested, ctx, { allowExisting = true } = {}) {
  if (hasControl(requested)) throw new AccountError("profile path has control characters");
  if (!(path.isAbsolute(requested) || requested.startsWith("~/"))) {
    throw new AccountError("--config-dir must be absolute or start with ~/");
  }
  let candidate = path.resolve(expandTilde(requested, ctx));
  let rawHome = ctx.env.HOME || os.homedir();
  rawHome = path.resolve(rawHome);
  if (rawHome !== ctx.home && within(rawHome, candidate)) {
    candidate = path.join(ctx.home, path.relative(rawHome, candidate));
  }
  if (!within(ctx.home, candidate) || candidate === ctx.home) {
    throw new AccountError("profile must be a directory under the user home, not the home itself");
  }
  // Walk every existing component below home: no symlinks, owned by the current user.
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  let walk = ctx.home;
  for (const part of path.relative(ctx.home, candidate).split(path.sep)) {
    walk = path.join(walk, part);
    let stat;
    try {
      stat = fs.lstatSync(walk);
    } catch (error) {
      if (error?.code === "ENOENT") break;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new AccountError(`profile path crosses a symlink: ${walk}`);
    if (!stat.isDirectory())
      throw new AccountError(`profile path component is not a directory: ${walk}`);
    if (uid !== null && stat.uid !== uid)
      throw new AccountError(`profile directory is not owned by you: ${walk}`);
  }
  if (!allowExisting && fs.existsSync(candidate)) throw new AccountError("profile already exists");
  return candidate;
}

function profileState(home) {
  let entries;
  try {
    entries = fs.readdirSync(home);
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, empty: true };
    throw error;
  }
  return { exists: true, empty: entries.length === 0 };
}

function readMarker(home) {
  try {
    const stat = fs.lstatSync(path.join(home, PROFILE_MARKER));
    if (!stat.isFile() || stat.nlink > 1) return null;
    return JSON.parse(fs.readFileSync(path.join(home, PROFILE_MARKER), "utf8"));
  } catch {
    return null;
  }
}

function ensureProfile(home, { provider, id, own }) {
  const isCreated = !fs.existsSync(home);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  if (isCreated) fs.chmodSync(home, 0o700);
  if (!own) return;
  const markerPath = path.join(home, PROFILE_MARKER);
  const body = `${JSON.stringify({ schema: "ork.account.profile.v1", provider, id, home }, null, 2)}\n`;
  const fd = fs.openSync(
    markerPath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
    0o600,
  );
  try {
    fs.writeFileSync(fd, body);
  } finally {
    fs.closeSync(fd);
  }
}

/* ------------------------------------------------------------ config + lock */

const LOCK_PY = [
  "import fcntl, os, sys",
  "fd = os.open(sys.argv[1], os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | getattr(os, 'O_CLOEXEC', 0), 0o600)",
  "st = os.fstat(fd)",
  "if st.st_uid != os.getuid() or (st.st_mode & 0o170000) != 0o100000:",
  String.raw`    sys.stderr.write('lock file is not an owned regular file\n'); sys.exit(3)`,
  "fcntl.flock(fd, fcntl.LOCK_EX)",
  String.raw`sys.stdout.write('LOCKED\n'); sys.stdout.flush()`,
  "sys.stdin.read()",
].join("\n");

/** Run `fn` while holding `<canonical>.lock` (same flock domain as Monitor's policy writer). */
async function withConfigLock(ctx, fn) {
  fs.mkdirSync(path.dirname(ctx.canonicalConfig), { recursive: true, mode: 0o700 });
  const child = spawn("python3", ["-c", LOCK_PY, `${ctx.canonicalConfig}.lock`], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const closed = new Promise((resolve) => child.once("close", resolve));
  await new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(
      () => reject(new AccountError("timed out waiting for the config lock")),
      60_000,
    );
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      if (!buffer.includes("LOCKED")) {
        return;
      }

      clearTimeout(timer);
      resolve();
    });
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      reject(new AccountError(`config lock failed (${code}): ${stderr.trim()}`));
    });
  });
  try {
    return await fn();
  } finally {
    child.stdin.end();
    await closed;
  }
}

function detectOnPath(ctx) {
  return (name) => pathDirs(ctx).some((dir) => isExecutable(path.join(dir, name)));
}

function readConfigFile(ctx, { bootstrap }) {
  let raw;
  try {
    raw = fs.readFileSync(ctx.canonicalConfig, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    // Bootstrap in memory only on ENOENT; the caller decides whether to persist it.
    void bootstrap;
    const config = detectConfig({ home: ctx.home, env: ctx.env, binaries: detectOnPath(ctx) });
    return { config, existed: false };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new AccountError(
      `monitor config is not valid JSON; refusing to modify it: ${error.message}`,
      "malformed",
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AccountError("monitor config must be a JSON object", "malformed");
  }
  if (parsed.accounts !== undefined && !Array.isArray(parsed.accounts)) {
    throw new AccountError("monitor config accounts must be an array", "malformed");
  }
  return { config: parsed, existed: true };
}

function atomicWrite(target, text, mode) {
  const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  const fd = fs.openSync(
    tmp,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
    mode,
  );
  try {
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, target);
  } catch (error) {
    try {
      fs.closeSync(fd);
    } catch {
      // already closed
    }
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

function writeConfig(ctx, config) {
  let mode = 0o600;
  try {
    mode = fs.statSync(ctx.canonicalConfig).mode & 0o777;
  } catch {
    // new file
  }
  atomicWrite(ctx.canonicalConfig, `${JSON.stringify(config, null, 2)}\n`, mode);
}

/* ------------------------------------------------------------------ journal */

function journalPath(ctx) {
  return `${ctx.canonicalConfig}.accounts-journal.json`;
}

function readJournal(ctx) {
  try {
    const parsed = JSON.parse(fs.readFileSync(journalPath(ctx), "utf8"));
    return {
      intents: Array.isArray(parsed.intents) ? parsed.intents : [],
      pendingSync: Array.isArray(parsed.pendingSync) ? parsed.pendingSync : [],
    };
  } catch {
    return { intents: [], pendingSync: [] };
  }
}

function writeJournal(ctx, journal) {
  if (journal.intents.length === 0 && journal.pendingSync.length === 0) {
    fs.rmSync(journalPath(ctx), { force: true });
    return;
  }
  atomicWrite(journalPath(ctx), `${JSON.stringify(journal, null, 2)}\n`, 0o600);
}

/* ------------------------------------------------------------------ wrapper */

function wrapperText({ provider, id, binary, env }) {
  const lines = [
    "#!/bin/sh",
    MARKER_VERSION,
    `# orkest-account-provider: ${provider}`,
    `# orkest-account-id: ${id}`,
    `unset ${STRIPPED_ENV.join(" ")}`,
  ];
  for (const [key, value] of Object.entries(env)) lines.push(`${key}=${shellQuote(value)}`);
  if (Object.keys(env).length > 0) lines.push(`export ${Object.keys(env).join(" ")}`);
  lines.push(`exec ${shellQuote(binary)} "$@"`, "");
  return lines.join("\n");
}

function wrapperIdentity(text) {
  const lines = text.split("\n");
  if (lines[0] !== "#!/bin/sh" || lines[1] !== MARKER_VERSION) return null;
  const provider = /^# orkest-account-provider: (.+)$/.exec(lines[2] || "");
  const id = /^# orkest-account-id: (.+)$/.exec(lines[3] || "");
  return provider && id ? { provider: provider[1], id: id[1] } : null;
}

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function pathDirs(ctx) {
  return String(ctx.env.PATH || "")
    .split(path.delimiter)
    .filter((dir) => dir && path.isAbsolute(dir));
}

function isSameName(a, b, ctx) {
  return ctx.platform === "darwin" || ctx.platform === "win32"
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

function dirMatches(dir, name, ctx) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => isSameName(entry, name, ctx))
    .map((entry) => path.join(dir, entry));
}

function realOrSelf(file) {
  try {
    return fs.realpathSync(file);
  } catch {
    return file;
  }
}

/** Inspect `~/.local/bin/<alias>`; returns whether it is a replaceable managed wrapper. */
function inspectLocalWrapper(alias, { provider, id }, ctx) {
  const target = path.join(ctx.localBin, alias);
  const siblings = dirMatches(ctx.localBin, alias, ctx);
  for (const found of siblings) {
    if (found !== target)
      throw new AccountError(`${found} collides with alias "${alias}" on this filesystem`);
  }
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    if (error?.code === "ENOENT") return { target, exists: false };
    throw error;
  }
  if (stat.isSymbolicLink())
    throw new AccountError(`${target} is a symlink; refusing to replace it`);
  if (!stat.isFile()) throw new AccountError(`${target} is not a regular file`);
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new AccountError(`${target} is owned by another user`);
  }
  if (stat.nlink > 1)
    throw new AccountError(`${target} has multiple hard links; refusing to replace it`);
  const identity = wrapperIdentity(fs.readFileSync(target, "utf8"));
  if (!identity) throw new AccountError(`${target} exists and is not an Orkest-managed wrapper`);
  if (identity.id !== id || identity.provider !== provider) {
    throw new AccountError(
      `${target} belongs to account ${identity.id} (${identity.provider}), not ${id}`,
    );
  }
  return { target, exists: true };
}

function checkPathCollisions(alias, ctx) {
  const localReal = realOrSelf(ctx.localBin);
  for (const dir of pathDirs(ctx)) {
    if (realOrSelf(dir) === localReal) continue;
    for (const found of dirMatches(dir, alias, ctx)) {
      if (isExecutable(found)) {
        throw new AccountError(
          `alias "${alias}" would shadow or be shadowed by existing executable ${found}`,
        );
      }
    }
  }
}

function validateAlias(alias, ctx) {
  if (!ALIAS_RE.test(alias)) throw new AccountError("--alias must match ^[a-z][a-z0-9_-]*$");
  if (HARNESS_NAMES.has(alias) || RESERVED.has(alias) || alias.startsWith("_")) {
    throw new AccountError(`alias "${alias}" is reserved by a shell, harness or the installer`);
  }
  const lowered = alias.toLowerCase();
  if (lowered.startsWith("trap") || lowered.endsWith("_functions")) {
    throw new AccountError(`alias "${alias}" is reserved by the installer`);
  }
  void ctx;
}

/** The real provider executable: first on PATH outside canonical ~/.local/bin, never a managed wrapper. */
function resolveProvider(bin, ctx) {
  const localReal = realOrSelf(ctx.localBin);
  for (const dir of pathDirs(ctx)) {
    const candidate = path.join(dir, bin);
    if (!isExecutable(candidate)) continue;
    const real = realOrSelf(candidate);
    if (within(localReal, real)) continue;
    try {
      if (wrapperIdentity(fs.readFileSync(real, "utf8"))) continue;
    } catch {
      // binary file
    }
    return real;
  }
  throw new AccountError(
    `provider executable "${bin}" was not found on PATH outside ~/.local/bin`,
    "provider",
  );
}

function writeWrapper(plan) {
  fs.mkdirSync(path.dirname(plan.target), { recursive: true, mode: 0o755 });
  let existing = null;
  try {
    existing = fs.readFileSync(plan.target, "utf8");
  } catch {
    // new
  }
  if (existing === plan.text) {
    fs.chmodSync(plan.target, 0o755);
    return false;
  }
  atomicWrite(plan.target, plan.text, 0o755);
  return true;
}

function quarantineRoot(ctx) {
  return path.join(ctx.home, ".local", "state", "orkest", "account-quarantine");
}

function quarantine(source, label, ctx) {
  const dir = path.join(
    quarantineRoot(ctx),
    `${Date.now()}-${crypto.randomBytes(3).toString("hex")}`,
  );
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dest = path.join(dir, label);
  fs.renameSync(source, dest);
  return dest;
}

/* ------------------------------------------------------------------ accounts */

function selectorMatches(account, selector) {
  if (account.id === selector) return "id";
  if (account.alias === selector) return "alias";
  const route = typeof account.route === "string" ? account.route.trim() : "";
  if (route && route === selector && !/\s/.test(route) && !route.includes("=")) return "route";
  return null;
}

function resolveSelector(accounts, selector) {
  const exact = accounts.filter((a) => a?.id === selector);
  const loose = accounts.filter((a) => a?.id !== selector && selectorMatches(a || {}, selector));
  if (exact.length + loose.length === 1) return exact[0] || loose[0];
  if (exact.length + loose.length === 0)
    throw new AccountError(`no account matches "${selector}"`, "not-found");
  throw new AccountError(
    `"${selector}" is ambiguous between ${[...exact, ...loose].map((a) => a.id).join(", ")}`,
  );
}

function assertNoCollisions(accounts, candidate) {
  const names = new Set([candidate.id, candidate.alias].filter(Boolean));
  for (const other of accounts) {
    if (!other || other.id === candidate.id) continue;
    const taken = [other.id, other.alias];
    const route = typeof other.route === "string" ? other.route.trim() : "";
    if (route && !/\s/.test(route) && !route.includes("=")) taken.push(route);
    for (const name of taken) {
      if (name && names.has(name)) {
        throw new AccountError(`"${name}" collides with account ${other.id}`);
      }
    }
  }
}

function assertNoOverlap(accounts, candidate, ctx) {
  const mine = accountHome(candidate, ctx);
  if (!mine) return;
  for (const other of accounts) {
    if (!other || other.id === candidate.id) continue;
    const theirs = accountHome(other, ctx) || defaultHomeFor(other, ctx);
    if (!theirs) continue;
    if (within(mine, theirs) || within(theirs, mine)) {
      throw new AccountError(`profile ${mine} overlaps profile ${theirs} of account ${other.id}`);
    }
  }
}

function signInFor(account, cli, binName, ctx) {
  const commandName = account.alias || binName;
  const argv = {
    claude: ["auth", "login"],
    codex: ["login"],
    agy: [],
    opencode: ["auth", "login"],
  }[cli];
  const env = {};
  if (!account.alias)
    Object.assign(
      env,
      account.env || {},
      account.configDir ? { CLAUDE_CONFIG_DIR: account.configDir } : {},
    );
  const assignments = Object.entries(env).map(([k, v]) => `${k}=${shellQuote(v)}`);
  const command = [...assignments, commandName, ...argv.map(shellQuote)].join(" ");
  void ctx;
  return { argv: [commandName, ...argv], env, command };
}

function defaultRoute(cli, entryEnv, configDir, bin) {
  const pairs = configDir ? { CLAUDE_CONFIG_DIR: configDir } : entryEnv;
  return [...Object.entries(pairs).map(([k, v]) => `${k}=${shellQuote(v)}`), bin].join(" ");
}

function loginStatus(account, ctx) {
  const cli = STORED_TO_CLI[account.provider];
  const home = accountHome(account, ctx) || defaultHomeFor(account, ctx);
  if (!cli || !home) return "unknown";
  const files = {
    claude: [".credentials.json"],
    codex: ["auth.json"],
    agy: ["oauth_credentials.json", ".gemini/oauth_credentials.json"],
    opencode: ["data/opencode/auth.json"],
  }[cli];
  for (const rel of files) {
    try {
      const stat = fs.statSync(path.join(home, rel));
      if (stat.isFile() && stat.size > 0) return "credential-file-present";
    } catch {
      // keep looking
    }
  }
  // Keyring-backed logins leave no file, so absence proves nothing.
  return "unknown";
}

/* ----------------------------------------------------------------- sync run */

function runInstaller(mode, { dryRun = false } = {}, ctx) {
  if (typeof ctx.runSync === "function") return ctx.runSync(mode, { dryRun }, ctx);
  const args = [SCRIPT, mode, "--json", ...(dryRun ? ["--dry-run"] : [])];
  const res = spawnSync("python3", args, {
    encoding: "utf8",
    timeout: 180_000,
    env: { ...ctx.env, HOME: ctx.home, MONITOR_CONFIG: ctx.canonicalConfig },
  });
  let payload = null;
  try {
    payload = JSON.parse(String(res.stdout || "").trim());
  } catch {
    // fall through
  }
  if (!payload) {
    return {
      schema: "ork.account.sync.v1",
      dryRun,
      profiles: [],
      shell: { status: "error" },
      errors: [
        {
          id: "*",
          operation: mode,
          message: String(res.stderr || res.error?.message || "sync failed")
            .trim()
            .split("\n")
            .slice(-3)
            .join(" "),
        },
      ],
    };
  }
  return payload;
}

function hasSyncFailure(result) {
  return Array.isArray(result?.errors) && result.errors.length > 0;
}

async function finishSync(ctx, ids, result) {
  await withConfigLock(ctx, () => {
    const journal = readJournal(ctx);
    if (hasSyncFailure(result)) {
      const failed = (result.errors || []).map((e) => e.id).filter((id) => id && id !== "*");
      journal.pendingSync = [...new Set([...journal.pendingSync, ...ids, ...failed])];
    } else {
      journal.pendingSync = [];
    }
    writeJournal(ctx, journal);
  });
}

/* ----------------------------------------------------------------- recovery */

function applyIntent(ctx, config, intent) {
  config.accounts ||= [];
  const index = config.accounts.findIndex((a) => a?.id === intent.id);
  if (intent.op === "add") {
    if (index === -1) {
      config.accounts.push(intent.entry);
    } else {
      config.accounts[index] = intent.entry;
    }
    if (intent.wrapper) writeWrapper(intent.wrapper);
  } else if (intent.op === "remove") {
    if (index !== -1) config.accounts.splice(index, 1);
    retireWrapper(intent, ctx);
  }
}

function retireWrapper(intent, ctx) {
  if (!intent.alias) return null;
  const target = path.join(ctx.localBin, intent.alias);
  try {
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.nlink > 1) return null;
    const identity = wrapperIdentity(fs.readFileSync(target, "utf8"));
    if (!identity || identity.id !== intent.id || identity.provider !== intent.provider)
      return null;
    return quarantine(target, intent.alias, ctx);
  } catch {
    return null;
  }
}

/** Under the lock: finish any interrupted add/remove from the journal before a new mutation. */
function recover(ctx, state) {
  const journal = readJournal(ctx);
  if (journal.intents.length === 0) return journal;
  for (const intent of journal.intents) {
    applyIntent(ctx, state.config, intent);
    if (intent.op === "add" && !journal.pendingSync.includes(intent.id))
      journal.pendingSync.push(intent.id);
  }
  writeConfig(ctx, state.config);
  journal.intents = [];
  writeJournal(ctx, journal);
  state.existed = true;
  return journal;
}

/* --------------------------------------------------------------- library API */

export async function addAccount(options, context = {}) {
  const ctx = resolveContext(context);
  const cli = options.provider;
  const spec = PROVIDERS[cli];
  if (!spec) throw new AccountError("provider must be one of claude, codex, agy, opencode");
  const slug = requireSlug(options.profile, "--profile");
  const id = options.id ? requireSlug(options.id, "--id") : `${spec.stored}-${slug}`;
  const tags = normalizeTags(options.tags || [], { validate: true });
  const short = options.short === undefined ? undefined : requireShort(options.short);
  const label = options.label === undefined ? undefined : cleanLabel(options.label);
  const alias = options.alias;
  if (alias !== undefined) validateAlias(alias, ctx);

  const requested = options.configDir || path.join(ctx.home, spec.dir(slug));
  const home = resolveProfileHome(requested, ctx);
  const faults = ctx.faults || {};

  // Validate wrapper before any commit, using the real provider.
  let wrapper = null;
  if (alias) {
    const binary = resolveProvider(spec.bin, ctx);
    inspectLocalWrapper(alias, { provider: spec.stored, id }, ctx);
    checkPathCollisions(alias, ctx);
    wrapper = { binary };
  }

  const result = await withConfigLock(ctx, () => {
    const state = readConfigFile(ctx, { bootstrap: true });
    recover(ctx, state);
    const config = state.config;
    config.accounts = Array.isArray(config.accounts) ? config.accounts : [];
    const existing = config.accounts.find((a) => a?.id === id);
    if (existing) {
      if (existing.provider !== spec.stored) {
        throw new AccountError(`account ${id} already exists with provider ${existing.provider}`);
      }
      const existingHome = accountHome(existing, ctx);
      if (existingHome && existingHome !== home) {
        throw new AccountError(`account ${id} already uses profile ${existingHome}`);
      }
    }
    const base = existing ? structuredClone(existing) : {};
    const profile = profileEnv(cli, home);
    // Preserve distinct legacy values for AGY when an existing entry records them.
    const mergedEnv = { ...profile.env, ...(existing && cli === "agy" && existing.env) };
    const entry = {
      ...base,
      id,
      provider: spec.stored,
      label: label ?? base.label ?? `${spec.stored} · ${slug}`,
      short: short ?? base.short ?? spec.short,
      ...(profile.configDir && { configDir: home }),
      env: { ...base.env, ...mergedEnv },
    };
    if (!profile.configDir) delete entry.configDir;
    const mergedTags = normalizeTags([...(base.tags || []), ...tags], { validate: false });
    if (mergedTags.length > 0) entry.tags = mergedTags;
    if (alias) entry.alias = alias;
    entry.route =
      entry.alias || base.route || defaultRoute(cli, entry.env, entry.configDir, spec.bin);
    if (alias) entry.route = alias;
    if (!entry.env || Object.keys(entry.env).length === 0) delete entry.env;

    assertNoCollisions(config.accounts, entry);
    assertNoOverlap(config.accounts, entry, ctx);

    let plan = null;
    if (entry.alias) {
      if (!wrapper) {
        wrapper = { binary: resolveProvider(spec.bin, ctx) };
      }
      const inspected = inspectLocalWrapper(entry.alias, { provider: spec.stored, id }, ctx);
      plan = {
        target: inspected.target,
        text: wrapperText({
          provider: spec.stored,
          id,
          binary: wrapper.binary,
          env: {
            ...(entry.configDir && { CLAUDE_CONFIG_DIR: entry.configDir }),
            ...entry.env,
          },
        }),
      };
    }

    const identical = existing && JSON.stringify(existing) === JSON.stringify(entry);
    const wrapperCurrent =
      !plan || (fs.existsSync(plan.target) && fs.readFileSync(plan.target, "utf8") === plan.text);
    const journal = readJournal(ctx);
    const profileInfo = profileState(home);
    if (identical && wrapperCurrent && profileInfo.exists) {
      return {
        entry,
        changed: false,
        pending: journal.pendingSync.includes(id),
        wrapperPath: plan?.target,
      };
    }

    // Profile first (validated above), then journal, wrapper, config.
    const ownMarker = !profileInfo.exists || (profileInfo.empty && !existing);
    ensureProfile(home, { provider: spec.stored, id, own: ownMarker && !readMarker(home) });
    journal.intents.push({ op: "add", id, entry, wrapper: plan });
    writeJournal(ctx, journal);
    if (faults.beforeCommit) throw new AccountError("injected failure before commit", "injected");
    if (plan) writeWrapper(plan);
    const index = config.accounts.findIndex((a) => a?.id === id);
    if (index === -1) {
      config.accounts.push(entry);
    } else {
      config.accounts[index] = entry;
    }
    writeConfig(ctx, config);
    journal.intents = journal.intents.filter((i) => i.id !== id);
    if (!journal.pendingSync.includes(id)) journal.pendingSync.push(id);
    writeJournal(ctx, journal);
    if (faults.afterCommit) throw new AccountError("injected failure after commit", "injected");
    return { entry, changed: true, pending: true, wrapperPath: plan?.target };
  });

  const signIn = signInFor(result.entry, cli, spec.bin, ctx);
  const payload = {
    schema: "ork.account.add.v1",
    id,
    provider: spec.stored,
    alias: result.entry.alias || null,
    home,
    changed: result.changed,
    wrapper: result.wrapperPath || null,
    signIn,
    sync: { status: "skipped" },
  };
  if (options.noSync) {
    payload.sync = { status: result.pending ? "pending" : "current" };
    return payload;
  }
  if (!result.pending) {
    payload.sync = { status: "current" };
    return payload;
  }
  const sync = faults.sync ? injectedSyncFailure(id) : runInstaller("--account-sync", {}, ctx);
  await finishSync(ctx, [id], sync);
  payload.sync = {
    status: hasSyncFailure(sync) ? "pending" : "current",
    errors: sync.errors || [],
  };
  if (hasSyncFailure(sync)) payload.exitCode = 1;
  return payload;
}

function injectedSyncFailure(id) {
  return {
    schema: "ork.account.sync.v1",
    dryRun: false,
    profiles: [],
    shell: { status: "unavailable" },
    errors: [{ id, operation: "sync", message: "injected sync failure" }],
  };
}

export async function listAccounts(context = {}) {
  const ctx = resolveContext(context);
  const { config } = readConfigFile(ctx, { bootstrap: false });
  const journal = readJournal(ctx);
  return (config.accounts || []).map((account) => ({
    provider: account.provider,
    id: account.id,
    alias: account.alias || null,
    tags: Array.isArray(account.tags) ? account.tags : [],
    home: accountHome(account, ctx) || defaultHomeFor(account, ctx),
    syncStatus: journal.pendingSync.includes(account.id) ? "pending" : "current",
    loginStatus: loginStatus(account, ctx),
  }));
}

export async function tagAccount(selector, action, tagList, context = {}) {
  if (!["add", "remove", "set"].includes(action))
    throw new AccountError("tag action must be add, remove or set");
  if (action !== "set" && tagList.length === 0) throw new AccountError("name at least one tag");
  const ctx = resolveContext(context);
  const incoming = normalizeTags(tagList, { validate: action !== "remove" });
  return withConfigLock(ctx, () => {
    const state = readConfigFile(ctx, { bootstrap: true });
    recover(ctx, state);
    const accounts = state.config.accounts || [];
    const account = resolveSelector(accounts, selector);
    const current = Array.isArray(account.tags) ? account.tags : [];
    let next;
    if (action === "add") next = normalizeTags([...current, ...incoming], { validate: false });
    else if (action === "remove") next = current.filter((tag) => !incoming.includes(tag));
    else next = incoming;
    if (next.length > 0) account.tags = next;
    else delete account.tags;
    state.config.accounts = accounts;
    writeConfig(ctx, state.config);
    return { schema: "ork.account.tag.v1", id: account.id, tags: next };
  });
}

export async function removeAccount(selector, options = {}, context = {}) {
  const ctx = resolveContext(context);
  const faults = ctx.faults || {};
  let purge = null;
  const removed = await withConfigLock(ctx, async () => {
    const state = readConfigFile(ctx, { bootstrap: true });
    recover(ctx, state);
    const accounts = state.config.accounts || [];
    const account = resolveSelector(accounts, selector);
    const home = accountHome(account, ctx);
    if (options.purgeProfile) {
      if (!home) throw new AccountError("this account has no dedicated profile to purge");
      const canonical = resolveProfileHome(home, ctx);
      const marker = readMarker(canonical);
      if (
        !marker ||
        marker.id !== account.id ||
        marker.provider !== account.provider ||
        marker.home !== canonical
      ) {
        throw new AccountError(
          "profile has no matching Orkest ownership marker; it will not be purged",
        );
      }
      for (const other of accounts) {
        if (
          other !== account &&
          accountHome(other, ctx) &&
          within(accountHome(other, ctx), canonical)
        ) {
          throw new AccountError(`profile is also referenced by account ${other.id}`);
        }
      }
      purge = { home: canonical, quarantine: quarantineRoot(ctx) };
      const confirmed =
        typeof ctx.confirm === "function" && (await ctx.confirm({ account: account.id, ...purge }));
      if (confirmed !== true) {
        throw new AccountError(
          `purge needs interactive confirmation: ${canonical} would be moved to quarantine (never deleted); nothing was changed`,
          "purge-unconfirmed",
        );
      }
    }
    const intent = {
      op: "remove",
      id: account.id,
      provider: account.provider,
      alias: account.alias || null,
    };
    const journal = readJournal(ctx);
    journal.intents.push(intent);
    writeJournal(ctx, journal);
    if (faults.beforeCommit) throw new AccountError("injected failure before commit", "injected");
    state.config.accounts = accounts.filter((a) => a !== account);
    writeConfig(ctx, state.config);
    if (faults.afterCommit) throw new AccountError("injected failure after commit", "injected");
    const retired = retireWrapper(intent, ctx);
    let purged = null;
    if (purge) purged = quarantine(purge.home, path.basename(purge.home), ctx);
    journal.intents = journal.intents.filter((i) => i.id !== account.id);
    journal.pendingSync = journal.pendingSync.filter((id) => id !== account.id);
    writeJournal(ctx, journal);
    return { id: account.id, retired, purged, profile: home };
  });
  const sync = faults.sync
    ? injectedSyncFailure(removed.id)
    : runInstaller("--shell-sync", {}, ctx);
  return {
    schema: "ork.account.remove.v1",
    id: removed.id,
    wrapperQuarantined: removed.retired,
    profile: removed.profile,
    profileQuarantined: removed.purged,
    sync: { status: hasSyncFailure(sync) ? "pending" : "current", errors: sync.errors || [] },
    ...(hasSyncFailure(sync) && { exitCode: 1 }),
  };
}

export async function syncAccounts(options = {}, context = {}) {
  const ctx = resolveContext(context);
  const isDryRun = Boolean(options.dryRun);
  if (!isDryRun) {
    await withConfigLock(ctx, () => {
      const state = readConfigFile(ctx, { bootstrap: true });
      recover(ctx, state);
    });
  }
  const result = runInstaller("--account-sync", { dryRun: isDryRun }, ctx);
  if (!isDryRun) await finishSync(ctx, [], result);
  return { ...result, ...(hasSyncFailure(result) && { exitCode: 1 }) };
}

/* --------------------------------------------------------------------- CLI */

function emit(stdout, value, json, human) {
  stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : `${human}\n`);
}

export async function accountCommand(argv, context = {}) {
  const stdout = context.stdout || process.stdout;
  const stderr = context.stderr || process.stderr;
  const [action, ...rest] = argv;
  try {
    if (!action || action === "--help" || action === "-h" || action === "help") {
      stdout.write(`${ACCOUNT_USAGE}\n`);
      return action ? 0 : 1;
    }
    if (action === "add") {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          profile: { type: "string" },
          id: { type: "string" },
          alias: { type: "string" },
          tag: { type: "string", multiple: true },
          label: { type: "string" },
          short: { type: "string" },
          "config-dir": { type: "string" },
          "no-sync": { type: "boolean" },
          json: { type: "boolean" },
        },
      });
      if (positionals.length !== 1)
        throw new AccountError("account add takes exactly one provider");
      if (!values.profile) throw new AccountError("--profile <slug> is required");
      const payload = await addAccount(
        {
          provider: positionals[0],
          profile: values.profile,
          id: values.id,
          alias: values.alias,
          tags: values.tag,
          label: values.label,
          short: values.short,
          configDir: values["config-dir"],
          noSync: values["no-sync"],
        },
        context,
      );
      const lines = [
        `${payload.changed ? "Configured" : "Already configured"} ${payload.id} (${payload.provider}) at ${payload.home}`,
        payload.wrapper ? `Wrapper: ${payload.wrapper}` : null,
        payload.sync.status === "pending"
          ? `Account is configured; profile sync is pending. Run: ork account sync`
          : null,
        `Sign in with: ${payload.signIn.command}`,
      ].filter(Boolean);
      emit(stdout, payload, values.json, lines.join("\n"));
      return payload.exitCode || 0;
    }
    if (action === "list") {
      const { values } = parseArgs({ args: rest, options: { json: { type: "boolean" } } });
      const rows = await listAccounts(context);
      const human =
        rows.length > 0
          ? rows
              .map(
                (r) =>
                  `${r.id}\t${r.provider}\t${r.alias || "-"}\t${r.tags.join(",") || "-"}\t${r.home}\t${r.syncStatus}\t${r.loginStatus}`,
              )
              .join("\n")
          : "No accounts configured.";
      emit(
        stdout,
        values.json ? { schema: "ork.account.list.v1", accounts: rows } : rows,
        values.json,
        human,
      );
      return 0;
    }
    if (action === "tag") {
      const { positionals } = parseArgs({ args: rest, allowPositionals: true, options: {} });
      const [selector, verb, ...tags] = positionals;
      if (!selector || !verb)
        throw new AccountError("usage: ork account tag <id-or-alias> <add|remove|set> <tag...>");
      const payload = await tagAccount(selector, verb, tags, context);
      emit(stdout, payload, false, `${payload.id}: ${payload.tags.join(", ") || "(no tags)"}`);
      return 0;
    }
    if (action === "remove") {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { "purge-profile": { type: "boolean" }, json: { type: "boolean" } },
      });
      if (positionals.length !== 1)
        throw new AccountError("usage: ork account remove <id-or-alias> [--purge-profile]");
      const confirm =
        context.confirm ||
        (values["purge-profile"] && process.stdin.isTTY && process.stdout.isTTY
          ? ttyConfirm
          : undefined);
      const payload = await removeAccount(
        positionals[0],
        { purgeProfile: values["purge-profile"] },
        { ...context, confirm },
      );
      emit(
        stdout,
        payload,
        values.json,
        `Removed ${payload.id}${payload.sync.status === "pending" ? " (shell sync pending; run ork account sync)" : ""}`,
      );
      return payload.exitCode || 0;
    }
    if (action === "sync") {
      const { values } = parseArgs({
        args: rest,
        options: { "dry-run": { type: "boolean" }, json: { type: "boolean" } },
      });
      const payload = await syncAccounts({ dryRun: values["dry-run"] }, context);
      const human = `${values["dry-run"] ? "Plan" : "Sync"}: ${payload.profiles?.length || 0} profile target(s); ${payload.errors?.length || 0} error(s)`;
      emit(stdout, payload, values.json, human);
      return payload.exitCode || 0;
    }
    throw new AccountError(`unknown account command "${action}"`);
  } catch (error) {
    const message = error?.message || String(error);
    if (rest.includes("--json")) {
      stdout.write(
        `${JSON.stringify({ schema: ACCOUNT_SCHEMA, ok: false, code: error?.code || "error", error: message })}\n`,
      );
    } else {
      stderr.write(`ork account: ${message}\n`);
    }
    return 1;
  }
}

async function ttyConfirm(scope) {
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(
      `Move profile ${scope.home} to quarantine ${scope.quarantine} (recoverable)? Type "quarantine" to confirm: `,
    );
    return answer.trim() === "quarantine";
  } finally {
    rl.close();
  }
}
