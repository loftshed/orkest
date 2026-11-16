import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

import { parseCodexRateLimits } from "../../../plugins/monitor/lib/providers/codex.mjs";
import { jsonView, renderReport } from "../../../plugins/monitor/lib/render.mjs";
import { observeResets, resetDetails } from "../../../plugins/monitor/lib/resets.mjs";

const NOW = Date.parse("2026-10-24T12:00:00Z");
const DAY = 86_400_000;
const window = (remainingPct, resetsAt) => ({
  id: "weekly",
  label: "weekly",
  kind: "weekly",
  windowMins: 10_080,
  remainingPct,
  usedPct: 100 - remainingPct,
  resetsAt,
});
const account = (w) => ({
  id: "cx",
  label: "Codex",
  short: "CX",
  provider: "codex",
  fetchedAt: NOW,
  windows: [w],
  pools: [{ id: "codex", families: ["gpt"], windowIds: ["weekly"] }],
});

test("an early refill with a moved date keeps the old date as history, never as a spending deadline", () => {
  const before = account(window(20, NOW + 2 * DAY));
  const after = account(window(100, NOW + 7 * DAY));
  after.resetHistory = observeResets(after, before, NOW);
  const view = jsonView([after], NOW);
  expect(view.accounts[0].resetHistory[0]).toMatchObject({
    previousRemainingPct: 20,
    remainingPct: 100,
    previousResetsAt: "2026-10-26T12:00:00.000Z",
    resetsAt: "2026-10-31T12:00:00.000Z",
    scheduleChanged: true,
  });
  expect(view.lanes[0]).toMatchObject({ weeklyResetsInHours: 168, expiring: false, surplusPts: 0 });
  expect(renderReport([after], { now: NOW })).toContain(
    "Previous dates are history, not confirmed extra refills.",
  );
  const again = { ...after, resetHistory: observeResets(after, after, NOW + 60_000) };
  expect(again.resetHistory).toHaveLength(1);
});

test("Claude refill with an unchanged date preserves the short remaining spending window", () => {
  const before = { ...account(window(10, NOW + DAY)), provider: "claude" };
  const after = { ...before, windows: [window(100, NOW + DAY)] };
  after.resetHistory = observeResets(after, before, NOW);
  const view = jsonView([after], NOW);
  expect(view.accounts[0].resetHistory[0]).toMatchObject({
    scheduleChanged: false,
    previousRemainingPct: 10,
    remainingPct: 100,
  });
  expect(view.lanes[0]).toMatchObject({ expiring: true, weeklyResetsInHours: 24, surplusPts: 86 });
  expect(renderReport([after], { now: NOW })).toContain(
    "Claude free resets preserve the usual weekly rollover.",
  );
  expect(observeResets(after, { ...before, windows: [window(0, NOW - 1)] }, NOW)).toEqual([]);
});

test("Codex bank details retain count-only responses and keep reset expiry separate from rollover", () => {
  const parse = (bank) =>
    parseCodexRateLimits({
      rateLimits: {
        primary: { usedPercent: 40, windowDurationMins: 10_080, resetsAt: (NOW + 6 * DAY) / 1000 },
      },
      rateLimitResetCredits: bank,
    });
  expect(parse({ availableCount: 3, credits: null }).resetCredits).toEqual({
    availableCount: 3,
    credits: null,
  });
  const data = parse({
    availableCount: 3,
    credits: [{ status: "available", expiresAt: (NOW + DAY) / 1000 }],
  });
  const view = jsonView([{ ...account(window(60, NOW + 6 * DAY)), ...data }], NOW);
  expect(view.accounts[0].resetCredits).toEqual({
    availableCount: 3,
    credits: [{ status: "available", expiresAt: "2026-10-25T12:00:00.000Z" }],
  });
  expect(view.lanes[0]).toMatchObject({ weeklyResetsInHours: 144, expiring: false });
  expect(view.accounts[0].resetDetails[0]).toContain("3 banked resets available");
  expect(parse().resetCredits).toBeNull();
});

test("source-linked announcements are separate from pace and disappear after their date", () => {
  const a = {
    ...account(window(50, NOW + 6 * DAY)),
    resetAnnouncements: [
      {
        title: "Provider announcement",
        at: "2026-10-25T12:00:00Z",
        url: "https://example.com/reset",
      },
      { title: "Unsafe source", at: "2026-10-25T12:00:00Z", url: "javascript:alert(1)" },
      { title: "No timezone", at: "2026-10-25T12:00:00", url: "https://example.com/reset" },
    ],
  };
  const view = jsonView([a], NOW);
  expect(view.accounts[0].resetAnnouncements).toEqual([
    {
      title: "Provider announcement",
      at: "2026-10-25T12:00:00.000Z",
      url: "https://example.com/reset",
    },
  ]);
  expect(view.lanes[0]).toMatchObject({ weeklyResetsInHours: 144, expiring: false });
  expect(renderReport([a], { now: NOW })).toContain("eligibility unverified; not used for pacing");
  expect(jsonView([a], NOW + DAY + 1).accounts[0].resetAnnouncements).toEqual([]);
});

