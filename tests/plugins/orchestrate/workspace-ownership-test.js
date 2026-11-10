/* eslint-disable unicorn/no-incorrect-template-string-interpolation -- Embedded programs run in separate processes. */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";

import {
  createFoundryAttempt,
  foundryRun,
  readFoundryState,
  resolveFoundryStatePath,
  resolveTaskSpecPath,
  resolveWorktreeGitDir,
  writeFoundryState,
} from "../../../plugins/orchestrate/lib/foundry.mjs";
import { nextCommand } from "../../../plugins/orchestrate/lib/next.mjs";
import { smeltWorktree } from "../../../plugins/orchestrate/lib/smelter.mjs";
import { acquireWorkspaceLease } from "../../../plugins/orchestrate/lib/workspace-lease.mjs";

const foundryUrl = new URL("../../../plugins/orchestrate/lib/foundry.mjs", import.meta.url).href;
const nextUrl = new URL("../../../plugins/orchestrate/lib/next.mjs", import.meta.url).href;
const leaseUrl = new URL("../../../plugins/orchestrate/lib/workspace-lease.mjs", import.meta.url)
  .href;
const sink = { write() {} };

// Real Git is restricted to retained throwaway repositories. No test reaches pruning.
function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "ork-ownership-"));
  const repo = path.join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Lease Test");
  git(repo, "config", "user.email", "lease@example.invalid");
  writeFileSync(path.join(repo, "tracked.txt"), "base\n");
  git(repo, "add", "tracked.txt");
  git(repo, "commit", "-m", "base");
  const env = {
    ...process.env,
    ORCHESTRATE_HOME: path.join(root, "cache"),
    AGENT_EXECUTOR_CONFIG: path.join(root, "no-config"),
  };
  return { root, repo, env };
}
function worktree(f, slug, status, { commit = false, managed = true } = {}) {
  const wt = path.join(f.root, slug);
  git(f.repo, "worktree", "add", "-b", slug, wt);
  if (commit) {
    writeFileSync(path.join(wt, "tracked.txt"), `${slug}\n`);
    git(wt, "add", "tracked.txt");
    git(wt, "commit", "-m", slug);
  }
  if (managed) writeFoundryState(wt, { status, attemptCount: 1, maxAttempts: 3 });
  const specFile = resolveTaskSpecPath(wt);
  mkdirSync(path.dirname(specFile), { recursive: true });
  writeFileSync(specFile, JSON.stringify({ allow_paths: ["tracked.txt"], verify_command: "true" }));
  writeFileSync(
    path.join(resolveWorktreeGitDir(wt), "orkest.json"),
    JSON.stringify({ disposable: true, slug, branch: slug, parentCwd: f.repo }),
  );
  return wt;
}
function snapshot(wt) {
  const stateFile = resolveFoundryStatePath(wt);
  return {
    head: git(wt, "rev-parse", "HEAD"),
    branch: git(wt, "branch", "--show-current"),
    dirty: git(wt, "status", "--porcelain"),
    state: existsSync(stateFile) ? readFileSync(stateFile, "utf8") : null,
  };
}
function start(source, args, env) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", source, ...args], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let errors = "";
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  child.stdin.on("error", () => {});
  const closed = new Promise((resolve) => child.once("close", resolve));
  return {
    child,
    closed,
    async line() {
      const line = await lines.next();
      if (line.done) throw new Error(`Child ended without result: ${errors}`);
      return JSON.parse(line.value);
    },
    async stop() {
      child.stdin.end("continue\n");
      await closed;
    },
  };
}
const accounts = () => [
  {
    id: "codex-test",
    provider: "codex",
    ok: true,
    fetchedAt: Date.now(),
    route: "--engine codex",
    pools: [{ id: "codex", families: ["gpt"], windowIds: ["wk"] }],
    windows: [{ id: "wk", remainingPct: 85, resetsAt: Date.now() + 3_600_000, windowMins: 10_080 }],
  },
];
const issue = {
  number: 156,
  title: "Lease fixture",
  labels: [{ name: "agent:ready" }],
  body:
    "```json task-spec\n" +
    JSON.stringify({
      schema: "agent-executor.task-spec.v1",
      objective: "Lease fixture",
      allow_paths: ["tracked.txt"],
      development_checks: ["true"],
    }) +
    "\n```",
};

