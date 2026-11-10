import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  acquireCleanupLock,
  CLEANUP_SCHEMA,
  cleanupCommand,
  hasActiveWorktreeLease,
  isCleanupLockHeld,
  migrateLegacyDirectory,
  migrateLegacyState,
  parseCleanupArgs,
  pruneDisposableWorktrees,
  pruneStaleLocks,
} from "../../../plugins/orchestrate/lib/cleanup.mjs";
import {
  isHarnessAllowed,
  POLICY_SCHEMA,
  resolveRepoPolicy,
  runPolicyCli,
  setRepoPolicyDeny,
} from "../../../plugins/orchestrate/lib/policy.mjs";

function makeCaptureStream() {
  let buffer = "";
  return {
    write(chunk) {
      buffer += String(chunk);
    },
    text() {
      return buffer;
    },
  };
}

function initGitRepo(repoDir) {
  fs.mkdirSync(repoDir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repoDir });
  execFileSync("git", ["config", "user.email", "cleanup-test@example.test"], { cwd: repoDir });
  execFileSync("git", ["config", "user.name", "Cleanup Test"], { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, "README.md"), "# Test Repo\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: repoDir });
  execFileSync("git", ["commit", "-qm", "initial commit"], { cwd: repoDir });
}

function setOldMtime(targetPath, secondsAgo = 3600) {
  const past = new Date(Date.now() - secondsAgo * 1000);
  fs.utimesSync(targetPath, past, past);
}

