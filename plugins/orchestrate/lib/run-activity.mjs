import { lstat, open, readFile } from "node:fs/promises";
import path from "node:path";

const TAIL_BYTES = 192 * 1024;
const MAX_LINES = 12;
const MAX_LINE = 160;

const ANSI = new RegExp(String.raw`${String.fromCodePoint(27)}\[[0-9;?]*[A-Za-z]`, "gu");

function oneLine(text) {
  const line = String(text ?? "")
    .replaceAll(ANSI, "")
    .replaceAll(/\s+/gu, " ")
    .trim();
  return [...line].length > MAX_LINE ? `${[...line].slice(0, MAX_LINE - 1).join("")}…` : line;
}

function commandText(command) {
  // Codex runs everything through `bash -lc "<command>"`; show the command itself.
  const wrapped = /^\S*(?:ba|z)?sh\s+-l?c\s+(["'])([\s\S]*)\1$/u.exec(String(command || ""));
  return oneLine(wrapped ? wrapped[2] : command);
}

function eventLine(event) {
  const item = event?.item;
  if (!item || event.type !== "item.completed") return "";
  switch (item.type) {
    case "agent_message": {
      return oneLine(String(item.text || "").split(/\r?\n/u, 1)[0]);
    }
    case "command_execution": {
      const mark =
        item.exit_code === 0 || item.exit_code == null ? "$" : `$ (exit ${item.exit_code})`;
      return `${mark} ${commandText(item.command)}`;
    }
    case "file_change": {
      const names = (item.changes || []).map((change) => path.basename(String(change.path || "")));
      const shown = names.slice(0, 3).join(", ");
      return oneLine(`edited ${shown}${names.length > 3 ? ` +${names.length - 3} more` : ""}`);
    }
    default: {
      return "";
    }
  }
}

/** Readable lines for the end of a runner's `stdout.txt`: Codex JSON events, else the plain text. */
export function summarizeRunOutput(text) {
  const lines = [];
  const rows = String(text || "").split(/\r?\n/u);
  for (const raw of rows) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    let line;
    if (trimmed.startsWith("{")) {
      try {
        line = eventLine(JSON.parse(trimmed));
      } catch {
        continue; // a line cut off by the size window
      }
    } else {
      line = oneLine(trimmed);
    }
    if (line) lines.push(line);
  }
  return lines.slice(-MAX_LINES);
}

/**
 * What a delegated run worker has been doing, from the output directory its run record names.
 * Read-only; a missing or unreadable file gives no lines.
 */
export async function readDelegatedRunTail(mailboxRoot, runId) {
  if (typeof runId !== "string" || !/^[\w.-]{1,120}$/u.test(runId)) return [];
  try {
    const record = JSON.parse(
      await readFile(path.join(mailboxRoot, "peers", `run-${runId}-worker.json`), "utf8"),
    );
    const resultPath = record?.resultPath;
    if (typeof resultPath !== "string" || !path.isAbsolute(resultPath)) return [];
    const file = path.join(path.dirname(resultPath), "stdout.txt");
    const info = await lstat(file);
    if (!info.isFile()) return [];
    const handle = await open(file, "r");
    try {
      const start = Math.max(0, info.size - TAIL_BYTES);
      const buffer = Buffer.alloc(info.size - start);
      await handle.read(buffer, 0, buffer.length, start);
      return summarizeRunOutput(buffer.toString("utf8"));
    } finally {
      await handle.close();
    }
  } catch {
    return [];
  }
}
