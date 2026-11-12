import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  readDelegatedRunTail,
  summarizeRunOutput,
} from "../../../plugins/orchestrate/lib/run-activity.mjs";

const directories = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function directory() {
  const prefix = path.join(tmpdir(), "run-activity-");
  const dir = await realpath(await mkdtemp(prefix));
  directories.push(dir);
  return dir;
}

const event = (item, type = "item.completed") => JSON.stringify({ type, item });

describe("summarizeRunOutput", () => {
  it("turns Codex events into short readable lines", () => {
    const text = [
      JSON.stringify({ type: "thread.started", thread_id: "t" }),
      event({ type: "agent_message", text: "Reading the cohort files.\nThen comparing." }),
      event({
        type: "command_execution",
        command: `/bin/bash -lc "rg -n cohort tools/gen.py"`,
        exit_code: 0,
      }),
      event({ type: "command_execution", command: "pytest -q", exit_code: 1 }),
      event(
        {
          type: "file_change",
          changes: ["a/one.py", "a/two.py", "a/three.py", "a/four.py"].map((file) => ({
            path: `/repo/${file}`,
          })),
        },
        "item.completed",
      ),
      event({ type: "command_execution", command: "ignored" }, "item.started"),
    ].join("\n");
    expect(summarizeRunOutput(text)).toEqual([
      "Reading the cohort files.",
      "$ rg -n cohort tools/gen.py",
      "$ (exit 1) pytest -q",
      "edited one.py, two.py, three.py +1 more",
    ]);
  });

  it("keeps plain text, drops a cut-off JSON line and bounds length and count", () => {
    const text = [
      '{"type":"item.comp',
      `\u{1B}[32m${"x".repeat(400)}\u{1B}[0m`,
      ...Array.from({ length: 30 }, (_, index) => `line ${index}`),
    ].join("\n");
    const lines = summarizeRunOutput(text);
    expect(lines).toHaveLength(12);
    expect(lines.at(-1)).toBe("line 29");
    expect(summarizeRunOutput(`\u{1B}[32m${"x".repeat(400)}\u{1B}[0m`)[0]).toHaveLength(160);
  });
});

describe("readDelegatedRunTail", () => {
  async function runFixture(runId = "run-a") {
    const root = await directory();
    const outDir = await directory();
    await mkdir(path.join(root, "peers"), { recursive: true });
    await writeFile(
      path.join(root, "peers", `run-${runId}-worker.json`),
      JSON.stringify({ resultPath: path.join(outDir, "result.json") }),
    );
    return { root, outDir };
  }

  it("reads the end of stdout.txt from the directory the run record names", async () => {
    const { root, outDir } = await runFixture();
    await writeFile(
      path.join(outDir, "stdout.txt"),
      `${event({ type: "agent_message", text: "Working" })}\n`,
    );
    expect(await readDelegatedRunTail(root, "run-a")).toEqual(["Working"]);
  });

  it("returns nothing for unknown runs, odd ids, relative paths and symlinked output", async () => {
    const { root, outDir } = await runFixture();
    expect(await readDelegatedRunTail(root, "missing")).toEqual([]);
    expect(await readDelegatedRunTail(root, "../peers/x")).toEqual([]);
    expect(await readDelegatedRunTail(root)).toEqual([]);
    await writeFile(path.join(root, "secret.txt"), "secret\n");
    await symlink(path.join(root, "secret.txt"), path.join(outDir, "stdout.txt"));
    expect(await readDelegatedRunTail(root, "run-a")).toEqual([]);
    await writeFile(
      path.join(root, "peers", "run-rel-worker.json"),
      JSON.stringify({ resultPath: "relative/result.json" }),
    );
    expect(await readDelegatedRunTail(root, "rel")).toEqual([]);
  });
});
