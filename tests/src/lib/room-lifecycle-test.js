import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { roomsCommand } from "../../../src/bin/rooms.mjs";
import {
  isClosedRoom,
  listRawRooms,
  parseTeam,
  readRawRoom,
  readRoom,
  roomLifecycle,
  updateRawRoom,
  updateRoom,
  validateRoom,
} from "../../../src/lib/horde-room.mjs";
import {
  HordeView,
  settingsProvenanceLabel,
} from "../../../src/lib/horde-view.mjs";
import { evaluateNextCandidates } from "../../../src/lib/next.mjs";
import {
  archiveRoom,
  cancelRoom,
  clearCurrentRoom,
  outstandingWork,
  reactivateRoom,
  reopenRoomView,
  roomHistory,
  searchRooms,
  startFreshRoom,
} from "../../../src/lib/room-lifecycle.mjs";
import {
  bindSession,
  clearDisplayReadCache,
  createMemberWorktree,
  dispatchMember,
  growRoom,
  listRooms,
  newRoom,
  observeRoom,
  readContinuations,
  reserveLead,
  settingsDisplay,
} from "../../../src/lib/rooms.mjs";
import { retainFixtures } from "../../helpers/retain-fixtures.js";

const directories = [];
async function directory() {
  const dir = await mkdtemp(path.join(tmpdir(), "ork-lifecycle-"));
  directories.push(dir);
  return dir;
}
afterEach(async () => {
  await retainFixtures(directories.splice(0));
});

const silent = { write() {} };
const forbidden = async (args) => {
  throw new Error(`read-only operation called the coordinator: ${args.join(" ")}`);
};

/** A room with one dispatched worker whose coordinator run the test controls. */
async function fixture({ transport = "executor", status = "active" } = {}) {
  const root = await directory();
  const cwd = await directory();
  const taskDir = await directory();
  const room = await newRoom(parseTeam("claude:haiku,codex:luna:max"), {
    id: "room-a",
    cwd,
    root,
    title: "Investigate cache",
    objective: "Find the cache regression",
  });
  const task = {
    schema: "agent-executor.task.v1",
    task_id: "task-a",
    repository: room.cwd,
    status: "active",
    runs: [],
    decisions: [],
    updated_at: "2026-11-18T00:00:00Z",
  };
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    if (args[0] === "show") return structuredClone(task);
    if (args[0] === "dispatch") {
      const request = args[args.indexOf("--request-id") + 1];
      let existing = task.runs.find((entry) => entry.request_id === request);
      if (!existing) {
        existing = {
          run_id: `run-${task.runs.length + 1}`,
          request_id: request,
          kind: args[args.indexOf("--kind") + 1],
          status,
          transport,
          engine: args[args.indexOf("--engine") + 1],
          model: args[args.indexOf("--model") + 1],
          result_path: path.join(taskDir, "result.json"),
        };
        task.runs.push(existing);
      }
      return structuredClone(existing);
    }
    if (args[0] === "abandon") {
      const entry = task.runs.find((value) => value.run_id === args[args.indexOf("--run-id") + 1]);
      entry.status = "cancelled";
      return {
        ...structuredClone(entry),
        status: transport === "native" ? "finished" : "cancelled",
      };
    }
    throw new Error(`Unexpected command ${args[0]}`);
  };
  const [worker] = room.agents;
  await dispatchMember(room.id, worker.id, { root, run, taskDir, kind: "investigation" });
  return { root, cwd: room.cwd, taskDir, room, task, run, calls, worker: worker.id };
}

