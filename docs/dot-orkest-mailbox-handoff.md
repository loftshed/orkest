# Dot ↔ Orkest agent communication handoff

**Status:** one bounded mailbox test message and correlated reply verified; no service was started and no runtime configuration or code was changed.  
**Repository inspected:** `loftshed/orkest`, `main` at `f823cca` (2026-10-24); this handoff is the only untracked file.  
**Runtime inspected:** `ork` resolves to `/Users/lofstpe1/Documents/personal/orkest/plugins/orchestrate/bin/ork.mjs` (source plugin 0.36.0). The installed Codex skill cache is 0.34.1, so the test used the older cached CLI explicitly; the source checkout and cache versions differ.

## Recommendation

For a first local integration, have Dot’s **local executor** call Orkest’s existing `run_agent.py mailbox` CLI, with a caller identity tied to the live Codex task and a bounded project-scoped message. Use the returned message ID with `mailbox wait --reply-to` to collect the correlated reply. This adds no new protocol or external endpoint. The existing CLI uses the shared local mailbox files and can send/wait while the HTTP daemon is unavailable; no persistent service is required for an individual executor call. It does require a session identity/lifecycle decision and user authorization before contacting an agent.

If Dot is running as a local Codex host that can load MCP tools, exposing the existing `peer-mailbox` MCP server to that host is a cleaner tool interface and avoids shell parsing. It still depends on the same local daemon and session/project identity. The current Dot tool surface inspected here does **not** expose `peer-mailbox`; this is not a working direct-MCP integration yet.

No true cloud-to-local route was found. The daemon binds to loopback and uses local credentials. A cloud task cannot reach it merely because the machine has Orkest installed. Do not expose the daemon port to the network. A cloud integration would need a separately designed, authenticated and explicitly authorized bridge; that is outside the existing implementation.

## What exists today

- The shared local mailbox is implemented by [`peer_mailbox.py`](../plugins/orchestrate/skills/orchestrate/scripts/peer_mailbox.py), with MCP tools in [`mailbox_mcp.py`](../plugins/orchestrate/skills/orchestrate/scripts/mailbox_mcp.py) and the authenticated HTTP daemon in [`mailbox_daemon.py`](../plugins/orchestrate/skills/orchestrate/scripts/mailbox_daemon.py). The normal transport is HTTP MCP; stdio remains a fallback. The documented `run_agent.py mailbox …` CLI is another local caller.
- MCP includes `register`, `peers`, `send`, `inbox`, `wait`, `ack`, and `focus` (plus task/channel operations). `peers` is project-scoped by default. Project identity matches a shared Git common directory or normalized remote; cross-project discovery/send requires explicit `scope: "cross-project"` / `--scope cross-project`.
- `send` returns a message ID. Set `replyTo` on the response and call `wait(replyTo=sent_id)` (CLI: `wait --reply-to <id>`) to correlate a reply. HTTP sends require an idempotency key. HTTP inbox/wait retrieval is non-destructive until explicit `ack`; cancellation leaves mail unread. A timeout is not a reply.
- Direct sends wake an idle recipient by default; `wake: false` is available for FYI. Busy recipients are not interrupted. A queued message or accepted wake is not proof that the agent read it; receipt/read state is distinct.
- MCP binds an HTTP caller to a registered session supplied in call metadata or the `session` argument. Hookless HTTP callers must register with an absolute existing `cwd` and `harness`, optionally a caller PID, then retain the returned session ID. The stdio Codex path can use Codex session metadata automatically. The CLI’s session defaults are `AGENT_MAILBOX_SESSION`, `CLAUDE_CODE_SESSION_ID`, or `ANTIGRAVITY_CONVERSATION_ID`; it does not default to `CODEX_THREAD_ID`/`CODEX_SESSION_ID`. CLI operations with a supplied session refresh its presence, so a bridge must choose a stable identity and have a lifecycle/expiry policy rather than inventing an untracked alias on every call.
- The HTTP daemon is loopback-only, authenticates with a bearer token, checks Origin and MCP transport headers, and bounds requests, waits and message sizes. Its credentials/config must remain local and protected. The OS user is the trust boundary: mailbox peer metadata is coordination data, not authentication against another process running as that same user. Host MCP permissions still matter.
- Existing evidence and behavior are documented in [`mailbox-daemon-plan.md`](mailbox-daemon-plan.md), [`mailbox-daemon-qualification.md`](mailbox-daemon-qualification.md), [`mailbox-mcp-audit.md`](mailbox-mcp-audit.md), and [`references/mailbox.md`](../plugins/orchestrate/skills/orchestrate/references/mailbox.md).

