import { execFile } from "node:child_process";

import { readAgentActivity } from "./agent-activity.mjs";
import { plain } from "./tui-box.mjs";

const PANE_ID = /^[A-Za-z0-9_.:%][A-Za-z0-9_.:%-]{0,63}$/u;

function identifier(value) {
  return typeof value === "string" && PANE_ID.test(value) ? value : "";
}

function terminalTarget(agent) {
  const herdrPane = identifier(agent.herdrPaneId || agent.progress?.herdrPaneId);
  if (herdrPane) return `herdr:${herdrPane}`;
  const tmuxPane = identifier(agent.paneId || agent.progress?.paneId);
  if (!tmuxPane) return "activity";
  const server = identifier(agent.terminalServer || agent.progress?.terminalServer);
  return JSON.stringify(["tmux", server, tmuxPane]);
}

function terminalText(value) {
  return String(value ?? "")
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map(plain)
    .join("\n");
}

/** Read terminal snapshots without moving agents or sending input to their sessions. */
export function createAgentPreview({
  env = process.env,
  exec = execFile,
  onChange = () => {},
} = {}) {
  let active;
  let snapshot = null;
  let generation = 0;
  let isDisposed = false;
  let isOwnedZoom = false;
  let zoomQueue = Promise.resolve();
  let zoomError = "";
  let pendingRead;
  const currentPane = identifier(env.HERDR_PANE_ID);
  const herdr = env.HERDR_BIN_PATH || "herdr";

  function run(command, args) {
    return new Promise((resolve, reject) => {
      exec(command, args, { env, timeout: 2500, maxBuffer: 512 * 1024 }, (error, stdout = "") => {
        if (error) reject(error);
        else resolve(String(stdout));
      });
    });
  }

  function publish(next) {
    snapshot = next;
    onChange(next);
    return next;
  }

  async function queueZoom(operation) {
    const previous = zoomQueue;
    const next = Promise.withResolvers();
    zoomQueue = next.promise;
    await previous;
    try {
      return await operation();
    } finally {
      next.resolve();
    }
  }

  function expand(token) {
    if (!currentPane) return Promise.resolve();
    return queueZoom(async () => {
      if (token !== generation || !active || isOwnedZoom) return;
      const response = JSON.parse(await run(herdr, ["pane", "layout", "--pane", currentPane]));
      const layout = response.result?.layout ?? response.layout;
      if (typeof layout?.zoomed !== "boolean") throw new Error("Pane layout is unavailable");
      if (token !== generation || !active || layout.zoomed) return;
      await run(herdr, ["pane", "zoom", "--pane", currentPane, "--on"]);
      // A close may arrive during this request. Its queued cleanup runs after ownership is recorded.
      isOwnedZoom = true;
    });
  }

  function restoreZoom() {
    return queueZoom(async () => {
      if (!isOwnedZoom) return;
      await run(herdr, ["pane", "zoom", "--pane", currentPane, "--off"]);
      isOwnedZoom = false;
    });
  }

  async function read(token) {
    const agent = active;
    if (!agent || token !== generation) return null;
    const herdrPane = identifier(agent.herdrPaneId || agent.progress?.herdrPaneId);
    const tmuxPane = identifier(agent.paneId || agent.progress?.paneId);
    try {
      let text;
      let kind = herdrPane || tmuxPane ? "terminal" : "activity";
      if (herdrPane || tmuxPane) {
        if (herdrPane && herdrPane === currentPane) {
          throw new Error("The agent points to this preview pane");
        }
        try {
          if (herdrPane) {
            text = await run(herdr, [
              "pane",
              "read",
              herdrPane,
              "--source",
              "visible",
              "--lines",
              "200",
            ]);
          } else {
            const server = identifier(agent.terminalServer || agent.progress?.terminalServer);
            const args = server ? ["-L", server] : [];
            text = await run("tmux", [...args, "capture-pane", "-p", "-t", tmuxPane]);
          }
        } catch (terminalError) {
          const fallback =
            (await readAgentActivity(agent)) ||
            (Array.isArray(agent.output) ? agent.output.join("\n") : "");
          if (!fallback) throw terminalError;
          text = fallback;
          kind = "activity";
        }
      } else {
        text = await readAgentActivity(agent);
        if (!text) text = Array.isArray(agent.output) ? agent.output.join("\n") : "";
        if (!text) text = "No recorded activity yet.";
      }
      if (token !== generation || !active) return null;
      return publish({
        ...snapshot,
        text: terminalText(text),
        error: zoomError,
        kind,
        loading: false,
      });
    } catch (error) {
      if (token !== generation || !active) return null;
      return publish({
        ...snapshot,
        error: [zoomError, `Preview unavailable: ${plain(error.message)}`]
          .filter(Boolean)
          .join(". "),
        loading: false,
      });
    }
  }

  function refresh(agent) {
    if (!active || isDisposed) return Promise.resolve(null);
    if (agent?.id === active.id) {
      const hasChangedTarget = terminalTarget(agent) !== terminalTarget(active);
      active = agent;
      if (hasChangedTarget) {
        generation++;
        publish({
          ...snapshot,
          title: plain(agent.progress?.name || agent.name || agent.id || "Agent"),
          text: "",
          error: "",
          kind: terminalTarget(agent) === "activity" ? "activity" : "terminal",
          loading: true,
        });
      }
    }
    if (pendingRead?.generation === generation) return pendingRead.promise;
    const token = generation;
    const promise = readCurrent(token);
    pendingRead = { generation: token, promise };
    return promise;
  }

  async function readCurrent(token) {
    try {
      return await read(token);
    } finally {
      if (pendingRead?.generation === token) pendingRead = undefined;
    }
  }

  async function open(agent) {
    if (isDisposed) return null;
    active = agent;
    const token = ++generation;
    zoomError = "";
    const isTerminal = Boolean(
      identifier(agent.herdrPaneId || agent.progress?.herdrPaneId) ||
      identifier(agent.paneId || agent.progress?.paneId),
    );
    publish({
      agentId: agent.id,
      title: plain(agent.progress?.name || agent.name || agent.id || "Agent"),
      text: "",
      error: "",
      kind: isTerminal ? "terminal" : "activity",
      loading: true,
    });
    try {
      await expand(token);
    } catch (error) {
      if (token !== generation || !active) return null;
      zoomError = `Could not expand preview: ${plain(error.message)}`;
    }
    if (token !== generation || !active) return null;
    return refresh();
  }

  async function close() {
    const previous = snapshot;
    active = undefined;
    const token = ++generation;
    zoomError = "";
    publish(null);
    try {
      await restoreZoom();
    } catch (error) {
      if (token !== generation || !previous) return null;
      return publish({
        ...previous,
        error: `Could not restore split: ${plain(error.message)}. Close the preview again to retry.`,
        loading: false,
      });
    }
    return null;
  }

  async function dispose() {
    isDisposed = true;
    return close();
  }

  return { open, refresh, close, dispose };
}
