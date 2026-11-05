/**
 * @module horde-view
 *
 * Horde View (`ork horde`): Unified live terminal card-tree TUI (`HordeView`)
 * rendering the coordinator summary card, subscription quota strip, folder
 * banners with continuous vertical tree rails, and multi-column agent cards
 * with disposable worktree badges (`wt:<slug>`).
 */
import path from "node:path";

import { renderLine, timeLeft } from "../../monitor/lib/render.mjs";
import { coalesceMessages, resolveMemberWorktree } from "./horde-room.mjs";
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
import { sectionHeading, statusRow, treeCard } from "./tui-components.mjs";
import { resolveTheme } from "./tui-theme.mjs";

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
const QUOTA_MODES = new Set(["expanded", "collapsed"]);
const SERVICES_MODES = new Set(["expanded", "collapsed"]);
const ERROR_STATUSES = new Set(["blocked", "failed", "rejected", "session unavailable"]);
const STAGE_STEPS = {
  planning: "1/4",
  running: "2/4",
  working: "2/4",
  testing: "3/4",
  review: "4/4",
};
const SLOT_ID_PATTERN = /^[a-z0-9.]+-\d+$/iu;
const SESSION_TAG_PATTERN = /^[0-9a-f]{2}$/iu;
const EFFORT_LEVELS = new Set(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
const TRAILING_EFFORT_PATTERN = /^(.*\S)(?:\s*\(([a-z]+)\)|\s*\[([a-z]+)\]|-([a-z]+))$/iu;

function isExecuting(member) {
  if (member.runtimeState) return member.runtimeState === "running";
  if (member.dispatch && member.status === "review") return false;
  return ACTIVE_STATUSES.has(member.status);
}

function isInactive(member) {
  if (ERROR_STATUSES.has(member.status) && member.status !== "session unavailable") return false;
  return (
    !isExecuting(member) &&
    (COMPLETED_STATUSES.has(member.status) ||
      ["idle", "session unavailable"].includes(member.status) ||
      ["idle", "stopped"].includes(member.runtimeState) ||
      (member.dispatch && member.status === "review"))
  );
}

function phaseLabel(member) {
  if (member.paused) return "new launches paused";
  if (member.dispatch && member.status === "review" && !isExecuting(member))
    return "awaiting review";
  if (member.runtimeState === "idle" && ACTIVE_STATUSES.has(member.status))
    return `idle · last reported ${member.status}`;
  return member.status || "unknown";
}

export function shortAgentName(member) {
  if (!member) return "";
  const person = plain(member?.progress?.person || member?.person || "").trim();
  const raw = plain(member?.progress?.name || member?.name || member?.id || "").trim();
  if (!raw) return person;
  if (person && (raw === person || raw.startsWith(`${person}-`))) return person;
  if (SLOT_ID_PATTERN.test(raw)) return raw;
  if (raw.includes(":")) return raw.replace(/-[0-9a-f]{2}$/iu, "") || raw;
  const repoSlug = shortFolder(
    member?.progress?.repository || member?.progress?.repo || member?.cwd || "",
  ).toLowerCase();
  if (
    repoSlug &&
    repoSlug !== "workspace" &&
    (raw.toLowerCase() === repoSlug || raw.toLowerCase().startsWith(`${repoSlug}-`))
  ) {
    return raw.replace(/-[0-9a-f]{2}$/iu, "") || raw;
  }
  const parts = raw.split("-").filter(Boolean);
  if (parts.length >= 3 && SESSION_TAG_PATTERN.test(parts.at(-1))) return parts[0];
  return raw;
}

export function normalizeModelAndEffort(modelName, effort) {
  let cleanModel = plain(modelName || "").trim();
  let cleanEffort = plain(effort || "").trim();
  const match = cleanModel.match(TRAILING_EFFORT_PATTERN);
  if (match) {
    const inferred = (match[2] || match[3] || match[4] || "").toLowerCase();
    if (EFFORT_LEVELS.has(inferred)) {
      cleanModel = match[1].trim();
      if (!cleanEffort || cleanEffort === "—") cleanEffort = inferred;
    }
  }
  return { model: cleanModel, effort: cleanEffort };
}

function progressSuffix(member, now) {
  if (!member || member.paused || !isExecuting(member)) return "";
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
  const activeCount = agents.filter(isExecuting).length;
  const doneCount = agents.filter(
    (a) => !isExecuting(a) && COMPLETED_STATUSES.has(a.status),
  ).length;
  const blockedCount = agents.filter((a) => ERROR_STATUSES.has(a.status)).length;
  const check = glyphSet(tier).completed;
  const parts = [];
  if (activeCount > 0) parts.push(`${activeCount} active`);
  if (blockedCount > 0) parts.push(`${blockedCount} blocked`);
  if (doneCount > 0) parts.push(`${doneCount}${check}`);
  return parts.length > 0 ? `${parts.join(" · ")} · ${base}` : base;
}

function toneForStatus(member) {
  const { status } = member;
  if (isExecuting(member)) return "running";
  if (COMPLETED_STATUSES.has(status)) return "success";
  if (status === "review") return "warning";
  if (isInactive(member)) return "muted";
  if (ERROR_STATUSES.has(status)) return "error";
  if (status === "queued" || status === "reserved") return "warning";
  return "muted";
}

function statusGlyph(agent, now, tier) {
  const glyphs = glyphSet(tier);
  const isActive = isExecuting(agent);
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
          : `${label} ${tone(progressBar(pct / 100, barWidth, tier), pct <= 10 ? "error" : "success", color)} ${suffix}`,
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
            : `${short} ${tone(progressBar(pct / 100, barWidth, tier), pct <= 10 ? "error" : "success", color)} ${summary}`,
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
        : `${short} ${tone(progressBar(pct / 100, barWidth, tier), pct <= 10 ? "error" : "success", color)} ${summary}`,
    );
  }
  return rows.length > 0 ? rows : ["Quota unavailable"];
}

