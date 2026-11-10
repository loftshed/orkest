import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

import { notifyHerdrTransitions } from "../../../plugins/orchestrate/bin/horde-tui.mjs";
import { createRoom, parseTeam } from "../../../plugins/orchestrate/lib/horde-room.mjs";
import { HordeView } from "../../../plugins/orchestrate/lib/horde-view.mjs";
import { observeRoom } from "../../../plugins/orchestrate/lib/rooms.mjs";
import { displayWidth, plain } from "../../../plugins/orchestrate/lib/tui-box.mjs";

const execute = promisify(execFile);
// Scratch directories are deliberately retained. No teardown removes user content.
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "ork-status-truth-"));
  const room = createRoom(parseTeam("codex:luna"), { id: "truth", cwd: root });
  room.swarm = { maxAgents: 8 };
  const member = room.agents[0];
  member.dispatch = {
    taskId: "task",
    taskDir: root,
    requestId: "request",
    runId: "run",
    transport: "executor",
  };
  const task = {
    schema: "agent-executor.task.v1",
    task_id: "task",
    repository: root,
    runs: [
      {
        run_id: "run",
        request_id: "request",
        kind: "implementation",
        engine: "codex",
        transport: "executor",
        status: "finished",
        runner_status: "completed",
      },
    ],
    decisions: [],
  };
  const observe = (options = {}) =>
    observeRoom(room, {
      root,
      tasks: new Map([[root, task]]),
      discoverNativePeers: false,
      progress: async () => ({
        conductor: {
          name: "lead",
          stage: "working",
          runtimeState: "running",
          reportedAt: "2099-01-01T00:00:00Z",
        },
        [member.id]: {
          name: "worker",
          stage: "working",
          runtimeState: "running",
          reportedAt: "2099-01-01T00:00:00Z",
        },
      }),
      ...options,
    });
  return { root, room, member, task, observe };
}

const outcomes = [
  ["reported complete", null, "reported (awaiting review)", "221", ["?", "○", "󰋗"]],
  ["completed", "supported", "supported", "80", ["s", "◇", "󰓎"]],
  ["completed", "accept", "accepted", "114", ["+", "✓", "󰄬"]],
  ["stale", "accept", "stale (needs revalidation)", "176", ["~", "↻", "󰑐"]],
  ["failed", null, "failed", "203", ["x", "✗", "󰅖"]],
  ["rejected", "reject", "rejected", "203", ["x", "✗", "󰅖"]],
];

function render(room, tier, completedMode = "expanded", isInHerdr = false) {
  vi.stubEnv("NO_COLOR", "");
  return new HordeView(room, {
    tier,
    color: true,
    height: 60,
    completedMode,
    inHerdr: isInHerdr,
    now: () => 1000,
  }).render(150);
}

