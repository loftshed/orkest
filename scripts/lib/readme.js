/**
 * The generated parts of README.md: marked text blocks taken from the code, and
 * terminal screenshots drawn by the real renderers from invented data.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { DEMO_NOW, DEMO_TERMINAL, demoAccounts, demoRoom } from "./readme-demo.js";

const execute = promisify(execFile);

const BLOCK = /<!-- generated:([\w-]+) -->\n[\s\S]*?<!-- \/generated:\1 -->/gu;

/** Replaces every `<!-- generated:NAME -->` block with `blocks[NAME]`; an unknown name throws. */
export function replaceBlocks(readme, blocks) {
  const seen = new Set();
  const text = readme.replaceAll(BLOCK, (_, name) => {
    if (!Object.hasOwn(blocks, name))
      throw new Error(`README.md has an unknown generated block: ${name}`);
    seen.add(name);
    return `<!-- generated:${name} -->\n\n${blocks[name]}\n\n<!-- /generated:${name} -->`;
  });
  const missing = Object.keys(blocks).filter((name) => !seen.has(name));
  if (missing.length > 0)
    throw new Error(`README.md has no generated block for: ${missing.join(", ")}`);
  return text;
}

/** The usage lines of `ork --help`, without the notes that follow them. */
export function commandReference(help) {
  const usage = help.split("\n\n", 1)[0].trimEnd();
  return `\`\`\`text\n${usage}\n\`\`\``;
}

function frontmatter(text) {
  const fields = {};
  const block = /^---\n([\s\S]*?)\n---/u.exec(text)?.[1] ?? "";
  for (const line of block.split("\n")) {
    const match = /^([\w-]+):\s*(.*)$/u.exec(line);
    if (match) fields[match[1]] = match[2].replace(/^"(.*)"$/u, "$1");
  }
  return fields;
}

/** One bullet per slash command, from the frontmatter of the plugin's command files. */
export function slashCommands(directory) {
  return fs
    .readdirSync(directory)
    .filter((file) => file.endsWith(".md"))
    .sort((a, b) => a.localeCompare(b))
    .map((file) => {
      const fields = frontmatter(fs.readFileSync(path.join(directory, file), "utf8"));
      const name = `/${path.basename(file, ".md")}`;
      const usage = fields["argument-hint"] ? `${name} ${fields["argument-hint"]}` : name;
      const description = (fields.description ?? "").replace(/\s*\(\/[^)]*\)\s*$/u, "");
      return `- \`${usage}\`: ${description}`;
    })
    .join("\n");
}

/** The sentence naming what must be installed, with the Node.js version from package.json. */
export function requirements(manifest) {
  const node = manifest.engines.node.replace(/^>=\s*/u, "").replace(/\.0$/u, "");
  return `Requires Git, Node.js ${node}+, Python 3.11+, \`tmux\`, and at least one installed, authenticated harness CLI (\`claude\`, \`codex\`, \`agy\`, or \`opencode\`).`;
}

/** Every generated text block of the README, by name. */
export async function generatedBlocks(repo) {
  const orchestrate = path.join(repo, "plugins/orchestrate");
  const help = await execute(process.execPath, [path.join(orchestrate, "bin/ork.mjs"), "--help"]);
  const manifest = fs.readFileSync(path.join(repo, "package.json"), "utf8");
  return {
    commands: commandReference(help.stdout),
    requirements: requirements(JSON.parse(manifest)),
    "slash-commands": slashCommands(path.join(orchestrate, "commands")),
  };
}

const load = (repo, file) => import(pathToFileURL(path.join(repo, file)).href);

async function swarmCapture(repo, { cols, rows, prepare }) {
  const { HordeView } = await load(repo, "plugins/orchestrate/lib/horde-view.mjs");
  const view = new HordeView(demoRoom(), {
    now: () => DEMO_NOW,
    height: rows,
    color: true,
    tier: "nerd",
  });
  prepare?.(view);
  return view.render(cols).slice(0, rows).join("\n");
}

/** The README screenshots as ANSI text: `{ name, title, cols, ansi }` for each image. */
export async function captures(repo) {
  // The monitor report prints local times, and the theme reads NO_COLOR: neither may
  // change a screenshot, wherever it is made.
  process.env.TZ = "UTC";
  delete process.env.NO_COLOR;
  const { renderReport } = await load(repo, "plugins/monitor/lib/render.mjs");
  return [
    {
      name: "swarm-view",
      title: "ork claude — Swarm View",
      cols: 100,
      ansi: await swarmCapture(repo, { cols: 100, rows: 34 }),
    },
    {
      name: "agent-preview",
      title: "Swarm View — live agent preview",
      cols: 110,
      ansi: await swarmCapture(repo, {
        cols: 110,
        rows: 30,
        prepare(view) {
          view.focusId = "birch";
          view.setPreview({
            agentId: "birch",
            title: "birch",
            kind: "terminal",
            loading: false,
            text: DEMO_TERMINAL,
          });
        },
      }),
    },
    {
      name: "monitor",
      title: "monitor",
      ansi: renderReport(demoAccounts(), { color: true, now: DEMO_NOW }),
    },
  ];
}

