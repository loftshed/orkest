import { appendFile, mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { readAudit } = vi.hoisted(() => ({ readAudit: [] }));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, homedir: vi.fn(actual.homedir) };
});

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
  vi.mocked(homedir).mockReturnValue(context.root);
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

function codexCustomTool(name, input) {
  return { type: "response_item", payload: { type: "custom_tool_call", name, input } };
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
  it.each([
    ['await tools.exec_command({cmd: "git status --short"})', "git status --short"],
    ["await tools.exec_command({cmd: 'git diff --stat'})", "git diff --stat"],
    ["await tools.exec_command({cmd: `git log -1`})", "git log -1"],
    [String.raw`await tools.exec_command({"cmd":"echo \"ready\""})`, 'echo "ready"'],
    [JSON.stringify({ cmd: "git branch --show-current" }), "git branch --show-current"],
  ])("extracts shell commands from Codex custom tool input %s", async (input, command) => {
    await codexTranscript(
      context.root,
      "custom-exec",
      jsonl(codexCustomTool("functions.exec", input)),
    );
    expect(
      await readAgentActivity({ activitySource: codexSource(context.root, "custom-exec") }),
    ).toBe(`Used functions.exec · ${command}`);
  });

  it("shows file paths from custom patch input", async () => {
    const patch =
      "*** Begin Patch\n*** Update File: src/view.mjs\n@@\n-old\n+new\n*** Add File: docs/view.md\n+Example\n*** Delete File: old.txt\n*** End Patch";
    await codexTranscript(
      context.root,
      "custom-patch",
      jsonl(codexCustomTool("apply_patch", patch)),
    );
    expect(
      await readAgentActivity({ activitySource: codexSource(context.root, "custom-patch") }),
    ).toBe("Used apply_patch · src/view.mjs, docs/view.md, old.txt");
  });

  it("caps custom tool details without merging different raw inputs", async () => {
    const prefix = `echo ${"x".repeat(235)}`;
    const first = codexCustomTool(
      "functions.exec",
      `await tools.exec_command({cmd: "${prefix}first"})`,
    );
    const second = codexCustomTool(
      "functions.exec",
      `await tools.exec_command({cmd: "${prefix}second"})`,
    );
    await codexTranscript(context.root, "custom-long", jsonl(first, first, second));
    expect(
      await readAgentActivity({ activitySource: codexSource(context.root, "custom-long") }),
    ).toBe(`Used functions.exec · ${prefix}… (×2)\nUsed functions.exec · ${prefix}…`);
  });

  it.each(["description", "path", "pattern", "subject", "cmd"])(
    "caps structured %s tool details",
    async (field) => {
      const detail = "x".repeat(300);
      await codexTranscript(
        context.root,
        "long-detail",
        jsonl(codexTool("inspect", { [field]: detail })),
      );
      expect(
        await readAgentActivity({ activitySource: codexSource(context.root, "long-detail") }),
      ).toBe(`Used inspect · ${"x".repeat(240)}…`);
    },
  );

  it("removes memory citations from assistant messages and reports", async () => {
    const citation =
      "<oai-mem-citation>\n<citation_entries>\nnotes.md:1-2\n</citation_entries>\n</oai-mem-citation>";
    await codexTranscript(
      context.root,
      "citations",
      jsonl(codexText(`Visible update.\n${citation}`), codexText(citation)),
    );
    expect(
      await readAgentActivity({
        activitySource: codexSource(context.root, "citations"),
        answer: `Done.\n${citation}`,
      }),
    ).toBe("Recent activity:\nVisible update.\n\nResponse:\nDone.");
  });

  it.each(["objective", "progress", "question"])(
    "preserves long task descriptions from %s up to 4000 characters",
    async (field) => {
      const task = `Review this plan:\n${"detail ".repeat(100)}`;
      const agent = (text) => ({
        [field]: field === "progress" ? { task: text } : text,
        answer: "Done.",
      });
      expect(await readAgentActivity(agent(task))).toBe(`Task: ${task.trim()}\n\nResponse:\nDone.`);
      const overlongTask = "x".repeat(4100);
      expect(await readAgentActivity(agent(overlongTask))).toBe(
        `Task: ${"x".repeat(4000)}…\n\nResponse:\nDone.`,
      );
    },
  );

  it.each(["codex", "claude", "agy"])(
    "loads %s session activity using result metadata and its default account directory",
    async (engine) => {
      const session = "result-session";
      const cwd = "/workspace/project";
      if (engine === "codex") {
        await codexTranscript(
          path.join(context.root, ".codex"),
          session,
          jsonl(codexText("Recovered update.")),
        );
      } else if (engine === "claude") {
        const directory = path.join(context.root, ".claude", "projects", "-workspace-project");
        await mkdir(directory, { recursive: true });
        await writeFile(
          path.join(directory, `${session}.jsonl`),
          jsonl({
            type: "assistant",
            message: { content: [{ type: "text", text: "Recovered update." }] },
          }),
        );
      } else {
        await agyTranscript(path.join(context.root, ".gemini"), session, "transcript_full.jsonl", [
          { type: "PLANNER_RESPONSE", content: "Recovered update." },
        ]);
      }
      const resultPath = path.join(context.root, "result.json");
      await writeFile(
        resultPath,
        JSON.stringify({
          engine,
          session_id: session,
          started_at: "2026-11-05T12:00:00.000Z",
          repository: cwd,
          final_message: "Finished report.",
        }),
      );
      expect(await readAgentActivity({ resultPath })).toBe(
        "Recent activity:\nRecovered update.\n\nResponse:\nFinished report.",
      );
      await codexTranscript(
        context.root,
        "explicit-source",
        jsonl(codexText("Explicit source wins.")),
      );
      expect(
        await readAgentActivity({
          resultPath,
          activitySource: codexSource(context.root, "explicit-source"),
        }),
      ).toBe("Recent activity:\nExplicit source wins.\n\nResponse:\nFinished report.");
    },
  );

  it("recovers full reports from explicit artifacts and truncated-summary siblings", async () => {
    const answer = `${"Detailed finding. ".repeat(600)}Final conclusion.\n\n\u{60}\u{60}\u{60}js\nif (ready) {\n  run();\n}\n\u{60}\u{60}\u{60}`;
    const resultPath = path.join(context.root, "result.json");
    const fullPath = path.join(context.root, "report.txt");
    await writeFile(fullPath, answer);
    await writeFile(
      resultPath,
      JSON.stringify({ final_message: "Short summary", final_output_path: fullPath }),
    );
    expect(await readAgentActivity({ resultPath })).toBe(`Response:\n${answer}`);
    await writeFile(path.join(context.root, "final-output.txt"), answer);
    await writeFile(
      resultPath,
      JSON.stringify({
        final_message: "Start [truncated; complete report is in the raw artifacts] end",
      }),
    );
    expect(await readAgentActivity({ resultPath })).toBe(`Response:\n${answer}`);
    await writeFile(
      resultPath,
      JSON.stringify({ final_message: "Summary survives", final_output_path: "missing.txt" }),
    );
    expect(await readAgentActivity({ resultPath })).toBe("Response:\nSummary survives");
  });

  it("keeps long updates and messages and marks the extreme response ceiling", async () => {
    const update = `Start ${"detail ".repeat(500)}update end`;
    await codexTranscript(context.root, "long-text", jsonl(codexText(update)));
    const text = await readAgentActivity({
      activitySource: codexSource(context.root, "long-text"),
      answer: "a".repeat(33_000),
      messages: [{ text: update }],
    });
    expect(text).toContain(`Messages to orchestrator:\n• ${update}`);
    expect(text).toContain(`Recent activity:\n${update}`);
    expect(text).toContain(`Response:\n${"a".repeat(32_000)}…`);
  });

  it("keeps distinct long commands, orders actions before the response, and reports overflow", async () => {
    const prefix = `echo ${"shared-prefix-".repeat(12)}`;
    const first = codexTool("Bash", { command: `${prefix}first` });
    const second = codexTool("Bash", { command: `${prefix}second` });
    const file = await codexTranscript(context.root, "long-actions", jsonl(first, second));
    const agent = {
      activitySource: codexSource(context.root, "long-actions"),
      answer: "Final response",
    };
    expect(await readAgentActivity(agent)).toBe(
      `Recent activity:\nUsed Bash · ${prefix}first\nUsed Bash · ${prefix}second\n\nResponse:\nFinal response`,
    );
    const actions = Array.from({ length: 130 }, (_, i) =>
      codexTool("Bash", { command: `echo action-${i}` }),
    );
    await appendFile(file, jsonl(...actions));
    const text = await readAgentActivity(agent);
    expect(text).toContain("… 12 earlier actions omitted");
    expect(text).toContain("Used Bash · echo action-10\nUsed Bash · echo action-11");
    expect(text).toContain("Used Bash · echo action-129\n\nResponse:\nFinal response");
  });

  it("does not collapse different commands that share a description", async () => {
    await codexTranscript(
      context.root,
      "described-actions",
      jsonl(
        codexTool("Bash", { description: "Check files", command: "cat first.txt" }),
        codexTool("Bash", { description: "Check files", command: "cat second.txt" }),
      ),
    );
    expect(
      await readAgentActivity({ activitySource: codexSource(context.root, "described-actions") }),
    ).toBe("Used Bash · Check files\nUsed Bash · Check files");
  });

  it("retains chronological order when old commentary is pinned around retained tools", async () => {
    const rows = [
      codexText("Opening update"),
      ...Array.from({ length: 140 }, (_, i) =>
        i === 50 ? codexText("Middle update") : codexTool("Bash", { command: `echo action-${i}` }),
      ),
    ];
    await codexTranscript(context.root, "ordered-actions", jsonl(...rows));
    const text = await readAgentActivity({
      activitySource: codexSource(context.root, "ordered-actions"),
    });
    expect(text).toContain("Opening update\nUsed Bash · echo action-20");
    expect(text).toContain("Used Bash · echo action-49\nMiddle update\nUsed Bash · echo action-51");
  });

  it("reads a complete final JSONL record without a newline exactly once", async () => {
    const file = await codexTranscript(
      context.root,
      "no-newline",
      JSON.stringify(codexText("Final record")),
    );
    const agent = { activitySource: codexSource(context.root, "no-newline") };
    expect(await readAgentActivity(agent)).toBe("Final record");
    expect(await readAgentActivity(agent)).toBe("Final record");
    await appendFile(file, `\n${jsonl(codexText("Next record"))}`);
    expect(await readAgentActivity(agent)).toBe("Final record\nNext record");
  });

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
