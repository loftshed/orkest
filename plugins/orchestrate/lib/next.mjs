/**
 * @module next
 *
 * The Autonomous Reconciler (`ork next`): Closed-loop state machine connecting
 * Horde rooms, Foundry disposable worktrees, and the 4-stage Smelter merge queue.
 *
 * Priority Waterfall:
 * - Tier 0: Deterministic Housekeeping (0 LLM tokens; auto-drained before Tier 1/2)
 * - Tier 3: Human Approval Gates (exit code 4; high blast radius, rebase conflicts, exhausted repairs)
 * - Tier 1: Smelter Convergence (merge verified worktrees before starting new work)
 * - Tier 2: Bounded Self-Repair (warm resume first, fresh fallback on crash) & Spare-Pool Foundry Dispatch
 */
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";

import { buildLanes } from "../../monitor/lib/analyze.mjs";
import { shouldUseColor } from "../../monitor/lib/render.mjs";
import { getAccounts } from "../../monitor/lib/store.mjs";
import {
  collectActiveWorktreeAllowPaths,
  commitVerifiedWorktreeChanges,
  countCommitsAhead,
  DEFAULT_ROUTES,
  enforceScopedVerifyCommand,
  foundryRun,
  hasWorktreeDirtyChanges,
  loadFactoryPolicy,
  loadFoundryState,
  planBatch,
  resolveFoundryStatePath,
  resolveTaskSpecPath,
  resolveWorktreeGitDir,
  resolveWorktreeHeadSha,
  writeFoundryState,
} from "./foundry.mjs";
import { mailboxRoot, resolveWorktreeMarkerPath } from "./horde-room.mjs";
import { glyphSet, glyphTier, renderPanel, renderTable } from "./horde-view.mjs";
import { observeRoom, recoverRoom } from "./rooms.mjs";
import { cacheHome } from "./runtime-paths.mjs";
import { alignCanonicalPath, classifyBlastRadius, smeltWorktree } from "./smelter.mjs";
import { acquireWorkspaceLease } from "./workspace-lease.mjs";

const executeAsync = promisify(execFile);
const scriptsDir = fileURLToPath(new URL("../skills/orchestrate/scripts/", import.meta.url));

export const NEXT_SCHEMA = "ork.next.v1";
export const NEXT_LEDGER_SCHEMA = "ork.next.ledger.v1";
export const EXIT_HUMAN_APPROVAL = 4;

export const NEXT_HELP = `ork next [step|run] [--room <id>] [--task-dir <dir>] [--max-tier <0|1|2|3>] [--approve <slug>] [--dry-run] [--json] [--cwd <dir>]
ork next status|plan [--room <id>] [--task-dir <dir>] [--include-github] [--json] [--cwd <dir>] [--width 120]
ork next settle [--room <id>] [--task-dir <dir>] [--json] [--cwd <dir>]
ork next loop [--room <id>] [--task-dir <dir>] [--max-tier <0|1|2|3>] [--max-steps 10] [--max-invocations 3] [--max-failures 2] [--json] [--cwd <dir>]
`;

const BLAST_ORDER = { high: 2, low: 0, medium: 1 };
const HEALTHY_REPAIR_STATES = new Set([
  "gate_failed",
  "review_changes_requested",
  "verification_failed",
]);
const REPAIRABLE_STATES = new Set([
  "gate_failed",
  "review_changes_requested",
  "verification_failed",
  "worker_failed",
]);

