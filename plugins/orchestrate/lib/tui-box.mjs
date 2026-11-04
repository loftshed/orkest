import { stripVTControlCharacters } from "node:util";

const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const ESC = String.fromCodePoint(27);
const ANSI_SGR_PATTERN = new RegExp(String.raw`${ESC}\[[0-9;]*m|[^${ESC}]+`, "gu");

export const ANSI = {
  cyan: "36",
  green: "32",
  yellow: "33",
  red: "31",
  dim: "2",
  bold: "1",
  inverse: "7",
  headerBg: "48;5;236;97;1",
  folderHeader: "48;5;24;97;1",
};

export const GLYPHS = {
  ascii: {
    topLeft: "+",
    topRight: "+",
    bottomLeft: "+",
    bottomRight: "+",
    horizontal: "-",
    vertical: "|",
    separator: "-",
    filled: "#",
    empty: ".",
    running: ">",
    blocked: "!",
    completed: "+",
    idle: "-",
  },
  unicode: {
    topLeft: "┌",
    topRight: "┐",
    bottomLeft: "└",
    bottomRight: "┘",
    horizontal: "─",
    vertical: "│",
    separator: "┄",
    filled: "█",
    empty: "░",
    running: SPINNER[0],
    blocked: "⚠",
    completed: "✓",
    idle: "·",
  },
  nerd: {
    topLeft: "╭",
    topRight: "╮",
    bottomLeft: "╰",
    bottomRight: "╯",
    horizontal: "─",
    vertical: "│",
    separator: "┄",
    filled: "█",
    empty: "░",
    running: "󰔛",
    blocked: "󰀪",
    completed: "󰄬",
    idle: "󰘓",
  },
};

/** Use explicit Nerd Font selection; otherwise stay with Unicode or an ASCII-safe locale. */
export function glyphTier(env = process.env) {
  const requested = env.ORK_GLYPHS?.toLowerCase();
  if (Object.hasOwn(GLYPHS, requested)) return requested;
  const locale = String(env.LC_ALL || env.LC_CTYPE || env.LANG || "").toLowerCase();
  if (env.TERM === "dumb" || !/(?:utf-?8|utf8)/u.test(locale)) return "ascii";
  return "unicode";
}

export function glyphSet(tier = glyphTier()) {
  return GLYPHS[Object.hasOwn(GLYPHS, tier) ? tier : "unicode"];
}

// Provider output is data. Strip terminal controls before adding our own ANSI styling.
export function plain(value) {
  return stripVTControlCharacters(String(value ?? "")).replaceAll(
    /[\p{Cc}\p{Cf}]/gu,
    (character) => (character === "\u{200C}" || character === "\u{200D}" ? character : " "),
  );
}

export function cellWidth(grapheme) {
  if (
    /[\u{1F1E6}-\u{1F1FF}]/u.test(grapheme) ||
    /\p{Extended_Pictographic}/u.test(grapheme) ||
    /[\u{FE0F}\u{20E3}]/u.test(grapheme)
  )
    return 2;
  const cp = grapheme.codePointAt(0);
  if (
    cp >= 4352 &&
    (cp <= 4447 ||
      (cp >= 11_904 && cp <= 12_663) ||
      (cp >= 12_864 && cp <= 12_895) ||
      (cp >= 13_312 && cp <= 19_823) ||
      (cp >= 19_968 && cp <= 20_367) ||
      (cp >= 20_880 && cp <= 21_471) ||
      (cp >= 21_472 && cp <= 23_199) ||
      (cp >= 23_552 && cp <= 25_919) ||
      (cp >= 25_920 && cp <= 26_047) ||
      (cp >= 26_112 && cp <= 26_143) ||
      (cp >= 26_144 && cp <= 26_527) ||
      (cp >= 26_528 && cp <= 26_559) ||
      (cp >= 26_560 && cp <= 27_103) ||
      (cp >= 27_136 && cp <= 27_167) ||
      (cp >= 27_200 && cp <= 27_231) ||
      (cp >= 27_264 && cp <= 27_295) ||
      (cp >= 27_328 && cp <= 27_423) ||
      (cp >= 27_456 && cp <= 27_487) ||
      (cp >= 27_520 && cp <= 27_583) ||
      (cp >= 27_616 && cp <= 28_671) ||
      (cp >= 28_672 && cp <= 30_719) ||
      (cp >= 30_720 && cp <= 30_783) ||
      (cp >= 30_784 && cp <= 31_967) ||
      (cp >= 31_968 && cp <= 32_767) ||
      (cp >= 32_768 && cp <= 33_583) ||
      (cp >= 33_584 && cp <= 34_047) ||
      (cp >= 34_048 && cp <= 34_815) ||
      (cp >= 44_032 && cp <= 55_203) ||
      (cp >= 63_744 && cp <= 64_255) ||
      (cp >= 65_040 && cp <= 65_135) ||
      (cp >= 65_281 && cp <= 65_376) ||
      (cp >= 131_072 && cp <= 262_141))
  )
    return 2;
  return /^\p{Mark}+$/u.test(grapheme) ? 0 : 1;
}

