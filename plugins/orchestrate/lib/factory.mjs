import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";

import { buildLanes } from "../../monitor/lib/analyze.mjs";
import { shouldUseColor } from "../../monitor/lib/render.mjs";
import { getAccounts } from "../../monitor/lib/store.mjs";
import { glyphSet, glyphTier, renderPanel, renderTable, wrapText } from "./stooges-view.mjs";

const execute = promisify(execFile);
const scriptsDir = fileURLToPath(new URL("../skills/orchestrate/scripts/", import.meta.url));
const TASK_SPEC_SCHEMA = "agent-executor.task-spec.v1";

export const DEFAULT_ROUTES = {
  "architecture-conductor": {
    alternates: [
      { effort: "high", engine: "claude", model: "claude:frontier" },
      { effort: "high", engine: "codex", model: "gpt:sol" },
    ],
    engine: "agy",
    model: "gemini:pro",
  },
  claude: {
    alternates: [
      { effort: "high", engine: "claude", model: "claude:frontier" },
      { effort: "high", engine: "claude", model: "claude:balanced" },
      { effort: "medium", engine: "claude", model: "claude:fast" },
    ],
    effort: "high",
    engine: "claude",
    model: "claude:best",
  },
  consultation: {
    effort: "high",
    engine: "codex",
    model: "gpt:sol",
  },
  "debug-invariants": {
    alternates: [
      { effort: "high", engine: "claude", model: "claude:frontier" },
      { effort: "max", engine: "codex", model: "gpt:luna" },
    ],
    effort: "high",
    engine: "codex",
    model: "gpt:sol",
  },
  gemini: {
    alternates: [
      { engine: "agy", model: "gemini:flash-high" },
      { engine: "agy", model: "gemini:pro" },
    ],
    engine: "agy",
    model: "gemini:fast",
  },
  implementation: {
    alternates: [
      { effort: "high", engine: "codex", model: "gpt:sol" },
      { effort: "high", engine: "codex", model: "gpt:astra" },
    ],
    effort: "max",
    engine: "codex",
    model: "gpt:luna",
  },
  "independent-review": {
    alternates: [
      { effort: "high", engine: "claude", model: "claude:frontier" },
      { engine: "agy", model: "gemini:flash-high" },
    ],
    effort: "high",
    engine: "codex",
    model: "gpt:sol",
  },
  "mechanical-sweep": {
    alternates: [
      { engine: "agy", model: "gemini:flash-high" },
      { effort: "medium", engine: "codex", model: "gpt:luna" },
    ],
    effort: "medium",
    engine: "claude",
    model: "claude:fast",
  },
  opencode: {
    alternates: [{ engine: "opencode", model: "deepseek:flash" }],
    engine: "opencode",
    model: "glm:flash",
    variant: "high",
  },
  "structural-refactor": {
    alternates: [
      { effort: "high", engine: "codex", model: "gpt:sol" },
      { effort: "high", engine: "claude", model: "claude:balanced" },
    ],
    effort: "high",
    engine: "claude",
    model: "claude:frontier",
  },
  "ui-design-system": {
    alternates: [
      { effort: "high", engine: "claude", model: "claude:frontier" },
      { effort: "high", engine: "claude", model: "claude:balanced" },
    ],
    effort: "high",
    engine: "codex",
    model: "gpt:astra",
  },
};

const ENGINE_FALLBACK_ROLES = {
  agy: "gemini",
  claude: "claude",
  codex: "implementation",
  opencode: "opencode",
};

export const FACTORY_HELP = `ork factory [status] [--json] [--repo <owner/name>] [--width 120]
ork factory run [--dry-run] [--once] [--issue <number>] [--repo <owner/name>] [--json]
ork factory groom --issue <number> [--dry-run] [--repo <owner/name>] [--json]
`;

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
      (Array.isArray(policy.allowedPools) && !matchesAllowedPools(lane, policy.allowedPools))
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

