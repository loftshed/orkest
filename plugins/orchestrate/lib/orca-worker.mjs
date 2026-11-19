// Orca IDE plugin worker (orca-plugin.json `main`): toggles the Orkest Swarm View in a split beside
// the coordinator, records which Orca terminal each agent runs in, restores open views after a cold
// restart, serves the Orkest sidebar panel, and keeps a quota item in the status bar from
// `monitor json`.
//
// Orca starts this module out of process with a stripped environment (PATH, HOME, locale and a few
// session variables), so every path is derived from this file's location and HOME.

import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { summarizeQuota as summarizeMonitorQuota } from "../../monitor/lib/render.mjs";
import {
  enrichedEnv,
  findExecutable,
  ORCA_TERMINALS_SCHEMA,
  ORCA_VIEW_SCHEMA,
  ORCA_VIEW_TITLE_PREFIX,
  orcaCacheHome,
  orcaTerminalHandle,
  orcaTerminalsPath,
  orcaViewPath,
  orcaViewsDirectory,
  orcaViewTitle,
  readJsonState,
  readOrcaTerminals,
  resolveOrcaCli,
  writeJsonState,
} from "./orca-context.mjs";

const CHIEF_VIEW_KEY = "__chief__";

const LIB = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(LIB, "../../..");
const ORK = path.join(REPO_ROOT, "plugins/orchestrate/bin/ork.mjs");
const ROOM_STORE = path.join(REPO_ROOT, "plugins/orchestrate/bin/room-store.mjs");
const MONITOR = path.join(REPO_ROOT, "plugins/monitor/bin/monitor.mjs");

export const QUOTA_ITEM = "orkest-quota";
export const PANEL_ID = "orkest-swarm";
export const PANEL_STATUS_SCHEMA = "orkest.orca-panel-status.v1";
/** The only actions the panel may request; anything else is refused. */
export const PANEL_ACTIONS = Object.freeze(["toggle", "open", "close", "chief"]);
const AGENT_STATES = Object.freeze(["working", "blocked", "waiting", "done"]);
const PANEL_MAX_ROOMS = 20;
const PANEL_MAX_WORKERS = 40;
const PANEL_POST_DELAY_MS = 500;
export const QUOTA_INTERVAL_MS = 60_000;
const REGISTRY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const REGISTRY_MAX_ENTRIES = 512;

/** POSIX single-quoting for the command Orca types into the view terminal's shell. */
export function shellQuote(value) {
  return `'${String(value).replaceAll("'", String.raw`'\''`)}'`;
}

export function swarmViewCommand(room, statePath, { ork = ORK, chief = false } = {}) {
  const envArgs = [shellQuote(`ORKEST_ORCA_VIEW_STATE=${statePath}`)];
  if (chief) envArgs.push("ORKEST_CHIEF_VIEW=1");
  const roomId = typeof room === "string" ? room.trim() : "";
  const hordeArgs = roomId ? ["--attach-room", shellQuote(roomId), "--view"] : ["--view"];
  if (chief) hordeArgs.push("--chief");
  return ["exec", "env", ...envArgs, "node", shellQuote(ork), "horde", ...hordeArgs].join(" ");
}

function isClosedRoom(room) {
  const lifecycle = typeof room?.lifecycle === "string" ? room.lifecycle.toLowerCase() : "";
  const status = typeof room?.status === "string" ? room.status.toLowerCase() : "";
  return (
    Boolean(room?.closedAt || room?.archivedAt || room?.cancelledAt) ||
    ["archived", "cancelled"].includes(lifecycle) ||
    ["archived", "cancelled", "closed", "completed"].includes(status)
  );
}

/** Status bar text, tone and tooltip for a `monitor.snapshot.v1` document (Monitor's own summary). */
export function summarizeQuota(snapshot, options) {
  return summarizeMonitorQuota(snapshot, options);
}

function splitHandle(stdout) {
  try {
    return orcaTerminalHandle(JSON.parse(stdout)?.result?.split?.handle);
  } catch {
    return "";
  }
}

function terminalIds(list) {
  return new Set(
    (Array.isArray(list) ? list : [])
      .map((terminal) => orcaTerminalHandle(terminal?.id))
      .filter(Boolean),
  );
}

function roomStamp(room) {
  const value = Date.parse(room?.updatedAt || room?.createdAt || "");
  return Number.isFinite(value) ? value : 0;
}

