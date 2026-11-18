// Orca IDE plugin worker (orca-plugin.json `main`): toggles the Orkest Swarm View in a split beside
// the coordinator, records which Orca terminal each agent runs in, restores open views after a cold
// restart, and keeps a quota item in the status bar from `monitor json`.
//
// Orca starts this module out of process with a stripped environment (PATH, HOME, locale and a few
// session variables), so every path is derived from this file's location and HOME.

import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
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

function lowestRemaining(account) {
  const values = (account.windows || [])
    .map((window) => window?.remainingPct)
    .filter((value) => typeof value === "number" && Number.isFinite(value));
  return values.length > 0 ? Math.min(...values) : null;
}

/** Status bar text, tone and tooltip for a `monitor.snapshot.v1` document. */
export function summarizeQuota(snapshot) {
  const accounts = Array.isArray(snapshot?.accounts) ? snapshot.accounts : [];
  const rows = [];
  const tooltip = [];
  let lowest = null;
  for (const account of accounts) {
    const name = String(account?.short || account?.label || account?.id || "?").slice(0, 16);
    if (account?.ok === false) {
      tooltip.push(
        `${account.label || name}: ${String(account.error || "unavailable").slice(0, 120)}`,
      );
      continue;
    }
    const remaining = lowestRemaining(account);
    if (remaining === null) continue;
    lowest = lowest === null ? remaining : Math.min(lowest, remaining);
    rows.push({ name, remaining });
    const windows = (account.windows || [])
      .filter((window) => typeof window?.remainingPct === "number")
      .map((window) => `${window.label || window.id} ${Math.round(window.remainingPct)}%`)
      .join(" · ");
    tooltip.push(`${account.label || name}: ${windows}`);
  }
  if (rows.length === 0) {
    return {
      text: "Quota —",
      tone: tooltip.length > 0 ? "warning" : "neutral",
      tooltip: tooltip.join("\n") || "No quota accounts reported by monitor",
    };
  }
  rows.sort((left, right) => left.remaining - right.remaining);
  const shown = rows.slice(0, 4).map(({ name, remaining }) => `${name} ${Math.round(remaining)}%`);
  if (rows.length > 4) shown.push(`+${rows.length - 4}`);
  let tone = "neutral";
  if (lowest < 10) tone = "danger";
  else if (lowest < 25) tone = "warning";
  if (snapshot.generatedAt) tooltip.push(`Updated ${snapshot.generatedAt}`);
  return { text: shown.join(" · "), tone, tooltip: tooltip.join("\n") };
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

/** The room whose coordinator runs in this Orca workspace, scored by how directly it is tied. */
export function matchRoom(rooms, context, registry = {}) {
  if (!context?.workspaceId || !Array.isArray(rooms)) return null;
  const terminals = terminalIds(context.terminals);
  const sessions = new Set(
    Object.values(registry)
      .filter((entry) => entry?.workspaceId === context.workspaceId && entry.sessionId)
      .map((entry) => entry.sessionId),
  );
  let best = null;
  for (const room of rooms) {
    if (!room || typeof room.id !== "string" || isClosedRoom(room)) continue;
    const coordinator = room.orcaCoordinatorTerminalId || room.conductor?.orcaTerminalHandle;
    let score = 0;
    if (coordinator && terminals.has(coordinator)) score = 3;
    else if (room.conductor?.session?.id && sessions.has(room.conductor.session.id)) score = 2;
    else if (room.orcaWorkspaceId && room.orcaWorkspaceId === context.workspaceId) score = 1;
    if (!score) continue;
    if (
      !best ||
      score > best.score ||
      (score === best.score && roomStamp(room) > roomStamp(best.room))
    ) {
      best = { room, score };
    }
  }
  return best?.room ?? null;
}

function run(exec, command, args, { env, timeout = 15_000, maxBuffer = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    exec(command, args, { env, timeout, maxBuffer }, (error, stdout = "", stderr = "") => {
      if (error) {
        error.stderr = String(stderr || "");
        reject(error);
      } else resolve(String(stdout));
    });
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
    cli = resolveOrcaCli(env, { platform }),
    node = findExecutable("node", env),
    listRooms,
  } = {},
) {
  const disposables = [];
  let queue = Promise.resolve();
  let context = null;
  let isReady = false;
  let isStopped = false;
  let quotaTimer = null;
  let quotaPending = null;
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

  async function readContext() {
    try {
      context = (await call("workspace.readContext", {})) ?? null;
    } catch (error) {
      log(`orkest: workspace.readContext failed: ${error.message}`);
    }
    return context;
  }

  async function liveTerminals(workspaceId, { isStrict = false } = {}) {
    try {
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
    if (!workspaceId) return;
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
    context = next ?? null;
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
    if (isReady) await noticeClosedViews(workspaceId, terminalIds(context.terminals));
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

  /** A view terminal that vanished while Orca was running was closed by the person. */
  async function noticeClosedViews(workspaceId, focused) {
    const missing = (await viewRecords()).filter(
      ({ record }) =>
        !record.closed &&
        record.workspaceId === workspaceId &&
        record.terminalId &&
        !focused.has(record.terminalId),
    );
    if (missing.length === 0) return;
    // Confirm with the full terminal list: the focused context may omit background terminals.
    const live = await liveTerminals(workspaceId, { isStrict: true });
    if (!live) return;
    for (const { file, record } of missing) {
      if (live.has(record.terminalId)) continue;
      await writeJsonState(file, {
        ...record,
        closed: true,
        closedAt: new Date(now()).toISOString(),
      });
    }
  }

  async function rooms() {
    if (listRooms) return listRooms();
    if (!node) throw new Error("node is not on PATH for the Orca plugin worker");
    const stdout = await run(
      exec,
      node,
      [ROOM_STORE, "list", "--root", path.join(orcaCacheHome(env), "mailbox-v1")],
      { env, timeout: 15_000 },
    );
    const parsed = JSON.parse(stdout);
    return Array.isArray(parsed) ? parsed : [];
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
          { env, timeout: 20_000 },
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
              { env, timeout: 10_000 },
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

  async function openView({ room, workspaceId, source, chief = false }) {
    const roomId = typeof room === "string" ? room.trim() : "";
    const isChief = Boolean(chief);
    const statePath = orcaViewPath(roomId || CHIEF_VIEW_KEY, env);
    const title = roomId ? orcaViewTitle(roomId) : `${ORCA_VIEW_TITLE_PREFIX} · Chief`;
    const command = swarmViewCommand(roomId, statePath, { chief: isChief });
    let created = await splitView(source, command, title);
    if (created?.error) return { status: "error", room: roomId, reason: created.error };
    if (!created) {
      // Fallback: a new terminal tab in the workspace, when no split is available.
      const result = await call("terminal.create", { workspaceId, title, command });
      const terminalId = orcaTerminalHandle(result?.terminalId);
      if (!terminalId)
        return { status: "error", room: roomId, reason: "Orca did not return a terminal" };
      created = { terminalId, method: "create" };
    }
    await writeJsonState(statePath, {
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
    });
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
      await call("terminal.close", { terminalId });
      return true;
    } catch (error) {
      if (cli) {
        try {
          await run(exec, cli, ["terminal", "close", "--terminal", terminalId, "--json"], {
            env,
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

  async function swarm(action, { chief = false } = {}) {
    const focused = await readContext();
    const workspaceId = focused?.workspaceId;
    if (!workspaceId) return { status: "unavailable", reason: "Focus an Orca workspace first." };
    let room = null;
    try {
      room = matchRoom(await rooms(), focused, registry.terminals);
    } catch (error) {
      log(`orkest: listing rooms failed: ${error.message}`);
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

  /** Cold restart: reopen views that were open when Orca stopped and whose terminal is gone. */
  async function restore() {
    const outcomes = [];
    const records = await viewRecords();
    for (const { record } of records) {
      if (isStopped) return outcomes;
      const room = typeof record.room === "string" ? record.room.trim() : "";
      const isChief = Boolean(record.chief);
      if (record.closed || !record.workspaceId || (!room && !isChief)) continue;
      const live = await liveTerminals(record.workspaceId);
      if (isStopped) return outcomes;
      if (!live) {
        outcomes.push({ room, status: "inspection_failed", ...(isChief && { chief: true }) });
        continue;
      }
      if (record.terminalId && live.has(record.terminalId)) {
        outcomes.push({ room, status: "already_present", ...(isChief && { chief: true }) });
        continue;
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
          ...(isChief && { chief: true }),
        });
      } catch (error) {
        log(`orkest: restoring ${room || "chief"} failed: ${error.message}`);
        outcomes.push({ room, status: "restore_failed", ...(isChief && { chief: true }) });
      }
    }
    return outcomes;
  }

  async function updateQuota() {
    if (!node) throw new Error("node is not on PATH for the Orca plugin worker");
    const stdout = await run(exec, node, [MONITOR, "json"], { env, timeout: 45_000 });
    const summary = summarizeQuota(JSON.parse(stdout));
    if (!isStopped) await call("statusBar.update", { id: QUOTA_ITEM, ...summary, visible: true });
    return summary;
  }

  async function refreshQuotaOnce() {
    try {
      return await updateQuota();
    } catch (error) {
      log(`orkest: quota refresh failed: ${error.message}`);
      const failed = {
        text: "Quota ?",
        tone: "warning",
        tooltip: `monitor json failed: ${String(error.stderr || error.message).slice(0, 200)}`,
      };
      if (!isStopped) {
        try {
          await call("statusBar.update", { id: QUOTA_ITEM, ...failed, visible: true });
        } catch {
          // The status bar is desktop-only; nothing else to report to.
        }
      }
      return failed;
    } finally {
      quotaPending = null;
    }
  }

  /** One `monitor json` run at a time; a timer tick during a slow run joins it. */
  function refreshQuota() {
    if (isStopped) return Promise.resolve(null);
    quotaPending ??= refreshQuotaOnce();
    return quotaPending;
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
    registry = await readOrcaTerminals(env);
    if (isStopped) return [];
    const swarmCommand = (action) => async (args) =>
      describe(
        (await serial(() =>
          swarm(action, args && typeof args === "object" ? args : undefined),
        )) ?? { status: "stopped" },
      );
    orca.commands.register("orkest.swarm.toggle", swarmCommand("toggle"));
    orca.commands.register("orkest.swarm.open", swarmCommand("open"));
    orca.commands.register("orkest.swarm.close", swarmCommand("close"));
    orca.commands.register("orkest.quota.refresh", async () => {
      const summary = await refreshQuota();
      return summary ? `Quota: ${summary.text}` : "Quota refresh skipped.";
    });
    disposables.push(
      orca.events.on("workspace.changed", (event) => serial(() => syncContext(event?.context))),
      orca.events.on("agent.status.changed", (event) => serial(() => onAgentStatus(event))),
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
      if (outcomes.length > 0) log(`orkest: restore ${JSON.stringify(outcomes)}`);
      return outcomes;
    });
  }

  async function stop() {
    isStopped = true;
    if (quotaTimer) stopTimer(quotaTimer);
    quotaTimer = null;
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
    swarm: (action) => serial(() => swarm(action)),
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
