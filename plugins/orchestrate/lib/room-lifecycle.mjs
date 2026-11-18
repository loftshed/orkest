/**
 * @module room-lifecycle
 *
 * Current swarm, history and cancellation. A room is `active`, `archived` or `cancelled`; the
 * record, its members and their receipts are kept in every state. Archive and cancel close new
 * dispatch authority (see `requireActiveRoom`); workers that already run stay owned by their room
 * and observable until terminal. Read-only operations (history, search, reopen-view) never call the
 * coordinator or a model, and never change a room.
 */
import { realpath } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";

import {
  isActiveRoom,
  listRawRooms,
  mailboxRoot,
  processStarted,
  readRoom,
  roomLifecycle,
  updateRoom,
} from "./horde-room.mjs";
import { hasTerminalDecision } from "./member-state.mjs";
import { authorityShow, coordinator, newRoom, observeRoom, roomOwnerSessions } from "./rooms.mjs";

const RUNNING_TASK_STATES = new Set(["reserved", "running", "unknown"]);
const LIVE_RUN_STATES = new Set(["dispatching", "reserved", "active", "uncertain"]);
const MAX_REASON = 500;

async function canonical(cwd) {
  try {
    return await realpath(cwd);
  } catch {
    return path.resolve(cwd);
  }
}

function cleanReason(reason) {
  if (reason === undefined || reason === null) return;
  if (typeof reason !== "string") throw new Error("--reason must be text");
  const text = reason.replaceAll(/\s+/gu, " ").trim();
  if (text.length > MAX_REASON)
    throw new Error(`--reason must be at most ${MAX_REASON} characters`);
  return text || undefined;
}

function transition(room, to, { now, reason, by }) {
  const from = roomLifecycle(room);
  room.lifecycle = to;
  room.lifecycleHistory = [
    ...(room.lifecycleHistory ?? []),
    { from, to, at: now, ...(reason && { reason }), ...(by && { by }) },
  ];
  switch (to) {
    case "archived": {
      room.archivedAt ??= now;
      break;
    }
    case "cancelled": {
      room.cancelledAt ??= now;
      break;
    }
    default: {
      delete room.archivedAt;
      room.reactivatedAt = now;
    }
  }
}

function isPidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function chiefPidState(room) {
  const launch = room?.chief?.launch;
  const pid = launch?.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) return { alive: false, reason: "no_pid" };
  if (room.machine && room.machine !== hostname()) return { alive: false, reason: "remote" };
  if (!isPidAlive(pid)) return { alive: false, reason: "exited" };
  if (launch.pidBirth) {
    const birth = processStarted(pid);
    if (birth && birth !== launch.pidBirth) return { alive: false, reason: "recycled" };
  }
  return { alive: true, pid };
}

function activeOwnerSessions(room) {
  return [
    ...new Set(
      [
        room?.conductor?.session?.id ?? room?.conductor?.session,
        room?.conductor?.mailboxSession,
        room?.conductor?.nativeSession,
        room?.promotion?.session,
      ].filter((id) => typeof id === "string" && id),
    ),
  ];
}

/** Members whose work outlives a lifecycle change: still running, or finished and unreviewed. */
export function outstandingWork(room, { chiefLiveRuns = [] } = {}) {
  const running = [];
  const awaitingAcceptance = [];
  const members = room.agents ?? [];
  for (const member of members) {
    if (member.consultation) continue;
    const entry = {
      id: member.id,
      engine: member.engine,
      model: member.resolvedModel || member.model,
      ...(member.dispatch?.taskDir && { taskDir: member.dispatch.taskDir }),
      ...(member.runId && { runId: member.runId }),
      ...(member.dispatch?.transport && { transport: member.dispatch.transport }),
    };
    if (member.dispatch) {
      if (hasTerminalDecision(member)) continue;
      if (
        member.runtimeState === "running" ||
        (member.runtimeState !== "stopped" && RUNNING_TASK_STATES.has(member.status))
      )
        running.push(entry);
      else if (member.status === "review") awaitingAcceptance.push(entry);
      continue;
    }
    if (member.role === "lead" && member.session && !hasTerminalDecision(member))
      running.push({ ...entry, transport: "native-lead" });
  }
  const launch = room.chief?.launch;
  if (launch) {
    const pidState = chiefPidState(room);
    const liveRuns =
      chiefLiveRuns.length > 0
        ? chiefLiveRuns
        : (launch.liveRuns ?? []).filter((entry) => LIVE_RUN_STATES.has(entry.status));
    if (pidState.alive || liveRuns.length > 0) {
      running.push({
        id: room.chief.mission?.session || "chief-orchestrator",
        engine: launch.engine || room.conductor?.engine,
        model: launch.model || room.conductor?.model,
        ...(launch.taskDir && { taskDir: launch.taskDir }),
        ...(pidState.alive && { pid: pidState.pid }),
        ...(liveRuns[0]?.run_id && { runId: liveRuns[0].run_id }),
        transport: launch.taskDir ? "chief-coordinator" : "chief-launch",
      });
    }
  }
  return { running, awaitingAcceptance };
}