test("refreshes persist observations across CLI processes and preserve them on provider failure", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "monitor-resets-"));
  try {
    const config = path.join(dir, "config.json");
    const payload = path.join(dir, "payload.json");
    const binary = path.join(dir, "codex");
    const cache = path.join(dir, "cache");
    mkdirSync(cache);
    writeFileSync(
      binary,
      `#!/usr/bin/env node\nconst fs = require('fs');\nrequire('readline').createInterface({input:process.stdin}).on('line', line => { const m = JSON.parse(line); if(m.id === 1) console.log(JSON.stringify({id:1,result:{}})); if(m.id === 2) console.log(JSON.stringify({id:2,...JSON.parse(fs.readFileSync(${JSON.stringify(payload)},'utf8'))})); });\n`,
    );
    chmodSync(binary, 0o755);
    writeFileSync(
      config,
      JSON.stringify({ accounts: [{ id: "cx", provider: "codex", command: binary }] }),
    );
    const cli = new URL("../../../plugins/monitor/bin/monitor.mjs", import.meta.url).pathname;
    const run = () => {
      const result = spawnSync(process.execPath, [cli, "json", "--refresh"], {
        encoding: "utf8",
        timeout: 15_000,
        env: { ...process.env, MONITOR_CONFIG: config, MONITOR_CACHE_DIR: cache },
      });
      expect(result.status, result.stderr).toBe(0);
      return JSON.parse(result.stdout);
    };
    const deadline = Math.floor(Date.now() / 1000) + (2 * DAY) / 1000;
    const response = (usedPercent, resetsAt) => ({
      result: { rateLimits: { primary: { usedPercent, windowDurationMins: 10_080, resetsAt } } },
    });
    writeFileSync(payload, JSON.stringify(response(80, deadline)));
    expect(run().accounts[0].windows[0].remainingPct).toBe(20);
    writeFileSync(payload, JSON.stringify(response(0, deadline + (5 * DAY) / 1000)));
    expect(run().accounts[0].resetHistory[0]).toMatchObject({
      previousRemainingPct: 20,
      remainingPct: 100,
      scheduleChanged: true,
    });
    writeFileSync(payload, JSON.stringify({ error: { message: "offline" } }));
    expect(run().accounts[0]).toMatchObject({
      ok: false,
      resetHistory: [{ previousRemainingPct: 20, remainingPct: 100, scheduleChanged: true }],
    });
    const saved = JSON.parse(readFileSync(path.join(cache, "snapshot.json")));
    expect(saved.accounts.cx.resetHistory).toHaveLength(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unused full window starting later does not become reset history", () => {
  const before = account(window(100, NOW + 2 * DAY));
  const after = account(window(99, NOW + 7 * DAY));
  expect(observeResets(after, before, NOW)).toEqual([]);
  const previouslyUsed = account(window(70, NOW + 2 * DAY));
  expect(observeResets(after, previouslyUsed, NOW)[0]).toMatchObject({
    scheduleChanged: true,
    previousRemainingPct: 70,
    remainingPct: 99,
  });
  const zeroBank = { ...after, resetCredits: { availableCount: 0, credits: null } };
  expect(jsonView([zeroBank], NOW).accounts[0].resetDetails).toEqual([
    "0 banked resets available; separate from the weekly rollover",
  ]);
});

test("resetDetails omits past rollover cycles and emits schedule-change disclaimer once", () => {
  const pastAndActive = {
    ...account(window(50, NOW + 5 * DAY)),
    provider: "antigravity",
    resetHistory: [
      {
        windowId: "gemini-weekly",
        label: "Gemini weekly",
        observedAt: NOW - 10 * DAY,
        previousResetsAt: NOW - 6 * DAY,
        resetsAt: NOW - DAY,
        previousRemainingPct: 12,
        remainingPct: 100,
        scheduleChanged: true,
      },
      {
        windowId: "gemini-weekly",
        label: "Gemini weekly",
        observedAt: NOW - 2 * DAY,
        previousResetsAt: NOW + DAY,
        resetsAt: NOW + 6 * DAY,
        previousRemainingPct: 5,
        remainingPct: 100,
        scheduleChanged: true,
      },
      {
        windowId: "claude-gpt-weekly",
        label: "Claude & GPT weekly",
        observedAt: NOW - DAY,
        previousResetsAt: NOW + 2 * DAY,
        resetsAt: NOW + 7 * DAY,
        previousRemainingPct: 18,
        remainingPct: 100,
        scheduleChanged: true,
      },
    ],
  };
  const view = jsonView([pastAndActive], NOW);
  expect(view.accounts[0].resetHistory).toHaveLength(3);
  const details = resetDetails(pastAndActive, NOW);
  expect(details.filter((line) => line.startsWith("Gemini weekly:"))).toHaveLength(1);
  expect(details.filter((line) => line.startsWith("Claude & GPT weekly:"))).toHaveLength(1);
  expect(
    details.filter((line) => line === "Previous dates are history, not confirmed extra refills."),
  ).toHaveLength(1);
});

