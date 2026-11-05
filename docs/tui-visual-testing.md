# Terminal visual comparisons

Compare the current checkout with a real historical revision:

```sh
node scripts/test-tui-visual.js --base-ref origin/main --output /tmp/orkest-visual
```

Open `/tmp/orkest-visual/report.html` for before/after panels. Agents can read
`comparison.json` for case status, exact source commits, Node/tmux versions and
source fingerprints. Each side also contains `.ansi`, `.json` and `.svg` files.
Intentional changes do not fail this comparison mode; capture errors and source
changes during the run do. A scenario unavailable in the base revision is marked
`unsupported`, with its reason. It never receives a fabricated baseline.

The nine default cases cover narrow and wide layouts, default and expanded quota,
keyboard shortcuts, read-only preview, dark/light backgrounds, monochrome and Nerd
icons. Use repeatable `--case NAME` to select cases; `--help` lists their names.
The fixture uses synthetic data, a fixed clock and explicit terminal dimensions.
It runs the actual renderer in a private tmux server and cleans up that server only.
It makes no model or network calls and does not use personal sessions or configuration.

## Reviewed baselines

Capture without updating, inspect the report, then explicitly save the approved state:

```sh
node scripts/test-tui-visual.js --baseline tests/visual-baselines --output /tmp/orkest-visual
node scripts/test-tui-visual.js --baseline tests/visual-baselines --output /tmp/orkest-visual --update
```

The first command fails for missing or changed baselines. `--update` is the only
command that writes baseline files. A failed or stale capture cannot update them.
No baseline is saved automatically by CI. Base-ref comparisons use `git archive`;
they leave the working checkout and index alone.

## What the images prove

The SVG files visualize actual ANSI terminal-cell captures. They are not native
window screenshots or pixel comparisons. The SVG viewer maps terminal colors to a
fixed palette and approximates font rendering with a fixed cell grid. Light and dark
cases change the viewer background; the renderer still uses its semantic ANSI colors.
Capture comparison uses ANSI content/styles and dimensions, not timestamps or SVG bytes.
The SVG supports colors, bold, dim and inverse styles; other styling remains in the
ANSI evidence rather than being reproduced by the SVG viewer.

Nerd icons require an installed compatible Nerd Font when viewing the report. The
SVG uses public font-family fallbacks and embeds no font assets. Without a matching
font, the ANSI evidence remains valid but some SVG icons may appear as missing glyphs.
Font rasterization, terminal-specific palettes, cursor interaction, hover, selection
and actual app-window layout still need separate interaction checks.

CI uploads the report on pull requests. Download the artifact and open `report.html`
locally. It requires Node 22.18 or newer, Git, tar and tmux, with no npm dependencies.
CI builds [tmux 3.8](https://github.com/tmux/tmux/releases/tag/3.8), the latest stable
release checked on 2026-11-05, from its checksum-verified source archive. tmux has
an [ISC license](https://github.com/tmux/tmux/blob/3.8/COPYING). The upstream
security-advisory list was empty on that date; the published
[CVE-2020-27347](https://nvd.nist.gov/vuln/detail/CVE-2020-27347) affects only
versions before 3.1c. This check does not audit the runner's system libraries.
