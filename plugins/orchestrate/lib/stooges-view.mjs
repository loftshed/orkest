import path from "node:path";

import { renderLine, timeLeft } from "../../monitor/lib/render.mjs";
import { coalesceMessages, resolveMemberWorktree } from "./stooges-room.mjs";
import {
  displayWidth,
  fit,
  fitStyled,
  frame,
  glyphSet,
  glyphTier,
  plain,
  progressBar,
  SPINNER,
  tone,
  wrapText,
} from "./tui-box.mjs";

export {
  ANSI,
  cellWidth,
  displayWidth,
  fit,
  fitStyled,
  frame,
  GLYPHS,
  glyphSet,
  glyphTier,
  plain,
  progressBar,
  renderPanel,
  renderTable,
  SPINNER,
  tone,
  wrapText,
} from "./tui-box.mjs";

const ACTIVE_STATUSES = new Set(["running", "working", "planning", "testing", "review"]);
const COMPLETED_STATUSES = new Set(["completed", "reported complete"]);
const COMPLETED_MODES = ["collapsed", "hidden", "expanded"];
const ERROR_STATUSES = new Set(["blocked", "failed", "rejected", "session unavailable"]);
const STAGE_STEPS = {
  planning: "1/4",
  running: "2/4",
  working: "2/4",
  testing: "3/4",
  review: "4/4",
};

function progressSuffix(member, now) {
  if (!member || member.paused) return "";
  const parts = [];
  const step = STAGE_STEPS[member.status];
  if (step) parts.push(`step ${step}`);
  if (ACTIVE_STATUSES.has(member.status)) {
    const timestamps = [
      member?.progress?.reportedAt,
      member?.progress?.lastSeenAt,
      member?.observedAt,
    ]
      .map((val) => (val ? Date.parse(val) : NaN))
      .filter((ms) => Number.isFinite(ms) && ms > 0);
    const stamp = timestamps.length > 0 ? Math.max(...timestamps) : NaN;
    if (Number.isFinite(stamp) && now >= stamp) {
      const ageSec = Math.floor((now - stamp) / 1000);
      if (ageSec <= 45) parts.push("live");
      else if (ageSec < 300) parts.push(`${Math.max(1, Math.floor(ageSec / 60))}m ago`);
      else if (ageSec < 3600) parts.push(`quiet ${Math.floor(ageSec / 60)}m`);
      else parts.push(`quiet ${Math.floor(ageSec / 3600)}h`);
    }
  }
  return parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
}

function swarmActivityBadge(room, maxAgents, tier, innerWidth = 80) {
  const agents = room?.agents || [];
  const base = `${agents.length}/${maxAgents} slots`;
  if (agents.length === 0 || innerWidth < 64) return base;
  const activeCount = agents.filter((a) => ACTIVE_STATUSES.has(a.status)).length;
  const doneCount = agents.filter((a) => COMPLETED_STATUSES.has(a.status)).length;
  const blockedCount = agents.filter((a) => ERROR_STATUSES.has(a.status)).length;
  const check = glyphSet(tier).completed;
  const parts = [];
  if (activeCount > 0) parts.push(`${activeCount} active`);
  if (blockedCount > 0) parts.push(`${blockedCount} blocked`);
  if (doneCount > 0) parts.push(`${doneCount}${check}`);
  return parts.length > 0 ? `${parts.join(" · ")} · ${base}` : base;
}

function toneForStatus(status) {
  if (COMPLETED_STATUSES.has(status)) return "green";
  if (ACTIVE_STATUSES.has(status)) return "cyan";
  if (ERROR_STATUSES.has(status)) return "red";
  if (status === "queued" || status === "reserved") return "yellow";
  return "dim";
}

function statusGlyph(agent, now, tier) {
  const glyphs = glyphSet(tier);
  const isActive = ACTIVE_STATUSES.has(agent.status);
  if (isActive && tier === "unicode") return SPINNER[Math.floor(now / 200) % SPINNER.length];
  if (isActive) return glyphs.running;
  if (ERROR_STATUSES.has(agent.status)) return glyphs.blocked;
  if (agent.status === "completed" || agent.status === "reported complete") return glyphs.completed;
  return glyphs.idle;
}