async function observedOutstanding(room, { root, run }) {
  let chiefLiveRuns = [];
  let chiefError;
  if (room.chief?.launch?.taskDir) {
    try {
      const task = await run(["show", "--task-dir", room.chief.launch.taskDir]);
      chiefLiveRuns = (task?.runs ?? []).filter((entry) => LIVE_RUN_STATES.has(entry.status));
    } catch (error) {
      chiefError = error.message;
    }
  }
  try {
    const observed = await observeRoom(structuredClone(room), {
      root,
      run,
      discoverNativePeers: false,
    });
    return {
      ...outstandingWork(observed, { chiefLiveRuns }),
      observed: !chiefError,
      ...(chiefError && { observationError: chiefError }),
    };
  } catch (error) {
    return {
      ...outstandingWork(room, { chiefLiveRuns }),
      observed: false,
      observationError: chiefError || error.message,
    };
  }
}

function routeBack(room) {
  return {
    view: `ork horde --attach-room ${room.id} --view`,
    reopen: `ork rooms reopen-view --room ${room.id}`,
    show: `ork rooms show --room ${room.id}`,
  };
}

function explainOutstanding(room, outstanding) {
  const parts = [];
  if (outstanding.running.length > 0)
    parts.push(
      `${outstanding.running.length} worker(s) still running (${outstanding.running.map((entry) => entry.id).join(", ")}) stay owned by room ${room.id} until they finish`,
    );
  if (outstanding.awaitingAcceptance.length > 0)
    parts.push(
      `${outstanding.awaitingAcceptance.length} result(s) await acceptance in room ${room.id}`,
    );
  if (parts.length === 0) return `Room ${room.id} has no running or unreviewed work.`;
  return `${parts.join("; ")}. Return to them with ${routeBack(room).reopen}.`;
}

/** Archive closes new dispatch authority. Repeating it keeps the first archive time. */
export async function archiveRoom(
  id,
  { root = mailboxRoot(), run = coordinator, reason, by, now = Date.now() } = {},
) {
  const note = cleanReason(reason);
  let previous;
  const room = await updateRoom(
    id,
    (current) => {
      previous = roomLifecycle(current);
      // Cancelled is the stronger state; an archived room is already history.
      if (previous === "active") transition(current, "archived", { now, reason: note, by });
      return current;
    },
    { root },
  );
  const outstanding = await observedOutstanding(room, { root, run });
  return {
    room: room.id,
    lifecycle: roomLifecycle(room),
    changed: previous === "active",
    archivedAt: room.archivedAt ?? null,
    outstanding,
    explanation: explainOutstanding(room, outstanding),
    route: routeBack(room),
  };
}

/** The checkout's current room: the most recently updated active swarm room on this machine. */
export async function currentRoom({ root = mailboxRoot(), cwd = process.cwd(), session } = {}) {
  const checkout = await canonical(cwd);
  const machine = hostname();
  const active = listRawRooms(root, { lifecycle: "active" });
  for (const room of active) {
    if (!room.swarm || !room.cwd || (room.machine && room.machine !== machine)) continue;
    if ((await canonical(room.cwd)) !== checkout) continue;
    if (session && !roomOwnerSessions(room).includes(session)) continue;
    return room;
  }
}

