import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { breakerRetryAt, probeDeadline, recordProbe } from "./adaptive-probes.mjs";
import { childEnv, expandHome } from "./exec.mjs";
import { detectConfig } from "./init.mjs";
import { normalizeAccountTags } from "./policy.mjs";
import { fetchAntigravity } from "./providers/antigravity.mjs";
import { fetchClaude } from "./providers/claude.mjs";
import { fetchCodex } from "./providers/codex.mjs";
import { observeResets } from "./resets.mjs";

const FETCHERS = { claude: fetchClaude, codex: fetchCodex, antigravity: fetchAntigravity };

export const CONFIG_PATH = expandHome(
  process.env.MONITOR_CONFIG ?? path.join(homedir(), ".config", "monitor", "config.json"),
);
export const CACHE_DIR = expandHome(
  process.env.MONITOR_CACHE_DIR ?? path.join(homedir(), ".cache", "monitor"),
);
const SNAPSHOT_PATH = path.join(CACHE_DIR, "snapshot.json");
const LOCK_DIR = path.join(CACHE_DIR, "refresh.lock");
// A live owner keeps its lock however slow the providers are; only a lock this old is presumed abandoned
// (hung owner, or its pid reused by another process).
const LOCK_MAX_AGE_MS = 10 * 60_000;

// Without a config file, monitor whatever is installed, so a fresh machine or plugin install works as-is.
export function loadConfig() {
  let raw;
  try {
    raw = readFileSync(CONFIG_PATH, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return detectConfig();
    throw error;
  }
  const config = { maxAgeSeconds: 180, env: {}, ...JSON.parse(raw) };
  const ids = new Set();
  for (const account of config.accounts) {
    if (!Object.hasOwn(FETCHERS, account.provider))
      throw new Error(
        `${CONFIG_PATH}: account "${account.id}" has unknown provider "${account.provider}"`,
      );
    if (ids.has(account.id))
      throw new Error(`${CONFIG_PATH}: duplicate account id "${account.id}"`);
    ids.add(account.id);
  }
  return config;
}

// Atomic, so an MCP server reading the config mid-write never sees half a file.
export function writeConfig(config) {
  mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  const tmp = `${CONFIG_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
  renameSync(tmp, CONFIG_PATH);
}

function readSnapshot() {
  try {
    return JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
  } catch {
    return { version: 1, accounts: {} };
  }
}

function writeSnapshot(snapshot) {
  mkdirSync(CACHE_DIR, { recursive: true });
  const tmp = `${SNAPSHOT_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(snapshot, null, 2));
  renameSync(tmp, SNAPSHOT_PATH);
}

const LOCK_OWNER = path.join(LOCK_DIR, "owner");
const lockState = { isHeld: false, isExitHookInstalled: false };

// Free the lock when this process exits mid-refresh (e.g. `watch` quitting). A killed process cannot
// clean up, so waiters also treat a lock whose owner is gone as stale. Installed on first acquisition,
// so importing this module has no side effects.
function installExitHook() {
  if (lockState.isExitHookInstalled) return;
  lockState.isExitHookInstalled = true;
  process.on("exit", () => {
    if (lockState.isHeld) unlock();
  });
}

function ownerAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function lockIsStale() {
  try {
    const age = Date.now() - statSync(LOCK_DIR).mtimeMs;
    if (age > LOCK_MAX_AGE_MS) return true;
    const pid = Number(readFileSync(LOCK_OWNER, "utf8"));
    return Number.isSafeInteger(pid) && pid > 0 && !ownerAlive(pid);
  } catch (error) {
    // No owner file yet: fine for a lock created a moment ago, stale if it never gets one.
    if (error.code === "ENOENT" && existsSync(LOCK_DIR))
      return Date.now() - statSync(LOCK_DIR).mtimeMs > 5000;
    return false;
  }
}

function tryLock() {
  mkdirSync(CACHE_DIR, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(LOCK_DIR);
      writeFileSync(LOCK_OWNER, String(process.pid));
      lockState.isHeld = true;
      installExitHook();
      return true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (attempt > 0 || !lockIsStale()) return false;
      rmSync(LOCK_DIR, { recursive: true, force: true });
    }
  }
  return false;
}

// Remove the lock only if it is still ours: after a takeover, another process owns the directory.
function unlock() {
  lockState.isHeld = false;
  try {
    if (Number(readFileSync(LOCK_OWNER, "utf8")) !== process.pid) return;
  } catch {
    return;
  }
  rmSync(LOCK_DIR, { recursive: true, force: true });
}

export const _lockInternals = { lockIsStale, tryLock, unlock, LOCK_DIR };

