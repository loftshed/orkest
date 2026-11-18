/**
 * @module chief-view
 *
 * Ork Chief side window (`ork chief view`, `ork horde --view --chief`): a machine-wide
 * overview of every live orchestrator room and standalone agent session. It renders the
 * `ork.chief.status.v1` snapshot from `lib/chief.mjs` and returns small action objects
 * (`chief-drill`, `chief-focus`, `chief-focus-chief`, `chief-mode`) that the terminal
 * runner in `bin/horde-tui.mjs` turns into room drill-downs and pane focus requests.
 */
import path from "node:path";

import {
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
  const target = {
    id: text(session) || text(member.id) || "chief-target",
    name: text(member.name),
    engine: text(member.engine),
    herdrPaneId: typeof member.herdrPaneId === "string" ? member.herdrPaneId : undefined,
    herdrEndpoint: typeof member.herdrEndpoint === "string" ? member.herdrEndpoint : undefined,
    paneId: typeof member.paneId === "string" ? member.paneId : undefined,
    terminalServer: typeof member.terminalServer === "string" ? member.terminalServer : undefined,
    ...(session && { session: { id: session } }),
  };
  return target.herdrPaneId || target.paneId ? target : null;
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
      entries.push({ kind: "room", key: `room:${room.id}`, repo: group.repo, data: room });
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
    this.targets = [];
    this.hovered = undefined;
    this.notice = "";
    this.overlay = undefined;
    this.listOffset = 0;
    this.lastRoomId = lastRoomId;
    this.selectedKey = undefined;
    this.status = null;
    this.entries = [];
    this.setStatus(status);
  }

  setStatus(status) {
    this.status = status && typeof status === "object" ? status : null;
    this.entries = chiefEntries(this.status);
    if (this.entries.some((entry) => entry.key === this.selectedKey)) return;
    const preferred = this.lastRoomId
      ? this.entries.find((entry) => entry.key === `room:${this.lastRoomId}`)
      : undefined;
    this.selectedKey = (preferred || this.entries[0])?.key;
  }

  get needsAnimation() {
    if (this.tier === "ascii" && !this.appearance.enabled) return false;
    return this.entries.some((entry) => {
      const pill = entry.kind === "room" ? chiefRoomPill(entry.data) : sessionPill(entry.data);
      return pill.tone === "running";
    });
  }

  selectedEntry() {
    return this.entries.find((entry) => entry.key === this.selectedKey);
  }

  selectedIndex() {
    return this.entries.findIndex((entry) => entry.key === this.selectedKey);
  }

  move(delta) {
    if (this.entries.length === 0) return false;
    const current = Math.max(0, this.selectedIndex());
    const next = Math.max(0, Math.min(this.entries.length - 1, current + delta));
    if (next === current && this.selectedIndex() !== -1) return false;
    this.selectedKey = this.entries[next].key;
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

  handleKey(key) {
    this.notice = "";
    if (this.overlay) {
      if (["\u{1B}", "?", "\u{1B}[O"].includes(key)) this.overlay = undefined;
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
    if (key === "\u{1B}[H" || key === "g") return this.move(-this.entries.length);
    if (key === "\u{1B}[F" || key === "G") return this.move(this.entries.length);
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
    if (key === "q") return { type: "close-view" };
    return false;
  }

  handleInput(key) {
    return this.handleKey(key);
  }

  handleMouse({ x, y, button, action }) {
    if (action === "scroll-up" || action === "scroll-down") {
      if (this.overlay) return false;
      return this.move(action === "scroll-down" ? 1 : -1);
    }
    const target = hitTest(this.targets, x, y);
    this.hovered = target?.id;
    if (action !== "press" || button !== 0 || !target) return false;
    if (target.entryKey) {
      this.notice = "";
      if (this.overlay) this.overlay = undefined;
      const entry = this.entries.find((item) => item.key === target.entryKey);
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
    const nameBudget = Math.max(
      1,
      inner - leftCells - displayWidth(rightText) - (rightText ? 1 : 0) - attentionBadge.length,
    );
    const fullName = `${name}${badgeText}`;
    const shown =
      displayWidth(fullName) > nameBudget
        ? truncateDisplay(fullName, nameBudget, this.tier)
        : fullName;
    const nameCells = displayWidth(name);
    const shownName = shown.slice(0, Math.min(shown.length, name.length));
    const shownBadge = shown.length > name.length ? shown.slice(name.length) : "";
    const styledName =
      displayWidth(shown) < nameCells
        ? this.style(shown, nameTone)
        : `${this.style(shownName, nameTone)}${this.style(shownBadge, "muted")}`;
    const styledAttention = attentionBadge ? this.style(attentionBadge, "warning bold") : "";
    const used =
      leftCells + displayWidth(shown) + displayWidth(attentionBadge) + displayWidth(rightText);
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

  /** Every list row with the entry key it belongs to, for scrolling and mouse targets. */
  listRows(inner) {
    const rows = [];
    let currentRepo;
    let isStandaloneHeadingShown = false;
    const roomCounts = new Map();
    for (const entry of this.entries) {
      if (entry.kind === "room") roomCounts.set(entry.repo, (roomCounts.get(entry.repo) || 0) + 1);
    }
    const standaloneCount = this.entries.filter((entry) => entry.kind === "session").length;
    for (const entry of this.entries) {
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
    return actionBar(
      [
        {
          id: "drill",
          label: entry?.kind === "session" ? "Focus" : "Open room",
          key: "\r",
          hint: "Enter",
          primary: true,
          disabled: !entry || (entry.kind === "session" && !hasPane),
        },
        ...(entry?.kind === "room"
          ? [{ id: "focus", label: isNarrow ? "Pane" : "Focus pane", key: "f", disabled: !hasPane }]
          : []),
        { id: "chief", label: "Chief", key: "C", disabled: !hasChiefPane },
        ...(this.lastRoomId && !isNarrow
          ? [{ id: "mode", label: "Room view", key: "\t", hint: "Tab" }]
          : []),
        { id: "help", label: isNarrow ? "Keys" : "Shortcuts", key: "?" },
      ],
      width,
      { color: this.appearance, hovered: this.hovered, tier: this.tier },
    );
  }

  helpLines(inner, height) {
    const rows = [
      "↑/↓ j/k     Select an orchestrator or session",
      "Enter       Open the selected room's Swarm View",
      "Tab         Switch between Chief overview and the last room",
      "Backspace   Return from a room to the Chief overview (also Esc)",
      "f or o      Focus the selected orchestrator's terminal pane",
      "C           Focus the bound Chief chat pane",
      "Mouse       Click to select; click again to open",
      "m           Toggle mouse capture to select terminal text",
      "? or Esc    Close this reference",
      "q or Ctrl-C Close the side window; agents keep running",
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
    const lines = [...this.headerLines(inner)];
    const controls = this.controls(inner);
    const footerRows = 1 + controls.lines.length + (this.notice ? 1 : 0);
    if (this.overlay === "help") {
      lines.push(...this.helpLines(inner, Math.max(3, this.height - lines.length - footerRows)));
    } else if (this.entries.length === 0) {
      const empty = [
        "No active orchestrators or sessions on this machine.",
        "Spawn one: ork chief spawn --cwd <repo> --goal <text>",
      ].flatMap((line) =>
        wrapText(line, Math.max(1, inner - 4)).map((part) => ` ${this.style(part, "muted")}`),
      );
      lines.push(...this.panel("Orchestrators", empty, inner, "", "border"));
    } else {
      const space = Math.max(2, this.height - lines.length - footerRows);
      const hasDetailRoom = space >= 12;
      const detailBody = hasDetailRoom ? this.detailLines(inner - 2, space >= 20 ? 6 : 3) : [];
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
      const visible = rows.slice(offset, offset + listHeight);
      const listTop = lines.length;
      for (const [index, row] of visible.entries()) {
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
      if (rows.length > listHeight && visible.length > 0) {
        const more = `${offset + visible.length}/${rows.length}`;
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
    const footerTop = Math.max(lines.length, this.height - footerRows);
    while (this.fill && lines.length < footerTop) lines.push("");
    lines.push(this.style(glyphSet(this.tier).horizontal.repeat(inner), "border"));
    for (const target of controls.targets) {
      this.targets.push({ ...target, x: target.x + 1, y: target.y + lines.length });
    }
    lines.push(...controls.lines);
    if (this.notice) lines.push(this.style(fit(this.notice, inner), "warning"));
    return this.marginLines(lines, width);
  }
}
