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
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { shouldUseColor } from "../../monitor/lib/render.mjs";
import { loadFoundryState, resolveFoundryStatePath, writeFoundryState } from "./foundry.mjs";
import { resolveWorktreeMarkerPath } from "./horde-room.mjs";
import { glyphSet, glyphTier, renderPanel, renderTable } from "./horde-view.mjs";

const scriptsDir = fileURLToPath(new URL("../skills/orchestrate/scripts/", import.meta.url));

export const COLD_REVIEW_QUESTION =
  "Deterministic linters, formatters, and test suites (ork gate --heavy) have already passed on this diff. Review the changes and report ONLY concrete correctness bugs, security vulnerabilities, concurrency/race conditions, or scope violations under FINDINGS. Do not report stylistic preferences or speculative refactors; write 'none' under FINDINGS if no concrete defects exist.";

export const SMELTER_HELP = `ork smelter status [--json] [--target <branch>] [--width 120]
ork smelter run [--worktree <slug|path>] [--strategy local|pr] [--target <branch>] [--approve-high-blast] [--dry-run] [--skip-review] [--json]
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
  if (reviewOutput == null) {
    return { findings: "Cold review output missing FINDINGS section", passed: false };
  }
  let parsed = null;
  if (typeof reviewOutput === "object") {
    parsed = reviewOutput;
  } else if (typeof reviewOutput === "string") {
    const trimmed = reviewOutput.trim();
    if (!trimmed) {
      return { findings: "Cold review output missing FINDINGS section", passed: false };
    }
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        parsed = null;
      }
    }
  }
  let rawFindings =
    parsed?.sections?.FINDINGS ??
    parsed?.sections?.findings ??
    parsed?.FINDINGS ??
    parsed?.findings ??
    null;
  if (rawFindings === null && typeof reviewOutput === "string") {
    const sectionMatch =
      /(?:^|\r?\n)\s*(?:#+\s*)?FINDINGS\s*:?[ \t]*\r?\n([\s\S]*?)(?=\r?\n\s*(?:#+\s*[A-Z_]+|[A-Z_]{3,}\s*:)|$)/iu.exec(
        reviewOutput,
      );
    if (sectionMatch) {
      rawFindings = sectionMatch[1];
    } else {
      const inlineMatch = /(?:^|\r?\n)\s*(?:#+\s*)?FINDINGS\s*:\s*([^\r\n]+)/iu.exec(reviewOutput);
      if (inlineMatch) rawFindings = inlineMatch[1];
    }
  }
  if (typeof rawFindings === "string") {
    const cleaned = rawFindings
      .trim()
      .replaceAll(/^(?:[-*•]\s*)+/gu, "")
      .trim();
    if (!cleaned) {
      return { findings: "Cold review output missing FINDINGS section", passed: false };
    }
    if (
      /^(?:none|no\s+(?:concrete\s+|actionable\s+)?(?:findings|defects|issues)(?:\s+found)?\.?|n\/a|nil|-)$/iu.test(
        cleaned,
      )
    ) {
      if (parsed && (parsed.passed === false || parsed.ok === false)) {
        return {
          findings: String(parsed.error || parsed.summary || "Review requested changes").trim(),
          passed: false,
        };
      }
      return { findings: "none", passed: true };
    }
    return { findings: rawFindings.trim(), passed: false };
  }
  if (parsed && (parsed.passed === false || parsed.ok === false)) {
    return {
      findings: String(parsed.error || parsed.summary || "Review requested changes").trim(),
      passed: false,
    };
  }
  return { findings: "Cold review output missing FINDINGS section", passed: false };
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

/**
 * Selects a cross-vendor engine for independent cold review, preferring an
 * installed cross-vendor harness and falling back to available harnesses when
 * a machine only has a subset installed.
 */
export function selectColdReviewerEngine(workerEngine, options = {}) {
  const raw = String(workerEngine ?? "")
    .trim()
    .toLowerCase();
  const normalized = raw === "antigravity" ? "agy" : raw;
  const candidates = REVIEWER_PREFERENCE[normalized] || REVIEWER_PREFERENCE.codex;
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
  const candidate = normalizeRelativePath(changedPath);
  if (!candidate || candidate.startsWith("..")) return false;
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
      }) ?? "",
    ).trim();
    return out || null;
  } catch {
    return null;
  }
}

const SKIPPED_SMELTER_STATES = new Set([
  "abandoned",
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
      verifyCommand:
        taskSpec?.verify_command || taskSpec?.development_checks?.[0] || "./scripts/check.sh",
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
export async function smeltWorktree(worktree, options = {}) {
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
  const hasMarker = Boolean(worktreeObj.marker || loadedMeta.marker);
  const marker = worktreeObj.marker ?? loadedMeta.marker ?? {};
  const taskSpec = worktreeObj.taskSpec ?? loadedMeta.taskSpec ?? null;

  const targetBranch = options.targetBranch || options.target || "main";
  const strategy = options.strategy || "local";
  if (!["local", "pr"].includes(strategy)) {
    throw new Error(`Unsupported smelter strategy: ${strategy}`);
  }
  const isDryRun = Boolean(options.dryRun || options["dry-run"]);
  const shouldSkipReview = Boolean(options.skipReview || options["skip-review"]);
  const shouldApproveHighBlast = Boolean(options.approveHighBlast || options["approve-high-blast"]);
  const repoRoot = path.resolve(
    options.repoRoot || options.cwd || worktreeObj.parentCwd || marker.parentCwd || process.cwd(),
  );
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
  const recordState = (patch) => {
    if (!canPersistState) return null;
    try {
      return writeFoundryState(worktreePath, {
        issue: worktreeObj.issue ?? marker.issue ?? taskSpec?.issue ?? null,
        targetBranch,
        ...patch,
      });
    } catch {
      return null;
    }
  };

  let resolvedHeadBranch = null;
  if (
    !options.branch &&
    !worktreeObj.branch &&
    !marker.branch &&
    existsSync(path.join(worktreePath, ".git"))
  ) {
    try {
      const headRef = String(
        execFileSyncFn("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
          cwd: worktreePath,
          encoding: "utf8",
        }) ?? "",
      ).trim();
      if (headRef && headRef !== "HEAD") resolvedHeadBranch = headRef;
    } catch {
      /* Ignore git lookup errors on non-git or mocked paths. */
    }
  }
  const branch =
    options.branch ||
    worktreeObj.branch ||
    marker.branch ||
    resolvedHeadBranch ||
    path.basename(worktreePath);
  let isDisposable = hasMarker && marker.disposable !== false;
  if (options.disposable !== undefined) {
    isDisposable = Boolean(options.disposable);
  } else if (worktreeObj.disposable !== undefined) {
    isDisposable = Boolean(worktreeObj.disposable);
  }
  const allowPaths =
    options.allowPaths ?? worktreeObj.allowPaths ?? taskSpec?.allow_paths ?? undefined;
  const verifyCommand =
    options.verifyCommand ||
    worktreeObj.verifyCommand ||
    taskSpec?.verify_command ||
    taskSpec?.development_checks?.[0] ||
    "./scripts/check.sh";
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
    commands.push({ args, cmd, cwd });
    return execFileSyncFn(cmd, args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  };

  // Stage 1: Rebase & Scope Audit
  const porcelainStatus = String(
    runCmd("git", ["status", "--porcelain"], worktreePath) ?? "",
  ).trim();
  if (porcelainStatus.length > 0) {
    throw new Error(`Worktree ${worktreePath} has uncommitted changes:\n${porcelainStatus}`);
  }

  let changedPaths;
  if (Array.isArray(options.changedPaths)) {
    changedPaths = options.changedPaths.map(normalizeRelativePath).filter(Boolean);
  } else if (Array.isArray(worktreeObj.changedPaths)) {
    changedPaths = worktreeObj.changedPaths.map(normalizeRelativePath).filter(Boolean);
  } else {
    const diffOut = String(
      runCmd(
        "git",
        ["diff", "--name-only", "--no-renames", `${targetBranch}...HEAD`],
        worktreePath,
      ) ?? "",
    );
    changedPaths = diffOut.split(/\r?\n/u).map(normalizeRelativePath).filter(Boolean);
  }

  if (Array.isArray(allowPaths) && allowPaths.length > 0) {
    const violations = changedPaths.filter((filePath) => !isPathAllowed(filePath, allowPaths));
    if (violations.length > 0) {
      recordState({
        scopeViolations: violations,
        status: "scope_violated",
      });
      throw new Error(
        `Scope audit failed: files outside allow_paths (${allowPaths.join(", ")}): ${violations.join(", ")}`,
      );
    }
  }

  const blastRadius = classifyBlastRadius(changedPaths);
  if (!isDryRun) {
    try {
      runCmd("git", ["rebase", targetBranch], worktreePath);
    } catch (error) {
      try {
        execFileSyncFn("git", ["rebase", "--abort"], { cwd: worktreePath, encoding: "utf8" });
      } catch {
        /* Ignore abort error if rebase had not started. */
      }
      const worktreeHeadSha =
        worktreeObj.head || resolveGitSha(worktreePath, "HEAD", execFileSyncFn);
      const targetHeadSha =
        resolveGitSha(worktreePath, targetBranch, execFileSyncFn) ||
        resolveGitSha(repoRoot, targetBranch, execFileSyncFn);
      recordState({
        rebase: {
          conflictOn: {
            targetHeadSha,
            worktreeHeadSha,
          },
        },
        status: "rebase_conflict",
      });
      throw error;
    }
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

  // Stage 2: Heavy Gate
  const verifyArgs = splitVerifyCommand(verifyCommand);
  const gateArgs = ["gate", "--heavy", "--", ...verifyArgs];
  let stage2;
  if (isDryRun) {
    stage2 = {
      command: ["ork", ...gateArgs],
      skipped: true,
      status: "dry-run",
      verifyCommand,
    };
  } else {
    try {
      const gateOutput = gateRunner
        ? await gateRunner({
            args: gateArgs,
            command: ["ork", ...gateArgs],
            verifyArgs,
            verifyCommand,
            worktreePath,
          })
        : runCmd("ork", gateArgs, worktreePath);
      stage2 = {
        command: ["ork", ...gateArgs],
        output: gateOutput ?? null,
        skipped: false,
        status: "passed",
        verifyCommand,
      };
    } catch (error) {
      recordState({
        gateError: error?.message || String(error),
        status: "gate_failed",
      });
      throw error;
    }
  }

  // Stage 3: Cross-Vendor Cold Review
  const reviewerEngine = selectColdReviewerEngine(workerEngine);
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
    targetBranch,
    "--question",
    COLD_REVIEW_QUESTION,
  ];
  let stage3;
  if (isDryRun || shouldSkipReview) {
    stage3 = {
      args: consultArgs,
      findings: "none",
      reviewerEngine,
      skipped: true,
      status: isDryRun ? "dry-run" : "skipped",
      workerEngine,
    };
  } else {
    const runAgentScript = path.join(scriptsDir, "run_agent.py");
    const reviewOutput = reviewRunner
      ? await reviewRunner({
          args: consultArgs,
          reviewerEngine,
          targetBranch,
          workerEngine,
          worktreePath,
        })
      : runCmd("python3", [runAgentScript, ...consultArgs], worktreePath);
    const parsedReview = parseColdReviewFindings(reviewOutput);
    if (!parsedReview.passed) {
      stage3 = {
        args: consultArgs,
        findings: parsedReview.findings,
        output: reviewOutput ?? null,
        reviewerEngine,
        skipped: false,
        status: "changes_requested",
        workerEngine,
      };
      recordState({
        findings: parsedReview.findings,
        reviewerEngine,
        status: "review_changes_requested",
      });
      return {
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

  if (!isDryRun && blastRadius === "high" && strategy === "local" && !shouldApproveHighBlast) {
    recordState({
      blastRadius,
      status: "awaiting_human_approval",
    });
    return {
      allowPaths: allowPaths ?? [],
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
    const plannedOps = [
      ["git", "merge", "--ff-only", branch],
      ...(isDisposable
        ? [
            ["git", "worktree", "remove", worktreePath],
            ["git", "branch", "-d", branch],
          ]
        : []),
    ];
    if (!isDryRun) {
      let currentRepoBranch = "";
      if (existsSync(path.join(repoRoot, ".git"))) {
        try {
          currentRepoBranch = String(
            execFileSyncFn("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
              cwd: repoRoot,
              encoding: "utf8",
            }) ?? "",
          ).trim();
        } catch {
          currentRepoBranch = "";
        }
      }
      if (currentRepoBranch && currentRepoBranch !== "HEAD" && currentRepoBranch !== targetBranch) {
        throw new Error(
          `Cannot fast-forward merge into ${repoRoot}: checked out branch is ${currentRepoBranch}, expected ${targetBranch}`,
        );
      }
      runCmd("git", ["merge", "--ff-only", branch], repoRoot);
      recordState({ status: "merged" });
      if (isDisposable) {
        runCmd("git", ["worktree", "remove", worktreePath], repoRoot);
        runCmd("git", ["branch", "-d", branch], repoRoot);
      }
    }
    stage4 = {
      branch,
      disposable: isDisposable,
      operations: plannedOps,
      pruned: !isDryRun && isDisposable,
      status: isDryRun ? "dry-run" : "passed",
      strategy: "local",
      targetBranch,
    };
  } else {
    const prArgs = ["pr", "create", "--base", targetBranch, "--head", branch, "--fill"];
    const plannedOps = [
      ["git", "push", "-u", "origin", branch],
      ["gh", ...prArgs],
    ];
    let prOutput = null;
    if (!isDryRun) {
      runCmd("git", ["push", "-u", "origin", branch], worktreePath);
      prOutput = runCmd("gh", prArgs, worktreePath);
      recordState({ status: "pr_opened" });
    }
    stage4 = {
      branch,
      disposable: isDisposable,
      operations: plannedOps,
      output: prOutput,
      pruned: false,
      status: isDryRun ? "dry-run" : "passed",
      strategy: "pr",
      targetBranch,
    };
  }

  const finalSmeltStatus = strategy === "local" ? "merged" : "pr_opened";
  return {
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
    return wt.disposable ? "disposable" : "keep";
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
      "approve-high-blast": { type: "boolean" },
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
      approveHighBlast: Boolean(values["approve-high-blast"]),
      cwd,
      dryRun: Boolean(values["dry-run"]),
      execFileSyncFn,
      gateRunner,
      reviewRunner,
      skipReview: Boolean(values["skip-review"]),
      strategy: values.strategy || "local",
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
          `${item.dryRun ? "Dry-run smelted" : "Smelted"} ${item.worktreeSlug} (${item.branch} -> ${item.targetBranch}, blast=${item.blastRadius}, reviewer=${item.reviewerEngine})\n`,
        );
      }
    }
  }
  return payload;
}

export const smelterCommand = smelterCli;
export const runSmeltCli = smelterCli;
