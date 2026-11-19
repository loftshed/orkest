import { execFileSync } from "node:child_process";
import { spawnSync } from "node:child_process";
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import {
  link as hardLink,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  bootstrapWorktreeInclude,
  linkWorktreeDirs,
  parseWorktreeConfig,
  previewWorktreeLinks,
  worktreeLaunchEnv,
  worktreePortEnv,
} from "../../../plugins/orchestrate/lib/worktree-env.mjs";
import { allocateWorktreePorts } from "../../../plugins/orchestrate/lib/worktree-ports.mjs";

const tempDirs = [];

async function makeTempDir(prefix) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop(), { force: true, recursive: true });
  }
});

describe("worktree-env bootstrapWorktreeInclude", () => {
  it("propagates untracked root .env files with 0600 mode without requiring .worktreeinclude and skips templates or tracked files", async () => {
    const repoRoot = await makeTempDir("ork-wt-env-repo-");
    const worktreePath = await makeTempDir("ork-wt-env-dest-");

    execFileSync("git", ["init", "-q"], { cwd: repoRoot });
    await writeFile(path.join(repoRoot, ".env.tracked"), "TRACKED=1\n");
    await writeFile(path.join(repoRoot, ".env.example"), "EXAMPLE=1\n");
    execFileSync("git", ["add", ".env.tracked", ".env.example"], { cwd: repoRoot });

    await writeFile(path.join(repoRoot, ".env"), "DATABASE_URL=postgres://localhost/dev\n");
    await writeFile(path.join(repoRoot, ".env.local"), "PORT=4173\n");

    const copied = bootstrapWorktreeInclude(repoRoot, worktreePath);
    expect(copied).toEqual([".env", ".env.local"]);
    expect(await readFile(path.join(repoRoot, ".env"), "utf8")).toBe(
      await readFile(path.join(worktreePath, ".env"), "utf8"),
    );
    expect((await stat(path.join(worktreePath, ".env"))).mode & 0o777).toBe(0o600);
    expect((await stat(path.join(worktreePath, ".env.local"))).mode & 0o777).toBe(0o600);
  });

  it("supports !pattern exclusions, preserves existing files when overwrite is false, and blocks traversal or external symlinks", async () => {
    const outsideDir = await makeTempDir("ork-wt-env-outside-");
    const repoRoot = await makeTempDir("ork-wt-env-sec-src-");
    const worktreePath = await makeTempDir("ork-wt-env-sec-dst-");

    const outsideSecret = path.join(outsideDir, "outside.txt");
    await writeFile(outsideSecret, "do-not-copy\n");
    await symlink(outsideSecret, path.join(repoRoot, ".env.symlink"));

    await mkdir(path.join(repoRoot, ".git"), { recursive: true });
    await writeFile(path.join(repoRoot, ".git", "config"), "[core]\n");
    await writeFile(path.join(repoRoot, ".env"), "MAIN=1\n");
    await writeFile(path.join(repoRoot, ".env.production.local"), "PROD=1\n");
    await writeFile(
      path.join(repoRoot, ".worktreeinclude"),
      [
        "../outside.txt",
        "/etc/hosts",
        ".git/config",
        ".env.symlink",
        "!.env.production.local",
      ].join("\n"),
    );

    await writeFile(path.join(worktreePath, ".env"), "WORKTREE_CUSTOM=1\n");
    const copiedNoOverwrite = bootstrapWorktreeInclude(repoRoot, worktreePath, {
      overwrite: false,
    });
    expect(copiedNoOverwrite).toEqual([]);
    expect(await readFile(path.join(worktreePath, ".env"), "utf8")).toBe("WORKTREE_CUSTOM=1\n");

    const copiedOverwrite = bootstrapWorktreeInclude(repoRoot, worktreePath, { overwrite: true });
    expect(copiedOverwrite).toEqual([".env"]);
    expect(await readFile(path.join(worktreePath, ".env"), "utf8")).toBe("MAIN=1\n");
  });
});

async function gitRepo(files = {}) {
  const repo = await makeTempDir("ork-wt-cfg-");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Env Tests"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "env@example.invalid"], { cwd: repo });
  await writeFile(path.join(repo, ".gitignore"), "node_modules\n");
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(repo, name)), { recursive: true });
    await writeFile(path.join(repo, name), content);
  }
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "fixture"], { cwd: repo });
  return realpathSync(repo);
}

function addWorktree(repo, name) {
  const target = path.join(repo, ".worktrees", name);
  execFileSync("git", ["worktree", "add", "-q", "-b", name, target, "HEAD"], { cwd: repo });
  return realpathSync(target);
}

