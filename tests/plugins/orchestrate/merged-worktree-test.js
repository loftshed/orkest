import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  auditMergedWorktrees,
  listJournals,
  matchPullRequest,
  mergedCleanup,
  normalizePrState,
  parseStrategy,
  pruneMergedWorktree,
  quarantineRoot,
  recoverQuarantines,
} from "../../../plugins/orchestrate/lib/merged-worktree.mjs";
import { acquireWorkspaceLease } from "../../../plugins/orchestrate/lib/workspace-lease.mjs";
import { retainFixtures } from "../../helpers/retain-fixtures.js";

const temporary = [];

async function makeTempDir(prefix = "ork-merged-test-") {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  temporary.push(dir);
  return dir;
}

afterEach(async () => {
  process.exitCode = 0;
  await retainFixtures(temporary.splice(0));
});

const GIT_ID = ["-c", "user.name=Merged Test", "-c", "user.email=merged@example.invalid"];

function git(cwd, ...args) {
  return execFileSync("git", [...GIT_ID, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** A repository whose `.worktrees/<slug>` holds an Orkest-owned worktree on its own branch. */
async function makeFixture({ slug = "wt-1", merge = "ff", marker = {} } = {}) {
  const root = await makeTempDir();
  const repoRoot = path.join(root, "repo");
  await mkdir(repoRoot, { recursive: true });
  git(repoRoot, "init", "-b", "main");
  writeFileSync(path.join(repoRoot, "README.md"), "base\n");
  writeFileSync(path.join(repoRoot, ".gitignore"), ".worktrees/\nignored*.log\n");
  git(repoRoot, "add", ".");
  git(repoRoot, "commit", "-m", "base");
  const worktreePath = path.join(repoRoot, ".worktrees", slug);
  const branch = `feat/${slug.replaceAll(/[^\w-]/gu, "-")}`;
  git(repoRoot, "worktree", "add", "-b", branch, worktreePath, "main");
  writeFileSync(path.join(worktreePath, "feature.txt"), "feature\n");
  git(worktreePath, "add", "feature.txt");
  git(worktreePath, "commit", "-m", "feature");
  const gitDir = git(worktreePath, "rev-parse", "--absolute-git-dir");
  writeFileSync(
    path.join(gitDir, "orkest.json"),
    JSON.stringify({ branch, disposable: true, parentCwd: repoRoot, slug, ...marker }),
  );
  if (merge === "ff") git(repoRoot, "merge", "--ff-only", branch);
  const cache = path.join(root, "cache");
  const env = { ...process.env, ORCHESTRATE_HOME: cache };
  return {
    branch,
    cache,
    env,
    gitDir,
    head: git(worktreePath, "rev-parse", "HEAD"),
    repoRoot,
    root,
    slug,
    worktreePath,
  };
}

/**
 * In-memory stand-in for 4A's worktree-ports API (worktreePortKey/list/release by key, plus fences that
 * block allocation). `events` records the order of calls for sequencing assertions.
 */
function makePorts(initial = {}) {
  const table = new Map(Object.entries(initial));
  const fences = new Set();
  const asText = (key) => `${key.repoKey}\0${key.worktreePath}`;
  const api = {
    table,
    fences,
    events: [],
    releases: [],
    worktreePortKey(repoRoot, worktreePath) {
      const resolved = path.resolve(worktreePath);
      const canonical = existsSync(resolved)
        ? realpath(resolved)
        : path.join(realpath(path.dirname(resolved)), path.basename(resolved));
      return { repoKey: realpath(repoRoot), worktreePath: canonical };
    },
    listWorktreePorts({ key }) {
      return table.get(asText(key)) ?? [];
    },
    fenceWorktreePorts({ key }) {
      api.events.push(["fence", asText(key), existsSync(key.worktreePath)]);
      fences.add(asText(key));
      return { fenced: true };
    },
    clearWorktreePortFence({ key }) {
      api.events.push(["unfence", asText(key)]);
      return { unfenced: fences.delete(asText(key)) };
    },
    releaseWorktreePorts({ key }) {
      api.events.push(["release", asText(key)]);
      api.releases.push(asText(key));
      const released = (table.get(asText(key)) ?? []).length;
      table.delete(asText(key));
      return { released };
    },
    /** What 4A's allocation does: refuse while the identity is fenced. */
    allocate(key, ports) {
      if (fences.has(asText(key))) throw new Error("ORK_PORTS_FENCED");
      table.set(asText(key), ports);
    },
    key: (fixture, worktreePath = fixture.worktreePath) =>
      `${realpath(fixture.repoRoot)}\0${realpath(worktreePath)}`,
  };
  return api;
}

function realpath(target) {
  return execFileSync("realpath", [target], { encoding: "utf8" }).trim();
}

function treeDigest(root) {
  const hash = createHash("sha256");
  const walk = (dir) => {
    const names = readdirSync(dir).toSorted((a, b) => a.localeCompare(b));
    for (const name of names) {
      const full = path.join(dir, name);
      const info = lstatSync(full);
      hash.update(
        `${path.relative(root, full)}|${info.mode}|${info.size}|${info.mtimeMs}|${info.ino}\n`,
      );
      if (info.isSymbolicLink()) hash.update(readlinkSync(full));
      else if (info.isDirectory()) walk(full);
      else hash.update(readFileSync(full));
    }
  };
  if (existsSync(root)) walk(root);
  return hash.digest("hex");
}

const hasNoLeases = () => false;
/** Dry-run reasons for a fixture, with optional extra options. */
async function dryReasons(fixture, extra = {}) {
  const report = await mergedCleanup(options(fixture, { dryRun: true, ...extra }));
  return { report, reasons: entryFor(report, fixture)?.reasons ?? [] };
}
const options = (fixture, extra = {}) => ({
  portsApi: makePorts(),
  repoRoot: fixture.repoRoot,
  env: fixture.env,
  targetBranch: "main",
  currentDir: fixture.repoRoot,
  hasActiveWorktreeLease: hasNoLeases,
  ...extra,
});

function entryFor(report, fixture) {
  const all = [...(report.eligible ?? []), ...(report.kept ?? []), ...(report.entries ?? [])];
  return all.find((entry) => entry.path === realpath(fixture.worktreePath));
}

describe("strategy and PR identity parsing", () => {
  it("accepts only local and pr, and rejects everything else with exit code 2", () => {
    expect(parseStrategy()).toBeUndefined();
    expect(parseStrategy("local")).toBe("local");
    expect(parseStrategy("pr")).toBe("pr");
    for (const bad of ["", "PR", "squash", "local ", 1]) {
      expect(() => parseStrategy(bad)).toThrow(expect.objectContaining({ exitCode: 2 }));
    }
  });

  it("normalizes states and matches only an exact repository, base, head ref and commit", () => {
    expect(normalizePrState("merged")).toBe("MERGED");
    expect(normalizePrState("DRAFT")).toBe("UNKNOWN");
    const identity = {
      repository: "acme/widgets",
      baseBranch: "main",
      headBranch: "f",
      headOid: "abc",
    };
    const item = {
      number: 9,
      url: "https://github.com/acme/widgets/pull/9",
      state: "OPEN",
      baseRefName: "main",
      headRefName: "f",
      headRefOid: "abc",
      isCrossRepository: false,
    };
    expect(matchPullRequest(item, identity)).toMatchObject({
      number: 9,
      createdAt: null,
      updatedAt: null,
    });
    for (const change of [
      { number: 0 },
      { number: 1.5 },
      { baseRefName: "dev" },
      { headRefName: "g" },
      { headRefOid: "abd" },
      { isCrossRepository: true },
      { url: ["http", "://github.com/acme/widgets/pull/9"].join("") },
      { url: "https://github.com/other/widgets/pull/9" },
      { url: "https://github.com/acme/widgets/pull/8" },
    ]) {
      expect(matchPullRequest({ ...item, ...change }, identity)).toBeNull();
    }
  });
});

describe("cleanup --merged audit", () => {
  it("reports an exact plan for a fast-forward merged worktree and writes nothing (byte parity)", async () => {
    const fixture = await makeFixture();
    const ports = makePorts();
    ports.table.set(ports.key(fixture), [{ name: "WEB_PORT", port: 31_042 }]);
    const before = [treeDigest(fixture.repoRoot), treeDigest(fixture.cache)];
    const report = await mergedCleanup(options(fixture, { dryRun: true, portsApi: ports }));
    expect([treeDigest(fixture.repoRoot), treeDigest(fixture.cache)]).toEqual(before);
    expect(existsSync(quarantineRoot(fixture.env))).toBe(false);
    expect(report.error).toBeNull();
    expect(report.eligible).toHaveLength(1);
    const [entry] = report.eligible;
    expect(entry).toMatchObject({
      path: realpath(fixture.worktreePath),
      branch: fixture.branch,
      head: fixture.head,
      base: "main",
      eligible: true,
      reasons: [],
      ports: [{ name: "WEB_PORT", port: 31_042 }],
      evidence: { kind: "ancestor" },
    });
    expect(entry.quarantine.destination.startsWith(quarantineRoot(fixture.env))).toBe(true);
    expect(entry.recovery.command).toEqual([
      "git",
      "-C",
      realpath(fixture.repoRoot),
      "worktree",
      "move",
      entry.quarantine.destination,
      entry.path,
    ]);
    expect(report.bytesReclaimed).toBe(0);
    expect(ports.releases).toEqual([]);
  });

  it("keeps everything it cannot prove: unmerged, dirty, locked, detached, unowned, room-owned", async () => {
    const cases = {
      unmerged: await makeFixture({ slug: "unmerged", merge: "none" }),
      dirty: await makeFixture({ slug: "dirty" }),
      locked: await makeFixture({ slug: "locked" }),
      detached: await makeFixture({ slug: "detached" }),
      unowned: await makeFixture({ slug: "unowned" }),
      room: await makeFixture({ slug: "room", marker: { roomId: "room-1" } }),
      keep: await makeFixture({ slug: "keep", marker: { disposable: false } }),
    };
    writeFileSync(path.join(cases.dirty.worktreePath, "scratch.txt"), "work\n");
    git(cases.locked.repoRoot, "worktree", "lock", cases.locked.worktreePath);
    git(cases.detached.worktreePath, "checkout", "--detach");
    writeFileSync(path.join(cases.unowned.gitDir, "orkest.json"), "not json");
    const expected = {
      unmerged: "merge_unverified",
      dirty: "dirty",
      locked: "git_locked",
      detached: "no_branch",
      unowned: "not_orkest_owned",
      room: "room_state_unknown",
      keep: "not_disposable",
    };
    for (const [name, fixture] of Object.entries(cases)) {
      const report = await mergedCleanup(options(fixture, { dryRun: true }));
      expect(report.eligible, name).toEqual([]);
      expect(entryFor(report, fixture).reasons, name).toContain(expected[name]);
    }
  });

  it("never treats the main checkout, the current worktree or paths outside the roots as candidates", async () => {
    const fixture = await makeFixture();
    const currentDir = path.join(fixture.worktreePath, "sub");
    mkdirSync(currentDir);
    const current = await mergedCleanup(options(fixture, { dryRun: true, currentDir }));
    expect(entryFor(current, fixture).reasons).toContain("current_worktree");
    const narrowed = await mergedCleanup(
      options(fixture, { dryRun: true, scanRoots: [path.join(fixture.root, "elsewhere")] }),
    );
    expect(entryFor(narrowed, fixture).reasons).toContain("outside_scan_roots");
    const audit = await auditMergedWorktrees(options(fixture));
    expect(audit.entries.map((entry) => entry.path)).not.toContain(realpath(fixture.repoRoot));
  });

  it("proves a squash merge only through a verified merged PR with the same head commit", async () => {
    const fixture = await makeFixture({ merge: "none" });
    git(fixture.repoRoot, "remote", "add", "origin", "https://github.com/acme/widgets.git");
    const pr = (overrides = {}) => ({
      number: 12,
      url: "https://github.com/acme/widgets/pull/12",
      state: "MERGED",
      baseRefName: "main",
      headRefName: fixture.branch,
      headRefOid: fixture.head,
      isCrossRepository: false,
      ...overrides,
    });
    const withGh = (listed) => (cmd, args, opts) => {
      if (cmd === "gh") {
        if (listed instanceof Error) throw listed;
        return JSON.stringify(listed);
      }
      return execFileSync(cmd, args, opts);
    };
    const run = (execFileSyncFn) =>
      mergedCleanup(options(fixture, { dryRun: true, execFileSyncFn }));

    const merged = await run(withGh([pr()]));
    expect(merged.eligible[0].evidence).toMatchObject({ kind: "merged_pr", pr: { number: 12 } });
    // A squash merged earlier head, closed PRs, other bases and failed queries are never evidence.
    for (const listed of [
      [pr({ headRefOid: "0".repeat(40) })],
      [pr({ state: "CLOSED" })],
      [pr({ state: "OPEN" })],
      [pr({ baseRefName: "release" })],
      [],
      [pr(), pr({ number: 13, url: "https://github.com/acme/widgets/pull/13" })],
      Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }),
      new Error("network down"),
    ]) {
      const report = await run(withGh(listed));
      expect(report.eligible, JSON.stringify(listed)).toEqual([]);
    }
    const enoent = Object.assign(new Error("x"), { code: "ENOENT" });
    const missing = await run(withGh(enoent));
    expect(entryFor(missing, fixture).reasons).toContain("gh_missing");
  });

  it("keeps a worktree whose relative symlink would resolve differently after the move", async () => {
    const fixture = await makeFixture();
    symlinkSync("../../outside.txt", path.join(fixture.worktreePath, "escape-link"));
    symlinkSync("feature.txt", path.join(fixture.worktreePath, "inner-link"));
    // Untracked links make the tree dirty; add them so only the symlink rule decides.
    git(fixture.worktreePath, "add", "escape-link", "inner-link");
    git(fixture.worktreePath, "commit", "-m", "links");
    git(fixture.repoRoot, "merge", "--ff-only", fixture.branch);
    const report = await mergedCleanup(options(fixture, { dryRun: true }));
    const entry = entryFor(report, fixture);
    expect(entry.reasons).toContain("symlink_would_change");
    expect(entry.unsafeSymlinks).toEqual(["escape-link"]);
  });
});

describe("cleanup --merged quarantine", () => {
  it("moves the worktree intact, releases its ports once, and can be restored by git worktree move", async () => {
    const fixture = await makeFixture();
    const worktree = fixture.worktreePath;
    writeFileSync(path.join(worktree, "ignored.log"), "ignored user data\n");
    git(fixture.repoRoot, "check-ignore", "-q", "ignored.log");
    // A tracked symlink and a hard link pair whose relationship must survive.
    symlinkSync("feature.txt", path.join(worktree, "link-to-feature"));
    git(worktree, "add", "link-to-feature");
    git(worktree, "commit", "-m", "link");
    git(fixture.repoRoot, "merge", "--ff-only", fixture.branch);
    linkSync(path.join(worktree, "ignored.log"), path.join(worktree, "ignored-hard.log"));
    const held = openSync(path.join(worktree, "ignored.log"), "r");
    const inodeBefore = statSync(path.join(worktree, "ignored.log")).ino;
    const ports = makePorts();
    ports.table.set(ports.key(fixture), [{ name: "WEB_PORT", port: 31_042 }]);
    const head = git(worktree, "rev-parse", "HEAD");

    const report = await mergedCleanup(
      options(fixture, { dryRun: false, portsApi: ports, execFileSyncFn: spyGit() }),
    );
    expect(report.error).toBeNull();
    expect(JSON.stringify(report.kept.map((k) => k.reasons))).toBe("[]");
    expect(report.quarantined).toHaveLength(1);
    const [done] = report.quarantined;
    expect(existsSync(worktree)).toBe(false);
    expect(done).toMatchObject({
      status: "quarantined",
      bytesReclaimed: 0,
      branch: fixture.branch,
      head,
    });
    const moved = done.destination;
    // Contents, ignored files, symlink spelling and hard-link relationship are intact.
    expect(readFileSync(path.join(moved, "feature.txt"), "utf8")).toBe("feature\n");
    expect(readFileSync(path.join(moved, "ignored.log"), "utf8")).toBe("ignored user data\n");
    expect(readlinkSync(path.join(moved, "link-to-feature"))).toBe("feature.txt");
    expect(statSync(path.join(moved, "ignored.log")).ino).toBe(inodeBefore);
    expect(statSync(path.join(moved, "ignored-hard.log")).ino).toBe(inodeBefore);
    expect(statSync(path.join(moved, "ignored.log")).nlink).toBe(2);
    expect(readFileSync(held, "utf8")).toBe("ignored user data\n");
    // Git still registers it, branch intact, marker retained.
    const listing = git(fixture.repoRoot, "worktree", "list", "--porcelain");
    expect(listing).toContain(`worktree ${realpath(moved)}`);
    expect(git(fixture.repoRoot, "rev-parse", `refs/heads/${fixture.branch}`)).toBe(head);
    expect(existsSync(path.join(fixture.gitDir, "orkest.json"))).toBe(true);
    // Ports released exactly once; the journal is final and private.
    expect(ports.releases).toEqual([ports.key(fixture)]);
    const [{ file, journal }] = listJournals(fixture.repoRoot, fixture.env);
    expect(journal.state).toBe("finalized");
    expect(journal.ports).toEqual([{ name: "WEB_PORT", port: 31_042 }]);
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
    expect(lstatSync(path.dirname(file)).mode & 0o777).toBe(0o700);

    // A second run is a no-op: nothing eligible, no repeated release.
    const again = await mergedCleanup(options(fixture, { portsApi: ports, dryRun: false }));
    expect(again.quarantined).toEqual([]);
    expect(ports.releases).toHaveLength(1);

    // Restore exactly as instructed.
    execFileSync(done.recovery.command[0], done.recovery.command.slice(1));
    expect(readFileSync(path.join(worktree, "feature.txt"), "utf8")).toBe("feature\n");
    expect(statSync(path.join(worktree, "ignored.log")).ino).toBe(inodeBefore);
    expect(git(worktree, "rev-parse", "--abbrev-ref", "HEAD")).toBe(fixture.branch);
  });

  it("never removes, deletes, prunes or forces anything", async () => {
    const fixture = await makeFixture();
    const calls = [];
    const spy = (cmd, args, opts) => {
      calls.push([cmd, ...args]);
      return execFileSync(cmd, args, opts);
    };
    const report = await mergedCleanup(options(fixture, { dryRun: false, execFileSyncFn: spy }));
    expect(report.quarantined).toHaveLength(1);
    const text = calls.map((call) => call.join(" "));
    expect(
      text.some((line) =>
        /worktree remove|worktree prune|branch -[dD]|update-ref -d|--force|-f\b/u.test(line),
      ),
    ).toBe(false);
    expect(text.some((line) => line.includes("worktree move"))).toBe(true);
  });

  it("keeps instead of acting when the worktree changes or its lease is held", async () => {
    const fixture = await makeFixture();
    const lease = await acquireWorkspaceLease(realpath(fixture.worktreePath), { env: fixture.env });
    expect(lease.acquired).toBe(true);
    try {
      const report = await mergedCleanup(options(fixture, { dryRun: false }));
      expect(report.quarantined).toEqual([]);
      expect(entryFor(report, fixture).reasons).toContain("lease_held");
      expect(existsSync(fixture.worktreePath)).toBe(true);
    } finally {
      await lease.release();
    }
    // Revalidation happens after the lease: a worktree dirtied between audit and action is kept.
    const dirtyAfterAudit = await makeFixture({ slug: "late" });
    let isArmed = true;
    const dirtyingGit = (cmd, args, opts) => {
      if (isArmed && args[0] === "worktree" && args[1] === "list") {
        isArmed = false;
        const out = execFileSync(cmd, args, opts);
        writeFileSync(path.join(dirtyAfterAudit.worktreePath, "late.txt"), "late\n");
        return out;
      }
      return execFileSync(cmd, args, opts);
    };
    const late = await mergedCleanup(
      options(dirtyAfterAudit, { dryRun: false, execFileSyncFn: dirtyingGit }),
    );
    expect(late.quarantined).toEqual([]);
    expect(existsSync(path.join(dirtyAfterAudit.worktreePath, "late.txt"))).toBe(true);
  });

  it("recovers a crash between the move and the journal update, and resumes port release", async () => {
    const fixture = await makeFixture();
    const ports = makePorts();
    ports.table.set(ports.key(fixture), [{ name: "API_PORT", port: 31_100 }]);
    // Crash: git moved the directory, then the process died before recording anything.
    const crashing = (cmd, args, opts) => {
      const out = execFileSync(cmd, args, opts);
      if (args[0] === "worktree" && args[1] === "move") throw new Error("simulated crash");
      return out;
    };
    const first = await mergedCleanup(
      options(fixture, { dryRun: false, portsApi: ports, execFileSyncFn: crashing }),
    );
    expect(first.quarantined).toEqual([]);
    expect(existsSync(fixture.worktreePath)).toBe(false);
    expect(listJournals(fixture.repoRoot, fixture.env)[0].journal.state).toBe("intent");
    expect(ports.releases).toEqual([]);

    const status = await mergedCleanup(options(fixture, { dryRun: true, portsApi: ports }));
    expect(status.pendingJournals).toHaveLength(1);

    const recovered = await recoverQuarantines({
      repoRoot: fixture.repoRoot,
      env: fixture.env,
      portsApi: ports,
    });
    expect(recovered).toMatchObject([{ status: "quarantined" }]);
    expect(ports.releases).toEqual([ports.key(fixture)]);
    expect(listJournals(fixture.repoRoot, fixture.env)[0].journal.state).toBe("finalized");
    // Idempotent: nothing left to do and no second release.
    expect(
      await recoverQuarantines({ repoRoot: fixture.repoRoot, env: fixture.env, portsApi: ports }),
    ).toEqual([]);
    expect(ports.releases).toHaveLength(1);
  });

  it("fences the original identity before the move so a replacement at the old path cannot inherit ports", async () => {
    const fixture = await makeFixture();
    const ports = makePorts();
    ports.table.set(ports.key(fixture), [{ name: "API_PORT", port: 31_100 }]);
    let isFailing = true;
    const flaky = {
      ...ports,
      releaseWorktreePorts(args) {
        if (isFailing) throw new Error("database busy");
        return ports.releaseWorktreePorts(args);
      },
    };
    const first = await mergedCleanup(options(fixture, { dryRun: false, portsApi: flaky }));
    // The fence was installed while the source still existed, i.e. before the move.
    expect(ports.events[0]).toEqual(["fence", ports.key(fixture), true]);
    // The directory already moved: it is reported as moved-pending, not as kept.
    expect(first.kept).toEqual([]);
    expect(first.quarantined).toMatchObject([
      {
        status: "quarantined_ports_pending",
        bytesReclaimed: 0,
        pendingPorts: [{ name: "API_PORT", port: 31_100 }],
      },
    ]);
    expect(first.quarantined[0].recovery.command[4]).toBe("move");
    expect(existsSync(first.quarantined[0].destination)).toBe(true);
    expect(listJournals(fixture.repoRoot, fixture.env)[0].journal.state).toBe("moved");
    expect(ports.fences.has(ports.key(fixture))).toBe(true);

    // A different worktree at the vacated path cannot allocate, so it cannot inherit or clobber ports.
    git(fixture.repoRoot, "worktree", "add", "-b", "feat/reuse", fixture.worktreePath, "main");
    const replacementKey = ports.worktreePortKey(fixture.repoRoot, fixture.worktreePath);
    expect(() => ports.allocate(replacementKey, [{ name: "NEW_PORT", port: 31_999 }])).toThrow(
      /FENCED/u,
    );
    expect(ports.table.get(ports.key(fixture))).toEqual([{ name: "API_PORT", port: 31_100 }]);

    // Recovery releases exactly the pinned original allocation and only then lifts the fence.
    isFailing = false;
    const recovered = await recoverQuarantines({
      repoRoot: fixture.repoRoot,
      env: fixture.env,
      portsApi: ports,
    });
    expect(recovered).toMatchObject([{ status: "quarantined" }]);
    expect(ports.events.slice(-2).map((event) => event[0])).toEqual(["release", "unfence"]);
    expect(ports.fences.size).toBe(0);
    expect(ports.table.has(ports.key(fixture))).toBe(false);
    // The replacement can allocate now, and repeating recovery never touches its ports.
    ports.allocate(replacementKey, [{ name: "NEW_PORT", port: 31_999 }]);
    expect(
      await recoverQuarantines({ repoRoot: fixture.repoRoot, env: fixture.env, portsApi: ports }),
    ).toEqual([]);
    expect(ports.table.get(ports.key(fixture))).toEqual([{ name: "NEW_PORT", port: 31_999 }]);
  });

  it("fences even a worktree with no allocated ports, and leaves no fence after success", async () => {
    const fixture = await makeFixture();
    const ports = makePorts();
    const report = await mergedCleanup(options(fixture, { dryRun: false, portsApi: ports }));
    expect(report.quarantined).toHaveLength(1);
    expect(ports.events.map((event) => event[0])).toEqual(["fence", "release", "unfence"]);
    expect(ports.fences.size).toBe(0);
    // A fence that cannot be installed keeps the worktree in place.
    const other = await makeFixture({ slug: "unfenceable" });
    const broken = {
      ...makePorts(),
      fenceWorktreePorts() {
        throw new Error("fence database busy");
      },
    };
    const kept = await mergedCleanup(options(other, { dryRun: false, portsApi: broken }));
    expect(kept.quarantined).toEqual([]);
    expect(entryFor(kept, other).reasons).toEqual(["ports_fence_failed"]);
    expect(existsSync(other.worktreePath)).toBe(true);
  });

  it("lifts the fence when the move itself fails, and refuses an incomplete ports API", async () => {
    const fixture = await makeFixture();
    const ports = makePorts();
    const refusing = (cmd, args, opts) => {
      if (args[0] === "worktree" && args[1] === "move") throw new Error("git refused");
      return execFileSync(cmd, args, opts);
    };
    await mergedCleanup(
      options(fixture, { dryRun: false, portsApi: ports, execFileSyncFn: refusing }),
    );
    expect(ports.fences.size).toBe(0);
    expect(ports.releases).toEqual([]);
    const other = await makeFixture({ slug: "old-api" });
    const oldApi = { listWorktreePorts: () => [], releaseWorktreePorts: () => ({ released: 0 }) };
    const report = await mergedCleanup(options(other, { dryRun: true, portsApi: oldApi }));
    expect(entryFor(report, other).reasons).toContain("ports_fence_unavailable");
  });

  it("retains a changed destination registration while recovering interrupted port release", async () => {
    const fixture = await makeFixture();
    const ports = makePorts();
    const failing = {
      ...ports,
      releaseWorktreePorts() {
        throw new Error("temporarily busy");
      },
    };
    const first = await mergedCleanup(options(fixture, { dryRun: false, portsApi: failing }));
    const destination = first.quarantined[0].destination;
    git(destination, "switch", "-c", "other");
    const recovered = await recoverQuarantines({ ...options(fixture), portsApi: ports });
    expect(recovered).toMatchObject([{ status: "needs_review", current: { branch: "other" } }]);
    expect(ports.fences.size).toBe(1);
    expect(ports.releases).toEqual([]);
  });

  it("retries an aborted move whose original fence could not be cleared", async () => {
    const fixture = await makeFixture();
    const ports = makePorts();
    const failing = {
      ...ports,
      clearWorktreePortFence() {
        throw new Error("temporarily busy");
      },
    };
    const refusing = (cmd, args, opts) => {
      if (args[0] === "worktree" && args[1] === "move") throw new Error("move refused");
      return execFileSync(cmd, args, opts);
    };
    await mergedCleanup(
      options(fixture, { dryRun: false, portsApi: failing, execFileSyncFn: refusing }),
    );
    expect(ports.fences.size).toBe(1);
    const recovered = await recoverQuarantines({ ...options(fixture), portsApi: ports });
    expect(recovered).toMatchObject([{ status: "aborted" }]);
    expect(ports.fences.size).toBe(0);
    expect(ports.releases).toEqual([]);
    expect(existsSync(fixture.worktreePath)).toBe(true);
  });

  it("leaves an aborted intent alone when git never moved anything", async () => {
    const fixture = await makeFixture();
    const refusing = (cmd, args, opts) => {
      if (args[0] === "worktree" && args[1] === "move") throw new Error("git refused");
      return execFileSync(cmd, args, opts);
    };
    const report = await mergedCleanup(
      options(fixture, { dryRun: false, execFileSyncFn: refusing }),
    );
    expect(report.quarantined).toEqual([]);
    expect(report.kept[0].reasons).toEqual(["move_failed"]);
    expect(existsSync(fixture.worktreePath)).toBe(true);
    expect(listJournals(fixture.repoRoot, fixture.env)[0].journal.state).toBe("aborted");
  });
});

function spyGit() {
  return (cmd, args, opts) => execFileSync(cmd, args, opts);
}

describe("cleanup --merged review cases", () => {
  it("requires positively matching ownership: marker branch, parent checkout, recorded base", async () => {
    const cases = {
      renamed: await makeFixture({ slug: "renamed", marker: { branch: "feat/other" } }),
      parent: await makeFixture({ slug: "parent", marker: { parentCwd: "/somewhere/else" } }),
      noParent: await makeFixture({ slug: "no-parent", marker: { parentCwd: undefined } }),
      notTrue: await makeFixture({ slug: "not-true", marker: { disposable: "yes" } }),
      base: await makeFixture({ slug: "base", marker: { targetBranch: "release" } }),
      corrupt: await makeFixture({ slug: "corrupt" }),
    };
    mkdirSync(path.join(cases.corrupt.gitDir, "orkest"), { recursive: true });
    writeFileSync(path.join(cases.corrupt.gitDir, "orkest", "foundry-state.json"), "{ not json");
    const expected = {
      renamed: "marker_branch_mismatch",
      parent: "marker_parent_mismatch",
      noParent: "marker_parent_mismatch",
      notTrue: "not_disposable",
      base: "base_mismatch",
      corrupt: "foundry_state_unreadable",
    };
    for (const [name, fixture] of Object.entries(cases)) {
      const report = await mergedCleanup(options(fixture, { dryRun: true }));
      expect(entryFor(report, fixture).reasons, name).toContain(expected[name]);
      expect(report.eligible, name).toEqual([]);
    }
    // Without any recorded or requested base nothing is assumed.
    const unknownBase = await makeFixture({ slug: "unknown-base" });
    const report = await mergedCleanup(
      options(unknownBase, { dryRun: true, targetBranch: undefined }),
    );
    expect(entryFor(report, unknownBase).reasons).toContain("base_unknown");
    // A recorded base is accepted without an explicit one.
    const recorded = await makeFixture({ slug: "recorded", marker: { targetBranch: "main" } });
    const accepted = await mergedCleanup(
      options(recorded, { dryRun: true, targetBranch: undefined }),
    );
    expect(accepted.eligible).toHaveLength(1);
  });

  it("keeps a worktree while a live process works inside it, and when process status is unknown", async () => {
    const fixture = await makeFixture();
    const child = spawn("sleep", ["30"], { cwd: fixture.worktreePath, stdio: "ignore" });
    try {
      const busy = await mergedCleanup(options(fixture, { dryRun: true }));
      expect(entryFor(busy, fixture).reasons).toContain("process_active");
    } finally {
      child.kill();
    }
    const unknown = await mergedCleanup(
      options(fixture, {
        dryRun: true,
        inspectProcesses: () => ({ inspectable: false, active: false }),
      }),
    );
    expect(entryFor(unknown, fixture).reasons).toContain("process_status_unknown");
    // macOS has no /proc: the lsof path is exercised through an injected runner.
    const lsof = (output, fail) => (cmd, args, opts) => {
      if (cmd !== "lsof") return execFileSync(cmd, args, opts);
      if (fail) throw Object.assign(new Error("lsof: not found"), { code: "ENOENT" });
      return output;
    };
    const busyOutput = ["p4242", `n${realpath(fixture.worktreePath)}/sub`, ""].join("\n");
    const darwinBusy = await mergedCleanup(
      options(fixture, {
        dryRun: true,
        platform: "darwin",
        execFileSyncFn: lsof(busyOutput),
      }),
    );
    expect(entryFor(darwinBusy, fixture).reasons).toContain("process_active");
    const darwinClear = await mergedCleanup(
      options(fixture, { dryRun: true, platform: "darwin", execFileSyncFn: lsof("p1\nn/\n") }),
    );
    expect(darwinClear.eligible).toHaveLength(1);
    const darwinUnknown = await mergedCleanup(
      options(fixture, { dryRun: true, platform: "darwin", execFileSyncFn: lsof("", true) }),
    );
    expect(entryFor(darwinUnknown, fixture).reasons).toContain("process_status_unknown");
  });

  it("keeps trees whose absolute or aliased links would dangle, and proves link targets after a move", async () => {
    const absolute = await makeFixture({ slug: "absolute" });
    symlinkSync(
      path.join(absolute.worktreePath, "feature.txt"),
      path.join(absolute.worktreePath, "ignored.log"),
    );
    const aliased = await makeFixture({ slug: "aliased" });
    symlinkSync(
      path.join(aliased.worktreePath, "feature.txt"),
      path.join(aliased.root, "outside-alias"),
    );
    symlinkSync(
      path.join(aliased.root, "outside-alias"),
      path.join(aliased.worktreePath, "ignored.log"),
    );
    for (const fixture of [absolute, aliased]) {
      const report = await mergedCleanup(options(fixture, { dryRun: true }));
      const entry = entryFor(report, fixture);
      expect(entry.reasons).toContain("symlink_would_change");
      expect(entry.unsafeSymlinks).toEqual(["ignored.log"]);
      const run = await mergedCleanup(options(fixture, { dryRun: false }));
      expect(run.quarantined).toEqual([]);
      expect(existsSync(fixture.worktreePath)).toBe(true);
    }
    // A safe relative link to a file outside keeps pointing at the same inode after the move.
    const safe = await makeFixture({ slug: "safe" });
    const outside = path.join(safe.root, "shared.txt");
    writeFileSync(outside, "shared\n");
    const inode = statSync(outside).ino;
    symlinkSync(outside, path.join(safe.root, "alias-to-shared"));
    symlinkSync("feature.txt", path.join(safe.worktreePath, "ignored.log"));
    const moved = await mergedCleanup(options(safe, { dryRun: false }));
    expect(moved.quarantined).toHaveLength(1);
    expect(statSync(path.join(moved.quarantined[0].destination, "ignored.log")).ino).toBe(
      statSync(path.join(moved.quarantined[0].destination, "feature.txt")).ino,
    );
    expect(statSync(outside).ino).toBe(inode);
  });

  it("dry-run and status leave Git index bytes and mtime, the DB and the journal untouched", async () => {
    const fixture = await makeFixture();
    const gitIndex = path.join(fixture.gitDir, "index");
    // Touching a tracked file only changes its mtime, which tempts git into refreshing the index.
    const future = new Date(Date.now() + 5000);
    utimesSync(path.join(fixture.worktreePath, "feature.txt"), future, future);
    const before = { bytes: readFileSync(gitIndex), mtime: statSync(gitIndex).mtimeMs };
    const ports = makePorts();
    for (const dryRun of [true, true]) {
      await mergedCleanup(options(fixture, { dryRun, portsApi: ports }));
    }
    await auditMergedWorktrees(options(fixture));
    expect(readFileSync(gitIndex).equals(before.bytes)).toBe(true);
    expect(statSync(gitIndex).mtimeMs).toBe(before.mtime);
    expect(existsSync(quarantineRoot(fixture.env))).toBe(false);
    expect(ports.releases).toEqual([]);
  });

  it("treats an open PR with the same head ref and base but another commit as a conflict", async () => {
    const fixture = await makeFixture({ merge: "none" });
    git(fixture.repoRoot, "remote", "add", "origin", "https://github.com/acme/widgets.git");
    const listed = [
      {
        number: 5,
        url: "https://github.com/acme/widgets/pull/5",
        state: "OPEN",
        baseRefName: "main",
        headRefName: fixture.branch,
        headRefOid: "0".repeat(40),
        isCrossRepository: false,
      },
    ];
    const withGh = (cmd, args, opts) =>
      cmd === "gh" ? JSON.stringify(listed) : execFileSync(cmd, args, opts);
    const report = await mergedCleanup(options(fixture, { dryRun: true, execFileSyncFn: withGh }));
    expect(entryFor(report, fixture).reasons).toContain("pr_conflict");
  });

  it("binds the merged-PR query to this checkout's origin, never to a record's repository", async () => {
    const fixture = await makeFixture({ merge: "none" });
    git(fixture.repoRoot, "remote", "add", "origin", "https://github.com/acme/widgets.git");
    mkdirSync(path.join(fixture.gitDir, "orkest"), { recursive: true });
    writeFileSync(
      path.join(fixture.gitDir, "orkest", "foundry-state.json"),
      JSON.stringify({
        schema: "ork.foundry.state.v2",
        targetBranch: "main",
        pr: { repository: "evil/widgets", number: 1 },
      }),
    );
    const queried = [];
    const withGh = (cmd, args, opts) => {
      if (cmd !== "gh") return execFileSync(cmd, args, opts);
      queried.push(args[args.indexOf("--repo") + 1]);
      return "[]";
    };
    const report = await mergedCleanup(options(fixture, { dryRun: true, execFileSyncFn: withGh }));
    expect(entryFor(report, fixture).reasons).toContain("pr_repository_mismatch");
    expect(queried).toEqual([]);
  });

  it("tells our own lease from an unrelated owner with the real lease readers", async () => {
    const fixture = await makeFixture();
    const realLeases = { hasActiveWorktreeLease: undefined };
    const { hasActiveWorktreeLease } = await import("../../../plugins/orchestrate/lib/cleanup.mjs");
    realLeases.hasActiveWorktreeLease = hasActiveWorktreeLease;
    const real = options(fixture, realLeases);
    const worktree = realpath(fixture.worktreePath);
    const cacheDir = fixture.cache;
    // An unrelated active session keeps it: the exclusive acquire fails.
    const other = await acquireWorkspaceLease(worktree, { env: fixture.env });
    expect(hasActiveWorktreeLease(cacheDir, worktree, path.basename(worktree), null)).toBe(true);
    const blocked = await mergedCleanup({ ...real, dryRun: false });
    expect(blocked.quarantined).toEqual([]);
    expect(entryFor(blocked, fixture).reasons).toContain("lease_active");
    await other.release();
    // Once it is released, the same run is not blocked by stale lease state, even by its own lease.
    const probe = { kernelLeases: true };
    expect(hasActiveWorktreeLease(cacheDir, worktree, path.basename(worktree), null, probe)).toBe(
      false,
    );
    const done = await mergedCleanup({ ...real, dryRun: false });
    expect(done.quarantined).toHaveLength(1);
  });

  it("rolls back a move whose links no longer reach what they reached", async () => {
    const fixture = await makeFixture();
    symlinkSync("feature.txt", path.join(fixture.worktreePath, "ignored.log"));
    const swapping = (cmd, args, opts) => {
      const out = execFileSync(cmd, args, opts);
      if (
        args[0] === "worktree" &&
        args[1] === "move" &&
        args[2] === realpath(fixture.worktreePath)
      ) {
        // Write the replacement first so it cannot reuse the old inode number, then swap it in.
        writeFileSync(path.join(args[3], "feature.new"), "replaced\n");
        renameSync(path.join(args[3], "feature.new"), path.join(args[3], "feature.txt"));
      }
      return out;
    };
    const report = await mergedCleanup(
      options(fixture, { dryRun: false, execFileSyncFn: swapping }),
    );
    expect(report.quarantined).toEqual([]);
    expect(report.kept[0].reasons).toEqual(["link_identity_changed"]);
    expect(existsSync(path.join(fixture.worktreePath, "feature.txt"))).toBe(true);
    expect(listJournals(fixture.repoRoot, fixture.env)[0].journal.state).toBe("aborted");
  });
});

describe("cleanup --merged final review cases", () => {
  it("keeps while a live room binds the path, whatever the marker says, and when room state is unknown", async () => {
    const fixture = await makeFixture();
    const bound = {
      active: new Set(["room-a"]),
      known: new Set(["room-a"]),
      paths: [{ path: realpath(fixture.worktreePath), roomId: "room-a" }],
      error: null,
    };
    const live = await mergedCleanup(options(fixture, { dryRun: true, roomBindings: bound }));
    expect(entryFor(live, fixture).reasons).toContain("room_bound");
    // A room whose agent merely runs inside the tree also counts.
    const inside = {
      ...bound,
      paths: [{ path: `${realpath(fixture.worktreePath)}/sub`, roomId: "room-a" }],
    };
    expect((await dryReasons(fixture, { roomBindings: inside })).reasons).toContain("room_bound");
    const unknown = { active: new Set(), known: new Set(), paths: [], error: "store unreadable" };
    expect((await dryReasons(fixture, { roomBindings: unknown })).reasons).toContain(
      "room_state_unknown",
    );
    // No binding at all: eligible.
    const none = { active: new Set(), known: new Set(), paths: [], error: null };
    expect(
      (await mergedCleanup(options(fixture, { dryRun: true, roomBindings: none }))).eligible,
    ).toHaveLength(1);
    // A marker naming a finished (known, inactive) room is not a live binding; a missing room is unknown.
    const roomy = await makeFixture({
      slug: "roomy",
      marker: { roomId: "room-done", memberId: "m1" },
    });
    const finished = { active: new Set(), known: new Set(["room-done"]), paths: [], error: null };
    expect(
      (await mergedCleanup(options(roomy, { dryRun: true, roomBindings: finished }))).eligible,
    ).toHaveLength(1);
    const missing = await mergedCleanup(options(roomy, { dryRun: true, roomBindings: none }));
    expect(entryFor(missing, roomy).reasons).toContain("room_state_unknown");
  });

  it("refuses an existing quarantine root that is group-accessible or a symlink", async () => {
    const fixture = await makeFixture();
    const root = quarantineRoot(fixture.env);
    mkdirSync(root, { recursive: true, mode: 0o755 });
    chmodSync(root, 0o755);
    const open = await mergedCleanup(options(fixture, { dryRun: true }));
    expect(entryFor(open, fixture).reasons).toContain("quarantine_unsafe");
    const run = await mergedCleanup(options(fixture, { dryRun: false }));
    expect(run.quarantined).toEqual([]);
    expect(existsSync(fixture.worktreePath)).toBe(true);
    chmodSync(root, 0o700);
    expect((await mergedCleanup(options(fixture, { dryRun: true }))).eligible).toHaveLength(1);
    // A symlinked root is never followed.
    const other = await makeFixture({ slug: "linked-root" });
    const elsewhere = path.join(other.root, "elsewhere");
    mkdirSync(elsewhere, { mode: 0o700 });
    mkdirSync(other.cache, { recursive: true });
    symlinkSync(elsewhere, quarantineRoot(other.env));
    expect((await dryReasons(other)).reasons).toContain("quarantine_unsafe");
  });

  it("renders a restore line that survives spaces and metacharacters, and keeps exact argv", async () => {
    const fixture = await makeFixture({ slug: "my work; echo $HOME" });
    const report = await mergedCleanup(options(fixture, { dryRun: false }));
    expect(report.quarantined).toHaveLength(1);
    const [done] = report.quarantined;
    expect(done.recovery.command.at(-1)).toBe(done.path);
    expect(done.recovery.shell).toContain("'");
    const result = spawnSync("bash", ["-c", done.recovery.shell], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(existsSync(path.join(fixture.worktreePath, "feature.txt"))).toBe(true);
    expect(existsSync(done.destination)).toBe(false);
  });

  it("the common helper quarantines a just-merged owned worktree and retains an unowned one", async () => {
    const owned = await makeFixture({ slug: "owned" });
    const outcome = await pruneMergedWorktree({
      repoRoot: owned.repoRoot,
      worktreePath: owned.worktreePath,
      targetBranch: "main",
      env: owned.env,
      portsApi: makePorts(),
      hasActiveWorktreeLease: hasNoLeases,
      roomBindings: { active: new Set(), known: new Set(), paths: [], error: null },
    });
    expect(outcome).toMatchObject({ pruned: true, status: "quarantined", bytesReclaimed: 0 });
    expect(git(owned.repoRoot, "rev-parse", `refs/heads/${owned.branch}`)).toBe(owned.head);
    expect(existsSync(owned.worktreePath)).toBe(false);

    const unowned = await makeFixture({ slug: "unowned-helper" });
    writeFileSync(path.join(unowned.gitDir, "orkest.json"), "{}");
    const retained = await pruneMergedWorktree({
      repoRoot: unowned.repoRoot,
      worktreePath: unowned.worktreePath,
      targetBranch: "main",
      env: unowned.env,
      portsApi: makePorts(),
      hasActiveWorktreeLease: hasNoLeases,
      roomBindings: { active: new Set(), known: new Set(), paths: [], error: null },
    });
    expect(retained).toMatchObject({ pruned: false, status: "retained" });
    expect(existsSync(unowned.worktreePath)).toBe(true);
  });
});
