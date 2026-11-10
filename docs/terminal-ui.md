# Terminal UI Design System

Orkest's terminal UI (`ork horde` / `ork swarm` and statuslines) is built on four focused modules in [`plugins/orchestrate/lib/`](../plugins/orchestrate/lib/):

| Module                                                                | Responsibility                                                                                                                                                     |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`tui-theme.mjs`](../plugins/orchestrate/lib/tui-theme.mjs)           | Semantic ANSI SGR token dictionary (`DEFAULT_THEME`) and per-view override validation (`resolveTheme`).                                                            |
| [`tui-box.mjs`](../plugins/orchestrate/lib/tui-box.mjs)               | Control-character sanitization (`plain`), grapheme display width (`cellWidth`, `displayWidth`), width-safe ANSI fitting (`fitStyled`, `wrapText`), and box frames. |
| [`tui-components.mjs`](../plugins/orchestrate/lib/tui-components.mjs) | Reusable primitives: `sectionHeading`, `disclosure`, `actionBar`, `statusRow`, `treeCard`, `shimmerText`, and `providerMark`.                                      |
| [`tui-markdown.mjs`](../plugins/orchestrate/lib/tui-markdown.mjs)     | Theme-aware, width-safe Markdown (`renderMarkdown`), structured activity banners, and coalesced room log lines (`renderLogLine`).                                  |
| [`member-state.mjs`](../plugins/orchestrate/lib/member-state.mjs)     | Shared display-state derivation and outcome vocabulary for projection, view and notifications.                                                                     |
| [`horde-view.mjs`](../plugins/orchestrate/lib/horde-view.mjs)         | Stateful layout, keyboard/mouse hit targets, disclosure state, and inline preview/overlay containers for the Swarm pane.                                           |

---

## 1. Semantic ANSI Palette (`tui-theme.mjs`)

All styling goes through `tone(text, role, colorConfig)` using named SGR tokens from `DEFAULT_THEME`. Never hardcode raw `\x1b[...m` escape sequences in layout logic when a semantic token fits.

| Category                 | Tokens                                                                                                                                           | SGR / Visual Role                                                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Core & Structure**     | `border` (`36`), `heading` (`1`), `muted` (`2`), `selected` (`7;1`), `swarmHeading` (`48;5;237;97;1`)                                            | Cyan frames, bold headings, dimmed secondary labels, inverse keyboard selection, and dark slate card headers.                                      |
| **Lifecycle States**     | `running` (`36`), `success` (`32`), `warning` (`33`), `error` (`31`)                                                                             | Agent and service status colors. Always pair with a state glyph or text label so meaning never relies on color alone.                              |
| **Work Outcomes**        | `reported` (`221`), `supported` (`80`), `accepted` (`114`), `stale` (`176`), `failed` (`203`), all `38;5` bold                                   | Distinct outcome accents; derive labels and glyphs using the [Swarm outcome rules](../plugins/orchestrate/skills/orchestrate/references/swarm.md). |
| **Coordinator & Header** | `leadModel` (`38;5;117;1`), `leadEffort` (`38;5;180;1`), `leadBranch` (`38;5;176`), `leadEngine` (`38;5;80`), `leadSeparator` (`38;5;245`)       | Matches the tmux/Herdr statusline palette: sky-blue model, warm-gold effort, orchid branch, cyan harness, and muted gray separators.               |
| **Agent Identity**       | `identity31`–`identity36` (`203`, `114`, `221`, `111`, `176`, `80` bold)                                                                         | Deterministic 256-color accents for Martian short names (`ork: <name>`).                                                                           |
| **Provider Marks**       | `brandClaude` (`38;5;173`), `brandGoogle` (`38;5;33`), `brandOpenAI` (`37`)                                                                      | Provider glyph coloring (`✻` Claude, `✦` Gemini/Antigravity, `◎` OpenAI/Codex).                                                                    |
| **Quota Meters**         | `quotaOk` (`38;5;71`), `quotaMid` (`38;5;179`), `quotaLow` (`38;5;208`), `quotaTrack` (`2;38;5;240`), `quotaHover` (`97;1`)                      | Remaining quota health (`>50%` green, `>20%` amber, `<=20%` orange) over a dimmed track.                                                           |
| **Action Buttons**       | `button` (`48;5;237;97`), `buttonPrimary` (`48;5;237;97;1`), `buttonActive` (`46;30;1`), `buttonHover` (`7;1`), `buttonDisabled` (`48;5;235;90`) | Footer `actionBar` pills. Primary actions are bold; toggled filters use high-contrast cyan (`buttonActive`); hover uses inverse.                   |
| **Active Shimmer**       | `shimmerBase` (`38;5;245`), `shimmerEdge` (`38;5;108`), `shimmerMid` (`38;5;107`), `shimmerPeak` (`38;5;150;1`), `shimmerSpinner` (`38;5;149`)   | Animated highlight wave across active coordinator/worker task lines and Braille spinner prefix.                                                    |

Override roles per view without mutating global state:

```js
new HordeView(room, {
  color: true,
  theme: { border: "90", selected: "7;1", success: "32" },
});
```

---

## 2. Glyph Tiers (`ORK_GLYPHS`)