/** Clear the current selection by archiving it; the room and its workers remain reachable. */
export async function clearCurrentRoom({
  root = mailboxRoot(),
  run = coordinator,
  room: id,
  cwd,
  session,
  reason,
} = {}) {
  const target = id ? { id } : await currentRoom({ root, cwd, session });
  if (!target)
    return {
      room: null,
      changed: false,
      explanation: "No active swarm room for this checkout; nothing to clear.",
    };
  return archiveRoom(target.id, { root, run, reason: reason ?? "cleared", by: session });
}

/**
 * Archive the current room, then open a new one. The new room records where it came from but
 * owns none of the old room's members; their results still route to their original assignment.
 */
export async function startFreshRoom({
  root = mailboxRoot(),
  run = coordinator,
  cwd = process.cwd(),
  session,
  members = [],
  objective,
  title,
  engine,
  model,
  id,
} = {}) {
  const cleared = await clearCurrentRoom({ root, run, cwd, session, reason: "start-fresh" });
  const previous = cleared.room;
  const room = await newRoom(members, {
    root,
    cwd,
    objective,
    title:
      title || (objective ? objective.replaceAll(/\s+/gu, " ").trim().slice(0, 160) : undefined),
    engine: engine || (previous ? (await readRoom(previous, root)).conductor?.engine : undefined),
    model,
    ...(id && { id }),
  });
  const saved = previous
    ? await updateRoom(
        room.id,
        (current) => {
          current.previousRoom = previous;
          return current;
        },
        { root },
      )
    : room;
  return { room: saved, archived: previous ? cleared : null };
}

function summary(room) {
  const lifecycle = roomLifecycle(room);
  return {
    id: room.id,
    title: room.title || room.id,
    ...(room.group && { group: room.group }),
    cwd: room.cwd ?? null,
    lifecycle,
    createdAt: room.createdAt ?? null,
    updatedAt: room.updatedAt ?? null,
    ...(room.archivedAt && { archivedAt: room.archivedAt }),
    ...(room.cancelledAt && { cancelledAt: room.cancelledAt }),
    ...(room.previousRoom && { previousRoom: room.previousRoom }),
    members: Array.isArray(room.agents) ? room.agents.length : 0,
    coordinator: {
      engine: room.conductor?.engine ?? null,
      session: room.conductor?.session?.id ?? null,
    },
    ...(room.objective && { objective: String(room.objective).slice(0, 240) }),
  };
}

async function inCheckout(room, checkout) {
  return !checkout || (room.cwd && (await canonical(room.cwd)) === checkout);
}

