import { open, readdir, readFile, stat } from "node:fs/promises";
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

function assistantText(value, maxChars = 1600) {
  if (typeof value !== "string") return "";
  return value
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((line) => line.replaceAll(/[\t ]+/gu, " ").trimEnd())
    .join("\n")
    .replaceAll(/\n{3,}/gu, "\n\n")
    .trim()
    .slice(0, maxChars);
}

function parseToolArgs(args) {
  if (args && typeof args === "object") return args;
  if (typeof args === "string" && args.trimStart().startsWith("{")) {
    try {
      return JSON.parse(args);
    } catch {
      return null;
    }
  }
  return null;
}

function toolLabel(name, args) {
  const parsed = parseToolArgs(args);
  const file = parsed?.AbsolutePath || parsed?.file_path || parsed?.path;
  return `Used ${shortText(name)}${typeof file === "string" && file ? ` · ${path.basename(file)}` : ""}`;
}

function events(text, engine) {
  const raw = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (engine === "agy" && row.type === "PLANNER_RESPONSE") {
      if (assistantText(row.content)) raw.push({ kind: "text", value: row.content });
      const calls = row.tool_calls || [];
      for (const call of calls) raw.push({ kind: "tool", value: toolLabel(call.name, call.args) });
    } else if (engine === "claude" && row.type === "assistant") {
      const content = row.message?.content || [];
      for (const block of content) {
        if (block.type === "text" && assistantText(block.text))
          raw.push({ kind: "text", value: block.text });
        if (block.type === "tool_use")
          raw.push({ kind: "tool", value: toolLabel(block.name, block.input) });
      }
    } else if (engine === "codex" && row.type === "response_item") {
      const item = row.payload;
      if (item?.type === "message" && item.role === "assistant") {
        const content = item.content || [];
        for (const block of content)
          if (block.type === "output_text" && assistantText(block.text))
            raw.push({ kind: "text", value: block.text });
      } else if (item?.type === "function_call" || item?.type === "custom_tool_call") {
        raw.push({ kind: "tool", value: toolLabel(item.name, item.arguments) });
      }
    }
  }
  const sliced = raw.slice(-MAX_EVENTS);
  let lastTextIndex = -1;
  for (let i = sliced.length - 1; i >= 0; i--) {
    if (sliced[i].kind === "text") {
      lastTextIndex = i;
      break;
    }
  }
  return sliced
    .map((item, idx) =>
      item.kind === "text"
        ? assistantText(item.value, idx === lastTextIndex ? 1600 : 400)
        : item.value,
    )
    .filter(Boolean)
    .join("\n");
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

async function fileExists(targetPath) {
  try {
    return (await stat(targetPath)).isFile();
  } catch {
    return false;
  }
}

async function transcriptFile(source, home) {
  const { engine, session = "", parentSession, cwd, parentCwd, roomCwd, startedAt } = source;
  const accountHome = source.accountHome || home || "";
  const subagentId =
    source.agentId || (session.startsWith("subagent-") ? session.slice("subagent-".length) : "");
  const effectiveSession = session || (subagentId ? `subagent-${subagentId}` : "");
  if (!SESSION_ID.test(effectiveSession) || !path.isAbsolute(accountHome)) return "";
  if (engine === "agy")
    return path.join(
      accountHome,
      "antigravity-cli",
      "brain",
      effectiveSession,
      ".system_generated",
      "logs",
      "transcript.jsonl",
    );
  if (engine === "claude") {
    const candidateCwds = [cwd, parentCwd, roomCwd].filter(
      (item) => typeof item === "string" && item.trim(),
    );
    if (candidateCwds.length === 0) return "";
    const slugs = [
      ...new Set(candidateCwds.map((item) => item.replaceAll(/[^A-Za-z0-9-]/gu, "-"))),
    ];
    if (!subagentId) {
      const candidates = slugs.map((slug) =>
        path.join(accountHome, "projects", slug, `${effectiveSession}.jsonl`),
      );
      for (const candidate of candidates) {
        if (await fileExists(candidate)) return candidate;
      }
      return candidates[0];
    }
    if (!SESSION_ID.test(subagentId) || !SESSION_ID.test(parentSession || "")) return "";
    const candidates = slugs.map((slug) =>
      path.join(
        accountHome,
        "projects",
        slug,
        parentSession,
        "subagents",
        `agent-${subagentId}.jsonl`,
      ),
    );
    for (const candidate of candidates) {
      if (await fileExists(candidate)) return candidate;
    }
    return candidates[0];
  }
  if (engine === "codex") return codexFile(accountHome, effectiveSession, startedAt);
  return "";
}

