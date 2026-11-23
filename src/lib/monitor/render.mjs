import { breakerRetryAt } from "./adaptive-probes.mjs";
import {
  blockedWindows,
  buildLanes,
  creditBalance,
  durationLabel,
  effectiveWindow,
  effectiveWindows,
  headline,
  level,
  pills,
  sections,
} from "./analyze.mjs";
import { resetAnnouncements, resetDetails } from "./resets.mjs";
import { formatClock, formatDuration } from "./time.mjs";
import { SNAPSHOT_SCHEMA, VERSION } from "./version.mjs";

export const ANSI = Object.freeze({
  reset: "\u{1B}[0m",
  bold: "\u{1B}[1m",
  dim: "\u{1B}[2m",
  red: "\u{1B}[31m",
  green: "\u{1B}[32m",
  yellow: "\u{1B}[33m",
  cyan: "\u{1B}[36m",
  quotaOk: "\u{1B}[38;5;71m",
  quotaMid: "\u{1B}[38;5;179m",
  quotaLow: "\u{1B}[38;5;208m",
  quotaTrack: "\u{1B}[2;38;5;240m",
});
const LEVEL_COLOR = {
  ok: "quotaOk",
  mid: "quotaMid",
  low: "quotaLow",
  out: "red",
  error: "red",
};

export function shouldUseColor(stream = process.stdout) {
  return Boolean(stream.isTTY) && !process.env.NO_COLOR && process.env.TERM !== "dumb";
}

function painter(color) {
  return (style, text) =>
    color
      ? `${style
          .split(" ")
          .map((s) => ANSI[s])
          .join("")}${text}${ANSI.reset}`
      : text;
}