describe("parseWorktreeConfig", () => {
  it("treats a missing config as legacy defaults", async () => {
    const repo = await gitRepo();
    expect(parseWorktreeConfig(repo)).toMatchObject({
      present: false,
      sha256: null,
      config: { symlinkDirs: [], copyFiles: [], setupCommand: null, ports: null },
    });
  });

  it("parses the frozen shape and hashes the exact bytes", async () => {
    const body = JSON.stringify({
      version: 1,
      symlinkDirs: ["node_modules", "packages/app/node_modules"],
      copyFiles: ["config/local.json"],
      setupCommand: ["node", "scripts/setup.mjs"],
      ports: { names: ["WEB_PORT"], rangeStart: 32_000, rangeEnd: 32_010 },
    });
    const repo = await gitRepo({ ".orkest/worktree.json": body });
    const parsed = parseWorktreeConfig(repo);
    expect(parsed.present).toBe(true);
    expect(parsed.config.ports).toEqual({
      names: ["WEB_PORT"],
      rangeStart: 32_000,
      rangeEnd: 32_010,
    });
    const { createHash } = await import("node:crypto");
    expect(parsed.sha256).toBe(createHash("sha256").update(body).digest("hex"));

    const defaults = await gitRepo({
      ".orkest/worktree.json": JSON.stringify({ version: 1, ports: { names: ["PORT"] } }),
    });
    expect(parseWorktreeConfig(defaults).config.ports).toEqual({
      names: ["PORT"],
      rangeStart: 31_000,
      rangeEnd: 49_151,
    });
  });

  it.each([
    ["malformed JSON", "{nope"],
    ["unknown key", JSON.stringify({ version: 1, extra: true })],
    ["wrong version", JSON.stringify({ version: 2 })],
    ["array root", "[]"],
    ["absolute path", JSON.stringify({ version: 1, symlinkDirs: ["/etc"] })],
    ["parent traversal", JSON.stringify({ version: 1, symlinkDirs: ["../out"] })],
    ["non-normalized", JSON.stringify({ version: 1, symlinkDirs: ["a//b"] })],
    ["glob", JSON.stringify({ version: 1, copyFiles: ["*.env"] })],
    ["git dir", JSON.stringify({ version: 1, copyFiles: [".git/config"] })],
    ["worktrees dir", JSON.stringify({ version: 1, symlinkDirs: [".worktrees/x"] })],
    ["orkest dir", JSON.stringify({ version: 1, copyFiles: [".orkest/worktree.json"] })],
    ["duplicates", JSON.stringify({ version: 1, symlinkDirs: ["a", "a"] })],
    ["link/copy overlap", JSON.stringify({ version: 1, symlinkDirs: ["a"], copyFiles: ["a/b"] })],
    ["empty argv", JSON.stringify({ version: 1, setupCommand: [] })],
    ["string argv", JSON.stringify({ version: 1, setupCommand: "npm ci" })],
    ["reserved port name", JSON.stringify({ version: 1, ports: { names: ["PATH"] } })],
    ["loader port name", JSON.stringify({ version: 1, ports: { names: ["LD_PRELOAD"] } })],
    ["secret-like port name", JSON.stringify({ version: 1, ports: { names: ["API_TOKEN"] } })],
    ["lowercase port", JSON.stringify({ version: 1, ports: { names: ["web"] } })],
    ["duplicate port", JSON.stringify({ version: 1, ports: { names: ["A", "A"] } })],
    ["bad range", JSON.stringify({ version: 1, ports: { names: ["A"], rangeStart: 90 } })],
    ["unknown ports key", JSON.stringify({ version: 1, ports: { names: ["A"], host: "x" } })],
  ])("rejects %s", async (_label, body) => {
    const repo = await gitRepo({ ".orkest/worktree.json": body });
    expect(() => parseWorktreeConfig(repo)).toThrow(
      expect.objectContaining({ stage: "bootstrap", substage: "config" }),
    );
  });

  it("rejects oversize, symlinked file and symlinked directory", async () => {
    const big = await gitRepo({
      ".orkest/worktree.json": JSON.stringify({ version: 1, pad: "x".repeat(70_000) }),
    });
    expect(() => parseWorktreeConfig(big)).toThrow(/too large|exceeds/u);

    const linkedFile = await gitRepo();
    await mkdir(path.join(linkedFile, ".orkest"));
    await writeFile(path.join(linkedFile, "real.json"), '{"version":1}');
    await symlink("../real.json", path.join(linkedFile, ".orkest", "worktree.json"));
    expect(() => parseWorktreeConfig(linkedFile)).toThrow(/symlink/u);

    const linkedDir = await gitRepo();
    await mkdir(path.join(linkedDir, "elsewhere"));
    await writeFile(path.join(linkedDir, "elsewhere", "worktree.json"), '{"version":1}');
    await symlink("elsewhere", path.join(linkedDir, ".orkest"));
    expect(() => parseWorktreeConfig(linkedDir)).toThrow(/real directory/u);
  });
});