function readJsonIfExists(filePath) {
  if (!filePath || !existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

export function resolveRepoKey(repoRoot = process.cwd()) {
  const canonical = alignCanonicalPath(repoRoot);
  const base =
    path
      .basename(canonical)
      .replaceAll(/[^A-Za-z0-9_.-]/gu, "-")
      .slice(0, 40) || "repo";
  const digest = createHash("sha1").update(canonical).digest("hex").slice(0, 12);
  return `${base}-${digest}`;
}

export function resolveNextStateDir(repoRoot = process.cwd(), env = process.env) {
  return path.join(cacheHome(env), "next-v1", resolveRepoKey(repoRoot));
}

export async function acquireNextLock(repoRoot = process.cwd(), { env = process.env } = {}) {
  const lease = await acquireWorkspaceLease(repoRoot, { env, namespace: "next-locks" });
  if (!lease.acquired) throw new Error(`ork next is already running for ${path.resolve(repoRoot)}`);
  return lease;
}

export async function releaseNextLock(lockInfo) {
  await lockInfo?.release();
}

export function readNextLedger(repoRoot = process.cwd(), { env = process.env } = {}) {
  const stateDir = resolveNextStateDir(repoRoot, env);
  const ledgerPath = path.join(stateDir, "next-ledger.json");
  const existing = readJsonIfExists(ledgerPath);
  if (existing && existing.schema === NEXT_LEDGER_SCHEMA) {
    return existing;
  }
  return {
    history: [],
    repoRoot: alignCanonicalPath(repoRoot),
    schema: NEXT_LEDGER_SCHEMA,
    updatedAt: null,
    worktrees: {},
  };
}

export function writeNextLedger(repoRoot = process.cwd(), patch = {}, { env = process.env } = {}) {
  const stateDir = resolveNextStateDir(repoRoot, env);
  mkdirSync(stateDir, { mode: 0o700, recursive: true });
  const ledgerPath = path.join(stateDir, "next-ledger.json");
  const existing = readNextLedger(repoRoot, { env });
  const nowIso = new Date().toISOString();
  const nextHistory = Array.isArray(patch.history)
    ? patch.history.slice(-50)
    : [
        ...(existing.history || []),
        ...(patch.historyEntry ? [{ executedAt: nowIso, ...patch.historyEntry }] : []),
      ].slice(-50);
  const nextWorktrees = {
    ...existing.worktrees,
    ...patch.worktrees,
  };
  const updated = {
    history: nextHistory,
    repoRoot: alignCanonicalPath(repoRoot),
    schema: NEXT_LEDGER_SCHEMA,
    updatedAt: patch.updatedAt || nowIso,
    worktrees: nextWorktrees,
  };
  writeFileSync(ledgerPath, `${JSON.stringify(updated, null, 2)}\n`);
  return updated;
}

function parsePorcelainWorktrees(porcelainText) {
  const blocks = String(porcelainText || "")
    .trim()
    .split(/\r?\n\r?\n/u)
    .map((block) => block.trim())
    .filter(Boolean);
  const worktrees = [];
  for (const block of blocks) {
    const entry = { branch: null, detached: false, head: null, worktree: null };
    for (const rawLine of block.split(/\r?\n/u)) {
      const line = rawLine.trim();
      if (line.startsWith("worktree ")) {
        entry.worktree = line.slice("worktree ".length).trim();
      } else if (line.startsWith("HEAD ")) {
        entry.head = line.slice("HEAD ".length).trim();
      } else if (line.startsWith("branch ")) {
        const ref = line.slice("branch ".length).trim();
        entry.branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
      } else if (line === "detached") {
        entry.detached = true;
      }
    }
    if (entry.worktree) worktrees.push(entry);
  }
  return worktrees;
}

function resolveGitSha(cwd, ref, execFileSyncFn = execFileSync) {
  try {
    const out = String(
      execFileSyncFn("git", ["rev-parse", ref], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }) ?? "",
    ).trim();
    return out || null;
  } catch {
    return null;
  }
}

export function discoverManagedWorktrees(
  repoRoot = process.cwd(),
  { execFileSyncFn = execFileSync, targetBranch = "main" } = {},
) {
  const resolvedRoot = path.resolve(repoRoot);
  const canonicalRoot = alignCanonicalPath(resolvedRoot);
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
  const rawEntries = parsePorcelainWorktrees(porcelain);
  const managed = [];
  const targetHeadSha = resolveGitSha(resolvedRoot, targetBranch, execFileSyncFn);

  for (const entry of rawEntries) {
    const worktreePath = path.resolve(entry.worktree);
    if (alignCanonicalPath(worktreePath) === canonicalRoot) continue;
    const gitDir = resolveWorktreeGitDir(worktreePath);
    const markerPath = resolveWorktreeMarkerPath(worktreePath) || path.join(gitDir, "orkest.json");
    const marker = readJsonIfExists(markerPath);
    if (!marker || typeof marker !== "object" || marker.disposable === false) continue;

    const taskSpecPath = resolveTaskSpecPath(worktreePath);
    const taskSpec =
      readJsonIfExists(taskSpecPath) ||
      readJsonIfExists(path.join(gitDir, "task-spec.json")) ||
      readJsonIfExists(path.join(worktreePath, ".orkest-task-spec.json"));
    const foundryStatePath = resolveFoundryStatePath(worktreePath);
    const loadedState = loadFoundryState(worktreePath);
    const foundryState = loadedState.state;
    const stateProblem = ["missing", "ok"].includes(loadedState.kind) ? null : loadedState;

    const counted = countCommitsAhead(worktreePath, targetBranch, { execFileSyncFn });
    const commitsAhead = counted.resolved
      ? counted.commitsAhead
      : Number(foundryState?.commitsAhead ?? 0);
    const dirtyCheck = hasWorktreeDirtyChanges(worktreePath, { execFileSyncFn });
    const allowPaths = taskSpec?.allow_paths ?? foundryState?.allowPaths ?? [];
    const blastRadius = foundryState?.blastRadius || classifyBlastRadius(allowPaths);
    const branch = entry.branch || marker.branch || foundryState?.branch || null;
    const head =
      entry.head ||
      foundryState?.headSha ||
      resolveWorktreeHeadSha(worktreePath, { execFileSyncFn });

    managed.push({
      allowPaths,
      archetype: taskSpec?.metadata?.archetype || marker.archetype || null,
      blastRadius,
      branch,
      commitsAhead,
      disposable: marker.disposable !== false,
      engine: marker.engine || taskSpec?.engine || foundryState?.lastRun?.engine || "codex",
      foundryState,
      foundryStatePath,
      stateProblem,
      gitDir,
      head,
      isDirty: dirtyCheck.isDirty,
      issue: marker.issue ?? taskSpec?.issue ?? foundryState?.issue?.number ?? null,
      marker,
      markerPath,
      parentCwd: marker.parentCwd || resolvedRoot,
      path: worktreePath,
      slug: marker.slug || foundryState?.worktreeSlug || path.basename(worktreePath),
      targetHeadSha,
      taskSpec,
      taskSpecPath,
      verifyCommand:
        foundryState?.verifyCommand ||
        taskSpec?.verify_command ||
        taskSpec?.development_checks?.[0] ||
        "./scripts/check.sh",
      worktreePath,
    });
  }

  return managed;
}

function selectAlternateRepairRoute(worktree, foundryState) {
  const currentEngine = foundryState?.lastRun?.engine || worktree.engine || "codex";
  const archetype = worktree.archetype || "debug-invariants";
  const routeDef = DEFAULT_ROUTES[archetype] || DEFAULT_ROUTES["debug-invariants"] || {};
  const alternates = Array.isArray(routeDef.alternates) ? routeDef.alternates : [];
  const crossVendor = alternates.find((alt) => alt.engine && alt.engine !== currentEngine);
  if (crossVendor) {
    return {
      effort: crossVendor.effort || crossVendor.variant || "high",
      engine: crossVendor.engine,
      model: crossVendor.model,
    };
  }
  if (routeDef.engine && routeDef.engine !== currentEngine) {
    return {
      effort: routeDef.effort || routeDef.variant || "high",
      engine: routeDef.engine,
      model: routeDef.model,
    };
  }
  const fallbackEngine = currentEngine === "codex" ? "claude" : "codex";
  const fallbackModel = fallbackEngine === "claude" ? "claude:sonnet" : "gpt:sol";
  return {
    effort: "high",
    engine: fallbackEngine,
    model: fallbackModel,
  };
}

export function buildRepairDispatchSpec(worktree, foundryState = worktree?.foundryState) {
  const status = foundryState?.status || "verification_failed";
  const lastRun = foundryState?.lastRun || {};
  const hasWarmSession =
    HEALTHY_REPAIR_STATES.has(status) &&
    typeof lastRun.sessionId === "string" &&
    Boolean(lastRun.sessionId.trim()) &&
    typeof lastRun.resultPath === "string" &&
    Boolean(lastRun.resultPath.trim());

  let failureContext;
  switch (status) {
    case "verification_failed": {
      failureContext = `Post-builder verification command (${worktree.verifyCommand}) failed:\n${foundryState?.verification?.output || "Verification exited non-zero"}`;
      break;
    }
    case "gate_failed": {
      failureContext = `Smelter Stage 2 heavy gate (${worktree.verifyCommand}) failed:\n${foundryState?.gateError || "Heavy gate exited non-zero"}`;
      break;
    }
    case "review_changes_requested": {
      failureContext = `Smelter Stage 3 cross-vendor cold review requested changes:\n${foundryState?.findings || "Address review findings"}`;
      break;
    }
    default: {
      failureContext = `Previous builder attempt failed (${foundryState?.verification?.reason || status}). Implement the task-spec cleanly within allow_paths.`;
      break;
    }
  }

  const prompt = [
    `Bounded self-repair attempt ${(foundryState?.attemptCount ?? 1) + 1} of ${foundryState?.maxAttempts ?? 2} for ${worktree.slug}.`,
    failureContext,
    `Fix the root cause strictly within allow_paths (${(worktree.allowPaths || []).join(", ") || "task scope"}) and ensure '${enforceScopedVerifyCommand(worktree.verifyCommand)}' passes.`,
  ].join("\n\n");

  const specPath = worktree.taskSpecPath || resolveTaskSpecPath(worktree.worktreePath);
  const scopedVerify = enforceScopedVerifyCommand(worktree.verifyCommand);

  if (hasWarmSession) {
    const engine = lastRun.engine || worktree.engine || "codex";
    const model = lastRun.model || "gpt:sol";
    const args = [
      "--cwd",
      worktree.worktreePath,
      "--task-spec",
      specPath,
      "--engine",
      engine,
      "--model",
      model,
      "--session",
      lastRun.sessionId.trim(),
      "--resume-result",
      lastRun.resultPath.trim(),
      "--verify-command",
      scopedVerify,
      "--prompt",
      prompt,
    ];
    return {
      args,
      engine,
      mode: "warm_resume",
      model,
      prompt,
      resumeResultPath: lastRun.resultPath.trim(),
      sessionId: lastRun.sessionId.trim(),
      status,
      verifyCommand: scopedVerify,
      worktreePath: worktree.worktreePath,
    };
  }

  const altRoute = selectAlternateRepairRoute(worktree, foundryState);
  const args = [
    "--cwd",
    worktree.worktreePath,
    "--task-spec",
    specPath,
    ...(worktree.archetype ? ["--route", worktree.archetype] : []),
    "--engine",
    altRoute.engine,
    "--model",
    altRoute.model,
    ...(altRoute.effort ? ["--effort", altRoute.effort] : []),
    "--verify-command",
    scopedVerify,
    "--prompt",
    prompt,
  ];
  return {
    args,
    effort: altRoute.effort,
    engine: altRoute.engine,
    mode: "fresh_reset",
    model: altRoute.model,
    prompt,
    resumeResultPath: null,
    sessionId: null,
    status,
    verifyCommand: scopedVerify,
    worktreePath: worktree.worktreePath,
  };
}

function matchesApproveTarget(worktree, approveTarget) {
  if (!approveTarget || typeof approveTarget !== "string") return false;
  const cleaned = approveTarget.trim();
  if (!cleaned) return false;
  return (
    worktree.slug === cleaned ||
    worktree.branch === cleaned ||
    worktree.path === path.resolve(cleaned) ||
    path.basename(worktree.path) === cleaned ||
    (worktree.issue !== null && String(worktree.issue) === cleaned.replace(/^#/u, ""))
  );
}

function isSameRebaseConflict(worktree) {
  const state = worktree.foundryState;
  if (state?.status !== "rebase_conflict") return false;
  const conflictOn = state.rebase?.conflictOn;
  if (!conflictOn) return true;
  const isSameWorktreeSha =
    !conflictOn.worktreeHeadSha || !worktree.head || conflictOn.worktreeHeadSha === worktree.head;
  const isSameTargetSha =
    !conflictOn.targetHeadSha ||
    !worktree.targetHeadSha ||
    conflictOn.targetHeadSha === worktree.targetHeadSha;
  return isSameWorktreeSha && isSameTargetSha;
}

export async function evaluateNextCandidates({
  approve = null,
  cwd = process.cwd(),
  discoverWorktreesFn = discoverManagedWorktrees,
  execFileSyncFn = execFileSync,
  execGhFn = null,
  getAccountsFn = null,
  includeGithub = false,
  observeRoomFn = observeRoom,
  openIssues = null,
  policy: policyOverride = null,
  room = null,
  roomId = null,
  targetBranch = "main",
} = {}) {
  const repoRoot = path.resolve(cwd);
  const worktrees = await discoverWorktreesFn(repoRoot, { execFileSyncFn, targetBranch });

  let observedRoom = room;
  if (!observedRoom && roomId && typeof observeRoomFn === "function") {
    try {
      observedRoom = await observeRoomFn(roomId, { root: mailboxRoot() });
    } catch {
      observedRoom = null;
    }
  }

  const tier0 = [];
  const tier1 = [];
  const tier2 = [];
  const tier3 = [];

  if (observedRoom && Array.isArray(observedRoom.agents)) {
    const notRecovered = observedRoom.agents.filter(
      (agent) => agent.dispatch && ["review", "unknown"].includes(agent.status),
    );
    if (notRecovered.length > 0) {
      tier0.push({
        id: `tier0:recover_room:${observedRoom.id}`,
        kind: "recover_room",
        roomId: observedRoom.id,
        summary: `Recover ${notRecovered.length} finished room dispatch(es) in ${observedRoom.id}`,
        target: observedRoom.id,
        tier: 0,
      });
    }

    const blockedAgents = observedRoom.agents.filter(
      (agent) => agent.status === "blocked" || Boolean(agent.question),
    );
    for (const agent of blockedAgents) {
      tier3.push({
        agentId: agent.id,
        id: `tier3:room_question:${agent.id}`,
        kind: "room_question",
        question: agent.question || agent.output?.at(-1) || "Agent is blocked awaiting input",
        roomId: observedRoom.id,
        summary: `Agent ${agent.id} is blocked: ${agent.question || "awaiting human guidance"}`,
        target: agent.id,
        tier: 3,
      });
    }
  }

  for (const wt of worktrees) {
    if (wt.stateProblem) {
      tier3.push({
        id: `tier3:state_unreadable:${wt.slug}`,
        kind: "state_unreadable",
        tier: 3,
        target: wt.slug,
        worktree: wt,
        reason: wt.stateProblem.error,
        summary: `Worktree ${wt.slug} has unreadable Foundry state (${wt.stateProblem.kind})`,
      });
      continue;
    }
    const status = wt.foundryState?.status || null;

    if (status === "abandoned") continue;

    if (status === "merged") {
      if (wt.disposable) {
        tier0.push({
          id: `tier0:prune_merged_worktree:${wt.slug}`,
          kind: "prune_merged_worktree",
          summary: `Prune merged disposable worktree ${wt.slug} (${wt.branch})`,
          target: wt.slug,
          tier: 0,
          worktree: wt,
        });
      }
      continue;
    }

    if (status === "pr_opened") continue;

    const attemptCount = wt.foundryState?.attemptCount ?? 1;
    const maxAttempts = wt.foundryState?.maxAttempts ?? 2;

    if (REPAIRABLE_STATES.has(status) && attemptCount >= maxAttempts) {
      tier0.push({
        id: `tier0:escalate_exhausted_worktree:${wt.slug}`,
        kind: "escalate_exhausted_worktree",
        summary: `Mark ${wt.slug} as needs_human after exhausting ${attemptCount}/${maxAttempts} attempts (${status})`,
        target: wt.slug,
        tier: 0,
        worktree: wt,
      });
      tier3.push({
        id: `tier3:needs_human:${wt.slug}`,
        kind: "needs_human",
        reason: `Exhausted ${attemptCount}/${maxAttempts} repair attempts (${status})`,
        summary: `Worktree ${wt.slug} exhausted ${attemptCount}/${maxAttempts} attempts (${status}) and requires human review`,
        target: wt.slug,
        tier: 3,
        worktree: wt,
      });
      continue;
    }

    if (status === "needs_human" || status === "scope_violated") {
      tier3.push({
        id: `tier3:${status}:${wt.slug}`,
        kind: status,
        reason:
          status === "scope_violated"
            ? `Modified files outside allow_paths: ${(wt.foundryState?.scopeViolations || []).join(", ")}`
            : wt.foundryState?.reason || "Escalated to human review",
        summary: `Worktree ${wt.slug} requires human intervention (${status})`,
        target: wt.slug,
        tier: 3,
        worktree: wt,
      });
      continue;
    }

    if (status === "rebase_conflict") {
      if (isSameRebaseConflict(wt)) {
        tier3.push({
          id: `tier3:rebase_conflict:${wt.slug}`,
          kind: "rebase_conflict",
          reason: `Rebase conflict onto ${targetBranch} (${wt.foundryState?.rebase?.conflictOn?.targetHeadSha || "HEAD"})`,
          summary: `Worktree ${wt.slug} has a rebase conflict with ${targetBranch}`,
          target: wt.slug,
          tier: 3,
          worktree: wt,
        });
        continue;
      }
      // Target branch or worktree HEAD moved! Re-eligible for smelting:
      tier1.push({
        blastRadius: wt.blastRadius,
        id: `tier1:smelt_worktree:${wt.slug}`,
        kind: "smelt_worktree",
        summary: `Retry smelting ${wt.slug} after ${targetBranch} advanced`,
        target: wt.slug,
        tier: 1,
        worktree: wt,
      });
      continue;
    }

    if (status === "awaiting_human_approval") {
      if (matchesApproveTarget(wt, approve)) {
        tier1.push({
          approveHighBlast: true,
          blastRadius: wt.blastRadius,
          id: `tier1:smelt_approved:${wt.slug}`,
          kind: "smelt_approved",
          summary: `Smelt human-approved high-blast worktree ${wt.slug} into ${targetBranch}`,
          target: wt.slug,
          tier: 1,
          worktree: wt,
        });
      } else {
        tier3.push({
          blastRadius: wt.blastRadius,
          id: `tier3:awaiting_human_approval:${wt.slug}`,
          kind: "awaiting_human_approval",
          reason: `High blast radius change in ${wt.slug} requires --approve ${wt.slug}`,
          summary: `Worktree ${wt.slug} (blast=high) passed cold review and awaits 'ork next --approve ${wt.slug}'`,
          target: wt.slug,
          tier: 3,
          worktree: wt,
        });
      }
      continue;
    }

    if (!status && (wt.commitsAhead > 0 || wt.isDirty)) {
      tier0.push({
        id: `tier0:reconcile_worktree_verify:${wt.slug}`,
        kind: "reconcile_worktree_verify",
        summary: `Run scoped verification on notIndexed worktree ${wt.slug}`,
        target: wt.slug,
        tier: 0,
        worktree: wt,
      });
      continue;
    }

    if (status === "verified" && wt.commitsAhead > 0) {
      const isApproved = matchesApproveTarget(wt, approve);
      tier1.push({
        approveHighBlast: isApproved,
        blastRadius: wt.blastRadius,
        id: `tier1:${isApproved ? "smelt_approved" : "smelt_worktree"}:${wt.slug}`,
        kind: isApproved ? "smelt_approved" : "smelt_worktree",
        summary: `Smelt verified worktree ${wt.slug} (${wt.branch} -> ${targetBranch}, blast=${wt.blastRadius})`,
        target: wt.slug,
        tier: 1,
        worktree: wt,
      });
      continue;
    }

    if (!REPAIRABLE_STATES.has(status) || attemptCount >= maxAttempts) continue;

    const repairSpec = buildRepairDispatchSpec(wt, wt.foundryState);
    tier2.push({
      attemptNumber: attemptCount + 1,
      id: `tier2:repair_worktree:${wt.slug}`,
      kind: "repair_worktree",
      maxAttempts,
      repairMode: repairSpec.mode,
      repairSpec,
      summary: `Repair ${wt.slug} (${status}, attempt ${attemptCount + 1}/${maxAttempts}, mode=${repairSpec.mode})`,
      target: wt.slug,
      tier: 2,
      worktree: wt,
    });
  }

  tier1.sort((a, b) => {
    if (a.kind === "smelt_approved" && b.kind !== "smelt_approved") return -1;
    if (b.kind === "smelt_approved" && a.kind !== "smelt_approved") return 1;
    const blastDiff = (BLAST_ORDER[a.blastRadius] ?? 1) - (BLAST_ORDER[b.blastRadius] ?? 1);
    if (blastDiff !== 0) return blastDiff;
    return String(a.target).localeCompare(String(b.target));
  });

  if (
    includeGithub &&
    (Array.isArray(openIssues) || typeof execGhFn === "function" || getAccountsFn)
  ) {
    try {
      const accounts =
        typeof getAccountsFn === "function" ? await getAccountsFn() : await getAccounts();
      const filePolicy = await loadFactoryPolicy();
      let resolvedIssues = openIssues;
      if (!Array.isArray(resolvedIssues) && typeof execGhFn === "function") {
        resolvedIssues = await execGhFn(
          [
            "issue",
            "list",
            "--state",
            "open",
            "--limit",
            "100",
            "--json",
            "number,title,labels,body",
          ],
          { cwd: repoRoot },
        );
      }
      if (Array.isArray(resolvedIssues) && resolvedIssues.length > 0) {
        const policy = { ...filePolicy, openIssues: resolvedIssues, ...policyOverride };
        const lanes = buildLanes(accounts);
        const activeAllowPaths = worktrees
          .filter(
            (wt) =>
              !["abandoned", "merged"].includes(wt.foundryState?.status || "") &&
              Array.isArray(wt.allowPaths) &&
              wt.allowPaths.length > 0,
          )
          .map((wt) => wt.allowPaths);
        const extraActive = collectActiveWorktreeAllowPaths(repoRoot, { execFileSyncFn });
        const combinedActivePaths = [...activeAllowPaths, ...extraActive];
        const batch = planBatch(resolvedIssues, lanes, combinedActivePaths, policy);
        if (batch.length > 0) {
          const expiringMatches = batch.filter((match) => match.pool?.expiring === true);
          const isParallelExpiring = expiringMatches.length > 1;
          const selectedMatches = isParallelExpiring ? expiringMatches : [batch[0]];
          tier2.push({
            batch: selectedMatches,
            id: `tier2:dispatch_foundry:${selectedMatches.map((m) => `#${m.issue.number}`).join(",")}`,
            issueNumbers: selectedMatches.map((m) => m.issue.number),
            kind: "dispatch_foundry",
            parallelExpiring: isParallelExpiring,
            summary: isParallelExpiring
              ? `Dispatch ${selectedMatches.length} disjoint issues (${selectedMatches.map((m) => `#${m.issue.number}`).join(", ")}) in parallel across expiring pools`
              : `Dispatch ready issue #${batch[0].issue.number} (${batch[0].issue.title}) on ${batch[0].selectedRoute.engine}/${batch[0].selectedRoute.model}`,
            target: selectedMatches.map((m) => `#${m.issue.number}`).join(","),
            tier: 2,
          });
        }
      }
    } catch {
      /* Ignore GitHub / quota lookup failures during candidate discovery when offline. */
    }
  }

  const candidates = [...tier0, ...tier3, ...tier1, ...tier2];
  return {
    candidates,
    tier0,
    tier1,
    tier2,
    tier3,
    worktrees,
  };
}

async function defaultExecVerify(command, { cwd = process.cwd() } = {}) {
  try {
    const { stderr = "", stdout = "" } = await executeAsync("/bin/sh", ["-c", command], {
      cwd,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 300_000,
    });
    return {
      exitCode: 0,
      ok: true,
      output: `${stdout}${stderr ? `\n${stderr}` : ""}`.trim(),
    };
  } catch (error) {
    return {
      exitCode: typeof error?.code === "number" ? error.code : 1,
      ok: false,
      output: `${error?.stdout || ""}\n${error?.stderr || ""}\n${error?.message || ""}`.trim(),
    };
  }
}

async function defaultExecAgent(args, { cwd = process.cwd() } = {}) {
  const script = path.join(scriptsDir, "run_agent.py");
  const { stdout } = await executeAsync("python3", [script, ...args], {
    cwd,
    maxBuffer: 32 * 1024 * 1024,
    timeout: 600_000,
  });
  const trimmed = String(stdout ?? "").trim();
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return { raw: trimmed, status: "completed" };
    }
  }
  return { raw: trimmed, status: "completed" };
}

function sendHerdrApprovalNotification(title, body, { env = process.env, execFileSyncFn } = {}) {
  if (env?.HERDR_ENV !== "1") return false;
  try {
    const runner = execFileSyncFn || execFileSync;
    runner(
      env.HERDR_BIN_PATH || "herdr",
      ["notification", "show", title, "--body", String(body || ""), "--sound", "request"],
      {
        encoding: "utf8",
        env,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    return true;
  } catch {
    return false;
  }
}

async function executeTier0Action(
  action,
  {
    cwd = process.cwd(),
    env = process.env,
    execFileSyncFn = execFileSync,
    execVerifyFn = defaultExecVerify,
    recoverRoomFn = recoverRoom,
    targetBranch = "main",
  } = {},
) {
  if (action.kind === "recover_room") {
    await recoverRoomFn(action.roomId, { root: mailboxRoot(env) });
    writeNextLedger(
      cwd,
      {
        historyEntry: {
          actionId: action.id,
          kind: action.kind,
          status: "completed",
          summary: action.summary,
          target: action.target,
          tier: 0,
        },
      },
      { env },
    );
    return { action, ok: true, status: "completed" };
  }

  if (action.kind === "escalate_exhausted_worktree") {
    const wt = action.worktree;
    const prevStatus = wt.foundryState?.status || "verification_failed";
    const state = writeFoundryState(wt.worktreePath, {
      escalatedFrom: prevStatus,
      reason: `Exhausted ${wt.foundryState?.attemptCount ?? 2}/${wt.foundryState?.maxAttempts ?? 2} attempts (${prevStatus})`,
      status: "needs_human",
      targetBranch,
    });
    writeNextLedger(
      cwd,
      {
        historyEntry: {
          actionId: action.id,
          kind: action.kind,
          status: "escalated",
          summary: action.summary,
          target: wt.slug,
          tier: 0,
        },
        worktrees: {
          [wt.slug]: {
            attemptCount: state.attemptCount,
            lastAction: action.kind,
            status: "needs_human",
            updatedAt: state.updatedAt,
          },
        },
      },
      { env },
    );
    return { action, foundryState: state, ok: true, status: "escalated" };
  }

  if (action.kind === "prune_merged_worktree") {
    const wt = action.worktree;
    execFileSyncFn("git", ["worktree", "remove", wt.worktreePath], {
      cwd,
      encoding: "utf8",
    });
    if (wt.branch) {
      try {
        execFileSyncFn("git", ["branch", "-d", wt.branch], {
          cwd,
          encoding: "utf8",
        });
      } catch {
        /* Branch may already be deleted. */
      }
    }
    writeNextLedger(
      cwd,
      {
        historyEntry: {
          actionId: action.id,
          kind: action.kind,
          status: "pruned",
          summary: action.summary,
          target: wt.slug,
          tier: 0,
        },
        worktrees: {
          [wt.slug]: {
            attemptCount: wt.foundryState?.attemptCount ?? 1,
            lastAction: action.kind,
            status: "pruned",
            updatedAt: new Date().toISOString(),
          },
        },
      },
      { env },
    );
    return { action, ok: true, status: "pruned" };
  }

  if (action.kind === "reconcile_worktree_verify") {
    const wt = action.worktree;
    const normalizedVerify = enforceScopedVerifyCommand(wt.verifyCommand);
    const verifyRes = await execVerifyFn(normalizedVerify, {
      cwd: wt.worktreePath,
      issue: wt.issue,
    });
    const isVerifyOk =
      typeof verifyRes?.ok === "boolean" ? verifyRes.ok : (verifyRes?.exitCode ?? 1) === 0;
    let commitsAhead = wt.commitsAhead;
    if (isVerifyOk && wt.isDirty) {
      try {
        commitVerifiedWorktreeChanges(wt.worktreePath, wt.issue, { execFileSyncFn });
        const recounted = countCommitsAhead(wt.worktreePath, targetBranch, { execFileSyncFn });
        commitsAhead = recounted.resolved ? recounted.commitsAhead : Math.max(1, commitsAhead);
      } catch {
        commitsAhead = Math.max(1, commitsAhead);
      }
    }
    const newStatus = isVerifyOk ? "verified" : "verification_failed";
    const state = writeFoundryState(wt.worktreePath, {
      attemptCount: wt.foundryState?.attemptCount ?? 1,
      branch: wt.branch,
      commitsAhead,
      headSha: resolveWorktreeHeadSha(wt.worktreePath, { execFileSyncFn }) || wt.head,
      issue: wt.issue ? { number: wt.issue, title: "" } : null,
      status: newStatus,
      targetBranch,
      verification: {
        command: normalizedVerify,
        exitCode: verifyRes?.exitCode ?? (isVerifyOk ? 0 : 1),
        ok: isVerifyOk,
        output: verifyRes?.output || "",
        status: isVerifyOk ? "passed" : "failed",
        verifiedAt: new Date().toISOString(),
      },
      verifyCommand: normalizedVerify,
    });
    writeNextLedger(
      cwd,
      {
        historyEntry: {
          actionId: action.id,
          kind: action.kind,
          status: newStatus,
          summary: action.summary,
          target: wt.slug,
          tier: 0,
        },
        worktrees: {
          [wt.slug]: {
            attemptCount: state.attemptCount,
            lastAction: action.kind,
            status: newStatus,
            updatedAt: state.updatedAt,
          },
        },
      },
      { env },
    );
    return { action, foundryState: state, ok: isVerifyOk, status: newStatus };
  }

  return { action, ok: true, status: "noop" };
}

async function executePrimaryAction(
  action,
  {
    cwd = process.cwd(),
    env = process.env,
    execAgentFn = defaultExecAgent,
    execFileSyncFn = execFileSync,
    execGhFn,
    execVerifyFn = defaultExecVerify,
    gateRunner,
    getAccountsFn,
    notifyFn,
    openIssues,
    policy,
    provisionWorktreeFn,
    reviewRunner,
    smeltWorktreeFn = smeltWorktree,
    stdout = process.stdout,
    targetBranch = "main",
  } = {},
) {
  if (action.tier === 1) {
    const wt = action.worktree;
    try {
      const smeltRes = await smeltWorktreeFn(wt, {
        approveHighBlast: Boolean(action.approveHighBlast),
        cwd,
        execFileSyncFn,
        gateRunner,
        reviewRunner,
        targetBranch,
      });
      const finalStatus = smeltRes.status || (smeltRes.ok ? "merged" : "failed");
      writeNextLedger(
        cwd,
        {
          historyEntry: {
            actionId: action.id,
            kind: action.kind,
            status: finalStatus,
            summary: action.summary,
            target: wt.slug,
            tier: 1,
          },
          worktrees: {
            [wt.slug]: {
              attemptCount: wt.foundryState?.attemptCount ?? 1,
              lastAction: action.kind,
              status: finalStatus,
              updatedAt: new Date().toISOString(),
            },
          },
        },
        { env },
      );
      if (smeltRes.awaitingApproval || finalStatus === "awaiting_human_approval") {
        if (typeof notifyFn === "function") {
          notifyFn(`Orkest: Approval needed (${wt.slug})`, action.summary);
        } else {
          sendHerdrApprovalNotification(
            `Orkest: Approval needed (${wt.slug})`,
            `High blast radius worktree ${wt.slug} awaits 'ork next --approve ${wt.slug}'`,
            { env, execFileSyncFn },
          );
        }
        return {
          action,
          awaitingApproval: true,
          exitCode: EXIT_HUMAN_APPROVAL,
          ok: false,
          result: smeltRes,
          status: "awaiting_human_approval",
        };
      }
      return {
        action,
        exitCode: 0,
        ok: Boolean(smeltRes.ok),
        result: smeltRes,
        status: finalStatus,
      };
    } catch (error) {
      const loadedState = loadFoundryState(wt.worktreePath);
      const updatedState = loadedState.state;
      const stateProblem = ["missing", "ok"].includes(loadedState.kind) ? null : loadedState;
      const failureStatus = stateProblem
        ? "state_unreadable"
        : updatedState?.status || "smelt_failed";
      writeNextLedger(
        cwd,
        {
          historyEntry: {
            actionId: action.id,
            error: error?.message || String(error),
            kind: action.kind,
            status: failureStatus,
            summary: action.summary,
            target: wt.slug,
            tier: 1,
          },
          worktrees: {
            [wt.slug]: {
              attemptCount: updatedState?.attemptCount ?? wt.foundryState?.attemptCount ?? 1,
              lastAction: action.kind,
              status: failureStatus,
              updatedAt: new Date().toISOString(),
            },
          },
        },
        { env },
      );
      if (["rebase_conflict", "scope_violated", "state_unreadable"].includes(failureStatus)) {
        if (typeof notifyFn === "function") {
          notifyFn(`Orkest: ${wt.slug} ${failureStatus}`, error?.message || action.summary);
        } else {
          sendHerdrApprovalNotification(
            `Orkest: ${wt.slug} ${failureStatus}`,
            error?.message || action.summary,
            { env, execFileSyncFn },
          );
        }
        return {
          action,
          error: error?.message || String(error),
          exitCode: EXIT_HUMAN_APPROVAL,
          ok: false,
          status: failureStatus,
        };
      }
      return {
        action,
        error: error?.message || String(error),
        exitCode: 1,
        ok: false,
        status: failureStatus,
      };
    }
  }

  if (action.kind === "repair_worktree") {
    const wt = action.worktree;
    const repairSpec = action.repairSpec || buildRepairDispatchSpec(wt, wt.foundryState);
    const nextAttempt = (wt.foundryState?.attemptCount ?? 1) + 1;
    const maxAttempts = wt.foundryState?.maxAttempts ?? 2;
    let agentResult;
    try {
      agentResult = await execAgentFn(repairSpec.args, {
        cwd: wt.worktreePath,
        repairSpec,
        worktree: wt,
      });
    } catch (error) {
      agentResult = { error: error?.message || String(error), ok: false, status: "failed" };
    }

    const rawAgentStatus = String(
      agentResult?.status ?? (agentResult?.ok === false ? "failed" : "completed"),
    )
      .trim()
      .toLowerCase();
    const didRepairBuilderSucceed =
      (rawAgentStatus === "completed" || rawAgentStatus === "complete") &&
      agentResult?.ok !== false;

    const dirtyCheck =
      typeof agentResult?.dirty === "boolean"
        ? { isDirty: agentResult.dirty, resolved: true }
        : hasWorktreeDirtyChanges(wt.worktreePath, { execFileSyncFn });
    const counted = countCommitsAhead(wt.worktreePath, targetBranch, { execFileSyncFn });
    let commitsAhead;
    if (typeof agentResult?.commitsAhead === "number") {
      commitsAhead = agentResult.commitsAhead;
    } else if (counted.resolved) {
      commitsAhead = counted.commitsAhead;
    } else {
      commitsAhead = Math.max(1, wt.commitsAhead || 1);
    }
    const hasChanges = commitsAhead > 0 || dirtyCheck.isDirty;

    let isVerifyOk = false;
    let verifyOutput = "";
    let verifyExitCode = 1;
    if (didRepairBuilderSucceed && hasChanges) {
      const verifyRes = await execVerifyFn(repairSpec.verifyCommand, {
        cwd: wt.worktreePath,
        issue: wt.issue,
      });
      if (typeof verifyRes?.exitCode === "number") {
        verifyExitCode = verifyRes.exitCode;
      } else {
        verifyExitCode = verifyRes?.ok === false ? 1 : 0;
      }
      isVerifyOk = typeof verifyRes?.ok === "boolean" ? verifyRes.ok : verifyExitCode === 0;
      verifyOutput = typeof verifyRes?.output === "string" ? verifyRes.output : "";
      if (isVerifyOk && dirtyCheck.isDirty) {
        try {
          commitVerifiedWorktreeChanges(wt.worktreePath, wt.issue, { execFileSyncFn });
          const recounted = countCommitsAhead(wt.worktreePath, targetBranch, { execFileSyncFn });
          commitsAhead = recounted.resolved ? recounted.commitsAhead : Math.max(1, commitsAhead);
        } catch {
          commitsAhead = Math.max(1, commitsAhead);
        }
      }
    }

    let finalStatus = "verified";
    if (!isVerifyOk) {
      finalStatus = nextAttempt >= maxAttempts ? "needs_human" : "verification_failed";
    }

    const newState = writeFoundryState(wt.worktreePath, {
      attemptCount: nextAttempt,
      commitsAhead,
      headSha:
        agentResult?.headSha ??
        agentResult?.head_sha ??
        resolveWorktreeHeadSha(wt.worktreePath, { execFileSyncFn }) ??
        wt.head,
      lastRepair: {
        attemptNumber: nextAttempt,
        engine: repairSpec.engine,
        mode: repairSpec.mode,
        model: repairSpec.model,
        repairedAt: new Date().toISOString(),
        status: finalStatus,
      },
      lastRun: {
        engine: repairSpec.engine,
        model: repairSpec.model,
        resultPath:
          agentResult?.result_path ??
          agentResult?.resultPath ??
          wt.foundryState?.lastRun?.resultPath ??
          null,
        sessionId:
          agentResult?.session_id ??
          agentResult?.sessionId ??
          wt.foundryState?.lastRun?.sessionId ??
          null,
        status: rawAgentStatus,
      },
      maxAttempts,
      ...(finalStatus === "needs_human" && {
        reason: `Exhausted ${nextAttempt}/${maxAttempts} attempts (repair failed)`,
      }),
      status: finalStatus,
      targetBranch,
      verification: {
        command: repairSpec.verifyCommand,
        exitCode: verifyExitCode,
        ok: isVerifyOk,
        output: verifyOutput,
        status: isVerifyOk ? "passed" : "failed",
        verifiedAt: new Date().toISOString(),
      },
    });

    writeNextLedger(
      cwd,
      {
        historyEntry: {
          actionId: action.id,
          attemptCount: nextAttempt,
          kind: action.kind,
          repairMode: repairSpec.mode,
          status: finalStatus,
          summary: action.summary,
          target: wt.slug,
          tier: 2,
        },
        worktrees: {
          [wt.slug]: {
            attemptCount: nextAttempt,
            lastAction: action.kind,
            repairMode: repairSpec.mode,
            status: finalStatus,
            updatedAt: newState.updatedAt,
          },
        },
      },
      { env },
    );

    if (finalStatus === "needs_human") {
      if (typeof notifyFn === "function") {
        notifyFn(
          `Orkest: ${wt.slug} needs human review`,
          `Exhausted ${nextAttempt}/${maxAttempts} repair attempts`,
        );
      } else {
        sendHerdrApprovalNotification(
          `Orkest: ${wt.slug} needs human review`,
          `Exhausted ${nextAttempt}/${maxAttempts} repair attempts`,
          { env, execFileSyncFn },
        );
      }
      return {
        action,
        exitCode: EXIT_HUMAN_APPROVAL,
        foundryState: newState,
        ok: false,
        repairSpec,
        status: "needs_human",
      };
    }

    return {
      action,
      exitCode: isVerifyOk ? 0 : 1,
      foundryState: newState,
      ok: isVerifyOk,
      repairSpec,
      status: finalStatus,
    };
  }

  if (action.kind === "dispatch_foundry") {
    const matches = Array.isArray(action.batch) ? action.batch : [];
    const silenceStdout = { columns: stdout?.columns || 120, isTTY: false, write: () => {} };
    const dispatchOne = async (match) =>
      foundryRun(["--issue", String(match.issue.number), "--json"], {
        cwd,
        execAgentFn,
        execFileSyncFn,
        execGhFn:
          execGhFn ||
          (Array.isArray(openIssues)
            ? async () =>
                openIssues.find((i) => Number(i.number) === Number(match.issue.number)) ||
                openIssues
            : undefined),
        execVerifyFn,
        getAccountsFn,
        policy,
        provisionWorktreeFn,
        stdout: silenceStdout,
        targetBranch,
      });

    const dispatchedResults = action.parallelExpiring
      ? await Promise.all(matches.map((match) => dispatchOne(match)))
      : [await dispatchOne(matches[0])];

    const didAllVerify = dispatchedResults.every((res) => res?.status === "verified");
    const finalStatus = didAllVerify ? "verified" : dispatchedResults[0]?.status || "dispatched";

    writeNextLedger(
      cwd,
      {
        historyEntry: {
          actionId: action.id,
          issueNumbers: action.issueNumbers,
          kind: action.kind,
          parallelExpiring: Boolean(action.parallelExpiring),
          status: finalStatus,
          summary: action.summary,
          target: action.target,
          tier: 2,
        },
      },
      { env },
    );

    return {
      action,
      dispatched: dispatchedResults,
      exitCode: didAllVerify ? 0 : 1,
      ok: didAllVerify,
      status: finalStatus,
    };
  }

  return { action, exitCode: 0, ok: true, status: "noop" };
}

function renderNextPanel(payload, width, options = {}) {
  const tier = options.tier || glyphTier();
  const bodyWidth = Math.max(20, width - 6);
  const nextSummary = payload.nextAction
    ? `Next: [Tier ${payload.nextAction.tier}] ${payload.nextAction.kind} -> ${payload.nextAction.summary}`
    : `Next: noop (${payload.status || "all worktrees settled"})`;
  const rows =
    Array.isArray(payload.candidates) && payload.candidates.length > 0
      ? payload.candidates.map((candidate) => [
          `T${candidate.tier}`,
          candidate.kind,
          candidate.target || "--",
          candidate.summary || "",
        ])
      : [["--", "noop", "--", "No pending actions across worktrees or backlog"]];
  const table = renderTable(["Tier", "Action", "Target", "Summary"], rows, bodyWidth, {
    tier,
    weights: [0.08, 0.24, 0.18, 0.5],
  });
  return renderPanel("Next", [nextSummary, ...table], width, {
    color: options.color,
    glyphs: glyphSet(tier),
  })
    .map((line) => line.trimEnd())
    .join("\n");
}

export async function nextCommand(
  argv = [],
  {
    cwd = process.cwd(),
    discoverWorktreesFn = discoverManagedWorktrees,
    env = process.env,
    execAgentFn = defaultExecAgent,
    execFileSyncFn = execFileSync,
    execGhFn,
    execVerifyFn = defaultExecVerify,
    gateRunner,
    getAccountsFn,
    notifyFn,
    observeRoomFn = observeRoom,
    openIssues,
    policy,
    provisionWorktreeFn,
    recoverRoomFn = recoverRoom,
    reviewRunner,
    room,
    smeltWorktreeFn = smeltWorktree,
    stdout = process.stdout,
    targetBranch: defaultTargetBranch = "main",
  } = {},
) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    args: argv,
    options: {
      approve: { type: "string" },
      cwd: { type: "string" },
      "dry-run": { type: "boolean" },
      help: { short: "h", type: "boolean" },
      "include-github": { type: "boolean" },
      json: { type: "boolean" },
      "max-failures": { type: "string" },
      "max-invocations": { type: "string" },
      "max-steps": { type: "string" },
      "max-tier": { type: "string" },
      room: { type: "string" },
      target: { type: "string" },
      "task-dir": { type: "string" },
      width: { type: "string" },
    },
  });

  if (values.help) {
    stdout.write(NEXT_HELP);
    return;
  }

  const mode = positionals[0] || "step";
  if (!["step", "run", "status", "plan", "settle", "loop"].includes(mode)) {
    throw new Error(`Unknown next subcommand: ${mode}`);
  }

  const effectiveCwd = path.resolve(values.cwd || cwd);
  const targetBranch = values.target || defaultTargetBranch || "main";
  const width = Number(values.width || stdout.columns || 120);
  if (!Number.isSafeInteger(width) || width < 40 || width > 1000) {
    throw new Error("Width must be 40–1000");
  }

  let maxTier = 2;
  if (mode === "settle") {
    maxTier = 0;
  } else if (values["max-tier"] !== undefined) {
    maxTier = Number(values["max-tier"]);
  }
  if (!Number.isSafeInteger(maxTier) || maxTier < 0 || maxTier > 3) {
    throw new Error("--max-tier must be 0, 1, 2, or 3");
  }

  const stripWorktreeField = (candidate) => {
    if (!candidate || typeof candidate !== "object") return null;
    const copy = { ...candidate };
    delete copy.worktree;
    return copy;
  };

  const isDryRun = Boolean(values["dry-run"]);
  const isReadOnlyMode = mode === "status" || mode === "plan";
  const shouldIncludeGithub =
    Boolean(values["include-github"]) ||
    (!isReadOnlyMode && maxTier >= 2) ||
    Array.isArray(openIssues) ||
    typeof execGhFn === "function";

  if (isReadOnlyMode) {
    const evaluated = await evaluateNextCandidates({
      approve: values.approve || null,
      cwd: effectiveCwd,
      discoverWorktreesFn,
      execFileSyncFn,
      execGhFn,
      getAccountsFn,
      includeGithub: shouldIncludeGithub,
      observeRoomFn,
      openIssues,
      policy,
      room,
      roomId: values.room || null,
      targetBranch,
    });
    const nextAction =
      evaluated.tier0[0] ||
      evaluated.tier3[0] ||
      evaluated.tier1.find((c) => c.tier <= maxTier) ||
      evaluated.tier2.find((c) => c.tier <= maxTier) ||
      null;
    const payload = {
      candidates: evaluated.candidates.map((c) => stripWorktreeField(c)),
      maxTier,
      mode,
      nextAction: stripWorktreeField(nextAction),
      ok: true,
      schema: NEXT_SCHEMA,
      status: nextAction ? "ready" : "noop",
      targetBranch,
      tier3Gates: evaluated.tier3.map((c) => stripWorktreeField(c)),
      worktrees: evaluated.worktrees.map((wt) => ({
        allowPaths: wt.allowPaths,
        blastRadius: wt.blastRadius,
        branch: wt.branch,
        commitsAhead: wt.commitsAhead,
        engine: wt.engine,
        issue: wt.issue,
        path: wt.path,
        slug: wt.slug,
        stateProblem: wt.stateProblem ?? null,
        status: wt.stateProblem ? "state_unreadable" : wt.foundryState?.status || "notIndexed",
      })),
    };
    if (values.json) {
      stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      stdout.write(
        `${renderNextPanel(payload, width, {
          color: shouldUseColor(stdout),
          tier: glyphTier(),
        })}\n`,
      );
    }
    return payload;
  }

  const runSingleStep = async () => {
    const lock = isDryRun ? null : await acquireNextLock(effectiveCwd, { env });
    try {
      const settledActions = [];
      let evaluated = await evaluateNextCandidates({
        approve: values.approve || null,
        cwd: effectiveCwd,
        discoverWorktreesFn,
        execFileSyncFn,
        execGhFn,
        getAccountsFn,
        includeGithub: shouldIncludeGithub,
        observeRoomFn,
        openIssues,
        policy,
        room,
        roomId: values.room || null,
        targetBranch,
      });

      if (!isDryRun && evaluated.tier0.length > 0) {
        for (const t0 of evaluated.tier0) {
          const settled = await executeTier0Action(t0, {
            cwd: effectiveCwd,
            env,
            execFileSyncFn,
            execVerifyFn,
            recoverRoomFn,
            targetBranch,
          });
          settledActions.push({ ...stripWorktreeField(t0), outcome: settled.status });
        }
        evaluated = await evaluateNextCandidates({
          approve: values.approve || null,
          cwd: effectiveCwd,
          discoverWorktreesFn,
          execFileSyncFn,
          execGhFn,
          getAccountsFn,
          includeGithub: shouldIncludeGithub,
          observeRoomFn,
          openIssues,
          policy,
          room,
          roomId: values.room || null,
          targetBranch,
        });
      }

      if (maxTier === 0) {
        return {
          candidates: evaluated.candidates.map((c) => stripWorktreeField(c)),
          dryRun: isDryRun,
          executedAction: null,
          exitCode: 0,
          maxTier,
          mode,
          nextAction: stripWorktreeField(evaluated.tier0[0] || null),
          ok: true,
          schema: NEXT_SCHEMA,
          settledActions,
          status: settledActions.length > 0 ? "settled" : "noop",
          targetBranch,
        };
      }

      const topTier1 = evaluated.tier1.find((c) => c.tier <= maxTier);
      const topTier2 = evaluated.tier2.find((c) => c.tier <= maxTier);
      const primaryCandidate = topTier1 || topTier2 || null;

      // If a Tier 3 human approval gate exists and there is no independent approved/disjoint work
      // or if the Tier 3 gate is the only remaining work, pause with exitCode 4:
      if (evaluated.tier3.length > 0 && !primaryCandidate) {
        const topGate = evaluated.tier3[0];
        const cleanGate = stripWorktreeField(topGate);
        if (!isDryRun) {
          if (typeof notifyFn === "function") {
            notifyFn(`Orkest: Approval needed (${topGate.target})`, topGate.summary);
          } else {
            sendHerdrApprovalNotification(
              `Orkest: Approval needed (${topGate.target})`,
              topGate.summary,
              { env, execFileSyncFn },
            );
          }
          process.exitCode = EXIT_HUMAN_APPROVAL;
        }
        return {
          candidates: evaluated.candidates.map((c) => stripWorktreeField(c)),
          dryRun: isDryRun,
          executedAction: null,
          exitCode: EXIT_HUMAN_APPROVAL,
          gate: cleanGate,
          maxTier,
          mode,
          nextAction: cleanGate,
          ok: false,
          schema: NEXT_SCHEMA,
          settledActions,
          status: "awaiting_human",
          targetBranch,
          tier3Gates: evaluated.tier3.map((c) => stripWorktreeField(c)),
        };
      }

      if (!primaryCandidate) {
        return {
          candidates: evaluated.candidates.map((c) => stripWorktreeField(c)),
          dryRun: isDryRun,
          executedAction: null,
          exitCode: 0,
          maxTier,
          mode,
          nextAction: null,
          ok: true,
          schema: NEXT_SCHEMA,
          settledActions,
          status: settledActions.length > 0 ? "settled" : "noop",
          targetBranch,
        };
      }

      const cleanPrimary = stripWorktreeField(primaryCandidate);
      if (isDryRun) {
        return {
          candidates: evaluated.candidates.map((c) => stripWorktreeField(c)),
          dryRun: true,
          executedAction: cleanPrimary,
          exitCode: 0,
          maxTier,
          mode,
          nextAction: cleanPrimary,
          ok: true,
          schema: NEXT_SCHEMA,
          settledActions,
          status: "dry-run",
          targetBranch,
        };
      }

      const execution = await executePrimaryAction(primaryCandidate, {
        cwd: effectiveCwd,
        env,
        execAgentFn,
        execFileSyncFn,
        execGhFn,
        execVerifyFn,
        gateRunner,
        getAccountsFn,
        notifyFn,
        openIssues,
        policy,
        provisionWorktreeFn,
        reviewRunner,
        smeltWorktreeFn,
        stdout,
        targetBranch,
      });

      if (execution.exitCode === EXIT_HUMAN_APPROVAL) {
        process.exitCode = EXIT_HUMAN_APPROVAL;
      }

      return {
        candidates: evaluated.candidates.map((c) => stripWorktreeField(c)),
        dryRun: false,
        executedAction: cleanPrimary,
        execution: {
          ...(execution.repairSpec && { repairSpec: execution.repairSpec }),
          ...(execution.dispatched && { dispatched: execution.dispatched }),
          ...(execution.error && { error: execution.error }),
          status: execution.status,
        },
        exitCode: execution.exitCode ?? 0,
        maxTier,
        mode,
        nextAction: cleanPrimary,
        ok: execution.ok,
        schema: NEXT_SCHEMA,
        settledActions,
        status: execution.status,
        targetBranch,
      };
    } finally {
      if (lock) await releaseNextLock(lock);
    }
  };

  if (mode === "loop") {
    const maxSteps = Number(values["max-steps"] || 10);
    const maxInvocations = Number(values["max-invocations"] || 3);
    const maxFailures = Number(values["max-failures"] || 2);
    const steps = [];
    let invocationsUsed = 0;
    let failuresCount = 0;
    let finalExitCode = 0;
    let stopReason = "max_steps_reached";

    for (let stepIdx = 0; stepIdx < maxSteps; stepIdx++) {
      if (invocationsUsed >= maxInvocations) {
        stopReason = "max_invocations_reached";
        break;
      }
      const stepRes = await runSingleStep();
      steps.push(stepRes);

      if (stepRes.executedAction && stepRes.executedAction.tier >= 1) {
        invocationsUsed++;
      }
      if (stepRes.exitCode === EXIT_HUMAN_APPROVAL) {
        finalExitCode = EXIT_HUMAN_APPROVAL;
        stopReason = "awaiting_human";
        break;
      }
      if (!stepRes.ok) {
        failuresCount++;
        if (failuresCount >= maxFailures) {
          finalExitCode = 1;
          stopReason = "max_failures_reached";
          break;
        }
      }
      if (stepRes.status === "noop" || !stepRes.executedAction) {
        stopReason = "noop";
        break;
      }
    }

    const loopPayload = {
      exitCode: finalExitCode,
      failuresCount,
      invocationsUsed,
      maxFailures,
      maxInvocations,
      maxSteps,
      maxTier,
      mode: "loop",
      ok: finalExitCode === 0,
      schema: NEXT_SCHEMA,
      status: stopReason,
      steps,
      targetBranch,
    };
    if (values.json) {
      stdout.write(`${JSON.stringify(loopPayload, null, 2)}\n`);
    } else {
      stdout.write(
        `ork next loop: ${steps.length} step(s), ${invocationsUsed}/${maxInvocations} invocations, stop=${stopReason}\n`,
      );
    }
    return loopPayload;
  }

  const payload = await runSingleStep();
  if (values.json) {
    stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    stdout.write(
      `${renderNextPanel(payload, width, {
        color: shouldUseColor(stdout),
        tier: glyphTier(),
      })}\n`,
    );
  }
  return payload;
}

export const nextCli = nextCommand;
export default nextCommand;
