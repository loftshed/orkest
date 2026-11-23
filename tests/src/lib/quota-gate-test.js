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
});
