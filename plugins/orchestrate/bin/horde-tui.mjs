import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { emitKeypressEvents } from "node:readline";
import { pathToFileURL } from "node:url";

import { shouldUseColor } from "../../monitor/lib/render.mjs";
import { CACHE_DIR, CONFIG_PATH } from "../../monitor/lib/store.mjs";
import { createRoom, mailboxRoot, readRoom } from "../lib/horde-room.mjs";
import { fit, HordeView, shortAgentName } from "../lib/horde-view.mjs";

const PANE_ID_RE = /^[A-Za-z0-9_.:%][A-Za-z0-9_.:%-]{0,63}$/u;

const TERMINAL_STAGES = new Set([
  "completed",
  "complete",
  "reported complete",
  "failed",
  "canceled",
  "cancelled",
  "rejected",
]);

const quotaCache = {
  snapshotPath: "",
  snapshotMtimeMs: -1,
  configPath: "",
  configMtimeMs: -1,
  accounts: null,
};

async function runExec(exec, command, args) {
  try {
    if (exec === execFile) {
      return await new Promise((resolve) => {
        execFile(command, args, (err) => resolve(!err));
      });
    }
    let callbackError = null;
    const result = exec(command, args, (err) => {
      callbackError = err;
    });
    if (result && typeof result.then === "function") {
      await result;
    }
    return !callbackError;
  } catch {
    return false;
  }
}

export async function focusAgentPane(agent, { exec = execFile } = {}) {
  if (!agent || typeof agent !== "object") return false;
  const herdrPaneId = typeof agent.herdrPaneId === "string" ? agent.herdrPaneId.trim() : "";
  if (herdrPaneId && PANE_ID_RE.test(herdrPaneId)) {
    return runExec(exec, "herdr", ["pane", "focus", "--pane", herdrPaneId]);
  }
  const paneId = typeof agent.paneId === "string" ? agent.paneId.trim() : "";
  if (paneId && PANE_ID_RE.test(paneId)) {
    const server = typeof agent.terminalServer === "string" ? agent.terminalServer.trim() : "";
    const tmuxArgs =
      server && PANE_ID_RE.test(server)
        ? ["-L", server, "select-pane", "-t", paneId]
        : ["select-pane", "-t", paneId];
    return runExec(exec, "tmux", tmuxArgs);
  }
  return false;
}

function resolveStage(agent) {
  return String(agent?.stage ?? agent?.progress?.stage ?? agent?.status ?? "")
    .trim()
    .toLowerCase();
}

export function notifyHerdrTransitions(
  prevAgents,
  nextAgents,
  notifiedSet,
  { env = process.env, exec = execFile } = {},
) {
  if (!Array.isArray(nextAgents)) return false;
  const seen = notifiedSet instanceof Set ? notifiedSet : new Set();
  const isAllTerminal =
    nextAgents.length > 0 && nextAgents.every((agent) => TERMINAL_STAGES.has(resolveStage(agent)));

  if (!Array.isArray(prevAgents)) {
    for (const agent of nextAgents) {
      if (!agent || typeof agent !== "object") continue;
      if (resolveStage(agent) === "blocked") {
        seen.add(`${agent.id}:blocked:${agent.summary}`);
      }
    }
    if (isAllTerminal) {
      seen.add("room:all-complete");
    }
    return false;
  }

  if (env?.HERDR_ENV !== "1" && !env?.HERDR_SOCKET && !env?.HERDR_PANE_ID) return false;
  if (!isAllTerminal) {
    seen.delete("room:all-complete");
  }
  let isTriggered = false;

  for (const agent of nextAgents) {
    if (!agent || typeof agent !== "object") continue;
    const stage = resolveStage(agent);
    if (stage !== "blocked") continue;
    const prev = prevAgents.find((item) => item?.id === agent.id);
    const prevStage = resolveStage(prev);
    const key = `${agent.id}:blocked:${agent.summary}`;
    if ((prevStage === "blocked" && prev?.summary === agent.summary) || seen.has(key)) continue;
    seen.add(key);
    isTriggered = true;
    void runExec(exec, "herdr", [
      "notification",
      "show",
      `Orkest: ${agent.person || agent.id} blocked`,
      "--body",
      String(agent.summary || "Needs attention"),
      "--sound",
      "request",
    ]);
  }

  const hadActive = prevAgents.some((agent) => {
    const stage = resolveStage(agent);
    return stage !== "" && !TERMINAL_STAGES.has(stage);
  });
  if (isAllTerminal && hadActive && !seen.has("room:all-complete")) {
    seen.add("room:all-complete");
    isTriggered = true;
    void runExec(exec, "herdr", [
      "notification",
      "show",
      "Orkest: Horde complete",
      "--body",
      `All ${nextAgents.length} agents finished.`,
      "--sound",
      "done",
    ]);
  }

  return isTriggered;
}