function routeCandidatesForRole(role, routesConfig = DEFAULT_ROUTES) {
  const effectiveRoutes = { ...DEFAULT_ROUTES, ...routesConfig };
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

/**
 * Matches multiple open agent:ready issues across eligible spare-token pools,
 * honoring archetype route preferences while spreading work across distinct
 * harnesses, pools, and models so parallel workers do not drain a single provider.
 */
export function matchIssuesToPools(issues, lanes, activeAllowPaths = [], policy = {}) {
  const sparePools = selectSparePools(lanes, policy);
  if (sparePools.length === 0 || !Array.isArray(issues)) return [];

  const routesConfig = policy.routes || DEFAULT_ROUTES;
  const runningAllowPaths = [...flattenActivePaths(activeAllowPaths)];
  const usedHarnesses = new Map();
  const usedPools = new Map();
  const usedModels = new Map();
  const matches = [];

  for (const issue of issues) {
    if (!isReadyCandidate(issue)) continue;
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

async function loadFactoryPolicy() {
  const configHome =
    process.env.AGENT_EXECUTOR_HOME || path.join(homedir(), ".config", "agent-executor");
  const policyPath =
    process.env.AGENT_EXECUTOR_FACTORY_CONFIG || path.join(configHome, "factory.json");
  try {
    return JSON.parse(await readFile(policyPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
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

async function provisionDisposableWorktree(cwd, worktreeSlug, branch, issueNumber) {
  const repoName = path.basename(path.resolve(cwd));
  const worktreeBase = path.join(homedir(), ".cache", "agent-executor", "worktrees", repoName);
  const worktreePath = path.join(worktreeBase, worktreeSlug);
  await mkdir(worktreeBase, { recursive: true });
  await execute("git", ["worktree", "add", "-B", branch, worktreePath, "HEAD"], {
    cwd,
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
        issue: issueNumber,
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
          if (issue.validSpec) {
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
    issue: { number: match.issue.number, title: match.issue.title },
    pool: {
      accountId: match.pool.accountId,
      effort: match.pool.effort ?? null,
      engine: match.pool.engine,
      expiring: match.pool.expiring,
      label: match.pool.label,
      model: match.pool.model,
      poolId: match.pool.poolId,
      route: match.pool.route ?? null,
      score: match.pool.score,
      surplusPts: match.pool.surplusPts,
    },
    selectedRoute: match.selectedRoute,
    verifyCommand: match.verifyCommand,
    worktreeSlug: match.worktreeSlug,
  };
}

export async function factoryCommand(
  argv = [],
  {
    activeAllowPaths = [],
    cwd = process.cwd(),
    execAgentFn = defaultExecAgent,
    execGhFn = defaultExecGh,
    getAccountsFn = getAccounts,
    policy: policyOverride,
    provisionWorktreeFn = provisionDisposableWorktree,
    stdout = process.stdout,
  } = {},
) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    args: argv,
    options: {
      "dry-run": { type: "boolean" },
      help: { short: "h", type: "boolean" },
      issue: { type: "string" },
      json: { type: "boolean" },
      once: { type: "boolean" },
      repo: { type: "string" },
      width: { type: "string" },
    },
  });

  if (values.help) {
    stdout.write(FACTORY_HELP);
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
    const consultArgs = ["consult", "--intent", "investigate", "--read", cwd, "--prompt", prompt];
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

  const filePolicy = await loadFactoryPolicy();
  const policy = { ...filePolicy, ...policyOverride };
  const accounts = await getAccountsFn();
  const lanes = buildLanes(accounts);
  const sparePools = selectSparePools(lanes, policy);
  const openIssues = await fetchOpenIssues(execGhFn, values.repo, cwd);

  if (action === "status") {
    const readyIssues = openIssues
      .filter((issue) => hasIssueLabel(issue, "agent:ready"))
      .map((issue) => {
        const spec = extractTaskSpec(issue.body);
        return {
          allowPaths: spec?.allow_paths ?? [],
          archetype: extractIssueArchetype(issue, spec),
          disjoint: spec ? hasDisjointPaths(spec.allow_paths, activeAllowPaths) : false,
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
    const batch = matchIssuesToPools(openIssues, lanes, activeAllowPaths, policy);
    const match = batch[0] ?? null;
    const statusPayload = {
      nextMatch: match ? serializeMatch(match) : null,
      plannedBatch: batch.map(serializeMatch),
      rawIssues,
      readyIssues,
      schema: "ork.factory.status.v1",
      sparePools: sparePools.map((pool) => ({
        accountId: pool.accountId,
        availableNowPct: pool.availableNowPct ?? 100,
        engine: pool.engine,
        expiring: pool.expiring,
        label: pool.label,
        poolId: pool.poolId,
        route: pool.route ?? null,
        score: pool.score,
        status: pool.status,
        surplusPts: pool.surplusPts,
      })),
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

  const batch = matchIssuesToPools(candidateIssues, lanes, activeAllowPaths, policy);
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

  const repoName = path.basename(path.resolve(cwd));
  const plannedWorktreePath = path.join(
    homedir(),
    ".cache",
    "agent-executor",
    "worktrees",
    repoName,
    match.worktreeSlug,
  );
  const runPayload = {
    allowPaths: match.allowPaths,
    archetype: match.archetype,
    batch: batch.map(serializeMatch),
    branch: match.branch,
    dryRun: Boolean(values["dry-run"]),
    issue: { number: match.issue.number, title: match.issue.title },
    matched: true,
    once: Boolean(values.once),
    pool: {
      accountId: match.pool.accountId,
      effort: match.pool.effort ?? null,
      engine: match.pool.engine,
      expiring: match.pool.expiring,
      label: match.pool.label,
      model: match.pool.model,
      poolId: match.pool.poolId,
      route: match.pool.route ?? null,
      score: match.pool.score,
      surplusPts: match.pool.surplusPts,
    },
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
  );
  const specFile = path.join(worktreePath, ".orkest-task-spec.json");
  await writeFile(specFile, `${JSON.stringify(match.taskSpec, null, 2)}\n`);
  const agentArgs = [
    "run",
    "--cwd",
    worktreePath,
    "--task-spec",
    specFile,
    "--engine",
    match.selectedRoute.engine,
    "--model",
    match.selectedRoute.model,
    "--verify",
    match.verifyCommand,
  ];
  if (match.selectedRoute.effort) agentArgs.push("--effort", match.selectedRoute.effort);
  const agentResult = await execAgentFn(agentArgs, { cwd: worktreePath });
  const executedPayload = {
    ...runPayload,
    agentResult,
    executed: true,
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