describe("truthful Swarm outcomes", () => {
  for (const [tierIndex, tier] of ["ascii", "unicode", "nerd"].entries()) {
    for (const [status, verdict, label, code, glyphs] of outcomes) {
      it(`${tier}: renders ${label} in lead, rows, counts and inactive modes`, () => {
        const room = createRoom(parseTeam("codex:luna"), { id: "truth" });
        const state = { status, verdict, runtimeState: "running", objective: "Review target" };
        Object.assign(room.conductor, state);
        Object.assign(room.agents[0], state);
        for (const mode of ["expanded", "collapsed", "hidden"]) {
          for (const inHerdr of [false, true]) {
            const lines = render(room, tier, mode, inHerdr);
            const text = lines.map(plain).join("\n");
            const glyph = glyphs[tierIndex];
            const stateName = label.split(" ", 1)[0];
            expect(text).toContain(`${glyph} 1 ${stateName}`);
            const occurrences = text.split(label).length - 1;
            expect(occurrences).toBeGreaterThanOrEqual(2);
            expect(lines.join("\n")).toContain(`38;5;${code};1m${glyph} 1 ${stateName}`);
            expect(lines.join("\n")).toContain(`\u{1B}[38;5;${code};1m${label}`);
            expect(lines.every((line) => displayWidth(line) <= 150)).toBe(true);
            expect(text).not.toContain("step 2/4");
          }
        }
      });
    }
  }

  it.each(["completed", "accepted", "supported"])("treats bare %s as a report", (status) => {
    const room = createRoom(parseTeam("codex:luna"), { id: "truth" });
    room.agents[0].status = status;
    const text = render(room, "unicode").map(plain).join("\n");
    expect(text).toContain("○ 1 reported");
    expect(text).toContain("reported (awaiting review)");
    expect(text).not.toMatch(/1 accepted|1 supported|1 complete/u);
  });

  it("shows fractions only from a valid recorded checklist", () => {
    const room = createRoom(parseTeam("codex:luna"), { id: "truth" });
    room.agents[0].status = "working";
    for (const checklist of [
      undefined,
      { completed: 2 },
      { total: 4 },
      { completed: 5, total: 4 },
      { completed: 1.5, total: 4 },
      { completed: 0, total: 0 },
    ]) {
      room.agents[0].checklist = checklist;
      expect(render(room, "unicode").map(plain).join("\n")).not.toMatch(/step \d+\/\d+/u);
    }
    room.agents[0].checklist = { completed: 2, total: 7 };
    expect(render(room, "unicode").map(plain).join("\n")).toContain("step 2/7");
    room.conductor.status = "working";
    room.conductor.progress = { checklist: { completed: 0, total: 3 } };
    expect(render(room, "unicode").map(plain).join("\n")).toContain("step 0/3");
  });
});

