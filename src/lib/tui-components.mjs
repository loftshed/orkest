/** Composable terminal presentation, built on the width-safe text and frame helpers. */
import { allBrandMarks, brandForProvider } from "./families-schema.mjs";
import { normalizeAccountTags } from "./policy.mjs";
import { displayWidth, fit, fitStyled, frame, glyphSet, plain, tone } from "./tui-box.mjs";

const SCOPE_TAGS = new Set(["business", "personal", "work"]);

export const WIDE_NERD_BRANDS = new Set(["\u{EC81}", "\u{EC82}"]);

export function providerMark(provider, tier = "nerd") {
  if (tier !== "nerd") return "";
  return brandForProvider(provider)?.glyph || "";
}

/** Only explicit account identity or tags determine ownership. */
export function quotaAccountScope(account) {
  if (!account || typeof account !== "object") return "";
  const tags = normalizeAccountTags(account);
  if (tags.includes("work") || tags.includes("business")) return "work";
  if (tags.includes("personal") || account.personal === true) return "personal";
  const identity =
    `${account.id || ""} ${account.alias || ""} ${account.label || ""}`.toLowerCase();
  if (/(?:^|[\s·_-])(?:work|business)(?:$|[\s·_-])/u.test(identity) || account.short === "CW")
    return "work";
  if (/(?:^|[\s·_-])personal(?:$|[\s·_-])/u.test(identity) || account.short === "CP")
    return "personal";
  return "";
}

/** Format explicit non-scope tags (or fallback category/billing) as a compact badge. */
export function quotaAccountTagBadge(account) {
  if (!account || typeof account !== "object") return "";
  const tags = normalizeAccountTags(account);
  const customTags = tags.filter((tag) => !SCOPE_TAGS.has(tag));
  if (customTags.length > 0) return customTags.map((tag) => `[${tag}]`).join(" ");
  const category =
    typeof account.category === "string" ? account.category.trim().toLowerCase() : "";
  if (category) return `[${category}]`;
  const scope = quotaAccountScope(account);
  if (scope) return `[${scope}]`;
  return "";
}

/** Apply brand colors after row styling, restoring the surrounding style after each icon. */
export function colorProviderMarks(line, color) {
  const enabled = typeof color === "object" ? color?.enabled : color;
  if (!enabled) return line;
  const marks = allBrandMarks();
  if (marks.length === 0) return line;
  let surrounding = "";
  const escape = String.fromCodePoint(27);
  const styles = Object.fromEntries(marks.map((entry) => [entry.glyph, entry.tone]));
  const glyphs = marks.map((entry) => entry.glyph).join("");
  const tokens = new RegExp(String.raw`${escape}\[[0-9;]*m|[${glyphs}]`, "gu");
  return String(line).replaceAll(tokens, (token) => {
    if (token.startsWith(escape)) {
      surrounding = token === `${escape}[0m` ? "" : surrounding + token;
      return token;
    }
    return tone(token, styles[token], color) + surrounding;
  });
}

export function quotaAccountLabel(account, tier = "nerd") {
  const label = plain(account.short || account.id || "?");
  if (tier !== "nerd") return label;
  const accountScope = quotaAccountScope(account);
  const scope = { work: "\u{F1AD}", personal: "\u{F007}" }[accountScope] || "";
  const customTags = normalizeAccountTags(account).filter((tag) => !SCOPE_TAGS.has(tag));
  const tagBadge = customTags.map((tag) => `[${tag}]`).join(" ");
  const brand = providerMark(account.provider, tier);
  const name = brand && ["AG", "CX", "CL"].includes(label) ? "" : label;
  const rest = [scope, name, tagBadge].filter(Boolean).join(" ");
  if (!brand) return rest;
  if (!rest) return brand;
  return `${brand}${WIDE_NERD_BRANDS.has(brand) ? "  " : " "}${rest}`;
}

export function disclosure(label, expanded, tier = "nerd") {
  let chevron = expanded ? "\u{F078}" : "\u{F054}";
  if (tier === "unicode") chevron = expanded ? "▾" : "▸";
  else if (tier === "ascii") chevron = expanded ? "v" : ">";
  const text = plain(label);
  return text ? `${chevron} ${text}` : chevron;
}

