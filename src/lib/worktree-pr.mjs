/** Pull-request identity, verification and recovery for worktree integration. */
import { execFileSync } from "node:child_process";

import { writeFoundryState } from "./foundry.mjs";

export const PR_STATES = Object.freeze(["OPEN", "MERGED", "CLOSED", "UNKNOWN"]);

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