// Probes that are expensive for their provider are not repeated more often than this, except on an
// explicit refresh. agy starts every MCP server in its config just to answer /usage (for this user: an LSP
// via npm, a mock server under ~/Documents that makes macOS ask for Documents access, and so on), and
// Antigravity usage only moves while agy is in use. Override per account with minRefreshSeconds.
const MIN_REFRESH_SECONDS = { antigravity: 600 };

function hasAntigravityProbeMismatch(entry, probe) {
  if (!entry) return false;
  const expectedAppData = probe.appDataDir ?? null;
  const expectedGeminiHome = probe.geminiCliHome ?? null;
  if (entry.appDataDir === undefined || entry.geminiCliHome === undefined) {
    return expectedAppData !== null || expectedGeminiHome !== null;
  }
  return entry.appDataDir !== expectedAppData || entry.geminiCliHome !== expectedGeminiHome;
}

function isMatchingCachedProbe(entry, provider, probe) {
  return (
    Boolean(entry) &&
    entry.provider === provider &&
    typeof entry.accountHome === "string" &&
    probe.accountHome != null &&
    entry.accountHome === probe.accountHome &&
    (provider !== "antigravity" || !hasAntigravityProbeMismatch(entry, probe))
  );
}

function staleIds(config, snapshot, maxAgeMs, now) {
  return config.accounts
    .filter((a) => {
      const entry = snapshot.accounts[a.id];
      const probe = resolveAccountProbe(a, config);
      const floor = (a.minRefreshSeconds ?? MIN_REFRESH_SECONDS[a.provider] ?? 0) * 1000;
      if (isMatchingCachedProbe(entry, a.provider, probe)) {
        const retryAt = breakerRetryAt(entry, now);
        if (retryAt !== null) {
          const age = now - entry.errorAt;
          return now >= retryAt && (age < 0 || maxAgeMs < 0 || age >= floor);
        }
      }
      const expectedHome = probe.accountHome;
      const hasHomeChanged =
        (entry?.accountHome != null && entry.accountHome !== expectedHome) ||
        (a.provider === "antigravity" && hasAntigravityProbeMismatch(entry, probe));
      const lastAttempt = Math.max(entry?.fetchedAt ?? 0, entry?.errorAt ?? 0);
      const limit = maxAgeMs < 0 ? maxAgeMs : Math.max(maxAgeMs, floor);
      return !entry || entry.provider !== a.provider || hasHomeChanged || now - lastAttempt > limit;
    })
    .map((a) => a.id);
}

