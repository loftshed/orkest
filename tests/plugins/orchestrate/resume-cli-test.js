import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";

const execute = promisify(execFile);
const temporary = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it.each([
  ["claude", ["--resume", "old-id"], ["claude", "--resume", "old-id"]],
  [
    "codex",
    ["--model", "gpt", "resume", "old-id"],
    ["codex", "--model", "gpt", "resume", "old-id"],
  ],
  [
    "agy",
    ["--harness-arg=--conversation", "--harness-arg=old-id"],
    ["agy", "--conversation", "old-id"],
  ],
  ["opencode", ["--harness-arg=-s", "--harness-arg=old-id"], ["opencode", "-s", "old-id"]],
])("ork %s routes resume before creating any room", async (engine, args, expected) => {
  const home = await mkdtemp(path.join(tmpdir(), "ork-resume-cli-"));
  temporary.push(home);
  const bin = path.join(home, "bin");
  await mkdir(bin);
  await writeFile(
    path.join(bin, "python3"),
    `#!${process.execPath}
import { writeFileSync } from "node:fs";
writeFileSync(process.env.TEST_CAPTURE, JSON.stringify(process.argv.slice(2)));
`,
    { mode: 0o700 },
  );
  const capture = path.join(home, "arguments.json");
  await execute(
    process.execPath,
    [path.resolve("plugins/orchestrate/bin/ork.mjs"), engine, "--cwd", home, ...args],
    {
      env: {
        ...process.env,
        HOME: home,
        AGENT_EXECUTOR_HOME: home,
        ORCHESTRATE_HOME: home,
        PATH: `${bin}:${process.env.PATH}`,
        TEST_CAPTURE: capture,
      },
    },
  );
  const forwarded = JSON.parse(await readFile(capture, "utf8"));
  expect(path.basename(forwarded[0])).toBe("agent_statusline_tmux.py");
  expect(forwarded.slice(1)).toEqual(["--resume-swarm", "--cwd", home, "--", ...expected]);
  expect((await readdir(home)).sort((a, b) => a.localeCompare(b))).toEqual([
    "arguments.json",
    "bin",
  ]);
});
