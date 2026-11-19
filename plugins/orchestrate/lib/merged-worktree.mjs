/**
 * Durable PR identity and recoverable cleanup of merged worktrees (Wave 4B).
 *
 * Nothing here removes a worktree, deletes a branch, forces Git, or removes data recursively. A merged
 * worktree is journaled and moved with `git worktree move` into a private quarantine on the same
 * filesystem; the branch, registration, contents, symlinks and hard links stay as they were.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  statSync,
  writeSync,
} from "node:fs";
import path from "node:path";

import { foundryLauncherAlive, loadFoundryState, writeFoundryState } from "./foundry.mjs";
import { cacheHome } from "./runtime-paths.mjs";
import { acquireWorkspaceLease, assertWorkspaceLease } from "./workspace-lease.mjs";

export const STRATEGIES = Object.freeze(["local", "pr"]);
export const PR_STATES = Object.freeze(["OPEN", "MERGED", "CLOSED", "UNKNOWN"]);
export const QUARANTINE_SCHEMA = "ork.cleanup.quarantine.v1";
const MAX_SCAN_ENTRIES = 500_000;
const NON_TERMINAL_JOURNAL = new Set(["intent", "moved", "ports_released"]);

function exitError(message, exitCode = 2, code = "usage") {
  const error = new Error(message);
  error.exitCode = exitCode;
  error.code = code;
  return error;
}

/** Parses a `--strategy` value once. Undefined/null means "not stated"; anything else must be exact. */
export function parseStrategy(value) {
  if (value === undefined || value === null) return;
  if (typeof value !== "string" || !STRATEGIES.includes(value)) {
    throw exitError(`Unsupported strategy: ${String(value)} (expected local or pr)`);
  }
  return value;
}