function memberWorktree(member, room) {
  if (member && Object.hasOwn(member, "_cachedWorktree")) return member._cachedWorktree;
  return resolveMemberWorktree(member, room?.cwd);
}

export function normalizeAgent(agent, room) {
  if (!agent || typeof agent !== "object") return agent;
  const worktree = resolveMemberWorktree(agent, room?.cwd);
  const herdrPaneId = agent.herdrPaneId || agent.progress?.herdrPaneId;
  const paneId = agent.paneId || agent.progress?.paneId;
  return {
    ...agent,
    _cachedWorktree: worktree,
    ...(worktree && { worktree }),
    ...(herdrPaneId && { herdrPaneId }),
    ...(paneId && { paneId }),
  };
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

function folderTreeRails(entries, tier, columns = 1, hasFollowingSection = false) {
  const inGroup = new Set(entries.map(({ agent }) => agent.id));
  const groupParent = (agent) =>
    agent.parent && agent.parent !== "conductor" && inGroup.has(agent.parent)
      ? agent.parent
      : "conductor";
  const isLastSibling = (agent) => {
    const parent = groupParent(agent);
    if (parent === "conductor" && hasFollowingSection) return false;
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
    const indent = ancestors
      .map((ancestor) => (isLastSibling(ancestor) ? " ".repeat(3) : "│  "))
      .join("");
    const isBottomOfColumn = columns > 1 && entryIndex + columns >= entries.length;
    const isLast = isLastSibling(agent);
    const hasRailBelow = !isLast && (!isBottomOfColumn || hasFollowingSection);
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

function parseAgentTimestampMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function agentOwnTimestampMs(agent) {
  return Math.max(
    parseAgentTimestampMs(agent?.progress?.updatedAt),
    parseAgentTimestampMs(agent?.observedAt),
    parseAgentTimestampMs(agent?.updatedAt),
    parseAgentTimestampMs(agent?.createdAt),
  );
}

function treeRoom(room) {
  const swarm = room.swarm || { maxAgents: 64, maxDepth: 8 };
  const indexById = new Map();
  const recencyById = new Map();
  let monotonicFloorMs = 0;
  for (const [index, agent] of room.agents.entries()) {
    indexById.set(agent.id, index);
    const ownMs = agentOwnTimestampMs(agent);
    if (ownMs > monotonicFloorMs) monotonicFloorMs = ownMs;
    recencyById.set(agent.id, ownMs > 0 ? ownMs : monotonicFloorMs);
  }
  const compareRecentFirst = (left, right) => {
    const timeDiff = (recencyById.get(right.id) || 0) - (recencyById.get(left.id) || 0);
    if (timeDiff !== 0) return timeDiff;
    return (indexById.get(right.id) ?? 0) - (indexById.get(left.id) ?? 0);
  };
  const treeAgents = [];
  const visited = new Set();
  const visit = (parent) => {
    const children = room.agents
      .filter((agent) => (agent.parent || "conductor") === parent)
      .toSorted(compareRecentFirst);
    for (const agent of children) {
      if (visited.has(agent.id)) continue;
      visited.add(agent.id);
      treeAgents.push(normalizeAgent(agent, room));
      visit(agent.id);
    }
  };
  visit("conductor");
  for (const agent of room.agents.toSorted(compareRecentFirst)) {
    if (visited.has(agent.id)) continue;
    visited.add(agent.id);
    treeAgents.push(normalizeAgent(agent, room));
  }
  const groups = new Map();
  for (const agent of treeAgents) {
    const folder = agentFolder(agent, room);
    if (!groups.has(folder)) groups.set(folder, []);
    groups.get(folder).push(agent);
  }
  const agents = groups.values().toArray().flat();
  const conductor = room.conductor ? normalizeAgent(room.conductor, room) : room.conductor;
  return { ...room, swarm, conductor, agents };
}

/** pi-tui compatible component: render(width): string[], handleInput(data), invalidate(). */
export class HordeView {
  constructor(
    room,
    {
      now = Date.now,
      height = 32,
      color = false,
      theme,
      tier = glyphTier(),
      completedMode = "collapsed",
      quotaMode = "expanded",
      servicesMode = "expanded",
      onFocusPane,
    } = {},
  ) {
    this.room = treeRoom(room);
    this.now = now;
    this.height = height;
    this.renderWidth = 80;
    this.color = color;
    this.appearance = { enabled: color, theme: resolveTheme(theme) };
    this.tier = tier;
    this.completedMode = COMPLETED_MODES.includes(completedMode) ? completedMode : "collapsed";
    this.quotaMode = QUOTA_MODES.has(quotaMode) ? quotaMode : "expanded";
    this.servicesMode = SERVICES_MODES.has(servicesMode) ? servicesMode : "expanded";
    this.onFocusPane = typeof onFocusPane === "function" ? onFocusPane : undefined;
    this.lastFocusedAgentId = undefined;
    this.focusId = this.room.agents[0]?.id;
    this.focusFollowsLatest = true;
    this.hasExplicitFocus = false;
    this.pinnedId = undefined;
    this.page = 0;
    this.overlay = undefined;
    this.logOffset = 0;
  }

  quotaRowLimit() {
    if (!this.room.accounts?.length && !this.room.quotaError) return 0;
    if (this.quotaMode === "collapsed") return 1;
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
    const budget = Math.max(2, Math.floor((this.height - 16) / 2));
    return this.height < 20 ? Math.min(2, total) : Math.min(8, budget, Math.max(2, total));
  }

  serviceRowLimit() {
    const services = Array.isArray(this.room.services) ? this.room.services : [];
    if (services.length === 0 || this.height < 14) return 0;
    if (this.servicesMode === "collapsed") return 1;
    return this.height < 22 ? Math.min(1, services.length) : Math.min(3, services.length);
  }

  showUpdateBar() {
    const upd = this.room?.update || this.room?.updateStatus;
    if (!upd || typeof upd !== "object") return false;
    return Boolean(
      upd.available ||
      upd.updateAvailable ||
      ["available", "updating", "updated", "error"].includes(upd.status),
    );
  }

  pageSizeFor() {
    const extraQuotaRows =
      this.quotaMode === "collapsed" ? 0 : Math.max(0, this.quotaRowLimit() - 2);
    const serviceRows = this.serviceRowLimit();
    let servicePanelLines = 0;
    if (serviceRows > 0) {
      servicePanelLines = this.servicesMode === "collapsed" ? 1 : serviceRows + 2;
    }
    const updateBarLines = this.showUpdateBar() ? 1 : 0;
    const base = Math.min(
      9,
      Math.max(
        2,
        Math.floor((this.height - 10 - extraQuotaRows - servicePanelLines - updateBarLines) / 4) *
          2,
      ),
    );
    const folderCount = new Set(this.room.agents.map((agent) => agentFolder(agent, this.room)))
      .size;
    if (folderCount > 1 || this.renderWidth < 100) {
      let quotaLines = 0;
      if (this.room.accounts?.length || this.room.quotaError) {
        quotaLines = this.quotaMode === "collapsed" ? 1 : Math.max(1, this.quotaRowLimit()) + 2;
      }
      const available = this.height - 5 - quotaLines - servicePanelLines - updateBarLines - 3;
      const capacity = Math.max(
        1,
        Math.floor((available - (folderCount > 1 ? 0 : 1)) / (folderCount > 1 ? 5 : 4)),
      );
      return Math.min(base, capacity);
    }
    if (this.completedMode === "expanded" || this.height < 24) return base;
    const completedCount = (this.room?.agents || []).filter(isInactive).length;
    if (completedCount <= 1) return base;
    return Math.min(16, Math.max(base, base + completedCount - 1));
  }

  get pageSize() {
    return this.pageSizeFor();
  }

  get needsAnimation() {
    return this.tier === "unicode" && this.room.agents.some(isExecuting);
  }

  setRoom(room) {
    this.room = treeRoom(room);
    if (
      (this.focusFollowsLatest && !this.pinnedId && this.page === 0) ||
      this.room.agents.every((agent) => agent.id !== this.focusId)
    ) {
      this.focusId = this.room.agents[0]?.id;
      this.hasExplicitFocus = false;
    }
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

  handleKey(key) {
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
      return false;
    }
    if (key === "?") {
      this.overlay = "help";
      return true;
    }
    if (key === "g") {
      this.overlay = "logs";
      this.logOffset = 0;
      return true;
    }
    if (/^[1-9]$/u.test(key)) {
      const selected = Number(key) - 1;
      const agent = this.room.agents[this.page * this.pageSize + selected];
      if (agent) {
        this.focusId = agent.id;
        this.hasExplicitFocus = true;
        this.focusFollowsLatest = false;
        return true;
      }
      return false;
    }
    switch (key) {
      case "o": {
        const selected = this.room.agents.find((agent) => agent.id === this.focusId);
        if (selected && (selected.herdrPaneId || selected.paneId)) {
          this.lastFocusedAgentId = selected.id;
          this.onFocusPane?.(selected);
          return true;
        }
        return false;
      }
      case "c": {
        const nextIndex =
          (COMPLETED_MODES.indexOf(this.completedMode) + 1) % COMPLETED_MODES.length;
        this.completedMode = COMPLETED_MODES[nextIndex];
        this.page = Math.min(
          this.page,
          Math.max(0, Math.ceil(this.room.agents.length / this.pageSize) - 1),
        );
        return true;
      }
      case "u": {
        if (!this.room.accounts?.length && !this.room.quotaError) return false;
        this.quotaMode = this.quotaMode === "collapsed" ? "expanded" : "collapsed";
        this.page = Math.min(
          this.page,
          Math.max(0, Math.ceil(this.room.agents.length / this.pageSize) - 1),
        );
        return true;
      }
      case "U": {
        const upd = this.room?.update || this.room?.updateStatus;
        if (
          upd?.available ||
          upd?.updateAvailable ||
          upd?.status === "available" ||
          upd?.status === "error"
        ) {
          return { type: "pull-update" };
        }
        return false;
      }
      case "v": {
        if (!this.room.services?.length) return false;
        this.servicesMode = this.servicesMode === "collapsed" ? "expanded" : "collapsed";
        this.page = Math.min(
          this.page,
          Math.max(0, Math.ceil(this.room.agents.length / this.pageSize) - 1),
        );
        return { type: "services-toggle", servicesMode: this.servicesMode };
      }
      case "p": {
        this.pinnedId = this.pinnedId === this.focusId ? undefined : this.focusId;
        return true;
      }
      case "n": {
        this.page =
          (this.page + 1) % Math.max(1, Math.ceil(this.room.agents.length / this.pageSize));
        return true;
      }
      case "\u{1B}[B":
      case "\u{1B}[A": {
        if (this.room.agents.length === 0) return false;
        const agents = this.room.agents;
        const direction = key.endsWith("B") ? 1 : -1;
        const current = agents.findIndex((agent) => agent.id === this.focusId);
        const index = (current + direction + agents.length) % agents.length;
        this.focusId = agents[index].id;
        this.hasExplicitFocus = true;
        this.page = Math.floor(index / this.pageSize);
        this.focusFollowsLatest = false;
        return true;
      }
      default: {
        return false;
      }
    }
  }

  handleInput(key) {
    return this.handleKey(key);
  }

  panel(title, body, width, right = "", headerTone, rail = "") {
    const glyphs = { ...glyphSet(this.tier) };
    const junction = this.tier === "ascii" ? "+" : "├";
    if (rail === "middle" || rail === "end") glyphs.topLeft = junction;
    if (rail === "start" || rail === "middle") glyphs.bottomLeft = junction;
    return frame(title, body, width, {
      glyphs,
      color: this.appearance,
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
        "o           Focus selected agent's Herdr or tmux pane",
        "c           Cycle inactive agents (collapse / hide / expand)",
        "u           Expand or collapse quota view",
        "U           Pull available Orkest update",
        "v           Expand or collapse running services view",
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
    return quotaRows(accounts, Math.max(10, width - 4), this.tier, this.appearance, this.now());
  }

  updateLine(innerWidth) {
    const upd = this.room?.update || this.room?.updateStatus || {};
    const labelText = "Update [U]";
    let badgeTone = "yellow bold";
    if (upd.status === "error") badgeTone = "red bold";
    else if (upd.status === "updated") badgeTone = "green bold";
    const badge = tone(labelText, badgeTone, this.appearance);
    const budget = Math.max(1, innerWidth - displayWidth(`${labelText}  `));
    const count =
      Number.isFinite(upd.commitsBehind) && upd.commitsBehind > 0 ? upd.commitsBehind : 1;
    const plural = count === 1 ? "commit" : "commits";
    let text;
    switch (upd.status) {
      case "updating": {
        text = "Pulling update from origin/main...";
        break;
      }
      case "updated": {
        const shortSha =
          plain(upd.toSha || upd.remoteSha || "")
            .trim()
            .slice(0, 7) || "latest";
        text = `✓ Updated to ${shortSha} · hooks & skills refreshed`;
        break;
      }
      case "error": {
        const msg = plain(upd.message || upd.error || "fast-forward failed").trim();
        text = `! Update failed: ${msg} · press U to retry`;
        break;
      }
      default: {
        text = upd.dirty
          ? `↑ ${count} new ${plural} on origin/main (working tree dirty)`
          : `↑ ${count} new ${plural} on origin/main · press U to pull & update`;
        break;
      }
    }
    return `${badge}  ${fit(text, budget)}`;
  }

  inlineQuotaLine(innerWidth) {
    const labelText = "Quota [u]";
    const badge = tone(labelText, "running bold", this.appearance);
    const budget = Math.max(1, innerWidth - displayWidth(`${labelText}  `));
    if (this.room.quotaError) {
      return `${badge}  ${fit(`unavailable: ${plain(this.room.quotaError)}`, budget)}`;
    }
    const accounts = this.room.accounts || [];
    const now = this.now();
    const parts = accounts.map((account) => {
      const short = plain(account.short || account.id || "?");
      const windows = Array.isArray(account.windows) ? account.windows : [];
      const refNow =
        Number.isFinite(account.fetchedAt) && now < 1_000_000_000_000 ? account.fetchedAt : now;
      if (Array.isArray(account.pools) && account.pools.length > 0) {
        const rendered = plain(renderLine([account], refNow)).trim();
        if (rendered) return rendered;
      }
      if (windows.length === 0) return `${short} —`;
      const hasPools = windows.some((w) => typeof w.pool === "string" && w.pool.trim());
      if (hasPools) {
        const poolGroups = new Map();
        for (const w of windows) {
          const poolKey = plain(w.pool || "default").trim();
          if (!poolGroups.has(poolKey)) poolGroups.set(poolKey, []);
          poolGroups.get(poolKey).push(w);
        }
        const poolParts = [];
        for (const [, group] of poolGroups) {
          const firstLabel = compactWindowLabel(group[0]?.label || group[0]?.id);
          const prefix = firstLabel.replace(/\s+(?:5h|wk)$/iu, "").trim();
          const percentages = group
            .filter((w) => Number.isFinite(w.remainingPct))
            .map((w) => `${Math.round(Math.max(0, Math.min(100, w.remainingPct)))}%`)
            .join("/");
          poolParts.push(prefix ? `${prefix} ${percentages || "—"}` : percentages || "—");
        }
        return `${short} ${poolParts.join(" · ")}`;
      }
      const primary = windows.filter((w) => !w.scope && Number.isFinite(w.remainingPct));
      const measured =
        primary.length > 0 ? primary : windows.filter((w) => Number.isFinite(w.remainingPct));
      if (measured.length === 0) return `${short} unavailable`;
      const percentages = measured
        .map((w) => `${Math.round(Math.max(0, Math.min(100, w.remainingPct)))}%`)
        .join("·");
      return `${short} ${percentages}${formatCreditSuffix(account)}`;
    });
    return `${badge}  ${fit(parts.join("  ·  "), budget)}`;
  }

  serviceHeaderBadge() {
    const services = Array.isArray(this.room.services) ? this.room.services : [];
    if (services.length === 0) return "";
    const ports = services
      .map((svc) => (svc?.port ? `:${svc.port}` : plain(svc?.ports || "").trim()))
      .filter(Boolean);
    const portSummary = ports.length > 0 ? ` · ${ports.slice(0, 3).join(" ")}` : "";
    return `${services.length} running${portSummary}`;
  }

  inlineServicesLine(innerWidth) {
    const services = Array.isArray(this.room.services) ? this.room.services : [];
    const labelText = "Services [v]";
    const badge = tone(labelText, "running bold", this.appearance);
    const budget = Math.max(1, innerWidth - displayWidth(`${labelText}  `));
    const items = services.map((svc) => {
      const isDocker = svc?.kind === "docker";
      const endpoint = svc?.port
        ? `:${svc.port}`
        : plain(svc?.ports || svc?.endpoint || (isDocker ? "docker" : "service")).trim();
      const label = isDocker
        ? `docker ${plain(svc?.image || svc?.name || svc?.container || "container").trim()}`
        : plain(svc?.name || svc?.command || "process").trim();
      const folder = plain(svc?.worktree || (svc?.cwd ? shortFolder(svc.cwd) : "")).trim();
      return `${endpoint} ${label}${folder ? ` (${folder})` : ""}`;
    });
    const summary = `${services.length} running${items.length > 0 ? ` · ${items.join(" · ")}` : ""}`;
    return `${badge}  ${fit(summary, budget)}`;
  }

  serviceLines(width) {
    const services = Array.isArray(this.room.services) ? this.room.services : [];
    const rowWidth = Math.max(10, width - 4);
    const glyphs = glyphSet(this.tier);
    return services.map((svc) => {
      const isDocker = svc?.kind === "docker";
      let glyph = glyphs.running;
      if (isDocker) {
        if (this.tier === "ascii") glyph = "*";
        else if (this.tier === "nerd") glyph = "󰡨";
        else glyph = "◆";
      }
      const endpoint = svc?.port
        ? `:${svc.port}`
        : plain(svc?.ports || svc?.endpoint || (isDocker ? "docker" : "service")).trim();
      const label = isDocker
        ? `docker ${plain(svc?.image || svc?.name || svc?.container || "container").trim()}`
        : `${plain(svc?.name || svc?.command || "process").trim()}${svc?.pid ? ` (pid ${svc.pid})` : ""}`;
      const folder = plain(svc?.worktree || (svc?.cwd ? shortFolder(svc.cwd) : "")).trim();
      const owner = svc?.owner ? `by ${plain(svc.owner).trim()}` : "";
      const uptime = svc?.uptime ? `up ${plain(svc.uptime).trim()}` : "";
      const meta = [label, folder, owner, uptime].filter(Boolean).join(" · ");
      const raw = `${glyph} ${endpoint}  ${meta}`;
      return tone(fit(raw, rowWidth), isDocker ? "running" : "success", this.appearance);
    });
  }

  folderHeaderLine(folder, count, innerWidth) {
    return sectionHeading(
      folder ? shortFolder(folder) : "workspace",
      `${count} ${count === 1 ? "agent" : "agents"}`,
      innerWidth,
      {
        prefix: toAsciiTree("│ ", this.tier),
        color: this.appearance,
        tier: this.tier,
      },
    );
  }

  render(width) {
    width = Math.max(1, Math.floor(width) || 80);
    this.renderWidth = width;
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
    const phase = phaseLabel;
    const roleOf = (member) => plain(member?.progress?.role || member?.workforceRole || "").trim();
    const model = (member) => {
      const data = member.progress || member;
      const rawModel =
        member.resolvedModel || data.model || member.model || member.engine || "default model";
      const rawEffort =
        member.resolvedEffort ||
        (data.effort && data.effort !== "—" ? data.effort : "") ||
        member.effort ||
        data.effort;
      const { model: modelName, effort } = normalizeModelAndEffort(rawModel, rawEffort);
      const provenance =
        member.consultation && member.modelSource === "requested" ? " (requested)" : "";
      return `${modelName || "default model"}${provenance}${effort && effort !== "—" ? ` / ${effort}` : ""}`;
    };
    const innerWidth = Math.max(1, width - 2);
    const leadFolder = agentFolder(lead, room);
    const leadRole = roleOf(lead);
    const leadRoleBadge = leadRole ? ` [${leadRole}]` : "";
    const cleanProgressTask = (member) => {
      const t = plain(member?.progress?.task || "").trim();
      return t && t !== "not set" ? t : "";
    };
    const leadTitle =
      lead.name || lead.progress?.name ? `Orchestrator: ${shortAgentName(lead)}` : "Coordinator";
    const leadBranch = plain(
      lead.branch || lead.progress?.branch || lead.worktree?.branch || "",
    ).trim();
    const leadEngine = plain(lead.engine || "").trim();
    const leadPane = plain(
      lead.herdrPaneId || lead.paneId || lead.progress?.herdrPaneId || lead.progress?.paneId || "",
    ).trim();
    const leadLocation =
      room.agents.length === 0 || selected.every((agent) => agentFolder(agent, room) !== leadFolder)
        ? ` · folder: ${shortFolder(leadFolder)}`
        : "";
    const leadMetaParts = [
      `${leadTitle}${leadRoleBadge}${leadLocation}${leadBranch ? ` (${leadBranch})` : ""}`,
      ...(leadEngine ? [leadEngine] : []),
      ...(leadPane ? [leadPane] : []),
    ];
    const leadGoal = plain(lead.progress?.goal || "").trim();
    const leadTask = cleanProgressTask(lead);
    const roomTitlePlain = plain(room.title || "").trim();
    const leadMissionLine =
      leadGoal &&
      leadGoal !== "not set" &&
      leadTask &&
      leadGoal !== leadTask &&
      leadGoal !== roomTitlePlain
        ? `${leadGoal} — ${leadTask}`
        : leadTask || plain(room.objective || "Tell the coordinator what you want done");
    let leadLines = [
      leadMetaParts.join(" · "),
      `${statusGlyph(lead, now, this.tier)} ${model(lead)} | ${phase(lead)}${progressSuffix(lead, now)}`,
      leadMissionLine,
    ];
    if (lead.status === "session unavailable" && room.agents.length > 0) {
      leadLines = ["Coordinator session unavailable"];
      if (room.objective) leadLines.push(plain(room.objective));
    }
    const maxAgents = room.swarm?.maxAgents ?? 64;
    const hasAgentTree = room.agents.length > 0;
    const withRail = (line) =>
      hasAgentTree
        ? `${tone(toAsciiTree("│ ", this.tier), "border", this.appearance)}${line}`
        : line;
    const lines = [
      ...this.panel(
        room.title === "New swarm" ? "Swarm" : `Swarm · ${plain(room.title || room.id)}`,
        leadLines,
        innerWidth,
        swarmActivityBadge(room, maxAgents, this.tier, innerWidth),
        "selected",
        hasAgentTree ? "start" : "",
      ),
    ];
    if (this.showUpdateBar()) {
      lines.push(withRail(this.updateLine(innerWidth - (hasAgentTree ? 2 : 0))));
    }
    if (room.accounts?.length || room.quotaError) {
      if (this.quotaMode === "collapsed") {
        lines.push(withRail(this.inlineQuotaLine(innerWidth - (hasAgentTree ? 2 : 0))));
      } else {
        const quotaLimit = this.quotaRowLimit();
        lines.push(
          ...this.panel(
            "Quota",
            this.quotaLines(innerWidth).slice(0, quotaLimit),
            innerWidth,
            "u collapse",
            undefined,
            hasAgentTree ? "middle" : "",
          ),
        );
      }
    }
    if (room.agents.length === 0) {
      lines.push("The coordinator will add agents as work is assigned.");
    } else {
      const parentIds = new Set(
        room.agents.map((agent) => agent.parent).filter((p) => p && p !== "conductor"),
      );
      const isCollapsibleCompleted = (agent) =>
        isInactive(agent) &&
        (agent.id !== this.focusId || !this.hasExplicitFocus) &&
        agent.id !== this.pinnedId &&
        !parentIds.has(agent.id);
      const folderGroups = new Map();
      for (const [offset, agent] of selected.entries()) {
        const folder = agentFolder(agent, room);
        if (!folderGroups.has(folder)) folderGroups.set(folder, []);
        folderGroups.get(folder).push({ agent, index: offset });
      }
      const gap = "  ";
      const lastFolder = folderGroups.keys().toArray().at(-1);
      const hasServices = this.serviceRowLimit() > 0;
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
        const hasFollowingSection = folder !== lastFolder || hasServices;
        const rails = folderTreeRails(entries, this.tier, columns, hasFollowingSection);
        const cards = entries.map(({ agent, index }, entryIndex) => {
          const { topPrefix, midPrefix, tailPrefix } = rails[entryIndex];
          const prefix =
            hiddenCompletedCount > 0 && entryIndex === entries.length - 1
              ? toAsciiTree(midPrefix.replace("└─", "├─"), this.tier)
              : midPrefix;
          const wfRole = roleOf(agent);
          const roleBadge = wfRole ? ` [${wfRole}]` : "";
          const isFocused = agent.id === this.focusId;
          const isPinned = agent.id === this.pinnedId;
          const locationBadge = worktreeBadge(agent, room);
          const taskText =
            cleanProgressTask(agent) || plain(agent.objective || "Awaiting assignment");
          const rawAgentName = shortAgentName(agent);
          const folderName = shortFolder(folder);
          const displayAgentName =
            rawAgentName === folderName || rawAgentName === `${agent.engine}:${folderName}`
              ? plain(agent.engine || "agent")
              : rawAgentName;
          const parent = room.agents.find((member) => member.id === agent.parent);
          const parentBadge =
            agent.parent && agent.parent !== "conductor"
              ? ` ↳ ${parent ? shortAgentName(parent) : plain(agent.parent)}`
              : "";
          if (this.completedMode === "collapsed" && isCollapsibleCompleted(agent)) {
            const glyph = statusGlyph(agent, now, this.tier);
            const label = ` ${glyph} ${index + 1} ${displayAgentName}${parentBadge}${locationBadge ? ` · ${locationBadge}` : ""}${isFocused ? " · FOCUS " : ""} · ${model(agent)}${agent.consultation ? "" : ` · ${taskText}`}`;
            return [
              statusRow(label, phase(agent), cardWidth, {
                prefix,
                color: this.appearance,
                style: toneForStatus(agent),
                tier: this.tier,
              }),
            ];
          }
          let stateBadge = "";
          if (isPinned) stateBadge = "PIN ";
          else if (isFocused) stateBadge = "FOCUS ";
          const cardTitle = `${index + 1} ${displayAgentName}${agent.role === "lead" ? " (lead)" : ""}`;
          const cardRight = `${stateBadge}${locationBadge}${parentBadge}`;
          const statusLine = tone(
            `${statusGlyph(agent, now, this.tier)}${roleBadge} ${model(agent)} | ${phase(agent)}${progressSuffix(agent, now)}`,
            `${toneForStatus(agent)}${isFocused ? " bold" : ""}`,
            this.appearance,
          );
          return treeCard(cardTitle, [taskText, statusLine], cardWidth, {
            emphasized: isFocused || isPinned,
            topPrefix,
            midPrefix: prefix,
            tailPrefix,
            right: cardRight,
            color: this.appearance,
            tier: this.tier,
          });
        });
        lines.push(...joinCardGrid(cards, columns, cardWidth, gap));
        if (hiddenCompletedCount === 0) continue;
        const summaryPrefix = toAsciiTree(hasFollowingSection ? "├─" : "└─", this.tier);
        const glyph = glyphSet(this.tier).completed;
        const summaryText = ` ${glyph} ${hiddenCompletedCount} inactive hidden (press c to expand)`;
        const summaryWidth = Math.max(1, innerWidth - displayWidth(summaryPrefix));
        const fittedSummary = fit(summaryText, summaryWidth);
        lines.push(
          `${tone(summaryPrefix, "border", this.appearance)}${tone(fittedSummary, "muted", this.appearance)}`,
        );
      }
    }
    const serviceLimit = this.serviceRowLimit();
    if (serviceLimit > 0) {
      if (this.servicesMode === "collapsed") {
        lines.push(withRail(this.inlineServicesLine(innerWidth - (hasAgentTree ? 2 : 0))));
      } else {
        const headerRight = [this.serviceHeaderBadge(), "v collapse"].filter(Boolean).join(" · ");
        lines.push(
          ...this.panel(
            "Services",
            this.serviceLines(innerWidth).slice(0, serviceLimit),
            innerWidth,
            headerRight,
            undefined,
            hasAgentTree ? "end" : "",
          ),
        );
      }
    }
    const focused = room.agents.find((agent) => agent.id === (this.pinnedId || this.focusId));
    const rawDetail = focused?.output?.at(-1);
    const detail = rawDetail ? plain(rawDetail) : "";
    const focusedTask = focused ? plain(focused.progress?.task || focused.objective || "") : "";
    if (detail && (this.pinnedId || detail !== focusedTask) && lines.length < this.height - 4) {
      const tag = this.pinnedId ? "pinned" : "detail";
      const prefix = `${tag} (${shortAgentName(focused)}): `;
      const detailBudget = Math.max(1, innerWidth - displayWidth(prefix));
      lines.push(`${tone(prefix, "muted", this.appearance)}${fit(detail, detailBudget)}`);
    }
    while (lines.length < this.height - 3) lines.push("");
    // Navigation is never sacrificed when content exceeds the terminal's row budget.
    lines.splice(Math.max(0, this.height - 3));
    const selectedAgent = room.agents.find((agent) => agent.id === this.focusId);
    const openHint =
      selectedAgent && (selectedAgent.herdrPaneId || selectedAgent.paneId) ? " · o open" : "";
    const quotaHint = room.accounts?.length || room.quotaError ? " · u quota" : "";
    const servicesHint = room.services?.length ? " · v services" : "";
    const upd = room.update || room.updateStatus;
    const updateHint =
      upd?.available || upd?.updateAvailable || upd?.status === "error" ? " · U update" : "";
    lines.push(
      `${room.agents.length}/${maxAgents} slots · page ${this.page + 1}/${pages}`,
      `↑↓ select${openHint} · c inactive${quotaHint}${servicesHint}${updateHint} · n page · ? help · q close view`,
      "Ctrl-b Tab: switch pane · Ctrl-b d: detach",
    );
    return this.marginLines(lines, width);
  }
}

export { HordeView as StoogesView };
