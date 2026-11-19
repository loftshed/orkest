/**
 * @module foundry
 *
 * The Foundry (`ork foundry` / `ork factory`): Spare-token software factory.
 * Harvests open GitHub issues (`Depends on #N` DAG-aware) when flat-rate
 * subscription pools (`monitor`) have expiring surplus quota, provisions
 * isolated disposable git worktrees (`.worktreeinclude`), and dispatches
 * bounded worker runs.
 */
import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, hostname, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";

import { buildLanes } from "../../monitor/lib/analyze.mjs";
import { shouldUseColor } from "../../monitor/lib/render.mjs";
import { getAccounts } from "../../monitor/lib/store.mjs";
import { resolveWorktreeMarkerPath } from "./horde-room.mjs";
import { glyphSet, glyphTier, renderPanel, renderTable, wrapText } from "./horde-view.mjs";
import {
  isHarnessAllowed,
  normalizeAccountTags,
  normalizeDenyToken,
  resolveRepoPolicy,
} from "./policy.mjs";
import { cacheHome, configPath, envFirst } from "./runtime-paths.mjs";
import { acquireWorkspaceLease, assertWorkspaceLease } from "./workspace-lease.mjs";
import { bootstrapWorktreeInclude as bootstrapWorktreeIncludeShared } from "./worktree-env.mjs";

const execute = promisify(execFile);
const scriptsDir = fileURLToPath(new URL("../skills/orchestrate/scripts/", import.meta.url));
const defaultRoutesUrl = new URL(
  "../skills/orchestrate/references/routes.default.json",
  import.meta.url,
);
const TASK_SPEC_SCHEMA = "agent-executor.task-spec.v1";
export const FOUNDRY_STATE_SCHEMA = "ork.foundry.state.v2";

export function loadDefaultRoutes() {
  let baseRoutes;
  try {
    baseRoutes = JSON.parse(readFileSync(defaultRoutesUrl, "utf8")).routes || {};
  } catch {
    baseRoutes = {};
  }
  const merged = structuredClone(baseRoutes);
  try {
    const userConfig = JSON.parse(readFileSync(configPath(), "utf8"));
    if (userConfig?.routes && typeof userConfig.routes === "object") {
      for (const [role, route] of Object.entries(userConfig.routes)) {
        if (route && typeof route === "object" && route.engine) {
          merged[role] = { ...merged[role], ...route };
        }
      }
    }
  } catch {
    /* Keep default routes when user config is absent or unreadable. */
  }
  return merged;
}

export const DEFAULT_ROUTES = loadDefaultRoutes();

const ENGINE_FALLBACK_ROLES = {
  agy: "gemini",
  claude: "claude",
  codex: "implementation",
  opencode: "opencode",
};

export const FOUNDRY_HELP = `ork foundry [status] [--json] [--repo <owner/name>] [--width 120]
ork foundry run [--dry-run] [--once] [--issue <number>] [--repo <owner/name>] [--verify <cmd>] [--acceptance <text>] [--json]
ork foundry groom --issue <number> [--dry-run] [--repo <owner/name>] [--json]
`;

export const FACTORY_HELP = FOUNDRY_HELP;

/**
 * Ensures Vitest and Jest verification commands cap worker concurrency to
 * `--maxWorkers=2` unless an explicit `--maxWorkers` or `-w` flag is already present.
 */
export function enforceScopedVerifyCommand(rawCommand) {
  if (typeof rawCommand !== "string" || rawCommand.trim().length === 0) {
    return "corepack pnpm test";
  }
  const trimmed = rawCommand.trim();
  if (
    /(?:^|[\s;|&()]|\/\.bin\/)(?:vitest|jest)(?=\s|$)/u.test(trimmed) &&
    !/--maxWorkers(?:=|\s+)/u.test(trimmed) &&
    !/(?:^|\s)-w(?:\s+|=|$)/u.test(trimmed)
  ) {
    return `${trimmed} --maxWorkers=2`;
  }
  return trimmed;
}

function isNonEmptyStringArray(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === "string" && item.trim().length > 0)
  );
}

function validateTaskSpecObject(candidate, requireSchemaTag) {
  if (
    !candidate ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    (requireSchemaTag && candidate.schema !== TASK_SPEC_SCHEMA) ||
    (candidate.schema !== undefined && candidate.schema !== TASK_SPEC_SCHEMA) ||
    typeof candidate.objective !== "string" ||
    candidate.objective.trim().length === 0 ||
    !isNonEmptyStringArray(candidate.allow_paths)
  ) {
    return null;
  }
  if (
    candidate.acceptance_checks !== undefined &&
    (!Array.isArray(candidate.acceptance_checks) ||
      candidate.acceptance_checks.some((item) => !(typeof item === "string" && item.trim())))
  )
    return null;
  const hasChecks =
    isNonEmptyStringArray(candidate.acceptance_checks) ||
    isNonEmptyStringArray(candidate.development_checks) ||
    isNonEmptyStringArray(candidate.acceptance_criteria);
  if (!hasChecks) return null;
  return {
    ...candidate,
    schema: TASK_SPEC_SCHEMA,
  };
}

/**
 * Parses an embedded ```json task-spec ... ``` (or ```json ... ``` with schema
 * "agent-executor.task-spec.v1") block from a GitHub issue body.
 */
export function extractTaskSpec(issueBody) {
  if (typeof issueBody !== "string" || issueBody.trim().length === 0) return null;
  const fencePattern =
    /(?:^|\r?\n)[ \t]*```(json(?:\s+task-spec)?|task-spec)[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```[ \t]*(?=\r?\n|$)/giu;
  const taggedBlocks = [];
  const plainJsonBlocks = [];
  for (const match of issueBody.matchAll(fencePattern)) {
    const info = match[1].trim().toLowerCase();
    const content = match[2].trim();
    if (info.includes("task-spec")) taggedBlocks.push(content);
    else plainJsonBlocks.push(content);
  }
  for (const block of taggedBlocks) {
    try {
      const parsed = JSON.parse(block);
      const valid = validateTaskSpecObject(parsed, false);
      if (valid) return valid;
    } catch {
      /* Ignore malformed JSON block and continue searching. */
    }
  }
  for (const block of plainJsonBlocks) {
    try {
      const parsed = JSON.parse(block);
      const valid = validateTaskSpecObject(parsed, true);
      if (valid) return valid;
    } catch {
      /* Ignore malformed JSON block and continue searching. */
    }
  }
  return null;
}

/**
 * Parses `Depends on #<n>` and `Blocked by #<n>` declarations (case-insensitive)
 * from an issue body and returns unique referenced issue numbers.
 */
