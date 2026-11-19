/**
 * @module smelter
 *
 * The Smelter (`ork smelter`): Automated disposable worktree verification,
 * cross-vendor cold review, and merge queue.
 *
 * Pipeline stages:
 * 1. Rebase & Scope Audit (`classifyBlastRadius`: `low` | `medium` | `high`)
 * 2. Serialized Heavy Gate (`ork gate --heavy`)
 * 3. Cross-Vendor Cold Review (`run_agent.py consult --intent review`)
 * 4. Smelt & Prune (fast-forward local merge or PR creation + worktree removal)
 */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { shouldUseColor } from "../../monitor/lib/render.mjs";
import { loadFoundryState, resolveFoundryStatePath, writeFoundryState } from "./foundry.mjs";
import { mailboxRoot, readRawRoom, resolveWorktreeMarkerPath } from "./horde-room.mjs";
import { glyphSet, glyphTier, renderPanel, renderTable } from "./horde-view.mjs";
import { ensurePullRequest, parseStrategy, pruneMergedWorktree } from "./merged-worktree.mjs";
import {
  isHarnessAllowed,
  loadConfiguredAccounts,
  resolveConfiguredAccount,
  resolveRepoPolicy,
} from "./policy.mjs";
import { acquireWorkspaceLease, assertWorkspaceLease } from "./workspace-lease.mjs";

const scriptsDir = fileURLToPath(new URL("../skills/orchestrate/scripts/", import.meta.url));

export const COLD_REVIEW_QUESTION =
  "Review the changes and report ONLY concrete correctness bugs, security vulnerabilities, concurrency/race conditions, or scope violations under FINDINGS. Do not report stylistic preferences or speculative refactors; write 'none' under FINDINGS if no concrete defects exist.";

/** Describe only the candidate and checks actually represented by this evidence. */
export function buildColdReviewQuestion(evidence) {
  const checks = evidence.checks || [];
  const lines = [
    `Candidate commit: ${evidence.candidate.commit}`,
    `Target SHA: ${evidence.target.sha}`,
    "Recorded checks (no other verification is claimed):",
    ...checks.map(
      (check) =>
        `- [${check.kind}] ${JSON.stringify(check.command)}: ${check.result} (exit ${check.exitCode ?? "unknown"})`,
    ),
  ];
  if (checks.length === 0) lines.push("No checks were run.");
  if (checks.every((check) => check.kind !== "acceptance"))
    lines.push("No acceptance checks were defined.");
  if (checks.length > 0 && checks.every((check) => check.kind === "default-lint")) {
    lines.push(
      checks.every((check) => check.result === "passed")
        ? "Only the lint default ran; tests were not run."
        : "Only the lint default was selected; tests were not run.",
    );
  }
  lines.push("No additional tests, linters or formatters were run beyond the commands listed.");
  return [...lines, COLD_REVIEW_QUESTION].join("\n");
}

// Initial failure plus at most two automatic retries, independent of builder repairs.
export const SMELTER_INFRASTRUCTURE_RETRIES = 2;