describe("rooms decision projection", () => {
  it.each([
    ["accept", "accepted"],
    ["supported", "supported"],
    ["reject", "rejected"],
    ["takeover", "blocked"],
  ])("preserves %s after late progress, including JSON output", async (decision, status) => {
    const { task, observe } = await fixture();
    task.decisions.push({ run_id: "run", decision });
    const observed = await observe();
    const json = JSON.stringify(observed);
    expect(JSON.parse(json).agents[0]).toMatchObject({
      status,
      verdict: decision,
    });
    expect((await observe()).agents[0]).toMatchObject({ status, verdict: decision });
  });

  it.each([
    ["accept", "accepted"],
    ["supported", "supported"],
    ["reject", "rejected"],
    ["takeover", "blocked"],
    [null, "cancelled"],
    [null, "conductor_takeover"],
  ])("protects terminal interactive members (%s, %s)", async (verdict, status) => {
    const { room, member, observe } = await fixture();
    delete member.dispatch;
    Object.assign(member, { status, verdict });
    Object.assign(room.conductor, { status, verdict });
    const observed = await observe();
    expect(observed.agents[0]).toMatchObject({ status, verdict });
    expect(observed.conductor).toMatchObject({ status, verdict });
  });

  it("keeps cancelled dispatches terminal despite runner failure and late progress", async () => {
    const { task, observe } = await fixture();
    Object.assign(task.runs[0], { status: "cancelled", runner_status: "failed" });
    expect((await observe()).agents[0]).toMatchObject({ status: "cancelled", verdict: "pending" });
  });

  it("renders a completed runner without a decision as reported", async () => {
    const { observe } = await fixture();
    const observed = await observe();
    expect(observed.agents[0]).toMatchObject({ status: "review", verdict: "pending" });
    expect(render(observed, "unicode").map(plain).join("\n")).toContain(
      "reported (awaiting review)",
    );
  });

  it.each([
    ["active", undefined, "running"],
    ["finished", "verification_failed", "failed"],
  ])(
    "keeps %s verification activity separate from stale evidence",
    async (status, runnerStatus, expected) => {
      const { task, observe } = await fixture();
      Object.assign(task.runs[0], { kind: "verification", status, runner_status: runnerStatus });
      expect((await observe()).agents[0]).toMatchObject({ status: expected, verdict: "pending" });
    },
  );

  it("requires revalidation of verification without candidate identity", async () => {
    const { task, observe } = await fixture();
    task.runs[0].kind = "verification";
    task.decisions.push({ run_id: "run", decision: "accept" });
    const observed = await observe();
    expect(observed.agents[0]).toMatchObject({
      status: "stale",
      verdict: "accept",
      evidenceState: "stale",
    });
    const text = render(observed, "unicode").map(plain).join("\n");
    expect(text).toContain("stale (needs revalidation)");
    expect(text).not.toContain("1 accepted");
  });

  it("invalidates a decision when its bound result changes", async () => {
    const { root, task, observe } = await fixture();
    const result = '{"answer":"original"}';
    task.runs[0].result_path = path.join(root, "result.json");
    task.runs[0].result_sha256 = createHash("sha256").update(result).digest("hex");
    task.decisions.push({ run_id: "run", decision: "supported" });
    await writeFile(task.runs[0].result_path, result);
    expect((await observe()).agents[0]).toMatchObject({
      status: "supported",
      verdict: "supported",
    });
    await writeFile(task.runs[0].result_path, '{"answer":"replacement"}');
    expect((await observe()).agents[0]).toMatchObject({ status: "stale", verdict: "supported" });
  });

  it("clears a previously accepted projection if the task identity changes", async () => {
    const { task, observe } = await fixture();
    task.decisions.push({ run_id: "run", decision: "accept" });
    expect((await observe()).agents[0]).toMatchObject({ status: "accepted", verdict: "accept" });
    task.task_id = "replacement";
    const observed = await observe();
    expect(observed.agents[0]).toMatchObject({ status: "unknown", verdict: "pending" });
    expect(render(observed, "unicode").map(plain).join("\n")).not.toContain("1 accepted");
  });

  it("marks a host verification stale when its parent result binding mismatches", async () => {
    const { root, task, observe } = await fixture();
    const parentPath = path.join(root, "parent.json");
    const parent = '{"answer":"candidate"}';
    await writeFile(parentPath, parent);
    Object.assign(task.runs[0], {
      result_path: parentPath,
      result_sha256: createHash("sha256").update(parent).digest("hex"),
    });
    const verificationPath = path.join(root, "verification.json");
    await writeFile(
      verificationPath,
      JSON.stringify({
        git_after: { fingerprint: "candidate-fingerprint" },
        git_identity_after: { head: "candidate-head" },
        verification_of: { path: parentPath, sha256: "different-candidate" },
      }),
    );
    task.runs.push({
      run_id: "verify",
      kind: "verification",
      verification_of: "run",
      engine: "codex",
      transport: "host_checks",
      status: "finished",
      runner_status: "completed",
      result_path: verificationPath,
    });
    task.decisions.push({ run_id: "verify", decision: "accept" });
    expect((await observe()).agents[0]).toMatchObject({
      runId: "verify",
      status: "stale",
      verdict: "accept",
    });
  });

  it("keeps accepted snapshots after workspace changes and audits only undecided work", async () => {
    const { root, task, observe } = await fixture();
    await execute("git", ["init", "--quiet", root]);
    const scripts = path.resolve("plugins/orchestrate/skills/orchestrate/scripts");
    const { stdout } = await execute("python3", [
      "-B",
      "-c",
      [
        "import sys, json",
        "from pathlib import Path",
        "sys.path.insert(0, sys.argv[1])",
        "import run_agent as runner",
        "repo = Path(sys.argv[2])",
        'print(json.dumps({"git_after": runner.git_state(repo, []), "git_identity_after": runner.git_identity(repo)}))',
      ].join("\n"),
      scripts,
      root,
    ]);
    // Store evidence outside the candidate checkout so writing it does not invalidate the audit.
    const evidenceRoot = await mkdtemp(path.join(tmpdir(), "ork-status-evidence-"));
    task.runs[0].result_path = path.join(evidenceRoot, "result.json");
    await writeFile(task.runs[0].result_path, stdout);
    task.decisions.push({ run_id: "run", decision: "accept" });
    expect((await observe()).agents[0]).toMatchObject({ status: "accepted", verdict: "accept" });
    const parent = task.runs[0];
    parent.result_sha256 = createHash("sha256").update(stdout).digest("hex");
    const verificationPath = path.join(evidenceRoot, "verification.json");
    const candidate = JSON.parse(stdout);
    await writeFile(
      verificationPath,
      JSON.stringify({
        ...candidate,
        verification_of: { path: parent.result_path, sha256: parent.result_sha256 },
      }),
    );
    task.runs.push({
      run_id: "verify",
      kind: "verification",
      verification_of: "run",
      engine: "codex",
      transport: "host_checks",
      status: "finished",
      runner_status: "completed",
      result_path: verificationPath,
    });
    task.decisions.push({ run_id: "verify", decision: "accept" });
    expect((await observe()).agents[0]).toMatchObject({
      runId: "verify",
      status: "accepted",
      verdict: "accept",
    });
    await writeFile(path.join(root, "candidate.txt"), "changed");
    expect((await observe()).agents[0]).toMatchObject({ status: "accepted", verdict: "accept" });
    task.decisions = [];
    expect((await observe()).agents[0]).toMatchObject({ status: "review", verdict: "pending" });
    await vi.waitFor(async () => {
      expect((await observe()).agents[0]).toMatchObject({ status: "stale", verdict: "pending" });
    });
  });
});

