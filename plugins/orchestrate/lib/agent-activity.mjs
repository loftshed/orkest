import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";

const SESSION_ID = /^[A-Za-z0-9_-]{1,100}$/u;
const MAX_BYTES = 128 * 1024;
const MAX_EVENTS = 24;

async function tail(file) {
  let handle;
  try {
    const info = await stat(file);
    if (!info.isFile()) return "";
    const length = Math.min(info.size, MAX_BYTES);
    handle = await open(file, "r");
    const bytes = Buffer.alloc(length);
    const result = await handle.read(bytes, 0, length, info.size - length);
    const text = bytes.toString("utf8", 0, result.bytesRead);
    return info.size > length ? text.slice(text.indexOf("\n") + 1) : text;
  } catch {
    return "";
  } finally {
    await handle?.close();
  }
}

function shortText(value) {
  return typeof value === "string" ? value.trim().replaceAll(/\s+/gu, " ").slice(0, 400) : "";
}

function toolLabel(name, args) {
  const file = args?.AbsolutePath || args?.file_path || args?.path;
  return `Used ${shortText(name)}${typeof file === "string" ? ` · ${path.basename(file)}` : ""}`;
}

function events(text, engine) {
  const result = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (engine === "agy" && row.type === "PLANNER_RESPONSE") {
      if (shortText(row.content)) result.push(shortText(row.content));
      const calls = row.tool_calls || [];
      for (const call of calls) result.push(toolLabel(call.name, call.args));
    } else if (engine === "claude" && row.type === "assistant") {
      const content = row.message?.content || [];
      for (const block of content) {
        if (block.type === "text" && shortText(block.text)) result.push(shortText(block.text));
        if (block.type === "tool_use") result.push(toolLabel(block.name, block.input));
      }
    } else if (engine === "codex" && row.type === "response_item") {
      const item = row.payload;
      if (item?.type === "message" && item.role === "assistant") {
        const content = item.content || [];
        for (const block of content)
          if (block.type === "output_text" && shortText(block.text))
            result.push(shortText(block.text));
      } else if (item?.type === "function_call" || item?.type === "custom_tool_call") {
        result.push(toolLabel(item.name, item.arguments));
      }
    }
  }
  return result.slice(-MAX_EVENTS).join("\n");
}

async function codexFile(home, session, startedAt) {
  const date = new Date(startedAt);
  if (!Number.isFinite(date.getTime())) return "";
  for (const dayOffset of [0, -1, 1]) {
    const day = new Date(date.getTime() + dayOffset * 86_400_000);
    const dir = path.join(
      home,
      "sessions",
      String(day.getUTCFullYear()),
      String(day.getUTCMonth() + 1).padStart(2, "0"),
      String(day.getUTCDate()).padStart(2, "0"),
    );
    let names;
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    const name = names.find((entry) => entry.endsWith(`-${session}.jsonl`));
    if (name) return path.join(dir, name);
  }
  return "";
}

async function transcriptFile(source) {
  const { engine, session, parentSession, cwd, startedAt } = source;
  if (!SESSION_ID.test(session) || !path.isAbsolute(source.accountHome || "")) return "";
  if (engine === "agy")
    return path.join(
      source.accountHome,
      "antigravity-cli",
      "brain",
      session,
      ".system_generated",
      "logs",
      "transcript.jsonl",
    );
  if (engine === "claude") {
    if (!cwd) return "";
    const slug = cwd.replaceAll(/[^A-Za-z0-9-]/gu, "-");
    const project = path.join(source.accountHome, "projects", slug);
    if (!session.startsWith("subagent-")) return path.join(project, `${session}.jsonl`);
    const id = session.slice("subagent-".length);
    if (!SESSION_ID.test(id) || !SESSION_ID.test(parentSession || "")) return "";
    return path.join(project, parentSession, "subagents", `agent-${id}.jsonl`);
  }
  if (engine === "codex") return codexFile(source.accountHome, session, startedAt);
  return "";
}

/** Show recent visible assistant messages and tool actions from a pane-less native agent. */
export async function readAgentActivity(agent) {
  const source = agent.activitySource;
  if (!source) return "";
  const file = await transcriptFile(source);
  return file ? events(await tail(file), source.engine) : "";
}
