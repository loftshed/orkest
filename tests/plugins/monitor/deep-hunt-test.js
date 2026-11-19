import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";

// Regression tests from the deep bug hunt. Fake provider CLIs and a private cache only.
const dir = mkdtempSync(path.join(tmpdir(), "monitor-hunt-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const cli = new URL("../../../plugins/monitor/bin/monitor.mjs", import.meta.url).pathname;
const NOW = Date.parse("2026-09-25T16:37:46Z");

function script(name, body) {
  const filePath = path.join(dir, name);
  writeFileSync(filePath, body);
  chmodSync(filePath, 0o755);
  return filePath;
}

const rateLimits = `{ rateLimitsByLimitId: { codex: { limitId: "codex", planType: "pro",
  primary: { usedPercent: 25, windowDurationMins: 10080, resetsAt: Math.floor(Date.now() / 1000) + 86400 } } } }`;

// Sends a server-initiated request that reuses id 2 before answering, as JSON-RPC allows.
const chattyCodex = script(
  "codex-chatty",
  String.raw`#!/usr/bin/env node
const out = (m) => process.stdout.write(JSON.stringify(m) + "\n");
require("readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === 1) { out({ id: 2, method: "account/login/prompt", params: {} }); out({ id: 1, result: {} }); }
  if (m.id === 2 && m.method) out({ id: 2, result: ${rateLimits} });
});
`,
);

const okCodex = script(
  "codex-ok",
  String.raw`#!/usr/bin/env node
const out = (m) => process.stdout.write(JSON.stringify(m) + "\n");
require("readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === 1) out({ id: 1, result: {} });
  if (m.id === 2) out({ id: 2, result: ${rateLimits} });
});
`,
);

test("codex: a server-initiated request reusing our id is not mistaken for the response", async () => {
  const { fetchCodex } = await import("../../../plugins/monitor/lib/providers/codex.mjs");
  const result = await fetchCodex({ command: chattyCodex });
  expect(result.windows[0].remainingPct).toBe(75);
});

test("codex: a limit with no windows does not hide the real pool", async () => {
  const { parseCodexRateLimits } = await import("../../../plugins/monitor/lib/providers/codex.mjs");
  const { headline, sections } = await import("../../../plugins/monitor/lib/analyze.mjs");
  const parsed = parseCodexRateLimits({
    rateLimitsByLimitId: {
      codex: {
        limitId: "codex",
        primary: { usedPercent: 48, windowDurationMins: 10_080, resetsAt: 1_790_779_510 },
      },
      code_review: { limitId: "code_review", primary: null, secondary: null },
    },
  });
  const account = { id: "codex", short: "CX", provider: "codex", ok: true, ...parsed };
  expect(headline(account, NOW).text).toBe("52");
  expect(sections([account], NOW).sections.map((s) => [s.label, s.entries.length])).toStrictEqual([
    ["wk", 1],
  ]);
});

test("claude: /usage lines with other separators or parenthesised resets still parse", async () => {
  const { parseClaudeUsage } = await import("../../../plugins/monitor/lib/providers/claude.mjs");
  const r = parseClaudeUsage(
    [
      "Current session: 42% used - resets Sep 25 at 3pm (America/Toronto)",
      "Current week (all models): 11% used (resets Sep 28 at 5pm (America/Toronto))",
    ].join("\n"),
    NOW,
  );
  expect(
    r.windows.map((w) => [w.id, w.remainingPct, new Date(w.resetsAt).toISOString()]),
  ).toStrictEqual([
    ["5h", 58, "2026-09-25T19:00:00.000Z"],
    ["week", 89, "2026-09-28T21:00:00.000Z"],
  ]);
});

test("reset text: relative, tomorrow and weekday forms", async () => {
  const { parseResetText } = await import("../../../plugins/monitor/lib/time.mjs");
  const iso = (t) => new Date(parseResetText(t, NOW)).toISOString();
  expect(iso("in 2h 15m")).toBe(new Date(NOW + (2 * 60 + 15) * 60_000).toISOString());
  expect(iso("in 45 minutes")).toBe(new Date(NOW + 45 * 60_000).toISOString());
  expect(iso("tomorrow at 5pm (America/Toronto)")).toBe("2026-09-26T21:00:00.000Z");
  // 2026-09-25 is a Friday; the next Monday is the 28th.
  expect(iso("Monday at 5pm (America/Toronto)")).toBe("2026-09-28T21:00:00.000Z");
  expect(iso("Mon 5pm (America/Toronto)")).toBe("2026-09-28T21:00:00.000Z");
});

test("lock: a slow refresh by a live owner is not stolen, and unlock never removes someone else's lock", async () => {
  const cache = path.join(dir, "cache-lock");
  process.env.MONITOR_CACHE_DIR = cache;
  const store = await import(`../../../plugins/monitor/lib/store.mjs?lock-test`);
  const { lockIsStale, tryLock, unlock, LOCK_DIR } = store._lockInternals;
  const sleeper = spawn("sleep", ["30"]);
  try {
    mkdirSync(LOCK_DIR, { recursive: true });
    writeFileSync(path.join(LOCK_DIR, "owner"), String(sleeper.pid));
    const old = (Date.now() - 200_000) / 1000;
    utimesSync(LOCK_DIR, old, old);
    expect(lockIsStale(), "live owner, 200 s old: still working").toBe(false);
    expect(tryLock()).toBe(false);
    unlock();
    expect(
      existsSync(LOCK_DIR),
      "unlock must not remove a lock this process does not own",
    ).toBeTruthy();
    sleeper.kill();
    await new Promise((resolve) => sleeper.on("exit", resolve));
    expect(lockIsStale(), "dead owner").toBe(true);
    expect(tryLock()).toBe(true);
    unlock();
    expect(existsSync(LOCK_DIR)).toBe(false);
  } finally {
    sleeper.kill();
    delete process.env.MONITOR_CACHE_DIR;
  }
});

test("ranking: a nearly empty pool ranks after pools with room", async () => {
  const { buildLanes } = await import("../../../plugins/monitor/lib/analyze.mjs");
  const week = (pct) => [
    {
      id: "wk",
      label: "weekly",
      kind: "weekly",
      windowMins: 10_080,
      remainingPct: pct,
      usedPct: 100 - pct,
      resetsAt: NOW + 20 * 3_600_000,
    },
  ];
  const account = (id, pct) => ({
    id,
    label: id,
    provider: "codex",
    ok: true,
    fetchedAt: NOW,
    windows: week(pct),
    pools: [{ id: "p", label: "p", families: ["gpt"], windowIds: ["wk"] }],
  });
  // "almost-empty" is ahead of even pace (3% left, 20 h to go) but can barely take a task.
  const lanes = buildLanes([account("almost-empty", 3), account("roomy", 40)], NOW);
  expect(lanes.map((l) => l.accountId)).toStrictEqual(["roomy", "almost-empty"]);
  expect(lanes[1].advice).toMatch(/only 3% usable/);
});

test("ranking: stale ok:false cached account measures pace from fetchedAt and ranks below fresh ok:true account", async () => {
  const { jsonView } = await import("../../../plugins/monitor/lib/render.mjs");
  const DAY = 86_400_000;
  const staleCached = {
    id: "stale-cached",
    label: "Stale Cached",
    short: "SC",
    provider: "codex",
    ok: false,
    error: "refresh failed",
    fetchedAt: NOW - 4 * DAY,
    windows: [
      {
        id: "weekly",
        label: "weekly",
        kind: "weekly",
        windowMins: 10_080,
        remainingPct: 92,
        usedPct: 8,
        resetsAt: NOW + DAY,
      },
    ],
    pools: [{ id: "codex", label: "Codex", families: ["gpt"], windowIds: ["weekly"] }],
  };
  const freshOk = {
    id: "fresh-ok",
    label: "Fresh OK",
    short: "FO",
    provider: "codex",
    ok: true,
    fetchedAt: NOW,
    windows: [
      {
        id: "weekly",
        label: "weekly",
        kind: "weekly",
        windowMins: 10_080,
        remainingPct: 50,
        usedPct: 50,
        resetsAt: NOW + 4 * DAY,
      },
    ],
    pools: [{ id: "codex", label: "Codex", families: ["gpt"], windowIds: ["weekly"] }],
  };
  const view = jsonView([staleCached, freshOk], NOW);
  expect(view.lanes.map((l) => l.accountId)).toStrictEqual(["fresh-ok", "stale-cached"]);
  const staleLane = view.lanes.find((l) => l.accountId === "stale-cached");
  // At fetchedAt (5 days before reset in a 7-day window), evenLeft is ~71.4%, so surplus is ~+21 pts, not phantom +78.
  expect(staleLane.surplusPts).toBe(21);
  expect(staleLane.expiring).toBe(false);
});

// --- MCP server over stdio ---

const config = path.join(dir, "config.json");
writeFileSync(
  config,
  JSON.stringify({
    accounts: [{ id: "codex", provider: "codex", label: "Codex", short: "CX", command: okCodex }],
  }),
);

function mcp(lines) {
  const result = spawnSync(process.execPath, [cli, "mcp"], {
    input: lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n",
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      MONITOR_CONFIG: config,
      MONITOR_CACHE_DIR: path.join(dir, "cache-mcp"),
    },
  });
  return result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

test("mcp: null arguments, batches, invalid messages", () => {
  const out = mcp([
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "recommend", arguments: null } },
    [
      { jsonrpc: "2.0", id: 2, method: "ping" },
      { jsonrpc: "2.0", id: 3, method: "tools/list" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
    ],
    [],
    "42",
  ]);
  const byId = (id) => out.flat().find((m) => m.id === id);
  expect(byId(1).result.isError, byId(1).result?.content?.[0]?.text).toBe(undefined);
  const batch = out.find(Array.isArray);
  expect(
    batch?.map((m) => m.id),
    "a batch gets one array response, notifications omitted",
  ).toStrictEqual([2, 3]);
  expect(
    out.filter((m) => !Array.isArray(m) && m.id === null && m.error?.code === -32_600).length,
    "empty batch and non-object are invalid requests",
  ).toBe(2);
});

test("mcp: get_usage JSON is compact and still carries what agents route on", () => {
  const [res] = mcp([
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_usage", arguments: {} } },
  ]);
  const text = res.result.content[0].text;
  const json = JSON.parse(text.slice(text.indexOf("\n\n{") + 2));
  expect(Object.keys(json)).toStrictEqual(["schema", "generatedAt", "accounts", "lanes"]);
  expect(Object.keys(json.accounts[0]).toSorted((a, b) => a.localeCompare(b, "en"))).toStrictEqual([
    "ageMinutes",
    "billing",
    "error",
    "id",
    "label",
    "ok",
    "provider",
    "windows",
  ]);
  expect(!("pills" in json.accounts[0]) && !("sections" in json)).toBeTruthy();
  const lane = json.lanes[0];
  for (const key of [
    "accountId",
    "advice",
    "availableNowPct",
    "billing",
    "blockedUntil",
    "families",
    "label",
    "poolId",
    "route",
    "status",
    "surplusPts",
  ])
    expect(Object.hasOwn(lane, key), key).toBeTruthy();
  // The fake Codex week resets in 24 h with 75% left: expiring, so the lane says when and how fast to spend it.
  expect(lane.expiring).toBe(true);
  expect(lane.expiresAt && lane.burnPctPerHour > 0).toBeTruthy();
  expect(text).toMatch(/^Expiring soon, spend first: Codex \(75% left, resets in 2[34]h at \d{4}-/);
});

test("agy is probed at most every 10 minutes unless a refresh is forced or the account overrides it", () => {
  const counter = path.join(dir, "agy-calls");
  const fixture = new URL("fixtures/agy-usage.json", import.meta.url).pathname;
  const countingAgy = script(
    "agy-counting",
    `#!/bin/sh\necho x >> "${counter}"\ncat "${fixture}"\n`,
  );
  const calls = () =>
    existsSync(counter) ? readFileSync(counter, "utf8").trim().split("\n").length : 0;
  const run = (cfg, args) => {
    const file = path.join(dir, `config-agy-${cfg.tag}.json`);
    writeFileSync(
      file,
      JSON.stringify({
        accounts: [
          {
            id: "ag",
            provider: "antigravity",
            label: "AG",
            short: "AG",
            command: countingAgy,
            ...cfg.account,
          },
        ],
      }),
    );
    const r = spawnSync(process.execPath, [cli, ...args], {
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        MONITOR_CONFIG: file,
        MONITOR_CACHE_DIR: path.join(dir, `cache-agy-${cfg.tag}`),
      },
    });
    expect(r.status, r.stderr).toBe(0);
  };
  run({ tag: "default" }, ["line", "--max-age", "0"]);
  run({ tag: "default" }, ["line", "--max-age", "0"]);
  expect(calls(), "second read within 10 minutes reuses the cache").toBe(1);
  run({ tag: "default" }, ["line", "--refresh"]);
  expect(calls(), "an explicit refresh always probes").toBe(2);
  run({ tag: "override", account: { minRefreshSeconds: 0 } }, ["line", "--max-age", "0"]);
  run({ tag: "override", account: { minRefreshSeconds: 0 } }, ["line", "--max-age", "0"]);
  expect(calls(), "minRefreshSeconds: 0 removes the floor").toBe(4);
});

test("store: relative CODEX_HOME resolves against homedir and never misattributes cached quota (#14, #15)", async () => {
  const fakeHome = path.join(dir, "fake-home");
  const altCwd = path.join(dir, "alt-cwd");
  const relProfile = "relative-codex-profile";
  const expectedHome = path.join(fakeHome, relProfile);
  mkdirSync(expectedHome, { recursive: true });
  mkdirSync(altCwd, { recursive: true });

  const envPrinterCodex = script(
    "codex-print-env",
    String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const out = (m) => process.stdout.write(JSON.stringify(m) + "\n");
require("readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === 1) out({ id: 1, result: {} });
  if (m.id === 2) {
    fs.writeFileSync(process.env.CODEX_ENV_LOG, JSON.stringify({ cwd: process.cwd(), codexHome: process.env.CODEX_HOME }));
    out({ id: 2, result: ${rateLimits} });
  }
});
`,
  );
  const envLog = path.join(dir, "codex-env.json");
  const cfgPath = path.join(dir, "config-rel.json");
  const cacheDir = path.join(dir, "cache-rel");
  writeFileSync(
    cfgPath,
    JSON.stringify({
      accounts: [
        {
          id: "cx",
          provider: "codex",
          label: "Codex",
          short: "CX",
          command: envPrinterCodex,
          env: { CODEX_HOME: relProfile, CODEX_ENV_LOG: envLog },
        },
      ],
    }),
  );
  const res = spawnSync(process.execPath, [cli, "json", "--refresh"], {
    cwd: altCwd,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, HOME: fakeHome, MONITOR_CONFIG: cfgPath, MONITOR_CACHE_DIR: cacheDir },
  });
  expect(res.status, res.stderr).toBe(0);
  const { realpathSync } = await import("node:fs");
  const view = JSON.parse(res.stdout);
  expect(view.accounts[0].accountHome).toBe(realpathSync(expectedHome));
  const childRecorded = JSON.parse(readFileSync(envLog, "utf8"));
  expect(realpathSync(childRecorded.cwd)).toBe(realpathSync(fakeHome));
  expect(realpathSync(childRecorded.codexHome)).toBe(realpathSync(expectedHome));

  // Changing CODEX_HOME invalidates cached quota and failed refresh does not keep old-home reading.
  const failingCodex = script("codex-fail", "#!/bin/sh\nexit 1\n");
  writeFileSync(
    cfgPath,
    JSON.stringify({
      accounts: [
        {
          id: "cx",
          provider: "codex",
          label: "Codex",
          short: "CX",
          command: failingCodex,
          env: { HOME: fakeHome, CODEX_HOME: path.join(dir, "other-codex") },
        },
      ],
    }),
  );
  const resChanged = spawnSync(process.execPath, [cli, "json", "--max-age", String(100_000)], {
    cwd: altCwd,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, MONITOR_CONFIG: cfgPath, MONITOR_CACHE_DIR: cacheDir },
  });
  expect(resChanged.status, resChanged.stderr).toBe(0);
  const viewChanged = JSON.parse(resChanged.stdout);
  expect(viewChanged.accounts[0].ok).toBe(false);
  expect(viewChanged.accounts[0].accountHome).toBe(path.resolve(dir, "other-codex"));
  expect(viewChanged.accounts[0].accountHome).not.toBe(realpathSync(expectedHome));
  expect(viewChanged.accounts[0].error).toMatch(/exited 1/);
  expect(viewChanged.accounts[0].windows).toEqual([]);

  // Legacy snapshot missing accountHome keeps accountHome: null until refreshed.
  const legacyCache = path.join(dir, "cache-legacy");
  mkdirSync(legacyCache, { recursive: true });
  writeFileSync(
    path.join(legacyCache, "snapshot.json"),
    JSON.stringify({
      version: 1,
      updatedAt: Date.now(),
      accounts: {
        cx: {
          id: "cx",
          provider: "codex",
          ok: true,
          fetchedAt: Date.now(),
          windows: [
            {
              id: "weekly",
              label: "weekly",
              kind: "weekly",
              windowMins: 10_080,
              usedPct: 10,
              remainingPct: 90,
              resetsAt: null,
            },
          ],
          pools: [{ id: "codex", label: "Codex", families: ["gpt"], windowIds: ["weekly"] }],
        },
      },
    }),
  );
  const resLegacy = spawnSync(process.execPath, [cli, "json", "--max-age", "100000"], {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, MONITOR_CONFIG: cfgPath, MONITOR_CACHE_DIR: legacyCache },
  });
  expect(resLegacy.status, resLegacy.stderr).toBe(0);
  const viewLegacy = JSON.parse(resLegacy.stdout);
  expect(viewLegacy.accounts[0].accountHome).toBe(null);
  // #18: Unverified (null) accountHome or mismatched provider in snapshot is never returned as ok quota.
  expect(viewLegacy.accounts[0].ok).toBe(false);
  expect(viewLegacy.accounts[0].windows).toEqual([]);

  // #18: Cross-provider cached entry with matching accountHome is rejected on final read.
  const crossCache = path.join(dir, "cache-cross-provider");
  mkdirSync(crossCache, { recursive: true });
  const otherCodexDir = path.join(dir, "other-codex");
  mkdirSync(otherCodexDir, { recursive: true });
  writeFileSync(
    path.join(crossCache, "snapshot.json"),
    JSON.stringify({
      version: 1,
      updatedAt: Date.now(),
      accounts: {
        cx: {
          id: "cx",
          provider: "claude",
          accountHome: realpathSync(otherCodexDir),
          ok: true,
          fetchedAt: Date.now(),
          windows: [
            {
              id: "weekly",
              label: "weekly",
              kind: "weekly",
              windowMins: 10_080,
              usedPct: 10,
              remainingPct: 90,
              resetsAt: null,
            },
          ],
          pools: [{ id: "all", label: "all", families: ["claude"], windowIds: ["weekly"] }],
        },
      },
    }),
  );
  const crossCfg = path.join(dir, "config-cross.json");
  writeFileSync(
    crossCfg,
    JSON.stringify({
      accounts: [
        {
          id: "cx",
          provider: "codex",
          label: "Codex",
          short: "CX",
          command: failingCodex,
          env: { HOME: fakeHome, CODEX_HOME: otherCodexDir },
        },
      ],
    }),
  );
  const resCross = spawnSync(process.execPath, [cli, "json", "--max-age", "100000"], {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, MONITOR_CONFIG: crossCfg, MONITOR_CACHE_DIR: crossCache },
  });
  expect(resCross.status, resCross.stderr).toBe(0);
  const viewCross = JSON.parse(resCross.stdout);
  expect(viewCross.accounts[0].provider).toBe("codex");
  expect(viewCross.accounts[0].ok).toBe(false);
  expect(viewCross.accounts[0].windows).toEqual([]);

  // #5: fetchClaude & store emit explicit claudeConfigDir vs unsetClaudeConfigDir metadata.
  const fakeClaudeBin = script(
    "claude-usage",
    `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: "Current session: 10% used · resets Jan 1 at 1pm (UTC)" }));
