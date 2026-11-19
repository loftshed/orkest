import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const POLICY_SCHEMA = "ork.policy.v1";
export const CANONICAL_HARNESSES = ["codex", "agy", "claude", "opencode"];
const CANONICAL_HARNESS_SET = new Set(CANONICAL_HARNESSES);
const RESERVED_ROUTE_ALIAS_NAMES = new Set([
  ...CANONICAL_HARNESS_SET,
  "gemini",
  "antigravity",
  "all",
]);
const TRANSPORT_BILLING_WORDS = new Set(["subscription", "api", "unknown", "oauth"]);
export const DENY_KEYS = [
  "deny",
  "denied",
  "denied_harnesses",
  "deniedHarnesses",
  "denied_engines",
];

export const TOKEN_ALIASES = {
  codex: "codex",
  openai: "codex",
  agy: "agy",
  gemini: "agy",
  antigravity: "agy",
  opencode: "opencode",
  openrouter: "opencode",
  claude: "claude",
  anthropic: "claude",
  "claude-all": "claude",
  claude_all: "claude",
  "all-claude": "claude",
  "claude-work": "claude-work",
  claude_work: "claude-work",
  "work-claude": "claude-work",
  "claude-personal": "claude-personal",
  claude_personal: "claude-personal",
  "personal-claude": "claude-personal",
};

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function normalizeDenyToken(token) {
  if (typeof token !== "string") {
    return "";
  }
  const cleaned = token.trim().toLowerCase();
  if (!cleaned) {
    return "";
  }
  if (Object.hasOwn(TOKEN_ALIASES, cleaned)) {
    return TOKEN_ALIASES[cleaned];
  }
  const colonIdx = cleaned.indexOf(":");
  if (colonIdx !== -1) {
    const prefix = cleaned.slice(0, colonIdx).trim();
    const rest = cleaned.slice(colonIdx + 1).trim();
    if (["tag", "category", "account"].includes(prefix)) {
      return rest ? `${prefix}:${rest}` : "";
    }
    const mappedPrefix = Object.hasOwn(TOKEN_ALIASES, prefix) ? TOKEN_ALIASES[prefix] : prefix;
    if (CANONICAL_HARNESS_SET.has(mappedPrefix)) {
      return rest ? `${mappedPrefix}:${rest}` : mappedPrefix;
    }
  }
  return cleaned;
}

export function normalizeAccountTags(account) {
  if (!isPlainObject(account)) {
    return [];
  }
  const tags = [];
  const seen = new Set();
  const addTag = (raw) => {
    if (typeof raw !== "string") {
      return;
    }
    const cleaned = raw.trim().toLowerCase();
    if (!cleaned || seen.has(cleaned)) {
      return;
    }
    seen.add(cleaned);
    tags.push(cleaned);
  };

  if (Array.isArray(account.tags)) {
    for (const item of account.tags) {
      addTag(item);
    }
  } else if (typeof account.tags === "string") {
    for (const item of account.tags.split(",")) {
      addTag(item);
    }
  }

  if (typeof account.category === "string") {
    addTag(account.category);
  }

  if (typeof account.billing === "string") {
    const billing = account.billing.trim().toLowerCase();
    if (billing && !TRANSPORT_BILLING_WORDS.has(billing)) {
      addTag(billing);
    }
  }

  return tags;
}

function canonicalizePath(targetPath) {
  const raw = String(targetPath ?? "");
  if (!raw) {
    try {
      return fs.realpathSync(process.cwd());
    } catch {
      return path.resolve(".");
    }
  }
  try {
    return fs.realpathSync(raw);
  } catch {
    const isAbs = path.isAbsolute(raw);
    let current;
    try {
      current = isAbs ? fs.realpathSync("/") : fs.realpathSync(process.cwd());
    } catch {
      current = isAbs ? "/" : process.cwd();
    }
    const suffix = [];
    for (const part of raw.split(/[\\/]+/u)) {
      if (!part || part === ".") {
        continue;
      }
      if (part === "..") {
        if (suffix.length > 0) {
          suffix.pop();
        } else {
          const parent = path.dirname(current);
          if (parent !== current) {
            try {
              current = fs.realpathSync(parent);
            } catch {
              current = parent;
            }
          }
        }
        continue;
      }
      if (suffix.length === 0) {
        const candidate = current === "/" ? `/${part}` : path.join(current, part);
        try {
          current = fs.realpathSync(candidate);
        } catch {
          suffix.push(part);
        }
      } else {
        suffix.push(part);
      }
    }
    return suffix.length > 0 ? path.join(current, ...suffix) : current;
  }
}

function existingDirectoryAncestor(targetPath) {
  let current = canonicalizePath(targetPath);
  for (;;) {
    try {
      if (fs.existsSync(current) && fs.statSync(current).isDirectory()) {
        return current;
      }
    } catch {
      // Keep walking upward if stat fails.
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return current;
    }
    current = parent;
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
  if (text === "~/") {
    return homeDir === "/" ? "/" : `${homeDir.replace(/\/+$/, "")}/`;
  }
  if (text.startsWith("~/")) {
    const base = homeDir.replace(/\/+$/, "");
    return `${base}/${text.slice(2)}`;
  }
  return text;
}

function resolveHomeDir(options = {}) {
  const env = options.env || process.env;
  const rawHome = options.homeDir || env.HOME || os.homedir();
  return path.resolve(expandHome(rawHome, os.homedir()));
}

function isNonGitRepoError(res) {
  if (!res || res.error || res.signal) {
    return false;
  }
  const stderr = String(res.stderr || "").toLowerCase();
  return res.status === 128 && stderr.includes("not a git repository");
}

function isMissingGitConfigKey(res) {
  if (!res || res.error || res.signal) {
    return false;
  }
  const stderr = String(res.stderr || "").trim();
  return res.status === 1 && stderr === "";
}

function formatGitLookupError(res, fallback) {
  if (res?.error) {
    return res.error.message || res.error.code || fallback;
  }
  if (res?.signal) {
    return `terminated by signal ${res.signal}`;
  }
  const stderr = String(res?.stderr || "").trim();
  if (stderr) {
    return stderr;
  }
  return `git exited with status ${res?.status ?? "unknown"}`;
}

export function resolveRepoRoot(cwd = process.cwd(), options = {}) {
  const homeDir = resolveHomeDir(options);
  const rawCwd = String(cwd || process.cwd());
  const expandedCwd = rawCwd.trimStart().startsWith("~") ? expandHome(rawCwd, homeDir) : rawCwd;
  const resolvedCwd = canonicalizePath(expandedCwd);
  const targetDir = existingDirectoryAncestor(resolvedCwd);
  const runSync = typeof options.spawnSync === "function" ? options.spawnSync : spawnSync;
  const res = runSync("git", ["-C", targetDir, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    timeout: 3000,
  });
  if (res && !res.error && !res.signal && res.status === 0 && res.stdout && res.stdout.trim()) {
    return canonicalizePath(res.stdout.trim());
  }
  if (isNonGitRepoError(res)) {
    return resolvedCwd;
  }
  if (options.strict) {
    throw new Error(
      `Failed to resolve git repository root for ${targetDir}: ${formatGitLookupError(res, "git rev-parse failed")}`,
    );
  }
  return resolvedCwd;
}

export function resolveGitRemote(repoRoot, options = {}) {
  const runSync = typeof options.spawnSync === "function" ? options.spawnSync : spawnSync;
  const res = runSync("git", ["-C", repoRoot, "config", "--get", "remote.origin.url"], {
    encoding: "utf8",
    timeout: 3000,
  });
  if (res && !res.error && !res.signal && res.status === 0) {
    return String(res.stdout || "").trim();
  }
  if (isMissingGitConfigKey(res) || isNonGitRepoError(res)) {
    return "";
  }
  if (options.strict) {
    throw new Error(
      `Failed to resolve git remote for ${repoRoot}: ${formatGitLookupError(res, "git config failed")}`,
    );
  }
  return "";
}

export function resolvePolicyConfigPath(options = {}) {
  const env = options.env || process.env;
  const homeDir = resolveHomeDir(options);
  if (options.configPath) {
    return path.resolve(expandHome(options.configPath, homeDir));
  }
  const explicitFile = env.ORCHESTRATE_CONFIG || env.AGENT_EXECUTOR_CONFIG;
  if (explicitFile) {
    return path.resolve(expandHome(explicitFile, homeDir));
  }
  const xdgConfig = path.resolve(
    expandHome(
      options.xdgConfigHome || env.XDG_CONFIG_HOME || path.join(homeDir, ".config"),
      homeDir,
    ),
  );
  const orchestrateCfg = path.join(xdgConfig, "orchestrate", "config.json");
  const legacyCfg = path.join(xdgConfig, "agent-executor", "config.json");
  if (fs.existsSync(orchestrateCfg) || !fs.existsSync(legacyCfg)) {
    return orchestrateCfg;
  }
  return legacyCfg;
}

function isMissingPolicyFileError(filePath, error) {
  if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") {
    return false;
  }
  const parentDir = path.dirname(filePath);
  try {
    const stat = fs.lstatSync(parentDir);
    if (error?.code === "ENOTDIR" && !stat.isDirectory()) {
      return false;
    }
    return error?.code === "ENOENT";
  } catch (parentError) {
    return parentError?.code === "ENOENT";
  }
}

