import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { roomsCommand } from "../../../plugins/orchestrate/bin/rooms.mjs";
import {
  mapDiffLines,
  markText,
  MAX_MARK_TEXT,
  readDiffMarks,
  writeDiffMarks,
} from "../../../plugins/orchestrate/lib/diff-marks.mjs";
import { parseTeam, updateRoom } from "../../../plugins/orchestrate/lib/horde-room.mjs";
import { HordeView } from "../../../plugins/orchestrate/lib/horde-view.mjs";
import { newRoom } from "../../../plugins/orchestrate/lib/rooms.mjs";

const directories = [];

async function directory() {
  const value = await mkdtemp(path.join(tmpdir(), "ork-diff-marks-"));
  directories.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((value) => rm(value, { recursive: true, force: true })),
  );
});

const multiFileDiff = [
  "diff --git a/src/main.mjs b/src/main.mjs",
  "index 1111111..2222222 100644",
  "--- a/src/main.mjs",
  "+++ b/src/main.mjs",
  "@@ -1,3 +1,4 @@",
  " keep this line",
  "-remove this line",
  "+add this line",
  "+add another line",
  "diff --git a/new.mjs b/new.mjs",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/new.mjs",
  "@@ -0,0 +1,2 @@",
  "+new file first line",
  "+new file second line",
  "diff --git a/old.mjs b/old.mjs",
  "deleted file mode 100644",
  "--- a/old.mjs",
  "+++ /dev/null",
  "@@ -2,2 +0,0 @@",
  "-deleted first line",
  "-deleted second line",
].join("\n");

function mappedLine(file, kind, line) {
  return mapDiffLines(multiFileDiff).find(
    (entry) =>
      entry.file === file &&
      entry.kind === kind &&
      entry[`${kind === "removed" ? "old" : "new"}Line`] === line,
  );
}

function previewView({
  text = multiFileDiff,
  height = 24,
  color = false,
  tier = "ascii",
  onMarks,
} = {}) {
  const view = new HordeView(
    {
      id: "marks-room",
      cwd: "/workspace/project",
      conductor: { id: "conductor", status: "idle" },
      agents: [
        {
          id: "worker-1",
          name: "Worker",
          status: "completed",
          resultPath: "/tmp/result.json",
        },
      ],
    },
    { height, now: () => 0, color, tier, onMarks },
  );
  view.setPreview({
    agentId: "worker-1",
    title: "Worker",
    kind: "diff",
    loading: false,
    available: true,
    stale: false,
    files: [],
    marks: [],
    text,
  });
  return view;
}