function gateReceipt(label, worktreePath, env) {
  const directory = env.AGENT_GATE_DIR || `/tmp/agent-gate-${process.getuid()}`;
  try {
    return (
      readFileSync(path.join(directory, "runs.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .findLast(
          (entry) =>
            entry.label === label &&
            alignCanonicalPath(entry.cwd) === alignCanonicalPath(worktreePath),
        ) || null
    );
  } catch {
    return null;
  }
}

export const SMELTER_HELP = `ork smelter status [--json] [--target <branch>] [--width 120]
ork smelter run [--worktree <slug|path>] [--strategy local|pr] [--target <branch>] [--approve-high-blast <commit>] [--dry-run] [--skip-review] [--json]
`;

export function alignCanonicalPath(targetPath) {
  if (!targetPath || typeof targetPath !== "string") return "";
  const resolved = path.resolve(targetPath);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

export function parseColdReviewFindings(reviewOutput) {
  const infrastructure = (reason) => ({
    result: "infrastructure_failure",
    passed: false,
    findings: null,
    reason,
  });
  if (reviewOutput == null) return infrastructure("Cold review output missing FINDINGS section");
  let parsed = reviewOutput;
  if (typeof reviewOutput === "string") {
    const trimmed = reviewOutput.trim();
    if (!trimmed) return infrastructure("Cold review output missing FINDINGS section");
    if (trimmed.startsWith("{")) {
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return infrastructure("Unparseable cold review output");
      }
    }
  }
  if (
    parsed &&
    typeof parsed === "object" &&
    (parsed.error ||
      parsed.ok === false ||
      parsed.passed === false ||
      ["failed", "error", "timeout", "blocked"].includes(parsed.status) ||
      (parsed.exit_code != null && parsed.exit_code !== 0))
  ) {
    return infrastructure(String(parsed.error || parsed.summary || "Cold review runner failed"));
  }
  let rawFindings =
    parsed?.sections?.FINDINGS ??
    parsed?.sections?.findings ??
    parsed?.FINDINGS ??
    parsed?.findings ??
    null;
  if (rawFindings === null && typeof parsed === "string") {
    const section =
      /(?:^|\r?\n)\s*(?:#+\s*)?FINDINGS\s*:?[ \t]*\r?\n([\s\S]*?)(?=\r?\n\s*(?:#+\s*[A-Z_]+|[A-Z_]{3,}\s*:)|$)/iu.exec(
        parsed,
      );
    const inline = /(?:^|\r?\n)\s*(?:#+\s*)?FINDINGS\s*:[ \t]*([^\r\n]+)/iu.exec(parsed);
    rawFindings = section?.[1] ?? inline?.[1] ?? null;
  }
  if (typeof rawFindings !== "string" || !rawFindings.trim())
    return infrastructure("Cold review output missing FINDINGS section");
  const cleaned = rawFindings
    .trim()
    .replaceAll(/^(?:[-*•]\s*)+/gu, "")
    .trim();
  if (
    /^(?:none|no\s+(?:concrete\s+|actionable\s+)?(?:findings|defects|issues)(?:\s+found)?\.?)$/iu.test(
      cleaned,
    )
  )
    return { result: "passed", passed: true, findings: "none" };
  return { result: "findings", passed: false, findings: rawFindings.trim() };
}

function normalizeRelativePath(rawPath) {
  if (typeof rawPath !== "string") return "";
  const slashPath = rawPath.replaceAll("\\", "/").trim();
  if (!slashPath) return "";
  return path.posix
    .normalize(slashPath)
    .replaceAll(/^(?:\.\/)+/gu, "")
    .replaceAll(/^\/+|\/+$/gu, "");
}

function isLowRiskFile(normalizedPath) {
  if (
    !normalizedPath ||
    normalizedPath.startsWith("docs/") ||
    normalizedPath.startsWith("tests/") ||
    normalizedPath.startsWith("test/") ||
    normalizedPath.startsWith("__tests__/") ||
    normalizedPath.startsWith("fixtures/") ||
    normalizedPath.includes("/tests/") ||
    normalizedPath.includes("/__tests__/") ||
    normalizedPath.includes("/fixtures/") ||
    normalizedPath.includes("/__fixtures__/")
  ) {
    return true;
  }
  const base = path.posix.basename(normalizedPath);
  return (
    /\.(?:md|mdx|txt)$/iu.test(base) ||
    base === "LICENSE" ||
    /(?:^|[._-])(?:test|spec)\.[a-z0-9]+$/iu.test(base) ||
    /^test_.*\.py$/iu.test(base) ||
    /.*_test\.py$/iu.test(base)
  );
}

function isHighRiskFile(normalizedPath) {
  if (!normalizedPath) return false;
  if (
    normalizedPath === "bin/ork.mjs" ||
    normalizedPath.endsWith("/bin/ork.mjs") ||
    normalizedPath === "run_agent.py" ||
    normalizedPath.endsWith("/run_agent.py") ||
    normalizedPath === "gate.py" ||
    normalizedPath.endsWith("/gate.py") ||
    normalizedPath.startsWith(".github/workflows/") ||
    normalizedPath.includes("/.github/workflows/")
  ) {
    return true;
  }
  if (isLowRiskFile(normalizedPath)) return false;
  return /(?:^|\/|[_.-])(?:auth|security|credential|credentials|secret|secrets|oauth|permission|permissions)(?:$|\/|[_.-])/iu.test(
    normalizedPath,
  );
}

/**
 * Classifies a list of changed file paths into blast-radius risk tiers:
 * - "high": touches bin/ork.mjs, run_agent.py, gate.py, .github/workflows/, or auth/security files
 * - "low": docs, tests, or fixtures only
 * - "medium": all other source changes
 */
export function classifyBlastRadius(changedPaths) {
  if (!Array.isArray(changedPaths) || changedPaths.length === 0) return "low";
  const normalized = changedPaths.map(normalizeRelativePath).filter(Boolean);
  if (normalized.length === 0) return "low";
  if (normalized.some(isHighRiskFile)) return "high";
  if (normalized.every(isLowRiskFile)) return "low";
  return "medium";
}

const REVIEWER_PREFERENCE = {
  agy: ["claude", "codex", "opencode", "agy"],
  claude: ["codex", "agy", "opencode", "claude"],
  codex: ["claude", "agy", "opencode", "codex"],
  opencode: ["claude", "codex", "agy", "opencode"],
};

export function isEngineInstalled(engine, env = process.env) {
  const pathDirs = String(env?.PATH || "")
    .split(path.delimiter)
    .filter(Boolean);
  return pathDirs.some((dir) => existsSync(path.join(dir, engine)));
}

function normalizeReviewerEngineToken(rawEngine, options = {}) {
  const cleaned = String(rawEngine ?? "")
    .trim()
    .toLowerCase();
  if (!cleaned) return "";
  if (cleaned === "antigravity" || cleaned === "gemini") return "agy";
  if (cleaned === "openai") return "codex";
  if (cleaned === "openrouter") return "opencode";
  if (Object.hasOwn(REVIEWER_PREFERENCE, cleaned)) return cleaned;
  const acct = resolveConfiguredAccount(cleaned, options);
  if (acct?.provider) {
    const prov = String(acct.provider).trim().toLowerCase();
    return prov === "antigravity" || prov === "gemini" ? "agy" : prov;
  }
  return cleaned;
}

function isReviewerEngineAllowedByPolicy(engine, configuredAccounts, policy, options = {}) {
  if (!policy || !Array.isArray(policy.deny) || policy.deny.length === 0) return true;
  const evalOpts = {
    policy,
    ...(options.env && { env: options.env }),
    ...(options.homeDir && { homeDir: options.homeDir }),
    ...(options.monitorConfigPath && { monitorConfigPath: options.monitorConfigPath }),
    accounts: configuredAccounts,
  };
  const matchingAccounts = configuredAccounts.filter((acct) => {
    const prov = String(acct?.provider || acct?.engine || "")
      .trim()
      .toLowerCase();
    const norm = prov === "antigravity" || prov === "gemini" ? "agy" : prov;
    return norm === engine;
  });
  if (matchingAccounts.length > 0) {
    return matchingAccounts.some((acct) => isHarnessAllowed(options.cwd || null, acct, evalOpts));
  }
  return isHarnessAllowed(options.cwd || null, { provider: engine, engine }, evalOpts);
}

/**
 * Selects a cross-vendor engine for independent cold review, preferring an
 * installed cross-vendor harness and falling back to available harnesses when
 * a machine only has a subset installed.
 */
export function selectColdReviewerEngine(workerEngine, options = {}) {
  const normalized = normalizeReviewerEngineToken(workerEngine, options);
  const baseCandidates = REVIEWER_PREFERENCE[normalized] || REVIEWER_PREFERENCE.codex;
  let policy = options.policy || null;
  if (!policy && options.cwd) {
    try {
      policy = resolveRepoPolicy(options.cwd, {
        ...(options.env && { env: options.env }),
        ...(options.homeDir && { homeDir: options.homeDir }),
        strict: false,
      });
    } catch {
      policy = null;
    }
  }
  let candidates = baseCandidates;
  if (policy && Array.isArray(policy.deny) && policy.deny.length > 0) {
    const configuredAccounts = Array.isArray(options.accounts)
      ? options.accounts
      : loadConfiguredAccounts({
          ...(options.env && { env: options.env }),
          ...(options.homeDir && { homeDir: options.homeDir }),
          ...(options.monitorConfigPath && { monitorConfigPath: options.monitorConfigPath }),
        });
    const allowed = baseCandidates.filter((engine) =>
      isReviewerEngineAllowedByPolicy(engine, configuredAccounts, policy, options),
    );
    if (allowed.length > 0) candidates = allowed;
  }
  if (Array.isArray(options?.availableEngines)) {
    const available = new Set(options.availableEngines.map((item) => String(item).toLowerCase()));
    return candidates.find((engine) => available.has(engine)) || candidates[0];
  }
  if (typeof options?.hasEngine === "function") {
    return candidates.find((engine) => options.hasEngine(engine)) || candidates[0];
  }
  return candidates.find((engine) => isEngineInstalled(engine, options?.env)) || candidates[0];
}

export function getBranchDiffFiles(
  worktreePath,
  targetBranch = "main",
  { branch = "HEAD", execFileSyncFn = execFileSync } = {},
) {
  const diffOut = String(
    execFileSyncFn("git", ["diff", "--name-only", "--no-renames", `${targetBranch}...${branch}`], {
      cwd: worktreePath,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    }) ?? "",
  );
  return diffOut.split(/\r?\n/u).map(normalizeRelativePath).filter(Boolean);
}

export function isPathAllowed(changedPath, allowPaths) {
  if (!Array.isArray(allowPaths) || allowPaths.length === 0) return true;
  // Git -z paths are literal: trimming or treating backslashes as separators can widen scope.
  if (typeof changedPath !== "string" || !changedPath) return false;
  const candidate = path.posix.normalize(changedPath);
  if (candidate === ".." || candidate.startsWith("../") || path.posix.isAbsolute(candidate))
    return false;
  return allowPaths.some((rawAllowed) => {
    const allowed = normalizeRelativePath(rawAllowed);
    if (!allowed) return false;
    if (allowed === ".") return true;
    return candidate === allowed || candidate.startsWith(`${allowed}/`);
  });
}

function applyPorcelainField(entry, key, value) {
  switch (key) {
    case "HEAD": {
      entry.head = value;
      break;
    }
    case "branch": {
      entry.branch = value.replace(/^refs\/heads\//u, "");
      break;
    }
    case "detached": {
      entry.detached = true;
      break;
    }
    default: {
      break;
    }
  }
}

function parsePorcelainWorktrees(porcelainOutput) {
  if (typeof porcelainOutput !== "string" || !porcelainOutput.trim()) return [];
  const entries = [];
  let current = null;
  for (const rawLine of porcelainOutput.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) {
      if (current?.worktree) entries.push(current);
      current = null;
      continue;
    }
    const [key, ...rest] = line.split(" ");
    const value = rest.join(" ").trim();
    if (key === "worktree") {
      if (current?.worktree) entries.push(current);
      current = { worktree: value };
    } else if (current) {
      applyPorcelainField(current, key, value);
    }
  }
  if (current?.worktree) entries.push(current);
  return entries;
}

function readJsonIfExists(filePath) {
  if (!filePath || !existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

export function verifyRoomIntegrationRecord(marker, foundryState, options = {}) {
  const isRoomIntegrated = Boolean(
    marker?.roomId ||
    marker?.memberId ||
    marker?.integrationId ||
    foundryState?.roomId ||
    foundryState?.memberId ||
    foundryState?.integrationId,
  );
  if (!isRoomIntegrated) {
    return { ok: true, isRoomIntegrated: false };
  }
  if (!marker || typeof marker !== "object") {
    return { ok: false, isRoomIntegrated: true, reason: "room_marker_missing" };
  }
  const roomId = marker.roomId;
  const memberId = marker.memberId;
  const integrationId = marker.integrationId;
  if (
    typeof roomId !== "string" ||
    !roomId ||
    typeof memberId !== "string" ||
    !memberId ||
    typeof integrationId !== "string" ||
    !integrationId ||
    typeof marker.commit !== "string" ||
    !marker.commit
  ) {
    return { ok: false, isRoomIntegrated: true, reason: "room_integration_incomplete" };
  }
  if (
    (foundryState?.roomId && foundryState.roomId !== roomId) ||
    (foundryState?.memberId && foundryState.memberId !== memberId) ||
    (foundryState?.integrationId && foundryState.integrationId !== integrationId)
  ) {
    return { ok: false, isRoomIntegrated: true, reason: "room_integration_state_mismatch" };
  }
  const root =
    options.mailboxRoot || marker.mailboxRoot || foundryState?.mailboxRoot || mailboxRoot();
  let room;
  try {
    room = readRawRoom(roomId, root);
  } catch {
    return { ok: false, isRoomIntegrated: true, reason: "room_missing_or_unreadable" };
  }
  if (!room || !Array.isArray(room.agents)) {
    return { ok: false, isRoomIntegrated: true, reason: "room_missing_or_unreadable" };
  }
  const member = room.agents.find((agent) => agent && agent.id === memberId);
  const integration = member?.integration;
  if (!integration || typeof integration !== "object") {
    return { ok: false, isRoomIntegrated: true, reason: "room_integration_not_committed" };
  }
  if (integration.integrationId !== integrationId) {
    return { ok: false, isRoomIntegrated: true, reason: "room_integration_id_mismatch" };
  }
  if (integration.commit !== marker.commit) {
    return { ok: false, isRoomIntegrated: true, reason: "room_integration_commit_mismatch" };
  }
  if (foundryState?.acceptedCommit && foundryState.acceptedCommit !== integration.commit) {
    return {
      ok: false,
      isRoomIntegrated: true,
      reason: "room_integration_accepted_commit_mismatch",
    };
  }
  if (
    typeof integration.targetBranch === "string" &&
    integration.targetBranch &&
    typeof foundryState?.targetBranch === "string" &&
    foundryState.targetBranch &&
    integration.targetBranch !== foundryState.targetBranch
  ) {
    return {
      ok: false,
      isRoomIntegrated: true,
      reason: "room_target_branch_mismatch",
    };
  }
  const recordedWorktree = member?.worktree;
  if (!recordedWorktree || typeof recordedWorktree.path !== "string" || !recordedWorktree.path) {
    return { ok: false, isRoomIntegrated: true, reason: "room_worktree_mismatch" };
  }
  if (recordedWorktree.disposable === false) {
    return { ok: false, isRoomIntegrated: true, reason: "room_worktree_not_disposable" };
  }
  if (options.worktreePath) {
    let canonicalRecordedWorktree;
    let canonicalLiveWorktree;
    try {
      canonicalRecordedWorktree = realpathSync(path.resolve(recordedWorktree.path));
      canonicalLiveWorktree = realpathSync(path.resolve(options.worktreePath));
    } catch {
      return { ok: false, isRoomIntegrated: true, reason: "room_worktree_mismatch" };
    }
    if (canonicalLiveWorktree !== canonicalRecordedWorktree) {
      return { ok: false, isRoomIntegrated: true, reason: "room_worktree_mismatch" };
    }
  }
  if (
    typeof recordedWorktree.branch === "string" &&
    recordedWorktree.branch &&
    typeof marker.branch === "string" &&
    marker.branch &&
    recordedWorktree.branch !== marker.branch
  ) {
    return { ok: false, isRoomIntegrated: true, reason: "room_branch_mismatch" };
  }
  return { ok: true, isRoomIntegrated: true, integration, room, member };
}

function loadWorktreeMetadata(worktreePath, explicitMarkerPath = null) {
  const markerPath = explicitMarkerPath || resolveWorktreeMarkerPath(worktreePath) || null;
  const gitDir = markerPath
    ? path.dirname(markerPath)
    : path.join(path.resolve(worktreePath), ".git");
  const marker = readJsonIfExists(markerPath) || readJsonIfExists(path.join(gitDir, "orkest.json"));
  const primarySpecPath = path.join(gitDir, "orkest", "task-spec.json");
  const fallbackSpecPath = path.join(gitDir, "task-spec.json");
  const legacySpecPath = path.join(worktreePath, ".orkest-task-spec.json");
  let taskSpecPath = null;
  let taskSpec = null;
  for (const candidate of [primarySpecPath, fallbackSpecPath, legacySpecPath]) {
    const loaded = readJsonIfExists(candidate);
    if (loaded) {
      taskSpec = loaded;
      taskSpecPath = candidate;
      break;
    }
  }
  const foundryStatePath = resolveFoundryStatePath(worktreePath);
  const loadedState = loadFoundryState(worktreePath);
  const foundryState = loadedState.state;
  const stateProblem = ["missing", "ok"].includes(loadedState.kind) ? null : loadedState;
  return {
    foundryState,
    foundryStatePath,
    stateProblem,
    gitDir,
    marker,
    markerPath,
    taskSpec,
    taskSpecPath,
  };
}

function resolveGitSha(cwd, ref, execFileSyncFn = execFileSync) {
  try {
    const out = String(
      execFileSyncFn("git", ["rev-parse", ref], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }) ?? "",
    ).trim();
    return out || null;
  } catch {
    return null;
  }
}

const SKIPPED_SMELTER_STATES = new Set([
  "abandoned",
  "launching",
  "running",
  "launch_uncertain",
  "merged",
  "needs_human",
  "pr_opened",
  "scope_violated",
  "verification_failed",
  "worker_failed",
]);

/**
 * Inspects `git worktree list --porcelain` and each worktree's `<gitdir>/orkest.json`
 * marker + `task-spec.json` to find disposable worktrees with commits ahead of target.
 */
export function discoverSmeltableWorktrees(
  repoRoot = process.cwd(),
  {
    execFileSyncFn = execFileSync,
    includeAllStates = false,
    includeKeep = false,
    mailboxRoot: overrideMailboxRoot,
    targetBranch = "main",
  } = {},
) {
  const resolvedRoot = path.resolve(repoRoot);
  const canonicalRoot = alignCanonicalPath(resolvedRoot);
  const porcelain = String(
    execFileSyncFn("git", ["worktree", "list", "--porcelain"], {
      cwd: resolvedRoot,
      encoding: "utf8",
    }) ?? "",
  );
  const rawEntries = parsePorcelainWorktrees(porcelain);
  const smeltable = [];
  let cachedTargetHeadSha;

  for (const entry of rawEntries) {
    const worktreePath = path.resolve(entry.worktree);
    if (alignCanonicalPath(worktreePath) === canonicalRoot) continue;
    const {
      foundryState,
      foundryStatePath,
      stateProblem,
      gitDir,
      marker,
      markerPath,
      taskSpec,
      taskSpecPath,
    } = loadWorktreeMetadata(worktreePath);
    if (!marker || typeof marker !== "object") continue;
    if (!includeKeep && marker.disposable === false) continue;

    if (!includeAllStates && !foundryState && !stateProblem) continue;
    const roomCheck = verifyRoomIntegrationRecord(marker, foundryState, {
      mailboxRoot: overrideMailboxRoot,
      worktreePath,
    });
    if (!roomCheck.ok) {
      continue;
    }
    if (
      roomCheck.isRoomIntegrated &&
      typeof roomCheck.member?.worktree?.branch === "string" &&
      roomCheck.member.worktree.branch &&
      entry.branch &&
      entry.branch !== roomCheck.member.worktree.branch
    ) {
      continue;
    }
    // A worktree records the branch its result belongs on; one queued for another branch is left
    // for a run that targets that branch, never rebased onto this one.
    const recordedTargetBranch =
      (roomCheck.isRoomIntegrated ? roomCheck.integration?.targetBranch : null) ||
      foundryState?.targetBranch ||
      null;
    if (!includeAllStates && recordedTargetBranch && recordedTargetBranch !== targetBranch)
      continue;
    if (!includeAllStates && foundryState && typeof foundryState.status === "string") {
      if (SKIPPED_SMELTER_STATES.has(foundryState.status)) {
        continue;
      }
      if (foundryState.status === "rebase_conflict") {
        const conflictOn = foundryState.rebase?.conflictOn;
        const currentWorktreeSha =
          entry.head || resolveGitSha(worktreePath, "HEAD", execFileSyncFn);
        if (cachedTargetHeadSha === undefined) {
          cachedTargetHeadSha =
            resolveGitSha(worktreePath, targetBranch, execFileSyncFn) ||
            resolveGitSha(resolvedRoot, targetBranch, execFileSyncFn);
        }
        if (
          conflictOn &&
          conflictOn.worktreeHeadSha &&
          conflictOn.worktreeHeadSha === currentWorktreeSha &&
          (!conflictOn.targetHeadSha ||
            !cachedTargetHeadSha ||
            conflictOn.targetHeadSha === cachedTargetHeadSha)
        ) {
          continue;
        }
      }
    }

    let commitsAhead;
    try {
      const countRaw = String(
        execFileSyncFn("git", ["rev-list", "--count", `${targetBranch}..HEAD`], {
          cwd: worktreePath,
          encoding: "utf8",
        }) ?? "",
      ).trim();
      const parsedCount = Number(countRaw);
      commitsAhead = Number.isSafeInteger(parsedCount) ? parsedCount : 0;
    } catch {
      commitsAhead = 0;
    }
    if (commitsAhead <= 0 && !stateProblem) continue;

    const branch = entry.branch || marker.branch || null;
    smeltable.push({
      allowPaths: taskSpec?.allow_paths ?? [],
      branch,
      commitsAhead,
      disposable: marker.disposable !== false,
      engine: marker.engine || taskSpec?.engine || null,
      foundryState,
      foundryStatePath,
      stateProblem,
      gitDir,
      head: entry.head || null,
      issue: marker.issue ?? taskSpec?.issue ?? null,
      marker,
      markerPath,
      parentCwd: marker.parentCwd || resolvedRoot,
      path: worktreePath,
      slug: marker.slug || path.basename(worktreePath),
      taskSpec,
      taskSpecPath,
      verifyCommand: taskSpec?.verify_command || "./scripts/check.sh",
      worktreePath,
    });
  }

  return smeltable;
}

function splitVerifyCommand(verifyCommand) {
  if (Array.isArray(verifyCommand) && verifyCommand.length > 0) {
    return verifyCommand.map(String);
  }
  const text =
    typeof verifyCommand === "string" && verifyCommand.trim()
      ? verifyCommand.trim()
      : "./scripts/check.sh";
  if (/[|&;<>()$`]/u.test(text)) {
    return ["sh", "-c", text];
  }
  return text.split(/\s+/u);
}

/**
 * Runs the 4-stage Orc Smelter pipeline on a worktree:
 * 1. Stage 1 (Rebase & Scope Audit)
 * 2. Stage 2 (Heavy Gate)
 * 3. Stage 3 (Cross-Vendor Cold Review)
 * 4. Stage 4 (Smelt & Prune)
 */
class SmelterLeaseError extends Error {
  constructor(status, worktreePath) {
    super(`Smelter ${status}: ${worktreePath}`);
    this.status = status;
  }
}

function withVerificationClaims(result) {
  if (!result.evidence) return result;
  const { evidence } = result;
  return {
    ...result,
    acceptanceChecksDefined: evidence.acceptanceChecksDefined,
    verificationSummary: evidence.acceptanceChecksDefined
      ? "Acceptance checks recorded separately"
      : "No acceptance checks were defined",
    reviewStatus: evidence.review.result,
  };
}

export async function smeltWorktree(worktree, options = {}) {
  const worktreePath = path.resolve(
    typeof worktree === "string"
      ? worktree
      : worktree.worktreePath || worktree.path || process.cwd(),
  );
  const acquireLease = options.acquireWorkspaceLeaseFn || acquireWorkspaceLease;
  let lease = options.workspaceLease || (await acquireLease(worktreePath, { env: options.env }));
  let isReadOnly = false;
  let candidate = null;
  let evidence = null;
  let targetLease;
  const targetBranch = options.targetBranch || options.target || "main";
  const execGit = options.execFileSync || options.execFileSyncFn || execFileSync;
  const stopped = (status) => new SmelterLeaseError(status, worktreePath);
  const checkState = () => {
    assertWorkspaceLease(lease);
    const loaded = loadFoundryState(worktreePath);
    const meta = loadWorktreeMetadata(
      worktreePath,
      typeof worktree === "object" ? worktree.markerPath : null,
    );
    const effectiveMarker = meta.marker;
    if (loaded.kind === "missing") {
      if (effectiveMarker || (typeof worktree === "object" && worktree.marker)) {
        throw stopped("unmanaged");
      }
      return;
    }
    if (loaded.kind !== "ok") throw stopped("state_unreadable");
    const roomCheck = verifyRoomIntegrationRecord(effectiveMarker, loaded.state, {
      ...options,
      worktreePath,
    });
    if (!roomCheck.ok) {
      if (roomCheck.reason === "room_worktree_mismatch") throw stopped("room_worktree_mismatch");
      if (roomCheck.reason === "room_branch_mismatch") throw stopped("room_branch_mismatch");
      if (roomCheck.reason === "room_target_branch_mismatch")
        throw stopped("target_branch_mismatch");
      throw stopped("room_integration_unverified");
    }
    if (roomCheck.isRoomIntegrated) {
      const recordedTarget = roomCheck.integration?.targetBranch || loaded.state?.targetBranch;
      if (recordedTarget && recordedTarget !== targetBranch) {
        throw stopped("target_branch_mismatch");
      }
    }
    if (["launching", "running", "launch_uncertain"].includes(loaded.state.status))
      throw stopped(loaded.state.status);
  };
  const checkStable = () => {
    checkState();
    const head = resolveGitSha(worktreePath, "HEAD", execGit);
    if (!candidate || head !== candidate.commit) throw stopped("stale_candidate");
    const dirty = String(
      execGit("git", ["status", "--porcelain"], { cwd: worktreePath, encoding: "utf8" }) ?? "",
    ).trim();
    if (dirty) throw stopped("check_mutated_workspace");
    if (resolveGitSha(worktreePath, evidence.target.ref, execGit) !== evidence.target.sha)
      throw stopped("stale_target");
  };
  const changeMode = async (nextReadOnly) => {
    assertWorkspaceLease(lease);
    if (isReadOnly === nextReadOnly) return;
    await lease.release();
    lease = await acquireLease(worktreePath, { env: options.env, readOnly: nextReadOnly });
    if (!lease.acquired) throw stopped("busy");
    isReadOnly = nextReadOnly;
    checkStable();
  };
  const ownership = {
    assertHeld() {
      assertWorkspaceLease(lease);
      if (targetLease) assertWorkspaceLease(targetLease);
    },
    pin(record) {
      evidence = record;
      candidate = record.candidate;
    },
    async review() {
      await changeMode(true);
    },
    async mutate() {
      await changeMode(false);
    },
    checkStable,
    async target(repoRoot) {
      assertWorkspaceLease(lease);
      if (alignCanonicalPath(repoRoot) === alignCanonicalPath(worktreePath)) return;
      targetLease = await acquireLease(repoRoot, { env: options.env });
      if (!targetLease.acquired) throw stopped("target_busy");
    },
  };
  try {
    if (!lease.acquired) throw stopped("busy");
    checkState();
    return withVerificationClaims(await smeltLeasedWorktree(worktree, options, ownership));
  } catch (error) {
    if (!(error instanceof SmelterLeaseError)) throw error;
    return withVerificationClaims({
      ok: false,
      status: error.status,
      reason: error.message,
      evidence: evidence ? { ...evidence, outcome: error.status } : null,
      candidate,
      ...(error.cause && { stateErrors: [error.cause.message] }),
      worktreePath,
      ...(error.status === "state_unreadable" && { stateProblem: loadFoundryState(worktreePath) }),
    });
  } finally {
    await targetLease?.release();
    await lease.release();
  }
}

function deleteTempRebaseRef(refName, runCmd) {
  if (typeof refName !== "string" || !refName.startsWith("refs/orkest/rebase-tmp/")) {
    return;
  }
  try {
    runCmd("git", ["update-ref", "-d", refName]);
  } catch {
    /* Best-effort cleanup of temporary rebase ref. */
  }
}

function isRebasedHeadConsistentWithPending(
  worktreePath,
  headSha,
  branch,
  targetBranch,
  acceptedCommit,
  foundryState,
  pendingRebase,
  execFileSyncFn,
) {
  if (
    !pendingRebase ||
    typeof pendingRebase !== "object" ||
    pendingRebase.acceptedCommit !== acceptedCommit ||
    pendingRebase.rebaseBranch !== branch ||
    pendingRebase.targetBranch !== targetBranch
  ) {
    return false;
  }
  const hasValidFrom =
    pendingRebase.fromCommit === acceptedCommit ||
    (foundryState?.acceptedCommit === acceptedCommit &&
      Boolean(foundryState?.rebasedCommit) &&
      pendingRebase.fromCommit === foundryState.rebasedCommit);
  if (
    !hasValidFrom ||
    typeof pendingRebase.targetOid !== "string" ||
    !pendingRebase.targetOid ||
    typeof pendingRebase.rebasedOid !== "string" ||
    !pendingRebase.rebasedOid ||
    headSha !== pendingRebase.rebasedOid
  ) {
    return false;
  }
  if (typeof pendingRebase.rebasedTree === "string" && pendingRebase.rebasedTree) {
    const headTree = resolveGitSha(worktreePath, `${headSha}^\u{7B}tree}`, execFileSyncFn);
    if (headTree !== pendingRebase.rebasedTree) return false;
  }
  try {
    execFileSyncFn("git", ["merge-base", "--is-ancestor", pendingRebase.targetOid, headSha], {
      cwd: worktreePath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

async function smeltLeasedWorktree(worktree, options, ownership) {
  const worktreeObj =
    typeof worktree === "string"
      ? { path: path.resolve(worktree), worktreePath: path.resolve(worktree) }
      : { ...worktree };
  const worktreePath = path.resolve(worktreeObj.worktreePath || worktreeObj.path || process.cwd());
  const loadedMeta = loadWorktreeMetadata(worktreePath, worktreeObj.markerPath);
  if (loadedMeta.stateProblem || worktreeObj.stateProblem) {
    return {
      ok: false,
      status: "state_unreadable",
      stateProblem: loadedMeta.stateProblem || worktreeObj.stateProblem,
      worktreePath,
    };
  }
  const loadedMarker = loadedMeta.marker;
  const roomCheck = verifyRoomIntegrationRecord(loadedMarker, loadedMeta.foundryState, {
    ...options,
    worktreePath,
  });
  if (!roomCheck.ok) {
    let mappedStatus = "room_integration_unverified";
    if (
      roomCheck.reason === "room_worktree_mismatch" ||
      roomCheck.reason === "room_branch_mismatch"
    ) {
      mappedStatus = roomCheck.reason;
    } else if (roomCheck.reason === "room_target_branch_mismatch") {
      mappedStatus = "target_branch_mismatch";
    }
    return {
      ok: false,
      status: mappedStatus,
      reason: roomCheck.reason,
      worktreePath,
    };
  }
  const hasMarker = Boolean(loadedMarker || (!roomCheck.isRoomIntegrated && worktreeObj.marker));
  const marker = loadedMarker ?? (roomCheck.isRoomIntegrated ? null : worktreeObj.marker) ?? {};
  const taskSpec = worktreeObj.taskSpec ?? loadedMeta.taskSpec ?? null;

  const targetBranch = options.targetBranch || options.target || "main";
  if (roomCheck.isRoomIntegrated) {
    const recordedTargetBranch =
      roomCheck.integration?.targetBranch || loadedMeta.foundryState?.targetBranch || null;
    if (recordedTargetBranch && recordedTargetBranch !== targetBranch) {
      return {
        ok: false,
        status: "target_branch_mismatch",
        reason: `Worktree was integrated for target branch ${recordedTargetBranch}, not ${targetBranch}`,
        worktreePath,
      };
    }
  }
  const strategy = parseStrategy(options.strategy) ?? "local";
  const isDryRun = Boolean(options.dryRun || options["dry-run"]);
  const shouldSkipReview = Boolean(options.skipReview || options["skip-review"]);
  const suppliedApproval = options.approveHighBlast || options["approve-high-blast"];
  const approvedCommit =
    typeof suppliedApproval === "string" ? suppliedApproval : suppliedApproval?.candidateCommit;
  const execFileSyncFn = options.execFileSync || options.execFileSyncFn || execFileSync;

  const canPersistState =
    !isDryRun &&
    (options.persistState === true ||
      Boolean(
        loadedMeta.markerPath ||
        loadedMeta.foundryState ||
        existsSync(loadedMeta.gitDir) ||
        existsSync(worktreePath),
      ));
  let evidence = null;
  const owningRoomId =
    roomCheck.isRoomIntegrated && roomCheck.ok && typeof marker.roomId === "string"
      ? marker.roomId
      : undefined;
  const recordState = async (patch) => {
    await ownership.mutate();
    ownership.assertHeld();
    if (!canPersistState) return null;
    try {
      return writeFoundryState(
        worktreePath,
        {
          issue: worktreeObj.issue ?? marker.issue ?? taskSpec?.issue ?? null,
          targetBranch,
          ...(evidence && {
            candidate: evidence.candidate,
            evidence: { ...evidence, outcome: patch.status },
          }),
          infrastructureRetry: null,
          findings: null,
          ...patch,
        },
        // A verified PR is attributed to the room whose integration record was verified, never another.
        patch.pr && owningRoomId ? { owningRoomId, env: options.env } : undefined,
      );
    } catch (error_) {
      const error = new SmelterLeaseError("state_write_failed", worktreePath);
      error.cause = error_;
      throw error;
    }
  };

  let isDisposable = hasMarker && marker.disposable !== false;
  if (options.disposable !== undefined) {
    isDisposable = Boolean(options.disposable);
  } else if (worktreeObj.disposable !== undefined) {
    isDisposable = Boolean(worktreeObj.disposable);
  }
  const allowPaths =
    options.allowPaths ?? worktreeObj.allowPaths ?? taskSpec?.allow_paths ?? undefined;
  const explicitCommand =
    options.verifyCommand || taskSpec?.verify_command || (!taskSpec && worktreeObj.verifyCommand);
  const checks =
    Array.isArray(taskSpec?.acceptance_checks) && taskSpec.acceptance_checks.length > 0
      ? taskSpec.acceptance_checks.map((command) => ({ kind: "acceptance", command }))
      : [
          {
            kind: explicitCommand ? "development" : "default-lint",
            command: explicitCommand || "./scripts/check.sh",
          },
        ];
  const verifyCommand = checks.map((check) => check.command).join(" && ");
  const workerEngine =
    options.workerEngine ||
    options.engine ||
    worktreeObj.workerEngine ||
    worktreeObj.engine ||
    marker.engine ||
    taskSpec?.engine ||
    "codex";

  const gateRunner = options.gateRunner || options.runGateFn || null;
  const reviewRunner =
    options.reviewRunner || options.consultRunner || options.runConsultFn || null;

  const commands = [];
  const runCmd = (cmd, args, cwd = worktreePath) => {
    ownership.assertHeld();
    commands.push({ args, cmd, cwd });
    return execFileSyncFn(cmd, args, {
      cwd,
      env: options.env ?? process.env,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
  };

  // Stage 1: Rebase & Scope Audit
  const commonDir = path.resolve(
    worktreePath,
    String(runCmd("git", ["rev-parse", "--git-common-dir"])).trim(),
  );
  const repoRoot = commonDir;
  const target = { ref: `refs/heads/${targetBranch}`, sha: null };
  target.sha = resolveGitSha(worktreePath, target.ref, execFileSyncFn);
  if (!target.sha) return { ok: false, status: "target_missing", target, worktreePath };
  if (
    typeof loadedMeta.foundryState?.targetBranch === "string" &&
    loadedMeta.foundryState.targetBranch &&
    loadedMeta.foundryState.targetBranch !== targetBranch
  ) {
    return {
      ok: false,
      status: "target_branch_mismatch",
      reason: `Worktree target branch ${loadedMeta.foundryState.targetBranch} does not match requested ${targetBranch}`,
      worktreePath,
    };
  }
  if (!isDryRun && loadedMeta.foundryState?.pendingRebase) {
    try {
      const hasInProgressRebase = ["rebase-merge", "rebase-apply", "REBASE_HEAD"].some((item) => {
        const p = String(
          execFileSyncFn("git", ["rev-parse", "--git-path", item], {
            cwd: worktreePath,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          }) ?? "",
        ).trim();
        return Boolean(p) && existsSync(path.resolve(worktreePath, p));
      });
      if (hasInProgressRebase) {
        runCmd("git", ["rebase", "--abort"]);
      }
    } catch {
      /* Best-effort cleanup of interrupted rebase state before status check. */
    }
  }
  const porcelainStatus = String(
    runCmd("git", ["status", "--porcelain"], worktreePath) ?? "",
  ).trim();
  if (porcelainStatus.length > 0) {
    throw new Error(`Worktree ${worktreePath} has uncommitted changes:\n${porcelainStatus}`);
  }

  let expectedRoomBranch = null;
  let preRebaseBranch = null;
  let preRebaseHead = null;
  let shouldSkipRoomRebase = false;
  if (roomCheck.isRoomIntegrated) {
    const memberWorktree = roomCheck.member?.worktree;
    if (!memberWorktree?.path) {
      return {
        ok: false,
        status: "room_worktree_mismatch",
        reason: "Room member has no recorded worktree path",
        worktreePath,
      };
    }
    if (realpathSync(path.resolve(memberWorktree.path)) !== realpathSync(worktreePath)) {
      return {
        ok: false,
        status: "room_worktree_mismatch",
        reason: `Worktree path ${worktreePath} does not match durable member.worktree.path ${memberWorktree.path}`,
        worktreePath,
      };
    }
    try {
      const topLevel = String(runCmd("git", ["rev-parse", "--show-toplevel"])).trim();
      if (topLevel && realpathSync(path.resolve(topLevel)) !== realpathSync(worktreePath)) {
        return {
          ok: false,
          status: "room_worktree_mismatch",
          reason: `Worktree root ${topLevel} does not match leased checkout ${worktreePath}`,
          worktreePath,
        };
      }
    } catch {
      // Mocked execFileSyncFn in unit tests may return empty string for rev-parse.
    }
    expectedRoomBranch =
      memberWorktree.branch || loadedMarker.branch || loadedMeta.foundryState?.branch || null;
    try {
      preRebaseBranch = String(runCmd("git", ["symbolic-ref", "--short", "-q", "HEAD"])).trim();
    } catch {
      preRebaseBranch = "";
    }
    const acceptedCommit = roomCheck.integration.commit;
    if (!isDryRun && !preRebaseBranch && loadedMeta.foundryState?.pendingRebase) {
      const pending = loadedMeta.foundryState.pendingRebase;
      const isValidPendingBranch =
        typeof pending?.rebaseBranch === "string" &&
        Boolean(pending.rebaseBranch) &&
        (!expectedRoomBranch || pending.rebaseBranch === expectedRoomBranch) &&
        (!memberWorktree.branch || pending.rebaseBranch === memberWorktree.branch);
      const isValidPendingFrom =
        pending?.fromCommit === acceptedCommit ||
        (loadedMeta.foundryState?.acceptedCommit === acceptedCommit &&
          Boolean(loadedMeta.foundryState?.rebasedCommit) &&
          pending?.fromCommit === loadedMeta.foundryState.rebasedCommit);
      if (
        isValidPendingBranch &&
        isValidPendingFrom &&
        pending.acceptedCommit === acceptedCommit &&
        pending.targetBranch === targetBranch
      ) {
        const branchSha = resolveGitSha(
          worktreePath,
          `refs/heads/${pending.rebaseBranch}`,
          execFileSyncFn,
        );
        const hasRebasedBranch =
          typeof pending.rebasedOid === "string" &&
          Boolean(pending.rebasedOid) &&
          branchSha === pending.rebasedOid;
        const hasFromBranch = branchSha === pending.fromCommit;
        if (hasRebasedBranch || hasFromBranch) {
          runCmd("git", ["checkout", pending.rebaseBranch]);
          if (hasFromBranch) {
            deleteTempRebaseRef(pending.tempRef, runCmd);
            await recordState({
              acceptedCommit,
              pendingRebase: null,
              status: loadedMeta.foundryState?.status || "verified",
            });
          }
          try {
            preRebaseBranch = String(
              runCmd("git", ["symbolic-ref", "--short", "-q", "HEAD"]),
            ).trim();
          } catch {
            preRebaseBranch = "";
          }
        }
      }
    }
    if (
      !preRebaseBranch ||
      (expectedRoomBranch && preRebaseBranch !== expectedRoomBranch) ||
      (memberWorktree.branch && preRebaseBranch !== memberWorktree.branch)
    ) {
      return {
        ok: false,
        status: "room_branch_mismatch",
        reason: `Worktree branch ${preRebaseBranch || "(detached)"} does not match accepted room branch ${expectedRoomBranch}`,
        worktreePath,
      };
    }
    preRebaseHead = String(runCmd("git", ["rev-parse", "HEAD"])).trim();
    const isAcceptedMatch = preRebaseHead === acceptedCommit;
    const isRecordedRebaseMatch =
      loadedMeta.foundryState?.acceptedCommit === acceptedCommit &&
      Boolean(loadedMeta.foundryState?.rebasedCommit) &&
      preRebaseHead === loadedMeta.foundryState.rebasedCommit;
    if (isAcceptedMatch || isRecordedRebaseMatch) {
      if (isRecordedRebaseMatch && loadedMeta.foundryState?.rebasedOnto === target.sha) {
        shouldSkipRoomRebase = true;
      }
      if (!isDryRun && loadedMeta.foundryState?.pendingRebase) {
        deleteTempRebaseRef(loadedMeta.foundryState.pendingRebase.tempRef, runCmd);
        await recordState({
          acceptedCommit,
          pendingRebase: null,
          status: loadedMeta.foundryState?.status || "verified",
        });
      }
    } else {
      const pendingRebase = loadedMeta.foundryState?.pendingRebase || null;
      const isPendingReconciled = isRebasedHeadConsistentWithPending(
        worktreePath,
        preRebaseHead,
        preRebaseBranch,
        targetBranch,
        acceptedCommit,
        loadedMeta.foundryState,
        pendingRebase,
        execFileSyncFn,
      );
      if (!isPendingReconciled) {
        return {
          ok: false,
          status: "room_commit_mismatch",
          reason: `Worktree HEAD ${preRebaseHead} does not match durable room accepted commit ${acceptedCommit}`,
          worktreePath,
        };
      }
      if (pendingRebase.targetOid === target.sha) {
        shouldSkipRoomRebase = true;
      }
      if (!isDryRun) {
        await recordState({
          acceptedCommit,
          rebasedCommit: preRebaseHead,
          rebasedOnto: pendingRebase.targetOid,
          pendingRebase: null,
          status: loadedMeta.foundryState?.status || "verified",
        });
        deleteTempRebaseRef(pendingRebase.tempRef, runCmd);
      }
    }
  }

  if (!isDryRun) {
    if (roomCheck.isRoomIntegrated) {
      if (!shouldSkipRoomRebase) {
        const txId = randomUUID();
        const tempRef = `refs/orkest/rebase-tmp/${txId}`;
        const basePending = {
          acceptedCommit: roomCheck.integration.commit,
          fromCommit: preRebaseHead,
          rebaseBranch: preRebaseBranch,
          targetBranch,
          targetOid: target.sha,
          tempRef,
          rebasedOid: null,
          startedAt: new Date().toISOString(),
        };
        await recordState({
          acceptedCommit: roomCheck.integration.commit,
          pendingRebase: basePending,
          status: loadedMeta.foundryState?.status || "verified",
        });
        let rebasedOid;
        let rebasedTree;
        try {
          runCmd("git", ["checkout", "--detach", preRebaseHead]);
          runCmd("git", ["rebase", target.sha]);
          rebasedOid = String(runCmd("git", ["rev-parse", "HEAD"])).trim();
          rebasedTree = String(runCmd("git", ["rev-parse", "HEAD^{tree}"])).trim();
          runCmd("git", ["update-ref", tempRef, rebasedOid]);
        } catch (error) {
          try {
            runCmd("git", ["rebase", "--abort"]);
          } catch {
            /* A rebase that never started has nothing to abort. */
          }
          try {
            runCmd("git", ["checkout", preRebaseBranch]);
          } catch {
            /* Best-effort return to preRebaseBranch. */
          }
          deleteTempRebaseRef(tempRef, runCmd);
          await recordState({
            pendingRebase: null,
            rebase: {
              conflictOn: {
                targetHeadSha: target.sha,
                worktreeHeadSha: resolveGitSha(worktreePath, "HEAD", execFileSyncFn),
              },
            },
            status: "rebase_conflict",
          });
          throw error;
        }
        await recordState({
          acceptedCommit: roomCheck.integration.commit,
          pendingRebase: {
            ...basePending,
            rebasedOid,
            rebasedTree,
          },
          status: loadedMeta.foundryState?.status || "verified",
        });
        runCmd("git", ["update-ref", `refs/heads/${preRebaseBranch}`, rebasedOid, preRebaseHead]);
        runCmd("git", ["checkout", preRebaseBranch]);
        await recordState({
          acceptedCommit: roomCheck.integration.commit,
          rebasedCommit: rebasedOid,
          rebasedOnto: target.sha,
          pendingRebase: null,
          status: loadedMeta.foundryState?.status || "verified",
        });
        deleteTempRebaseRef(tempRef, runCmd);
      }
    } else {
      try {
        runCmd("git", ["rebase", target.sha]);
      } catch (error) {
        try {
          runCmd("git", ["rebase", "--abort"]);
        } catch {
          /* A rebase that never started has nothing to abort. */
        }
        await recordState({
          pendingRebase: null,
          rebase: {
            conflictOn: {
              targetHeadSha: target.sha,
              worktreeHeadSha: resolveGitSha(worktreePath, "HEAD", execFileSyncFn),
            },
          },
          status: "rebase_conflict",
        });
        throw error;
      }
    }
  }
  const candidate = {
    commit: String(runCmd("git", ["rev-parse", "HEAD"])).trim(),
    tree: String(runCmd("git", ["rev-parse", "HEAD^{tree}"])).trim(),
    branch: String(runCmd("git", ["symbolic-ref", "--short", "HEAD"])).trim(),
  };
  if (roomCheck.isRoomIntegrated && expectedRoomBranch && candidate.branch !== expectedRoomBranch) {
    return {
      ok: false,
      status: "room_branch_mismatch",
      reason: `Worktree branch ${candidate.branch} does not match accepted room branch ${expectedRoomBranch}`,
      worktreePath,
    };
  }
  const branch = candidate.branch;
  const changedPaths = String(
    runCmd("git", ["diff", "--name-only", "--no-renames", "-z", target.sha, candidate.commit]),
  )
    .split("\0")
    .filter(Boolean);
  const violations = changedPaths.filter((filePath) => !isPathAllowed(filePath, allowPaths));
  const blastRadius = classifyBlastRadius(changedPaths);
  const specPath = worktreeObj.taskSpecPath || loadedMeta.taskSpecPath;
  const digest = (value) =>
    createHash("sha256")
      .update(
        typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value ?? null),
      )
      .digest("hex");
  let scopeResult = allowPaths?.length > 0 ? "passed" : "unchecked";
  if (violations.length > 0) scopeResult = "violated";
  evidence = {
    schema: "ork.smelter.evidence.v1",
    candidate,
    target,
    mergeBase: String(runCmd("git", ["merge-base", target.sha, candidate.commit])).trim(),
    spec: specPath ? { path: specPath, sha256: digest(readFileSync(specPath)) } : null,
    scope: { allowPaths: allowPaths ?? [], changedPaths, result: scopeResult },
    blastRadius,
    checks: [],
    review: { engine: null, result: "not_reviewed", outputSha256: null },
    acceptanceChecksDefined: checks.some((check) => check.kind === "acceptance"),
    waivers: [],
    rejectedAuthorizations: [],
    approval:
      approvedCommit === candidate.commit &&
      (typeof suppliedApproval === "string" || suppliedApproval?.policy === "high-blast")
        ? {
            kind: "high-blast",
            policy: "high-blast",
            candidateCommit: candidate.commit,
            approvedBy: suppliedApproval?.approvedBy || options.approvedBy || "cli",
            at: new Date().toISOString(),
          }
        : null,
    outcome: null,
  };
  if (suppliedApproval && !evidence.approval)
    evidence.rejectedAuthorizations.push({
      policy: "high-blast",
      candidateCommit: approvedCommit ?? null,
      reason: "Approval ignored: candidate or policy does not match",
    });
  const suppliedWaiver = options.skipReviewWaiver;
  if (!isDryRun && (shouldSkipReview || suppliedWaiver)) {
    const waiver = suppliedWaiver || {
      candidateCommit: candidate.commit,
      policy: "skip-review",
      suppliedBy: options.approvedBy || "cli --skip-review",
      at: new Date().toISOString(),
    };
    if (
      waiver.candidateCommit === candidate.commit &&
      waiver.policy === "skip-review" &&
      waiver.suppliedBy
    )
      evidence.waivers.push({ ...waiver, at: waiver.at || new Date().toISOString() });
    else
      evidence.rejectedAuthorizations.push({
        policy: "skip-review",
        candidateCommit: waiver.candidateCommit ?? null,
        reason: "Waiver ignored: candidate, policy or supplier does not match",
      });
  }
  const infrastructureFailure = async (status, detail) => {
    const previous = loadedMeta.foundryState?.infrastructureRetry;
    const count = previous?.candidateCommit === candidate.commit ? previous.count + 1 : 1;
    const infrastructureRetry = {
      candidateCommit: candidate.commit,
      count,
      maxRetries: SMELTER_INFRASTRUCTURE_RETRIES,
    };
    await recordState({ status, infrastructureRetry, infrastructureError: detail, findings: null });
    return {
      ok: false,
      status,
      retryable: true,
      infrastructureRetry,
      error: detail,
      candidate,
      evidence: { ...evidence, outcome: status },
      worktreePath,
    };
  };
  ownership.pin(evidence);
  if (violations.length > 0) {
    await recordState({ scopeViolations: violations, status: "scope_violated" });
    return {
      ok: false,
      status: "scope_violated",
      evidence: { ...evidence, outcome: "scope_violated" },
      candidate,
      worktreePath,
    };
  }
  const stage1 = {
    allowPaths: allowPaths ?? [],
    blastRadius,
    changedPaths,
    clean: true,
    rebased: !isDryRun,
    status: isDryRun ? "dry-run" : "passed",
    targetBranch,
  };

  await ownership.review();

  // Stage 2: each required check has its own result, including checks not reached.
  evidence.checks = checks.map((check) => ({
    ...check,
    exitCode: null,
    result: "not_run",
    startedAt: null,
    endedAt: null,
    outputSha256: null,
  }));
  const stage2 = {
    checks: evidence.checks,
    skipped: isDryRun,
    status: isDryRun ? "not_run" : "passed",
    verifyCommand,
  };
  for (const check of evidence.checks) {
    if (isDryRun) continue;
    const verifyArgs = splitVerifyCommand(check.command);
    const label = `smelter-${randomUUID()}`;
    const gateArgs = ["gate", "--heavy", "--label", label, "--", ...verifyArgs];
    check.startedAt = new Date().toISOString();
    try {
      const output = gateRunner
        ? await gateRunner({
            args: gateArgs,
            command: ["ork", ...gateArgs],
            verifyArgs,
            verifyCommand: check.command,
            kind: check.kind,
            worktreePath,
          })
        : runCmd("ork", gateArgs, worktreePath);
      if (
        output &&
        typeof output === "object" &&
        (output.ok === false || output.exitCode > 0 || output.result === "infrastructure_failure")
      ) {
        const error = new Error(output.error || output.output || "Gate failed");
        error.status = output.exitCode;
        error.infrastructureFailure = output.result === "infrastructure_failure";
        throw error;
      }
      Object.assign(check, { exitCode: 0, result: "passed", outputSha256: digest(output ?? null) });
    } catch (error) {
      // The wrapper's exit status alone does not prove the workload started. Its
      // receipt distinguishes a real failed check (including exit 2) from admission/launch failure.
      const receipt = gateRunner
        ? null
        : gateReceipt(label, worktreePath, options.env ?? process.env);
      const didRun = gateRunner
        ? Number.isSafeInteger(error.status) && !error.infrastructureFailure
        : receipt && ["failed", "signaled"].includes(receipt.outcome);
      Object.assign(check, {
        exitCode: didRun ? (receipt?.exitCode ?? error.status) : null,
        result: didRun ? "failed" : "infrastructure_failure",
        endedAt: new Date().toISOString(),
        outputSha256: digest(error.stdout ?? error.message),
      });
      ownership.checkStable();
      if (!didRun) return infrastructureFailure("gate_infrastructure_failure", error.message);
      await recordState({ gateError: error.message, status: "gate_failed" });
      return {
        ok: false,
        status: "gate_failed",
        error: error.message,
        candidate,
        evidence: { ...evidence, outcome: "gate_failed" },
        worktreePath,
      };
    }
    check.endedAt = new Date().toISOString();
    ownership.checkStable();
  }
  ownership.checkStable();

  // Stage 3: Cross-Vendor Cold Review
  const reviewerEngine = selectColdReviewerEngine(workerEngine, {
    cwd: repoRoot,
    env: options.env,
  });
  evidence.review.engine = reviewerEngine;
  const consultArgs = [
    "consult",
    "--intent",
    "review",
    "--engine",
    reviewerEngine,
    "--transport",
    "executor",
    "--format",
    "json",
    "--read",
    worktreePath,
    "--diff",
    target.sha,
    "--question",
    buildColdReviewQuestion(evidence),
  ];
  let stage3;
  if (isDryRun || evidence.waivers.length > 0) {
    stage3 = {
      args: consultArgs,
      findings: null,
      reviewerEngine,
      skipped: true,
      status: "not_reviewed",
      workerEngine,
    };
  } else {
    const runAgentScript = path.join(scriptsDir, "run_agent.py");
    let reviewOutput;
    try {
      reviewOutput = reviewRunner
        ? await reviewRunner({
            args: consultArgs,
            reviewerEngine,
            targetBranch,
            workerEngine,
            worktreePath,
          })
        : runCmd("python3", [runAgentScript, ...consultArgs], worktreePath);
    } catch (error) {
      reviewOutput = { status: "failed", error: error.message, sections: null };
    }
    const parsedReview = parseColdReviewFindings(reviewOutput);
    evidence.review = {
      engine: reviewerEngine,
      result: parsedReview.result,
      outputSha256: digest(reviewOutput),
    };
    ownership.checkStable();
    if (parsedReview.result === "infrastructure_failure")
      return infrastructureFailure("review_infrastructure_failure", parsedReview.reason);
    if (parsedReview.result === "findings") {
      stage3 = {
        args: consultArgs,
        findings: parsedReview.findings,
        output: reviewOutput ?? null,
        reviewerEngine,
        skipped: false,
        status: "changes_requested",
        workerEngine,
      };
      await recordState({
        findings: parsedReview.findings,
        reviewerEngine,
        status: "review_changes_requested",
      });
      return {
        evidence: { ...evidence, outcome: "review_changes_requested" },
        candidate,
        allowPaths: allowPaths ?? [],
        blastRadius,
        branch,
        changedPaths,
        commands,
        disposable: isDisposable,
        dryRun: isDryRun,
        findings: parsedReview.findings,
        ok: false,
        pruned: false,
        reviewerEngine,
        schema: "ork.smelter.run.v1",
        skipReview: shouldSkipReview,
        stages: {
          coldReview: stage3,
          heavyGate: stage2,
          rebaseAndScope: stage1,
          smeltAndPrune: {
            branch,
            disposable: isDisposable,
            operations: [],
            pruned: false,
            skipped: true,
            status: "skipped",
            strategy,
            targetBranch,
          },
        },
        status: "review_changes_requested",
        strategy,
        targetBranch,
        verifyCommand,
        workerEngine,
        worktreePath,
        worktreeSlug: worktreeObj.slug || path.basename(worktreePath),
      };
    }
    stage3 = {
      args: consultArgs,
      findings: parsedReview.findings,
      output: reviewOutput ?? null,
      reviewerEngine,
      skipped: false,
      status: "passed",
      workerEngine,
    };
  }

  ownership.checkStable();
  await ownership.mutate();

  if (!isDryRun && blastRadius === "high" && strategy === "local" && !evidence.approval) {
    await recordState({
      blastRadius,
      status: "awaiting_human_approval",
    });
    return {
      allowPaths: allowPaths ?? [],
      evidence: { ...evidence, outcome: "awaiting_human_approval" },
      candidate,
      awaitingApproval: true,
      blastRadius,
      branch,
      changedPaths,
      commands,
      disposable: isDisposable,
      dryRun: isDryRun,
      ok: false,
      pruned: false,
      reviewerEngine,
      schema: "ork.smelter.run.v1",
      skipReview: shouldSkipReview,
      stages: {
        coldReview: stage3,
        heavyGate: stage2,
        rebaseAndScope: stage1,
        smeltAndPrune: {
          branch,
          disposable: isDisposable,
          operations: [],
          pruned: false,
          skipped: true,
          status: "awaiting_human_approval",
          strategy,
          targetBranch,
        },
      },
      status: "awaiting_human_approval",
      strategy,
      targetBranch,
      verifyCommand,
      workerEngine,
      worktreePath,
      worktreeSlug: worktreeObj.slug || path.basename(worktreePath),
    };
  }

  // Stage 4: Smelt & Prune
  let stage4;
  if (strategy === "local") {
    let isPruned = false;
    let quarantine = null;
    const entries = parsePorcelainWorktrees(
      String(runCmd("git", ["worktree", "list", "--porcelain"])),
    );
    const checkout = entries.find((entry) => entry.branch === targetBranch);
    const plannedOps = [
      checkout
        ? ["git", "merge", "--ff-only", candidate.commit]
        : ["git", "update-ref", target.ref, candidate.commit, target.sha],
    ];
    if (!isDryRun) {
      if (checkout) {
        await ownership.target(checkout.worktree);
        let attached = "";
        try {
          attached = String(
            runCmd("git", ["symbolic-ref", "-q", "HEAD"], checkout.worktree),
          ).trim();
        } catch {
          /* Detached target is refused below. */
        }
        if (attached !== target.ref)
          return {
            ok: false,
            status: "target_detached",
            candidate,
            evidence: { ...evidence, outcome: "target_detached" },
            worktreePath,
          };
        if (resolveGitSha(checkout.worktree, "HEAD", execFileSyncFn) !== target.sha)
          return {
            ok: false,
            status: "stale_target",
            candidate,
            evidence: { ...evidence, outcome: "stale_target" },
            worktreePath,
          };
        ownership.checkStable();
        try {
          runCmd("git", ["merge", "--ff-only", candidate.commit], checkout.worktree);
        } catch (error) {
          return {
            ok: false,
            status: "merge_failed",
            error: error.message,
            candidate,
            evidence: { ...evidence, outcome: "merge_failed" },
            worktreePath,
          };
        }
      } else {
        ownership.checkStable();
        try {
          runCmd("git", ["update-ref", target.ref, candidate.commit, target.sha], repoRoot);
        } catch (error) {
          const status =
            resolveGitSha(worktreePath, target.ref, execFileSyncFn) === target.sha
              ? "merge_failed"
              : "stale_target";
          return {
            ok: false,
            status,
            error: error.message,
            candidate,
            evidence: { ...evidence, outcome: status },
            worktreePath,
          };
        }
      }
      if (resolveGitSha(worktreePath, target.ref, execFileSyncFn) !== candidate.commit)
        return {
          ok: false,
          status: "merge_unconfirmed",
          candidate,
          evidence: { ...evidence, outcome: "merge_unconfirmed" },
          worktreePath,
        };
      try {
        await recordState({ status: "merged" });
      } catch (error) {
        return {
          ok: false,
          status: "merged_state_unrecorded",
          stateErrors: [error.cause?.message || error.message],
          candidate,
          evidence: { ...evidence, outcome: "merged_state_unrecorded" },
          worktreePath,
        };
      }
      if (
        isDisposable &&
        resolveGitSha(worktreePath, target.ref, execFileSyncFn) === candidate.commit &&
        resolveGitSha(worktreePath, "HEAD", execFileSyncFn) === candidate.commit
      ) {
        // Recoverable: the common helper quarantines a proven-merged, positively owned worktree and
        // otherwise retains it. No worktree removal, branch deletion or force exists on this path.
        const prune = await (options.pruneMergedWorktreeFn ?? pruneMergedWorktree)({
          repoRoot: entries[0]?.worktree ?? repoRoot,
          worktreePath,
          targetBranch,
          env: options.env ?? process.env,
          execFileSyncFn,
          assertHeld: () => ownership.assertHeld(),
          allowRoomId: owningRoomId,
        });
        isPruned = prune.pruned;
        quarantine = prune;
      }
    }
    stage4 = {
      branch,
      disposable: isDisposable,
      operations: plannedOps,
      pruned: isPruned,
      ...(quarantine && { quarantine }),
      status: isDryRun ? "dry-run" : "passed",
      strategy: "local",
      targetBranch,
    };
  } else {
    const pr = await ensurePullRequest({
      runCmd,
      runGit: (cmd, args) => runCmd(cmd, args, worktreePath),
      candidate,
      baseBranch: targetBranch,
      priorState: loadedMeta.foundryState,
      dryRun: isDryRun,
      record: (patch) => recordState(patch),
    });
    if (!isDryRun && !["opened", "existing", "merged"].includes(pr.status)) {
      const failed = pr.status;
      return {
        ok: false,
        status: failed,
        candidate,
        evidence: { ...evidence, outcome: failed },
        strategy,
        stages: {
          coldReview: stage3,
          heavyGate: stage2,
          rebaseAndScope: stage1,
          smeltAndPrune: {
            branch,
            disposable: isDisposable,
            operations: pr.operations,
            pruned: false,
            skipped: true,
            status: failed,
            strategy,
            targetBranch,
          },
        },
        targetBranch,
        ...(pr.code && { reason: pr.code }),
        worktreePath,
      };
    }
    stage4 = {
      branch,
      disposable: isDisposable,
      operations: pr.operations,
      output: pr.output ?? null,
      pr: pr.pr ?? null,
      pruned: false,
      status: isDryRun ? "dry-run" : "passed",
      strategy: "pr",
      targetBranch,
    };
  }

  const finalSmeltStatus =
    strategy === "local" || stage4.pr?.state === "MERGED" ? "merged" : "pr_opened";
  return {
    evidence: { ...evidence, outcome: isDryRun ? "dry-run" : finalSmeltStatus },
    candidate,
    allowPaths: allowPaths ?? [],
    blastRadius,
    branch,
    changedPaths,
    commands,
    disposable: isDisposable,
    dryRun: isDryRun,
    ok: true,
    pruned: Boolean(stage4.pruned),
    reviewerEngine,
    schema: "ork.smelter.run.v1",
    skipReview: shouldSkipReview,
    stages: {
      coldReview: stage3,
      heavyGate: stage2,
      rebaseAndScope: stage1,
      smeltAndPrune: stage4,
    },
    status: isDryRun ? "dry-run" : finalSmeltStatus,
    strategy,
    targetBranch,
    verifyCommand,
    workerEngine,
    worktreePath,
    worktreeSlug: worktreeObj.slug || path.basename(worktreePath),
  };
}

function renderSmelterStatusPanel(statusData, width, options = {}) {
  const tier = options.tier || glyphTier();
  const bodyWidth = Math.max(20, width - 6);
  const summary = `${statusData.worktrees.length} smeltable worktrees ahead of ${statusData.targetBranch}`;
  const lifecycle = (wt) => {
    if (wt.stateProblem) return `state_unreadable (${wt.stateProblem.kind})`;
    return `${wt.foundryState?.status || "unmanaged"}; review=${wt.foundryState?.evidence?.review?.result || "not_reviewed"}`;
  };
  const rows =
    statusData.worktrees.length > 0
      ? statusData.worktrees.map((wt) => [
          wt.slug,
          wt.branch || "--",
          wt.issue ? `#${wt.issue}` : "--",
          `+${wt.commitsAhead}`,
          lifecycle(wt),
        ])
      : [["None", "--", "--", "0", "No disposable worktrees ahead of target"]];
  const table = renderTable(
    ["Worktree", "Branch", "Issue", "Ahead", "Lifecycle"],
    rows,
    bodyWidth,
    {
      tier,
      weights: [0.28, 0.28, 0.12, 0.12, 0.2],
    },
  );
  return renderPanel("Smelter", [summary, ...table], width, {
    color: options.color,
    glyphs: glyphSet(tier),
  })
    .map((line) => line.trimEnd())
    .join("\n");
}

export async function smelterCli(
  argv = [],
  {
    cwd = process.cwd(),
    execFileSyncFn = execFileSync,
    gateRunner = null,
    reviewRunner = null,
    stdout = process.stdout,
  } = {},
) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    args: argv,
    options: {
      "approve-high-blast": { type: "string" },
      "dry-run": { type: "boolean" },
      help: { short: "h", type: "boolean" },
      json: { type: "boolean" },
      "skip-review": { type: "boolean" },
      strategy: { type: "string" },
      target: { type: "string" },
      width: { type: "string" },
      worktree: { type: "string" },
    },
  });

  if (values.help) {
    stdout.write(SMELTER_HELP);
    return;
  }

  const action = positionals[0] || "status";
  if (!["status", "run"].includes(action)) {
    throw new Error(`Unknown smelter subcommand: ${action}`);
  }

  const strategy = parseStrategy(values.strategy) ?? "local";
  const targetBranch = values.target || "main";
  const width = Number(values.width || stdout.columns || 120);
  if (!Number.isSafeInteger(width) || width < 40 || width > 1000) {
    throw new Error("Width must be 40–1000");
  }

  const discovered = discoverSmeltableWorktrees(cwd, {
    execFileSyncFn,
    includeKeep: Boolean(values.worktree),
    targetBranch,
  });

  if (action === "status") {
    const payload = {
      schema: "ork.smelter.status.v1",
      targetBranch,
      worktrees: discovered.map((wt) => ({
        allowPaths: wt.allowPaths,
        branch: wt.branch,
        commitsAhead: wt.commitsAhead,
        disposable: wt.disposable,
        engine: wt.engine,
        foundryState: wt.foundryState ?? null,
        stateProblem: wt.stateProblem ?? null,
        issue: wt.issue,
        path: wt.path,
        slug: wt.slug,
        verifyCommand: wt.verifyCommand,
      })),
    };
    if (values.json) {
      stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      stdout.write(
        `${renderSmelterStatusPanel(payload, width, {
          color: shouldUseColor(stdout),
          tier: glyphTier(),
        })}\n`,
      );
    }
    return payload;
  }

  let selected = discovered;
  if (values.worktree) {
    const requested = values.worktree.trim();
    const resolvedRequested = path.resolve(cwd, requested);
    const canonicalRequested = alignCanonicalPath(resolvedRequested);
    selected = discovered.filter(
      (wt) =>
        wt.slug === requested ||
        wt.path === resolvedRequested ||
        alignCanonicalPath(wt.path) === canonicalRequested ||
        path.basename(wt.path) === requested,
    );
    if (selected.length === 0 && existsSync(resolvedRequested)) {
      selected = [{ path: resolvedRequested, slug: path.basename(resolvedRequested) }];
    }
  }

  if (selected.length === 0) {
    const emptyPayload = {
      dryRun: Boolean(values["dry-run"]),
      results: [],
      schema: "ork.smelter.run.v1",
      targetBranch,
    };
    if (values.json) stdout.write(`${JSON.stringify(emptyPayload, null, 2)}\n`);
    else stdout.write(`ork smelter: no smeltable worktrees ahead of ${targetBranch}\n`);
    return emptyPayload;
  }

  const results = [];
  for (const wt of selected) {
    const res = await smeltWorktree(wt, {
      approveHighBlast: values["approve-high-blast"],
      cwd,
      dryRun: Boolean(values["dry-run"]),
      execFileSyncFn,
      gateRunner,
      reviewRunner,
      skipReview: Boolean(values["skip-review"]),
      strategy,
      targetBranch,
    });
    results.push(res);
  }

  const hasHalted = results.some((r) => r.ok === false);
  const payload =
    results.length === 1
      ? { ...results[0], ok: results[0].ok !== false, results }
      : {
          dryRun: Boolean(values["dry-run"]),
          ok: !hasHalted,
          results,
          schema: "ork.smelter.run.v1",
          targetBranch,
        };

  if (hasHalted) {
    process.exitCode = 1;
  }

  if (values.json) {
    stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    for (const item of results) {
      if (item.ok === false) {
        stdout.write(
          `Halted ${item.taskId || item.worktreeSlug || item.branch} (${item.status})\n`,
        );
      } else {
        stdout.write(
          `${item.dryRun ? "Dry-run smelted" : "Smelted"} ${item.worktreeSlug} (${item.branch} -> ${item.targetBranch}, blast=${item.blastRadius}, review=${item.evidence?.review?.result || "not_reviewed"}, reviewer=${item.reviewerEngine}; ${item.verificationSummary})\n`,
        );
      }
    }
  }
  return payload;
}

export const smelterCommand = smelterCli;
export const runSmeltCli = smelterCli;
