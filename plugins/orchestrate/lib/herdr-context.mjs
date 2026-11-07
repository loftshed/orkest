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
 */
export function createHerdrLifecycleSubscriber({
  env = process.env,
  connect = (socketPath) => net.createConnection(socketPath),
  onInvalidate,
  onReconcile,
  paneIds = [],
  reconnectDelayMs = 500,
  maxReconnectDelayMs = 5000,
} = {}) {
  let socket = null;
  let isStopped = false;
  let isSubscribed = false;
  let generation = 0;
  let invalidations = 0;
  let reconnectTimer = null;
  let attempts = 0;
  let buffer = "";

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

  const buildSubscriptions = () => {
    const subs = HERDR_LIFECYCLE_SUBSCRIPTIONS.map((item) => ({ ...item }));
    for (const paneId of paneIds) {
      if (typeof paneId === "string" && paneId.trim()) {
        subs.push({ type: "pane.agent_status_changed", pane_id: paneId.trim() });
      }
    }
    return subs;
  };

  const scheduleReconnect = (reason) => {
    if (isStopped || reconnectTimer) return;
    isSubscribed = false;
    notifyInvalidate(reason);
    const delay = Math.min(maxReconnectDelayMs, reconnectDelayMs * 2 ** Math.min(attempts, 5));
    attempts += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      openSocket();
    }, delay);
    reconnectTimer.unref?.();
  };

  const handleMessage = (msg) => {
    if (!msg || typeof msg !== "object" || isStopped) return;
    if (
      msg.error?.code === "events_lost" ||
      msg.event === "events_lost" ||
      msg.data?.type === "events_lost" ||
      msg.error
    ) {
      if (socket) {
        const current = socket;
        socket = null;
        current.destroy();
      }
      scheduleReconnect(
        msg.error && msg.error?.code !== "events_lost" ? "subscribe_error" : "events_lost",
      );
      return;
    }
    if (msg.result?.type === "subscription_started") {
      isSubscribed = true;
      attempts = 0;
      generation += 1;
      notifyInvalidate("subscription_started");
      notifyReconcile("subscription_started");
      return;
    }
    if (typeof msg.event === "string" && msg.event) {
      notifyInvalidate(msg.event, msg.data || null);
    }
  };

  const openSocket = () => {
    if (isStopped || env?.HERDR_ENV !== "1") return;
    let socketPath;
    try {
      socketPath = herdrEndpoint(env);
    } catch {
      scheduleReconnect("endpoint_error");
      return;
    }
    let current;
    try {
      current = connect(socketPath);
    } catch {
      scheduleReconnect("connect_error");
      return;
    }
    socket = current;
    buffer = "";
    const reqId = `ork-sub-${generation + 1}`;
    const onConnect = () => {
      if (isStopped || socket !== current) return;
      const payload = JSON.stringify({
        id: reqId,
        method: "events.subscribe",
        params: { subscriptions: buildSubscriptions() },
      });
      try {
        current.write(`${payload}\n`);
      } catch {
        scheduleReconnect("write_error");
      }
    };
    const onData = (chunk) => {
      if (isStopped || socket !== current) return;
      buffer += String(chunk || "");
      let newlineIdx = buffer.indexOf("\n");
      while (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (line) {
          try {
            handleMessage(JSON.parse(line));
          } catch {
            // Ignore malformed lines on the stream.
          }
        }
        newlineIdx = buffer.indexOf("\n");
      }
    };
    const onCloseOrError = () => {
      if (isStopped || socket !== current) return;
      socket = null;
      scheduleReconnect("disconnected");
    };
    current.on?.("connect", onConnect);
    current.on?.("data", onData);
    current.on?.("error", onCloseOrError);
    current.on?.("close", onCloseOrError);
    current.on?.("end", onCloseOrError);
  };

  const start = () => {
    if (isStopped || socket || env?.HERDR_ENV !== "1") return;
    openSocket();
  };

  const stop = () => {
    if (isStopped) return;
    isStopped = true;
    isSubscribed = false;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (!socket) return;
    const current = socket;
    socket = null;
    try {
      current.destroy?.();
    } catch {
      // Ignore socket teardown errors.
    }
  };

  return {
    start,
    stop,
    get isSubscribed() {
      return isSubscribed;
    },
    get generation() {
      return generation;
    },
    get invalidations() {
      return invalidations;
    },
  };
}
