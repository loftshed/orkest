import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { readAgentActivity } from "../../../plugins/orchestrate/lib/agent-activity.mjs";
import { createAgentPreview } from "../../../plugins/orchestrate/lib/agent-preview.mjs";

function fixture({ zoomed = false, readError = false, zoomError = false } = {}) {
  const state = {
    zoomed,
    zoomWrites: [],
    snapshots: [],
    reads: [],
    held: new Map(),
    readError,
    zoomError,
  };
  const exec = (command, args, options, callback) => {
    expect(options.timeout).toBe(2500);
    queueMicrotask(() => {
      if (args[1] === "layout")
        callback(null, JSON.stringify({ result: { layout: { zoomed: state.zoomed } } }));
      else if (args[1] === "zoom") {
        if (state.zoomError) return callback(new Error("layout refused"));
        state.zoomed = args.includes("--on");
        state.zoomWrites.push(state.zoomed);
        callback(null, "{}");
      } else {
        const pane = args[1] === "read" ? args[2] : args.at(-1);
        state.reads.push({ command, args });
        if (state.held.has(pane)) state.held.set(pane, callback);
        else if (state.readError) callback(new Error("terminal closed"));
        else callback(null, `Conversation from ${pane}\nAssistant: working`);
      }
    });
  };
  const preview = createAgentPreview({
    env: { HERDR_PANE_ID: "w1:p2" },
    exec,
    onChange: (snapshot) => {
      state.snapshots.push(snapshot);
    },
  });
  return { state, preview };
}

async function until(callback) {
  for (let index = 0; index < 30 && !callback(); index++) await Promise.resolve();
  expect(callback()).toBe(true);
}

