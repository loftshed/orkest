/**
 * @module tui-markdown
 *
 * Theme-aware, width-safe Markdown and structured agent-activity formatting
 * built on `tui-box` grapheme measurement and `tui-theme` SGR tokens.
 */
import {
  cellWidth,
  displayWidth,
  fit,
  fitStyled,
  glyphSet,
  glyphTier,
  plain,
  tone,
} from "./tui-box.mjs";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

const SECTION_BANNER_RE =
  /^(Messages to orchestrator|Response|Latest updates|Live output|Recent activity):$/u;
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/u;
const HORIZONTAL_RULE_RE = /^\s*(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/u;
const ATX_HEADING_RE = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*$/u;
const OUTCOME_LINE_RE = /^\s*(COMPLETE|COMPLETED|PASSED|PARTIAL|BLOCKED|FAILED)\s*$/u;
const TOOL_EVENT_RE = /^Used ([A-Za-z0-9_.:/-]+)(?: · (.*?))?(?: \((×\d+)\))?$/u;
const BLOCKQUOTE_RE = /^\s*>\s?(.*)$/u;
const LIST_ITEM_RE = /^(\s*)(?:([•\-*+])|(\d+[.)]))\s+(.*)$/u;
const TASK_BOX_RE = /^\[([ xX])\]\s+(.*)$/u;
const MESSAGE_TAG_RE = /^(\[[A-Za-z0-9_/-]{1,20}\])\s+(.*)$/u;
const TABLE_SEPARATOR_RE = /^\s*\|?(?:\s*:?-{2,}:?\s*\|)+\s*:?-{2,}:?\s*\|?\s*$/u;

function combineStyles(base, extra) {
  if (!base) return extra;
  if (!extra || base === extra) return base;
  return `${base} ${extra}`;
}

function normalizeColor(color) {
  if (!color || typeof color !== "object" || "enabled" in color) return color;
  return { enabled: true, theme: color };
}

function badgeToneForTag(rawTag) {
  const key = rawTag.slice(1, -1).toLowerCase();
  if (/^(?:update|progress|info|status|note)$/u.test(key)) return "mdBadgeInfo";
  if (/^(?:done|complete|completed|passed|ok|fixed|resolved)$/u.test(key)) return "success bold";
  if (/^(?:warn|warning|blocked|blocker|question|todo|pending)$/u.test(key)) return "warning bold";
  if (/^(?:error|err|fail|failed|bug|critical)$/u.test(key)) return "error bold";
  return "bold";
}

function verificationTone(value) {
  const clean = value.trim();
  if (/^(?:passed|ok|complete|completed|verified)\b/iu.test(clean)) return "success bold";
  if (/^(?:failed|error)\b/iu.test(clean)) return "error bold";
  if (/^(?:skipped|timed_out|partial|blocked)\b/iu.test(clean)) return "warning bold";
  return "";
}

