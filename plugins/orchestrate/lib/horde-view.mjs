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
  shimmerText,
  SPINNER,
  tone,
  wrapText,
} from "./tui-box.mjs";
import {
  actionBar,
  colorProviderMarks,
  disclosure,
  hitTest,
  lineGauge,
  meterStrip,
  providerMark,
  quotaAccountLabel,
  quotaAccountScope,
  sectionHeading,
  statusRow,
  treeCard,
} from "./tui-components.mjs";
import { renderLogLine, renderMarkdown, stripInlineMarkdown } from "./tui-markdown.mjs";
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
  shimmerText,
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

function quotaWindowKind(window) {
  if (window.kind === "5h" || window.windowMins === 300) return "5h";
  if (window.kind === "weekly" || window.windowMins >= 1440) return "weekly";
  const label = `${window.label || ""} ${window.id || ""}`;
  if (/\b5-?h(?:our)?\b|\bsession\b/iu.test(label)) return "5h";
  if (/\b(?:wk|week(?:ly)?|7-?d(?:ay)?)\b/iu.test(label)) return "weekly";
  return "";
}

function leadStageTone(member) {
  if (member.paused || /blocked|paused|stale/u.test(member.status)) return "leadWarning";
  if (/failed|error/u.test(member.status)) return "leadError";
  if (/complete/u.test(member.status)) return "leadSuccess";
  if (member.status === "planning") return "leadPlanning";
  if (member.status === "testing") return "leadTesting";
  return ACTIVE_STATUSES.has(member.status) ? "leadModel" : "muted";
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

function folderActivitySummary(entries, tier) {
  const agents = entries.map((entry) => entry.agent || entry);
  const activeCount = agents.filter(isExecuting).length;
  const blockedCount = agents.filter((a) => ERROR_STATUSES.has(a.status)).length;
  const doneCount = agents.filter(
    (a) => !isExecuting(a) && COMPLETED_STATUSES.has(a.status),
  ).length;
  const glyphs = glyphSet(tier);
  const parts = [];
  if (activeCount > 0) parts.push(`${glyphs.running} ${activeCount} active`);
  if (blockedCount > 0) parts.push(`${glyphs.blocked} ${blockedCount} blocked`);
  if (doneCount > 0) parts.push(`${glyphs.completed} ${doneCount} complete`);
  if (parts.length === 0) {
    return `${agents.length} ${agents.length === 1 ? "agent" : "agents"}`;
  }
  return parts.join("  ·  ");
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

function quotaExpandedLabel(account, tier, width = 80) {
  const base = quotaAccountLabel(account, tier);
  if (tier !== "nerd" || width < 72) return base;
  const short = plain(account.short || account.id || "?").trim();
  const accountScope = quotaAccountScope(account);
  const brand = providerMark(account.provider, tier);
  if (accountScope === "work") {
    return [brand, "\u{F1AD} Work", short ? `· ${short}` : ""].filter(Boolean).join(" ");
  }
  if (accountScope === "personal") {
    return [brand, "\u{F007} Personal", short ? `· ${short}` : ""].filter(Boolean).join(" ");
  }
  const provider = String(account.provider || "").toLowerCase();
  if (/^(?:gpt|codex|openai)/u.test(provider)) {
    return [brand, "\u{F007} Codex", short && short !== "CX" ? `· ${short}` : ""]
      .filter(Boolean)
      .join(" ");
  }
  if (/^(?:gemini|google|agy|antigravity)/u.test(provider)) {
    return [brand, "\u{F007} Antigravity"].filter(Boolean).join(" ");
  }
  return base;
}

function quotaRows(accounts, width, tier, color, now = Date.now()) {
  const entries = [];
  const accountList = accounts || [];
  for (const account of accountList) {
    const windows = Array.isArray(account.windows) ? account.windows : [];
    const short = quotaAccountLabel(account, tier);
    const expandedShort = quotaExpandedLabel(account, tier, width);
    const creditSuffix = formatCreditSuffix(account);
    const refNow =
      Number.isFinite(account.fetchedAt) && now < 1_000_000_000_000 ? account.fetchedAt : now;
    if (windows.length === 0) {
      entries.push({
        raw: plain(
          `${expandedShort} ${renderLine([account]) || "quota unavailable"}${creditSuffix}`,
        ),
      });
      continue;
    }
    if (windows.length === 1 && accountList.length === 1) {
      const [window] = windows;
      const pct = Number.isFinite(window.remainingPct)
        ? Math.max(0, Math.min(100, window.remainingPct))
        : undefined;
      const label = plain(`${short} ${window.label || window.id || "quota"}`);
      const resetSuffix = pct === undefined ? "" : formatGroupResetSuffix(windows, refNow);
      const summary =
        pct === undefined ? "unavailable" : `${Math.round(pct)}% left${creditSuffix}${resetSuffix}`;
      entries.push({ label, pct, summary, maxBar: 14, minBar: 3 });
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
      for (const group of poolGroups.values()) {
        const measured = group.filter((w) => Number.isFinite(w.remainingPct));
        const minPct =
          measured.length > 0 ? Math.min(100, ...measured.map((w) => w.remainingPct)) : undefined;
        const pct = minPct === undefined ? undefined : Math.max(0, minPct);
        const resetSuffix = formatGroupResetSuffix(group, refNow);
        const summary = `${summarizePoolWindows(group)}${creditSuffix}${resetSuffix}`;
        entries.push({ label: expandedShort, pct, summary, maxBar: 8, minBar: 4 });
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
    entries.push({ label: expandedShort, pct, summary, maxBar: 8, minBar: 4 });
  }
  if (entries.length === 0) return ["Quota unavailable"];
  let labelCol = 0;
  for (const entry of entries) {
    if (entry.label) labelCol = Math.max(labelCol, displayWidth(entry.label));
  }
  const rows = [];
  for (const entry of entries) {
    if (entry.raw) {
      rows.push(entry.raw);
      continue;
    }
    const paddedLabel = entries.length > 1 ? fit(entry.label, labelCol) : entry.label;
    if (entry.pct === undefined) {
      rows.push(`${paddedLabel} ${entry.summary}`);
      continue;
    }
    const barWidth = Math.max(
      entry.minBar,
      Math.min(entry.maxBar, width - displayWidth(paddedLabel) - displayWidth(entry.summary) - 2),
    );
    const gauge = lineGauge(entry.pct / 100, barWidth, { color, tier });
    rows.push(`${paddedLabel} ${gauge} ${entry.summary}`);
  }
  return rows;
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

const BOILERPLATE_HEADING_RE =
  /^#{1,6}\s*(?:status|summary|verdict|result|results|answer|overview|conclusion|outcome)\s*#*$/iu;
const TRAILING_SECTION_HEADING_RE =
  /^#{1,6}\s*(?:files?\s+changed|commands?\s+run|verification|uncertainty|artifacts?|appendix|references?)\b/iu;
const STANDALONE_OUTCOME_RE = /^(?:COMPLETE|COMPLETED|PASSED|PARTIAL|BLOCKED|FAILED)$/u;
const INTERNAL_FILE_PATH_RE = /^(?:\/|[A-Za-z]:\\)\S+\.(?:json|jsonl|txt|log)$/iu;

function cleanProgressTask(member) {
  const t = plain(member?.progress?.task || "").trim();
  return t && t !== "not set" ? t : "";
}

function isFocusNoiseLine(rawLine, resultPath = "") {
  const trimmed = plain(rawLine).trim();
  if (
    !trimmed ||
    /^Coordinator observed:/iu.test(trimmed) ||
    /^Uncertainty:\s*none\.?$/iu.test(trimmed) ||
    BOILERPLATE_HEADING_RE.test(trimmed) ||
    STANDALONE_OUTCOME_RE.test(trimmed) ||
    TRAILING_SECTION_HEADING_RE.test(trimmed)
  )
    return true;
  if (resultPath && trimmed === plain(resultPath).trim()) return true;
  return INTERNAL_FILE_PATH_RE.test(trimmed);
}

function extractAnswerLeadLines(rawAnswer, maxLines = 3) {
  const lines = String(rawAnswer || "").split(/\r?\n/u);
  const picked = [];
  let isInsideFence = false;
  for (const raw of lines) {
    const trimmed = plain(raw).trim();
    if (/^(?:`{3,}|~{3,})/u.test(trimmed)) {
      isInsideFence = !isInsideFence;
      continue;
    }
    if (
      isInsideFence ||
      !trimmed ||
      /^(?:-\s*){3,}$|^(?:\*\s*){3,}$|^(?:_\s*){3,}$/u.test(trimmed) ||
      BOILERPLATE_HEADING_RE.test(trimmed) ||
      STANDALONE_OUTCOME_RE.test(trimmed)
    )
      continue;
    if (TRAILING_SECTION_HEADING_RE.test(trimmed)) {
      if (picked.length > 0) break;
      continue;
    }
    if (/^Uncertainty:\s*none\.?$/iu.test(trimmed)) continue;
    if (/^Uncertainty:/iu.test(trimmed) && picked.length > 0) break;
    picked.push(trimmed);
    if (picked.length >= maxLines) break;
  }
  return picked;
}

export function extractAgentFocusMarkdown(
  agent,
  { isPinned = false, isCardCollapsed = false } = {},
) {
  if (!agent) return "";
  const sections = [];
  const seen = new Set();
  const pushUnique = (line) => {
    const normalized = plain(line).trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    sections.push(normalized);
  };

  const taskLine = cleanProgressTask(agent) || plain(agent.objective || "").trim();
  const errorLine = plain(agent.error || agent.dispatchError || "").trim();

  if (agent.consultation) {
    const asked = plain(agent.question || taskLine).trim();
    if (asked) pushUnique(`Asked: ${asked}`);
    if (errorLine) {
      pushUnique(`Error: ${errorLine}`);
    } else if (agent.answer) {
      for (const line of extractAnswerLeadLines(agent.answer, 3)) {
        pushUnique(line);
      }
    } else {
      const cleanOut = (agent.output || []).filter(
        (line) => !isFocusNoiseLine(line, agent.resultPath),
      );
      const nonUncertainty = cleanOut.filter(
        (line) => !/^Uncertainty:/iu.test(plain(line).trim()) && plain(line).trim() !== asked,
      );
      const chosen = nonUncertainty.length > 0 ? nonUncertainty.slice(0, 3) : cleanOut.slice(0, 2);
      for (const line of chosen) pushUnique(line);
    }
    return sections.join("\n");
  }

  if (errorLine) pushUnique(`Error: ${errorLine}`);
  if (agent.question) {
    const blockerQuestion = plain(agent.question).trim();
    if (blockerQuestion && blockerQuestion !== taskLine) {
      pushUnique(`Question: ${blockerQuestion}`);
    }
  }
  if (isCardCollapsed && taskLine) {
    pushUnique(`Task: ${taskLine}`);
  }

  if (agent.answer) {
    for (const line of extractAnswerLeadLines(agent.answer, 3)) {
      if (plain(line).trim() !== taskLine) pushUnique(line);
    }
  } else {
    const cleanOut = (agent.output || []).filter(
      (line) => !isFocusNoiseLine(line, agent.resultPath) && plain(line).trim() !== taskLine,
    );
    const nonUncertainty = cleanOut.filter((line) => !/^Uncertainty:/iu.test(plain(line).trim()));
    let chosen = [];
    if (nonUncertainty.length > 0) {
      chosen = nonUncertainty.slice(-3);
    } else if (cleanOut.length > 0) {
      chosen = cleanOut.slice(-2);
    }
    for (const line of chosen) pushUnique(line);
  }

  if (sections.length === 0 && isPinned && taskLine) {
    pushUnique(`Task: ${taskLine}`);
  }
  return sections.join("\n");
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
      tier = process.env.ORK_GLYPHS ? glyphTier() : "nerd",
      completedMode = "collapsed",
      quotaMode = "collapsed",
      quotaWindow = "5h",
      servicesMode = "expanded",
      inHerdr = false,
      onFocusPane,
      onPreview,
    } = {},
  ) {
    this.room = treeRoom(room);
    this.now = now;
    this.height = height;
    this.renderWidth = 80;
    this.color = color && !process.env.NO_COLOR;
    this.appearance = { enabled: this.color, theme: resolveTheme(theme) };
    this.tier = tier;
    this.inHerdr = Boolean(inHerdr);
    this.completedMode = COMPLETED_MODES.includes(completedMode) ? completedMode : "collapsed";
    this.quotaWindow = quotaWindow === "weekly" ? "weekly" : "5h";
    this.quotaMode = QUOTA_MODES.has(quotaMode) ? quotaMode : "expanded";
    this.servicesMode = SERVICES_MODES.has(servicesMode) ? servicesMode : "expanded";
    this.onFocusPane = typeof onFocusPane === "function" ? onFocusPane : undefined;
    this.onPreview = typeof onPreview === "function" ? onPreview : undefined;
    this.lastFocusedAgentId = undefined;
    this.focusId = this.room.agents[0]?.id;
    this.focusFollowsLatest = true;
    this.hasExplicitFocus = false;
    this.pinnedId = undefined;
    this.page = 0;
    this.overlay = undefined;
    this.logOffset = 0;
    this.targets = [];
    this.hovered = undefined;
    this.mouseEnabled = true;
    this.notice = "";
    this.activityId = undefined;
    this.preview = null;
    this.previewWidth = 0;
    this.previewOffset = 0;
    this.previewFollow = true;
    this.previewLatestText = "";
  }

  quotaRowLimit() {
    if (!this.room.accounts?.length && !this.room.quotaError) return 0;
    if (this.quotaMode === "collapsed")
      return this.quotaSummaryLines(Math.max(1, this.renderWidth - 4)).length;
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
    const footerExtra = Math.max(
      0,
      this.controls(Math.max(1, this.renderWidth - 2)).lines.length - 1,
    );
    const extraQuotaRows =
      this.quotaMode === "collapsed"
        ? Math.max(0, this.quotaRowLimit())
        : Math.max(0, this.quotaRowLimit() - 2);
    const serviceRows = this.serviceRowLimit();
    let servicePanelLines = 0;
    if (serviceRows > 0) {
      servicePanelLines = this.servicesMode === "collapsed" ? 1 : serviceRows + 2;
    }
    let updateBarLines = 0;
    if (this.showUpdateBar() && this.height >= 14) {
      updateBarLines = this.height < 18 ? 1 : 3;
    }
    const base = Math.min(
      9,
      Math.max(
        2,
        Math.floor(
          (this.height - 10 - extraQuotaRows - servicePanelLines - updateBarLines - footerExtra) /
            4,
        ) * 2,
      ),
    );
    const folderCount = new Set(this.room.agents.map((agent) => agentFolder(agent, this.room)))
      .size;
    if (folderCount > 1 || this.renderWidth < 100) {
      let quotaLines = 0;
      if (this.room.accounts?.length || this.room.quotaError) {
        quotaLines =
          this.quotaMode === "collapsed"
            ? this.quotaRowLimit() + 1
            : Math.max(1, this.quotaRowLimit()) + 2;
      }
      const available =
        this.height - 5 - quotaLines - servicePanelLines - updateBarLines - 3 - footerExtra;
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

  hasAnimatedLeadTask() {
    const lead = this.room?.conductor;
    if (!lead || !isExecuting(lead) || lead.status === "session unavailable") return false;
    const task = plain(lead.progress?.task || "").trim();
    const hasTask = Boolean(task && task !== "not set");
    const hasObjective = Boolean(plain(this.room?.objective || "").trim());
    return hasTask || hasObjective;
  }

  get needsAnimation() {
    const canAnimateAgents = this.tier === "unicode" || Boolean(this.appearance?.enabled);
    return (
      (canAnimateAgents && this.room.agents.some(isExecuting)) ||
      (this.tier !== "ascii" && this.hasAnimatedLeadTask())
    );
  }

  setRoom(room) {
    this.room = treeRoom(room);
    if (
      (this.focusFollowsLatest && !this.pinnedId && this.page === 0) ||
      (this.focusId !== "conductor" && this.room.agents.every((agent) => agent.id !== this.focusId))
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
      .map(
        (line) =>
          `${" ".repeat(margin)}${colorProviderMarks(fitStyled(line, contentWidth), this.appearance)}`,
      );
  }

  invalidate() {
    /* Projection reads the latest room and clock on each render. */
  }

  handleKey(key) {
    this.notice = "";
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
          this.logOffset = 0;
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
    if (this.preview) {
      if (key === "\u{1B}") {
        this.setPreview(null);
        return { type: "close-preview" };
      }
      if (key === "\u{1B}[5~" || key === "\u{1B}[6~") {
        this.scrollPreview((key === "\u{1B}[5~" ? 1 : -1) * Math.max(1, this.height - 8));
        return true;
      }
      if (key === "r") {
        this.previewOffset = 0;
        this.previewFollow = true;
        this.preview.text = this.previewLatestText;
        return true;
      }
      if (key === "[" || key === "]") {
        const agents = this.room.agents;
        if (agents.length === 0) return false;
        const index = agents.findIndex((agent) => agent.id === this.focusId);
        this.focusId = agents[(index + (key === "]" ? 1 : -1) + agents.length) % agents.length].id;
        return this.previewAgent();
      }
    }
    if (key === "g") {
      this.overlay = "logs";
      this.logOffset = 0;
      return true;
    }
    if (key === "0") {
      this.focusId = "conductor";
      return this.previewAgent();
    }
    if (/^[1-9]$/u.test(key)) {
      const selected = Number(key) - 1;
      const agent = this.room.agents[this.page * this.pageSize + selected];
      if (agent) {
        this.focusId = agent.id;
        this.hasExplicitFocus = true;
        this.focusFollowsLatest = false;
        return !this.preview || this.previewAgent();
      }
      return false;
    }
    switch (key) {
      case "\r": {
        return this.previewAgent();
      }
      case "o": {
        const selected = this.selectedAgent();
        if (selected && (selected.herdrPaneId || selected.paneId)) {
          this.lastFocusedAgentId = selected.id;
          this.onFocusPane?.(selected);
          return true;
        }
        if (selected) {
          this.activityId = selected.id;
          this.overlay = "activity";
          return true;
        }
        return false;
      }
      case "m": {
        this.mouseEnabled = !this.mouseEnabled;
        return { type: "mouse-toggle", enabled: this.mouseEnabled };
      }
      case "q": {
        return { type: "close-view" };
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
      case "w": {
        return this.toggleQuotaWindow();
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
        return !this.preview || this.previewAgent();
      }
      default: {
        return false;
      }
    }
  }

  handleInput(key) {
    return this.handleKey(key);
  }

  previewAgent() {
    const agent = this.selectedAgent();
    if (!agent) return false;
    this.hasExplicitFocus = true;
    this.focusFollowsLatest = false;
    if (this.isCurrentAgent(agent)) {
      this.onFocusPane?.(agent);
      return true;
    }
    if (this.onPreview) this.onPreview(agent);
    else
      this.setPreview({
        agentId: agent.id,
        title: shortAgentName(agent),
        text: (agent.output || []).join("\n"),
        kind: "activity",
        loading: false,
      });
    return true;
  }

  selectedAgent() {
    if (this.focusId === "conductor")
      return {
        ...this.room.conductor,
        id: "conductor",
        ...(this.room.herdrCoordinatorPaneId && { herdrPaneId: this.room.herdrCoordinatorPaneId }),
      };
    return this.room.agents.find((agent) => agent.id === this.focusId);
  }

  isCurrentAgent(agent) {
    const pane = this.room.herdrCoordinatorPaneId || this.room.conductor?.herdrPaneId;
    if (pane) return agent.herdrPaneId === pane;
    const session = this.room.conductor?.session?.id;
    return Boolean(session && agent.session?.id === session && (agent.herdrPaneId || agent.paneId));
  }

  toggleQuotaWindow() {
    this.quotaWindow = this.quotaWindow === "5h" ? "weekly" : "5h";
    return true;
  }

  setPreview(snapshot) {
    if (snapshot?.agentId !== this.preview?.agentId || snapshot?.loading) {
      this.previewOffset = 0;
      this.previewFollow = true;
    }
    this.previewLatestText = snapshot?.text || "";
    this.preview =
      snapshot && !this.previewFollow ? { ...snapshot, text: this.preview.text } : snapshot;
  }

  scrollPreview(delta) {
    this.previewOffset = Math.max(0, this.previewOffset + delta);
    this.previewFollow = this.preview?.kind === "terminal" && this.previewOffset === 0;
    if (this.previewFollow && this.preview) this.preview.text = this.previewLatestText;
  }

  handleMouse({ x, y, button, action }) {
    if (action === "scroll-up" || action === "scroll-down") {
      if (this.preview) {
        this.scrollPreview(action === "scroll-up" ? 3 : -3);
        return true;
      }
      return this.handleKey(action === "scroll-up" ? "\u{1B}[A" : "\u{1B}[B");
    }
    const target = hitTest(this.targets, x, y);
    this.hovered = target?.id;
    if (action !== "press" || button !== 0 || !target) return false;
    if (target.agentId) {
      this.notice = "";
      if (this.preview && this.preview.agentId === target.agentId) {
        this.setPreview(null);
        return { type: "close-preview" };
      }
      this.focusId = target.agentId;
      this.hasExplicitFocus = true;
      this.focusFollowsLatest = false;
      return this.previewAgent();
    }
    return this.handleKey(target.key);
  }

  controls(width) {
    if (this.overlay) {
      return actionBar(
        [
          { id: "dismiss", label: "Back", key: "\u{1B}", hint: "Esc", primary: true },

          { id: "scroll-up", label: "Up", key: "\u{1B}[A", hint: "↑" },
          { id: "scroll-down", label: "Down", key: "\u{1B}[B", hint: "↓" },
        ],
        width,
        { color: this.appearance, hovered: this.hovered, tier: this.tier },
      );
    }
    if (this.preview) {
      return actionBar(
        [
          { id: "preview-back", label: "Back", key: "\u{1B}", hint: "Esc", primary: true },
          {
            id: "preview-open",
            label: "Open terminal",
            key: "o",
            disabled: this.preview.kind !== "terminal",
          },
          { id: "preview-follow", label: "Follow", key: "r", active: this.previewFollow },
          { id: "preview-up", label: "Up", key: "\u{1B}[5~", hint: "PgUp" },
          { id: "preview-down", label: "Down", key: "\u{1B}[6~", hint: "PgDn" },
          { id: "preview-previous", label: "Prev", key: "[" },
          { id: "preview-next", label: "Next", key: "]" },
        ],
        width,
        { color: this.appearance, hovered: this.hovered, tier: this.tier },
      );
    }
    const selected = this.selectedAgent();
    const hasInactiveAgents = this.room.agents.some(isInactive);
    return actionBar(
      [
        ...(!this.preview && (!selected || !this.isCurrentAgent(selected))
          ? [
              {
                id: "preview",
                label: "View chat",
                key: "\r",
                hint: "Enter",
                primary: true,
                disabled: !selected,
              },
            ]
          : []),
        ...(this.preview ||
        !selected ||
        this.isCurrentAgent(selected) ||
        (!selected.herdrPaneId && !selected.paneId)
          ? []
          : [
              {
                id: "open",
                label: "Open terminal",
                key: "o",
              },
            ]),
        ...(hasInactiveAgents
          ? [
              {
                id: "inactive",
                label: "Inactive",
                key: "c",
                active: this.completedMode === "expanded",
              },
            ]
          : []),
        { id: "logs", label: "Log", key: "g" },
        { id: "help", label: "Shortcuts", key: "?" },
      ],
      width,
      { color: this.appearance, hovered: this.hovered, tier: this.tier },
    );
  }

  addTargets(targets, row = 0, column = 1) {
    this.targets.push(
      ...targets.map((target) => ({ ...target, x: target.x + column, y: target.y + row })),
    );
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
    let title = this.overlay === "help" ? "Keyboard shortcuts" : "Room log";
    const pad = width >= 6 ? " " : "";
    const interior = Math.max(1, width - 6);
    let wrapped;
    if (this.overlay === "help") {
      const helpRows = [
        "↑/↓ or 1–9  Select agent",
        "0           Return to the current session's live chat",
        "Enter       Preview selected agent's screen without typing into it",
        "PgUp/PgDn   Scroll the preview; r follows the latest screen",
        "o           Open selected agent's interactive terminal",
        "Mouse       Click an agent to preview its chat; click buttons for actions",
        "m           Toggle mouse capture to select terminal text",
        "c           Cycle inactive agents (collapse / hide / expand)",
        "u           Expand or collapse quota view",
        "w           Switch compact quota between 5h and weekly",
        "U           Pull available Orkest update",
        "v           Expand or collapse running services view",
        "n           Next page",
        "p           Pin or unpin focused output",
        "g           Open coalesced room log",
        "? or Esc    Close this reference",
        "q or Ctrl-C Quit the display; workers continue",
        "Glyphs      Set ORK_GLYPHS=ascii|unicode|nerd",
        "Icons       Nerd Font by default; unicode or ascii selects fallback",
      ];
      wrapped = helpRows.flatMap((row) =>
        wrapText(row, interior).map((line, lineIndex) => {
          if (lineIndex === 0 && interior >= 20 && line.length > 12) {
            return `${tone(line.slice(0, 12), "mdSection", this.appearance)}${line.slice(12)}`;
          }
          return line;
        }),
      );
    } else if (this.overlay === "activity") {
      const agent = this.room.agents.find((member) => member.id === this.activityId);
      title = agent ? shortAgentName(agent) : "Agent activity";
      const activityBody = [...(agent?.output || []), agent?.question || ""]
        .filter(Boolean)
        .join("\n\n");
      wrapped = [
        tone("No interactive chat attached.", "muted", this.appearance),
        ...(activityBody
          ? renderMarkdown(activityBody, interior, { color: this.appearance, tier: this.tier })
          : []),
      ];
    } else {
      const coalesced = coalesceMessages(this.room.messages);
      wrapped =
        coalesced.length > 0
          ? coalesced.flatMap((message) =>
              renderLogLine(message.from, message.text, message.count, interior, {
                color: this.appearance,
                tier: this.tier,
              }),
            )
          : [tone("No room messages yet", "muted", this.appearance)];
    }
    const count = Math.max(1, this.height - 7);
    const start = Math.max(0, Math.min(this.logOffset, wrapped.length - count));
    const visible = wrapped.slice(start, start + count).map((line) => `${pad}${line}`);
    return this.panel(title, visible, width);
  }

  quotaLines(width) {
    if (this.room.quotaError) return [` Quota unavailable: ${plain(this.room.quotaError)}`];
    const accounts = this.room.accounts || [];
    return quotaRows(accounts, Math.max(10, width - 5), this.tier, this.appearance, this.now()).map(
      (line) => ` ${line}`,
    );
  }

  updateSummaryText() {
    const upd = this.room?.update || this.room?.updateStatus || {};
    const count =
      Number.isFinite(upd.commitsBehind) && upd.commitsBehind > 0 ? upd.commitsBehind : 1;
    const plural = count === 1 ? "commit" : "commits";
    switch (upd.status) {
      case "updating": {
        return "Pulling update from origin/main...";
      }
      case "updated": {
        const shortSha =
          plain(upd.toSha || upd.remoteSha || "")
            .trim()
            .slice(0, 7) || "latest";
        return `✓ Updated to ${shortSha} · hooks & skills refreshed`;
      }
      case "error": {
        const msg = plain(upd.message || upd.error || "fast-forward failed").trim();
        return `! Update failed: ${msg} · click to retry`;
      }
      default: {
        return upd.dirty
          ? `↑ ${count} new ${plural} on origin/main (working tree dirty)`
          : `↑ ${count} new ${plural} on origin/main · click to update`;
      }
    }
  }

  updateLine(innerWidth) {
    const upd = this.room?.update || this.room?.updateStatus || {};
    const labelText = this.tier === "nerd" ? "\u{F021} Update" : "Update";
    let badgeTone = "yellow bold";
    switch (upd.status) {
      case "error": {
        badgeTone = "red bold";
        break;
      }
      case "updated": {
        badgeTone = "green bold";
        break;
      }
      case "updating": {
        {
          badgeTone = "running bold";
          // No default
        }
        break;
      }
    }
    if (this.hovered === "update-bar") badgeTone = "buttonHover";
    const badge = tone(labelText, badgeTone, this.appearance);
    const budget = Math.max(1, innerWidth - displayWidth(`${labelText}  `));
    return `${badge}  ${fit(this.updateSummaryText(), budget)}`;
  }

  updateBlockLines(innerWidth) {
    if (!this.showUpdateBar() || this.height < 14) return [];
    if (this.height < 18) return [this.updateLine(innerWidth)];
    const upd = this.room?.update || this.room?.updateStatus || {};
    let headerTone = "yellow bold";
    let bodyTone = "warning";
    let headerRight = upd.dirty ? "working tree dirty" : "Shift+U";
    switch (upd.status) {
      case "error": {
        headerTone = "red bold";
        bodyTone = "error";
        headerRight = "retry · Shift+U";

        break;
      }
      case "updated": {
        headerTone = "green bold";
        bodyTone = "success";
        headerRight = "up to date";

        break;
      }
      case "updating": {
        headerTone = "running bold";
        bodyTone = "running";
        headerRight = "pulling...";

        break;
      }
      // No default
    }
    if (this.hovered === "update-bar") headerTone = "buttonHover";
    const title = this.tier === "nerd" ? "\u{F021} Update" : "Update";
    const rowWidth = Math.max(1, innerWidth - 4);
    const body = tone(` ${fit(this.updateSummaryText(), rowWidth)}`, bodyTone, this.appearance);
    return this.panel(title, [body], innerWidth, headerRight, headerTone);
  }

  quotaSummaryLines(innerWidth) {
    const chevron = disclosure("", true, this.tier);
    const chevronWidth = displayWidth(chevron);
    const stripWidth = Math.max(1, innerWidth - chevronWidth - 5);
    const appendChevron = (line, isFirst) => {
      const fitted = fitStyled(` ${line}`, stripWidth + 1);
      if (!isFirst) return `${fitted}${" ".repeat(chevronWidth + 4)}`;
      const mark = tone(
        chevron,
        this.hovered === "quota-heading" ? "quotaHover" : "muted",
        this.appearance,
      );
      const period = tone(
        this.quotaWindow === "weekly" ? "wk" : "5h",
        this.hovered === "quota-window" ? "buttonHover" : "leadModel",
        this.appearance,
      );
      return `${fitted} ${period} ${mark}`;
    };
    if (this.room.quotaError) {
      return [appendChevron(`unavailable: ${plain(this.room.quotaError)}`, true)];
    }
    const rows = new Map([
      ["work", []],
      ["personal", []],
      ["", []],
    ]);
    const accounts = this.room.accounts || [];
    for (const account of accounts) {
      const windows = account.windows || [];
      const groups = new Map();
      const pools = account.pools || [];
      for (const pool of pools) {
        groups.set(
          pool.id,
          windows.filter(
            (window) => window.pool === pool.id || pool.windowIds?.includes(window.id),
          ),
        );
      }
      for (const window of windows) {
        if (!window.pool || groups.has(window.pool)) continue;
        groups.set(
          window.pool,
          windows.filter((item) => item.pool === window.pool),
        );
      }
      if (account.provider === "antigravity") {
        if (!groups.has("claude-gpt")) groups.set("claude-gpt", []);
        if (!groups.has("gemini")) groups.set("gemini", []);
      }
      if (groups.size === 0) groups.set("", windows);
      for (const [pool, group] of groups) {
        let label = pool;
        if (pool === "claude-gpt") label = "Claude/GPT";
        else if (pool === "gemini") label = "Gemini";
        if (groups.size === 1 && providerMark(account.provider, this.tier)) label = "";
        const measured = group.filter((window) => Number.isFinite(window.remainingPct));
        const matching = measured.filter((window) => quotaWindowKind(window) === this.quotaWindow);
        const active = matching.length > 0 ? matching : measured;
        const exhausted = measured.some((window) => window.remainingPct <= 0);
        const scope = quotaAccountScope(account);
        const brand = providerMark(account.provider, this.tier);
        const accountLabel = scope
          ? [
              brand || (label ? account.provider : ""),
              label || (brand ? "" : account.provider || account.short || account.id),
            ]
              .filter(Boolean)
              .join(" ")
          : [quotaAccountLabel(account, this.tier), label].filter(Boolean).join(" ");
        const remaining =
          active.length > 0 ? Math.min(...active.map((window) => window.remainingPct)) : undefined;
        rows.get(scope).push({
          label: accountLabel,
          remaining: exhausted ? 0 : remaining,
          detail: formatCreditSuffix(account).replace(/^ · /u, ""),
        });
      }
    }
    if (
      (rows.get("work").length > 0 || rows.get("personal").length > 0) &&
      rows.get("").length > 0
    ) {
      rows.get("personal").push(...rows.get(""));
      rows.set("", []);
    }
    const rawLines = [];
    for (const [scope, meters] of rows) {
      if (meters.length === 0) continue;
      const { icon: scopeIcon, accent } = {
        work: { icon: "\u{F1AD}", accent: "quotaWork" },
        personal: { icon: "\u{F007}", accent: "quotaPersonal" },
        "": { icon: "", accent: "success" },
      }[scope];
      const icon = this.tier === "ascii" ? "" : scopeIcon;
      rawLines.push(
        ...meterStrip(icon, meters, stripWidth, {
          color: this.appearance,
          tier: this.tier,
          hovered: this.hovered === "quota-heading" && rawLines.length === 0,
          accent,
        }),
      );
    }
    if (rawLines.length === 0) return [appendChevron("", true)];
    return rawLines.map((line, index) => appendChevron(line, index === 0));
  }

  serviceHeaderBadge() {
    const services = Array.isArray(this.room.services) ? this.room.services : [];
    if (services.length === 0) return "";
    const ports = services
      .map((svc) => (svc?.port ? `:${svc.port}` : plain(svc?.ports || "").trim()))
      .filter(Boolean);
    const portSummary = ports.length > 0 ? ` · localhost ${ports.slice(0, 3).join(" ")}` : "";
    return `${services.length} running${portSummary}`;
  }

  inlineServicesLine(innerWidth) {
    const services = Array.isArray(this.room.services) ? this.room.services : [];
    const serviceTitle = this.tier === "nerd" ? "\u{F233} Services" : "Services";
    const labelText = disclosure(serviceTitle, false, this.tier);
    const badge = tone(
      labelText,
      this.hovered === "services-heading" ? "buttonHover" : "running bold",
      this.appearance,
    );
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
    const hasPort = services.some((svc) => svc?.port || plain(svc?.ports || "").trim());
    const hostPrefix = hasPort ? "localhost " : "";
    const summary = `${services.length} running${items.length > 0 ? ` · ${hostPrefix}${items.join(" · ")}` : ""}`;
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
      const meta = [label, folder, owner].filter(Boolean).join(" · ");
      const raw = `${glyph} ${endpoint}  ${meta}`;
      const right = uptime ? fit(uptime, Math.min(displayWidth(uptime), rowWidth - 2)) : "";
      const row = right
        ? `${fit(raw, rowWidth - displayWidth(right) - 2)}  ${right}`
        : fit(raw, rowWidth);
      return tone(row, isDocker ? "running" : "success", this.appearance);
    });
  }

  folderHeaderLine(folder, count, innerWidth, summary = "") {
    return sectionHeading(
      folder ? shortFolder(folder) : "workspace",
      summary || `${count} ${count === 1 ? "agent" : "agents"}`,
      innerWidth,
      {
        prefix: toAsciiTree("│ ", this.tier),
        color: this.appearance,
        tier: this.tier,
        separator: summary ? "  ·  " : " · ",
      },
    );
  }

  isCollapsibleCompleted(agent, parentIds) {
    if (!agent || !isInactive(agent) || agent.id === this.pinnedId) return false;
    if (agent.id === this.focusId && this.hasExplicitFocus) return false;
    if (parentIds) return !parentIds.has(agent.id);
    const agents = Array.isArray(this.room?.agents) ? this.room.agents : [];
    return agents.every(
      (member) => !(member.parent && member.parent !== "conductor" && member.parent === agent.id),
    );
  }

  focusCardLines(focused, innerWidth, remainingRows, startRow) {
    if (!focused || remainingRows <= 0) return [];
    const isPinned = Boolean(this.pinnedId && focused.id === this.pinnedId);
    const isCardCollapsed =
      this.completedMode === "collapsed" && this.isCollapsibleCompleted(focused);
    const markdown = extractAgentFocusMarkdown(focused, { isPinned, isCardCollapsed });
    if (!markdown) return [];

    const agentLabel = shortAgentName(focused);
    const titlePrefix = isPinned ? "Pinned" : "Focus";
    if (remainingRows < 3) {
      const compactTag = `[${titlePrefix} · ${agentLabel}]`;
      const styledTag = tone(compactTag, isPinned ? "warning bold" : "mdSection", this.appearance);
      const rawLast = markdown.split("\n").at(-1) || "";
      const summary = stripInlineMarkdown(rawLast).replace(/^(?:Task|Asked|Question):\s*/u, "");
      const budget = Math.max(1, innerWidth - displayWidth(`${compactTag} `));
      return [`${styledTag} ${fit(summary, budget)}`];
    }

    const title = `${titlePrefix} · ${agentLabel}`;
    let rightHint = "";
    if (innerWidth >= 48) {
      rightHint = isPinned ? "Enter open · p unpin" : "Enter open · p pin";
    } else if (innerWidth >= 34) {
      rightHint = "Enter open";
    }
    const pad = innerWidth >= 6 ? " " : "";
    const bodyWidth = Math.max(1, innerWidth - 2 - pad.length * 2);
    const maxBodyRows = Math.max(1, Math.min(4, remainingRows - 2));
    const rendered = renderMarkdown(markdown, bodyWidth, {
      color: this.appearance,
      tier: this.tier,
    }).filter((line, idx, arr) => line !== "" || (idx > 0 && idx < arr.length - 1));
    let visible = rendered.slice(0, maxBodyRows);
    if (rendered.length > maxBodyRows && visible.length > 0 && bodyWidth >= 4) {
      const ellipsis = this.tier === "ascii" ? "..." : "…";
      const cutWidth = Math.max(1, bodyWidth - displayWidth(ellipsis));
      const truncatedLast = fitStyled(visible.at(-1), cutWidth).trimEnd();
      visible = [
        ...visible.slice(0, -1),
        `${truncatedLast}${tone(ellipsis, "muted", this.appearance)}`,
      ];
    }
    const paddedBody = visible.map((row) => `${pad}${row}`);
    let headerTone = isPinned ? "warning bold" : "mdSection";
    if (this.hovered === "focus-card") headerTone = "buttonHover";
    const cardLines = this.panel(title, paddedBody, innerWidth, rightHint, headerTone);
    this.addTargets([
      {
        id: "focus-card",
        agentId: focused.id,
        x: 1,
        y: startRow,
        width: innerWidth,
        height: cardLines.length,
      },
    ]);
    return cardLines;
  }

  render(width) {
    this.previewWidth = this.preview && !this.overlay ? width : 0;
    return this.renderSidebar(width);
  }

  previewPanelLines(width, height) {
    const preview = this.preview;
    if (!preview || height <= 0) return [];
    const budget = Math.max(1, height - 3);
    const pad = width >= 6 ? " " : "";
    const textWidth = Math.max(1, width - 2 - pad.length * 2);
    const rows =
      preview.kind === "terminal"
        ? String(preview.text || "")
            .split(/\r?\n/u)
            .flatMap((line) => wrapText(plain(line), textWidth))
        : renderMarkdown(preview.text || "", textWidth, {
            color: this.appearance,
            tier: this.tier,
          });
    this.previewOffset = Math.min(this.previewOffset, Math.max(0, rows.length - budget));
    if (this.previewFollow) {
      const response =
        preview.kind === "activity"
          ? rows.findIndex((line) => /^Response:(?:\s|$)/u.test(plain(line).trim()))
          : -1;
      const start = Math.max(0, rows.length - budget);
      this.previewOffset = response >= 0 ? Math.max(0, start - response) : 0;
    }
    const end = Math.max(0, rows.length - this.previewOffset);
    const body = rows.slice(Math.max(0, end - budget), end).map((line) => `${pad}${line}`);
    while (body.length < budget) body.push("");
    const heading = preview.kind === "terminal" ? "Live screen · read only" : "Recorded activity";
    const state = preview.loading ? "Loading..." : preview.error || heading;
    const rightHint = width >= 44 ? "Esc back · [ ] switch" : "";
    return this.panel(
      plain(preview.title || "Agent"),
      [`${pad}${tone(state, preview.error ? "error" : "muted", this.appearance)}`, ...body],
      Math.max(1, width),
      rightHint,
      "mdSection",
    ).slice(0, height);
  }

  renderSidebar(width) {
    width = Math.max(1, Math.floor(width) || 80);
    this.renderWidth = width;
    this.targets = [];
    if (this.overlay) {
      const controls = this.controls(Math.max(1, width - 2));
      const lines = this.overlayLines(Math.max(1, width - 2)).slice(
        0,
        Math.max(0, this.height - controls.lines.length),
      );
      while (lines.length < this.height - controls.lines.length) lines.push("");
      this.addTargets(controls.targets, lines.length);
      return this.marginLines([...lines, ...controls.lines], width);
    }
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
    const style = (text, token) => tone(text, token, this.appearance);
    const separator = (text) => style(text, "leadSeparator");
    const model = (member, isStyled = false) => {
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
      const brand =
        providerMark(modelName, this.tier) ||
        providerMark(member.engine || data.harness, this.tier);
      if (isStyled) {
        return `${brand ? `${colorProviderMarks(brand, this.appearance)} ` : ""}${style(`${modelName || "default model"}${provenance}`, "leadModel")}${effort && effort !== "—" ? `${separator(" / ")}${style(effort, "leadEffort")}` : ""}`;
      }
      return `${brand ? `${brand} ` : ""}${modelName || "default model"}${provenance}${effort && effort !== "—" ? ` / ${effort}` : ""}`;
    };
    const innerWidth = Math.max(1, width - 2);
    const leadFolder = agentFolder(lead, room);
    const leadRole = roleOf(lead);
    const leadRoleBadge = leadRole ? style(` [${leadRole}]`, "leadBranch bold") : "";
    const leadIcon = this.tier === "nerd" ? "\u{F06A9} " : "";
    const identityColor = lead.color ?? lead.progress?.color;
    const identityTone = [31, 32, 33, 34, 35, 36].includes(Number(identityColor))
      ? `identity${identityColor}`
      : "identity36";
    const leadTitle =
      lead.name || lead.progress?.name
        ? `${style("ork:", "muted")} ${style(`${leadIcon}${shortAgentName(lead)}`, identityTone)}`
        : `${style(leadIcon, identityTone)}${style("Coordinator", "bold")}`;
    const leadBranch = plain(
      lead.branch || lead.progress?.branch || lead.worktree?.branch || "",
    ).trim();
    const leadEngine = plain(lead.engine || "").trim();
    const leadLocation =
      room.agents.length === 0 || selected.every((agent) => agentFolder(agent, room) !== leadFolder)
        ? `${separator(" · ")}${style("folder:", "muted")} ${style(shortFolder(leadFolder), "bold")}`
        : "";
    const leadMetaParts = [
      `${leadTitle}${leadRoleBadge}${leadLocation}${leadBranch ? style(` (${leadBranch})`, "leadBranch") : ""}`,
      ...(leadEngine ? [`${style("harness:", "muted")} ${style(leadEngine, "leadEngine")}`] : []),
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
        : leadTask || plain(room.objective || "");
    const leadRunning = isExecuting(lead);
    const missionBudget = Math.max(1, innerWidth - (leadRunning ? 5 : 3));
    const fittedMission =
      displayWidth(leadMissionLine) > missionBudget
        ? fit(leadMissionLine, missionBudget)
        : leadMissionLine;
    const renderedMission =
      leadMissionLine && leadRunning
        ? `${tone(this.tier === "ascii" ? ">" : SPINNER[Math.floor(now / 120) % SPINNER.length], "shimmerSpinner", this.appearance)} ${shimmerText(fittedMission, now, this.appearance)}`
        : fittedMission;
    const stageTone = leadStageTone(lead);
    const leadSuffix = progressSuffix(lead, now)
      .split(" · ")
      .slice(1)
      .map(
        (part) => `${separator(" · ")}${style(part, part === "live" ? "leadSuccess" : stageTone)}`,
      )
      .join("");
    let leadLines = [
      leadMetaParts.join(separator(" · ")),
      `${style(statusGlyph(lead, now, this.tier), stageTone)} ${model(lead, true)}${separator(" | ")}${style(phase(lead), stageTone)}${leadSuffix}`,
      ...(leadMissionLine ? [renderedMission] : []),
    ];
    if (lead.status === "session unavailable" && room.agents.length > 0) {
      leadLines = ["Coordinator session unavailable"];
      if (room.objective) leadLines.push(plain(room.objective));
    }
    leadLines = leadLines.map((line) => ` ${line}`);
    const maxAgents = room.swarm?.maxAgents ?? 64;
    const hasAgentTree = room.agents.length > 0;
    const hasQuota = Boolean(room.accounts?.length || room.quotaError);
    const isQuotaDrawer = hasQuota && this.quotaMode === "collapsed";
    const hasHerdrPaneHeader = Boolean(
      this.inHerdr || room.herdrViewPaneId || room.herdrCoordinatorPaneId,
    );
    const activityBadge = swarmActivityBadge(room, maxAgents, this.tier, innerWidth);
    let topCardTitle = "";
    if (!hasHerdrPaneHeader) {
      topCardTitle =
        room.title === "New swarm" ? "Swarm" : `Swarm · ${plain(room.title || room.id)}`;
    }
    const lines = [
      ...this.panel(
        topCardTitle,
        leadLines,
        innerWidth,
        hasHerdrPaneHeader ? "" : activityBadge,
        this.hovered === "current-session" ? "buttonHover" : "swarmHeading",
        hasAgentTree ? "start" : "",
      ),
    ];
    if (room.herdrCoordinatorPaneId || lead.herdrPaneId || lead.paneId)
      this.addTargets([
        {
          id: "current-session",
          agentId: "conductor",
          x: 1,
          y: 1,
          width: innerWidth,
          height: isQuotaDrawer ? lines.length - 1 : lines.length,
        },
      ]);
    if (isQuotaDrawer) {
      const glyphs = glyphSet(this.tier);
      const leftTee = this.tier === "ascii" ? "+" : "├";
      const rightTee = this.tier === "ascii" ? "+" : "┤";
      const inside = Math.max(1, innerWidth - 2);
      const hBar = glyphs.horizontal.repeat(Math.max(0, innerWidth - 2));
      lines.pop();
      lines.push(tone(`${leftTee}${hBar}${rightTee}`, "border", this.appearance));
      const drawerRows = this.quotaSummaryLines(inside);
      this.addTargets([
        {
          id: "quota-heading",
          key: "u",
          x: 1,
          y: lines.length + 1,
          width: innerWidth,
          height: drawerRows.length,
        },
        {
          id: "quota-window",
          key: "w",
          x: inside - displayWidth(disclosure("", true, this.tier)) - 2,
          y: lines.length + 1,
          width: 3,
          height: 1,
        },
      ]);
      const vBorder = tone(glyphs.vertical, "border", this.appearance);
      for (const row of drawerRows) {
        lines.push(`${vBorder}${fitStyled(row, inside)}${vBorder}`);
      }
      const bottomLeft = hasAgentTree ? leftTee : glyphs.bottomLeft;
      lines.push(tone(`${bottomLeft}${hBar}${glyphs.bottomRight}`, "border", this.appearance));
    }
    if (hasQuota && !isQuotaDrawer) {
      this.addTargets([
        { id: "quota-heading", key: "u", x: 1, y: lines.length + 1, width: innerWidth, height: 1 },
      ]);
      const quotaLimit = this.quotaRowLimit();
      lines.push(
        ...this.panel(
          disclosure("Quota", true, this.tier),
          this.quotaLines(innerWidth).slice(0, quotaLimit),
          innerWidth,
          "",
          this.hovered === "quota-heading" ? "quotaHover" : undefined,
          hasAgentTree ? "middle" : "",
        ),
      );
    }
    if (room.agents.length > 0) {
      const parentIds = new Set(
        room.agents.map((agent) => agent.parent).filter((p) => p && p !== "conductor"),
      );
      const isCollapsibleCompleted = (agent) => this.isCollapsibleCompleted(agent, parentIds);
      const activePreviewAgentId = this.preview ? this.preview.agentId || this.focusId : "";
      const previewSource = activePreviewAgentId
        ? room.agents.filter((agent) => agent.id === activePreviewAgentId)
        : [];
      const visibleAgents = this.preview && previewSource.length > 0 ? previewSource : selected;
      const folderGroups = new Map();
      for (const [offset, agent] of visibleAgents.entries()) {
        const pageIndex = this.preview ? room.agents.findIndex((a) => a.id === agent.id) : offset;
        const folder = agentFolder(agent, room);
        if (!folderGroups.has(folder)) folderGroups.set(folder, []);
        folderGroups.get(folder).push({ agent, index: pageIndex >= 0 ? pageIndex : offset });
      }
      const gap = "  ";
      const lastFolder = folderGroups.keys().toArray().at(-1);
      for (const [folder, rawEntries] of folderGroups) {
        const folderSummary = hasHerdrPaneHeader
          ? folderActivitySummary(rawEntries, this.tier)
          : "";
        lines.push(this.folderHeaderLine(folder, rawEntries.length, innerWidth, folderSummary));
        const hiddenCompletedCount =
          !this.preview && this.completedMode === "hidden"
            ? rawEntries.filter(({ agent }) => isCollapsibleCompleted(agent)).length
            : 0;
        const entries =
          !this.preview && this.completedMode === "hidden"
            ? rawEntries.filter(({ agent }) => !isCollapsibleCompleted(agent))
            : rawEntries;
        const hasCollapsedRows =
          !this.preview &&
          this.completedMode === "collapsed" &&
          entries.some(({ agent }) => isCollapsibleCompleted(agent));
        const columns =
          !this.preview && !hasCollapsedRows && innerWidth >= 100 && entries.length > 1 ? 2 : 1;
        const cardWidth =
          columns === 2 ? Math.max(24, Math.floor((innerWidth - gap.length) / 2)) : innerWidth;
        const hasFollowingSection = folder !== lastFolder;
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
          const isHovered = this.hovered === `agent:${agent.id}`;
          const pointer = this.tier === "ascii" ? ">" : "▸";
          const chevron = disclosure("", Boolean(this.preview), this.tier);
          const isPinned = agent.id === this.pinnedId;
          const currentBadge = this.isCurrentAgent(agent) ? " · This chat" : "";
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
          if (
            !this.preview &&
            this.completedMode === "collapsed" &&
            isCollapsibleCompleted(agent)
          ) {
            const glyph = statusGlyph(agent, now, this.tier);
            const badge = ` ${isFocused ? pointer : glyph} ${index + 1} ${displayAgentName} `;
            const label = `${currentBadge}${parentBadge}${locationBadge ? ` · ${locationBadge}` : ""} · ${model(agent)}${agent.consultation ? "" : ` · ${taskText}`}`;
            return [
              statusRow(label, phase(agent), cardWidth, {
                prefix,
                color: this.appearance,
                style: toneForStatus(agent),
                tier: this.tier,
                badge,
                badgeStyle: isFocused ? "agentSelected" : "button",
                chevron,
                hovered: isHovered,
              }),
            ];
          }
          const stateBadge = isPinned ? "PIN " : "";
          const cardTitle = `${isFocused ? `${pointer} ` : ""}${index + 1} ${displayAgentName}${agent.role === "lead" ? " (lead)" : ""}`;
          const rightMeta = `${stateBadge}${locationBadge}${parentBadge}${currentBadge}`.trim();
          const cardRight = rightMeta ? `${rightMeta} ${chevron}` : chevron;
          const agentRunning = isExecuting(agent);
          const cardBodyWidth = Math.max(
            1,
            cardWidth - displayWidth(prefix) - (agentRunning ? 5 : 3),
          );
          const fittedTaskText =
            displayWidth(taskText) > cardBodyWidth ? fit(taskText, cardBodyWidth) : taskText;
          const renderedTask = agentRunning
            ? `${tone(this.tier === "ascii" ? ">" : SPINNER[Math.floor(now / 120) % SPINNER.length], "shimmerSpinner", this.appearance)} ${shimmerText(fittedTaskText, now, this.appearance)}`
            : fittedTaskText;
          const statusLine = tone(
            `${statusGlyph(agent, now, this.tier)}${roleBadge} ${model(agent)} | ${phase(agent)}${progressSuffix(agent, now)}`,
            `${toneForStatus(agent)}${isFocused ? " bold" : ""}`,
            this.appearance,
          );
          return treeCard(cardTitle, [` ${renderedTask}`, ` ${statusLine}`], cardWidth, {
            emphasized: isFocused || isPinned,
            hovered: isHovered,
            topPrefix,
            midPrefix: prefix,
            tailPrefix,
            right: cardRight,
            color: this.appearance,
            tier: this.tier,
          });
        });
        let gridRow = lines.length;
        for (let start = 0; start < cards.length; start += columns) {
          const row = cards.slice(start, start + columns);
          for (const [column, card] of row.entries()) {
            this.addTargets([
              {
                id: `agent:${entries[start + column].agent.id}`,
                agentId: entries[start + column].agent.id,
                x: column * (cardWidth + gap.length) + 1,
                y: gridRow + 1,
                width: cardWidth,
                height: card.length,
              },
            ]);
          }
          gridRow += Math.max(...row.map((card) => card.length));
        }
        lines.push(...joinCardGrid(cards, columns, cardWidth, gap));
        if (hiddenCompletedCount === 0) continue;
        const hiddenTargetId = `inactive-hidden:${folder}`;
        this.addTargets([
          {
            id: hiddenTargetId,
            key: "c",
            x: 1,
            y: lines.length + 1,
            width: innerWidth,
            height: 1,
          },
        ]);
        const summaryPrefix = toAsciiTree(hasFollowingSection ? "├─" : "└─", this.tier);
        const glyph = glyphSet(this.tier).completed;
        const summaryText = ` ${glyph} ${hiddenCompletedCount} inactive hidden (press c to expand)`;
        const summaryWidth = Math.max(1, innerWidth - displayWidth(summaryPrefix));
        const fittedSummary = fit(summaryText, summaryWidth);
        const summaryTone = this.hovered === hiddenTargetId ? "buttonHover" : "muted";
        lines.push(
          `${tone(summaryPrefix, "border", this.appearance)}${tone(fittedSummary, summaryTone, this.appearance)}`,
        );
      }
    }
    const serviceLimit = this.preview ? 0 : this.serviceRowLimit();
    const serviceBlock = [];
    if (serviceLimit > 0) {
      if (this.servicesMode === "collapsed") {
        serviceBlock.push(this.inlineServicesLine(innerWidth));
      } else {
        const headerRight = this.serviceHeaderBadge();
        const serviceTitle = this.tier === "nerd" ? "\u{F233} Services" : "Services";
        serviceBlock.push(
          ...this.panel(
            disclosure(serviceTitle, true, this.tier),
            this.serviceLines(innerWidth).slice(0, serviceLimit),
            innerWidth,
            headerRight,
            this.hovered === "services-heading" ? "buttonHover" : undefined,
          ),
        );
      }
    }
    const updateBlock = this.preview ? [] : this.updateBlockLines(innerWidth);
    const controls = this.controls(innerWidth);
    const footerHeight = controls.lines.length + 2;
    const contentHeight = Math.max(0, this.height - footerHeight);
    const mainHeight = Math.max(0, contentHeight - serviceBlock.length - updateBlock.length);
    if (this.preview) {
      const minPreviewHeight = Math.min(mainHeight, 6);
      if (mainHeight - lines.length < minPreviewHeight) {
        const keepTop = Math.max(0, mainHeight - minPreviewHeight);
        lines.splice(keepTop);
        this.targets = this.targets
          .map((target) => ({
            ...target,
            height: Math.min(target.height, keepTop - target.y + 1),
          }))
          .filter((target) => target.height > 0);
      }
      lines.push(...this.previewPanelLines(innerWidth, Math.max(1, mainHeight - lines.length)));
    } else {
      const focused = room.agents.find((agent) => agent.id === (this.pinnedId || this.focusId));
      const focusLines = this.focusCardLines(
        focused,
        innerWidth,
        mainHeight - lines.length,
        lines.length + 1,
      );
      if (focusLines.length > 0) {
        lines.push(...focusLines);
      }
      if (room.agents.length === 0) {
        const emptyLines = [];
        for (const line of wrapText(
          "The coordinator will add agents as work is assigned.",
          innerWidth,
        )) {
          const leftSpaces = Math.max(0, Math.floor((innerWidth - displayWidth(line)) / 2));
          emptyLines.push(`${" ".repeat(leftSpaces)}${tone(line, "muted", this.appearance)}`);
        }
        const topPad = Math.max(0, Math.floor((mainHeight - lines.length - emptyLines.length) / 2));
        for (let i = 0; i < topPad; i++) lines.push("");
        lines.push(...emptyLines);
      }
    }
    while (lines.length < mainHeight) lines.push("");
    lines.splice(mainHeight);
    this.targets = this.targets
      .map((target) => ({
        ...target,
        height: Math.min(target.height, mainHeight - target.y + 1),
      }))
      .filter((target) => target.height > 0);
    lines.push(
      tone(
        `${room.agents.length}/${maxAgents} slots · page ${this.page + 1}/${pages}`,
        "muted",
        this.appearance,
      ),
    );
    if (serviceBlock.length > 0 && contentHeight - mainHeight >= serviceBlock.length) {
      this.addTargets([
        {
          id: "services-heading",
          key: "v",
          x: 1,
          y: lines.length + 1,
          width: innerWidth,
          height: 1,
        },
      ]);
      lines.push(...serviceBlock);
    }
    if (
      updateBlock.length > 0 &&
      contentHeight - mainHeight >= serviceBlock.length + updateBlock.length
    ) {
      this.addTargets([
        {
          id: "update-bar",
          key: "U",
          x: 1,
          y: lines.length + 1,
          width: innerWidth,
          height: updateBlock.length,
        },
      ]);
      lines.push(...updateBlock);
    }
    this.addTargets(controls.targets, lines.length);
    const footerNotice =
      this.notice || (this.mouseEnabled ? "" : "Mouse off — press m to re-enable mouse");
    const footerNoticeTone = this.notice || this.mouseEnabled ? "muted" : "warning bold";
    lines.push(...controls.lines, tone(footerNotice, footerNoticeTone, this.appearance));
    return this.marginLines(lines, width);
  }
}
