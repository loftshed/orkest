import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cachedUpdateStatus,
  resolvePullUpdateOutcome,
  UPDATE_SUCCESS_TTL_MS,
} from "../../../plugins/orchestrate/bin/horde-tui.mjs";
import {
  checkOrkestUpdate,
  DEFAULT_UPDATE_INTERVAL_MS,
  getUpdateConfigPath,
  getUpdateStatePath,
  readAutoUpdateConfig,
  readLocalGitHeadSha,
  resolveOrkestRepoRoot,
  runOrkestUpdate,
  runUpdateCli,
  setAutoUpdateEnabled,
} from "../../../plugins/orchestrate/lib/update.mjs";

const tempDirs = [];

async function makeTempDir() {
  const dir = await mkdtemp(path.join(tmpdir(), "orkest-update-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("Orkest auto-update (update.mjs)", () => {
  it("prints help and rejects unknown arguments before calling update, config, state, or exec functions", async () => {
    const configDir = await makeTempDir();
    const cacheDir = await makeTempDir();
    let output = "";
    const stdout = { write: (chunk) => (output += chunk) };
    const injected = {
      updateFn: vi.fn(),
      checkFn: vi.fn(),
      setAutoUpdateEnabledFn: vi.fn(),
      readAutoUpdateConfigFn: vi.fn(),
      readUpdateStateFn: vi.fn(),
      exec: vi.fn(),
      configDir,
      cacheDir,
      stdout,
    };

    for (const arg of ["--help", "-h"]) {
      const result = await runUpdateCli([arg], injected);
      expect(result).toMatchObject({ ok: true, status: "help", help: true, exitCode: 0 });
      expect(output).toContain("Usage: ork update");
    }
    expect(output).toContain("--check");
    expect(output).toContain("--apply");

    for (const arg of ["--hlep", "upgrade"]) {
      let thrown;
      try {
        await runUpdateCli([arg], injected);
      } catch (error_) {
        thrown = error_;
      }
      const error = thrown;
      expect(error).toMatchObject({ exitCode: 2 });
      expect(error.message).toContain(arg);
    }

    for (const name of [
      "updateFn",
      "checkFn",
      "setAutoUpdateEnabledFn",
      "readAutoUpdateConfigFn",
      "readUpdateStateFn",
      "exec",
    ]) {
      expect(injected[name]).not.toHaveBeenCalled();
    }
    await expect(readFile(getUpdateStatePath({ cacheDir }), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(getUpdateConfigPath({ configDir }), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps the documented update, check, status, toggle, and output flags working", async () => {
    const configDir = await makeTempDir();
    const cacheDir = await makeTempDir();
    const calls = [];
    let output = "";
    const stdout = { write: (chunk) => (output += chunk) };
    const options = {
      configDir,
      cacheDir,
      stdout,
      updateFn: vi.fn(async (opts) => {
        calls.push(["update", opts]);
        return { ok: true, status: "throttled", updated: false };
      }),
      checkFn: vi.fn(async (opts) => {
        calls.push(["check", opts]);
        return { ok: true, status: "up_to_date", updateAvailable: false };
      }),
      setAutoUpdateEnabledFn: vi.fn(async (enabled) => ({ enabled })),
      readAutoUpdateConfigFn: vi.fn(async () => ({ enabled: true })),
      readUpdateStateFn: vi.fn(async () => ({ status: "idle" })),
    };

    await runUpdateCli(["run"], options);
    output = "";
    await runUpdateCli(["--apply", "--auto", "--force", "--quiet"], options);
    expect(options.updateFn).toHaveBeenCalledTimes(2);
    expect(calls[0][1]).toMatchObject({ auto: false, force: false });
    expect(calls[1][1]).toMatchObject({ auto: true, force: true });
    expect(output).toBe("");

    await runUpdateCli(["check"], options);
    await runUpdateCli(["--check", "--json"], options);
    expect(options.checkFn).toHaveBeenCalledTimes(2);
    expect(output).toContain('"status": "up_to_date"');

    const status = await runUpdateCli(["status"], options);
    expect(status).toMatchObject({
      status: "idle",
      autoUpdate: { enabled: true },
      state: { status: "idle" },
    });
    expect(options.readAutoUpdateConfigFn).toHaveBeenCalledTimes(1);
    expect(options.readUpdateStateFn).toHaveBeenCalledWith(getUpdateStatePath({ cacheDir }));

    await runUpdateCli(["enable"], options);
    await runUpdateCli(["disable"], options);
    expect(options.setAutoUpdateEnabledFn.mock.calls.map(([enabled]) => enabled)).toEqual([
      true,
      false,
    ]);

    output = "";
    await runUpdateCli(["run", "--json"], options);
    expect(JSON.parse(output)).toMatchObject({ status: "throttled", updated: false });

    output = "";
    await runUpdateCli(["run"], {
      ...options,
      updateFn: async () => ({
        ok: true,
        status: "updated",
        cleanup: {
          cache: { status: "already_migrated", changed: false },
          config: { status: "already_migrated", changed: false },
          repairedWorktrees: [],
        },
      }),
    });
    expect(output).not.toContain("Legacy state migration:");
  });

  it("reads default config and toggles auto_update.enabled via setAutoUpdateEnabled and CLI", async () => {
    const configDir = await makeTempDir();
    const cacheDir = await makeTempDir();

    const initial = await readAutoUpdateConfig({ configDir });
    expect(initial).toEqual({
      enabled: true,
      intervalMinutes: 30,
      remote: "origin",
      branch: "main",
    });

    const disabled = await setAutoUpdateEnabled(false, { configDir });
    expect(disabled.enabled).toBe(false);

    let out = "";
    const stdout = {
      write: (chunk) => {
        out += chunk;
      },
    };
    const statusRes = await runUpdateCli(["status", "--json"], {
      configDir,
      cacheDir,
      stdout,
    });
    expect(statusRes.autoUpdate.enabled).toBe(false);
    expect(JSON.parse(out).autoUpdate.enabled).toBe(false);

    await runUpdateCli(["enable"], { configDir, cacheDir, stdout });
    expect((await readAutoUpdateConfig({ configDir })).enabled).toBe(true);
  });

  it("treats --check as a check and --apply as an update, refusing conflicting commands", async () => {
    const configDir = await makeTempDir();
    const cacheDir = await makeTempDir();
    const calls = [];
    const exec = (_cmd, args, cb) => {
      calls.push(args.join(" "));
      if (args.includes("--abbrev-ref")) return cb(null, "main\n");
      if (args.includes("--porcelain")) return cb(null, "");
      if (args.includes("rev-list")) return cb(null, "3\n");
      if (args.includes("rev-parse")) {
        return cb(null, args.some((arg) => arg.includes("origin/")) ? "2222222\n" : "1111111\n");
      }
      cb(null, "");
    };
    const stdout = { write() {} };
    const result = await runUpdateCli(["--check", "--json"], {
      configDir,
      cacheDir,
      repoRoot: "/repo",
      exec,
      stdout,
    });
    expect(result.status).not.toBe("updated");
    expect(calls.filter((call) => call.includes("merge --ff-only"))).toEqual([]);
    await runUpdateCli(["disable"], { configDir, cacheDir, stdout });
    for (const argv of [
      ["--check", "enable"],
      ["--check", "--apply"],
      ["--apply", "check"],
    ]) {
      await expect(runUpdateCli(argv, { configDir, cacheDir, exec, stdout })).rejects.toThrow(
        /Conflicting update commands/u,
      );
    }
    expect((await readAutoUpdateConfig({ configDir })).enabled).toBe(false);
  });

  it("skips update checks when the working tree is dirty or on a feature branch", async () => {
    const configDir = await makeTempDir();
    const cacheDir = await makeTempDir();

    const dirtyExec = (_cmd, args, cb) => {
      if (args.includes("--abbrev-ref")) return cb(null, "main\n");
      if (args.includes("--porcelain")) return cb(null, " M README.md\n");
      if (args.includes("rev-parse")) return cb(null, "1111111\n");
      cb(null, "");
    };
    const dirtyCheck = await checkOrkestUpdate({
      configDir,
      cacheDir,
      repoRoot: "/repo",
      exec: dirtyExec,
    });
    expect(dirtyCheck).toMatchObject({
      ok: true,
      status: "skipped_dirty_or_branch",
      branch: "main",
      dirty: true,
      updateAvailable: false,
    });

    const branchExec = (_cmd, args, cb) => {
      if (args.includes("--abbrev-ref")) return cb(null, "feat/custom\n");
      if (args.includes("--porcelain")) return cb(null, "");
      if (args.includes("rev-parse")) return cb(null, "1111111\n");
      cb(null, "");
    };
    const branchCheck = await checkOrkestUpdate({
      configDir,
      cacheDir,
      repoRoot: "/repo",
      exec: branchExec,
    });
    expect(branchCheck).toMatchObject({
      ok: true,
      status: "skipped_dirty_or_branch",
      branch: "feat/custom",
      dirty: false,
      updateAvailable: false,
    });
  });

  it("throttles background --auto checks within intervalMs and reports up_to_date when HEAD matches upstream", async () => {
    const configDir = await makeTempDir();
    const cacheDir = await makeTempDir();
    const statePath = getUpdateStatePath({ cacheDir });
    await writeFile(
      statePath,
      JSON.stringify({ lastCheckedAt: new Date(100_000).toISOString(), status: "up_to_date" }),
      "utf8",
    );

    const throttled = await runOrkestUpdate({
      auto: true,
      now: 100_000 + DEFAULT_UPDATE_INTERVAL_MS - 1000,
      configDir,
      cacheDir,
      exec: () => {
        throw new Error("should not run git when throttled");
      },
    });
    expect(throttled).toMatchObject({
      ok: true,
      status: "throttled",
      updated: false,
    });

    const upToDateExec = (_cmd, args, cb) => {
      if (args.includes("--abbrev-ref")) return cb(null, "main\n");
      if (args.includes("--porcelain") || args.includes("fetch")) return cb(null, "");
      if (args.includes("HEAD..origin/main") || args.includes("origin/main..HEAD")) {
        return cb(null, "0\n");
      }
      if (args.includes("rev-parse")) return cb(null, "abcdef1234567890\n");
      cb(null, "");
    };
    const upToDate = await runOrkestUpdate({
      auto: true,
      now: 100_000 + DEFAULT_UPDATE_INTERVAL_MS + 5000,
      configDir,
      cacheDir,
      repoRoot: "/repo",
      exec: upToDateExec,
    });
    expect(upToDate).toMatchObject({
      ok: true,
      status: "up_to_date",
      updated: false,
      commitsBehind: 0,
    });
  });

  it("fast-forwards clean main, refreshes mailbox hooks, and invokes legacy migration on update", async () => {
    const configDir = await makeTempDir();
    const cacheDir = await makeTempDir();
    const executed = [];
    let cleanupOpts = null;

    const updateExec = (cmd, args, cb) => {
      executed.push([cmd, args]);
      if (cmd === "git") {
        if (args.includes("--abbrev-ref")) return cb(null, "main\n");
        if (args.includes("--porcelain") || args.includes("fetch")) return cb(null, "");
        if (args.includes("HEAD..origin/main")) return cb(null, "3\n");
        if (args.includes("origin/main..HEAD")) return cb(null, "0\n");
        if (args.includes("origin/main") && args.includes("rev-parse")) {
          return cb(null, "bbbb2222\n");
        }
        if (args.includes("HEAD") && args.includes("rev-parse")) {
          return cb(null, "aaaa1111\n");
        }
        if (args.includes("merge")) return cb(null, "Updating aaaa1111..bbbb2222\n");
      }
      cb(null, "");
    };

    const res = await runOrkestUpdate({
      now: 500_000,
      configDir,
      cacheDir,
      repoRoot: "/repo",
      exec: updateExec,
      cleanupFn: async (opts) => {
        cleanupOpts = opts;
        return { migrated: true };
      },
    });

    expect(res).toEqual({
      ok: true,
      status: "updated",
      updated: true,
      branch: "main",
      fromSha: "aaaa1111",
      toSha: "bbbb2222",
      commitsBehind: 3,
      cleanup: { migrated: true },
    });
    expect(
      executed.some(
        ([cmd, args]) => cmd === "git" && args.includes("merge") && args.includes("--ff-only"),
      ),
    ).toBe(true);
    expect(
      executed.some(
        ([cmd, args]) =>
          cmd === "python3" && args.some((item) => item.endsWith("install_mailbox.py")),
      ),
    ).toBe(true);
    expect(cleanupOpts).toMatchObject({ migrateLegacy: true, dryRun: false });

    const savedState = JSON.parse(await readFile(getUpdateStatePath({ cacheDir }), "utf8"));
    expect(savedState).toMatchObject({
      status: "updated",
      fromSha: "aaaa1111",
      toSha: "bbbb2222",
      localSha: "bbbb2222",
      remoteSha: "bbbb2222",
      commitsBehind: 3,
    });
  });

  it("calls the exported migration during update without pruning cleanup state", async () => {
    const configDir = await makeTempDir();
    const cacheDir = await makeTempDir();
    const fakeHome = await makeTempDir();
    const legacyCache = path.join(fakeHome, ".cache", "agent-executor");
    const staleLock = path.join(legacyCache, "locks", "old.lock");
    await mkdir(path.dirname(staleLock), { recursive: true });
    await writeFile(staleLock, JSON.stringify({ pid: 99_999_999, released: false }), "utf8");
    await utimes(staleLock, new Date(1), new Date(1));
    const env = {
      HOME: fakeHome,
      XDG_CACHE_HOME: path.join(fakeHome, ".cache"),
      XDG_CONFIG_HOME: path.join(fakeHome, ".config"),
      XDG_DATA_HOME: path.join(fakeHome, ".local", "share"),
    };
    let output = "";
    const stdout = { write: (chunk) => (output += chunk) };
    const executed = [];
    const updateExec = (cmd, args, cb) => {
      executed.push([cmd, args]);
      if (cmd === "git") {
        if (args.includes("--abbrev-ref")) return cb(null, "main\n");
        if (args.includes("--porcelain") || args.includes("fetch")) return cb(null, "");
        if (args.includes("HEAD..origin/main")) return cb(null, "1\n");
        if (args.includes("origin/main..HEAD")) return cb(null, "0\n");
        if (args.includes("origin/main") && args.includes("rev-parse")) {
          return cb(null, "bbbb2222\n");
        }
        if (args.includes("HEAD") && args.includes("rev-parse")) return cb(null, "aaaa1111\n");
        if (args.includes("merge")) return cb(null, "Updating aaaa1111..bbbb2222\n");
      }
      cb(null, "");
    };

    const result = await runUpdateCli(["--apply"], {
      configDir,
      cacheDir,
      env,
      now: 500_000,
      repoRoot: "/repo",
      exec: updateExec,
      stdout,
    });

    expect(result).toMatchObject({
      status: "updated",
      cleanup: {
        requested: true,
        cache: { status: "migrated", changed: true },
        config: { status: "created_and_linked", changed: true },
        repairedWorktrees: [],
      },
    });
    expect(output.match(/Legacy state migration:/gu)).toHaveLength(1);
    expect(
      await readFile(path.join(fakeHome, ".cache", "orchestrate", "locks", "old.lock"), "utf8"),
    ).toContain("99999999");
    expect(executed.some(([cmd]) => cmd === "python3")).toBe(true);
    expect(executed.some(([cmd, args]) => cmd === "git" && args.includes("merge"))).toBe(true);

    output = "";
    const jsonResult = await runUpdateCli(["--apply", "--json"], {
      configDir,
      cacheDir,
      env,
      now: 600_000,
      repoRoot: "/repo",
      exec: updateExec,
      stdout,
    });
    expect(JSON.parse(output).cleanup).toEqual(jsonResult.cleanup);
    expect(jsonResult.cleanup.cache.status).toBe("already_migrated");
  });

  it("reports migration failures while keeping an otherwise successful update successful", async () => {
    const configDir = await makeTempDir();
    const cacheDir = await makeTempDir();
    let output = "";
    const updateExec = (cmd, args, cb) => {
      if (cmd === "git") {
        if (args.includes("--abbrev-ref")) return cb(null, "main\n");
        if (args.includes("--porcelain") || args.includes("fetch")) return cb(null, "");
        if (args.includes("HEAD..origin/main")) return cb(null, "1\n");
        if (args.includes("origin/main..HEAD")) return cb(null, "0\n");
        if (args.includes("origin/main") && args.includes("rev-parse")) {
          return cb(null, "bbbb2222\n");
        }
        if (args.includes("HEAD") && args.includes("rev-parse")) return cb(null, "aaaa1111\n");
      }
      cb(null, "");
    };

    const result = await runUpdateCli(["--apply"], {
      configDir,
      cacheDir,
      repoRoot: "/repo",
      exec: updateExec,
      cleanupFn: async () => {
        throw new Error("migration lock is busy");
      },
      stdout: { write: (chunk) => (output += chunk) },
    });

    expect(result).toMatchObject({
      ok: true,
      status: "updated",
      updated: true,
      migrationError: "migration lock is busy",
    });
    expect(output.match(/Legacy state migration failed:/gu)).toHaveLength(1);
    expect(output).toContain("migration lock is busy");
  });

  it("reads local git HEAD across loose refs, packed-refs, and linked worktrees, and resolves pruned worktrees", async () => {
    const shaA = "1111111111111111111111111111111111111111";
    const shaB = "2222222222222222222222222222222222222222";
    const primary = await makeTempDir();
    await mkdir(path.join(primary, ".git", "refs", "heads"), { recursive: true });
    await writeFile(path.join(primary, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
    await writeFile(path.join(primary, ".git", "refs", "heads", "main"), `${shaA}\n`, "utf8");
    expect(await readLocalGitHeadSha(primary)).toBe(shaA);

    // Packed-refs resolution when loose ref is absent:
    await rm(path.join(primary, ".git", "refs", "heads", "main"));
    await writeFile(
      path.join(primary, ".git", "packed-refs"),
      `# pack-refs with: peeled fully-peeled sorted\n${shaB} refs/heads/main\n`,
      "utf8",
    );
    expect(await readLocalGitHeadSha(primary)).toBe(shaB);

    // Linked worktree resolves back to primary repo root:
    const wtGitDir = path.join(primary, ".git", "worktrees", "wt-demo");
    await mkdir(wtGitDir, { recursive: true });
    await writeFile(path.join(wtGitDir, "commondir"), "../..\n", "utf8");
    await writeFile(path.join(wtGitDir, "HEAD"), "ref: refs/heads/main\n", "utf8");
    const wtCheckout = await makeTempDir();
    await writeFile(path.join(wtCheckout, ".git"), `gitdir: ${wtGitDir}\n`, "utf8");
    expect(await resolveOrkestRepoRoot({ defaultRepoRoot: wtCheckout })).toBe(primary);
    expect(await readLocalGitHeadSha(wtCheckout)).toBe(shaB);

    // Pruned disposable worktree falls back via ~/.agents/skills/orchestrate symlink:
    const fakeHome = await makeTempDir();
    const skillTarget = path.join(primary, "plugins", "orchestrate", "skills", "orchestrate");
    await mkdir(skillTarget, { recursive: true });
    await mkdir(path.join(fakeHome, ".agents", "skills"), { recursive: true });
    await symlink(skillTarget, path.join(fakeHome, ".agents", "skills", "orchestrate"));
    const missingWorktree = path.join(primary, "does-not-exist-anymore");
    expect(await resolveOrkestRepoRoot({ defaultRepoRoot: missingWorktree, home: fakeHome })).toBe(
      await realpath(primary),
    );
  });

  it("clears stale cross-session Update banners without refetching and handles up_to_date clicks cleanly", async () => {
    const shaOld = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const shaNew = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const repoRoot = await makeTempDir();
    const cacheDir = await makeTempDir();
    await mkdir(path.join(repoRoot, ".git", "refs", "heads"), { recursive: true });
    await writeFile(path.join(repoRoot, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
    await writeFile(path.join(repoRoot, ".git", "refs", "heads", "main"), `${shaOld}\n`, "utf8");

    let checkCalls = 0;
    const initial = await cachedUpdateStatus({
      force: true,
      now: 10_000,
      repoRoot,
      cacheDir,
      checkFn: async () => {
        checkCalls += 1;
        return {
          updateAvailable: true,
          commitsBehind: 2,
          localSha: shaOld,
          remoteSha: shaNew,
          dirty: false,
        };
      },
    });
    expect(initial).toMatchObject({
      available: true,
      commitsBehind: 2,
      localSha: shaOld,
      remoteSha: shaNew,
      status: "available",
    });
    expect(checkCalls).toBe(1);

    // Still behind 1 second later -> stays available from cache without calling checkFn:
    const stillBehind = await cachedUpdateStatus({
      now: 11_000,
      repoRoot,
      cacheDir,
      checkFn: async () => {
        throw new Error("should not refetch while local HEAD is unchanged");
      },
    });
    expect(stillBehind.available).toBe(true);

    // Another session fast-forwards main on disk -> next tick immediately clears banner without calling checkFn:
    await writeFile(path.join(repoRoot, ".git", "refs", "heads", "main"), `${shaNew}\n`, "utf8");
    const afterSiblingPull = await cachedUpdateStatus({
      now: 12_000,
      repoRoot,
      cacheDir,
      checkFn: async () => {
        throw new Error("should clear banner from local HEAD without network fetch");
      },
    });
    expect(afterSiblingPull).toMatchObject({
      available: false,
      commitsBehind: 0,
      localSha: shaNew,
      remoteSha: shaNew,
      status: "up_to_date",
    });

    // Clicking Update when another session already updated clears banner instead of reporting an error:
    const upToDateClick = resolvePullUpdateOutcome(
      { ok: true, updated: false, status: "up_to_date", localSha: shaNew },
      20_000,
    );
    expect(upToDateClick).toEqual({
      updateState: null,
      notice: "Orkest is already up to date.",
    });

    const updatedClick = resolvePullUpdateOutcome(
      { ok: true, updated: true, status: "updated", toSha: shaNew, commitsBehind: 2 },
      25_000,
    );
    expect(updatedClick.updateState).toEqual({
      available: false,
      status: "updated",
      toSha: shaNew,
      commitsBehind: 2,
      completedAt: 25_000,
    });
    expect(UPDATE_SUCCESS_TTL_MS).toBeGreaterThanOrEqual(5000);
  });
});
