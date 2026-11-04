import path from "node:path";

import { renderLine } from "../../monitor/lib/render.mjs";
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
const ERROR_STATUSES = new Set(["blocked", "failed", "rejected", "session unavailable"]);

function toneForStatus(status) {
  if (status === "completed" || status === "reported complete") return "green";
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

function quotaRows(accounts, width, tier, color) {
  const rows = [];
  const accountList = accounts || [];
  for (const account of accountList) {
    const windows = Array.isArray(account.windows) ? account.windows : [];
    const short = account.short || account.id || "?";
    if (windows.length === 0) {
      rows.push(plain(`${short} ${renderLine([account]) || "quota unavailable"}`));
      continue;
    }
    const displayedWindows = windows.slice(0, 3);
    for (const window of displayedWindows) {
      const pct = Number.isFinite(window.remainingPct)
        ? Math.max(0, Math.min(100, window.remainingPct))
        : undefined;
      const label = plain(`${short} ${window.label || window.id || "quota"}`);
      const suffixWidth = pct === undefined ? 12 : displayWidth(`${Math.round(pct)}% left`) + 1;
      const barWidth = Math.max(3, Math.min(18, width - displayWidth(label) - suffixWidth - 1));
      rows.push(
        pct === undefined
          ? `${label} unavailable`
          : `${label} ${tone(progressBar(pct / 100, barWidth, tier), pct <= 10 ? "red" : "green", color)} ${Math.round(pct)}% left`,
      );
    }
  }
  return rows.length > 0 ? rows : ["Quota unavailable"];
}

function memberWorktree(member, room) {
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
  const visit = (parent) => {
    const children = room.agents.filter((agent) => (agent.parent || "conductor") === parent);
    for (const agent of children) {
      const worktree = memberWorktree(agent, room);
      treeAgents.push({
        ...agent,
        ...(worktree && { worktree }),
      });
      visit(agent.id);
    }
  };
  visit("conductor");
  const groups = new Map();
  for (const agent of treeAgents) {
    const folder = agentFolder(agent, room);
    if (!groups.has(folder)) groups.set(folder, []);
    groups.get(folder).push(agent);
  }
  const agents = groups.values().toArray().flat();
  return { ...room, swarm, agents };
}

/** pi-tui compatible component: render(width): string[], handleInput(data), invalidate(). */
export class StoogesView {
  constructor(room, { now = Date.now, height = 32, color = false, tier = glyphTier() } = {}) {
    this.room = treeRoom(room);
    this.now = now;
    this.height = height;
    this.color = color;
    this.tier = tier;
    this.focusId = this.room.agents[0]?.id;
    this.pinnedId = undefined;
    this.page = 0;
    this.overlay = undefined;
    this.logOffset = 0;
  }

  pageSizeFor() {
    return Math.min(9, Math.max(2, Math.floor((this.height - 10) / 4) * 2));
  }

  get pageSize() {
    return this.pageSizeFor();
  }

  get needsAnimation() {
    return this.room.agents.some((agent) => ACTIVE_STATUSES.has(agent.status));
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
    return quotaRows(accounts, Math.max(10, width - 4), this.tier, this.color);
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
      `${model(lead)} | ${phase(lead)}`,
      plain(lead.progress?.task || room.objective || "Tell the coordinator what you want done"),
    ];
    const maxAgents = room.swarm?.maxAgents ?? 64;
    const lines = [
      ...this.panel(
        `Swarm · ${plain(room.title || room.id)}`,
        leadLines,
        innerWidth,
        `${room.agents.length}/${maxAgents} slots`,
        "headerBg",
      ),
    ];
    if (room.accounts?.length || room.quotaError) {
      const quotaLimit = this.height < 24 ? 1 : 2;
      lines.push(
        ...this.panel("Quota", this.quotaLines(innerWidth).slice(0, quotaLimit), innerWidth),
      );
    }
    if (room.agents.length === 0) {
      lines.push("The coordinator will add agents as work is assigned.");
    } else {
      const folderGroups = new Map();
      for (const [offset, agent] of selected.entries()) {
        const folder = agentFolder(agent, room);
        if (!folderGroups.has(folder)) folderGroups.set(folder, []);
        folderGroups.get(folder).push({ agent, index: offset });
      }
      const gap = "  ";
      for (const [folder, entries] of folderGroups) {
        lines.push(this.folderHeaderLine(folder, entries.length, innerWidth));
        const columns = innerWidth >= 100 && entries.length > 1 ? 2 : 1;
        const cardWidth =
          columns === 2 ? Math.max(24, Math.floor((innerWidth - gap.length) / 2)) : innerWidth;
        const rails = folderTreeRails(entries, this.tier, columns);
        const cards = entries.map(({ agent, index }, entryIndex) => {
          const { topPrefix, midPrefix, tailPrefix } = rails[entryIndex];
          const prefixWidth = displayWidth(midPrefix);
          const boxWidth = Math.max(4, cardWidth - prefixWidth);
          const wfRole = roleOf(agent);
          const roleBadge = wfRole ? ` [${wfRole}]` : "";
          const isFocused = agent.id === this.focusId;
          const isPinned = agent.id === this.pinnedId;
          let stateBadge = "";
          if (isPinned) stateBadge = "PIN ";
          else if (isFocused) stateBadge = "FOCUS ";
          const parentBadge =
            agent.parent && agent.parent !== "conductor" ? ` ↳ ${plain(agent.parent)}` : "";
          const cardTitle = `${index + 1} ${plain(agent.name || agent.id)}${agent.role === "lead" ? " (lead)" : ""}`;
          const locationBadge = worktreeBadge(agent, room) || shortFolder(folder);
          const cardRight = `${stateBadge}${locationBadge}${parentBadge}`;
          const taskText = plain(agent.progress?.task || agent.objective || "Awaiting assignment");
          const statusLine = tone(
            `${statusGlyph(agent, now, this.tier)}${roleBadge} ${model(agent)} | ${phase(agent)}`,
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
            let prefix = tailPrefix;
            if (lineIndex < midIndex) prefix = topPrefix;
            else if (lineIndex === midIndex) prefix = midPrefix;
            return `${tone(prefix, "cyan", this.color)}${line}`;
          });
        });
        lines.push(...joinCardGrid(cards, columns, cardWidth, gap));
      }
    }
    const focused = room.agents.find((agent) => agent.id === (this.pinnedId || this.focusId));
    const detail = focused?.output?.at(-1);
    if (detail && lines.length < this.height - 4) lines.push(plain(detail));
    while (lines.length < this.height - 3) lines.push("");
    lines.push(
      `${room.agents.length}/${maxAgents} slots · page ${this.page + 1}/${pages}`,
      "↑↓ select · n page · ? help · q close view",
      "Ctrl-b Tab: switch pane · Ctrl-b d: detach",
    );
    return this.marginLines(lines, width);
  }
}

export { StoogesView as HordeView };
