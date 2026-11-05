/** Composable terminal presentation, built on the width-safe text and frame helpers. */
import { displayWidth, fit, fitStyled, frame, glyphSet, plain, tone } from "./tui-box.mjs";

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
  { prefix = "", color = false, tier = "unicode" } = {},
) {
  const available = Math.max(0, width - displayWidth(prefix));
  const suffix = detail ? ` · ${plain(detail)}` : "";
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
  { prefix = "", color = false, style = "muted", tier = "unicode" } = {},
) {
  const available = Math.max(0, width - displayWidth(prefix));
  const state = plain(status);
  const stateWidth = Math.min(available, displayWidth(state) + 3);
  const labelWidth = Math.max(0, available - stateWidth);
  const left = elide(label, labelWidth, tier);
  const right = fit(` | ${state}`, stateWidth);
  return fitStyled(
    tone(prefix, "border", color) + tone(left, style, color) + tone(right, style, color),
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
  } = {},
) {
  const cardWidth = Math.max(1, width - displayWidth(midPrefix));
  const glyphs = glyphSet(tier);
  const box = frame(title, lines, cardWidth, {
    glyphs,
    color,
    right,
    headerTone: emphasized ? "selected" : "heading",
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