async function verifiedFixture() {
  const context = await fixture();
  const result = JSON.stringify({
    verification: { status: "passed" },
    git_after: { fingerprint: "recorded-candidate" },
    git_identity_after: { head: "recorded-head" },
  });
  Object.assign(context.task.runs[0], {
    result_path: path.join(context.root, "result.json"),
    result_sha256: createHash("sha256").update(result).digest("hex"),
  });
  await writeFile(context.task.runs[0].result_path, result);
  return context;
}

describe("bounded candidate observation", () => {
  it.each([
    ["accept", "accepted"],
    ["supported", "supported"],
  ])("keeps %s snapshots without consulting the moving workspace", async (decision, expected) => {
    const { task, observe } = await verifiedFixture();
    task.decisions.push({ run_id: "run", decision });
    const candidateProbe = vi.fn(() => false);
    expect((await observe({ candidateProbe })).agents[0]).toMatchObject({
      status: expected,
      verdict: decision,
    });
    expect(candidateProbe).toHaveBeenCalledTimes(0);
  });

  it("probes at most once across twenty observations and refreshes after thirty seconds", async () => {
    const { observe } = await verifiedFixture();
    let now = 0;
    const candidateProbe = vi.fn(() => true);
    const options = { candidateProbe, probeNow: () => now };
    for (let i = 0; i < 20; i++) {
      expect((await observe(options)).agents[0]).toMatchObject({
        status: "review",
        verdict: "pending",
      });
    }
    expect(candidateProbe).toHaveBeenCalledTimes(1);
    now = 29_999;
    expect((await observe(options)).agents[0].status).toBe("review");
    expect(candidateProbe).toHaveBeenCalledTimes(1);
    now = 30_000;
    expect((await observe(options)).agents[0].status).toBe("review");
    expect(candidateProbe).toHaveBeenCalledTimes(2);
  });

  it("marks an undecided candidate stale only after a completed mismatch comparison", async () => {
    const { observe } = await verifiedFixture();
    const { promise, resolve: resolveProbe } = Promise.withResolvers();
    const candidateProbe = vi.fn(() => promise);
    expect((await observe({ candidateProbe })).agents[0].status).toBe("review");
    expect((await observe({ candidateProbe })).agents[0].status).toBe("review");
    expect(candidateProbe).toHaveBeenCalledTimes(1);
    resolveProbe(false);
    const observed = await observe({ candidateProbe });
    expect(observed.agents[0]).toMatchObject({ status: "stale", evidenceState: "stale" });
    expect(render(observed, "unicode").map(plain).join("\n")).toContain(
      "stale (needs revalidation)",
    );
  });

  it("permits only one in-flight probe per repository across different result hashes", async () => {
    const { task, observe } = await verifiedFixture();
    const { promise, resolve: resolveProbe } = Promise.withResolvers();
    const candidateProbe = vi.fn(() => promise);
    expect((await observe({ candidateProbe })).agents[0].status).toBe("review");
    const replacement = JSON.stringify({
      verification: { status: "passed" },
      git_after: { fingerprint: "next-candidate" },
      git_identity_after: { head: "next-head" },
    });
    await writeFile(task.runs[0].result_path, replacement);
    task.runs[0].result_sha256 = createHash("sha256").update(replacement).digest("hex");
    for (let i = 0; i < 20; i++) {
      expect((await observe({ candidateProbe })).agents[0].status).toBe("review");
    }
    expect(candidateProbe).toHaveBeenCalledTimes(1);
    resolveProbe(true);
  });

  it("does not reuse a mismatch for a different result hash", async () => {
    const { task, observe } = await verifiedFixture();
    const candidateProbe = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    await observe({ candidateProbe });
    expect((await observe({ candidateProbe })).agents[0].status).toBe("stale");
    const replacement = JSON.stringify({
      verification: { status: "passed" },
      git_after: { fingerprint: "new-candidate" },
      git_identity_after: { head: "new-head" },
    });
    await writeFile(task.runs[0].result_path, replacement);
    task.runs[0].result_sha256 = createHash("sha256").update(replacement).digest("hex");
    expect((await observe({ candidateProbe })).agents[0].status).toBe("review");
    expect((await observe({ candidateProbe })).agents[0].status).toBe("review");
    expect(candidateProbe).toHaveBeenCalledTimes(2);
  });

  it("does not overlap an uncooperative probe after its timeout", async () => {
    vi.useFakeTimers();
    const { observe } = await verifiedFixture();
    let now = 0;
    const { promise, resolve } = Promise.withResolvers();
    const candidateProbe = vi.fn(() => promise);
    const options = { candidateProbe, probeNow: () => now, probeTimeoutMs: 5 };
    expect((await observe(options)).agents[0].status).toBe("review");
    await vi.advanceTimersByTimeAsync(5);
    now = 60_000;
    expect((await observe(options)).agents[0].status).toBe("review");
    expect((await observe(options)).agents[0].status).toBe("review");
    expect(candidateProbe).toHaveBeenCalledTimes(1);
    resolve(null);
  });

  it("retains the cached answer while a refresh is in flight", async () => {
    const { observe } = await verifiedFixture();
    let now = 0;
    const { promise, resolve: resolveProbe } = Promise.withResolvers();
    const candidateProbe = vi
      .fn()
      .mockReturnValueOnce(false)
      .mockImplementation(() => promise);
    const options = { candidateProbe, probeNow: () => now };
    await observe(options);
    expect((await observe(options)).agents[0].status).toBe("stale");
    now = 30_000;
    expect((await observe(options)).agents[0].status).toBe("stale");
    expect((await observe(options)).agents[0].status).toBe("stale");
    expect(candidateProbe).toHaveBeenCalledTimes(2);
    resolveProbe(null);
    const observed = await observe(options);
    expect(observed.agents[0].status).toBe("review");
    expect(render(observed, "unicode").map(plain).join("\n")).toContain(
      "reported (awaiting review)",
    );
  });

  it("shows a failed probe as awaiting review and caches that unknown result", async () => {
    const { observe } = await verifiedFixture();
    const candidateProbe = vi.fn(() => {
      throw new Error("probe unavailable");
    });
    let observed;
    for (let i = 0; i < 20; i++) observed = await observe({ candidateProbe });
    expect(observed.agents[0]).toMatchObject({ status: "review", evidenceState: null });
    expect(render(observed, "unicode").map(plain).join("\n")).toContain(
      "reported (awaiting review)",
    );
    expect(candidateProbe).toHaveBeenCalledTimes(1);
  });

  it("aborts a timed-out probe and leaves its outcome awaiting review", async () => {
    vi.useFakeTimers();
    const { observe } = await verifiedFixture();
    let probeSignal;
    const candidateProbe = vi.fn((_repository, _result, { signal }) => {
      probeSignal = signal;
      return new Promise((resolve) =>
        signal.addEventListener("abort", () => resolve(null), { once: true }),
      );
    });
    const options = { candidateProbe, probeTimeoutMs: 5 };
    expect((await observe(options)).agents[0].status).toBe("review");
    await vi.advanceTimersByTimeAsync(5);
    const observed = await observe(options);
    expect(observed.agents[0]).toMatchObject({ status: "review", evidenceState: null });
    expect(probeSignal.aborted).toBe(true);
    expect(render(observed, "unicode").map(plain).join("\n")).toContain(
      "reported (awaiting review)",
    );
    expect(candidateProbe).toHaveBeenCalledTimes(1);
  });
});

