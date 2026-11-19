import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

import { parseAntigravityUsage } from "../../../plugins/monitor/lib/providers/antigravity.mjs";
import { parseClaudeUsage } from "../../../plugins/monitor/lib/providers/claude.mjs";
import { jsonView, summarizeQuota } from "../../../plugins/monitor/lib/render.mjs";

const fixture = (name) => readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8");
const NOW = Date.parse("2026-09-25T16:37:46Z");
const HOUR = 3_600_000;

// Raw provider output, parsed by Monitor's own parsers, then shaped by its own jsonView.
const personal = {
  id: "claude-personal",
  label: "Claude Personal",
  short: "CP",
  provider: "claude",
  ok: true,
  fetchedAt: NOW,
  ...parseClaudeUsage(fixture("claude-personal.txt"), NOW),
};
const work = {
  id: "claude-work",
  label: "Claude Work",
  short: "CW",
  provider: "claude",
  ok: true,
  fetchedAt: NOW,
  ...parseClaudeUsage(fixture("claude-work.txt"), NOW),
};
const agy = {
  id: "agy",
  label: "Antigravity",
  short: "AG",
  provider: "antigravity",
  ok: true,
  fetchedAt: NOW,
  ...parseAntigravityUsage(JSON.parse(fixture("agy-usage.json"))),
};

const summarize = (accounts, now = NOW, options = {}) =>
  summarizeQuota(jsonView(accounts, now), { now, ...options });

/** A one-window account on the weekly pool, for the edge cases the fixtures do not cover. */
function weekly(id, remainingPct, extra = {}) {
  return {
    id,
    label: `Label ${id}`,
    short: id.toUpperCase(),
    provider: "codex",
    ok: true,
    fetchedAt: NOW,
    windows: [
      {
        id: "weekly",
        label: "weekly",
        kind: "weekly",
        windowMins: 10_080,
        remainingPct,
        usedPct: 100 - remainingPct,
        resetsAt: NOW + 30 * HOUR,
      },
    ],
    pools: [{ id: "codex", label: "Codex", families: ["gpt"], windowIds: ["weekly"] }],
    ...extra,
  };
}