function formatCreditSuffix(account) {
  const credits = account?.credits;
  if (!credits) return "";
  if (credits.unlimited) return " · unlimited cr";
  if (credits.hasCredits && Number.isFinite(credits.balance) && credits.balance > 0) {
    return ` · ${Math.round(credits.balance).toLocaleString("en-US")} cr`;
  }
  return "";
}

function compactWindowLabel(rawLabel) {
  const text = plain(rawLabel || "quota").trim();
  return text
    .replaceAll(/\bClaude\s*&\s*GPT\b/giu, "Claude/GPT")
    .replaceAll(/\b5-hour\b/giu, "5h")
    .replaceAll(/\bweekly\b/giu, "wk")
    .replaceAll(/\s+/gu, " ")
    .trim();
}

function isLongQuotaWindow(w, totalWindows = 2) {
  if (!w || !Number.isFinite(w.resetsAt)) return false;
  if (totalWindows === 1) return true;
  if (w.kind === "weekly" || (Number.isFinite(w.windowMins) && w.windowMins >= 1440)) return true;
  if (/\b5-?h/iu.test(w.label || w.id || "")) return false;
  return /\b(?:wk|week|daily|day|month)/iu.test(w.label || w.id || "");
}

function formatWindowResetItem(w, totalWindows = 2, now = Date.now()) {
  if (!isLongQuotaWindow(w, totalWindows)) return "";
  const date = new Date(w.resetsAt);
  if (Number.isNaN(date.getTime())) return "";
  const day = date.toLocaleDateString("en-US", { weekday: "short" }) || "";
  if (!day) return "";
  const left = timeLeft(w.resetsAt, now);
  if (!left || left === "now") return `now (${day})`;
  return `in ${left} (${day})`;
}

function formatGroupResetSuffix(windows, now = Date.now()) {
  const items = [];
  const list = windows || [];
  for (const w of list) {
    if (!Number.isFinite(w?.remainingPct)) continue;
    const item = formatWindowResetItem(w, list.length, now);
    if (item && !items.includes(item)) items.push(item);
  }
  return items.length > 0 ? ` · resets ${items.join(" / ")}` : "";
}

function summarizeAccountWindows(windows) {
  return windows
    .map((w) => {
      const label = compactWindowLabel(w.label || w.id || "quota");
      const pct = Number.isFinite(w.remainingPct)
        ? `${Math.round(Math.max(0, Math.min(100, w.remainingPct)))}%`
        : "unavailable";
      return `${label} ${pct}`;
    })
    .join(" · ");
}

function summarizePoolWindows(group) {
  const firstLabel = compactWindowLabel(group[0]?.label || group[0]?.id);
  const prefix = firstLabel.replace(/\s+(?:5h|wk)$/iu, "").trim();
  const metrics = group
    .map((w) => {
      const pct = Number.isFinite(w.remainingPct)
        ? `${Math.round(Math.max(0, Math.min(100, w.remainingPct)))}%`
        : "?";
      const kind = /\b5-?h/iu.test(w.label || w.id || "") ? "5h" : "wk";
      return `${kind} ${pct}`;
    })
    .join(" · ");
  return prefix ? `${prefix} · ${metrics}` : metrics;
}

