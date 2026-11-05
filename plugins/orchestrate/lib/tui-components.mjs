/** Composable terminal presentation, built on the width-safe text and frame helpers. */
import { displayWidth, fit, fitStyled, frame, glyphSet, plain, tone } from "./tui-box.mjs";

const CONTROL_ICONS = Object.freeze({
  preview: "\u{F086}",
  open: "\u{F120}",
  inactive: "\u{F1DA}",
  services: "\u{F233}",
  update: "\u{F021}",
  logs: "\u{F03A}",
  pin: "\u{F08D}",
  page: "\u{F061}",
  help: "\u{F11C}",
  mouse: "\u{F245}",
  close: "\u{F00D}",
  dismiss: "\u{F060}",
  "scroll-up": "\u{F062}",
  "scroll-down": "\u{F063}",
  "preview-back": "\u{F03A}",
  "preview-open": "\u{F120}",
  "preview-follow": "\u{F021}",
  "preview-up": "\u{F062}",
  "preview-down": "\u{F063}",
  "preview-previous": "\u{F060}",
  "preview-next": "\u{F061}",
  return: "\u{F060}",
});

export function providerMark(provider, tier = "nerd") {
  if (tier !== "nerd") return "";
  const name = String(provider || "").toLowerCase();
  if (/^(?:claude|anthropic|opus|sonnet|haiku|fable|mythos)(?:$|[-_.:/\s\d])/u.test(name))
    return "\u{EC82}";
  if (/^(?:gemini|google|agy|antigravity|argon|flash)(?:$|[-_.:/\s\d])/u.test(name))
    return "\u{E7F0}";
  if (/^(?:gpt|codex|openai|astra|sol|terra|luna)(?:$|[-_.:/\s\d])/u.test(name)) return "\u{EC81}";
  return "";
}

/** Only explicit account identity determines ownership. */
export function quotaAccountScope(account) {
  const identity = `${account.id || ""} ${account.label || ""}`.toLowerCase();
  if (/(?:^|[\s·_-])(?:work|business)(?:$|[\s·_-])/u.test(identity) || account.short === "CW")
    return "work";
  if (/(?:^|[\s·_-])(?:personal|plaude)(?:$|[\s·_-])/u.test(identity) || account.short === "CP")
    return "personal";
  return "";
}

/** Apply brand colors after row styling, restoring the surrounding style after each icon. */
export function colorProviderMarks(line, color) {
  const enabled = typeof color === "object" ? color?.enabled : color;
  if (!enabled) return line;
  let surrounding = "";
  const escape = String.fromCodePoint(27);
  const tokens = new RegExp(String.raw`${escape}\[[0-9;]*m|[\u{EC82}\u{E7F0}\u{EC81}]`, "gu");
  const styles = {
    "\u{EC82}": "brandClaude",
    "\u{E7F0}": "brandGoogle",
    "\u{EC81}": "brandOpenAI",
  };
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
  const brand = providerMark(account.provider, tier);
  const name = brand && (label === "AG" || label === "CX") ? "" : label;
  return [brand, scope, name].filter(Boolean).join(" ");
}

export function disclosure(label, expanded, tier = "nerd") {
  let chevron = expanded ? "\u{F078}" : "\u{F054}";
  if (tier === "unicode") chevron = expanded ? "▾" : "▸";
  else if (tier === "ascii") chevron = expanded ? "v" : ">";
  const text = plain(label);
  return text ? `${chevron} ${text}` : chevron;
}

/** Button geometry and text share one layout, including wrapped and narrow toolbars. */
export function actionBar(actions, width, { color = false, hovered, tier = "unicode" } = {}) {
  const lines = [""];
  const targets = [];
  width = Math.max(1, width);
  for (const action of actions) {
    const glyph = CONTROL_ICONS[action.id];
    const icon = tier === "nerd" && glyph ? `${glyph} ` : "";
    const label = elide(`${icon}${action.label}`, Math.max(1, width - 2), tier).trimEnd();
    const text = fit(` ${label} `, Math.min(width, displayWidth(` ${label} `)));
    const cells = displayWidth(text);
    let row = lines.length - 1;
    let used = displayWidth(lines[row]);
    if (used && used + 1 + cells > width) {
      lines.push("");
      row++;
      used = 0;
    }
    const x = used + (used ? 2 : 1);
    let style = "button";
    if (action.primary) style = "buttonPrimary";
    if (action.danger) style = "buttonDanger";
    if (action.active) style = "buttonActive";
    if (hovered === action.id) style = "buttonHover";
    if (action.disabled) style = "buttonDisabled";
    lines[row] += `${used ? " " : ""}${tone(text, style, color)}`;
    if (!action.disabled)
      targets.push({ id: action.id, key: action.key, x, y: row + 1, width: cells, height: 1 });
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
  const layouts = [
    { barCells: 4, itemGap: "  ", headGap: label ? "  " : "" },
    { barCells: 3, itemGap: "  ", headGap: label ? "  " : "" },
    { barCells: 3, itemGap: " ", headGap: label ? " " : "" },
    { barCells: 2, itemGap: " ", headGap: label ? " " : "" },
  ];
  let chosen = layouts[0];
  for (const candidate of layouts) {
    const headLen = displayWidth(`${label}${candidate.headGap}`);
    let total = headLen;
    for (const [idx, meter] of meters.entries()) {
      const hasVal = Number.isFinite(meter.remaining);
      const rem = hasVal ? Math.round(Math.max(0, Math.min(100, meter.remaining))) : undefined;
      const st = hasVal ? `${rem}%` : meter.detail || "unavailable";
      const br = hasVal
        ? `${lineGauge(rem / 100, candidate.barCells, { color: false, tier })} `
        : "";
      const itemLen = displayWidth(`${plain(meter.label)} ${br}${st}`);
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
  for (const meter of meters) {
    const hasValue = Number.isFinite(meter.remaining);
    const remaining = hasValue
      ? Math.round(Math.max(0, Math.min(100, meter.remaining)))
      : undefined;
    const state = hasValue ? `${remaining}%` : meter.detail || "unavailable";
    const plainBar = hasValue
      ? `${lineGauge(remaining / 100, chosen.barCells, { color: false, tier })} `
      : "";
    const content = `${plain(meter.label)} ${plainBar}${state}`;
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
    if (hasValue) {
      const labelPart = plain(meter.label);
      const barPart = lineGauge(remaining / 100, chosen.barCells, { color, tier });
      let pctTone = "muted";
      if (remaining <= 10) pctTone = "error";
      else if (remaining <= 25) pctTone = "quotaLow";
      else if (remaining <= 50) pctTone = "quotaMid";
      lines[row] += `${labelPart} ${barPart} ${tone(state, pctTone, color)}`;
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
  { prefix = "", color = false, tier = "unicode", separator = " · " } = {},
) {
  const available = Math.max(0, width - displayWidth(prefix));
  const suffix = detail ? `${separator}${plain(detail)}` : "";
  const nameWidth = Math.max(0, available - displayWidth(suffix));
  const name =
    displayWidth(label) > nameWidth ? elide(label, nameWidth, tier).trimEnd() : plain(label);
  return fitStyled(
    tone(prefix, "border", color) +
      fitStyled(tone(name, "heading", color) + tone(suffix, "muted", color), available),
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