function loadJsonObject(filePath, { isStrict = false } = {}) {
  if (!filePath) {
    return {};
  }
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (isMissingPolicyFileError(filePath, error)) {
      return {};
    }
    if (isStrict) {
      throw new Error(`Failed to read policy JSON in ${filePath}: ${error.message}`, {
        cause: error,
      });
    }
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    if (isPlainObject(parsed)) {
      return parsed;
    }
    if (isStrict) {
      throw new Error(`Invalid policy JSON object in ${filePath}`);
    }
    return {};
  } catch (error) {
    if (isStrict) {
      throw new Error(`Failed to parse policy JSON in ${filePath}: ${error.message}`, {
        cause: error,
      });
    }
    return {};
  }
}

function ruleDisplayName(rule, fallback) {
  if (isPlainObject(rule)) {
    const selector = rule.path || rule.repo || rule.remote || rule.match || rule.pattern;
    if (selector !== undefined && selector !== null && String(selector).trim()) {
      return String(selector);
    }
  }
  return String(fallback);
}

function validateDenyArray(list, label) {
  if (!Array.isArray(list)) {
    throw new TypeError(`Invalid rule ${label}: expected array`);
  }
  for (const [idx, item] of list.entries()) {
    if (typeof item !== "string" || !item.trim()) {
      throw new Error(`Invalid rule ${label}[${idx}]: expected non-empty string`);
    }
  }
}

function validatePolicyContainer(container, source, { isStrict = false } = {}) {
  if (!isStrict) {
    return;
  }
  if (!isPlainObject(container)) {
    throw new Error(`Invalid policy container in ${source}: expected JSON object`);
  }
  for (const key of DENY_KEYS) {
    if (container[key] !== undefined) {
      validateDenyArray(container[key], `'${key}' in ${source}`);
    }
  }
  for (const policiesKey of ["repo_policies", "repoPolicies"]) {
    const rawPolicies = container[policiesKey];
    if (rawPolicies === undefined || rawPolicies === null) {
      continue;
    }
    if (Array.isArray(rawPolicies)) {
      for (const [idx, entry] of rawPolicies.entries()) {
        if (!isPlainObject(entry)) {
          throw new Error(`Invalid rule [${idx}] in ${source}.${policiesKey}: expected object`);
        }
        const name = ruleDisplayName(entry, `[${idx}]`);
        for (const denyKey of DENY_KEYS) {
          if (entry[denyKey] !== undefined) {
            validateDenyArray(
              entry[denyKey],
              `'${denyKey}' for rule ${JSON.stringify(name)} in ${source}.${policiesKey}`,
            );
          }
        }
      }
      continue;
    }
    if (isPlainObject(rawPolicies)) {
      for (const [ruleKey, value] of Object.entries(rawPolicies)) {
        if (Array.isArray(value)) {
          validateDenyArray(
            value,
            `shorthand entry ${JSON.stringify(ruleKey)} in ${source}.${policiesKey}`,
          );
          continue;
        }
        if (!isPlainObject(value)) {
          throw new Error(
            `Invalid rule map entry ${JSON.stringify(ruleKey)} in ${source}.${policiesKey}: expected array or object`,
          );
        }
        const name = ruleDisplayName(value, ruleKey);
        for (const denyKey of DENY_KEYS) {
          if (value[denyKey] !== undefined) {
            validateDenyArray(
              value[denyKey],
              `'${denyKey}' for rule ${JSON.stringify(name)} in ${source}.${policiesKey}`,
            );
          }
        }
      }
      continue;
    }
    throw new Error(`Invalid '${policiesKey}' in ${source}: expected array or object`);
  }
}

function escapeRegExpChar(ch) {
  return String.raw`\^$+?.()|{}[]`.includes(ch) ? `\\${ch}` : ch;
}

function parseGlobCharClass(globPattern, startIndex) {
  const length = globPattern.length;
  let end = startIndex;
  if (end < length && globPattern[end] === "!") {
    end += 1;
  }
  if (end < length && globPattern[end] === "]") {
    end += 1;
  }
  while (end < length && globPattern[end] !== "]") {
    end += 1;
  }
  if (end >= length) {
    return { fragment: String.raw`\[`, nextIndex: startIndex };
  }
  let stuff = globPattern.slice(startIndex, end);
  if (stuff.includes("-")) {
    const chunks = [];
    let pos = startIndex;
    let k = pos + (globPattern[pos] === "!" ? 2 : 1);
    for (;;) {
      const dash = globPattern.indexOf("-", k);
      if (dash === -1 || dash >= end) {
        break;
      }
      chunks.push(globPattern.slice(pos, dash));
      pos = dash + 1;
      k = dash + 3;
    }
    const tail = globPattern.slice(pos, end);
    if (tail) {
      chunks.push(tail);
    } else {
      chunks[chunks.length - 1] += "-";
    }
    // Mirror Python fnmatch._translate: drop reversed ranges (e.g. [z-a1] -> [1], [z-a] -> (?!)).
    for (let idx = chunks.length - 1; idx > 0; idx -= 1) {
      const leftChars = [...chunks[idx - 1]];
      const rightChars = [...chunks[idx]];
      if (leftChars.at(-1).codePointAt(0) <= rightChars[0].codePointAt(0)) {
        continue;
      }
      chunks[idx - 1] = leftChars.slice(0, -1).join("") + rightChars.slice(1).join("");
      chunks.splice(idx, 1);
    }
    stuff = chunks
      .map((part) => part.replaceAll("\\", String.raw`\\`).replaceAll("-", String.raw`\-`))
      .join("-");
  } else {
    stuff = stuff.replaceAll("\\", String.raw`\\`);
  }
  if (!stuff) {
    return { fragment: "(?!)", nextIndex: end + 1 };
  }
  if (stuff === "!") {
    return { fragment: ".", nextIndex: end + 1 };
  }
  stuff = stuff.replaceAll("]", String.raw`\]`);
  if (stuff.startsWith("!")) {
    stuff = `^${stuff.slice(1)}`;
  } else if (stuff.startsWith("^")) {
    stuff = String.raw`\^` + stuff.slice(1);
  }
  return { fragment: `[${stuff}]`, nextIndex: end + 1 };
}

function translateGlobToken(globPattern, index) {
  const ch = globPattern[index];
  switch (ch) {
    case "*": {
      return { fragment: ".*", nextIndex: index + 1 };
    }
    case "?": {
      return { fragment: ".", nextIndex: index + 1 };
    }
    case "[": {
      return parseGlobCharClass(globPattern, index + 1);
    }
    default: {
      return { fragment: escapeRegExpChar(ch), nextIndex: index + 1 };
    }
  }
}

function globToRegExp(globPattern) {
  let index = 0;
  const length = globPattern.length;
  let regexStr = "^";
  while (index < length) {
    const step = translateGlobToken(globPattern, index);
    regexStr += step.fragment;
    index = step.nextIndex;
  }
  regexStr += "$";
  try {
    return new RegExp(regexStr, "su");
  } catch {
    return null;
  }
}

function globMatch(value, pattern) {
  const re = globToRegExp(pattern);
  return re ? re.test(value) : false;
}

