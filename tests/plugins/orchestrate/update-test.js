import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  checkOrkestUpdate,
  DEFAULT_UPDATE_INTERVAL_MS,
  getUpdateStatePath,
  readAutoUpdateConfig,
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
      commitsBehind: 3,
    });
  });
});