`,
  );
  const { fetchClaude } = await import("../../../plugins/monitor/lib/providers/claude.mjs");
  const defaultClaudeRes = await fetchClaude({
    id: "cw",
    provider: "claude",
    command: fakeClaudeBin,
    configDir: "~/.claude",
  });
  expect(defaultClaudeRes.unsetClaudeConfigDir).toBe(true);
  expect(defaultClaudeRes.claudeConfigDir).toBe(null);

  const relClaudeDir = path.join(fakeHome, "claude-alt");
  mkdirSync(relClaudeDir, { recursive: true });
  const prevHome = process.env.HOME;
  let customClaudeRes;
  try {
    process.env.HOME = fakeHome;
    customClaudeRes = await fetchClaude({
      id: "cp",
      provider: "claude",
      command: fakeClaudeBin,
      configDir: "claude-alt",
    });
  } finally {
    process.env.HOME = prevHome;
  }
  expect(customClaudeRes.unsetClaudeConfigDir).toBe(false);
  expect(customClaudeRes.claudeConfigDir).toBe(path.resolve(fakeHome, "claude-alt"));

  // #3: store.getAccounts carries accountEnv.HOME for default-profile Claude with distinct HOME.
  const secondHome = path.join(dir, "second-claude-home");
  mkdirSync(path.join(secondHome, ".claude"), { recursive: true });
  const cacheSecond = path.join(dir, "cache-second-claude");
  mkdirSync(cacheSecond, { recursive: true });
  const prevCacheDir = process.env.MONITOR_CACHE_DIR;
  let secondAccounts;
  try {
    process.env.MONITOR_CACHE_DIR = cacheSecond;
    const store = await import(`../../../plugins/monitor/lib/store.mjs?second-home-test`);
    secondAccounts = await store.getAccounts({
      force: true,
      config: {
        accounts: [
          {
            id: "claude-second",
            provider: "claude",
            command: fakeClaudeBin,
            configDir: "~/.claude",
            env: { HOME: secondHome },
          },
        ],
      },
    });
  } finally {
    if (prevCacheDir === undefined) delete process.env.MONITOR_CACHE_DIR;
    else process.env.MONITOR_CACHE_DIR = prevCacheDir;
  }
  expect(secondAccounts).toHaveLength(1);
  expect(secondAccounts[0]).toMatchObject({
    id: "claude-second",
    accountHome: path.join(realpathSync(secondHome), ".claude"),
    claudeConfigDir: null,
    unsetClaudeConfigDir: true,
    accountEnv: { HOME: realpathSync(secondHome) },
  });

  // #2: jsonView preserves unsetClaudeConfigDir, claudeConfigDir, and accountEnv end-to-end into handoff.py.
  const { jsonView } = await import("../../../plugins/monitor/lib/render.mjs");
  const serializedView = jsonView(secondAccounts);
  expect(serializedView.accounts[0]).toMatchObject({
    id: "claude-second",
    accountHome: path.join(realpathSync(secondHome), ".claude"),
    claudeConfigDir: null,
    unsetClaudeConfigDir: true,
    accountEnv: { HOME: realpathSync(secondHome) },
  });

  // Autodetected default Claude account (no configDir in config) stays launchable through jsonView -> handoff.
  const autoClaudeHome = path.join(dir, "auto-default-claude-home");
  mkdirSync(path.join(autoClaudeHome, ".claude"), { recursive: true });
  const cacheAuto = path.join(dir, "cache-auto-claude");
  mkdirSync(cacheAuto, { recursive: true });
  let autoAccounts;
  try {
    process.env.HOME = autoClaudeHome;
    process.env.MONITOR_CACHE_DIR = cacheAuto;
    delete process.env.CLAUDE_CONFIG_DIR;
    const store = await import(`../../../plugins/monitor/lib/store.mjs?auto-default-test`);
    autoAccounts = await store.getAccounts({
      force: true,
      config: {
        accounts: [{ id: "claude-auto", provider: "claude", command: fakeClaudeBin }],
      },
    });
  } finally {
    process.env.HOME = prevHome;
    if (prevCacheDir === undefined) delete process.env.MONITOR_CACHE_DIR;
    else process.env.MONITOR_CACHE_DIR = prevCacheDir;
  }
  const autoView = jsonView(autoAccounts);
  expect(autoView.accounts[0]).toMatchObject({
    id: "claude-auto",
    configDir: null,
    claudeConfigDir: null,
    unsetClaudeConfigDir: true,
    accountHome: path.join(realpathSync(autoClaudeHome), ".claude"),
  });

  const scriptsDir = new URL(
    "../../../plugins/orchestrate/skills/orchestrate/scripts",
    import.meta.url,
  ).pathname;
  const handoffProbe = spawnSync(
    "python3",
    [
      "-c",
      `
