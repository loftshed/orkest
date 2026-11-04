import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const POLICY_SCHEMA = "ork.policy.v1";
export const CANONICAL_HARNESSES = ["codex", "agy", "opencode", "claude-work", "plaude"];

const TOKEN_ALIASES = {
  claude: "claude-work",
  "claude-work": "claude-work",
  claude_work: "claude-work",
  "work-claude": "claude-work",
  plaude: "plaude",
  "claude-personal": "plaude",
  claude_personal: "plaude",
  "personal-claude": "plaude",
  "claude-all": "claude-all",
  claude_all: "claude-all",
  "all-claude": "claude-all",
  codex: "codex",
  openai: "codex",
  agy: "agy",
  gemini: "agy",
  antigravity: "agy",
  opencode: "opencode",
  openrouter: "opencode",
};

export function normalizeDenyToken(token) {
  const cleaned = String(token ?? "")
    .trim()
    .toLowerCase();
  if (!cleaned) {
    return "";
  }
  return TOKEN_ALIASES[cleaned] || cleaned;
}

function realpathSafe(targetPath) {
  try {
    return fs.realpathSync(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

export function resolveRepoRoot(cwd = process.cwd()) {
  const rawCwd = String(cwd || process.cwd());
  const resolvedCwd = realpathSafe(path.resolve(rawCwd));
  const targetDir =
    fs.existsSync(resolvedCwd) && fs.statSync(resolvedCwd).isDirectory()
      ? resolvedCwd
      : path.dirname(resolvedCwd);
  const res = spawnSync("git", ["-C", targetDir, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    timeout: 3000,
  });
  if (res.status === 0 && res.stdout && res.stdout.trim()) {
    return realpathSafe(res.stdout.trim());
  }
  return resolvedCwd;
}

export function resolveGitRemote(repoRoot) {
  const res = spawnSync("git", ["-C", repoRoot, "config", "--get", "remote.origin.url"], {
    encoding: "utf8",
    timeout: 3000,
  });
  if (res.status === 0 && res.stdout) {
    return res.stdout.trim();
  }
  return "";
}

export function resolvePolicyConfigPath(options = {}) {
  if (options.configPath) {
    return path.resolve(String(options.configPath));
  }
  const env = options.env || process.env;
  const explicitFile = env.ORCHESTRATE_CONFIG || env.AGENT_EXECUTOR_CONFIG;
  if (explicitFile) {
    return path.resolve(String(explicitFile));
  }
  const homeDir = path.resolve(options.homeDir || env.HOME || os.homedir());
  const xdgConfig = path.resolve(
    options.xdgConfigHome || env.XDG_CONFIG_HOME || path.join(homeDir, ".config"),
  );
  const orchestrateCfg = path.join(xdgConfig, "orchestrate", "config.json");
  const legacyCfg = path.join(xdgConfig, "agent-executor", "config.json");
  if (fs.existsSync(orchestrateCfg) || !fs.existsSync(legacyCfg)) {
    return orchestrateCfg;
  }
  return legacyCfg;
}

function loadJsonObject(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) {
      return {};
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function expandHome(pattern, homeDir = os.homedir()) {
  const text = String(pattern ?? "").trim();
  if (!text) {
    return "";
  }
  if (text === "~") {
    return homeDir;
  }
  if (text.startsWith("~/")) {
    return path.join(homeDir, text.slice(2));
  }
  return text;
}

function globToRegExp(globPattern) {
  let regexStr = "^";
  for (const ch of globPattern) {
    if (ch === "*") {
      regexStr += ".*";
    } else if (ch === "?") {
      regexStr += ".";
    } else if (String.raw`\^$+?.()|{}[]`.includes(ch)) {
      regexStr += `\\${ch}`;
    } else {
      regexStr += ch;
    }
  }
  regexStr += "$";
  return new RegExp(regexStr);
}

function matchesPathPattern(repoRoot, rawPattern, homeDir = os.homedir()) {
  const expanded = expandHome(rawPattern, homeDir);
  if (!expanded) {
    return false;
  }
  const repoStr = String(repoRoot);
  if (expanded === repoStr || expanded.replace(/\/+$/, "") === repoStr) {
    return true;
  }
  try {
    if (realpathSafe(expanded) === repoStr) {
      return true;
    }
  } catch {
    // Ignore
  }
  if (expanded.endsWith("/*")) {
    const prefix = expanded.slice(0, -2).replace(/\/+$/, "");
    if (repoStr === prefix || repoStr.startsWith(`${prefix}/`)) {
      return true;
    }
  }
  if (expanded.endsWith("/")) {
    const prefix = expanded.replace(/\/+$/, "");
    if (repoStr === prefix || repoStr.startsWith(`${prefix}/`)) {
      return true;
    }
  }
  if (/[*?[]/.test(expanded)) {
    return globToRegExp(expanded).test(repoStr);
  }
  return false;
}

function matchesRemotePattern(remoteUrl, rawPattern) {
  if (!remoteUrl) {
    return false;
  }
  const pat = String(rawPattern ?? "")
    .trim()
    .toLowerCase();
  if (!pat) {
    return false;
  }
  const rem = String(remoteUrl).trim().toLowerCase();
  return Boolean(
    rem.includes(pat) || globToRegExp(pat).test(rem) || globToRegExp(`*${pat}`).test(rem),
  );
}

function normalizeRulesList(rawPolicies, source) {
  const rules = [];
  if (Array.isArray(rawPolicies)) {
    for (const entry of rawPolicies) {
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        rules.push({ ...entry, source });
      }
    }
  } else if (rawPolicies && typeof rawPolicies === "object") {
    for (const [key, value] of Object.entries(rawPolicies)) {
      if (Array.isArray(value)) {
        rules.push({ match: String(key), deny: [...value], source });
      } else if (value && typeof value === "object") {
        const rule = { ...value, source };
        if (!rule.path && !rule.remote && !rule.match) {
          rule.match = String(key);
        }
        rules.push(rule);
      }
    }
  }
  return rules;
}

function ruleMatchesRepo(
  rule,
  repoRoot,
  remoteUrl,
  { homeDir = os.homedir(), defaultMatchAll = false } = {},
) {
  const pathPat = rule.path || rule.repo;
  const remotePat = rule.remote;
  const matchPat = rule.match || rule.pattern;

  if (!pathPat && !remotePat && !matchPat) {
    return defaultMatchAll;
  }
  if (pathPat && !matchesPathPattern(repoRoot, String(pathPat), homeDir)) {
    return false;
  }
  if (remotePat && !matchesRemotePattern(remoteUrl, String(remotePat))) {
    return false;
  }
  if (matchPat) {
    const patStr = String(matchPat);
    if (
      !matchesPathPattern(repoRoot, patStr, homeDir) &&
      !matchesRemotePattern(remoteUrl, patStr)
    ) {
      return false;
    }
  }
  return true;
}

export function resolveRepoPolicy(cwd = process.cwd(), options = {}) {
  const homeDir = path.resolve(
    options.homeDir || options.env?.HOME || process.env.HOME || os.homedir(),
  );
  const repoRoot = resolveRepoRoot(cwd);
  const remoteUrl =
    options.remote === undefined ? resolveGitRemote(repoRoot) : String(options.remote || "");

  let configData;
  let configSource;
  if (options.config && typeof options.config === "object") {
    configData = options.config;
    configSource = "config";
  } else {
    const cfgPath = resolvePolicyConfigPath({ ...options, homeDir });
    configData = loadJsonObject(cfgPath);
    configSource = cfgPath;
  }

  const candidateRules = [];
  if (configData && configData.repo_policies !== undefined) {
    for (const rule of normalizeRulesList(configData.repo_policies, configSource)) {
      candidateRules.push({ rule, defaultMatchAll: false });
    }
  }

  const repoLocalPath = path.join(repoRoot, ".orkest", "policy.json");
  if (fs.existsSync(repoLocalPath)) {
    const repoLocal = loadJsonObject(repoLocalPath);
    if (Array.isArray(repoLocal.deny)) {
      candidateRules.push({
        rule: { path: repoRoot, deny: [...repoLocal.deny], source: repoLocalPath },
        defaultMatchAll: true,
      });
    }
    if (repoLocal.repo_policies !== undefined) {
      for (const rule of normalizeRulesList(repoLocal.repo_policies, repoLocalPath)) {
        candidateRules.push({ rule, defaultMatchAll: true });
      }
    }
  }

  const matchedRules = [];
  const denyTokens = [];
  const seenDeny = new Set();

  for (const { rule, defaultMatchAll } of candidateRules) {
    if (
      !ruleMatchesRepo(rule, repoRoot, remoteUrl, { homeDir, defaultMatchAll }) ||
      !Array.isArray(rule.deny)
    ) {
      continue;
    }
    const normalizedRuleDeny = [];
    for (const rawItem of rule.deny) {
      const norm = normalizeDenyToken(rawItem);
      if (!norm) {
        continue;
      }
      normalizedRuleDeny.push(norm);
      if (seenDeny.has(norm)) {
        continue;
      }

      seenDeny.add(norm);
      denyTokens.push(norm);
    }
    const matched = {
      source: rule.source || configSource,
      deny: normalizedRuleDeny,
    };
    if (rule.path || rule.repo) {
      matched.path = rule.path || rule.repo;
    }
    if (rule.remote) {
      matched.remote = rule.remote;
    }
    if (rule.match || rule.pattern) {
      matched.match = rule.match || rule.pattern;
    }
    matchedRules.push(matched);
  }

  const denySet = new Set(denyTokens);
  const allowedHarnesses = [];
  if (!denySet.has("codex")) {
    allowedHarnesses.push("codex");
  }
  if (!denySet.has("agy")) {
    allowedHarnesses.push("agy");
  }
  if (!denySet.has("opencode")) {
    allowedHarnesses.push("opencode");
  }
  if (!denySet.has("claude-work") && !denySet.has("claude-all")) {
    allowedHarnesses.push("claude-work");
  }
  if (!denySet.has("plaude") && !denySet.has("claude-all")) {
    allowedHarnesses.push("plaude");
  }

  return {
    schema: POLICY_SCHEMA,
    repo: repoRoot,
    remote: remoteUrl,
    deny: denyTokens,
    allowed_harnesses: allowedHarnesses,
    allowedHarnesses,
    matched_rules: matchedRules,
    matchedRules,
  };
}

function classifyHarnessTarget(target) {
  if (typeof target === "string") {
    return normalizeDenyToken(target);
  }
  if (!target || typeof target !== "object") {
    return "";
  }
  const combined = [
    target.provider,
    target.engine,
    target.harness,
    target.id,
    target.accountId,
    target.label,
    target.route,
    target.billing,
    target.configDir,
  ]
    .filter(Boolean)
    .map((v) => String(v).toLowerCase())
    .join(" ");

  const primary = String(
    target.engine || target.harness || target.provider || target.id || "",
  ).toLowerCase();
  if (
    primary.includes("opencode") ||
    primary.includes("openrouter") ||
    combined.includes("openrouter")
  ) {
    return "opencode";
  }
  if (primary.includes("codex") || primary.includes("openai") || primary.includes("chatgpt")) {
    return "codex";
  }
  if (primary.includes("agy") || primary.includes("gemini") || primary.includes("antigravity")) {
    return "agy";
  }
  if (
    primary.includes("claude") ||
    primary.includes("anthropic") ||
    primary.includes("plaude") ||
    combined.includes("claude") ||
    combined.includes("anthropic")
  ) {
    const isPersonal =
      String(target.billing || "")
        .toLowerCase()
        .includes("personal") ||
      combined.includes("plaude") ||
      combined.includes("claude-personal") ||
      combined.includes("claude_personal") ||
      combined.includes("personal");
    return isPersonal ? "plaude" : "claude-work";
  }
  return normalizeDenyToken(primary);
}

export function isHarnessAllowed(cwd, target, options = {}) {
  const policy = options.policy || resolveRepoPolicy(cwd, options);
  const denySet = new Set(policy.deny || []);
  const canonical = classifyHarnessTarget(target);
  if (!canonical) {
    return true;
  }
  if (canonical === "codex") {
    return !denySet.has("codex");
  }
  if (canonical === "agy") {
    return !denySet.has("agy");
  }
  if (canonical === "opencode") {
    return !denySet.has("opencode");
  }
  if (canonical === "claude-work") {
    return !denySet.has("claude-work") && !denySet.has("claude-all");
  }
  if (canonical === "plaude") {
    return !denySet.has("plaude") && !denySet.has("claude-all");
  }
  if (canonical === "claude-all") {
    return !denySet.has("claude-all") && !(denySet.has("claude-work") && denySet.has("plaude"));
  }
  return !denySet.has(canonical);
}

export function setRepoPolicyDeny(
  cwd,
  targets = [],
  { mode = "add", match = null, configPath = null, homeDir = null, env = process.env } = {},
) {
  const resolvedHome = path.resolve(homeDir || env?.HOME || os.homedir());
  const repoRoot = resolveRepoRoot(cwd);
  const selector = match ? String(match).trim() : repoRoot;
  const resolvedConfigPath = resolvePolicyConfigPath({ configPath, homeDir: resolvedHome, env });

  const configObj = loadJsonObject(resolvedConfigPath);
  const existingPolicies = configObj.repo_policies;
  let rulesList = [];
  if (Array.isArray(existingPolicies)) {
    rulesList = existingPolicies.map((item) => ({ ...item }));
  } else if (existingPolicies && typeof existingPolicies === "object") {
    for (const [k, v] of Object.entries(existingPolicies)) {
      if (Array.isArray(v)) {
        rulesList.push({ match: k, deny: [...v] });
      } else if (v && typeof v === "object") {
        rulesList.push({ match: k, ...v });
      }
    }
  }

  const normalizedTargets = (Array.isArray(targets) ? targets : [targets])
    .map((t) => normalizeDenyToken(t))
    .filter(Boolean);

  const matchesSelector = (rule) =>
    (rule.path && String(rule.path) === selector) ||
    (rule.match && String(rule.match) === selector) ||
    (rule.remote && String(rule.remote) === selector);

  if (mode === "reset") {
    rulesList = rulesList.filter((rule) => !matchesSelector(rule));
  } else {
    let targetRule = rulesList.find((rule) => matchesSelector(rule));
    if (!targetRule && mode === "add") {
      targetRule = match ? { match: selector, deny: [] } : { path: selector, deny: [] };
      rulesList.push(targetRule);
    }
    if (targetRule) {
      const currentDeny = (Array.isArray(targetRule.deny) ? targetRule.deny : [])
        .map((t) => normalizeDenyToken(t))
        .filter(Boolean);
      const denySet = new Set(currentDeny);
      if (mode === "add") {
        for (const tok of normalizedTargets) {
          denySet.add(tok);
        }
      } else if (mode === "remove") {
        for (const tok of normalizedTargets) {
          denySet.delete(tok);
          if (!((tok === "claude-work" || tok === "plaude") && denySet.has("claude-all"))) {
            continue;
          }

          denySet.delete("claude-all");
          denySet.add(tok === "claude-work" ? "plaude" : "claude-work");
        }
      }
      targetRule.deny = [...denySet];
      if (targetRule.deny.length === 0) {
        rulesList = rulesList.filter((r) => r !== targetRule);
      }
    }
  }

  const nextConfig = {
    ...configObj,
    repo_policies: rulesList,
  };
  fs.mkdirSync(path.dirname(resolvedConfigPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(resolvedConfigPath, JSON.stringify(nextConfig, null, 2) + "\n", { mode: 0o600 });

  return resolveRepoPolicy(repoRoot, {
    configPath: resolvedConfigPath,
    homeDir: resolvedHome,
    env,
  });
}

export function policyHelpText() {
  return [
    "Usage: ork policy [show|deny|allow|reset] [targets...] [options]",
    "",
    "Manage per-repository harness and account denylist policies.",
    "",
    "Subcommands:",
    "  show                    Show effective policy for the repository (default)",
    "  deny <target...>        Deny one or more harnesses/accounts (e.g. claude-work, plaude, opencode, codex, agy)",
    "  allow <target...>       Remove one or more harnesses/accounts from the repository denylist",
    "  reset                   Remove all denylist rules matching the repository (or --match pattern)",
    "",
    "Options:",
    "  --cwd <dir>             Target repository directory (default: current directory)",
    "  --match <pattern>       Path, glob, or git remote pattern for the rule (default: repo root)",
    "  --json                  Output structured JSON (schema: ork.policy.v1)",
    "  --help, -h              Show this help message",
  ].join("\n");
}

export function runPolicyCli(argv = [], io = {}) {
  const args = Array.isArray(argv) ? [...argv] : [];
  const stdout = io.stdout || process.stdout;
  let action = null;
  const targets = [];
  let cwd = io.cwd || process.cwd();
  let match = null;
  let isJson = false;
  let isHelp = false;

  for (let i = 0; i < args.length; i += 1) {
    const token = String(args[i] ?? "");
    if (token === "--help" || token === "-h") {
      isHelp = true;
    } else if (token === "--json") {
      isJson = true;
    } else if (token === "--cwd" || token.startsWith("--cwd=")) {
      const raw = token.includes("=") ? token.slice("--cwd=".length) : args[++i];
      if (!raw) {
        const err = new Error("Missing value for --cwd");
        err.exitCode = 2;
        throw err;
      }
      cwd = path.resolve(String(raw));
    } else if (token === "--match" || token.startsWith("--match=")) {
      const raw = token.includes("=") ? token.slice("--match=".length) : args[++i];
      if (!raw) {
        const err = new Error("Missing value for --match");
        err.exitCode = 2;
        throw err;
      }
      match = String(raw);
    } else if (token.startsWith("-")) {
      const err = new Error(`Unknown policy option: ${token}`);
      err.exitCode = 2;
      throw err;
    } else {
      if (action === null && ["show", "deny", "allow", "reset"].includes(token)) {
        action = token;
      } else {
        targets.push(token);
      }
    }
  }

  if (isHelp) {
    if (!io.silent && stdout?.write) {
      stdout.write(policyHelpText() + "\n");
    }
    return { schema: POLICY_SCHEMA, action: "help", help: true, exitCode: 0 };
  }

  const resolvedAction = action || "show";
  let result;
  switch (resolvedAction) {
    case "show": {
      result = resolveRepoPolicy(cwd, io);

      break;
    }
    case "deny": {
      if (targets.length === 0) {
        const err = new Error("ork policy deny requires at least one harness/account target");
        err.exitCode = 2;
        throw err;
      }
      result = setRepoPolicyDeny(cwd, targets, { mode: "add", match, ...io });

      break;
    }
    case "allow": {
      if (targets.length === 0) {
        const err = new Error("ork policy allow requires at least one harness/account target");
        err.exitCode = 2;
        throw err;
      }
      result = setRepoPolicyDeny(cwd, targets, { mode: "remove", match, ...io });

      break;
    }
    case "reset": {
      result = setRepoPolicyDeny(cwd, [], { mode: "reset", match, ...io });

      break;
    }
    // No default
  }

  const payload = { ...result, action: resolvedAction, exitCode: 0 };
  if (!io.silent && stdout?.write) {
    if (isJson) {
      stdout.write(JSON.stringify(payload, null, 2) + "\n");
    } else {
      stdout.write(
        [
          `Repository policy (${payload.repo})`,
          `  Remote: ${payload.remote || "(none)"}`,
          `  Denied: ${payload.deny.length > 0 ? payload.deny.join(", ") : "(none)"}`,
          `  Allowed harnesses: ${payload.allowedHarnesses.join(", ") || "(none)"}`,
        ].join("\n") + "\n",
      );
    }
  }
  return payload;
}

export const policyCommand = runPolicyCli;
export default runPolicyCli;