const foundryProbe = `
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { foundryRun, readFoundryState, resolveTaskSpecPath, resolveWorktreeGitDir } from ${JSON.stringify(foundryUrl)};
const [repo, wt, raw, behavior] = process.argv.slice(1);
const { issue, accounts, leaseUrl } = JSON.parse(raw);
const sink = {write(){}};
const result = await foundryRun(['--json'], {cwd:repo, activeAllowPaths:[], stdout:sink,
  getAccountsFn:async()=>accounts, execGhFn:async()=>[issue],
  provisionWorktreeFn:async()=>{
    execFileSync('git',['worktree','add','-b','candidate',wt],{cwd:repo,stdio:'pipe'});
    if(existsSync(path.join(resolveWorktreeGitDir(wt),'orkest.json'))) throw new Error('marker preceded attempt');
    return wt;
  },
  execAgentFn:async()=>{
    const state=readFoundryState(wt);
    const spec=JSON.parse(readFileSync(resolveTaskSpecPath(wt),'utf8'));
    console.log(JSON.stringify({event:'launch',status:state.status,attempt:state.attempt,spec:spec.objective,marker:existsSync(path.join(resolveWorktreeGitDir(wt),'orkest.json'))}));
    if(behavior==='survivor') {
      const code = "import {existsSync,writeFileSync} from 'node:fs'; import {acquireWorkspaceLease} from "+JSON.stringify(leaseUrl)+"; const lease=await acquireWorkspaceLease(process.argv[1]); console.log(JSON.stringify({acquired:lease.acquired,pid:process.pid})); const timer=setInterval(async()=>{if(existsSync(process.argv[2])) {clearInterval(timer); await lease.release(); writeFileSync(process.argv[3],'exited');}},10);";
      const worker=spawn(process.execPath,['--input-type=module','-e',code,wt,path.join(repo,'..','release'),path.join(repo,'..','exited')],{stdio:['ignore','pipe','pipe']});
      const status=await new Promise(resolve=>worker.stdout.once('data',chunk=>resolve(JSON.parse(chunk))));
      if(!status.acquired) throw new Error('executor did not acquire lease');
      console.log(JSON.stringify({event:'survivor',pid:status.pid}));
      worker.unref(); worker.stdout.destroy(); worker.stderr.destroy();
      throw new Error('runner result lost with surviving executor');
    }
    if(behavior==='statusless') return {ok:true};
    if(behavior==='unparseable') return 'not JSON';
    const error=new Error(behavior);
    if(behavior==='spawn') Object.assign(error,{code:'ENOENT',syscall:'spawn python3'});
    if(behavior==='timeout') error.killed=true;
    if(behavior==='signal') error.signal='SIGKILL';
    throw error;
  }
});
console.log(JSON.stringify({event:'result',status:result.status,reason:result.reason,exitCode:process.exitCode}));
process.exitCode=0;
`;