describe("ork cleanup (Slice 1D)", () => {
  let tempRoot;
  let fakeHome;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ork-cleanup-test-"));
    fakeHome = path.join(tempRoot, "home");
    fs.mkdirSync(fakeHome, { recursive: true });
  });

  afterEach(() => {
    if (tempRoot && fs.existsSync(tempRoot)) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("supports --help and parses CLI flags", () => {
    const stdout = makeCaptureStream();
    const helpRes = cleanupCommand(["--help"], { homeDir: fakeHome, stdout });
    expect(helpRes).toEqual({
      schema: CLEANUP_SCHEMA,
      action: "help",
      help: true,
      exitCode: 0,
    });
    expect(stdout.text()).toContain("Usage: ork cleanup [status|run]");

    const parsedStatus = parseCleanupArgs([
      "status",
      "--migrate-legacy",
      "--grace-minutes",
      "20",
      "--keep-backups=2",
    ]);
    expect(parsedStatus.action).toBe("status");
    expect(parsedStatus.dryRun).toBe(true);
    expect(parsedStatus.migrateLegacy).toBe(true);
    expect(parsedStatus.graceMinutes).toBe(20);
    expect(parsedStatus.keepBackups).toBe(2);
  });

  it("enforces single-GC cleanup.lock and preserves lock inode on reclaim and release", () => {
    const cacheDir = path.join(fakeHome, ".cache", "orchestrate");
    fs.mkdirSync(cacheDir, { recursive: true });
    const lockPath = path.join(cacheDir, "cleanup.lock");

    // Held lock -> rejected
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, released: false }), "utf8");
    const initialInode = fs.statSync(lockPath).ino;
    expect(isCleanupLockHeld(lockPath)).toBe(true);
    expect(() =>
      cleanupCommand(["run", "--json"], {
        homeDir: fakeHome,
        silent: true,
        runRunnerPrune: () => ({ bytes: 0 }),
      }),
    ).toThrow(/already running/);

    // Stale dead-PID lock older than grace window -> reclaimed in-place and marked released on exit without unlinking
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 99_999_999, released: false }), "utf8");
    setOldMtime(lockPath, 3600);
    const report = cleanupCommand(["run", "--json"], {
      homeDir: fakeHome,
      silent: true,
      runRunnerPrune: () => ({ bytes: 0 }),
    });
    expect(report.schema).toBe(CLEANUP_SCHEMA);
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fs.statSync(lockPath).ino).toBe(initialInode);
    expect(isCleanupLockHeld(lockPath)).toBe(false);
    expect(JSON.parse(fs.readFileSync(lockPath, "utf8"))).toMatchObject({
      pid: null,
      released: true,
      releasedByPid: process.pid,
    });

    // Direct acquireCleanupLock re-acquires and releases on the exact same inode, and enforces mutual exclusion
    const lock = acquireCleanupLock(lockPath, { dryRun: false });
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fs.statSync(lockPath).ino).toBe(initialInode);
    expect(isCleanupLockHeld(lockPath)).toBe(true);
    // Second concurrent acquireCleanupLock while first is held must throw CLEANUP_LOCKED
    expect(() => acquireCleanupLock(lockPath, { dryRun: false })).toThrow(/already running/);
    lock.release();
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fs.statSync(lockPath).ino).toBe(initialInode);
    expect(isCleanupLockHeld(lockPath)).toBe(false);
  });

  it("safely prunes only clean, merged, disposable worktrees past the grace window", () => {
    const repoDir = path.join(tempRoot, "repo");
    initGitRepo(repoDir);

    const cacheDir = path.join(fakeHome, ".cache", "orchestrate");
    const wtRoot = path.join(cacheDir, "worktrees");
    fs.mkdirSync(wtRoot, { recursive: true });

    const wtCleanMerged = path.join(wtRoot, "wt-clean-merged");
    const wtNonDisposable = path.join(wtRoot, "wt-non-disposable");
    const wtDirty = path.join(wtRoot, "wt-dirty");
    const wtUnmerged = path.join(wtRoot, "wt-unmerged");
    const wtRecent = path.join(wtRoot, "wt-recent");
    const wtActiveRun = path.join(wtRoot, "wt-active-run");

    for (const [wtPath, branch] of [
      [wtCleanMerged, "orkest/clean-merged"],
      [wtNonDisposable, "orkest/non-disposable"],
      [wtDirty, "orkest/dirty"],
      [wtUnmerged, "orkest/unmerged"],
      [wtRecent, "orkest/recent"],
      [wtActiveRun, "orkest/active-run"],
    ]) {
      execFileSync("git", ["worktree", "add", "-q", "-b", branch, wtPath, "main"], {
        cwd: repoDir,
      });
    }

    // 1. Clean merged disposable worktree (old)
    fs.writeFileSync(
      path.join(wtCleanMerged, "meta.json"),
      JSON.stringify({ disposable: true, baseBranch: "main", parentCwd: repoDir }),
    );
    setOldMtime(wtCleanMerged, 3600);

    // 2. Non-disposable worktree (old)
    fs.writeFileSync(
      path.join(wtNonDisposable, "meta.json"),
      JSON.stringify({ disposable: false, baseBranch: "main", parentCwd: repoDir }),
    );
    setOldMtime(wtNonDisposable, 3600);

    // 3. Dirty worktree (old)
    fs.writeFileSync(
      path.join(wtDirty, "meta.json"),
      JSON.stringify({ disposable: true, baseBranch: "main", parentCwd: repoDir }),
    );
    fs.writeFileSync(path.join(wtDirty, "uncommitted.txt"), "dirty\n", "utf8");
    setOldMtime(wtDirty, 3600);

    // 4. Unmerged commits worktree (old)
    fs.writeFileSync(
      path.join(wtUnmerged, "meta.json"),
      JSON.stringify({ disposable: true, baseBranch: "main", parentCwd: repoDir }),
    );
    fs.writeFileSync(path.join(wtUnmerged, "feature.txt"), "work\n", "utf8");
    execFileSync("git", ["add", "feature.txt"], { cwd: wtUnmerged });
    execFileSync("git", ["commit", "-qm", "unmerged work"], { cwd: wtUnmerged });
    setOldMtime(wtUnmerged, 3600);

    // 5. Recent worktree within 15-minute grace window
    fs.writeFileSync(
      path.join(wtRecent, "meta.json"),
      JSON.stringify({ disposable: true, baseBranch: "main", parentCwd: repoDir }),
    );

    // 6. Active run worktree (live PID)
    fs.writeFileSync(
      path.join(wtActiveRun, "meta.json"),
      JSON.stringify({
        disposable: true,
        baseBranch: "main",
        parentCwd: repoDir,
        pid: process.pid,
      }),
    );
    setOldMtime(wtActiveRun, 3600);

    // Status (dry-run) does not delete wtCleanMerged
    const statusReport = cleanupCommand(["status", "--cwd", repoDir, "--json"], {
      homeDir: fakeHome,
      silent: true,
      runRunnerPrune: () => ({ bytes: 0 }),
    });
    expect(statusReport.dryRun).toBe(true);
    expect(statusReport.worktrees.pruned.map((w) => w.name)).toEqual(["wt-clean-merged"]);
    expect(fs.existsSync(wtCleanMerged)).toBe(true);

    // Run removes only wt-clean-merged and preserves all protected worktrees
    const runReport = cleanupCommand(["run", "--cwd", repoDir, "--json"], {
      homeDir: fakeHome,
      silent: true,
      runRunnerPrune: () => ({ bytes: 0 }),
    });
    expect(runReport.worktrees.pruned.map((w) => w.name)).toEqual(["wt-clean-merged"]);
    expect(fs.existsSync(wtCleanMerged)).toBe(false);

    const keptByName = Object.fromEntries(
      runReport.worktrees.kept.map((item) => [item.name, item.reason]),
    );
    expect(keptByName["wt-non-disposable"]).toBe("non_disposable");
    expect(keptByName["wt-dirty"]).toBe("dirty_worktree");
    expect(keptByName["wt-unmerged"]).toBe("unmerged_commits");
    expect(keptByName["wt-recent"]).toBe("within_grace_window");
    expect(keptByName["wt-active-run"]).toBe("active_run");
  });

  it("rotates .mailbox-bak.* backups, prunes share backups, and prunes inactive staged daemon runtimes", () => {
    const cacheDir = path.join(fakeHome, ".cache", "orchestrate");
    const claudeDir = path.join(fakeHome, ".claude");
    fs.mkdirSync(claudeDir, { recursive: true });

    const bakOld = path.join(claudeDir, "settings.json.mailbox-bak.1000");
    const bakMid = path.join(claudeDir, "settings.json.mailbox-bak.2000");
    const bakNewest = path.join(claudeDir, "settings.json.mailbox-bak.3000");
    fs.writeFileSync(bakOld, "old\n", "utf8");
    fs.writeFileSync(bakMid, "mid\n", "utf8");
    fs.writeFileSync(bakNewest, "newest\n", "utf8");

    const shareBackups = path.join(fakeHome, ".local", "share", "agent-executor", "backups");
    const snapOld = path.join(shareBackups, "snap-1");
    const snapNewest = path.join(shareBackups, "snap-2");
    fs.mkdirSync(snapOld, { recursive: true });
    fs.mkdirSync(snapNewest, { recursive: true });
    fs.writeFileSync(path.join(snapOld, "file.txt"), "old-snap\n", "utf8");
    fs.writeFileSync(path.join(snapNewest, "file.txt"), "new-snap\n", "utf8");
    setOldMtime(snapOld, 7200);
    setOldMtime(snapNewest, 3600);

    const daemonDir = path.join(cacheDir, "mailbox-daemon-v1");
    const runtimesDir = path.join(daemonDir, "runtimes");
    const rtActive = path.join(runtimesDir, "rev-live");
    const rtRecent = path.join(runtimesDir, "rev-recent");
    const rtStale = path.join(runtimesDir, "rev-stale");
    for (const rt of [rtActive, rtRecent, rtStale]) {
      fs.mkdirSync(rt, { recursive: true });
      fs.writeFileSync(path.join(rt, "mailbox_daemon.py"), "# runtime\n", "utf8");
    }
    fs.writeFileSync(
      path.join(daemonDir, "state.json"),
      JSON.stringify({ runtimeRevision: "rev-live" }),
      "utf8",
    );
    setOldMtime(rtActive, 7200);
    setOldMtime(rtStale, 7200);

    const report = cleanupCommand(["run", "--keep-backups", "1", "--json"], {
      homeDir: fakeHome,
      silent: true,
      runRunnerPrune: () => ({
        events: 2,
        jobs: 1,
        runs: 0,
        consults: 0,
        locks: 1,
        mailbox: 0,
        bytes: 128,
      }),
    });

    expect(fs.existsSync(bakOld)).toBe(false);
    expect(fs.existsSync(bakMid)).toBe(false);
    expect(fs.existsSync(bakNewest)).toBe(true);

    expect(fs.existsSync(snapOld)).toBe(false);
    expect(fs.existsSync(snapNewest)).toBe(true);

    expect(fs.existsSync(rtStale)).toBe(false);
    expect(fs.existsSync(rtActive)).toBe(true);
    expect(fs.existsSync(rtRecent)).toBe(true);
    expect(report.totalBytesReclaimed).toBeGreaterThan(128);
  });

  it("atomically migrates legacy agent-executor cache & config dirs with symlinks and repairs git worktrees", () => {
    const repoDir = path.join(tempRoot, "repo");
    initGitRepo(repoDir);

    const legacyCache = path.join(fakeHome, ".cache", "agent-executor");
    const orchestrateCache = path.join(fakeHome, ".cache", "orchestrate");
    const legacyConfig = path.join(fakeHome, ".config", "agent-executor");
    const orchestrateConfig = path.join(fakeHome, ".config", "orchestrate");

    fs.mkdirSync(path.join(legacyCache, "worktrees"), { recursive: true });
    fs.mkdirSync(legacyConfig, { recursive: true });
    fs.writeFileSync(path.join(legacyConfig, "config.json"), '{"routes":{}}\n', "utf8");

    const legacyWtPath = path.join(legacyCache, "worktrees", "wt-keep");
    execFileSync("git", ["worktree", "add", "-q", "-b", "orkest/wt-keep", legacyWtPath, "main"], {
      cwd: repoDir,
    });
    fs.writeFileSync(
      path.join(legacyWtPath, "meta.json"),
      JSON.stringify({ disposable: false, worktreePath: legacyWtPath, parentCwd: repoDir }),
      "utf8",
    );

    const stdout = makeCaptureStream();
    const report = cleanupCommand(["run", "--migrate-legacy", "--cwd", repoDir, "--json"], {
      homeDir: fakeHome,
      stdout,
      runRunnerPrune: () => ({ bytes: 0 }),
    });

    expect(report.migration.cache.status).toBe("migrated");
    expect(report.migration.config.status).toBe("migrated");
    expect(fs.lstatSync(legacyCache).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(legacyCache)).toBe("orchestrate");
    expect(fs.lstatSync(orchestrateCache).isDirectory()).toBe(true);

    expect(fs.lstatSync(legacyConfig).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(legacyConfig)).toBe("orchestrate");
    expect(fs.existsSync(path.join(orchestrateConfig, "config.json"))).toBe(true);

    // Verify git worktree list --porcelain in parent repo now points to canonical orchestrate path
    const canonicalOrchestrateWt = fs.realpathSync(
      path.join(orchestrateCache, "worktrees", "wt-keep"),
    );
    const wtList = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: repoDir,
      encoding: "utf8",
    });
    expect(wtList).toContain(`worktree ${canonicalOrchestrateWt}`);

    // Re-running --migrate-legacy is idempotent
    const secondReport = cleanupCommand(["run", "--migrate-legacy", "--cwd", repoDir, "--json"], {
      homeDir: fakeHome,
      silent: true,
      runRunnerPrune: () => ({ bytes: 0 }),
    });
    expect(secondReport.migration.cache.status).toBe("already_migrated");
    expect(secondReport.migration.config.status).toBe("already_migrated");
  });

  it("delegates to run_agent.py prune and peer_mailbox.py prune in an isolated cache", () => {
    const cacheDir = path.join(fakeHome, ".cache", "orchestrate");
    const locksDir = path.join(cacheDir, "locks");
    fs.mkdirSync(locksDir, { recursive: true });
    const deadLock = path.join(locksDir, "dead.lock");
    fs.writeFileSync(deadLock, JSON.stringify({ pid: 99_999_997 }), "utf8");
    setOldMtime(deadLock, 7200);

    const report = cleanupCommand(["run", "--older-than", "1m", "--json"], {
      homeDir: fakeHome,
      silent: true,
    });

    expect(report.runnerPrune.locks).toBe(1);
    expect(fs.existsSync(deadLock)).toBe(false);
  });

  it("checks worktree-locks-v1, locks, and coordinator-locks for active leases and prunes stale dead-PID lockfiles", () => {
    const repoDir = path.join(tempRoot, "repo");
    initGitRepo(repoDir);

    const cacheDir = path.join(fakeHome, ".cache", "orchestrate");
    const wtRoot = path.join(cacheDir, "worktrees");
    const wtLocksDir = path.join(cacheDir, "worktree-locks-v1");
    const locksDir = path.join(cacheDir, "locks");
    const coordLocksDir = path.join(cacheDir, "coordinator-locks");
    for (const dir of [wtRoot, wtLocksDir, locksDir, coordLocksDir]) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const wtLeased = path.join(wtRoot, "wt-leased");
    execFileSync("git", ["worktree", "add", "-q", "-b", "orkest/leased", wtLeased, "main"], {
      cwd: repoDir,
    });
    fs.writeFileSync(
      path.join(wtLeased, "meta.json"),
      JSON.stringify({ disposable: true, baseBranch: "main", parentCwd: repoDir }),
      "utf8",
    );
    setOldMtime(wtLeased, 3600);

    // Active worktree lease in worktree-locks-v1/<sha256_16>.lock (matches execution_support.py naming)
    const wtReal = fs.realpathSync(wtLeased);
    const hashPrefix = crypto.createHash("sha256").update(wtReal).digest("hex").slice(0, 16);
    const activeWtLock = path.join(wtLocksDir, `${hashPrefix}.lock`);
    fs.writeFileSync(activeWtLock, JSON.stringify({ pid: process.pid, repo: wtReal }), "utf8");
    expect(hasActiveWorktreeLease(cacheDir, wtLeased, { disposable: true })).toBe(true);

    // Stale dead-PID locks across all three lock directories (older than 15m) + recent dead-PID lock (within 15m)
    const staleWtLock = path.join(wtLocksDir, "dead-wt.lock");
    const staleRunLock = path.join(locksDir, "dead-run.lock");
    const staleCoordLock = path.join(coordLocksDir, "dead-coord.lock");
    const recentDeadLock = path.join(coordLocksDir, "recent-coord.lock");
    for (const p of [staleWtLock, staleRunLock, staleCoordLock, recentDeadLock]) {
      fs.writeFileSync(p, JSON.stringify({ pid: 99_999_996 }), "utf8");
    }
    setOldMtime(staleWtLock, 3600);
    setOldMtime(staleRunLock, 3600);
    setOldMtime(staleCoordLock, 3600);

    const report = cleanupCommand(["run", "--cwd", repoDir, "--json"], {
      homeDir: fakeHome,
      silent: true,
      runRunnerPrune: () => ({ bytes: 0 }),
    });

    // wt-leased is protected by active worktree-locks-v1 lease
    const keptByName = Object.fromEntries(
      report.worktrees.kept.map((item) => [item.name, item.reason]),
    );
    expect(keptByName["wt-leased"]).toBe("active_run");
    expect(fs.existsSync(wtLeased)).toBe(true);

    // Stale locks in locks and coordinator-locks are pruned; persistent flock inodes in worktree-locks-v1 remain intact!
    const staleWtInode = fs.statSync(staleWtLock).ino;
    expect(report.staleLocks.pruned.length).toBe(2);
    expect(fs.existsSync(staleWtLock)).toBe(true);
    expect(fs.statSync(staleWtLock).ino).toBe(staleWtInode);
    expect(fs.existsSync(staleRunLock)).toBe(false);
    expect(fs.existsSync(staleCoordLock)).toBe(false);
    expect(fs.existsSync(activeWtLock)).toBe(true);
    expect(fs.existsSync(recentDeadLock)).toBe(true);
    expect(fs.existsSync(path.join(cacheDir, "cleanup.lock"))).toBe(true);

    // Direct pruneStaleLocks dryRun check on locks/ and worktree-locks-v1/
    fs.writeFileSync(staleRunLock, JSON.stringify({ pid: 99_999_995 }), "utf8");
    setOldMtime(staleRunLock, 3600);
    const dryLocks = pruneStaleLocks(cacheDir, { graceMs: 15 * 60 * 1000, dryRun: true });
    expect(dryLocks.pruned).toContain(staleRunLock);
    expect(dryLocks.pruned).not.toContain(staleWtLock);
    expect(dryLocks.kept).toContain(staleWtLock);
    expect(fs.existsSync(staleRunLock)).toBe(true);
  });

  it("preserves conflicting files in migrateLegacyDirectory (conflict_preserved) and merges identical/non-conflicting files", () => {
    const legacyConfig = path.join(fakeHome, ".config", "agent-executor");
    const orchestrateConfig = path.join(fakeHome, ".config", "orchestrate");
    fs.mkdirSync(legacyConfig, { recursive: true });
    fs.mkdirSync(orchestrateConfig, { recursive: true });

    // 1. Non-conflicting file in legacy only
    fs.writeFileSync(path.join(legacyConfig, "only-legacy.json"), '{"a":1}\n', "utf8");
    // 2. Identical file in both
    fs.writeFileSync(path.join(legacyConfig, "same.json"), '{"same":true}\n', "utf8");
    fs.writeFileSync(path.join(orchestrateConfig, "same.json"), '{"same":true}\n', "utf8");
    // 3. Conflicting file with different contents
    fs.writeFileSync(
      path.join(legacyConfig, "config.json"),
      '{"routes":{"legacy":true}}\n',
      "utf8",
    );
    fs.writeFileSync(
      path.join(orchestrateConfig, "config.json"),
      '{"routes":{"new":true}}\n',
      "utf8",
    );

    const res = migrateLegacyDirectory(legacyConfig, orchestrateConfig, { dryRun: false });
    expect(res.status).toBe("conflict_preserved");
    expect(res.legacyDataPreserved).toBe(true);
    expect(res.conflicts).toEqual(["config.json"]);

    // Non-conflicting moved to orchestrateConfig, identical deduplicated, conflicting preserved in both!
    expect(fs.existsSync(path.join(orchestrateConfig, "only-legacy.json"))).toBe(true);
    expect(fs.existsSync(path.join(legacyConfig, "only-legacy.json"))).toBe(false);
    expect(fs.existsSync(path.join(legacyConfig, "same.json"))).toBe(false);
    expect(fs.readFileSync(path.join(legacyConfig, "config.json"), "utf8")).toBe(
      '{"routes":{"legacy":true}}\n',
    );
    expect(fs.readFileSync(path.join(orchestrateConfig, "config.json"), "utf8")).toBe(
      '{"routes":{"new":true}}\n',
    );
    expect(fs.lstatSync(legacyConfig).isSymbolicLink()).toBe(false);

    // Once conflict is resolved (identical bytes), re-running completes migration and creates symlink
    fs.writeFileSync(path.join(legacyConfig, "config.json"), '{"routes":{"new":true}}\n', "utf8");
    const resResolved = migrateLegacyDirectory(legacyConfig, orchestrateConfig, { dryRun: false });
    expect(resResolved.status).toBe("merged_and_migrated");
    expect(resResolved.conflicts).toEqual([]);
    expect(fs.lstatSync(legacyConfig).isSymbolicLink()).toBe(true);
  });

  it("migrates legacy cache and config under cleanup.lock without pruning state", () => {
    const legacyCache = path.join(fakeHome, ".cache", "agent-executor");
    const legacyConfig = path.join(fakeHome, ".config", "agent-executor");
    const staleLock = path.join(legacyCache, "locks", "preserved.lock");
    fs.mkdirSync(path.dirname(staleLock), { recursive: true });
    fs.mkdirSync(legacyConfig, { recursive: true });
    fs.writeFileSync(staleLock, JSON.stringify({ pid: 99_999_991, released: false }), "utf8");
    fs.writeFileSync(path.join(legacyConfig, "config.json"), '{"routes":{}}\n', "utf8");
    setOldMtime(staleLock, 3600);

    const report = migrateLegacyState({ homeDir: fakeHome, cwd: fakeHome });
    const cacheHome = path.join(fakeHome, ".cache", "orchestrate");
    const configHome = path.join(fakeHome, ".config", "orchestrate");
    const migratedLock = path.join(cacheHome, "locks", "preserved.lock");
    const cleanupLock = path.join(cacheHome, "cleanup.lock");

    expect(report).toMatchObject({
      requested: true,
      cache: { status: "migrated", changed: true },
      config: { status: "migrated", changed: true },
      repairedWorktrees: [],
    });
    expect(fs.readFileSync(migratedLock, "utf8")).toContain("99999991");
    expect(fs.readlinkSync(legacyCache)).toBe("orchestrate");
    expect(fs.readlinkSync(legacyConfig)).toBe("orchestrate");
    expect(fs.existsSync(path.join(configHome, "config.json"))).toBe(true);
    expect(isCleanupLockHeld(cleanupLock)).toBe(false);
  });

  it("never overrides Git refusal to remove a locked or registered worktree (git_locked / git_remove_refused)", () => {
    const repoDir = path.join(tempRoot, "repo");
    initGitRepo(repoDir);

    const cacheDir = path.join(fakeHome, ".cache", "orchestrate");
    const wtRoot = path.join(cacheDir, "worktrees");
    fs.mkdirSync(wtRoot, { recursive: true });

    const wtLocked = path.join(wtRoot, "wt-locked");
    execFileSync("git", ["worktree", "add", "-q", "-b", "orkest/locked", wtLocked, "main"], {
      cwd: repoDir,
    });
    fs.writeFileSync(
      path.join(wtLocked, "meta.json"),
      JSON.stringify({ disposable: true, baseBranch: "main", parentCwd: repoDir }),
      "utf8",
    );
    execFileSync("git", ["worktree", "lock", wtLocked], { cwd: repoDir });
    setOldMtime(wtLocked, 3600);

    const result = pruneDisposableWorktrees(cacheDir, {
      dryRun: false,
      graceMs: 15 * 60 * 1000,
      cwd: repoDir,
    });
    expect(result.pruned).toEqual([]);
    expect(result.kept).toEqual([{ path: wtLocked, name: "wt-locked", reason: "git_locked" }]);
    expect(fs.existsSync(wtLocked)).toBe(true);
  });

  it("evaluates and persists per-repository harness/account denylist policies via policy.mjs", () => {
    const repoDir = path.join(tempRoot, "repo");
    initGitRepo(repoDir);
    execFileSync("git", ["remote", "add", "origin", "https://github.com/loftshed/orkest.git"], {
      cwd: repoDir,
    });

    const cfgPath = path.join(fakeHome, ".config", "orchestrate", "config.json");
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({ routes: { implementation: { engine: "codex" } } }),
      "utf8",
    );

    // Deny work claude ("claude-work") for this repo
    const updated = setRepoPolicyDeny(repoDir, ["claude-work"], {
      mode: "add",
      configPath: cfgPath,
      homeDir: fakeHome,
    });
    expect(updated.schema).toBe(POLICY_SCHEMA);
    expect(updated.deny).toEqual(["claude-work"]);
    expect(updated.allowedHarnesses).toEqual(["codex", "agy", "opencode", "plaude"]);

    // Existing routes key in config.json is preserved
    const savedCfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    expect(savedCfg.routes).toEqual({ implementation: { engine: "codex" } });

    expect(isHarnessAllowed(repoDir, "claude", { configPath: cfgPath, homeDir: fakeHome })).toBe(
      false,
    );
    expect(
      isHarnessAllowed(repoDir, "claude-work", { configPath: cfgPath, homeDir: fakeHome }),
    ).toBe(false);
    expect(isHarnessAllowed(repoDir, "plaude", { configPath: cfgPath, homeDir: fakeHome })).toBe(
      true,
    );
    expect(
      isHarnessAllowed(repoDir, "claude-personal", { configPath: cfgPath, homeDir: fakeHome }),
    ).toBe(true);
    expect(isHarnessAllowed(repoDir, "agy", { configPath: cfgPath, homeDir: fakeHome })).toBe(true);
    expect(isHarnessAllowed(repoDir, "codex", { configPath: cfgPath, homeDir: fakeHome })).toBe(
      true,
    );
    expect(
      isHarnessAllowed(
        repoDir,
        { provider: "claude", id: "claude-work", billing: "subscription" },
        { configPath: cfgPath, homeDir: fakeHome },
      ),
    ).toBe(false);
    expect(
      isHarnessAllowed(
        repoDir,
        { provider: "claude", id: "plaude", billing: "personal" },
        { configPath: cfgPath, homeDir: fakeHome },
      ),
    ).toBe(true);

    // CLI show/deny/allow/reset
    const stdout = makeCaptureStream();
    const cliDeny = runPolicyCli(["deny", "opencode", "--cwd", repoDir, "--json"], {
      configPath: cfgPath,
      homeDir: fakeHome,
      stdout,
    });
    expect(cliDeny.deny).toEqual(["claude-work", "opencode"]);
    expect(isHarnessAllowed(repoDir, "opencode", { configPath: cfgPath, homeDir: fakeHome })).toBe(
      false,
    );

    const cliAllow = runPolicyCli(["allow", "opencode", "--cwd", repoDir, "--json"], {
      configPath: cfgPath,
      homeDir: fakeHome,
      silent: true,
    });
    expect(cliAllow.deny).toEqual(["claude-work"]);

    const cliReset = runPolicyCli(["reset", "--cwd", repoDir, "--json"], {
      configPath: cfgPath,
      homeDir: fakeHome,
      silent: true,
    });
    expect(cliReset.deny).toEqual([]);
    expect(
      resolveRepoPolicy(repoDir, { configPath: cfgPath, homeDir: fakeHome }).allowedHarnesses,
    ).toEqual(["codex", "agy", "opencode", "claude-work", "plaude"]);
  });
});
