import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import { loadFoundryState, writeFoundryState } from "../../../src/lib/foundry.mjs";
import { createRoom, mailboxRoot, openRooms, updateRoom } from "../../../src/lib/horde-room.mjs";
import { smeltWorktree } from "../../../src/lib/smelter.mjs";
import { ensurePullRequest } from "../../../src/lib/worktree-pr.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "ork-effects-"));
  const repo = path.join(dir, "repo");
  const remote = path.join(dir, "owner", "project.git");
  mkdirSync(repo);
  mkdirSync(path.dirname(remote));
  const env = {
    ...process.env,
    ORCHESTRATE_HOME: path.join(dir, "cache"),
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: repo,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-q", "-b", "main");
  git("commit", "-qm", "base", "--allow-empty");
  const base = git("rev-parse", "HEAD");
  git("switch", "-qc", "feature");
  git("commit", "-qm", "change", "--allow-empty");
  const oid = git("rev-parse", "HEAD");
  git("init", "-q", "--bare", remote);
  git("remote", "add", "origin", remote);
  return { dir, repo, remote, git, env, base, oid };
}

it("reconciles an interrupted push, uncertain GitHub create and old create marker with the original identity", async () => {
  const f = fixture();
  let creates = 0,
    pushes = 0;
  let isVisible = false;
  const item = {
    number: 7,
    url: "https://github.com/owner/project/pull/7",
    state: "OPEN",
    headRefName: "feature",
    baseRefName: "main",
    headRefOid: f.oid,
    isCrossRepository: false,
  };
  const run = () =>
    ensurePullRequest({
      candidate: { branch: "feature", commit: f.oid },
      baseBranch: "main",
      priorState: loadFoundryState(f.repo, { env: f.env }).state,
      record: (patch) => writeFoundryState(f.repo, patch, { env: f.env }),
      runGit(_cmd, args) {
        const out = f.git(...args);
        if (args[0] === "push" && ++pushes === 1) throw new Error("lost push response");
        return out;
      },
      runCmd(_cmd, [command, verb]) {
        if (command === "repo") return JSON.stringify({ nameWithOwner: "owner/project" });
        if (verb === "create") {
          creates++;
          throw new Error("lost GitHub response");
        }
        if (verb === "list") return JSON.stringify(isVisible ? [item] : []);
        return JSON.stringify(isVisible ? item : null);
      },
    });
  await expect(run()).rejects.toThrow("lost push response");
  expect(f.git("--git-dir", f.remote, "rev-parse", "refs/heads/feature")).toBe(f.oid);
  expect(loadFoundryState(f.repo, { env: f.env }).state.prReconcile.phase).toBe("push_pending");
  expect((await run()).status).toBe("pr_unverified");
  expect((await run()).status).toBe("pr_unverified");
  const marker = loadFoundryState(f.repo, { env: f.env }).state.prReconcile;
  writeFoundryState(f.repo, { prReconcile: { ...marker, phase: "creating" } }, { env: f.env });
  expect((await run()).status).toBe("pr_unverified");
  isVisible = true;
  expect((await run()).status).toBe("existing");
  expect({ creates, pushes }).toEqual({ creates: 1, pushes: 2 });
  expect(loadFoundryState(f.repo, { env: f.env }).state.pr.number).toBe(7);
});

it("recognizes a locally landed ref after acknowledgement loss, including later fast-forwards", async () => {
  const f = fixture();
  writeFoundryState(
    f.repo,
    {
      candidate: { commit: f.oid, branch: "feature" },
      mergeIntent: { targetRef: "refs/heads/main", previousOid: f.base, headOid: f.oid },
    },
    { env: f.env },
  );
  f.git("update-ref", "refs/heads/main", f.oid, f.base);
  f.git("commit", "-qm", "later", "--allow-empty");
  f.git("update-ref", "refs/heads/main", f.git("rev-parse", "HEAD"), f.oid);
  const result = await smeltWorktree(
    { path: f.repo, branch: "feature", disposable: false },
    { strategy: "local", env: f.env },
  );
  expect(result).toMatchObject({ status: "merged", reconciled: true });
  expect(loadFoundryState(f.repo, { env: f.env }).state.mergeIntent).toBeNull();
});

