import { execFile, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import {
  ansiToSvg,
  compareCaptures,
  runVisualRegression,
  VISUAL_CASES,
} from "../../scripts/lib/tui-visual.js";

const execute = promisify(execFile);
const directories = [];
const hasTmux = spawnSync("tmux", ["-V"]).status === 0;
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture({ mutate = false } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "visual-test-"));
  directories.push(directory);
  const repo = path.join(directory, "repo");
  await mkdir(path.join(repo, "plugins/orchestrate/lib"), { recursive: true });
  await mkdir(path.join(repo, "plugins/monitor/lib"), { recursive: true });
  await writeFile(path.join(repo, "plugins/monitor/lib/fixture.mjs"), "export {};\n");
  const renderer = path.join(repo, "plugins/orchestrate/lib/horde-view.mjs");
  const source = (text) =>
    String.raw`import {appendFileSync} from 'node:fs'; export class HordeView { constructor(){} handleInput(){} render(){${mutate ? String.raw`appendFileSync(new URL(import.meta.url),'// changed during capture\n');` : ""}return ['\u001b[36m${text}\u001b[0m'];} }`.replaceAll(
      String.raw`\u001b`,
      "\u{1B}",
    );
  await writeFile(renderer, source("Historical view"));
  await execute("git", ["init", "--quiet"], { cwd: repo });
  await execute("git", ["add", "."], { cwd: repo });
  await execute(
    "git",
    [
      "-c",
      "user.name=Visual test",
      "-c",
      "user.email=visual@example.invalid",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ],
    { cwd: repo },
  );
  const commit = (await execute("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
  return {
    directory,
    repo,
    renderer,
    source,
    commit,
    output: path.join(directory, "output"),
    baseline: path.join(directory, "baseline"),
  };
}

it("renders escaped terminal cells with captured colors, inverse backgrounds and fixed dimensions", () => {
  const svg = ansiToSvg("\u{1B}[31m<agent>&\u{1B}[0m\n\u{1B}[7m界\u{1B}[0m", {
    name: 'safe "capture"',
    cols: 12,
    rows: 2,
    palette: "dark",
  });
  expect(svg).toContain('width="136" height="56"');
  expect(svg).toContain("&lt;agent&gt;&amp;");
  expect(svg).toContain('fill="#c62828"');
  expect(svg).toContain('width="20" height="20" fill="#e6e8ee"');
  expect(svg).toContain('aria-label="safe &quot;capture&quot; terminal capture"');
});

it("compares cell content and dimensions without treating source metadata as a visual change", () => {
  const before = {
    status: "captured",
    cols: 48,
    rows: 32,
    ansi: "\u{1B}[31mAgent",
    source: { commit: "first" },
  };
  expect(compareCaptures(before, { ...before, source: { commit: "second" } })).toBe("same");
  expect(compareCaptures(before, { ...before, ansi: "\u{1B}[32mAgent" })).toBe("changed");
  expect(compareCaptures(before, { ...before, cols: 80 })).toBe("changed");
  expect(compareCaptures(null, before)).toBe("missing-baseline");
  expect(compareCaptures({ status: "unsupported" }, before)).toBe("unsupported");
});

describe.skipIf(!hasTmux)("private native terminal captures", () => {
  it("captures the actual archived base and dirty current source without changing the checkout", async () => {
    const { repo, renderer, source, commit, output } = await fixture();
    const current = source("Current view");
    await writeFile(renderer, current);
    const result = await runVisualRegression({
      repo,
      output,
      baseRef: "HEAD",
      cases: [VISUAL_CASES[0], VISUAL_CASES[5]],
    });
    expect(result.failed).toBe(false);
    expect(result.cases).toEqual([
      { name: "overview-dark-48", status: "changed" },
      { name: "preview-dark-160", status: "unsupported" },
    ]);
    const before = JSON.parse(
      await readFile(path.join(output, "before/overview-dark-48.json"), "utf8"),
    );
    const after = JSON.parse(
      await readFile(path.join(output, "after/overview-dark-48.json"), "utf8"),
    );
    expect(before.ansi).toContain("Historical view");
    expect(after.ansi).toContain("Current view");
    expect(before.source).toMatchObject({ ref: "HEAD", commit, dirty: false });
    expect(after.source).toMatchObject({ ref: "working-tree", commit, dirty: true });
    expect(after.runtime).toMatchObject({ node: process.versions.node });
    expect(after.runtime.tmux).toMatch(/^tmux /u);
    expect(await readFile(renderer, "utf8")).toBe(current);
    expect(await readFile(path.join(output, "report.html"), "utf8")).toContain(
      "not native-window pixel screenshots",
    );
  });

  it("requires explicit baseline updates and fails a saved baseline mismatch", async () => {
    const { repo, renderer, source, output, baseline } = await fixture();
    const options = { repo, output, baseline, cases: [VISUAL_CASES[0]] };
    expect((await runVisualRegression(options)).failed).toBe(true);
    await expect(readFile(path.join(baseline, "overview-dark-48.ansi"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await runVisualRegression({ ...options, update: true })).baselineUpdated).toBe(true);
    const original = await readFile(path.join(baseline, "overview-dark-48.ansi"), "utf8");
    expect((await runVisualRegression(options)).cases).toEqual([
      { name: "overview-dark-48", status: "same" },
    ]);
    await writeFile(renderer, source("Changed view"));
    expect((await runVisualRegression(options)).failed).toBe(true);
    expect(await readFile(path.join(baseline, "overview-dark-48.ansi"), "utf8")).toBe(original);
  });

  it("rejects captures when renderer source changes during the run and does not update baselines", async () => {
    const { repo, output, baseline } = await fixture({ mutate: true });
    const result = await runVisualRegression({
      repo,
      output,
      baseline,
      update: true,
      cases: [VISUAL_CASES[0]],
    });
    expect(result.failed).toBe(true);
    expect(result.baselineUpdated).toBe(false);
    expect(result.cases).toEqual([{ name: "overview-dark-48", status: "stale" }]);
    const report = JSON.parse(await readFile(path.join(output, "comparison.json"), "utf8"));
    expect(report.stale).toBe(true);
    expect(report.validation.rendererAfter).not.toBe(report.validation.rendererBefore);
    await expect(readFile(path.join(baseline, "overview-dark-48.ansi"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
