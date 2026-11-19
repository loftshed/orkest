#!/usr/bin/env node
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { renderLine } from "../lib/monitor/render.mjs";
import {
  bindChief,
  chiefClose,
  chiefDesk,
  chiefInbox,
  chiefReconcile,
  chiefSend,
  chiefSpawn,
  chiefStatus,
  displayedDigestGroups,
  listDesk,
} from "../lib/chief.mjs";
import { mailboxRoot } from "../lib/horde-room.mjs";
import { truncateDisplay } from "../lib/tui-box.mjs";

export const CHIEF_HELP = `ork chief [status] [--json] [--room <id>] [--all] [--no-quota]   (machine-wide Chief overview)
ork chief bind [--session <id>] [--clear] [--force] [--json]   (claim or release the Chief desk)
ork chief send --to <target> [--from <session>] [--kind update|question|escalation|done] [--wake | --no-wake] <message>
ork chief spawn --cwd <repo> [--worktree [slug] | --branch <branch>] (--goal <text> | --goal-file <path>)
    [--title <t>] [--engine claude|agy|opencode|codex] [--model <m>] [--effort <e>] [--route <r>]
    [--timeout <t> | --interactive] [--dry-run] [--json]
ork chief inbox [--ack] [--json]   (open Chief items, grouped by room; --ack clears the groups shown)
ork chief close <room-or-branch-or-session> [--force] [--json]   (stop tracking a finished mission)
ork chief reconcile <roomId> [--event <absolute-path>] [--json]   (record a mission's exit once)
ork chief desk [--ack] [--json]   (reports queued while no Chief was live)
ork chief view [--print|--json] [--width N]   (Chief View; same as ork horde --view --chief)

Targets resolve in order: exact session ID, "chief" (the bound Chief), room ID, agent name,
branch or worktree slug, repository name. An ambiguous target lists its candidates.
spawn launches a detached room orchestrator in its own room (and worktree when asked) that
reports back to the Chief; it never passes --allow-credits or --ignore-quota. --interactive
opens the harness in a pane of the current Herdr, Orca or tmux session instead.
close stops tracking a mission and clears its attention; it never kills a process or deletes files.
`;

const SUBCOMMANDS = new Set([
  "bind",
  "close",
  "desk",
  "inbox",
  "reconcile",
  "send",
  "spawn",
  "status",
  "view",
]);