function quotaRows(accounts, width, tier, color, now = Date.now()) {
  const rows = [];
  const accountList = accounts || [];
  for (const account of accountList) {
    const windows = Array.isArray(account.windows) ? account.windows : [];
    const short = plain(account.short || account.id || "?");
    const creditSuffix = formatCreditSuffix(account);
    const refNow =
      Number.isFinite(account.fetchedAt) && now < 1_000_000_000_000 ? account.fetchedAt : now;
    if (windows.length === 0) {
      rows.push(plain(`${short} ${renderLine([account]) || "quota unavailable"}${creditSuffix}`));
      continue;
    }
    if (windows.length === 1 && accountList.length === 1) {
      const [window] = windows;
      const pct = Number.isFinite(window.remainingPct)
        ? Math.max(0, Math.min(100, window.remainingPct))
        : undefined;
      const label = plain(`${short} ${window.label || window.id || "quota"}`);
      const resetSuffix = pct === undefined ? "" : formatGroupResetSuffix(windows, refNow);
      const suffix =
        pct === undefined ? "unavailable" : `${Math.round(pct)}% left${creditSuffix}${resetSuffix}`;
      const barWidth = Math.max(
        3,
        Math.min(14, width - displayWidth(label) - displayWidth(suffix) - 2),
      );
      rows.push(
        pct === undefined
          ? `${label} ${suffix}`
          : `${label} ${tone(progressBar(pct / 100, barWidth, tier), pct <= 10 ? "red" : "green", color)} ${suffix}`,
      );
      continue;
    }
    const hasPools = windows.some((w) => typeof w.pool === "string" && w.pool.trim());
    if (hasPools) {
      const poolGroups = new Map();
      for (const w of windows) {
        const poolKey = plain(w.pool || "default").trim();
        if (!poolGroups.has(poolKey)) poolGroups.set(poolKey, []);
        poolGroups.get(poolKey).push(w);
      }
      for (const [, group] of poolGroups) {
        const measured = group.filter((w) => Number.isFinite(w.remainingPct));
        const minPct =
          measured.length > 0 ? Math.min(100, ...measured.map((w) => w.remainingPct)) : undefined;
        const pct = minPct === undefined ? undefined : Math.max(0, minPct);
        const resetSuffix = formatGroupResetSuffix(group, refNow);
        const summary = `${summarizePoolWindows(group)}${creditSuffix}${resetSuffix}`;
        const barWidth = Math.max(
          4,
          Math.min(10, width - displayWidth(short) - displayWidth(summary) - 2),
        );
        rows.push(
          pct === undefined
            ? `${short} ${summary}`
            : `${short} ${tone(progressBar(pct / 100, barWidth, tier), pct <= 10 ? "red" : "green", color)} ${summary}`,
        );
      }
      continue;
    }
    const primaryCandidates = windows.filter((w) => !w.scope && Number.isFinite(w.remainingPct));
    const measured =
      primaryCandidates.length > 0
        ? primaryCandidates
        : windows.filter((w) => Number.isFinite(w.remainingPct));
    const minPct =
      measured.length > 0 ? Math.min(100, ...measured.map((w) => w.remainingPct)) : undefined;
    const pct = minPct === undefined ? undefined : Math.max(0, minPct);
    const resetSuffix = formatGroupResetSuffix(windows, refNow);
    const summary =
      windows.length === 1
        ? `${plain(windows[0].label || windows[0].id || "quota")} ${pct === undefined ? "unavailable" : `${Math.round(pct)}% left`}${creditSuffix}${resetSuffix}`
        : `${summarizeAccountWindows(windows)}${creditSuffix}${resetSuffix}`;
    const barWidth = Math.max(
      4,
      Math.min(10, width - displayWidth(short) - displayWidth(summary) - 2),
    );
    rows.push(
      pct === undefined
        ? `${short} ${summary}`
        : `${short} ${tone(progressBar(pct / 100, barWidth, tier), pct <= 10 ? "red" : "green", color)} ${summary}`,
    );
  }
  return rows.length > 0 ? rows : ["Quota unavailable"];
}

function memberWorktree(member, room) {
  if (member && Object.hasOwn(member, "_cachedWorktree")) return member._cachedWorktree;
  return resolveMemberWorktree(member, room?.cwd);
}

export function agentFolder(member, room) {
  const worktree = memberWorktree(member, room);
  if (worktree?.disposable === true) {
    const parentFolder = worktree.parentCwd || room?.cwd;
    if (parentFolder) return plain(parentFolder);
  }
  return plain(
    member?.progress?.cwd ||
      member?.cwd ||
      member?.session?.cwd ||
      worktree?.path ||
      room?.cwd ||
      "",
  );
}

function shortFolder(folderPath) {
  const cleaned = plain(folderPath).trim();
  if (!cleaned) return "workspace";
  return path.basename(cleaned) || cleaned;
}