describe("room lifecycle", () => {
  it("treats legacy rooms without the field as active and rejects unknown states", async () => {
    const { root } = await fixture();
    const raw = readRawRoom("room-a", root);
    expect(raw.lifecycle).toBeUndefined();
    expect(roomLifecycle(raw)).toBe("active");
    expect(listRawRooms(root, { lifecycle: "active" }).map((room) => room.id)).toEqual(["room-a"]);
    expect(() => validateRoom({ ...raw, lifecycle: "closed-by-age" })).toThrow(/lifecycle/u);
    expect(() => listRawRooms(root, { lifecycle: "stale" })).toThrow(/lifecycle/u);
  });

  it("archives with an active child: dispatch closes, the worker stays owned and observable", async () => {
    const { root, run, taskDir, task, worker } = await fixture();
    const archived = await archiveRoom("room-a", { root, run, reason: "switching goals" });
    expect(archived).toMatchObject({ lifecycle: "archived", changed: true });
    expect(archived.outstanding.running.map((entry) => entry.id)).toEqual([worker]);
    expect(archived.explanation).toMatch(/still running .* stay owned by room room-a/u);
    expect(archived.route.reopen).toBe("ork rooms reopen-view --room room-a");

    const stored = await readRoom("room-a", root);
    expect(stored.agents.find((agent) => agent.id === worker).dispatch.taskId).toBe("task-a");
    expect(stored.lifecycleHistory).toEqual([
      expect.objectContaining({ from: "active", to: "archived", reason: "switching goals" }),
    ]);

    const other = stored.agents.find((agent) => agent.id !== worker).id;
    await expect(
      dispatchMember("room-a", other, { root, run, taskDir, kind: "investigation" }),
    ).rejects.toThrow(/archived; it accepts no new dispatch/u);
    await expect(growRoom("room-a", parseTeam("claude:haiku"), root)).rejects.toThrow(/archived/u);
    await expect(reserveLead("room-a", other, "lead it", { root })).rejects.toThrow(/archived/u);
    await expect(
      roomsCommand(["objective", "--room", "room-a", "--objective", "Updated objective"], {
        stdout: silent,
        root,
        run,
      }),
    ).rejects.toThrow(/archived/u);

    // A late completion routes to the original assignment in the archived room.
    task.runs[0].status = "finished";
    const observed = await observeRoom("room-a", {
      root,
      run,
      progress: async () => new Map(),
      discoverNativePeers: false,
    });
    expect(observed.agents.find((agent) => agent.id === worker)).toMatchObject({
      runId: "run-1",
      status: "review",
    });
    expect(outstandingWork(observed).awaitingAcceptance.map((entry) => entry.id)).toEqual([worker]);
  });

  it("keeps the first archive time when archive repeats", async () => {
    const { root, run } = await fixture();
    const first = await archiveRoom("room-a", { root, run, now: 1000 });
    const second = await archiveRoom("room-a", { root, run, now: 2000 });
    expect(second).toMatchObject({ changed: false, archivedAt: first.archivedAt });
    expect((await readRoom("room-a", root)).lifecycleHistory).toHaveLength(1);
  });

  it("starts fresh without adopting the archived room's workers", async () => {
    const { root, cwd, run, worker } = await fixture();
    const fresh = await startFreshRoom({ root, run, cwd, objective: "New direction" });
    expect(fresh.archived).toMatchObject({ room: "room-a", lifecycle: "archived" });
    expect(fresh.room).toMatchObject({ previousRoom: "room-a", agents: [] });
    expect(fresh.room.id).not.toBe("room-a");
    expect((await listRooms(root)).rooms.map((room) => room.id)).toEqual([fresh.room.id]);
    expect((await listRooms(root, { all: true })).rooms.map((room) => room.id)).toHaveLength(2);
    const old = await readRoom("room-a", root);
    expect(old.agents.some((agent) => agent.id === worker && agent.dispatch)).toBe(true);
    // Clearing again finds the fresh room as current, not the archived one.
    const cleared = await clearCurrentRoom({ root, run, cwd });
    expect(cleared.room).toBe(fresh.room.id);
    expect((await clearCurrentRoom({ root, run, cwd })).room).toBeNull();
  });

  it("reopens a view without resuming, launching or calling the coordinator", async () => {
    const { root, run } = await fixture();
    await archiveRoom("room-a", { root, run });
    const view = await reopenRoomView("room-a", { root });
    expect(view).toMatchObject({ lifecycle: "archived", resumed: false, launched: false });
    expect(view.next).toMatch(/reactivate/u);
    const history = await roomHistory({ root });
    expect(history.rooms).toEqual([
      expect.objectContaining({ id: "room-a", lifecycle: "archived", members: 2 }),
    ]);
    expect((await searchRooms("cache regression", { root })).rooms).toHaveLength(1);
    expect((await searchRooms("nothing-like-this", { root })).rooms).toHaveLength(0);
    for (const argv of [
      ["history", "--json"],
      ["search", "--query", "luna", "--json"],
      ["reopen-view", "--room", "room-a", "--json"],
    ])
      await roomsCommand(argv, { stdout: silent, root, run: forbidden });
    expect(roomLifecycle(readRawRoom("room-a", root))).toBe("archived");
  });

  it("reactivates explicitly only when no other active room owns the coordinator", async () => {
    const { root, cwd, run } = await fixture();
    await updateRawRoom(
      "room-a",
      (room) => {
        room.conductor.session = { id: "lead-1", engine: "codex", machine: hostname(), cwd };
        return room;
      },
      { root },
    );
    await archiveRoom("room-a", { root, run });
    const fresh = await newRoom([], { id: "room-b", cwd, root, engine: "codex" });
    await updateRawRoom(
      fresh.id,
      (room) => {
        room.conductor.session = { id: "lead-1", engine: "codex", machine: hostname(), cwd };
        return room;
      },
      { root },
    );
    await expect(reactivateRoom("room-a", { root, run })).rejects.toThrow(
      /room-b is the current room/u,
    );
    await archiveRoom("room-b", { root, run });
    const resumed = await reactivateRoom("room-a", { root, run });
    expect(resumed).toMatchObject({ lifecycle: "active", changed: true });
    expect(resumed.next).toMatch(/nothing was launched/u);
    expect(roomLifecycle(readRawRoom("room-a", root))).toBe("active");
  });

  it("checks team authority before reactivating", async () => {
    const { root, run } = await fixture();
    await updateRoom(
      "room-a",
      (room) => {
        room.authority = "team-x";
        return room;
      },
      { root },
    );
    await archiveRoom("room-a", { root, run });
    await expect(
      reactivateRoom("room-a", { root, run, authority: async () => ({ error: "no record" }) }),
    ).rejects.toThrow(/Cannot confirm team team-x/u);
  });

  it("cancels an executor run through the coordinator and never re-queues it", async () => {
    const { root, run, calls, worker } = await fixture();
    const result = await cancelRoom("room-a", { root, run, reason: "wrong goal" });
    expect(calls.some((args) => args[0] === "abandon")).toBe(true);
    expect(result.members[worker]).toMatchObject({ outcome: "cancelled", method: "coordinator" });
    expect(result).toMatchObject({ lifecycle: "cancelled", uncertain: [] });
    const stored = await readRoom("room-a", root);
    expect(stored.agents.find((agent) => agent.id === worker)).toMatchObject({
      cancellation: { outcome: "cancelled", reason: "wrong goal" },
    });
    expect(stored.agents.find((agent) => agent.id === worker).dispatch).toBeDefined();
    await expect(reactivateRoom("room-a", { root, run })).rejects.toThrow(/was cancelled/u);
  });

  it("records a native interruption as uncertain instead of claiming it", async () => {
    const { root, run, worker } = await fixture({ transport: "native", status: "reserved" });
    const result = await cancelRoom("room-a", { root, run, member: worker });
    expect(result.members[worker]).toMatchObject({ outcome: "uncertain", method: "native-host" });
    expect(result.uncertain).toEqual([worker]);
    // Cancelling one member leaves the room active.
    expect(result.lifecycle).toBe("active");
  });
});