const FOREGROUND = "#e6e8ee";
const BACKGROUND = "#171a21";
const PALETTE = [
  "#2a2e37",
  "#e5484d",
  "#46a758",
  "#d9a514",
  "#3b82f6",
  "#a855f7",
  "#1aa3b0",
  "#d5d8df",
  "#707782",
  "#ff6b6b",
  "#69d98c",
  "#ffe084",
  "#7baaff",
  "#d99cff",
  "#6bdded",
  "#ffffff",
];
const CELL_WIDTH = 8.4;
const CELL_HEIGHT = 19;
const FONT_SIZE = 14;
const PADDING = 14;
const TITLE_BAR = 34;
const PLAIN_STYLE = Object.freeze({ fg: null, bg: null, bold: false, dim: false, inverse: false });

/** Fonts the screenshots are drawn with; `fc-list` must know both. */
export const SCREENSHOT_FONTS = ["Fira Code", "Symbols Nerd Font Mono"];

// Box-drawing characters as [left, right, up, down] strokes (2 = heavy), then "rounded".
const BOX = new Map(
  Object.entries({
    "─": [1, 1, 0, 0],
    "━": [2, 2, 0, 0],
    "│": [0, 0, 1, 1],
    "┌": [0, 1, 0, 1],
    "┐": [1, 0, 0, 1],
    "└": [0, 1, 1, 0],
    "┘": [1, 0, 1, 0],
    "├": [0, 1, 1, 1],
    "┤": [1, 0, 1, 1],
    "┬": [1, 1, 0, 1],
    "┴": [1, 1, 1, 0],
    "┼": [1, 1, 1, 1],
    "╭": [0, 1, 0, 1, true],
    "╮": [1, 0, 0, 1, true],
    "╯": [1, 0, 1, 0, true],
    "╰": [0, 1, 1, 0, true],
  }),
);

function indexedColor(index) {
  if (index < 16) return PALETTE[index];
  if (index >= 232) {
    const level = 8 + (index - 232) * 10;
    return `rgb(${level},${level},${level})`;
  }
  const cube = index - 16;
  const steps = [0, 95, 135, 175, 215, 255];
  return `rgb(${steps[Math.floor(cube / 36)]},${steps[Math.floor(cube / 6) % 6]},${steps[cube % 6]})`;
}

const SIMPLE_CODES = new Map([
  [1, { bold: true }],
  [2, { dim: true }],
  [7, { inverse: true }],
  [22, { bold: false, dim: false }],
  [27, { inverse: false }],
  [39, { fg: null }],
  [49, { bg: null }],
]);

/** The style change of a 16-colour code, or undefined when `code` is not one. */
function paletteChange(code) {
  if (code >= 30 && code <= 37) return { fg: PALETTE[code - 30] };
  if (code >= 90 && code <= 97) return { fg: PALETTE[code - 82] };
  if (code >= 40 && code <= 47) return { bg: PALETTE[code - 40] };
  if (code >= 100 && code <= 107) return { bg: PALETTE[code - 92] };
}

/** The colour of an extended `38;5;n` or `38;2;r;g;b` code and how many parameters it used. */
function extendedColor(parameters, index) {
  if (parameters[index + 1] === 5) return [indexedColor(parameters[index + 2]), 2];
  if (parameters[index + 1] === 2)
    return [`rgb(${parameters.slice(index + 2, index + 5).join(",")})`, 4];
  return [undefined, 0];
}

/** Applies one SGR sequence's parameters to a style and returns the new style. */
function applyStyle(style, parameters) {
  let next = { ...style };
  for (let index = 0; index < parameters.length; index++) {
    const code = parameters[index];
    if (code === 0) next = { ...PLAIN_STYLE };
    else if (code === 38 || code === 48) {
      const [color, used] = extendedColor(parameters, index);
      next[code === 38 ? "fg" : "bg"] = color;
      index += used;
    } else Object.assign(next, SIMPLE_CODES.get(code) ?? paletteChange(code));
  }
  return next;
}

const xml = (text) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const number = (value) => String(Math.round(value * 100) / 100);