export function worktreeBadge(member, room) {
  const worktree = memberWorktree(member, room);
  if (worktree?.disposable !== true) return "";
  const target =
    worktree.slug || worktree.path || member?.progress?.cwd || member?.cwd || member?.session?.cwd;
  return `wt:${shortFolder(target)}`;
}

function toAsciiTree(text, tier) {
  if (tier !== "ascii") return text;
  return text.replaceAll("└", "`").replaceAll("├", "+").replaceAll("─", "-").replaceAll("│", "|");
}

function folderTreeRails(entries, tier, columns = 1) {
  const inGroup = new Set(entries.map(({ agent }) => agent.id));
  const groupParent = (agent) =>
    agent.parent && agent.parent !== "conductor" && inGroup.has(agent.parent)
      ? agent.parent
      : "conductor";
  const isLastSibling = (agent) => {
    const parent = groupParent(agent);
    for (let index = entries.length - 1; index >= 0; index--) {
      if (groupParent(entries[index].agent) === parent) return entries[index].agent.id === agent.id;
    }
    return true;
  };
  return entries.map(({ agent }, entryIndex) => {
    const ancestors = [];
    let cursor = groupParent(agent);
    while (cursor !== "conductor") {
      const parentEntry = entries.find((item) => item.agent.id === cursor);
      if (!parentEntry) break;
      ancestors.unshift(parentEntry.agent);
      cursor = groupParent(parentEntry.agent);
    }
    let indent = ancestors
      .map((ancestor) => (isLastSibling(ancestor) ? " ".repeat(3) : "│  "))
      .join("");
    if (agent.parent && agent.parent !== "conductor" && !inGroup.has(agent.parent)) {
      indent += " ".repeat(3);
    }
    const isBottomOfColumn = columns > 1 && entryIndex + columns >= entries.length;
    const isLast = isLastSibling(agent);
    const hasRailBelow = !isLast && !isBottomOfColumn;
    return {
      topPrefix: toAsciiTree(`${indent}│ `, tier),
      midPrefix: toAsciiTree(`${indent}${isLast ? "└─" : "├─"}`, tier),
      tailPrefix: toAsciiTree(`${indent}${hasRailBelow ? "│ " : "  "}`, tier),
    };
  });
}

function joinCardGrid(cards, columns, cardWidth, gap = "  ") {
  if (columns <= 1 || cards.length <= 1) return cards.flat();
  const rows = [];
  for (let index = 0; index < cards.length; index += columns) {
    const pair = cards.slice(index, index + columns);
    if (pair.length === 1) {
      rows.push(...pair[0]);
      continue;
    }
    const height = Math.max(...pair.map((card) => card.length));
    for (let lineIndex = 0; lineIndex < height; lineIndex++) {
      const left = fitStyled(pair[0][lineIndex] || "", cardWidth);
      const right = fitStyled(pair[1][lineIndex] || "", cardWidth);
      rows.push(`${left}${gap}${right}`);
    }
  }
  return rows;
}

function treeRoom(room) {
  const swarm = room.swarm || { maxAgents: 64, maxDepth: 8 };
  const treeAgents = [];
  const visited = new Set();
  const visit = (parent) => {
    const children = room.agents.filter((agent) => (agent.parent || "conductor") === parent);
    for (const agent of children) {
      if (visited.has(agent.id)) continue;
      visited.add(agent.id);
      const worktree = resolveMemberWorktree(agent, room?.cwd);
      treeAgents.push({
        ...agent,
        _cachedWorktree: worktree,
        ...(worktree && { worktree }),
      });
      visit(agent.id);
    }
  };
  visit("conductor");
  for (const agent of room.agents) {
    if (visited.has(agent.id)) continue;
    visited.add(agent.id);
    const worktree = resolveMemberWorktree(agent, room?.cwd);
    treeAgents.push({
      ...agent,
      _cachedWorktree: worktree,
      ...(worktree && { worktree }),
    });
  }
  const groups = new Map();
  for (const agent of treeAgents) {
    const folder = agentFolder(agent, room);
    if (!groups.has(folder)) groups.set(folder, []);
    groups.get(folder).push(agent);
  }
  const agents = groups.values().toArray().flat();
  const conductor = room.conductor
    ? { ...room.conductor, _cachedWorktree: resolveMemberWorktree(room.conductor, room?.cwd) }
    : room.conductor;
  return { ...room, swarm, conductor, agents };
}

