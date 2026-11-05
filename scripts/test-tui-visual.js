#!/usr/bin/env node
import { rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, stripVTControlCharacters } from "node:util";

import { renderFixture, runVisualRegression, VISUAL_CASES } from "./lib/tui-visual.js";

async function readyFile(file, result) {
  await writeFile(`${file}.tmp`, JSON.stringify(result));
  await rename(`${file}.tmp`, file);
}

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({
    args,
    options: {
      "base-ref": { type: "string" },
      baseline: { type: "string" },
      output: { type: "string" },
      update: { type: "boolean" },
      case: { type: "string", multiple: true },
      fixture: { type: "boolean" },
      repo: { type: "string" },
      ready: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "node scripts/test-tui-visual.js [--base-ref REF | --baseline DIR [--update]] [--output DIR] [--case NAME]",
    );
    console.log(`Cases: ${VISUAL_CASES.map(({ name }) => name).join(", ")}`);
    return;
  }
  const repo = path.resolve(values.repo || fileURLToPath(new URL("..", import.meta.url)));
  const cases = values.case
    ? values.case.map((name) => {
        const spec = VISUAL_CASES.find((item) => item.name === name);
        if (!spec) throw new Error(`Unknown visual case: ${name}`);
        return spec;
      })
    : VISUAL_CASES;
  if (values.fixture) {
    if (!values.ready || cases.length !== 1)
      throw new Error("Fixture mode requires --ready and one --case");
    Date.now = () => Date.parse("2026-01-15T12:00:00Z");
    try {
      const result = await renderFixture(repo, cases[0]);
      if (result.status === "captured") {
        await new Promise((resolve) =>
          process.stdout.write(
            `\u{1B}[2J\u{1B}[H${result.lines.join("\r\n")}\u{1B}[0m\u{1B}[H`,
            resolve,
          ),
        );
        result.firstLine = stripVTControlCharacters(
          result.lines.find((line) => stripVTControlCharacters(line).trim()) || "",
        ).trim();
        delete result.lines;
      }
      await readyFile(values.ready, result);
    } catch (error) {
      await readyFile(values.ready, { status: "error", error: error.message });
    }
    setInterval(() => {}, 1000);
    return;
  }
  const result = await runVisualRegression({
    repo,
    output: path.resolve(values.output || "artifacts/tui-visual"),
    baseRef: values["base-ref"],
    baseline: values.baseline && path.resolve(values.baseline),
    update: values.update,
    cases,
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.failed) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