describe("notification outcomes", () => {
  it.each(outcomes)("announces %s with its own outcome wording", (status, verdict, label) => {
    const exec = vi.fn();
    const previous = [{ id: "worker", status: "working" }];
    const next = [
      { id: "worker", status, verdict, stage: "working", progress: { stage: "working" } },
    ];
    expect(
      notifyHerdrTransitions(previous, next, new Set(), { env: { HERDR_ENV: "1" }, exec }),
    ).toBe(true);
    expect(exec.mock.calls[0].slice(0, 2)).toEqual([
      "herdr",
      [
        "notification",
        "show",
        `Orkest: Swarm ${label}`,
        "--body",
        `All 1 agents ${label}.`,
        "--sound",
        ["accepted", "supported"].includes(label) ? "done" : "request",
      ],
    ]);
  });

  it("announces acceptance after a reported outcome without requiring new worker activity", () => {
    const exec = vi.fn();
    const seen = new Set();
    const options = { env: { HERDR_ENV: "1" }, exec };
    const reported = [{ id: "worker", status: "completed" }];
    notifyHerdrTransitions(null, reported, seen, options);
    const accepted = [
      { id: "worker", status: "completed", verdict: "accept", progress: { stage: "working" } },
    ];
    expect(notifyHerdrTransitions(reported, accepted, seen, options)).toBe(true);
    expect(exec.mock.calls[0][1]).toContain("Orkest: Swarm accepted");
    expect(notifyHerdrTransitions(reported, accepted, seen, options)).toBe(false);
  });

  it("keeps mixed accepted and reported outcomes separate", () => {
    const exec = vi.fn();
    const next = [
      { id: "one", status: "completed", verdict: "accept" },
      { id: "two", status: "completed" },
    ];
    expect(
      notifyHerdrTransitions([{ id: "one", status: "working" }], next, new Set(), {
        env: { HERDR_ENV: "1" },
        exec,
      }),
    ).toBe(true);
    expect(exec.mock.calls[0][1]).toEqual([
      "notification",
      "show",
      "Orkest: Swarm outcomes",
      "--body",
      "1 accepted · 1 reported (awaiting review).",
      "--sound",
      "request",
    ]);
  });
});

describe("preserved Swarm layout", () => {
  it.each([
    ["ascii", ">"],
    ["unicode", "▸"],
    ["nerd", "▸"],
  ])("keeps the focused collapsed-row pointer in %s", (tier, pointer) => {
    const room = createRoom(parseTeam("codex:luna"), { id: "truth" });
    Object.assign(room.agents[0], { status: "completed", verdict: "accept" });
    const text = render(room, tier, "collapsed").map(plain).join("\n");
    expect(text).toContain(`${pointer} 1 luna-1`);
    expect(text).toContain("accepted");
  });

  it.each([false, true])("keeps activity on the folder header only with Herdr (%s)", (inHerdr) => {
    const room = createRoom(parseTeam("codex:luna"), { id: "truth", cwd: "/workspace/project" });
    room.agents[0].status = "working";
    const lines = new HordeView(room, { tier: "unicode", inHerdr, now: () => 0 })
      .render(150)
      .map(plain);
    const index = lines.findIndex((line) => line.includes("│ project"));
    expect(lines[index]).toContain(inHerdr ? "1 active" : "1 agent");
    expect(lines[index + 1]).toContain("┌ ▸ 1 luna-1");
    expect(lines[index].includes("1 active")).toBe(inHerdr);
  });
});