/** pi-tui compatible component: render(width): string[], handleInput(data), invalidate(). */
export class StoogesView {
  constructor(
    room,
    {
      now = Date.now,
      height = 32,
      color = false,
      tier = glyphTier(),
      completedMode = "collapsed",
    } = {},
  ) {
    this.room = treeRoom(room);
    this.now = now;
    this.height = height;
    this.color = color;
    this.tier = tier;
    this.completedMode = COMPLETED_MODES.includes(completedMode) ? completedMode : "collapsed";
    this.focusId = this.room.agents[0]?.id;
    this.pinnedId = undefined;
    this.page = 0;
    this.overlay = undefined;
    this.logOffset = 0;
  }

  quotaRowLimit() {
    if (!this.room.accounts?.length && !this.room.quotaError) return 0;
    let rowCount = 0;
    const accounts = this.room.accounts || [];
    for (const account of accounts) {
      const windows = Array.isArray(account?.windows) ? account.windows : [];
      const pools = new Set(
        windows.map((w) => (typeof w?.pool === "string" ? w.pool.trim() : "")).filter(Boolean),
      );
      rowCount += Math.max(1, pools.size);
    }
    const total = Math.max(1, rowCount);
    return this.height < 20 ? Math.min(2, total) : Math.min(8, Math.max(2, total));
  }

  pageSizeFor() {
    const extraQuotaRows = Math.max(0, this.quotaRowLimit() - 2);
    const base = Math.min(9, Math.max(2, Math.floor((this.height - 10 - extraQuotaRows) / 4) * 2));
    if (this.completedMode === "expanded" || this.height < 24) return base;
    const completedCount = (this.room?.agents || []).filter((agent) =>
      COMPLETED_STATUSES.has(agent.status),
    ).length;
    if (completedCount <= 1) return base;
    return Math.min(16, Math.max(base, base + completedCount - 1));
  }

  get pageSize() {
    return this.pageSizeFor();
  }

  get needsAnimation() {
    return (
      this.tier === "unicode" && this.room.agents.some((agent) => ACTIVE_STATUSES.has(agent.status))
    );
  }

  setRoom(room) {
    this.room = treeRoom(room);
    if (this.room.agents.every((agent) => agent.id !== this.focusId))
      this.focusId = this.room.agents[0]?.id;
    if (this.room.agents.every((agent) => agent.id !== this.pinnedId)) this.pinnedId = undefined;
    this.page = Math.min(
      this.page,
      Math.max(0, Math.ceil(this.room.agents.length / this.pageSize) - 1),
    );
  }

  marginLines(lines, width) {
    const margin = Math.min(1, Math.floor((Math.max(1, width) - 1) / 2));
    const contentWidth = Math.max(1, width - margin * 2);
    return lines
      .slice(0, Math.max(0, this.height))
      .map((line) => `${" ".repeat(margin)}${fitStyled(line, contentWidth)}`);
  }

  invalidate() {
    /* Projection reads the latest room and clock on each render. */
  }