async function readResultSummary(resultPath) {
  if (typeof resultPath !== "string" || !resultPath.trim()) return null;
  try {
    const raw = await readFile(resultPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const answer = assistantText(
        parsed.answer || parsed.final_message || parsed.reported_outcome || "",
        1600,
      );
      const uncertainty = assistantText(parsed.uncertainty || "", 600);
      const error = assistantText(parsed.error || "", 600);
      const verification =
        typeof parsed.verification?.status === "string" ? parsed.verification.status.trim() : "";
      return { answer, uncertainty, error, verification, liveOutput: "" };
    }
  } catch {
    const runDir = path.dirname(resultPath);
    for (const fallbackFile of ["final-output.txt", "stdout.txt"]) {
      const liveText = assistantText(await tail(path.join(runDir, fallbackFile)), 1600);
      if (liveText) {
        return { answer: "", uncertainty: "", error: "", verification: "", liveOutput: liveText };
      }
    }
  }
  return null;
}

/** Show recent visible assistant messages, results, and tool actions from a pane-less or finished agent. */
export async function readAgentActivity(agent) {
  if (!agent || typeof agent !== "object") return "";
  const source = agent.activitySource;
  const [file, resultInfo] = await Promise.all([
    source ? transcriptFile(source) : Promise.resolve(""),
    agent.resultPath ? readResultSummary(agent.resultPath) : Promise.resolve(null),
  ]);
  const transcriptEvents = file && source ? events(await tail(file), source.engine) : "";
  const answer = resultInfo?.answer || assistantText(agent.answer || "", 1600);
  const uncertainty = resultInfo?.uncertainty || assistantText(agent.uncertainty || "", 600);
  const error = resultInfo?.error || assistantText(agent.error || "", 600);
  const verification = resultInfo?.verification || "";
  const liveOutput = resultInfo?.liveOutput || "";
  const messages = Array.isArray(agent.messages) ? agent.messages : [];
  const rawTask = shortText(agent.objective || agent.progress?.task || agent.question || "");
  const task = rawTask && rawTask !== "not set" ? rawTask : "";

  const hasRichActivity = Boolean(
    transcriptEvents ||
    messages.length > 0 ||
    answer ||
    uncertainty ||
    error ||
    verification ||
    liveOutput,
  );
  if (!hasRichActivity) return "";

  const hasStructuredContext = Boolean(
    task || messages.length > 0 || answer || uncertainty || error || verification || liveOutput,
  );
  if (!hasStructuredContext) return transcriptEvents;

  const sections = [];
  if (task) sections.push(`Task: ${task}`);
  if (messages.length > 0) {
    const formattedMessages = messages
      .map((msg) => {
        const kindPrefix = msg.kind ? `[${shortText(msg.kind)}] ` : "";
        const body = assistantText(msg.text || "", 600);
        return body ? `• ${kindPrefix}${body}` : "";
      })
      .filter(Boolean);
    if (formattedMessages.length > 0) {
      sections.push(`Messages to orchestrator:\n${formattedMessages.join("\n")}`);
    }
  }
  if (answer) {
    const responseLines = [`Response:\n${answer}`];
    if (uncertainty) responseLines.push(`Uncertainty: ${uncertainty}`);
    if (verification) responseLines.push(`Verification: ${verification}`);
    sections.push(responseLines.join("\n"));
  } else {
    const metaLines = [
      uncertainty && `Uncertainty: ${uncertainty}`,
      verification && `Verification: ${verification}`,
    ].filter(Boolean);
    if (metaLines.length > 0) sections.push(metaLines.join("\n"));
  }
  if (error) sections.push(`Error: ${error}`);
  if (liveOutput) sections.push(`Live output:\n${liveOutput}`);
  if (transcriptEvents) sections.push(`Recent activity:\n${transcriptEvents}`);
  return sections.join("\n\n");
}