export function parseIssueDependencies(issueBody) {
  if (typeof issueBody !== "string" || issueBody.trim().length === 0) return [];
  const clausePattern =
    /\b(?:depends\s+on|blocked\s+by)\s*:?\s*(#[0-9]+(?:\s*(?:,|and|&)?\s*#[0-9]+)*)/giu;
  const issueRefPattern = /#([0-9]+)/gu;
  const seen = new Set();
  for (const clauseMatch of issueBody.matchAll(clausePattern)) {
    const refsChunk = clauseMatch[1] || "";
    for (const refMatch of refsChunk.matchAll(issueRefPattern)) {
      const num = Number(refMatch[1]);
      if (Number.isSafeInteger(num) && num > 0) seen.add(num);
    }
  }
  return [...seen];
}

function normalizeRelativePath(rawPath) {
  if (typeof rawPath !== "string") return "";
  const slashPath = rawPath.replaceAll("\\", "/").trim();
  if (!slashPath) return "";
  const normalized = path.posix
    .normalize(slashPath)
    .replaceAll(/^(?:\.\/)+/gu, "")
    .replaceAll(/^\/+|\/+$/gu, "");
  return normalized;
}

function pathsOverlap(firstPath, secondPath) {
  const a = normalizeRelativePath(firstPath);
  const b = normalizeRelativePath(secondPath);
  if (!a || !b || a === "." || b === "." || a.startsWith("..") || b.startsWith("..") || a === b) {
    return true;
  }
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function flattenActivePaths(activeAllowPathsList) {
  if (!Array.isArray(activeAllowPathsList)) return [];
  const flat = [];
  for (const entry of activeAllowPathsList) {
    if (typeof entry === "string") {
      flat.push(entry);
    } else if (Array.isArray(entry)) {
      for (const item of flattenActivePaths(entry)) flat.push(item);
    } else if (entry && typeof entry === "object" && Array.isArray(entry.allow_paths)) {
      for (const item of flattenActivePaths(entry.allow_paths)) flat.push(item);
    }
  }
  return flat;
}

/**
 * Returns true if candidateAllowPaths has zero path/prefix overlap with any
 * currently active task's allow_paths.
 */
export function hasDisjointPaths(candidateAllowPaths, activeAllowPathsList = []) {
  if (!isNonEmptyStringArray(candidateAllowPaths)) return false;
  const activePaths = flattenActivePaths(activeAllowPathsList);
  for (const candidate of candidateAllowPaths) {
    for (const active of activePaths) {
      if (pathsOverlap(candidate, active)) return false;
    }
  }
  return true;
}

function isPersonalLane(lane) {
  if (
    lane.billing === "personal" ||
    lane.personal === true ||
    normalizeAccountTags(lane).includes("personal")
  ) {
    return true;
  }
  const haystack = `${lane.accountId ?? ""} ${lane.accountLabel ?? ""} ${lane.label ?? ""} ${lane.route ?? ""}`;
  return /\bpersonal\b/iu.test(haystack);
}

function matchesAllowedPools(lane, allowedPools) {
  const allowed = new Set(allowedPools);
  return (
    allowed.has(lane.poolId) ||
    allowed.has(lane.accountId) ||
    allowed.has(`${lane.accountId}:${lane.poolId}`) ||
    allowed.has(`${lane.accountId}/${lane.poolId}`) ||
    allowed.has(lane.label)
  );
}

export function isLaneDeniedByPolicy(lane, denyList = []) {
  if (!lane || typeof lane !== "object" || !Array.isArray(denyList) || denyList.length === 0) {
    return false;
  }
  const normalizedDeny = denyList
    .map((item) => normalizeDenyToken(String(item ?? "")))
    .filter(Boolean);
  if (normalizedDeny.length === 0) return false;
  const engine = laneEngine(lane);
  const target = {
    ...lane,
    id: lane.accountId || lane.id || "",
    accountId: lane.accountId || lane.id || "",
    alias: lane.alias || lane.accountAlias || "",
    provider: lane.provider || "",
    engine,
    tags: normalizeAccountTags(lane),
  };
  if (!isHarnessAllowed(null, target, { policy: { deny: normalizedDeny } })) {
    return true;
  }
  const accountId = String(lane.accountId ?? "")
    .trim()
    .toLowerCase();
  const poolId = String(lane.poolId ?? "")
    .trim()
    .toLowerCase();
  if (!poolId) return false;
  const denySet = new Set(normalizedDeny);
  return (
    (Boolean(accountId) && denySet.has(`${accountId}:${poolId}`)) ||
    (poolId !== engine && denySet.has(poolId))
  );
}

function laneSurplusPts(lane) {
  if (typeof lane.surplusPts === "number" && Number.isFinite(lane.surplusPts)) {
    return lane.surplusPts;
  }
  if (typeof lane.pace?.surplus === "number" && Number.isFinite(lane.pace.surplus)) {
    return Math.round(lane.pace.surplus);
  }
  return 0;
}

export function laneEngine(lane) {
  if (!lane || typeof lane !== "object") return "codex";
  if (typeof lane.engine === "string" && lane.engine.trim()) {
    const normalized = lane.engine.trim().toLowerCase();
    return normalized === "antigravity" ? "agy" : normalized;
  }
  if (typeof lane.route === "string") {
    const match = /--engine\s+([a-z0-9_-]+)/iu.exec(lane.route);
    if (match) return match[1].toLowerCase() === "antigravity" ? "agy" : match[1].toLowerCase();
    if (/\bclaude\b/iu.test(lane.route)) return "claude";
    if (/\b(?:agy|gemini)\b/iu.test(lane.route)) return "agy";
    if (/\b(?:codex)\b/iu.test(lane.route)) return "codex";
    if (/\b(?:opencode)\b/iu.test(lane.route)) return "opencode";
  }
  const provider = String(lane.provider ?? "").toLowerCase();
  const poolId = String(lane.poolId ?? "").toLowerCase();
  const accountId = String(lane.accountId ?? "").toLowerCase();
  if (provider === "antigravity" || poolId === "gemini" || accountId.includes("agy")) return "agy";
  if (provider === "claude" || poolId === "claude" || accountId.includes("claude")) return "claude";
  if (provider === "opencode" || poolId === "opencode" || accountId.includes("opencode")) {
    return "opencode";
  }
  return "codex";
}

function laneFamilies(lane) {
  if (Array.isArray(lane?.families) && lane.families.length > 0) {
    return lane.families.map((family) => String(family).toLowerCase());
  }
  const engine = laneEngine(lane);
  const poolId = String(lane?.poolId ?? "").toLowerCase();
  if (engine === "claude" || poolId === "claude") return ["claude"];
  if (engine === "agy") return ["gemini"];
  if (engine === "opencode") return ["glm", "deepseek", "kimi"];
  return ["gpt"];
}

/**
 * Normalizes a spare-pool object into its serialized summary representation.
 */
export function poolSummary(pool) {
  if (!pool || typeof pool !== "object") return null;
  return {
    accountId: pool.accountId,
    availableNowPct: pool.availableNowPct ?? 100,
    effort: pool.effort ?? null,
    engine: pool.engine,
    expiring: pool.expiring,
    label: pool.label,
    model: pool.model ?? null,
    poolId: pool.poolId,
    route: pool.route ?? null,
    score: pool.score,
    status: pool.status,
    surplusPts: pool.surplusPts,
  };
}

/**
 * Filters and orders all eligible spare-token pools from buildLanes(accounts).
 * Strictly refuses credits, blocked, error, lowRoom, and unauthorized pools.
 */
export function selectSparePools(lanes, policy = {}) {
  if (!Array.isArray(lanes)) return [];
  const minSurplusPts = policy.minSurplusPts ?? 10;
  const minAvailableNowPct = policy.minAvailableNowPct ?? 10;
  const eligible = [];

  for (const lane of lanes) {
    const laneTags = normalizeAccountTags(lane || {});
    if (
      !lane ||
      typeof lane !== "object" ||
      lane.status !== "available" ||
      Boolean(lane.credits) ||
      lane.redundant === true ||
      lane.lowRoom === true ||
      lane.resetAwaitingRefresh === true ||
      (typeof lane.availableNowPct === "number" && lane.availableNowPct < minAvailableNowPct) ||
      lane.billing === "unauthorized" ||
      lane.unauthorized === true ||
      (Array.isArray(policy.allowedBilling) &&
        !policy.allowedBilling.includes(
          lane.billing ?? (isPersonalLane(lane) ? "personal" : "work"),
        )) ||
      (Array.isArray(policy.allowedTags) &&
        policy.allowedTags.every((tag) => !laneTags.includes(String(tag).trim().toLowerCase()))) ||
      (policy.allowPersonal === false && isPersonalLane(lane)) ||
      (Array.isArray(policy.allowedPools) && !matchesAllowedPools(lane, policy.allowedPools)) ||
      (Array.isArray(policy.deny) &&
        policy.deny.length > 0 &&
        isLaneDeniedByPolicy(lane, policy.deny))
    ) {
      continue;
    }

    const isExpiringLane = Boolean(lane.expiring || lane.expiringWindow);
    const surplusPts = laneSurplusPts(lane);
    if (!isExpiringLane && surplusPts < minSurplusPts) continue;

    let fallbackScore = surplusPts;
    if (isExpiringLane) fallbackScore = 1000 + (lane.burnPctPerHour ?? surplusPts);
    const score =
      typeof lane.score === "number" && Number.isFinite(lane.score) ? lane.score : fallbackScore;

    eligible.push({
      ...lane,
      engine: laneEngine(lane),
      expiring: isExpiringLane,
      families: laneFamilies(lane),
      score,
      surplusPts,
    });
  }

  eligible.sort((a, b) => {
    if (policy.expiringFirst !== false && a.expiring !== b.expiring) {
      return a.expiring ? -1 : 1;
    }
    if (b.score !== a.score) return b.score - a.score;
    return b.surplusPts - a.surplusPts;
  });

  return eligible;
}

/**
 * Selects the highest-scoring eligible spare pool, or null when none qualify.
 */
export function selectSparePool(lanes, policy = {}) {
  return selectSparePools(lanes, policy)[0] ?? null;
}

function issueLabels(issue) {
  if (!Array.isArray(issue?.labels)) return [];
  return issue.labels
    .map((label) => (typeof label === "string" ? label : label?.name))
    .filter((name) => typeof name === "string");
}

function hasIssueLabel(issue, targetLabel) {
  const normalizedTarget = targetLabel.toLowerCase();
  return issueLabels(issue).some((label) => label.toLowerCase() === normalizedTarget);
}

function isReadyCandidate(issue) {
  if (!issue || typeof issue !== "object") return false;
  if (issue.state !== undefined && String(issue.state).toLowerCase() !== "open") return false;
  if (Array.isArray(issue.labels)) return hasIssueLabel(issue, "agent:ready");
  return true;
}

/**
 * Extracts an issue's task archetype from an `archetype:<name>` label or
 * taskSpec.metadata.archetype / taskSpec.archetype / taskSpec.task_archetype.
 */
export function extractIssueArchetype(issue, taskSpec = null) {
  for (const label of issueLabels(issue)) {
    const match = /^archetype:(.+)$/iu.exec(label.trim());
    if (match && match[1].trim()) return match[1].trim().toLowerCase();
  }
  const specArchetype =
    taskSpec?.metadata?.archetype ||
    taskSpec?.archetype ||
    taskSpec?.task_archetype ||
    issue?.archetype;
  if (typeof specArchetype === "string" && specArchetype.trim()) {
    return specArchetype.trim().toLowerCase();
  }
  return null;
}

function normalizeRouteCandidate(entry) {
  return {
    account: entry.account ?? entry.alias ?? null,
    claudeConfigDir: entry.claudeConfigDir ?? entry.claude_config_dir ?? null,
    effort: entry.effort ?? entry.variant ?? null,
    engine: entry.engine,
    model: entry.model,
    tags: Array.isArray(entry.tags) ? entry.tags : [],
  };
}

function routeCandidatesForRole(role, routesConfig = loadDefaultRoutes()) {
  const effectiveRoutes = { ...loadDefaultRoutes(), ...routesConfig };
  const route = effectiveRoutes[role];
  if (!route || typeof route !== "object") return [];
  const primary = normalizeRouteCandidate(route);
  const alternates = Array.isArray(route.alternates)
    ? route.alternates.map((alt) => normalizeRouteCandidate(alt))
    : [];
  return [primary, ...alternates];
}

function expandHomeDir(rawPath, homeDir = homedir()) {
  const text = String(rawPath ?? "").trim();
  if (!text) return "";
  if (text === "~") return homeDir;
  if (text === "~/") return homeDir === "/" ? "/" : `${homeDir.replace(/\/+$/u, "")}/`;
  if (text.startsWith("~/")) return `${homeDir.replace(/\/+$/u, "")}/${text.slice(2)}`;
  return text;
}

function normalizeConfigDirPath(rawPath, homeDir = homedir()) {
  const expanded = expandHomeDir(rawPath, homeDir);
  if (!expanded) return "";
  const resolved = path.resolve(homeDir, expanded);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function candidateFamily(modelSelector) {
  if (typeof modelSelector !== "string") return "";
  const cleaned = modelSelector.replaceAll(/^latest:/giu, "");
  return cleaned.split(":", 1)[0].toLowerCase();
}

function hasCandidateRouteConstraints(candidate) {
  return Boolean(
    candidate?.account ||
    (Array.isArray(candidate?.tags) && candidate.tags.length > 0) ||
    candidate?.claudeConfigDir,
  );
}

export function poolSupportsCandidate(pool, candidate) {
  const poolEng = laneEngine(pool);
  if (poolEng !== candidate.engine) return false;
  if (candidate.account) {
    const target = String(candidate.account).trim().toLowerCase();
    const poolAliases = Array.isArray(pool.aliases) ? pool.aliases : [];
    const poolIdentities = [pool.accountId, pool.alias, ...poolAliases]
      .filter((item) => typeof item === "string" && item.trim())
      .map((item) => item.trim().toLowerCase());
    if (!poolIdentities.includes(target)) return false;
  }
  if (Array.isArray(candidate.tags) && candidate.tags.length > 0) {
    const poolTags = new Set(normalizeAccountTags(pool));
    const requiredTags = candidate.tags
      .map((tag) =>
        String(tag ?? "")
          .trim()
          .toLowerCase(),
      )
      .filter(Boolean);
    if (requiredTags.some((tag) => !poolTags.has(tag))) return false;
  }
  if (candidate.claudeConfigDir) {
    const rawPoolHome = pool.accountEnv?.HOME || pool.env?.HOME;
    const poolHomeDir = rawPoolHome
      ? path.resolve(homedir(), expandHomeDir(rawPoolHome))
      : homedir();
    const expandedRawConfigDir = pool.configDir
      ? path.resolve(poolHomeDir, expandHomeDir(pool.configDir, poolHomeDir))
      : null;
    const poolConfigDir =
      pool.claudeConfigDir ||
      (poolEng === "claude" ? pool.accountHome : null) ||
      expandedRawConfigDir ||
      null;
    const effectivePoolConfigDir =
      poolConfigDir || (poolEng === "claude" ? path.join(poolHomeDir, ".claude") : "");
    if (
      !effectivePoolConfigDir ||
      normalizeConfigDirPath(effectivePoolConfigDir, poolHomeDir) !==
        normalizeConfigDirPath(candidate.claudeConfigDir)
    ) {
      return false;
    }
  }
  const family = candidateFamily(candidate.model);
  const supported = laneFamilies(pool);
  return !family || supported.length === 0 || supported.includes(family);
}

function buildPoolRouteOptions(pool, archetype, routesConfig) {
  const options = [];
  const seenModels = new Set();
  const poolEng = laneEngine(pool);
  const archetypeCandidates = archetype ? routeCandidatesForRole(archetype, routesConfig) : [];

  for (const [rank, candidate] of archetypeCandidates.entries()) {
    if (!poolSupportsCandidate(pool, candidate) || seenModels.has(candidate.model)) continue;
    seenModels.add(candidate.model);
    options.push({
      archetypeRank: rank,
      effort: candidate.effort ?? null,
      engine: candidate.engine,
      isArchetypeMatch: true,
      model: candidate.model,
    });
  }

  if (options.length === 0 && archetypeCandidates.some(hasCandidateRouteConstraints)) {
    return [];
  }

  const fallbackRole = ENGINE_FALLBACK_ROLES[poolEng] || "implementation";
  const engineDefaults = routeCandidatesForRole(fallbackRole, routesConfig);
  for (const [index, candidate] of engineDefaults.entries()) {
    if (!poolSupportsCandidate(pool, candidate) || seenModels.has(candidate.model)) continue;
    seenModels.add(candidate.model);
    options.push({
      archetypeRank: archetype ? 10 + index : index,
      effort: candidate.effort ?? null,
      engine: candidate.engine,
      isArchetypeMatch: false,
      model: candidate.model,
    });
  }

  const rawRoleCandidates = [...archetypeCandidates, ...engineDefaults];
  if (
    options.length === 0 &&
    rawRoleCandidates.some(
      (candidate) => candidate.engine === poolEng && hasCandidateRouteConstraints(candidate),
    )
  ) {
    return [];
  }

  if (options.length === 0) {
    const engine = poolEng;
    const defaultModel = Array.isArray(pool.models) && pool.models[0] ? pool.models[0] : engine;
    options.push({
      archetypeRank: archetype ? 20 : 0,
      effort: null,
      engine,
      isArchetypeMatch: false,
      model: defaultModel,
    });
  }

  return options;
}

function computeBlockedBy(issue, openIssueNumbers, closedIssueNumbers) {
  const deps = parseIssueDependencies(issue?.body);
  if (deps.length === 0) return [];
  return deps.filter((dep) => {
    if (closedIssueNumbers.has(dep)) return false;
    if (openIssueNumbers.size > 0) return openIssueNumbers.has(dep);
    return true;
  });
}

function buildIssueStateSets(issues, policy = {}) {
  const sourceIssues = Array.isArray(policy.openIssues) ? policy.openIssues : issues;
  const openIssueNumbers = new Set();
  const closedIssueNumbers = new Set();

  if (Array.isArray(sourceIssues)) {
    for (const item of sourceIssues) {
      const num = Number(item?.number);
      if (!Number.isSafeInteger(num) || num <= 0) continue;
      const state = String(item?.state ?? "open").toLowerCase();
      if (state === "closed") closedIssueNumbers.add(num);
      else openIssueNumbers.add(num);
    }
  }
  if (Array.isArray(policy.openIssueNumbers)) {
    for (const num of policy.openIssueNumbers) openIssueNumbers.add(Number(num));
  }
  if (Array.isArray(policy.closedIssueNumbers)) {
    for (const num of policy.closedIssueNumbers) {
      const parsed = Number(num);
      closedIssueNumbers.add(parsed);
      openIssueNumbers.delete(parsed);
    }
  }
  return { closedIssueNumbers, openIssueNumbers };
}

/**
 * Matches multiple open agent:ready issues across eligible spare-token pools,
 * honoring archetype route preferences while spreading work across distinct
 * harnesses, pools, and models so parallel workers do not drain a single provider.
 */
export function matchIssuesToPools(issues, lanes, activeAllowPaths = [], policy = {}) {
  if (!Array.isArray(issues)) return [];
  const { closedIssueNumbers, openIssueNumbers } = buildIssueStateSets(issues, policy);
  for (const issue of issues) {
    if (issue && typeof issue === "object") {
      issue.blockedBy = computeBlockedBy(issue, openIssueNumbers, closedIssueNumbers);
    }
  }

  const sparePools = selectSparePools(lanes, policy);
  if (sparePools.length === 0) return [];

  const routesConfig = policy.routes || loadDefaultRoutes();
  const runningAllowPaths = [...flattenActivePaths(activeAllowPaths)];
  const usedHarnesses = new Map();
  const usedPools = new Map();
  const usedModels = new Map();
  const matches = [];

  for (const issue of issues) {
    if (!isReadyCandidate(issue)) continue;
    if (Array.isArray(issue.blockedBy) && issue.blockedBy.length > 0) continue;
    const taskSpec = extractTaskSpec(issue.body);
    if (!taskSpec || !hasDisjointPaths(taskSpec.allow_paths, runningAllowPaths)) continue;

    const archetype = extractIssueArchetype(issue, taskSpec);
    let bestChoice = null;

    for (const pool of sparePools) {
      const poolKey = `${pool.accountId ?? ""}:${pool.poolId ?? pool.label ?? ""}`;
      const routeOptions = buildPoolRouteOptions(pool, archetype, routesConfig);

      for (const option of routeOptions) {
        const harnessUses = usedHarnesses.get(option.engine) ?? 0;
        const poolUses = usedPools.get(poolKey) ?? 0;
        const modelKey = `${option.engine}:${option.model}`;
        const modelUses = usedModels.get(modelKey) ?? 0;

        let archetypeBonus = 0;
        if (option.isArchetypeMatch) {
          if (option.archetypeRank === 0) archetypeBonus = 300;
          else if (option.archetypeRank === 1) archetypeBonus = 200;
          else archetypeBonus = 120;
        } else if (!archetype && option.archetypeRank === 0) {
          archetypeBonus = 25;
        }

        const diversityPenalty = poolUses * 2000 + harnessUses * 1500 + modelUses * 500;
        const compositeScore = pool.score + archetypeBonus - diversityPenalty;

        if (!bestChoice || compositeScore > bestChoice.compositeScore) {
          bestChoice = {
            compositeScore,
            modelKey,
            option,
            pool,
            poolKey,
          };
        }
      }
    }

    if (!bestChoice) continue;

    const { modelKey, option, pool, poolKey } = bestChoice;
    usedHarnesses.set(option.engine, (usedHarnesses.get(option.engine) ?? 0) + 1);
    usedPools.set(poolKey, (usedPools.get(poolKey) ?? 0) + 1);
    usedModels.set(modelKey, (usedModels.get(modelKey) ?? 0) + 1);
    for (const allowedPath of taskSpec.allow_paths) runningAllowPaths.push(allowedPath);

    const number = issue.number;
    const verifyCommand =
      taskSpec.verify_command || taskSpec.development_checks?.[0] || "corepack pnpm test";
    const effectiveArchetype =
      archetype || ENGINE_FALLBACK_ROLES[option.engine] || "implementation";
    const selectedRoute = {
      ...(archetype && { archetype }),
      ...(pool.accountId && { accountId: pool.accountId }),
      effort: option.effort,
      engine: option.engine,
      model: option.model,
    };

    matches.push({
      allowPaths: taskSpec.allow_paths,
      archetype,
      branch: `feat/issue-${number}`,
      classification: { archetype: effectiveArchetype },
      issue,
      pool: {
        ...pool,
        effort: option.effort,
        engine: option.engine,
        model: option.model,
      },
      selectedRoute,
      taskSpec,
      verifyCommand,
      worktreeSlug: `wt-issue-${number}`,
    });
  }

  return matches;
}

export const planBatch = matchIssuesToPools;

/**
 * Picks the highest-scoring eligible spare pool (with archetype route matching)
 * and matches it to the first open agent:ready issue with a valid embedded
 * task-spec and disjoint allow_paths.
 */
export function matchIssueToPool(issues, lanes, activeAllowPaths = [], policy = {}) {
  return matchIssuesToPools(issues, lanes, activeAllowPaths, policy)[0] ?? null;
}

/**
 * Copies untracked local `.env*` files and `<repoRoot>/.worktreeinclude` patterns
 * from `repoRoot` into `worktreePath`.
 */
export function bootstrapWorktreeInclude(repoRoot, worktreePath, options) {
  return bootstrapWorktreeIncludeShared(repoRoot, worktreePath, options);
}

export function resolveWorktreeGitDir(worktreePath) {
  const markerPath = resolveWorktreeMarkerPath(worktreePath);
  return markerPath ? path.dirname(markerPath) : path.join(path.resolve(worktreePath), ".git");
}

export function resolveTaskSpecPath(worktreePath) {
  return path.join(resolveWorktreeGitDir(worktreePath), "orkest", "task-spec.json");
}

export function resolveFoundryStatePath(worktreePath) {
  return path.join(resolveWorktreeGitDir(worktreePath), "orkest", "foundry-state.json");
}

export class FoundryStateError extends Error {
  constructor(problem, preservedPath = null) {
    super(`Foundry state ${problem.kind}: ${problem.path}: ${problem.error}`);
    this.name = "FoundryStateError";
    this.kind = problem.kind;
    this.path = problem.path;
    this.preservedPath = preservedPath;
  }
}

function lstatIfExists(targetPath) {
  try {
    return lstatSync(targetPath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function assertNonSymlinkDirectory(dirPath, label) {
  const info = lstatSync(dirPath);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`${label} is invalid or a symlink: ${dirPath}`);
  }
  return realpathSync(dirPath);
}

function readRegularFileNoFollow(filePath, label) {
  const fd = openSync(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) {
      throw new Error(`${label} is not a regular file: ${filePath}`);
    }
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

function canonicalizePathPreservingMissing(targetPath) {
  const resolved = path.resolve(targetPath);
  const missing = [];
  let cursor = resolved;
  while (true) {
    const info = lstatIfExists(cursor);
    if (info) {
      const canonicalAncestor = realpathSync(cursor);
      return missing.length > 0 ? path.join(canonicalAncestor, ...missing) : canonicalAncestor;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) return resolved;
    missing.unshift(path.basename(cursor));
    cursor = parent;
  }
}

function resolveValidatedWorktreeAdminDir(worktreePath) {
  const resolvedWorktree = path.resolve(worktreePath);
  const wtStat = lstatIfExists(resolvedWorktree);
  if (wtStat && (wtStat.isSymbolicLink() || !wtStat.isDirectory())) {
    throw new Error(`Foundry worktree path is invalid or a symlink: ${resolvedWorktree}`);
  }
  const dotGitPath = path.join(resolvedWorktree, ".git");
  const dotGitStat = lstatIfExists(dotGitPath);
  if (!dotGitStat) {
    if (wtStat) {
      const canonicalWorktree = realpathSync(resolvedWorktree);
      return {
        adminDir: null,
        pinnedTarget: { baseDir: canonicalWorktree, relParts: [".git", "orkest"] },
        statePath: path.join(canonicalWorktree, ".git", "orkest", "foundry-state.json"),
      };
    }
    return {
      adminDir: null,
      pinnedTarget: null,
      statePath: path.join(resolvedWorktree, ".git", "orkest", "foundry-state.json"),
    };
  }
  if (dotGitStat.isSymbolicLink()) {
    throw new Error(`Foundry worktree .git is a symlink: ${dotGitPath}`);
  }

  let canonicalAdminDir;
  const runRevParseGitDir = () => {
    try {
      const out = String(
        execFileSync("git", ["rev-parse", "--git-dir"], {
          cwd: resolvedWorktree,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }) ?? "",
      ).trim();
      return out || null;
    } catch {
      return null;
    }
  };

  if (dotGitStat.isFile()) {
    const dotGitText = readRegularFileNoFollow(dotGitPath, "Foundry worktree .git");
    const match = /^gitdir:\s*(.+)$/mu.exec(dotGitText);
    if (!match) {
      throw new Error(
        `Foundry worktree .git file does not point to a Git directory: ${dotGitPath}`,
      );
    }
    const rawAdminDir = path.resolve(resolvedWorktree, match[1].trim());
    canonicalAdminDir = assertNonSymlinkDirectory(
      rawAdminDir,
      "Foundry worktree Git admin directory",
    );
    const revParseGitDir = runRevParseGitDir();
    if (!revParseGitDir) {
      throw new Error(`Foundry worktree git rev-parse --git-dir failed for ${resolvedWorktree}`);
    }
    const canonicalRevParse = realpathSync(path.resolve(resolvedWorktree, revParseGitDir));
    if (canonicalRevParse !== canonicalAdminDir) {
      throw new Error(
        `Foundry worktree .git link disagrees with git rev-parse --git-dir: ${dotGitPath}`,
      );
    }
    const backlinkPath = path.join(canonicalAdminDir, "gitdir");
    const backlinkStat = lstatIfExists(backlinkPath);
    if (!backlinkStat || backlinkStat.isSymbolicLink() || !backlinkStat.isFile()) {
      throw new Error(
        `Foundry worktree Git backlink is missing, invalid, or a symlink: ${backlinkPath}`,
      );
    }
    const backlinkTarget = readRegularFileNoFollow(
      backlinkPath,
      "Foundry worktree Git backlink",
    ).trim();
    if (!backlinkTarget) {
      throw new Error(`Foundry worktree Git backlink is empty: ${backlinkPath}`);
    }
    const resolvedBacklink = realpathSync(path.resolve(canonicalAdminDir, backlinkTarget));
    const dotGitCanonical = realpathSync(dotGitPath);
    if (resolvedBacklink !== dotGitCanonical) {
      throw new Error(
        `Foundry worktree Git backlink does not point back to worktree .git: ${backlinkPath}`,
      );
    }
    const canonicalWorktree = realpathSync(resolvedWorktree);
    let worktreeListOut;
    try {
      worktreeListOut = String(
        execFileSync("git", ["worktree", "list", "--porcelain"], {
          cwd: resolvedWorktree,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }) ?? "",
      );
    } catch {
      throw new Error(`Foundry worktree registration check failed for ${resolvedWorktree}`);
    }
    const registeredWorktrees = worktreeListOut
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("worktree "))
      .map((line) => {
        try {
          return realpathSync(line.slice("worktree ".length).trim());
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    if (!registeredWorktrees.includes(canonicalWorktree)) {
      throw new Error(`Foundry worktree is not a registered Git worktree: ${resolvedWorktree}`);
    }
  } else if (dotGitStat.isDirectory()) {
    canonicalAdminDir = assertNonSymlinkDirectory(
      dotGitPath,
      "Foundry worktree Git admin directory",
    );
    const revParseGitDir = runRevParseGitDir();
    if (revParseGitDir) {
      const canonicalRevParse = realpathSync(path.resolve(resolvedWorktree, revParseGitDir));
      if (canonicalRevParse !== canonicalAdminDir) {
        throw new Error(
          `Foundry worktree .git directory disagrees with git rev-parse --git-dir: ${dotGitPath}`,
        );
      }
    }
  } else {
    throw new Error(`Foundry worktree .git is invalid: ${dotGitPath}`);
  }

  const orkestDir = path.join(canonicalAdminDir, "orkest");
  if (lstatIfExists(orkestDir)) {
    const canonicalOrkest = assertNonSymlinkDirectory(orkestDir, "Foundry orkest directory");
    if (canonicalOrkest !== orkestDir) {
      throw new Error(`Foundry orkest directory escapes adminDir: ${orkestDir}`);
    }
  }

  return {
    adminDir: canonicalAdminDir,
    pinnedTarget: { baseDir: canonicalAdminDir, relParts: ["orkest"] },
    statePath: path.join(canonicalAdminDir, "orkest", "foundry-state.json"),
  };
}

function resolveValidatedFoundryTarget(worktreePath, options = {}) {
  const { adminDir, statePath: explicitStatePath } = options;
  let canonicalAdminDir = null;
  if (adminDir !== undefined && adminDir !== null) {
    if (typeof adminDir !== "string" || !adminDir.trim()) {
      throw new Error("adminDir must be a non-empty path");
    }
    canonicalAdminDir = assertNonSymlinkDirectory(path.resolve(adminDir), "Foundry adminDir");
    const orkestDir = path.join(canonicalAdminDir, "orkest");
    if (lstatIfExists(orkestDir)) {
      const canonicalOrkest = assertNonSymlinkDirectory(orkestDir, "Foundry orkest directory");
      if (canonicalOrkest !== orkestDir) {
        throw new Error(`Foundry orkest directory escapes adminDir: ${orkestDir}`);
      }
    }
  }
  let targetPath;
  let pinnedTarget = null;
  if (explicitStatePath !== undefined && explicitStatePath !== null) {
    if (typeof explicitStatePath !== "string" || !explicitStatePath.trim()) {
      throw new Error("statePath must be a non-empty path");
    }
    const rawTarget = path.resolve(explicitStatePath);
    const targetStat = lstatIfExists(rawTarget);
    if (targetStat && (targetStat.isSymbolicLink() || !targetStat.isFile())) {
      throw new Error(`Foundry state path is invalid or a symlink: ${rawTarget}`);
    }
    const parentDir = path.dirname(rawTarget);
    if (lstatIfExists(parentDir)) {
      assertNonSymlinkDirectory(parentDir, "Foundry state directory");
    }
    targetPath = canonicalizePathPreservingMissing(rawTarget);
    if (canonicalAdminDir) {
      const expectedPath = path.join(canonicalAdminDir, "orkest", "foundry-state.json");
      if (
        path.dirname(targetPath) !== path.dirname(expectedPath) ||
        path.basename(targetPath) !== "foundry-state.json"
      ) {
        throw new Error(
          `Foundry statePath ${targetPath} escapes validated adminDir ${canonicalAdminDir}`,
        );
      }
      pinnedTarget = { baseDir: canonicalAdminDir, relParts: ["orkest"] };
    }
  } else if (canonicalAdminDir) {
    targetPath = path.join(canonicalAdminDir, "orkest", "foundry-state.json");
    pinnedTarget = { baseDir: canonicalAdminDir, relParts: ["orkest"] };
  } else {
    const resolved = resolveValidatedWorktreeAdminDir(worktreePath);
    targetPath = resolved.statePath;
    pinnedTarget = resolved.pinnedTarget;
  }
  const finalStat = lstatIfExists(targetPath);
  if (finalStat && (finalStat.isSymbolicLink() || !finalStat.isFile())) {
    throw new Error(`Foundry state path is invalid or a symlink: ${targetPath}`);
  }
  return { statePath: targetPath, pinnedTarget };
}

const FOUNDRY_DIRFD_PY = String.raw`
import hashlib, json, os, stat, sys, uuid

DIR_FLAGS = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
NOFOLLOW_RDONLY = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
NOFOLLOW_EXCL_WR = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)

def fsync_dir(fd):
    try:
        os.fsync(fd)
    except OSError:
        pass

def write_all_fd(fd, raw_bytes):
    view = memoryview(raw_bytes)
    offset = 0
    while offset < len(view):
        offset += os.write(fd, view[offset:])

def read_all_fd(fd):
    chunks = []
    while True:
        chunk = os.read(fd, 1024 * 1024)
        if not chunk:
            break
        chunks.append(chunk)
    return b"".join(chunks)

def open_pinned_dir(base_dir, expected_dev, expected_ino, rel_parts=None, create=False):
    cur_fd = os.open(base_dir, DIR_FLAGS)
    opened = [cur_fd]
    try:
        st = os.fstat(cur_fd)
        if (st.st_dev, st.st_ino) != (expected_dev, expected_ino):
            raise RuntimeError(f"Foundry state ancestor directory identity changed: {base_dir}")
        for part in (rel_parts or []):
            if not part or part == ".":
                continue
            if part == ".." or "/" in part or "\\" in part or "\0" in part:
                raise RuntimeError(f"Invalid foundry state path component: {part!r}")
            try:
                info = os.lstat(part, dir_fd=cur_fd)
                if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
                    raise RuntimeError(f"Foundry state directory is invalid or a symlink: {part}")
            except FileNotFoundError:
                if not create:
                    raise
                try:
                    os.mkdir(part, 0o700, dir_fd=cur_fd)
                    fsync_dir(cur_fd)
                except FileExistsError:
                    pass
            nxt_fd = os.open(part, DIR_FLAGS, dir_fd=cur_fd)
            opened.append(nxt_fd)
            cur_fd = nxt_fd
        return cur_fd, opened
    except Exception:
        for fd in reversed(opened):
            try:
                os.close(fd)
            except OSError:
                pass
        raise

op = sys.argv[1]
req = json.loads(sys.argv[2])
base_dir = req["base_dir"]
expected_dev = int(req["expected_dev"])
expected_ino = int(req["expected_ino"])
rel_parts = req.get("rel_parts") or []
filename = req["filename"]

try:
    dir_fd, opened = open_pinned_dir(
        base_dir, expected_dev, expected_ino, rel_parts=rel_parts, create=(op == "write_state")
    )
except FileNotFoundError as exc:
    if op == "read_state":
        sys.stdout.write(json.dumps({"ok": True, "missing": True}) + "\n")
        sys.exit(0)
    sys.stderr.write(str(exc) + "\n")
    sys.exit(1)
except Exception as exc:
    sys.stderr.write(str(exc) + "\n")
    sys.exit(1)

try:
    if op == "read_state":
        try:
            fd = os.open(filename, NOFOLLOW_RDONLY, dir_fd=dir_fd)
        except FileNotFoundError:
            sys.stdout.write(json.dumps({"ok": True, "missing": True}) + "\n")
            sys.exit(0)
        try:
            st_file = os.fstat(fd)
            if not stat.S_ISREG(st_file.st_mode):
                raise RuntimeError(f"Foundry state path is not a regular file: {filename}")
            raw = read_all_fd(fd)
        finally:
            os.close(fd)
        with os.fdopen(3, "wb") as transfer:
            transfer.write(raw)
            transfer.seek(0)
        sys.stdout.write(json.dumps({"ok": True, "missing": False}) + "\n")
    elif op == "write_state":
        with os.fdopen(3, "rb") as transfer:
            transfer.seek(0)
            payload = transfer.read()
        exclusive = bool(req.get("exclusive"))
        tmp_name = f".{filename}.tmp-{uuid.uuid4().hex}"
        tmp_fd = os.open(tmp_name, NOFOLLOW_EXCL_WR, 0o600, dir_fd=dir_fd)
        try:
            write_all_fd(tmp_fd, payload)
            os.fsync(tmp_fd)
        finally:
            os.close(tmp_fd)
        try:
            if exclusive:
                os.link(tmp_name, filename, src_dir_fd=dir_fd, dst_dir_fd=dir_fd)
                os.unlink(tmp_name, dir_fd=dir_fd)
            else:
                try:
                    info = os.lstat(filename, dir_fd=dir_fd)
                    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
                        raise RuntimeError(f"Foundry state path is invalid or a symlink: {filename}")
                except FileNotFoundError:
                    pass
                os.replace(tmp_name, filename, src_dir_fd=dir_fd, dst_dir_fd=dir_fd)
            fsync_dir(dir_fd)
        except Exception:
            try:
                os.unlink(tmp_name, dir_fd=dir_fd)
            except OSError:
                pass
            raise
        sys.stdout.write(json.dumps({"ok": True}) + "\n")
    elif op == "preserve_problem":
        kind = req["kind"]
        fd = os.open(filename, NOFOLLOW_RDONLY, dir_fd=dir_fd)
        try:
            raw = read_all_fd(fd)
        finally:
            os.close(fd)
        digest = hashlib.sha256(raw).hexdigest()[:16]
        preserved_name = f"{filename}.{kind}-{digest}"
        try:
            pfd = os.open(preserved_name, NOFOLLOW_EXCL_WR, 0o600, dir_fd=dir_fd)
        except FileExistsError:
            efd = os.open(preserved_name, NOFOLLOW_RDONLY, dir_fd=dir_fd)
            try:
                existing = read_all_fd(efd)
            finally:
                os.close(efd)
            if existing != raw:
                raise
        else:
            try:
                write_all_fd(pfd, raw)
                os.fsync(pfd)
            finally:
                os.close(pfd)
            fsync_dir(dir_fd)
        sys.stdout.write(json.dumps({"ok": True, "preservedName": preserved_name}) + "\n")
    else:
        raise RuntimeError(f"Unknown foundry dir_fd op: {op}")
except OSError as exc:
    sys.stderr.write(f"ERRNO:{exc.errno}:{exc.strerror}\n")
    sys.exit(2)
except Exception as exc:
    sys.stderr.write(str(exc) + "\n")
    sys.exit(1)
finally:
    for fd in reversed(opened):
        try:
            os.close(fd)
        except OSError:
            pass
`;

function pinDirHandle(baseDir, relParts = []) {
  const canonicalBase = assertNonSymlinkDirectory(baseDir, "Foundry state ancestor directory");
  const fd = openSync(
    canonicalBase,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  try {
    const dirStat = fstatSync(fd, { bigint: true });
    return {
      baseDir: canonicalBase,
      relParts,
      expectedDev: String(dirStat.dev),
      expectedIno: String(dirStat.ino),
    };
  } finally {
    closeSync(fd);
  }
}

function pinExistingAncestorDir(targetDir, pinnedTarget = null) {
  if (pinnedTarget?.baseDir) {
    return pinDirHandle(pinnedTarget.baseDir, pinnedTarget.relParts || []);
  }
  let cursor = path.resolve(targetDir);
  const relParts = [];
  while (!lstatIfExists(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    relParts.unshift(path.basename(cursor));
    cursor = parent;
  }
  return pinDirHandle(cursor, relParts);
}

function runFoundryDirFdOp(targetDir, { op, bytes, ...metadata }, pinnedTarget = null) {
  const pinned = pinExistingAncestorDir(targetDir, pinnedTarget);
  const request = JSON.stringify({
    ...metadata,
    base_dir: pinned.baseDir,
    expected_dev: pinned.expectedDev,
    expected_ino: pinned.expectedIno,
    rel_parts: pinned.relParts,
  });
  let transferFd;
  try {
    if (op === "write_state" || op === "read_state") {
      // Bulk state travels over an inherited regular file. Unlink our empty file before
      // writing any bytes so it has no pathname and both processes can close it safely.
      const spool = path.join(tmpdir(), `orkest-foundry-${randomUUID()}`);
      transferFd = openSync(spool, "wx+", 0o600);
      unlinkSync(spool);
      if (bytes) writeFileSync(transferFd, bytes);
    }
    const out = execFileSync("python3", ["-B", "-c", FOUNDRY_DIRFD_PY, op, request], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe", transferFd ?? "ignore"],
    });
    const result = JSON.parse(out);
    if (op === "read_state" && !result.missing) result.bytes = readFileSync(transferFd);
    return result;
  } catch (error) {
    const stderr = String(error.stderr || error.message || "").trim();
    const errnoMatch = /^ERRNO:(\d+):(.*)$/mu.exec(stderr);
    if (errnoMatch) {
      const errNo = Number(errnoMatch[1]);
      const msg = errnoMatch[2] || stderr;
      const fsErr = new Error(msg);
      switch (errNo) {
        case fsConstants.EEXIST: {
          fsErr.code = "EEXIST";
          break;
        }
        case fsConstants.ENOENT: {
          fsErr.code = "ENOENT";
          break;
        }
        case fsConstants.ELOOP: {
          fsErr.code = "ELOOP";
          break;
        }
        default: {
          break;
        }
      }
      throw fsErr;
    }
    throw new Error(stderr || "Foundry dir_fd operation failed", { cause: error });
  } finally {
    if (transferFd !== undefined) closeSync(transferFd);
  }
}

export function buildFoundryState(worktreePath, statePatch = {}, existing = null) {
  const resolvedWorktree = path.resolve(worktreePath);
  const prior = existing || {};
  const nowIso = new Date().toISOString();
  return {
    ...prior,
    ...statePatch,
    attemptCount: Math.max(statePatch.attemptCount ?? 1, prior.attemptCount ?? 1),
    maxAttempts: statePatch.maxAttempts ?? prior.maxAttempts ?? 2,
    schema: FOUNDRY_STATE_SCHEMA,
    targetBranch: statePatch.targetBranch ?? prior.targetBranch ?? "main",
    updatedAt: statePatch.updatedAt || nowIso,
    worktreePath: resolvedWorktree,
    worktreeSlug: statePatch.worktreeSlug ?? prior.worktreeSlug ?? path.basename(resolvedWorktree),
  };
}

export function loadFoundryState(worktreePath, options = {}) {
  let target;
  try {
    target = resolveValidatedFoundryTarget(worktreePath, options);
  } catch (error) {
    return {
      kind: "corrupt",
      state: null,
      path: options.statePath || resolveFoundryStatePath(worktreePath),
      error: error.message,
    };
  }
  const statePath = target.statePath;
  const result = { kind: "missing", state: null, path: statePath, error: null };
  const stateDir = path.dirname(statePath);
  if (!lstatIfExists(stateDir)) return result;
  let bytes;
  try {
    const readRes = runFoundryDirFdOp(
      stateDir,
      {
        op: "read_state",
        filename: path.basename(statePath),
      },
      target.pinnedTarget,
    );
    if (readRes.missing) return result;
    bytes = readRes.bytes;
  } catch (error) {
    if (error.code === "ENOENT") return result;
    return { ...result, kind: "corrupt", error: error.message };
  }
  let state;
  try {
    state = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    return { ...result, kind: "corrupt", error: error.message };
  }
  if (
    !state ||
    typeof state !== "object" ||
    Array.isArray(state) ||
    (Object.hasOwn(state, "schema") &&
      !["ork.foundry.state.v1", FOUNDRY_STATE_SCHEMA].includes(state.schema))
  ) {
    return {
      ...result,
      kind: "unsupported",
      error: "Unknown Foundry state schema or non-object state",
    };
  }
  return { ...result, kind: "ok", state };
}

export function readFoundryState(worktreePath) {
  const loaded = loadFoundryState(worktreePath);
  if (loaded.kind === "missing") return null;
  if (loaded.kind !== "ok") throw new FoundryStateError(loaded);
  return loaded.state;
}

function preserveFoundryProblem(problem, pinnedTarget = null) {
  // The canonical bytes stay in place: later reads must remain closed too.
  const stateDir = path.dirname(problem.path);
  const res = runFoundryDirFdOp(
    stateDir,
    {
      op: "preserve_problem",
      filename: path.basename(problem.path),
      kind: problem.kind,
    },
    pinnedTarget,
  );
  throw new FoundryStateError(problem, path.join(stateDir, res.preservedName));
}

export function writeFoundryState(worktreePath, statePatch = {}, options = {}) {
  const resolvedWorktree = path.resolve(worktreePath);
  const target = resolveValidatedFoundryTarget(resolvedWorktree, options);
  const statePath = target.statePath;
  const loaded = loadFoundryState(resolvedWorktree, options);
  if (!["missing", "ok"].includes(loaded.kind)) preserveFoundryProblem(loaded, target.pinnedTarget);
  const merged = buildFoundryState(resolvedWorktree, statePatch, loaded.state);
  const stateDir = path.dirname(statePath);
  const payload = Buffer.from(`${JSON.stringify(merged, null, 2)}\n`, "utf8");
  runFoundryDirFdOp(
    stateDir,
    {
      op: "write_state",
      filename: path.basename(statePath),
      bytes: payload,
      exclusive: Boolean(options.exclusive),
    },
    target.pinnedTarget,
  );
  return merged;
}

export function processIdentity(pid = process.pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const ticks = stat
      .slice(stat.lastIndexOf(")") + 1)
      .trim()
      .split(/\s+/u, 20)[19];
    if (ticks) return `proc-start-ticks:${ticks}`;
  } catch {
    // macOS has no /proc; use the same stable birth-time identity as native_bridge.
  }
  try {
    const started = String(
      execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
        encoding: "utf8",
        env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
        stdio: ["ignore", "pipe", "pipe"],
      }),
    ).trim();
    if (started) return started;
    throw new Error(`Process identity unavailable for PID ${pid}`);
  } catch (error) {
    // ps exits 1 without diagnostics for an absent PID. Other failures are unknown.
    if (error.status === 1 && !String(error.stderr || "").trim()) return null;
    throw error;
  }
}

export function createFoundryAttempt(
  state,
  { intent = "launch", route, pid = process.pid, now = new Date().toISOString() } = {},
) {
  if (!["launch", "repair"].includes(intent)) throw new Error("Invalid Foundry attempt intent");
  const number = (state?.attemptCount ?? 0) + 1;
  return {
    attemptCount: number,
    attempt: {
      id: randomUUID(),
      number,
      intent,
      status: "launching",
      startedAt: now,
      endedAt: null,
      launcher: { pid, processIdentity: processIdentity(pid), host: hostname() },
      route: {
        engine: route?.engine ?? null,
        model: route?.model ?? null,
        effort: route?.effort ?? null,
      },
      error: null,
    },
  };
}

export function updateFoundryAttempt(
  state,
  { status, error = null, now = new Date().toISOString() },
) {
  if (!state?.attempt || !["running", "finished", "failed", "uncertain"].includes(status)) {
    throw new Error("An existing Foundry attempt and valid status are required");
  }
  return {
    attemptCount: Math.max(state.attemptCount, state.attempt.number),
    attempt: { ...state.attempt, status, error, endedAt: status === "running" ? null : now },
  };
}

/** A missing or unverifiable launcher identity fails closed; never signal it. */
export function foundryLauncherAlive(state) {
  const launcher = state?.attempt?.launcher;
  if (
    !launcher ||
    !Number.isSafeInteger(launcher.pid) ||
    launcher.pid <= 0 ||
    launcher.host !== hostname() ||
    !launcher.processIdentity
  )
    return true;
  try {
    const identity = processIdentity(launcher.pid);
    return identity !== null && identity === launcher.processIdentity;
  } catch {
    return true;
  } // Unknown liveness must never authorize recovery.
}

/** Decode the runner protocol, stopping before model-authored final report text. */
export function parseRunnerOutput(stdout, { exitCode = 0 } = {}) {
  const raw = String(stdout ?? "");
  let reported = {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) reported = parsed;
  } catch {
    for (const line of raw.split(/\r?\n/u)) {
      if (line === "--- AGENT FINAL REPORT ---") break;
      const match = /^AGENT_(STATUS|OUTCOME|SESSION|RESULT)=(.*)$/u.exec(line);
      if (!match) continue;
      const fields = {
        STATUS: "status",
        OUTCOME: "task_outcome",
        SESSION: "session_id",
        RESULT: "result_path",
      };
      reported[fields[match[1]]] = match[2].trim();
      if (match[1] === "RESULT") break;
    }
  }
  const resultPath = reported.resultPath ?? reported.result_path ?? null;
  let result = reported;
  if (
    typeof resultPath === "string" &&
    path.isAbsolute(resultPath) &&
    path.basename(resultPath) === "result.json"
  ) {
    try {
      const saved = JSON.parse(readFileSync(resultPath, "utf8"));
      if (saved && typeof saved === "object" && !Array.isArray(saved)) {
        result = { ...reported, ...saved };
        if (typeof saved.status !== "string" || !saved.status.trim())
          result.status = reported.status;
      }
    } catch {
      // A surviving status line is sufficient; an absent status stays uncertain.
    }
  }
  return {
    ...result,
    status: result.status ?? null,
    taskOutcome: result.task_outcome ?? result.taskOutcome ?? null,
    sessionId: result.session_id ?? result.sessionId ?? null,
    resultPath,
    exitCode,
    raw,
  };
}

export async function runFoundryWorker(execAgentFn, args, options) {
  let agentResult;
  try {
    agentResult = await execAgentFn(args, options);
    if (typeof agentResult === "string") agentResult = parseRunnerOutput(agentResult);
  } catch (error) {
    const beforeStart =
      !error.pid &&
      !error.killed &&
      !error.signal &&
      ["ENOENT", "EACCES", "ENOEXEC"].includes(error.code) &&
      String(error.syscall || "").startsWith("spawn");
    return {
      agentResult: {
        error: beforeStart
          ? `Nothing was launched: ${error.message}`
          : error?.message || String(error),
      },
      outcome: beforeStart ? "failed" : "uncertain",
    };
  }
  const status =
    typeof agentResult?.status === "string" ? agentResult.status.toLowerCase().trim() : "";
  if (
    agentResult?.signal ||
    agentResult?.killed ||
    agentResult?.timedOut ||
    agentResult?.timed_out
  ) {
    return { agentResult, outcome: "uncertain" };
  }
  const exitCode = agentResult?.exitCode ?? agentResult?.exit_code;
  if (exitCode === 27) return { agentResult, outcome: "busy" };
  if (status === "native_handoff" || [4, 11, 13, 15, 17, 18, 28].includes(exitCode)) {
    return {
      agentResult: {
        ...agentResult,
        error: `Nothing was launched (runner status ${status || "unreported"}, exit ${exitCode ?? "unreported"})`,
      },
      outcome: "failed",
    };
  }
  if (!status) return { agentResult, outcome: "uncertain" };
  const taskOutcome = agentResult?.taskOutcome ?? agentResult?.task_outcome;
  const didComplete =
    ["completed", "complete"].includes(status) &&
    agentResult?.ok !== false &&
    !["failed", "blocked", "not_run"].includes(taskOutcome) &&
    (exitCode === undefined || exitCode === 0);
  return { agentResult, outcome: didComplete ? "finished" : "failed" };
}

export function countCommitsAhead(
  worktreePath,
  targetBranch = "main",
  { execFileSyncFn = execFileSync } = {},
) {
  try {
    const out = String(
      execFileSyncFn("git", ["rev-list", "--count", `${targetBranch}..HEAD`], {
        cwd: worktreePath,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }) ?? "",
    ).trim();
    const parsed = Number(out);
    if (out && Number.isSafeInteger(parsed) && parsed >= 0) {
      return { commitsAhead: parsed, resolved: true };
    }
  } catch {
    /* Non-git or uninitialized mock worktree directory. */
  }
  return { commitsAhead: 0, resolved: false };
}

export function hasWorktreeDirtyChanges(worktreePath, { execFileSyncFn = execFileSync } = {}) {
  try {
    const out = String(
      execFileSyncFn("git", ["status", "--porcelain"], {
        cwd: worktreePath,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }) ?? "",
    ).trim();
    return { isDirty: out.length > 0, resolved: true, statusText: out };
  } catch {
    return { isDirty: false, resolved: false, statusText: "" };
  }
}

export function commitBuilderWorktreeChanges(
  worktreePath,
  issueNumber,
  { execFileSyncFn = execFileSync } = {},
) {
  const message = issueNumber
    ? `feat(foundry): resolve #${issueNumber}`
    : "feat(foundry): apply builder changes";
  execFileSyncFn("git", ["add", "-A"], {
    cwd: worktreePath,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  execFileSyncFn("git", ["commit", "-m", message], {
    cwd: worktreePath,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return { committed: true, message };
}

/** Commit builder output before checks; check output is always left for inspection. */
export async function verifyBuilderWorktree(
  worktreePath,
  {
    issue,
    allowPaths = [],
    targetBranch = "main",
    command,
    execFileSyncFn = execFileSync,
    execVerifyFn = defaultExecVerify,
    assertHeld = () => {},
  } = {},
) {
  const git = (...args) => {
    assertHeld();
    return String(execFileSyncFn("git", args, { cwd: worktreePath, encoding: "utf8" }) ?? "");
  };
  const verification = {
    command,
    kind: "development",
    candidate: null,
    exitCode: null,
    ok: false,
    output: "",
    status: "not_run",
    verifiedAt: new Date().toISOString(),
    committedByHost: false,
  };
  const failure = (status, reason, extra = {}) => ({
    status,
    commitsAhead: null,
    verification: { ...verification, reason, ...extra },
  });
  let candidate;
  let commitsAhead;
  try {
    const paths = new Set(
      [
        ...git("diff", "--name-only", "--no-renames", "-z", "HEAD").split("\0"),
        ...git("ls-files", "--others", "--exclude-standard", "-z").split("\0"),
      ].filter(Boolean),
    );
    const violations = [...paths].filter(
      (changed) =>
        !allowPaths.some((raw) => {
          const allowed = normalizeRelativePath(raw);
          return (
            allowed === "." ||
            (allowed && (changed === allowed || changed.startsWith(`${allowed}/`)))
          );
        }),
    );
    if (violations.length > 0)
      return {
        ...failure("scope_violated", `Files outside allow_paths: ${violations.join(", ")}`),
        scopeViolations: violations,
      };
    if (git("status", "--porcelain")) {
      try {
        assertHeld();
        commitBuilderWorktreeChanges(worktreePath, issue, { execFileSyncFn });
        verification.committedByHost = true;
      } catch (error) {
        return failure("commit_failed", error.message);
      }
    }
    candidate = {
      commit: git("rev-parse", "HEAD").trim(),
      tree: git("rev-parse", "HEAD^{tree}").trim(),
    };
    if (!candidate.commit || !candidate.tree)
      throw new Error("Cannot resolve verification candidate");
    verification.candidate = candidate;
    const counted = countCommitsAhead(worktreePath, targetBranch, { execFileSyncFn });
    if (!counted.resolved) throw new Error("Cannot resolve commit count");
    commitsAhead = counted.commitsAhead;
  } catch (error) {
    return failure("verification_failed", error.message);
  }
  const beforeCheck = hasWorktreeDirtyChanges(worktreePath, { execFileSyncFn });
  if (!beforeCheck.resolved || beforeCheck.isDirty)
    return {
      ...failure("verification_mutated_workspace", "Workspace is dirty after builder commit"),
      commitsAhead,
    };
  let result;
  try {
    assertHeld();
    result = await execVerifyFn(command, { cwd: worktreePath, issue });
  } catch (error) {
    result = { ok: false, exitCode: error.status ?? 1, output: error.message };
  }
  const exitCode = result?.exitCode ?? (result?.ok === true ? 0 : 1);
  const isPassed = exitCode === 0 && result?.ok !== false;
  Object.assign(verification, {
    exitCode,
    output: result?.output || "",
    status: isPassed ? "passed" : "failed",
    ok: isPassed,
  });
  const dirty = hasWorktreeDirtyChanges(worktreePath, { execFileSyncFn });
  assertHeld();
  if (git("rev-parse", "HEAD").trim() !== candidate.commit || !dirty.resolved || dirty.isDirty) {
    return {
      status: "verification_mutated_workspace",
      commitsAhead,
      verification: {
        ...verification,
        ok: false,
        status: "failed",
        reason: "Verification changed HEAD or left a dirty workspace",
      },
    };
  }
  return { status: isPassed ? "verified" : "verification_failed", commitsAhead, verification };
}

export function resolveWorktreeHeadSha(worktreePath, { execFileSyncFn = execFileSync } = {}) {
  try {
    const out = String(
      execFileSyncFn("git", ["rev-parse", "HEAD"], {
        cwd: worktreePath,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }) ?? "",
    ).trim();
    return /^[0-9a-f]{7,40}$/iu.test(out) ? out : null;
  } catch {
    return null;
  }
}

export function collectActiveWorktreeAllowPaths(
  repoRoot = process.cwd(),
  { execFileSyncFn = execFileSync } = {},
) {
  const resolvedRoot = path.resolve(repoRoot);
  let porcelain;
  try {
    porcelain = String(
      execFileSyncFn("git", ["worktree", "list", "--porcelain"], {
        cwd: resolvedRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }) ?? "",
    );
  } catch {
    return [];
  }
  const activeAllowPaths = [];
  for (const rawLine of porcelain.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line.startsWith("worktree ")) continue;
    const wtPath = path.resolve(line.slice("worktree ".length).trim());
    if (wtPath === resolvedRoot) continue;
    const gitDir = resolveWorktreeGitDir(wtPath);
    const markerFile = resolveWorktreeMarkerPath(wtPath) || path.join(gitDir, "orkest.json");
    if (!existsSync(markerFile)) continue;
    let marker;
    try {
      marker = JSON.parse(readFileSync(markerFile, "utf8"));
    } catch {
      marker = null;
    }
    if (!marker || marker.disposable === false) continue;
    const loadedState = loadFoundryState(wtPath);
    if (loadedState.kind === "ok" && ["merged", "abandoned"].includes(loadedState.state.status))
      continue;
    const specFile = resolveTaskSpecPath(wtPath);
    if (!existsSync(specFile)) continue;
    try {
      const spec = JSON.parse(readFileSync(specFile, "utf8"));
      if (Array.isArray(spec?.allow_paths) && spec.allow_paths.length > 0) {
        activeAllowPaths.push(spec.allow_paths);
      }
    } catch {
      /* Ignore unreadable task-spec in worktree. */
    }
  }
  return activeAllowPaths;
}

async function defaultExecVerify(command, { cwd = process.cwd() } = {}) {
  try {
    const { stderr = "", stdout = "" } = await execute("/bin/sh", ["-c", command], {
      cwd,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 300_000,
    });
    return {
      exitCode: 0,
      ok: true,
      output: `${stdout}${stderr}`.trim(),
    };
  } catch (error) {
    const output = `${error?.stdout ?? ""}${error?.stderr ?? ""}${error?.message ?? ""}`.trim();
    return {
      exitCode: typeof error?.code === "number" ? error.code : 1,
      ok: false,
      output,
    };
  }
}

export async function loadFactoryPolicy(repoRoot = process.cwd()) {
  const explicitPolicy = envFirst("ORCHESTRATE_FACTORY_CONFIG", "AGENT_EXECUTOR_FACTORY_CONFIG");
  const configDir = path.dirname(configPath());
  const policyPath = explicitPolicy || path.join(configDir, "factory.json");
  let basePolicy = {};
  try {
    basePolicy = JSON.parse(await readFile(policyPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (repoRoot) {
    const resolvedRepo = path.resolve(repoRoot);
    const repoPolicyPath = path.join(resolvedRepo, ".orkest", "policy.json");
    try {
      const repoPolicy = JSON.parse(await readFile(repoPolicyPath, "utf8"));
      if (Array.isArray(repoPolicy?.deny) && repoPolicy.deny.length > 0) {
        const mergedDeny = [
          ...(Array.isArray(basePolicy.deny) ? basePolicy.deny : []),
          ...repoPolicy.deny,
        ];
        basePolicy = {
          ...basePolicy,
          deny: [...new Set(mergedDeny)],
        };
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    try {
      const resolved = resolveRepoPolicy(resolvedRepo, { strict: false });
      if (Array.isArray(resolved?.deny) && resolved.deny.length > 0) {
        basePolicy = {
          ...basePolicy,
          deny: [
            ...new Set([
              ...(Array.isArray(basePolicy.deny) ? basePolicy.deny : []),
              ...resolved.deny,
            ]),
          ],
        };
      }
    } catch {
      // Keep factory/local policy if canonical repo policy cannot be resolved.
    }
  }
  return basePolicy;
}

async function defaultExecGh(args, { cwd = process.cwd() } = {}) {
  const { stdout } = await execute("gh", args, {
    cwd,
    maxBuffer: 8 * 1024 * 1024,
    timeout: 30_000,
  });
  return JSON.parse(stdout);
}

async function defaultExecAgent(
  args,
  {
    cwd = process.cwd(),
    env = process.env,
    runnerScriptPath = path.join(scriptsDir, "run_agent.py"),
  } = {},
) {
  try {
    const { stdout } = await execute("python3", [runnerScriptPath, ...args], {
      cwd,
      env,
      maxBuffer: 16 * 1024 * 1024,
    });
    return parseRunnerOutput(stdout);
  } catch (error) {
    if (typeof error.code !== "number" || error.signal || error.killed) throw error;
    return parseRunnerOutput(error.stdout, { exitCode: error.code });
  }
}

async function provisionDisposableWorktree(
  cwd,
  worktreeSlug,
  branch,
  _issue,
  _engine,
  { env = process.env } = {},
) {
  const resolvedCwd = path.resolve(cwd);
  const repoName = path.basename(resolvedCwd);
  const worktreeBase = path.join(cacheHome(env), "worktrees", repoName);
  const worktreePath = path.join(worktreeBase, worktreeSlug);
  if (existsSync(worktreePath)) {
    throw new Error(`Disposable worktree path already exists: ${worktreePath}`);
  }
  await mkdir(worktreeBase, { recursive: true });
  await execute("git", ["worktree", "add", "-b", branch, worktreePath, "HEAD"], {
    cwd: resolvedCwd,
    timeout: 30_000,
  });
  return worktreePath;
}

function renderStatusPanel(statusData, width, options = {}) {
  const tier = options.tier || glyphTier();
  const bodyWidth = Math.max(20, width - 6);
  const summary = `${statusData.sparePools.length} spare pools · ${statusData.readyIssues.length} ready issues · ${statusData.rawIssues.length} raw issues`;
  const poolRows =
    statusData.sparePools.length > 0
      ? statusData.sparePools.map((pool) => [
          pool.label || `${pool.accountId}:${pool.poolId}`,
          pool.expiring ? "expiring" : `+${pool.surplusPts} pts`,
          `${Math.floor(pool.availableNowPct ?? 100)}%`,
          pool.route || pool.engine || pool.accountId || "--",
        ])
      : [["None", "--", "--", "No spare pools meet threshold"]];
  const poolTable = renderTable(["Spare pool", "Surplus", "Now", "Route"], poolRows, bodyWidth, {
    tier,
    weights: [0.36, 0.2, 0.14, 0.3],
  });

  const readyRows =
    statusData.readyIssues.length > 0
      ? statusData.readyIssues.map((issue) => {
          let specStatus = "invalid spec";
          if (Array.isArray(issue.blockedBy) && issue.blockedBy.length > 0) {
            specStatus = `blocked (#${issue.blockedBy.join(", #")})`;
          } else if (issue.validSpec) {
            specStatus = issue.disjoint ? "ready (disjoint)" : "collision";
          }
          return [`#${issue.number}`, issue.title, specStatus, issue.allowPaths.join(", ") || "--"];
        })
      : [["--", "No open agent:ready issues", "--", "--"]];
  const readyTable = renderTable(
    ["Issue", "Title", "Spec / Paths", "Allow paths"],
    readyRows,
    bodyWidth,
    {
      tier,
      weights: [0.1, 0.36, 0.22, 0.32],
    },
  );

  const rawLine =
    statusData.rawIssues.length > 0
      ? `Raw backlog (agent:raw): ${statusData.rawIssues.map((item) => `#${item.number} ${item.title}`).join(" · ")}`
      : "Raw backlog (agent:raw): none";
  const matchLine = statusData.nextMatch
    ? `Next dispatch: #${statusData.nextMatch.issue.number} -> ${statusData.nextMatch.pool.label || statusData.nextMatch.pool.poolId} [${statusData.nextMatch.selectedRoute.engine}/${statusData.nextMatch.selectedRoute.model}] (${statusData.nextMatch.worktreeSlug} on ${statusData.nextMatch.branch})`
    : "Next dispatch: none";

  const body = [
    ...poolTable,
    "",
    ...readyTable,
    "",
    ...wrapText(rawLine, bodyWidth),
    ...wrapText(matchLine, bodyWidth),
  ];

  return renderPanel("Factory", [summary, ...body], width, {
    color: options.color,
    glyphs: glyphSet(tier),
  })
    .map((line) => line.trimEnd())
    .join("\n");
}

async function fetchOpenIssues(execGh, repo, cwd) {
  const args = [
    "issue",
    "list",
    "--state",
    "open",
    "--limit",
    "100",
    "--json",
    "number,title,labels,body",
  ];
  if (repo) args.push("--repo", repo);
  const issues = await execGh(args, { cwd });
  return Array.isArray(issues) ? issues : [];
}

async function fetchSingleIssue(execGh, issueNumber, repo, cwd) {
  const args = ["issue", "view", String(issueNumber), "--json", "number,title,labels,body"];
  if (repo) args.push("--repo", repo);
  const result = await execGh(args, { cwd });
  if (Array.isArray(result)) {
    return result.find((entry) => Number(entry.number) === Number(issueNumber)) ?? result[0];
  }
  return result;
}

function serializeMatch(match) {
  return {
    allowPaths: match.allowPaths,
    archetype: match.archetype,
    branch: match.branch,
    classification: match.classification,
    issue: { number: match.issue.number, title: match.issue.title },
    pool: poolSummary(match.pool),
    selectedRoute: match.selectedRoute,
    verifyCommand: match.verifyCommand,
    worktreeSlug: match.worktreeSlug,
  };
}

export async function foundryCommand(
  argv = [],
  {
    activeAllowPaths,
    countCommitsAheadFn,
    cwd = process.cwd(),
    env = process.env,
    execAgentFn = defaultExecAgent,
    execFileSyncFn,
    execGhFn = defaultExecGh,
    execVerifyFn,
    getAccountsFn = getAccounts,
    policy: policyOverride,
    provisionWorktreeFn = provisionDisposableWorktree,
    runnerScriptPath,
    stdout = process.stdout,
    targetBranch = "main",
  } = {},
) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    args: argv,
    options: {
      acceptance: { type: "string" },
      "dry-run": { type: "boolean" },
      help: { short: "h", type: "boolean" },
      issue: { type: "string" },
      json: { type: "boolean" },
      once: { type: "boolean" },
      repo: { type: "string" },
      verify: { type: "string" },
      width: { type: "string" },
    },
  });

  if (values.help) {
    stdout.write(FOUNDRY_HELP);
    return;
  }

  const action = positionals[0] || "status";
  if (!["status", "run", "groom"].includes(action)) {
    throw new Error(`Unknown factory subcommand: ${action}`);
  }

  const width = Number(values.width || stdout.columns || 120);
  if (!Number.isSafeInteger(width) || width < 40 || width > 1000) {
    throw new Error("Width must be 40–1000");
  }

  if (action === "groom") {
    const issueNumber = Number(values.issue ?? "");
    if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
      throw new Error("ork factory groom requires --issue <number>");
    }
    const issue = await fetchSingleIssue(execGhFn, issueNumber, values.repo, cwd);
    if (!issue) throw new Error(`Issue #${issueNumber} not found`);
    const prompt = [
      `Groom GitHub Issue #${issue.number}: ${issue.title}`,
      "",
      issue.body || "",
      "",
      'Produce a validated ```json task-spec block with schema "agent-executor.task-spec.v1", objective, allow_paths, development_checks, and acceptance_criteria.',
    ].join("\n");
    const consultArgs = ["consult", "--intent", "investigate", "--read", cwd, "--question", prompt];
    const commandString = `run_agent.py consult --intent investigate --read ${cwd} --issue ${issue.number}`;
    if (values["dry-run"]) {
      const payload = {
        command: commandString,
        consultArgs,
        dryRun: true,
        issue: { number: issue.number, title: issue.title },
        schema: "ork.factory.groom.v1",
      };
      if (values.json) stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      else stdout.write(`Dry run groom #${issue.number}: ${commandString}\n`);
      return payload;
    }
    const response = await execAgentFn(consultArgs, { cwd, env, runnerScriptPath });
    const text =
      typeof response === "string"
        ? response
        : response?.response || response?.stdout || response?.raw || JSON.stringify(response);
    const taskSpec = extractTaskSpec(text);
    const payload = {
      command: commandString,
      dryRun: false,
      issue: { number: issue.number, title: issue.title },
      schema: "ork.factory.groom.v1",
      taskSpec,
    };
    if (values.json) stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else stdout.write(`${JSON.stringify(taskSpec ?? response, null, 2)}\n`);
    return payload;
  }

  const effectiveActiveAllowPaths =
    activeAllowPaths ?? collectActiveWorktreeAllowPaths(cwd, { execFileSyncFn });
  const filePolicy = await loadFactoryPolicy(cwd);
  const openIssues = await fetchOpenIssues(execGhFn, values.repo, cwd);
  const policy = { ...filePolicy, openIssues, ...policyOverride };
  const accounts = await getAccountsFn();
  const accountsById = new Map(
    (Array.isArray(accounts) ? accounts : []).map((acct) => [acct?.id, acct]),
  );
  const lanes = buildLanes(accounts).map((lane) => {
    const acct = accountsById.get(lane.accountId);
    if (!acct) return lane;
    const tags = normalizeAccountTags({ ...acct, ...lane });
    const accountEnv =
      lane.accountEnv ?? acct.accountEnv ?? (acct.env?.HOME ? { HOME: acct.env.HOME } : null);
    return {
      ...lane,
      ...(acct.alias && !lane.alias && { alias: acct.alias }),
      ...(Array.isArray(acct.aliases) && !lane.aliases && { aliases: acct.aliases }),
      ...(acct.accountHome && !lane.accountHome && { accountHome: acct.accountHome }),
      ...(accountEnv && !lane.accountEnv && { accountEnv }),
      ...(acct.configDir && !lane.configDir && { configDir: acct.configDir }),
      ...(acct.claudeConfigDir &&
        !lane.claudeConfigDir && { claudeConfigDir: acct.claudeConfigDir }),
      ...(acct.category && !lane.category && { category: acct.category }),
      ...(acct.billing && !lane.billing && { billing: acct.billing }),
      ...(tags.length > 0 && { tags }),
    };
  });
  const sparePools = selectSparePools(lanes, policy);

  if (action === "status") {
    const { closedIssueNumbers, openIssueNumbers } = buildIssueStateSets(openIssues, policy);
    const readyIssues = openIssues
      .filter((issue) => hasIssueLabel(issue, "agent:ready"))
      .map((issue) => {
        const spec = extractTaskSpec(issue.body);
        const blockedBy = computeBlockedBy(issue, openIssueNumbers, closedIssueNumbers);
        return {
          allowPaths: spec?.allow_paths ?? [],
          archetype: extractIssueArchetype(issue, spec),
          blockedBy,
          disjoint: spec ? hasDisjointPaths(spec.allow_paths, effectiveActiveAllowPaths) : false,
          number: issue.number,
          taskSpec: spec,
          title: issue.title,
          validSpec: Boolean(spec),
        };
      });
    const rawIssues = openIssues
      .filter((issue) => hasIssueLabel(issue, "agent:raw"))
      .map((issue) => ({
        number: issue.number,
        title: issue.title,
      }));
    const batch = matchIssuesToPools(openIssues, lanes, effectiveActiveAllowPaths, policy);
    const match = batch[0] ?? null;
    const statusPayload = {
      nextMatch: match ? serializeMatch(match) : null,
      plannedBatch: batch.map(serializeMatch),
      rawIssues,
      readyIssues,
      schema: "ork.factory.status.v1",
      sparePools: sparePools.map(poolSummary),
    };
    if (values.json) {
      stdout.write(`${JSON.stringify(statusPayload, null, 2)}\n`);
    } else {
      stdout.write(
        `${renderStatusPanel(statusPayload, width, {
          color: shouldUseColor(stdout),
          tier: glyphTier(),
        })}\n`,
      );
    }
    return statusPayload;
  }

  let candidateIssues = openIssues;
  if (values.issue !== undefined) {
    const requestedNumber = Number(values.issue);
    if (!Number.isSafeInteger(requestedNumber) || requestedNumber <= 0) {
      throw new Error("Invalid --issue <number>");
    }
    candidateIssues = openIssues.filter((issue) => Number(issue.number) === requestedNumber);
  }

  const batch = matchIssuesToPools(candidateIssues, lanes, effectiveActiveAllowPaths, policy);
  const match = batch[0] ?? null;
  if (!match) {
    const emptyPayload = {
      dryRun: Boolean(values["dry-run"]),
      matched: false,
      once: Boolean(values.once),
      reason:
        sparePools.length === 0
          ? "No eligible spare-token pools available"
          : "No compatible agent:ready issue with disjoint allow_paths",
      schema: "ork.factory.run.v1",
    };
    if (values.json) stdout.write(`${JSON.stringify(emptyPayload, null, 2)}\n`);
    else stdout.write(`ork factory: ${emptyPayload.reason}\n`);
    return emptyPayload;
  }

  if (typeof values.verify === "string" && values.verify.trim().length > 0) {
    const rawVerifyOverride = values.verify.trim();
    match.verifyCommand = rawVerifyOverride;
    match.taskSpec = {
      ...match.taskSpec,
      verify_command: rawVerifyOverride,
    };
  }
  if (typeof values.acceptance === "string" && values.acceptance.trim().length > 0) {
    match.taskSpec = {
      ...match.taskSpec,
      acceptance_criteria: [values.acceptance.trim()],
    };
  }
  const acceptanceCriteria = Array.isArray(match.taskSpec?.acceptance_criteria)
    ? match.taskSpec.acceptance_criteria
    : [];

  const repoName = path.basename(path.resolve(cwd));
  const plannedWorktreePath = path.join(cacheHome(env), "worktrees", repoName, match.worktreeSlug);
  const runPayload = {
    acceptanceCriteria,
    allowPaths: match.allowPaths,
    archetype: match.archetype,
    batch: batch.map(serializeMatch),
    branch: match.branch,
    classification: match.classification,
    dryRun: Boolean(values["dry-run"]),
    issue: { number: match.issue.number, title: match.issue.title },
    matched: true,
    once: Boolean(values.once),
    pool: poolSummary(match.pool),
    schema: "ork.factory.run.v1",
    selectedRoute: match.selectedRoute,
    taskSpec: match.taskSpec,
    verifyCommand: match.verifyCommand,
    worktreePath: plannedWorktreePath,
    worktreeSlug: match.worktreeSlug,
  };

  if (values["dry-run"]) {
    if (values.json) {
      stdout.write(`${JSON.stringify(runPayload, null, 2)}\n`);
    } else {
      stdout.write(
        [
          `Matched issue: #${runPayload.issue.number} ${runPayload.issue.title}`,
          `Spare pool: ${runPayload.pool.label || `${runPayload.pool.accountId}:${runPayload.pool.poolId}`} (${runPayload.pool.expiring ? "expiring" : `+${runPayload.pool.surplusPts} pts`})`,
          `Route: ${runPayload.selectedRoute.engine} / ${runPayload.selectedRoute.model}${runPayload.selectedRoute.effort ? ` / ${runPayload.selectedRoute.effort}` : ""}`,
          `Worktree: ${runPayload.worktreeSlug} (${runPayload.worktreePath})`,
          `Branch: ${runPayload.branch}`,
          `Verify: ${runPayload.verifyCommand}`,
        ].join("\n") + "\n",
      );
    }
    return runPayload;
  }

  const worktreePath = await provisionWorktreeFn(
    cwd,
    match.worktreeSlug,
    match.branch,
    match.issue.number,
    match.selectedRoute?.engine || null,
    { env },
  );
  const initialLease = await acquireWorkspaceLease(worktreePath, { env });
  if (!initialLease.acquired) {
    const busy = {
      ...runPayload,
      ok: false,
      status: "busy",
      worktreePath,
      reason: `Workspace lease busy: ${worktreePath}`,
    };
    if (values.json) stdout.write(`${JSON.stringify(busy, null, 2)}\n`);
    else stdout.write(`${busy.reason}\n`);
    process.exitCode = 1;
    return busy;
  }
  const specFile = resolveTaskSpecPath(worktreePath);
  let launchingState;
  try {
    assertWorkspaceLease(initialLease);
    if (loadFoundryState(worktreePath).kind !== "missing") {
      throw new Error(`Foundry state already exists: ${worktreePath}`);
    }
    bootstrapWorktreeInclude(cwd, worktreePath);
    await mkdir(path.dirname(specFile), { recursive: true });
    assertWorkspaceLease(initialLease);
    await writeFile(specFile, `${JSON.stringify(match.taskSpec, null, 2)}\n`);
    assertWorkspaceLease(initialLease);
    launchingState = writeFoundryState(worktreePath, {
      ...createFoundryAttempt(null, { route: match.selectedRoute }),
      acceptanceCriteria,
      allowPaths: match.allowPaths,
      branch: match.branch,
      issue: { number: match.issue.number, title: match.issue.title },
      maxAttempts: 2,
      status: "launching",
      targetBranch,
      verifyCommand: enforceScopedVerifyCommand(match.verifyCommand),
      worktreeSlug: match.worktreeSlug,
    });
    await writeFile(
      path.join(resolveWorktreeGitDir(worktreePath), "orkest.json"),
      `${JSON.stringify(
        {
          branch: match.branch,
          createdAt: new Date().toISOString(),
          disposable: true,
          engine: match.selectedRoute.engine,
          issue: match.issue.number,
          parentCwd: path.resolve(cwd),
          slug: match.worktreeSlug,
        },
        null,
        2,
      )}\n`,
    );
    assertWorkspaceLease(initialLease);
  } finally {
    await initialLease.release();
  }
  const routeArchetype = match.classification?.archetype || match.archetype;
  const accountId = match.pool?.accountId || match.selectedRoute?.accountId || null;
  const agentArgs = [
    "--cwd",
    worktreePath,
    "--task-spec",
    specFile,
    ...(routeArchetype ? ["--route", routeArchetype] : []),
    "--engine",
    match.selectedRoute.engine,
    ...(accountId ? ["--account", accountId] : []),
    "--model",
    match.selectedRoute.model,
    "--verify-command",
    match.verifyCommand,
  ];
  if (match.selectedRoute.effort) agentArgs.push("--effort", match.selectedRoute.effort);
  const { agentResult, outcome } = await runFoundryWorker(execAgentFn, agentArgs, {
    cwd: worktreePath,
    env,
    runnerScriptPath,
  });
  const rawAgentStatus = agentResult?.status || outcome;
  const didBuilderSucceed = outcome === "finished";
  const finalLease = outcome === "busy" ? null : await acquireWorkspaceLease(worktreePath, { env });
  if (!finalLease?.acquired) {
    const busy = {
      ...runPayload,
      executed: true,
      ok: false,
      status: "busy",
      worktreePath,
      reason: `Workspace lease busy after launch: ${worktreePath}`,
      foundryState: launchingState,
    };
    if (values.json) stdout.write(`${JSON.stringify(busy, null, 2)}\n`);
    else stdout.write(`${busy.reason}\n`);
    process.exitCode = 1;
    return busy;
  }
  try {
    assertWorkspaceLease(finalLease);
    const currentState = readFoundryState(worktreePath);
    if (currentState?.attempt?.id !== launchingState.attempt.id) {
      return { ...runPayload, ok: false, status: "stale", worktreePath };
    }

    let commitsAhead;
    if (typeof countCommitsAheadFn === "function") {
      commitsAhead = Number(await countCommitsAheadFn(worktreePath, targetBranch));
    } else {
      const counted = countCommitsAhead(worktreePath, targetBranch, { execFileSyncFn });
      commitsAhead = counted.resolved ? counted.commitsAhead : null;
    }
    assertWorkspaceLease(finalLease);
    const dirtyCheck = hasWorktreeDirtyChanges(worktreePath, { execFileSyncFn });
    const isDirtyWorktree = dirtyCheck.isDirty;
    const hasWorktreeChanges = commitsAhead === null || commitsAhead > 0 || isDirtyWorktree;

    const normalizedVerifyCommand = enforceScopedVerifyCommand(match.verifyCommand);
    const nowIso = new Date().toISOString();
    let verification;
    let finalStatus;
    let scopeViolations;

    if (!didBuilderSucceed || !hasWorktreeChanges) {
      finalStatus = outcome === "uncertain" ? "launch_uncertain" : "worker_failed";
      verification = {
        acceptanceCriteria,
        command: normalizedVerifyCommand,
        exitCode: null,
        ok: false,
        output: "",
        reason: didBuilderSucceed
          ? "Builder produced 0 commits and no working-tree changes"
          : agentResult?.error || `Builder exited with status ${rawAgentStatus}`,
        status: "skipped",
        verifiedAt: nowIso,
      };
    } else {
      const checked = await verifyBuilderWorktree(worktreePath, {
        issue: match.issue.number,
        allowPaths: match.allowPaths,
        targetBranch,
        command: normalizedVerifyCommand,
        execFileSyncFn,
        execVerifyFn: execVerifyFn || defaultExecVerify,
        assertHeld: () => assertWorkspaceLease(finalLease),
      });
      commitsAhead = checked.commitsAhead;
      finalStatus = checked.status;
      scopeViolations = checked.scopeViolations;
      verification = { ...checked.verification, acceptanceCriteria };
    }

    const headSha = resolveWorktreeHeadSha(worktreePath, { execFileSyncFn });
    const foundryStateFile = resolveFoundryStatePath(worktreePath);
    assertWorkspaceLease(finalLease);
    const foundryState = writeFoundryState(worktreePath, {
      ...updateFoundryAttempt(currentState, {
        status: outcome,
        error:
          agentResult?.error ||
          (outcome === "uncertain" ? "Runner result unavailable or ambiguous" : null),
      }),
      acceptanceCriteria,
      branch: match.branch,
      commitsAhead,
      headSha,
      issue: { number: match.issue.number, title: match.issue.title },
      lastRun: {
        engine: match.selectedRoute.engine,
        model: match.selectedRoute.model,
        resultPath: agentResult?.result_path ?? agentResult?.resultPath ?? null,
        sessionId: agentResult?.session_id ?? agentResult?.sessionId ?? null,
        status: rawAgentStatus,
      },
      maxAttempts: 2,
      status: finalStatus,
      targetBranch,
      updatedAt: verification.verifiedAt,
      verification,
      ...(scopeViolations && { scopeViolations }),
      verifyCommand: normalizedVerifyCommand,
      worktreePath,
      worktreeSlug: match.worktreeSlug,
    });

    const executedPayload = {
      ...runPayload,
      agentArgs,
      agentResult,
      commitsAhead,
      executed: true,
      foundryState,
      foundryStateFile,
      specFile,
      status: finalStatus,
      verification,
      verifyCommand: normalizedVerifyCommand,
      worktreePath,
    };
    if (values.json) {
      stdout.write(`${JSON.stringify(executedPayload, null, 2)}\n`);
    } else {
      stdout.write(
        `Dispatched #${runPayload.issue.number} in ${runPayload.worktreeSlug} (${runPayload.branch})\n`,
      );
    }
    return executedPayload;
  } finally {
    await finalLease.release();
  }
}

export const factoryCommand = foundryCommand;
export const foundryCli = foundryCommand;
export const factoryCli = foundryCommand;

export async function foundryStatus(argvOrOptions = [], maybeOptions = {}) {
  if (Array.isArray(argvOrOptions)) {
    const args = argvOrOptions[0] === "status" ? argvOrOptions : ["status", ...argvOrOptions];
    return foundryCommand(args, maybeOptions);
  }
  const options = argvOrOptions || {};
  const args = ["status"];
  if (options.json) args.push("--json");
  if (options.repo) args.push("--repo", String(options.repo));
  if (options.width) args.push("--width", String(options.width));
  return foundryCommand(args, options);
}

export const factoryStatus = foundryStatus;

export async function foundryGroom(argvOrOptions = [], maybeOptions = {}) {
  if (Array.isArray(argvOrOptions)) {
    const args = argvOrOptions[0] === "groom" ? argvOrOptions : ["groom", ...argvOrOptions];
    return foundryCommand(args, maybeOptions);
  }
  const options = argvOrOptions || {};
  const args = ["groom"];
  if (options.issue !== undefined) args.push("--issue", String(options.issue));
  if (options.dryRun || options["dry-run"]) args.push("--dry-run");
  if (options.repo) args.push("--repo", String(options.repo));
  if (options.json) args.push("--json");
  return foundryCommand(args, options);
}

export const factoryGroom = foundryGroom;

export async function runSmelterPass(argvOrOptions = [], maybeOptions = {}) {
  if (Array.isArray(argvOrOptions)) {
    const args = argvOrOptions[0] === "run" ? argvOrOptions : ["run", ...argvOrOptions];
    return foundryCommand(args, maybeOptions);
  }
  const options = argvOrOptions || {};
  const args = ["run"];
  if (options.dryRun || options["dry-run"]) args.push("--dry-run");
  if (options.once) args.push("--once");
  if (options.issue !== undefined) args.push("--issue", String(options.issue));
  if (options.repo) args.push("--repo", String(options.repo));
  if (options.verify) args.push("--verify", String(options.verify));
  if (options.acceptance) args.push("--acceptance", String(options.acceptance));
  if (options.json) args.push("--json");
  return foundryCommand(args, options);
}

export const runFoundryPass = runSmelterPass;
export const foundryRun = runSmelterPass;
export const factoryRun = runSmelterPass;
