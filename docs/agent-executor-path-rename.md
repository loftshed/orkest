# Retire the remaining `agent-executor` names in orchestrate

Hooks, compat symlinks, global instructions and agent memories on the main machine were moved to `orchestrate` on 2026-11-02, and `~/.agents/skills/agent-executor` is gone. What still carries the old name is orchestrate's own runtime naming. This is the inventory for doing that rename.

## Shared runtime-paths helpers

Path and environment-variable resolution with legacy `agent-executor` fallback lives in two small shared helpers:

- Python: [`plugins/orchestrate/skills/orchestrate/scripts/runtime_paths.py`](../plugins/orchestrate/skills/orchestrate/scripts/runtime_paths.py)
- ESM: [`plugins/orchestrate/lib/runtime-paths.mjs`](../plugins/orchestrate/lib/runtime-paths.mjs)

Both helpers provide:

- **`cache_home()` / `cacheHome()`**: checks `ORCHESTRATE_HOME` first, then `AGENT_EXECUTOR_HOME`. Otherwise checks `<cache>/orchestrate` first (where `<cache>` is `$XDG_CACHE_HOME` or `~/.cache`), falling back to `<cache>/agent-executor` only when the legacy directory already exists and `<cache>/orchestrate` does not, and defaulting to `<cache>/orchestrate` when neither exists.
- **`config_path()` / `configPath()`**: checks `ORCHESTRATE_CONFIG` first, then `AGENT_EXECUTOR_CONFIG`. Otherwise checks `<config>/orchestrate/config.json` first (where `<config>` is `$XDG_CONFIG_HOME` or `~/.config`), falling back to `<config>/agent-executor/config.json` when the legacy file exists and the new one does not, and defaulting to `<config>/orchestrate/config.json` when neither exists.
- **`env_first("ORCHESTRATE_...", "AGENT_EXECUTOR_...")` / `envFirst(...)`**: reads `ORCHESTRATE_<SUFFIX>` with fallback to `AGENT_EXECUTOR_<SUFFIX>`.

Currently wired into `routes.py` (`config_path()`), `peer_mailbox.py` (`root()`), and `lib/stooges-room.mjs` (`mailboxRoot()`).

## What still uses the old name

- **Cache root `~/.cache/agent-executor`** (about 818 MB: jobs, runs, consults, mailbox, worktree locks, model caches). `peer_mailbox.py:root()` and `lib/stooges-room.mjs:mailboxRoot()` now resolve through `runtime_paths`; remaining scripts to wire in:
  - `run_agent.py` (three places, near lines 582, 766 and 3861)
  - `telemetry.py:25`, `events_bus.py:68`, `authority.py:67`, `mailbox_feedback.py:37`
  - `check_mailbox.py:136` and `:248`
- **Config `~/.config/agent-executor/config.json`**: `routes.py` now resolves through `runtime_paths.config_path()`; `mailbox_feedback.py:55` and `references/routes.default.json:3` remain.
- **Environment variables**: `ORCHESTRATE_HOME` / `AGENT_EXECUTOR_HOME`, `ORCHESTRATE_CONFIG` / `AGENT_EXECUTOR_CONFIG`, `ORCHESTRATE_FEEDBACK_DIR` / `AGENT_EXECUTOR_FEEDBACK_DIR` and `ORCHESTRATE_CONDUCTOR_MODEL` / `AGENT_EXECUTOR_CONDUCTOR_MODEL` (`run_agent.py:2595`, `mailbox_daemon.py:745-746`, plus the docs below).
- **Schema IDs `agent-executor.*.v1`** (config, room, task, job, message-signal, send-operation, mailbox-feedback). These are written into persisted state, so a rename has to read both the old and new IDs, or migrate the files.
- **Install and docs**: `install.sh`, `uninstall.sh`, `SKILL.md` (around lines 222 and 265), `references/runner.md`, `references/mailbox.md`, `references/completion.md`, the plugin README and the tests under `tests/plugins/orchestrate/`.
- **`release.json`** maps `orchestrate` to `agent-executor` for tag history. That mapping probably stays.

## Cutover hazards

- **The mailbox daemon runs from the old cache.** LaunchAgent `dev.loftshed.agent-mailbox.plist` starts `~/.cache/agent-executor/mailbox-daemon-v1/runtimes/<hash>/scripts/mailbox_daemon.py serve --root ~/.cache/agent-executor/mailbox-v1`. Every harness's sessions share that root.
- **There are several installed copies.** These are the Claude Code plugin caches for both accounts (versions 0.23.1 to 0.43.0), the Codex plugin cache (0.43.0), and `~/.agents/skills/orchestrate`, which links to this working copy.
  - If any copy still resolves the old root after the state moves, the mailbox splits in two and sessions stop seeing each other.

## Suggested order

1. Add one paths helper with the new names (`runtime_paths.py` and `runtime-paths.mjs`), falling back to `~/.cache/agent-executor` and `~/.config/agent-executor/config.json` when the legacy state exists and the new path does not. Read old schema IDs alongside new ones.
2. Release, then update every installed copy.
3. Stop the mailbox daemon, migrate, and let the installer rewrite the LaunchAgent with the new paths. Then restart the daemon and the running sessions.
4. Grep the home directory for `agent-executor` afterwards. Machine-local instructions and agent memories still name the old config and cache paths on purpose, and a Codex memory note maps the old name to the new one; update or drop those once the rename has landed.