describe("summarizeQuota", () => {
  test("keeps two accounts of one provider apart and marks a fresh zero as exhausted", () => {
    const summary = summarize([personal, work]);
    expect(summary.text).toMatch(/^CW ☠\d+h · CP \d+%$/u);
    expect(summary.tone).toBe("danger");
    expect(summary.tooltip).toContain("Claude Personal (claude): 5-hour 57%");
    expect(summary.tooltip).toContain("Claude Work (claude): 5-hour 100%");
    expect(summary.tooltip).toContain("weekly 0% (resets in 8h)");
  });

  test("falls back to labels when two accounts share a short tag", () => {
    const summary = summarize([
      { ...personal, short: "CL" },
      { ...work, short: "CL" },
    ]);
    expect(summary.text).toContain("Claude Work ☠");
    expect(summary.text).toContain("Claude Personal ");
    expect(summary.text).not.toContain("CL ");
  });

  test("tells Antigravity's tagged pools apart in the tooltip", () => {
    const { tooltip, text } = summarize([agy]);
    expect(text).toBe("AG 6%");
    expect(tooltip).toContain("  G Gemini: 100% · 6%");
    expect(tooltip).toContain("  C Claude & GPT: 100% · 27%");
  });

  test("uses short, then label, then id for the name", () => {
    const named = (fields) =>
      summarizeQuota({ accounts: [{ windows: [{ remainingPct: 50 }], ...fields }] });
    expect(named({ short: "S", label: "Label", id: "i" }).text).toBe("S 50%");
    expect(named({ label: "Label", id: "i" }).text).toBe("Label 50%");
    expect(named({ id: "only-id" }).text).toBe("only-id 50%");
    expect(named({}).text).toBe("? 50%");
  });

  test("shows an account without usable numbers as unknown, never as zero", () => {
    const summary = summarizeQuota({
      accounts: [
        { id: "a", short: "A", windows: [{ label: "wk", remainingPct: 80 }] },
        { id: "b", short: "B", label: "Beta", windows: [{ label: "wk", remainingPct: "n/a" }] },
        { id: "c", short: "C", label: "Gamma" },
      ],
    });
    expect(summary.text).toBe("A 80% · B ? · C ?");
    expect(summary.tone).toBe("warning");
    expect(summary.tooltip).toContain("Beta: no quota data");
    expect(summary.tooltip).toContain("Gamma: no quota data");
  });

  test("keeps the established empty and all-failed shapes", () => {
    expect(summarizeQuota({ accounts: [] })).toStrictEqual({
      text: "Quota —",
      tone: "neutral",
      tooltip: "No quota accounts reported by monitor",
    });
    expect(
      summarizeQuota({ accounts: [{ label: "Codex", ok: false, error: "expired" }] }),
    ).toStrictEqual({ text: "Quota —", tone: "warning", tooltip: "Codex: expired" });
    expect(summarizeQuota(null).text).toBe("Quota —");
  });

  test("marks data older than Monitor's own freshness limit as stale, not as exhausted", () => {
    const old = weekly("old", 0, { fetchedAt: NOW - 3 * HOUR });
    const summary = summarize([old, weekly("new", 40)]);
    // A stale zero proves nothing about now: no skull, no danger, listed after the fresh figure.
    expect(summary.text).toBe("NEW 40% · OLD 0%!");
    expect(summary.tone).toBe("warning");
    expect(summary.tooltip).toContain("[stale; data 3h 00m old]");
    expect(summarize([old]).tone).toBe("warning");
  });

  test("a failed refresh shows last good data as stale and carries the error", () => {
    const summary = summarize([weekly("a", 5, { ok: false, error: "token expired" })]);
    expect(summary.text).toBe("A 5%!");
    expect(summary.tone).toBe("warning");
    expect(summary.tooltip).toContain("refresh failed: token expired");
  });

  test("a passed reset is a rollover awaiting refresh, so the old number is stale", () => {
    const rolled = weekly("r", 3, {});
    rolled.windows[0].resetsAt = NOW - HOUR;
    const summary = summarize([rolled]);
    expect(summary.text).toBe("R 3%!");
    expect(summary.tone).toBe("warning");
    expect(summary.tooltip).toContain("rollover due; awaiting provider refresh");
    // The same snapshot read later than it was taken also rolls over.
    const later = summarizeQuota(jsonView([weekly("r", 3)], NOW), { now: NOW + 40 * HOUR });
    expect(later.text).toBe("R 3%!");
  });

  test("clamps overflow to the 0-100 range", () => {
    expect(summarize([weekly("hi", 140)]).text).toBe("HI 100%");
    const negative = summarize([weekly("lo", -5)]);
    expect(negative.text).toMatch(/^LO ☠/u);
    expect(negative.tone).toBe("danger");
  });

  test("a valid fresh zero is real exhaustion with its reset time", () => {
    const summary = summarize([weekly("z", 0)]);
    expect(summary.text).toBe("Z ☠1d");
    expect(summary.tone).toBe("danger");
  });

  test("lists the four lowest accounts and counts the rest, lowest first", () => {
    const accounts = [60, 10, 30, 50, 20, 40].map((pct, index) => weekly(`a${index}`, pct));
    expect(summarize(accounts).text).toBe("A1 10% · A4 20% · A2 30% · A5 40% · +2");
    expect(summarize(accounts, NOW, { maxShown: 2 }).text).toBe("A1 10% · A4 20% · +4");
  });

  test("tone follows the lowest fresh figure", () => {
    expect(summarize([weekly("a", 24)]).tone).toBe("warning");
    expect(summarize([weekly("a", 9)]).tone).toBe("danger");
    expect(summarize([weekly("a", 80)]).tone).toBe("neutral");
  });
});
