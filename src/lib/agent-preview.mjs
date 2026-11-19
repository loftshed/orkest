import { execFile } from "node:child_process";

import { readAgentActivity } from "./agent-activity.mjs";
import { resolveAgentPane } from "./herdr-cli.mjs";
import { isCurrentHerdrAgent } from "./herdr-context.mjs";
import {
  agentOrcaTerminal,
  isCurrentOrcaAgent,
  orcaTerminalHandle,
  resolveOrcaCli,
} from "./orca-context.mjs";
import { plain } from "./tui-box.mjs";

const PANE_ID = /^[A-Za-z0-9_.:%][A-Za-z0-9_.:%-]{0,63}$/u;
const ORKEST_TMUX_SERVER = /^orkest-label-[0-9a-f]{12}$/u;

function identifier(value) {
  return typeof value === "string" && PANE_ID.test(value) ? value : "";
}

function herdrPaneBinding(agent) {
  const value = agent.herdrPaneId || agent.progress?.herdrPaneId;
  return typeof value === "string" ? value.trim() : "";
}

function terminalTarget(agent, env) {
  const boundHerdrPane = herdrPaneBinding(agent);
  if (boundHerdrPane)
    return env.HERDR_ENV === "1" && identifier(boundHerdrPane)
      ? JSON.stringify([
          "herdr",
          agent.herdrEndpoint || agent.progress?.herdrEndpoint,
          boundHerdrPane,
        ])
      : "activity";
  const orcaTerminal = agentOrcaTerminal(agent);
  if (orcaTerminal)
    return isCurrentOrcaAgent(agent, env)
      ? JSON.stringify([
          "orca",
          agent.orcaEnvironment || agent.progress?.orcaEnvironment || "",
          orcaTerminal,
        ])
      : "activity";
  const tmuxPane = identifier(agent.paneId || agent.progress?.paneId);
  if (!tmuxPane) return "activity";
  const server = identifier(agent.terminalServer || agent.progress?.terminalServer);
  if (!ORKEST_TMUX_SERVER.test(server)) return "activity";
  return JSON.stringify(["tmux", server, tmuxPane]);
}

/** Visible Orca terminal text; `--screen` renders repaints, older Orca builds only have the tail. */
async function readOrcaTerminal(run, cli, terminal) {
  let stdout;
  try {
    stdout = await run(cli, ["terminal", "read", "--terminal", terminal, "--screen", "--json"]);
  } catch {
    stdout = await run(cli, [
      "terminal",
      "read",
      "--terminal",
      terminal,
      "--limit",
      "200",
      "--json",
    ]);
  }
  const tail = JSON.parse(stdout)?.result?.terminal?.tail;
  if (!Array.isArray(tail)) throw new Error("Orca returned no terminal output");
  return tail.map(String).join("\n");
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
  zoom = false,
  orcaCli,
} = {}) {
  let active;
  let snapshot = null;
  let generation = 0;
  let isDisposed = false;
  let isOwnedZoom = false;
  let zoomQueue = Promise.resolve();
  let zoomError = "";
  let pendingRead;
  const currentPane = env.HERDR_ENV === "1" ? identifier(env.HERDR_PANE_ID) : "";
  const herdr = env.HERDR_BIN_PATH || "herdr";
  const currentOrcaTerminal = orcaTerminalHandle(env.ORCA_TERMINAL_HANDLE);

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
    if (!zoom || !currentPane) return Promise.resolve();
    return queueZoom(async () => {
      if (token !== generation || !active || isOwnedZoom) return;
      if (herdrPaneBinding(active) && !isCurrentHerdrAgent(active, env)) return;
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
    const boundHerdrPane = herdrPaneBinding(agent);
    const herdrPane = env.HERDR_ENV === "1" ? identifier(boundHerdrPane) : "";
    const orcaTerminal = boundHerdrPane ? "" : agentOrcaTerminal(agent);
    const orcaPane = orcaTerminal && isCurrentOrcaAgent(agent, env) ? orcaTerminal : "";
    const server = identifier(agent.terminalServer || agent.progress?.terminalServer);
    const tmuxPane =
      !boundHerdrPane && !orcaTerminal && ORKEST_TMUX_SERVER.test(server)
        ? identifier(agent.paneId || agent.progress?.paneId)
        : "";
    try {
      let text;
      let kind = herdrPane || orcaPane || tmuxPane ? "terminal" : "activity";
      if (herdrPane || orcaPane || tmuxPane) {
        if (
          (herdrPane && herdrPane === currentPane) ||
          (orcaPane && orcaPane === currentOrcaTerminal)
        ) {
          throw new Error("The agent points to this preview pane");
        }
        try {
          if (orcaPane) {
            const cli = orcaCli === undefined ? resolveOrcaCli(env) : orcaCli;
            if (!cli) throw new Error("The Orca CLI is not available");
            text = await readOrcaTerminal(run, cli, orcaPane);
          } else if (herdrPane) {
            if (!isCurrentHerdrAgent(agent, env))
              throw new Error("The agent belongs to another Herdr server");
            const session =
              agent.session?.id || agent.nativeSession || agent.activitySource?.session;
            const pane = await resolveAgentPane(herdrPane, session, { env, exec });
            if (!pane || pane === currentPane)
              throw new Error("The agent in this pane has changed");
            text = await run(herdr, [
              "agent",
              "read",
              pane,
              "--source",
              "visible",
              "--lines",
              "200",
            ]);
          } else {
            text = await run("tmux", ["-L", server, "capture-pane", "-p", "-t", tmuxPane]);
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
      const hasChangedTarget = terminalTarget(agent, env) !== terminalTarget(active, env);
      active = agent;
      if (hasChangedTarget) {
        generation++;
        publish({
          ...snapshot,
          title: plain(agent.progress?.name || agent.name || agent.id || "Agent"),
          text: "",
          error: "",
          kind: terminalTarget(agent, env) === "activity" ? "activity" : "terminal",
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
    const isTerminal = terminalTarget(agent, env) !== "activity";
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
