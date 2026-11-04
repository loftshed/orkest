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
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";

import { buildLanes } from "../../monitor/lib/analyze.mjs";
import { shouldUseColor } from "../../monitor/lib/render.mjs";
import { getAccounts } from "../../monitor/lib/store.mjs";
import { resolveWorktreeMarkerPath } from "./horde-room.mjs";
import { glyphSet, glyphTier, renderPanel, renderTable, wrapText } from "./horde-view.mjs";
import { cacheHome, configPath, envFirst } from "./runtime-paths.mjs";

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
  const hasChecks =
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
  if (lane.billing === "personal" || lane.personal === true) return true;
  const haystack = `${lane.accountId ?? ""} ${lane.label ?? ""} ${lane.route ?? ""}`;
  return /\b(?:personal|plaude)\b/iu.test(haystack);
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

function doesDenyTokenMatchLane(token, { accountId, engine, isPersonal, poolId }) {
  switch (token) {
    case "opencode": {
      return engine === "opencode";
    }
    case "codex": {
      return engine === "codex";
    }
    case "agy":
    case "gemini":
    case "antigravity": {
      return engine === "agy";
    }
    case "claude-all": {
      return engine === "claude";
    }
    case "claude-work":
    case "claude": {
      return engine === "claude" && !isPersonal;
    }
    case "plaude":
    case "claude-personal": {
      return engine === "claude" && isPersonal;
    }
    default: {
      return (
        Boolean(accountId && token === accountId) ||
        Boolean(poolId && token === poolId) ||
        Boolean(accountId && poolId && token === `${accountId}:${poolId}`)
      );
    }
  }
}

export function isLaneDeniedByPolicy(lane, denyList = []) {
  if (!lane || typeof lane !== "object" || !Array.isArray(denyList) || denyList.length === 0) {
    return false;
  }
  const tokens = denyList
    .map((item) =>
      String(item ?? "")
        .trim()
        .toLowerCase(),
    )
    .filter(Boolean);
  if (tokens.length === 0) return false;
  const info = {
    accountId: String(lane.accountId ?? "")
      .trim()
      .toLowerCase(),
    engine: laneEngine(lane),
    isPersonal: isPersonalLane(lane),
    poolId: String(lane.poolId ?? "")
      .trim()
      .toLowerCase(),
  };
  const uniqueTokens = [...new Set(tokens)];
  return uniqueTokens.some((token) => doesDenyTokenMatchLane(token, info));
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
    if (/\b(?:plaude|claude)\b/iu.test(lane.route)) return "claude";
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
        !policy.allowedBilling.includes(lane.billing ?? "work")) ||
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

function routeCandidatesForRole(role, routesConfig = loadDefaultRoutes()) {
  const effectiveRoutes = { ...loadDefaultRoutes(), ...routesConfig };
  const route = effectiveRoutes[role];
  if (!route || typeof route !== "object") return [];
  const primary = {
    effort: route.effort ?? route.variant ?? null,
    engine: route.engine,
    model: route.model,
  };
  const alternates = Array.isArray(route.alternates)
    ? route.alternates.map((alt) => ({
        effort: alt.effort ?? alt.variant ?? null,
        engine: alt.engine,
        model: alt.model,
      }))
    : [];
  return [primary, ...alternates];
}

function candidateFamily(modelSelector) {
  if (typeof modelSelector !== "string") return "";
  const cleaned = modelSelector.replaceAll(/^latest:/giu, "");
  return cleaned.split(":", 1)[0].toLowerCase();
}

function poolSupportsCandidate(pool, candidate) {
  const poolEng = laneEngine(pool);
  if (poolEng !== candidate.engine) return false;
  const family = candidateFamily(candidate.model);
  const supported = laneFamilies(pool);
  return !family || supported.length === 0 || supported.includes(family);
}

