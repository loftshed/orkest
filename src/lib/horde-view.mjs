/**
 * @module horde-view
 *
 * Horde View (`ork horde`): Unified live terminal card-tree TUI (`HordeView`)
 * rendering the coordinator summary card, subscription quota strip, folder
 * banners with continuous vertical tree rails, and multi-column agent cards
 * with disposable worktree badges (`wt:<slug>`).
 */
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { redactCommand } from "./agent-processes.mjs";
import { mapDiffLines, markText } from "./diff-marks.mjs";
import { coalesceMessages, resolveMemberWorktree } from "./horde-room.mjs";
import { memberDisplayState, MEMBER_OUTCOMES as OUTCOMES } from "./member-state.mjs";
import { terseLine, timeLeft } from "./monitor/render.mjs";
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
  truncateDisplay,
  truncateStyled,
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
  WIDE_NERD_BRANDS,
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
  truncateDisplay,
  truncateStyled,
  wrapText,
} from "./tui-box.mjs";

const ACTIVE_STATUSES = new Set(["running", "working", "planning", "testing", "review"]);

function outcome(member) {
  return OUTCOMES[memberDisplayState(member)];
}

function outcomeGlyph(state, tier) {
  return OUTCOMES[state].glyphs[{ ascii: 0, unicode: 1, nerd: 2 }[tier] ?? 1];
}
const COMPLETED_MODES = ["collapsed", "hidden", "expanded"];
const QUOTA_MODES = new Set(["expanded", "collapsed"]);
const SERVICES_MODES = new Set(["expanded", "collapsed"]);
const ERROR_STATUSES = new Set(["blocked", "failed", "rejected", "session unavailable"]);
// An embedded Herdr pane retires on close; a bare q must be pressed twice within this window.
export const CLOSE_CONFIRM_MS = 3000;
const RESOLVED_STATES = new Set(["accepted", "finished", "answered", "cancelled"]);
const SLOT_ID_PATTERN = /^[a-z0-9.]+-\d+$/iu;
const MULTI_HYPHEN_SLOT_PATTERN = /^([a-z0-9]+(?:-[a-z0-9.]+){2,})-(\d+)$/iu;
const SESSION_TAG_PATTERN = /^[0-9a-f]{2}$/iu;
const EFFORT_LEVELS = new Set(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
const TRAILING_EFFORT_PATTERN = /^(.*\S)(?:\s*\(([a-z]+)\)|\s*\[([a-z]+)\]|-([a-z]+))$/iu;
const DIFF_GUTTER = {
  nerd: { cursor: "", mark: "" },
  unicode: { cursor: "›", mark: "●" },
  ascii: { cursor: ">", mark: "*" },
};

function isExecuting(member) {
  if (outcome(member) || ["cancelled", "blocked"].includes(memberDisplayState(member)))
    return false;
  if (member.runtimeState) return member.runtimeState === "running";
  if (member.dispatch && member.status === "review") return false;
  return ACTIVE_STATUSES.has(member.status);
}

function isInactive(member) {
  if (["stale", "failed", "rejected", "blocked"].includes(memberDisplayState(member))) return false;
  return (
    !isExecuting(member) &&
    (Boolean(outcome(member)) ||
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
  if (outcome(member)) return outcome(member).tone;
  if (member.paused || /blocked|paused|stale/u.test(member.status)) return "leadWarning";
  if (/failed|error/u.test(member.status)) return "leadError";
  if (member.status === "planning") return "leadPlanning";
  if (member.status === "testing") return "leadTesting";
  return ACTIVE_STATUSES.has(member.status) ? "leadModel" : "muted";
}

/** A request or inheritance is labelled as such; only an observation is shown unlabelled. */
export function settingsProvenanceLabel(member) {
  if (member.settingsMismatch?.length > 0) return " (observed ≠ resolved)";
  if (member.modelSource === "requested" && (member.consultation || member.settingsProvenance))
    return " (requested)";
  if (member.modelSource === "inherited") return " (inherited)";
  return "";
}

function phaseLabel(member) {
  if (outcome(member)) return outcome(member).label;
  if (member.verdict === "takeover" || member.status === "conductor_takeover")
    return "conductor takeover";
  if (member.paused) return "new launches paused";
  if (member.awaitingTurn && !isExecuting(member)) return "awaiting coordinator turn";
  if (member.dispatch && member.status === "review" && !isExecuting(member))
    return "awaiting review";
  if (member.runtimeState === "idle" && ACTIVE_STATUSES.has(member.status))
    return `idle · last reported ${member.status}`;
  return member.status || "unknown";
}

function agentPhaseLabel(member, width = 80) {
  if (memberDisplayState(member) === "reported" && width < 68) {
    return "review";
  }
  return phaseLabel(member);
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
  const checklist = member.checklist || member.progress?.checklist;
  if (
    Number.isSafeInteger(checklist?.completed) &&
    Number.isSafeInteger(checklist?.total) &&
    checklist.total > 0 &&
    checklist.completed >= 0 &&
    checklist.completed <= checklist.total
  )
    parts.push(`step ${checklist.completed}/${checklist.total}`);
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

function activityParts(agents, tier) {
  const parts = [];
  const activeCount = agents.filter(isExecuting).length;
  const blockedCount = agents.filter((agent) => memberDisplayState(agent) === "blocked").length;
  if (activeCount)
    parts.push({ text: `${glyphSet(tier).running} ${activeCount} active`, style: "running" });
  if (blockedCount)
    parts.push({ text: `${glyphSet(tier).blocked} ${blockedCount} blocked`, style: "error" });
  for (const [state, spec] of Object.entries(OUTCOMES)) {
    if (spec.neutral) continue;
    const count = agents.filter((agent) => memberDisplayState(agent) === state).length;
    if (count)
      parts.push({ text: `${outcomeGlyph(state, tier)} ${count} ${state}`, style: spec.tone });
  }
  return parts;
}

function swarmActivityBadge(room, maxAgents, tier, innerWidth = 80) {
  const agents = room?.agents || [];
  const base = { text: `${agents.length}/${maxAgents} slots`, style: "" };
  if (agents.length === 0 || innerWidth < 64) return [base];
  return [...activityParts(agents, tier), base];
}

function toneForStatus(member) {
  if (outcome(member)) return outcome(member).tone;
  if (isExecuting(member)) return "running";
  if (member.status === "review") return "warning";
  if (isInactive(member)) return "muted";
  if (ERROR_STATUSES.has(member.status)) return "error";
  if (member.status === "queued" || member.status === "reserved") return "warning";
  return "muted";
}

function statusGlyph(agent, now, tier) {
  const state = memberDisplayState(agent);
  if (Object.hasOwn(OUTCOMES, state)) return outcomeGlyph(state, tier);
  const glyphs = glyphSet(tier);
  const isActive = isExecuting(agent);
  if (isActive && tier === "unicode") return SPINNER[Math.floor(now / 200) % SPINNER.length];
  if (isActive) return glyphs.running;
  if (ERROR_STATUSES.has(agent.status)) return glyphs.blocked;
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

function brandGap(brand) {
  return WIDE_NERD_BRANDS.has(brand) ? "  " : " ";
}

function quotaExpandedLabel(account, tier, width = 80) {
  const base = quotaAccountLabel(account, tier);
  if (tier !== "nerd" || width < 72) return base;
  const short = plain(account.short || account.id || "?").trim();
  const accountScope = quotaAccountScope(account);
  const brand = providerMark(account.provider, tier);
  const joinWithBrand = (...parts) => {
    const rest = parts.filter(Boolean).join(" ");
    if (!brand) return rest;
    return rest ? `${brand}${brandGap(brand)}${rest}` : brand;
  };
  if (accountScope === "work") {
    return joinWithBrand("\u{F1AD} Work", short ? `· ${short}` : "");
  }
  if (accountScope === "personal") {
    return joinWithBrand("\u{F007} Personal", short ? `· ${short}` : "");
  }
  const provider = String(account.provider || "").toLowerCase();
  if (/^(?:gpt|codex|openai)/u.test(provider)) {
    return joinWithBrand("\u{F007} Codex", short && short !== "CX" ? `· ${short}` : "");
  }
  if (/^(?:gemini|google|agy|antigravity)/u.test(provider)) {
    return joinWithBrand("\u{F007} Antigravity");
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
      const gap = WIDE_NERD_BRANDS.has(expandedShort) ? brandGap(expandedShort) : " ";
      entries.push({
        raw: plain(
          `${expandedShort}${gap}${terseLine([account]) || "quota unavailable"}${creditSuffix}`,
        ),
      });
      continue;
    }
    if (windows.length === 1 && accountList.length === 1) {
      const [window] = windows;
      const pct = Number.isFinite(window.remainingPct)
        ? Math.max(0, Math.min(100, window.remainingPct))
        : undefined;
      const gap = WIDE_NERD_BRANDS.has(short) ? brandGap(short) : " ";
      const label = plain(`${short}${gap}${window.label || window.id || "quota"}`);
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
  const herdrEndpoint = agent.herdrEndpoint || agent.progress?.herdrEndpoint;
  const paneId = agent.paneId || agent.progress?.paneId;
  const orcaTerminalHandle = agent.orcaTerminalHandle || agent.progress?.orcaTerminalHandle;
  const orcaEnvironment = agent.orcaEnvironment || agent.progress?.orcaEnvironment;
  return {
    ...agent,
    _cachedWorktree: worktree,
    ...(worktree && { worktree }),
    ...(herdrPaneId && { herdrPaneId }),
    ...(herdrEndpoint && { herdrEndpoint }),
    ...(paneId && { paneId }),
    ...(orcaTerminalHandle && { orcaTerminalHandle }),
    ...(orcaEnvironment && { orcaEnvironment }),
  };
}

/** The agent runs in a terminal pane that `o` can focus: Herdr, Orca or Orkest tmux. */
function hasTerminalPane(agent) {
  return Boolean(agent && (agent.herdrPaneId || agent.paneId || agent.orcaTerminalHandle));
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

function groupFolder(member, room) {
  const raw = agentFolder(member, room);
  const rootCwd = plain(room?.cwd || "").trim();
  const worktree = memberWorktree(member, room);
  if (
    !raw ||
    !rootCwd ||
    raw === rootCwd ||
    worktree?.disposable === false ||
    existsSync(path.join(raw, ".git"))
  ) {
    return raw;
  }
  const rawNorm = raw.replace(/\/+$/u, "");
  const rootNorm = rootCwd.replace(/\/+$/u, "");
  if (rawNorm === rootNorm) return rootCwd;
  const xdgCache = (process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache")).replace(
    /\/+$/u,
    "",
  );
  const orchestrateCache = xdgCache ? path.join(xdgCache, "orchestrate") : "";
  const isInRepoSubdir = rawNorm.startsWith(`${rootNorm}${path.sep}`);
  const isInOrchestrateCache = Boolean(
    orchestrateCache &&
    (rawNorm === orchestrateCache || rawNorm.startsWith(`${orchestrateCache}${path.sep}`)),
  );
  const hasWorkerArtifact = Boolean(member?.dispatch || member?.resultPath || member?.consultation);
  return isInRepoSubdir || hasWorkerArtifact || isInOrchestrateCache ? rootCwd : raw;
}

function subfolderContext(member, room, groupedFolder) {
  const worktree = memberWorktree(member, room);
  if (worktree?.disposable === true) return "";
  const raw = agentFolder(member, room);
  if (raw && groupedFolder && raw !== groupedFolder) return shortFolder(raw);
  return "";
}

function dedupSlotAgentName(rawAgentName, modelName) {
  const match = rawAgentName.match(MULTI_HYPHEN_SLOT_PATTERN);
  if (!match) return rawAgentName;
  const [, stem, slotNum] = match;
  const stemTokens = stem.toLowerCase().split("-").filter(Boolean);
  const modelTokens = new Set(
    String(modelName || "")
      .toLowerCase()
      .split(/[^a-z0-9.]+/u)
      .filter(Boolean),
  );
  if (stemTokens.every((token) => !modelTokens.has(token))) return rawAgentName;
  while (
    stemTokens.length > 1 &&
    (EFFORT_LEVELS.has(stemTokens.at(-1)) || /^\d+(?:\.\d+)*$/u.test(stemTokens.at(-1)))
  ) {
    stemTokens.pop();
  }
  const word = stemTokens.at(-1);
  return word ? `${word}-${slotNum}` : rawAgentName;
}

function shortFolder(folderPath) {
  const cleaned = plain(folderPath).trim();
  if (!cleaned) return "workspace";
  return path.basename(cleaned) || cleaned;
}

export function formatWorktreeBadge(target) {
  const label = shortFolder(target);
  if (/^wt:/iu.test(label)) return label;
  if (/^wt-/iu.test(label) && label.length > 3) return `wt:${label.slice(3)}`;
  return `wt:${label}`;
}

export function worktreeBadge(member, room) {
  const worktree = memberWorktree(member, room);
  if (worktree?.disposable !== true) return "";
  const target =
    worktree.slug || worktree.path || member?.progress?.cwd || member?.cwd || member?.session?.cwd;
  return formatWorktreeBadge(target);
}

function toAsciiTree(text, tier) {
  if (tier !== "ascii") return text;
  return text.replaceAll("└", "`").replaceAll("├", "+").replaceAll("─", "-").replaceAll("│", "|");
}

function folderTreeRails(entries, tier, columns = 1, hasFollowingSection = false, width = 80) {
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
  const isNarrow = width < 68;
  const maxDepth = 4;
  return entries.map(({ agent }, entryIndex) => {
    const ancestors = [];
    let cursor = groupParent(agent);
    while (cursor !== "conductor") {
      const parentEntry = entries.find((item) => item.agent.id === cursor);
      if (!parentEntry) break;
      ancestors.unshift(parentEntry.agent);
      cursor = groupParent(parentEntry.agent);
    }
    let indent = "";
    let continuationIndent = "";
    const hasDepthOverflow = ancestors.length > maxDepth;
    if (hasDepthOverflow) {
      const excess = ancestors.length - maxDepth;
      indent = `+${excess} `;
      continuationIndent = " ".repeat(displayWidth(indent));
    } else {
      for (const ancestor of ancestors) {
        const last = isLastSibling(ancestor);
        const pad = " ".repeat(isNarrow ? 2 : 3);
        const rail = isNarrow ? "│ " : "│  ";
        indent += last ? pad : rail;
        continuationIndent += last ? pad : rail;
      }
    }
    const isBottomOfColumn = columns > 1 && entryIndex + columns >= entries.length;
    const isLast = isLastSibling(agent);
    const hasRailBelow = !isLast && (!isBottomOfColumn || hasFollowingSection);
    const branch = isLast ? "└─" : "├─";
    const contRail = isNarrow ? "│ " : "│  ";
    const contSpace = " ".repeat(isNarrow ? 2 : 3);
    const cont = hasRailBelow ? contRail : contSpace;
    const tailSpace = " ".repeat(2);
    return {
      topPrefix: toAsciiTree(`${indent}│ `, tier),
      midPrefix: toAsciiTree(`${indent}${branch}`, tier),
      continuationPrefix: toAsciiTree(`${continuationIndent}${cont}`, tier),
      tailPrefix: toAsciiTree(`${indent}${hasRailBelow ? "│ " : tailSpace}`, tier),
      hasDepthOverflow,
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

function agentProcessInfo(member, room) {
  const value = room?.agentProcesses?.[member?.id];
  const processes = Array.isArray(value?.processes) ? value.processes : [];
  const more = Number.isSafeInteger(value?.more) && value.more > 0 ? value.more : 0;
  return { processes, more, count: processes.length + more };
}

function agentProcessSummary(member, room) {
  const info = agentProcessInfo(member, room);
  if (info.count === 0) return null;
  const state = memberDisplayState(member);
  const isLeftover = ["reported", "finished", "answered", "completed", "complete"].includes(state);
  const ports = [
    ...new Set(
      info.processes.flatMap((process) =>
        (Array.isArray(process?.ports) ? process.ports : [])
          .map(Number)
          .filter((port) => Number.isSafeInteger(port) && port > 0),
      ),
    ),
  ].toSorted((a, b) => a - b);
  const countLabel = `${info.count} proc${info.count === 1 ? "" : "s"}${isLeftover ? " left" : ""}`;
  return {
    ...info,
    left: isLeftover,
    tone: isLeftover ? "warning" : "muted",
    text: `${countLabel}${ports.length > 0 ? ` · :${ports[0]}` : ""}`,
    compactText: countLabel,
  };
}

function formatProcessAge(seconds) {
  const age = Number.isFinite(Number(seconds)) ? Math.max(0, Math.floor(Number(seconds))) : 0;
  if (age < 60) return `${age}s`;
  if (age < 3600) return `${Math.floor(age / 60)}m`;
  if (age < 86_400) return `${Math.floor(age / 3600)}h`;
  return `${Math.floor(age / 86_400)}d`;
}

function runningProcessLine(process, color) {
  const command = plain(redactCommand(process?.command)) || "(no command line)";
  const pid = Number.isSafeInteger(process?.pid) && process.pid > 0 ? process.pid : "?";
  const ports = [
    ...new Set(
      (Array.isArray(process?.ports) ? process.ports : [])
        .map(Number)
        .filter((port) => Number.isSafeInteger(port) && port > 0),
    ),
  ].toSorted((a, b) => a - b);
  const portSuffix = ports.map((port) => ` :${port}`).join("");
  const directorySuffix = process?.via === "cwd" ? tone(" (by directory)", "muted", color) : "";
  return `${pid}  ${formatProcessAge(process?.ageSeconds)}  ${command}${tone(portSuffix, "running", color)}${directorySuffix}`;
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
  const rawErrorLine = plain(agent.error || agent.dispatchError || "").trim();
  const errorLine = rawErrorLine && !/^failed\.?$/iu.test(rawErrorLine) ? rawErrorLine : "";

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

function attentionBucket(agent) {
  const state = memberDisplayState(agent);
  if (
    ["blocked", "failed", "rejected", "stale"].includes(state) ||
    ERROR_STATUSES.has(agent?.status)
  ) {
    return 0;
  }
  if (isExecuting(agent) || ["starting", "queued", "reserved"].includes(agent?.status)) {
    return 1;
  }
  if (RESOLVED_STATES.has(state) || state === "idle") {
    return 3;
  }
  if (state === "reported" || state === "supported" || isInactive(agent)) {
    return 2;
  }
  return 3;
}

function treeRoom(room) {
  const swarm = room.swarm || { maxAgents: 64, maxDepth: 8 };
  const indexById = new Map();
  const recencyById = new Map();
  const ownBucketById = new Map();
  const childrenByParent = new Map();
  let monotonicFloorMs = 0;
  for (const [index, agent] of room.agents.entries()) {
    indexById.set(agent.id, index);
    const ownMs = agentOwnTimestampMs(agent);
    if (ownMs > monotonicFloorMs) monotonicFloorMs = ownMs;
    recencyById.set(agent.id, ownMs > 0 ? ownMs : monotonicFloorMs);
    ownBucketById.set(agent.id, attentionBucket(agent));
    if (!agent.parent || agent.parent === "conductor") continue;
    if (!childrenByParent.has(agent.parent)) childrenByParent.set(agent.parent, []);
    childrenByParent.get(agent.parent).push(agent);
  }
  const subtreeBucketById = new Map();
  for (const agent of room.agents) {
    let minBucket = 3;
    const stack = [agent.id];
    const seen = new Set();
    while (stack.length > 0) {
      const id = stack.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      minBucket = Math.min(minBucket, ownBucketById.get(id) ?? 3);
      const children = childrenByParent.get(id) || [];
      for (const child of children) {
        if (!seen.has(child.id)) stack.push(child.id);
      }
    }
    subtreeBucketById.set(agent.id, minBucket);
  }
  const compareRecentFirst = (left, right) => {
    const timeDiff = (recencyById.get(right.id) || 0) - (recencyById.get(left.id) || 0);
    if (timeDiff !== 0) return timeDiff;
    return (indexById.get(right.id) ?? 0) - (indexById.get(left.id) ?? 0);
  };
  const compareAttentionFirst = (left, right) =>
    (subtreeBucketById.get(left.id) ?? 3) - (subtreeBucketById.get(right.id) ?? 3) ||
    compareRecentFirst(left, right);
  const treeAgents = [];
  const visited = new Set();
  const visit = (parent) => {
    const children = room.agents
      .filter((agent) => (agent.parent || "conductor") === parent)
      .toSorted(compareAttentionFirst);
    for (const agent of children) {
      if (visited.has(agent.id)) continue;
      visited.add(agent.id);
      treeAgents.push(normalizeAgent(agent, room));
      visit(agent.id);
    }
  };
  visit("conductor");
  for (const agent of room.agents.toSorted(compareAttentionFirst)) {
    if (visited.has(agent.id)) continue;
    visited.add(agent.id);
    treeAgents.push(normalizeAgent(agent, room));
    visit(agent.id);
  }
  const groups = new Map();
  for (const agent of treeAgents) {
    const folder = groupFolder(agent, room);
    if (!groups.has(folder)) groups.set(folder, []);
    groups.get(folder).push(agent);
  }
  const agents = groups.values().toArray().flat();
  const conductor = room.conductor ? normalizeAgent(room.conductor, room) : room.conductor;
  return { ...room, swarm, conductor, agents };
}

function propagateUpAncestors(agents, seedIds) {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const result = new Set(seedIds);
  for (const startAgent of agents) {
    if (!result.has(startAgent.id)) continue;
    let current = startAgent;
    const seen = new Set();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      result.add(current.id);
      current =
        current.parent && current.parent !== "conductor" ? byId.get(current.parent) : undefined;
    }
  }
  return result;
}

/** Subtle `★ chief desk` title hint, present only when this room's coordinator holds the live Chief binding. */
function chiefHintLabel(room, lead, tier) {
  const chief = room?.liveChief;
  if (!chief || chief.schema !== "ork.chief.v1" || !chief.live || chief.stale) return "";
  const star = tier === "ascii" ? "*" : "★";
  const conductor = room?.conductor;
  const ownerSessions = new Set(
    [
      conductor?.session?.id ?? conductor?.session,
      conductor?.mailboxSession,
      conductor?.nativeSession,
      lead?.session?.id ?? lead?.session,
      lead?.mailboxSession,
      lead?.nativeSession,
    ].filter((value) => typeof value === "string" && value),
  );
  return chief.session && ownerSessions.has(chief.session) ? ` · ${star} chief desk` : "";
}

function memberModelInfo(member) {
  const data = member.progress || member;
  const rawModel =
    member.resolvedModel || data.model || member.model || member.engine || "default model";
  const rawEffort =
    member.resolvedEffort ||
    (data.effort && data.effort !== "—" ? data.effort : "") ||
    member.effort ||
    data.effort;
  return normalizeModelAndEffort(rawModel, rawEffort);
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
      servicesMode = "collapsed",
      inHerdr = false,
      confirmClose = false,
      mouseEnabled = true,
      onFocusPane,
      onPreview,
      onDiff,
      onMarks,
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
    this.confirmClose = Boolean(confirmClose);
    this.closeArmedAt = undefined;
    this.completedMode = COMPLETED_MODES.includes(completedMode) ? completedMode : "collapsed";
    this.quotaWindow = quotaWindow === "weekly" ? "weekly" : "5h";
    this.quotaMode = QUOTA_MODES.has(quotaMode) ? quotaMode : "expanded";
    this.servicesMode = SERVICES_MODES.has(servicesMode) ? servicesMode : "collapsed";
    this.onFocusPane = typeof onFocusPane === "function" ? onFocusPane : undefined;
    this.onPreview = typeof onPreview === "function" ? onPreview : undefined;
    this.onDiff = typeof onDiff === "function" ? onDiff : undefined;
    this.onMarks = typeof onMarks === "function" ? onMarks : undefined;
    this.lastFocusedAgentId = undefined;
    this.focusId = this.renderableAgents()[0]?.id ?? this.room.agents[0]?.id;
    this.focusFollowsLatest = true;
    this.hasExplicitFocus = false;
    this.pinnedId = undefined;
    this.page = 0;
    this.overlay = undefined;
    this.logOffset = 0;
    this.targets = [];
    this.hovered = undefined;
    this.mouseEnabled = mouseEnabled !== false;
    this.notice = "";
    this.activityId = undefined;
    this.preview = null;
    this.previewWidth = 0;
    this.previewOffset = 0;
    this.previewFollow = true;
    this.previewLatestText = "";
    this.diffCursor = 0;
    this.diffCursorRows = new Map();
    this.diffPreviewMetrics = null;
    this.quotaWindowOffset = undefined;
    this.chiefEnabled = false;
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
    const hasQuota =
      Boolean(this.room.accounts?.length || this.room.quotaError) && this.height >= 12;
    const quotaRowsCount = hasQuota ? Math.max(1, this.quotaRowLimit()) : 0;
    const serviceRows = this.serviceRowLimit();
    const updateBarLines = this.showUpdateBar() && this.height >= 14 ? 1 : 0;
    const hasTelemetry = hasQuota || serviceRows > 0 || updateBarLines > 0;
    const hasQuotaServicesDivider =
      hasQuota &&
      serviceRows > 0 &&
      (this.quotaMode === "expanded" || this.servicesMode === "expanded");
    const hasUpdateDivider =
      updateBarLines > 0 &&
      (hasQuota || serviceRows > 0) &&
      ((hasQuota && this.quotaMode === "expanded") ||
        (serviceRows > 0 && this.servicesMode === "expanded"));
    const telemetryLines = hasTelemetry
      ? 2 +
        quotaRowsCount +
        (hasQuotaServicesDivider ? 1 : 0) +
        serviceRows +
        (hasUpdateDivider ? 1 : 0) +
        updateBarLines
      : 0;
    const noTelemetryRuleLines = hasTelemetry ? 0 : 1;
    const base = Math.min(
      16,
      Math.max(
        2,
        Math.floor((this.height - 6 - telemetryLines - noTelemetryRuleLines - footerExtra) / 2),
      ),
    );
    const folderCount = new Set(
      this.renderableAgents().map((agent) => groupFolder(agent, this.room)),
    ).size;
    if (folderCount > 1 || this.renderWidth < 100) {
      const available = this.height - 4 - telemetryLines - noTelemetryRuleLines - 2 - footerExtra;
      const capacity = Math.max(1, Math.floor((available - (folderCount > 1 ? 1 : 0)) / 2));
      return Math.min(base, capacity);
    }
    if (this.completedMode === "expanded" || this.height < 24) return base;
    const completedCount = (this.room?.agents || []).filter(isInactive).length;
    if (completedCount <= 1) return base;
    return Math.min(16, Math.max(base, base + completedCount));
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

  ensureVisibleFocus(renderable = this.renderableAgents()) {
    if (
      !this.hasExplicitFocus &&
      !this.pinnedId &&
      this.focusId !== "conductor" &&
      renderable.length > 0 &&
      renderable.every((agent) => agent.id !== this.focusId)
    ) {
      this.focusId = renderable[0].id;
    }
  }

  setRoom(room) {
    this.room = treeRoom(room);
    const renderable = this.renderableAgents();
    if (
      (this.focusFollowsLatest && !this.pinnedId && this.page === 0) ||
      (this.focusId !== "conductor" && this.room.agents.every((agent) => agent.id !== this.focusId))
    ) {
      this.focusId = renderable[0]?.id ?? this.room.agents[0]?.id;
      this.hasExplicitFocus = false;
    }
    if (this.room.agents.every((agent) => agent.id !== this.pinnedId)) this.pinnedId = undefined;
    this.ensureVisibleFocus(renderable);
    this.page = Math.min(this.page, this.pageCount() - 1);
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

  /** Bare q: closes at once, or in an embedded Herdr pane only when pressed again promptly. */
  requestClose(nowMs = Date.now()) {
    if (!this.confirmClose) return { type: "close-view" };
    if (Number.isFinite(this.closeArmedAt) && nowMs - this.closeArmedAt <= CLOSE_CONFIRM_MS) {
      this.closeArmedAt = undefined;
      return { type: "close-view" };
    }
    this.closeArmedAt = nowMs;
    this.notice = "Press q again to close this pane; workers continue";
    return true;
  }

  handleKey(key) {
    this.notice = "";
    if (key !== "q") this.closeArmedAt = undefined;
    if (this.overlay) {
      switch (key) {
        case "\u{1B}":
        case "\u{1B}[O": {
          this.overlay = undefined;
          break;
        }
        case "?":
        case "g": {
          const requested = key === "?" ? "help" : "logs";
          this.overlay = this.overlay === requested ? undefined : requested;
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
        case "u": {
          if (!this.room.accounts?.length && !this.room.quotaError) return false;
          this.quotaMode = this.quotaMode === "collapsed" ? "expanded" : "collapsed";
          break;
        }
        case "w": {
          return this.toggleQuotaWindow();
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
      if (this.preview.kind === "diff") {
        if (key === "j" || key === "\u{1B}[B") return this.moveDiffCursor(1);
        if (key === "k" || key === "\u{1B}[A") return this.moveDiffCursor(-1);
        if (key === "x") return this.toggleDiffMark();
        if (key === "X") return this.clearDiffMarks();
      }
      if (key === "r") {
        if (this.preview.kind === "diff") return false;
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
      const agent = this.renderableAgents()[this.page * this.pageSize + selected];
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
        if (hasTerminalPane(selected)) {
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
      case "d": {
        const selected = this.selectedAgent();
        if (!selected?.resultPath || !this.onDiff) return false;
        this.hasExplicitFocus = true;
        this.focusFollowsLatest = false;
        this.onDiff(selected);
        return true;
      }
      case "m": {
        this.mouseEnabled = !this.mouseEnabled;
        return { type: "mouse-toggle", enabled: this.mouseEnabled };
      }
      case "q": {
        return this.requestClose();
      }
      case "c": {
        const agents = Array.isArray(this.room?.agents) ? this.room.agents : [];
        const { nonCollapsibleIds, nonResolvedIds, resolvedCollapsibleCount } = this.foldState();
        const collapsedFoldedCount = agents.filter(
          (agent) =>
            resolvedCollapsibleCount >= 2 &&
            this.isResolvedCollapsible(agent, nonCollapsibleIds, nonResolvedIds),
        ).length;
        const hiddenFoldedCount = agents.filter((agent) =>
          this.isCollapsibleCompleted(agent, nonCollapsibleIds),
        ).length;
        if (this.completedMode === "collapsed" && hiddenFoldedCount === collapsedFoldedCount) {
          this.completedMode = "expanded";
        } else {
          const nextIndex =
            (COMPLETED_MODES.indexOf(this.completedMode) + 1) % COMPLETED_MODES.length;
          this.completedMode = COMPLETED_MODES[nextIndex];
        }
        this.ensureVisibleFocus();
        this.page = Math.min(this.page, this.pageCount() - 1);
        return true;
      }
      case "w": {
        return this.toggleQuotaWindow();
      }
      case "u": {
        if (!this.room.accounts?.length && !this.room.quotaError) return false;
        this.quotaMode = this.quotaMode === "collapsed" ? "expanded" : "collapsed";
        this.page = Math.min(this.page, this.pageCount() - 1);
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
        this.page = Math.min(this.page, this.pageCount() - 1);
        return { type: "services-toggle", servicesMode: this.servicesMode };
      }
      case "p": {
        this.pinnedId = this.pinnedId === this.focusId ? undefined : this.focusId;
        return true;
      }
      case "n": {
        this.page = (this.page + 1) % this.pageCount();
        return true;
      }
      case "\u{1B}[B":
      case "\u{1B}[A": {
        const agents = this.renderableAgents();
        if (agents.length === 0) return false;
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
        ...(this.room.herdrEndpoint && { herdrEndpoint: this.room.herdrEndpoint }),
        ...(this.room.orcaCoordinatorTerminalId && {
          orcaTerminalHandle: this.room.orcaCoordinatorTerminalId,
        }),
        ...(this.room.orcaEnvironment && { orcaEnvironment: this.room.orcaEnvironment }),
      };
    return this.room.agents.find((agent) => agent.id === this.focusId);
  }

  isCurrentAgent(agent) {
    const pane = this.room.herdrCoordinatorPaneId || this.room.conductor?.herdrPaneId;
    if (pane) return agent.herdrPaneId === pane;
    const orcaTerminal =
      this.room.orcaCoordinatorTerminalId || this.room.conductor?.orcaTerminalHandle;
    if (orcaTerminal) return agent.orcaTerminalHandle === orcaTerminal;
    const session = this.room.conductor?.session?.id;
    return Boolean(session && agent.session?.id === session && hasTerminalPane(agent));
  }

  toggleQuotaWindow() {
    this.quotaWindow = this.quotaWindow === "5h" ? "weekly" : "5h";
    return true;
  }

  setPreview(snapshot) {
    const isNewPreview =
      snapshot?.agentId !== this.preview?.agentId || snapshot?.kind !== this.preview?.kind;
    if (isNewPreview || snapshot?.loading) {
      this.previewOffset = 0;
      this.previewFollow = true;
    }
    this.previewLatestText = snapshot?.text || "";
    this.preview =
      snapshot && !this.previewFollow ? { ...snapshot, text: this.preview.text } : snapshot;
    if (isNewPreview) this.diffCursor = 0;
    if (this.preview?.kind === "diff") {
      this.diffCursor = Math.min(
        this.diffCursor,
        Math.max(0, mapDiffLines(this.preview.text).length - 1),
      );
    }
  }

  scrollPreview(delta) {
    this.previewOffset = Math.max(0, this.previewOffset + delta);
    this.previewFollow = this.preview?.kind === "terminal" && this.previewOffset === 0;
    if (this.previewFollow && this.preview) this.preview.text = this.previewLatestText;
    if (this.preview?.kind === "diff") this.alignDiffCursorToViewport();
  }

  moveDiffCursor(delta) {
    const lineCount = mapDiffLines(this.preview?.text).length;
    if (lineCount === 0) return false;
    const next = Math.max(0, Math.min(lineCount - 1, this.diffCursor + delta));
    if (next === this.diffCursor) return false;
    this.diffCursor = next;
    this.previewFollow = false;
    this.keepDiffCursorVisible();
    return true;
  }

  markAtDiffCursor() {
    if (this.preview?.kind !== "diff") return null;
    const lines = String(this.preview.text || "").split(/\r?\n/u);
    const source = lines[this.diffCursor];
    const mapped = mapDiffLines(this.preview.text)[this.diffCursor];
    if (!mapped?.file || mapped.kind === "meta") return null;
    const side = mapped.kind === "removed" ? "old" : "new";
    const line = side === "old" ? mapped.oldLine : mapped.newLine;
    if (!Number.isSafeInteger(line) || line < 1) return null;
    return {
      file: mapped.file,
      line,
      side,
      text: markText(plain(source || "").slice(1)),
    };
  }

  persistDiffMarks(marks) {
    const agent = this.room.agents.find((member) => member.id === this.preview?.agentId);
    if (!agent || !this.onMarks) return;
    try {
      this.onMarks(agent, marks);
    } catch (error) {
      this.notice = `Could not save marks: ${error.message}`;
    }
  }

  toggleDiffMark() {
    if (this.preview?.marksStale) {
      this.notice = "Stored marks are stale; press X to clear them before marking current lines.";
      return true;
    }
    const mark = this.markAtDiffCursor();
    if (!mark) return false;
    const marks = [...(this.preview.marks || [])];
    const index = marks.findIndex(
      (current) =>
        current.file === mark.file && current.line === mark.line && current.side === mark.side,
    );
    if (index === -1) marks.push(mark);
    else marks.splice(index, 1);
    this.preview = { ...this.preview, marks, marksStale: false };
    this.persistDiffMarks(marks);
    return true;
  }

  clearDiffMarks() {
    if (this.preview?.kind !== "diff") return false;
    this.preview = { ...this.preview, marks: [], marksStale: false };
    this.persistDiffMarks([]);
    return true;
  }

  keepDiffCursorVisible() {
    const row = this.diffCursorRows.get(this.diffCursor);
    const metrics = this.diffPreviewMetrics;
    if (row === undefined || !metrics) return;
    const start = Math.max(0, metrics.rowCount - this.previewOffset - metrics.budget);
    const end = Math.max(0, metrics.rowCount - this.previewOffset);
    if (row < start) {
      this.previewOffset = Math.max(0, metrics.rowCount - metrics.budget - row);
    } else if (row >= end) {
      this.previewOffset = Math.max(0, metrics.rowCount - row - 1);
    }
    this.previewOffset = Math.min(
      this.previewOffset,
      Math.max(0, metrics.rowCount - metrics.budget),
    );
  }

  alignDiffCursorToViewport() {
    const metrics = this.diffPreviewMetrics;
    if (!metrics) return;
    const start = Math.max(0, metrics.rowCount - this.previewOffset - metrics.budget);
    const end = Math.max(0, metrics.rowCount - this.previewOffset);
    const cursorRow = this.diffCursorRows.get(this.diffCursor);
    if (cursorRow === undefined || (cursorRow >= start && cursorRow < end)) return;
    const sourceRows = this.diffCursorRows.entries().toArray();
    const visible = sourceRows.filter(([, row]) => row >= start && row < end);
    if (visible.length > 0) {
      this.diffCursor = cursorRow < start ? visible[0][0] : visible.at(-1)[0];
      return;
    }
    let nearest;
    let nearestDistance = Infinity;
    for (const current of sourceRows) {
      const row = current[1];
      let distance = 0;
      if (row < start) distance = start - row;
      else if (row >= end) distance = row - end + 1;
      if (distance >= nearestDistance) continue;
      nearest = current;
      nearestDistance = distance;
    }
    if (!nearest) return;
    this.diffCursor = nearest[0];
    this.keepDiffCursorVisible();
  }

  handleMouse({ x, y, button, action }) {
    if (action === "scroll-up" || action === "scroll-down") {
      if (this.overlay) {
        this.logOffset = Math.max(0, this.logOffset + (action === "scroll-down" ? 1 : -1));
        return true;
      }
      if (this.preview) {
        const delta = action === "scroll-up" ? 3 : -3;
        this.previewOffset = Math.max(0, this.previewOffset + delta);
        this.previewFollow = this.preview?.kind === "terminal" && this.previewOffset === 0;
        if (this.previewFollow && this.preview) this.preview.text = this.previewLatestText;
        return true;
      }
      const pages = this.pageCount();
      if (pages > 1) {
        const delta = action === "scroll-down" ? 1 : -1;
        const nextPage = Math.max(0, Math.min(pages - 1, this.page + delta));
        if (nextPage !== this.page) {
          this.page = nextPage;
          return true;
        }
      }
      return false;
    }
    const target = hitTest(this.targets, x, y);
    this.hovered = target?.id;
    if (action === "press") this.closeArmedAt = undefined;
    if (action !== "press" || button !== 0 || !target) return false;
    if (target.id?.startsWith("inactive-hidden:")) {
      this.notice = "";
      this.completedMode = "expanded";
      this.page = Math.min(this.page, this.pageCount() - 1);
      return true;
    }
    if (target.agentId) {
      this.notice = "";
      if (this.overlay) {
        this.overlay = undefined;
      }
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
    const isNarrow = width < 68;
    if (this.preview) {
      const bar = actionBar(
        [
          { id: "preview-back", label: "Back", key: "\u{1B}", hint: "Esc", primary: true },
          ...(isNarrow
            ? []
            : [
                {
                  id: "preview-open",
                  label: "Open terminal",
                  key: "o",
                  disabled: this.preview.kind !== "terminal",
                },
                {
                  id: "preview-follow",
                  label: "Follow",
                  key: "r",
                  active: this.previewFollow,
                  disabled: this.preview.kind === "diff",
                },
              ]),
          ...(this.preview.kind === "diff"
            ? [
                { id: "diff-mark", label: "Mark line", key: "x" },
                { id: "diff-clear", label: "Clear marks", key: "X" },
              ]
            : []),
          ...(isNarrow
            ? []
            : [
                { id: "preview-up", label: "Up", key: "\u{1B}[5~", hint: "PgUp" },
                { id: "preview-down", label: "Down", key: "\u{1B}[6~", hint: "PgDn" },
                { id: "preview-previous", label: "Prev", key: "[" },
                { id: "preview-next", label: "Next", key: "]" },
              ]),
        ],
        width,
        { color: this.appearance, hovered: this.hovered, tier: this.tier },
      );
      return bar;
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
        ...(!isNarrow &&
        !this.preview &&
        selected &&
        !this.isCurrentAgent(selected) &&
        hasTerminalPane(selected)
          ? [
              {
                id: "open",
                label: "Open terminal",
                key: "o",
              },
            ]
          : []),
        ...(selected?.resultPath && (!isNarrow || width >= 56)
          ? [{ id: "diff", label: "Diff", key: "d" }]
          : []),
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
        ...(isNarrow ? [] : [{ id: "logs", label: "Log", key: "g" }]),
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
    const detailParts = Array.isArray(right) ? right : null;
    const detail = detailParts ? detailParts.map((part) => plain(part.text)).join(" · ") : right;
    const lines = frame(title, body, width, {
      glyphs,
      color: this.appearance,
      right: detail,
      headerTone,
    });
    if (detailParts && width >= 4 && detail) {
      const tailWidth = Math.min(displayWidth(` ${detail} `), width - 2);
      const tail = fit(` ${detail} `, tailWidth);
      const sepTone = headerTone === "border" || headerTone === "muted" ? "muted" : headerTone;
      const separator = tone(" · ", sepTone, this.appearance);
      const styledParts = detailParts
        .filter((part) => plain(part.text))
        .map((part) => {
          let partTone = headerTone;
          if (part.style && part.style !== headerTone) {
            partTone =
              part.style === "muted" &&
              (!headerTone || headerTone === "border" || headerTone === "muted")
                ? "muted"
                : `${headerTone} ${part.style}`;
          }
          return tone(plain(part.text), partTone, this.appearance);
        });
      const padTone = headerTone === "muted" ? "border" : headerTone;
      const padding = tone(" ", padTone, this.appearance);
      const styledTail = fitStyled(`${padding}${styledParts.join(separator)}${padding}`, tailWidth);
      lines[0] = lines[0].replace(tone(tail, headerTone, this.appearance), () => styledTail);
    }
    return lines;
  }

  panelDividerRow(width, title = "", right = "", headerTone) {
    const glyphs = {
      ...glyphSet(this.tier),
      topLeft: this.tier === "ascii" ? "+" : "├",
      topRight: this.tier === "ascii" ? "+" : "┤",
    };
    return frame(title, [], width, {
      glyphs,
      color: this.appearance,
      right,
      headerTone,
    })[0];
  }

  footerRuleLine(width, right = "") {
    const glyphs = glyphSet(this.tier);
    const cleanRight = plain(right).trim();
    if (!cleanRight) {
      return tone(glyphs.horizontal.repeat(width), "border", this.appearance);
    }
    const rightText = ` ${cleanRight}`;
    const rightCells = displayWidth(rightText);
    if (rightCells >= width) {
      return tone(truncateDisplay(cleanRight, width, this.tier), "muted", this.appearance);
    }
    const ruleWidth = Math.max(0, width - rightCells);
    return (
      tone(glyphs.horizontal.repeat(ruleWidth), "border", this.appearance) +
      tone(rightText, "muted", this.appearance)
    );
  }

  overlayLines(width, height = this.height - 5) {
    let title = this.overlay === "help" ? "Keyboard shortcuts" : "Room log";
    const pad = width >= 6 ? " " : "";
    const interior = Math.max(1, width - 6);
    let wrapped;
    if (this.overlay === "help") {
      const helpRows = [
        "↑/↓ or 1–9  Select agent",
        "0           Return to the current session's live chat",
        "Enter       Preview selected agent's screen without typing into it",
        "d           Preview selected agent's worker changes read-only",
        "Diff only   j/k or ↑/↓ move the line cursor; x toggles a line mark; X clears that member's marks",
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
        ...(this.chiefEnabled
          ? [
              "Tab         Switch to the machine-wide Chief overview",
              "Backspace   Return to the Chief overview",
            ]
          : []),
        "? or Esc    Close this reference",
        this.confirmClose
          ? "q q/Ctrl-C  Close this pane (q twice); workers continue"
          : "q or Ctrl-C Quit the display; workers continue",
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
    const count = Math.max(1, height - 2);
    const start = Math.max(0, Math.min(this.logOffset, wrapped.length - count));
    const visible = wrapped.slice(start, start + count).map((line) => `${pad}${line}`);
    while (visible.length < count) visible.push("");
    const rightHint = width >= 46 ? "Esc back · ↑/↓ scroll" : "";
    return this.panel(title, visible, width, rightHint, "mdSection").slice(0, Math.max(1, height));
  }

  quotaLines(width) {
    if (this.room.quotaError) return [` Quota unavailable: ${plain(this.room.quotaError)}`];
    const accounts = this.room.accounts || [];
    return quotaRows(accounts, Math.max(10, width - 5), this.tier, this.appearance, this.now()).map(
      (line) => ` ${line}`,
    );
  }

  updateSummaryText(budget = 80) {
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
        if (upd.dirty) {
          const fullDirty = `↑ ${count} new ${plural} on origin/main (working tree dirty)`;
          return displayWidth(fullDirty) <= budget
            ? fullDirty
            : `↑ ${count} new ${plural} (dirty tree)`;
        }
        const full = `↑ ${count} new ${plural} on origin/main · click to update`;
        return displayWidth(full) <= budget ? full : `↑ ${count} new ${plural} · click to update`;
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
    return `${badge}  ${truncateDisplay(this.updateSummaryText(budget), budget, this.tier)}`;
  }

  updateBlockLines(innerWidth) {
    if (!this.showUpdateBar() || this.height < 14) return [];
    return [this.updateLine(innerWidth)];
  }

  quotaSummaryLines(boxBodyWidth) {
    const chevron = disclosure("", false, this.tier);
    const chevronWidth = displayWidth(chevron);
    const rightPad = boxBodyWidth >= 10 ? " " : "";
    const stripWidth = Math.max(1, boxBodyWidth - chevronWidth - 5 - rightPad.length);
    this.quotaWindowOffset = stripWidth + 2;
    const appendChevron = (line, isFirst) => {
      const fitted = fitStyled(` ${line}`, stripWidth + 1);
      if (!isFirst) return `${fitted}${" ".repeat(chevronWidth + 4 + rightPad.length)}`;
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
      return `${fitted} ${period} ${mark}${rightPad}`;
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
        let accountLabel;
        if (scope) {
          const head = brand || (label ? account.provider : "");
          const tail = label || (brand ? "" : account.provider || account.short || account.id);
          if (head && tail) {
            accountLabel = `${head}${brand && head === brand ? brandGap(brand) : " "}${tail}`;
          } else {
            accountLabel = head || tail || "";
          }
        } else {
          const baseLabel = quotaAccountLabel(account, this.tier);
          if (baseLabel && label) {
            accountLabel = `${baseLabel}${WIDE_NERD_BRANDS.has(baseLabel) ? brandGap(baseLabel) : " "}${label}`;
          } else {
            accountLabel = baseLabel || label;
          }
        }
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
      let stripMeters = meters;
      if (
        meters.length >= 4 &&
        meterStrip(icon, meters, stripWidth, { tier: this.tier }).length > 1
      ) {
        const tier1 = meters.map((meter) => ({
          ...meter,
          label: meter.label.replaceAll("Claude/GPT", "CL/GPT"),
        }));
        if (meterStrip(icon, tier1, stripWidth, { tier: this.tier }).length === 1) {
          stripMeters = tier1;
        } else {
          const tier2 = meters.map((meter) => ({
            ...meter,
            label: meter.label
              .replaceAll("Claude/GPT", "C/G")
              .replaceAll("Gemini", "Gem")
              .replaceAll("fable", "fab"),
          }));
          if (meterStrip(icon, tier2, stripWidth, { tier: this.tier }).length === 1) {
            stripMeters = tier2;
          }
        }
      }
      rawLines.push(
        ...meterStrip(icon, stripMeters, stripWidth, {
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
    return `${badge}  ${truncateDisplay(summary, budget, this.tier)}`;
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

  folderHeaderLine(folder, count, innerWidth, summary = null) {
    return sectionHeading(
      folder ? shortFolder(folder) : "workspace",
      `${count} ${count === 1 ? "agent" : "agents"}`,
      innerWidth,
      {
        prefix: toAsciiTree("│ ", this.tier),
        color: this.appearance,
        tier: this.tier,
        separator: summary ? "  ·  " : " · ",
        detailParts: summary,
      },
    );
  }

  nonCollapsibleAgentIds() {
    const agents = Array.isArray(this.room?.agents) ? this.room.agents : [];
    const seeds = new Set();
    for (const agent of agents) {
      const isOwnNonCollapsible =
        !isInactive(agent) ||
        agent.id === this.pinnedId ||
        agentProcessInfo(agent, this.room).count > 0 ||
        (agent.id === this.focusId && this.hasExplicitFocus);
      if (isOwnNonCollapsible) seeds.add(agent.id);
    }
    return propagateUpAncestors(agents, seeds);
  }

  nonResolvedAgentIds(nonCollapsibleIds) {
    const agents = Array.isArray(this.room?.agents) ? this.room.agents : [];
    const blockedIds = nonCollapsibleIds || this.nonCollapsibleAgentIds();
    const seeds = new Set(blockedIds);
    for (const agent of agents) {
      if (!RESOLVED_STATES.has(memberDisplayState(agent))) {
        seeds.add(agent.id);
      }
    }
    return propagateUpAncestors(agents, seeds);
  }

  foldState() {
    const agents = Array.isArray(this.room?.agents) ? this.room.agents : [];
    const nonCollapsibleIds = this.nonCollapsibleAgentIds();
    const nonResolvedIds = this.nonResolvedAgentIds(nonCollapsibleIds);
    const resolvedCollapsibleCount = agents.filter((agent) => !nonResolvedIds.has(agent.id)).length;
    return { nonCollapsibleIds, nonResolvedIds, resolvedCollapsibleCount };
  }

  isCollapsibleCompleted(agent, nonCollapsibleIds) {
    if (!agent) return false;
    const blockedIds = nonCollapsibleIds || this.nonCollapsibleAgentIds();
    return !blockedIds.has(agent.id);
  }

  isResolvedCollapsible(agent, nonCollapsibleIds, nonResolvedIds) {
    if (!agent) return false;
    const blocked = nonCollapsibleIds || this.nonCollapsibleAgentIds();
    const unresolved = nonResolvedIds || this.nonResolvedAgentIds(blocked);
    return !blocked.has(agent.id) && !unresolved.has(agent.id);
  }

  isFoldedAgent(agent, nonCollapsibleIds, resolvedCollapsibleCount, nonResolvedIds) {
    if (!agent) return false;
    if (this.completedMode === "hidden") {
      return this.isCollapsibleCompleted(agent, nonCollapsibleIds);
    }
    if (this.completedMode === "collapsed") {
      return (
        resolvedCollapsibleCount >= 2 &&
        this.isResolvedCollapsible(agent, nonCollapsibleIds, nonResolvedIds)
      );
    }
    return false;
  }

  renderableAgents() {
    const agents = Array.isArray(this.room?.agents) ? this.room.agents : [];
    const { nonCollapsibleIds, nonResolvedIds, resolvedCollapsibleCount } = this.foldState();
    return agents.filter(
      (agent) =>
        !this.isFoldedAgent(agent, nonCollapsibleIds, resolvedCollapsibleCount, nonResolvedIds),
    );
  }

  pageCount() {
    return Math.max(1, Math.ceil(this.renderableAgents().length / this.pageSize));
  }

  focusCardLines(focused, innerWidth, remainingRows, startRow) {
    if (!focused || remainingRows <= 0) return [];
    const isPinned = Boolean(this.pinnedId && focused.id === this.pinnedId);
    const isCardCollapsed =
      this.completedMode === "collapsed" && this.isCollapsibleCompleted(focused);
    const markdown = extractAgentFocusMarkdown(focused, { isPinned, isCardCollapsed });
    const processInfo = agentProcessInfo(focused, this.room);
    if (!markdown && processInfo.count === 0) return [];

    const agentLabel = dedupSlotAgentName(shortAgentName(focused), memberModelInfo(focused).model);
    const titlePrefix = isPinned ? "Pinned" : "Focus";
    if (remainingRows < 3) {
      const compactTag = `[${titlePrefix} · ${agentLabel}]`;
      const styledTag = tone(compactTag, isPinned ? "warning bold" : "mdSection", this.appearance);
      const rawLast = markdown.split("\n").at(-1) || "";
      const detailSummary = stripInlineMarkdown(rawLast).replace(
        /^(?:Task|Asked|Question):\s*/u,
        "",
      );
      const processSummary = agentProcessSummary(focused, this.room);
      const summary = detailSummary || processSummary?.text || "";
      const compactSummary = processSummary
        ? `${summary}${detailSummary ? ` · ${processSummary.compactText}` : ""}`
        : summary;
      const budget = Math.max(1, innerWidth - displayWidth(`${compactTag} `));
      return [`${styledTag} ${fit(compactSummary, budget)}`];
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
    const bodyCapacity = Math.max(1, Math.min(24, remainingRows - 2));
    const rendered = markdown
      ? renderMarkdown(markdown, bodyWidth, {
          color: this.appearance,
          tier: this.tier,
        }).filter((line, idx, arr) => line !== "" || (idx > 0 && idx < arr.length - 1))
      : [];
    const hasRunning = processInfo.count > 0;
    const detailLimit = Math.min(4, Math.max(0, bodyCapacity - (hasRunning ? 2 : 0)));
    let visible = rendered.slice(0, detailLimit);
    if (rendered.length > detailLimit && visible.length > 0 && bodyWidth >= 4) {
      const ellipsis = this.tier === "ascii" ? "..." : "…";
      const cutWidth = Math.max(1, bodyWidth - displayWidth(ellipsis));
      const truncatedLast = fitStyled(visible.at(-1), cutWidth).trimEnd();
      visible = [
        ...visible.slice(0, -1),
        `${truncatedLast}${tone(ellipsis, "muted", this.appearance)}`,
      ];
    }
    if (hasRunning && visible.length < bodyCapacity) {
      visible.push(tone("Running", "mdSection", this.appearance));
      const runningCapacity = bodyCapacity - visible.length;
      const availableProcessRows = Math.max(0, runningCapacity);
      const processRows = processInfo.processes.slice(0, 20);
      const total = processInfo.count;
      const canShowMore = total > availableProcessRows;
      const visibleProcessCount = Math.min(
        20,
        processRows.length,
        canShowMore && availableProcessRows > 0 ? availableProcessRows - 1 : availableProcessRows,
      );
      visible.push(
        ...processRows
          .slice(0, visibleProcessCount)
          .map((process) => runningProcessLine(process, this.appearance)),
      );
      const omitted = Math.max(0, total - visibleProcessCount);
      if (omitted > 0 && visible.length < bodyCapacity) {
        const ellipsis = this.tier === "ascii" ? "..." : "…";
        visible.push(tone(`${ellipsis}and ${omitted} more`, "muted", this.appearance));
      }
    }
    const paddedBody = visible.map((row) => `${pad}${truncateStyled(row, bodyWidth, this.tier)}`);
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
    let rows;
    if (preview.kind === "diff") rows = this.diffPreviewRows(preview, textWidth);
    else if (preview.kind === "terminal")
      rows = String(preview.text || "")
        .split(/\r?\n/u)
        .flatMap((line) => wrapText(plain(line), textWidth));
    else
      rows = renderMarkdown(preview.text || "", textWidth, {
        color: this.appearance,
        tier: this.tier,
      });
    this.previewOffset = Math.min(this.previewOffset, Math.max(0, rows.length - budget));
    if (preview.kind === "diff" && this.previewFollow) {
      this.previewOffset = Math.max(0, rows.length - budget);
    } else if (this.previewFollow) {
      const response =
        preview.kind === "activity"
          ? rows.findIndex((line) => /^Response:(?:\s|$)/u.test(plain(line).trim()))
          : -1;
      const start = Math.max(0, rows.length - budget);
      this.previewOffset = response >= 0 ? Math.max(0, start - response) : 0;
    }
    if (preview.kind === "diff") {
      this.diffPreviewMetrics = { rowCount: rows.length, budget };
      this.alignDiffCursorToViewport();
    } else {
      this.diffPreviewMetrics = null;
      this.diffCursorRows = new Map();
    }
    const end = Math.max(0, rows.length - this.previewOffset);
    const body = rows.slice(Math.max(0, end - budget), end).map((line) => `${pad}${line}`);
    if (preview.kind === "diff" && preview.loading)
      body.unshift(`${pad}${tone("Loading...", "muted", this.appearance)}`);
    while (body.length < budget) body.push("");
    let heading = "Recorded activity";
    if (preview.kind === "terminal") heading = "Live screen · read only";
    else if (preview.kind === "diff") heading = "Changes · read only";
    let state;
    if (preview.loading && preview.kind !== "diff")
      state = tone("Loading...", "muted", this.appearance);
    else if (preview.error) state = tone(preview.error, "error", this.appearance);
    else if (preview.kind === "diff") {
      state = tone(heading, "muted", this.appearance);
      if (preview.stale) state += ` ${tone("· stale", "stale", this.appearance)}`;
      state += ` ${tone(`· ${(preview.marks || []).length} marked`, "warning", this.appearance)}`;
      if (preview.marksStale) state += ` ${tone("· marks stale", "warning", this.appearance)}`;
    } else state = tone(heading, "muted", this.appearance);
    let rightHint = "";
    if (width >= 44) {
      if (preview.kind === "diff") {
        if (width >= 62) {
          const arrows = this.tier === "ascii" ? "arrows" : "↑/↓";
          rightHint = `j/k or ${arrows} move · Esc back · [ ] switch`;
        } else rightHint = "j/k move · Esc · [ ]";
      } else rightHint = "Esc back · [ ] switch";
    }
    return this.panel(
      plain(preview.title || "Agent"),
      [`${pad}${state}`, ...body],
      Math.max(1, width),
      rightHint,
      "mdSection",
    ).slice(0, height);
  }

  diffPreviewRows(preview, width) {
    const rows = [];
    this.diffCursorRows = new Map();
    if (preview.loading) return rows;
    const files = Array.isArray(preview.files) ? preview.files : [];
    if (files.length > 0) {
      rows.push(tone("Changed files", "muted bold", this.appearance));
      for (const file of files) {
        const added = `+${file.added ?? "?"}`;
        const removed = `-${file.removed ?? "?"}`;
        const counts = `${tone(added, "accepted", this.appearance)} ${tone(removed, "failed", this.appearance)}`;
        const pathWidth = Math.max(1, width - displayWidth(counts) - 1);
        const pathLines = wrapText(plain(file.path), pathWidth);
        rows.push(
          fitStyled(`${tone(pathLines[0] || "", "muted bold", this.appearance)} ${counts}`, width),
        );
        for (const line of pathLines.slice(1))
          rows.push(fitStyled(`  ${tone(line, "muted bold", this.appearance)}`, width));
      }
      rows.push("");
    }
    const diffLines = String(preview.text || "").split(/\r?\n/u);
    const mappedLines = mapDiffLines(preview.text);
    const marks = Array.isArray(preview.marks) ? preview.marks : [];
    const gutter = DIFF_GUTTER[this.tier] || DIFF_GUTTER.unicode;
    const gutterWidth = Math.min(3, Math.max(0, width - 1));
    const sourceWidth = Math.max(1, width - gutterWidth);
    for (const [index, rawLine] of diffLines.entries()) {
      const line = plain(rawLine);
      const mapped = mappedLines[index] || { file: null, kind: "meta" };
      let role = "";
      if (mapped.kind === "added") {
        role = "accepted";
      } else if (mapped.kind === "removed") {
        role = "failed";
      } else if (
        line.startsWith("diff --git ") ||
        line.startsWith("index ") ||
        line.startsWith("--- ") ||
        line.startsWith("+++ ") ||
        line.startsWith("new file mode ") ||
        line.startsWith("deleted file mode ") ||
        line.startsWith("old mode ") ||
        line.startsWith("new mode ") ||
        line.startsWith("@@")
      ) {
        role = "muted bold";
      }
      const side = mapped.kind === "removed" ? "old" : "new";
      const location = side === "old" ? mapped.oldLine : mapped.newLine;
      const marked =
        location !== null &&
        location !== undefined &&
        marks.some(
          (mark) => mark.file === mapped.file && mark.line === location && mark.side === side,
        );
      const isCursor = index === this.diffCursor;
      const cursorGlyph = isCursor ? tone(gutter.cursor, "selected", this.appearance) : " ";
      const markGlyph = marked
        ? tone(gutter.mark, preview.marksStale ? "stale" : "warning bold", this.appearance)
        : " ";
      const prefix = `${cursorGlyph}${markGlyph} `;
      const wrapped = wrapText(line, sourceWidth);
      this.diffCursorRows.set(index, rows.length);
      for (const [partIndex, part] of wrapped.entries()) {
        const rowPrefix = partIndex === 0 ? prefix : " ".repeat(gutterWidth);
        const styled = tone(part, isCursor ? "selected" : role, this.appearance);
        rows.push(fitStyled(`${rowPrefix}${styled}`, width));
      }
    }
    return rows;
  }

  renderSidebar(width) {
    width = Math.max(1, Math.floor(width) || 80);
    this.renderWidth = width;
    this.targets = [];
    if (this.height < 8)
      return this.marginLines(
        this.panel("ork", ["Resize terminal to at least 8 rows"], width),
        width,
      );

    const now = this.now();
    const room = this.room;
    const lead = room.conductor || {};
    const size = this.pageSizeFor();
    const { nonCollapsibleIds, nonResolvedIds, resolvedCollapsibleCount } = this.foldState();
    const renderable = room.agents.filter(
      (agent) =>
        !this.isFoldedAgent(agent, nonCollapsibleIds, resolvedCollapsibleCount, nonResolvedIds),
    );
    const pages = Math.max(1, Math.ceil(renderable.length / size));
    this.page = Math.min(this.page, pages - 1);
    const selected = renderable.slice(this.page * size, (this.page + 1) * size);
    const phase = phaseLabel;
    const roleOf = (member) =>
      plain(
        member?.progress?.role ||
          member?.workforceRole ||
          (member === lead ? "" : member?.role) ||
          "",
      ).trim();
    const style = (text, token) => tone(text, token, this.appearance);
    const separator = (text) => style(text, "leadSeparator");
    const model = (member, isStyled = false) => {
      const data = member.progress || member;
      const { model: modelName, effort } = memberModelInfo(member);
      const provenance = settingsProvenanceLabel(member);
      const brand =
        providerMark(modelName, this.tier) ||
        providerMark(member.engine || data.harness, this.tier);
      const gap = brand ? brandGap(brand) : "";
      if (isStyled) {
        return `${brand ? `${colorProviderMarks(brand, this.appearance)}${gap}` : ""}${style(`${modelName || "default model"}${provenance}`, "leadModel")}${effort && effort !== "—" ? `${separator(" / ")}${style(effort, "leadEffort")}` : ""}`;
      }
      return `${brand ? `${brand}${gap}` : ""}${modelName || "default model"}${provenance}${effort && effort !== "—" ? ` / ${effort}` : ""}`;
    };
    const innerWidth = Math.max(1, width - 2);
    const leadFolder = groupFolder(lead, room);
    const leadRole = roleOf(lead);
    const leadRoleBadge = leadRole ? style(` [${leadRole}]`, "leadBranch bold") : "";
    const leadIcon = this.tier === "nerd" ? "\u{F06A9} " : "";
    const identityColor = lead.color ?? lead.progress?.color;
    const identityTone = [31, 32, 33, 34, 35, 36].includes(Number(identityColor))
      ? `identity${identityColor}`
      : "identity36";
    const leadTitle =
      lead.name || lead.progress?.name
        ? style(`${leadIcon}${shortAgentName(lead)}`, identityTone)
        : `${style(leadIcon, identityTone)}${style("Coordinator", "bold")}`;
    const leadBranch = plain(
      lead.branch || lead.progress?.branch || lead.worktree?.branch || "",
    ).trim();
    const leadEngine = plain(lead.engine || "").trim();
    const allShareLead =
      room.agents.length > 0 && selected.every((agent) => groupFolder(agent, room) === leadFolder);
    const leadLocation =
      room.agents.length === 0 ||
      allShareLead ||
      selected.every((agent) => groupFolder(agent, room) !== leadFolder)
        ? `${separator(" · ")}${style(shortFolder(leadFolder), "bold")}`
        : "";
    const leadMetaParts = [
      `${leadTitle}${leadRoleBadge}${leadLocation}${leadBranch ? style(` (${leadBranch})`, "leadBranch") : ""}`,
      ...(leadEngine ? [style(leadEngine, "leadEngine")] : []),
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
        ? truncateDisplay(leadMissionLine, missionBudget, this.tier)
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
    const leadLeft = leadMetaParts.join(separator(" · "));
    const leadRight = `${style(statusGlyph(lead, now, this.tier), stageTone)} ${model(lead, true)}${separator(" | ")}${style(phase(lead), stageTone)}${leadSuffix}`;
    const leftWidth = displayWidth(plain(leadLeft));
    const rightWidth = displayWidth(plain(leadRight));
    const leadHeaderBudget = innerWidth - 4;
    let leadLines;
    if (lead.status === "session unavailable" && room.agents.length > 0) {
      leadLines = ["Coordinator session unavailable"];
      if (room.objective) leadLines.push(plain(room.objective));
    } else if (innerWidth >= 60 && leftWidth + 3 + rightWidth <= leadHeaderBudget) {
      const headerGap = " ".repeat(Math.max(3, leadHeaderBudget - leftWidth - rightWidth));
      leadLines = [
        `${leadLeft}${headerGap}${leadRight}`,
        ...(leadMissionLine ? [renderedMission] : []),
      ];
    } else {
      leadLines = [leadLeft, leadRight, ...(leadMissionLine ? [renderedMission] : [])];
    }
    leadLines = leadLines.map((line) => ` ${line}`);
    const maxAgents = room.swarm?.maxAgents ?? 64;
    const hasAgentTree = room.agents.length > 0 && (!this.overlay || this.overlay === "activity");
    const hasQuota = Boolean(room.accounts?.length || room.quotaError);
    const hasHerdrPaneHeader = Boolean(
      this.inHerdr || room.herdrViewPaneId || room.herdrCoordinatorPaneId,
    );
    const activityBadge = swarmActivityBadge(room, maxAgents, this.tier, innerWidth);
    const lifecycleSuffix =
      room.lifecycle && room.lifecycle !== "active" ? ` · ${room.lifecycle}` : "";
    const swarmTitle =
      (room.title === "New swarm" ? "Swarm" : `Swarm · ${plain(room.title || room.id)}`) +
      lifecycleSuffix;
    const topCardTitle = `${hasHerdrPaneHeader ? "Coordinator" : swarmTitle}${chiefHintLabel(room, lead, this.tier)}`;
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
    if (room.herdrCoordinatorPaneId || room.orcaCoordinatorTerminalId || hasTerminalPane(lead))
      this.addTargets([
        {
          id: "current-session",
          agentId: "conductor",
          x: 1,
          y: 1,
          width: innerWidth,
          height: lines.length,
        },
      ]);
    if (room.agents.length > 0 && (!this.overlay || this.overlay === "activity")) {
      const isCollapsibleCompleted = (agent) =>
        this.isCollapsibleCompleted(agent, nonCollapsibleIds);
      const childCountById = new Map();
      for (const agent of room.agents) {
        if (agent.parent && agent.parent !== "conductor") {
          childCountById.set(agent.parent, (childCountById.get(agent.parent) || 0) + 1);
        }
      }
      let activePreviewAgentId = "";
      if (this.overlay === "activity") {
        activePreviewAgentId = this.activityId || this.focusId;
      } else if (this.preview) {
        activePreviewAgentId = this.preview.agentId || this.focusId;
      }
      const previewSource = activePreviewAgentId
        ? room.agents.filter((agent) => agent.id === activePreviewAgentId)
        : [];
      const isFocusedView = Boolean(this.preview || this.overlay === "activity");
      const visibleAgents = isFocusedView && previewSource.length > 0 ? previewSource : selected;
      const foldedAgents = isFocusedView
        ? []
        : room.agents.filter((agent) =>
            this.isFoldedAgent(agent, nonCollapsibleIds, resolvedCollapsibleCount, nonResolvedIds),
          );
      const folderGroups = new Map();
      const ensureFolderGroup = (folder) => {
        if (!folderGroups.has(folder)) folderGroups.set(folder, []);
        return folderGroups.get(folder);
      };
      for (const [offset, agent] of visibleAgents.entries()) {
        const pageIndex = isFocusedView ? room.agents.findIndex((a) => a.id === agent.id) : offset;
        const folder = groupFolder(agent, room);
        ensureFolderGroup(folder).push({
          agent,
          index: pageIndex >= 0 ? pageIndex : offset,
        });
      }
      const hasHiddenSummary = !isFocusedView && this.page === pages - 1 && foldedAgents.length > 0;
      if (visibleAgents.length === 0 && hasHiddenSummary) {
        ensureFolderGroup(leadFolder);
      }
      const gap = "  ";
      const lastFolder = folderGroups.keys().toArray().at(-1);
      const hasWorktrees = visibleAgents.some((agent) => worktreeBadge(agent, room));
      const hasAllSharingLead =
        folderGroups.size === 1 && folderGroups.has(leadFolder) && !hasWorktrees;
      for (const [folder, entries] of folderGroups) {
        if (!hasAllSharingLead || hasHerdrPaneHeader) {
          const folderAgents =
            entries.length > 0 ? entries.map(({ agent }) => agent) : foldedAgents;
          const parts = hasHerdrPaneHeader ? activityParts(folderAgents, this.tier) : [];
          const folderSummary = parts.length > 0 ? parts : null;
          lines.push(this.folderHeaderLine(folder, folderAgents.length, innerWidth, folderSummary));
        }
        const hasCollapsedRows =
          !isFocusedView &&
          this.completedMode === "collapsed" &&
          entries.some(({ agent }) => isCollapsibleCompleted(agent));
        const columns =
          !isFocusedView && !hasCollapsedRows && innerWidth >= 100 && entries.length > 1 ? 2 : 1;
        const cardWidth =
          columns === 2 ? Math.max(24, Math.floor((innerWidth - gap.length) / 2)) : innerWidth;
        const isLastFolder = folder === lastFolder;
        const hasFollowingSection = !isLastFolder;
        const rails = folderTreeRails(
          entries,
          this.tier,
          columns,
          hasFollowingSection || (isLastFolder && hasHiddenSummary),
          cardWidth,
        );
        const inGroup = new Set(entries.map(({ agent: a }) => a.id));
        const groupParent = (member) =>
          member.parent && member.parent !== "conductor" && inGroup.has(member.parent)
            ? member.parent
            : "conductor";
        const cards = entries.map(({ agent, index }, entryIndex) => {
          const { midPrefix, continuationPrefix } = rails[entryIndex];
          const prefix =
            isLastFolder && hasHiddenSummary && entryIndex === entries.length - 1
              ? toAsciiTree(midPrefix.replace("└─", "├─"), this.tier)
              : midPrefix;
          const wfRole = roleOf(agent);
          const childCount = childCountById.get(agent.id) || 0;
          let roleBadge = "";
          if (childCount > 0) {
            roleBadge =
              !wfRole || wfRole === "lead"
                ? ` [lead · ${childCount}]`
                : ` [${wfRole} · ${childCount} sub]`;
          } else if (wfRole) {
            roleBadge = ` [${wfRole}]`;
          }
          const isFocused = agent.id === this.focusId;
          const isPinned = agent.id === this.pinnedId;
          const pointer = this.tier === "ascii" ? ">" : "▸";
          const focusGlyph = isFocused ? `${pointer} ` : "  ";
          const glyph = statusGlyph(agent, now, this.tier);
          const chevron = disclosure("", isFocusedView, this.tier);
          const currentBadge = this.isCurrentAgent(agent) ? " · This chat" : "";
          const locationBadge = worktreeBadge(agent, room);
          const taskText =
            cleanProgressTask(agent) || plain(agent.objective || "Awaiting assignment");
          const { model: modelName, effort } = memberModelInfo(agent);
          const rawAgentName = shortAgentName(agent);
          const folderName = shortFolder(folder);
          const displayAgentName =
            rawAgentName === folderName || rawAgentName === `${agent.engine}:${folderName}`
              ? plain(agent.engine || "agent")
              : dedupSlotAgentName(rawAgentName, modelName);
          const subCtx = subfolderContext(agent, room, folder);
          const normSubCtx = subCtx.toLowerCase().replaceAll(/[^a-z0-9]/gu, "");
          const normModelEffort = `${modelName}${effort}`
            .toLowerCase()
            .replaceAll(/[^a-z0-9]/gu, "");
          let subBadge = "";
          if (normSubCtx && !normModelEffort.includes(normSubCtx)) {
            subBadge = roleBadge ? ` · ${subCtx}` : ` [${subCtx}]`;
          }
          const parent = room.agents.find((member) => member.id === agent.parent);
          const isParentInGroup = agent.parent && inGroup.has(agent.parent);
          const parentBadge =
            agent.parent && agent.parent !== "conductor" && !isParentInGroup
              ? ` ↳ ${parent ? shortAgentName(parent) : plain(agent.parent)}`
              : "";

          const isHovered = this.hovered === `agent:${agent.id}`;
          const isCollapsed =
            !isFocusedView && this.completedMode === "collapsed" && isCollapsibleCompleted(agent);
          const statusTone = toneForStatus(agent);
          const pinBadge = isCollapsed || !isPinned ? "" : " · PIN";
          const leftBadges = `${roleBadge}${subBadge}${locationBadge ? ` · ${locationBadge}` : ""}${pinBadge}${currentBadge}${parentBadge}`;
          let nameTone = isCollapsed ? "muted" : `${statusTone} bold`;
          if (isHovered) {
            nameTone = "buttonHover";
          } else if (isFocused || (!isCollapsed && isPinned)) {
            nameTone = "heading";
          }
          const badgeTone = isCollapsed || !isFocused ? "muted" : "heading";
          let rightTone = isFocused ? `${statusTone} bold` : "muted";
          if (isCollapsed && isHovered) {
            rightTone = "buttonHover";
          }
          const styledPrefix = tone(prefix, "border", this.appearance);
          const styledStatusGlyph = tone(glyph, statusTone, this.appearance);
          const styledName = tone(displayAgentName, nameTone, this.appearance);
          const leftRequired = `${styledPrefix}${focusGlyph}${styledStatusGlyph} ${index + 1} ${styledName}`;
          const leftOptional = leftBadges ? tone(leftBadges, badgeTone, this.appearance) : "";
          const elapsed = isCollapsed ? "" : progressSuffix(agent, now);
          const shortRightRaw = `${model(agent)} · ${agentPhaseLabel(agent, cardWidth)}`;
          const rightRaw = `${shortRightRaw}${elapsed}`;
          const chevronTone = isCollapsed && isHovered ? "buttonHover" : "muted";
          const styledChevron = chevron ? ` ${tone(chevron, chevronTone, this.appearance)}` : "";
          const chevronCells = chevron ? 1 + displayWidth(chevron) : 0;

          const fitHeaderRow = (leftStyled, leftCells, metaPlain) => {
            const metaCells = displayWidth(metaPlain);
            if (leftCells + 1 + metaCells + chevronCells <= cardWidth) {
              const gapSpaces = " ".repeat(cardWidth - leftCells - metaCells - chevronCells);
              return `${leftStyled}${gapSpaces}${tone(metaPlain, rightTone, this.appearance)}${styledChevron}`;
            }
            return null;
          };

          const fullLeft = `${leftRequired}${leftOptional}`;
          const fullLeftCells = displayWidth(plain(fullLeft));
          const reqLeftCells = displayWidth(plain(leftRequired));
          let row1 =
            fitHeaderRow(fullLeft, fullLeftCells, rightRaw) ||
            (elapsed ? fitHeaderRow(fullLeft, fullLeftCells, shortRightRaw) : null);

          if (!row1 && leftOptional) {
            const noBadgeFit = fitHeaderRow(leftRequired, reqLeftCells, shortRightRaw);
            if (noBadgeFit) {
              const availOptional =
                cardWidth - reqLeftCells - 1 - displayWidth(shortRightRaw) - chevronCells;
              if (availOptional >= 4) {
                const clippedBadge = truncateDisplay(leftBadges, availOptional, this.tier);
                const combinedLeft = `${leftRequired}${tone(clippedBadge, badgeTone, this.appearance)}`;
                row1 =
                  fitHeaderRow(combinedLeft, displayWidth(plain(combinedLeft)), shortRightRaw) ||
                  noBadgeFit;
              } else {
                row1 = noBadgeFit;
              }
            }
          }

          if (!row1) {
            const availRight = cardWidth - reqLeftCells - 1 - chevronCells;
            const minRight = displayWidth(this.tier === "ascii" ? "..." : "…") + 1;
            if (availRight >= minRight) {
              const clippedRight = truncateDisplay(shortRightRaw, availRight, this.tier);
              const gapSpaces = Math.max(
                1,
                cardWidth - reqLeftCells - displayWidth(clippedRight) - chevronCells,
              );
              row1 = `${leftRequired}${" ".repeat(gapSpaces)}${tone(clippedRight, rightTone, this.appearance)}${styledChevron}`;
            } else {
              const availLeft = Math.max(1, cardWidth - chevronCells);
              const clippedLeft = truncateStyled(leftRequired, availLeft, this.tier);
              const gapSpaces = Math.max(
                0,
                cardWidth - displayWidth(plain(clippedLeft)) - chevronCells,
              );
              row1 = `${clippedLeft}${" ".repeat(gapSpaces)}${styledChevron}`;
            }
          }

          if (isCollapsed) return [row1];

          const styledContinuation = tone(continuationPrefix, "border", this.appearance);
          const hasVisibleChildBelow =
            columns === 1 &&
            entryIndex + 1 < entries.length &&
            groupParent(entries[entryIndex + 1].agent) === agent.id &&
            !rails[entryIndex + 1].hasDepthOverflow;
          const bodyIndent = hasVisibleChildBelow
            ? tone(toAsciiTree("│ ", this.tier), "border", this.appearance)
            : "  ";
          const availBody = Math.max(
            1,
            cardWidth - displayWidth(plain(continuationPrefix)) - displayWidth(plain(bodyIndent)),
          );
          let row2Content;
          const rawErr = plain(agent.error || agent.dispatchError || "").trim();
          const hasRealError = Boolean(rawErr && !/^failed\.?$/iu.test(rawErr));
          if (agent.status === "blocked" && agent.question) {
            const questionText = truncateDisplay(
              `Question: ${plain(agent.question).trim()}`,
              availBody,
              this.tier,
            );
            row2Content = tone(questionText, "warning bold", this.appearance);
          } else if (hasRealError) {
            const errorText = truncateDisplay(`Error: ${rawErr}`, availBody, this.tier);
            row2Content = tone(errorText, "error bold", this.appearance);
          } else {
            const agentRunning = isExecuting(agent);
            const spinnerWidth = agentRunning ? 2 : 0;
            const processSummary = agentProcessSummary(agent, room);
            let procText = "";
            if (processSummary) {
              if (availBody - displayWidth(processSummary.text) - 3 > 10) {
                procText = processSummary.text;
              } else if (availBody - displayWidth(processSummary.compactText) - 3 > 10) {
                procText = processSummary.compactText;
              }
            }
            const taskBudget = Math.max(
              1,
              availBody - spinnerWidth - (procText ? displayWidth(procText) + 3 : 0),
            );
            const fittedTaskText = truncateDisplay(taskText, taskBudget, this.tier);
            const renderedTask = agentRunning
              ? `${tone(this.tier === "ascii" ? ">" : SPINNER[Math.floor(now / 120) % SPINNER.length], "shimmerSpinner", this.appearance)} ${shimmerText(fittedTaskText, now, this.appearance)}`
              : tone(fittedTaskText, isFocused ? "heading" : "muted", this.appearance);
            row2Content = renderedTask;
            if (procText) {
              row2Content += `${tone(" · ", "muted", this.appearance)}${tone(procText, processSummary.tone, this.appearance)}`;
            }
          }
          const row2 = fitStyled(`${styledContinuation}${bodyIndent}${row2Content}`, cardWidth);
          return [row1, row2];
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
      }
      if (hasHiddenSummary) {
        const hiddenTargetId = "inactive-hidden:all";
        const summaryPrefix = toAsciiTree("└─ ", this.tier);
        const summaryText = `${foldedAgents.length} inactive hidden (press c to expand)`;
        const hiddenStates = new Map();
        for (const agent of foldedAgents) {
          const state = memberDisplayState(agent);
          const group = hiddenStates.get(state) || { agent, count: 0 };
          group.count++;
          hiddenStates.set(state, group);
        }
        const detailParts = hiddenStates
          .values()
          .map(({ agent, count }) => ({
            text: `${statusGlyph(agent, now, this.tier)} ${count} ${agentPhaseLabel(agent, innerWidth)}`,
            style: toneForStatus(agent),
          }))
          .toArray();
        this.addTargets([
          { id: hiddenTargetId, key: "c", x: 1, y: lines.length + 1, width: innerWidth, height: 1 },
        ]);
        lines.push(
          sectionHeading(summaryText, "", innerWidth, {
            prefix: summaryPrefix,
            color: this.appearance,
            tier: this.tier,
            detailParts,
          }),
        );
      }
    }
    const isInteractiveMain = !this.preview && !this.overlay;
    const hasVisibleQuota = isInteractiveMain && hasQuota && this.height >= 12;
    const serviceLimit = isInteractiveMain ? this.serviceRowLimit() : 0;
    const hasVisibleServices = serviceLimit > 0;
    const hasVisibleUpdate = isInteractiveMain && this.showUpdateBar() && this.height >= 14;
    const hasSlotSummary = !(pages === 1 && room.agents.length < maxAgents * 0.75);
    const slotSummaryText = hasSlotSummary
      ? `${room.agents.length}/${maxAgents} slots · page ${this.page + 1}/${pages}`
      : "";
    const controls = this.controls(innerWidth);
    const hasEligibleTelemetry = hasVisibleQuota || hasVisibleServices || hasVisibleUpdate;
    const provisionalFooterHeight =
      controls.lines.length + 1 + (isInteractiveMain && !hasEligibleTelemetry ? 1 : 0);
    const provisionalContentHeight = Math.max(0, this.height - provisionalFooterHeight);
    const availableTelemetryHeight = Math.max(
      0,
      provisionalContentHeight - Math.min(provisionalContentHeight, 4),
    );
    const boxBodyWidth = Math.max(1, innerWidth - 2);
    const telemetryBodyRows = [];
    let quotaBoxInfo = null;
    let servicesBoxInfo = null;
    let updateBoxInfo = null;
    let topTitle = "";
    let topRight = slotSummaryText ? [{ text: slotSummaryText, style: "muted" }] : "";
    let topHeaderTone = slotSummaryText ? "muted" : undefined;

    if (hasEligibleTelemetry && availableTelemetryHeight >= 3) {
      const bodyBudget = Math.max(1, availableTelemetryHeight - 2);
      if (hasVisibleQuota) {
        if (this.quotaMode === "collapsed") {
          const rows = this.quotaSummaryLines(boxBodyWidth).slice(0, bodyBudget);
          if (rows.length > 0) {
            quotaBoxInfo = {
              mode: "collapsed",
              startOffset: telemetryBodyRows.length,
              count: rows.length,
              periodStartInBox: this.quotaWindowOffset ?? Math.max(1, boxBodyWidth - 5),
            };
            for (const row of rows) telemetryBodyRows.push({ type: "body", text: row });
          }
        } else {
          const quotaLimit = Math.min(this.quotaRowLimit(), bodyBudget);
          const rows = this.quotaLines(innerWidth).slice(0, quotaLimit);
          if (rows.length > 0) {
            topTitle = disclosure("Quota", true, this.tier);
            topHeaderTone = this.hovered === "quota-heading" ? "quotaHover" : "border";
            quotaBoxInfo = { mode: "expanded", isTopHeader: true };
            for (const row of rows) telemetryBodyRows.push({ type: "body", text: row });
          }
        }
      }

      if (hasVisibleServices) {
        const remaining = bodyBudget - telemetryBodyRows.length;
        const serviceTitle = this.tier === "nerd" ? "\u{F233} Services" : "Services";
        if (this.servicesMode === "expanded") {
          if (telemetryBodyRows.length > 0 && remaining >= 2) {
            telemetryBodyRows.push({
              type: "divider",
              text: this.panelDividerRow(
                innerWidth,
                disclosure(serviceTitle, true, this.tier),
                this.serviceHeaderBadge(),
                this.hovered === "services-heading" ? "buttonHover" : "border",
              ),
            });
            servicesBoxInfo = { isTopHeader: false, offset: telemetryBodyRows.length - 1 };
            const svcLimit = Math.min(serviceLimit, bodyBudget - telemetryBodyRows.length);
            for (const row of this.serviceLines(innerWidth).slice(0, svcLimit)) {
              telemetryBodyRows.push({ type: "body", text: ` ${row}` });
            }
          } else if (telemetryBodyRows.length === 0 && remaining >= 1) {
            const serviceBadge = this.serviceHeaderBadge();
            topTitle = disclosure(serviceTitle, true, this.tier);
            const rightParts = [
              ...(serviceBadge ? [{ text: serviceBadge, style: "" }] : []),
              ...(slotSummaryText ? [{ text: slotSummaryText, style: "muted" }] : []),
            ];
            topRight = rightParts.length > 0 ? rightParts : "";
            topHeaderTone = this.hovered === "services-heading" ? "buttonHover" : "border";
            servicesBoxInfo = { isTopHeader: true };
            const svcLimit = Math.min(serviceLimit, remaining);
            for (const row of this.serviceLines(innerWidth).slice(0, svcLimit)) {
              telemetryBodyRows.push({ type: "body", text: ` ${row}` });
            }
          }
        } else if (remaining >= 1) {
          if (telemetryBodyRows.length > 0 && this.quotaMode === "expanded" && remaining >= 2) {
            telemetryBodyRows.push({ type: "divider", text: this.panelDividerRow(innerWidth) });
          }
          if (bodyBudget - telemetryBodyRows.length >= 1) {
            servicesBoxInfo = { isTopHeader: false, offset: telemetryBodyRows.length };
            const inlineWidth = Math.max(1, boxBodyWidth - 2);
            telemetryBodyRows.push({
              type: "body",
              text: ` ${fitStyled(this.inlineServicesLine(inlineWidth), inlineWidth)} `,
            });
          }
        }
      }

      if (hasVisibleUpdate) {
        const remaining = bodyBudget - telemetryBodyRows.length;
        const hasExpandedBefore =
          (Boolean(quotaBoxInfo) && this.quotaMode === "expanded") ||
          (Boolean(servicesBoxInfo) && this.servicesMode === "expanded");
        if (telemetryBodyRows.length > 0 && hasExpandedBefore && remaining >= 2) {
          telemetryBodyRows.push({ type: "divider", text: this.panelDividerRow(innerWidth) });
        }
        if (bodyBudget - telemetryBodyRows.length >= 1) {
          updateBoxInfo = { offset: telemetryBodyRows.length };
          const updateWidth = Math.max(1, boxBodyWidth - 2);
          telemetryBodyRows.push({
            type: "body",
            text: ` ${fitStyled(this.updateLine(updateWidth), updateWidth)} `,
          });
        }
      }
    }

    const telemetryBlock = [];
    if (telemetryBodyRows.length > 0) {
      if (innerWidth < 4) {
        for (const row of telemetryBodyRows) telemetryBlock.push(fitStyled(row.text, innerWidth));
      } else {
        const glyphs = glyphSet(this.tier);
        const outer = this.panel(topTitle, [], innerWidth, topRight, topHeaderTone);
        const vert = tone(glyphs.vertical, "border", this.appearance);
        telemetryBlock.push(
          outer[0],
          ...telemetryBodyRows.map((entry) =>
            entry.type === "divider"
              ? entry.text
              : `${vert}${fitStyled(entry.text, boxBodyWidth)}${vert}`,
          ),
          outer.at(-1),
        );
      }
    }

    const hasRenderedTelemetry = telemetryBlock.length > 0;
    const hasNoTelemetryRule = isInteractiveMain && !hasRenderedTelemetry;
    const footerHeight = controls.lines.length + 1 + (hasNoTelemetryRule ? 1 : 0);
    const contentHeight = Math.max(0, this.height - footerHeight);
    const mainHeight = Math.max(0, contentHeight - telemetryBlock.length);
    if (this.overlay) {
      const minOverlayHeight = Math.min(mainHeight, 6);
      if (mainHeight - lines.length < minOverlayHeight) {
        const keepTop = Math.max(0, mainHeight - minOverlayHeight);
        lines.splice(keepTop);
        this.targets = this.targets
          .map((target) => ({
            ...target,
            height: Math.min(target.height, keepTop - target.y + 1),
          }))
          .filter((target) => target.height > 0);
      }
      lines.push(...this.overlayLines(innerWidth, Math.max(1, mainHeight - lines.length)));
    } else if (this.preview) {
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
      const shouldShowFocus = Boolean(focused && (this.pinnedId || this.hasExplicitFocus));
      if (shouldShowFocus) {
        const focusLines = this.focusCardLines(
          focused,
          innerWidth,
          mainHeight - lines.length,
          lines.length + 1,
        );
        if (focusLines.length > 0) {
          lines.push(...focusLines);
        }
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
    if (hasRenderedTelemetry && contentHeight - mainHeight >= telemetryBlock.length) {
      const boxStartY = lines.length + 1;
      const bodyStartY = innerWidth >= 4 ? boxStartY + 1 : boxStartY;
      if (quotaBoxInfo) {
        if (quotaBoxInfo.mode === "collapsed") {
          const isQuotaOnlyInBox = !servicesBoxInfo && !updateBoxInfo;
          const firstQuotaBodyRowY = bodyStartY + quotaBoxInfo.startOffset;
          const headingHeight =
            (innerWidth >= 4 ? 1 : 0) +
            quotaBoxInfo.count +
            (innerWidth >= 4 && isQuotaOnlyInBox ? 1 : 0);
          this.addTargets([
            {
              id: "quota-heading",
              key: "u",
              x: 1,
              y: boxStartY,
              width: innerWidth,
              height: headingHeight,
            },
            {
              id: "quota-window",
              key: "w",
              x: (innerWidth >= 4 ? 2 : 1) + quotaBoxInfo.periodStartInBox,
              y: firstQuotaBodyRowY,
              width: 2,
              height: 1,
            },
          ]);
        } else {
          this.addTargets([
            { id: "quota-heading", key: "u", x: 1, y: boxStartY, width: innerWidth, height: 1 },
          ]);
        }
      }
      if (servicesBoxInfo) {
        this.addTargets([
          {
            id: "services-heading",
            key: "v",
            x: 1,
            y: servicesBoxInfo.isTopHeader ? boxStartY : bodyStartY + servicesBoxInfo.offset,
            width: innerWidth,
            height: 1,
          },
        ]);
      }
      if (updateBoxInfo) {
        const isUpdateOnlyInBox = !quotaBoxInfo && !servicesBoxInfo;
        this.addTargets([
          {
            id: "update-bar",
            key: "U",
            x: 1,
            y: bodyStartY + updateBoxInfo.offset,
            width: innerWidth,
            height: innerWidth >= 4 && isUpdateOnlyInBox ? 2 : 1,
          },
        ]);
      }
      lines.push(...telemetryBlock);
    } else if (hasNoTelemetryRule) {
      lines.push(this.footerRuleLine(innerWidth, slotSummaryText));
    }
    this.addTargets(controls.targets, lines.length);
    const footerNotice =
      this.notice || (this.mouseEnabled ? "" : "Mouse off — press m to re-enable mouse");
    const footerNoticeTone = this.notice || this.mouseEnabled ? "muted" : "warning bold";
    lines.push(...controls.lines, tone(footerNotice, footerNoticeTone, this.appearance));
    return this.marginLines(lines, width);
  }
}