function ago(stamp, now = Date.now()) {
  const ms = now - Date.parse(stamp);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

function fit(text, width) {
  const value = String(text ?? "");
  return value.length > width ? `${value.slice(0, Math.max(0, width - 1))}…` : value;
}

function countsLabel(counts) {
  const parts = [];
  if (counts.working) parts.push(`${counts.working} working`);
  if (counts.blocked) parts.push(`${counts.blocked} blocked`);
  if (counts.done) parts.push(`${counts.done} done`);
  if (counts.idle) parts.push(`${counts.idle} idle`);
  return parts.length > 0 ? parts.join(" · ") : "no workers";
}

function place(entry) {
  const repo = entry.repo?.name || "?";
  const branch = entry.branch || entry.worktree?.slug;
  return branch ? `${repo}@${branch}` : repo;
}

/** Compact, at most ~40 lines: the Chief reads this every turn, so it must stay small. */
export function renderChiefStatus(status, { width = 100, maxRooms = 8, maxStandalone = 6 } = {}) {
  const lines = [];
  const now = Date.parse(status.generatedAt) || Date.now();
  const { chief, staleChief, summary } = status;
  if (chief) {
    const model = [chief.engine, chief.model].filter(Boolean).join(" ");
    lines.push(
      `ORK CHIEF  ★ ${chief.name}${model ? ` (${model})` : ""}  bound ${ago(chief.boundAt, now)}`,
    );
  } else if (staleChief) {
    lines.push(`ORK CHIEF  no live Chief (stale: ${staleChief.name} — ${staleChief.reason})`);
  } else {
    lines.push("ORK CHIEF  no Chief bound (ork chief bind)");
  }
  lines.push(
    `${summary.orchestrators} orchestrators · ${summary.working} working · ${summary.blocked} blocked · ` +
      `${summary.attention} attention · ${summary.standalone} standalone`,
  );
  if (status.roomsError) lines.push(fit(`rooms unavailable: ${status.roomsError}`, width));
  if (status.rooms.length > 0) lines.push("", "ROOMS");
  for (const room of status.rooms.slice(0, maxRooms)) {
    const mark = room.attention.length > 0 ? "!" : " ";
    const coordinator = room.coordinator;
    const who = [coordinator.engine, coordinator.model].filter(Boolean).join(":");
    const state = coordinator.live ? coordinator.status : `${coordinator.status} (not live)`;
    lines.push(
      fit(
        `${mark} ${room.id}  ${place(room)}  ${who}  ${state}  ${countsLabel(room.counts)}`,
        width,
      ),
    );
    if (room.task) lines.push(fit(`    ${room.task}`, width));
    for (const item of room.attention.slice(0, 2))
      lines.push(fit(`    ⚠ ${item.kind} ${item.from || ""}: ${item.text}`, width));
    if (room.attention.length > 2) lines.push(`    … ${room.attention.length - 2} more`);
  }
  if (status.rooms.length > maxRooms)
    lines.push(`  … ${status.rooms.length - maxRooms} more rooms (ork chief status --json)`);
  if (status.standalone.length > 0) lines.push("", "STANDALONE");
  for (const peer of status.standalone.slice(0, maxStandalone)) {
    lines.push(
      fit(
        `  ${peer.name}  ${place(peer)}  ${peer.status}${peer.task ? `  ${peer.task}` : ""}`,
        width,
      ),
    );
  }
  if (status.standalone.length > maxStandalone)
    lines.push(`  … ${status.standalone.length - maxStandalone} more sessions`);
  const loose = [...(status.inbox || []), ...(status.desk || [])];
  if (loose.length > 0) {
    lines.push("", "INBOX");
    for (const item of loose.slice(0, 3))
      lines.push(fit(`  ${item.kind} ${item.from || ""}: ${item.text}`, width));
    if (status.desk?.length > 0)
      lines.push(`  ${status.desk.length} queued on the desk (ork chief desk --ack)`);
  }
  if (status.accounts?.length > 0) {
    let quota;
    try {
      quota = renderLine(status.accounts, now);
    } catch {
      quota = `${status.accounts.length} accounts (ork quota)`;
    }
    lines.push("", fit(`QUOTA  ${quota}`, width));
  } else if (status.quotaError) {
    lines.push("", fit(`QUOTA  unavailable: ${status.quotaError}`, width));
  }
  return lines;
}

function renderRoom(room, width) {
  const lines = [
    `${room.id}  ${room.title}`,
    `  repo      ${room.repo?.path || room.cwd}`,
    `  branch    ${room.branch || "(detached)"}${room.worktree ? `  worktree ${room.worktree.slug}` : ""}`,
    `  lead      ${room.coordinator.name}  ${room.coordinator.engine || ""} ${room.coordinator.model || ""}  ${room.coordinator.live ? room.coordinator.status : "not live"}`,
    `  workers   ${countsLabel(room.counts)} (${room.counts.total} total)`,
  ];
  if (room.goal || room.objective)
    lines.push(fit(`  goal      ${room.goal || room.objective}`, width));
  if (room.stage) lines.push(`  stage     ${room.stage}`);
  if (room.parentChief)
    lines.push(`  chief     ${room.parentChief.name || room.parentChief.session || "chief"}`);
  for (const item of room.attention)
    lines.push(fit(`  ⚠ ${item.kind} ${item.from || ""}: ${item.text}`, width));
  if (room.latest) lines.push(fit(`  latest    ${room.latest.from}: ${room.latest.text}`, width));
  return lines;
}

function parse(argv, options) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: { help: { type: "boolean", short: "h" }, json: { type: "boolean" }, ...options },
  });
}