describe("continuation and provenance display", () => {
  it("shows awaiting coordinator turn from durable continuation requests", async () => {
    const { root, worker, taskDir } = await fixture();
    await mkdir(path.join(root, "continuations"), { recursive: true });
    await writeFile(
      path.join(root, "continuations", "requests.json"),
      JSON.stringify({
        schema: "orkest.continuation-requests.v1",
        requests: {
          "cont-1": {
            key: "cont-1",
            room: "room-a",
            member: worker,
            task_dir: taskDir,
            status: "requested",
            reasons: ["stop", "worker_terminal"],
            deliveries: 1,
            availability: "unavailable",
            manual_resume: "ork rooms show --room room-a",
          },
          "cont-2": { key: "cont-2", room: "room-b", status: "requested", reasons: ["stop"] },
          "cont-3": { key: "cont-3", room: "room-a", status: "completed", reasons: ["stop"] },
        },
      }),
    );
    expect((await readContinuations(root, "room-a")).map((entry) => entry.key)).toEqual([
      "cont-1",
      "cont-3",
    ]);
    const observed = await observeRoom("room-a", {
      root,
      run: async () => ({ schema: "agent-executor.task.v1", task_id: "task-a", runs: [] }),
      progress: async () => new Map(),
      discoverNativePeers: false,
    });
    expect(observed.continuations).toEqual([
      expect.objectContaining({ key: "cont-1", label: "awaiting coordinator turn" }),
    ]);
    expect(observed.conductor.awaitingTurn).toBe(true);
    const text = new HordeView(observed, { color: false }).render(120).join("\n");
    expect(text).toContain("awaiting coordinator turn");

    const next = await evaluateNextCandidates({
      cwd: observed.cwd,
      discoverWorktreesFn: async () => [],
      room: observed,
    });
    expect(next.continuations).toEqual([
      expect.objectContaining({
        key: "cont-1",
        roomId: "room-a",
        manualResume: expect.any(String),
      }),
    ]);
    // Shown for the coordinator, never turned into an executable step.
    expect(next.candidates.some((candidate) => candidate.kind.includes("continuation"))).toBe(
      false,
    );
  });

  it("labels archived history in the view title", async () => {
    const { root, run } = await fixture();
    await archiveRoom("room-a", { root, run });
    const room = await readRoom("room-a", root);
    const text = new HordeView(room, { color: false }).render(120).join("\n");
    expect(text).toMatch(/Investigate cache · archived/u);
  });

  it("never shows a requested or inherited model as observed", () => {
    const at = "2026-11-18T00:00:00Z";
    const requested = {
      requested: { model: "sonnet", effort: null, source: "dispatch", at },
      resolved: { model: null, effort: null, source: "coordinator", at },
      observed: null,
      mismatch: [],
    };
    expect(settingsDisplay(requested)).toMatchObject({ modelSource: "requested" });
    expect(settingsProvenanceLabel(settingsDisplay(requested))).toBe(" (requested)");
    const inherited = {
      ...requested,
      requested: { ...requested.requested, source: "inherited" },
    };
    expect(settingsProvenanceLabel(settingsDisplay(inherited))).toBe(" (inherited)");
    const resolved = {
      ...requested,
      resolved: { model: "claude-sonnet-5-5", effort: "high", source: "coordinator", at },
    };
    expect(settingsDisplay(resolved)).toMatchObject({ modelSource: "resolved" });
    expect(settingsProvenanceLabel(settingsDisplay(resolved))).toBe("");
    const mismatch = {
      ...resolved,
      observed: { model: "claude-haiku-5-5", effort: null, source: "host", at },
      mismatch: [{ field: "model", resolved: "claude-sonnet-5-5", observed: "claude-haiku-5-5" }],
    };
    expect(settingsDisplay(mismatch)).toMatchObject({
      modelSource: "observed",
      resolvedModel: "claude-haiku-5-5",
    });
    expect(settingsProvenanceLabel(settingsDisplay(mismatch))).toBe(" (observed ≠ resolved)");
    expect(settingsDisplay()).toEqual({});
  });

  it("shows a native consultation as its own actor awaiting the host", async () => {
    const { root } = await fixture();
    const room = await readRoom("room-a", root);
    room.conductor.session = { id: "supervisor-a", machine: hostname() };
    room.conductor.model = "supervisor-model";
    const dir = path.join(root, "consultations", "supervisor-a");
    await mkdir(dir, { recursive: true });
    const resultPath = path.join(root, "native-result.json");
    await writeFile(
      resultPath,
      JSON.stringify({ schema: "agent-executor.consultation.v1", status: "native_handoff" }),
    );
    const startedAt = new Date(Date.now() + 1000).toISOString();
    await writeFile(
      path.join(dir, "consult-n.json"),
      JSON.stringify({
        schema: "orchestrate.consultation-observation.v1",
        id: "consult-n",
        parent_session: "supervisor-a",
        room_id: "room-a",
        machine: hostname(),
        pid: null,
        runner_pid: process.pid,
        deadline_ms: Date.now() + 60_000,
        engine: "claude",
        model: "claude-opus-5-5",
        effort: "high",
        task: "Second opinion",
        started_at: startedAt,
        result_path: resultPath,
        transport: "native",
      }),
    );
    const observed = await observeRoom(room, {
      root,
      run: async () => ({ schema: "agent-executor.task.v1", task_id: "task-a", runs: [] }),
      progress: async () => new Map(),
      discoverNativePeers: false,
    });
    expect(observed.conductor.model).toBe("supervisor-model");
    expect(observed.agents.at(-1)).toMatchObject({
      id: "consult-n",
      consultation: true,
      transport: "native",
      status: "native handoff",
      runtimeState: "unknown",
      model: "claude-opus-5-5",
      modelSource: "requested",
      supervisor: { session: "supervisor-a", member: "conductor" },
    });
  });

  it("treats archived and cancelled rooms as closed and handles chief launch cancellation and authority checks", async () => {
    expect(isClosedRoom({ lifecycle: "archived" })).toBe(true);
    expect(isClosedRoom({ lifecycle: "cancelled" })).toBe(true);
    expect(isClosedRoom({ status: "cancelled" })).toBe(true);
    expect(isClosedRoom({ lifecycle: "active" })).toBe(false);

    const root = await directory();
    const cwd = await directory();
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
      stdio: "ignore",
    });
    try {
      const missionRoom = await newRoom(parseTeam("claude:haiku"), {
        id: "chief-mission-room",
        cwd,
        root,
      });
      await updateRawRoom(
        missionRoom.id,
        (current) => {
          current.chief = {
            goal: "Watch process",
            state: "running",
            mission: { session: "chief-mission-room-orch" },
            launch: { engine: "claude", status: "started", pid: child.pid },
          };
          return current;
        },
        { root },
      );
      expect(outstandingWork(readRawRoom(missionRoom.id, root)).running).toEqual([
        expect.objectContaining({
          id: "chief-mission-room-orch",
          pid: child.pid,
          transport: "chief-launch",
        }),
      ]);
      const cancelled = await cancelRoom(missionRoom.id, { root, run: forbidden, reason: "stop" });
      expect(cancelled.chief).toMatchObject({
        outcome: "cancelled",
        method: "sigterm",
        pid: child.pid,
      });
      expect(readRawRoom(missionRoom.id, root).chief.cancellation).toMatchObject({
        outcome: "cancelled",
        method: "sigterm",
      });
    } finally {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already terminated.
      }
    }

    // Recycled PID (mismatched pidBirth) must NOT be treated as live or signalled.
    const recycled = await newRoom(parseTeam("claude:haiku"), { id: "recycled-chief", cwd, root });
    await updateRawRoom(
      recycled.id,
      (current) => {
        current.chief = {
          goal: "Recycled check",
          state: "running",
          mission: { session: "recycled-orch" },
          launch: { pid: process.pid, pidBirth: "1999-01-01T00:00:00Z" },
        };
        return current;
      },
      { root },
    );
    expect(outstandingWork(readRawRoom(recycled.id, root)).running).toEqual([]);
    const safeCancel = await cancelRoom(recycled.id, { root, run: forbidden });
    expect(safeCancel.chief).toMatchObject({ outcome: "not_running", method: "pid-recycled" });

    // Coordinator taskDir abandon for Chief launch when taskDir is recorded.
    const abandonedCalls = [];
    const coordMission = await newRoom(parseTeam("claude:haiku"), { id: "coord-chief", cwd, root });
    await updateRawRoom(
      coordMission.id,
      (current) => {
        current.chief = {
          goal: "Taskdir cancel",
          state: "running",
          mission: { session: "coord-chief-orch" },
          launch: { taskDir: "/tmp/chief-task" },
        };
        return current;
      },
      { root },
    );
    const coordCancelled = await cancelRoom(coordMission.id, {
      root,
      run: async (args) => {
        abandonedCalls.push(args);
        if (args[0] === "show") return { runs: [{ run_id: "r-chief", status: "active" }] };
        return { status: "cancelled" };
      },
    });
    expect(coordCancelled.chief).toMatchObject({
      outcome: "cancelled",
      method: "coordinator",
      runId: "r-chief",
    });
    expect(abandonedCalls.some((args) => args[0] === "abandon")).toBe(true);

    // reactivateRoom checks authority({ fresh: true }), requires status === "active", and ignores previousSessions.
    const authRoom = await newRoom(parseTeam("claude:haiku"), {
      id: "auth-reactivate",
      cwd,
      root,
      authority: "team-a",
    });
    await archiveRoom(authRoom.id, { root, run: forbidden });
    const authorityCalls = [];
    await expect(
      reactivateRoom(authRoom.id, {
        root,
        run: forbidden,
        authority: async (team, opts) => {
          authorityCalls.push([team, opts]);
          return { team, status: "withdrawn" };
        },
      }),
    ).rejects.toThrow(/withdrawn/u);
    expect(authorityCalls).toEqual([["team-a", { fresh: true }]]);

    // start-fresh -> owner moves to new session (historical in previousSessions) -> old room reactivates cleanly.
    const oldRoom = await newRoom(parseTeam("claude:haiku"), { id: "old-room", cwd, root });
    await updateRawRoom(
      oldRoom.id,
      (current) => {
        current.conductor.session = { id: "sess-1", machine: hostname(), engine: "claude", cwd };
        current.conductor.previousSessions = ["shared-old-sess"];
        return current;
      },
      { root },
    );
    await archiveRoom(oldRoom.id, { root, run: forbidden });
    const freshRoom = await newRoom(parseTeam("claude:haiku"), { id: "fresh-room", cwd, root });
    await updateRawRoom(
      freshRoom.id,
      (current) => {
        current.conductor.session = { id: "sess-2", machine: hostname(), engine: "claude", cwd };
        current.conductor.previousSessions = ["shared-old-sess"];
        return current;
      },
      { root },
    );
    const reactivated = await reactivateRoom(oldRoom.id, { root, run: forbidden });
    expect(reactivated.changed).toBe(true);
  });

  it("blocks bindSession, createMemberWorktree, and recorded-intent dispatch on archived rooms and bounds observeRoom", async () => {
    const root = await directory();
    const cwd = await directory();
    const taskDir = await directory();
    const room = await newRoom(parseTeam("claude:haiku"), { id: "frozen-room", cwd, root });
    const workerId = room.agents[0].id;
    await updateRawRoom(
      room.id,
      (current) => {
        current.conductor.session = {
          id: "sup-frozen",
          machine: hostname(),
          engine: "claude",
          cwd,
        };
        current.agents[0].dispatch = {
          taskDir,
          taskId: "task-f",
          requestId: "req-f",
          kind: "investigation",
          transport: "executor",
        };
        return current;
      },
      { root },
    );
    await archiveRoom(room.id, { root, run: forbidden });
    const archivedRoom = await readRoom(room.id, root);

    await expect(
      bindSession(room.id, "conductor", { session: "new-s", engine: "claude", root }),
    ).rejects.toThrow(/archived/u);
    await expect(createMemberWorktree(room.id, workerId, { root })).rejects.toThrow(/archived/u);
    await expect(
      dispatchMember(room.id, workerId, {
        root,
        taskDir,
        kind: "investigation",
        run: async () => ({
          schema: "agent-executor.task.v1",
          task_id: "task-f",
          repository: cwd,
          runs: [],
        }),
      }),
    ).rejects.toThrow(/archived/u);

    // Consultations and inbox messages created AFTER archivedAt are excluded from inactive observeRoom,
    // and native discovery is skipped for inactive rooms.
    const postArchiveIso = new Date(archivedRoom.archivedAt + 10_000).toISOString();
    await mkdir(path.join(root, "consultations", "sup-frozen"), { recursive: true });
    await writeFile(
      path.join(root, "consultations", "sup-frozen", "post-c.json"),
      JSON.stringify({
        schema: "orchestrate.consultation-observation.v1",
        id: "post-c",
        parent_session: "sup-frozen",
        room_id: room.id,
        machine: hostname(),
        pid: process.pid,
        runner_pid: process.pid,
        deadline_ms: Date.now() + 60_000,
        started_at: postArchiveIso,
        result_path: path.join(root, "post-c-res.json"),
      }),
    );
    await mkdir(path.join(root, "inbox", "sup-frozen"), { recursive: true });
    await writeFile(
      path.join(root, "inbox", "sup-frozen", "m-after.json"),
      JSON.stringify({
        schema: "agent-executor.mail.v1",
        id: "m-after",
        from: { session: workerId, name: workerId },
        text: "late note after archive",
        sentAt: postArchiveIso,
      }),
    );
    const observedArchived = await observeRoom(room.id, {
      root,
      run: async () => ({ schema: "agent-executor.task.v1", task_id: "task-f", runs: [] }),
      progress: async () => new Map(),
      discoverNativePeers: false,
    });
    expect(observedArchived.agents.some((a) => a.id === "post-c")).toBe(false);
    expect(observedArchived.messages).toEqual([]);

    // Active room peer discovery still ignores archived room's conductor lockout while isolating workers.
    await mkdir(path.join(root, "peers"), { recursive: true });
    const nowMs = Date.now();
    const startIso = new Date(nowMs - 1000).toISOString();
    const seenIso = new Date(nowMs).toISOString();
    await writeFile(
      path.join(root, "peers", "reused-cond.json"),
      JSON.stringify({
        schema: "agent-executor.peer.v1",
        session: "sup-frozen",
        name: "claude-reused",
        harness: "claude",
        cwd,
        pid: process.pid,
        state: "busy",
        isSubagent: true,
        startedAt: startIso,
        lastSeenAt: seenIso,
        parentSession: "active-cond",
      }),
    );
    const activeRoom = await newRoom([], { id: "active-next", cwd, root });
    await updateRawRoom(
      activeRoom.id,
      (current) => {
        current.conductor.session = {
          id: "active-cond",
          machine: hostname(),
          engine: "claude",
          cwd,
        };
        return current;
      },
      { root },
    );
    clearDisplayReadCache();
    const observedActive = await observeRoom(activeRoom.id, {
      root,
      run: async () => ({ schema: "agent-executor.task.v1", task_id: "task-n", runs: [] }),
      discoverNativePeers: true,
    });
    expect(
      observedActive.agents.some(
        (a) => a.nativeSession === "sup-frozen" || a.session?.id === "sup-frozen",
      ),
    ).toBe(true);
  });
});
