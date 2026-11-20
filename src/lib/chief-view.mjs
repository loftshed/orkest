/**
 * @module chief-view
 *
 * Ork Chief side window (`ork chief view`, `ork horde --view --chief`): a machine-wide
 * overview of every live orchestrator room and standalone agent session. It renders the
 * `ork.chief.status.v1` snapshot from `lib/chief.mjs` and returns small action objects
 * (`chief-drill`, `chief-focus`, `chief-focus-chief`, `chief-mode`, `chief-reply`,
 * `chief-ack-desk`, `chief-close-room`) that the terminal runner in `bin/horde-tui.mjs`
 * turns into room drill-downs, pane focus requests and Chief mutations.
 */
import path from "node:path";
import { stripVTControlCharacters } from "node:util";

import {
  cellWidth,
  displayWidth,
  fit,
  fitStyled,
  frame,
  glyphSet,
  glyphTier,
  plain,
  SPINNER,
  tone,
  truncateDisplay,
  wrapText,
} from "./tui-box.mjs";
import {
  actionBar,
  colorProviderMarks,
  hitTest,
  meterStrip,
  providerMark,
  quotaAccountLabel,
} from "./tui-components.mjs";
import { resolveTheme } from "./tui-theme.mjs";

export const CHIEF_KEYS = Object.freeze({
  back: new Set(["\u{7F}", "\b", "\u{1B}"]),
  chief: "C",
  drill: "\r",
  focus: new Set(["f", "o"]),
  mode: "\t",
  mouse: "m",
});

const CLOSE_CONFIRM_MS = 3000;
const DRAWER_MAX = 5;
const UP = new Set(["\u{1B}[A", "k"]);
const DOWN = new Set(["\u{1B}[B", "j"]);
const ACTIVE = new Set([
  "running",
  "working",
  "planning",
  "testing",
  "review",
  "busy",
  "implementing",
]);
const WARN = new Set(["blocked", "awaiting-input", "paused", "stale", "stale-coordinator"]);
const FAILED = new Set(["failed", "error", "rejected"]);
const ATTENTION_TONES = new Set(["warning", "stale", "error"]);
const CONTROL_TEXT = /[\p{Cc}\p{Zl}\p{Zp}]|(?![\u{200C}\u{200D}])\p{Cf}/gu;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function text(value) {
  return plain(value ?? "")
    .replaceAll(/\s+/gu, " ")
    .trim();
}

function count(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
}

function list(value) {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === "object") : [];
}

/** Repository label for grouping: repo name, else the checkout folder name. */
export function chiefRepoName(item = {}) {
  const repo = item.repo && typeof item.repo === "object" ? item.repo : {};
  const named = text(repo.name);
  if (named) return named;
  const source = text(repo.path) || text(item.cwd);
  return source ? path.basename(source) : "unknown repo";
}

function roomName(room) {
  return (
    text(room.title) ||
    text(room.coordinator?.name) ||
    text(room.goal) ||
    text(room.objective) ||
    text(room.id) ||
    "room"
  );
}

function sessionName(session) {
  return text(session.name) || text(session.session).slice(0, 12) || "session";
}

function modelLabel(member = {}) {
  const model = text(member.model);
  const effort = text(member.effort);
  if (model && effort) return `${model} / ${effort}`;
  return model || text(member.engine);
}

function locationBadge(item) {
  const slug = text(item.worktree?.slug);
  if (slug) return `wt:${slug}`;
  const branch = text(item.branch);
  return branch ? `(${branch})` : "";
}

function normalizePorts(item) {
  const ports = item?.worktree?.ports;
  if (!Array.isArray(ports)) return [];
  return ports
    .filter(
      (entry) =>
        entry && typeof entry === "object" && Number.isSafeInteger(entry.port) && entry.port > 0,
    )
    .filter((entry) => entry.port < 65_536)
    .map((entry) => ({ name: text(entry.name), port: entry.port }));
}

const PR_GLYPHS = {
  OPEN: { unicode: "●", ascii: "o", tone: "running" },
  MERGED: { unicode: "✓", ascii: "+", tone: "success" },
  CLOSED: { unicode: "✗", ascii: "x", tone: "warning" },
  UNKNOWN: { unicode: "?", ascii: "?", tone: "muted" },
};

function normalizePr(item) {
  const pr = item?.worktree?.pr;
  if (!pr || typeof pr !== "object") return null;
  const number = Number(pr.number);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  const state = text(pr.state).toUpperCase();
  return { number, state: Object.keys(PR_GLYPHS).includes(state) ? state : "UNKNOWN" };
}

/** `:31042 (+2)`: the first allocated port and how many more the worktree holds; "" when none. */
export function chiefPortBadge(item = {}) {
  const ports = normalizePorts(item);
  if (ports.length === 0) return "";
  return `:${ports[0].port}${ports.length > 1 ? ` (+${ports.length - 1})` : ""}`;
}

/** `● #231 open`: a state glyph, the number and the state word, so colour is never the only signal. */
export function chiefPrBadge(item = {}, tier = "unicode") {
  const pr = normalizePr(item);
  if (!pr) return null;
  const mark = PR_GLYPHS[pr.state];
  const glyph = tier === "ascii" ? mark.ascii : mark.unicode;
  return { text: `${glyph} #${pr.number} ${pr.state.toLowerCase()}`, tone: mark.tone };
}

/** Splits a string after `cells` display cells without cutting a grapheme. */
function splitAtCells(value, cells) {
  let used = 0;
  let head = "";
  const parts = [...graphemes.segment(value)];
  for (const [index, { segment }] of parts.entries()) {
    const size = cellWidth(segment);
    if (used + size > cells)
      return [
        head,
        parts
          .slice(index)
          .map((part) => part.segment)
          .join(""),
      ];
    head += segment;
    used += size;
  }
  return [head, ""];
}

function attentionItems(room) {
  return list(room.attention);
}

/** Status pill derived from counts, attention and coordinator status. */
export function chiefRoomPill(room = {}) {
  const counts = room.counts || {};
  if (count(counts.blocked) > 0) return { label: "blocked", tone: "warning" };
  const status = text(room.coordinator?.status).toLowerCase();
  const attention = attentionItems(room);
  if (attention.some((item) => item.kind === "escalation"))
    return { label: "escalated", tone: "warning" };
  if (attention.some((item) => item.kind === "awaiting-input"))
    return { label: "needs you", tone: "warning" };
  if (attention.some((item) => item.kind === "stale-coordinator") || status === "stale")
    return { label: "stale", tone: "stale" };
  if (FAILED.has(status)) return { label: status, tone: "error" };
  if (count(counts.working) > 0 || ACTIVE.has(status)) return { label: "working", tone: "running" };
  if (count(counts.total) > 0 && count(counts.done) >= count(counts.total))
    return { label: "done", tone: "success" };
  return { label: status || "idle", tone: "muted" };
}

function sessionPill(session = {}) {
  const status = text(session.stage || session.status).toLowerCase();
  if (WARN.has(status)) return { label: status, tone: "warning" };
  if (FAILED.has(status)) return { label: status, tone: "error" };
  if (ACTIVE.has(status)) return { label: "working", tone: "running" };
  return { label: status || "idle", tone: "muted" };
}