function formatActionItem(action, width, tier) {
  const rawSource = action.hint || action.key || "";
  let rawHint;
  if (!action.hint && (rawSource === "\r" || rawSource === "\n")) rawHint = "Enter";
  else if (!action.hint && rawSource === "\u{1B}") rawHint = "Esc";
  else rawHint = plain(rawSource).trim();
  if (tier === "ascii") rawHint = rawHint.replaceAll("↑", "^").replaceAll("↓", "v");

  const labelText = plain(action.label);
  const prefix = rawHint ? `${rawHint} ` : "";
  const cleanLabel =
    prefix && labelText.startsWith(prefix) ? labelText.slice(prefix.length) : labelText;
  const rawItem = rawHint ? `${rawHint} ${cleanLabel}` : cleanLabel;
  const text = elide(rawItem, width, tier).trimEnd();
  let keyPart = "";
  let labelPart = text;
  if (rawHint) {
    if (text.startsWith(rawHint)) {
      keyPart = rawHint;
      labelPart = text.slice(rawHint.length);
    } else {
      keyPart = text;
      labelPart = "";
    }
  }
  return { action, text, keyPart, labelPart, cells: displayWidth(text) };
}

function styleActionItem({ action, text, keyPart, labelPart }, { color, hovered }) {
  if (action.disabled) return tone(text, "muted", color);
  if (hovered === action.id) return tone(text, "quotaHover", color);
  if (action.danger) return tone(text, "error bold", color);
  let keyTone = "heading";
  let labelTone = "muted";
  if (action.active) {
    keyTone = "accepted bold";
    labelTone = "accepted";
  } else if (action.primary) {
    keyTone = "leadModel";
    labelTone = "heading";
  }
  return (
    (keyPart ? tone(keyPart, keyTone, color) : "") +
    (labelPart ? tone(labelPart, labelTone, color) : "")
  );
}

/** Key-hint geometry and text share one layout, including wrapped and narrow toolbars. */
export function actionBar(actions, width, { color = false, hovered, tier = "unicode" } = {}) {
  const lines = [""];
  const targets = [];
  width = Math.max(1, width);
  const items = actions.map((action) => formatActionItem(action, width, tier));
  const wideSep = tier === "ascii" ? "  |  " : "  ·  ";
  const compactSep = tier === "ascii" ? " | " : " · ";
  const wideWidth = displayWidth(wideSep);
  const compactWidth = displayWidth(compactSep);
  const itemTotal = items.reduce((sum, item) => sum + item.cells, 0);
  const gapCount = Math.max(0, items.length - 1);
  const isCompact =
    gapCount > 0 &&
    itemTotal + gapCount * wideWidth > width &&
    itemTotal + gapCount * compactWidth <= width;
  const sepPlain = isCompact ? compactSep : wideSep;
  const sepWidth = displayWidth(sepPlain);
  const sep = tone(sepPlain, "leadSeparator", color);
  for (const item of items) {
    let row = lines.length - 1;
    let used = displayWidth(lines[row]);
    if (used && used + sepWidth + item.cells > width) {
      lines.push("");
      row++;
      used = 0;
    }
    const x = used + (used ? sepWidth + 1 : 1);
    lines[row] += `${used ? sep : ""}${styleActionItem(item, { color, hovered })}`;
    if (!item.action.disabled)
      targets.push({
        id: item.action.id,
        key: item.action.key,
        x,
        y: row + 1,
        width: item.cells,
        height: 1,
      });
  }
  return { lines, targets };
}

export function quotaHealthTone(remainingPct) {
  if (!Number.isFinite(remainingPct) || remainingPct <= 10) return "error";
  if (remainingPct <= 25) return "quotaLow";
  if (remainingPct <= 50) return "quotaMid";
  return "quotaOk";
}