// eslint-disable-next-line no-control-regex -- ANSI color sequences start with ESC.
const visibleLength = (s) => s.replaceAll(/\u{1B}\[[0-9;]*m/gu, "").length;
const pad = (s, n) => s + " ".repeat(Math.max(0, n - visibleLength(s)));
const padStart = (s, n) => " ".repeat(Math.max(0, n - visibleLength(s))) + s;

export const surplusText = (surplus) =>
  `${surplus >= 0 ? "+" : "−"}${Math.round(Math.abs(surplus))} pts`;

function bar(pct, width, c, levelColor) {
  const eighths = Math.round((Math.max(0, Math.min(100, pct)) / 100) * width * 8);
  const full = Math.floor(eighths / 8);
  const part = eighths % 8;
  const filled = "█".repeat(full) + (part ? "▏▎▍▌▋▊▉"[part - 1] : "");
  const track = "·".repeat(width - full - (part ? 1 : 0));
  if (!c) return filled + track;
  return (filled ? c(levelColor, filled) : "") + (track ? c("quotaTrack", track) : "");
}

function resetText(w, blocker, now, c) {
  if (blocker)
    return c("dim", `unusable until the ${durationLabel(blocker.windowMins)} limit resets`);
  if (w.resetAwaitingRefresh) return c("dim", "rollover due; awaiting provider refresh");
  if (!w.resetsAt) return c("dim", "not started");
  return `${c("dim", "resets")} ${formatClock(w.resetsAt, now)} ${c("dim", `(in ${formatDuration(w.resetsAt - now)})`)}`;
}

function surplusColor(surplus) {
  if (surplus >= 15) return "quotaOk";
  if (surplus <= -10) return "quotaMid";
  return "dim";
}

export function renderReport(
  accounts,
  { color = false, now = Date.now(), refreshing = false, footer = "" } = {},
) {
  const c = painter(color);
  const out = [];
  const oldest = accounts.length > 0 ? Math.min(...accounts.map((a) => a.fetchedAt ?? now)) : now;
  const status = refreshing
    ? c("cyan", "refreshing…")
    : c("dim", `data ${formatDuration(now - oldest)} old`);
  out.push(
    `${c("bold", " Monitor")}  ${c("dim", new Date(now).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }))}  ${status}`,
  );
  out.push("");

  for (const account of accounts) {
    const h = headline(account, now);
    const plan = account.plan ? c("dim", `  ${account.plan}`) : "";
    out.push(` ${c(`bold ${LEVEL_COLOR[h.level]}`, account.label)}${plan}`);
    if (account.ok === false) {
      const when = account.errorAt ? ` ${formatDuration(now - account.errorAt)} ago` : "";
      out.push(`   ${c("red", `⚠ refresh failed${when}: ${account.error}`)}`);
      if (account.fetchedAt)
        out.push(
          `   ${c("dim", `showing last good data from ${formatDuration(now - account.fetchedAt)} ago`)}`,
        );
    }
    const blocked = blockedWindows(account, now);
    for (const w of effectiveWindows(account, now)) {
      const blocker = blocked.get(w.id);
      const lv = blocker ? "out" : level(w.remainingPct);
      const dead = blocker || w.remainingPct <= 0.5;
      const pct = padStart(dead ? SKULL : `${Math.floor(w.remainingPct)}%`, 4);
      const reset = resetText(w, blocker, now, c);
      out.push(
        `   ${pad(w.label, 22)} ${bar(blocker ? 0 : w.remainingPct, 14, c, LEVEL_COLOR[lv])} ${c(LEVEL_COLOR[lv], pct)} ${dead ? " ".repeat(4) : "left"}   ${reset}`,
      );
    }
    const credits = creditBalance(account);
    if (credits)
      out.push(
        `   ${pad("credit balance", 22)} ${c(LEVEL_COLOR[credits.level], credits.text)} left`,
      );
    for (const detail of resetDetails(account, now)) out.push(`   ${c("dim", detail)}`);
    for (const notice of resetAnnouncements(account, now)) {
      out.push(
        `   Announced: ${notice.title} · ${formatClock(Date.parse(notice.at), now)} (eligibility unverified; not used for pacing)`,
      );
      out.push(`   ${notice.url}`);
    }
    const notes = account.notes ?? [];
    for (const note of notes) out.push(`   ${c("dim", note)}`);
    out.push("");
  }

  const lanes = buildLanes(accounts, now);
  out.push(
    ` ${c("bold", "Where to spend next")}  ${c("dim", "(pts = weekly % left minus what even use would leave)")}`,
  );
  let rank = 0;
  for (const lane of lanes) {
    if (lane.redundant) continue;
    const isAvailable = lane.status === "available";
    const isUsable = isAvailable || lane.status === "credits";
    const marker = isUsable ? padStart(String(++rank), 2) : c("red", " ✗");
    const pts = isAvailable && lane.pace ? surplusText(lane.pace.surplus) : "";
    const ptsColor = pts ? surplusColor(lane.pace.surplus) : "dim";
    const route = lane.route ? c("cyan", lane.route) : "";
    out.push(
      ` ${marker}  ${pad(lane.label, 34)} ${c(ptsColor, padStart(pts, 8))}   ${pad(lane.advice ?? "", 44)} ${route}`,
    );
  }
  if (footer) out.push("", c("dim", ` ${footer}`));
  return out.join("\n");
}

// Marks limits that are used up: the ☠ group in the menu bar and `line`, and dead rows in the terminal view.
export const SKULL = "☠";

// Marks the pool that is expiring: near its weekly rollover with capacity left.
export const HOURGLASS = "⏳";

/** Time until a rollover in the largest whole unit, rounded to the nearest day: "3d", "5h", "40m". */
export function timeLeft(resetsAt, now = Date.now()) {
  if (!resetsAt) return "";
  const minutes = Math.floor((resetsAt - now) / 60_000);
  if (minutes <= 0) return "now";
  if (minutes >= 1440) return `${Math.round(minutes / 1440)}d`;
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h`;
  return `${minutes}m`;
}

/**
 * One provider's pill as text: "16·78 3d" (5-hour % left · weekly % left, then time to the weekly rollover),
 * "49 4d" when there is no 5-hour limit, "☠5h" when the week is used up (then time until it is back),
 * "62,261.91 cr 4d" when the week is used up but the account runs on credits.
 * Antigravity's pools are tagged: "G76·3 4h C100·27 1d⏳".
 */
export function pillText(account, now = Date.now()) {
  const list = pills(account, now);
  if (list.length === 0) return "?";
  const pct = (g) => String(Math.floor(g.pct));
  const pools = list.map((p) => {
    const tag = p.tag ?? "";
    // On credits the included week is used up: the balance, then how long until that week is back.
    if (p.credits) return `${tag}${p.credits.text} ${timeLeft(p.weekly?.resetsAt, now)}`.trim();
    if (p.weekly?.exhausted) return `${tag}${SKULL}${timeLeft(p.weekly.resetsAt, now)}`;
    const weekly = p.weekly
      ? `${pct(p.weekly)} ${timeLeft(p.weekly.resetsAt, now)}`.trim() +
        (p.weekly.expiring ? HOURGLASS : "")
      : "";
    return tag + [p.short && pct(p.short), weekly].filter(Boolean).join("·");
  });
  return pools.join(" ") + (account.ok === false ? "!" : "");
}

/** One line for tmux or a status line, one group per provider: "CW ☠5h · CP 16·78 3d · CX 49 4d · AG …". */
export function renderLine(accounts, now = Date.now()) {
  return accounts.map((a) => `${a.short} ${pillText(a, now)}`).join(" · ");
}

const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
const minutesUntil = (ms, now) => (ms ? Math.max(0, Math.round((ms - now) / 60_000)) : null);

function sectionsView({ sections: list, exhausted, unavailable }) {
  return {
    sections: list.map((sec) => ({
      ...sec,
      entries: sec.entries.map((e) => ({ ...e, resetsAt: iso(e.resetsAt) })),
    })),
    exhausted: exhausted.map((e) => ({ ...e, resetsAt: iso(e.resetsAt) })),
    unavailable,
  };
}

/** Stable machine-readable view shared by `monitor json`, the menu bar app and the MCP server. */
export function jsonView(accounts, now = Date.now()) {
  return {
    schema: SNAPSHOT_SCHEMA,
    version: VERSION,
    generatedAt: iso(now),
    // The menu bar layout: one section per window length (e.g. "5h", "wk"), shortest first.
    ...sectionsView(sections(accounts, now)),
    accounts: accounts.map((a) => ({
      id: a.id,
      label: a.label,
      short: a.short,
      provider: a.provider,
      plan: a.plan ?? null,
      billing: a.billing ?? null,
      configDir: a.configDir ?? null,
      accountHome: a.accountHome ?? null,
      ...(a.claudeConfigDir !== undefined && { claudeConfigDir: a.claudeConfigDir ?? null }),
      ...(a.unsetClaudeConfigDir !== undefined && {
        unsetClaudeConfigDir: Boolean(a.unsetClaudeConfigDir),
      }),
      ...(a.accountEnv && typeof a.accountEnv === "object" && { accountEnv: a.accountEnv }),
      credits: creditBalance(a),
      ok: a.ok !== false,
      error: a.ok === false ? a.error : null,
      ...(a.probeHealth && {
        probe: {
          p95Ms: a.probeHealth.p95Ms,
          p99Ms: a.probeHealth.p99Ms,
          lastDurationMs: a.probeHealth.lastDurationMs,
          lastDeadlineMs: a.probeHealth.lastDeadlineMs,
          lastOutcome: a.probeHealth.lastOutcome,
          retryAt: iso(breakerRetryAt(a, now)),
        },
      }),
      fetchedAt: iso(a.fetchedAt),
      ageMinutes: a.fetchedAt ? Math.round((now - a.fetchedAt) / 60_000) : null,
      headline: headline(a, now),
      pills: pills(a, now).map((p) => ({
        ...p,
        short: p.short && { ...p.short, resetsAt: iso(p.short.resetsAt) },
        weekly: p.weekly && { ...p.weekly, resetsAt: iso(p.weekly.resetsAt) },
      })),
      windows: ((blocked) =>
        effectiveWindows(a, now).map((w) => ({
          id: w.id,
          label: w.label,
          kind: w.kind,
          usedPct: w.usedPct,
          remainingPct: w.remainingPct,
          resetsAt: iso(w.resetsAt),
          resetsInMinutes: minutesUntil(w.resetsAt, now),
          resetSinceFetch: false,
          resetAwaitingRefresh: Boolean(w.resetAwaitingRefresh),
          exhausted: w.remainingPct <= 0.5,
          blockedBy: blocked.has(w.id) ? durationLabel(blocked.get(w.id).windowMins) : null,
        })))(blockedWindows(a, now)),
      resetCredits: a.resetCredits
        ? {
            ...a.resetCredits,
            credits:
              a.resetCredits.credits?.map((c) => ({ ...c, expiresAt: iso(c.expiresAt) })) ?? null,
          }
        : null,
      resetHistory: (a.resetHistory ?? []).map((e) => ({
        ...e,
        observedAt: iso(e.observedAt),
        previousResetsAt: iso(e.previousResetsAt),
        resetsAt: iso(e.resetsAt),
      })),
      resetDetails: resetDetails(a, now),
      resetAnnouncements: resetAnnouncements(a, now),
      notes: a.notes ?? [],
    })),
    lanes: buildLanes(accounts, now).map((l) => ({
      label: l.label,
      accountId: l.accountId,
      poolId: l.poolId,
      windowIds: l.windowIds,
      families: l.families,
      models: l.models ?? null,
      status: l.status,
      credits: l.credits ?? null,
      availableNowPct: l.availableNowPct ?? 0,
      weeklyRemainingPct: l.weeklyRemainingPct ?? 0,
      surplusPts: l.pace ? Math.round(l.pace.surplus) : null,
      expiring: Boolean(l.expiring),
      expiresAt: iso(l.expiringWindow?.resetsAt),
      burnPctPerHour: l.burnPctPerHour == null ? null : Math.round(l.burnPctPerHour * 10) / 10,
      lowRoom: Boolean(l.lowRoom),
      weeklyResetsInHours: l.pace ? Math.round(l.pace.hoursLeft * 10) / 10 : null,
      blockedUntil: iso(l.blockedUntil),
      route: l.route ?? null,
      advice: l.advice,
      subPoolOf: l.subPoolOf ?? null,
      redundant: Boolean(l.redundant),
      stale: l.stale,
      resetAwaitingRefresh: Boolean(l.resetAwaitingRefresh),
      score: Math.round(l.score * 10) / 10,
    })),
  };
}

const QUOTA_NAME_MAX = 16;
const EXHAUSTED_QUOTA_PCT = 0.5;
const quotaNumber = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
const quotaPct = (value) => Math.max(0, Math.min(100, value));

/** One account of a `monitor.snapshot.v1` document, reduced to what a one-line quota item needs. */
function quotaEntry(account, lanes, now) {
  const label = String(account?.label || account?.short || account?.id || "?");
  const windows = (Array.isArray(account?.windows) ? account.windows : []).flatMap((w) => {
    const remaining = quotaNumber(w?.remainingPct);
    if (remaining === null) return [];
    const resetsAt = w.resetsAt ? Date.parse(w.resetsAt) : NaN;
    // Monitor's own rollover rule: a passed reset keeps the last measurement but cannot confirm it.
    const effective = effectiveWindow(
      { ...w, resetsAt: Number.isFinite(resetsAt) ? resetsAt : null },
      now,
    );
    return [
      {
        label: String(w.label || w.id || "window"),
        pct: quotaPct(remaining),
        resetsAt: effective.resetsAt,
        rollover: Boolean(effective.resetAwaitingRefresh || w.resetAwaitingRefresh),
      },
    ];
  });
  const isFailed = account?.ok === false;
  const stale = isFailed || windows.some((w) => w.rollover) || lanes.some((lane) => lane.stale);
  return {
    id: account?.id == null ? "" : String(account.id),
    label,
    short: String(account?.short || ""),
    provider: account?.provider ? String(account.provider) : "",
    windows,
    stale,
    failed: isFailed,
    error: isFailed ? String(account.error || "unavailable").slice(0, 120) : "",
    age:
      quotaNumber(account?.ageMinutes) === null
        ? ""
        : formatDuration(Math.max(0, account.ageMinutes) * 60_000),
    pools: (Array.isArray(account?.pills) ? account.pills : []).filter((p) => p?.tag),
  };
}

function quotaTooltipLine(entry, now) {
  const head = entry.provider ? `${entry.label} (${entry.provider})` : entry.label;
  if (entry.windows.length === 0) {
    return `${head}: ${entry.failed ? entry.error : "no quota data"}`;
  }
  const windows = entry.windows
    .map((w) => {
      const reset = w.rollover
        ? "rollover due; awaiting provider refresh"
        : timeLeft(w.resetsAt, now);
      const when = reset
        ? ` (${reset === "now" || w.rollover ? reset : `resets in ${reset}`})`
        : "";
      return `${w.label} ${Math.floor(w.pct)}%${when}`;
    })
    .join(" · ");
  const notes = [];
  if (entry.failed) notes.push(`refresh failed: ${entry.error}`);
  else if (entry.stale) notes.push("stale");
  if (entry.age && entry.stale) notes.push(`data ${entry.age} old`);
  const suffix = notes.length > 0 ? ` [${notes.join("; ")}]` : "";
  const pools = entry.pools
    .map(
      (p) =>
        `  ${p.tag} ${p.poolLabel}: ${[p.short, p.weekly]
          .filter(Boolean)
          .map((g) => `${Math.floor(quotaPct(quotaNumber(g.pct) ?? 0))}%`)
          .join(" · ")}`,
    )
    .join("\n");
  return `${head}: ${windows}${suffix}${pools ? `\n${pools}` : ""}`;
}

/**
 * Status bar text, tone and tooltip for a `monitor json` snapshot, shared by hosts that show one quota
 * item. Freshness, rollover and account identity come from Monitor's own lanes, windows and labels:
 * a stale or rolled-over figure is marked "!" and never sets a danger tone or proves exhaustion, an
 * account with no numbers shows "?", and a fresh zero is a real, exhausted limit (☠).
 * Accounts sharing a provider tag are told apart by label.
 */
export function summarizeQuota(snapshot, { now, maxShown = 4, stale = false } = {}) {
  const accounts = Array.isArray(snapshot?.accounts) ? snapshot.accounts : [];
  const lanes = Array.isArray(snapshot?.lanes) ? snapshot.lanes : [];
  const generated = Date.parse(snapshot?.generatedAt ?? "");
  const at = quotaNumber(now) ?? (Number.isFinite(generated) ? generated : Date.now());
  const entries = accounts.map((account) =>
    quotaEntry(
      account,
      account?.id == null
        ? []
        : lanes.filter((lane) => lane?.accountId === account.id && !lane.redundant),
      at,
    ),
  );
  if (stale) for (const entry of entries) entry.stale = true;
  const tagCount = new Map();
  for (const entry of entries) tagCount.set(entry.short, (tagCount.get(entry.short) ?? 0) + 1);
  const nameOf = (entry) =>
    (entry.short && tagCount.get(entry.short) === 1 ? entry.short : entry.label || entry.id).slice(
      0,
      QUOTA_NAME_MAX,
    );

  const tooltip = entries.map((entry) => quotaTooltipLine(entry, at));
  const known = entries
    .filter((entry) => entry.windows.length > 0)
    .map((entry) => {
      const binding = entry.windows.toSorted((left, right) => left.pct - right.pct)[0];
      return { entry, name: nameOf(entry), binding, pct: binding.pct };
    })
    .toSorted((left, right) => {
      if (left.entry.stale !== right.entry.stale) return left.entry.stale ? 1 : -1;
      return left.pct - right.pct;
    });

  if (known.length === 0) {
    return {
      text: "Quota —",
      tone: tooltip.length > 0 ? "warning" : "neutral",
      tooltip: tooltip.join("\n") || "No quota accounts reported by monitor",
    };
  }
  const unknown = entries.filter((entry) => entry.windows.length === 0);
  const cells = known.map(({ entry, name, binding, pct }) => {
    if (!entry.stale && pct <= EXHAUSTED_QUOTA_PCT) {
      return `${name} ${SKULL}${timeLeft(binding.resetsAt, at)}`;
    }
    return `${name} ${Math.floor(pct)}%${entry.stale ? "!" : ""}`;
  });
  for (const entry of unknown) cells.push(`${nameOf(entry)} ?`);
  const shown = cells.slice(0, maxShown);
  if (cells.length > maxShown) shown.push(`+${cells.length - maxShown}`);

  const fresh = known.filter(({ entry }) => !entry.stale);
  const lowest = fresh.length > 0 ? Math.min(...fresh.map(({ pct }) => pct)) : null;
  let tone = "neutral";
  if (lowest !== null && lowest < 10) tone = "danger";
  else if (lowest !== null && lowest < 25) tone = "warning";
  if (tone === "neutral" && (unknown.length > 0 || known.some(({ entry }) => entry.stale))) {
    tone = "warning";
  }
  if (snapshot?.generatedAt) tooltip.push(`Updated ${snapshot.generatedAt}`);
  return { text: shown.join(" · "), tone, tooltip: tooltip.join("\n") };
}
