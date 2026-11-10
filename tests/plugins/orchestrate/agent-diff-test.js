import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { readAgentDiff } from "../../../plugins/orchestrate/lib/agent-diff.mjs";

const execute = promisify(execFile);
const temporary = [];

async function setupRepository() {
  const root = await mkdtemp(path.join(tmpdir(), "ork-agent-diff-"));
  temporary.push(root);
  const repository = path.join(root, "repo");
  await mkdir(repository);
  await execute("git", ["init", "--quiet"], { cwd: repository });
  await execute("git", ["config", "user.name", "Orkest test"], { cwd: repository });
  await execute("git", ["config", "user.email", "orkest-test@example.invalid"], {
    cwd: repository,
  });
  return { root, repository };
}

async function git(repository, args) {
  return (await execute("git", args, { cwd: repository })).stdout;
}

async function writeResult(root, repository, changedPaths) {
  const resultPath = path.join(root, "result.json");
  const status = (await git(repository, ["status", "--short", "--untracked-files=all"]))
    .split("\n")
    .filter(Boolean);
  await writeFile(
    resultPath,
    JSON.stringify({
      repository,
      run_delta: { changed_paths: changedPaths },
      git_after: { status, fingerprint: "test-fingerprint" },
    }),
  );
  return resultPath;
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("readAgentDiff", () => {
  it("shows only recorded tracked, deleted, spaced and untracked paths without writing", async () => {
    const { root, repository } = await setupRepository();
    const initialFiles = {
      "tracked.txt": "original tracked line\n",
      "deleted.txt": "remove this line\n",
      "with spaces.txt": "old spaced line\n",
      "outside.txt": "outside original\n",
    };
    for (const [filePath, text] of Object.entries(initialFiles))
      await writeFile(path.join(repository, filePath), text);
    await git(repository, ["add", "--", "."]);
    await git(repository, ["commit", "--quiet", "-m", "baseline"]);

    await writeFile(path.join(repository, "tracked.txt"), "updated tracked line\n");
    await rm(path.join(repository, "deleted.txt"));
    await writeFile(path.join(repository, "with spaces.txt"), "updated spaced line\n");
    await writeFile(path.join(repository, "outside.txt"), "outside unrelated change\n");
    await writeFile(path.join(repository, "new file.txt"), "untracked addition\n");
    await symlink("outside.txt", path.join(repository, "external-link"));
    const changedPaths = [
      "tracked.txt",
      "deleted.txt",
      "with spaces.txt",
      "new file.txt",
      "external-link",
    ];
    const resultPath = await writeResult(root, repository, changedPaths);
    const statusBefore = await git(repository, ["status", "--porcelain=v1", "-z"]);
    const indexBefore = await readFile(path.join(repository, ".git/index"));

    const snapshot = await readAgentDiff({ id: "worker", name: "worker", resultPath });

    expect(snapshot).toMatchObject({ kind: "diff", available: true, stale: false });
    expect(snapshot.files.map((file) => file.path)).toEqual(changedPaths);
    expect(snapshot.text).toContain("updated tracked line");
    expect(snapshot.text).toContain("remove this line");
    expect(snapshot.text).toContain("updated spaced line");
    expect(snapshot.text).toContain("untracked addition");
    expect(snapshot.text).toContain("+outside.txt");
    expect(snapshot.text).not.toContain("outside unrelated change");
    expect(snapshot.files).toEqual([
      { path: "tracked.txt", added: 1, removed: 1 },
      { path: "deleted.txt", added: 0, removed: 1 },
      { path: "with spaces.txt", added: 1, removed: 1 },
      { path: "new file.txt", added: 1, removed: 0 },
      { path: "external-link", added: 1, removed: 0 },
    ]);
    expect(await readFile(path.join(repository, ".git/index"))).toEqual(indexBefore);
    expect(await git(repository, ["status", "--porcelain=v1", "-z"])).toBe(statusBefore);
    expect(await readFile(resultPath, "utf8")).toContain("test-fingerprint");
  });

  it("returns one-line unavailable snapshots for missing and unreadable results", async () => {
    expect(await readAgentDiff({ id: "worker" })).toMatchObject({
      kind: "diff",
      available: false,
      text: "No recorded worker result is available for this agent.",
    });
    const snapshot = await readAgentDiff({ id: "worker", resultPath: "/missing/result.json" });
    expect(snapshot.available).toBe(false);
    expect(snapshot.text).toBe("The worker result could not be read.");
    expect(snapshot.text).not.toMatch(/[\r\n]/u);
  });

  it("marks the snapshot stale when recorded path status no longer matches", async () => {
    const { root, repository } = await setupRepository();
    await writeFile(path.join(repository, "tracked.txt"), "baseline\n");
    await git(repository, ["add", "--", "tracked.txt"]);
    await git(repository, ["commit", "--quiet", "-m", "baseline"]);
    await writeFile(path.join(repository, "tracked.txt"), "worker result\n");
    const resultPath = await writeResult(root, repository, ["tracked.txt"]);
    await writeFile(path.join(repository, "tracked.txt"), "baseline\n");

    const snapshot = await readAgentDiff({ id: "worker", resultPath });

    expect(snapshot.stale).toBe(true);
  });

  it("adds an omission notice when a diff exceeds the line cap", async () => {
    const { root, repository } = await setupRepository();
    const pathToFile = path.join(repository, "large.txt");
    const original = Array.from({ length: 4200 }, (_, index) => `old line ${index}`).join("\n");
    const replacement = Array.from({ length: 4200 }, (_, index) => `new line ${index}`).join("\n");
    await writeFile(pathToFile, `${original}\n`);
    await git(repository, ["add", "--", "large.txt"]);
    await git(repository, ["commit", "--quiet", "-m", "baseline"]);
    await writeFile(pathToFile, `${replacement}\n`);
    const resultPath = await writeResult(root, repository, ["large.txt"]);

    const snapshot = await readAgentDiff({ id: "worker", resultPath });

    expect(snapshot.text).toContain("Omitted diff output");
    expect(snapshot.text.split("\n").length).toBeLessThanOrEqual(4000);
    expect(snapshot.files).toEqual([{ path: "large.txt", added: 4200, removed: 4200 }]);
  });
});