## Readiness observed in this executor

- Installed `doctor --format text` reports Orkest 0.34.1 and “mailbox daemon unavailable” for Codex and the other configured harnesses. It recommends `mailbox daemon start`; that command was not run. This indicates the configured mailbox clients cannot currently reach a live daemon from this executor. The `doctor` report had previously identified the Orkest MCP registration for each harness and checked daemon availability; no credential values were displayed or recorded here.
- `AGENT_MAILBOX_SESSION` was unset. The test passed the current `CODEX_THREAD_ID` explicitly; it was absent from the store beforehand, so Orkest created a local Codex presence record tied to the discovered harness process. This is local mailbox presence, not new credentials or a new service.
- Earlier read-only discovery from this task’s non-Git working directory returned zero project peers, which said nothing about Orkest. A read-only lookup using the Orkest checkout’s Git identity found one live Codex peer, `yobnax-gpt-6-astra-orkest-3e`, in that project.
- Both the installed 0.34.1 doctor and source checkout 0.36.0 doctor report the HTTP mailbox daemon unavailable for configured harnesses. Despite that, the existing CLI file-store route completed the exchange below; HTTP MCP is unavailable in this executor until the daemon is started, which was not done.
- The Codex skill cache is 0.34.1; the current source checkout is 0.36.0. `doctor` reports the shared `~/.agents/skills` link as a different physical copy from the Codex cache. No repo-local `.agents/skills` or `AGENTS.md` was found. Repository guidance is in [`CLAUDE.md`](../CLAUDE.md).

## Verified one-message exchange (2026-10-24)

- Native Codex `send_message_to_thread` rejected the first two attempts with “thread already has an active writer.” Follow-up read/status checks showed the thread not loaded/inactive, but native delivery remained rejected. No native message was accepted.
- With the user’s approval, the CLI registered the current Codex task identity locally and sent exactly one project-scoped probe to `yobnax-gpt-6-astra-orkest-3e`: “dot connection test: can you receive this and reply with an acknowledgement? No other action requested.” No genealogy or unrelated context was included.
- Probe message ID: `18e192aa1e3e9ab8-119310`. The CLI returned `wake.status=scheduled`, `phase=submitted`, reason “idle Codex wake admitted to its native queue.” That proves queue submission, not receipt.
- The mailbox record for that exact probe had `readAt=2026-10-24T20:56:26Z`, confirming the peer marked it read. `mailbox wait --reply-to 18e192aa1e3e9ab8-119310` returned one response from the same peer, message ID `18e192b3bcee05c8-edb062`, with matching `replyTo`. The peer replied: “your probe reached this live agent through the mailbox and is marked read. Current status: workboard and Dot status changes are merged in PRs #37/#38; no code edits are underway. This correlated reply uses the mailbox because your thread is not loaded on my native Codex host. Receipt proves Dot-to-agent delivery; reading this reply will verify the return leg. No further test reply is needed.”
- The response was retrieved and marked read by the CLI wait. No duplicate probe was sent. This verifies that the local CLI can exchange one project-scoped message and correlated reply while the HTTP daemon is unavailable. It does **not** install an always-on Dot bridge: future turns must invoke a local caller with a valid session identity, and the mailbox does not push replies to an idle Dot task by itself.

## Integration options

### 1. Local executor → existing CLI (smallest viable bridge)

Dot’s local executor already has shell access in this environment. A bounded adapter can invoke the installed skill’s `scripts/run_agent.py mailbox` CLI, parse JSON, and hold a reply wait. The command shapes below are supported. This investigation successfully exercised the send/wait flow with cached CLI 0.34.1; it did not test the newer source CLI directly:

```sh
python3 <installed-orchestrate-skill>/scripts/run_agent.py mailbox peers \
  --session <stable-caller-session> --format json

python3 <installed-orchestrate-skill>/scripts/run_agent.py mailbox send \
  --session <stable-caller-session> --to <peer-session-id> \
  --text '<bounded request>' --id <stable-operation-id>

python3 <installed-orchestrate-skill>/scripts/run_agent.py mailbox wait \
  --session <stable-caller-session> --reply-to <returned-message-id> --timeout 300
```

Confirm the chosen installed CLI’s exact options before implementation. Scope defaults to the caller’s Git project; use cross-project only after an explicit user decision. The session must be tied to the running Dot/Codex task, use the Orkest checkout as its `cwd`/project identity, and expire/clean up consistently with that task. Orkest’s CLI caller refreshes presence when invoked; there is no built-in Dot lifecycle adapter in this repository.