/** `3 working · 1 blocked · 2 done` (full) or `3▶ 1⚠ 2✓` (compact). */
export function chiefWorkerSummary(counts = {}, { compact = false, tier = "unicode" } = {}) {
  const working = count(counts.working);
  const blocked = count(counts.blocked);
  const done = count(counts.done);
  const total = count(counts.total);
  if (compact) {
    const glyphs = tier === "ascii" ? [">", "!", "+"] : ["▶", "⚠", "✓"];
    const parts = [];
    if (working) parts.push(`${working}${glyphs[0]}`);
    if (blocked) parts.push(`${blocked}${glyphs[1]}`);
    if (done) parts.push(`${done}${glyphs[2]}`);
    if (parts.length === 0) parts.push(total ? `${total} idle` : "no workers");
    return parts.join(" ");
  }
  const parts = [];
  if (working) parts.push(`${working} working`);
  if (blocked) parts.push(`${blocked} blocked`);
  if (done) parts.push(`${done} done`);
  if (parts.length === 0) return total ? `${total} idle` : "no workers";
  return parts.join(" · ");
}

function statusGlyph(pill, tier, now) {
  if (pill.tone === "running")
    return tier === "ascii" ? ">" : SPINNER[Math.floor(now / 120) % SPINNER.length];
  if (pill.tone === "warning") return tier === "ascii" ? "!" : "⚠";
  if (pill.tone === "error") return tier === "ascii" ? "x" : "✗";
  if (pill.tone === "success") return tier === "ascii" ? "+" : "✓";
  if (pill.tone === "stale") return tier === "ascii" ? "?" : "◌";
  return tier === "ascii" ? "-" : "·";
}