function realOrResolved(target) {
  try {
    return realpathSync(path.resolve(target));
  } catch {
    return path.resolve(target);
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

// ---------------------------------------------------------------------------------------------
// Pull request identity
// ---------------------------------------------------------------------------------------------

export function normalizePrState(raw) {
  const value = typeof raw === "string" ? raw.toUpperCase() : "";
  return PR_STATES.includes(value) && value !== "UNKNOWN" ? value : "UNKNOWN";
}

function isoOrNull(value) {
  if (typeof value !== "string" || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

const PR_FIELDS =
  "number,url,state,baseRefName,headRefName,headRefOid,isCrossRepository,headRepository,headRepositoryOwner,createdAt,updatedAt,mergedAt";

function headRepositoryName(item) {
  const owner = item?.headRepositoryOwner?.login;
  const name = item?.headRepository?.name;
  return typeof owner === "string" && typeof name === "string" ? `${owner}/${name}` : null;
}

/**
 * Returns the frozen state.pr record when `item` (one gh JSON object) is exactly the pull request for
 * `identity` = {repository, baseBranch, headBranch, headOid}; otherwise null.
 */
export function matchPullRequest(item, identity) {
  if (!item || typeof item !== "object") return null;
  const number = item.number;
  if (
    !Number.isSafeInteger(number) ||
    number <= 0 ||
    item.baseRefName !== identity.baseBranch ||
    item.headRefName !== identity.headBranch ||
    typeof item.headRefOid !== "string" ||
    item.headRefOid !== identity.headOid
  )
    return null;
  const headRepo = headRepositoryName(item);
  const isSameRepo =
    item.isCrossRepository === false ||
    (headRepo !== null && headRepo.toLowerCase() === identity.repository.toLowerCase());
  if (!isSameRepo || item.isCrossRepository === true || typeof item.url !== "string") return null;
  let url;
  try {
    url = new URL(item.url);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    !url.pathname.toLowerCase().endsWith(`/${identity.repository.toLowerCase()}/pull/${number}`)
  )
    return null;
  const state = normalizePrState(item.state);
  return {
    number,
    url: item.url,
    state,
    repository: identity.repository,
    baseBranch: identity.baseBranch,
    headBranch: identity.headBranch,
    headOid: identity.headOid,
    createdAt: isoOrNull(item.createdAt),
    updatedAt: isoOrNull(item.updatedAt) ?? isoOrNull(item.mergedAt),
  };
}

function parseJson(text) {
  try {
    return JSON.parse(String(text ?? ""));
  } catch {
    return;
  }
}

export function ghError(error) {
  return error?.code === "ENOENT" ? "gh_missing" : "gh_failed";
}

/** Default gh runner: injected `execFileSync`-compatible function, never a shell. */
function makeGh(run, { cwd, env }) {
  return (args) => run("gh", args, { cwd, env, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
}

/**
 * Looks up the pull request for an exact identity. Result status:
 * found | none | conflict (several PRs claim it) | error (query failed, nothing is known).
 */
export function lookupPullRequest(identity, { gh }) {
  let listed;
  try {
    listed = parseJson(
      gh([
        "pr",
        "list",
        "--repo",
        identity.repository,
        "--head",
        identity.headBranch,
        "--base",
        identity.baseBranch,
        "--state",
        "all",
        "--limit",
        "50",
        "--json",
        PR_FIELDS,
      ]),
    );
  } catch (error) {
    return { status: "error", code: ghError(error), message: error?.message };
  }
  if (!Array.isArray(listed)) return { status: "error", code: "gh_bad_output" };
  const matches = listed.map((item) => matchPullRequest(item, identity)).filter(Boolean);
  const numbers = new Set(matches.map((pr) => pr.number));
  if (numbers.size > 1) return { status: "conflict", matches };
  // An open PR for the same head ref and base with another commit would be updated by our push: stop.
  const diverged = listed.filter(
    (item) =>
      item?.state === "OPEN" &&
      Number.isSafeInteger(item.number) &&
      item.number > 0 &&
      item.baseRefName === identity.baseBranch &&
      item.headRefName === identity.headBranch &&
      item.isCrossRepository !== true &&
      item.headRefOid !== identity.headOid,
  );
  if (diverged.length > 0) {
    return {
      status: "conflict",
      reason: "head_oid_differs",
      numbers: diverged.map((i) => i.number),
    };
  }
  // An open PR for the same head/base with another commit is branch-name reuse: not ours, never adopted.
  return matches.length === 1 ? { status: "found", pr: matches[0] } : { status: "none" };
}

/** Views one PR by number (or URL) and verifies it against an exact identity. */
export function viewPullRequest(identity, reference, { gh }) {
  let viewed;
  try {
    viewed = parseJson(
      gh(["pr", "view", String(reference), "--repo", identity.repository, "--json", PR_FIELDS]),
    );
  } catch (error) {
    return { status: "error", code: ghError(error), message: error?.message };
  }
  const pr = matchPullRequest(viewed, identity);
  return pr ? { status: "found", pr } : { status: "error", code: "pr_identity_mismatch" };
}

/** `owner/name` of a remote URL (https or ssh form), or null. */
export function originRepository(url) {
  const match = /[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/u.exec(String(url).trim());
  return match ? match[1] : null;
}

export function resolveRepositoryName({ gh }) {
  try {
    const parsed = parseJson(gh(["repo", "view", "--json", "nameWithOwner"]));
    const name = parsed?.nameWithOwner;
    return typeof name === "string" && /^[\w.-]+\/[\w.-]+$/u.test(name)
      ? { status: "ok", repository: name }
      : { status: "error", code: "repository_unverified" };
  } catch (error) {
    return { status: "error", code: ghError(error), message: error?.message };
  }
}

function sameRecord(a, b) {
  if (!a || !b) return false;
  return ["number", "url", "state", "repository", "baseBranch", "headBranch", "headOid"].every(
    (key) => a[key] === b[key],
  );
}

/**
 * Plans (dry run) or performs "push, create, verify" for one candidate commit. Never creates a PR before a
 * successful lookup said none exists, and records a reconcilable `prReconcile` marker before the
 * remote create so an interrupted run is resumed by lookup instead of creating a second PR.
 *
 * Returns {status, pr?, operations, output?, reconcile?}. status is one of: opened | existing | merged |
 * dry-run | gh_unavailable | repository_unverified | pr_lookup_failed | pr_unverified | pr_conflict |
 * pr_closed.
 */
export async function ensurePullRequest({
  runCmd,
  runGit = runCmd,
  candidate,
  baseBranch,
  priorState = null,
  record,
  dryRun = false,
  reconcileOnly = false,
}) {
  const headBranch = candidate.branch;
  const headOid = candidate.commit;
  const planned = [
    ["gh", "repo", "view", "--json", "nameWithOwner"],
    ["gh", "pr", "list", "--head", headBranch, "--base", baseBranch, "--state", "all"],
    ["git", "push", "origin", `${headOid}:refs/heads/${headBranch}`],
    ["gh", "pr", "create", "--base", baseBranch, "--head", headBranch, "--fill"],
  ];
  if (dryRun) return { status: "dry-run", operations: planned };
  const gh = (args) => runCmd("gh", args);
  const operations = [];
  const repo = resolveRepositoryName({ gh });
  if (repo.status !== "ok") {
    return {
      status: repo.code === "gh_missing" ? "gh_unavailable" : "repository_unverified",
      operations,
      code: repo.code,
    };
  }
  // The PR belongs to this checkout's own origin; gh's idea of the repository is only a cross-check.
  let origin;
  try {
    origin = originRepository(String(runGit("git", ["remote", "get-url", "origin"]) ?? ""));
  } catch {
    origin = null;
  }
  if (!origin || origin.toLowerCase() !== repo.repository.toLowerCase()) {
    return { status: "repository_unverified", operations, code: "origin_mismatch" };
  }
  const identity = { repository: repo.repository, baseBranch, headBranch, headOid };
  const settle = async (pr, how) => {
    const unchanged = prRecordsEqual(priorState?.pr, pr);
    await record({
      status: pr.state === "MERGED" ? "merged" : "pr_opened",
      ...(!unchanged && { pr }),
      prReconcile: null,
    });
    return { status: pr.state === "MERGED" ? "merged" : how, pr, operations };
  };
  // A verified CLOSED PR is persisted exactly (never as opened) so it is visible and not re-created.
  const closed = async (pr) => {
    await record({
      status: "pr_closed",
      ...(!prRecordsEqual(priorState?.pr, pr) && { pr }),
      prReconcile: null,
    });
    return { status: "pr_closed", pr, operations };
  };
  const reconcile = priorState?.prReconcile;
  const pending =
    reconcile &&
    reconcile.repository === identity.repository &&
    reconcile.baseBranch === baseBranch &&
    reconcile.headBranch === headBranch &&
    reconcile.headOid === headOid
      ? reconcile
      : null;

  let found = lookupPullRequest(identity, { gh });
  if (found.status === "none" && pending?.url) {
    found = viewPullRequest(identity, pending.url, { gh });
    if (found.status === "error" && found.code === "pr_identity_mismatch")
      found = { status: "none" };
  }
  operations.push(["lookup", found.status]);
  if (found.status === "error")
    return { status: "pr_lookup_failed", operations, code: found.code, reconcile: pending };
  if (found.status === "conflict") return { status: "pr_conflict", operations };
  if (found.status === "found") {
    if (found.pr.state === "CLOSED") return closed(found.pr);
    if (found.pr.state === "UNKNOWN") return { status: "pr_unverified", pr: found.pr, operations };
    return settle(found.pr, "existing");
  }

  if (reconcileOnly) {
    // Discovery found nothing: never push or create from a reconcile-only retry.
    return { status: "pr_unverified", operations, reconcile: pending };
  }
  const marker = {
    ...identity,
    phase: "creating",
    startedAt: new Date().toISOString(),
    url: null,
  };
  await record({ status: "pr_creating", prReconcile: marker });
  runGit("git", ["push", "origin", `${headOid}:refs/heads/${headBranch}`]);
  operations.push(["git", "push"]);
  let output;
  try {
    output = String(
      gh([
        "pr",
        "create",
        "--repo",
        identity.repository,
        "--base",
        baseBranch,
        "--head",
        headBranch,
        "--fill",
      ]),
    );
  } catch (error) {
    // The remote may or may not have created it: lookup decides, never a blind retry.
    output = "";
    operations.push(["gh", "pr", "create", "failed"]);
    if (ghError(error) === "gh_missing") return { status: "gh_unavailable", operations };
  }
  const url =
    String(output ?? "")
      .split(/\s+/u)
      .findLast((token) => /^https:\/\/\S+\/pull\/\d+$/u.test(token)) ?? null;
  let verified = lookupPullRequest(identity, { gh });
  if (verified.status === "none" && url) verified = viewPullRequest(identity, url, { gh });
  if (verified.status === "found" && verified.pr.state === "CLOSED") {
    return { ...(await closed(verified.pr)), output };
  }
  if (verified.status === "found" && verified.pr.state !== "UNKNOWN") {
    const result = await settle(verified.pr, "opened");
    return { ...result, output };
  }
  if (verified.status === "conflict") return { status: "pr_conflict", operations, output };
  const reconcilable = { ...marker, phase: "created_unverified", url };
  await record({ status: "pr_unverified", prReconcile: reconcilable });
  return { status: "pr_unverified", operations, output, reconcile: reconcilable };
}

export const RECONCILABLE_PR_STATUSES = Object.freeze([
  "pr_creating",
  "pr_unverified",
  "pr_lookup_failed",
]);

/**
 * Retry discovery for an interrupted PR creation: look up (and view by recorded URL) first, persist the
 * verified metadata, and never push or create. Needs the worktree's recorded `prReconcile` marker.
 */
export async function reconcilePullRequest({
  worktreePath,
  baseBranch,
  priorState,
  execFileSyncFn = execFileSync,
  env = process.env,
  assertHeld = () => {},
  owningRoomId,
  write = writeFoundryState,
}) {
  const marker = priorState?.prReconcile;
  if (!marker?.headOid || !marker.headBranch)
    return { ok: false, status: "pr_unverified", reason: "no_reconcile_marker" };
  const runCmd = (cmd, args) => {
    assertHeld();
    return execFileSyncFn(cmd, args, {
      cwd: worktreePath,
      env,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
  };
  let head;
  try {
    head = String(runCmd("git", ["rev-parse", "HEAD"])).trim();
  } catch {
    return { ok: false, status: "pr_unverified", reason: "head_unreadable" };
  }
  if (head !== marker.headOid) {
    return { ok: false, status: "stale_candidate", reason: "head_changed_since_create" };
  }
  const result = await ensurePullRequest({
    runCmd,
    candidate: { branch: marker.headBranch, commit: marker.headOid },
    baseBranch: baseBranch ?? marker.baseBranch,
    priorState,
    reconcileOnly: true,
    record: (patch) => {
      assertHeld();
      return write(
        worktreePath,
        patch,
        patch.pr && owningRoomId ? { owningRoomId, env } : undefined,
      );
    },
  });
  return {
    ok: ["opened", "existing", "merged"].includes(result.status),
    ...result,
    status: ["opened", "existing"].includes(result.status) ? "pr_opened" : result.status,
  };
}

/** True when a saved record and a freshly verified record agree on everything but timestamps. */
export function prRecordsEqual(saved, fresh) {
  return sameRecord(saved, fresh) && saved.createdAt === fresh.createdAt;
}

// ---------------------------------------------------------------------------------------------
// Git helpers (read-only unless stated)
// ---------------------------------------------------------------------------------------------

/** Git must not refresh indexes or take optional locks: an audit may not change any byte. */
function gitEnv(env) {
  return { ...env, GIT_OPTIONAL_LOCKS: "0" };
}

function git(run, cwd, args, env) {
  return String(
    run("git", args, {
      cwd,
      env: gitEnv(env),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }) ?? "",
  );
}

function tryGit(run, cwd, args, env) {
  try {
    return git(run, cwd, args, env);
  } catch {
    return null;
  }
}

export function parseWorktreeList(text) {
  const entries = [];
  for (const block of String(text).split(/\n\s*\n/u)) {
    const entry = { locked: false, prunable: false, bare: false, detached: false };
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) entry.path = line.slice(9);
      else if (line.startsWith("HEAD ")) entry.head = line.slice(5).trim();
      else if (line.startsWith("branch ")) entry.branchRef = line.slice(7).trim();
      else if (line === "bare") entry.bare = true;
      else if (line === "detached") entry.detached = true;
      else if (line === "locked" || line.startsWith("locked ")) entry.locked = true;
      else if (line === "prunable" || line.startsWith("prunable ")) entry.prunable = true;
    }
    if (!entry.path) {
      continue;
    }

    entry.branch = entry.branchRef?.startsWith("refs/heads/")
      ? entry.branchRef.slice("refs/heads/".length)
      : null;
    entries.push(entry);
  }
  return entries;
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function readJsonSafe(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function identityOf(target) {
  try {
    const info = statSync(target);
    return { dev: info.dev, ino: info.ino };
  } catch {
    return null;
  }
}

function isSameIdentity(a, b) {
  return Boolean(a && b && a.dev === b.dev && a.ino === b.ino);
}

function repoKeyOf(repoRoot) {
  const canonical = realOrResolved(repoRoot);
  const base =
    path
      .basename(canonical)
      .replaceAll(/[^A-Za-z0-9_.-]/gu, "-")
      .slice(0, 40) || "repo";
  return `${base}-${sha256(canonical).slice(0, 12)}`;
}

export function quarantineRoot(env = process.env) {
  return path.join(cacheHome(env), "worktree-quarantine-v1");
}

/** Lazily loaded 4A port API (frozen signatures); absent module means no recorded ports. */
async function loadPortsApi(override) {
  if (override) return override;
  try {
    return await import("./worktree-ports.mjs");
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") return null;
    throw error;
  }
}

const PORT_API_FUNCTIONS = [
  "worktreePortKey",
  "listWorktreePorts",
  "releaseWorktreePorts",
  "fenceWorktreePorts",
  "clearWorktreePortFence",
];

function hasFullPortsApi(portsApi) {
  return PORT_API_FUNCTIONS.every((name) => typeof portsApi?.[name] === "function");
}

/** The canonical {repoKey, worktreePath} identity of a worktree, or an error string. */
function portKeyFor(portsApi, repoRoot, worktreePath) {
  if (!portsApi) return { ok: true, key: null };
  if (!hasFullPortsApi(portsApi)) return { ok: false, error: "ports_fence_unavailable" };
  try {
    return { ok: true, key: portsApi.worktreePortKey(repoRoot, worktreePath) };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

/** Ports recorded for a pinned key. Read-only; a missing database reads as empty. */
function listPorts(portsApi, key, env) {
  if (!portsApi || !key) return { ok: true, ports: [] };
  try {
    const rows = portsApi.listWorktreePorts({ key, env });
    return {
      ok: true,
      ports: Array.isArray(rows) ? rows.map(({ name, port }) => ({ name, port })) : [],
    };
  } catch (error) {
    return { ok: false, ports: [], error: error?.message || String(error) };
  }
}

// ---------------------------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------------------------

function pathIsAtOrInside(root, candidate) {
  return candidate === root || isInside(root, candidate);
}

function inspectLinuxProcesses(root) {
  let pids;
  try {
    pids = readdirSync("/proc").filter((name) => /^\d+$/u.test(name));
  } catch {
    return { inspectable: false, active: false };
  }
  // Credential-dropping daemons of our own user (agents, compositors) are non-dumpable, so the kernel
  // refuses their cwd to everyone. They are counted and disclosed; workers Orkest launches are readable.
  let unreadable = 0;
  for (const pid of pids) {
    if (Number(pid) === process.pid) continue;
    try {
      if (pathIsAtOrInside(root, readlinkSync(`/proc/${pid}/cwd`))) {
        return { inspectable: true, active: true, pid: Number(pid) };
      }
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ESRCH") continue;
      // cwd is refused: fall back to the command line, which names a worktree in practice.
      let cmdline = "";
      try {
        cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
      } catch {
        /* unreadable too */
      }
      if (cmdline.includes(root)) return { inspectable: true, active: true, pid: Number(pid) };
      unreadable += 1;
    }
  }
  return { inspectable: true, active: false, unreadable };
}

/** macOS/BSD: `lsof -d cwd` lists every process's working directory; no /proc exists there. */
function inspectLsofProcesses(root, run, env) {
  let output;
  try {
    output = String(
      run("lsof", ["-w", "-a", "-d", "cwd", "-Fpn"], {
        env,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      }) ?? "",
    );
  } catch (error) {
    // lsof exits 1 when it lists nothing for some users; any other failure is "unknown".
    if (error?.status === 1 && !error?.stdout) return { inspectable: true, active: false };
    output = typeof error?.stdout === "string" && error?.status === 1 ? error.stdout : null;
    if (output === null) return { inspectable: false, active: false };
  }
  let pid = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid !== process.pid && pathIsAtOrInside(root, line.slice(1))) {
      return { inspectable: true, active: true, pid };
    }
  }
  return { inspectable: true, active: false };
}

/** Any process whose working directory is inside the worktree keeps it; unknown status keeps it too. */
export function inspectProcessesInside(root, { run, env, platform = process.platform }) {
  return platform === "linux" ? inspectLinuxProcesses(root) : inspectLsofProcesses(root, run, env);
}

/**
 * Walks the worktree (no symlink following, no `.git`) and returns the links a move would change or
 * break, plus the identity each link resolves to now. A link survives a move only if it is relative and
 * stays inside the tree, or leaves it in a way that resolves identically from the destination.
 */
function scanLinks(root, destination) {
  const unsafe = [];
  const identities = new Map();
  const realRoot = realOrResolved(root);
  let seen = 0;
  const walk = (dir) => {
    const children = readdirSync(dir, { withFileTypes: true });
    for (const entry of children) {
      if (++seen > MAX_SCAN_ENTRIES) throw new Error("too_large_to_audit");
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const relative = path.relative(root, full);
        const target = readlinkSync(full);
        const lexical = path.resolve(dir, target);
        const isInsideLexically =
          pathIsAtOrInside(root, lexical) || pathIsAtOrInside(realRoot, lexical);
        let isUnsafe = false;
        if (path.isAbsolute(target)) isUnsafe = isInsideLexically;
        else if (!isInsideLexically) {
          const relocated = path.resolve(destination, path.relative(root, dir), target);
          isUnsafe = relocated !== lexical;
        }
        if (!isUnsafe && !isInsideLexically) {
          // Alias chains: a link to a link that leads back into this tree.
          try {
            isUnsafe = pathIsAtOrInside(realRoot, realpathSync(full));
          } catch {
            /* dangling stays dangling */
          }
        }
        if (isUnsafe) unsafe.push(relative);
        identities.set(relative, identityOf(full));
      } else if (entry.isDirectory() && !(dir === root && entry.name === ".git")) {
        walk(full);
      }
    }
  };
  walk(root);
  return { unsafe, identities };
}

function destinationFor(repoRoot, worktreePath, env, tag) {
  const root = quarantineRoot(env);
  const repoKey = repoKeyOf(repoRoot);
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const id = `${sha256(`${realOrResolved(worktreePath)}\0${tag}`).slice(0, 16)}-${attempt}`;
    const journal = path.join(root, repoKey, "journal", `${id}.json`);
    const destination = path.join(root, repoKey, "worktrees", id, path.basename(worktreePath));
    let isExists = false;
    for (const candidate of [journal, path.dirname(destination)]) {
      try {
        lstatSync(candidate);
        isExists = true;
      } catch {
        /* vacant */
      }
    }
    if (!isExists) return { id, journal, destination, repoKey, root };
  }
  return null;
}

function nearestExisting(target) {
  let current = target;
  for (;;) {
    try {
      lstatSync(current);
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

function shellQuote(value) {
  const text = String(value);
  return /^[\w./:@%+=,-]+$/u.test(text) ? text : `'${text.replaceAll("'", String.raw`'\''`)}'`;
}

/** Exact argv for programmatic restores, and a copy-pasteable shell line for people. */
function restoreInstructions(repoRoot, source, destination) {
  const command = ["git", "-C", repoRoot, "worktree", "move", destination, source];
  return {
    command,
    shell: command.map((part) => shellQuote(part)).join(" "),
    text: `Check that ${shellQuote(source)} does not exist, then run: ${command.map((part) => shellQuote(part)).join(" ")}`,
    portsNote: "Recorded ports were released; provision again to allocate new ones.",
  };
}

/**
 * Room bindings from the read-only room store: which worktree paths live (active) rooms use, and which
 * room ids exist. Any read problem is "unknown", which keeps every worktree.
 */
export async function loadRoomBindings(env = process.env, override) {
  if (override) return override;
  try {
    const { listRawRoomsReadOnly, mailboxRoot } = await import("./horde-room.mjs");
    const rooms = listRawRoomsReadOnly(mailboxRoot(env));
    const active = new Set();
    const known = new Set();
    const paths = [];
    for (const room of rooms) {
      known.add(room.id);
      const isActive = (room.lifecycle ?? "active") === "active";
      if (isActive) active.add(room.id);
      const agents = Array.isArray(room.agents) ? room.agents : [];
      for (const agent of agents) {
        const candidates = [agent?.worktree?.path, agent?.cwd];
        for (const candidate of candidates) {
          if (typeof candidate === "string" && candidate && isActive) {
            paths.push({ path: realOrResolved(candidate), roomId: room.id });
          }
        }
      }
    }
    return { active, known, paths, error: null };
  } catch (error) {
    return {
      active: new Set(),
      known: new Set(),
      paths: [],
      error: error?.message || String(error),
    };
  }
}

/**
 * Evaluates one registered worktree. Read-only. Returns {eligible, reasons[], evidence, ...}.
 * Every uncertainty is a reason; an entry is eligible only when `reasons` is empty.
 */
export async function evaluateMergedWorktree(entry, ctx) {
  const {
    repoRoot,
    env,
    run,
    gh,
    portsApi,
    scanRoots,
    currentDir,
    allowPrLookup = true,
    cache,
  } = ctx;
  const reasons = [];
  const worktreePath = realOrResolved(entry.path);
  const result = {
    path: worktreePath,
    branch: entry.branch ?? null,
    head: entry.head ?? null,
    base: null,
    eligible: false,
    reasons,
    evidence: null,
    ports: [],
    quarantine: null,
    recovery: null,
    identity: identityOf(worktreePath),
  };
  const keep = (reason) => {
    if (!reasons.includes(reason)) reasons.push(reason);
  };
  if (scanRoots.every((root) => !isInside(root, worktreePath))) keep("outside_scan_roots");
  if (currentDir && (currentDir === worktreePath || isInside(worktreePath, currentDir)))
    keep("current_worktree");
  if (entry.bare) keep("bare");
  if (entry.prunable) keep("prunable_registration");
  if (entry.locked) keep("git_locked");
  if (entry.detached || !entry.branch) keep("no_branch");
  if (!result.identity) keep("path_missing");
  if (
    reasons.length > 0 &&
    (reasons.includes("path_missing") || reasons.includes("outside_scan_roots"))
  )
    return result;

  // Ownership evidence: Orkest's own disposable marker, positively matching this checkout and branch.
  const gitDir = tryGit(run, worktreePath, ["rev-parse", "--absolute-git-dir"], env)?.trim();
  const marker = gitDir ? readJsonSafe(path.join(gitDir, "orkest.json")) : null;
  const loadedState = loadFoundryState(worktreePath);
  const state = loadedState.kind === "ok" ? loadedState.state : null;
  if (!["missing", "ok"].includes(loadedState.kind)) keep("foundry_state_unreadable");
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) keep("not_orkest_owned");
  else {
    if (marker.disposable !== true) keep("not_disposable");
    if (marker.branch !== entry.branch) keep("marker_branch_mismatch");
    if (
      typeof marker.parentCwd !== "string" ||
      !path.isAbsolute(marker.parentCwd) ||
      !pathIsAtOrInside(repoRoot, realOrResolved(marker.parentCwd))
    )
      keep("marker_parent_mismatch");
  }
  const rooms = ctx.rooms ?? {
    error: "room_store_not_loaded",
    active: new Set(),
    known: new Set(),
    paths: [],
  };
  const allowed = new Set(ctx.allowRoomId ? [ctx.allowRoomId] : []);
  if (rooms.error) keep("room_state_unknown");
  else {
    // A live room that binds this path keeps it, whatever the marker says.
    for (const binding of rooms.paths) {
      if (pathIsAtOrInside(worktreePath, binding.path) && !allowed.has(binding.roomId))
        keep("room_bound");
    }
    if (marker?.roomId || marker?.memberId) {
      if (typeof marker.roomId !== "string" || !rooms.known.has(marker.roomId))
        keep("room_state_unknown");
      else if (rooms.active.has(marker.roomId) && !allowed.has(marker.roomId)) keep("room_bound");
    }
  }
  const recordedBase = state?.targetBranch ?? marker?.targetBranch ?? marker?.baseBranch ?? null;
  const base = recordedBase ?? ctx.explicitBase ?? null;
  if (recordedBase && ctx.explicitBase && recordedBase !== ctx.explicitBase) keep("base_mismatch");
  if (!base) keep("base_unknown");
  result.base = base;
  if (state && ["launching", "running", "launch_uncertain"].includes(state.status))
    keep("foundry_run_active");
  if (state?.attempt?.launcher && foundryLauncherAlive(state)) keep("foundry_run_active");
  for (const marker_ of [
    path.join(worktreePath, ".gitmodules"),
    gitDir && path.join(gitDir, "modules"),
  ]) {
    if (!marker_) continue;
    try {
      lstatSync(marker_);
      keep("submodule");
    } catch {
      /* none */
    }
  }

  const status = tryGit(
    run,
    worktreePath,
    ["--no-optional-locks", "status", "--porcelain", "--untracked-files=all"],
    env,
  );
  if (status === null) keep("status_unreadable");
  else if (status.trim()) keep("dirty");

  const tip = entry.branch
    ? tryGit(
        run,
        repoRoot,
        ["rev-parse", "--verify", "--quiet", ["refs/heads/", entry.branch, "^{commit}"].join("")],
        env,
      )?.trim()
    : null;
  const head = tryGit(
    run,
    worktreePath,
    ["rev-parse", "--verify", ["HEAD", "^{commit}"].join("")],
    env,
  )?.trim();
  result.head = head || result.head;
  if (!tip || !head || tip !== head) keep("branch_tip_mismatch");

  const baseSha = base
    ? tryGit(
        run,
        repoRoot,
        ["rev-parse", "--verify", "--quiet", ["refs/heads/", base, "^{commit}"].join("")],
        env,
      )?.trim()
    : null;
  if (base && !baseSha) keep("base_missing");
  if (entry.branch && entry.branch === base) keep("is_base_branch");

  const processes = ctx.inspectProcesses
    ? ctx.inspectProcesses(worktreePath)
    : inspectProcessesInside(worktreePath, { run, env, platform: ctx.platform });
  if (processes.active) keep("process_active");
  if (!processes.inspectable) keep("process_status_unknown");
  if (processes.unreadable) result.unreadableProcesses = processes.unreadable;

  const keyed = portKeyFor(portsApi, repoRoot, worktreePath);
  if (keyed.ok) {
    const portResult = listPorts(portsApi, keyed.key, env);
    result.ports = portResult.ports;
    if (!portResult.ok) keep("ports_unreadable");
  } else keep(keyed.error === "ports_fence_unavailable" ? keyed.error : "ports_unreadable");

  if (cache?.leaseCheck) {
    const leaseReason = cache.leaseCheck(worktreePath, marker);
    if (leaseReason) keep(leaseReason);
  }

  // Evidence of merge: ancestry, else a freshly verified merged PR for exactly this head.
  if (head && baseSha && reasons.length === 0) {
    const ancestor = (() => {
      try {
        run("git", ["merge-base", "--is-ancestor", head, baseSha], {
          cwd: repoRoot,
          env: gitEnv(env),
          stdio: "ignore",
        });
        return true;
      } catch (error) {
        return error?.status !== 1 && null;
      }
    })();
    if (ancestor === true) {
      result.evidence = { kind: "ancestor", head, base, baseSha };
    } else if (ancestor === null) {
      keep("ancestry_unknown");
    } else if (!allowPrLookup || !gh) {
      keep("merge_unverified");
    } else {
      // The PR must belong to this checkout's own origin, never to a repository a record names.
      const repository = ctx.repository ?? null;
      if (
        repository &&
        state?.pr?.repository &&
        state.pr.repository.toLowerCase() !== repository.toLowerCase()
      ) {
        keep("pr_repository_mismatch");
      } else if (repository) {
        const identity = { repository, baseBranch: base, headBranch: entry.branch, headOid: head };
        const found = lookupPullRequest(identity, { gh });
        if (found.status === "found" && found.pr.state === "MERGED") {
          result.evidence = { kind: "merged_pr", pr: found.pr, head, base };
        } else
          switch (found.status) {
            case "found": {
              keep(`pr_${found.pr.state.toLowerCase()}`);
              break;
            }
            case "error": {
              keep(found.code === "gh_missing" ? "gh_missing" : "pr_lookup_failed");
              break;
            }
            case "conflict": {
              keep("pr_conflict");
              break;
            }
            default: {
              keep("merge_unverified");
            }
          }
      } else {
        keep("merge_unverified");
      }
    }
  }

  // Quarantine feasibility.
  const planned = destinationFor(repoRoot, worktreePath, env, `${head}\0${entry.branch}`);
  if (planned) {
    const existing = nearestExisting(planned.destination);
    const here = identityOf(worktreePath);
    const there = identityOf(existing);
    if (!here || !there || here.dev !== there.dev) keep("cross_device");
    {
      try {
        const { unsafe } = scanLinks(worktreePath, planned.destination);
        if (unsafe.length > 0) {
          keep("symlink_would_change");
          result.unsafeSymlinks = unsafe.slice(0, 20);
        }
      } catch (error) {
        keep(error?.message === "too_large_to_audit" ? "too_large_to_audit" : "scan_failed");
      }
    }
    const qBase = quarantineRoot(env);
    if (
      privateDirProblems(path.dirname(planned.journal), qBase) ||
      privateDirProblems(path.dirname(planned.destination), qBase)
    )
      keep("quarantine_unsafe");
    result.quarantine = {
      id: planned.id,
      destination: planned.destination,
      journal: planned.journal,
    };
    result.recovery = restoreInstructions(repoRoot, worktreePath, planned.destination);
  } else {
    keep("quarantine_unavailable");
  }
  result.eligible = reasons.length === 0 && Boolean(result.evidence);
  if (!result.eligible && reasons.length === 0) keep("merge_unverified");
  return result;
}

function makeLeaseCheck(cacheHomeDir, hasActiveWorktreeLease, ownLeasePaths = []) {
  return (worktreePath, marker) => {
    try {
      return hasActiveWorktreeLease(
        cacheHomeDir,
        worktreePath,
        path.basename(worktreePath),
        marker,
        {
          ownLeasePaths,
          kernelLeases: true,
        },
      )
        ? "lease_active"
        : null;
    } catch {
      return "lease_unreadable";
    }
  };
}

function defaultScanRoots(repoRoot, env) {
  return [
    path.join(realOrResolved(repoRoot), ".worktrees"),
    path.join(realOrResolved(cacheHome(env)), "worktrees"),
  ];
}

/** Read-only audit of every registered linked worktree for `repoRoot`. */
export async function auditMergedWorktrees({
  repoRoot,
  env = process.env,
  targetBranch,
  execFileSyncFn = execFileSync,
  portsApi,
  scanRoots,
  currentDir = process.cwd(),
  allowPrLookup = true,
  hasActiveWorktreeLease,
  platform,
  inspectProcesses,
  roomBindings,
} = {}) {
  let root = realOrResolved(repoRoot);
  const run = execFileSyncFn;
  const base = targetBranch ?? null;
  const listing = tryGit(run, root, ["worktree", "list", "--porcelain"], env);
  if (listing === null) {
    return { repoRoot: root, base, entries: [], error: "worktree_list_failed", journals: [] };
  }
  // Everything is keyed to the main checkout, however the command was started.
  const main = parseWorktreeList(listing)[0];
  if (main) root = realOrResolved(main.path);
  const ports = await loadPortsApi(portsApi);
  const rooms = await loadRoomBindings(env, roomBindings);
  const gh = makeGh(run, { cwd: root, env });
  const repository = (() => {
    if (!allowPrLookup) return null;
    const url = tryGit(run, root, ["remote", "get-url", "origin"], env)?.trim() ?? "";
    return originRepository(url);
  })();
  const roots = (scanRoots ?? defaultScanRoots(root, env)).map(realOrResolved);
  const all = parseWorktreeList(listing);
  const entries = [];
  const leaseCheck = hasActiveWorktreeLease
    ? makeLeaseCheck(cacheHome(env), hasActiveWorktreeLease)
    : null;
  for (const [index, entry] of all.entries()) {
    if (index === 0) continue; // The main worktree is never eligible.
    if (realOrResolved(entry.path) === root) continue;
    entries.push(
      await evaluateMergedWorktree(entry, {
        repoRoot: root,
        env,
        run,
        explicitBase: base,
        gh,
        portsApi: ports,
        scanRoots: roots,
        currentDir: realOrResolved(currentDir),
        allowPrLookup,
        platform,
        inspectProcesses,
        repository,
        rooms,
        cache: { leaseCheck },
      }),
    );
  }
  return { repoRoot: root, base, repository, entries, journals: listJournals(root, env) };
}

// ---------------------------------------------------------------------------------------------
// Journal and quarantine
// ---------------------------------------------------------------------------------------------

function journalDir(repoRoot, env) {
  return path.join(quarantineRoot(env), repoKeyOf(repoRoot), "journal");
}

/** First problem with an existing private directory component (not a symlink, ours, mode 0700), or null. */
function privateDirProblem(target) {
  let info;
  try {
    info = lstatSync(target);
  } catch (error) {
    return error.code === "ENOENT" ? null : `unreadable: ${target}`;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) return `not a plain directory: ${target}`;
  if (typeof process.getuid === "function" && info.uid !== process.getuid())
    return `not owned by you: ${target}`;
  if ((info.mode & 0o077) !== 0) return `group/world accessible: ${target}`;
  return null;
}

function privateDirProblems(dir, base) {
  const parts = path.relative(base, dir).split(path.sep).filter(Boolean);
  let current = base;
  const found = [privateDirProblem(current)];
  for (const part of parts) {
    current = path.join(current, part);
    found.push(privateDirProblem(current));
  }
  return found.find(Boolean) ?? null;
}

/** Creates (0700) and then re-validates every component below `base`, inclusive. */
function ensurePrivateDir(dir, base) {
  const parts = path.relative(base, dir).split(path.sep).filter(Boolean);
  let current = base;
  mkdirSync(current, { recursive: true, mode: 0o700 });
  for (const part of parts) {
    current = path.join(current, part);
    try {
      mkdirSync(current, { mode: 0o700 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  const problem = privateDirProblems(dir, base);
  if (problem) throw new Error(`unsafe quarantine path: ${problem}`);
}

function writeJournal(file, journal) {
  const temporary = `${file}.tmp-${process.pid}`;
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeSync(descriptor, `${JSON.stringify(journal, null, 2)}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, file);
  const directory = openSync(path.dirname(file), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

export function listJournals(repoRoot, env = process.env) {
  const dir = journalDir(repoRoot, env);
  let names;
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
  return names
    .toSorted((a, b) => a.localeCompare(b))
    .map((name) => ({ file: path.join(dir, name), journal: readJsonSafe(path.join(dir, name)) }))
    .filter((item) => item.journal?.schema === QUARANTINE_SCHEMA);
}

/**
 * Journaled `git worktree move` into the private quarantine. Must be called with the worktree's
 * exclusive lease held and a fresh `evaluateMergedWorktree` result for the same path. The original
 * port identity is pinned and fenced before the move, and the fence stays until the exact original
 * allocation is released and the journal is final.
 */
export async function quarantineMergedWorktree({
  repoRoot,
  evaluation,
  env = process.env,
  execFileSyncFn = execFileSync,
  portsApi,
  lease,
  assertHeld,
  now = () => new Date(),
}) {
  const source = evaluation.path;
  if (!evaluation.eligible || !evaluation.quarantine) {
    return { status: "kept", path: source, reasons: evaluation.reasons };
  }
  const run = execFileSyncFn;
  const root = realOrResolved(repoRoot);
  const held = () => {
    if (lease) assertWorkspaceLease(lease);
    assertHeld?.();
  };
  const kept = (...reasons) => ({ status: "kept", path: source, reasons });
  held();
  const ports = await loadPortsApi(portsApi);
  const { id, journal: journalFile, destination, repoKey } = evaluation.quarantine;
  const keyed = portKeyFor(ports, root, source);
  if (!keyed.ok)
    return kept(keyed.error === "ports_fence_unavailable" ? keyed.error : "ports_unreadable");
  const portKey = keyed.key;
  const portRecords = listPorts(ports, portKey, env);
  if (!portRecords.ok) return kept("ports_unreadable");
  // Capture, under the lease, what every link resolves to now; the move must not change any of it.
  let links;
  try {
    links = scanLinks(source, destination);
  } catch {
    return kept("scan_failed");
  }
  if (links.unsafe.length > 0) return kept("symlink_would_change");
  const journal = {
    schema: QUARANTINE_SCHEMA,
    id,
    state: "intent",
    repoRoot: root,
    repoKey,
    source,
    destination,
    branch: evaluation.branch,
    head: evaluation.head,
    base: evaluation.base,
    evidence: evaluation.evidence,
    identity: evaluation.identity,
    ports: portRecords.ports,
    portKey,
    fenced: false,
    createdAt: now().toISOString(),
    updatedAt: now().toISOString(),
  };
  const qBase = quarantineRoot(env);
  try {
    ensurePrivateDir(path.dirname(journalFile), qBase);
    ensurePrivateDir(path.dirname(destination), qBase);
  } catch {
    return kept("quarantine_unsafe");
  }
  writeJournal(journalFile, journal);
  const update = (patch) => {
    Object.assign(journal, patch, { updatedAt: now().toISOString() });
    writeJournal(journalFile, journal);
  };
  const liftFence = () => {
    if (!journal.fenced || !ports) return true;
    try {
      ports.clearWorktreePortFence({ key: journal.portKey, env });
      update({ fenced: false });
      return true;
    } catch {
      return false;
    }
  };
  if (ports) {
    try {
      ports.fenceWorktreePorts({ key: portKey, env, reason: `quarantine ${id}` });
      update({ fenced: true });
    } catch (error) {
      update({ state: "aborted", error: String(error?.message ?? error).slice(0, 500) });
      return kept("ports_fence_failed");
    }
  }
  try {
    held();
    git(run, root, ["worktree", "move", source, destination], env);
  } catch (error) {
    // Nothing moved if the source is intact; otherwise recovery resolves it from the journal.
    const isIntact =
      isSameIdentity(identityOf(source), journal.identity) && !identityOf(destination);
    update({
      state: isIntact ? "aborted" : "intent",
      error: String(error?.message ?? error).slice(0, 500),
    });
    if (isIntact) liftFence();
    return { status: "move_failed", path: source, journal: journalFile, error: journal.error };
  }
  const changed = [...links.identities].filter(([relative, before]) => {
    const after = identityOf(path.join(destination, relative));
    return !isSameIdentity(before, after) && !(before === null && after === null);
  });
  if (changed.length > 0) {
    // A link no longer reaches what it reached: put the tree back exactly where it was.
    try {
      git(run, root, ["worktree", "move", destination, source], env);
      update({ state: "aborted", error: "link_identity_changed" });
      liftFence();
      return { status: "link_identity_changed", path: source, journal: journalFile };
    } catch {
      update({ error: "link_identity_changed_rollback_failed" });
      return { status: "move_unverified", path: source, journal: journalFile };
    }
  }
  return finishMoved({ journal, journalFile, update, ports, env, run, root });
}

/** After a verified move: release the pinned original allocation, then lift the fence, then finalize. */
function finishMoved({ journal, journalFile, update, ports, env, run, root }) {
  const isMoved = isSameIdentity(identityOf(journal.destination), journal.identity);
  const registered = parseWorktreeList(
    git(run, root, ["worktree", "list", "--porcelain"], env),
  ).some((entry) => realOrResolved(entry.path) === realOrResolved(journal.destination));
  if (!isMoved || !registered) {
    update({ state: "intent", error: "post_move_verification_failed" });
    return { status: "move_unverified", path: journal.source, journal: journalFile };
  }
  const pending = (error, extra = {}) => ({
    status: "quarantined_ports_pending",
    path: journal.source,
    destination: journal.destination,
    branch: journal.branch,
    head: journal.head,
    journal: journalFile,
    pendingPorts: journal.ports,
    error,
    bytesReclaimed: 0,
    recovery: restoreInstructions(journal.repoRoot, journal.source, journal.destination),
    resume: "Run `ork cleanup run --merged` again to finish releasing the recorded ports.",
    ...extra,
  });
  const wasReleased = journal.state === "ports_released";
  if (!wasReleased) update({ state: "moved" });
  let released = journal.released ?? null;
  if (ports && journal.portKey && !wasReleased) {
    try {
      released = ports.releaseWorktreePorts({ key: journal.portKey, env });
    } catch (error) {
      return pending(error?.message || String(error));
    }
  }
  update({ state: "ports_released", released });
  if (journal.fenced && ports) {
    try {
      ports.clearWorktreePortFence({ key: journal.portKey, env });
      update({ fenced: false });
    } catch (error) {
      return pending(error?.message || String(error), { pendingFence: true });
    }
  }
  update({ state: "finalized" });
  return {
    status: "quarantined",
    path: journal.source,
    destination: journal.destination,
    branch: journal.branch,
    head: journal.head,
    journal: journalFile,
    ports: journal.ports,
    releasedPorts: released,
    bytesReclaimed: 0,
    recovery: restoreInstructions(journal.repoRoot, journal.source, journal.destination),
  };
}

/**
 * Resumes interrupted journals under the caller's repo lease. A reused source path is never
 * mistaken for the original: only directory identity recorded in the journal counts, and ports are
 * only ever released through the pinned original key.
 */
export async function recoverQuarantines({
  repoRoot,
  env = process.env,
  execFileSyncFn = execFileSync,
  portsApi,
  now = () => new Date(),
}) {
  const run = execFileSyncFn;
  const root = realOrResolved(repoRoot);
  const ports = await loadPortsApi(portsApi);
  const results = [];
  for (const { file, journal } of listJournals(root, env)) {
    if (!NON_TERMINAL_JOURNAL.has(journal.state)) continue;
    const update = (patch) => {
      Object.assign(journal, patch, { updatedAt: now().toISOString() });
      writeJournal(file, journal);
    };
    const isAtDestination = isSameIdentity(identityOf(journal.destination), journal.identity);
    const isAtSource = isSameIdentity(identityOf(journal.source), journal.identity);
    const isNeedsPorts = Boolean(journal.portKey);
    if (isNeedsPorts && !hasFullPortsApi(ports)) {
      results.push({ id: journal.id, status: "needs_review", reason: "ports_api_unavailable" });
      continue;
    }
    if (journal.state === "intent" && isAtSource && !identityOf(journal.destination)) {
      update({ state: "aborted", error: "move_never_happened" });
      if (journal.fenced && isNeedsPorts) {
        try {
          ports.clearWorktreePortFence({ key: journal.portKey, env });
          update({ fenced: false });
        } catch {
          /* The fence stays visible; it blocks reuse until cleared. */
        }
      }
      results.push({ id: journal.id, status: "aborted" });
      continue;
    }
    if (!isAtDestination) {
      update({ error: "identity_mismatch_needs_manual_review" });
      results.push({ id: journal.id, status: "needs_review", source: journal.source });
      continue;
    }
    // Defensive: the fence should make a changed allocation impossible; if it happened, stop.
    if (isNeedsPorts && journal.state === "moved" && journal.ports.length > 0) {
      const current = listPorts(ports, journal.portKey, env);
      const isUnchanged = JSON.stringify(current.ports) === JSON.stringify(journal.ports);
      if (!current.ok || (current.ports.length > 0 && !isUnchanged)) {
        results.push({ id: journal.id, status: "needs_review", reason: "ports_changed" });
        continue;
      }
    }
    const outcome = finishMoved({
      journal,
      journalFile: file,
      update,
      ports: isNeedsPorts ? ports : null,
      env,
      run,
      root,
    });
    results.push({ id: journal.id, ...outcome });
  }
  return results;
}

/**
 * The common recoverable "prune" for a worktree whose branch was just merged (smelter, next, cleanup):
 * positive ownership, live lease/process/room checks, then the journaled quarantine. It never removes a
 * worktree, deletes a branch or forces anything; when it cannot prove safety it retains the tree.
 */
export async function pruneMergedWorktree({
  repoRoot,
  worktreePath,
  targetBranch,
  env = process.env,
  execFileSyncFn = execFileSync,
  portsApi,
  assertHeld,
  lease,
  allowRoomId,
  hasActiveWorktreeLease,
  scanRoots,
  roomBindings,
  platform,
  inspectProcesses,
}) {
  const run = execFileSyncFn;
  const listing = tryGit(run, realOrResolved(repoRoot), ["worktree", "list", "--porcelain"], env);
  if (listing === null)
    return { pruned: false, status: "retained", reasons: ["worktree_list_failed"] };
  const entries = parseWorktreeList(listing);
  const root = realOrResolved(entries[0]?.path ?? repoRoot);
  const target = realOrResolved(worktreePath);
  const entry = entries.slice(1).find((item) => realOrResolved(item.path) === target);
  if (!entry) return { pruned: false, status: "retained", reasons: ["not_registered"] };
  let lookup = hasActiveWorktreeLease;
  if (!lookup) {
    try {
      ({ hasActiveWorktreeLease: lookup } = await import("./cleanup.mjs"));
    } catch {
      lookup = null;
    }
  }
  const evaluation = await evaluateMergedWorktree(entry, {
    repoRoot: root,
    env,
    run,
    explicitBase: targetBranch,
    gh: null,
    allowPrLookup: false,
    portsApi: await loadPortsApi(portsApi),
    scanRoots: (scanRoots ?? defaultScanRoots(root, env)).map(realOrResolved),
    currentDir: null,
    allowRoomId,
    rooms: await loadRoomBindings(env, roomBindings),
    platform,
    inspectProcesses,
    repository: null,
    // Our own lease is held by the caller: it is excluded, every other owner still counts.
    cache: { leaseCheck: lookup ? makeLeaseCheck(cacheHome(env), lookup, [target]) : null },
  });
  if (!evaluation.eligible) {
    return { pruned: false, status: "retained", reasons: evaluation.reasons, path: target };
  }
  const outcome = await quarantineMergedWorktree({
    repoRoot: root,
    evaluation,
    env,
    execFileSyncFn,
    portsApi,
    lease,
    assertHeld,
  });
  const isMoved = ["quarantined", "quarantined_ports_pending"].includes(outcome.status);
  return { pruned: isMoved, ...outcome };
}

/**
 * `ork cleanup --merged`: audit, then (unless dry-run/status) quarantine each eligible worktree
 * under exclusive leases with a fresh re-evaluation. Status and dry-run write nothing at all.
 */
export async function mergedCleanup({
  repoRoot,
  env = process.env,
  targetBranch,
  dryRun = true,
  execFileSyncFn = execFileSync,
  portsApi,
  scanRoots,
  currentDir = process.cwd(),
  hasActiveWorktreeLease,
  acquireLease = acquireWorkspaceLease,
  recordPr,
  platform,
  inspectProcesses,
  roomBindings,
} = {}) {
  const audit = await auditMergedWorktrees({
    roomBindings,
    repoRoot,
    env,
    targetBranch,
    execFileSyncFn,
    portsApi,
    scanRoots,
    currentDir,
    hasActiveWorktreeLease,
    platform,
    inspectProcesses,
  });
  const report = {
    mode: "merged",
    repoRoot: audit.repoRoot,
    targetBranch: audit.base,
    dryRun,
    error: audit.error ?? null,
    eligible: audit.entries.filter((entry) => entry.eligible),
    kept: audit.entries.filter((entry) => !entry.eligible),
    quarantined: [],
    recovered: [],
    pendingJournals: audit.journals
      .filter(({ journal }) => NON_TERMINAL_JOURNAL.has(journal.state))
      .map(({ journal }) => ({ id: journal.id, state: journal.state, source: journal.source })),
    bytesReclaimed: 0,
  };
  if (dryRun || audit.error) return report;

  const repoLease = await acquireLease(audit.repoRoot, { env, namespace: "cleanup-merged" });
  if (!repoLease.acquired) {
    report.error = "cleanup_busy";
    return report;
  }
  try {
    report.recovered = await recoverQuarantines({
      repoRoot: audit.repoRoot,
      env,
      execFileSyncFn,
      portsApi,
    });
    const roots = (scanRoots ?? defaultScanRoots(audit.repoRoot, env)).map(realOrResolved);
    const keptAfter = [...report.kept];
    const candidates = report.eligible;
    report.eligible = [];
    for (const candidate of candidates) {
      const lease = await acquireLease(candidate.path, { env });
      if (!lease.acquired) {
        keptAfter.push({ ...candidate, eligible: false, reasons: ["lease_held"] });
        continue;
      }
      try {
        // Revalidate identity and evidence under the exclusive lease, immediately before acting.
        const fresh = parseWorktreeList(
          git(execFileSyncFn, audit.repoRoot, ["worktree", "list", "--porcelain"], env),
        ).find((entry) => realOrResolved(entry.path) === candidate.path);
        const evaluation = fresh
          ? await evaluateMergedWorktree(fresh, {
              repoRoot: audit.repoRoot,
              env,
              run: execFileSyncFn,
              explicitBase: audit.base,
              rooms: await loadRoomBindings(env, roomBindings),
              platform,
              inspectProcesses,
              gh: makeGh(execFileSyncFn, { cwd: audit.repoRoot, env }),
              portsApi: await loadPortsApi(portsApi),
              scanRoots: roots,
              currentDir: realOrResolved(currentDir),
              repository: audit.repository,
              // Re-read every lease holder, ignoring exactly the holders this operation just acquired.
              cache: {
                leaseCheck: hasActiveWorktreeLease
                  ? makeLeaseCheck(cacheHome(env), hasActiveWorktreeLease, [candidate.path])
                  : null,
              },
            })
          : null;
        if (
          !evaluation?.eligible ||
          !isSameIdentity(evaluation.identity, candidate.identity) ||
          evaluation.head !== candidate.head ||
          evaluation.branch !== candidate.branch
        ) {
          keptAfter.push({
            ...candidate,
            eligible: false,
            reasons: evaluation?.reasons?.length ? evaluation.reasons : ["changed_before_action"],
          });
          continue;
        }
        if (recordPr && evaluation.evidence?.kind === "merged_pr") {
          try {
            await recordPr(evaluation.path, evaluation.evidence.pr);
          } catch {
            keptAfter.push({ ...candidate, eligible: false, reasons: ["pr_state_unrecorded"] });
            continue;
          }
        }
        const outcome = await quarantineMergedWorktree({
          repoRoot: audit.repoRoot,
          evaluation,
          env,
          execFileSyncFn,
          portsApi,
          lease,
        });
        if (["quarantined", "quarantined_ports_pending"].includes(outcome.status)) {
          report.quarantined.push(outcome);
        } else
          keptAfter.push({
            ...candidate,
            eligible: false,
            reasons: outcome.reasons ?? [outcome.status],
          });
      } finally {
        await lease.release();
      }
    }
    report.kept = keptAfter;
  } finally {
    await repoLease.release();
  }
  return report;
}

export function formatMergedCleanupReport(report) {
  const lines = [
    `Orkest Cleanup --merged (${report.dryRun ? "dry-run" : "run"}) base=${report.targetBranch ?? "unknown"}`,
    `  Quarantined: ${report.quarantined.length}, eligible: ${report.eligible.length}, kept: ${report.kept.length}`,
    "  Bytes reclaimed: 0 (nothing is deleted)",
  ];
  if (report.error) lines.push(`  Error: ${report.error}`);
  for (const item of report.eligible) {
    lines.push(
      `  would quarantine ${item.path} [${item.branch} @ ${String(item.head).slice(0, 12)}] -> ${item.quarantine.destination}`,
      `    restore: ${item.recovery.text}`,
    );
  }
  for (const item of report.quarantined) {
    lines.push(
      `  quarantined ${item.path} [${item.branch}] -> ${item.destination}`,
      `    restore: ${item.recovery.text}`,
    );
  }
  for (const item of report.kept) {
    lines.push(`  kept ${item.path}: ${item.reasons.join(", ")}`);
  }
  return `${lines.join("\n")}\n`;
}