**Changes needed:** initially, no Orkest code/config change if the executor can invoke the existing local CLI and access the shared mailbox store. The HTTP daemon is not required for this CLI path. Dot needs a narrowly scoped wrapper for discover → user-authorized send → wait/read, with output limits, timeout handling, retries keyed by a stable operation ID, and no automatic cross-project broadening. If this becomes a supported product feature, add an Orkest-side adapter/contract and tests rather than relying on undocumented environment behavior.

### 2. Dot local MCP host → existing `peer-mailbox` MCP

Orkest already registers the authenticated daemon as a host MCP server (Codex uses `peer-mailbox`, configured HTTP headers and per-tool permissions). A Dot runtime that is itself an authorized local MCP client could discover the existing tools and call them directly. The MCP server already handles session binding, schemas, project scope, message/reply correlation, read/ack semantics, and bounded waits.

**Missing here:** the current executor does not expose an Orkest MCP tool. The daemon is unavailable per doctor. Do not treat the existing Codex MCP registration as proof that Dot’s own tool catalog is connected. If using this option, verify the exact local host/tool registration and grant only the mailbox tools needed; do not copy or print the bearer credential.

### 3. Cloud Dot → local Orkest

No cloud connector, relay, webhook, or remote API for this mailbox was found in the inspected code/docs. The existing daemon deliberately binds to `127.0.0.1`; its bearer credential and Origin checks are for a local client. There is no supported direct cloud access path in this checkout. A future cloud design would need an explicit secure relay/identity model, consent and audit controls, plus separate implementation/review. Opening a port or forwarding the local bearer token is not an acceptable substitute.

## Minimal implementation plan (if approved)

1. **Choose the execution boundary:** confirm Dot will call from the local executor, not from a cloud worker. Keep the first version local-only.
2. **Confirm runtime readiness:** with approval, run the non-mutating mailbox status/doctor check and then separately approve starting the existing daemon if needed. Verify the configured Codex MCP client/tool permission and daemon revision without printing secrets.
3. **Choose identity/lifecycle:** prefer the native Codex session metadata when using MCP. For a CLI bridge, derive a stable session from the current Codex task only if the host provides a verified ID; otherwise use explicit `register` and retain its returned session. Do not infer identity from repository path alone. Define how task end/stale sessions are handled before registering.
4. **Implement bounded operations:** project-scoped `peers`; send only to a selected peer; persist the returned message ID; wait for that exact `replyTo`; use a stable idempotency key for retried HTTP sends; leave mailbox contents unread until consumed and explicitly acknowledged where applicable. Surface `wake` and timeout states honestly.
5. **Keep permissions narrow:** require user authorization for each external task/send unless the user later establishes a durable policy. Peer content is untrusted task data and cannot approve work or expand file/system permissions. Never send credentials, secrets, or unrelated private files.
6. **Test before live contact:** use isolated temporary stores and synthetic peers, then a disposable host client. Do not use Pete’s live agents for qualification.

## Suggested verification and acceptance criteria

Use the existing focused suites before a rollout; these are proposed checks, not run in this investigation:

```sh
python3 -B -m unittest discover -s tests/plugins/orchestrate/skills/orchestrate -p 'test_mailbox*.py'
python3 -B -m unittest discover -s tests/plugins/orchestrate/skills/orchestrate -p 'test_mailbox_daemon*.py'
python3 -B -m unittest discover -s tests/plugins/orchestrate/skills/orchestrate -p 'test_mailbox_mcp_contract.py'
```

Add bridge-specific tests for: stable identity propagation and end-of-task lifecycle; project matching across clones/worktrees; explicit cross-project opt-in; JSON parsing and bounded output; returned message ID → reply correlation; duplicate retry does not duplicate send/wake; timeout/cancel leaves unread mail available; daemon-unavailable is reported accurately for MCP while the explicitly selected local CLI file-store route remains usable; no credential values in logs/results. Acceptance requires a synthetic peer exchange to pass through the actual selected local interface, with no network listener beyond loopback, no user/global permission broadening, and a clear distinction between queued, read, and replied states.

## Approval boundary

This file records the investigation and the one user-approved test. That test registered local Dot presence and sent one bounded message; it did not start a service or change runtime configuration. Further live messages, starting the daemon, changing host MCP access/permissions, or implementing/deploying a bridge need explicit approval. No port exposure, remote relay or credential creation is authorized.