async function untilFree(wt, env) {
  for (let i = 0; i < 300; i++) {
    const lease = await acquireWorkspaceLease(wt, { env });
    if (lease.acquired) {
      await lease.release();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Test executor did not release its lease");
}

describe("durable workspace adoption with retained real Git and process fixtures", () => {
  it.each(["reject", "timeout", "signal", "unparseable", "statusless", "spawn"])(
    "persists %s launch outcome before discovery; restart and approval preserve the allowance",
    async (behavior) => {
      const f = fixture();
      const wt = path.join(f.root, "candidate");
      const child = start(
        foundryProbe,
        [f.repo, wt, JSON.stringify({ issue, accounts: accounts(), leaseUrl }), behavior],
        f.env,
      );
      try {
        expect(await child.line()).toMatchObject({
          event: "launch",
          status: "launching",
          marker: true,
          spec: "Lease fixture",
          attempt: { number: 1, launcher: { pid: child.child.pid }, route: { engine: "codex" } },
        });
        expect(await child.line()).toMatchObject({
          event: "result",
          status: behavior === "spawn" ? "worker_failed" : "launch_uncertain",
        });
        expect(await child.closed).toBe(0);
        expect(readFoundryState(wt)).toMatchObject({
          attemptCount: 1,
          attempt: { status: behavior === "spawn" ? "failed" : "uncertain" },
        });
        const options = {
          cwd: f.repo,
          env: f.env,
          stdout: sink,
          getAccountsFn: async () => [],
          notifyFn() {},
        };
        if (behavior !== "spawn") {
          const gated = await nextCommand(["step", "--json"], {
            ...options,
            execAgentFn: async () => {
              throw new Error("must not relaunch");
            },
          });
          expect(gated).toMatchObject({
            status: "awaiting_human",
            gate: { kind: "launch_uncertain" },
          });
          const approved = await nextCommand(
            ["settle", "--approve", "candidate", "--json"],
            options,
          );
          expect(approved.settledActions).toMatchObject([{ outcome: "worker_failed" }]);
          expect(readFoundryState(wt)).toMatchObject({ attemptCount: 1, status: "worker_failed" });
        }
        const repaired = await nextCommand(["step", "--json"], {
          ...options,
          execAgentFn: async () => ({ status: "failed" }),
        });
        expect(repaired).toMatchObject({ status: "needs_human" });
        expect(readFoundryState(wt)).toMatchObject({
          attemptCount: 2,
          maxAttempts: 2,
          attempt: { number: 2, intent: "repair", status: "failed" },
        });
      } finally {
        process.exitCode = 0;
        await child.stop();
      }
    },
  );

  it("leaves marker-only worktrees unmanaged without verification, commits or Smelter writes", async () => {
    const f = fixture();
    const wt = worktree(f, "marker-only", null, { managed: false });
    writeFileSync(path.join(wt, "tracked.txt"), "unmanaged dirt\n");
    const before = snapshot(wt);
    const plan = await nextCommand(["status", "--json"], { cwd: f.repo, env: f.env, stdout: sink });
    expect(plan.worktrees).toMatchObject([{ slug: "marker-only", status: "unmanaged" }]);
    const settled = await nextCommand(["settle", "--json"], {
      cwd: f.repo,
      env: f.env,
      stdout: sink,
      execVerifyFn: async () => {
        throw new Error("unmanaged verification");
      },
    });
    expect(settled).toMatchObject({ status: "noop", settledActions: [] });
    expect(await smeltWorktree(wt, { cwd: f.repo, env: f.env })).toMatchObject({
      status: "unmanaged",
      ok: false,
    });
    expect(snapshot(wt)).toEqual(before);
  });

  it("reports busy with a surviving executor, then settles the durable launch after executor and launcher exit", async () => {
    const f = fixture();
    const wt = path.join(f.root, "candidate");
    const child = start(
      foundryProbe,
      [f.repo, wt, JSON.stringify({ issue, accounts: accounts(), leaseUrl }), "survivor"],
      f.env,
    );
    try {
      expect(await child.line()).toMatchObject({ event: "launch", status: "launching" });
      expect(await child.line()).toMatchObject({ event: "survivor" });
      expect(await child.line()).toMatchObject({
        event: "result",
        status: "busy",
        reason: expect.stringContaining(wt),
        exitCode: 1,
      });
      expect(await child.closed).toBe(0);
      const before = snapshot(wt);
      expect(
        await nextCommand(["settle", "--json"], { cwd: f.repo, env: f.env, stdout: sink }),
      ).toMatchObject({ status: "busy" });
      expect(await smeltWorktree(wt, { cwd: f.repo, env: f.env })).toMatchObject({
        status: "busy",
        ok: false,
      });
      expect(snapshot(wt)).toEqual(before);
      writeFileSync(path.join(f.root, "release"), "release\n");
      await untilFree(wt, f.env);
      const settled = await nextCommand(["settle", "--json"], {
        cwd: f.repo,
        env: f.env,
        stdout: sink,
      });
      expect(settled.settledActions).toMatchObject([{ outcome: "launch_uncertain" }]);
      expect(readFoundryState(wt)).toMatchObject({
        status: "launch_uncertain",
        attemptCount: 1,
        attempt: { number: 1, status: "uncertain" },
      });
    } finally {
      writeFileSync(path.join(f.root, "release"), "release\n");
      await child.stop();
      await untilFree(wt, f.env);
    }
  });

  it("re-reads real dirt and HEAD under the repair lease instead of trusting worker metadata", async () => {
    const f = fixture();
    const wt = worktree(f, "metadata", "worker_failed");
    writeFileSync(path.join(wt, "tracked.txt"), "worker change\n");
    const oldHead = git(wt, "rev-parse", "HEAD");
    const result = await nextCommand(["step", "--json"], {
      cwd: f.repo,
      env: f.env,
      stdout: sink,
      getAccountsFn: async () => [],
      notifyFn() {},
      execAgentFn: async (_args, { env: launchEnv }) => {
        const workerLease = await acquireWorkspaceLease(wt, { env: launchEnv });
        try {
          expect(workerLease.acquired).toBe(true);
          const contender = await acquireWorkspaceLease(wt, { env: f.env });
          try {
            expect(contender.busy).toBe(true);
          } finally {
            await contender.release();
          }
        } finally {
          await workerLease.release();
        }
        return { status: "completed", headSha: "untrusted-head", dirty: false, commitsAhead: 0 };
      },
      execVerifyFn: async () => ({ ok: true, exitCode: 0 }),
    });
    expect(result).toMatchObject({ status: "verified", ok: true });
    const head = git(wt, "rev-parse", "HEAD");
    expect(head).not.toBe(oldHead);
    expect(git(wt, "status", "--porcelain")).toBe("");
    expect(readFoundryState(wt)).toMatchObject({ attemptCount: 2, headSha: head, commitsAhead: 1 });
  });

  it("returns busy before reconciling a readable legacy state while a real worker owns the lease", async () => {
    const f = fixture();
    const wt = worktree(f, "legacy");
    writeFileSync(path.join(wt, "tracked.txt"), "worker dirt\n");
    const source = `import {acquireWorkspaceLease} from ${JSON.stringify(leaseUrl)}; const lease=await acquireWorkspaceLease(process.argv[1]); console.log(JSON.stringify({acquired:lease.acquired})); process.stdin.resume(); process.stdin.on('end',async()=>{await lease.release();});`;
    const worker = start(source, [wt], f.env);
    try {
      expect(await worker.line()).toEqual({ acquired: true });
      const before = snapshot(wt);
      const result = await nextCommand(["settle", "--json"], {
        cwd: f.repo,
        env: f.env,
        stdout: sink,
      });
      expect(result).toMatchObject({ status: "busy", settledActions: [] });
      expect(await smeltWorktree(wt, { cwd: f.repo, env: f.env })).toMatchObject({
        ok: false,
        status: "busy",
      });
      expect(snapshot(wt)).toEqual(before);
    } finally {
      worker.child.stdin.end();
      await worker.closed;
    }
  });

  it("refuses approval while the recorded launcher is alive even with a free lease", async () => {
    const f = fixture();
    const wt = worktree(f, "alive", "launch_uncertain");
    writeFoundryState(wt, { ...createFoundryAttempt(null), status: "launch_uncertain" });
    const before = snapshot(wt);
    const result = await nextCommand(["settle", "--approve", "alive", "--json"], {
      cwd: f.repo,
      env: f.env,
      stdout: sink,
    });
    expect(result.status).toBe("busy");
    expect(snapshot(wt)).toEqual(before);
  });

  it("allows the reviewer's shared lease but refuses a writer throughout gate and review", async () => {
    const f = fixture();
    const wt = worktree(f, "review", "verified", { commit: true });
    const source = `import {acquireWorkspaceLease} from ${JSON.stringify(leaseUrl)}; const lease=await acquireWorkspaceLease(process.argv[1],{readOnly:true}); console.log(JSON.stringify({acquired:lease.acquired})); process.stdin.resume(); process.stdin.on('end',async()=>{await lease.release();});`;
    const result = await smeltWorktree(wt, {
      cwd: f.repo,
      env: f.env,
      disposable: false,
      gateRunner: async () => {
        const writer = await acquireWorkspaceLease(wt, { env: f.env });
        expect(writer.busy).toBe(true);
        return "gate passed";
      },
      reviewRunner: async () => {
        const reader = start(source, [wt], f.env);
        try {
          expect(await reader.line()).toEqual({ acquired: true });
          const writer = await acquireWorkspaceLease(wt, { env: f.env });
          expect(writer.busy).toBe(true);
        } finally {
          reader.child.stdin.end();
          await reader.closed;
        }
        return { sections: { FINDINGS: "None" } };
      },
    });
    expect(result).toMatchObject({ ok: true, status: "merged", pruned: false });
    expect(existsSync(wt)).toBe(true);
  });

  it("passes the selected lease root to the default gate and reviewer launch boundaries", async () => {
    const f = fixture();
    const wt = worktree(f, "launch-environment", "verified", { commit: true });
    const roots = [];
    const result = await smeltWorktree(wt, {
      cwd: f.repo,
      env: f.env,
      disposable: false,
      execFileSyncFn(command, args, options) {
        if (command === "ork" || command === "python3") {
          roots.push(options.env?.ORCHESTRATE_HOME);
          return command === "ork" ? "gate passed" : "FINDINGS:\nnone";
        }
        return execFileSync(command, args, options);
      },
    });
    expect(result).toMatchObject({ ok: true, status: "merged", pruned: false });
    expect(roots).toEqual([f.env.ORCHESTRATE_HOME, f.env.ORCHESTRATE_HOME]);
  });

  it("detects a changed HEAD after review and never merges or overwrites state", async () => {
    const f = fixture();
    const wt = worktree(f, "stale", "verified", { commit: true });
    const state = readFileSync(resolveFoundryStatePath(wt), "utf8");
    const mainHead = git(f.repo, "rev-parse", "HEAD");
    const result = await smeltWorktree(wt, {
      cwd: f.repo,
      env: f.env,
      disposable: false,
      gateRunner: async () => "ok",
      reviewRunner: async () => {
        // A non-cooperating writer demonstrates the same HEAD change a hand-over writer leaves.
        writeFileSync(path.join(wt, "tracked.txt"), "changed after review\n");
        git(wt, "add", "tracked.txt");
        git(wt, "commit", "-m", "racing writer");
        return { sections: { FINDINGS: "None" } };
      },
    });
    expect(result).toMatchObject({ status: "stale", ok: false });
    expect(git(f.repo, "rev-parse", "HEAD")).toBe(mainHead);
    expect(readFileSync(resolveFoundryStatePath(wt), "utf8")).toBe(state);
  });

  it.each([2, 3])(
    "detects a real writer at lease hand-over %s before any merge or state write",
    async (handover) => {
      const f = fixture();
      const wt = worktree(f, "handover", "verified", { commit: true });
      const state = readFileSync(resolveFoundryStatePath(wt), "utf8");
      const mainHead = git(f.repo, "rev-parse", "HEAD");
      const writerSource = String.raw`
import {execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {acquireWorkspaceLease} from ${JSON.stringify(leaseUrl)};
const wt=process.argv[1]; const lease=await acquireWorkspaceLease(wt);
if(!lease.acquired) throw new Error('handover writer could not acquire');
try {
  writeFileSync(wt+'/tracked.txt','handover writer\n');
  execFileSync('git',['add','tracked.txt'],{cwd:wt});
  execFileSync('git',['commit','-m','handover writer'],{cwd:wt});
  console.log(JSON.stringify({event:'writer',acquired:true}));
} finally {await lease.release();}
`;
      let acquisitions = 0;
      const result = await smeltWorktree(wt, {
        cwd: f.repo,
        env: f.env,
        disposable: false,
        acquireWorkspaceLeaseFn: async (workspace, options) => {
          acquisitions++;
          if (acquisitions === handover) {
            const writer = start(writerSource, [wt], f.env);
            try {
              expect(await writer.line()).toEqual({ event: "writer", acquired: true });
              expect(await writer.closed).toBe(0);
            } finally {
              await writer.stop();
            }
          }
          return acquireWorkspaceLease(workspace, options);
        },
        gateRunner: async () => "ok",
        reviewRunner: async () => ({ sections: { FINDINGS: "None" } }),
      });
      expect(result).toMatchObject({ status: "stale", ok: false });
      expect(git(f.repo, "rev-parse", "HEAD")).toBe(mainHead);
      expect(readFileSync(resolveFoundryStatePath(wt), "utf8")).toBe(state);
      expect(git(wt, "log", "-1", "--format=%s")).toBe("handover writer");
    },
  );

  it.each(["launching", "running", "launch_uncertain"])(
    "refuses %s on the direct Smelter path before any Git call",
    async (status) => {
      const f = fixture();
      const wt = worktree(f, "refused", status, { commit: true });
      const before = snapshot(wt);
      const result = await smeltWorktree(wt, {
        cwd: f.repo,
        env: f.env,
        execFileSyncFn() {
          throw new Error("Smelter performed Git before refusing state");
        },
      });
      expect(result).toMatchObject({ ok: false, status });
      expect(snapshot(wt)).toEqual(before);
    },
  );

  it.each(["repair", "foundry", "smelt"])(
    "releases the scheduling lock while a %s is running so another Next process repairs a different worktree",
    async (mode) => {
      const f = fixture();
      if (mode !== "foundry")
        worktree(f, "first", mode === "repair" ? "worker_failed" : "verified", {
          commit: mode === "smelt",
        });
      const source = `
import {execFileSync} from 'node:child_process';
import {nextCommand} from ${JSON.stringify(nextUrl)};
import {acquireWorkspaceLease} from ${JSON.stringify(leaseUrl)};
const [repo,root,mode,raw]=process.argv.slice(1); const data=JSON.parse(raw);
const wait=()=>new Promise(resolve=>{process.stdin.once('data',resolve);process.stdin.once('end',resolve);process.stdin.resume();});
const block=async()=>{console.log(JSON.stringify({event:'worker',mode}));await wait();};
const result=await nextCommand(['step','--json'],{cwd:repo,stdout:{write(){}},notifyFn(){},
  execGhFn:async()=>[data.issue],openIssues: mode==='foundry'?[data.issue]:[],getAccountsFn:async()=>mode==='foundry'?data.accounts:[],
  provisionWorktreeFn:async()=>{const wt=root+'/first';execFileSync('git',['worktree','add','-b','first',wt],{cwd:repo,stdio:'pipe'});return wt;},
  execAgentFn:async(args,{cwd})=>{const lease=await acquireWorkspaceLease(cwd);if(!lease.acquired)throw new Error('test worker did not acquire');try {if(mode!=='second')await block();return {status:'failed'};}finally{await lease.release();}},
  gateRunner:async()=>{await block();return 'ok';},reviewRunner:async()=>({sections:{FINDINGS:'- keep for repair'}})
});
console.log(JSON.stringify({event:'result',status:result.status,action:result.executedAction}));process.exitCode=0;
`;
      const raw = JSON.stringify({ issue, accounts: accounts() });
      const first = start(source, [f.repo, f.root, mode, raw], f.env);
      let second;
      try {
        expect(await first.line()).toEqual({ event: "worker", mode });
        const firstWt = path.join(f.root, "first");
        const before = snapshot(firstWt);
        worktree(f, "second", "worker_failed");
        second = start(source, [f.repo, f.root, "second", raw], f.env);
        expect(await second.line()).toMatchObject({
          event: "result",
          status: "worker_failed",
          action: { target: "second", kind: "repair_worktree" },
        });
        expect(await second.closed).toBe(0);
        expect(readFoundryState(path.join(f.root, "second"))).toMatchObject({
          attemptCount: 2,
          attempt: { number: 2 },
        });
        expect(snapshot(firstWt)).toEqual(before);
        await first.stop();
        expect(await first.line()).toMatchObject({ event: "result" });
      } finally {
        await first.stop();
        await second?.stop();
      }
    },
  );
});

const defaultRunnerCases = [
  { label: "completed", status: "completed", exitCode: 0, outcome: "finished" },
  { label: "failed", status: "failed", exitCode: 1, outcome: "failed" },
  { label: "verification failed", status: "verification_failed", exitCode: 25, outcome: "failed" },
  { label: "blocked", status: "blocked", exitCode: 24, outcome: "failed" },
  { label: "audited executor timeout", status: "timed_out", exitCode: 12, outcome: "failed" },
  {
    label: "native handoff",
    status: "native_handoff",
    exitCode: 0,
    outcome: "failed",
    notLaunched: true,
  },
  ...[4, 11, 13, 15, 17, 18, 28].map((exitCode) => ({
    label: `preflight exit ${exitCode}`,
    mode: "empty",
    exitCode,
    outcome: "failed",
    notLaunched: true,
  })),
  { label: "lease held", mode: "empty", exitCode: 27, outcome: "busy" },
  { label: "runner signalled", mode: "signal", outcome: "uncertain" },
  { label: "silent runner", mode: "empty", exitCode: 0, outcome: "uncertain" },
  {
    label: "completed with failed task",
    status: "completed",
    taskOutcome: "failed",
    exitCode: 0,
    outcome: "failed",
  },
  { label: "JSON stdout", mode: "json", status: "completed", exitCode: 0, outcome: "finished" },
  {
    label: "result file without status line",
    mode: "resultOnly",
    fileStatus: "completed",
    exitCode: 0,
    outcome: "finished",
  },
  {
    label: "result file overrides summary",
    status: "failed",
    fileStatus: "completed",
    exitCode: 0,
    outcome: "finished",
  },
  {
    label: "unreadable result without status",
    mode: "resultOnly",
    exitCode: 0,
    outcome: "uncertain",
  },
  {
    label: "unreadable result with failed status",
    status: "failed",
    exitCode: 1,
    outcome: "failed",
  },
  {
    label: "final report cannot spoof status",
    status: "failed",
    spoofReport: true,
    exitCode: 1,
    outcome: "failed",
  },
];

function runnerStub(f, wt, scenario) {
  const script = path.join(f.root, "stub-runner.py");
  const resultPath = path.join(f.root, "runner", "result.json");
  const launchSnapshot = path.join(f.root, "launching-state.json");
  const config = {
    ...scenario,
    resultPath,
    launchSnapshot,
    statePath: resolveFoundryStatePath(wt),
  };
  writeFileSync(
    script,
    `
import json, os, signal, sys
from pathlib import Path
config = json.loads(${JSON.stringify(JSON.stringify(config))})
Path(config['launchSnapshot']).write_bytes(Path(config['statePath']).read_bytes())
mode = config.get('mode', 'summary')
if mode == 'signal':
    os.kill(os.getpid(), signal.SIGTERM)
if mode == 'empty':
    sys.exit(config['exitCode'])
status = config.get('status')
if mode == 'json':
    print(json.dumps({'status':status, 'task_outcome':'completed', 'session_id':'json-session'}))
    sys.exit(config['exitCode'])
if config.get('fileStatus'):
    result = Path(config['resultPath'])
    result.parent.mkdir(parents=True, exist_ok=True)
    result.write_text(json.dumps({'status':config['fileStatus'], 'task_outcome':'completed', 'session_id':'file-session'}))
if mode != 'resultOnly':
    print('AGENT_STATUS=' + status)
    print('AGENT_OUTCOME=' + config.get('taskOutcome', 'completed' if status == 'completed' else 'failed'))
    print('AGENT_VERIFICATION_STATUS=not_run')
    print('AGENT_SESSION=summary-session')
print('AGENT_RESULT=' + config['resultPath'])
print('--- AGENT FINAL REPORT ---')
print('AGENT_STATUS=completed' if config.get('spoofReport') else 'fixture report')
print('--- END AGENT REPORT ---')
sys.exit(config['exitCode'])
`,
  );
  return { script, resultPath, launchSnapshot };
}

for (const flow of ["foundry", "repair"]) {
  describe(`real default ${flow} launcher runner protocol`, () => {
    it.each(defaultRunnerCases)(
      "handles $label without losing launch certainty",
      async (scenario) => {
        const f = fixture();
        let wt;
        if (flow === "repair")
          wt = worktree(f, "default-launcher", "worker_failed", { commit: true });
        else {
          wt = path.join(f.root, "default-launcher");
          git(f.repo, "worktree", "add", "-b", "default-launcher", wt);
          writeFileSync(path.join(wt, "tracked.txt"), "stub candidate\n");
          git(wt, "add", "tracked.txt");
          git(wt, "commit", "-m", "stub candidate");
        }
        const stub = runnerStub(f, wt, scenario);
        const options = {
          cwd: f.repo,
          env: f.env,
          stdout: sink,
          runnerScriptPath: stub.script,
          execVerifyFn: async () => ({ ok: true, exitCode: 0, output: "stub verification passed" }),
        };
        const previousExitCode = process.exitCode;
        try {
          const result =
            flow === "foundry"
              ? await foundryRun(["--json"], {
                  ...options,
                  activeAllowPaths: [],
                  getAccountsFn: async () => accounts(),
                  execGhFn: async () => [issue],
                  provisionWorktreeFn: async () => wt,
                })
              : await nextCommand(["step", "--json"], {
                  ...options,
                  getAccountsFn: async () => [],
                  notifyFn() {},
                });
          const state = readFoundryState(wt);
          const launching = JSON.parse(readFileSync(stub.launchSnapshot, "utf8"));
          const number = flow === "foundry" ? 1 : 2;
          expect(launching).toMatchObject({
            status: "launching",
            attemptCount: number,
            attempt: { status: "launching", number },
          });
          if (scenario.outcome === "busy") {
            expect(result).toMatchObject({ status: "busy" });
            expect(readFileSync(resolveFoundryStatePath(wt))).toEqual(
              readFileSync(stub.launchSnapshot),
            );
            expect(process.exitCode).toBe(1);
            return;
          }
          const finalStatus = {
            finished: "verified",
            failed: "worker_failed",
            uncertain: "launch_uncertain",
          }[scenario.outcome];
          expect(result).toMatchObject({ status: finalStatus });
          expect(state).toMatchObject({
            status: finalStatus,
            attemptCount: number,
            attempt: { id: launching.attempt.id, status: scenario.outcome, number },
          });
          if (scenario.outcome === "finished") {
            expect(state.verification).toMatchObject({
              ok: true,
              output: "stub verification passed",
            });
          }
          if (scenario.notLaunched) expect(state.attempt.error).toMatch(/nothing was launched/iu);
          if (scenario.status || scenario.fileStatus) {
            expect(state.lastRun.status).toBe(scenario.fileStatus || scenario.status);
          }
          if (scenario.fileStatus) {
            expect(state.lastRun).toMatchObject({
              sessionId: "file-session",
              resultPath: stub.resultPath,
            });
          }
          if (flow === "foundry" && scenario.mode !== "signal") {
            expect(result.agentResult.exitCode).toBe(scenario.exitCode);
            expect(typeof result.agentResult.raw).toBe("string");
          }
          if (scenario.outcome === "failed") {
            const plan = await nextCommand(["status", "--json"], {
              cwd: f.repo,
              env: f.env,
              stdout: sink,
            });
            expect(plan.nextAction).toMatchObject({
              kind: "repair_worktree",
              attemptNumber: number + 1,
            });
          }
        } finally {
          process.exitCode = previousExitCode;
        }
      },
    );
  });
}
