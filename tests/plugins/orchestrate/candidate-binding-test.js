import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  foundryRun,
  readFoundryState,
  resolveFoundryStatePath,
  resolveTaskSpecPath,
  resolveWorktreeGitDir,
  verifyBuilderWorktree,
  writeFoundryState,
} from "../../../plugins/orchestrate/lib/foundry.mjs";
import { nextCommand } from "../../../plugins/orchestrate/lib/next.mjs";
import { smeltWorktree } from "../../../plugins/orchestrate/lib/smelter.mjs";

// All Git mutations stay in retained scratch repositories; markers prohibit pruning.
function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function fixture({ high = false, allowPaths = ["change.txt"] } = {}) {
  // Git reports real paths; macOS temp directories sit behind a symlink.
  const created = mkdtempSync(path.join(tmpdir(), "ork-candidate-retained-"));
  const root = realpathSync(created);
  const repo = path.join(root, "repo");
  const wt = path.join(root, "candidate");
  mkdirSync(repo);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Candidate Test");
  git(repo, "config", "user.email", "candidate@example.invalid");
  for (const file of ["change.txt", "dirty.txt", "staged.txt"])
    writeFileSync(path.join(repo, file), "base\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "base");
  const target = git(repo, "rev-parse", "HEAD");
  git(repo, "worktree", "add", "-b", "builder", wt);
  if (high) mkdirSync(path.join(wt, ".github", "workflows"), { recursive: true });
  const changed = high ? ".github/workflows/build.yml" : "change.txt";
  writeFileSync(path.join(wt, changed), "candidate\n");
  git(wt, "add", changed);
  git(wt, "commit", "-m", "builder");
  const spec = resolveTaskSpecPath(wt);
  mkdirSync(path.dirname(spec), { recursive: true });
  writeFileSync(
    spec,
    JSON.stringify({ allow_paths: high ? [changed] : allowPaths, verify_command: "true" }),
  );
  writeFileSync(
    path.join(resolveWorktreeGitDir(wt), "orkest.json"),
    JSON.stringify({
      disposable: false,
      slug: "candidate",
      branch: "builder",
      parentCwd: "/incorrect-marker-root",
    }),
  );
  writeFoundryState(wt, { status: "verified", attemptCount: 1 });
  return {
    repo,
    wt,
    root,
    target,
    env: { ...process.env, ORCHESTRATE_HOME: path.join(root, "cache") },
  };
}
function smelt(f, options = {}) {
  return smeltWorktree(f.wt, {
    env: f.env,
    gateRunner: async () => "passed",
    reviewRunner: async () => "FINDINGS:\nnone",
    ...options,
  });
}
function targetSnapshot(f) {
  return {
    status: git(f.repo, "status", "--porcelain"),
    index: readFileSync(path.join(f.repo, ".git", "index")),
    files: ["dirty.txt", "staged.txt", "untracked.txt"].map((file) =>
      readFileSync(path.join(f.repo, file)),
    ),
  };
}
function dirtyTarget(f) {
  writeFileSync(path.join(f.repo, "dirty.txt"), "dirty untouched\n");
  writeFileSync(path.join(f.repo, "staged.txt"), "staged untouched\n");
  git(f.repo, "add", "staged.txt");
  writeFileSync(path.join(f.repo, "untracked.txt"), "untracked untouched\n");
}

describe("one pinned candidate with retained real Git", () => {
  it("rebases onto the pinned target, records evidence and preserves target user files", async () => {
    const f = fixture();
    dirtyTarget(f);
    const before = targetSnapshot(f);
    const result = await smelt(f);
    expect(result).toMatchObject({
      ok: true,
      status: "merged",
      pruned: false,
      evidence: {
        schema: "ork.smelter.evidence.v1",
        target: { ref: "refs/heads/main", sha: f.target },
        scope: { result: "passed", changedPaths: ["change.txt"] },
        outcome: "merged",
      },
    });
    expect(result.candidate.commit).toBe(git(f.repo, "rev-parse", "HEAD"));
    expect(result.candidate.tree).toBe(git(f.repo, "rev-parse", "HEAD^{tree}"));
    expect(readFoundryState(f.wt).evidence).toEqual(result.evidence);
    expect(targetSnapshot(f).files).toEqual(before.files);
    expect(targetSnapshot(f).status).toBe(before.status);
    expect(git(f.repo, "show", ":staged.txt")).toBe("staged untouched");
  });

  it("computes scope after rebasing onto the resolved target SHA", async () => {
    const f = fixture();
    writeFileSync(path.join(f.repo, "target-only.txt"), "target advance");
    git(f.repo, "add", "target-only.txt");
    git(f.repo, "commit", "-m", "target advance");
    const target = git(f.repo, "rev-parse", "HEAD");
    const original = git(f.wt, "rev-parse", "HEAD");
    const result = await smelt(f);
    expect(result).toMatchObject({
      ok: true,
      evidence: {
        target: { sha: target },
        mergeBase: target,
        scope: { result: "passed", changedPaths: ["change.txt"] },
      },
    });
    expect(result.candidate.commit).not.toBe(original);
    expect(git(f.wt, "show", "HEAD:target-only.txt")).toBe("target advance");
  });

  it("audits literal Git paths without trimming filenames into the allow-list", async () => {
    const f = fixture();
    writeFileSync(path.join(f.wt, " change.txt"), "outside the allow-list");
    git(f.wt, "add", "--", " change.txt");
    git(f.wt, "commit", "-m", "literal filename");
    const result = await smelt(f);
    expect(result).toMatchObject({
      ok: false,
      status: "scope_violated",
      evidence: { scope: { result: "violated", changedPaths: [" change.txt", "change.txt"] } },
    });
    expect(git(f.repo, "rev-parse", "HEAD")).toBe(f.target);
  });

  it("preserves overlapping target edits when Git refuses a merge", async () => {
    const f = fixture();
    dirtyTarget(f);
    writeFileSync(path.join(f.repo, "change.txt"), "user edit overlaps merge\n");
    const files = targetSnapshot(f).files;
    const indexBlob = git(f.repo, "show", ":staged.txt");
    const result = await smelt(f);
    expect(result).toMatchObject({ ok: false, status: "merge_failed" });
    expect(git(f.repo, "rev-parse", "HEAD")).toBe(f.target);
    expect(targetSnapshot(f).files).toEqual(files);
    expect(git(f.repo, "show", ":staged.txt")).toBe(indexBlob);
    expect(readFileSync(path.join(f.repo, "change.txt"), "utf8")).toBe(
      "user edit overlaps merge\n",
    );
  });

  it("does not claim merged when the target ref cannot be confirmed", async () => {
    const f = fixture();
    let isMerged = false;
    const result = await smelt(f, {
      execFileSyncFn: (cmd, args, options) => {
        if (isMerged && args[0] === "rev-parse" && args[1] === "refs/heads/main")
          return `${f.target}\n`;
        const output = execFileSync(cmd, args, options);
        if (cmd === "git" && args[0] === "merge") isMerged = true;
        return output;
      },
    });
    expect(result).toMatchObject({ ok: false, status: "merge_unconfirmed" });
    expect(readFoundryState(f.wt).status).toBe("verified");
  });

  it.each(["gate", "review"])(
    "refuses a candidate moved after %s and preserves the target",
    async (stage) => {
      const f = fixture();
      dirtyTarget(f);
      const before = targetSnapshot(f);
      const mutate = () => {
        writeFileSync(path.join(f.wt, "change.txt"), "racing candidate\n");
        git(f.wt, "add", "change.txt");
        git(f.wt, "commit", "-m", "racer");
        return "FINDINGS:\nnone";
      };
      const result = await smelt(
        f,
        stage === "gate" ? { gateRunner: mutate } : { reviewRunner: mutate },
      );
      expect(result).toMatchObject({ ok: false, status: "stale_candidate" });
      expect(git(f.repo, "rev-parse", "HEAD")).toBe(f.target);
      expect(targetSnapshot(f)).toEqual(before);
    },
  );

  it("refuses a check that leaves untracked output", async () => {
    const f = fixture();
    const result = await smelt(f, {
      gateRunner: () => writeFileSync(path.join(f.wt, "check-output.txt"), "retained"),
    });
    expect(result.status).toBe("check_mutated_workspace");
    expect(git(f.repo, "rev-parse", "HEAD")).toBe(f.target);
  });

  it("refuses a moved target", async () => {
    const f = fixture();
    const result = await smelt(f, {
      reviewRunner: () => {
        writeFileSync(path.join(f.repo, "target.txt"), "target move");
        git(f.repo, "add", "target.txt");
        git(f.repo, "commit", "-m", "advance target");
        return "FINDINGS:\nnone";
      },
    });
    expect(result.status).toBe("stale_target");
    expect(git(f.repo, "log", "-1", "--format=%s")).toBe("advance target");
  });

  it("uses compare-and-swap when the target has no checkout and reports unchecked scope", async () => {
    const f = fixture({ allowPaths: [] });
    git(f.repo, "symbolic-ref", "HEAD", "refs/heads/parking");
    const result = await smelt(f);
    expect(result).toMatchObject({
      ok: true,
      status: "merged",
      evidence: { scope: { result: "unchecked" } },
    });
    expect(git(f.wt, "rev-parse", "main")).toBe(result.candidate.commit);
    expect(result.commands.some(({ args }) => args[0] === "update-ref")).toBe(true);
  });

  it("refuses a detached target at integration handover", async () => {
    const f = fixture();
    dirtyTarget(f);
    const before = targetSnapshot(f);
    const result = await smelt(f, {
      acquireWorkspaceLeaseFn: async (workspace, options) => {
        const { acquireWorkspaceLease } =
          await import("../../../plugins/orchestrate/lib/workspace-lease.mjs");
        if (workspace === f.repo) git(f.repo, "update-ref", "--no-deref", "HEAD", f.target);
        return acquireWorkspaceLease(workspace, options);
      },
    });
    expect(result.status).toBe("target_detached");
    expect(git(f.wt, "rev-parse", "main")).toBe(f.target);
    expect(targetSnapshot(f)).toEqual(before);
  });

  it("honours a high blast approval only for its candidate", async () => {
    const f = fixture({ high: true });
    const initial = await smelt(f);
    expect(initial.status).toBe("awaiting_human_approval");
    writeFileSync(path.join(f.wt, ".github/workflows/build.yml"), "different candidate\n");
    git(f.wt, "add", ".github/workflows/build.yml");
    git(f.wt, "commit", "-m", "new candidate");
    const changed = await smelt(f, { approveHighBlast: initial.candidate.commit });
    expect(changed.status).toBe("awaiting_human_approval");
    expect(changed.candidate.commit).not.toBe(initial.candidate.commit);
    expect((await smelt(f, { approveHighBlast: changed.candidate.commit })).status).toBe("merged");
  });

  it("reports a missing target and a post-merge state write failure", async () => {
    const f = fixture();
    expect((await smelt(f, { targetBranch: "absent" })).status).toBe("target_missing");
    const result = await smelt(f, {
      execFileSyncFn: (cmd, args, options) => {
        const output = execFileSync(cmd, args, options);
        if (cmd === "git" && args[0] === "merge")
          writeFileSync(resolveFoundryStatePath(f.wt), "corrupt state bytes");
        return output;
      },
    });
    expect(result).toMatchObject({ ok: false, status: "merged_state_unrecorded" });
    expect(git(f.repo, "rev-parse", "HEAD")).toBe(result.candidate.commit);
  });

  it("pushes the candidate SHA refspec with PR strategy", async () => {
    const f = fixture();
    const calls = [];
    const result = await smelt(f, {
      strategy: "pr",
      execFileSyncFn: (cmd, args, options) => {
        if (cmd === "gh" || args[0] === "push") {
          calls.push([cmd, ...args]);
          return "pr-created";
        }
        return execFileSync(cmd, args, options);
      },
    });
    expect(calls).toContainEqual([
      "git",
      "push",
      "origin",
      `${result.candidate.commit}:refs/heads/builder`,
    ]);
  });

  it("commits builder changes before the real verifier and never commits check output", async () => {
    const f = fixture();
    writeFileSync(path.join(f.wt, "change.txt"), "builder dirty\n");
    const checked = await verifyBuilderWorktree(f.wt, {
      allowPaths: ["change.txt"],
      command: "git show HEAD:change.txt",
      targetBranch: "main",
    });
    expect(checked).toMatchObject({
      status: "verified",
      verification: {
        committedByHost: true,
        output: "builder dirty",
        candidate: { commit: git(f.wt, "rev-parse", "HEAD") },
      },
    });
    const head = git(f.wt, "rev-parse", "HEAD");
    const mutated = await verifyBuilderWorktree(f.wt, {
      allowPaths: ["change.txt"],
      command: "printf retained > check-output.txt",
    });
    expect(mutated.status).toBe("verification_mutated_workspace");
    expect(git(f.wt, "rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(path.join(f.wt, "check-output.txt"), "utf8")).toBe("retained");
  });

  it("Foundry uses the real verifier even with an injected builder", async () => {
    const f = fixture();
    renameSync(resolveFoundryStatePath(f.wt), path.join(f.root, "previous-state.json"));
    const now = Date.now();
    const task = {
      schema: "agent-executor.task-spec.v1",
      objective: "Verify the builder",
      allow_paths: ["change.txt"],
      development_checks: ["exit 9"],
    };
    const result = await foundryRun(["--json"], {
      cwd: f.repo,
      env: f.env,
      stdout: { write() {} },
      execGhFn: async () => [
        {
          number: 157,
          title: "Verify candidate",
          labels: [{ name: "agent:ready" }],
          body: `\`\`\`json task-spec\n${JSON.stringify(task)}\n\`\`\``,
        },
      ],
      getAccountsFn: async () => [
        {
          fetchedAt: now,
          id: "codex-test",
          label: "Codex",
          ok: true,
          provider: "codex",
          route: "--engine codex",
          pools: [{ families: ["gpt"], id: "codex", label: "Codex", windowIds: ["week"] }],
          windows: [
            {
              id: "week",
              label: "Weekly",
              remainingPct: 85,
              resetsAt: now + 3 * 24 * 3600 * 1000,
              windowMins: 10_080,
            },
          ],
        },
      ],
      provisionWorktreeFn: async () => f.wt,
      execAgentFn: async () => {
        writeFileSync(path.join(f.wt, "change.txt"), "builder change before real verification\n");
        return { status: "completed" };
      },
    });
    expect(result).toMatchObject({
      status: "verification_failed",
      verification: { exitCode: 9, ok: false, committedByHost: true, status: "failed" },
    });
    expect(git(f.wt, "show", "HEAD:change.txt")).toBe("builder change before real verification");
    expect(result.verification.candidate.commit).toBe(git(f.wt, "rev-parse", "HEAD"));
  });

  it("rejects a clean HEAD move made by verification", async () => {
    const f = fixture();
    const before = git(f.wt, "rev-parse", "HEAD");
    const checked = await verifyBuilderWorktree(f.wt, {
      allowPaths: ["change.txt"],
      command: "git commit --allow-empty -m check-created-commit",
    });
    expect(checked).toMatchObject({
      status: "verification_mutated_workspace",
      verification: { ok: false, candidate: { commit: before } },
    });
    expect(git(f.wt, "status", "--porcelain")).toBe("");
    expect(git(f.wt, "log", "-1", "--format=%s")).toBe("check-created-commit");
  });

  it("refuses out-of-scope files and failed commits before invoking a verifier", async () => {
    const f = fixture();
    writeFileSync(path.join(f.wt, "outside.txt"), "outside");
    let calls = 0;
    expect(
      (
        await verifyBuilderWorktree(f.wt, {
          allowPaths: ["change.txt"],
          execVerifyFn: () => calls++,
        })
      ).status,
    ).toBe("scope_violated");
    const head = git(f.wt, "rev-parse", "HEAD");
    git(f.wt, "config", "user.name", "");
    const result = await verifyBuilderWorktree(f.wt, {
      allowPaths: ["outside.txt"],
      execVerifyFn: () => calls++,
    });
    expect(result.status).toBe("commit_failed");
    expect(calls).toBe(0);
    expect(git(f.wt, "rev-parse", "HEAD")).toBe(head);
  });

  it.each([null, "a".repeat(40)])(
    "Next revalidates stale verified candidate %s before smelting",
    async (commit) => {
      const f = fixture();
      writeFoundryState(f.wt, { verification: commit ? { candidate: { commit } } : {} });
      // Next discovers disposable candidates; the injected smelter cannot prune this fixture.
      writeFileSync(
        path.join(resolveWorktreeGitDir(f.wt), "orkest.json"),
        JSON.stringify({ disposable: true, slug: "candidate", branch: "builder" }),
      );
      let verifications = 0;
      const result = await nextCommand(["--json"], {
        cwd: f.repo,
        env: f.env,
        stdout: { write() {} },
        openIssues: [],
        getAccountsFn: async () => [],
        execVerifyFn: async () => {
          verifications++;
          return { ok: true, exitCode: 0, output: "checked" };
        },
        smeltWorktreeFn: async () => ({ ok: true, status: "pr_opened" }),
      });
      expect(verifications).toBe(1);
      expect(readFoundryState(f.wt).verification.candidate.commit).toBe(
        git(f.wt, "rev-parse", "HEAD"),
      );
      expect(result.ok).toBe(true);
    },
  );
});