test.skipIf(process.platform !== "darwin")(
  "MonitorBar --dump-menu consolidates reset history, aligns account extras, and compacts lanes",
  () => {
    const dir = mkdtempSync(path.join(tmpdir(), "monitor-menu-"));
    try {
      const appPath = path.join(dir, "Monitor.app");
      const fakeCli = path.join(dir, "fake-monitor.sh");
      const snapshotPath = path.join(dir, "snapshot.json");
      const buildScript = new URL("../../../plugins/monitor/macos/build.sh", import.meta.url)
        .pathname;
      const snapshot = {
        schema: "monitor.snapshot.v1",
        version: "0.19.3",
        generatedAt: "2026-10-24T12:00:00.000Z",
        accounts: [
          {
            id: "cw",
            label: "Claude · work",
            short: "CW",
            provider: "claude",
            plan: "subscription",
            ok: true,
            headline: { text: "90", level: "ok", values: [90], levels: ["ok"] },
            pills: [{ pool: "all", weekly: { pct: 90, level: "ok" } }],
            windows: [
              {
                id: "week",
                label: "weekly",
                kind: "weekly",
                remainingPct: 90,
                resetsAt: "2026-10-29T12:00:00.000Z",
              },
            ],
            resetCredits: { availableCount: 0, credits: null },
            resetDetails: [
              "Claude free resets preserve the usual weekly rollover. Use the current reported date above.",
            ],
            resetAnnouncements: [],
          },
          {
            id: "cx",
            label: "Codex · ChatGPT",
            short: "CX",
            provider: "codex",
            plan: "pro",
            ok: true,
            credits: { text: "45,916.21 cr", level: "ok" },
            headline: { text: "7", level: "low", values: [7], levels: ["low"] },
            pills: [{ pool: "codex", weekly: { pct: 7, level: "low" } }],
            windows: [
              {
                id: "weekly",
                label: "weekly",
                kind: "weekly",
                remainingPct: 7,
                resetsAt: "2026-10-26T12:00:00.000Z",
              },
            ],
            resetCredits: { availableCount: 3, credits: null },
            resetDetails: [
              "3 banked resets available; separate from the weekly rollover",
              "Codex resets can replace the weekly schedule. Use the current reported rollover.",
            ],
            resetAnnouncements: [],
          },
        ],
        lanes: [
          {
            label: "Claude · work · all models",
            accountId: "cw",
            status: "available",
            surplusPts: 30,
            availableNowPct: 90,
            advice: "under-used, spend freely",
            route: "claude",
            redundant: false,
          },
          {
            label: "Antigravity · Claude & GPT",
            accountId: "ag",
            status: "available",
            surplusPts: -8,
            availableNowPct: 70,
            expiring: true,
            expiresAt: "2026-10-25T12:00:00.000Z",
            advice:
              "use it or lose it: 27% of the weekly limit resets Sat 8:25 PM (in 28h); ~1%/h uses it all",
            route: "agy --model claude-opus-4-6-thinking",
            redundant: false,
          },
        ],
      };
      writeFileSync(snapshotPath, JSON.stringify(snapshot));
      writeFileSync(fakeCli, `#!/bin/sh\ncat "${snapshotPath}"\n`);
      chmodSync(fakeCli, 0o755);

      const build = spawnSync(buildScript, [appPath], {
        encoding: "utf8",
        timeout: 60_000,
        env: { ...process.env, MONITOR_COMMAND: fakeCli },
      });
      expect(build.status, build.stderr).toBe(0);

      const binary = path.join(appPath, "Contents", "MacOS", "MonitorBar");
      const dump = spawnSync(binary, ["--dump-menu", "--collapse", ""], {
        encoding: "utf8",
        timeout: 15_000,
        env: { ...process.env, MONITOR_COMMAND: fakeCli },
      });
      expect(dump.status, dump.stderr).toBe(0);
      expect(dump.stdout).not.toContain("Reset details & history");
      expect(dump.stdout).not.toContain("Claude free resets preserve");
      expect(dump.stdout).not.toContain("0 available");
      expect(dump.stdout).not.toContain("--model");
      expect(dump.stdout).not.toContain("use it or lose it:");
      expect(dump.stdout).toContain("  Credit balance      45,916.21 🪙 left");
      expect(dump.stdout).toContain("  Banked resets       3 available");
      expect(dump.stdout).toContain("Reset History");
      expect(dump.stdout).toContain("Display Help");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  60_000,
);