/** Stored history, newest first. No coordinator or model call; nothing is migrated or inferred. */
export async function roomHistory({ root = mailboxRoot(), cwd, lifecycle, limit = 50 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
    throw new Error("--limit must be 1–1000");
  const checkout = cwd && (await canonical(cwd));
  const rooms = [];
  const stored = listRawRooms(root, lifecycle ? { lifecycle } : {});
  for (const room of stored) {
    if (!(await inCheckout(room, checkout))) continue;
    rooms.push(summary(room));
    if (rooms.length >= limit) break;
  }
  return { schema: "ork.rooms.history.v1", rooms };
}

function searchable(room) {
  const values = [room.id, room.title, room.group, room.objective, room.cwd];
  for (const member of [room.conductor, ...(room.agents ?? [])]) {
    if (!member) continue;
    values.push(member.id, member.model, member.engine, member.objective, member.session?.id);
    if (member.dispatch) values.push(member.dispatch.taskId, member.dispatch.taskDir);
  }
  const messages = room.messages ?? [];
  for (const message of messages)
    values.push(typeof message === "string" ? message : message?.text);
  return values
    .filter((value) => typeof value === "string" && value)
    .join("\n")
    .toLowerCase();
}

/** Case-insensitive search over stored rooms of every lifecycle; read-only. */
export async function searchRooms(query, { root = mailboxRoot(), cwd, limit = 50 } = {}) {
  if (typeof query !== "string" || !query.trim()) throw new Error("--query is required");
  const terms = query.toLowerCase().split(/\s+/u).filter(Boolean);
  const checkout = cwd && (await canonical(cwd));
  const rooms = [];
  for (const room of listRawRooms(root)) {
    if (!(await inCheckout(room, checkout))) continue;
    const text = searchable(room);
    if (terms.some((term) => !text.includes(term))) continue;
    rooms.push(summary(room));
    if (rooms.length >= limit) break;
  }
  return { schema: "ork.rooms.search.v1", query, rooms };
}

/** What a reopened view shows. It resumes nothing, launches nothing and leaves the lifecycle alone. */
export async function reopenRoomView(id, { root = mailboxRoot() } = {}) {
  const room = await readRoom(id, root);
  const outstanding = outstandingWork(room);
  return {
    schema: "ork.rooms.view.v1",
    room: summary(room),
    lifecycle: roomLifecycle(room),
    resumed: false,
    launched: false,
    outstanding,
    route: routeBack(room),
    next: isActiveRoom(room)
      ? "The room is current; open the view to watch it."
      : `Read-only history. Its workers stay with room ${room.id}; resume explicitly with ork rooms reactivate --room ${room.id}.`,
  };
}

/**
 * Explicit resume of an archived room. It checks the room's team authority and that no other
 * active room already owns the same coordinator in this checkout, then reports pending work.
 */
export async function reactivateRoom(
  id,
  { root = mailboxRoot(), run = coordinator, authority = authorityShow, by, now = Date.now() } = {},
) {
  const stored = await readRoom(id, root);
  const lifecycle = roomLifecycle(stored);
  if (lifecycle === "cancelled")
    throw new Error(`Room ${id} was cancelled; start a fresh room instead of resuming it`);
  if (stored.authority) {
    const current = await authority(stored.authority, { fresh: true });
    if (current?.error)
      throw new Error(`Cannot confirm team ${stored.authority}'s authority: ${current.error}`);
    if (current?.status !== "active")
      throw new Error(
        `Cannot reactivate room ${id}: team ${stored.authority} authority status is ${current?.status || "unknown"}`,
      );
  }
  if (lifecycle === "active")
    return { room: id, lifecycle, changed: false, outstanding: outstandingWork(stored) };
  const owners = new Set(activeOwnerSessions(stored));
  const checkout = stored.cwd && (await canonical(stored.cwd));
  const active = listRawRooms(root, { lifecycle: "active" });
  for (const other of active) {
    if (other.id === id || !other.swarm || !other.cwd || (await canonical(other.cwd)) !== checkout)
      continue;
    if (activeOwnerSessions(other).some((session) => owners.has(session)))
      throw new Error(
        `Room ${other.id} is the current room for this coordinator; archive it before reactivating ${id}`,
      );
  }
  const room = await updateRoom(
    id,
    (current) => {
      if (roomLifecycle(current) === "archived")
        transition(current, "active", { now, reason: "reactivated", by });
      return current;
    },
    { root },
  );
  return {
    room: id,
    lifecycle: roomLifecycle(room),
    changed: true,
    outstanding: await observedOutstanding(room, { root, run }),
    next: "New dispatch is open again. Pending results still need review; nothing was launched.",
  };
}

function chiefPidOutcome(room, launch) {
  const pid = launch?.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) return { outcome: "not_running", method: "none" };
  if (room.machine && room.machine !== hostname()) {
    return {
      outcome: "uncertain",
      method: "remote",
      pid,
      detail: `Chief orchestrator runs on ${room.machine}`,
    };
  }
  if (!isPidAlive(pid)) return { outcome: "not_running", method: "none" };
  if (launch.pidBirth) {
    const birth = processStarted(pid);
    if (birth && birth !== launch.pidBirth) {
      return {
        outcome: "not_running",
        method: "pid-recycled",
        pid,
        detail: `Process ${pid} exited and PID was recycled`,
      };
    }
  }
  try {
    process.kill(pid, "SIGTERM");
    return { outcome: "cancelled", method: "sigterm", pid };
  } catch (error) {
    if (error.code === "ESRCH") return { outcome: "not_running", method: "none" };
    return { outcome: "uncertain", method: "sigterm", pid, detail: error.message };
  }
}

/**
 * Cancel owned runs, and the room itself unless one member is named. An executor run is stopped
 * through the coordinator; a native run can only be interrupted by its host, so that interruption is
 * recorded as uncertain rather than claimed.
 */
