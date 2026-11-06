# Documentation

Repository-wide architecture maps, operational guides, and design records:

- **[ARCHITECTURE.md](ARCHITECTURE.md)** — Complete command glossary (`ork horde`, `ork hall`, `ork foundry`, `ork smelter`, `ork radar`, `ork gate`), deep-module map across Node.js and Python, and IDE IntelliSense setup (`jsconfig.json` / `pyrightconfig.json`).
- **[terminal-ui.md](terminal-ui.md)** — Terminal UI design system: semantic ANSI palette (`tui-theme.mjs`), glyph tiers (`nerd`/`unicode`/`ascii`), connected rail vs. bubble layout rules, and inline preview containers.
- **[tui-visual-testing.md](tui-visual-testing.md)** — Deterministic tmux ANSI/SVG visual comparison runner (`scripts/test-tui-visual.js`) and baseline workflow.
- **[releases.md](releases.md)** — How conventional commits on `main` drive automatic per-plugin version bumps, changelogs, tags, and GitHub releases via `scripts/release.js`.
- **Peer mailbox design records:**
  - **[mailbox-daemon-plan.md](mailbox-daemon-plan.md)** — Service contract and architecture for the shared loopback HTTP MCP mailbox daemon (`mailbox_daemon.py`).
  - **[mailbox-daemon-qualification.md](mailbox-daemon-qualification.md)** — Concurrency, crash-recovery, schema, and multi-harness qualification evidence for the HTTP daemon.
  - **[mailbox-mcp-audit.md](mailbox-mcp-audit.md)** — MCP `2026-07-28` protocol, pagination, JSON Schema, and context-budget audit.
  - **[mailbox-feedback/README.md](mailbox-feedback/README.md)** — Local collector for cross-agent communication friction reports and [token-efficiency observations](mailbox-feedback/token-efficiency-observations.md).

For plugin usage and installation, see each plugin's own README:

- [`monitor`](../plugins/monitor/README.md)
- [`orchestrate`](../plugins/orchestrate/README.md)