function write(stdout, payload, isJson, text) {
  stdout.write(isJson ? `${JSON.stringify(payload, null, 2)}\n` : `${text}\n`);
  return payload;
}

/** `--worktree` takes an optional slug, which parseArgs cannot express. */
function splitWorktree(argv) {
  const rest = [];
  let worktree;
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === "--worktree") {
      const next = argv[index + 1];
      if (next && !next.startsWith("-") && /^[a-z0-9-]+$/u.test(next)) {
        worktree = next;
        index++;
      } else {
        worktree = true;
      }
    } else if (token.startsWith("--worktree=")) {
      worktree = token.slice("--worktree=".length) || true;
    } else {
      rest.push(token);
    }
  }
  return { rest, worktree };
}

function renderDigest(payload, width) {
  if (payload.groups.length === 0) return ["No open Chief items."];
  const shown = displayedDigestGroups(payload.groups);
  const lines = [];
  for (const group of shown) {
    const head = group.roomId ?? "unattributed";
    const latest = group.latest ? ago(group.latest) || "just now" : "unknown";
    lines.push(truncateDisplay(`${head}  ${group.state}  latest ${latest}`, width));
    const [first, second] = group.asks;
    lines.push(
      truncateDisplay(
        first ? `  ${first.kind} ${first.from}: ${first.text}` : "  no open items",
        width,
      ),
    );
    if (second) {
      const more = group.asks.length - 2;
      lines.push(
        truncateDisplay(
          `  next: ${second.kind} ${second.from}: ${second.text}${more > 0 ? ` (+${more} more)` : ""}`,
          width,
        ),
      );
    } else lines.push("  one open item");
  }
  if (payload.groups.length > shown.length)
    lines.push(`… ${payload.groups.length - shown.length} more rooms (ork chief inbox --json)`);
  return lines;
}

function requireNoPositionals(positionals, verb) {
  if (positionals.length > 0) throw new Error(`${verb} takes no positional arguments`);
}