describe("copyFiles and links", () => {
  it("composes copyFiles with .worktreeinclude and lets exclusions win", async () => {
    const repo = await gitRepo({ ".worktreeinclude": "a.local\n!blocked.local\n" });
    await writeFile(path.join(repo, "a.local"), "a\n");
    await writeFile(path.join(repo, "b.local"), "b\n");
    await writeFile(path.join(repo, "blocked.local"), "x\n");
    const wt = addWorktree(repo, "compose");
    const copied = bootstrapWorktreeInclude(repo, wt, {
      overwrite: false,
      extraIncludes: ["b.local", "blocked.local"],
    });
    expect(copied).toEqual(["a.local", "b.local"]);
  });

  it("never writes through a symlinked destination parent or a hard link", async () => {
    const repo = await gitRepo({ ".worktreeinclude": "conf/app.local\nkeep.local\n" });
    await mkdir(path.join(repo, "conf"));
    await writeFile(path.join(repo, "conf", "app.local"), "new\n");
    await writeFile(path.join(repo, "keep.local"), "new\n");
    const wt = addWorktree(repo, "escape");
    const outside = await makeTempDir("ork-wt-outside-");
    await symlink(outside, path.join(wt, "conf"));
    const shared = path.join(outside, "shared.txt");
    await writeFile(shared, "precious\n");
    await hardLink(shared, path.join(wt, "keep.local"));

    const copied = bootstrapWorktreeInclude(repo, wt, { overwrite: true });
    expect(copied).toEqual([]);
    await expect(readFile(path.join(outside, "app.local"), "utf8")).rejects.toThrow();
    expect(await readFile(shared, "utf8")).toBe("precious\n");
    expect(lstatSync(path.join(wt, "keep.local")).nlink).toBe(2);
  });

  it("creates, reuses and refuses to replace configured directory links", async () => {
    const repo = await gitRepo();
    await mkdir(path.join(repo, "node_modules", "pkg"), { recursive: true });
    await writeFile(path.join(repo, "node_modules", "pkg", "index.js"), "1\n");
    const wt = addWorktree(repo, "links");

    previewWorktreeLinks(repo, wt, ["node_modules"]);
    expect(linkWorktreeDirs(repo, wt, ["node_modules"])).toEqual([
      { path: "node_modules", status: "linked" },
    ]);
    expect(readlinkSync(path.join(wt, "node_modules"))).toBe(
      realpathSync(path.join(repo, "node_modules")),
    );
    expect(await readFile(path.join(wt, "node_modules", "pkg", "index.js"), "utf8")).toBe("1\n");
    expect(linkWorktreeDirs(repo, wt, ["node_modules"])).toEqual([
      { path: "node_modules", status: "reused" },
    ]);
    // The generated link does not make the tree dirty.
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: wt, encoding: "utf8" })).toBe("");

    const other = addWorktree(repo, "links-conflict");
    await mkdir(path.join(other, "node_modules"));
    await writeFile(path.join(other, "node_modules", "mine.txt"), "mine\n");
    expect(() => linkWorktreeDirs(repo, other, ["node_modules"])).toThrow(
      expect.objectContaining({ code: "ORK_WORKTREE_LINK_CONFLICT" }),
    );
    expect(await readFile(path.join(other, "node_modules", "mine.txt"), "utf8")).toBe("mine\n");

    const wrong = addWorktree(repo, "links-wrong");
    const decoy = await makeTempDir("ork-wt-decoy-");
    await symlink(decoy, path.join(wrong, "node_modules"));
    expect(() => linkWorktreeDirs(repo, wrong, ["node_modules"])).toThrow(
      expect.objectContaining({ code: "ORK_WORKTREE_LINK_CONFLICT" }),
    );
    expect(readlinkSync(path.join(wrong, "node_modules"))).toBe(decoy);
  });

  it("skips a missing source and refuses a source that is a symlink", async () => {
    const repo = await gitRepo();
    const wt = addWorktree(repo, "missing-source");
    expect(linkWorktreeDirs(repo, wt, ["node_modules"])).toEqual([
      { path: "node_modules", status: "skipped-missing" },
    ]);
    const outside = await makeTempDir("ork-wt-src-");
    await symlink(outside, path.join(repo, "node_modules"));
    expect(() => linkWorktreeDirs(repo, wt, ["node_modules"])).toThrow(
      expect.objectContaining({ code: "ORK_WORKTREE_LINK_UNSAFE" }),
    );
  });

  it("rejects tracked paths and non-ignored links with a repo-local suggestion", async () => {
    const repo = await gitRepo({ "vendor/lib.txt": "tracked\n" });
    await mkdir(path.join(repo, "cache"));
    const wt = addWorktree(repo, "preview");
    expect(() => previewWorktreeLinks(repo, wt, ["vendor"])).toThrow(
      expect.objectContaining({ code: "ORK_WORKTREE_LINK_TRACKED" }),
    );
    let thrown;
    try {
      previewWorktreeLinks(repo, wt, ["cache"]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown.code).toBe("ORK_WORKTREE_LINK_NOT_IGNORED");
    expect(thrown.message).toContain('"/cache"');
    // The shared excludes were not edited on the user's behalf.
    let excludes = "";
    try {
      excludes = await readFile(path.join(repo, ".git", "info", "exclude"), "utf8");
    } catch {
      // No exclude file at all also means nothing was edited.
    }
    expect(excludes).not.toContain("cache");
  });

  it("treats a directory-only ignore pattern as not hiding the generated link", async () => {
    const repo = await gitRepo();
    await writeFile(path.join(repo, ".gitignore"), "node_modules/\n");
    execFileSync("git", ["commit", "-q", "-am", "dir pattern"], { cwd: repo });
    await mkdir(path.join(repo, "node_modules"));
    const wt = addWorktree(repo, "dir-pattern");
    expect(() => previewWorktreeLinks(repo, wt, ["node_modules"])).toThrow(
      expect.objectContaining({ code: "ORK_WORKTREE_LINK_NOT_IGNORED" }),
    );
  });

  it("is dogfooded: this repository ignores a generated node_modules link", () => {
    const here = path.resolve(import.meta.dirname, "../../..");
    const parsed = parseWorktreeConfig(here);
    expect(parsed.config.symlinkDirs).toEqual(["node_modules"]);
    const probe = spawnSync("git", ["check-ignore", "-q", "--no-index", "--", "node_modules"], {
      cwd: here,
    });
    expect(probe.status).toBe(0);
  });
});