export function lineGauge(value, width, { color = false, tier = "unicode" } = {}) {
  width = Math.max(0, Math.floor(width));
  const ratio = Math.max(0, Math.min(1, Number(value) || 0));
  const filledGlyph = tier === "ascii" ? "=" : "━";
  const emptyGlyph = tier === "ascii" ? "-" : "─";
  let filled = Math.round(ratio * width);
  if (ratio > 0 && filled === 0 && width > 0) filled = 1;
  if (ratio < 0.95 && filled === width && width > 1) filled = width - 1;
  const empty = Math.max(0, width - filled);
  const fillTone = quotaHealthTone(ratio * 100);
  const filledPart = filled > 0 ? tone(filledGlyph.repeat(filled), fillTone, color) : "";
  const emptyPart = empty > 0 ? tone(emptyGlyph.repeat(empty), "quotaTrack", color) : "";
  return `${filledPart}${emptyPart}`;
}

/** Keep each compact meter intact when wrapping a quota strip. */
export function meterStrip(
  label,
  meters,
  width,
  { color = false, tier = "unicode", hovered = false, accent = "success" } = {},
) {
  const prepared = meters.map((meter) => {
    const hasValue = Number.isFinite(meter.remaining);
    const remaining = hasValue
      ? Math.round(Math.max(0, Math.min(100, meter.remaining)))
      : undefined;
    const state = hasValue ? `${remaining}%` : meter.detail || "unavailable";
    const labelText = plain(meter.label);
    const labelGap = tier === "nerd" && WIDE_NERD_BRANDS.has([...labelText].at(-1)) ? "  " : " ";
    return { hasValue, remaining, state, labelText, labelGap };
  });
  const layouts = [
    { barCells: 4, itemGap: "  ", headGap: label ? "  " : "" },
    { barCells: 3, itemGap: "  ", headGap: label ? "  " : "" },
    { barCells: 3, itemGap: " ", headGap: label ? " " : "" },
    { barCells: 2, itemGap: " ", headGap: label ? " " : "" },
  ];
  let chosen = layouts.at(-1);
  for (const candidate of layouts) {
    const headLen = displayWidth(`${label}${candidate.headGap}`);
    let total = headLen;
    for (const [idx, item] of prepared.entries()) {
      const br = item.hasValue
        ? `${lineGauge(item.remaining / 100, candidate.barCells, { color: false, tier })} `
        : "";
      const itemLen = displayWidth(`${item.labelText}${item.labelGap}${br}${item.state}`);
      total += (idx > 0 ? candidate.itemGap.length : 0) + itemLen;
    }
    if (total <= width) {
      chosen = candidate;
      break;
    }
  }
  const heading = label ? `${label}${chosen.headGap}` : "";
  const indent = " ".repeat(Math.min(displayWidth(heading), Math.max(0, width - 20)));
  const lines = [heading ? tone(heading, hovered ? "quotaHover" : accent, color) : ""];
  for (const item of prepared) {
    const plainBar = item.hasValue
      ? `${lineGauge(item.remaining / 100, chosen.barCells, { color: false, tier })} `
      : "";
    const content = `${item.labelText}${item.labelGap}${plainBar}${item.state}`;
    let row = lines.length - 1;
    const gap =
      displayWidth(lines[row]) > displayWidth(row === 0 ? heading : indent) ? chosen.itemGap : "";
    if (
      displayWidth(lines[row]) + gap.length + displayWidth(content) > width &&
      displayWidth(lines[row]) > displayWidth(row === 0 ? heading : indent)
    ) {
      lines.push(indent);
      row++;
    } else lines[row] += gap;
    if (item.hasValue) {
      const barPart = lineGauge(item.remaining / 100, chosen.barCells, { color, tier });
      let pctTone = "muted";
      if (item.remaining <= 10) pctTone = "error";
      else if (item.remaining <= 25) pctTone = "quotaLow";
      else if (item.remaining <= 50) pctTone = "quotaMid";
      lines[row] +=
        `${item.labelText}${item.labelGap}${barPart} ${tone(item.state, pctTone, color)}`;
    } else {
      lines[row] += tone(content, accent, color);
    }
  }
  return lines.map((line) => fitStyled(line, width));
}

export function hitTest(targets, x, y) {
  return targets.findLast(
    (target) =>
      x >= target.x && x < target.x + target.width && y >= target.y && y < target.y + target.height,
  );
}

function elide(text, width, tier) {
  const value = plain(text);
  if (displayWidth(value) <= width) return fit(value, width);
  const mark = tier === "ascii" ? "..." : "…";
  if (width <= displayWidth(mark)) return fit(value, width);
  return fit(value, width - displayWidth(mark)) + mark;
}

