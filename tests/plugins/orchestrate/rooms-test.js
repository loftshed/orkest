import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { roomsCommand } from "../../../plugins/orchestrate/bin/rooms.mjs";
import { parseTeam, readRoom, updateRoom } from "../../../plugins/orchestrate/lib/horde-room.mjs";
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
});

describe("room CLI", () => {
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
        model: "gemini-3.8-flash-high",
        effort: "high",
        state: "busy",
        cwd,
        pid: process.pid,
        branch: "feat/swarm-view",
        herdrPaneId: "herdr-pane-77",
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
        checkout: cwd,
        role: "scout",
        goal: "Upgrade Swarm View",
        task: "Auditing native subagent discovery",
        stage: "working",
        updatedAt: nowIso,
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
    expect(nativeAgent.progress.task).toBe("Auditing native subagent discovery");
    expect(observed.agents.some((agent) => agent.nativeSession === "claimed-by-other-room")).toBe(
      false,
    );

    // Persisted room on disk remains untouched (only 1 declared agent):
    const onDisk = await readRoom(room.id, root);
    expect(onDisk.agents).toHaveLength(1);
  });
});