Every component accepts `tier` (`"nerd"`, `"unicode"`, or `"ascii"`), resolved by `glyphTier()` in [`tui-box.mjs`](../plugins/orchestrate/lib/tui-box.mjs):

| Element            | `nerd` (`ORK_GLYPHS=nerd`)              | `unicode` (UTF-8 default) | `ascii` (`TERM=dumb` / non-UTF-8) |
| ------------------ | --------------------------------------- | ------------------------- | --------------------------------- |
| **Box Corners**    | Rounded `╭ ╮ ╰ ╯`                       | Square `┌ ┐ └ ┘`          | `+ + + +`                         |
| **Tree Junctions** | `├ ┤ │ ─`                               | `├ ┤ │ ─`                 | `+ + \| -`                        |
| **Disclosure**     | `\u{F054}` (closed) / `\u{F078}` (open) | `▸` (closed) / `▾` (open) | `>` (closed) / `v` (open)         |
| **Status Icons**   | `󰔛` / `󰀪` / `󰄬` / `󰘓`                   | `⣾` / `⚠` / `✓` / `·`     | `>` / `!` / `+` / `-`             |
| **Control Icons**  | Nerd Font icon prefix (`CONTROL_ICONS`) | Text label only           | Text label only                   |

---

## 3. Component & Layout Rules

1. **Connected Tree Rails vs. Bottom Bubbles:**
   - **Connected rail panels** (`rail: "start" | "middle" | "end"`) link the Coordinator header, compact Quota drawer, and folder/agent tree along the left border using `├` junctions.
   - **Standalone bottom bubbles** (`Services`, `Update`) render as self-contained rounded panels (`this.panel(...)`) directly above the footer `actionBar`.
2. **Single-Place Controls (No Redundant Footer Buttons):**
   - If a section has an inline disclosure card or bubble on screen (`Quota` with `u`, `Services` with `v`, `Update` with `U`), clicking the card header toggles or triggers it directly. Do **not** duplicate those toggles as buttons in the bottom `actionBar`.
   - Hide conditional footer buttons when they have nothing to act on (for example, omit `Inactive` (`c`) when the room has zero inactive agents).
   - When collapsed summary lines appear in the tree (such as `N inactive hidden (press c to expand)`), register a mouse hit target on that line so clicking it expands in place.
3. **Consistent Disclosure Chevrons:**
   - Every collapsible header (`Quota`, `Services`, focused agent preview card) must show its disclosure state in both collapsed (`▸` / `\u{F054}`) and expanded (`▾` / `\u{F078}`) modes.
4. **Inline Containers Over Full-Screen Replacement or Pane Zooming:**
   - Opening an agent's log or chat (`Enter` or clicking an agent card) keeps the Swarm pane at its normal split size (`zoom = false`), collapses non-focused agents, and renders the preview in a framed container directly below the focused agent card.
   - Opening reference overlays (`?` Keyboard shortcuts or `g` Room log) also renders in the lower inline container below the Coordinator header and Quota drawer rather than wiping the top of the pane.
   - Dismissal uses a single primary **`Back`** (`Esc`) button in the footer toolbar (plus clicking the focused agent card or pressing `?`/`g` again to toggle), never both `Back` and `Return to chat` at once.
5. **Cross-Command Framing & Palette Parity:**
   - Every tabular or report CLI subcommand (`ork routes`, `ork telemetry`, `ork foundry status`, `ork smelter status`, `ork radar status|diff|priors`) renders through `renderPanel` and `renderTable` with `glyphTier()` so all Orkest terminal output shares the same rounded/square box borders and semantic tokens.
   - `agent_statusline.py`, `monitor/lib/render.mjs`, and `tui-theme.mjs` share identical 256-color codes for identity (`203`, `114`, `221`, `111`, `176`, `80`), model/effort/separators (`117`, `180`, `245`), and quota health (`71`, `179`, `208`, `240`), verified by unit tests.
6. **Internal Pane IDs Stay Hidden:**
   - Raw Herdr or tmux pane identifiers (`wQ:p1`, `%12`) belong on click/focus targets (`herdrPaneId`, `paneId`), never in visible header titles or card labels.
   - Focusing a Herdr pane by ID uses `herdr agent focus <herdrPaneId>` (not `herdr pane focus`, which is directional).
7. **Width & Injection Safety:**
   - Treat all model/tool/terminal output as untrusted data: sanitize with `plain()` before applying `tone()`, and clamp every rendered line with `fitStyled(line, width)` so escape codes never leak or wrap across borders.

---

## 4. Herdr Boundary & Visual Baselines

- **Herdr Boundary:** Herdr owns terminal hosting, split-pane placement, focus, and lifecycle. Keep card layout and ANSI styling inside Orkest; see the [Herdr plugin contract](https://herdr.dev/tui/docs/plugins/) and [theme configuration](https://herdr.dev/tui/docs/configuration/#theme).
- **Visual Regression Testing:** Run `node scripts/test-tui-visual.js` to capture deterministic ANSI/SVG before-and-after reports across narrow/wide, dark/light, monochrome, and Nerd Font tiers. Full workflow: [docs/tui-visual-testing.md](tui-visual-testing.md).