  handleInput(key) {
    if (this.overlay) {
      switch (key) {
        case "\u{1B}":
        case "\u{1B}[O": {
          this.overlay = undefined;
          break;
        }
        case "?":
        case "g": {
          this.overlay = key === "?" ? "help" : "logs";
          break;
        }
        case "\u{1B}[B":
        case "n": {
          this.logOffset++;
          break;
        }
        case "\u{1B}[A":
        case "p": {
          this.logOffset = Math.max(0, this.logOffset - 1);
          break;
        }
        // No default
      }
      return;
    }
    if (key === "?") {
      this.overlay = "help";
      return;
    }
    if (key === "g") {
      this.overlay = "logs";
      this.logOffset = 0;
      return;
    }
    if (/^[1-9]$/u.test(key)) {
      const selected = Number(key) - 1;
      const agent = this.room.agents[this.page * this.pageSize + selected];
      if (agent) this.focusId = agent.id;
    } else
      switch (key) {
        case "c": {
          const nextIndex =
            (COMPLETED_MODES.indexOf(this.completedMode) + 1) % COMPLETED_MODES.length;
          this.completedMode = COMPLETED_MODES[nextIndex];
          this.page = Math.min(
            this.page,
            Math.max(0, Math.ceil(this.room.agents.length / this.pageSize) - 1),
          );
          break;
        }
        case "p": {
          this.pinnedId = this.pinnedId === this.focusId ? undefined : this.focusId;
          break;
        }
        case "n": {
          this.page =
            (this.page + 1) % Math.max(1, Math.ceil(this.room.agents.length / this.pageSize));
          break;
        }
        case "\u{1B}[B":
        case "\u{1B}[A": {
          if (this.room.agents.length === 0) break;
          const agents = this.room.agents;
          const direction = key.endsWith("B") ? 1 : -1;
          const current = agents.findIndex((agent) => agent.id === this.focusId);
          const index = (current + direction + agents.length) % agents.length;
          this.focusId = agents[index].id;
          this.page = Math.floor(index / this.pageSize);
          break;
        }
        // No default
      }
  }

  panel(title, body, width, right = "", headerTone) {
    return frame(title, body, width, {
      glyphs: glyphSet(this.tier),
      color: this.color,
      right,
      headerTone,
    });
  }

  overlayLines(width) {
    const title = this.overlay === "help" ? "Key reference" : "Room log";
    const messages = coalesceMessages(this.room.messages).map(
      (message) =>
        `${plain(message.from)}: ${plain(message.text)}${message.count > 1 ? ` (×${message.count})` : ""}`,
    );
    let rows;
    if (this.overlay === "help") {
      rows = [
        "↑/↓ or 1–9  Select agent",
        "c           Cycle completed agents (collapse / hide / expand)",
        "n           Next page",
        "p           Pin or unpin focused output",
        "g           Open coalesced room log",
        "? or Esc    Close this reference",
        "q or Ctrl-C Quit the display; workers continue",
        "Glyphs      Set ORK_GLYPHS=ascii|unicode|nerd",
        "Nerd tier   Requires a Nerd Font; selected explicitly",
      ];
    } else {
      rows = messages.length > 0 ? messages : ["No room messages yet"];
    }
    const interior = Math.max(1, width - 6);
    const wrapped = rows.flatMap((line) => wrapText(line, interior));
    if (this.overlay === "logs") {
      const count = Math.max(1, this.height - 7);
      const start = Math.max(0, Math.min(this.logOffset, wrapped.length - count));
      const visible = wrapped.slice(start, start + count);
      return this.panel(title, visible, width, "Esc close");
    }
    return this.panel(title, wrapped.slice(0, Math.max(1, this.height - 6)), width, "Esc close");
  }

  quotaLines(width) {
    if (this.room.quotaError) return [`Quota unavailable: ${plain(this.room.quotaError)}`];
    const accounts = this.room.accounts || [];
    return quotaRows(accounts, Math.max(10, width - 4), this.tier, this.color, this.now());
  }

  folderHeaderLine(folder, count, innerWidth) {
    const countLabel = `${count} ${count === 1 ? "agent" : "agents"}`;
    const folderLabel = folder
      ? `${shortFolder(folder)} · ${countLabel} · ${folder}`
      : `workspace · ${countLabel}`;
    const rail = toAsciiTree("│ ", this.tier);
    const bannerWidth = Math.max(1, innerWidth - displayWidth(rail));
    return `${tone(rail, "cyan", this.color)}${tone(fit(folderLabel, bannerWidth), "folderHeader", this.color)}`;
  }