export function displayWidth(value) {
  return [...segments.segment(plain(value))].reduce(
    (sum, { segment }) => sum + cellWidth(segment),
    0,
  );
}

export function fit(value, width) {
  width = Math.max(0, Math.floor(width));
  let text = "";
  let used = 0;
  const graphemes = segments.segment(plain(value));
  for (const { segment } of graphemes) {
    const size = cellWidth(segment);
    if (used + size > width) break;
    text += segment;
    used += size;
  }
  return text + " ".repeat(width - used);
}

export function wrapText(value, width) {
  width = Math.max(1, Math.floor(width));
  const output = [];
  let line = "";
  const tokens = plain(value).match(/\s*\S+/gu) || [];
  for (const token of tokens) {
    const candidate = line + token;
    if (line && displayWidth(candidate) > width) {
      output.push(line.trimEnd());
      line = "";
    }
    const word = line ? token : token.trimStart();
    const graphemes = segments.segment(word);
    for (const { segment } of graphemes) {
      if (cellWidth(segment) > width) {
        if (line) output.push(line);
        output.push("?");
        line = "";
        continue;
      }
      if (line && displayWidth(line + segment) > width) {
        output.push(line);
        line = "";
      }
      line += segment;
    }
  }
  if (line || output.length === 0) output.push(line);
  return output;
}

export function progressBar(value, width, tier = glyphTier()) {
  const glyphs = glyphSet(tier);
  width = Math.max(0, Math.floor(width));
  const ratio = Math.max(0, Math.min(1, Number(value) || 0));
  const eighths = Math.round(ratio * width * 8);
  const full = Math.floor(eighths / 8);
  if (tier === "ascii") {
    const cells = Math.round(eighths / 8);
    return glyphs.filled.repeat(cells) + glyphs.empty.repeat(width - cells);
  }
  const partial = eighths % 8;
  const fraction = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"][partial];
  const empty = Math.max(0, width - full - Number(Boolean(fraction)));
  return glyphs.filled.repeat(full) + fraction + glyphs.empty.repeat(empty);
}

export function tone(value, styleTone, color) {
  const text = plain(value);
  const codes = String(styleTone)
    .split(/\s+/u)
    .map((name) => ANSI[name])
    .filter(Boolean);
  if (!color || codes.length === 0) return text;
  return `\u{1B}[${codes.join(";")}m${text}\u{1B}[0m`;
}

export function fitStyled(value, width) {
  width = Math.max(0, Math.floor(width));
  const source = String(value ?? "");
  const tokens = source.match(ANSI_SGR_PATTERN) || [];
  let output = "";
  let used = 0;
  let isStyled = false;
  for (const token of tokens) {
    if (token.startsWith(`${ESC}[`)) {
      output += token;
      isStyled = !token.startsWith(`${ESC}[0m`);
      continue;
    }
    const graphemes = segments.segment(plain(token));
    for (const { segment } of graphemes) {
      const size = cellWidth(segment);
      if (!(used + size <= width)) {
        continue;
      }

      output += segment;
      used += size;
    }
  }
  if (used < width) output += " ".repeat(width - used);
  if (isStyled) output += "\u{1B}[0m";
  return output;
}