describe("diff line marks", () => {
  it("maps additions, removals, context, new files, and deleted files", () => {
    expect(mappedLine("src/main.mjs", "context", 1)).toMatchObject({
      file: "src/main.mjs",
      newLine: 1,
      oldLine: 1,
      kind: "context",
    });
    expect(mappedLine("src/main.mjs", "removed", 2)).toMatchObject({
      file: "src/main.mjs",
      newLine: null,
      oldLine: 2,
      kind: "removed",
    });
    expect(mappedLine("src/main.mjs", "added", 2)).toMatchObject({
      file: "src/main.mjs",
      newLine: 2,
      oldLine: null,
      kind: "added",
    });
    expect(mappedLine("new.mjs", "added", 1)).toMatchObject({
      file: "new.mjs",
      newLine: 1,
      oldLine: null,
      kind: "added",
    });
    expect(mappedLine("old.mjs", "removed", 3)).toMatchObject({
      file: "old.mjs",
      newLine: null,
      oldLine: 3,
      kind: "removed",
    });
    expect(mapDiffLines(multiFileDiff)[0]).toMatchObject({ kind: "meta", file: null });
  });

  it("decodes Git quoted UTF-8 paths", () => {
    const diff = String.raw`diff --git "a/src/fo\303\251.mjs" "b/src/fo\303\251.mjs"
--- "a/src/fo\303\251.mjs"
+++ "b/src/fo\303\251.mjs"
@@ -1 +1 @@
-old
+new`;
    expect(mapDiffLines(diff).at(-1)).toMatchObject({
      file: "src/foé.mjs",
      newLine: 1,
      kind: "added",
    });
  });

  it("moves the cursor by diff line and keeps cursor scrolling within preview bounds", () => {
    const text = [
      "diff --git a/src/main.mjs b/src/main.mjs",
      "--- a/src/main.mjs",
      "+++ b/src/main.mjs",
      "@@ -1,50 +1,50 @@",
      ...Array.from({ length: 50 }, (_, index) => ` line ${index + 1}`),
    ].join("\n");
    const view = previewView({ text, height: 12 });
    view.render(60);
    expect(view.diffCursor).toBe(0);
    expect(view.handleInput("j")).toBe(true);
    expect(view.diffCursor).toBe(1);
    expect(view.handleInput("\u{1B}[B")).toBe(true);
    expect(view.diffCursor).toBe(2);
    for (let index = 0; index < 100; index++) view.handleInput("j");
    const lineCount = mapDiffLines(text).length;
    expect(view.diffCursor).toBe(lineCount - 1);
    const finalOffset = view.previewOffset;
    expect(finalOffset).toBeGreaterThanOrEqual(0);
    expect(finalOffset).toBeLessThanOrEqual(
      view.diffPreviewMetrics.rowCount - view.diffPreviewMetrics.budget,
    );
    expect(view.handleInput("k")).toBe(true);
    expect(view.diffCursor).toBe(lineCount - 2);
    view.handleInput("\u{1B}[5~");
    expect(view.previewOffset).toBeGreaterThanOrEqual(0);
    expect(view.previewOffset).toBeLessThanOrEqual(
      view.diffPreviewMetrics.rowCount - view.diffPreviewMetrics.budget,
    );
    view.handleInput("\u{1B}[6~");
    expect(view.previewOffset).toBeGreaterThanOrEqual(0);
    expect(view.previewOffset).toBeLessThanOrEqual(
      view.diffPreviewMetrics.rowCount - view.diffPreviewMetrics.budget,
    );

    const crowded = previewView({ text, height: 12 });
    crowded.preview.files = Array.from({ length: 30 }, (_, index) => ({
      path: `src/file-${index}.mjs`,
      added: 1,
      removed: 0,
    }));
    crowded.render(60);
    const cursorRow = crowded.diffCursorRows.get(crowded.diffCursor);
    const start = Math.max(
      0,
      crowded.diffPreviewMetrics.rowCount -
        crowded.previewOffset -
        crowded.diffPreviewMetrics.budget,
    );
    const end = Math.max(0, crowded.diffPreviewMetrics.rowCount - crowded.previewOffset);
    expect(cursorRow).toBeGreaterThanOrEqual(start);
    expect(cursorRow).toBeLessThan(end);
  });

  it("toggles a mark under the cursor and clears all member marks", () => {
    const onMarks = vi.fn();
    const view = previewView({ onMarks });
    const lineIndex = mapDiffLines(multiFileDiff).findIndex(
      (entry) => entry.file === "new.mjs" && entry.kind === "added",
    );
    view.diffCursor = lineIndex;
    expect(view.handleInput("x")).toBe(true);
    expect(view.preview.marks).toEqual([
      { file: "new.mjs", line: 1, side: "new", text: "new file first line" },
    ]);
    expect(onMarks).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "worker-1" }),
      view.preview.marks,
    );
    expect(view.handleInput("x")).toBe(true);
    expect(view.preview.marks).toEqual([]);
    view.handleInput("x");
    view.handleInput("X");
    expect(view.preview.marks).toEqual([]);
    expect(onMarks).toHaveBeenLastCalledWith(expect.anything(), []);
  });

  it("ignores metadata lines and protects stale marks until they are cleared", () => {
    const onMarks = vi.fn();
    const view = previewView({ onMarks });
    view.diffCursor = 3;
    expect(view.handleInput("x")).toBe(false);
    expect(onMarks).not.toHaveBeenCalled();
    const lineIndex = mapDiffLines(multiFileDiff).findIndex(
      (entry) => entry.file === "new.mjs" && entry.kind === "added",
    );
    view.diffCursor = lineIndex;
    view.preview = {
      ...view.preview,
      marks: [{ file: "old.mjs", line: 3, side: "old", text: "deleted first line" }],
      marksStale: true,
    };
    expect(view.handleInput("x")).toBe(true);
    expect(view.preview.marks).toHaveLength(1);
    expect(view.notice).toContain("press X to clear");
    expect(onMarks).not.toHaveBeenCalled();
    expect(view.handleInput("X")).toBe(true);
    expect(view.preview.marks).toEqual([]);
    expect(onMarks).toHaveBeenCalledWith(expect.anything(), []);
  });

  it("persists marks atomically and detects a changed result fingerprint", async () => {
    const root = await directory();
    const canonicalRoot = await realpath(root);
    const resultPath = path.join(canonicalRoot, "result.json");
    await writeFile(resultPath, JSON.stringify({ git_after: { fingerprint: "fingerprint-a" } }));
    const member = { id: "worker-1", resultPath: await realpath(resultPath) };
    const marks = [{ file: "src/main.mjs", line: 2, side: "new", text: "add this line" }];
    const record = await writeDiffMarks("marks-room", member, marks, {
      root: canonicalRoot,
      now: () => 0,
    });
    expect(record).toMatchObject({
      member: "worker-1",
      resultPath: await realpath(resultPath),
      fingerprint: "fingerprint-a",
      marks,
    });
    expect(record.updatedAt).toBe("1970-01-01T00:00:00.000Z");
    const loaded = await readDiffMarks("marks-room", member, {
      root: canonicalRoot,
      fingerprint: "fingerprint-a",
    });
    expect(loaded).toMatchObject({ marks, stale: false, available: true });
    const file = path.join(canonicalRoot, "diff-marks", "marks-room", "worker-1.json");
    expect(JSON.parse(await readFile(file, "utf8")).resultPath).toBe(await realpath(resultPath));
    const stale = await readDiffMarks("marks-room", member, {
      root: canonicalRoot,
      fingerprint: "fingerprint-b",
    });
    expect(stale).toMatchObject({ marks, stale: true });
  });

  it("prints member marks and stale state through the room command", async () => {
    const root = await directory();
    const resultPath = path.join(root, "result.json");
    await writeFile(resultPath, JSON.stringify({ git_after: { fingerprint: "fingerprint-a" } }));
    let room = await newRoom(parseTeam("codex:luna:max"), {
      id: "marks-room",
      cwd: root,
      root,
    });
    const memberId = room.agents[0].id;
    // The result path is not stored on the member: it is found by observing the member's recorded
    // run, as in real use.
    const taskDir = path.join(root, "task");
    const dispatch = { taskDir, taskId: "task-1", requestId: "request-1", runId: "run-1" };
    room = await updateRoom(
      room.id,
      (current) => {
        current.agents[0].dispatch = { ...dispatch, transport: "executor" };
        return current;
      },
      { root },
    );
    const run = async (args) => {
      if (args[0] !== "show") throw new Error(`Unexpected coordinator command: ${args.join(" ")}`);
      return {
        schema: "agent-executor.task.v1",
        task_id: dispatch.taskId,
        repository: root,
        task_spec: { objective: "Marked work" },
        runs: [
          {
            run_id: dispatch.runId,
            request_id: dispatch.requestId,
            engine: "codex",
            model: "gpt-test-model",
            transport: "executor",
            status: "finished",
            runner_status: "completed",
            result_path: resultPath,
            task_spec: { objective: "Marked work" },
          },
        ],
        decisions: [],
        updated_at: "2026-11-10T00:00:00.000Z",
      };
    };
    const output = async (args = [], selectedMember = memberId) => {
      let text = "";
      await roomsCommand(["marks", "--room", room.id, "--member", selectedMember, ...args], {
        root,
        run,
        stdout: { write: (value) => (text += value) },
      });
      return text;
    };
    expect(await output()).toContain("[]");
    expect(await output([], "conductor")).toContain("[]");
    await writeDiffMarks(
      room.id,
      { ...room.agents[0], resultPath },
      [{ file: "src/main.mjs", line: 2, side: "new", text: "add this line" }],
      { root, now: () => 0 },
    );
    const text = await output();
    expect(text).toContain("stale: false");
    expect(text).toContain("src/main.mjs:2 add this line");
    await writeFile(resultPath, JSON.stringify({ git_after: { fingerprint: "fingerprint-b" } }));
    const json = JSON.parse(await output(["--json"]));
    expect(json).toMatchObject({
      member: memberId,
      stale: true,
      marks: [{ file: "src/main.mjs", line: 2, side: "new", text: "add this line" }],
    });
  });

  it("renders cursor and marks with ASCII gutter glyphs when color is disabled", () => {
    const view = previewView({ color: false, tier: "ascii", height: 40 });
    const lineIndex = mapDiffLines(multiFileDiff).findIndex(
      (entry) => entry.file === "src/main.mjs" && entry.kind === "added",
    );
    view.preview.marks = [{ file: "src/main.mjs", line: 2, side: "new", text: "add this line" }];
    view.diffCursor = lineIndex;
    const rendered = view.render(80).join("\n");
    expect(rendered).toContain(">* +add this line");
    expect(rendered).toContain("1 marked");
    expect(rendered).not.toContain("\u{1B}[");
  });

  it("leaves mark and cursor keys unused outside a diff preview", () => {
    const view = previewView();
    view.setPreview(null);
    for (const key of ["j", "k", "x", "X"]) expect(view.handleInput(key)).toBe(false);
  });
  it("caps a marked line's saved text and refuses stored marks that exceed the cap", async () => {
    const long = `+${"x".repeat(5000)}`;
    const text = markText(long.slice(1));
    expect(text.length).toBe(MAX_MARK_TEXT);
    expect(text.endsWith("…")).toBe(true);
    expect(markText("a\r\nb")).toBe("a b");
    const root = await directory();
    const member = { id: "member-1" };
    await expect(
      writeDiffMarks(
        "marks-room",
        member,
        [{ file: "a.txt", line: 1, side: "new", text: "x".repeat(MAX_MARK_TEXT + 1) }],
        { root },
      ),
    ).rejects.toThrow(/safe file/u);
  });
});