function canonicalPath(target) {
  const resolved = path.resolve(target);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function resolveChildEnvPath(value, baseDir = homedir()) {
  const trimmed = String(value).trim();
  let expanded;
  if (trimmed === "~") {
    expanded = baseDir;
  } else if (trimmed.startsWith("~/")) {
    expanded = path.join(baseDir, trimmed.slice(2));
  } else {
    expanded = expandHome(trimmed);
  }
  return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(baseDir, expanded);
}

function normalizeProviderEnv(env, keys) {
  const normalized = {};
  for (const key of keys) {
    if (typeof env[key] === "string" && env[key].trim()) {
      normalized[key] = resolveChildEnvPath(env[key]);
    }
  }
  return normalized;
}

/**
 * Resolves the canonical home directory and normalized child env overrides that Monitor's provider
 * fetcher actually probes for an account (resolving relative paths against the child's cwd, `homedir()`).
 */
function resolveAccountProbe(account, config = {}) {
  const mergedConfigEnv = { ...config.env, ...account.env };
  if (account.provider === "claude") {
    const rawHome =
      typeof mergedConfigEnv.HOME === "string" && mergedConfigEnv.HOME.trim()
        ? resolveChildEnvPath(mergedConfigEnv.HOME)
        : null;
    const envHomeBase = rawHome ?? homedir();
    const defaultConfigDir = canonicalPath(path.join(envHomeBase, ".claude"));
    const rawConfigDir = [
      account.configDir,
      account.claudeConfigDir,
      mergedConfigEnv.CLAUDE_CONFIG_DIR,
    ].find((v) => typeof v === "string" && v.trim());
    const configDir = rawConfigDir ? resolveChildEnvPath(rawConfigDir, envHomeBase) : null;
    const env = childEnv(
      {
        ...mergedConfigEnv,
        CLAUDE_CONFIG_DIR:
          configDir && canonicalPath(configDir) !== defaultConfigDir ? configDir : null,
      },
      { strip: [/^ANTHROPIC_/, /^CLAUDE_CODE_/, "CLAUDECODE", "CLAUDE_CONFIG_DIR"] },
    );
    const envOverrides = normalizeProviderEnv(env, ["HOME", "CLAUDE_CONFIG_DIR"]);
    const homeBase = envOverrides.HOME ?? homedir();
    const callerHome = canonicalPath(homedir());
    const probedHome = envOverrides.HOME ? canonicalPath(envOverrides.HOME) : null;
    const accountEnv = probedHome && probedHome !== callerHome ? { HOME: probedHome } : null;
    const claudeConfigDir = envOverrides.CLAUDE_CONFIG_DIR ?? null;
    const shouldUnsetClaudeConfigDir = claudeConfigDir === null;
    const claudeDir = claudeConfigDir ?? path.join(homeBase, ".claude");
    return {
      accountHome: canonicalPath(claudeDir),
      envOverrides,
      accountEnv,
      claudeConfigDir,
      unsetClaudeConfigDir: shouldUnsetClaudeConfigDir,
    };
  }
  const rawHome =
    typeof mergedConfigEnv.HOME === "string" && mergedConfigEnv.HOME.trim()
      ? resolveChildEnvPath(mergedConfigEnv.HOME)
      : null;
  const envHomeBase = rawHome ?? homedir();
  const preResolvedEnv = { ...mergedConfigEnv };
  if (rawHome !== null) {
    preResolvedEnv.HOME = rawHome;
  }
  for (const key of ["CODEX_HOME", "GEMINI_CLI_HOME", "ANTIGRAVITY_APP_DATA_DIR"]) {
    if (typeof preResolvedEnv[key] === "string" && preResolvedEnv[key].trim()) {
      preResolvedEnv[key] = resolveChildEnvPath(preResolvedEnv[key], envHomeBase);
    }
  }
  const env = childEnv(preResolvedEnv);
  const envOverrides = normalizeProviderEnv(env, [
    "HOME",
    "CODEX_HOME",
    "GEMINI_CLI_HOME",
    "ANTIGRAVITY_APP_DATA_DIR",
  ]);
  const homeBase = envOverrides.HOME ?? homedir();
  if (account.provider === "codex") {
    const codexHome = canonicalPath(envOverrides.CODEX_HOME ?? path.join(homeBase, ".codex"));
    return { accountHome: codexHome, codexHome, envOverrides };
  }
  if (account.provider === "antigravity") {
    const appDataDir = envOverrides.ANTIGRAVITY_APP_DATA_DIR
      ? canonicalPath(envOverrides.ANTIGRAVITY_APP_DATA_DIR)
      : null;
    const geminiCliHome = envOverrides.GEMINI_CLI_HOME
      ? canonicalPath(envOverrides.GEMINI_CLI_HOME)
      : null;
    const accountHome =
      appDataDir ?? geminiCliHome ?? canonicalPath(path.join(homeBase, ".gemini"));
    const agyHome = geminiCliHome ?? appDataDir ?? canonicalPath(path.join(homeBase, ".gemini"));
    return { accountHome, agyHome, appDataDir, geminiCliHome, envOverrides };
  }
  return { accountHome: null, envOverrides: {} };
}

export function resolveAccountHome(account, config = {}) {
  return resolveAccountProbe(account, config).accountHome;
}

async function fetchAccount(account, config, previous) {
  const started = Date.now();
  const probe = resolveAccountProbe(account, config);
  const {
    accountHome,
    appDataDir,
    geminiCliHome,
    envOverrides,
    accountEnv,
    claudeConfigDir,
    unsetClaudeConfigDir,
  } = probe;
  const isSameHome = isMatchingCachedProbe(previous, account.provider, probe);
  const health = isSameHome ? previous.probeHealth : null;
  const timeoutMs = probeDeadline(account, health);
  const startTick = performance.now();
  try {
    const data = await FETCHERS[account.provider](
      { ...account, timeoutMs, env: { ...config.env, ...account.env, ...envOverrides } },
      { now: started },
    );
    const now = Date.now();
    const elapsedMs = Math.round(performance.now() - startTick);
    return {
      id: account.id,
      provider: account.provider,
      accountHome,
      ...(account.provider === "claude" && {
        claudeConfigDir: data.claudeConfigDir ?? claudeConfigDir ?? null,
        unsetClaudeConfigDir: data.unsetClaudeConfigDir ?? unsetClaudeConfigDir ?? false,
        ...(accountEnv && { accountEnv }),
      }),
      ...(account.provider === "antigravity" && {
        appDataDir: appDataDir ?? null,
        geminiCliHome: geminiCliHome ?? null,
      }),
      ok: true,
      fetchedAt: now,
      durationMs: elapsedMs,
      probeHealth: recordProbe(health, {
        outcome: "success",
        elapsedMs,
        deadlineMs: timeoutMs,
        now,
      }),
      ...data,
      resetHistory: observeResets(data, isSameHome ? previous : null, started),
    };
  } catch (error) {
    // Keep the last good reading ONLY when it belongs to the same verified probed home.
    const keep = isSameHome ? previous : {};
    const now = Date.now();
    return {
      ...keep,
      id: account.id,
      provider: account.provider,
      accountHome: accountHome ?? (isSameHome ? (previous.accountHome ?? null) : null),
      ...(account.provider === "antigravity" && {
        appDataDir: appDataDir ?? null,
        geminiCliHome: geminiCliHome ?? null,
      }),
      ok: false,
      error: error.message,
      errorAt: now,
      probeHealth: recordProbe(health, {
        outcome: error.code === "MONITOR_PROBE_TIMEOUT" ? "timeout" : "error",
        elapsedMs: Math.round(performance.now() - startTick),
        deadlineMs: timeoutMs,
        now,
      }),
    };
  }
}

/**
 * Returns every configured account, refreshing any whose data is older than maxAgeSeconds.
 * One process refreshes at a time; others wait for it and then read its result.
 */
export async function getAccounts({ maxAgeSeconds, force = false, config = loadConfig() } = {}) {
  const maxAgeMs = force ? -1 : (maxAgeSeconds ?? config.maxAgeSeconds ?? 180) * 1000;
  let snapshot = readSnapshot();
  const deadline = Date.now() + 90_000;
  while (staleIds(config, snapshot, maxAgeMs, Date.now()).length > 0) {
    if (tryLock()) {
      try {
        snapshot = readSnapshot();
        const ids = staleIds(config, snapshot, maxAgeMs, Date.now());
        const accounts = config.accounts.filter((a) => ids.includes(a.id));
        const results = await Promise.all(
          accounts.map((a) => fetchAccount(a, config, snapshot.accounts[a.id])),
        );
        for (const entry of results) snapshot.accounts[entry.id] = entry;
        // Drop accounts that are no longer configured instead of carrying them forever.
        for (const id of Object.keys(snapshot.accounts))
          if (config.accounts.every((a) => a.id !== id)) delete snapshot.accounts[id];
        snapshot.updatedAt = Date.now();
        writeSnapshot(snapshot);
      } finally {
        unlock();
      }
      break;
    }
    // Another process is refreshing: wait for its result instead of fetching twice.
    const seen = snapshot.updatedAt;
    while (existsSync(LOCK_DIR) && !lockIsStale() && Date.now() < deadline) await sleep(300);
    snapshot = readSnapshot();
    if (Date.now() > deadline) break;
    // A forced refresh is satisfied by a refresh that completed, not by one that was abandoned.
    if (force && snapshot.updatedAt !== seen) break;
  }
  return config.accounts.map((account) => {
    const probe = resolveAccountProbe(account, config);
    const cached = snapshot.accounts[account.id];
    const isValidCached = isMatchingCachedProbe(cached, account.provider, probe);
    const entry = isValidCached
      ? cached
      : {
          id: account.id,
          provider: account.provider,
          accountHome: null,
          ok: false,
          error: "not fetched yet",
        };
    return {
      ...entry,
      label: account.label ?? account.id,
      short: account.short ?? account.id.slice(0, 2).toUpperCase(),
      alias:
        typeof account.alias === "string" && account.alias.trim() ? account.alias.trim() : null,
      aliases: Array.isArray(account.aliases) ? account.aliases : [],
      category: account.category ?? null,
      tags: normalizeAccountTags(account),
      route: account.route,
      routes: account.routes ?? {},
      billing: account.billing ?? null,
      configDir: account.configDir ?? null,
      ...(account.provider === "claude" && {
        claudeConfigDir: isValidCached
          ? (entry.claudeConfigDir ?? probe.claudeConfigDir ?? null)
          : (probe.claudeConfigDir ?? null),
        unsetClaudeConfigDir: isValidCached
          ? (entry.unsetClaudeConfigDir ?? probe.unsetClaudeConfigDir ?? false)
          : (probe.unsetClaudeConfigDir ?? false),
        ...((isValidCached ? (entry.accountEnv ?? probe.accountEnv) : probe.accountEnv) && {
          accountEnv: isValidCached ? (entry.accountEnv ?? probe.accountEnv) : probe.accountEnv,
        }),
      }),
      ...(account.provider === "codex" && { codexHome: probe.codexHome ?? null }),
      ...(account.provider === "antigravity" && {
        agyHome: probe.agyHome ?? null,
        appDataDir: probe.appDataDir ?? null,
        geminiCliHome: probe.geminiCliHome ?? null,
      }),
      accountHome: entry.accountHome ?? null,
      resetAnnouncements: account.resetAnnouncements ?? [],
    };
  });
}
