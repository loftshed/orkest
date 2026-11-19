import { realpathSync } from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import path from "node:path";

export const HERDR_LIFECYCLE_SUBSCRIPTIONS = Object.freeze([
  { type: "pane.created" },
  { type: "pane.updated" },
  { type: "pane.moved" },
  { type: "pane.closed" },
  { type: "pane.exited" },
  { type: "pane.agent_detected" },
  { type: "layout.updated" },
  { type: "workspace.updated" },
]);

function expandHome(filePath) {
  if (typeof filePath !== "string") return "";
  if (filePath === "~") return homedir();
  if (filePath.startsWith("~/") || filePath.startsWith("~\\")) {
    return path.join(homedir(), filePath.slice(2));
  }
  return filePath;
}

/** Herdr pane IDs only have meaning at this server endpoint. */
export function herdrEndpoint(env = process.env) {
  const config = path.join(
    expandHome(env.XDG_CONFIG_HOME) || path.join(homedir(), ".config"),
    "herdr",
  );
  const socket = expandHome(
    env.HERDR_SOCKET_PATH ||
      (env.HERDR_SESSION
        ? path.join(config, "sessions", env.HERDR_SESSION, "herdr.sock")
        : path.join(config, "herdr.sock")),
  );
  try {
    return realpathSync(socket);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    try {
      return path.join(realpathSync(path.dirname(socket)), path.basename(socket));
    } catch (parentError) {
      if (parentError.code !== "ENOENT") throw parentError;
      return path.resolve(socket);
    }
  }
}

/** Herdr workspace, tab and pane identifiers (`w1`, `w1:p2`, `%3`): never lead with a dash. */
export const HERDR_ID_RE = /^[A-Za-z0-9_.:%][A-Za-z0-9_.:%-]{0,63}$/u;

export function isHerdrId(value) {
  return typeof value === "string" && HERDR_ID_RE.test(value);
}

/** Valid pane IDs only, deduplicated and sorted so equal sets compare equal. */
export function normalizePaneIds(ids) {
  const unique = new Set();
  const list = Array.isArray(ids) || ids instanceof Set ? ids : [];
  for (const id of list) {
    const trimmed = typeof id === "string" ? id.trim() : "";
    if (isHerdrId(trimmed)) unique.add(trimmed);
  }
  return [...unique].sort((a, b) => a.localeCompare(b, "en"));
}

/** Canonical form of an endpoint recorded by another process, or "" when unusable. */
export function canonicalHerdrEndpoint(endpoint) {
  if (typeof endpoint !== "string" || !path.isAbsolute(endpoint)) return "";
  try {
    return herdrEndpoint({ HERDR_SOCKET_PATH: endpoint });
  } catch {
    return "";
  }
}

/** Pane IDs of room members bound to this process's own Herdr endpoint. */
export function herdrPaneIdsFromRoom(room, env = process.env) {
  if (env?.HERDR_ENV !== "1" || !room || typeof room !== "object") return [];
  const members = [room.conductor, ...(Array.isArray(room.agents) ? room.agents : [])];
  const ids = [];
  for (const member of members) {
    if (!member || typeof member !== "object" || !isCurrentHerdrAgent(member, env)) continue;
    ids.push(member.herdrPaneId || member.progress?.herdrPaneId);
  }
  return normalizePaneIds(ids);
}

export function isCurrentHerdrAgent(agent, env = process.env) {
  const endpoint = agent?.herdrEndpoint || agent?.progress?.herdrEndpoint;
  if (env.HERDR_ENV !== "1" || typeof endpoint !== "string") return false;
  try {
    return endpoint === herdrEndpoint(env);
  } catch {
    return false;
  }
}

/** Agent commands require the current pane ID. Herdr's pane API also accepts its pre-move alias. */
export async function verifiedHerdrAgentPane(pane, session, query) {
  if (!pane || typeof session !== "string" || !session) return null;
  async function result(args) {
    try {
      return JSON.parse(await query(args))?.result;
    } catch {
      return null;
    }
  }
  let response = await result(["agent", "get", pane]);
  if (!response) {
    const current = await result(["pane", "current", "--pane", pane]);
    const canonical = current?.pane?.pane_id;
    if (typeof canonical !== "string" || !canonical || canonical === pane) return null;
    pane = canonical;
    response = await result(["agent", "get", pane]);
  }
  const ref = response?.type === "agent_info" && response.agent?.agent_session;
  return ref?.kind === "id" && ref.value === session ? pane : null;
}

