import { open, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const SESSION_ID = /^[A-Za-z0-9_-]{1,100}$/u;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_EVENTS = 24;
const MAX_PINNED_TEXTS = 6;
const MAX_RECENT_TOOLS = 16;

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

function cleanShellCommand(rawCommand) {
  if (typeof rawCommand !== "string" || !rawCommand.trim()) return "";
  let s = rawCommand.trim().replaceAll(/\s+/gu, " ");
  for (let i = 0; i < 6; i++) {
    const next = s
      .replace(/^cd\s+[^;&]+(?:\s*&&|\s*;)\s*/u, "")
      .replace(/^[A-Za-z_][A-Za-z0-9_]*=(?:\$\([^;]*\)|[^\s;&]+)\s*(?:&&|;)\s*/u, "")
      .trim();
    if (next === s) break;
    s = next;
  }
  if (/^python3?\s+-\s*<</u.test(s)) {
    const fileMatch = rawCommand.match(
      /['"]([A-Za-z0-9_./-]+\.(?:tsx?|jsx?|mjs|cjs|py|md|json|css|scss|html))['"]/u,
    );
    const target = fileMatch?.[1] ? path.basename(fileMatch[1]) : "";
    return target ? `python3 inline script (${target})` : "python3 inline script";
  }
  return s.slice(0, 96);
}

function toolDetail(parsed) {
  if (!parsed || typeof parsed !== "object") return "";
  const desc = shortText(parsed.description || parsed.toolSummary || "");
  if (desc) return desc.slice(0, 96);
  const file = parsed.AbsolutePath || parsed.file_path || parsed.path || parsed.SearchPath;
  const pattern = shortText(parsed.pattern || parsed.Query || parsed.Pattern || "");
  if (pattern && typeof file === "string" && file) {
    return `${pattern.slice(0, 60)} · ${path.basename(file)}`;
  }
  if (typeof file === "string" && file) return path.basename(file);
  if (pattern) return pattern.slice(0, 80);
  const cmd = cleanShellCommand(parsed.command || parsed.CommandLine || parsed.cmd || "");
  if (cmd) return cmd;
  const sub = shortText(parsed.Role || parsed.subject || "");
  if (sub) return sub.slice(0, 80);
  return "";
}

function toolLabel(name, args) {
  const parsed = parseToolArgs(args);
  const detail = toolDetail(parsed);
  return `Used ${shortText(name)}${detail ? ` · ${detail}` : ""}`;
}

function parseTranscript(text, engine) {
  const raw = [];
  let handback = "";
  const sentMessages = [];
  for (const line of text.split("\n")) {
    if (
      !line ||
      line.includes('"type":"api-request') ||
      line.includes('"type": "api-request') ||
      line.includes('"type":"attachment"')
    ) {
      continue;
    }
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (engine === "agy" && row.type === "PLANNER_RESPONSE") {
      if (assistantText(row.content)) raw.push({ kind: "text", value: row.content });
      const calls = row.tool_calls || [];
      for (const call of calls) {
        const parsedArgs = parseToolArgs(call.args);
        if (call.name === "send_message" && assistantText(parsedArgs?.Message, 600)) {
          sentMessages.push({
            to: shortText(parsedArgs?.Recipient || ""),
            text: assistantText(parsedArgs.Message, 600),
          });
          continue;
        }
        raw.push({ kind: "tool", value: toolLabel(call.name, call.args) });
      }
    } else if (engine === "claude" && row.type === "assistant") {
      const content = row.message?.content || [];
      for (const block of content) {
        if (block.type === "text" && assistantText(block.text))
          raw.push({ kind: "text", value: block.text });
        if (block.type !== "tool_use") continue;
        const parsedInput = parseToolArgs(block.input);
        if (block.name === "SubagentHandback") {
          const msg = assistantText(
            parsedInput?.message || parsedInput?.content || parsedInput?.report || "",
            1600,
          );
          if (msg) handback = msg;
          continue;
        }
        if (
          block.name === "SendMessage" &&
          assistantText(parsedInput?.message || parsedInput?.content || "", 600)
        ) {
          sentMessages.push({
            to: shortText(parsedInput?.to || parsedInput?.recipient || ""),
            text: assistantText(parsedInput.message || parsedInput.content, 600),
          });
          continue;
        }
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

  const collapsed = [];
  for (const item of raw) {
    const prev = collapsed.at(-1);
    if (item.kind === "tool" && prev?.kind === "tool" && prev.baseValue === item.value) {
      prev.count = (prev.count || 1) + 1;
      prev.value = `${prev.baseValue} (×${prev.count})`;
    } else {
      collapsed.push(
        item.kind === "tool" ? { ...item, baseValue: item.value, count: 1 } : { ...item },
      );
    }
  }

  const tailSlice = collapsed.slice(-MAX_EVENTS);
  const tailHasText = tailSlice.some((item) => item.kind === "text");
  let selected = tailSlice;
  if (tailHasText) {
    const earlierTexts = collapsed
      .slice(0, Math.max(0, collapsed.length - MAX_EVENTS))
      .filter((item) => item.kind === "text")
      .slice(-Math.max(0, MAX_PINNED_TEXTS - tailSlice.filter((i) => i.kind === "text").length));
    if (earlierTexts.length > 0) {
      selected = [...earlierTexts, ...tailSlice.slice(-(MAX_EVENTS - earlierTexts.length))];
    }
  } else {
    const allTexts = collapsed.filter((item) => item.kind === "text").slice(-MAX_PINNED_TEXTS);
    const recentTools = collapsed.filter((item) => item.kind === "tool").slice(-MAX_RECENT_TOOLS);
    selected = [...allTexts, ...recentTools];
  }

  let lastTextIndex = -1;
  for (let i = selected.length - 1; i >= 0; i--) {
    if (selected[i].kind === "text") {
      lastTextIndex = i;
      break;
    }
  }
  const eventsText = selected
    .map((item, idx) =>
      item.kind === "text"
        ? assistantText(item.value, idx === lastTextIndex ? 1600 : 400)
        : item.value,
    )
    .filter(Boolean)
    .join("\n");
  const textItems = collapsed.filter((item) => item.kind === "text").slice(-MAX_PINNED_TEXTS);
  const commentary = textItems
    .map((item, idx) => assistantText(item.value, idx === textItems.length - 1 ? 1600 : 400))
    .filter(Boolean);
  return { eventsText, handback, sentMessages, commentary };
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
  const parsedTranscript =
    file && source
      ? parseTranscript(await tail(file), source.engine)
      : { eventsText: "", handback: "", sentMessages: [], commentary: [] };
  const transcriptEvents = parsedTranscript.eventsText;
  const commentary = parsedTranscript.commentary || [];
  const answer =
    resultInfo?.answer || assistantText(agent.answer || "", 1600) || parsedTranscript.handback;
  const uncertainty = resultInfo?.uncertainty || assistantText(agent.uncertainty || "", 600);
  const error = resultInfo?.error || assistantText(agent.error || "", 600);
  const verification = resultInfo?.verification || "";
  const liveOutput = resultInfo?.liveOutput || "";
  const rawMessages = Array.isArray(agent.messages) ? [...agent.messages] : [];
  for (const sent of parsedTranscript.sentMessages) {
    if (rawMessages.every((m) => assistantText(m.text || "", 600) !== sent.text)) {
      rawMessages.push(sent);
    }
  }
  const messages = rawMessages;
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
    if (commentary.length > 0) {
      const updates = commentary.map((item) => `• ${item}`).join("\n");
      sections.push(`Latest updates:\n${updates}`);
    }
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