function relativeAge(value, now) {
  const stamp = typeof value === "number" ? value : Date.parse(String(value ?? ""));
  if (!Number.isFinite(stamp) || stamp <= 0) return "";
  const seconds = Math.max(0, Math.round((now - stamp) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

/** Normalize a room coordinator, standalone session or chief binding for `focusAgentPane`. */
export function chiefPaneTarget(member) {
  if (!member || typeof member !== "object") return null;
  const session = typeof member.session === "string" ? member.session : member.session?.id;
  const orcaTerminalHandle =
    typeof member.orcaTerminalHandle === "string" ? member.orcaTerminalHandle : undefined;
  const orcaPaneKey = typeof member.orcaPaneKey === "string" ? member.orcaPaneKey : undefined;
  const orcaWorkspaceId =
    typeof member.orcaWorkspaceId === "string" ? member.orcaWorkspaceId : undefined;
  const orcaTabId = typeof member.orcaTabId === "string" ? member.orcaTabId : undefined;
  const orcaEnvironment =
    typeof member.orcaEnvironment === "string" ? member.orcaEnvironment : undefined;
  const target = {
    id: text(session) || text(member.id) || "chief-target",
    name: text(member.name),
    engine: text(member.engine),
    herdrPaneId: typeof member.herdrPaneId === "string" ? member.herdrPaneId : undefined,
    herdrEndpoint: typeof member.herdrEndpoint === "string" ? member.herdrEndpoint : undefined,
    orcaEnvironment,
    orcaPaneKey,
    orcaTabId,
    orcaTerminalHandle,
    orcaWorkspaceId,
    paneId: typeof member.paneId === "string" ? member.paneId : undefined,
    terminalServer: typeof member.terminalServer === "string" ? member.terminalServer : undefined,
    ...(session && { session: { id: session } }),
  };
  return target.herdrPaneId || target.orcaTerminalHandle || target.orcaPaneKey || target.paneId
    ? target
    : null;
}

/** Selectable rows: rooms grouped by repository (attention first), then standalone sessions. */
export function chiefEntries(status) {
  const rooms = list(status?.rooms);
  const groups = new Map();
  for (const room of rooms) {
    const repo = chiefRepoName(room);
    if (!groups.has(repo)) groups.set(repo, []);
    groups.get(repo).push(room);
  }
  const urgency = (room) =>
    count(room.counts?.blocked) * 10 +
    attentionItems(room).length * 5 +
    count(room.counts?.working);
  const stamp = (item) => {
    const value = Date.parse(String(item.updatedAt ?? "")) || Number(item.updatedAt) || 0;
    return Number.isFinite(value) ? value : 0;
  };
  const ordered = groups
    .entries()
    .map(([repo, members]) => ({
      repo,
      members: members.toSorted(
        (left, right) =>
          urgency(right) - urgency(left) ||
          stamp(right) - stamp(left) ||
          roomName(left).localeCompare(roomName(right)),
      ),
    }))
    .toArray()
    .toSorted(
      (left, right) =>
        Math.max(...right.members.map(urgency)) - Math.max(...left.members.map(urgency)) ||
        left.repo.localeCompare(right.repo),
    );
  const entries = [];
  for (const group of ordered) {
    for (const room of group.members) {
      entries.push({
        kind: "room",
        key: `room:${room.id}`,
        repo: group.repo,
        data: room,
        ports: normalizePorts(room),
        pr: normalizePr(room),
      });
    }
  }
  const sessions = list(status?.standalone).toSorted(
    (left, right) =>
      stamp(right) - stamp(left) || sessionName(left).localeCompare(sessionName(right)),
  );
  for (const session of sessions) {
    entries.push({
      kind: "session",
      key: `session:${session.session || session.name}`,
      repo: chiefRepoName(session),
      data: session,
      ports: normalizePorts(session),
      pr: normalizePr(session),
    });
  }
  return entries;
}

/** Machine-wide summary, preferring the snapshot's own counters. */
export function chiefSummary(status) {
  const rooms = list(status?.rooms);
  const standalone = list(status?.standalone);
  const summary = status?.summary && typeof status.summary === "object" ? status.summary : {};
  const sum = (field) => rooms.reduce((total, room) => total + count(room.counts?.[field]), 0);
  const attention = rooms.reduce((total, room) => total + attentionItems(room).length, 0);
  return {
    orchestrators: count(summary.orchestrators) || rooms.length,
    working: count(summary.working) || sum("working"),
    blocked: count(summary.blocked) || sum("blocked"),
    attention: count(summary.attention) || attention,
    standalone: count(summary.standalone) || standalone.length,
  };
}

/** Whether an entry belongs under the attention filter (`a`) and the `n` jump. */
function chiefAttention(entry) {
  const data = entry.data;
  if (entry.kind === "room") {
    return (
      attentionItems(data).length > 0 ||
      count(data.counts?.blocked) > 0 ||
      ATTENTION_TONES.has(chiefRoomPill(data).tone)
    );
  }
  return list(data.attention).length > 0 || ATTENTION_TONES.has(sessionPill(data).tone);
}

/** Rooms with work still running cannot be closed from the overview. */
function chiefRoomLive(room) {
  const status = text(room.coordinator?.status).toLowerCase();
  return count(room.counts?.working) > 0 || ACTIVE.has(status);
}

/** Lowercase text a search matches against: repo, branch, worktree, then the entry's own names. */
function chiefSearchFields(entry) {
  const data = entry.data;
  const shared = [
    chiefRepoName(data),
    text(data.branch),
    text(data.worktree?.slug),
    chiefPortBadge(data),
    normalizePr(data) ? `#${normalizePr(data).number}` : "",
  ];
  const named =
    entry.kind === "room"
      ? [
          text(data.title),
          text(data.id),
          text(data.coordinator?.name),
          text(data.coordinator?.session),
        ]
      : [text(data.name), text(data.session)];
  return [...shared, ...named].map((field) => field.toLowerCase());
}

/** Desk and inbox records for the drawer, newest first with a stable ID tie-break. */
function chiefDrawerItems(status) {
  const stampOf = (item) => {
    const raw = item.at ?? item.createdAt ?? item.updatedAt;
    const value = typeof raw === "number" ? raw : Date.parse(String(raw ?? ""));
    return Number.isFinite(value) ? value : 0;
  };
  const idOf = (item) => (typeof item.id === "string" && item.id ? item.id : "");
  return [...list(status?.desk), ...list(status?.inbox)]
    .toSorted((left, right) => {
      const byTime = stampOf(right) - stampOf(left);
      if (byTime !== 0) return byTime;
      return idOf(left).localeCompare(idOf(right));
    })
    .map((item) => ({
      id: idOf(item),
      from: text(item.from),
      kind: text(item.kind),
      text: text(item.text),
    }));
}

/** Strip terminal controls from typed input. Newlines and tabs cannot enter a single-line reply. */
export function chiefInputText(value) {
  return stripVTControlCharacters(String(value ?? "")).replaceAll(CONTROL_TEXT, "");
}

function dropLastGrapheme(value) {
  return [...graphemes.segment(value)]
    .slice(0, -1)
    .map((part) => part.segment)
    .join("");
}

/** The last characters of a line that fit `width`, with an ellipsis for the cut-off start. */
function tailText(value, width, tier) {
  width = Math.max(0, Math.floor(width));
  const cleaned = plain(value);
  if (displayWidth(cleaned) <= width) return cleaned;
  const mark = tier === "ascii" ? "..." : "…";
  const limit = width - displayWidth(mark);
  if (limit <= 0) return truncateDisplay(mark, width, tier);
  const parts = [...graphemes.segment(cleaned)].map((part) => part.segment);
  let used = 0;
  let start = parts.length;
  while (start > 0) {
    const size = cellWidth(parts[start - 1]);
    if (used + size > limit) break;
    used += size;
    start--;
  }
  return `${mark}${parts.slice(start).join("")}`;
}

export class ChiefView {
  constructor(
    status,
    {
      now = Date.now,
      height = 32,
      color = false,
      theme,
      tier = process.env.ORK_GLYPHS ? glyphTier() : "nerd",
      mouseEnabled = true,
      confirmClose = false,
      lastRoomId,
      fill = true,
    } = {},
  ) {
    this.fill = fill !== false;
    this.now = now;
    this.height = height;
    this.renderWidth = 80;
    this.color = color && !process.env.NO_COLOR;
    this.appearance = { enabled: this.color, theme: resolveTheme(theme) };
    this.tier = tier;
    this.mouseEnabled = mouseEnabled !== false;
    this.confirmClose = Boolean(confirmClose);
    this.closeArmedAt = undefined;
    this.targets = [];
    this.hovered = undefined;
    this.notice = "";
    this.overlay = undefined;
    this.listOffset = 0;
    this.lastRoomId = lastRoomId;
    this.selectedKey = undefined;
    this.status = null;
    this.entries = [];
    this.visible = [];
    this.query = "";
    this.attentionOnly = false;
    this.prompt = null;
    this.drawerOpen = false;
    this.drawerOffset = 0;
    this.drawerCapacity = DRAWER_MAX;
    this.roomClose = undefined;
    this.setStatus(status);
  }

  setStatus(status) {
    this.status = status && typeof status === "object" ? status : null;
    this.entries = chiefEntries(this.status);
    this.refreshVisible();
    if (
      this.prompt?.kind === "reply" &&
      this.entries.every((entry) => entry.key !== this.prompt.key)
    ) {
      this.notice = `Reply cancelled: ${this.prompt.targetLabel} is no longer listed.`;
      this.prompt = null;
    }
    if (this.roomClose && this.entries.every((entry) => entry.key !== this.roomClose.key))
      this.roomClose = undefined;
    this.reconcileSelection();
    if (this.roomClose && this.roomClose.key !== this.selectedKey) this.roomClose = undefined;
  }

  /** Recompute the one visible list from the search text and the attention filter. */
  refreshVisible() {
    const needle = text(this.query).toLowerCase();
    this.visible = this.entries.filter(
      (entry) =>
        (!needle || chiefSearchFields(entry).some((field) => field.includes(needle))) &&
        (!this.attentionOnly || chiefAttention(entry)),
    );
  }

  /** Keep a selection that is still visible; otherwise choose the last room or the first visible row. */
  reconcileSelection() {
    if (this.visible.length === 0 || this.visible.some((entry) => entry.key === this.selectedKey))
      return;
    const preferred = this.lastRoomId
      ? this.visible.find((entry) => entry.key === `room:${this.lastRoomId}`)
      : undefined;
    this.selectedKey = (preferred || this.visible[0]).key;
  }

  afterFilterChange() {
    this.refreshVisible();
    this.reconcileSelection();
    if (this.visible.length > 0) return;
    if (this.attentionOnly || text(this.query)) {
      this.notice = `No match${text(this.query) ? ` for "${text(this.query)}"` : ""}${this.attentionOnly ? " needing attention" : ""}`;
    }
  }

  get needsAnimation() {
    if (this.tier === "ascii" && !this.appearance.enabled) return false;
    return this.entries.some((entry) => {
      const pill = entry.kind === "room" ? chiefRoomPill(entry.data) : sessionPill(entry.data);
      return pill.tone === "running";
    });
  }

  selectedEntry() {
    return this.visible.find((entry) => entry.key === this.selectedKey);
  }

  selectedIndex() {
    return this.visible.findIndex((entry) => entry.key === this.selectedKey);
  }

  move(delta) {
    if (this.visible.length === 0) return false;
    const current = Math.max(0, this.selectedIndex());
    const next = Math.max(0, Math.min(this.visible.length - 1, current + delta));
    if (next === current && this.selectedIndex() !== -1) return false;
    const key = this.visible[next].key;
    if (key !== this.selectedKey) this.roomClose = undefined;
    this.selectedKey = key;
    return true;
  }

  drill(entry = this.selectedEntry()) {
    if (!entry) return false;
    if (entry.kind !== "room") return this.focus(entry);
    this.lastRoomId = entry.data.id;
    return { type: "chief-drill", roomId: entry.data.id, room: entry.data };
  }

  focus(entry = this.selectedEntry()) {
    if (!entry) return false;
    const member = entry.kind === "room" ? entry.data.coordinator : entry.data;
    const target = chiefPaneTarget(member);
    if (!target) {
      this.notice =
        entry.kind === "room"
          ? "This orchestrator has no live terminal pane."
          : "This session has no live terminal pane.";
      return true;
    }
    return { type: "chief-focus", target, label: target.name || target.id };
  }

  focusChief() {
    const target = chiefPaneTarget(this.status?.chief);
    if (!target) {
      this.notice = this.status?.chief
        ? "The bound Chief has no live terminal pane."
        : "No Chief is bound. Run ork chief bind in the Chief chat.";
      return true;
    }
    return { type: "chief-focus-chief", target, label: target.name || "Chief" };
  }

  /** Bare q: closes at once, or when confirmClose is set only when pressed again promptly. */
  requestClose(nowMs = this.now()) {
    if (!this.confirmClose) return { type: "close-view" };
    if (Number.isFinite(this.closeArmedAt) && nowMs - this.closeArmedAt <= CLOSE_CONFIRM_MS) {
      this.closeArmedAt = undefined;
      return { type: "close-view" };
    }
    this.closeArmedAt = nowMs;
    this.notice = "Press q again to close this pane; agents keep running";
    return true;
  }

  /** The armed room close, or undefined once it has timed out or been disarmed. */
  armedRoomClose() {
    if (!this.roomClose) return;
    if (this.now() - this.roomClose.armedAt > CLOSE_CONFIRM_MS) this.roomClose = undefined;
    return this.roomClose;
  }

  /** `x` on a room: first press arms that room, a second press within the interval closes it. */
  closeRoom() {
    const entry = this.selectedEntry();
    if (!entry || entry.kind !== "room") {
      this.roomClose = undefined;
      this.notice = entry
        ? "Only orchestrator rooms can be closed here."
        : "Select an orchestrator room to close it.";
      return true;
    }
    const room = entry.data;
    const label = roomName(room);
    if (chiefRoomLive(room)) {
      this.roomClose = undefined;
      this.notice = `${label} is still working. Stop its work before closing it.`;
      return true;
    }
    const now = this.now();
    const armed = this.armedRoomClose();
    if (armed && armed.key === entry.key && armed.roomId === room.id) {
      this.roomClose = undefined;
      return { type: "chief-close-room", roomId: room.id };
    }
    this.roomClose = { key: entry.key, roomId: room.id, label, armedAt: now };
    this.notice = `Press x again within ${Math.round(CLOSE_CONFIRM_MS / 1000)}s to close ${label}`;
    return true;
  }

  /** `r`: capture the selected raw target and its display label for the reply prompt. */
  startReply() {
    const entry = this.selectedEntry();
    if (!entry) {
      this.notice = "Select an orchestrator or session to reply to.";
      return true;
    }
    const data = entry.data;
    const target = entry.kind === "room" ? data.id : data.session;
    if (typeof target !== "string" || !target) {
      this.notice = "This item has no ID to reply to.";
      return true;
    }
    const label = entry.kind === "room" ? roomName(data) : sessionName(data);
    this.prompt = { kind: "reply", key: entry.key, target, targetLabel: label, text: "" };
    return true;
  }

  /** `n`: the next visible attention item after the selection, wrapping once. */
  nextAttention() {
    const total = this.visible.length;
    if (total === 0) {
      this.notice = "Nothing to step through in this view.";
      return true;
    }
    const start = Math.max(0, this.selectedIndex() + 1);
    for (let step = 0; step < total; step++) {
      const entry = this.visible[(start + step) % total];
      if (chiefAttention(entry)) {
        this.selectedKey = entry.key;
        return true;
      }
    }
    this.notice = "Nothing needs attention in this view.";
    return true;
  }

  /** `A`: acknowledge the desk and unattributed inbox while the drawer is open. */
  acknowledgeDesk() {
    if (!this.drawerOpen) return false;
    const items = chiefDrawerItems(this.status);
    if (items.length === 0) {
      this.notice = "Nothing is waiting for Chief.";
      return true;
    }
    if (items.some((item) => !item.id)) {
      this.notice = "This status has no item IDs, so these items cannot be acknowledged here.";
      return true;
    }
    return { type: "chief-ack-desk" };
  }

  drawerMaxOffset() {
    return Math.max(0, chiefDrawerItems(this.status).length - this.drawerCapacity);
  }

  scrollDrawer(delta) {
    const next = Math.max(0, Math.min(this.drawerMaxOffset(), this.drawerOffset + delta));
    if (next === this.drawerOffset) return false;
    this.drawerOffset = next;
    return true;
  }

  /** Enter, Backspace and printable keys edit the active prompt before any global shortcut. */
  handlePrompt(key) {
    const edit = this.prompt;
    const isFilter = edit.kind === "filter";
    if (key === "\u{1B}") {
      this.prompt = null;
      if (isFilter) {
        this.query = "";
        this.afterFilterChange();
      } else {
        this.notice = "Reply cancelled.";
      }
      return true;
    }
    if (key.startsWith("\u{1B}")) return true;
    if (key === "\r" || key === "\n") {
      if (isFilter) {
        this.prompt = null;
        return true;
      }
      const body = edit.text.trim();
      if (!body) {
        this.notice = "Type a reply first, or press Esc to cancel.";
        return true;
      }
      this.prompt = null;
      return {
        type: "chief-reply",
        target: edit.target,
        targetLabel: edit.targetLabel,
        text: body,
      };
    }
    if (key === "\u{7F}" || key === "\b") {
      if (isFilter) {
        this.query = dropLastGrapheme(this.query);
        this.afterFilterChange();
      } else {
        edit.text = dropLastGrapheme(edit.text);
      }
      return true;
    }
    const value = chiefInputText(key);
    if (!value) return true;
    if (isFilter) {
      this.query += value;
      this.afterFilterChange();
    } else {
      edit.text += value;
    }
    return true;
  }

  handleKey(key) {
    this.notice = "";
    if (key !== "q") this.closeArmedAt = undefined;
    if (key !== "x") this.roomClose = undefined;
    if (this.prompt) return this.handlePrompt(key);
    if (this.overlay) {
      if (["\u{1B}", "?", "\u{1B}[O"].includes(key)) this.overlay = undefined;
      return true;
    }
    if (this.drawerOpen && (key === "\u{1B}" || key === "i")) {
      this.drawerOpen = false;
      return true;
    }
    if (this.drawerOpen && UP.has(key)) {
      this.scrollDrawer(-1);
      return true;
    }
    if (this.drawerOpen && DOWN.has(key)) {
      this.scrollDrawer(1);
      return true;
    }
    if (key === "\u{1B}" && (this.query || this.attentionOnly)) {
      this.query = "";
      this.attentionOnly = false;
      this.afterFilterChange();
      return true;
    }
    if (key === "?") {
      this.overlay = "help";
      return true;
    }
    if (UP.has(key)) return this.move(-1);
    if (DOWN.has(key)) return this.move(1);
    if (key === "\u{1B}[5~") return this.move(-5);
    if (key === "\u{1B}[6~") return this.move(5);
    if (key === "\u{1B}[H" || key === "g") return this.move(-this.visible.length);
    if (key === "\u{1B}[F" || key === "G") return this.move(this.visible.length);
    if (key === CHIEF_KEYS.drill) return this.drill();
    if (CHIEF_KEYS.focus.has(key)) return this.focus();
    if (key === CHIEF_KEYS.chief) return this.focusChief();
    if (key === CHIEF_KEYS.mode) {
      if (!this.lastRoomId) {
        this.notice = "Select an orchestrator and press Enter to open its room.";
        return true;
      }
      return { type: "chief-mode", mode: "room", roomId: this.lastRoomId };
    }
    if (key === CHIEF_KEYS.mouse) {
      this.mouseEnabled = !this.mouseEnabled;
      return { type: "mouse-toggle", enabled: this.mouseEnabled };
    }
    if (key === "/") {
      this.prompt = { kind: "filter" };
      return true;
    }
    if (key === "a") {
      this.attentionOnly = !this.attentionOnly;
      this.afterFilterChange();
      return true;
    }
    if (key === "n") return this.nextAttention();
    if (key === "r") return this.startReply();
    if (key === "i") {
      this.drawerOpen = true;
      this.drawerOffset = 0;
      return true;
    }
    if (key === "A") return this.drawerOpen ? this.acknowledgeDesk() : false;
    if (key === "x") return this.closeRoom();
    if (key === "q") return this.requestClose();
    return false;
  }

  handleInput(key) {
    return this.handleKey(key);
  }

  handleMouse({ x, y, button, action }) {
    if (action === "scroll-up" || action === "scroll-down") {
      if (this.overlay || !this.drawerOpen) return false;
      return this.scrollDrawer(action === "scroll-down" ? 1 : -1);
    }
    const target = hitTest(this.targets, x, y);
    this.hovered = target?.id;
    if (action === "press") {
      this.closeArmedAt = undefined;
      this.roomClose = undefined;
    }
    if (action !== "press" || button !== 0 || !target || target.id === "drawer") return false;
    if (target.entryKey) {
      this.notice = "";
      if (this.overlay) this.overlay = undefined;
      const entry = this.visible.find((item) => item.key === target.entryKey);
      if (!entry) return false;
      if (this.selectedKey === entry.key) return this.drill(entry);
      this.selectedKey = entry.key;
      return true;
    }
    return target.key ? this.handleKey(target.key) : false;
  }

  style(value, token) {
    return tone(value, token, this.appearance);
  }

  panel(title, body, width, right = "", headerTone = "swarmHeading") {
    return frame(title, body, width, {
      glyphs: glyphSet(this.tier),
      color: this.appearance,
      right,
      headerTone,
    });
  }

  headerLines(inner) {
    const now = this.now();
    const chief = this.status?.chief;
    const stale = this.status?.staleChief;
    const star = this.tier === "ascii" ? "*" : "★";
    const body = [];
    if (chief) {
      const parts = [
        this.style(`${star} ${text(chief.name) || "Chief"}`, "identity33"),
        ...(modelLabel(chief) ? [this.style(modelLabel(chief), "leadModel")] : []),
        ...(relativeAge(chief.boundAt, now)
          ? [this.style(`bound ${relativeAge(chief.boundAt, now)} ago`, "muted")]
          : []),
      ];
      body.push(` ${parts.join(this.style(" · ", "leadSeparator"))}`);
    } else if (stale) {
      body.push(
        ` ${this.style(`${star} stale chief ${text(stale.name || stale.session)}`, "stale")}${this.style(` · ${text(stale.reason) || "not live"}`, "muted")}`,
      );
    } else {
      body.push(` ${this.style("No chief bound · ork chief bind", "muted")}`);
    }
    const summary = chiefSummary(this.status);
    const summaryParts = [
      {
        full: `${summary.orchestrators} orchestrator${summary.orchestrators === 1 ? "" : "s"}`,
        short: `${summary.orchestrators} orch`,
        token: "heading",
      },
      { full: `${summary.working} working`, short: `${summary.working}▶`, token: "running" },
      ...(summary.blocked
        ? [{ full: `${summary.blocked} blocked`, short: `${summary.blocked}⚠`, token: "warning" }]
        : []),
      ...(summary.attention
        ? [
            {
              full: `${summary.attention} need you`,
              short: `!${summary.attention}`,
              token: "warning bold",
            },
          ]
        : []),
      ...(summary.standalone
        ? [
            {
              full: `${summary.standalone} solo`,
              short: `${summary.standalone} solo`,
              token: "muted",
            },
          ]
        : []),
    ];
    const budget = Math.max(1, inner - 3);
    const fullText = summaryParts.map((part) => part.full).join(" · ");
    const shortText = summaryParts.map((part) => part.short).join(" · ");
    const isCompact = displayWidth(fullText) > budget;
    const separator = isCompact && displayWidth(shortText) > budget ? " " : " · ";
    body.push(
      ` ${summaryParts
        .map((part) => {
          let label = isCompact ? part.short : part.full;
          if (this.tier === "ascii") label = label.replace("▶", ">").replace("⚠", "!");
          return this.style(label, part.token);
        })
        .join(this.style(separator, "leadSeparator"))}`,
    );
    const unread = list(this.status?.inbox).length + list(this.status?.desk).length;
    if (unread > 0) {
      const mail = this.tier === "ascii" ? "@" : "✉";
      body.push(
        ` ${this.style(`${mail} ${unread} unread for Chief`, "warning")}${this.style(" · ork chief status", "muted")}`,
      );
    }
    const remoteObservations = list(this.status?.remoteObservations);
    for (const observation of remoteObservations) {
      const host = text(observation.origin).slice(0, 12);
      const counts = `${observation.rooms} rooms · ${observation.presentPeers} peers · ${observation.accounts} quota accounts (${observation.staleAccounts} stale) · ${observation.chiefItems} Chief items`;
      body.push(` ${this.style(`Remote ${host} · ${counts}`, "muted")}`);
    }
    if (this.status?.roomsError) {
      const message = `rooms unavailable: ${text(this.status.roomsError)}`;
      body.push(` ${this.style(truncateDisplay(message, budget, this.tier), "muted")}`);
    }
    const accounts = list(this.status?.accounts);
    if (this.status?.quotaError) {
      const message = `quota unavailable: ${text(this.status.quotaError)}`;
      body.push(` ${this.style(truncateDisplay(message, budget, this.tier), "muted")}`);
    } else if (accounts.length > 0 && this.height >= 16) {
      const meters = accounts.map((account) => {
        const windows = list(account.windows).filter((window) =>
          Number.isFinite(window.remainingPct),
        );
        const short = windows.filter((window) => window.kind === "5h" || window.windowMins === 300);
        const active = short.length > 0 ? short : windows;
        return {
          label: quotaAccountLabel(account, this.tier) || text(account.short || account.id),
          remaining:
            active.length > 0
              ? Math.min(...active.map((window) => window.remainingPct))
              : undefined,
        };
      });
      const strip = meterStrip("", meters, budget, {
        color: this.appearance,
        tier: this.tier,
      }).slice(0, 2);
      body.push(...strip.map((line) => ` ${line}`));
    }
    const host = text(this.status?.machine) || "";
    const right = inner >= 40 && host ? host : "";
    const title = this.tier === "ascii" ? "ORK CHIEF" : `${star} ORK CHIEF`;
    return this.panel(title, body, inner, right);
  }

  entryRows(entry, inner, isSelected) {
    const now = this.now();
    const isRoom = entry.kind === "room";
    const item = entry.data;
    const pill = isRoom ? chiefRoomPill(item) : sessionPill(item);
    const pointer = this.tier === "ascii" ? ">" : "▸";
    const isHovered = this.hovered === `entry:${entry.key}`;
    let nameTone = `${pill.tone === "muted" ? "heading" : pill.tone} bold`;
    if (isHovered) nameTone = "buttonHover";
    else if (isSelected) nameTone = "agentSelected";
    const glyph = this.style(statusGlyph(pill, this.tier, now), pill.tone);
    const name = isRoom ? roomName(item) : sessionName(item);
    const member = isRoom ? item.coordinator || {} : item;
    const attention = isRoom ? attentionItems(item) : [];
    const badges = [
      ...(isRoom ? [] : [entry.repo]),
      ...(locationBadge(item) ? [locationBadge(item)] : []),
    ];
    const attentionBadge = attention.length > 0 ? ` !${attention.length}` : "";
    const isWide = inner >= 72;
    const workers = isRoom
      ? chiefWorkerSummary(item.counts, { compact: !isWide, tier: this.tier })
      : "";
    const brand = providerMark(member.model || member.engine, this.tier);
    const model = modelLabel(member);
    const rightParts = isWide
      ? [
          ...(model ? [`${brand ? `${brand} ` : ""}${model}`] : []),
          ...(workers ? [workers] : []),
          pill.label,
        ]
      : [...(workers ? [workers] : []), pill.label];
    const rightPlain = rightParts.join(" · ");
    const lead = isSelected ? `${pointer} ` : "  ";
    const leftRequired = `${lead}${glyph} `;
    const leftCells = displayWidth(plain(leftRequired));
    const badgeText = badges.length > 0 ? ` · ${badges.join(" · ")}` : "";
    const rightBudget = Math.min(displayWidth(rightPlain), Math.max(0, inner - leftCells - 8));
    const rightText = rightBudget > 0 ? truncateDisplay(rightPlain, rightBudget, this.tier) : "";
    const prBadge = chiefPrBadge(item, this.tier);
    const portBadge = chiefPortBadge(item);
    const attentionWidth = displayWidth(attentionBadge);
    const cap = Math.max(
      1,
      inner - leftCells - displayWidth(rightText) - (rightText ? 1 : 0) - attentionWidth,
    );
    const nameCells = displayWidth(name);
    // Narrow rows: shorten the name first (down to a stub), then drop the optional port badge; the PR
    // badge with its state word is kept and only truncated when nothing else is left to give.
    const stub = Math.min(nameCells, 8);
    const prTail = prBadge ? ` ${prBadge.text}` : "";
    let portTail = portBadge ? ` ${portBadge}` : "";
    let headBudget = cap - displayWidth(portTail) - displayWidth(prTail);
    if (portTail && headBudget < stub) {
      portTail = "";
      headBudget = cap - displayWidth(prTail);
    }
    let prShown = prTail;
    if (prTail && headBudget < stub) {
      headBudget = Math.min(stub, Math.max(1, cap - 1));
      prShown = truncateDisplay(prTail, Math.max(0, cap - headBudget), this.tier);
    }
    headBudget = Math.max(1, headBudget);
    const fullName = `${name}${badgeText}`;
    const shown =
      displayWidth(fullName) > headBudget
        ? truncateDisplay(fullName, headBudget, this.tier)
        : fullName;
    const [shownName, shownBadge] = splitAtCells(shown, nameCells);
    const styledName = `${this.style(shownName, nameTone)}${shownBadge ? this.style(shownBadge, "muted") : ""}${portTail ? this.style(portTail, "muted") : ""}${prShown ? this.style(prShown, prBadge.tone) : ""}`;
    const styledAttention = attentionBadge ? this.style(attentionBadge, "warning bold") : "";
    const used =
      leftCells +
      displayWidth(shown) +
      displayWidth(portTail) +
      displayWidth(prShown) +
      attentionWidth +
      displayWidth(rightText);
    const gap = " ".repeat(Math.max(rightText ? 1 : 0, inner - used));
    const rightTone = isSelected ? `${pill.tone} bold` : "muted";
    const row1 = fitStyled(
      `${leftRequired}${styledName}${styledAttention}${gap}${rightText ? colorProviderMarks(this.style(rightText, rightTone), this.appearance) : ""}`,
      inner,
    );
    const indent = " ".repeat(4);
    const detailBudget = Math.max(1, inner - indent.length);
    let detail;
    let detailTone = isSelected ? "heading" : "muted";
    const firstAttention = attention[0];
    if (firstAttention) {
      detail = `${text(firstAttention.kind) || "attention"}: ${text(firstAttention.text) || text(firstAttention.from)}`;
      detailTone = "warning";
    } else {
      const stage = text(item.stage);
      const task = text(item.task) || text(item.goal) || text(item.objective);
      detail = [stage && stage !== task ? stage : "", task].filter(Boolean).join(" — ");
      if (!isWide && !isRoom && model) detail = [model, detail].filter(Boolean).join(" · ");
      if (!isWide && isRoom && model) detail = [model, detail].filter(Boolean).join(" · ");
    }
    if (!detail) detail = isRoom ? "No task reported yet" : "No progress reported";
    const row2 = `${indent}${this.style(truncateDisplay(detail, detailBudget, this.tier), detailTone)}`;
    return [row1, row2];
  }

  groupHeading(label, detail, inner) {
    const fold = this.tier === "ascii" ? "-" : "▾";
    const head = `${fold} ${label}`;
    const tail = detail ? ` · ${detail}` : "";
    const budget = Math.max(1, inner - displayWidth(tail));
    const shown = displayWidth(head) > budget ? truncateDisplay(head, budget, this.tier) : head;
    return fitStyled(`${this.style(shown, "mdSection")}${this.style(tail, "muted")}`, inner);
  }

  /** Every visible list row with the entry key it belongs to, for scrolling and mouse targets. */
  listRows(inner) {
    const rows = [];
    let currentRepo;
    let isStandaloneHeadingShown = false;
    const roomCounts = new Map();
    for (const entry of this.visible) {
      if (entry.kind === "room") roomCounts.set(entry.repo, (roomCounts.get(entry.repo) || 0) + 1);
    }
    const standaloneCount = this.visible.filter((entry) => entry.kind === "session").length;
    for (const entry of this.visible) {
      if (entry.kind === "room" && entry.repo !== currentRepo) {
        currentRepo = entry.repo;
        const total = roomCounts.get(entry.repo) || 0;
        rows.push({
          line: this.groupHeading(entry.repo, `${total} room${total === 1 ? "" : "s"}`, inner),
        });
      }
      if (entry.kind === "session" && !isStandaloneHeadingShown) {
        isStandaloneHeadingShown = true;
        rows.push({
          line: this.groupHeading("Sessions", `${standaloneCount} not in a room`, inner),
        });
      }
      const lines = this.entryRows(entry, inner, entry.key === this.selectedKey);
      for (const line of lines) rows.push({ line, entryKey: entry.key });
    }
    return rows;
  }

  detailLines(inner, maxRows) {
    const entry = this.selectedEntry();
    if (!entry || maxRows <= 0) return [];
    const item = entry.data;
    const budget = Math.max(1, inner - 3);
    const rows = [];
    const label = (name, value, token = "") => {
      const clean = text(value);
      if (!clean) return;
      const head = `${name} `;
      const wrapped = wrapText(clean, Math.max(1, budget - head.length));
      rows.push(
        ` ${this.style(head, "mdSection")}${token ? this.style(wrapped[0], token) : wrapped[0]}`,
      );
      for (const line of wrapped.slice(1, 2))
        rows.push(` ${" ".repeat(head.length)}${token ? this.style(line, token) : line}`);
    };
    if (entry.kind === "room") {
      const counts = item.counts || {};
      label("Goal", item.goal || item.objective || item.title);
      label(
        "Team",
        `${chiefWorkerSummary(counts)}${count(counts.total) ? ` (${count(counts.total)} total)` : ""}`,
      );
      const attention = attentionItems(item)[0];
      if (attention) {
        label(
          "Needs",
          `${text(attention.from) ? `${text(attention.from)}: ` : ""}${text(attention.text) || text(attention.kind)}`,
          "warning",
        );
      }
      const mission = item.mission && typeof item.mission === "object" ? item.mission : null;
      if (mission?.state) {
        label(
          "Mission",
          `${text(mission.state)}${text(mission.reason) ? ` — ${text(mission.reason)}` : ""}`,
        );
      }
      const latest = item.latest && typeof item.latest === "object" ? item.latest : null;
      if (latest) {
        label("Latest", `${text(latest.from) ? `${text(latest.from)}: ` : ""}${text(latest.text)}`);
      }
      label(
        "Where",
        [text(item.repo?.path) || text(item.cwd), locationBadge(item)].filter(Boolean).join(" "),
      );
      if (item.parentChief) label("Chief", item.parentChief.name || item.parentChief.session);
    } else {
      label("Task", item.task || item.stage);
      label("Model", modelLabel(item));
      label("Where", [text(item.cwd), locationBadge(item)].filter(Boolean).join(" "));
      label("Session", item.session);
    }
    return rows.slice(0, maxRows);
  }

  /** One desk or inbox record: sender and kind first, then the text clipped to fit. */
  drawerRow(item, width) {
    const head = [item.from || "Unattributed", item.kind].filter(Boolean).join(" · ");
    const headBudget = Math.min(displayWidth(head), Math.max(8, Math.floor(width / 2)));
    const shownHead = truncateDisplay(head, headBudget, this.tier);
    const bodyBudget = width - displayWidth(shownHead) - 2;
    if (!item.text || bodyBudget < 4) return this.style(shownHead, "warning");
    return `${this.style(shownHead, "warning")}  ${this.style(truncateDisplay(item.text, bodyBudget, this.tier), "heading")}`;
  }

  drawerLines(inner, items, rows) {
    const body = [];
    if (items.length === 0) body.push(` ${this.style("Nothing is waiting for Chief.", "muted")}`);
    const shown = items.slice(this.drawerOffset, this.drawerOffset + rows);
    for (const item of shown) body.push(` ${this.drawerRow(item, inner - 3)}`);
    while (body.length < rows) body.push("");
    const shownEnd = Math.min(items.length, this.drawerOffset + rows);
    let range = "";
    if (items.length > rows) range = ` ${this.drawerOffset + 1}-${shownEnd} of ${items.length}`;
    else if (items.length > 0) range = ` ${items.length}`;
    const right = items.length > 0 ? "A ack · Esc close" : "Esc close";
    return this.panel(`Chief desk & inbox${range}`, body, inner, right, "mdSection");
  }

  promptLine(inner) {
    if (this.prompt) {
      const isFilter = this.prompt.kind === "filter";
      const cursor = this.tier === "ascii" ? "_" : "▏";
      const label = isFilter
        ? "Find"
        : `Reply to ${truncateDisplay(this.prompt.targetLabel, Math.max(4, Math.floor(inner / 3)), this.tier)}`;
      const prefix = `${label}: `;
      const room = inner - displayWidth(prefix) - displayWidth(cursor);
      const value = isFilter ? this.query : this.prompt.text;
      const shown = tailText(value, Math.max(0, room), this.tier);
      return `${this.style(prefix, "heading bold")}${this.style(shown, "heading")}${this.style(cursor, "warning")}`;
    }
    if (this.query || this.attentionOnly) {
      const parts = [];
      if (text(this.query)) parts.push(`find "${text(this.query)}"`);
      if (this.attentionOnly) parts.push("attention only");
      parts.push(`${this.visible.length}/${this.entries.length} shown`);
      return this.style(truncateDisplay(parts.join(" · "), inner, this.tier), "muted");
    }
    return null;
  }

  controls(width) {
    if (this.overlay) {
      return actionBar(
        [{ id: "dismiss", label: "Back", key: "\u{1B}", hint: "Esc", primary: true }],
        width,
        { color: this.appearance, hovered: this.hovered, tier: this.tier },
      );
    }
    const entry = this.selectedEntry();
    const isNarrow = width < 60;
    const hasPane =
      entry &&
      Boolean(chiefPaneTarget(entry.kind === "room" ? entry.data.coordinator : entry.data));
    const hasChiefPane = Boolean(chiefPaneTarget(this.status?.chief));
    const actions = [
      {
        id: "drill",
        label: entry?.kind === "session" ? "Focus" : "Open room",
        key: "\r",
        hint: "Enter",
        primary: true,
        disabled: !entry || (entry.kind === "session" && !hasPane),
      },
    ];
    if (entry?.kind === "room") {
      actions.push({
        id: "focus",
        label: isNarrow ? "Pane" : "Focus pane",
        key: "f",
        disabled: !hasPane,
      });
    }
    if (!isNarrow) actions.push({ id: "chief", label: "Chief", key: "C", disabled: !hasChiefPane });
    if (this.lastRoomId && !isNarrow) {
      actions.push({ id: "mode", label: "Room view", key: "\t", hint: "Tab" });
    }
    actions.push({ id: "desk", label: "Desk", key: "i" });
    actions.push({ id: "reply", label: "Reply", key: "r", disabled: !entry });
    actions.push({ id: "find", label: "Find", key: "/" });
    if (entry?.kind === "room" && !isNarrow) {
      actions.push({ id: "close", label: "Close room", key: "x" });
    }
    actions.push({ id: "help", label: isNarrow ? "Keys" : "Shortcuts", key: "?" });
    return actionBar(actions, width, {
      color: this.appearance,
      hovered: this.hovered,
      tier: this.tier,
    });
  }

  helpLines(inner, height) {
    const rows = [
      "↑/↓ j/k     Select an orchestrator or session (scrolls the desk while it is open)",
      "Enter       Open the selected room's Swarm View",
      "Tab         Switch between Chief overview and the last room",
      "Backspace   Return from a room to the Chief overview (also Esc)",
      "f or o      Focus the selected orchestrator's terminal pane",
      "C           Focus the bound Chief chat pane",
      "/           Filter by repo, branch, worktree, title or name (Enter keeps, Esc clears)",
      "a           Show only items that need attention (toggles)",
      "n           Jump to the next item that needs attention",
      "r           Reply to the selected orchestrator or session (Enter sends, Esc cancels)",
      "i           Chief desk and inbox (A acknowledges, i or Esc closes)",
      "x x         Close the selected idle room (press x twice within 3 seconds)",
      "Mouse       Click to select; click again to open; wheel scrolls an open desk",
      "m           Toggle mouse capture to select terminal text",
      "? or Esc    Close this reference",
      this.confirmClose
        ? "q q/Ctrl-C  Close the side window (q twice); agents keep running"
        : "q or Ctrl-C Close the side window; agents keep running",
    ];
    const interior = Math.max(1, inner - 4);
    const wrapped = rows.flatMap((row) =>
      wrapText(row, interior).map((line, index) =>
        index === 0 && interior >= 24 && line.length > 12
          ? ` ${this.style(line.slice(0, 12), "mdSection")}${line.slice(12)}`
          : ` ${line}`,
      ),
    );
    const visible = wrapped.slice(0, Math.max(1, height - 2));
    while (visible.length < height - 2) visible.push("");
    return this.panel("Chief shortcuts", visible, inner, "", "mdSection");
  }

  marginLines(lines, width) {
    const margin = Math.min(1, Math.floor((Math.max(1, width) - 1) / 2));
    const contentWidth = Math.max(1, width - margin * 2);
    return lines
      .slice(0, Math.max(0, this.height))
      .map(
        (line) =>
          `${" ".repeat(margin)}${colorProviderMarks(fitStyled(line, contentWidth), this.appearance)}`,
      );
  }

  footerHint() {
    if (this.notice) return { text: this.notice, tone: "warning" };
    if (this.prompt) {
      const hint =
        this.prompt.kind === "filter"
          ? "Enter keeps the filter · Esc clears it"
          : "Enter sends · Esc cancels";
      return { text: hint, tone: "muted" };
    }
    const armed = this.armedRoomClose();
    if (armed) {
      return { text: `Press x again to close ${armed.label}`, tone: "warning" };
    }
    if (!this.mouseEnabled)
      return { text: "Mouse off (select/copy) — press m to re-enable mouse", tone: "warning" };
    if (this.confirmClose)
      return { text: "Press q twice to close this pane; agents keep running", tone: "muted" };
    return null;
  }

  render(width) {
    width = Math.max(1, Math.floor(width) || 80);
    this.renderWidth = width;
    this.targets = [];
    const inner = Math.max(1, width - 2);
    if (this.height < 8) {
      return this.marginLines(
        this.panel("ork chief", ["Resize terminal to at least 8 rows"], inner),
        width,
      );
    }
    this.armedRoomClose();
    const lines = [...this.headerLines(inner)];
    const controls = this.controls(inner);
    const footer = this.footerHint();
    const prompt = this.promptLine(inner);
    const footerRows = 1 + controls.lines.length + (footer ? 1 : 0) + (prompt ? 1 : 0);
    const middle = Math.max(0, this.height - lines.length - footerRows);
    const showDrawer = this.drawerOpen && this.overlay !== "help";
    const drawerItems = showDrawer ? chiefDrawerItems(this.status) : [];
    const drawerRows = showDrawer
      ? Math.max(1, Math.min(DRAWER_MAX, drawerItems.length || 1, middle - 4))
      : 0;
    const drawerTotal = showDrawer ? drawerRows + 2 : 0;
    if (this.overlay === "help") {
      lines.push(...this.helpLines(inner, Math.max(3, middle)));
    } else if (this.visible.length === 0) {
      lines.push(...this.emptyPanel(inner));
    } else {
      const space = Math.max(2, middle - drawerTotal);
      const hasDetailRoom = space >= 12;
      const detailBody =
        hasDetailRoom && this.selectedEntry()
          ? this.detailLines(inner - 2, space >= 20 ? 6 : 3)
          : [];
      const detailRows = detailBody.length > 0 ? detailBody.length + 2 : 0;
      const listHeight = Math.max(2, space - detailRows);
      const rows = this.listRows(inner);
      const firstSelected = rows.findIndex((row) => row.entryKey === this.selectedKey);
      const lastSelected = rows.findLastIndex((row) => row.entryKey === this.selectedKey);
      const maxOffset = Math.max(0, rows.length - listHeight);
      let offset = Math.min(this.listOffset, maxOffset);
      if (firstSelected !== -1) {
        // Keep the group heading in view when its first entry is selected.
        const headingAbove = firstSelected > 0 && !rows[firstSelected - 1].entryKey ? 1 : 0;
        if (firstSelected - headingAbove < offset) offset = firstSelected - headingAbove;
        if (lastSelected >= offset + listHeight) offset = lastSelected - listHeight + 1;
      }
      offset = Math.max(0, Math.min(offset, maxOffset));
      this.listOffset = offset;
      const shown = rows.slice(offset, offset + listHeight);
      const listTop = lines.length;
      for (const [index, row] of shown.entries()) {
        lines.push(row.line);
        if (row.entryKey) {
          this.targets.push({
            id: `entry:${row.entryKey}`,
            entryKey: row.entryKey,
            x: 2,
            y: listTop + index + 1,
            width: inner,
            height: 1,
          });
        }
      }
      if (rows.length > listHeight && shown.length > 0) {
        const more = `${offset + shown.length}/${rows.length}`;
        const last = lines.length - 1;
        if (displayWidth(plain(lines[last])) + more.length + 1 <= inner) {
          lines[last] = fitStyled(
            `${fitStyled(lines[last], inner - more.length)}${this.style(more, "muted")}`,
            inner,
          );
        }
      }
      while (this.fill && lines.length < listTop + listHeight) lines.push("");
      if (detailRows > 0) {
        const entry = this.selectedEntry();
        const title = entry.kind === "room" ? roomName(entry.data) : sessionName(entry.data);
        const heading = truncateDisplay(title, Math.max(1, inner - 8), this.tier);
        lines.push(...this.panel(heading, detailBody, inner, "", "border"));
      }
    }
    if (showDrawer) {
      this.drawerCapacity = drawerRows;
      this.drawerOffset = Math.min(this.drawerOffset, Math.max(0, drawerItems.length - drawerRows));
      this.targets.push({ id: "drawer", x: 1, y: lines.length + 1, width, height: drawerTotal });
      lines.push(...this.drawerLines(inner, drawerItems, drawerRows));
    }
    const footerTop = Math.max(lines.length, this.height - footerRows);
    while (this.fill && lines.length < footerTop) lines.push("");
    lines.push(this.style(glyphSet(this.tier).horizontal.repeat(inner), "border"));
    if (prompt) lines.push(prompt);
    for (const target of controls.targets) {
      this.targets.push({ ...target, x: target.x + 1, y: target.y + lines.length });
    }
    lines.push(...controls.lines);
    if (footer) lines.push(this.style(fit(footer.text, inner), footer.tone));
    return this.marginLines(lines, width);
  }

  emptyPanel(inner) {
    if (this.entries.length === 0) {
      const empty = [
        "No active orchestrators or sessions on this machine.",
        "Spawn one: ork chief spawn --cwd <repo> --goal <text>",
      ].flatMap((line) =>
        wrapText(line, Math.max(1, inner - 4)).map((part) => ` ${this.style(part, "muted")}`),
      );
      return this.panel("Orchestrators", empty, inner, "", "border");
    }
    const query = text(this.query);
    const subject = `${query ? ` for "${query}"` : ""}${this.attentionOnly ? " needing attention" : ""}`;
    const message = [`No match${subject}.`, "/ edits the filter · a toggles attention"];
    const body = message.flatMap((line) =>
      wrapText(line, Math.max(1, inner - 4)).map((part) => ` ${this.style(part, "muted")}`),
    );
    return this.panel("No matches", body, inner, "", "border");
  }
}