export async function cancelRoom(
  id,
  { root = mailboxRoot(), run = coordinator, member: only, reason, by, now = Date.now() } = {},
) {
  const note = cleanReason(reason) || "cancelled by operator";
  const room = await readRoom(id, root);
  const targets = room.agents.filter(
    (agent) => !agent.consultation && agent.dispatch && (!only || agent.id === only),
  );
  if (only && room.agents.every((agent) => agent.id !== only))
    throw new Error(`Unknown member: ${only}`);
  const outcomes = {};
  for (const agent of targets) {
    const { taskDir } = agent.dispatch;
    let task;
    try {
      task = await run(["show", "--task-dir", taskDir]);
    } catch (error) {
      outcomes[agent.id] = { outcome: "uncertain", method: "coordinator", detail: error.message };
      continue;
    }
    const live = (task.runs ?? []).filter(
      (entry) => entry.request_id === agent.dispatch.requestId && LIVE_RUN_STATES.has(entry.status),
    );
    if (live.length === 0) {
      outcomes[agent.id] = { outcome: "not_running", method: "none" };
      continue;
    }
    for (const entry of live) {
      try {
        const result = await run([
          "abandon",
          "--task-dir",
          taskDir,
          "--run-id",
          entry.run_id,
          "--reason",
          note,
        ]);
        if (entry.transport === "native")
          outcomes[agent.id] = {
            outcome: "uncertain",
            method: "native-host",
            runId: entry.run_id,
            detail:
              "The audit was closed, but Orkest cannot interrupt a native tool. Interrupt it with the host's native tools; a late result stays with this assignment.",
          };
        else
          outcomes[agent.id] = {
            outcome: result?.status === "cancelled" ? "cancelled" : "uncertain",
            method: "coordinator",
            runId: entry.run_id,
            ...(result?.recovery && { detail: result.recovery }),
          };
      } catch (error) {
        outcomes[agent.id] = {
          outcome: "uncertain",
          method: entry.transport === "native" ? "native-host" : "coordinator",
          runId: entry.run_id,
          detail: error.message,
        };
      }
    }
  }
  let chiefOutcome;
  if (!only && room.chief?.launch) {
    const launch = room.chief.launch;
    if (launch.taskDir) {
      try {
        const task = await run(["show", "--task-dir", launch.taskDir]);
        const live = (task?.runs ?? []).filter((entry) => LIVE_RUN_STATES.has(entry.status));
        if (live.length === 0) {
          chiefOutcome = chiefPidOutcome(room, launch);
        } else {
          for (const entry of live) {
            try {
              const result = await run([
                "abandon",
                "--task-dir",
                launch.taskDir,
                "--run-id",
                entry.run_id,
                "--reason",
                note,
              ]);
              chiefOutcome = {
                outcome: result?.status === "cancelled" ? "cancelled" : "uncertain",
                method: "coordinator",
                runId: entry.run_id,
                ...(result?.recovery && { detail: result.recovery }),
              };
            } catch (error) {
              chiefOutcome = {
                outcome: "uncertain",
                method: "coordinator",
                runId: entry.run_id,
                detail: error.message,
              };
            }
          }
        }
      } catch (error) {
        chiefOutcome = { outcome: "uncertain", method: "coordinator", detail: error.message };
      }
    } else {
      chiefOutcome = chiefPidOutcome(room, launch);
    }
  }
  const saved = await updateRoom(
    id,
    (current) => {
      for (const [memberId, outcome] of Object.entries(outcomes)) {
        const agent = current.agents.find((entry) => entry.id === memberId);
        // A cancelled assignment never turns back into a queued one.
        if (agent) agent.cancellation = { ...outcome, reason: note, requestedAt: now };
      }
      if (!only && chiefOutcome && current.chief) {
        current.chief.cancellation = { ...chiefOutcome, reason: note, requestedAt: now };
        if (chiefOutcome.outcome === "cancelled") current.chief.state = "cancelled";
      }
      if (!only && roomLifecycle(current) !== "cancelled")
        transition(current, "cancelled", { now, reason: note, by });
      return current;
    },
    { root },
  );
  return {
    room: id,
    lifecycle: roomLifecycle(saved),
    members: outcomes,
    ...(chiefOutcome && { chief: chiefOutcome }),
    uncertain: [
      ...Object.entries(outcomes)
        .filter(([, outcome]) => outcome.outcome === "uncertain")
        .map(([memberId]) => memberId),
      ...(chiefOutcome?.outcome === "uncertain" ? ["chief"] : []),
    ],
    route: routeBack(saved),
  };
}