export function frame(
  title,
  lines,
  width,
  { glyphs = glyphSet(), color = false, right = "", headerTone } = {},
) {
  width = Math.max(1, Math.floor(width));
  if (width < 4) return [title, ...lines].map((line) => fit(line, width));
  const inside = width - 2;
  const cleanTitle = ` ${plain(title)} `;
  const cleanRight = right ? ` ${plain(right)} ` : "";
  const availableTitle = Math.max(0, inside - displayWidth(cleanRight));
  const heading = fit(cleanTitle, availableTitle);
  const tail = fit(cleanRight, inside - displayWidth(heading));
  const topContent = heading + tail;
  const topRemaining = Math.max(0, inside - displayWidth(topContent));
  let top;
  if (color && headerTone) {
    const titlePill = fit(cleanTitle, Math.min(displayWidth(cleanTitle), availableTitle));
    const middleSpace = " ".repeat(Math.max(0, availableTitle - displayWidth(titlePill)));
    const styledTail = tone(tail, tail.trim() ? headerTone : "cyan", color);
    top = `${tone(glyphs.topLeft, "cyan", color)}${tone(titlePill, headerTone, color)}${tone(middleSpace, "cyan", color)}${styledTail}${tone(glyphs.horizontal.repeat(topRemaining) + glyphs.topRight, "cyan", color)}`;
  } else {
    top = tone(
      glyphs.topLeft + topContent + glyphs.horizontal.repeat(topRemaining) + glyphs.topRight,
      "cyan",
      color,
    );
  }
  return [
    top,
    ...lines.map(
      (line) =>
        `${tone(glyphs.vertical, "cyan", color)}${fitStyled(line, inside)}${tone(glyphs.vertical, "cyan", color)}`,
    ),
    tone(
      `${glyphs.bottomLeft}${glyphs.horizontal.repeat(inside)}${glyphs.bottomRight}`,
      "cyan",
      color,
    ),
  ];
}

/** Shared framed panel for interactive and non-interactive terminal output. */
export function renderPanel(title, lines, width, options = {}) {
  const margin = Math.min(1, Math.floor((Math.max(1, width) - 1) / 2));
  const panelWidth = Math.max(1, Math.floor(width) - margin * 2);
  return frame(title, lines.map(plain), panelWidth, options).map(
    (line) => `${" ".repeat(margin)}${line}`,
  );
}

/** Fit weighted cells into a fixed width, keeping separators inside the available space. */
export function renderTable(
  headers,
  rows,
  width,
  { weights = [], tier = glyphTier(), rowDetails = [], rowStyle } = {},
) {
  width = Math.max(headers.length, Math.floor(width));
  const separator = ` ${glyphSet(tier).vertical} `;
  const separatorWidth = displayWidth(separator) * Math.max(0, headers.length - 1);
  const cellWidthTotal = Math.max(headers.length, width - separatorWidth);
  const ratios = headers.map((_, index) => Math.max(0.1, Number(weights[index]) || 1));
  const ratioTotal = ratios.reduce((sum, ratio) => sum + ratio, 0);
  const widths = ratios.map((ratio) =>
    Math.max(1, Math.floor((cellWidthTotal * ratio) / ratioTotal)),
  );
  let remaining = cellWidthTotal - widths.reduce((sum, cell) => sum + cell, 0);
  for (let index = 0; remaining > 0; index = (index + 1) % widths.length, remaining--)
    widths[index]++;
  while (widths.reduce((sum, cell) => sum + cell, 0) + separatorWidth > width) {
    const index = widths.indexOf(Math.max(...widths));
    if (widths[index] <= 1) break;
    widths[index]--;
  }
  const renderRow = (row) => row.map((cell, index) => fit(cell, widths[index])).join(separator);
  const renderedRows = rows.flatMap((row, rowIndex) => {
    const cells = row.map((cell, index) => wrapText(cell, widths[index]));
    const height = Math.max(1, ...cells.map((lines) => lines.length));
    const lines = Array.from({ length: height }, (_, line) =>
      cells.map((cellLines, index) => fit(cellLines[line] || "", widths[index])).join(separator),
    );
    const detail = rowDetails[rowIndex];
    if (detail) lines.push(...wrapText(detail, width));
    return lines.map((line) => (rowStyle ? rowStyle(line, rowIndex) : line));
  });
  return [
    renderRow(headers),
    widths.map((cell) => glyphSet(tier).separator.repeat(cell)).join(separator),
    ...renderedRows,
  ];
}