function toNotificationAgents(room) {
  return (room?.agents || []).map((agent) => ({
    ...agent,
    id: agent.id,
    person: agent.person || agent.progress?.person || shortAgentName(agent) || agent.id,
    stage: agent.stage || agent.progress?.stage || agent.status,
    summary:
      agent.summary ??
      agent.question ??
      (agent.progress?.task && agent.progress.task !== "not set"
        ? agent.progress.task
        : undefined) ??
      agent.objective ??
      "",
  }));
}

async function mtimeOrNull(filePath) {
  try {
    return (await stat(filePath)).mtimeMs;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/** Follow monitor's shared snapshot without starting provider CLIs from a display. */
export async function cachedQuota() {
  const snapshotPath = path.join(CACHE_DIR, "snapshot.json");
  const snapshotMtimeMs = await mtimeOrNull(snapshotPath);
  if (snapshotMtimeMs === null) return [];
  const configMtimeMs = await mtimeOrNull(CONFIG_PATH);
  if (
    quotaCache.accounts &&
    quotaCache.snapshotPath === snapshotPath &&
    quotaCache.snapshotMtimeMs === snapshotMtimeMs &&
    quotaCache.configPath === CONFIG_PATH &&
    quotaCache.configMtimeMs === configMtimeMs
  ) {
    return quotaCache.accounts.map((account) => ({ ...account }));
  }
  let snapshot;
  try {
    snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  let config;
  try {
    config = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const entries = snapshot.accounts || {};
  const configured =
    config?.accounts ||
    Object.entries(entries).map(([id, entry]) => ({ ...entry, id: entry?.id || id }));
  const accounts = configured.map((account) => {
    const id = String(account?.id || "account");
    return {
      ...entries[id],
      id,
      label: account?.label || id,
      short: account?.short || id.slice(0, 2).toUpperCase(),
    };
  });
  Object.assign(quotaCache, {
    snapshotPath,
    snapshotMtimeMs,
    configPath: CONFIG_PATH,
    configMtimeMs,
    accounts,
  });
  return accounts.map((account) => ({ ...account }));
}

/** Own only terminal state; workers and room membership survive closing the display. */
export async function runHordeTui(
  load,
  {
    input = process.stdin,
    output = process.stdout,
    quota = true,
    env = process.env,
    exec = execFile,
  } = {},
) {
  if (!input.isTTY || !output.isTTY)
    throw new Error("Interactive view needs a terminal; use --print or --json");
  const loadRoom =
    typeof load === "function"
      ? load
      : async () => {
          const roomId = typeof load === "string" && load ? load : env?.ORKEST_ROOM_ID;
          return roomId ? readRoom(roomId, mailboxRoot(env)) : createRoom([]);
        };
  const initialRoom = await loadRoom();
  const notifiedSet = new Set();
  let prevAgents = toNotificationAgents(initialRoom);
  notifyHerdrTransitions(null, prevAgents, notifiedSet, { env, exec });
  const view = new HordeView(initialRoom, {
    height: output.rows || 32,
    color: shouldUseColor(output),
    onFocusPane: (agent) => {
      void focusAgentPane(agent, { exec });
    },
  });
  let isBusy = false;
  let errorText = "";
  let isStopped = false;
  let isRawModeChanged = false;
  let isInputResumed = false;
  let isAlternateScreen = false;
  let isCursorHidden = false;
  let lastLines = [];
  let terminalError;
  let timer;
  let refreshTimer;
  let resolveExit;
  const wasRaw = Boolean(input.isRaw);
  const width = () => output.columns || 80;
  const height = () => output.rows || 32;
  const refresh = async () => {
    if (isBusy || isStopped) return;
    isBusy = true;
    try {
      const room = await loadRoom();
      if (quota) {
        try {
          const accounts = await cachedQuota();
          if (accounts.length > 0) room.accounts = accounts;
        } catch (error) {
          room.quotaError = error.message;
        }
      }
      view.setRoom(room);
      const nextAgents = toNotificationAgents(room);
      notifyHerdrTransitions(prevAgents, nextAgents, notifiedSet, { env, exec });
      prevAgents = nextAgents;
      errorText = "";
    } catch (error) {
      errorText = error.message;
    } finally {
      isBusy = false;
    }
    paint();
  };
  const paint = () => {
    if (isStopped) return;
    try {
      view.height = height();
      const lines = view.render(width());
      if (errorText && lines.length > 0) lines[lines.length - 1] = fit(errorText, width());
      const visible = lines.slice(0, Math.max(1, view.height));
      // Overwrite in place (\x1b[K clears trailing cells after drawing) inside synchronized output
      // (\x1b[?2026h ... \x1b[?2026l), updating only changed rows to prevent background-bar flicker.
      if (lastLines.length === visible.length) {
        const patches = [];
        for (const [index, line] of visible.entries()) {
          if (line !== lastLines[index]) {
            patches.push(`\u{1B}[${index + 1};1H${line}\u{1B}[K`);
          }
        }
        if (patches.length > 0) {
          output.write(`\u{1B}[?2026h${patches.join("")}\u{1B}[?2026l`);
          lastLines = visible;
        }
      } else {
        const frame = visible.map((line) => `${line}\u{1B}[K`).join("\r\n");
        output.write(`\u{1B}[?2026h\u{1B}[H${frame}\u{1B}[J\u{1B}[?2026l`);
        lastLines = visible;
      }
    } catch (error) {
      terminalError = error;
      cleanup();
    }
  };
  const cleanup = () => {
    if (isStopped) return;
    isStopped = true;
    clearInterval(timer);
    clearInterval(refreshTimer);
    input.off("keypress", keypress);
    input.off("end", cleanup);
    input.off("close", cleanup);
    process.off("SIGINT", cleanup);
    process.off("SIGTERM", cleanup);
    process.off("SIGHUP", cleanup);
    output.off?.("resize", onResize);
    try {
      if (isRawModeChanged) input.setRawMode(wasRaw);
    } catch (error) {
      // Still restore the visible terminal even if the stream has already closed.
      terminalError ??= error;
    }
    if (isInputResumed) {
      try {
        input.pause();
      } catch (error) {
        terminalError ??= error;
      }
    }
    if (isAlternateScreen || isCursorHidden) {
      try {
        output.write(
          `${isCursorHidden ? "\u{1B}[?25h" : ""}${isAlternateScreen ? "\u{1B}[?1049l" : ""}`,
        );
      } catch (error) {
        terminalError ??= error;
      }
    }
    lastLines = [];
    resolveExit?.();
  };
  const keypress = (text, key) => {
    const value = key?.sequence || text || "";
    if (text === "q" || (key?.ctrl && key.name === "c")) cleanup();
    else {
      view.handleInput(value);
      paint();
    }
  };
  const onResize = () => {
    lastLines = [];
    paint();
  };
  try {
    emitKeypressEvents(input);
    input.setRawMode(true);
    isRawModeChanged = true;
    input.resume();
    isInputResumed = true;
    output.write("\u{1B}[?1049h\u{1B}[?25l");
    isAlternateScreen = true;
    isCursorHidden = true;
    await new Promise((resolve) => {
      resolveExit = resolve;
      timer = setInterval(() => {
        if (view.needsAnimation) paint();
      }, 200);
      refreshTimer = setInterval(refresh, 1000);
      input.on("keypress", keypress);
      input.on("end", cleanup);
      input.on("close", cleanup);
      process.on("SIGINT", cleanup);
      process.on("SIGTERM", cleanup);
      process.on("SIGHUP", cleanup);
      output.on?.("resize", onResize);
      paint();
      void refresh();
    });
  } finally {
    cleanup();
  }
  if (terminalError) throw terminalError;
}

export const runStoogesTui = runHordeTui;
export const runTui = runHordeTui;

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  await runHordeTui();
}
