# Generated README content

`corepack pnpm readme` rewrites the generated parts of the root [README](../README.md).
`node scripts/readme.js --check` runs in the lint gate and fails while any of them is stale.

| Part                                | Source                                                       |
| ----------------------------------- | ------------------------------------------------------------ |
| `<!-- generated:commands -->`       | The usage lines of `ork --help`                              |
| `<!-- generated:slash-commands -->` | Frontmatter of `plugins/orchestrate/commands/*.md`           |
| `<!-- generated:requirements -->`   | `engines.node` in `package.json`                             |
| `docs/images/*.png`                 | The Swarm View and `monitor` renderers, drawn from demo data |
| Plugin versions in the table        | The release job, see [releases](releases.md)                 |

Edit a generated block at its source, never between its markers. To add one, return it from
`generatedBlocks` in [`scripts/lib/readme.js`](../scripts/lib/readme.js) and place its markers in
the README.

## Screenshots

Each screenshot is the real renderer's output for the invented room and accounts in
[`scripts/lib/readme-demo.js`](../scripts/lib/readme-demo.js), at a fixed clock. It is saved twice:
`NAME.ansi`, the terminal text, and `NAME.png`, that text drawn as a terminal window. The check
compares the `.ansi` file with a fresh render, so it needs no fonts and runs in CI. Only changed
screenshots are redrawn; `--force` redraws all of them.

Drawing needs ImageMagick (`magick`), fontconfig, and the Fira Code and Symbols Nerd Font Mono
fonts. To add a screenshot, add a capture to `captures` in `scripts/lib/readme.js`.

## Troubleshooting

- **The gate reports a stale screenshot after a terminal UI change:** that is the check working.
  Run `corepack pnpm readme`, look at the new image, and commit both files.
- **`drawing screenshots needs …`:** install the named tool or font. The text blocks have already
  been written by then; only the images are pending.