function buildPoolRouteOptions(pool, archetype, routesConfig) {
  const options = [];
  const seenModels = new Set();

  if (archetype) {
    const archetypeCandidates = routeCandidatesForRole(archetype, routesConfig);
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
  }

  const fallbackRole = ENGINE_FALLBACK_ROLES[laneEngine(pool)] || "implementation";
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

  if (options.length === 0) {
    const engine = laneEngine(pool);
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

function globToRegExp(globPattern) {
  let regexStr = "^";
  for (let i = 0; i < globPattern.length; i += 1) {
    const ch = globPattern[i];
    if (ch === "*") {
      if (globPattern[i + 1] === "*") {
        regexStr += ".*";
        i += 1;
      } else {
        regexStr += "[^/]*";
      }
    } else if (ch === "?") {
      regexStr += "[^/]";
    } else if (".+^${}()|[]\\".includes(ch)) {
      regexStr += `\\${ch}`;
    } else {
      regexStr += ch;
    }
  }
  regexStr += "$";
  return new RegExp(regexStr, "u");
}

function listRelativeFilesRecursive(rootDir, currentRel = "") {
  const absDir = currentRel ? path.join(rootDir, currentRel) : rootDir;
  let entries;
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const relPath = currentRel ? `${currentRel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...listRelativeFilesRecursive(rootDir, relPath));
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      files.push(relPath);
    }
  }
  return files;
}

function resolveTrackedFilesSet(repoRoot) {
  try {
    const out = execFileSync("git", ["ls-files"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return new Set(
      out
        .split(/\r?\n/u)
        .map((line) => normalizeRelativePath(line))
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

/**
 * Copies untracked local files matching `<repoRoot>/.worktreeinclude` patterns
 * from `repoRoot` into `worktreePath`.
 */
export function bootstrapWorktreeInclude(repoRoot, worktreePath) {
  if (!repoRoot || !worktreePath) return [];
  const resolvedRoot = path.resolve(repoRoot);
  const resolvedWorktree = path.resolve(worktreePath);
  const includeFile = path.join(resolvedRoot, ".worktreeinclude");
  if (!existsSync(includeFile)) return [];

  const rawLines = readFileSync(includeFile, "utf8").split(/\r?\n/u);
  const patterns = rawLines
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => normalizeRelativePath(line))
    .filter((pattern) => Boolean(pattern) && !pattern.startsWith(".."));
  if (patterns.length === 0) return [];

  const trackedSet = resolveTrackedFilesSet(resolvedRoot);
  const candidateFiles = new Set();
  let allFiles = null;

  for (const pattern of patterns) {
    if (/[*?[\]]/u.test(pattern)) {
      allFiles ??= listRelativeFilesRecursive(resolvedRoot);
      const matcher = globToRegExp(pattern);
      for (const relFile of allFiles) {
        if (matcher.test(relFile) && !trackedSet.has(relFile)) {
          candidateFiles.add(relFile);
        }
      }
      continue;
    }

    const sourcePath = path.join(resolvedRoot, pattern);
    if (!existsSync(sourcePath)) continue;
    try {
      const stat = statSync(sourcePath);
      if (stat.isDirectory()) {
        for (const relFile of listRelativeFilesRecursive(resolvedRoot, pattern)) {
          if (!trackedSet.has(relFile)) candidateFiles.add(relFile);
        }
      } else if (!trackedSet.has(pattern)) {
        candidateFiles.add(pattern);
      }
    } catch {
      /* Ignore unreadable candidate paths. */
    }
  }

  const sortedFiles = [...candidateFiles].sort((a, b) => a.localeCompare(b));
  const copied = [];
  for (const relFile of sortedFiles) {
    if (relFile.startsWith("..")) continue;
    const src = path.join(resolvedRoot, relFile);
    const dest = path.join(resolvedWorktree, relFile);
    if (
      path.relative(resolvedRoot, src).startsWith("..") ||
      path.relative(resolvedWorktree, dest).startsWith("..")
    ) {
      continue;
    }
    mkdirSync(path.dirname(dest), { recursive: true });
    cpSync(src, dest, { force: true, recursive: true });
    copied.push(relFile);
  }
  return copied;
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

export function readFoundryState(worktreePath) {
  if (!worktreePath) return null;
  const statePath = resolveFoundryStatePath(worktreePath);
  if (!existsSync(statePath)) return null;
  try {
    return JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return null;
  }
}

export function writeFoundryState(worktreePath, statePatch = {}) {
  const resolvedWorktree = path.resolve(worktreePath);
  const statePath = resolveFoundryStatePath(resolvedWorktree);
  const existing = readFoundryState(resolvedWorktree) || {};
  const nowIso = new Date().toISOString();
  const merged = {
    ...existing,
    ...statePatch,
    attemptCount: statePatch.attemptCount ?? existing.attemptCount ?? 1,
    maxAttempts: statePatch.maxAttempts ?? existing.maxAttempts ?? 2,
    schema: FOUNDRY_STATE_SCHEMA,
    targetBranch: statePatch.targetBranch ?? existing.targetBranch ?? "main",
    updatedAt: statePatch.updatedAt || nowIso,
    worktreePath: resolvedWorktree,
    worktreeSlug:
      statePatch.worktreeSlug ?? existing.worktreeSlug ?? path.basename(resolvedWorktree),
  };
  mkdirSync(path.dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(merged, null, 2)}\n`);
  return merged;
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
    if (Number.isSafeInteger(parsed) && parsed >= 0) {
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

export function commitVerifiedWorktreeChanges(
  worktreePath,
  issueNumber,
  { execFileSyncFn = execFileSync } = {},
) {
  const message = issueNumber
    ? `feat(foundry): resolve #${issueNumber}`
    : "feat(foundry): apply verified builder changes";
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
    const state = readFoundryState(wtPath);
    if (state?.status && ["merged", "abandoned"].includes(state.status)) continue;
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
    const repoPolicyPath = path.join(path.resolve(repoRoot), ".orkest", "policy.json");
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

async function defaultExecAgent(args, { cwd = process.cwd() } = {}) {
  const script = path.join(scriptsDir, "run_agent.py");
  const { stdout } = await execute("python3", [script, ...args], {
    cwd,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 600_000,
  });
  try {
    return JSON.parse(stdout);
  } catch {
    return { stdout: stdout.trim() };
  }
}

async function provisionDisposableWorktree(cwd, worktreeSlug, branch, issueNumber, engine = null) {
  const resolvedCwd = path.resolve(cwd);
  const repoName = path.basename(resolvedCwd);
  const worktreeBase = path.join(cacheHome(), "worktrees", repoName);
  const worktreePath = path.join(worktreeBase, worktreeSlug);
  if (existsSync(worktreePath)) {
    throw new Error(`Disposable worktree path already exists: ${worktreePath}`);
  }
  await mkdir(worktreeBase, { recursive: true });
  await execute("git", ["worktree", "add", "-b", branch, worktreePath, "HEAD"], {
    cwd: resolvedCwd,
    timeout: 30_000,
  });
  const { stdout: gitDirRaw } = await execute("git", ["rev-parse", "--git-dir"], {
    cwd: worktreePath,
    timeout: 10_000,
  });
  const gitDir = path.resolve(worktreePath, gitDirRaw.trim());
  await writeFile(
    path.join(gitDir, "orkest.json"),
    `${JSON.stringify(
      {
        branch,
        createdAt: new Date().toISOString(),
        disposable: true,
        ...(engine && { engine }),
        issue: issueNumber,
        parentCwd: resolvedCwd,
        slug: worktreeSlug,
      },
      null,
      2,
    )}\n`,
  );
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
    execAgentFn = defaultExecAgent,
    execFileSyncFn,
    execGhFn = defaultExecGh,
    execVerifyFn,
    getAccountsFn = getAccounts,
    policy: policyOverride,
    provisionWorktreeFn = provisionDisposableWorktree,
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
    const response = await execAgentFn(consultArgs, { cwd });
    const text =
      typeof response === "string"
        ? response
        : response?.response || response?.stdout || JSON.stringify(response);
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
  const lanes = buildLanes(accounts);
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
  const plannedWorktreePath = path.join(cacheHome(), "worktrees", repoName, match.worktreeSlug);
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
  );
  bootstrapWorktreeInclude(cwd, worktreePath);
  const specFile = resolveTaskSpecPath(worktreePath);
  await mkdir(path.dirname(specFile), { recursive: true });
  await writeFile(specFile, `${JSON.stringify(match.taskSpec, null, 2)}\n`);
  const routeArchetype = match.classification?.archetype || match.archetype;
  const agentArgs = [
    "--cwd",
    worktreePath,
    "--task-spec",
    specFile,
    ...(routeArchetype ? ["--route", routeArchetype] : []),
    "--engine",
    match.selectedRoute.engine,
    "--model",
    match.selectedRoute.model,
    "--verify-command",
    match.verifyCommand,
  ];
  if (match.selectedRoute.effort) agentArgs.push("--effort", match.selectedRoute.effort);
  const agentResult = await execAgentFn(agentArgs, { cwd: worktreePath });

  const rawAgentStatus = String(
    agentResult?.status ?? (agentResult?.ok === false ? "failed" : "completed"),
  )
    .trim()
    .toLowerCase();
  const didBuilderSucceed =
    (rawAgentStatus === "completed" || rawAgentStatus === "complete") && agentResult?.ok !== false;

  let commitsAhead;
  if (typeof agentResult?.commitsAhead === "number") {
    commitsAhead = agentResult.commitsAhead;
  } else if (typeof countCommitsAheadFn === "function") {
    commitsAhead = Number(await countCommitsAheadFn(worktreePath, targetBranch));
  } else {
    const counted = countCommitsAhead(worktreePath, targetBranch, { execFileSyncFn });
    if (counted.resolved) {
      commitsAhead = counted.commitsAhead;
    } else if (execAgentFn === defaultExecAgent || typeof execFileSyncFn === "function") {
      commitsAhead = 0;
    } else {
      commitsAhead = didBuilderSucceed ? 1 : 0;
    }
  }

  const dirtyCheck =
    typeof agentResult?.dirty === "boolean"
      ? { isDirty: agentResult.dirty, resolved: true }
      : hasWorktreeDirtyChanges(worktreePath, { execFileSyncFn });
  const isDirtyWorktree = dirtyCheck.isDirty;
  const hasWorktreeChanges = commitsAhead > 0 || isDirtyWorktree;

  const normalizedVerifyCommand = enforceScopedVerifyCommand(match.verifyCommand);
  const nowIso = new Date().toISOString();
  let verification;
  let finalStatus;

  if (!didBuilderSucceed || !hasWorktreeChanges) {
    finalStatus = "worker_failed";
    verification = {
      acceptanceCriteria,
      command: normalizedVerifyCommand,
      exitCode: null,
      ok: false,
      output: "",
      reason: didBuilderSucceed
        ? "Builder produced 0 commits and no working-tree changes"
        : `Builder exited with status ${rawAgentStatus}`,
      status: "skipped",
      verifiedAt: nowIso,
    };
  } else {
    let wasHostCommitted = false;
    let rawVerifyResult;
    if (typeof execVerifyFn === "function") {
      rawVerifyResult = await execVerifyFn(normalizedVerifyCommand, {
        cwd: worktreePath,
        issue: match.issue.number,
      });
    } else if (execAgentFn === defaultExecAgent) {
      rawVerifyResult = await defaultExecVerify(normalizedVerifyCommand, {
        cwd: worktreePath,
        issue: match.issue.number,
      });
    } else {
      rawVerifyResult = { exitCode: 0, ok: true, output: "" };
    }
    let verifyExitCode = 0;
    if (typeof rawVerifyResult?.exitCode === "number") {
      verifyExitCode = rawVerifyResult.exitCode;
    } else if (rawVerifyResult?.ok === false) {
      verifyExitCode = 1;
    }
    const isVerifyOk =
      typeof rawVerifyResult?.ok === "boolean" ? rawVerifyResult.ok : verifyExitCode === 0;
    if (isVerifyOk && isDirtyWorktree) {
      try {
        commitVerifiedWorktreeChanges(worktreePath, match.issue.number, { execFileSyncFn });
        wasHostCommitted = true;
        const recounted = countCommitsAhead(worktreePath, targetBranch, { execFileSyncFn });
        commitsAhead = recounted.resolved ? recounted.commitsAhead : Math.max(1, commitsAhead);
      } catch {
        commitsAhead = Math.max(1, commitsAhead);
      }
    }
    finalStatus = isVerifyOk ? "verified" : "verification_failed";
    verification = {
      acceptanceCriteria,
      command: normalizedVerifyCommand,
      committedByHost: wasHostCommitted,
      exitCode: verifyExitCode,
      ok: isVerifyOk,
      output: typeof rawVerifyResult?.output === "string" ? rawVerifyResult.output : "",
      status: isVerifyOk ? "passed" : "failed",
      verifiedAt: nowIso,
    };
  }

  const headSha =
    agentResult?.headSha ??
    agentResult?.head_sha ??
    resolveWorktreeHeadSha(worktreePath, { execFileSyncFn });
  const foundryStateFile = resolveFoundryStatePath(worktreePath);
  const foundryState = writeFoundryState(worktreePath, {
    acceptanceCriteria,
    attemptCount: 1,
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
