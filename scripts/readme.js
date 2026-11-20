#!/usr/bin/env node
/**
 * Keeps the generated parts of README.md current: the marked text blocks and the
 * screenshots under docs/images. `--check` changes nothing and fails when either is stale.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";

import { ansiToWindowSvg, captures, generatedBlocks, replaceBlocks } from "./lib/readme.js";

const execute = promisify(execFile);
const IMAGES = "docs/images";

/** Names of the screenshots whose saved ANSI source or image no longer matches `shots`. */
export function staleScreenshots(repo, shots) {
  return shots
    .filter(({ name, ansi }) => {
      const source = path.join(repo, IMAGES, `${name}.ansi`);
      const isCurrent = fs.existsSync(source) && fs.readFileSync(source, "utf8") === `${ansi}\n`;
      return !isCurrent || !fs.existsSync(path.join(repo, IMAGES, `${name}.png`));
    })
    .map(({ name }) => name);
}

async function requireRasterizer() {
  let tool;
  try {
    await execute("magick", ["-version"]);
    tool = "magick";
  } catch {
    try {
      await execute("rsvg-convert", ["-v"]);
      tool = "rsvg-convert";
    } catch {
      throw new Error(
        "drawing screenshots needs ImageMagick (`magick`) or librsvg (`rsvg-convert`), and fontconfig (`fc-list`)",
      );
    }
  }
  let fonts;
  try {
    fonts = (await execute("fc-list", [":", "family"])).stdout;
  } catch {
    throw new Error("drawing screenshots needs fontconfig (`fc-list`)");
  }
  const hasTextFont = fonts.includes("Fira Code") || fonts.includes("BlexMono Nerd Font Mono");
  const hasIconFont =
    fonts.includes("Symbols Nerd Font Mono") ||
    fonts.includes("Symbols Nerd Font") ||
    fonts.includes("BlexMono Nerd Font Mono");
  if (!hasTextFont || !hasIconFont) {
    throw new Error(
      "drawing screenshots needs either 'Fira Code' or 'BlexMono Nerd Font Mono' and any of 'Symbols Nerd Font Mono', 'Symbols Nerd Font', or 'BlexMono Nerd Font Mono' installed",
    );
  }
  return tool;
}

async function rasterizeToPng(tool, svgPath, imagePath) {
  if (tool === "magick") {
    // Twice the SVG's size for high-density displays, with a 255-colour palette to stay small.
    await execute("magick", [
      "-background",
      "none",
      "-density",
      "192",
      svgPath,
      "-strip",
      "-colors",
      "255",
      `PNG8:${imagePath}`,
    ]);
  } else if (tool === "rsvg-convert") {
    await execute("rsvg-convert", ["--zoom=2", "-o", imagePath, svgPath]);
  }
}

async function drawScreenshots(repo, shots) {
  const tool = await requireRasterizer();
  const { cellWidth } = await import(pathToFileURL(path.join(repo, "src/lib/tui-box.mjs")).href);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "readme-screenshots-"));
  try {
    fs.mkdirSync(path.join(repo, IMAGES), { recursive: true });
    for (const { name, title, cols, ansi } of shots) {
      const svg = path.join(scratch, `${name}.svg`);
      fs.writeFileSync(svg, ansiToWindowSvg(ansi, { title, cols, cellWidth }));
      const image = path.join(repo, IMAGES, `${name}.png`);
      await rasterizeToPng(tool, svg, image);
      // The source is saved last, so an interrupted run is still reported as stale.
      fs.writeFileSync(path.join(repo, IMAGES, `${name}.ansi`), `${ansi}\n`);
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({
    args,
    options: {
      check: { type: "boolean" },
      force: { type: "boolean" },
      help: { type: "boolean" },
      repo: { type: "string" },
    },
  });
  if (values.help) {
    console.log("node scripts/readme.js [--check] [--force]");
    console.log("Rewrites README.md's generated blocks and redraws changed screenshots.");
    console.log("--check reports what is stale; --force redraws every screenshot.");
    return 0;
  }
  const repo = path.resolve(values.repo || fileURLToPath(new URL("..", import.meta.url)));
  const file = path.join(repo, "README.md");
  const current = fs.readFileSync(file, "utf8");
  const next = replaceBlocks(current, await generatedBlocks(repo));
  const shots = await captures(repo);
  const stale = staleScreenshots(repo, shots);

  if (values.check) {
    const problems = [
      ...(next === current ? [] : ["README.md generated blocks"]),
      ...stale.map((name) => `${IMAGES}/${name}.png`),
    ];
    if (problems.length === 0) return 0;
    console.error(`readme: out of date: ${problems.join(", ")}`);
    console.error("readme: run `corepack pnpm readme` and commit the result.");
    return 1;
  }

  if (next !== current) fs.writeFileSync(file, next);
  const redraw = values.force ? shots : shots.filter(({ name }) => stale.includes(name));
  if (redraw.length > 0) await drawScreenshots(repo, redraw);
  const changed = [
    ...(next === current ? [] : ["README.md"]),
    ...redraw.map(({ name }) => `${IMAGES}/${name}.png`),
  ];
  console.log(changed.length > 0 ? `readme: updated ${changed.join(", ")}` : "readme: up to date");
  return 0;
}

let entry = "";
try {
  if (process.argv[1]) entry = fs.realpathSync(process.argv[1]);
} catch {
  /* An importing test runner may not have a filesystem entry point. */
}
if (entry === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(`readme: ${error.message}`);
    process.exitCode = 1;
  }
}
