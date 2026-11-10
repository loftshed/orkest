import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { expect, test } from "vitest";

import {
  ansiToWindowSvg,
  captures,
  commandReference,
  generatedBlocks,
  replaceBlocks,
  requirements,
  slashCommands,
} from "../../scripts/lib/readme.js";
import { main, staleScreenshots } from "../../scripts/readme.js";

const repo = fileURLToPath(new URL("../..", import.meta.url));

test("a generated block is replaced between its markers and the rest is left alone", () => {
  const readme = "Intro\n\n<!-- generated:a -->\nold\n<!-- /generated:a -->\n\nOutro\n";
  expect(replaceBlocks(readme, { a: "new" })).toBe(
    "Intro\n\n<!-- generated:a -->\n\nnew\n\n<!-- /generated:a -->\n\nOutro\n",
  );
  expect(replaceBlocks(replaceBlocks(readme, { a: "new" }), { a: "new" })).toBe(
    replaceBlocks(readme, { a: "new" }),
  );
});

test("a block the README lacks, or one nothing generates, is an error", () => {
  expect(() => replaceBlocks("no markers", { a: "x" })).toThrow(/no generated block for: a/u);
  expect(() => replaceBlocks("<!-- generated:b -->\n<!-- /generated:b -->", {})).toThrow(
    /unknown generated block: b/u,
  );
});

test("the command reference keeps the usage lines and drops the notes after them", () => {
  expect(commandReference("ork a\nork b\n\nNotes about keys.\n")).toBe(
    "```text\nork a\nork b\n```",
  );
});

test("slash commands come from command frontmatter, without the repeated usage", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "readme-commands-"));
  fs.writeFileSync(
    path.join(directory, "side.md"),
    '---\ndescription: Park an idea (/side [--later] <idea>)\nargument-hint: "[--later] <idea>"\n---\nBody\n',
  );
  fs.writeFileSync(path.join(directory, "plain.md"), "---\ndescription: No arguments\n---\n");
  expect(slashCommands(directory)).toBe(
    "- `/plain`: No arguments\n- `/side [--later] <idea>`: Park an idea",
  );
});

test("the requirements sentence takes the Node.js version from package.json", () => {
  expect(requirements({ engines: { node: ">=26.13.0" } })).toContain("Node.js 26.13+");
});

test("the README in this repository is current", async () => {
  const readme = fs.readFileSync(path.join(repo, "README.md"), "utf8");
  expect(replaceBlocks(readme, await generatedBlocks(repo))).toBe(readme);
  expect(staleScreenshots(repo, await captures(repo))).toEqual([]);
});

test("captures ignore the caller's colour and time zone settings", async () => {
  const before = await captures(repo);
  process.env.NO_COLOR = "1";
  process.env.TZ = "Asia/Tokyo";
  expect(await captures(repo)).toEqual(before);
  expect(stripVTControlCharacters(before[0].ansi)).toContain("payments-api");
});

test("a changed capture or a missing image is reported as stale", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "readme-stale-"));
  fs.mkdirSync(path.join(root, "docs/images"), { recursive: true });
  const shot = { name: "view", ansi: "text" };
  expect(staleScreenshots(root, [shot])).toEqual(["view"]);
  fs.writeFileSync(path.join(root, "docs/images/view.ansi"), "text\n");
  expect(staleScreenshots(root, [shot])).toEqual(["view"]);
  fs.writeFileSync(path.join(root, "docs/images/view.png"), "");
  expect(staleScreenshots(root, [shot])).toEqual([]);
  expect(staleScreenshots(root, [{ ...shot, ansi: "changed" }])).toEqual(["view"]);
});

test("--check passes on this repository and writes nothing", async () => {
  const readme = fs.readFileSync(path.join(repo, "README.md"), "utf8");
  expect(await main(["--check"])).toBe(0);
  expect(fs.readFileSync(path.join(repo, "README.md"), "utf8")).toBe(readme);
});

test("the window drawing places styled text, borders and backgrounds on the cell grid", () => {
  const svg = ansiToWindowSvg("\u{1B}[1;31mA\u{1B}[0m─\u{1B}[7mB\u{1B}[0m\n<█", {
    title: "t & t",
    cellWidth: () => 1,
  });
  expect(svg).toContain('font-weight="700" fill="#e5484d">A</text>');
  expect(svg).toContain("<line ");
  expect(svg).toContain('fill="#171a21">B</text>');
  expect(svg).toContain("&lt;</text>");
  expect(svg).toContain("t &amp; t");
  expect(svg).toMatch(/^<svg [^>]*width="54" height="100"/u);
});