function boxStrokes([left, right, up, down, isRounded], x, y, paint) {
  const centerX = x + CELL_WIDTH / 2;
  const centerY = y + CELL_HEIGHT / 2;
  const edgeX = right ? x + CELL_WIDTH + 0.2 : x - 0.2;
  const edgeY = down ? y + CELL_HEIGHT + 0.2 : y - 0.2;
  if (isRounded) {
    const radius = 4.2;
    const fromX = right ? centerX + radius : centerX - radius;
    const toY = down ? centerY + radius : centerY - radius;
    return [
      `<path d="M${number(edgeX)} ${centerY} L${number(fromX)} ${centerY} Q${number(centerX)} ${centerY} ${number(centerX)} ${number(toY)} L${number(centerX)} ${number(edgeY)}" fill="none" stroke-width="1.2" ${paint("stroke")}/>`,
    ];
  }
  const strokes = [];
  const width = (weight) => (weight === 2 ? 2.6 : 1.2);
  if (left || right)
    strokes.push(
      `<line x1="${number(left ? x - 0.2 : centerX)}" y1="${centerY}" x2="${number(right ? x + CELL_WIDTH + 0.2 : centerX)}" y2="${centerY}" stroke-width="${width(left || right)}" ${paint("stroke")}/>`,
    );
  if (up || down)
    strokes.push(
      `<line x1="${number(centerX)}" y1="${number(up ? y - 0.2 : centerY)}" x2="${number(centerX)}" y2="${number(down ? y + CELL_HEIGHT + 0.2 : centerY)}" stroke-width="${width(up || down)}" ${paint("stroke")}/>`,
    );
  return strokes;
}

/**
 * Draws ANSI text as a terminal window. Every character sits in its own cell and box-drawing
 * characters are strokes, so borders join whatever font the viewer has. `cellWidth` is the
 * renderer's own display-width function.
 */
export function ansiToWindowSvg(ansi, { title, cols, cellWidth }) {
  const lines = ansi.replace(/\n+$/u, "").split("\n");
  const marks = [];
  let widest = 0;
  for (const [row, line] of lines.entries()) {
    const y = PADDING + TITLE_BAR + row * CELL_HEIGHT;
    let style = { ...PLAIN_STYLE };
    let column = 0;
    // eslint-disable-next-line no-control-regex -- SGR sequences start with the escape character
    for (const [, sgr, character] of line.matchAll(/\u{1B}\[([\d;]*)m|([\s\S])/gu)) {
      if (sgr !== undefined) {
        style = applyStyle(style, sgr === "" ? [0] : sgr.split(";").map(Number));
        continue;
      }
      const width = cellWidth(character);
      if (width === 0) continue;
      const x = PADDING + column * CELL_WIDTH;
      column += width;
      const fg = style.inverse ? (style.bg ?? BACKGROUND) : (style.fg ?? FOREGROUND);
      const bg = style.inverse ? (style.fg ?? FOREGROUND) : style.bg;
      const paint = (attribute) => `${attribute}="${fg}"${style.dim ? ' opacity="0.6"' : ""}`;
      if (bg)
        marks.push(
          `<rect x="${number(x)}" y="${y}" width="${number(CELL_WIDTH * width + 0.3)}" height="${CELL_HEIGHT}" fill="${bg}"/>`,
        );
      const code = character.codePointAt(0);
      if (BOX.has(character)) marks.push(...boxStrokes(BOX.get(character), x, y, paint));
      else if (code >= 9608 && code <= 9615) {
        // Left block elements U+2588–U+258F, from a full cell down to one eighth.
        const fraction = (9616 - code) / 8;
        marks.push(
          `<rect x="${number(x)}" y="${y + 3}" width="${number(CELL_WIDTH * fraction + (fraction === 1 ? 0.3 : 0))}" height="${CELL_HEIGHT - 6}" ${paint("fill")}/>`,
        );
      } else if (character !== " ") {
        // Nerd Font icons live in the private-use areas, U+E000–U+F8FF and from U+F0000.
        const isIcon = (code >= 57_344 && code <= 63_743) || code >= 983_040;
        const [textFont, iconFont] = SCREENSHOT_FONTS;
        marks.push(
          `<text x="${number(x + (CELL_WIDTH * width) / 2)}" y="${y + 14}" text-anchor="middle" font-family="'${isIcon ? iconFont : textFont}',monospace" font-size="${isIcon ? FONT_SIZE + 1 : FONT_SIZE}"${style.bold ? ' font-weight="700"' : ""} ${paint("fill")}>${xml(character)}</text>`,
        );
      }
    }
    widest = Math.max(widest, column);
  }
  const width = Math.ceil(PADDING * 2 + (cols ?? widest) * CELL_WIDTH);
  const height = PADDING * 2 + TITLE_BAR + lines.length * CELL_HEIGHT;
  const chrome = [
    `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="10" fill="${BACKGROUND}" stroke="#2f3541"/>`,
    `<path d="M0.5 ${TITLE_BAR + 0.5} H${width - 0.5}" stroke="#262b35"/>`,
    ...["#ff5f57", "#febc2e", "#28c840"].map(
      (fill, index) => `<circle cx="${20 + index * 18}" cy="17" r="5.5" fill="${fill}"/>`,
    ),
    `<text x="${width / 2}" y="22" text-anchor="middle" font-family="sans-serif" font-size="13" fill="#8b93a1">${xml(title)}</text>`,
  ];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${chrome.join("")}${marks.join("")}</svg>\n`;
}