it("recovers a committed notification from private history after process death and reconciles only the original sink", async () => {
  const f = fixture();
  const roomId = "fixture";
  const rootDir = mailboxRoot(f.env);
  await updateRoom(roomId, () => createRoom([], { id: roomId, cwd: f.repo }), {
    root: rootDir,
    create: true,
  });
  const config = path.join(f.dir, "bridge.json");
  const receipts = path.join(f.dir, "receipts");
  const hook = path.join(f.dir, "hook.sh");
  // The sink commits its effect but loses its acknowledgement on the first attempt.
  writeFileSync(
    hook,
    [
      "#!/bin/sh",
      'echo "$ORK_CHIEF_EVENT_ID" >> "$1.attempts"',
      'if mkdir "$1.$ORK_CHIEF_EVENT_ID"; then',
      '  cat >> "$1"',
      "  exit 1",
      "fi",
      "cat >/dev/null",
      'echo "$ORK_CHIEF_EVENT_ID" > "$1.ack"',
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  writeFileSync(
    config,
    JSON.stringify({ version: 1, enabled: true, command: { path: hook, args: [receipts] } }),
    { mode: 0o600 },
  );
  const env = { ...f.env, ORK_CHIEF_BRIDGE_CONFIG: config };
  const recovery = (...args) =>
    JSON.parse(
      execFileSync(process.execPath, ["src/bin/projection-recovery.mjs", ...args], {
        env,
        cwd: root,
        timeout: 10_000,
        encoding: "utf8",
      }),
    );
  const checkpoint = recovery("checkpoint", rootDir, path.join(f.dir, "checkpoint"));
  const pr = {
    number: 7,
    url: "https://github.com/owner/project/pull/7",
    state: "OPEN",
    repository: "owner/project",
    baseBranch: "main",
    headBranch: "feature",
    headOid: f.oid,
    createdAt: null,
    updatedAt: null,
  };
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'import {writeFoundryState} from "./src/lib/foundry.mjs";writeFoundryState(process.argv[1],{pr:JSON.parse(process.argv[2])},{owningRoomId:"fixture"});process.exit(0)',
      f.repo,
      JSON.stringify(pr),
    ],
    { env, cwd: root },
  );
  {
    using db = openRooms(rootDir);
    expect(db.tagStore.get`SELECT count(*) AS n FROM chief_notification_intents`.n).toBe(1);
  }
  expect(existsSync(receipts)).toBe(false);
  const recovered = recovery(
    "rebuild",
    rootDir,
    checkpoint.database,
    checkpoint.sha256,
    path.join(f.dir, "rebuild"),
  );
  const recoveredEnv = { ...env, ORCHESTRATE_HOME: path.join(f.dir, "recovered") };
  const recoveredRoot = mailboxRoot(recoveredEnv);
  mkdirSync(path.dirname(recoveredRoot), { recursive: true, mode: 0o700 });
  renameSync(path.dirname(recovered.database), recoveredRoot);
  renameSync(rootDir, path.join(f.dir, "source-offline"));
  expect(existsSync(receipts + ".attempts")).toBe(false);
  {
    using db = openRooms(recoveredRoot);
    expect(db.tagStore.get`SELECT count(*) AS n FROM chief_notification_intents`.n).toBe(1);
  }
  const reconcile = () =>
    execFileSync(process.execPath, ["src/bin/ork.mjs", "chief", "reconcile", roomId, "--json"], {
      env: recoveredEnv,
      cwd: root,
      timeout: 10_000,
    });
  const originalConfig = readFileSync(config, "utf8");
  const replacement = JSON.parse(originalConfig);
  replacement.command.args = [receipts + ".different"];
  writeFileSync(config, JSON.stringify(replacement));
  reconcile();
  expect(existsSync(receipts + ".different.attempts")).toBe(false);
  {
    using db = openRooms(recoveredRoot);
    expect(db.tagStore.get`SELECT count(*) AS n FROM chief_notification_intents`.n).toBe(1);
  }
  writeFileSync(config, originalConfig);
  reconcile();
  await expect
    .poll(() => existsSync(receipts) && readFileSync(receipts, "utf8").includes("pr_opened"), {
      timeout: 5000,
    })
    .toBe(true);
  reconcile();
  await expect.poll(() => existsSync(receipts + ".ack"), { timeout: 5000 }).toBe(true);
  const attempts = readFileSync(receipts + ".attempts", "utf8")
    .trim()
    .split("\n");
  expect(attempts.length).toBeGreaterThanOrEqual(2);
  expect(new Set(attempts).size).toBe(1);
  const rows = readFileSync(receipts, "utf8")
    .trim()
    .split(/\n+/u)
    .map((row) => JSON.parse(row));
  expect(existsSync(rootDir)).toBe(false);
  expect(existsSync(receipts + ".different.attempts")).toBe(false);
  expect(rows).toHaveLength(1);
  expect(rows[0].id).toBe(attempts[0]);
  expect(rows[0]).toMatchObject({ event: "pr_opened", roomId, prNumber: 7 });
  {
    using db = openRooms(recoveredRoot);
    expect(db.tagStore.get`SELECT count(*) AS n FROM chief_notification_intents`.n).toBe(0);
  }
});