/** Parse inline Markdown (`code`, **bold**, *emphasis*, [label](url)) into plain styled spans. */
export function parseInlineSpans(rawText, baseStyle = "") {
  const text = plain(rawText);
  if (!text) return [];
  const spans = [];
  let buffer = "";
  const flush = () => {
    if (!buffer) return;
    spans.push({ text: buffer, style: baseStyle });
    buffer = "";
  };

  let index = 0;
  while (index < text.length) {
    if (text.startsWith("``", index)) {
      const close = text.indexOf("``", index + 2);
      if (close > index + 2) {
        flush();
        spans.push({
          text: text.slice(index + 2, close),
          style: combineStyles(baseStyle, "mdCode"),
        });
        index = close + 2;
        continue;
      }
    }

    if (text[index] === "`") {
      const close = text.indexOf("`", index + 1);
      if (close > index + 1) {
        flush();
        spans.push({
          text: text.slice(index + 1, close),
          style: combineStyles(baseStyle, "mdCode"),
        });
        index = close + 1;
        continue;
      }
    }

    if (text[index] === "[") {
      const closeBracket = text.indexOf("]", index + 1);
      if (closeBracket > index + 1 && text[closeBracket + 1] === "(") {
        const closeParen = text.indexOf(")", closeBracket + 2);
        const label = text.slice(index + 1, closeBracket);
        if (closeParen > closeBracket + 2 && !label.includes("[")) {
          const href = text.slice(closeBracket + 2, closeParen).trim();
          flush();
          const isFileLink = href.startsWith("file://");
          spans.push({
            text: label,
            style: combineStyles(baseStyle, isFileLink ? "mdCode bold" : "bold"),
          });
          if (href && href !== label && !isFileLink) {
            spans.push({ text: ` (${href})`, style: combineStyles(baseStyle, "muted") });
          }
          index = closeParen + 1;
          continue;
        }
      }
    }

    const afterDouble = text.charAt(index + 2);
    if (text.startsWith("**", index) && afterDouble !== "" && afterDouble !== " ") {
      const close = text.indexOf("**", index + 2);
      if (close > index + 2 && text.charAt(close - 1) !== " ") {
        flush();
        spans.push(
          ...parseInlineSpans(text.slice(index + 2, close), combineStyles(baseStyle, "bold")),
        );
        index = close + 2;
        continue;
      }
    }

    if (
      text.startsWith("__", index) &&
      afterDouble !== "" &&
      afterDouble !== " " &&
      (index === 0 || /\W/u.test(text.charAt(index - 1)))
    ) {
      const close = text.indexOf("__", index + 2);
      if (
        close > index + 2 &&
        text.charAt(close - 1) !== " " &&
        (close + 2 >= text.length || /\W/u.test(text.charAt(close + 2)))
      ) {
        flush();
        spans.push(
          ...parseInlineSpans(text.slice(index + 2, close), combineStyles(baseStyle, "bold")),
        );
        index = close + 2;
        continue;
      }
    }

    const afterSingle = text.charAt(index + 1);
    if (
      text.charAt(index) === "*" &&
      afterSingle !== "" &&
      afterSingle !== "*" &&
      afterSingle !== " " &&
      (index === 0 || /[\s([{"']/u.test(text.charAt(index - 1)))
    ) {
      let close = text.indexOf("*", index + 1);
      while (close !== -1 && text.charAt(close + 1) === "*") {
        close = text.indexOf("*", close + 2);
      }
      if (
        close > index + 1 &&
        text.charAt(close - 1) !== " " &&
        (close + 1 >= text.length || /[\s)\]}.,;:!?"']/u.test(text.charAt(close + 1)))
      ) {
        flush();
        spans.push({ text: text.slice(index + 1, close), style: combineStyles(baseStyle, "bold") });
        index = close + 1;
        continue;
      }
    }

    buffer += text[index];
    index += 1;
  }

  flush();
  return spans;
}

/** Strip Markdown syntax markers for compact single-line summaries. */
export function stripInlineMarkdown(value) {
  const cleaned = plain(value).replace(/^\s{0,3}#{1,6}\s+/u, "");
  return parseInlineSpans(cleaned)
    .map((span) => span.text)
    .join("");
}

function spansWidth(parts) {
  let sum = 0;
  for (const part of parts) sum += displayWidth(part.text);
  return sum;
}

function renderParts(parts, color) {
  if (parts.length === 0) return "";
  const merged = [];
  for (const part of parts) {
    if (!part.text) continue;
    const previous = merged.at(-1);
    if (previous && previous.style === part.style) {
      previous.text += part.text;
    } else {
      merged.push({ text: part.text, style: part.style });
    }
  }
  return merged
    .map((part) => (part.style ? tone(part.text, part.style, color) : part.text))
    .join("");
}

function tokenizeSpans(spans) {
  const tokens = [];
  for (const span of spans) {
    const pieces = span.text.match(/\s+|\S+/gu) || [];
    for (const piece of pieces) {
      const isSpace = /^\s+$/u.test(piece);
      const normalized = isSpace ? " ".repeat(piece.length) : piece;
      const previous = tokens.at(-1);
      if (previous && previous.isSpace === isSpace) {
        previous.parts.push({ text: normalized, style: span.style });
        previous.width += displayWidth(normalized);
      } else {
        tokens.push({
          isSpace,
          parts: [{ text: normalized, style: span.style }],
          width: displayWidth(normalized),
        });
      }
    }
  }
  return tokens;
}

function takeGraphemesWithinBudget(value, budget) {
  let text = "";
  let used = 0;
  for (const { segment } of graphemes.segment(value)) {
    const size = cellWidth(segment);
    if (used + size > budget) break;
    text += segment;
    used += size;
  }
  return { text, used };
}

function clampPrefix(prefixParts, width) {
  const maxPrefix = Math.max(0, Math.min(width - 1, Math.floor(width * 0.45)));
  if (spansWidth(prefixParts) <= maxPrefix) return prefixParts;
  const trimmed = [];
  let used = 0;
  for (const part of prefixParts) {
    if (used >= maxPrefix) break;
    const slice = takeGraphemesWithinBudget(part.text, maxPrefix - used);
    used += slice.used;
    if (slice.text) trimmed.push({ text: slice.text, style: part.style });
  }
  return trimmed;
}

function wrapSpans(spans, width, { color = false, firstPrefix = [], restPrefix = [] } = {}) {
  width = Math.max(1, Math.floor(width));
  const headPrefix = width >= 4 ? clampPrefix(firstPrefix, width) : [];
  const tailPrefix = width >= 4 ? clampPrefix(restPrefix, width) : [];
  const tokens = tokenizeSpans(spans);
  if (tokens.length === 0) {
    return [fitStyled(renderParts(headPrefix, color), width).trimEnd()];
  }

  const lines = [];
  let isFirstLine = true;
  let currentPrefix = headPrefix;
  let currentParts = [...currentPrefix];
  let currentWidth = spansWidth(currentPrefix);
  let hasContent = false;

  const pushCurrentLine = () => {
    while (currentParts.length > currentPrefix.length) {
      const last = currentParts.at(-1);
      const trimmed = last.text.trimEnd();
      if (trimmed.length === last.text.length) break;
      if (trimmed) {
        last.text = trimmed;
        break;
      }
      currentParts.pop();
    }
    lines.push(renderParts(currentParts, color));
    isFirstLine = false;
    currentPrefix = tailPrefix;
    currentParts = [...currentPrefix];
    currentWidth = spansWidth(currentPrefix);
    hasContent = false;
  };

  for (const token of tokens) {
    if (token.isSpace) {
      if (!hasContent) continue;
      if (currentWidth + 1 <= width) {
        currentParts.push({ text: " ", style: token.parts[0]?.style || "" });
        currentWidth += 1;
      }
      continue;
    }

    if (hasContent && currentWidth + token.width > width) {
      pushCurrentLine();
    }

    const prefixBudget = spansWidth(currentPrefix);
    if (!hasContent && prefixBudget + token.width <= width) {
      currentParts.push(...token.parts);
      currentWidth += token.width;
      hasContent = true;
      continue;
    }

    if (hasContent && currentWidth + token.width <= width) {
      currentParts.push(...token.parts);
      currentWidth += token.width;
      continue;
    }

    for (const part of token.parts) {
      for (const { segment } of graphemes.segment(part.text)) {
        const size = cellWidth(segment);
        if (size > width) {
          if (hasContent) pushCurrentLine();
          currentParts.push({ text: "?", style: part.style });
          currentWidth += 1;
          hasContent = true;
          continue;
        }
        if (currentWidth + size > width && (hasContent || currentWidth > 0)) {
          pushCurrentLine();
        }
        currentParts.push({ text: segment, style: part.style });
        currentWidth += size;
        hasContent = true;
      }
    }
  }

  if (hasContent || isFirstLine) {
    pushCurrentLine();
  }
  return lines;
}

function wrapVerbatimLine(rawLine, width, { color = false, prefix = "", style = "mdCode" } = {}) {
  width = Math.max(1, Math.floor(width));
  const cleanLine = plain(rawLine.replaceAll("\t", "  "));
  const activePrefix = width >= displayWidth(prefix) + 4 ? prefix : "";
  const prefixWidth = displayWidth(activePrefix);
  const bodyBudget = Math.max(1, width - prefixWidth);
  const styledPrefix = activePrefix ? tone(activePrefix, "mdCodeBorder", color) : "";

  if (!cleanLine) return [styledPrefix];

  const slices = [];
  let current = "";
  let used = 0;
  for (const { segment } of graphemes.segment(cleanLine)) {
    const size = cellWidth(segment);
    if (size > bodyBudget) {
      if (current) slices.push(current);
      slices.push("?");
      current = "";
      used = 0;
      continue;
    }
    if (used + size > bodyBudget && current) {
      slices.push(current);
      current = "";
      used = 0;
    }
    current += segment;
    used += size;
  }
  if (current || slices.length === 0) slices.push(current);

  return slices.map((slice) => `${styledPrefix}${style ? tone(slice, style, color) : slice}`);
}

function splitTableCells(line) {
  let trimmed = plain(line).trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);
  return trimmed.split("|").map((cell) => stripInlineMarkdown(cell).trim());
}

function renderMarkdownTable(tableLines, width, { color = false, tier = "unicode" } = {}) {
  const glyphs = glyphSet(tier);
  const headers = splitTableCells(tableLines[0]);
  const columnCount = Math.max(1, headers.length);
  const bodyRows = tableLines.slice(2).map((line) => {
    const cells = splitTableCells(line);
    while (cells.length < columnCount) cells.push("");
    return cells.slice(0, columnCount);
  });

  if (width < columnCount * 4) {
    return [headers, ...bodyRows].flatMap((row) =>
      wrapSpans([{ text: row.filter(Boolean).join(" · "), style: "" }], width, { color }),
    );
  }

  const joinerPlain = ` ${glyphs.vertical} `;
  const joinerStyled = tone(joinerPlain, "muted", color);
  const available = Math.max(
    columnCount,
    width - displayWidth(joinerPlain) * Math.max(0, columnCount - 1),
  );
  const naturalWidths = headers.map((header, column) =>
    Math.max(
      3,
      displayWidth(header),
      ...bodyRows.map((row) => Math.min(36, displayWidth(row[column] || ""))),
    ),
  );
  const totalNatural = naturalWidths.reduce((sum, item) => sum + item, 0) || columnCount;
  const colWidths = naturalWidths.map((natural) =>
    Math.max(1, Math.floor((available * natural) / totalNatural)),
  );
  let leftover = available - colWidths.reduce((sum, item) => sum + item, 0);
  for (let idx = 0; leftover > 0; idx = (idx + 1) % columnCount, leftover -= 1) {
    colWidths[idx] += 1;
  }
  while (
    colWidths.reduce((sum, item) => sum + item, 0) +
      displayWidth(joinerPlain) * Math.max(0, columnCount - 1) >
    width
  ) {
    const widest = colWidths.indexOf(Math.max(...colWidths));
    if (colWidths[widest] <= 1) break;
    colWidths[widest] -= 1;
  }

  const wrapCell = (text, colWidth) =>
    wrapSpans([{ text, style: "" }], colWidth, { color: false }).map((cell) => fit(cell, colWidth));

  const headerWrapped = headers.map((header, idx) => wrapCell(header, colWidths[idx]));
  const headerHeight = Math.max(1, ...headerWrapped.map((cells) => cells.length));
  const output = [];
  for (let lineIdx = 0; lineIdx < headerHeight; lineIdx += 1) {
    output.push(
      headerWrapped
        .map((cells, colIdx) =>
          tone(cells[lineIdx] || " ".repeat(colWidths[colIdx]), "heading", color),
        )
        .join(joinerStyled),
    );
  }
  output.push(
    colWidths
      .map((colWidth) => tone(glyphs.separator.repeat(colWidth), "mdRule", color))
      .join(joinerStyled),
  );
  for (const row of bodyRows) {
    const wrappedCells = row.map((cell, idx) => wrapCell(cell, colWidths[idx]));
    const rowHeight = Math.max(1, ...wrappedCells.map((cells) => cells.length));
    for (let lineIdx = 0; lineIdx < rowHeight; lineIdx += 1) {
      output.push(
        wrappedCells
          .map((cells, colIdx) => cells[lineIdx] || " ".repeat(colWidths[colIdx]))
          .join(joinerStyled),
      );
    }
  }
  return output;
}

function renderHeading(level, headingText, width, { color = false, tier = "unicode" } = {}) {
  switch (level) {
    case 1: {
      const cleanHeading = stripInlineMarkdown(headingText);
      if (displayWidth(cleanHeading) + 2 <= width) {
        return [tone(` ${cleanHeading} `, "mdH1", color)];
      }
      const marker = tier === "ascii" ? "# " : "▌ ";
      const h1Spans = parseInlineSpans(headingText, "heading");
      return wrapSpans(h1Spans, width, {
        color,
        firstPrefix: [{ text: marker, style: "mdH2" }],
        restPrefix: [{ text: "  ", style: "" }],
      });
    }
    case 2: {
      const marker = tier === "ascii" ? "## " : "▍ ";
      const h2Spans = parseInlineSpans(headingText, "mdH2");
      return wrapSpans(h2Spans, width, {
        color,
        firstPrefix: [{ text: marker, style: "mdH2" }],
        restPrefix: [{ text: "  ", style: "" }],
      });
    }
    case 3: {
      const marker = tier === "ascii" ? "> " : "▸ ";
      const h3Spans = parseInlineSpans(headingText, "mdH3");
      return wrapSpans(h3Spans, width, {
        color,
        firstPrefix: [{ text: marker, style: "mdH3" }],
        restPrefix: [{ text: "  ", style: "" }],
      });
    }
    default: {
      const marker = tier === "ascii" ? "- " : "· ";
      const h4Spans = parseInlineSpans(headingText, "mdH4");
      return wrapSpans(h4Spans, width, {
        color,
        firstPrefix: [{ text: marker, style: "mdH4" }],
        restPrefix: [{ text: "  ", style: "" }],
      });
    }
  }
}

/** Render room log rows with sender and repeat-count styling. */
export function renderLogLine(
  from,
  text,
  count,
  width,
  { color = false, tier = glyphTier() } = {},
) {
  color = normalizeColor(color);
  const sender = `${plain(from)}:`;
  const bodySpans = parseInlineSpans(text);
  if (count > 1) {
    bodySpans.push({ text: ` (×${count})`, style: "warning" });
  }
  return wrapSpans(bodySpans, width, {
    color,
    firstPrefix: [
      { text: sender, style: "mdSection" },
      { text: " ", style: "" },
    ],
    restPrefix: [{ text: "  ", style: "" }],
    tier,
  });
}

/**
 * Format structured agent activity and Markdown prose into width-safe, SGR-styled
 * terminal lines using the active Orkest TUI theme.
 */
export function renderMarkdown(value, width, { color = false, tier = glyphTier() } = {}) {
  color = normalizeColor(color);
  width = Math.max(1, Math.floor(width));
  const glyphs = glyphSet(tier);
  const rawLines = String(value ?? "")
    .replaceAll("\r\n", "\n")
    .split("\n");
  const output = [];
  let blankRun = 0;
  let index = 0;

  while (index < rawLines.length) {
    const rawLine = rawLines[index];
    const cleanLine = plain(rawLine);
    const trimmed = cleanLine.trim();

    const fenceMatch = cleanLine.match(FENCE_OPEN_RE);
    if (fenceMatch) {
      blankRun = 0;
      const fenceMarker = fenceMatch[1];
      const fenceChar = fenceMarker[0];
      const info = fenceMatch[2].trim();
      const isDiff = /^(?:diff|patch)\b/iu.test(info);
      const codeRail = tier === "ascii" ? "  | " : "  │ ";
      if (info && width >= 8) {
        const label = fit(info, Math.max(1, width - displayWidth(codeRail))).trimEnd();
        output.push(`${tone(codeRail, "mdCodeBorder", color)}${tone(label, "muted", color)}`);
      }
      index += 1;
      const closePattern = new RegExp(
        String.raw`^ {0,3}${fenceChar}{${fenceMarker.length},}\s*$`,
        "u",
      );
      while (index < rawLines.length && !closePattern.test(plain(rawLines[index]))) {
        const codeLine = rawLines[index];
        let lineStyle = "mdCode";
        if (isDiff) {
          if (codeLine.startsWith("+") && !codeLine.startsWith("+++")) lineStyle = "success";
          else if (codeLine.startsWith("-") && !codeLine.startsWith("---")) lineStyle = "error";
        }
        output.push(
          ...wrapVerbatimLine(codeLine, width, { color, prefix: codeRail, style: lineStyle }),
        );
        index += 1;
      }
      if (index < rawLines.length) index += 1;
      continue;
    }

    if (!trimmed) {
      blankRun += 1;
      if (blankRun === 1 && output.length > 0) output.push("");
      index += 1;
      continue;
    }
    blankRun = 0;

    if (trimmed === "No recorded activity yet.") {
      output.push(...wrapSpans([{ text: trimmed, style: "muted" }], width, { color }));
      index += 1;
      continue;
    }

    if (
      cleanLine.includes("|") &&
      index + 1 < rawLines.length &&
      TABLE_SEPARATOR_RE.test(plain(rawLines[index + 1]))
    ) {
      const tableBlock = [cleanLine, plain(rawLines[index + 1])];
      index += 2;
      while (
        index < rawLines.length &&
        plain(rawLines[index]).includes("|") &&
        plain(rawLines[index]).trim() !== ""
      ) {
        tableBlock.push(plain(rawLines[index]));
        index += 1;
      }
      output.push(...renderMarkdownTable(tableBlock, width, { color, tier }));
      continue;
    }

    if (HORIZONTAL_RULE_RE.test(cleanLine)) {
      output.push(tone(glyphs.separator.repeat(width), "mdRule", color));
      index += 1;
      continue;
    }

    const bannerMatch = trimmed.match(SECTION_BANNER_RE);
    if (bannerMatch) {
      const label = `${bannerMatch[1]}:`;
      if (displayWidth(label) >= width) {
        output.push(tone(fit(label, width).trimEnd(), "mdSection", color));
      } else {
        const ruleWidth = Math.max(0, width - displayWidth(label) - 1);
        const rule = ruleWidth >= 2 ? ` ${glyphs.horizontal.repeat(ruleWidth)}` : "";
        output.push(`${tone(label, "mdSection", color)}${rule ? tone(rule, "mdRule", color) : ""}`);
      }
      index += 1;
      continue;
    }

    if (cleanLine.startsWith("Task: ") || cleanLine.startsWith("Asked: ")) {
      const colonIdx = cleanLine.indexOf(":");
      const label = cleanLine.slice(0, colonIdx + 1);
      const taskSpans = parseInlineSpans(cleanLine.slice(colonIdx + 2));
      output.push(
        ...wrapSpans(taskSpans, width, {
          color,
          firstPrefix: [
            { text: label, style: "mdSection" },
            { text: " ", style: "" },
          ],
          restPrefix: [{ text: "  ", style: "" }],
        }),
      );
      index += 1;
      continue;
    }

    if (cleanLine.startsWith("Question: ")) {
      const questionSpans = parseInlineSpans(cleanLine.slice(10));
      output.push(
        ...wrapSpans(questionSpans, width, {
          color,
          firstPrefix: [
            { text: "Question:", style: "warning bold" },
            { text: " ", style: "" },
          ],
          restPrefix: [{ text: "  ", style: "" }],
        }),
      );
      index += 1;
      continue;
    }

    if (cleanLine.startsWith("Error: ")) {
      const errorSpans = parseInlineSpans(cleanLine.slice(7), "error");
      output.push(
        ...wrapSpans(errorSpans, width, {
          color,
          firstPrefix: [
            { text: "Error:", style: "error bold" },
            { text: " ", style: "" },
          ],
          restPrefix: [{ text: "  ", style: "" }],
        }),
      );
      index += 1;
      continue;
    }

    if (cleanLine.startsWith("Uncertainty: ")) {
      const rest = cleanLine.slice(13);
      const isNone = /^none\.?$/iu.test(rest.trim());
      const uncertaintySpans = parseInlineSpans(rest, isNone ? "muted" : "");
      output.push(
        ...wrapSpans(uncertaintySpans, width, {
          color,
          firstPrefix: [
            { text: "Uncertainty:", style: isNone ? "muted bold" : "warning bold" },
            { text: " ", style: "" },
          ],
          restPrefix: [{ text: "  ", style: "" }],
        }),
      );
      index += 1;
      continue;
    }

    if (cleanLine.startsWith("Verification: ")) {
      const rest = cleanLine.slice(14);
      const verificationSpans = parseInlineSpans(rest, verificationTone(rest));
      output.push(
        ...wrapSpans(verificationSpans, width, {
          color,
          firstPrefix: [
            { text: "Verification:", style: "mdSection" },
            { text: " ", style: "" },
          ],
          restPrefix: [{ text: "  ", style: "" }],
        }),
      );
      index += 1;
      continue;
    }

    const headingMatch = cleanLine.match(ATX_HEADING_RE);
    if (headingMatch) {
      output.push(
        ...renderHeading(headingMatch[1].length, headingMatch[2], width, { color, tier }),
      );
      index += 1;
      continue;
    }

    const outcomeMatch = cleanLine.match(OUTCOME_LINE_RE);
    if (outcomeMatch) {
      const outcome = outcomeMatch[1];
      let outcomeStyle = "success bold";
      let outcomeGlyph = glyphs.completed;
      if (outcome === "PARTIAL" || outcome === "BLOCKED") {
        outcomeStyle = "warning bold";
        outcomeGlyph = glyphs.blocked;
      } else if (outcome === "FAILED") {
        outcomeStyle = "error bold";
        outcomeGlyph = tier === "ascii" ? "x" : "✗";
      }
      output.push(
        ...wrapSpans([{ text: `${outcomeGlyph} ${outcome}`, style: outcomeStyle }], width, {
          color,
        }),
      );
      index += 1;
      continue;
    }

    const toolMatch = cleanLine.match(TOOL_EVENT_RE);
    if (toolMatch) {
      const [, toolName, detail, count] = toolMatch;
      const spans = [{ text: toolName, style: "mdCode bold" }];
      if (detail) {
        spans.push({ text: " · ", style: "muted" }, { text: detail, style: "muted" });
      }
      if (count) {
        spans.push({ text: ` (${count})`, style: "warning" });
      }
      output.push(
        ...wrapSpans(spans, width, {
          color,
          firstPrefix: [{ text: "Used ", style: "muted" }],
          restPrefix: [{ text: "  ", style: "" }],
        }),
      );
      index += 1;
      continue;
    }

    const quoteMatch = cleanLine.match(BLOCKQUOTE_RE);
    if (quoteMatch) {
      const bar = tier === "ascii" ? "| " : "▎ ";
      const quoteSpans = parseInlineSpans(quoteMatch[1], "mdQuote");
      output.push(
        ...wrapSpans(quoteSpans, width, {
          color,
          firstPrefix: [{ text: bar, style: "mdQuoteBar" }],
          restPrefix: [{ text: bar, style: "mdQuoteBar" }],
        }),
      );
      index += 1;
      continue;
    }

    const listMatch = cleanLine.match(LIST_ITEM_RE);
    if (listMatch) {
      const [, rawIndent, unorderedMark, orderedMark, rawBody] = listMatch;
      const indent = " ".repeat(Math.min(6, Math.floor(rawIndent.length / 2) * 2));
      const prefixParts = indent ? [{ text: indent, style: "" }] : [];
      let itemBody = rawBody;
      let markerWidth;

      const taskBox = unorderedMark ? itemBody.match(TASK_BOX_RE) : null;
      if (taskBox) {
        const isChecked = taskBox[1].toLowerCase() === "x";
        let boxGlyph = "☐ ";
        if (isChecked) {
          boxGlyph = `${glyphs.completed} `;
        } else if (tier === "ascii") {
          boxGlyph = "[ ] ";
        }
        prefixParts.push({ text: boxGlyph, style: isChecked ? "success bold" : "muted" });
        markerWidth = displayWidth(boxGlyph);
        itemBody = taskBox[2];
      } else if (orderedMark) {
        const numLabel = `${orderedMark} `;
        prefixParts.push({ text: numLabel, style: "mdBullet bold" });
        markerWidth = displayWidth(numLabel);
      } else {
        const bullet = tier === "ascii" ? "- " : "• ";
        prefixParts.push({ text: bullet, style: "mdBullet" });
        markerWidth = displayWidth(bullet);
      }

      const tagMatch = itemBody.match(MESSAGE_TAG_RE);
      if (tagMatch) {
        prefixParts.push(
          { text: tagMatch[1], style: badgeToneForTag(tagMatch[1]) },
          { text: " ", style: "" },
        );
        itemBody = tagMatch[2];
      }

      const hangIndent = " ".repeat(displayWidth(indent) + markerWidth);
      const itemSpans = parseInlineSpans(itemBody);
      output.push(
        ...wrapSpans(itemSpans, width, {
          color,
          firstPrefix: prefixParts,
          restPrefix: [{ text: hangIndent, style: "" }],
        }),
      );
      index += 1;
      continue;
    }

    const lineSpans = parseInlineSpans(cleanLine);
    output.push(...wrapSpans(lineSpans, width, { color }));
    index += 1;
  }

  if (output.length === 0) return [""];
  return output;
}
