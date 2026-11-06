import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { bootstrapWorktreeInclude } from "../../../plugins/orchestrate/lib/worktree-env.mjs";

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
