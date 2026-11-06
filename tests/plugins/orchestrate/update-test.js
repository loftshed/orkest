import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  cachedUpdateStatus,
  resolvePullUpdateOutcome,
  UPDATE_SUCCESS_TTL_MS,
} from "../../../plugins/orchestrate/bin/horde-tui.mjs";
import {
  checkOrkestUpdate,
  DEFAULT_UPDATE_INTERVAL_MS,
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

  it("fast-forwards clean main, runs install_mailbox.py, and invokes legacy cleanup on update", async () => {
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