export async function chiefCommand(argv = [], context = {}) {
  const {
    stdout = process.stdout,
    env = process.env,
    main,
    root = mailboxRoot(env),
    ...overrides
  } = context;
  const args = [...argv];
  if (args.includes("--help") || args.includes("-h") || argv[0] === "help") {
    stdout.write(CHIEF_HELP);
    return;
  }
  let action = "status";
  if (args[0] !== undefined && !String(args[0]).startsWith("-")) {
    if (!SUBCOMMANDS.has(args[0]))
      throw new Error(`Unknown chief command "${args[0]}"; run ork chief --help`);
    action = args.shift();
  }
  if (action === "view") {
    if (typeof main !== "function") throw new Error("ork chief view must run through ork");
    return main(["horde", "--view", "--chief", ...args], { stdout });
  }
  if (action === "status") {
    const { positionals, values } = parse(args, {
      all: { type: "boolean" },
      "no-quota": { type: "boolean" },
      room: { type: "string" },
      width: { type: "string" },
    });
    requireNoPositionals(positionals, "status");
    const status = await chiefStatus({
      root,
      env,
      all: values.all || Boolean(values.room),
      quota: !values["no-quota"],
      ...overrides,
    });
    const width = Number(values.width || stdout.columns || 100);
    if (values.room) {
      const room = status.rooms.find((candidate) => candidate.id === values.room);
      if (!room) throw new Error(`No room ${values.room}; run ork chief status --all`);
      return write(stdout, room, values.json, renderRoom(room, width).join("\n"));
    }
    return write(stdout, status, values.json, renderChiefStatus(status, { width }).join("\n"));
  }
  if (action === "bind") {
    const { positionals, values } = parse(args, {
      clear: { type: "boolean" },
      force: { type: "boolean" },
      session: { type: "string" },
    });
    requireNoPositionals(positionals, "bind");
    const result = await bindChief({
      root,
      env,
      session: values.session,
      clear: values.clear,
      force: values.force,
      ...overrides,
    });
    let text;
    if (result.action === "cleared")
      text = `Released the Chief desk (was ${result.previous.name || result.previous.session}).`;
    else if (result.action === "none") text = "No Chief was bound.";
    else {
      text = `${result.binding.name} is the machine Chief (${result.action}).`;
      if (result.action === "taken")
        text += ` Took the desk from ${result.previous.name || result.previous.session}.`;
      if (result.desk > 0) text += ` ${result.desk} report(s) are queued: ork chief desk.`;
    }
    return write(stdout, result, values.json, text);
  }
  if (action === "send") {
    const { positionals, values } = parse(args, {
      from: { type: "string" },
      kind: { type: "string" },
      "no-wake": { type: "boolean" },
      to: { type: "string" },
      wake: { type: "boolean" },
    });
    if (values.wake && values["no-wake"]) throw new Error("Pass --wake or --no-wake, not both");
    const result = await chiefSend({
      root,
      env,
      to: values.to,
      message: positionals.join(" "),
      from: values.from,
      kind: values.kind,
      // Absent switches keep the library default: updates stay quiet, everything else wakes.
      noWake: values["no-wake"] ? true : !values.wake && undefined,
      ...overrides,
    });
    if (result.status === "already-reported") {
      return write(stdout, result, values.json, "This mission has already reported completion.");
    }
    const text =
      result.status === "queued"
        ? "No live Chief: the report is queued on the Chief desk."
        : `Sent to ${result.target.label} (${result.target.session}, by ${result.target.tier})${result.woke ? " and woke it" : ""}.`;
    return write(stdout, result, values.json, text);
  }
  if (action === "desk") {
    const { positionals, values } = parse(args, { ack: { type: "boolean" } });
    requireNoPositionals(positionals, "desk");
    const items = listDesk(root).map((item) =>
      Object.fromEntries(Object.entries(item).filter(([key]) => key !== "file")),
    );
    let acknowledged = 0;
    if (values.ack && items.length > 0) {
      // A desk-only snapshot: it cannot touch mailbox items and never impersonates a session.
      const result = await chiefDesk({
        root,
        env,
        ack: true,
        snapshot: {
          session: null,
          revision: null,
          deskIds: items.map((item) => item.id),
          inboxIds: [],
        },
        ...overrides,
      });
      acknowledged = result.acknowledged.desk;
    }
    const payload = { schema: "ork.chief.desk.v1", items, acknowledged };
    const text =
      items.length === 0
        ? "The Chief desk is empty."
        : items.map((item) => `${item.at}  ${item.kind}  ${item.from}: ${item.text}`).join("\n");
    return write(stdout, payload, values.json, text);
  }
  if (action === "inbox") {
    const { positionals, values } = parse(args, { ack: { type: "boolean" } });
    requireNoPositionals(positionals, "inbox");
    const payload = await chiefInbox({
      root,
      env,
      ack: values.ack,
      // Text mode acknowledges only the groups it displays; JSON carries and clears every group.
      ackScope: values.json ? "all" : "displayed",
      ...overrides,
    });
    const width = Number(stdout.columns || 100);
    return write(stdout, payload, values.json, renderDigest(payload, width).join("\n"));
  }
  if (action === "close") {
    const { positionals, values } = parse(args, { force: { type: "boolean" } });
    if (positionals.length !== 1)
      throw new Error("Pass one room, branch or session: ork chief close <target>");
    const result = await chiefClose({
      roomId: positionals[0],
      target: positionals[0],
      force: values.force,
      root,
      env,
      ...overrides,
    });
    const text =
      result.status === "closed"
        ? `Closed ${result.roomId}; its attention is cleared.`
        : `${result.roomId} was already closed.`;
    return write(stdout, result, values.json, text);
  }
  if (action === "reconcile") {
    const { positionals, values } = parse(args, {
      event: { type: "string" },
      hook: { type: "boolean" },
      "mailbox-root": { type: "string" },
    });
    if (positionals.length !== 1) throw new Error("Pass one room ID: ork chief reconcile <roomId>");
    if (values.event && !path.isAbsolute(values.event))
      throw new Error("--event needs an absolute path");
    if (values["mailbox-root"] && !path.isAbsolute(values["mailbox-root"]))
      throw new Error("--mailbox-root needs an absolute path");
    const result = await chiefReconcile({
      roomId: positionals[0],
      event: values.event ?? null,
      hook: Boolean(values.hook),
      root: values["mailbox-root"] ?? root,
      env,
      ...overrides,
    });
    // A completion hook that found no artifacts yet reports a retryable exit (EX_TEMPFAIL).
    if (result.status === "retry") process.exitCode = 75;
    const detail = result.reason ? `, ${result.reason}` : "";
    const text = `${result.roomId}: ${result.status}${result.state ? ` (${result.state}${detail})` : ""}`;
    return write(stdout, result, values.json, text);
  }
  const { rest, worktree } = splitWorktree(args);
  const { positionals, values } = parse(rest, {
    branch: { type: "string" },
    cwd: { type: "string" },
    "dry-run": { type: "boolean" },
    effort: { type: "string" },
    engine: { type: "string" },
    goal: { type: "string" },
    "goal-file": { type: "string" },
    interactive: { type: "boolean" },
    model: { type: "string" },
    route: { type: "string" },
    timeout: { type: "string" },
    title: { type: "string" },
  });
  if (positionals.length > 0) throw new Error("spawn takes its goal through --goal or --goal-file");
  const result = await chiefSpawn({
    cwd: values.cwd,
    worktree,
    branch: values.branch,
    goal: values.goal,
    goalFile: values["goal-file"],
    title: values.title,
    engine: values.engine,
    model: values.model,
    effort: values.effort,
    route: values.route,
    timeout: values.timeout,
    interactive: Boolean(values.interactive),
    dryRun: values["dry-run"],
    root,
    env,
    ...overrides,
  });
  const where = result.worktree
    ? `worktree ${result.worktree.path} (${result.worktree.branch})`
    : result.workspace;
  let text;
  if (result.dryRun)
    text = result.backend
      ? `Would open room ${result.roomId} in a ${result.backend} pane in ${where}:\n  ${result.command.join(" ")}`
      : `Would spawn room ${result.roomId} in ${where}:\n  ${result.command.join(" ")}`;
  else if (result.status === "launched" && result.launch?.backend)
    text = `Opened room ${result.roomId} in ${where} in a ${result.launch.backend} pane. It reports to the Chief.`;
  else if (result.status === "launched")
    text = `Spawned room ${result.roomId} in ${where} (pid ${result.launch.pid ?? "?"}). It reports to the Chief.`;
  else
    text = `Room ${result.roomId} was created but its orchestrator failed to launch: ${result.error}`;
  const warnings = result.warnings || [];
  for (const warning of warnings) text += `\n${warning}`;
  if (result.status === "failed") process.exitCode = 1;
  return write(stdout, result, values.json, text);
}

function isEntry() {
  if (!process.argv[1]) return false;
  try {
    return (
      realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (isEntry()) {
  try {
    const { main } = await import("./ork.mjs");
    await chiefCommand(process.argv.slice(2), { main });
  } catch (error) {
    process.stderr.write(`ork chief: ${error.message}\n`);
    process.exitCode = Number.isSafeInteger(error.exitCode) ? error.exitCode : 1;
  }
}