/** Keep a section's count visible while long names give up space first. */
export function sectionHeading(
  label,
  detail,
  width,
  { prefix = "", color = false, tier = "unicode", separator = " · ", detailParts = null } = {},
) {
  const available = Math.max(0, width - displayWidth(prefix));
  const text = detailParts?.length
    ? detailParts.map((part) => plain(part.text)).join("  ·  ")
    : plain(detail);
  const suffix = text ? `${separator}${text}` : "";
  const styledSuffix = detailParts?.length
    ? tone(separator, "muted", color) +
      detailParts
        .map((part) => tone(plain(part.text), part.style, color))
        .join(tone("  ·  ", "muted", color))
    : tone(suffix, "muted", color);
  const nameWidth = Math.max(0, available - displayWidth(suffix));
  const name =
    displayWidth(label) > nameWidth ? elide(label, nameWidth, tier).trimEnd() : plain(label);
  return fitStyled(
    tone(prefix, "border", color) +
      fitStyled(tone(name, "heading", color) + styledSuffix, available),
    width,
  );
}

/** A summary row reserves space for its state instead of clipping it after its label. */
export function statusRow(
  label,
  status,
  width,
  {
    prefix = "",
    color = false,
    style = "muted",
    tier = "unicode",
    badge = "",
    badgeStyle = "button",
    chevron = "",
    hovered = false,
  } = {},
) {
  const available = Math.max(0, width - displayWidth(prefix));
  const state = plain(status);
  const chevronSuffix = chevron ? ` ${plain(chevron)}` : "";
  const rightText = ` | ${state}${chevronSuffix}`;
  const stateWidth = Math.min(available, displayWidth(rightText));
  const labelWidth = Math.max(0, available - stateWidth);
  const right = fit(rightText, stateWidth);
  const rowStyle = hovered ? "quotaHover" : style;
  if (badge) {
    const badgeText = plain(badge);
    const pillTone = hovered ? "buttonHover" : badgeStyle;
    if (displayWidth(badgeText) >= labelWidth) {
      const clippedBadge = elide(badgeText, labelWidth, tier);
      return fitStyled(
        tone(prefix, "border", color) +
          tone(clippedBadge, pillTone, color) +
          tone(right, rowStyle, color),
        width,
      );
    }
    const restWidth = Math.max(0, labelWidth - displayWidth(badgeText));
    const rest = elide(label, restWidth, tier);
    return fitStyled(
      tone(prefix, "border", color) +
        tone(badgeText, pillTone, color) +
        tone(rest, rowStyle, color) +
        tone(right, rowStyle, color),
      width,
    );
  }
  const left = elide(label, labelWidth, tier);
  return fitStyled(
    tone(prefix, "border", color) + tone(left, rowStyle, color) + tone(right, rowStyle, color),
    width,
  );
}

/** Attach a framed card to a tree without exposing border/ANSI arithmetic to its caller. */
export function treeCard(
  title,
  lines,
  width,
  {
    topPrefix = "",
    midPrefix = "",
    tailPrefix = "",
    right = "",
    color = false,
    tier = "unicode",
    emphasized = false,
    hovered = false,
  } = {},
) {
  const cardWidth = Math.max(1, width - displayWidth(midPrefix));
  const glyphs = glyphSet(tier);
  let headerTone = "button";
  if (hovered) headerTone = "buttonHover";
  else if (emphasized) headerTone = "agentSelected";
  const box = frame(title, lines, cardWidth, {
    glyphs,
    color,
    right,
    headerTone,
  });
  const midIndex = Math.max(1, Math.floor((box.length - 1) / 2));
  return box.map((line, index) => {
    let prefix = tailPrefix;
    if (index < midIndex) prefix = topPrefix;
    else if (index === midIndex) {
      prefix = midPrefix;
      const border = tone(glyphs.vertical, "border", color);
      if (cardWidth >= 4 && line.startsWith(border)) {
        line = tone(tier === "ascii" ? "+" : "┤", "border", color) + line.slice(border.length);
      }
    }
    return fitStyled(tone(prefix, "border", color) + line, width);
  });
}