/** Rooms tied to the context's workspace, best tie first (coordinator terminal, session, workspace). */
export function eligibleRooms(rooms, context, registry = {}) {
  if (!context?.workspaceId || !Array.isArray(rooms)) return [];
  const terminals = terminalIds(context.terminals);
  const sessions = new Set(
    Object.values(registry)
      .filter((entry) => entry?.workspaceId === context.workspaceId && entry.sessionId)
      .map((entry) => entry.sessionId),
  );
  const scored = [];
  for (const room of rooms) {
    if (!room || typeof room.id !== "string" || isClosedRoom(room)) continue;
    const coordinator = room.orcaCoordinatorTerminalId || room.conductor?.orcaTerminalHandle;
    let score = 0;
    if (coordinator && terminals.has(coordinator)) score = 3;
    else if (room.conductor?.session?.id && sessions.has(room.conductor.session.id)) score = 2;
    else if (room.orcaWorkspaceId && room.orcaWorkspaceId === context.workspaceId) score = 1;
    if (score) scored.push({ room, score });
  }
  return scored
    .toSorted(
      (left, right) => right.score - left.score || roomStamp(right.room) - roomStamp(left.room),
    )
    .map(({ room }) => room);
}

/** The room whose coordinator runs in this Orca workspace, scored by how directly it is tied. */
export function matchRoom(rooms, context, registry = {}) {
  return eligibleRooms(rooms, context, registry)[0] ?? null;
}

/** A panel request's input, or null unless it is exactly an enumerated action and an optional room. */
export function parsePanelAction(input) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => key !== "action" && key !== "room") ||
    !PANEL_ACTIONS.includes(input.action)
  )
    return null;
  if (input.room !== undefined && (typeof input.room !== "string" || input.room.length > 256)) {
    return null;
  }
  return { action: input.action, room: input.room?.trim() || "" };
}

function panelError(code, message) {
  return Object.assign(new Error(message), { code });
}

function text(value, max = 120) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function run(
  exec,
  command,
  args,
  { env: spawnEnv, timeout = 15_000, maxBuffer = 8 * 1024 * 1024 } = {},
) {
  return new Promise((resolve, reject) => {
    exec(
      command,
      args,
      { env: spawnEnv, timeout, maxBuffer },
      (error, stdout = "", stderr = "") => {
        if (error) {
          error.stderr = String(stderr || "");
          reject(error);
        } else resolve(String(stdout));
      },
    );
  });
}

