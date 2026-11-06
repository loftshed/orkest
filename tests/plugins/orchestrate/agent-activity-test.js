import { appendFile, mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { readAudit } = vi.hoisted(() => ({ readAudit: [] }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    open: async (...args) => {
      const handle = await actual.open(...args);
      return new Proxy(handle, {
        get(target, property) {
          if (property === "read") {
            return async (...readArgs) => {
              const result = await target.read(...readArgs);
              readAudit.push({
                file: String(args[0]),
                position: readArgs[3],
                bytesRead: result.bytesRead,
              });
              return result;
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
});

import {
  readAgentActivity,
  resetActivityCursorCache,
} from "../../../plugins/orchestrate/lib/agent-activity.mjs";

const context = { root: "" };

beforeEach(async () => {
  readAudit.length = 0;
  resetActivityCursorCache();
  context.root = await mkdtemp(path.join(tmpdir(), "ork-agent-activity-"));
});

afterEach(async () => {
  resetActivityCursorCache();
  vi.unstubAllEnvs();
  await rm(context.root, { recursive: true, force: true });
});

function codexSource(home, session = "activity-session") {
  return {
    engine: "codex",
    session,
    accountHome: home,
    startedAt: "2026-11-05T12:00:00.000Z",
  };
}

function codexText(text) {
  return {
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text }],
    },
  };
}

function codexTool(name, arguments_) {
  return {
    type: "response_item",
    payload: { type: "function_call", name, arguments: arguments_ },
  };
}

function jsonl(...rows) {
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

async function codexTranscript(home, session, content) {
  const dateDirectory = path.join(home, "sessions", "2026", "11", "05");
  await mkdir(dateDirectory, { recursive: true });
  const file = path.join(dateDirectory, `rollout-2026-11-05T12-00-00-${session}.jsonl`);
  await writeFile(file, content);
  return file;
}

function agySource(accountHome, session) {
  return { engine: "agy", session, accountHome };
}

async function agyTranscript(accountHome, session, fileName, rows) {
  const directory = path.join(
    accountHome,
    "antigravity-cli",
    "brain",
    session,
    ".system_generated",
    "logs",
  );
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, fileName);
  await writeFile(file, jsonl(...rows));
  return file;
}

function createOpenCodeDb(dbPath, session) {
  const database = new DatabaseSync(dbPath);
  database.exec(`
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      time_created INTEGER,
      time_updated INTEGER,
      data TEXT
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT,
      session_id TEXT,
      time_created INTEGER,
      time_updated INTEGER,
      data TEXT
    );
  `);
  database
    .prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)")
    .run("user-message", session, 1, 1, JSON.stringify({ role: "user" }));
  database
    .prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)")
    .run("assistant-message", session, 2, 2, JSON.stringify({ role: "assistant" }));
  const insertPart = database.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)");
  insertPart.run(
    "user-part",
    "user-message",
    session,
    1,
    1,
    JSON.stringify({ type: "text", text: "Hidden user message" }),
  );
  insertPart.run(
    "assistant-text",
    "assistant-message",
    session,
    2,
    2,
    JSON.stringify({ type: "text", text: "OpenCode is inspecting the report" }),
  );
  insertPart.run(
    "assistant-tool-a",
    "assistant-message",
    session,
    3,
    3,
    JSON.stringify({
      type: "tool",
      tool: "Read",
      state: { input: { file_path: "/work/report.md" } },
    }),
  );
  insertPart.run(
    "assistant-tool-b",
    "assistant-message",
    session,
    4,
    4,
    JSON.stringify({
      type: "tool",
      tool: "Read",
      state: { input: { file_path: "/work/report.md" } },
    }),
  );
  database.close();
  return dbPath;
}

describe("agent activity streaming cursors", () => {
  it("reads only appended bytes and performs no reads while the file is idle", async () => {
    const session = "incremental-session";
    const file = await codexTranscript(context.root, session, jsonl(codexText("Started")));
    const agent = { activitySource: codexSource(context.root, session) };

    expect(await readAgentActivity(agent)).toBe("Started");
    const initialBytes = readAudit.reduce((sum, entry) => sum + entry.bytesRead, 0);
    const startedBytes = Buffer.byteLength(jsonl(codexText("Started")));
    expect(initialBytes).toBe(startedBytes);

    const appended = jsonl(codexText("Appended update"));
    const readsBeforeAppend = readAudit.length;
    await appendFile(file, appended);
    expect(await readAgentActivity(agent)).toContain("Appended update");
    const appendReads = readAudit.slice(readsBeforeAppend);
    expect(appendReads.reduce((sum, entry) => sum + entry.bytesRead, 0)).toBe(
      Buffer.byteLength(appended),
    );
    const expectedOffset = BigInt(startedBytes);
    expect(appendReads.every((entry) => entry.position === expectedOffset)).toBe(true);

    const readsBeforeIdlePoll = readAudit.length;
    expect(await readAgentActivity(agent)).toContain("Appended update");
    expect(readAudit).toHaveLength(readsBeforeIdlePoll);
  });

  it("collapses identical consecutive tools across separate appends", async () => {
    const session = "tool-collapse-session";
    const tool = codexTool("Read", { file_path: "/work/report.md" });
    const file = await codexTranscript(context.root, session, jsonl(tool));
    const agent = { activitySource: codexSource(context.root, session) };
    expect(await readAgentActivity(agent)).toBe("Used Read · report.md");

    await appendFile(file, jsonl(tool));
    expect(await readAgentActivity(agent)).toBe("Used Read · report.md (×2)");
    await appendFile(file, jsonl(tool));
    expect(await readAgentActivity(agent)).toBe("Used Read · report.md (×3)");
  });

  it("decodes a UTF-8 character split across partial writes after its line completes", async () => {
    const session = "partial-utf8-session";
    const line = Buffer.from(jsonl(codexText("Résumé 🧭 café ─")));
    const characterOffset = line.indexOf(Buffer.from("🧭"));
    const splitAt = characterOffset + 2;
    const file = await codexTranscript(context.root, session, line.subarray(0, splitAt));
    const agent = { activitySource: codexSource(context.root, session) };

    expect(await readAgentActivity(agent)).toBe("");
    await appendFile(file, line.subarray(splitAt));
    const summary = await readAgentActivity(agent);
    expect(summary).toBe("Résumé 🧭 café ─");
    expect(summary).not.toContain("�");
  });

  it("resets on truncation and inode replacement", async () => {
    const session = "reset-session";
    const file = await codexTranscript(
      context.root,
      session,
      jsonl(codexText("Original activity")),
    );
    const agent = { activitySource: codexSource(context.root, session) };
    expect(await readAgentActivity(agent)).toBe("Original activity");

    await writeFile(file, jsonl(codexText("Truncated replacement")));
    expect(await readAgentActivity(agent)).toBe("Truncated replacement");

    const previousInfo = await stat(file, { bigint: true });
    const replacement = `${file}.replacement`;
    const replacedText = "A longer activity after a complete inode replacement";
    await writeFile(replacement, jsonl(codexText(replacedText)));
    await rename(replacement, file);
    const replacementInfo = await stat(file, { bigint: true });
    expect(replacementInfo.ino).not.toBe(previousInfo.ino);
    expect(replacementInfo.size).toBeGreaterThan(previousInfo.size);
    expect(await readAgentActivity(agent)).toBe(replacedText);
  });

  it("keeps pinned commentary after more than 2 MiB of later tool calls", async () => {
    const session = "pinned-commentary-session";
    const file = await codexTranscript(
      context.root,
      session,
      jsonl(codexText("Keep this early update")),
    );
    const agent = { activitySource: codexSource(context.root, session) };
    expect(await readAgentActivity(agent)).toContain("Keep this early update");

    const heavyOutput = Array.from({ length: 3000 }, () =>
      jsonl(codexTool("Inspect", { description: "x".repeat(900) })),
    ).join("");
    expect(Buffer.byteLength(heavyOutput)).toBeGreaterThan(2 * 1024 * 1024);
    await appendFile(file, heavyOutput);
    const summary = await readAgentActivity(agent);
    expect(summary).toContain("Keep this early update");
    expect(summary).toContain("(×3000)");
  });

  it("prefers the full Antigravity transcript and falls back to the compact transcript", async () => {
    const fullSession = "agy-full-session";
    const compactRow = {
      type: "PLANNER_RESPONSE",
      content: "",
      tool_calls: [],
      truncated_fields: ["content", "tool_calls"],
    };
    await agyTranscript(context.root, fullSession, "transcript.jsonl", [compactRow]);
    await agyTranscript(context.root, fullSession, "transcript_full.jsonl", [
      { type: "PLANNER_RESPONSE", content: "Full transcript commentary", tool_calls: [] },
    ]);
    expect(await readAgentActivity({ activitySource: agySource(context.root, fullSession) })).toBe(
      "Full transcript commentary",
    );

    const fallbackSession = "agy-fallback-session";
    await agyTranscript(context.root, fallbackSession, "transcript.jsonl", [
      { type: "PLANNER_RESPONSE", content: "Compact fallback commentary", tool_calls: [] },
    ]);
    expect(
      await readAgentActivity({ activitySource: agySource(context.root, fallbackSession) }),
    ).toBe("Compact fallback commentary");
  });

  it("reads OpenCode assistant parts read-only and refreshes on part time_updated changes", async () => {
    const dbPath = path.join(context.root, "opencode.db");
    const session = "opencode-session";
    createOpenCodeDb(dbPath, session);
    const agent = {
      activitySource: { engine: "opencode", session, opencodeDbPath: dbPath },
    };

    expect(await readAgentActivity(agent)).toBe(
      "OpenCode is inspecting the report\nUsed Read · report.md (×2)",
    );

    const database = new DatabaseSync(dbPath);
    database
      .prepare("UPDATE part SET data = ?, time_updated = 5 WHERE id = ?")
      .run(
        JSON.stringify({ type: "text", text: "OpenCode refreshed the activity" }),
        "assistant-text",
      );
    database.close();
    expect(await readAgentActivity(agent)).toBe(
      "OpenCode refreshed the activity\nUsed Read · report.md (×2)",
    );

    const verify = new DatabaseSync(dbPath, { readOnly: true });
    expect(verify.prepare("SELECT COUNT(*) AS count FROM part").get().count).toBe(4);
    verify.close();
  });

  it("streams latest OpenCode parts past 600 parts and detects same-millisecond updates", async () => {
    const dbPath = path.join(context.root, "opencode-long.db");
    const session = "opencode-long-session";
    createOpenCodeDb(dbPath, session);
    const agent = {
      activitySource: { engine: "opencode", session, opencodeDbPath: dbPath },
    };

    const database = new DatabaseSync(dbPath);
    const insertMessage = database.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)");
    const insertPart = database.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)");
    for (let index = 0; index < 210; index++) {
      insertMessage.run(
        `msg-${String(index).padStart(4, "0")}`,
        session,
        10 + index,
        10 + index,
        JSON.stringify({ role: "assistant" }),
      );
    }
    const latestMessageId = "msg-0209";
    for (let index = 0; index < 650; index++) {
      insertPart.run(
        `part-${String(index).padStart(4, "0")}`,
        latestMessageId,
        session,
        1000 + index,
        2000,
        JSON.stringify({
          type: "tool",
          tool: "Bash",
          state: { input: { description: `step-${index}` } },
        }),
      );
    }
    database.close();

    const firstRead = await readAgentActivity(agent);
    expect(firstRead).toContain("OpenCode is inspecting the report");
    expect(firstRead).toContain("Used Bash · step-649");

    const sameMillisecond = new DatabaseSync(dbPath);
    sameMillisecond
      .prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)")
      .run(
        "part-0650",
        latestMessageId,
        session,
        1650,
        2000,
        JSON.stringify({ type: "text", text: "Completed final step in same millisecond" }),
      );
    sameMillisecond.close();

    const secondRead = await readAgentActivity(agent);
    expect(secondRead).toContain("Completed final step in same millisecond");
  });

  it("resolves OpenCode data from XDG_DATA_HOME and accountHome", async () => {
    const session = "opencode-path-session";
    const xdgDataHome = path.join(context.root, "xdg-data");
    const xdgDb = path.join(xdgDataHome, "opencode", "opencode.db");
    await mkdir(path.dirname(xdgDb), { recursive: true });
    createOpenCodeDb(xdgDb, session);
    vi.stubEnv("XDG_DATA_HOME", xdgDataHome);
    expect(await readAgentActivity({ activitySource: { engine: "opencode", session } })).toContain(
      "OpenCode is inspecting the report",
    );

    resetActivityCursorCache();
    vi.stubEnv("XDG_DATA_HOME", "");
    const accountHome = path.join(context.root, "account");
    const accountDb = path.join(accountHome, ".local", "share", "opencode", "opencode.db");
    await mkdir(path.dirname(accountDb), { recursive: true });
    createOpenCodeDb(accountDb, session);
    expect(
      await readAgentActivity({ activitySource: { engine: "opencode", session, accountHome } }),
    ).toContain("OpenCode is inspecting the report");
  });
});