describe("worktreeLaunchEnv", () => {
  it("adds allocated ports for a registered worktree and reaches a launched child", async () => {
    const repo = await gitRepo();
    const wt = addWorktree(repo, "launch");
    const cache = await makeTempDir("ork-wt-launch-cache-");
    const base = { ORCHESTRATE_HOME: cache, PATH: process.env.PATH, KEEP: "1" };
    expect(worktreeLaunchEnv(base, { repoRoot: repo, worktreePath: wt })).toEqual(base);
    const ports = await allocateWorktreePorts({
      repoRoot: repo,
      worktreePath: wt,
      names: ["WEB_PORT"],
      env: base,
    });
    const launched = worktreeLaunchEnv(base, { repoRoot: repo, worktreePath: wt });
    expect(launched.WEB_PORT).toBe(String(ports.WEB_PORT));
    expect(base.WEB_PORT).toBeUndefined();
    const child = spawnSync(
      process.execPath,
      ["-e", "process.stdout.write(process.env.WEB_PORT + ':' + process.env.KEEP)"],
      { env: launched, encoding: "utf8", cwd: wt },
    );
    expect(child.stdout).toBe(`${ports.WEB_PORT}:1`);
  });

  it("exposes only the validated port variables through worktreePortEnv, shared with the launch env", async () => {
    const repo = await gitRepo();
    const wt = addWorktree(repo, "port-env");
    const cache = await makeTempDir("ork-wt-portenv-cache-");
    const base = { ORCHESTRATE_HOME: cache, PATH: process.env.PATH, KEEP: "1" };
    expect(worktreePortEnv({ repoRoot: repo, worktreePath: wt, env: base })).toEqual({});
    const ports = await allocateWorktreePorts({
      repoRoot: repo,
      worktreePath: wt,
      names: ["WEB_PORT", "API_PORT"],
      env: base,
    });
    const only = worktreePortEnv({ repoRoot: repo, worktreePath: wt, env: base });
    expect(Object.keys(only).toSorted((a, b) => a.localeCompare(b))).toEqual([
      "API_PORT",
      "ORKEST_WORKTREE_PORTS",
      "WEB_PORT",
    ]);
    expect(only.WEB_PORT).toBe(String(ports.WEB_PORT));
    expect(JSON.parse(only.ORKEST_WORKTREE_PORTS)).toEqual(ports);
    expect(worktreeLaunchEnv(base, { repoRoot: repo, worktreePath: wt })).toEqual({
      ...base,
      ...only,
    });
  });
});
