import { open, readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { Database } from "node:sqlite";

const SESSION_ID = /^[A-Za-z0-9_-]{1,100}$/u;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_CHUNK_BYTES = 64 * 1024;
const MAX_CURSORS = 64;
const MAX_EVENTS = 24;
const MAX_PINNED_TEXTS = 6;
const MAX_RECENT_TOOLS = 16;
const MAX_PENDING_BYTES = MAX_BYTES;
const MAX_SENT_MESSAGES = 64;
const TAB_BYTE = 9;
const LINE_FEED_BYTE = 10;
const CARRIAGE_RETURN_BYTE = 13;
const SPACE_BYTE = 32;
const OPEN_BRACE_BYTE = 123;
const EMPTY_ACTIVITY = { eventsText: "", handback: "", sentMessages: [], commentary: [] };

const activityCursors = new Map();
const openCodeCursors = new Map();
const activityLocks = new Map();

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

function createActivityState() {
  return {
    commentary: [],
    handback: "",
    lastEvent: null,
    recentEvents: [],
    recentTools: [],
    sentMessageKeys: new Set(),
    sentMessages: [],
  };
}

function addActivityEvent(state, kind, value) {
  const normalizedValue = kind === "text" ? assistantText(value, 1600) : value.slice(0, 400);
  if (!normalizedValue) return;

  const previous = state.lastEvent;
  if (kind === "tool" && previous?.kind === "tool" && previous.baseValue === normalizedValue) {
    previous.count++;
    previous.value = `${previous.baseValue} (×${previous.count})`;
    return;
  }

  const item =
    kind === "tool"
      ? { kind, value: normalizedValue, baseValue: normalizedValue, count: 1 }
      : { kind, value: normalizedValue };
  state.lastEvent = item;
  state.recentEvents.push(item);
  if (state.recentEvents.length > MAX_EVENTS) state.recentEvents.shift();
  if (kind === "text") {
    state.commentary.push(item);
    if (state.commentary.length > MAX_PINNED_TEXTS) state.commentary.shift();
  } else {
    state.recentTools.push(item);
    if (state.recentTools.length > MAX_RECENT_TOOLS) state.recentTools.shift();
  }
}

function addSentMessage(state, to, rawText) {
  const text = assistantText(rawText, 600);
  if (!text || state.sentMessageKeys.has(text)) return;
  state.sentMessageKeys.add(text);
  state.sentMessages.push({ to: shortText(to || ""), text });
  if (state.sentMessages.length <= MAX_SENT_MESSAGES) return;
  const removed = state.sentMessages.shift();
  state.sentMessageKeys.delete(removed.text);
}

function activitySummary(state) {
  const tailSlice = state.recentEvents;
  const tailHasText = tailSlice.some((item) => item.kind === "text");
  let selected = tailSlice;
  if (tailHasText) {
    const tailTexts = new Set(tailSlice.filter((item) => item.kind === "text"));
    const textRoom = Math.max(
      0,
      MAX_PINNED_TEXTS - tailSlice.filter((item) => item.kind === "text").length,
    );
    const earlierTexts = textRoom
      ? state.commentary.filter((item) => !tailTexts.has(item)).slice(-textRoom)
      : [];
    if (earlierTexts.length > 0) {
      selected = [...earlierTexts, ...tailSlice.slice(-(MAX_EVENTS - earlierTexts.length))];
    }
  } else {
    selected = [...state.commentary, ...state.recentTools];
  }

  let lastTextIndex = -1;
  for (let index = selected.length - 1; index >= 0; index--) {
    if (selected[index].kind === "text") {
      lastTextIndex = index;
      break;
    }
  }
  const eventsText = selected
    .map((item, index) =>
      item.kind === "text"
        ? assistantText(item.value, index === lastTextIndex ? 1600 : 400)
        : item.value,
    )
    .filter(Boolean)
    .join("\n");
  const commentary = state.commentary
    .map((item, index) =>
      assistantText(item.value, index === state.commentary.length - 1 ? 1600 : 400),
    )
    .filter(Boolean);
  return {
    eventsText,
    handback: state.handback,
    sentMessages: [...state.sentMessages],
    commentary,
  };
}

function parseTranscriptLine(state, line, engine) {
  if (
    !line ||
    line.includes('"type":"api-request') ||
    line.includes('"type": "api-request') ||
    line.includes('"type":"attachment"')
  ) {
    return;
  }

  let row;
  try {
    row = JSON.parse(line);
  } catch {
    return;
  }

  if (engine === "agy" && row.type === "PLANNER_RESPONSE") {
    if (assistantText(row.content)) addActivityEvent(state, "text", row.content);
    const toolCalls = row.tool_calls || [];
    for (const call of toolCalls) {
      const parsedArgs = parseToolArgs(call.args);
      if (call.name === "send_message" && assistantText(parsedArgs?.Message, 600)) {
        addSentMessage(state, parsedArgs.Recipient, parsedArgs.Message);
        continue;
      }
      addActivityEvent(state, "tool", toolLabel(call.name, call.args));
    }
  } else if (engine === "claude" && row.type === "assistant") {
    const content = row.message?.content || [];
    for (const block of content) {
      if (block.type === "text" && assistantText(block.text)) {
        addActivityEvent(state, "text", block.text);
      }
      if (block.type !== "tool_use") continue;
      const parsedInput = parseToolArgs(block.input);
      if (block.name === "SubagentHandback") {
        const message = assistantText(
          parsedInput?.message || parsedInput?.content || parsedInput?.report || "",
          1600,
        );
        if (message) state.handback = message;
        continue;
      }
      if (
        block.name === "SendMessage" &&
        assistantText(parsedInput?.message || parsedInput?.content || "", 600)
      ) {
        addSentMessage(
          state,
          parsedInput.to || parsedInput.recipient,
          parsedInput.message || parsedInput.content,
        );
        continue;
      }
      addActivityEvent(state, "tool", toolLabel(block.name, block.input));
    }
  } else if (engine === "codex" && row.type === "response_item") {
    const item = row.payload;
    if (item?.type === "message" && item.role === "assistant") {
      const content = item.content || [];
      for (const block of content)
        if (block.type === "output_text" && assistantText(block.text))
          addActivityEvent(state, "text", block.text);
    } else if (item?.type === "function_call" || item?.type === "custom_tool_call") {
      addActivityEvent(state, "tool", toolLabel(item.name, item.arguments));
    }
  }
}

function consumeTranscriptBytes(cursor, bytes, engine) {
  const previousReadOffset = cursor.readOffset;
  const combinedStart = previousReadOffset - BigInt(cursor.pendingBytes.length);
  const combined = Buffer.concat([cursor.pendingBytes, bytes]);
  let lineStart = 0;

  for (let index = 0; index < combined.length; index++) {
    if (combined[index] !== LINE_FEED_BYTE) continue;
    const lineEnd = BigInt(index + 1) + combinedStart;
    if (cursor.discardUntilNewline) {
      cursor.discardUntilNewline = false;
    } else {
      parseTranscriptLine(
        cursor.parsed,
        combined.subarray(lineStart, index).toString("utf8"),
        engine,
      );
    }
    cursor.byteOffset = lineEnd;
    lineStart = index + 1;
  }

  const remaining = combined.subarray(lineStart);
  if (cursor.discardUntilNewline) {
    cursor.pendingBytes = Buffer.alloc(0);
  } else if (remaining.length > MAX_PENDING_BYTES) {
    cursor.discardUntilNewline = true;
    cursor.pendingBytes = Buffer.alloc(0);
  } else {
    cursor.pendingBytes = Buffer.from(remaining);
  }
  cursor.readOffset += BigInt(bytes.length);
  cursor.summary = activitySummary(cursor.parsed);
}

function createTranscriptCursor(info) {
  const startOffset = info.size > BigInt(MAX_BYTES) ? info.size - BigInt(MAX_BYTES) : 0n;
  const parsed = createActivityState();
  return {
    ino: info.ino,
    size: info.size,
    mtimeNs: info.mtimeNs,
    byteOffset: startOffset,
    readOffset: startOffset,
    pendingBytes: Buffer.alloc(0),
    discardUntilNewline: startOffset > 0n,
    parsed,
    summary: activitySummary(parsed),
  };
}

function touchCursor(cache, key, cursor) {
  cache.delete(key);
  cache.set(key, cursor);
  while (cache.size > MAX_CURSORS) cache.delete(cache.keys().next().value);
}

async function withActivityLock(key, operation) {
  const previous = activityLocks.get(key) || Promise.resolve();
  const { promise: current, resolve: release } = Promise.withResolvers();
  activityLocks.set(key, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (activityLocks.get(key) === current) activityLocks.delete(key);
  }
}

function firstNonWhitespaceByte(chunk) {
  for (const byte of chunk) {
    if (
      byte !== SPACE_BYTE &&
      byte !== TAB_BYTE &&
      byte !== CARRIAGE_RETURN_BYTE &&
      byte !== LINE_FEED_BYTE
    ) {
      return byte;
    }
  }
  return -1;
}

async function readTranscript(file, engine) {
  let canonicalPath;
  try {
    canonicalPath = await realpath(file);
  } catch {
    return { ...EMPTY_ACTIVITY };
  }
  const key = `${canonicalPath}\0${engine}`;
  return withActivityLock(key, async () => {
    let pathInfo;
    try {
      pathInfo = await stat(canonicalPath, { bigint: true });
      if (!pathInfo.isFile()) return { ...EMPTY_ACTIVITY };
    } catch {
      activityCursors.delete(key);
      return { ...EMPTY_ACTIVITY };
    }

    let cursor = activityCursors.get(key);
    if (
      cursor &&
      pathInfo.ino === cursor.ino &&
      pathInfo.size === cursor.size &&
      pathInfo.mtimeNs === cursor.mtimeNs
    ) {
      touchCursor(activityCursors, key, cursor);
      return cursor.summary;
    }

    let handle;
    try {
      handle = await open(canonicalPath, "r");
      const info = await handle.stat({ bigint: true });
      if (!info.isFile()) return { ...EMPTY_ACTIVITY };

      const isReset =
        !cursor ||
        info.ino !== cursor.ino ||
        info.size < cursor.size ||
        info.size < cursor.readOffset ||
        (info.size === cursor.size && info.mtimeNs !== cursor.mtimeNs);
      if (isReset) cursor = createTranscriptCursor(info);

      if (info.size < cursor.readOffset) cursor = createTranscriptCursor(info);
      let checkedLineBoundary =
        cursor.readOffset === 0n || cursor.pendingBytes.length > 0 || cursor.discardUntilNewline;
      while (cursor.readOffset < info.size) {
        const remaining = info.size - cursor.readOffset;
        const length = Number(
          remaining > BigInt(MAX_CHUNK_BYTES) ? BigInt(MAX_CHUNK_BYTES) : remaining,
        );
        const buffer = Buffer.allocUnsafe(length);
        const result = await handle.read(buffer, 0, length, cursor.readOffset);
        if (result.bytesRead === 0) break;
        const chunk = buffer.subarray(0, result.bytesRead);
        if (!checkedLineBoundary) {
          checkedLineBoundary = true;
          const firstNonSpace = firstNonWhitespaceByte(chunk);
          if (firstNonSpace !== -1 && firstNonSpace !== OPEN_BRACE_BYTE) {
            cursor = createTranscriptCursor(info);
            continue;
          }
        }
        consumeTranscriptBytes(cursor, chunk, engine);
      }
      cursor.ino = info.ino;
      cursor.size = info.size;
      cursor.mtimeNs = info.mtimeNs;
      touchCursor(activityCursors, key, cursor);
      return cursor.summary;
    } catch {
      return { ...EMPTY_ACTIVITY };
    } finally {
      if (handle) {
        try {
          await handle.close();
        } catch {
          // Closing a failed transcript read is best effort.
        }
      }
    }
  });
}

function parseJsonObject(value) {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function openCodeDbCandidates(source) {
  if (typeof source.opencodeDbPath === "string" && source.opencodeDbPath.trim()) {
    return [path.resolve(source.opencodeDbPath)];
  }
  const dataHomes = [
    process.env.XDG_DATA_HOME,
    source.accountHome ? path.join(source.accountHome, ".local", "share") : "",
    path.join(homedir(), ".local", "share"),
  ];
  return [...new Set(dataHomes.filter((item) => item && path.isAbsolute(item)))].map((item) =>
    path.join(item, "opencode", "opencode.db"),
  );
}

async function openCodeDbPath(source) {
  const candidates = openCodeDbCandidates(source);
  for (const candidate of candidates) if (await fileExists(candidate)) return candidate;
  return candidates[0] || "";
}

function addOpenCodeActivity(state, part) {
  const data = parseJsonObject(part.data);
  if (!data) return;
  if (data.type === "text" && typeof data.text === "string") {
    addActivityEvent(state, "text", data.text);
  } else if (data.type === "tool") {
    addActivityEvent(
      state,
      "tool",
      toolLabel(data.tool, data.state?.input || { description: data.state?.title }),
    );
  }
}

async function readOpenCodeActivity(source) {
  const session = source.session || "";
  if (!SESSION_ID.test(session)) return { ...EMPTY_ACTIVITY };
  const dbPath = await openCodeDbPath(source);
  if (!dbPath) return { ...EMPTY_ACTIVITY };
  const key = `${dbPath}\0${session}`;

  let database;
  try {
    database = new Database(dbPath, { readOnly: true, timeout: 50 });
    using versionStatement = database.prepare(
      `SELECT
        (SELECT COUNT(*) FROM message WHERE session_id = ?) AS message_count,
        (SELECT COALESCE(MAX(time_updated), -1) FROM message WHERE session_id = ?) AS message_updated,
        (SELECT COALESCE(SUM(LENGTH(data)), 0) FROM message WHERE session_id = ?) AS message_bytes,
        (SELECT COUNT(*) FROM part WHERE session_id = ?) AS part_count,
        (SELECT COALESCE(MAX(time_updated), -1) FROM part WHERE session_id = ?) AS part_updated,
        (SELECT COALESCE(SUM(LENGTH(data)), 0) FROM part WHERE session_id = ?) AS part_bytes`,
    );
    const version = versionStatement.get(session, session, session, session, session, session);
    const versionKey = `${version.message_count}:${version.message_updated}:${version.message_bytes}:${version.part_count}:${version.part_updated}:${version.part_bytes}`;
    const cached = openCodeCursors.get(key);
    if (cached?.version === versionKey) {
      touchCursor(openCodeCursors, key, cached);
      return cached.summary;
    }

    using recentPartsStatement = database.prepare(
      `SELECT p.id, p.time_created, p.data
       FROM part AS p
       JOIN message AS m ON m.id = p.message_id AND m.session_id = p.session_id
       WHERE p.session_id = ?
         AND CASE WHEN json_valid(m.data) THEN json_extract(m.data, '$.role') END = 'assistant'
       ORDER BY p.time_created DESC, p.id DESC
       LIMIT 600`,
    );
    using pinnedTextStatement = database.prepare(
      `SELECT p.id, p.time_created, p.data
       FROM part AS p
       JOIN message AS m ON m.id = p.message_id AND m.session_id = p.session_id
       WHERE p.session_id = ?
         AND CASE WHEN json_valid(m.data) THEN json_extract(m.data, '$.role') END = 'assistant'
         AND CASE WHEN json_valid(p.data) THEN json_extract(p.data, '$.type') END = 'text'
       ORDER BY p.time_created DESC, p.id DESC
       LIMIT ?`,
    );
    const recentParts = recentPartsStatement.all(session);
    const pinnedTextParts = pinnedTextStatement.all(session, MAX_PINNED_TEXTS);
    const partsById = new Map();
    for (const part of pinnedTextParts) partsById.set(part.id, part);
    for (const part of recentParts) partsById.set(part.id, part);
    const orderedParts = partsById
      .values()
      .toArray()
      .sort((left, right) => {
        const timeDelta = (left.time_created ?? 0) - (right.time_created ?? 0);
        if (timeDelta !== 0) return timeDelta;
        if (left.id < right.id) return -1;
        if (left.id > right.id) return 1;
        return 0;
      });

    const state = createActivityState();
    for (const part of orderedParts) addOpenCodeActivity(state, part);
    const cursor = { version: versionKey, summary: activitySummary(state) };
    touchCursor(openCodeCursors, key, cursor);
    return cursor.summary;
  } catch {
    return { ...EMPTY_ACTIVITY };
  } finally {
    database?.close();
  }
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
  if (engine === "agy") {
    const logDirectory = path.join(
      accountHome,
      "antigravity-cli",
      "brain",
      effectiveSession,
      ".system_generated",
      "logs",
    );
    const fullTranscript = path.join(logDirectory, "transcript_full.jsonl");
    return (await fileExists(fullTranscript))
      ? fullTranscript
      : path.join(logDirectory, "transcript.jsonl");
  }
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
  const transcriptPromise = (async () => {
    if (!source) return { ...EMPTY_ACTIVITY };
    if (source.engine === "opencode") return readOpenCodeActivity(source);
    const file = await transcriptFile(source);
    return file ? readTranscript(file, source.engine) : { ...EMPTY_ACTIVITY };
  })();
  const [parsedTranscript, resultInfo] = await Promise.all([
    transcriptPromise,
    agent.resultPath ? readResultSummary(agent.resultPath) : Promise.resolve(null),
  ]);
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

export function resetActivityCursorCache() {
  activityCursors.clear();
  openCodeCursors.clear();
}