  render(width) {
    width = Math.max(1, Math.floor(width) || 80);
    if (this.overlay) return this.marginLines(this.overlayLines(Math.max(1, width - 2)), width);
    if (this.height < 8)
      return this.marginLines(
        this.panel("ork", ["Resize terminal to at least 8 rows"], width),
        width,
      );

    const now = this.now();
    const room = this.room;
    const lead = room.conductor || {};
    const size = this.pageSizeFor();
    const pages = Math.max(1, Math.ceil(room.agents.length / size));
    this.page = Math.min(this.page, pages - 1);
    const selected = room.agents.slice(this.page * size, (this.page + 1) * size);
    const phase = (member) => (member.paused ? "new launches paused" : member.status || "unknown");
    const roleOf = (member) => plain(member?.progress?.role || member?.workforceRole || "").trim();
    const model = (member) => {
      const data = member.progress || member;
      const modelName = member.resolvedModel || data.model || member.engine || "default model";
      const effort = member.resolvedEffort || data.effort;
      return `${modelName}${effort && effort !== "—" ? ` / ${effort}` : ""}`;
    };
    const innerWidth = Math.max(1, width - 2);
    const leadFolder = agentFolder(lead, room);
    const leadRole = roleOf(lead);
    const leadRoleBadge = leadRole ? ` [${leadRole}]` : "";
    const leadLines = [
      `${plain(lead.name || "Coordinator")}${leadRoleBadge} · folder: ${shortFolder(leadFolder)}`,
      `${statusGlyph(lead, now, this.tier)} ${model(lead)} | ${phase(lead)}${progressSuffix(lead, now)}`,
      plain(lead.progress?.task || room.objective || "Tell the coordinator what you want done"),
    ];
    const maxAgents = room.swarm?.maxAgents ?? 64;
    const lines = [
      ...this.panel(
        `Swarm · ${plain(room.title || room.id)}`,
        leadLines,
        innerWidth,
        swarmActivityBadge(room, maxAgents, this.tier, innerWidth),
        "headerBg",
      ),
    ];
    if (room.accounts?.length || room.quotaError) {
      const quotaLimit = this.quotaRowLimit();
      lines.push(
        ...this.panel("Quota", this.quotaLines(innerWidth).slice(0, quotaLimit), innerWidth),
      );
    }
    if (room.agents.length === 0) {
      lines.push("The coordinator will add agents as work is assigned.");
    } else {
      const parentIds = new Set(
        room.agents.map((agent) => agent.parent).filter((p) => p && p !== "conductor"),
      );
      const isCollapsibleCompleted = (agent) =>
        COMPLETED_STATUSES.has(agent.status) &&
        agent.id !== this.focusId &&
        agent.id !== this.pinnedId &&
        !parentIds.has(agent.id);
      const folderGroups = new Map();
      for (const [offset, agent] of selected.entries()) {
        const folder = agentFolder(agent, room);
        if (!folderGroups.has(folder)) folderGroups.set(folder, []);
        folderGroups.get(folder).push({ agent, index: offset });
      }
      const gap = "  ";
      for (const [folder, rawEntries] of folderGroups) {
        lines.push(this.folderHeaderLine(folder, rawEntries.length, innerWidth));
        const hiddenCompletedCount =
          this.completedMode === "hidden"
            ? rawEntries.filter(({ agent }) => isCollapsibleCompleted(agent)).length
            : 0;
        const entries =
          this.completedMode === "hidden"
            ? rawEntries.filter(({ agent }) => !isCollapsibleCompleted(agent))
            : rawEntries;
        const hasCollapsedRows =
          this.completedMode === "collapsed" &&
          entries.some(({ agent }) => isCollapsibleCompleted(agent));
        const columns = !hasCollapsedRows && innerWidth >= 100 && entries.length > 1 ? 2 : 1;
        const cardWidth =
          columns === 2 ? Math.max(24, Math.floor((innerWidth - gap.length) / 2)) : innerWidth;
        const rails = folderTreeRails(entries, this.tier, columns);
        const cards = entries.map(({ agent, index }, entryIndex) => {
          const { topPrefix, midPrefix, tailPrefix } = rails[entryIndex];
          const prefix =
            hiddenCompletedCount > 0 && entryIndex === entries.length - 1
              ? toAsciiTree(midPrefix.replace("└─", "├─"), this.tier)
              : midPrefix;
          const prefixWidth = displayWidth(prefix);
          const boxWidth = Math.max(4, cardWidth - prefixWidth);
          const wfRole = roleOf(agent);
          const roleBadge = wfRole ? ` [${wfRole}]` : "";
          const isFocused = agent.id === this.focusId;
          const isPinned = agent.id === this.pinnedId;
          const locationBadge = worktreeBadge(agent, room) || shortFolder(folder);
          const taskText = plain(agent.progress?.task || agent.objective || "Awaiting assignment");
          if (this.completedMode === "collapsed" && isCollapsibleCompleted(agent)) {
            const glyph = statusGlyph(agent, now, this.tier);
            const titlePart = ` ${glyph} ${index + 1} ${plain(agent.name || agent.id)}${roleBadge} · ${locationBadge} · `;
            const taskPart = fit(taskText, Math.max(1, boxWidth - displayWidth(titlePart)));
            const compactRow = `${tone(titlePart, "green", this.color)}${tone(taskPart, "dim", this.color)}`;
            return [`${tone(prefix, "cyan", this.color)}${fitStyled(compactRow, boxWidth)}`];
          }
          let stateBadge = "";
          if (isPinned) stateBadge = "PIN ";
          else if (isFocused) stateBadge = "FOCUS ";
          const parentBadge =
            agent.parent && agent.parent !== "conductor" ? ` ↳ ${plain(agent.parent)}` : "";
          const cardTitle = `${index + 1} ${plain(agent.name || agent.id)}${agent.role === "lead" ? " (lead)" : ""}`;
          const cardRight = `${stateBadge}${locationBadge}${parentBadge}`;
          const statusLine = tone(
            `${statusGlyph(agent, now, this.tier)}${roleBadge} ${model(agent)} | ${phase(agent)}${progressSuffix(agent, now)}`,
            `${toneForStatus(agent.status)}${isFocused ? " bold" : ""}`,
            this.color,
          );
          const box = frame(cardTitle, [taskText, statusLine], boxWidth, {
            glyphs: glyphSet(this.tier),
            color: this.color,
            right: cardRight,
            headerTone: "headerBg",
          });
          const midIndex = Math.max(1, Math.floor((box.length - 1) / 2));
          return box.map((line, lineIndex) => {
            let linePrefix = tailPrefix;
            if (lineIndex < midIndex) linePrefix = topPrefix;
            else if (lineIndex === midIndex) linePrefix = prefix;
            return `${tone(linePrefix, "cyan", this.color)}${line}`;
          });
        });
        lines.push(...joinCardGrid(cards, columns, cardWidth, gap));
        if (hiddenCompletedCount === 0) continue;
        const summaryPrefix = toAsciiTree("└─", this.tier);
        const glyph = glyphSet(this.tier).completed;
        const summaryText = ` ${glyph} ${hiddenCompletedCount} completed hidden (press c to expand)`;
        const summaryWidth = Math.max(1, innerWidth - displayWidth(summaryPrefix));
        const fittedSummary = fit(summaryText, summaryWidth);
        lines.push(
          `${tone(summaryPrefix, "cyan", this.color)}${tone(fittedSummary, "dim", this.color)}`,
        );
      }
    }
    const focused = room.agents.find((agent) => agent.id === (this.pinnedId || this.focusId));
    const rawDetail = focused?.output?.at(-1);
    const detail = rawDetail ? plain(rawDetail) : "";
    const focusedTask = focused ? plain(focused.progress?.task || focused.objective || "") : "";
    if (detail && (this.pinnedId || detail !== focusedTask) && lines.length < this.height - 4) {
      const tag = this.pinnedId ? "pinned" : "detail";
      const prefix = `${tag} (${plain(focused.name || focused.id)}): `;
      const detailBudget = Math.max(1, innerWidth - displayWidth(prefix));
      lines.push(`${tone(prefix, "dim", this.color)}${fit(detail, detailBudget)}`);
    }
    while (lines.length < this.height - 3) lines.push("");
    lines.push(
      `${room.agents.length}/${maxAgents} slots · page ${this.page + 1}/${pages}`,
      "↑↓ select · c completed · n page · ? help · q close view",
      "Ctrl-b Tab: switch pane · Ctrl-b d: detach",
    );
    return this.marginLines(lines, width);
  }
}

export { StoogesView as HordeView };