import json, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import handoff, succession
view = json.loads(sys.argv[2])
config = {"accounts": [{"id": "claude-auto", "provider": "claude", "billing": "personal"}]}
entry = config["accounts"][0]
binding = handoff._claude_launch_binding(succession, entry, config, view["accounts"][0])
print(json.dumps({
    "launchable": binding[0],
    "accountHome": binding[1],
    "configDir": binding[2],
    "launchEnv": binding[3],
}))
`,
      scriptsDir,
      JSON.stringify(autoView),
    ],
    { encoding: "utf8" },
  );
  expect(handoffProbe.status).toBe(0);
  expect(JSON.parse(handoffProbe.stdout)).toEqual({
    launchable: true,
    accountHome: path.join(realpathSync(autoClaudeHome), ".claude"),
    configDir: null,
    launchEnv: {
      CLAUDE_CONFIG_DIR: null,
      ORKEST_CLAUDE_ACCOUNT_HOME: realpathSync(autoClaudeHome),
      ORKEST_PINNED_CLAUDE_ACCOUNT: "1",
    },
  });
});

test("store & claude: honor env.CLAUDE_CONFIG_DIR, distinct AGY app-data dirs, first-probe errors, and account metadata", async () => {
  const { realpathSync } = await import("node:fs");
  const { fetchClaude } = await import("../../../plugins/monitor/lib/providers/claude.mjs");

  const fakeHome = path.join(dir, "claude-env-home");
  const defaultClaude = path.join(fakeHome, ".claude");
  const workClaude = path.join(fakeHome, ".claude-work");
  const secondHome = path.join(dir, "claude-env-second-home");
  const secondDefaultClaude = path.join(secondHome, ".claude");
  const secondWorkClaude = path.join(secondHome, ".claude-work");
  for (const p of [defaultClaude, workClaude, secondDefaultClaude, secondWorkClaude]) {
    mkdirSync(p, { recursive: true });
  }

  const envClaudeBin = script(
    "claude-env-probe",
    `#!/usr/bin/env node
