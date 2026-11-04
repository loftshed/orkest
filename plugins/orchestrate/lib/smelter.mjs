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
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { shouldUseColor } from "../../monitor/lib/render.mjs";
import { resolveWorktreeMarkerPath } from "./stooges-room.mjs";
import { glyphSet, glyphTier, renderPanel, renderTable } from "./stooges-view.mjs";

const scriptsDir = fileURLToPath(new URL("../skills/orchestrate/scripts/", import.meta.url));

export const SMELTER_HELP = `ork smelter status [--json] [--target <branch>] [--width 120]
ork smelter run [--worktree <slug|path>] [--strategy local|pr] [--target <branch>] [--dry-run] [--skip-review] [--json]
`;

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
  const normalized = String(workerEngine ?? "")
    .trim()
    .toLowerCase();
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
  return { gitDir, marker, markerPath, taskSpec, taskSpecPath };
}

/**
 * Inspects `git worktree list --porcelain` and each worktree's `<gitdir>/orkest.json`
 * marker + `task-spec.json` to find disposable worktrees with commits ahead of target.
 */
export function discoverSmeltableWorktrees(
  repoRoot = process.cwd(),
  { execFileSyncFn = execFileSync, includeKeep = false, targetBranch = "main" } = {},
) {
  const resolvedRoot = path.resolve(repoRoot);
  const porcelain = String(
    execFileSyncFn("git", ["worktree", "list", "--porcelain"], {
      cwd: resolvedRoot,
      encoding: "utf8",
    }) ?? "",
  );
  const rawEntries = parsePorcelainWorktrees(porcelain);
  const smeltable = [];

  for (const entry of rawEntries) {
    const worktreePath = path.resolve(entry.worktree);
    if (worktreePath === resolvedRoot) continue;
    const { gitDir, marker, markerPath, taskSpec, taskSpecPath } =
      loadWorktreeMetadata(worktreePath);
    if (!marker || typeof marker !== "object") continue;
    if (!includeKeep && marker.disposable === false) continue;

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
    if (commitsAhead <= 0) continue;

    const branch = entry.branch || marker.branch || null;
    smeltable.push({
      allowPaths: taskSpec?.allow_paths ?? [],
      branch,
      commitsAhead,
      disposable: marker.disposable !== false,
      engine: marker.engine || taskSpec?.engine || null,
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
  const marker = worktreeObj.marker ?? loadedMeta.marker ?? {};
  const taskSpec = worktreeObj.taskSpec ?? loadedMeta.taskSpec ?? null;

  const targetBranch = options.targetBranch || options.target || "main";
  const strategy = options.strategy || "local";
  if (!["local", "pr"].includes(strategy)) {
    throw new Error(`Unsupported smelter strategy: ${strategy}`);
  }
  const isDryRun = Boolean(options.dryRun || options["dry-run"]);
  const shouldSkipReview = Boolean(options.skipReview || options["skip-review"]);
  const repoRoot = path.resolve(
    options.repoRoot || options.cwd || worktreeObj.parentCwd || marker.parentCwd || process.cwd(),
  );
  const branch =
    options.branch || worktreeObj.branch || marker.branch || path.basename(worktreePath);
  let isDisposable = marker.disposable !== false;
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

  const execFileSyncFn = options.execFileSync || options.execFileSyncFn || execFileSync;
  const gateRunner = options.gateRunner || options.runGateFn || null;
  const reviewRunner =
    options.reviewRunner || options.consultRunner || options.runConsultFn || null;

  const commands = [];
  const runCmd = (cmd, args, cwd = worktreePath) => {
    commands.push({ args, cmd, cwd });
    return execFileSyncFn(cmd, args, { cwd, encoding: "utf8" });
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
      runCmd("git", ["diff", "--name-only", `${targetBranch}...HEAD`], worktreePath) ?? "",
    );
    changedPaths = diffOut.split(/\r?\n/u).map(normalizeRelativePath).filter(Boolean);
  }

  if (Array.isArray(allowPaths) && allowPaths.length > 0) {
    const violations = changedPaths.filter((filePath) => !isPathAllowed(filePath, allowPaths));
    if (violations.length > 0) {
      throw new Error(
        `Scope audit failed: files outside allow_paths (${allowPaths.join(", ")}): ${violations.join(", ")}`,
      );
    }
  }

  const blastRadius = classifyBlastRadius(changedPaths);
  if (!isDryRun) {
    runCmd("git", ["rebase", targetBranch], worktreePath);
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
  } else if (gateRunner) {
    const gateOutput = await gateRunner({
      args: gateArgs,
      command: ["ork", ...gateArgs],
      verifyArgs,
      verifyCommand,
      worktreePath,
    });
    stage2 = {
      command: ["ork", ...gateArgs],
      output: gateOutput ?? null,
      skipped: false,
      status: "passed",
      verifyCommand,
    };
  } else {
    const gateOutput = runCmd("ork", gateArgs, worktreePath);
    stage2 = {
      command: ["ork", ...gateArgs],
      output: gateOutput ?? null,
      skipped: false,
      status: "passed",
      verifyCommand,
    };
  }

  // Stage 3: Cross-Vendor Cold Review
  const reviewerEngine = selectColdReviewerEngine(workerEngine);
  const consultArgs = [
    "consult",
    "--intent",
    "review",
    "--engine",
    reviewerEngine,
    "--read",
    worktreePath,
    "--diff",
    targetBranch,
  ];
  let stage3;
  if (isDryRun || shouldSkipReview) {
    stage3 = {
      args: consultArgs,
      reviewerEngine,
      skipped: true,
      status: isDryRun ? "dry-run" : "skipped",
      workerEngine,
    };
  } else if (reviewRunner) {
    const reviewOutput = await reviewRunner({
      args: consultArgs,
      reviewerEngine,
      targetBranch,
      workerEngine,
      worktreePath,
    });
    stage3 = {
      args: consultArgs,
      output: reviewOutput ?? null,
      reviewerEngine,
      skipped: false,
      status: "passed",
      workerEngine,
    };
  } else {
    const runAgentScript = path.join(scriptsDir, "run_agent.py");
    const reviewOutput = runCmd("python3", [runAgentScript, ...consultArgs], worktreePath);
    stage3 = {
      args: consultArgs,
      output: reviewOutput ?? null,
      reviewerEngine,
      skipped: false,
      status: "passed",
      workerEngine,
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
      runCmd("git", ["merge", "--ff-only", branch], repoRoot);
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
  const rows =
    statusData.worktrees.length > 0
      ? statusData.worktrees.map((wt) => [
          wt.slug,
          wt.branch || "--",
          wt.issue ? `#${wt.issue}` : "--",
          `+${wt.commitsAhead}`,
          wt.disposable ? "disposable" : "keep",
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
    selected = discovered.filter(
      (wt) =>
        wt.slug === requested ||
        wt.path === resolvedRequested ||
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

  const payload =
    results.length === 1
      ? { ...results[0], results }
      : {
          dryRun: Boolean(values["dry-run"]),
          results,
          schema: "ork.smelter.run.v1",
          targetBranch,
        };

  if (values.json) {
    stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    for (const res of results) {
      stdout.write(
        `${res.dryRun ? "Dry-run smelted" : "Smelted"} ${res.worktreeSlug} (${res.branch} -> ${res.targetBranch}, blast=${res.blastRadius}, reviewer=${res.reviewerEngine})\n`,
      );
    }
  }
  return payload;
}

export const smelterCommand = smelterCli;