/**
 * Subscribe to Herdr lifecycle events over the server Unix socket to invalidate cached snapshots.
 * Events are non-durable invalidation signals: on connect, reconnect, or `events_lost`, callers
 * reconcile through an authoritative snapshot read rather than replaying event payloads.
 *
 * Herdr protocol 22 has no unsubscribe verb, and a repeated `events.subscribe` on an established
 * stream resets the connection (verified against a disposable isolated server), so changing the
 * watched pane set opens a replacement stream beside the live one. It is promoted on
 * `subscription_started`, then the old stream is retired. A failed switch keeps the live stream.
 */
export function createHerdrLifecycleSubscriber({
  env = process.env,
  connect = (socketPath) => net.createConnection(socketPath),
  onInvalidate,
  onReconcile,
  paneIds = [],
  handshakeTimeoutMs = 5000,
  reconnectDelayMs = 500,
  maxReconnectDelayMs = 5000,
} = {}) {
  let live = null; // promoted stream: events are delivered from here
  let candidate = null; // replacement or first stream awaiting subscription_started
  let desiredIds = normalizePaneIds(paneIds);
  let isStarted = false;
  let isStopped = false;
  let generation = 0;
  let invalidations = 0;
  let reconnectTimer = null;
  let switchTimer = null;
  let attempts = 0;
  let switchAttempts = 0;

  const backoff = (count) =>
    Math.min(maxReconnectDelayMs, reconnectDelayMs * 2 ** Math.min(count, 5));

  const notifyInvalidate = (reason, detail = null) => {
    if (isStopped) return;
    invalidations += 1;
    try {
      onInvalidate?.({ reason, detail, generation, invalidations });
    } catch {
      // Invalidation callbacks must never break the subscriber loop.
    }
  };

  const notifyReconcile = (reason) => {
    if (isStopped) return;
    try {
      onReconcile?.({ reason, generation, invalidations });
    } catch {
      // Reconciliation callbacks are best-effort.
    }
  };

  const buildSubscriptions = (ids) => [
    ...HERDR_LIFECYCLE_SUBSCRIPTIONS.map((item) => ({ ...item })),
    ...ids.map((paneId) => ({ type: "pane.agent_status_changed", pane_id: paneId })),
  ];

  const retire = (stream) => {
    if (!stream || stream.isDead) return;
    stream.isDead = true;
    clearTimeout(stream.handshakeTimer);
    try {
      stream.socket?.destroy?.();
    } catch {
      // Ignore socket teardown errors.
    }
  };

  const clearTimers = () => {
    clearTimeout(reconnectTimer);
    clearTimeout(switchTimer);
    reconnectTimer = null;
    switchTimer = null;
  };

  const scheduleReconnect = (reason) => {
    if (isStopped || reconnectTimer || candidate) return;
    clearTimeout(switchTimer);
    switchTimer = null;
    notifyInvalidate(reason);
    const delay = backoff(attempts);
    attempts += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      openStream();
    }, delay);
    reconnectTimer.unref?.();
  };

  /** A replacement stream failed: the old one still delivers hints, so retry later. */
  const scheduleSwitchRetry = () => {
    if (isStopped || switchTimer || reconnectTimer) return;
    const delay = backoff(switchAttempts);
    switchAttempts += 1;
    switchTimer = setTimeout(() => {
      switchTimer = null;
      if (!isStopped && live && !candidate && !sameIds(live.ids, desiredIds)) openStream();
    }, delay);
    switchTimer.unref?.();
  };

  const sameIds = (a, b) => a.length === b.length && a.every((id, index) => id === b[index]);

  const fail = (stream, reason) => {
    if (stream.isDead || isStopped) return;
    retire(stream);
    if (stream === candidate) {
      candidate = null;
      if (live) scheduleSwitchRetry();
      else scheduleReconnect(reason);
    } else if (stream === live) {
      live = null;
      if (candidate) notifyInvalidate(reason);
      else scheduleReconnect(reason);
    }
  };

  const promote = (stream) => {
    clearTimeout(stream.handshakeTimer);
    const previous = live;
    live = stream;
    candidate = null;
    attempts = 0;
    switchAttempts = 0;
    generation += 1;
    retire(previous);
    notifyInvalidate("subscription_started");
    notifyReconcile("subscription_started");
  };

  const handleMessage = (stream, msg) => {
    if (!msg || typeof msg !== "object" || stream.isDead || isStopped) return;
    if (
      msg.error?.code === "events_lost" ||
      msg.event === "events_lost" ||
      msg.data?.type === "events_lost" ||
      msg.error
    ) {
      fail(
        stream,
        msg.error && msg.error?.code !== "events_lost" ? "subscribe_error" : "events_lost",
      );
      return;
    }
    if (msg.result?.type === "subscription_started") {
      if (stream === candidate) promote(stream);
      return;
    }
    if (stream === live && typeof msg.event === "string" && msg.event) {
      notifyInvalidate(msg.event, msg.data || null);
    }
  };

  function openStream() {
    if (isStopped || !isStarted || env?.HERDR_ENV !== "1") return;
    let socketPath;
    try {
      socketPath = herdrEndpoint(env);
    } catch {
      if (live) scheduleSwitchRetry();
      else scheduleReconnect("endpoint_error");
      return;
    }
    let socket;
    try {
      socket = connect(socketPath);
    } catch {
      if (live) scheduleSwitchRetry();
      else scheduleReconnect("connect_error");
      return;
    }
    const stream = {
      socket,
      ids: desiredIds,
      isDead: false,
      reqId: `ork-sub-${generation + 1}`,
      pending: "",
    };
    candidate = stream;
    stream.handshakeTimer = setTimeout(() => fail(stream, "handshake_timeout"), handshakeTimeoutMs);
    stream.handshakeTimer.unref?.();
    socket.on?.("connect", () => {
      if (stream.isDead || isStopped) return;
      const payload = JSON.stringify({
        id: stream.reqId,
        method: "events.subscribe",
        params: { subscriptions: buildSubscriptions(stream.ids) },
      });
      try {
        socket.write(`${payload}\n`);
      } catch {
        fail(stream, "write_error");
      }
    });
    socket.on?.("data", (chunk) => {
      if (stream.isDead || isStopped) return;
      stream.pending += String(chunk || "");
      let newlineIdx = stream.pending.indexOf("\n");
      while (newlineIdx !== -1) {
        const line = stream.pending.slice(0, newlineIdx).trim();
        stream.pending = stream.pending.slice(newlineIdx + 1);
        if (line) {
          try {
            handleMessage(stream, JSON.parse(line));
          } catch {
            // Ignore malformed lines on the stream.
          }
        }
        if (stream.isDead) return;
        newlineIdx = stream.pending.indexOf("\n");
      }
    });
    const onCloseOrError = () => fail(stream, "disconnected");
    socket.on?.("error", onCloseOrError);
    socket.on?.("close", onCloseOrError);
    socket.on?.("end", onCloseOrError);
  }

  const start = () => {
    if (isStopped || isStarted || env?.HERDR_ENV !== "1") return;
    isStarted = true;
    openStream();
  };

  /**
   * Replace the watched pane set. Unchanged sets do no I/O; a changed set before start or while
   * disconnected only records the desired state. Otherwise a newer request supersedes any pending
   * replacement so an older set can never be promoted after a newer one.
   */
  const setPaneIds = (nextIds) => {
    if (isStopped) return false;
    const next = normalizePaneIds(nextIds);
    if (sameIds(next, desiredIds)) return false;
    desiredIds = next;
    if (!isStarted) return true;
    if (candidate) {
      retire(candidate);
      candidate = null;
      openStream();
    } else if (live) {
      clearTimeout(switchTimer);
      switchTimer = null;
      openStream();
    }
    return true;
  };

  const stop = () => {
    if (isStopped) return;
    isStopped = true;
    clearTimers();
    const streams = [live, candidate];
    live = null;
    candidate = null;
    for (const stream of streams) retire(stream);
  };

  return {
    start,
    stop,
    setPaneIds,
    get isSubscribed() {
      return live !== null;
    },
    get generation() {
      return generation;
    },
    get invalidations() {
      return invalidations;
    },
    get paneIds() {
      return [...desiredIds];
    },
  };
}
