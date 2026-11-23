import { describe, expect, it } from "vitest";

import { bestAlternative, checkRouteQuota, quotaGate } from "../../../src/lib/quota-gate.mjs";

// A monitor.snapshot.v1 view reduced to what quota.check and the alternative read.
const view = {
  schema: "monitor.snapshot.v1",
  accounts: [
    { id: "claude", provider: "claude" },
    { id: "codex", provider: "codex" },
    { id: "antigravity", provider: "antigravity" },
  ],
  lanes: [
    {
      label: "Codex",
      accountId: "codex",
      poolId: "codex",
      families: ["gpt"],
      status: "available",
      availableNowPct: 52,
      weeklyRemainingPct: 52,
      route: "codex",
      advice: "on pace",
      stale: false,
    },
    {
      label: "Antigravity · Gemini",
      accountId: "antigravity",
      poolId: "gemini",
      families: ["gemini"],
      status: "available",
      availableNowPct: 40,
      advice: "on pace",
      stale: false,
    },
    {
      label: "Claude",
      accountId: "claude",
      poolId: "all",
      families: ["claude"],
      status: "available",
      availableNowPct: 6,
      lowRoom: true,
      advice: "only 6% usable now: small tasks only",
      stale: false,
    },
    {
      label: "Antigravity · Claude & GPT",
      accountId: "antigravity",
      poolId: "claude-gpt",
      families: ["claude"],
      status: "blocked",
      availableNowPct: 0,
      advice: "out until 3:00 PM",
      stale: false,
    },
  ],
};

describe("quota gate", () => {
  it("reads each route's pool the way the runner's quota gate does", async () => {
    const findings = await checkRouteQuota(
      [
        { engine: "claude", model: "claude-opus-5-5" },
        { engine: "claude", model: "claude-opus-5-5" },
        { engine: "codex", model: "gpt-5.6-sol" },
        { engine: "agy", model: "claude-sonnet-5-5" },
        { engine: "opencode", model: "openrouter/x" },
      ],
      { view },
    );
    expect(findings.map((f) => [f.engine, f.status, f.label])).toEqual([
      ["claude", "low", "Claude"],
      ["codex", "available", "Codex"],
      ["agy", "blocked", "Antigravity · Claude & GPT"],
      ["opencode", "not_applicable", null],
    ]);
    expect(findings[0].alternative).toEqual({
      label: "Codex",
      engine: "codex",
      route: "codex",
      availableNowPct: 52,
    });
    expect(findings[1].alternative).toBeNull();
  });

  it("is silent without monitor data", async () => {
    expect(await checkRouteQuota([{ engine: "claude", model: "x" }], { view: null })).toEqual([]);
    // The test profile has no monitor config, so nothing is probed.
    expect(await checkRouteQuota([{ engine: "claude", model: "x" }])).toEqual([]);
    expect(await checkRouteQuota([], { view })).toEqual([]);
  });

  it("names monitor's best alternative other than the pool in question", () => {
    expect(bestAlternative(view, { accountId: "codex", poolId: "codex" })?.label).toBe(
      "Antigravity · Gemini",
    );
    expect(bestAlternative({ ...view, lanes: view.lanes.slice(2) }, {})).toBeNull();
  });

  it("requires confirmation for low and blocked pools only", () => {
    const low = {
      engine: "claude",
      model: "claude-opus-5-5",
      status: "low",
      label: "Claude",
      availableNowPct: 6.7,
      advice: "only 6% usable now: small tasks only",
      alternative: null,
    };
    expect(
      quotaGate([
        { ...low, status: "available" },
        { ...low, status: "unknown" },
      ]),
    ).toEqual([]);
    expect(() => quotaGate([low])).toThrow(
      "Claude quota is low for claude:claude-opus-5-5 (6% usable now; only 6% usable now: small tasks only). Monitor has no other pool with room now; see monitor recommend.\nPass --confirm-low-quota",
    );
    expect(quotaGate([{ ...low, status: "blocked" }], { confirmed: true })).toEqual([
      "Claude quota is blocked for claude:claude-opus-5-5 (6% usable now; only 6% usable now: small tasks only). Monitor has no other pool with room now; see monitor recommend.",
    ]);
  });

  // The view with Claude's 5-hour and weekly windows, each [% left, hours to reset], and monitor's flag.
  const claudeWindows = (short, week, expiring) => {
    const at = (hours) => new Date(Date.now() + hours * 3_600_000).toISOString();
    const window = (id, label, windowMins, [remainingPct, hours]) => ({
      id,
      label,
      windowMins,
      remainingPct,
      resetsAt: at(hours),
    });
    return {
      ...view,
      accounts: view.accounts.map((a) =>
        a.id === "claude"
          ? {
              ...a,
              windows: [window("5h", "5-hour", 300, short), window("week", "weekly", 10_080, week)],
            }
          : a,
      ),
      lanes: view.lanes.map((l) =>
        l.accountId === "claude"
          ? {
              ...l,
              windowIds: ["5h", "week"],
              availableNowPct: Math.min(short[0], week[0]),
              expiring,
            }
          : l,
      ),
    };
  };
  const claudeRoute = [{ engine: "claude", model: "claude-opus-5-5" }];

  it("passes a use-it-or-lose-it pool with a note instead of refusing it", async () => {
    const findings = await checkRouteQuota(claudeRoute, {
      view: claudeWindows([6, 1], [9, 2], true),
    });
    expect(findings[0]).toMatchObject({ status: "low", spendToZero: { window: "weekly" } });
    const [note] = quotaGate(findings);
    expect(note).toBe(
      `Claude quota is low for claude:claude-opus-5-5, but its weekly remainder (9%) is lost at the reset (${findings[0].spendToZero.resetsAt}) unless spent: use it or lose it; a quota handoff happens only on exhaustion.`,
    );
    // A low pool that is not expiring still needs confirmation.
    expect(() => quotaGate([{ ...findings[0], spendToZero: null }])).toThrow("--confirm-low-quota");
  });

  it("refuses a nearly empty pool monitor ranks low room, not use it or lose it", async () => {
    // Weekly 1% resetting in 30 hours with the 5-hour window at 40%: below monitor's 5% floor.
    const findings = await checkRouteQuota(claudeRoute, {
      view: claudeWindows([40, 3], [1, 30], false),
    });
    expect(findings[0]).toMatchObject({ status: "low", spendToZero: null });
    expect(() => quotaGate(findings)).toThrow("--confirm-low-quota");
  });
});
