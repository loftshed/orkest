import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

import { roomsCommand } from "../../../plugins/orchestrate/bin/rooms.mjs";
import {
  createRoom,
  deleteRoom,
  listRawRooms,
  parseTeam,
  readRawRoom,
  readRoom,
  roomsDbPath,
  updateRawRoom,
  updateRoom,
  withRoomLock,
} from "../../../plugins/orchestrate/lib/horde-room.mjs";
import { openOrkestSqlite } from "../../../plugins/orchestrate/lib/orkest-sqlite.mjs";
import {
  dispatchMember,
  growRoom,
  listRooms,
  newRoom,
  observeRoom,
  recoverRoom,
} from "../../../plugins/orchestrate/lib/rooms.mjs";

const directories = [];
async function directory() {
  const dir = await mkdtemp(path.join(tmpdir(), "ork-rooms-"));
  directories.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function fixture() {
  const root = await directory();
  const cwd = await directory();
  const taskDir = await directory();
  const room = await newRoom(parseTeam("claude:haiku,codex:luna:max"), {
    id: "room-a",
    cwd,
    root,
    group: "Research",
    title: "Investigate cache",
  });
  const task = {
    schema: "agent-executor.task.v1",
    task_id: "task-a",
    repository: room.cwd,
    runs: [],
    decisions: [],
    updated_at: "2026-10-20T15:00:00Z",
  };
  const run = async (args) => {
    if (args[0] === "show") return structuredClone(task);
    if (args[0] !== "dispatch") throw new Error(`Unexpected command ${args[0]}`);
    const request = args[args.indexOf("--request-id") + 1];
    let existing = task.runs.find((entry) => entry.request_id === request);
    if (!existing) {
      existing = {
        run_id: `run-${task.runs.length + 1}`,
        request_id: request,
        status: "active",
        transport: args[args.indexOf("--transport") + 1],
        engine: args[args.indexOf("--engine") + 1],
        result_path: path.join(taskDir, "result.json"),
      };
      task.runs.push(existing);
    }
    return structuredClone(existing);
  };
  return { root, cwd: room.cwd, taskDir, room, task, run };
}

describe("room execution", () => {
  it("projects consultations under their supervisor with independent model and lifecycle", async () => {
    const { root, room } = await fixture();
    room.conductor.session = { id: "supervisor-a", machine: hostname() };
    room.conductor.model = "supervisor-model";
    const dir = path.join(root, "consultations", "supervisor-a");
    await mkdir(dir, { recursive: true });
    const resultPath = path.join(root, "consult-result.json");
    const record = {
      schema: "orchestrate.consultation-observation.v1",
      id: "consult-a",
      parent_session: "supervisor-a",
      room_id: room.id,
      machine: hostname(),
      pid: process.pid,
      runner_pid: process.pid,
      deadline_ms: Date.now() + 60_000,
      engine: "claude",
      model: "requested-worker-model",
      effort: "high",
      task: "Inspect the lifecycle",
      started_at: new Date().toISOString(),
      result_path: resultPath,
    };
    await writeFile(path.join(dir, "consult-a.json"), JSON.stringify(record));
    const options = { root, progress: async () => new Map(), discoverNativePeers: false };
    const observed = await observeRoom(room, options);
    expect(observed.conductor.model).toBe("supervisor-model");
    expect(observed.agents.at(-1)).toMatchObject({
      id: "consult-a",
      parent: "conductor",
      consultation: true,
      model: "requested-worker-model",
      modelSource: "requested",
      runtimeState: "running",
    });
    await writeFile(
      path.join(dir, "consult-a.json"),
      JSON.stringify({ ...record, deadline_ms: 1 }),
    );
    expect((await observeRoom(room, options)).agents.at(-1)).toMatchObject({
      status: "session unavailable",
      runtimeState: "unknown",
    });
    await writeFile(
      resultPath,
      JSON.stringify({
        schema: "agent-executor.consultation.v1",
        status: "answered",
        model_observed: ["actual-worker-model"],
        session_id: "worker-session",
      }),
    );
    room.agents.push({
      id: "hook-discovered-worker",
      native: true,
      nativeSession: "worker-session",
      status: "idle",
    });
    const finished = await observeRoom(room, options);
    expect(finished.agents.filter((agent) => agent.id === "consult-a")).toHaveLength(1);
    expect(finished.agents.some((agent) => agent.id === "hook-discovered-worker")).toBe(false);
    expect(finished.agents.at(-1)).toMatchObject({
      model: "actual-worker-model",
      modelSource: "observed",
      requestedModel: "requested-worker-model",
      status: "reported complete",
      runtimeState: "stopped",
      nativeSession: "worker-session",
    });
    const anotherSwarm = structuredClone(room);
    anotherSwarm.id = "another-room";
    expect((await observeRoom(anotherSwarm, options)).agents.some((a) => a.consultation)).toBe(
      false,
    );
    const unrelated = structuredClone(room);
    unrelated.conductor.session.id = "another-supervisor";
    expect((await observeRoom(unrelated, options)).agents.some((a) => a.consultation)).toBe(false);
  });

  it("creates and lists grouped rooms without dispatching, then preserves members when adding", async () => {
    const { root, room } = await fixture();
    await growRoom(room.id, parseTeam("agy:flash"), root);
    const result = await listRooms(root);
    expect(
      result.rooms.map((entry) => [
        entry.group,
        entry.title,
        entry.agents.map((member) => member.status),
      ]),
    ).toEqual([["Research", "Investigate cache", ["queued", "queued", "queued"]]]);
  });

  it("persists intent before launch and reuses it after a lost dispatch response", async () => {
    const { root, room, taskDir, task, run } = await fixture();
    let isLoseReply = true;
    const unreliable = async (args) => {
      const result = await run(args);
      if (args[0] === "dispatch") {
        const saved = await readRoom(room.id, root);
        expect(saved.agents[0].dispatch.requestId).toBe(result.request_id);
        if (isLoseReply) {
          isLoseReply = false;
          throw new Error("lost reply");
        }
      }
      return result;
    };
    await expect(
      dispatchMember(room.id, "haiku-1", { root, taskDir, run: unreliable }),
    ).rejects.toThrow("lost reply");
    const result = await dispatchMember(room.id, "haiku-1", { root, taskDir, run: unreliable });
    expect(result.room.agents[0].status).toBe("running");
    expect(result.dispatch.run_id).toBe("run-1");
    expect(task.runs.map((entry) => entry.run_id)).toEqual(["run-1"]);
  });

  it("shows finished work as awaiting review until the coordinator records a verdict", async () => {
    const { root, room, taskDir, task, run } = await fixture();
    await dispatchMember(room.id, "haiku-1", { root, taskDir, run });
    task.runs[0].status = "finished";
    task.runs[0].runner_status = "completed";
    expect((await observeRoom(room.id, { root, run })).agents[0]).toMatchObject({
      status: "review",
      runtimeState: "stopped",
    });
    task.decisions.push({ run_id: "run-1", decision: "supported" });
    expect((await observeRoom(room.id, { root, run })).agents[0].status).toBe("completed");
    task.decisions.length = 0;
    task.runs[0].runner_status = "failed";
    expect((await observeRoom(room.id, { root, run })).agents[0].status).toBe("failed");
    task.decisions.push({ run_id: "run-1", decision: "reject" });
    expect((await observeRoom(room.id, { root, run })).agents[0].status).toBe("rejected");
    task.decisions.push({ run_id: "run-1", decision: "takeover" });
    expect((await observeRoom(room.id, { root, run })).agents[0].status).toBe("blocked");
    task.task_id = "replacement";
    expect((await observeRoom(room.id, { root, run })).agents[0]).toMatchObject({
      status: "unknown",
      runtimeState: "unknown",
    });
  });

  it("reserves native work without inventing an interactive session", async () => {
    const { root, room, taskDir, task, run } = await fixture();
    const result = await dispatchMember(room.id, "luna-1", {
      root,
      taskDir,
      run,
      transport: "native",
    });
    expect(result.dispatch.transport).toBe("native");
    task.runs[0].status = "reserved";
    expect((await observeRoom(room.id, { root, run })).agents[1].status).toBe("reserved");
  });

  it("rejects a changed task or request instead of dispatching another worker", async () => {
    const { root, room, taskDir, task, run } = await fixture();
    await dispatchMember(room.id, "haiku-1", { root, taskDir, run, requestId: "one" });
    await expect(
      dispatchMember(room.id, "haiku-1", { root, taskDir, run, requestId: "two" }),
    ).rejects.toThrow("already has a dispatch");
    await expect(
      dispatchMember(room.id, "luna-1", { root, taskDir, run, requestId: "one" }),
    ).rejects.toThrow("another dispatch");
    expect(task.runs.map((entry) => entry.request_id)).toEqual(["one"]);
  });

  it("clears the intent after a refusal that launched nothing, so the member can dispatch again", async () => {
    const { root, room, taskDir, task, run } = await fixture();
    const refuse = async (args) => {
      if (args[0] === "dispatch") throw new Error("implementation already dispatched");
      return run(args);
    };
    await expect(
      dispatchMember(room.id, "haiku-1", { root, taskDir, run: refuse, kind: "implementation" }),
    ).rejects.toThrow("already dispatched");
    const refused = (await readRoom(room.id, root)).agents.find((agent) => agent.id === "haiku-1");
    expect(refused.dispatch).toBeUndefined();
    expect(refused.status).toBe("queued");
    expect(refused.dispatchError).toBe("implementation already dispatched");
    // A different kind is no longer blocked by the stale intent.
    await dispatchMember(room.id, "haiku-1", { root, taskDir, run, kind: "investigation" });
    expect(task.runs).toHaveLength(1);
  });

  it("keeps the intent when the outcome of a failed dispatch is unknown", async () => {
    const { root, room, taskDir, run } = await fixture();
    const lost = async (args) => {
      if (args[0] === "dispatch") {
        await run(args);
        throw new Error("response lost");
      }
      return run(args);
    };
    await expect(dispatchMember(room.id, "haiku-1", { root, taskDir, run: lost })).rejects.toThrow(
      "response lost",
    );
    const kept = (await readRoom(room.id, root)).agents.find((agent) => agent.id === "haiku-1");
    expect(kept.dispatch.requestId).toBeTruthy();
  });

  it("reports corrupt rooms alongside valid rooms", async () => {
    const { root } = await fixture();
    await mkdir(path.join(root, "rooms"), { recursive: true });
    await writeFile(path.join(root, "rooms", "broken.json"), "{", "utf8");
    const result = await listRooms(root);
    expect(result.rooms.map((room) => room.id)).toEqual(["room-a"]);
    expect(result.errors[0].file).toBe("broken.json");
  });

  it("reads the real coordinator task snapshot without launching a model", async () => {
    const { root, room, taskDir, task, run } = await fixture();
    await dispatchMember(room.id, "haiku-1", { root, taskDir, run });
    task.runs[0].status = "finished";
    task.runs[0].runner_status = "completed";
    await writeFile(path.join(taskDir, "task.json"), JSON.stringify(task));
    const observed = await observeRoom(room.id, { root });
    expect(observed.agents[0].runId).toBe("run-1");
    expect(observed.agents[0].status).toBe("review");
  });

  it("refreshes each task and keeps other members visible when a task is unreadable", async () => {
    const { root, room, taskDir, task, run } = await fixture();
    await dispatchMember(room.id, "haiku-1", { root, taskDir, run, requestId: "first" });
    task.runs[0].status = "finished";
    task.runs[0].runner_status = "completed";
    const secondDir = await directory();
    const secondTask = {
      ...task,
      task_id: "task-b",
      runs: [
        "engine",
        {
          request_id: "second",
          run_id: "run-b",
          engine: "codex",
          transport: "executor",
          status: "active",
        },
      ],
      decisions: ["unrelated malformed decision"],
    };
    await updateRoom(
      room.id,
      (current) => {
        current.agents[1].dispatch = {
          taskDir: secondDir,
          taskId: "task-b",
          requestId: "second",
          runId: "run-b",
          transport: "executor",
        };
        return current;
      },
      { root },
    );
    await writeFile(path.join(taskDir, "task.json"), JSON.stringify(task));
    await writeFile(path.join(secondDir, "task.json"), JSON.stringify(secondTask));
    expect((await observeRoom(room.id, { root })).agents.map((member) => member.status)).toEqual([
      "review",
      "running",
    ]);

    secondTask.runs.shift();
    task.decisions.push({ run_id: "run-1", decision: "supported" });
    await writeFile(path.join(taskDir, "task.json"), JSON.stringify(task));
    await writeFile(
      path.join(secondDir, "task.json"),
      '{"nested":'.repeat(1100) + "0" + "}".repeat(1100),
    );
    expect((await observeRoom(room.id, { root })).agents.map((member) => member.status)).toEqual([
      "completed",
      "unknown",
    ]);
    await writeFile(path.join(secondDir, "task.json"), "{");
    expect((await observeRoom(room.id, { root })).agents.map((member) => member.status)).toEqual([
      "completed",
      "unknown",
    ]);

    secondTask.runs[0].status = "finished";
    secondTask.runs[0].runner_status = "completed";
    await writeFile(path.join(secondDir, "task.json"), JSON.stringify(secondTask));
    expect((await observeRoom(room.id, { root })).agents.map((member) => member.status)).toEqual([
      "completed",
      "review",
    ]);
  });

  it("shows different runs of the same task across rooms", async () => {
    const { root, room, taskDir, task, run } = await fixture();
    await dispatchMember(room.id, "haiku-1", { root, taskDir, run, requestId: "first" });
    task.runs[0].status = "finished";
    task.runs[0].runner_status = "completed";
    task.runs.push({
      request_id: "second",
      run_id: "run-2",
      engine: "codex",
      transport: "executor",
      status: "active",
    });
    await writeFile(path.join(taskDir, "task.json"), JSON.stringify(task));
    const other = await newRoom(parseTeam("codex:luna:max"), {
      id: "room-b",
      cwd: room.cwd,
      root,
    });
    await updateRoom(
      other.id,
      (current) => {
        current.agents[0].dispatch = {
          taskDir,
          taskId: task.task_id,
          requestId: "second",
          runId: "run-2",
          transport: "executor",
        };
        return current;
      },
      { root },
    );
    let output = "";
    await roomsCommand(["list", "--json"], {
      root,
      stdout: {
        write: (value) => {
          output += value;
        },
      },
    });
    expect(JSON.parse(output).rooms.map((entry) => [entry.id, entry.agents[0].status])).toEqual([
      ["room-a", "review"],
      ["room-b", "running"],
    ]);
  });

  it("collects results only while the bound task identity still matches", async () => {
    const { root, room, taskDir, task, run } = await fixture();
    await dispatchMember(room.id, "haiku-1", { root, taskDir, run });
    const collect = async (args) => {
      if (args[0] === "recover") {
        task.runs[0].status = "finished";
        task.runs[0].runner_status = "completed";
        return task;
      }
      return run(args);
    };
    expect((await recoverRoom(room.id, { root, run: collect })).agents[0].status).toBe("review");
    task.task_id = "another-task";
    await expect(recoverRoom(room.id, { root, run: collect })).rejects.toThrow(
      "Task identity changed",
    );
  });
});

describe("rooms under a team", () => {
  it("run only the team's tasks, pass the lead's generation and show the lead", async () => {
    const root = await directory();
    const cwd = await directory();
    const taskDir = await directory();
    const room = await newRoom(parseTeam("claude:haiku"), {
      id: "team-room",
      cwd,
      root,
      authority: "team",
    });
    const task = {
      schema: "agent-executor.task.v1",
      task_id: "t",
      repository: room.cwd,
      runs: [],
      decisions: [],
    };
    const calls = [];
    const run = async (args) => {
      calls.push(args);
      if (args[0] === "show") return structuredClone(task);
      const request = args[args.indexOf("--request-id") + 1];
      task.runs.push({
        run_id: "r1",
        request_id: request,
        status: "active",
        engine: "claude",
        transport: "executor",
      });
      return { run_id: "r1" };
    };
    await expect(dispatchMember(room.id, "haiku-1", { root, taskDir, run })).rejects.toThrow(
      "not under the room's team team",
    );
    task.authority = { team: "team" };
    const lead = async (team) => ({
      team,
      generation: 3,
      status: "active",
      lead: { session: "s" },
    });
    await dispatchMember(room.id, "haiku-1", {
      root,
      taskDir,
      run,
      leadSession: "s",
      leadGeneration: 3,
      authority: lead,
    });
    const dispatch = calls.find((args) => args[0] === "dispatch");
    expect(dispatch.slice(dispatch.indexOf("--lead-session"))).toEqual([
      "--lead-session",
      "s",
      "--lead-generation",
      "3",
    ]);
    expect((await observeRoom(room.id, { root, run, authority: lead })).lead.generation).toBe(3);
  });

  it("passes an optional runner timeout to the coordinator and keeps it with the intent", async () => {
    const { root, room, taskDir, run } = await fixture();
    const calls = [];
    const record = async (args) => {
      calls.push(args);
      return run(args);
    };
    await dispatchMember(room.id, "haiku-1", { root, taskDir, run: record });
    expect(calls.find((args) => args[0] === "dispatch")).not.toContain("--timeout");
    expect((await readRoom(room.id, root)).agents[0].dispatch).not.toHaveProperty("timeout");
    await dispatchMember(room.id, "luna-1", { root, taskDir, run: record, timeout: "25m" });
    const timed = calls.findLast((args) => args[0] === "dispatch");
    expect(timed.slice(timed.indexOf("--timeout"), timed.indexOf("--timeout") + 2)).toEqual([
      "--timeout",
      "25m",
    ]);
    expect((await readRoom(room.id, root)).agents[1].dispatch.timeout).toBe("25m");
    await expect(
      dispatchMember(room.id, "luna-1", { root, taskDir, run: record, timeout: "30m" }),
    ).rejects.toThrow("Existing dispatch differs: timeout");
    await expect(
      dispatchMember(room.id, "haiku-1", { root, taskDir, run: record, timeout: 1500 }),
    ).rejects.toThrow("--timeout needs a duration");
  });

  it("passes verify gates and auto-correct rounds to the coordinator and keeps them with the intent", async () => {
    const { root, room, taskDir, run } = await fixture();
    const calls = [];
    const record = async (args) => {
      calls.push(args);
      return run(args);
    };
    await dispatchMember(room.id, "haiku-1", { root, taskDir, run: record });
    const plain = calls.find((args) => args[0] === "dispatch");
    expect(plain).not.toContain("--verify-command");
    expect(plain).not.toContain("--auto-correct");
    expect((await readRoom(room.id, root)).agents[0].dispatch).not.toHaveProperty("autoCorrect");
    const gates = { verifyCommands: ["pnpm check", "pnpm test"], autoCorrect: 1 };
    await dispatchMember(room.id, "luna-1", {
      root,
      taskDir,
      run: record,
      kind: "implementation",
      ...gates,
    });
    const gated = calls.findLast((args) => args[0] === "dispatch");
    expect(gated.slice(gated.indexOf("--verify-command"))).toEqual([
      "--verify-command",
      "pnpm check",
      "--verify-command",
      "pnpm test",
      "--auto-correct",
      "1",
    ]);
    expect((await readRoom(room.id, root)).agents[1].dispatch).toMatchObject({
      verifyCommands: ["pnpm check", "pnpm test"],
      autoCorrect: "1",
    });
    const again = { root, taskDir, run: record, kind: "implementation" };
    await expect(
      dispatchMember(room.id, "luna-1", { ...again, ...gates, autoCorrect: 2 }),
    ).rejects.toThrow("Existing dispatch differs: autoCorrect");
    await expect(
      dispatchMember(room.id, "luna-1", { ...again, ...gates, verifyCommands: ["pnpm check"] }),
    ).rejects.toThrow("Existing dispatch differs: verifyCommands");
    await dispatchMember(room.id, "luna-1", { ...again, ...gates, autoCorrect: "1" });
    for (const [option, message] of [
      [{ autoCorrect: "one" }, "--auto-correct needs a number"],
      [{ autoCorrect: -1 }, "--auto-correct needs a number"],
      [{ verifyCommands: [" "] }, "--verify-command needs a non-empty command"],
    ])
      await expect(
        dispatchMember(room.id, "haiku-1", { root, taskDir, run: record, ...option }),
      ).rejects.toThrow(message);
  });
});

describe("room CLI", () => {
  it("passes --time-budget to init-task and --timeout to dispatch and launch", async () => {
    const { root, room, taskDir, run } = await fixture();
    const calls = [];
    const record = async (args) => {
      calls.push(args);
      return args[0] === "init" ? { task_id: "task-a" } : run(args);
    };
    const stdout = { write: () => {} };
    const init = [
      "init-task",
      "--task-spec",
      path.join(taskDir, "spec.json"),
      "--task-dir",
      taskDir,
    ];
    await roomsCommand([...init, "--host", "claude"], { stdout, root, run: record });
    await roomsCommand([...init, "--host", "claude", "--time-budget", "2h"], {
      stdout,
      root,
      run: record,
    });
    const [plain, budgeted] = calls.filter((args) => args[0] === "init");
    expect(plain).not.toContain("--time-budget");
    expect(budgeted.slice(-2)).toEqual(["--time-budget", "2h"]);
    await roomsCommand(
      [
        "dispatch",
        "--room",
        room.id,
        "--member",
        "haiku-1",
        "--task-dir",
        taskDir,
        "--timeout",
        "25m",
      ],
      { stdout, root, run: record },
    );
    const plan = path.join(taskDir, "plan.json");
    await writeFile(plan, JSON.stringify({ members: [{ id: "luna-1", taskDir, timeout: "40m" }] }));
    await roomsCommand(["launch", "--room", room.id, "--plan", plan], {
      stdout,
      root,
      run: record,
    });
    const timeouts = calls
      .filter((args) => args[0] === "dispatch")
      .map((args) => args[args.indexOf("--timeout") + 1]);
    expect(timeouts).toEqual(["25m", "40m"]);
  });

  it("passes repeated --verify-command and --auto-correct to dispatch and launch", async () => {
    const { root, room, taskDir, run } = await fixture();
    const calls = [];
    const record = async (args) => {
      calls.push(args);
      return run(args);
    };
    const stdout = { write: () => {} };
    await roomsCommand(
      [
        "dispatch",
        "--room",
        room.id,
        "--member",
        "haiku-1",
        "--task-dir",
        taskDir,
        "--kind",
        "implementation",
        "--verify-command",
        "pnpm check",
        "--verify-command",
        "pnpm test",
        "--auto-correct",
        "2",
      ],
      { stdout, root, run: record },
    );
    const plan = path.join(taskDir, "plan.json");
    await writeFile(
      plan,
      JSON.stringify({
        members: [
          {
            id: "luna-1",
            taskDir,
            kind: "implementation",
            verifyCommands: ["gen.py apply --dry-run"],
            autoCorrect: 1,
          },
        ],
      }),
    );
    await roomsCommand(["launch", "--room", room.id, "--plan", plan], {
      stdout,
      root,
      run: record,
    });
    const [cli, launched] = calls
      .filter((args) => args[0] === "dispatch")
      .map((args) => args.slice(args.indexOf("--verify-command")));
    expect(cli).toEqual([
      "--verify-command",
      "pnpm check",
      "--verify-command",
      "pnpm test",
      "--auto-correct",
      "2",
    ]);
    expect(launched).toEqual(["--verify-command", "gen.py apply --dry-run", "--auto-correct", "1"]);
  });

  it("creates and lists rooms", async () => {
    const root = await directory();
    const cwd = await directory();
    let output = "";
    const stdout = {
      write: (text) => {
        output += text;
      },
    };
    await roomsCommand(
      ["create", "--id", "new", "--cwd", cwd, "--team", "claude:haiku", "--group", "Fixes"],
      { stdout, root },
    );
    expect(JSON.parse(output).group).toBe("Fixes");
    output = "";
    await roomsCommand(["list", "--json"], { stdout, root });
    expect(JSON.parse(output).rooms.map((room) => room.id)).toEqual(["new"]);
  });

  it("propagates herdrPaneId and paneId onto observed agents and ignores legacy progress-v1 paths", async () => {
    const rawRoot = await directory();
    const root = await realpath(rawRoot);
    const rawCwd = await directory();
    const cwd = await realpath(rawCwd);
    const room = await newRoom(parseTeam("claude:haiku"), {
      id: "room-herdr",
      cwd,
      root,
    });
    const sessionKey = "worker-session-1";
    await mkdir(path.join(root, "peers"), { recursive: true });
    await mkdir(path.join(path.dirname(root), "progress-v1"), { recursive: true });
    const nowIso = new Date().toISOString();
    await writeFile(
      path.join(root, "peers", `${sessionKey}.json`),
      JSON.stringify({
        schema: "agent-executor.peer.v1",
        session: sessionKey,
        name: "gribble-claude-haiku-orkest-11",
        harness: "claude",
        cwd,
        pid: process.pid,
        herdrPaneId: "herdr-pane-42",
        herdrEndpoint: "/tmp/observed-herdr.sock",
        paneId: "%42",
        startedAt: nowIso,
        lastSeenAt: nowIso,
      }),
    );
    await writeFile(
      path.join(path.dirname(root), "progress-v1", `${sessionKey}.json`),
      JSON.stringify({
        schema: "orchestrate.progress.v1",
        session: sessionKey,
        harness: "claude",
        machine: hostname(),
        checkout: cwd,
        goal: "Legacy goal",
        task: "Legacy task should be ignored",
        stage: "blocked",
        updatedAt: nowIso,
      }),
    );
    await updateRoom(
      room.id,
      (current) => {
        current.agents[0].session = {
          id: sessionKey,
          engine: "claude",
          machine: hostname(),
          cwd,
        };
        return current;
      },
      { root },
    );

    const observed = await observeRoom(room.id, { root });
    expect(observed.agents[0].herdrPaneId).toBe("herdr-pane-42");
    expect(observed.agents[0].herdrEndpoint).toBe("/tmp/observed-herdr.sock");
    expect(observed.agents[0].paneId).toBe("%42");
    expect(observed.agents[0].progress.task).not.toBe("Legacy task should be ignored");
  });

  it("keeps an idle session separate from its saved review phase", async () => {
    const { root, room, cwd } = await fixture();
    const session = "idle-reviewer";
    const now = new Date().toISOString();
    await mkdir(path.join(root, "peers"), { recursive: true });
    await mkdir(path.join(root, "progress"), { recursive: true });
    await writeFile(
      path.join(root, "peers", `${session}.json`),
      JSON.stringify({
        schema: "agent-executor.peer.v1",
        session,
        name: "reviewer",
        harness: "claude",
        state: "idle",
        accountHome: path.join(root, "claude-home"),
        cwd,
        pid: process.pid,
        startedAt: now,
        lastSeenAt: now,
      }),
    );
    await writeFile(
      path.join(root, "progress", `${session}.json`),
      JSON.stringify({
        schema: "orchestrate.progress.v1",
        session,
        harness: "claude",
        machine: hostname(),
        accountHome: path.join(root, "claude-home"),
        checkout: cwd,
        goal: "Inspect cache",
        task: "Review result",
        stage: "review",
        updatedAt: now,
      }),
    );
    await updateRoom(
      room.id,
      (current) => {
        current.agents[0].session = { id: session, engine: "claude", machine: hostname(), cwd };
        return current;
      },
      { root },
    );
    const observed = await observeRoom(room.id, { root });
    expect(observed.agents[0]).toMatchObject({
      status: "review",
      runtimeState: "idle",
      progress: { stage: "review" },
      activitySource: {
        engine: "claude",
        session,
        accountHome: path.join(root, "claude-home"),
      },
    });
  });

  it("auto-discovers live unbound native peers in the room checkout without mutating persisted room json", async () => {
    const rawRoot = await directory();
    const root = await realpath(rawRoot);
    const rawCwd = await directory();
    const cwd = await realpath(rawCwd);
    const room = await newRoom(parseTeam("claude:haiku"), {
      id: "room-native-auto",
      cwd,
      root,
      title: "Upgrade Swarm View",
    });
    const otherRoom = await newRoom(parseTeam("codex:luna"), {
      id: "room-other",
      cwd,
      root,
    });
    await updateRoom(
      room.id,
      (current) => {
        current.herdrEndpoint = "/tmp/room-herdr.sock";
        current.conductor.herdrWorkspaceId = "w1";
        return current;
      },
      { root },
    );
    await mkdir(path.join(root, "peers"), { recursive: true });
    await mkdir(path.join(root, "progress"), { recursive: true });
    const nowIso = new Date().toISOString();

    // Bind another room's agent to ensure observeRoom skips sessions claimed by other rooms:
    await updateRoom(
      otherRoom.id,
      (current) => {
        current.agents[0].session = {
          id: "claimed-by-other-room",
          engine: "codex",
          machine: hostname(),
          cwd,
        };
        return current;
      },
      { root },
    );

    // Unbound native peer 1: started after room creation with an active progress record
    await writeFile(
      path.join(root, "peers", "native-sub-1.json"),
      JSON.stringify({
        schema: "agent-executor.peer.v1",
        session: "native-sub-1",
        name: "gribble-gemini-3-flash-orkest-ab",
        shortName: "gribble",
        harness: "gemini",
        accountHome: path.join(root, "gemini-home"),
        model: "gemini-3.8-flash-high",
        effort: "high",
        state: "busy",
        cwd,
        pid: process.pid,
        branch: "feat/swarm-view",
        herdrPaneId: "herdr-pane-77",
        herdrWorkspaceId: "w1",
        herdrEndpoint: "/tmp/room-herdr.sock",
        startedAt: nowIso,
        lastSeenAt: nowIso,
      }),
    );
    await writeFile(
      path.join(root, "progress", "native-sub-1.json"),
      JSON.stringify({
        schema: "orchestrate.progress.v1",
        session: "native-sub-1",
        harness: "gemini",
        machine: hostname(),
        accountHome: path.join(root, "gemini-home"),
        checkout: cwd,
        role: "scout",
        goal: "Upgrade Swarm View",
        task: "Auditing native subagent discovery",
        stage: "working",
        updatedAt: nowIso,
      }),
    );

    await writeFile(
      path.join(root, "peers", "other-server.json"),
      JSON.stringify({
        schema: "agent-executor.peer.v1",
        session: "other-server",
        name: "other-codex-orkest-dd",
        harness: "codex",
        state: "busy",
        cwd,
        pid: process.pid,
        herdrPaneId: "herdr-pane-77",
        herdrWorkspaceId: "w1",
        herdrEndpoint: "/tmp/another-herdr.sock",
        startedAt: nowIso,
        lastSeenAt: nowIso,
      }),
    );

    // Unbound native peer 2: claimed by other room (must be excluded)
    await writeFile(
      path.join(root, "peers", "claimed-by-other-room.json"),
      JSON.stringify({
        schema: "agent-executor.peer.v1",
        session: "claimed-by-other-room",
        name: "other-codex-orkest-cc",
        harness: "codex",
        state: "busy",
        cwd,
        pid: process.pid,
        startedAt: nowIso,
        lastSeenAt: nowIso,
      }),
    );

    const observed = await observeRoom(room.id, { root });
    const nativeAgent = observed.agents.find((agent) => agent.native === true);
    expect(nativeAgent).toBeDefined();
    expect(nativeAgent.id).toBe("gribble");
    expect(nativeAgent.engine).toBe("agy");
    expect(nativeAgent.workforceRole).toBe("scout");
    expect(nativeAgent.status).toBe("running");
    expect(nativeAgent.branch).toBe("feat/swarm-view");
    expect(nativeAgent.herdrPaneId).toBe("herdr-pane-77");
    expect(nativeAgent.herdrEndpoint).toBe("/tmp/room-herdr.sock");
    expect(observed.agents.some((agent) => agent.nativeSession === "other-server")).toBe(false);
    expect(nativeAgent.progress.task).toBe("Auditing native subagent discovery");
    expect(nativeAgent.activitySource).toEqual({
      engine: "agy",
      session: "native-sub-1",
      accountHome: path.join(root, "gemini-home"),
      parentSession: undefined,
      cwd,
      startedAt: nowIso,
    });
    expect(observed.agents.some((agent) => agent.nativeSession === "claimed-by-other-room")).toBe(
      false,
    );

    // Persisted room on disk remains untouched (only 1 declared agent):
    const onDisk = await readRoom(room.id, root);
    expect(onDisk.agents).toHaveLength(1);
  });

  it("enriches active Claude Code background subagents from .meta.json/.jsonl and retains completed subagents", async () => {
    const rawRoot = await directory();
    const root = await realpath(rawRoot);
    const rawCwd = await directory();
    const cwd = await realpath(rawCwd);
    const accountHome = await directory();
    const parentSession = "aefa8a6b-23c2-42d9-b932-5205dcf251d2";
    const slug = cwd.replaceAll(/[^A-Za-z0-9-]/gu, "-");
    const subagentsDir = path.join(accountHome, "projects", slug, parentSession, "subagents");
    await mkdir(subagentsDir, { recursive: true });
    await mkdir(path.join(root, "peers"), { recursive: true });
    await mkdir(path.join(root, "progress"), { recursive: true });

    const room = await newRoom([], {
      id: "room-claude-subagents",
      cwd,
      root,
      title: "Swarm Dashboard Polish",
    });
    await updateRoom(
      room.id,
      (current) => {
        current.conductor.name = "floomp";
        current.conductor.person = "floomp";
        current.conductor.engine = "claude";
        current.conductor.model = "claude-opus-5-5";
        current.conductor.session = {
          id: parentSession,
          engine: "claude",
          machine: hostname(),
          cwd,
        };
        return current;
      },
      { root },
    );

    const staleIso = new Date(Date.now() - 14 * 60_000).toISOString();
    // Active subagent peer written by old SubagentStart (wrong parent model & focus, stale lastSeenAt)
    await writeFile(
      path.join(root, "peers", "subagent-a22a04ba7fa8ef95e.json"),
      JSON.stringify({
        schema: "agent-executor.peer.v1",
        session: "subagent-a22a04ba7fa8ef95e",
        name: "ploomix-claude-opus-5-5-orkest-da",
        person: "ploomix",
        shortName: "ploomix",
        harness: "claude",
        model: "claude-opus-5-5",
        state: "busy",
        cwd,
        checkout: cwd,
        accountHome,
        pid: process.pid,
        sharedProcess: true,
        isSubagent: true,
        parentSession,
        focus: "native general-purpose",
        startedAt: staleIso,
        lastSeenAt: staleIso,
      }),
    );
    await writeFile(
      path.join(subagentsDir, "agent-a22a04ba7fa8ef95e.meta.json"),
      JSON.stringify({
        agentType: "general-purpose",
        model: "claude-fable-5-1",
        description: "Fable writes layout spec",
      }),
    );
    await writeFile(
      path.join(subagentsDir, "agent-a22a04ba7fa8ef95e.jsonl"),
      `${JSON.stringify({ message: { model: "claude-fable-5-1" } })}\n`,
    );

    // Completed subagent whose peer file was deleted by SubagentStop
    await writeFile(
      path.join(subagentsDir, "agent-a24fc1a93a67c7e27.meta.json"),
      JSON.stringify({
        agentType: "general-purpose",
        model: "sonnet",
        description: "Sonnet implements layout Phase 1",
        finished: true,
      }),
    );
    await writeFile(
      path.join(subagentsDir, "agent-a24fc1a93a67c7e27.jsonl"),
      `${JSON.stringify({ message: { model: "claude-sonnet-5-5" } })}\n`,
    );

    const prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = accountHome;
    try {
      const observed = await observeRoom(room.id, { root });
      const activeSub = observed.agents.find((a) => a.id === "ploomix");
      expect(activeSub).toBeDefined();
      expect(activeSub.model).toBe("claude-fable-5-1");
      expect(activeSub.status).toBe("running");
      expect(activeSub.progress.task).toBe("Fable writes layout spec");
      // Timestamp refreshed from .jsonl mtime (much newer than 14m ago):
      expect(Date.parse(activeSub.observedAt)).toBeGreaterThan(Date.parse(staleIso));

      const completedSub = observed.agents.find(
        (a) => a.nativeSession === "subagent-a24fc1a93a67c7e27",
      );
      expect(completedSub).toBeDefined();
      expect(completedSub.model).toBe("claude-sonnet-5-5");
      expect(completedSub.status).toBe("reported complete");
      expect(completedSub.progress.task).toBe("Sonnet implements layout Phase 1");
      expect(completedSub.id).not.toMatch(/^subagent-/u);
    } finally {
      if (prevConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
      }
    }
  });

  it("projects consultation answers and attaches agent mailbox messages during observeRoom", async () => {
    const rawRoot = await directory();
    const root = await realpath(rawRoot);
    const rawCwd = await directory();
    const cwd = await realpath(rawCwd);
    await mkdir(path.join(root, "consultations", "conductor-sess"), { recursive: true });
    await mkdir(path.join(root, "inbox", "conductor-sess"), { recursive: true });

    const room = await newRoom([{ label: "worker", engine: "codex", model: "gpt-6-astra" }], {
      id: "room-consult-messages",
      cwd,
      root,
      title: "Consult & Messages",
    });
    const workerId = room.agents[0].id;
    const nowIso = new Date().toISOString();
    await updateRoom(
      room.id,
      (current) => {
        current.conductor.name = "floomp";
        current.conductor.person = "floomp";
        current.conductor.session = {
          id: "conductor-sess",
          engine: "claude",
          machine: hostname(),
          cwd,
        };
        current.agents[0].mailboxSession = "worker-sess-1";
        return current;
      },
      { root },
    );

    const consultResultPath = path.join(root, "consult-result.json");
    await writeFile(
      consultResultPath,
      JSON.stringify({
        schema: "agent-executor.consultation.v1",
        status: "succeeded",
        engine: "claude",
        model: "claude-opus-5-5",
        question: "Is the migration backward-compatible?",
        answer: "Yes, legacy names remain valid.\nNew names decompose cleanly.",
        uncertainty: "Low",
      }),
    );
    await writeFile(
      path.join(root, "consultations", "conductor-sess", "consult-1.json"),
      JSON.stringify({
        schema: "orchestrate.consultation-observation.v1",
        id: "consult-1",
        parent_session: "conductor-sess",
        room_id: room.id,
        machine: hostname(),
        pid: process.pid,
        runner_pid: process.pid,
        deadline_ms: Date.now() + 60_000,
        status: "succeeded",
        engine: "claude",
        model: "claude-opus-5-5",
        task: "Is the migration backward-compatible?",
        started_at: nowIso,
        finished_at: nowIso,
        result_path: consultResultPath,
      }),
    );

    await writeFile(
      path.join(root, "inbox", "conductor-sess", "msg-1.json"),
      JSON.stringify({
        id: "msg-1",
        from: workerId,
        fromSession: "worker-sess-1",
        to: "floomp",
        toSession: "conductor-sess",
        text: "Schema audit completed with zero breaking changes.",
        sentAt: nowIso,
      }),
    );

    const observed = await observeRoom(room.id, { root });
    const consultAgent = observed.agents.find((a) => a.consultation === true);
    expect(consultAgent).toBeDefined();
    expect(consultAgent.answer).toBe(
      "Yes, legacy names remain valid.\nNew names decompose cleanly.",
    );
    expect(consultAgent.uncertainty).toBe("Low");
    expect(consultAgent.output).toEqual([
      "Yes, legacy names remain valid.",
      "New names decompose cleanly.",
      "Uncertainty: Low",
    ]);

    const worker = observed.agents.find((a) => a.id === workerId);
    expect(worker.messages).toHaveLength(1);
    expect(worker.messages[0]).toMatchObject({
      from: workerId,
      to: "floomp",
      text: "Schema audit completed with zero breaking changes.",
    });
    expect(observed.messages).toHaveLength(1);
  });
});

describe("room lock ownership", () => {
  it.each(["legacy", "json"])("does not steal an aged live %s owner", async (format) => {
    const root = await directory();
    const file = path.join(root, "room.json");
    const lock = `${file}.lock`;
    await mkdir(lock);
    const owner =
      format === "legacy"
        ? `${process.pid}\n`
        : JSON.stringify({ pid: process.pid, token: "python-holder" });
    await writeFile(path.join(lock, "owner"), owner);
    const now = Date.now();
    await utimes(lock, (now - 60_000) / 1000, (now - 60_000) / 1000);
    const clock = vi
      .spyOn(Date, "now")
      .mockReturnValueOnce(now)
      .mockReturnValue(now + 4000);
    try {
      await expect(withRoomLock(file, () => "stolen")).rejects.toThrow("Room is locked:");
    } finally {
      clock.mockRestore();
    }
    expect(await readFile(path.join(lock, "owner"), "utf8")).toBe(owner);
  });

  it.each(["dead", "missing", "invalid", "reused", "retired"])(
    "recovers a %s owner",
    async (format) => {
      const root = await directory();
      const file = path.join(root, "room.json");
      const lock = `${file}.lock`;
      await mkdir(lock);
      if (format !== "missing") {
        const owner =
          format === "invalid"
            ? "partial{"
            : JSON.stringify({
                pid: ["dead", "retired"].includes(format) ? 2_147_483_647 : process.pid,
                token: "ended-acquisition",
                ...(format === "reused" && { pidBirth: "previous-process" }),
              });
        await writeFile(
          path.join(lock, format === "retired" ? "owner.2147483647.abcd.retired" : "owner"),
          owner,
        );
      }
      await utimes(lock, 1, 1);
      expect(await withRoomLock(file, () => "recovered")).toBe("recovered");
      await expect(readFile(lock)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("gives a missing owner an acquisition grace period", async () => {
    const root = await directory();
    const file = path.join(root, "room.json");
    await mkdir(`${file}.lock`);
    const now = Date.now();
    const clock = vi
      .spyOn(Date, "now")
      .mockReturnValueOnce(now)
      .mockReturnValue(now + 4000);
    try {
      await expect(withRoomLock(file, () => "stolen")).rejects.toThrow("Room is locked:");
    } finally {
      clock.mockRestore();
    }
    await writeFile(path.join(`${file}.lock`, "owner"), `${process.pid}\n`);
    expect(await readFile(path.join(`${file}.lock`, "owner"), "utf8")).toBe(`${process.pid}\n`);
  });

  it("does not release a replacement acquisition, even with the same PID", async () => {
    const root = await directory();
    const file = path.join(root, "room.json");
    const ownerFile = path.join(`${file}.lock`, "owner");
    await expect(
      withRoomLock(file, async () => {
        const first = JSON.parse(await readFile(ownerFile, "utf8"));
        expect(first.pid).toBe(process.pid);
        expect(typeof first.token).toBe("string");
        await rm(`${file}.lock`, { recursive: true });
        await mkdir(`${file}.lock`);
        await writeFile(ownerFile, JSON.stringify({ pid: process.pid, token: "replacement" }));
        throw new Error("update failed");
      }),
    ).rejects.toThrow("update failed");
    expect(JSON.parse(await readFile(ownerFile, "utf8"))).toEqual({
      pid: process.pid,
      token: "replacement",
    });
  });
});

describe("SQLite room persistence", () => {
  const execute = promisify(execFile);
  const moduleUrl = new URL("../../../plugins/orchestrate/lib/horde-room.mjs", import.meta.url)
    .href;

  it("imports legacy rooms once, archives them, and keeps corrupt files visible", async () => {
    const root = await directory();
    await mkdir(path.join(root, "rooms"));
    const legacy = createRoom([], { id: "legacy", cwd: root });
    await writeFile(path.join(root, "rooms/legacy.json"), JSON.stringify(legacy));
    await writeFile(
      path.join(root, "rooms/minimal.json"),
      JSON.stringify({ cwd: root, agents: [] }),
    );
    await writeFile(path.join(root, "rooms/broken.json"), "{");
    await writeFile(
      path.join(root, "rooms/mismatch.json"),
      JSON.stringify({ id: "wrong", agents: [] }),
    );
    const listed = await listRooms(root);
    expect(listed.rooms.map((room) => room.id)).toEqual(["legacy"]);
    expect(listed.errors.map((error) => error.file).sort((a, b) => a.localeCompare(b))).toEqual([
      "broken.json",
      "minimal.json",
      "mismatch.json",
    ]);
    const archived = JSON.parse(
      await readFile(path.join(root, "rooms.v1-backup/legacy.json"), "utf8"),
    );
    expect(archived).toEqual(legacy);
    expect(readRawRoom("minimal", root)).toMatchObject({ id: "minimal", cwd: root, agents: [] });
    await updateRoom(
      "legacy",
      async (room) => {
        await new Promise((resolve) => setImmediate(resolve));
        room.title = "Updated through SQLite";
        return room;
      },
      { root },
    );
    expect((await readRoom("legacy", root)).title).toBe("Updated through SQLite");
    await expect(readFile(path.join(root, "rooms/legacy.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(path.join(root, "rooms/broken.json"), "utf8")).toBe("{");
    expect(deleteRoom("minimal", root)).toBe(true);
    expect(listRawRooms(root).map((room) => room.id)).toEqual(["legacy"]);
    using db = openOrkestSqlite(roomsDbPath(root));
    expect(db.tagStore.get`PRAGMA journal_mode`.journal_mode).toBe("wal");
    expect(db.tagStore.get`PRAGMA synchronous`.synchronous).toBe(2);
    expect(db.tagStore.get`PRAGMA application_id`.application_id).toBe(1_330_793_298);
  });

  it("recovers an import interrupted after commit before archive without losing the room", async () => {
    const root = await directory();
    await mkdir(path.join(root, "rooms"));
    await writeFile(
      path.join(root, "rooms/recovery.json"),
      JSON.stringify({ id: "recovery", counter: 0 }),
    );
    const child = `
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      fs.renameSync = () => process.exit(73);
      syncBuiltinESMExports();
      const { listRawRooms } = await import(${JSON.stringify(moduleUrl)});
      listRawRooms(process.argv[1]);
    `;
    await expect(
      execute(process.execPath, ["--input-type=module", "-e", child, root]),
    ).rejects.toMatchObject({ code: 73 });
    {
      using db = openOrkestSqlite(roomsDbPath(root));
      db.tagStore
        .run`UPDATE rooms SET data = '{"id":"recovery","counter":1}', revision = revision + 1 WHERE id = 'recovery'`;
    }
    expect(readRawRoom("recovery", root)).toEqual({ id: "recovery", counter: 1 });
    await expect(readFile(path.join(root, "rooms/recovery.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const archived = JSON.parse(
      await readFile(path.join(root, "rooms.v1-backup/recovery.json"), "utf8"),
    );
    expect(archived).toEqual({ id: "recovery", counter: 0 });
  });

  it("retries async callbacks across processes without losing updates", async () => {
    const root = await directory();
    await updateRoom(
      "concurrent",
      () => ({ ...createRoom([], { id: "concurrent", cwd: root }), counter: 0 }),
      { root, create: true },
    );
    const child = `
      import { updateRoom } from ${JSON.stringify(moduleUrl)};
      const root = process.argv[1];
      for (let i = 0; i < 6; i++) {
        await updateRoom("concurrent", async (room) => {
          await new Promise((resolve) => setTimeout(resolve, 3));
          room.counter++;
          return room;
        }, { root });
      }
    `;
    await Promise.all(
      Array.from({ length: 4 }, () =>
        execute(process.execPath, ["--input-type=module", "-e", child, root]),
      ),
    );
    expect((await readRoom("concurrent", root)).counter).toBe(24);
  });

  it("preserves identity and missing/create contracts and protects conditional deletion", async () => {
    const root = await directory();
    await expect(updateRoom("absent", (room) => room, { root })).rejects.toMatchObject({
      code: "ENOENT",
    });
    await updateRawRoom("raw", () => ({ id: "raw", agents: [] }), { root, create: true });
    await expect(updateRawRoom("raw", () => [], { root })).rejects.toThrow(
      "expected a plain object",
    );
    const date = Object.assign(new Date(), { id: "raw" });
    await expect(updateRawRoom("raw", () => date, { root })).rejects.toThrow(
      "expected a plain object",
    );
    const before = readRawRoom("raw", root);
    await expect(updateRawRoom("raw", () => ({}), { root, create: true })).rejects.toThrow(
      "Room already exists: raw",
    );
    await expect(
      updateRawRoom("raw", (room) => ({ ...room, id: "other" }), { root }),
    ).rejects.toThrow("Cannot change room identity");
    await updateRawRoom("raw", (room) => ({ ...room, title: "Fresh" }), { root });
    expect(deleteRoom("raw", root, before)).toBe(false);
    expect(readRawRoom("raw", root).title).toBe("Fresh");
    expect(deleteRoom("raw", root)).toBe(true);
  });

  it("allows concurrent WAL room reads during an active write and bounds optimistic CAS retries", async () => {
    const root = await directory();
    await mkdir(path.join(root, "rooms"), { recursive: true });
    await writeFile(path.join(root, "rooms", "broken.json"), "{");
    await updateRoom(
      "active-room",
      () => ({ ...createRoom([], { id: "active-room", cwd: root }), title: "Committed", count: 0 }),
      { root, create: true },
    );

    using writer = openOrkestSqlite(roomsDbPath(root), { timeout: 50 });
    writer.exec(
      "BEGIN IMMEDIATE; UPDATE rooms SET data = json_set(data, '$.title', 'In-flight') WHERE id = 'active-room';",
    );
    try {
      expect(readRawRoom("active-room", root).title).toBe("Committed");
      expect(listRawRooms(root).map((room) => room.title)).toEqual(["Committed"]);
    } finally {
      writer.exec("ROLLBACK");
    }

    await expect(
      updateRoom(
        "active-room",
        async (room) => {
          using contender = openOrkestSqlite(roomsDbPath(root));
          contender.exec("UPDATE rooms SET revision = revision + 1 WHERE id = 'active-room'");
          room.count++;
          return room;
        },
        { root, maxAttempts: 2 },
      ),
    ).rejects.toThrow("exceeded 2 concurrent retries: active-room");
  });

  it("clears stale member herdrPaneId when peer explicitly nulls Herdr bindings", async () => {
    const { root, room } = await fixture();
    room.conductor.session = { id: "coord-null-herdr", machine: hostname() };
    room.conductor.herdrPaneId = "w1:p1";
    room.conductor.herdrWorkspaceId = "w1";
    room.conductor.herdrEndpoint = "/tmp/old-herdr.sock";
    await mkdir(path.join(root, "peers"), { recursive: true });
    await writeFile(
      path.join(root, "peers", "coord-null-herdr.json"),
      JSON.stringify({
        schema: "orchestrate.peer.v1",
        session: "coord-null-herdr",
        herdrPaneId: null,
        herdrWorkspaceId: null,
        herdrEndpoint: null,
      }),
    );
    const observed = await observeRoom(room, {
      root,
      progress: async () => ({}),
      discoverNativePeers: false,
    });
    expect(observed.conductor.herdrPaneId).toBeUndefined();
    expect(observed.conductor.herdrWorkspaceId).toBeUndefined();
    expect(observed.conductor.herdrEndpoint).toBeUndefined();
  });
});