describe("agent terminal preview", () => {
  it("opens a live snapshot, refreshes it, and restores only its owned zoom", async () => {
    const { state, preview } = fixture();
    const result = await preview.open({ id: "worker-a", name: "Worker A", herdrPaneId: "w1:p3" });
    expect(result).toEqual({
      agentId: "worker-a",
      title: "Worker A",
      text: "Conversation from w1:p3\nAssistant: working",
      error: "",
      kind: "terminal",
      loading: false,
    });
    expect(state.zoomed).toBe(true);
    expect(state.reads[0]).toEqual({
      command: "herdr",
      args: ["pane", "read", "w1:p3", "--source", "visible", "--lines", "200"],
    });
    expect(await preview.refresh()).toEqual(result);
    await preview.close();
    expect(state.snapshots.at(-1)).toBe(null);
    expect(state.zoomed).toBe(false);
    expect(state.zoomWrites).toEqual([true, false]);
  });

  it("preserves a layout that the user had already zoomed", async () => {
    const { state, preview } = fixture({ zoomed: true });
    expect((await preview.open({ id: "a", herdrPaneId: "w1:p3" })).text).toContain(
      "Conversation from w1:p3",
    );
    await preview.dispose();
    expect(state.zoomed).toBe(true);
    expect(state.zoomWrites).toEqual([]);
  });

  it("shows recorded activity for a worker without a terminal", async () => {
    const { state, preview } = fixture();
    expect(
      await preview.open({ id: "background", output: ["Started review", "Found two issues"] }),
    ).toEqual({
      agentId: "background",
      title: "background",
      text: "Started review\nFound two issues",
      error: "",
      kind: "activity",
      loading: false,
    });
    expect(state.reads).toEqual([]);
    await preview.close();
  });

  it("refreshes recorded activity from the latest room projection", async () => {
    const { preview } = fixture();
    await preview.open({ id: "background", output: ["Started review"] });
    const updated = await preview.refresh({ id: "background", output: ["Review complete"] });
    expect(updated.text).toBe("Review complete");
    expect(updated.kind).toBe("activity");
    await preview.close();
  });

  it("shows recent Antigravity work for a native agent without a pane", async () => {
    const accountHome = await mkdtemp(path.join(tmpdir(), "ork-activity-"));
    const session = "475c0b38-2c1d-429c-8935-60556d4e147e";
    const transcript = path.join(
      accountHome,
      "antigravity-cli",
      "brain",
      session,
      ".system_generated",
      "logs",
      "transcript.jsonl",
    );
    await mkdir(path.dirname(transcript), { recursive: true });
    await writeFile(
      transcript,
      `${JSON.stringify({ type: "PLANNER_RESPONSE", thinking: "private", tool_calls: [{ name: "view_file", args: { AbsolutePath: "/work/notes.md" } }] })}\n`,
    );
    const { preview } = fixture();
    const agent = {
      id: "native-worker",
      output: [],
      activitySource: { engine: "agy", session, accountHome },
    };
    try {
      expect((await preview.open(agent)).text).toBe("Used view_file · notes.md");
      await appendFile(
        transcript,
        `${JSON.stringify({ type: "PLANNER_RESPONSE", content: "Found the regression", tool_calls: [] })}\n`,
      );
      const refreshed = await preview.refresh(agent);
      expect(refreshed.text).toContain("Found the regression");
      expect(refreshed.text).not.toContain("private");
    } finally {
      await preview.close();
      await rm(accountHome, { recursive: true, force: true });
    }
  });

  it("reads visible Claude and Codex actions without exposing reasoning", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "ork-activity-"));
    const claudeSource = {
      engine: "claude",
      session: "subagent-a12",
      parentSession: "parent-123",
      cwd: "/work/room",
      accountHome: path.join(home, "claude"),
    };
    const claudeFile = path.join(
      claudeSource.accountHome,
      "projects",
      "-work-room",
      "parent-123",
      "subagents",
      "agent-a12.jsonl",
    );
    const codexSource = {
      engine: "codex",
      session: "codex-123",
      startedAt: "2026-11-05T12:00:00Z",
      accountHome: path.join(home, "codex"),
    };
    const codexFile = path.join(
      codexSource.accountHome,
      "sessions",
      "2026",
      "11",
      "05",
      "rollout-2026-11-05T12-00-00-codex-123.jsonl",
    );
    try {
      await mkdir(path.dirname(claudeFile), { recursive: true });
      await mkdir(path.dirname(codexFile), { recursive: true });
      await writeFile(
        claudeFile,
        `${JSON.stringify({ type: "assistant", message: { content: [{ type: "thinking", thinking: "hidden" }, { type: "tool_use", name: "Read", input: { file_path: "/work/room/report.md" } }, { type: "text", text: "Review complete" }] } })}\n`,
      );
      await writeFile(
        codexFile,
        `${JSON.stringify({ type: "response_item", payload: { type: "reasoning", summary: "hidden" } })}\n${JSON.stringify({ type: "response_item", payload: { type: "custom_tool_call", name: "functions.exec" } })}\n${JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Tests passed" }] } })}\n`,
      );
      expect(await readAgentActivity({ activitySource: claudeSource })).toBe(
        "Used Read · report.md\nReview complete",
      );
      const mainClaudeFile = path.join(
        claudeSource.accountHome,
        "projects",
        "-work-room",
        "main-123.jsonl",
      );
      await writeFile(
        mainClaudeFile,
        `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Investigating" }] } })}\n`,
      );
      expect(
        await readAgentActivity({
          activitySource: { ...claudeSource, session: "main-123" },
        }),
      ).toBe("Investigating");
      expect(await readAgentActivity({ activitySource: codexSource })).toBe(
        "Used functions.exec\nTests passed",
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("reports a self-referencing pane without capturing the preview recursively", async () => {
    const { state, preview } = fixture();
    const result = await preview.open({ id: "a", herdrPaneId: "w1:p2" });
    expect(result.error).toBe("Preview unavailable: The agent points to this preview pane");
    expect(result.loading).toBe(false);
    expect(state.reads).toEqual([]);
    await preview.close();
  });

  it("keeps a visible close error and retries owned zoom restoration on disposal", async () => {
    const { state, preview } = fixture();
    await preview.open({ id: "a", herdrPaneId: "w1:p3" });
    state.zoomError = true;
    const result = await preview.close();
    expect(result.error).toBe(
      "Could not restore split: layout refused. Close the preview again to retry.",
    );
    expect(result.text).toBe("Conversation from w1:p3\nAssistant: working");
    expect(state.zoomed).toBe(true);
    state.zoomError = false;
    expect(await preview.dispose()).toBe(null);
    expect(state.zoomed).toBe(false);
    expect(state.snapshots.at(-1)).toBe(null);
  });

  it("uses the named tmux server and sanitizes snapshot text", async () => {
    let latest;
    const preview = createAgentPreview({
      env: {},
      exec(command, args, _options, callback) {
        expect(command).toBe("tmux");
        expect(args).toEqual(["-L", "test-server", "capture-pane", "-p", "-t", "%3"]);
        callback(null, "\u{1B}[31mAssistant\u{1B}[0m\nSafe text\u{1B}]2;title\u{7}");
      },
      onChange: (value) => {
        latest = value;
      },
    });
    await preview.open({ id: "tmux-a", progress: { paneId: "%3", terminalServer: "test-server" } });
    expect(latest.text).toBe("Assistant\nSafe text");
    expect(latest.kind).toBe("terminal");
    await preview.dispose();
  });

  it("keeps the last snapshot visible when refreshing a closed terminal fails", async () => {
    const { state, preview } = fixture();
    await preview.open({ id: "a", herdrPaneId: "w1:p3" });
    state.readError = true;
    expect(await preview.refresh()).toEqual({
      agentId: "a",
      title: "a",
      text: "Conversation from w1:p3\nAssistant: working",
      error: "Preview unavailable: terminal closed",
      kind: "terminal",
      loading: false,
    });
    await preview.close();
  });

  it("still reads the conversation when expanding the layout fails", async () => {
    const { state, preview } = fixture({ zoomError: true });
    const result = await preview.open({ id: "a", herdrPaneId: "w1:p3" });
    expect(result.text).toBe("Conversation from w1:p3\nAssistant: working");
    expect(result.error).toBe("Could not expand preview: layout refused");
    await preview.close();
    expect(state.zoomed).toBe(false);
  });

  it("discards an older agent read after another agent is selected", async () => {
    const { state, preview } = fixture();
    state.held.set("w1:p3", null);
    const first = preview.open({ id: "a", herdrPaneId: "w1:p3" });
    await until(() => typeof state.held.get("w1:p3") === "function");
    await preview.open({ id: "b", herdrPaneId: "w1:p4" });
    state.held.get("w1:p3")(null, "Old conversation");
    expect(await first).toBe(null);
    expect(state.snapshots.at(-1)).toEqual({
      agentId: "b",
      title: "b",
      text: "Conversation from w1:p4\nAssistant: working",
      error: "",
      kind: "terminal",
      loading: false,
    });
    await preview.close();
  });

  it("discards a pending read when the same agent is rebound to another pane", async () => {
    const { state, preview } = fixture();
    state.held.set("w1:p3", null);
    const first = preview.open({ id: "a", herdrPaneId: "w1:p3" });
    await until(() => typeof state.held.get("w1:p3") === "function");
    const rebound = preview.refresh({ id: "a", herdrPaneId: "w1:p4" });
    state.held.get("w1:p3")(null, "Old pane conversation");
    await rebound;
    expect(await first).toBe(null);
    expect(state.snapshots.at(-1)).toEqual({
      agentId: "a",
      title: "a",
      text: "Conversation from w1:p4\nAssistant: working",
      error: "",
      kind: "terminal",
      loading: false,
    });
    await preview.close();
  });

  it("does not resurrect a closed preview when a read finishes late", async () => {
    const { state, preview } = fixture();
    state.held.set("w1:p3", null);
    const opening = preview.open({ id: "a", herdrPaneId: "w1:p3" });
    await until(() => typeof state.held.get("w1:p3") === "function");
    await preview.close();
    state.held.get("w1:p3")(null, "Late conversation");
    expect(await opening).toBe(null);
    expect(state.snapshots.at(-1)).toBe(null);
    expect(state.zoomed).toBe(false);
  });

  it("serializes a close while zoom admission is pending", async () => {
    let finishZoom;
    let isZoomed = false;
    const snapshots = [];
    const preview = createAgentPreview({
      env: { HERDR_PANE_ID: "w1:p2" },
      onChange: (value) => {
        snapshots.push(value);
      },
      exec(_command, args, _options, callback) {
        if (args[1] === "layout")
          callback(null, JSON.stringify({ result: { layout: { zoomed: isZoomed } } }));
        else if (args.includes("--on"))
          finishZoom = () => {
            isZoomed = true;
            callback(null, "{}");
          };
        else if (args.includes("--off")) {
          isZoomed = false;
          callback(null, "{}");
        } else callback(null, "Conversation");
      },
    });
    const opening = preview.open({ id: "a", herdrPaneId: "w1:p3" });
    await until(() => typeof finishZoom === "function");
    const closing = preview.close();
    finishZoom();
    expect(await opening).toBe(null);
    await closing;
    expect(isZoomed).toBe(false);
    expect(snapshots.at(-1)).toBe(null);
  });
});