function canonicalizeGlobPath(absPattern) {
  const globMatchIdx = /[*?[]/u.exec(absPattern)?.index ?? -1;
  if (globMatchIdx === -1) {
    return canonicalizePath(absPattern);
  }
  const literalPart = absPattern.slice(0, globMatchIdx);
  const lastSlash = literalPart.lastIndexOf("/");
  const dirPrefix = lastSlash <= 0 ? "/" : literalPart.slice(0, lastSlash);
  const globSuffix = absPattern.slice(lastSlash + 1);
  const canonDir = canonicalizePath(dirPrefix);
  return canonDir === "/" ? `/${globSuffix}` : `${canonDir}/${globSuffix}`;
}

function matchesLiteralPrefix(repoStr, prefix) {
  if (prefix === "/") {
    return repoStr.startsWith("/");
  }
  return repoStr === prefix || repoStr.startsWith(`${prefix}/`);
}

function matchesPathPattern(repoRoot, rawPattern, homeDir = os.homedir()) {
  const expanded = expandHome(rawPattern, homeDir);
  if (!expanded) {
    return false;
  }
  const repoStr = String(repoRoot);
  if (path.isAbsolute(expanded)) {
    // Check exact literal equality / directory prefix BEFORE any glob evaluation
    // so literal directory names containing '[', '?', or '*' (e.g. project[1]) still match.
    if (expanded.length > 1 && expanded.endsWith("/")) {
      const literalPrefix = canonicalizePath(expanded.replace(/\/+$/, "") || "/");
      if (matchesLiteralPrefix(repoStr, literalPrefix)) {
        return true;
      }
    } else if (expanded.endsWith("/*")) {
      const literalPrefix = canonicalizePath(expanded.slice(0, -2) || "/");
      if (matchesLiteralPrefix(repoStr, literalPrefix)) {
        return true;
      }
    } else if (repoStr === canonicalizePath(expanded)) {
      return true;
    }

    const hasGlob = /[*?[]/u.test(expanded);
    if (!hasGlob) {
      return false;
    }
    const canonPattern = canonicalizeGlobPath(expanded);
    if (canonPattern.endsWith("/*")) {
      const prefixPattern = canonPattern.slice(0, -2) || "/";
      if (!/[*?[]/u.test(prefixPattern)) {
        return matchesLiteralPrefix(repoStr, prefixPattern);
      }
      return globMatch(repoStr, prefixPattern) || globMatch(repoStr, canonPattern);
    }
    if (canonPattern.length > 1 && canonPattern.endsWith("/")) {
      const prefixPattern = canonPattern.replace(/\/+$/, "") || "/";
      const descPattern = prefixPattern === "/" ? "/*" : `${prefixPattern}/*`;
      return globMatch(repoStr, prefixPattern) || globMatch(repoStr, descPattern);
    }
    return globMatch(repoStr, canonPattern);
  }

  const rawRel = expanded.replaceAll(path.sep, "/");
  const hadTrailingSlash = rawRel.endsWith("/");
  let rel = path.posix.normalize(rawRel);
  if (rel === "." || rel === "./") {
    return true;
  }
  if (hadTrailingSlash && rel !== "/" && !rel.endsWith("/")) {
    rel += "/";
  }
  if (!rel.includes("/")) {
    if (path.basename(repoStr) === rel) {
      return true;
    }
    return globMatch(path.basename(repoStr), rel);
  }
  if (rel.endsWith("/*") || rel.endsWith("/")) {
    const relPrefix = (rel.endsWith("/*") ? rel.slice(0, -2) : rel).replace(/\/+$/, "");
    if (!relPrefix) {
      return false;
    }
    if (repoStr.endsWith(`/${relPrefix}`) || repoStr.includes(`/${relPrefix}/`)) {
      return true;
    }
    return globMatch(repoStr, `*/${relPrefix}`) || globMatch(repoStr, `*/${relPrefix}/*`);
  }
  if (repoStr.endsWith(`/${rel}`)) {
    return true;
  }
  return globMatch(repoStr, `*/${rel}`);
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
  return Boolean(rem.includes(pat) || globMatch(rem, pat) || globMatch(rem, `*${pat}`));
}

function hasRuleSelector(rule) {
  return Boolean(rule.path || rule.repo || rule.remote || rule.match || rule.pattern);
}

function normalizeRulesList(rawPolicies, source) {
  const rules = [];
  if (Array.isArray(rawPolicies)) {
    for (const entry of rawPolicies) {
      if (isPlainObject(entry)) {
        rules.push({ ...entry, source });
      }
    }
  } else if (isPlainObject(rawPolicies)) {
    for (const [key, value] of Object.entries(rawPolicies)) {
      if (Array.isArray(value)) {
        rules.push({ match: String(key), deny: [...value], source });
      } else if (isPlainObject(value)) {
        const rule = { ...value, source };
        if (!hasRuleSelector(rule)) {
          rule.match = String(key);
        }
        rules.push(rule);
      }
    }
  }
  return rules;
}

function collectRuleDenyTokens(rule) {
  if (!isPlainObject(rule)) {
    return null;
  }
  let hasDenyList = false;
  const tokens = [];
  const seen = new Set();
  for (const key of DENY_KEYS) {
    const list = rule[key];
    if (!Array.isArray(list)) {
      continue;
    }
    hasDenyList = true;
    for (const rawItem of list) {
      const norm = normalizeDenyToken(rawItem);
      if (!norm || seen.has(norm)) {
        continue;
      }
      seen.add(norm);
      tokens.push(norm);
    }
  }
  return hasDenyList ? tokens : null;
}

function ruleMatchesRepo(
  rule,
  repoRoot,
  remoteUrl,
  { homeDir = os.homedir(), defaultMatchAll = false } = {},
) {
  const pathPat = rule.path || rule.repo;
  if (rule.literalRoot && pathPat) {
    return String(repoRoot) === String(pathPat);
  }
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
  const isStrict = Boolean(options.strict);
  const homeDir = resolveHomeDir(options);
  const repoRoot = options.repoRoot
    ? canonicalizePath(options.repoRoot)
    : resolveRepoRoot(cwd, {
        homeDir,
        env: options.env,
        strict: isStrict,
        spawnSync: options.spawnSync,
      });
  const remoteUrl =
    options.remote === undefined
      ? resolveGitRemote(repoRoot, { strict: isStrict, spawnSync: options.spawnSync })
      : String(options.remote || "");

  let configData;
  let configSource;
  if (options.config === undefined) {
    const cfgPath = resolvePolicyConfigPath({ ...options, homeDir });
    configData = loadJsonObject(cfgPath, { isStrict });
    configSource = cfgPath;
  } else {
    if (isPlainObject(options.config)) {
      configData = options.config;
    } else {
      if (isStrict) {
        throw new Error("Invalid policy config: expected object");
      }
      configData = {};
    }
    configSource = "config";
  }
  validatePolicyContainer(configData, configSource, { isStrict });

  const candidateRules = [];
  for (const key of ["repo_policies", "repoPolicies"]) {
    if (!configData || configData[key] === undefined) {
      continue;
    }
    const rules = normalizeRulesList(configData[key], configSource);
    for (const rule of rules) {
      candidateRules.push({ rule, defaultMatchAll: false });
    }
  }

  const repoLocalPath = path.join(repoRoot, ".orkest", "policy.json");
  const repoLocal = loadJsonObject(repoLocalPath, { isStrict });
  validatePolicyContainer(repoLocal, repoLocalPath, { isStrict });
  const localTopTokens = collectRuleDenyTokens(repoLocal);
  if (localTopTokens !== null) {
    candidateRules.push({
      rule: { path: repoRoot, deny: localTopTokens, source: repoLocalPath, literalRoot: true },
      defaultMatchAll: true,
    });
  }
  for (const key of ["repo_policies", "repoPolicies"]) {
    if (repoLocal[key] === undefined) {
      continue;
    }
    const localRules = normalizeRulesList(repoLocal[key], repoLocalPath);
    for (const rule of localRules) {
      candidateRules.push({ rule, defaultMatchAll: true });
    }
  }

  const matchedRules = [];
  const denyTokens = [];
  const seenDeny = new Set();

  for (const { rule, defaultMatchAll } of candidateRules) {
    if (!ruleMatchesRepo(rule, repoRoot, remoteUrl, { homeDir, defaultMatchAll })) {
      continue;
    }
    const normalizedRuleDeny = collectRuleDenyTokens(rule);
    if (normalizedRuleDeny === null) {
      continue;
    }
    for (const norm of normalizedRuleDeny) {
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
  if (!denySet.has("all")) {
    for (const harness of CANONICAL_HARNESSES) {
      if (!denySet.has(harness)) {
        allowedHarnesses.push(harness);
      }
    }
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

function classifyFamilyFromText(text) {
  if (!text) {
    return "";
  }
  if (text.includes("opencode") || text.includes("openrouter")) {
    return "opencode";
  }
  if (text.includes("codex") || text.includes("openai") || text.includes("chatgpt")) {
    return "codex";
  }
  if (text.includes("agy") || text.includes("gemini") || text.includes("antigravity")) {
    return "agy";
  }
  if (text.includes("claude") || text.includes("anthropic")) {
    return "claude";
  }
  return "";
}

export function classifyHarnessTarget(target) {
  if (typeof target === "string") {
    return normalizeDenyToken(target);
  }
  if (!target || typeof target !== "object") {
    return "";
  }
  const provider = String(target.provider || "")
    .trim()
    .toLowerCase();
  const engine = String(target.engine || target.harness || "")
    .trim()
    .toLowerCase();
  const id = String(target.id || "")
    .trim()
    .toLowerCase();
  const accountId = String(target.accountId || "")
    .trim()
    .toLowerCase();
  const route = String(target.route || "")
    .trim()
    .toLowerCase();
  const configDir = String(target.configDir || target.claudeConfigDir || "")
    .trim()
    .toLowerCase();
  const label = String(target.label || "")
    .trim()
    .toLowerCase();

  // Authoritative engine/provider fields take precedence over descriptive id/route text.
  let family = classifyFamilyFromText(engine) || classifyFamilyFromText(provider);
  if (!family) {
    const descriptive = [id, accountId, route].filter(Boolean).join(" ");
    family = classifyFamilyFromText(descriptive);
  }
  if (!family && (configDir.includes("claude") || label.includes("claude"))) {
    family = "claude";
  }
  if (family) {
    return family;
  }
  return normalizeDenyToken(engine || provider || id || accountId);
}

function resolveMonitorConfigPath(options = {}) {
  const env = options.env || process.env;
  const homeDir = resolveHomeDir(options);
  if (options.monitorConfigPath) {
    return path.resolve(expandHome(options.monitorConfigPath, homeDir));
  }
  if (env.MONITOR_CONFIG) {
    return path.resolve(expandHome(env.MONITOR_CONFIG, homeDir));
  }
  return path.join(homeDir, ".config", "monitor", "config.json");
}

function resolveAccountDirPath(rawValue, baseHome) {
  if (typeof rawValue !== "string" || !rawValue.trim()) {
    return "";
  }
  const expanded = expandHome(rawValue.trim(), baseHome);
  const absPath = path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(baseHome, expanded);
  return canonicalizePath(absPath);
}

function getAccountAliases(account) {
  const aliases = [];
  const seen = new Set();
  const addAlias = (val) => {
    if (typeof val !== "string") {
      return;
    }
    const cleaned = val.trim().toLowerCase();
    if (!cleaned || seen.has(cleaned)) {
      return;
    }
    seen.add(cleaned);
    aliases.push(cleaned);
  };
  addAlias(account?.alias);
  if (Array.isArray(account?.aliases)) {
    for (const item of account.aliases) {
      addAlias(item);
    }
  }
  if (typeof account?.route === "string") {
    const routeTok = account.route.trim();
    if (
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(routeTok) &&
      !RESERVED_ROUTE_ALIAS_NAMES.has(routeTok.toLowerCase())
    ) {
      addAlias(routeTok);
    }
  }
  return aliases;
}

function firstNonEmptyString(...values) {
  for (const val of values) {
    if (typeof val === "string" && val.trim()) {
      return val.trim();
    }
  }
  return "";
}

function mergeGlobalAccountEnv(globalEnv, entry) {
  const mergedEnv = {};
  for (const mapping of [globalEnv, entry.env]) {
    if (!isPlainObject(mapping)) {
      continue;
    }
    for (const [key, value] of Object.entries(mapping)) {
      if (value === null) {
        delete mergedEnv[key];
      } else if (typeof value === "string" && value.trim()) {
        mergedEnv[key] = value.trim();
      }
    }
  }
  const next = { ...entry, tags: normalizeAccountTags(entry) };
  if (Object.keys(mergedEnv).length > 0) {
    next.env = mergedEnv;
  } else {
    delete next.env;
  }
  return next;
}

export function loadConfiguredAccounts(options = {}) {
  const isStrict = Boolean(options.strict);
  let rawAccounts;
  let globalEnv = null;
  if (
    isPlainObject(options.config) &&
    Object.hasOwn(options.config, "accounts") &&
    options.config.accounts !== undefined
  ) {
    globalEnv = isPlainObject(options.config.env) ? options.config.env : null;
    if (Array.isArray(options.config.accounts)) {
      rawAccounts = options.config.accounts;
    } else {
      if (isStrict) {
        throw new Error("Invalid accounts list in Monitor config: expected array");
      }
      rawAccounts = [];
    }
  } else {
    const cfgPath = resolveMonitorConfigPath(options);
    const parsed = loadJsonObject(cfgPath, { isStrict });
    if (isPlainObject(parsed.env)) {
      globalEnv = parsed.env;
    } else if (isPlainObject(options.config?.env)) {
      globalEnv = options.config.env;
    }
    if (Object.hasOwn(parsed, "accounts") && parsed.accounts !== undefined) {
      if (Array.isArray(parsed.accounts)) {
        rawAccounts = parsed.accounts;
      } else {
        if (isStrict) {
          throw new Error(`Invalid accounts list in Monitor config ${cfgPath}: expected array`);
        }
        rawAccounts = [];
      }
    } else {
      rawAccounts = [];
    }
  }
  return rawAccounts
    .filter((entry) => isPlainObject(entry))
    .map((entry) => mergeGlobalAccountEnv(globalEnv, entry));
}

function deriveEffectiveAgyProfile(
  agyHomeRaws,
  appDataRaws,
  baseHome,
  { fallbackToDefault = false, inferBasename = false } = {},
) {
  const agyHomesList = Array.isArray(agyHomeRaws) ? agyHomeRaws : [agyHomeRaws];
  const appDataList = Array.isArray(appDataRaws) ? appDataRaws : [appDataRaws];
  const exactPaths = new Set();
  let firstAgyHome = "";
  let firstAppData = "";

  for (const raw of agyHomesList) {
    const resolved = resolveAccountDirPath(raw, baseHome);
    if (!resolved) {
      continue;
    }
    exactPaths.add(resolved);
    if (!firstAgyHome) {
      firstAgyHome = resolved;
    }
  }
  for (const raw of appDataList) {
    const resolved = resolveAccountDirPath(raw, baseHome);
    if (!resolved) {
      continue;
    }
    exactPaths.add(resolved);
    if (!firstAppData) {
      firstAppData = resolved;
    }
  }

  if (exactPaths.size === 0 && fallbackToDefault) {
    exactPaths.add(canonicalizePath(path.join(baseHome, ".gemini")));
  }

  let effectiveAppData = "";
  if (firstAppData) {
    effectiveAppData = firstAppData;
  } else if (firstAgyHome) {
    effectiveAppData =
      inferBasename && path.basename(firstAgyHome).toLowerCase().startsWith("antigravity")
        ? firstAgyHome
        : canonicalizePath(path.join(firstAgyHome, "antigravity-cli"));
  } else if (fallbackToDefault) {
    effectiveAppData = canonicalizePath(path.join(baseHome, ".gemini", "antigravity-cli"));
  }

  const fallbackParents = new Set();
  for (const candidatePath of [...exactPaths, ...(effectiveAppData ? [effectiveAppData] : [])]) {
    const base = path.basename(candidatePath).toLowerCase();
    if (base === "antigravity" || base === "antigravity-cli") {
      fallbackParents.add(canonicalizePath(path.dirname(candidatePath)));
    }
  }

  return {
    exactPaths,
    effectiveAppData,
    hasExplicitAppData: Boolean(firstAppData),
    fallbackParents,
  };
}

function describeConfiguredAccountPaths(account, homeDir) {
  const envObj = isPlainObject(account.env) ? account.env : {};
  const envHome = resolveAccountDirPath(envObj.HOME, homeDir);
  const baseHome = envHome || canonicalizePath(homeDir);
  const family = classifyFamilyFromText(
    String(account.provider || "")
      .trim()
      .toLowerCase(),
  );

  const claudeRaw = firstNonEmptyString(
    account.claudeConfigDir,
    account.claude_config_dir,
    account.configDir,
    envObj.CLAUDE_CONFIG_DIR,
  );
  let claudeDir = resolveAccountDirPath(claudeRaw, baseHome);
  if (!claudeDir && family === "claude") {
    claudeDir = canonicalizePath(path.join(baseHome, ".claude"));
  }

  const codexRaw = firstNonEmptyString(account.codexHome, account.codex_home, envObj.CODEX_HOME);
  let codexHome = resolveAccountDirPath(codexRaw, baseHome);
  if (!codexHome && family === "codex") {
    codexHome = canonicalizePath(path.join(baseHome, ".codex"));
  }

  const agyHome = firstNonEmptyString(account.agyHome, account.agy_home);
  const agyAppData = firstNonEmptyString(account.agyAppDataDir, account.agy_app_data_dir);
  const envGeminiHome = firstNonEmptyString(envObj.GEMINI_CLI_HOME);
  const envAppData = firstNonEmptyString(envObj.ANTIGRAVITY_APP_DATA_DIR);
  const hasLegacyUntypedAgyHome = Boolean(agyHome) && !envGeminiHome && !envAppData && !agyAppData;
  const agyProfile = deriveEffectiveAgyProfile(
    [agyHome, envGeminiHome],
    [agyAppData, envAppData],
    baseHome,
    { fallbackToDefault: family === "agy", inferBasename: hasLegacyUntypedAgyHome },
  );

  return {
    family,
    envHome,
    claudeDir,
    codexHome,
    agyExact: agyProfile.exactPaths,
    effectiveAgyAppData: agyProfile.effectiveAppData,
    hasExplicitAgyAppData: agyProfile.hasExplicitAppData,
    agyFallbackParents: agyProfile.fallbackParents,
  };
}

export function resolveConfiguredAccount(selectorOrPaths, options = {}) {
  const globalEnv = isPlainObject(options.config?.env) ? options.config.env : null;
  const accounts = Array.isArray(options.accounts)
    ? options.accounts
        .filter((entry) => isPlainObject(entry))
        .map((entry) => mergeGlobalAccountEnv(globalEnv, entry))
    : loadConfiguredAccounts(options);
  if (accounts.length === 0) {
    return null;
  }

  const homeDir = resolveHomeDir(options);
  const canonicalHome = canonicalizePath(homeDir);
  const idCandidates = new Set();
  const aliasCandidates = new Set();
  const claudeDirs = new Set();
  const codexHomes = new Set();
  const rawSelAgyHomes = [];
  const rawSelAgyAppData = [];
  const envHomes = new Set();
  const genericPaths = new Set();

  const addId = (val) => {
    if (typeof val !== "string") {
      return;
    }
    let cleaned = val.trim().toLowerCase();
    if (cleaned.startsWith("account:")) {
      cleaned = cleaned.slice("account:".length).trim();
    }
    if (cleaned) {
      idCandidates.add(cleaned);
    }
  };
  const addAlias = (val) => {
    if (typeof val !== "string") {
      return;
    }
    const cleaned = val.trim().toLowerCase();
    if (cleaned) {
      aliasCandidates.add(cleaned);
    }
  };
  const addPathToSet = (targetSet, raw) => {
    const resolved = resolveAccountDirPath(raw, canonicalHome);
    if (resolved) {
      targetSet.add(resolved);
    }
  };

  let providerFilter = classifyFamilyFromText(
    String(options.provider || "")
      .trim()
      .toLowerCase(),
  );
  addId(options.accountId);
  addAlias(options.accountAlias);
  addPathToSet(claudeDirs, options.claudeConfigDir);
  addPathToSet(codexHomes, options.codexHome);
  if (options.agyHome) {
    rawSelAgyHomes.push(options.agyHome);
  }
  if (options.agyAppDataDir) {
    rawSelAgyAppData.push(options.agyAppDataDir);
  }

  if (typeof selectorOrPaths === "string") {
    const rawStr = selectorOrPaths.trim();
    addId(rawStr);
    addAlias(rawStr);
    if (
      rawStr.includes("/") ||
      rawStr.includes("\\") ||
      rawStr.startsWith("~") ||
      rawStr.startsWith(".")
    ) {
      addPathToSet(genericPaths, rawStr);
    }
  } else if (isPlainObject(selectorOrPaths)) {
    const selProv = classifyFamilyFromText(
      String(selectorOrPaths.provider || selectorOrPaths.engine || selectorOrPaths.harness || "")
        .trim()
        .toLowerCase(),
    );
    if (!providerFilter && selProv) {
      providerFilter = selProv;
    }
    addId(selectorOrPaths.id);
    addId(selectorOrPaths.accountId);
    addAlias(selectorOrPaths.alias);
    addAlias(selectorOrPaths.accountAlias);
    const selEnv = isPlainObject(selectorOrPaths.env) ? selectorOrPaths.env : {};
    addPathToSet(
      claudeDirs,
      firstNonEmptyString(
        selectorOrPaths.claudeConfigDir,
        selectorOrPaths.claude_config_dir,
        selectorOrPaths.configDir,
        selEnv.CLAUDE_CONFIG_DIR,
      ),
    );
    addPathToSet(
      codexHomes,
      firstNonEmptyString(selectorOrPaths.codexHome, selectorOrPaths.codex_home, selEnv.CODEX_HOME),
    );
    for (const rawAgy of [
      selectorOrPaths.agyHome,
      selectorOrPaths.agy_home,
      selEnv.GEMINI_CLI_HOME,
    ]) {
      if (rawAgy) {
        rawSelAgyHomes.push(rawAgy);
      }
    }
    for (const rawAppData of [
      selectorOrPaths.agyAppDataDir,
      selectorOrPaths.agy_app_data_dir,
      selEnv.ANTIGRAVITY_APP_DATA_DIR,
    ]) {
      if (rawAppData) {
        rawSelAgyAppData.push(rawAppData);
      }
    }
    const selHome = resolveAccountDirPath(selectorOrPaths.home || selEnv.HOME, canonicalHome);
    if (selHome && selHome !== canonicalHome) {
      envHomes.add(selHome);
    }
  }

  let inferSelectorBasename;
  if (isPlainObject(selectorOrPaths) && selectorOrPaths.inferAgyBasename !== undefined) {
    inferSelectorBasename = Boolean(selectorOrPaths.inferAgyBasename);
  } else if (options.inferAgyBasename !== undefined) {
    inferSelectorBasename = Boolean(options.inferAgyBasename);
  } else if (isPlainObject(selectorOrPaths)) {
    const selEnv = isPlainObject(selectorOrPaths.env) ? selectorOrPaths.env : {};
    const hasUntypedAgyHome = Boolean(
      options.agyHome || selectorOrPaths.agyHome || selectorOrPaths.agy_home,
    );
    inferSelectorBasename = hasUntypedAgyHome || !selEnv.GEMINI_CLI_HOME;
  } else {
    inferSelectorBasename = Boolean(options.agyHome);
  }

  const selectorAgy = deriveEffectiveAgyProfile(rawSelAgyHomes, rawSelAgyAppData, canonicalHome, {
    inferBasename: inferSelectorBasename,
  });
  const agyHomes = selectorAgy.exactPaths;
  const genericAgy =
    rawSelAgyHomes.length === 0 && rawSelAgyAppData.length === 0 && genericPaths.size > 0
      ? deriveEffectiveAgyProfile([...genericPaths], [], canonicalHome, { inferBasename: true })
      : null;
  const selectorAppData = selectorAgy.effectiveAppData || genericAgy?.effectiveAppData || "";
  const hasExplicitSelectorAppData = selectorAgy.hasExplicitAppData;

  for (const acct of accounts) {
    const acctId = String(acct.id || "")
      .trim()
      .toLowerCase();
    if (acctId && idCandidates.has(acctId)) {
      return acct;
    }
  }
  for (const acct of accounts) {
    const aliases = getAccountAliases(acct);
    if (aliases.some((a) => aliasCandidates.has(a))) {
      return acct;
    }
  }

  const accountInfos = accounts.map((acct) => ({
    acct,
    info: describeConfiguredAccountPaths(acct, homeDir),
  }));

  // Pass 1: exact effective AGY app-data matches across all accounts first.
  if (selectorAppData) {
    for (const { acct, info } of accountInfos) {
      if (providerFilter && info.family && info.family !== providerFilter) {
        continue;
      }
      if (info.family === "agy" && info.effectiveAgyAppData === selectorAppData) {
        return acct;
      }
    }
  }

  // Pass 2: exact path matches (never matching an AGY account on shared GEMINI_CLI_HOME when explicit app-data differs).
  const matchesAgyExactPath = (info, candidatePath) => {
    if (!info.agyExact.has(candidatePath)) {
      return false;
    }
    if (hasExplicitSelectorAppData) {
      return selectorAppData === info.effectiveAgyAppData;
    }
    if (info.hasExplicitAgyAppData) {
      return candidatePath === info.effectiveAgyAppData;
    }
    return true;
  };

  for (const { acct, info } of accountInfos) {
    if (providerFilter && info.family && info.family !== providerFilter) {
      continue;
    }
    if (claudeDirs.size > 0 && info.family === "claude" && claudeDirs.has(info.claudeDir)) {
      return acct;
    }
    if (codexHomes.size > 0 && info.family === "codex" && codexHomes.has(info.codexHome)) {
      return acct;
    }
    if (
      agyHomes.size > 0 &&
      info.family === "agy" &&
      [...agyHomes].some((p) => matchesAgyExactPath(info, p))
    ) {
      return acct;
    }
    if (envHomes.size > 0 && info.envHome && envHomes.has(info.envHome)) {
      return acct;
    }
    if (
      genericPaths.size > 0 &&
      (genericPaths.has(info.claudeDir) ||
        genericPaths.has(info.codexHome) ||
        genericPaths.has(info.envHome) ||
        [...genericPaths].some((p) => matchesAgyExactPath(info, p)))
    ) {
      return acct;
    }
  }

  // Pass 3: fallback parent matches only for default container names ("antigravity", "antigravity-cli").
  if (!hasExplicitSelectorAppData) {
    for (const { acct, info } of accountInfos) {
      if (providerFilter && info.family && info.family !== providerFilter) {
        continue;
      }
      if (
        agyHomes.size > 0 &&
        info.family === "agy" &&
        [...agyHomes].some((p) => info.agyFallbackParents.has(p))
      ) {
        return acct;
      }
      if (genericPaths.size > 0 && [...genericPaths].some((p) => info.agyFallbackParents.has(p))) {
        return acct;
      }
    }
  }
  return null;
}

function matchesAccountIdentity(token, identity) {
  if (!token) {
    return false;
  }
  return (
    (identity.id && identity.id === token) ||
    (identity.accountId && identity.accountId === token) ||
    identity.aliases.includes(token)
  );
}

function extractBillingModeTag(target) {
  if (!isPlainObject(target)) {
    return "";
  }
  const raw = String(target.billingMode || target.billing_mode || "")
    .trim()
    .toLowerCase();
  if (!raw || TRANSPORT_BILLING_WORDS.has(raw)) {
    return "";
  }
  if (raw === "personal_subscription") {
    return "personal";
  }
  if (raw === "work_subscription") {
    return "work";
  }
  return raw;
}

function shouldResolveConfiguredAccounts(options, selector) {
  if (
    options.accounts !== undefined ||
    options.monitorConfigPath !== undefined ||
    options.homeDir !== undefined ||
    options.env !== undefined
  ) {
    return true;
  }
  return typeof selector === "string" && selector.trim().length > 0;
}

function buildDescriptorFromAccountObject(effective) {
  const provider = classifyHarnessTarget(effective);
  const canonicalProvider = CANONICAL_HARNESS_SET.has(provider) ? provider : "";
  const tags = [...normalizeAccountTags(effective)];
  const billingModeTag = extractBillingModeTag(effective);
  if (billingModeTag && !tags.includes(billingModeTag)) {
    tags.push(billingModeTag);
  }
  const id = String(effective.id || "")
    .trim()
    .toLowerCase();
  const accountId = String(effective.accountId || "")
    .trim()
    .toLowerCase();
  const aliases = getAccountAliases(effective);
  return {
    provider: canonicalProvider,
    tags,
    id,
    accountId,
    aliases,
  };
}

function trimmedNonEmpty(value) {
  return typeof value === "string" ? value.trim() : "";
}

function defaultSelectorForHarness(harness, options) {
  const env = options.env || process.env;
  const homeDir = resolveHomeDir(options);
  if (harness === "claude") {
    const explicitClaude = trimmedNonEmpty(options.claudeConfigDir);
    const orkestClaudeHome = trimmedNonEmpty(env.ORKEST_CLAUDE_ACCOUNT_HOME);
    let rawClaude;
    if (explicitClaude) {
      rawClaude = explicitClaude;
    } else if (orkestClaudeHome) {
      rawClaude = path.join(expandHome(orkestClaudeHome, homeDir), ".claude");
    } else if (env.ORKEST_PINNED_CLAUDE_ACCOUNT === "1") {
      rawClaude = "~/.claude";
    } else {
      rawClaude = trimmedNonEmpty(env.CLAUDE_CONFIG_DIR) || "~/.claude";
    }
    return {
      provider: "claude",
      claudeConfigDir: rawClaude,
    };
  }
  if (harness === "codex") {
    const explicitCodex = trimmedNonEmpty(options.codexHome);
    const orkestCodexHome = trimmedNonEmpty(env.ORKEST_CODEX_ACCOUNT_HOME);
    let codexHome;
    if (explicitCodex) {
      codexHome = explicitCodex;
    } else if (orkestCodexHome) {
      codexHome = orkestCodexHome;
    } else if (env.ORKEST_PINNED_CODEX_ACCOUNT === "1") {
      codexHome = "~/.codex";
    } else {
      codexHome = trimmedNonEmpty(env.CODEX_HOME) || "~/.codex";
    }
    return {
      provider: "codex",
      codexHome,
    };
  }
  if (harness === "agy") {
    const explicitAgyHome = trimmedNonEmpty(options.agyHome);
    const explicitAgyAppData = trimmedNonEmpty(options.agyAppDataDir);
    if (explicitAgyHome || explicitAgyAppData) {
      return {
        provider: "antigravity",
        ...(explicitAgyHome && { agyHome: explicitAgyHome }),
        ...(explicitAgyAppData && { agyAppDataDir: explicitAgyAppData }),
        ...(options.inferAgyBasename !== undefined && {
          inferAgyBasename: Boolean(options.inferAgyBasename),
        }),
      };
    }
    const orkestAgyHome = trimmedNonEmpty(env.ORKEST_AGY_ACCOUNT_HOME);
    if (orkestAgyHome) {
      return {
        provider: "antigravity",
        agyHome: orkestAgyHome,
        inferAgyBasename: true,
      };
    }
    if (env.ORKEST_PINNED_AGY_ACCOUNT === "1") {
      return {
        provider: "antigravity",
        agyHome: "~/.gemini",
      };
    }
    const envAppData = trimmedNonEmpty(env.ANTIGRAVITY_APP_DATA_DIR);
    const envGeminiHome = trimmedNonEmpty(env.GEMINI_CLI_HOME);
    if (envAppData || envGeminiHome) {
      return {
        provider: "antigravity",
        ...(envAppData && { agyAppDataDir: envAppData }),
        ...(envGeminiHome && { agyHome: envGeminiHome }),
        inferAgyBasename: false,
      };
    }
    return {
      provider: "antigravity",
      agyHome: "~/.gemini",
    };
  }
  return null;
}

function buildTargetEvaluationDescriptor(target, options = {}) {
  const empty = { provider: "", tags: [], id: "", accountId: "", aliases: [] };
  if (typeof target === "string") {
    const cleaned = target.trim().toLowerCase();
    const norm = normalizeDenyToken(target);
    if (!norm) {
      return empty;
    }
    if (norm === "all") {
      return { ...empty, isAll: true };
    }
    if (CANONICAL_HARNESS_SET.has(norm)) {
      const policyNeedsAccountMetadata =
        Array.isArray(options.policy?.deny) &&
        options.policy.deny.some((rawTok) => {
          const tok = normalizeDenyToken(rawTok);
          return (
            Boolean(tok) &&
            (tok.startsWith("tag:") ||
              tok.startsWith("category:") ||
              tok.startsWith("account:") ||
              (!CANONICAL_HARNESS_SET.has(tok) && tok !== "all"))
          );
        });
      if (policyNeedsAccountMetadata) {
        const defaultSelector = defaultSelectorForHarness(norm, options);
        const matched = defaultSelector
          ? resolveConfiguredAccount(defaultSelector, { ...options, provider: norm })
          : null;
        if (matched) {
          return buildDescriptorFromAccountObject(matched);
        }
      }
      return { ...empty, provider: norm };
    }
    if (norm === "claude-work") {
      return {
        provider: "claude",
        tags: ["work"],
        id: "claude-work",
        accountId: "",
        aliases: [],
      };
    }
    if (norm === "claude-personal") {
      return {
        provider: "claude",
        tags: ["personal"],
        id: "claude-personal",
        accountId: "",
        aliases: [],
      };
    }
    if (norm.startsWith("tag:") || norm.startsWith("category:")) {
      const tag = norm.slice(norm.indexOf(":") + 1);
      return { ...empty, tags: tag ? [tag] : [] };
    }
    if (norm.startsWith("account:")) {
      const acctTok = norm.slice("account:".length);
      const matched = shouldResolveConfiguredAccounts(options, acctTok)
        ? resolveConfiguredAccount(norm, options)
        : null;
      if (matched) {
        return buildDescriptorFromAccountObject(matched);
      }
      return { ...empty, id: acctTok, accountId: acctTok };
    }
    const colonIdx = norm.indexOf(":");
    if (colonIdx !== -1) {
      const provPart = norm.slice(0, colonIdx);
      const tagPart = norm.slice(colonIdx + 1);
      if (CANONICAL_HARNESS_SET.has(provPart)) {
        return { ...empty, provider: provPart, tags: tagPart ? [tagPart] : [] };
      }
    }
    const matched = shouldResolveConfiguredAccounts(options, cleaned)
      ? resolveConfiguredAccount(target, options)
      : null;
    if (matched) {
      return buildDescriptorFromAccountObject(matched);
    }
    return { ...empty, id: cleaned, accountId: "", aliases: [cleaned] };
  }

  if (!isPlainObject(target)) {
    return empty;
  }

  let effective = target;
  const hasExplicitTags =
    target.tags !== undefined || target.category !== undefined || target.billing !== undefined;
  if (shouldResolveConfiguredAccounts(options, "")) {
    const matched = resolveConfiguredAccount(target, options);
    if (matched) {
      effective = {
        ...matched,
        ...target,
        provider: target.provider || target.engine || target.harness || matched.provider,
        ...(!hasExplicitTags && {
          tags: matched.tags,
          category: matched.category,
          billing: matched.billing,
        }),
        alias: target.alias ?? matched.alias,
        aliases: target.aliases ?? matched.aliases,
      };
    }
  }

  return buildDescriptorFromAccountObject(effective);
}

export function isHarnessAllowed(cwd, target, options = {}) {
  const policy = options.policy || resolveRepoPolicy(cwd, options);
  const denySet = new Set((policy.deny || []).map(normalizeDenyToken).filter(Boolean));
  if (denySet.size === 0) {
    return true;
  }
  if (denySet.has("all")) {
    return false;
  }

  const descriptor = buildTargetEvaluationDescriptor(target, { ...options, policy });
  if (descriptor.isAll) {
    return false;
  }

  const tagSet = new Set(descriptor.tags);
  for (const rawDeny of denySet) {
    if (CANONICAL_HARNESS_SET.has(rawDeny)) {
      if (descriptor.provider === rawDeny) {
        return false;
      }
      continue;
    }
    if (rawDeny.startsWith("tag:") || rawDeny.startsWith("category:")) {
      const tag = rawDeny.slice(rawDeny.indexOf(":") + 1);
      if (tag && tagSet.has(tag)) {
        return false;
      }
      continue;
    }
    if (rawDeny.startsWith("account:")) {
      const acctTok = rawDeny.slice("account:".length);
      if (matchesAccountIdentity(acctTok, descriptor)) {
        return false;
      }
      continue;
    }
    if (rawDeny === "claude-work") {
      if (
        (descriptor.provider === "claude" && tagSet.has("work")) ||
        matchesAccountIdentity("claude-work", descriptor)
      ) {
        return false;
      }
      continue;
    }
    if (rawDeny === "claude-personal") {
      if (
        (descriptor.provider === "claude" && tagSet.has("personal")) ||
        matchesAccountIdentity("claude-personal", descriptor)
      ) {
        return false;
      }
      continue;
    }
    const colonIdx = rawDeny.indexOf(":");
    if (colonIdx !== -1) {
      const rawProv = rawDeny.slice(0, colonIdx);
      const provPart = Object.hasOwn(TOKEN_ALIASES, rawProv) ? TOKEN_ALIASES[rawProv] : rawProv;
      const tagPart = rawDeny.slice(colonIdx + 1);
      if (provPart && tagPart && descriptor.provider === provPart && tagSet.has(tagPart)) {
        return false;
      }
      continue;
    }
    if (tagSet.has(rawDeny) || matchesAccountIdentity(rawDeny, descriptor)) {
      return false;
    }
  }
  return true;
}

export const isAccountAllowed = isHarnessAllowed;

function describePathSelector(rawSelector, homeDir) {
  const expanded = expandHome(rawSelector, homeDir);
  if (!expanded) {
    return null;
  }
  const hasTrailingSlashStar = expanded.endsWith("/*");
  const hasTrailingSlash = !hasTrailingSlashStar && expanded.length > 1 && expanded.endsWith("/");
  let suffix = "";
  if (hasTrailingSlashStar) {
    suffix = "/*";
  } else if (hasTrailingSlash) {
    suffix = "/";
  }

  if (path.isAbsolute(expanded)) {
    let base = expanded;
    if (suffix === "/*") {
      base = expanded.slice(0, -2) || "/";
    } else if (suffix === "/") {
      base = expanded.replace(/\/+$/, "") || "/";
    }
    const isExistingLiteral = fs.existsSync(base);
    const hasGlob = !isExistingLiteral && /[*?[]/u.test(base);
    const canonBase = hasGlob ? canonicalizeGlobPath(base) : canonicalizePath(base);
    let value = canonBase;
    if (suffix === "/*") {
      value = canonBase === "/" ? "/*" : `${canonBase}/*`;
    } else if (suffix === "/") {
      value = canonBase === "/" ? "/" : `${canonBase}/`;
    }
    return { isAbs: true, suffix, hasGlob, value };
  }

  const normalizedSlash = expanded.replaceAll(path.sep, "/");
  let base = normalizedSlash;
  if (suffix === "/*") {
    base = normalizedSlash.slice(0, -2);
  } else if (suffix === "/") {
    base = normalizedSlash.replace(/\/+$/, "");
  }
  const normBase = base ? path.posix.normalize(base) : "";
  const hasGlob = /[*?[]/u.test(normBase);
  return { isAbs: false, suffix, hasGlob, value: `${normBase}${suffix}` };
}

function arePathDescriptorsEqual(a, b) {
  return Boolean(
    a &&
    b &&
    a.isAbs === b.isAbs &&
    a.suffix === b.suffix &&
    a.hasGlob === b.hasGlob &&
    a.value === b.value,
  );
}

function ruleMatchesMutationTarget(rule, { selector, hasExplicitMatch, targetDesc, homeDir }) {
  if (!isPlainObject(rule)) {
    return false;
  }
  const hasPath = Boolean(rule.path || rule.repo);
  const hasMatch = Boolean(rule.match || rule.pattern);
  const hasRemote = Boolean(rule.remote);
  const selectorKindCount = Number(hasPath) + Number(hasMatch) + Number(hasRemote);
  if (selectorKindCount !== 1) {
    return false;
  }

  if (!hasExplicitMatch) {
    if (hasRemote) {
      return false;
    }
    const rawVal = hasPath ? rule.path || rule.repo : rule.match || rule.pattern;
    const ruleDesc = describePathSelector(String(rawVal), homeDir);
    return Boolean(
      ruleDesc &&
      ruleDesc.isAbs &&
      ruleDesc.suffix === "" &&
      !ruleDesc.hasGlob &&
      ruleDesc.value === targetDesc.value,
    );
  }

  if (hasRemote) {
    return String(rule.remote).trim() === selector;
  }
  const rawVal = hasPath ? rule.path || rule.repo : rule.match || rule.pattern;
  const rawStr = String(rawVal).trim();
  if (hasMatch && rawStr === selector) {
    return true;
  }
  const ruleDesc = describePathSelector(rawStr, homeDir);
  return arePathDescriptorsEqual(ruleDesc, targetDesc);
}

function mutatePolicyRulesList(
  rawPolicies,
  { mode, selector, hasExplicitMatch, targetDesc, homeDir, normalizedTargets },
) {
  let rulesList = [];
  if (Array.isArray(rawPolicies)) {
    rulesList = rawPolicies.map((item) => (isPlainObject(item) ? { ...item } : item));
  } else if (isPlainObject(rawPolicies)) {
    for (const [k, v] of Object.entries(rawPolicies)) {
      if (Array.isArray(v)) {
        rulesList.push({ match: k, deny: [...v] });
      } else if (isPlainObject(v)) {
        const rule = { ...v };
        if (!hasRuleSelector(rule)) {
          rule.match = k;
        }
        rulesList.push(rule);
      }
    }
  }

  const matchesSelector = (rule) =>
    ruleMatchesMutationTarget(rule, { selector, hasExplicitMatch, targetDesc, homeDir });

  if (mode === "reset") {
    return rulesList.filter((rule) => !matchesSelector(rule));
  }

  let targetRule = rulesList.find((rule) => matchesSelector(rule));
  if (!targetRule && mode === "add") {
    targetRule = hasExplicitMatch ? { match: selector, deny: [] } : { path: selector, deny: [] };
    rulesList.push(targetRule);
  }
  if (targetRule) {
    const currentDeny = collectRuleDenyTokens(targetRule) || [];
    const denySet = new Set(currentDeny);
    if (mode === "add") {
      for (const tok of normalizedTargets) {
        denySet.add(tok);
      }
    } else if (mode === "remove") {
      for (const tok of normalizedTargets) {
        if (denySet.has("all") && tok !== "all") {
          denySet.delete("all");
          for (const harness of CANONICAL_HARNESSES) {
            denySet.add(harness);
          }
        }
        if (tok === "claude") {
          denySet.delete("claude");
          denySet.delete("claude-work");
          denySet.delete("claude-personal");
          for (const existing of denySet) {
            if (existing.startsWith("claude:")) {
              denySet.delete(existing);
            }
          }
          continue;
        }
        denySet.delete(tok);
      }
    }
    targetRule.deny = [...denySet];
    for (const aliasKey of DENY_KEYS) {
      if (aliasKey !== "deny") {
        delete targetRule[aliasKey];
      }
    }
    if (targetRule.deny.length === 0) {
      rulesList = rulesList.filter((r) => r !== targetRule);
    }
  }
  return rulesList;
}

function resolveWritablePolicyConfigPath(filePath) {
  let current = path.resolve(filePath);
  for (let hop = 0; hop < 40; hop += 1) {
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error?.code === "ENOENT") {
        return canonicalizePath(current);
      }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      try {
        return fs.realpathSync(current);
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
        const linkTarget = fs.readlinkSync(current);
        current = path.resolve(path.dirname(current), linkTarget);
        continue;
      }
    }
    return fs.realpathSync(current);
  }
  throw new Error(`Too many levels of symbolic links resolving ${filePath}`);
}

const POLICY_FLOCK_SCRIPT = [
  "import fcntl, json, os, subprocess, sys",
  "req = json.loads(sys.stdin.read())",
  "lock_path = req['lockPath']",
  "fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)",
  "try:",
  "    fcntl.flock(fd, fcntl.LOCK_EX)",
  "    env = dict(os.environ)",
  "    env['ORKEST_POLICY_LOCK_HELD'] = '1'",
  "    res = subprocess.run(",
  "        [req['nodeExec'], '--input-type=module', '-e', req['nodeScript']],",
  "        input=json.dumps(req['payload']),",
  "        text=True,",
  "        capture_output=True,",
  "        env=env,",
  "        pass_fds=(fd,),",
  "        check=False,",
  "    )",
  "    if res.stdout:",
  "        sys.stdout.write(res.stdout)",
  "    if res.stderr:",
  "        sys.stderr.write(res.stderr)",
  "    sys.exit(res.returncode)",
  "finally:",
  "    os.close(fd)",
].join("\n");

function runUnderPolicyFileLock(targetPath, payload) {
  const lockPath = `${targetPath}.lock`;
  const nodeScript = [
    "import fs from 'node:fs';",
    `import { setRepoPolicyDeny } from ${JSON.stringify(import.meta.url)};`,
    "const payload = JSON.parse(fs.readFileSync(0, 'utf8'));",
    "try {",
    "  const result = setRepoPolicyDeny(payload.cwd, payload.targets, {",
    "    ...payload.options,",
    "    _policyLockHeld: true,",
    "  });",
    "  process.stdout.write(JSON.stringify({ ok: true, result }));",
    "} catch (error) {",
    "  process.stdout.write(JSON.stringify({",
    "    ok: false,",
    "    error: error?.message || String(error),",
    "    exitCode: error?.exitCode ?? null,",
    "  }));",
    "}",
  ].join("\n");
  const rawOut = execFileSync("python3", ["-c", POLICY_FLOCK_SCRIPT], {
    input: JSON.stringify({
      lockPath,
      nodeExec: process.execPath,
      nodeScript,
      payload,
    }),
    encoding: "utf8",
    env: process.env,
  });
  const parsed = JSON.parse(rawOut.trim());
  if (!parsed.ok) {
    const err = new Error(parsed.error || "Failed to update repository policy");
    if (Number.isSafeInteger(parsed.exitCode)) {
      err.exitCode = parsed.exitCode;
    }
    throw err;
  }
  return parsed.result;
}

export function setRepoPolicyDeny(
  cwd,
  targets = [],
  {
    mode = "add",
    match = null,
    configPath = null,
    homeDir = null,
    env = process.env,
    spawnSync: customSpawnSync,
    _policyLockHeld = false,
  } = {},
) {
  let effectiveMode = mode;
  if (mode === "allow") {
    effectiveMode = "remove";
  } else if (mode === "deny") {
    effectiveMode = "add";
  }
  const resolvedHome = resolveHomeDir({ homeDir, env });
  const repoRoot = resolveRepoRoot(cwd, {
    homeDir: resolvedHome,
    env,
    strict: true,
    spawnSync: customSpawnSync,
  });
  const hasExplicitMatch = match !== null && match !== undefined && String(match).trim() !== "";
  const selector = hasExplicitMatch ? String(match).trim() : repoRoot;
  const targetDesc = hasExplicitMatch
    ? describePathSelector(selector, resolvedHome)
    : { isAbs: true, suffix: "", hasGlob: false, value: repoRoot };
  const resolvedConfigPath = resolvePolicyConfigPath({ configPath, homeDir: resolvedHome, env });
  const targetConfigPath = resolveWritablePolicyConfigPath(resolvedConfigPath);
  const parentDir = path.dirname(targetConfigPath);
  fs.mkdirSync(parentDir, { recursive: true, mode: 0o700 });

  if (!_policyLockHeld) {
    return runUnderPolicyFileLock(targetConfigPath, {
      cwd: repoRoot,
      targets,
      options: {
        mode,
        match,
        configPath: targetConfigPath,
        homeDir: resolvedHome,
        env: env === process.env ? undefined : { ...env },
      },
    });
  }

  const normalizedTargets = (Array.isArray(targets) ? targets : [targets])
    .map((t) => normalizeDenyToken(t))
    .filter(Boolean);

  const mutationOpts = {
    mode: effectiveMode,
    selector,
    hasExplicitMatch,
    targetDesc,
    homeDir: resolvedHome,
    normalizedTargets,
  };

  const configObj = loadJsonObject(targetConfigPath, { isStrict: true });
  validatePolicyContainer(configObj, targetConfigPath, { isStrict: true });

  const nextConfig = { ...configObj };
  if (configObj.repoPolicies === undefined) {
    nextConfig.repo_policies = mutatePolicyRulesList(configObj.repo_policies, mutationOpts);
  } else if (effectiveMode === "add" && configObj.repo_policies === undefined) {
    nextConfig.repoPolicies = mutatePolicyRulesList(configObj.repoPolicies, mutationOpts);
  } else {
    if (effectiveMode === "remove" || effectiveMode === "reset") {
      const updatedCamel = mutatePolicyRulesList(configObj.repoPolicies, mutationOpts);
      if (updatedCamel.length === 0) {
        delete nextConfig.repoPolicies;
      } else {
        nextConfig.repoPolicies = updatedCamel;
      }
    }
    nextConfig.repo_policies = mutatePolicyRulesList(configObj.repo_policies, mutationOpts);
  }

  const tmpPath = `${targetConfigPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const payload = JSON.stringify(nextConfig, null, 2) + "\n";
  let fd;
  try {
    fd = fs.openSync(tmpPath, "w", 0o600);
    fs.writeFileSync(fd, payload, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.chmodSync(tmpPath, 0o600);
    fs.renameSync(tmpPath, targetConfigPath);
  } catch (error) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close error during cleanup.
      }
    }
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // Ignore temp cleanup error.
    }
    throw error;
  }

  return resolveRepoPolicy(repoRoot, {
    configPath: targetConfigPath,
    homeDir: resolvedHome,
    env,
    strict: true,
    spawnSync: customSpawnSync,
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
    "  deny <target...>        Deny one or more harnesses/accounts (e.g. claude, claude:work, tag:personal, codex, agy, opencode)",
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
      cwd = String(raw);
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
    } else if (action === null && ["show", "deny", "allow", "reset"].includes(token)) {
      action = token;
    } else {
      targets.push(token);
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