const fs = require("node:fs");
if (process.env.CLAUDE_ENV_LOG) {
  fs.writeFileSync(
    process.env.CLAUDE_ENV_LOG,
    JSON.stringify({
      claudeConfigDir: process.env.CLAUDE_CONFIG_DIR ?? null,
      home: process.env.HOME ?? null,
    }),
  );
}
process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: "Current session: 15% used · resets Jan 1 at 1pm (UTC)" }));
`,
  );

  const prevHome = process.env.HOME;
  const prevCacheDir = process.env.MONITOR_CACHE_DIR;
  try {
    process.env.HOME = fakeHome;

    // 1. fetchClaude honors env.CLAUDE_CONFIG_DIR for alternate profile and unsets for default profile
    const workEnvLog = path.join(dir, "claude-work-env.json");
    const workRes = await fetchClaude({
      id: "cw-env",
      provider: "claude",
      command: envClaudeBin,
      env: { CLAUDE_CONFIG_DIR: "~/.claude-work", CLAUDE_ENV_LOG: workEnvLog },
    });
    expect(workRes.unsetClaudeConfigDir).toBe(false);
    expect(workRes.claudeConfigDir).toBe(path.resolve(workClaude));
    expect(JSON.parse(readFileSync(workEnvLog, "utf8")).claudeConfigDir).toBe(
      path.resolve(workClaude),
    );

    const defEnvLog = path.join(dir, "claude-def-env.json");
    const defRes = await fetchClaude({
      id: "cd-env",
      provider: "claude",
      command: envClaudeBin,
      env: { CLAUDE_CONFIG_DIR: "~/.claude", CLAUDE_ENV_LOG: defEnvLog },
    });
    expect(defRes.unsetClaudeConfigDir).toBe(true);
    expect(defRes.claudeConfigDir).toBe(null);
    expect(JSON.parse(readFileSync(defEnvLog, "utf8")).claudeConfigDir).toBe(null);

    const secondDefRes = await fetchClaude({
      id: "cs-def-env",
      provider: "claude",
      command: envClaudeBin,
      env: { HOME: secondHome, CLAUDE_CONFIG_DIR: secondDefaultClaude },
    });
    expect(secondDefRes.unsetClaudeConfigDir).toBe(true);
    expect(secondDefRes.claudeConfigDir).toBe(null);

    const secondWorkRes = await fetchClaude({
      id: "cs-work-env",
      provider: "claude",
      command: envClaudeBin,
      env: { HOME: secondHome, CLAUDE_CONFIG_DIR: "~/.claude-work" },
    });
    expect(secondWorkRes.unsetClaudeConfigDir).toBe(false);
    expect(secondWorkRes.claudeConfigDir).toBe(path.resolve(secondWorkClaude));

    // 2. store.getAccounts preserves env.CLAUDE_CONFIG_DIR, distinct ANTIGRAVITY_APP_DATA_DIR homes,
    //    alias/aliases/category/tags/codexHome/agyHome, and first-probe failure messages.
    const profilesRoot = path.join(dir, "agy-profiles");
    const agyRed = path.join(profilesRoot, "antigravity-red");
    const agyBlue = path.join(profilesRoot, "antigravity-blue");
    const codexWork = path.join(dir, "codex-work-home");
    mkdirSync(agyRed, { recursive: true });
    mkdirSync(agyBlue, { recursive: true });
    mkdirSync(codexWork, { recursive: true });

    const agyFixture = new URL("fixtures/agy-usage.json", import.meta.url).pathname;
    const okAgy = script("agy-ok-meta", `#!/bin/sh\ncat "${agyFixture}"\n`);
    const failingAgy = script(
      "agy-fail-auth",
      String.raw`#!/usr/bin/env node
process.stdout.write("Authentication required.\nWaiting for authentication (timeout 60s)...\n");
setTimeout(() => {}, 30_000);
`,
    );

    const cacheMeta = path.join(dir, "cache-meta");
    mkdirSync(cacheMeta, { recursive: true });
    process.env.MONITOR_CACHE_DIR = cacheMeta;
    const store = await import(`../../../plugins/monitor/lib/store.mjs?meta-test`);

    const cfgMeta = {
      accounts: [
        {
          id: "claude-env",
          alias: "c-work",
          aliases: ["work-claude-alt"],
          category: "work",
          tags: ["Team-Alpha"],
          billing: "subscription",
          route: "claude-env-route",
          provider: "claude",
          command: envClaudeBin,
          env: { CLAUDE_CONFIG_DIR: "~/.claude-work" },
        },
        {
          id: "cx-meta",
          alias: "cx-main",
          provider: "codex",
          command: okCodex,
          env: { CODEX_HOME: codexWork },
          billing: "personal",
        },
        {
          id: "ag-red",
          provider: "antigravity",
          command: okAgy,
          env: {
            ANTIGRAVITY_APP_DATA_DIR: agyRed,
            SSH_CONNECTION: null,
            SSH_CLIENT: null,
            SSH_TTY: null,
          },
          tags: ["client-red"],
        },
        {
          id: "ag-blue",
          provider: "antigravity",
          command: failingAgy,
          env: {
            ANTIGRAVITY_APP_DATA_DIR: agyBlue,
            SSH_CONNECTION: null,
            SSH_CLIENT: null,
            SSH_TTY: null,
          },
        },
      ],
    };

    const accounts = await store.getAccounts({ force: true, config: cfgMeta });
    const byId = Object.fromEntries(accounts.map((a) => [a.id, a]));

    expect(byId["claude-env"]).toMatchObject({
      ok: true,
      alias: "c-work",
      aliases: ["work-claude-alt"],
      category: "work",
      tags: ["team-alpha", "work"],
      route: "claude-env-route",
      claudeConfigDir: path.resolve(workClaude),
      unsetClaudeConfigDir: false,
      accountHome: realpathSync(workClaude),
    });
    expect(byId["cx-meta"]).toMatchObject({
      ok: true,
      alias: "cx-main",
      aliases: [],
      category: null,
      tags: ["personal"],
      codexHome: realpathSync(codexWork),
      accountHome: realpathSync(codexWork),
    });
    expect(byId["ag-red"]).toMatchObject({
      ok: true,
      tags: ["client-red"],
      agyHome: realpathSync(agyRed),
      accountHome: realpathSync(agyRed),
    });
    expect(byId["ag-blue"].accountHome).not.toBe(byId["ag-red"].accountHome);
    expect(byId["ag-blue"]).toMatchObject({
      ok: false,
      agyHome: realpathSync(agyBlue),
      accountHome: realpathSync(agyBlue),
    });
    expect(byId["ag-blue"].error).toMatch(/requires interactive authentication/);
    expect(byId["ag-blue"].error).not.toBe("not fetched yet");

    // Re-reading from cache without refresh preserves the real first-probe error for the same home
    const cachedAccounts = await store.getAccounts({ maxAgeSeconds: 100_000, config: cfgMeta });
    const cachedBlue = cachedAccounts.find((a) => a.id === "ag-blue");
    expect(cachedBlue.ok).toBe(false);
    expect(cachedBlue.error).toMatch(/requires interactive authentication/);
    expect(cachedBlue.accountHome).toBe(realpathSync(agyBlue));

    // Changing ANTIGRAVITY_APP_DATA_DIR from agyRed to agyBlue invalidates ag-red's cached quota
    const movedRed = await store.getAccounts({
      maxAgeSeconds: 100_000,
      config: {
        accounts: [
          {
            id: "ag-red",
            provider: "antigravity",
            command: failingAgy,
            env: {
              ANTIGRAVITY_APP_DATA_DIR: agyBlue,
              SSH_CONNECTION: null,
              SSH_CLIENT: null,
              SSH_TTY: null,
            },
          },
        ],
      },
    });
    expect(movedRed[0].ok).toBe(false);
    expect(movedRed[0].windows ?? []).toEqual([]);
    expect(movedRed[0].accountHome).toBe(realpathSync(agyBlue));
    expect(movedRed[0].error).toMatch(/requires interactive authentication/);

    // 3. Antigravity profiles sharing GEMINI_CLI_HOME with distinct ANTIGRAVITY_APP_DATA_DIR keep
    //    distinct cache identities and invalidate cleanly when either env var changes.
    const commonGemini = path.join(dir, "gemini-common");
    const otherGemini = path.join(dir, "gemini-other");
    const sharedProfileA = path.join(profilesRoot, "antigravity-shared-a");
    const sharedProfileB = path.join(profilesRoot, "antigravity-shared-b");
    for (const dirPath of [commonGemini, otherGemini, sharedProfileA, sharedProfileB]) {
      mkdirSync(dirPath, { recursive: true });
    }
    const sharedCfg = {
      accounts: [
        {
          id: "ag-shared-1",
          provider: "antigravity",
          command: okAgy,
          env: {
            GEMINI_CLI_HOME: commonGemini,
            ANTIGRAVITY_APP_DATA_DIR: sharedProfileA,
            SSH_CONNECTION: null,
            SSH_CLIENT: null,
            SSH_TTY: null,
          },
        },
        {
          id: "ag-shared-2",
          provider: "antigravity",
          command: failingAgy,
          env: {
            GEMINI_CLI_HOME: commonGemini,
            ANTIGRAVITY_APP_DATA_DIR: sharedProfileB,
            SSH_CONNECTION: null,
            SSH_CLIENT: null,
            SSH_TTY: null,
          },
        },
      ],
    };
    const sharedInitial = await store.getAccounts({ force: true, config: sharedCfg });
    const sharedById = Object.fromEntries(sharedInitial.map((a) => [a.id, a]));
    expect(sharedById["ag-shared-1"]).toMatchObject({
      ok: true,
      accountHome: realpathSync(sharedProfileA),
      agyHome: realpathSync(commonGemini),
      appDataDir: realpathSync(sharedProfileA),
      geminiCliHome: realpathSync(commonGemini),
    });
    expect(sharedById["ag-shared-2"]).toMatchObject({
      ok: false,
      accountHome: realpathSync(sharedProfileB),
      agyHome: realpathSync(commonGemini),
      appDataDir: realpathSync(sharedProfileB),
      geminiCliHome: realpathSync(commonGemini),
    });
    expect(sharedById["ag-shared-1"].accountHome).not.toBe(sharedById["ag-shared-2"].accountHome);

    // Switching ANTIGRAVITY_APP_DATA_DIR while keeping the same GEMINI_CLI_HOME invalidates cache.
    const movedSharedAppData = await store.getAccounts({
      maxAgeSeconds: 100_000,
      config: {
        accounts: [
          {
            id: "ag-shared-1",
            provider: "antigravity",
            command: failingAgy,
            env: {
              GEMINI_CLI_HOME: commonGemini,
              ANTIGRAVITY_APP_DATA_DIR: sharedProfileB,
              SSH_CONNECTION: null,
              SSH_CLIENT: null,
              SSH_TTY: null,
            },
          },
        ],
      },
    });
    expect(movedSharedAppData[0]).toMatchObject({
      ok: false,
      accountHome: realpathSync(sharedProfileB),
      appDataDir: realpathSync(sharedProfileB),
      geminiCliHome: realpathSync(commonGemini),
    });
    expect(movedSharedAppData[0].windows ?? []).toEqual([]);

    // Switching only GEMINI_CLI_HOME while keeping ANTIGRAVITY_APP_DATA_DIR also invalidates cache.
    await store.getAccounts({
      force: true,
      config: { accounts: [sharedCfg.accounts[0]] },
    });
    const movedGeminiCliHome = await store.getAccounts({
      maxAgeSeconds: 100_000,
      config: {
        accounts: [
          {
            id: "ag-shared-1",
            provider: "antigravity",
            command: failingAgy,
            env: {
              GEMINI_CLI_HOME: otherGemini,
              ANTIGRAVITY_APP_DATA_DIR: sharedProfileA,
              SSH_CONNECTION: null,
              SSH_CLIENT: null,
              SSH_TTY: null,
            },
          },
        ],
      },
    });
    expect(movedGeminiCliHome[0]).toMatchObject({
      ok: false,
      accountHome: realpathSync(sharedProfileA),
      agyHome: realpathSync(otherGemini),
      appDataDir: realpathSync(sharedProfileA),
      geminiCliHome: realpathSync(otherGemini),
    });
    expect(movedGeminiCliHome[0].windows ?? []).toEqual([]);
    expect(movedGeminiCliHome[0].error).toMatch(/requires interactive authentication/);

    // 4. Astra #7-JS: Codex and Antigravity expand ~ and relative provider paths against account.env.HOME.
    const subHome = path.join(dir, "sub-account-home");
    const subCodex = path.join(subHome, "cx-tilde");
    const subCodexRel = path.join(subHome, "cx-rel");
    const subGemini = path.join(subHome, "gem-tilde");
    const subAgyRel = path.join(subHome, "ag-rel");
    for (const d of [subHome, subCodex, subCodexRel, subGemini, subAgyRel]) {
      mkdirSync(d, { recursive: true });
    }
    const envLogCodex = script(
      "codex-env-log",
      String.raw`#!/usr/bin/env node
const fs = require("node:fs");
if (process.env.CODEX_ENV_LOG) {
  fs.writeFileSync(process.env.CODEX_ENV_LOG, JSON.stringify({
    HOME: process.env.HOME,
    CODEX_HOME: process.env.CODEX_HOME,
  }));
}
const out = (m) => process.stdout.write(JSON.stringify(m) + "\n");
require("readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === 1) out({ id: 1, result: {} });
  if (m.id === 2) out({ id: 2, result: ${rateLimits} });
});
`,
    );
    const { fetchCodex } = await import("../../../plugins/monitor/lib/providers/codex.mjs");
    const cxLogTilde = path.join(dir, "cx-tilde-env.json");
    await fetchCodex({
      command: envLogCodex,
      env: { HOME: subHome, CODEX_HOME: "~/cx-tilde", CODEX_ENV_LOG: cxLogTilde },
    });
    expect(JSON.parse(readFileSync(cxLogTilde, "utf8"))).toEqual({
      HOME: path.resolve(subHome),
      CODEX_HOME: path.resolve(subCodex),
    });

    const cxLogRel = path.join(dir, "cx-rel-env.json");
    await fetchCodex({
      command: envLogCodex,
      env: { HOME: subHome, CODEX_HOME: "cx-rel", CODEX_ENV_LOG: cxLogRel },
    });
    expect(JSON.parse(readFileSync(cxLogRel, "utf8"))).toEqual({
      HOME: path.resolve(subHome),
      CODEX_HOME: path.resolve(subCodexRel),
    });

    const { probeEnv } = await import("../../../plugins/monitor/lib/providers/antigravity.mjs");
    writeFileSync(path.join(subAgyRel, "antigravity-oauth-token"), "tok");
    const savedSsh = Object.fromEntries(
      ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"].map((name) => [name, process.env[name]]),
    );
    for (const name of Object.keys(savedSsh)) delete process.env[name];
    let agyProbeEnv;
    try {
      agyProbeEnv = probeEnv(
        {
          HOME: subHome,
          GEMINI_CLI_HOME: "~/gem-tilde",
          ANTIGRAVITY_APP_DATA_DIR: "ag-rel",
        },
        { platform: "linux" },
      );
    } finally {
      for (const [name, value] of Object.entries(savedSsh)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
    expect(agyProbeEnv.HOME).toBe(path.resolve(subHome));
    expect(agyProbeEnv.GEMINI_CLI_HOME).toBe(path.resolve(subGemini));
    expect(agyProbeEnv.ANTIGRAVITY_APP_DATA_DIR).toBe(path.resolve(subAgyRel));
    expect(agyProbeEnv.SSH_CONNECTION).toBe("127.0.0.1 0 127.0.0.1 22");

    const subStoreRes = await store.getAccounts({
      force: true,
      config: {
        accounts: [
          {
            id: "cx-sub-home",
            provider: "codex",
            command: okCodex,
            env: { HOME: subHome, CODEX_HOME: "~/cx-tilde" },
          },
          {
            id: "ag-sub-home",
            provider: "antigravity",
            command: okAgy,
            env: {
              HOME: subHome,
              GEMINI_CLI_HOME: "~/gem-tilde",
              ANTIGRAVITY_APP_DATA_DIR: "ag-rel",
              SSH_CONNECTION: null,
              SSH_CLIENT: null,
              SSH_TTY: null,
            },
          },
        ],
      },
    });
    const subById = Object.fromEntries(subStoreRes.map((a) => [a.id, a]));
    expect(subById["cx-sub-home"]).toMatchObject({
      ok: true,
      codexHome: realpathSync(subCodex),
      accountHome: realpathSync(subCodex),
    });
    expect(subById["ag-sub-home"]).toMatchObject({
      ok: true,
      agyHome: realpathSync(subGemini),
      appDataDir: realpathSync(subAgyRel),
      geminiCliHome: realpathSync(subGemini),
      accountHome: realpathSync(subAgyRel),
    });

    // 5. Astra #8: Legacy Antigravity cache entries lacking appDataDir/geminiCliHome are NOT falsely
    //    invalidated when config has no selectors, but ARE invalidated once selectors are configured.
    const legacySnapshotPath = path.join(cacheMeta, "snapshot.json");
    const legacyGeminiDefault = path.join(subHome, ".gemini");
    mkdirSync(legacyGeminiDefault, { recursive: true });
    writeFileSync(
      legacySnapshotPath,
      JSON.stringify({
        version: 1,
        accounts: {
          "ag-legacy-no-sel": {
            id: "ag-legacy-no-sel",
            provider: "antigravity",
            accountHome: realpathSync(legacyGeminiDefault),
            ok: true,
            fetchedAt: Date.now(),
            windows: [{ id: "gemini-5h", remainingPct: 91 }],
            pools: [
              { id: "gemini", label: "Gemini", families: ["gemini"], windowIds: ["gemini-5h"] },
            ],
          },
          "ag-legacy-with-sel": {
            id: "ag-legacy-with-sel",
            provider: "antigravity",
            accountHome: realpathSync(subAgyRel),
            ok: true,
            fetchedAt: Date.now(),
            windows: [{ id: "gemini-5h", remainingPct: 12 }],
            pools: [
              { id: "gemini", label: "Gemini", families: ["gemini"], windowIds: ["gemini-5h"] },
            ],
          },
        },
      }),
    );
    const legacyNoSelAccounts = await store.getAccounts({
      maxAgeSeconds: 100_000,
      config: {
        accounts: [
          {
            id: "ag-legacy-no-sel",
            provider: "antigravity",
            command: failingAgy,
            env: {
              HOME: subHome,
              ANTIGRAVITY_APP_DATA_DIR: null,
              GEMINI_CLI_HOME: null,
              SSH_CONNECTION: null,
              SSH_CLIENT: null,
              SSH_TTY: null,
            },
          },
          {
            id: "ag-legacy-with-sel",
            provider: "antigravity",
            command: okAgy,
            env: {
              HOME: subHome,
              ANTIGRAVITY_APP_DATA_DIR: "ag-rel",
              GEMINI_CLI_HOME: null,
              SSH_CONNECTION: null,
              SSH_CLIENT: null,
              SSH_TTY: null,
            },
          },
        ],
      },
    });
    const legacyById = Object.fromEntries(legacyNoSelAccounts.map((a) => [a.id, a]));
    // No selectors in config -> legacy entry preserved without calling failingAgy.
    expect(legacyById["ag-legacy-no-sel"]).toMatchObject({
      ok: true,
      windows: [{ id: "gemini-5h", remainingPct: 91 }],
    });
    // Selector configured in config -> legacy entry without selector fields is invalidated and refreshed.
    expect(legacyById["ag-legacy-with-sel"]).toMatchObject({
      ok: true,
      appDataDir: realpathSync(subAgyRel),
      geminiCliHome: null,
    });
    expect(legacyById["ag-legacy-with-sel"].windows[0].remainingPct).not.toBe(12);
    const persistedAfterLegacy = JSON.parse(readFileSync(legacySnapshotPath, "utf8"));
    expect(persistedAfterLegacy.accounts["ag-legacy-with-sel"]).toMatchObject({
      appDataDir: realpathSync(subAgyRel),
      geminiCliHome: null,
    });
  } finally {
    process.env.HOME = prevHome;
    if (prevCacheDir === undefined) delete process.env.MONITOR_CACHE_DIR;
    else process.env.MONITOR_CACHE_DIR = prevCacheDir;
  }
});