/** The Orca worker state machine; `activate` wires it to the real host. */
export function createOrcaWorker(
  orca,
  {
    env = process.env,
    exec = execFile,
    platform = process.platform,
    now = Date.now,
    quotaIntervalMs = QUOTA_INTERVAL_MS,
    setInterval: startTimer = setInterval,
    clearInterval: stopTimer = clearInterval,
    setTimeout: startTimeout = setTimeout,
    clearTimeout: stopTimeout = clearTimeout,
    cli = resolveOrcaCli(env, { platform }),
    node = findExecutable("node", env),
    listRooms,
  } = {},
) {
  // Orca hands workers a reduced PATH: children get a derived one, process.env stays untouched.
  const spawnEnv = enrichedEnv(env);
  const disposables = [];
  let queue = Promise.resolve();
  let context = null;
  let isReady = false;
  let isStopped = false;
  let quotaTimer = null;
  let quotaPending = null;
  let lastQuota = null;
  let lifecycle = 0;
  // Bumped when the workspace or a view's lifecycle changes: in-flight rooms reads then count as stale.
  let generation = 0;
  const roomReads = new Map();
  let pendingOpens = 0;
  let closeEpoch = 0;
  let panelTimer = null;
  let lastPanelPost = "";
  let isSplitUnsupported = false;
  let registry = { schema: ORCA_TERMINALS_SCHEMA, terminals: {} };

  const log = (message) => {
    try {
      orca.log?.(String(message));
    } catch {
      // Logging must never break the worker.
    }
  };
  const call = (method, params) => orca.host.call(method, params);
  const has = (method) => typeof orca.host.has !== "function" || orca.host.has(method);
  const invalidate = () => {
    generation += 1;
    roomReads.clear();
  };

  /** Serialize every state change, so events, commands and restore never interleave. */
  function serial(operation) {
    const previous = queue;
    const next = (async () => {
      await previous;
      return isStopped ? undefined : operation();
    })();
    queue = (async () => {
      try {
        await next;
      } catch (error) {
        log(`orkest: ${error?.message || error}`);
      }
    })();
    return next;
  }

  function setContext(next) {
    if ((next?.workspaceId ?? null) !== (context?.workspaceId ?? null)) invalidate();
    context = next;
  }

  async function readContext() {
    try {
      setContext((await call("workspace.readContext", {})) ?? null);
    } catch (error) {
      log(`orkest: workspace.readContext failed: ${error.message}`);
    }
    return context;
  }

  async function liveTerminals(workspaceId, { isStrict = false } = {}) {
    try {
      if (!has("terminal.list")) throw new Error("terminal.list is not available in this Orca");
      const { terminals } = await call("terminal.list", { workspaceId });
      return terminalIds(terminals);
    } catch {
      if (isStrict) return null;
      return context?.workspaceId === workspaceId ? terminalIds(context.terminals) : null;
    }
  }

  async function saveRegistry() {
    const cutoff = now() - REGISTRY_MAX_AGE_MS;
    const entries = Object.entries(registry.terminals)
      .filter(([, entry]) => (entry?.updatedAt ?? 0) >= cutoff)
      .toSorted(([, left], [, right]) => right.updatedAt - left.updatedAt)
      .slice(0, REGISTRY_MAX_ENTRIES);
    registry = {
      schema: ORCA_TERMINALS_SCHEMA,
      updatedAt: new Date(now()).toISOString(),
      terminals: Object.fromEntries(entries),
    };
    await writeJsonState(orcaTerminalsPath(env), registry);
  }

  function recordTerminal(terminalId, fields) {
    const id = orcaTerminalHandle(terminalId);
    if (!id) return false;
    const previous = registry.terminals[id] || { terminalId: id };
    const next = { ...previous };
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined && value !== null && value !== "") next[key] = value;
    }
    next.updatedAt = now();
    registry.terminals[id] = next;
    return true;
  }

  async function syncAgents(workspaceId) {
    if (!workspaceId || !has("agents.list")) return;
    try {
      const { agents = [] } = await call("agents.list", { workspaceId });
      for (const agent of agents) {
        recordTerminal(agent?.terminalId, {
          workspaceId,
          title: agent.title || undefined,
          agent: agent.agent || undefined,
          state: agent.state,
          sessionId: agent.sessionId || undefined,
        });
      }
    } catch (error) {
      log(`orkest: agents.list failed: ${error.message}`);
    }
  }

  async function syncContext(next) {
    if (isStopped) return;
    setContext(next ?? null);
    const workspaceId = context?.workspaceId;
    if (!workspaceId) return;
    const terminals = context.terminals || [];
    for (const terminal of terminals) {
      recordTerminal(terminal?.id, { workspaceId, title: terminal.title || undefined });
    }
    await syncAgents(workspaceId);
    if (isStopped) return;
    await saveRegistry();
    if (isStopped) return;
    if (isReady) await reconcileViews(workspaceId, terminalIds(context.terminals));
  }

  async function onAgentStatus(event) {
    const recorded = recordTerminal(event?.terminalId, {
      paneKey: event.paneKey,
      workspaceId: event.workspaceId || undefined,
      title: event.title,
      state: event.state,
      sessionId: event.sessionId,
    });
    if (recorded) await saveRegistry();
    const workspaceId = event?.workspaceId || context?.workspaceId;
    if (isReady && workspaceId) await closeAutoDismissedViews(workspaceId);
  }

  async function viewRecords() {
    let names;
    try {
      names = await readdir(orcaViewsDirectory(env));
    } catch {
      return [];
    }
    const records = [];
    const files = names
      .filter((file) => file.endsWith(".json"))
      .toSorted((left, right) => left.localeCompare(right));
    for (const name of files) {
      const file = path.join(orcaViewsDirectory(env), name);
      const record = await readJsonState(file);
      if (
        record?.schema === ORCA_VIEW_SCHEMA &&
        (typeof record.room === "string" || record.chief)
      ) {
        records.push({ file, record });
      }
    }
    return records;
  }

  async function closeAutoDismissedViews(workspaceId, { records, live } = {}) {
    if (!workspaceId || isStopped) return;
    const allRecords = records ?? (await viewRecords());
    const pending = allRecords.filter(
      ({ record }) =>
        record.closed &&
        record.autoDismissed &&
        !record.terminalClosed &&
        record.workspaceId === workspaceId &&
        record.terminalId,
    );
    if (pending.length === 0) return;
    const terminals = live ?? (await liveTerminals(workspaceId, { isStrict: true }));
    if (!terminals || isStopped) return;
    for (const { file, record } of pending) {
      if (isStopped) return;
      if (!terminals.has(record.terminalId)) {
        await writeJsonState(file, { ...record, terminalClosed: true });
        continue;
      }
      if (await closeTerminal(record.terminalId)) {
        await writeJsonState(file, { ...record, terminalClosed: true });
      }
    }
  }

  /** A view terminal that vanished while Orca was running was closed by the person. */
  async function reconcileViews(workspaceId, focused) {
    const records = await viewRecords();
    const missing = records.filter(
      ({ record }) =>
        !record.closed &&
        record.workspaceId === workspaceId &&
        record.terminalId &&
        !focused.has(record.terminalId),
    );
    const hasPendingDismiss = records.some(
      ({ record }) =>
        record.closed &&
        record.autoDismissed &&
        !record.terminalClosed &&
        record.workspaceId === workspaceId &&
        record.terminalId,
    );
    if (missing.length === 0 && !hasPendingDismiss) return;
    // Confirm with the full terminal list: the focused context may omit background terminals.
    const live = await liveTerminals(workspaceId, { isStrict: true });
    if (!live || isStopped) return;
    for (const { file, record } of missing) {
      if (live.has(record.terminalId)) continue;
      await writeJsonState(file, {
        ...record,
        closed: true,
        closedAt: new Date(now()).toISOString(),
      });
    }
    await closeAutoDismissedViews(workspaceId, { records, live });
  }

  async function readRooms() {
    if (listRooms) return listRooms();
    if (!node) throw new Error("node is not on PATH for the Orca plugin worker");
    const stdout = await run(
      exec,
      node,
      [ROOM_STORE, "list", "--root", path.join(orcaCacheHome(env), "mailbox-v1")],
      { env: spawnEnv, timeout: 15_000 },
    );
    const parsed = JSON.parse(stdout);
    // Only a real array is an authoritative list; anything else is a failed lookup, never "no rooms".
    if (!Array.isArray(parsed)) throw new Error("room-store list did not return an array");
    return parsed;
  }

  /**
   * Rooms for a workspace, one read at a time per workspace. A read that finishes after the workspace
   * or a view's lifecycle changed is discarded and repeated; the promise leaves the map in `finally`.
   */
  async function readRoomsOnce(workspaceId, entry) {
    try {
      return await readRooms();
    } finally {
      if (roomReads.get(workspaceId) === entry) roomReads.delete(workspaceId);
    }
  }

  async function rooms(workspaceId = context?.workspaceId ?? "") {
    for (let attempt = 0; ; attempt++) {
      const mine = generation;
      let read = roomReads.get(workspaceId);
      if (!read || read.generation !== mine) {
        const entry = { generation: mine };
        roomReads.set(workspaceId, entry);
        entry.promise = readRoomsOnce(workspaceId, entry);
        read = entry;
      }
      const isLast = attempt >= 2;
      try {
        const result = await read.promise;
        if (mine === generation || isLast) return result;
      } catch (error) {
        if (mine === generation || isLast) throw error;
      }
    }
  }

  async function splitView(source, command, title) {
    if (source && !isSplitUnsupported && has("terminal.split")) {
      try {
        const result = await call("terminal.split", {
          terminalId: source,
          direction: "vertical",
          command,
        });
        const id = orcaTerminalHandle(result?.terminalId);
        if (id) return { terminalId: id, method: "host-split" };
      } catch (error) {
        if (error?.code !== "invalid_params" && error?.code !== "unknown_method") throw error;
        isSplitUnsupported = true;
      }
    }
    if (source && cli) {
      let stdout;
      try {
        stdout = await run(
          exec,
          cli,
          [
            "terminal",
            "split",
            "--terminal",
            source,
            "--direction",
            "vertical",
            "--command",
            command,
            "--json",
          ],
          { env: spawnEnv, timeout: 20_000 },
        );
      } catch (error) {
        // A timed-out split may still open: never start a second copy beside it.
        if (error?.killed || error?.signal) {
          return { error: "Orca did not confirm the split; check the workspace before retrying." };
        }
        log(`orkest: terminal split failed: ${error.stderr || error.message}`);
      }
      if (stdout !== undefined) {
        const handle = splitHandle(stdout);
        if (handle) {
          try {
            await run(
              exec,
              cli,
              ["terminal", "rename", "--terminal", handle, "--title", title, "--json"],
              { env: spawnEnv, timeout: 10_000 },
            );
          } catch {
            // The title only helps people find the pane.
          }
          return { terminalId: handle, method: "cli-split" };
        }
        return { error: "Orca split the pane without naming its terminal." };
      }
    }
    return null;
  }

  /** Open a view; a close requested while this runs wins (see `requestClose`). */
  async function openView(args) {
    const epoch = closeEpoch;
    pendingOpens += 1;
    try {
      return await openViewNow(args, epoch);
    } finally {
      pendingOpens -= 1;
      invalidate();
    }
  }

  /** Note a close request the moment it is made, before it waits its turn behind a pending open. */
  function requestClose() {
    if (pendingOpens === 0) return false;
    closeEpoch += 1;
    return true;
  }

  /**
   * Run a swarm action in turn. A close or toggle made while an open is pending cancels that open
   * at once; the toggle is then spent, so it does not reopen what it just cancelled.
   */
  async function control(action, options) {
    const isCancelling = action !== "open" && requestClose();
    const outcome = await serial(() =>
      isCancelling && action === "toggle"
        ? { status: "closed", ...(options?.room && { room: options.room }) }
        : swarm(action, options),
    );
    schedulePanelPost();
    return outcome ?? { status: "stopped" };
  }

  async function openViewNow({ room, workspaceId, source, chief = false }, epoch) {
    const roomId = typeof room === "string" ? room.trim() : "";
    const isChief = Boolean(chief);
    const statePath = orcaViewPath(roomId || CHIEF_VIEW_KEY, env);
    const title = roomId ? orcaViewTitle(roomId) : `${ORCA_VIEW_TITLE_PREFIX} · Chief`;
    const command = swarmViewCommand(roomId, statePath, { chief: isChief });
    let created = await splitView(source, command, title);
    if (created?.error) return { status: "error", room: roomId, reason: created.error };
    if (!created) {
      // Fallback: a new terminal tab in the workspace, when no split is available.
      if (!has("terminal.create")) {
        return {
          status: "error",
          room: roomId,
          reason: "This Orca cannot open a terminal for the Swarm View; update Orca.",
        };
      }
      const result = await call("terminal.create", { workspaceId, title, command });
      const terminalId = orcaTerminalHandle(result?.terminalId);
      if (!terminalId)
        return { status: "error", room: roomId, reason: "Orca did not return a terminal" };
      created = { terminalId, method: "create" };
    }
    const record = {
      schema: ORCA_VIEW_SCHEMA,
      room: roomId,
      workspaceId,
      terminalId: created.terminalId,
      sourceTerminalId: source || null,
      title,
      method: created.method,
      chief: isChief,
      openedAt: new Date(now()).toISOString(),
      closed: false,
    };
    if (closeEpoch !== epoch && !isStopped) {
      // The person closed the view while Orca was still opening it: the close wins.
      const isClosed = await closeTerminal(created.terminalId);
      await writeJsonState(
        statePath,
        isClosed ? { ...record, closed: true, closedAt: new Date(now()).toISOString() } : record,
      );
      if (!isClosed) {
        return { status: "error", room: roomId, reason: "Orca refused to close the Swarm View" };
      }
      return {
        status: "closed",
        room: roomId,
        terminal: created.terminalId,
        ...(isChief && { chief: true }),
      };
    }
    await writeJsonState(statePath, record);
    return {
      status: "opened",
      room: roomId,
      terminal: created.terminalId,
      method: created.method,
      ...(isChief && { chief: true }),
    };
  }

  function sourceTerminal(room, focused) {
    const terminals = terminalIds(focused?.terminals);
    const coordinator = orcaTerminalHandle(
      room?.orcaCoordinatorTerminalId || room?.conductor?.orcaTerminalHandle,
    );
    if (coordinator && terminals.has(coordinator)) return coordinator;
    const session = room?.conductor?.session?.id;
    const bySession = Object.values(registry.terminals).find(
      (entry) => session && entry.sessionId === session && terminals.has(entry.terminalId),
    );
    if (bySession) return bySession.terminalId;
    return [...terminals][0] || "";
  }

  async function closeTerminal(terminalId) {
    try {
      if (!has("terminal.close")) throw new Error("terminal.close is not available in this Orca");
      await call("terminal.close", { terminalId });
      return true;
    } catch (error) {
      if (cli) {
        try {
          await run(exec, cli, ["terminal", "close", "--terminal", terminalId, "--json"], {
            env: spawnEnv,
            timeout: 10_000,
          });
          return true;
        } catch {
          // Fall through to the liveness check.
        }
      }
      log(`orkest: terminal.close failed: ${error.message}`);
      return false;
    }
  }

  async function swarm(action, { chief = false, room: selectedRoom = "" } = {}) {
    const focused = await readContext();
    const workspaceId = focused?.workspaceId;
    if (!workspaceId) return { status: "unavailable", reason: "Focus an Orca workspace first." };
    let room = null;
    try {
      const eligible = eligibleRooms(await rooms(workspaceId), focused, registry.terminals);
      if (selectedRoom) {
        room = eligible.find((candidate) => candidate.id === selectedRoom) ?? null;
        if (!room) {
          return {
            status: "unavailable",
            reason: "That room is not bound to the focused workspace.",
          };
        }
      } else room = eligible[0] ?? null;
    } catch (error) {
      log(`orkest: listing rooms failed: ${error.message}`);
      if (selectedRoom) return { status: "unavailable", reason: "Orkest could not list rooms." };
    }
    const records = await viewRecords();
    const owned = room
      ? records.find(({ record }) => record.room === room.id)
      : records.find(
          ({ record }) =>
            !record.closed &&
            record.workspaceId === workspaceId &&
            (!chief || Boolean(record.chief)),
        );
    const isChief = Boolean(chief || owned?.record?.chief);
    const live = owned?.record.terminalId ? await liveTerminals(owned.record.workspaceId) : null;
    const isOpen = Boolean(owned && !owned.record.closed && live?.has(owned.record.terminalId));
    const roomId = room?.id || owned?.record.room || "";
    if (action === "close" || (action === "toggle" && isOpen)) {
      if (!isOpen) {
        if (owned && !owned.record.closed) {
          await writeJsonState(owned.file, { ...owned.record, closed: true });
        }
        return {
          status: "already_closed",
          ...(roomId && { room: roomId }),
          ...(isChief && { chief: true }),
        };
      }
      const closed = await closeTerminal(owned.record.terminalId);
      const after = closed ? null : await liveTerminals(owned.record.workspaceId);
      if (!closed && after?.has(owned.record.terminalId)) {
        return { status: "error", room: roomId, reason: "Orca refused to close the Swarm View" };
      }
      await writeJsonState(owned.file, {
        ...owned.record,
        closed: true,
        closedAt: new Date(now()).toISOString(),
      });
      return {
        status: "closed",
        room: roomId,
        terminal: owned.record.terminalId,
        ...(isChief && { chief: true }),
      };
    }
    if (isOpen) {
      return {
        status: "already_open",
        room: roomId,
        terminal: owned.record.terminalId,
        ...(isChief && { chief: true }),
      };
    }
    if (!room && !isChief) {
      return {
        status: "unavailable",
        reason:
          "No Orkest swarm is bound to this workspace. Run `ork swarm open` from the coordinator.",
      };
    }
    const source = room
      ? sourceTerminal(room, focused)
      : [...terminalIds(focused?.terminals)][0] || "";
    return openView({
      room: room?.id || "",
      workspaceId,
      source,
      chief: isChief,
    });
  }

  /**
   * Whether a persisted room view may be reopened: the room must be listed, not archived, and tied to
   * the record's workspace. A failed lookup is temporary and leaves the record for the next start;
   * only a successful lookup that shows the room archived or gone closes the record for good.
   */
  async function restorable(record, room, live) {
    let list;
    try {
      list = await rooms(record.workspaceId);
    } catch (error) {
      log(`orkest: listing rooms to restore ${room} failed: ${error.message}`);
      return { status: "room_lookup_failed" };
    }
    if (isStopped) return { status: "stopped" };
    const found = list.find((candidate) => candidate?.id === room);
    if (!found || isClosedRoom(found)) {
      return { status: found ? "room_archived" : "room_missing", isFinal: true };
    }
    const tied = matchRoom(
      [found],
      { workspaceId: record.workspaceId, terminals: [...live].map((id) => ({ id })) },
      registry.terminals,
    );
    return { status: tied ? "eligible" : "workspace_mismatch" };
  }

  /** Cold restart: reopen views that were open when Orca stopped and whose terminal is gone. */
  async function restore() {
    const outcomes = [];
    const records = await viewRecords();
    for (const { file, record } of records) {
      if (isStopped) return outcomes;
      const room = typeof record.room === "string" ? record.room.trim() : "";
      const isChief = Boolean(record.chief);
      if (record.closed || !record.workspaceId || (!room && !isChief)) continue;
      const tag = isChief ? { chief: true } : {};
      const live = await liveTerminals(record.workspaceId);
      if (isStopped) return outcomes;
      if (!live) {
        outcomes.push({ room, status: "inspection_failed", ...tag });
        continue;
      }
      if (record.terminalId && live.has(record.terminalId)) {
        outcomes.push({ room, status: "already_present", ...tag });
        continue;
      }
      if (room) {
        const verdict = await restorable(record, room, live);
        if (isStopped) return outcomes;
        if (verdict.status !== "eligible") {
          if (verdict.isFinal) {
            await writeJsonState(file, {
              ...record,
              closed: true,
              closedAt: new Date(now()).toISOString(),
              closedReason: verdict.status,
            });
          }
          outcomes.push({ room, status: verdict.status, ...tag });
          continue;
        }
      }
      const source =
        record.sourceTerminalId && live.has(record.sourceTerminalId) ? record.sourceTerminalId : "";
      try {
        const outcome = await openView({
          room,
          workspaceId: record.workspaceId,
          source,
          chief: isChief,
        });
        outcomes.push({
          room,
          status: outcome.status === "opened" ? "restored" : outcome.status,
          ...tag,
        });
      } catch (error) {
        log(`orkest: restoring ${room || "chief"} failed: ${error.message}`);
        outcomes.push({ room, status: "restore_failed", ...tag });
      }
    }
    return outcomes;
  }

  async function setQuotaItem(summary) {
    if (!has("statusBar.update")) return;
    await call("statusBar.update", { id: QUOTA_ITEM, ...summary, visible: true });
  }

  async function updateQuota(epoch) {
    if (!node) throw new Error("node is not on PATH for the Orca plugin worker");
    const stdout = await run(exec, node, [MONITOR, "json"], { env: spawnEnv, timeout: 45_000 });
    const summary = summarizeQuota(JSON.parse(stdout));
    // A worker that stopped or restarted meanwhile owns the status bar item now.
    if (isStopped || epoch !== lifecycle) return summary;
    lastQuota = { summary, at: now() };
    await setQuotaItem(summary);
    schedulePanelPost();
    return summary;
  }

  /** A failed refresh keeps the last good figures, marked stale and never as current exhaustion. */
  function staleQuota(error) {
    const reason = `monitor json failed: ${String(error.stderr || error.message).slice(0, 200)}`;
    if (!lastQuota) return { text: "Quota ?", tone: "warning", tooltip: reason };
    const { summary, at } = lastQuota;
    return {
      text: `${summary.text} · stale`,
      tone: "warning",
      tooltip: `${reason}\nLast good values from ${new Date(at).toISOString()}:\n${summary.tooltip}`,
    };
  }

  async function refreshQuotaOnce() {
    const epoch = lifecycle;
    try {
      return await updateQuota(epoch);
    } catch (error) {
      log(`orkest: quota refresh failed: ${error.message}`);
      const failed = staleQuota(error);
      if (!isStopped && epoch === lifecycle) {
        try {
          await setQuotaItem(failed);
        } catch {
          // The status bar is desktop-only; nothing else to report to.
        }
      }
      return failed;
    }
  }

  async function trackQuotaRefresh() {
    try {
      return await refreshQuotaOnce();
    } finally {
      quotaPending = null;
    }
  }

  /** One `monitor json` run at a time; a timer tick during a slow run joins it. */
  function refreshQuota() {
    if (isStopped) return Promise.resolve(null);
    quotaPending ??= trackQuotaRefresh();
    return quotaPending;
  }

  /** What the sidebar panel shows: the focused workspace's rooms and workers, and the quota item. */
  async function panelStatus(focused) {
    const workspaceId = focused?.workspaceId || "";
    const base = {
      schema: PANEL_STATUS_SCHEMA,
      workspaceId,
      workspaceName: text(focused?.displayName),
      rooms: [],
      workers: [],
      view: { open: false, chief: false, room: "" },
      quota: lastQuota ? { text: lastQuota.summary.text, tone: lastQuota.summary.tone } : null,
    };
    if (!workspaceId) return base;
    let eligible = [];
    try {
      eligible = eligibleRooms(await rooms(workspaceId), focused, registry.terminals);
    } catch (error) {
      log(`orkest: panel rooms failed: ${error.message}`);
      base.error = "Orkest could not list rooms.";
    }
    const live = await liveTerminals(workspaceId);
    const records = (await viewRecords()).filter(
      ({ record }) => record.workspaceId === workspaceId && !record.closed,
    );
    const isOpen = ({ record }) => Boolean(live?.has(record.terminalId));
    const openRoom = new Set(records.filter(isOpen).map(({ record }) => record.room));
    base.rooms = eligible.slice(0, PANEL_MAX_ROOMS).map((room, index) => ({
      id: room.id,
      label: text(room.title || room.name || room.goal) || room.id,
      status: text(room.status || room.lifecycle, 32) || "active",
      selected: index === 0,
      open: openRoom.has(room.id),
    }));
    const open = records.find(isOpen)?.record;
    base.view = { open: Boolean(open), chief: Boolean(open?.chief), room: open?.room || "" };
    base.workers = Object.values(registry.terminals)
      .filter((entry) => entry?.workspaceId === workspaceId)
      // A stable order: sorting by recency would reshuffle the list on every status event.
      .toSorted((left, right) => String(left.terminalId).localeCompare(String(right.terminalId)))
      .slice(0, PANEL_MAX_WORKERS)
      .map((entry) => ({
        terminalId: entry.terminalId,
        title: text(entry.title) || entry.terminalId,
        agent: text(entry.agent, 32),
        state: AGENT_STATES.includes(entry.state) ? entry.state : "unknown",
      }));
    return base;
  }

  async function postPanelStatus() {
    panelTimer = null;
    if (isStopped || typeof orca.panels?.post !== "function") return;
    try {
      const payload = await panelStatus(context);
      const serialized = JSON.stringify(payload);
      if (serialized === lastPanelPost || isStopped) return;
      lastPanelPost = serialized;
      await orca.panels.post("status.changed", payload);
    } catch (error) {
      log(`orkest: panel post failed: ${error.message}`);
    }
  }

  /** Coalesce bursts of events into one post: the host allows 200 posts per 10 seconds. */
  function schedulePanelPost() {
    if (isStopped || panelTimer || typeof orca.panels?.post !== "function") return;
    panelTimer = startTimeout(() => void postPanelStatus(), PANEL_POST_DELAY_MS);
    panelTimer?.unref?.();
  }

  function registerPanelHandlers() {
    if (typeof orca.panels?.handle !== "function") return;
    orca.panels.handle("swarm.status", async (input) => {
      if (
        input !== undefined &&
        input !== null &&
        (typeof input !== "object" || Array.isArray(input))
      ) {
        throw panelError("invalid_params", "swarm.status takes no input");
      }
      return panelStatus(await readContext());
    });
    orca.panels.handle("swarm.action", async (input) => {
      const request = parsePanelAction(input);
      if (!request) {
        throw panelError("invalid_params", `action must be one of ${PANEL_ACTIONS.join(", ")}`);
      }
      const isChief = request.action === "chief";
      const action = isChief ? "open" : request.action;
      const outcome = await control(action, {
        ...(isChief && { chief: true }),
        ...(request.room && { room: request.room }),
      });
      return {
        status: outcome.status,
        message: describe(outcome),
        ...(outcome.room && { room: outcome.room }),
      };
    });
  }

  function describe(outcome) {
    const room = outcome.room ? ` (room ${outcome.room})` : "";
    switch (outcome.status) {
      case "opened": {
        return `Swarm View opened${room}.`;
      }
      case "closed": {
        return `Swarm View closed${room}.`;
      }
      case "already_open": {
        return `Swarm View is already open${room}.`;
      }
      case "already_closed": {
        return `Swarm View is already closed${room}.`;
      }
      default: {
        return outcome.reason || `Swarm View ${outcome.status}${room}.`;
      }
    }
  }

  async function start() {
    lifecycle += 1;
    invalidate();
    registry = await readOrcaTerminals(env);
    if (isStopped) return [];
    const swarmCommand = (action, defaults) => async (args) => {
      const given = args && typeof args === "object" && !Array.isArray(args) ? args : {};
      return describe(await control(action, { ...given, ...defaults }));
    };
    orca.commands.register("orkest.swarm.toggle", swarmCommand("toggle"));
    orca.commands.register("orkest.swarm.open", swarmCommand("open"));
    orca.commands.register("orkest.swarm.close", swarmCommand("close"));
    orca.commands.register("orkest.chief.open", swarmCommand("open", { chief: true }));
    registerPanelHandlers();
    orca.commands.register("orkest.quota.refresh", async () => {
      const summary = await refreshQuota();
      return summary ? `Quota: ${summary.text}` : "Quota refresh skipped.";
    });
    disposables.push(
      orca.events.on("workspace.changed", async (event) => {
        await serial(() => syncContext(event?.context));
        schedulePanelPost();
      }),
      orca.events.on("agent.status.changed", async (event) => {
        await serial(() => onAgentStatus(event));
        schedulePanelPost();
      }),
    );
    void refreshQuota();
    quotaTimer = startTimer(() => void refreshQuota(), quotaIntervalMs);
    quotaTimer?.unref?.();
    return serial(async () => {
      if (isStopped) return [];
      const initialContext = await readContext();
      if (isStopped) return [];
      await syncContext(initialContext);
      if (isStopped) return [];
      const outcomes = await restore();
      if (isStopped) return [];
      isReady = true;
      invalidate();
      await closeAutoDismissedViews(context?.workspaceId);
      if (outcomes.length > 0) log(`orkest: restore ${JSON.stringify(outcomes)}`);
      return outcomes;
    });
  }

  async function stop() {
    isStopped = true;
    lifecycle += 1;
    invalidate();
    if (quotaTimer) stopTimer(quotaTimer);
    quotaTimer = null;
    if (panelTimer) stopTimeout(panelTimer);
    panelTimer = null;
    for (const disposable of disposables.splice(0)) {
      try {
        disposable?.dispose?.();
      } catch {
        // Already disposed.
      }
    }
    // Neither promise rejects: serial() and refreshQuotaOnce() report their own errors.
    await queue;
    await quotaPending;
  }

  return {
    start,
    stop,
    swarm: (action, options) => control(action, options),
    panelStatus: async () => panelStatus(await readContext()),
    restore: () => serial(restore),
    refreshQuota,
    get registry() {
      return registry;
    },
    get isReady() {
      return isReady;
    },
  };
}

const active = { worker: null };

/** Orca calls the default export once when the worker starts. */
export default async function activate(orca) {
  await active.worker?.stop();
  active.worker = createOrcaWorker(orca);
  await active.worker.start();
}

export async function deactivate() {
  const { worker } = active;
  active.worker = null;
  await worker?.stop();
}

export { activate };
