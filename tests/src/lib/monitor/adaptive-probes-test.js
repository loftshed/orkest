import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";

import {
  breakerRetryAt,
  probeDeadline,
  recordProbe,
} from "../../../../src/lib/monitor/adaptive-probes.mjs";
import { retainFixtures } from "../../../helpers/retain-fixtures.js";

const cli = fileURLToPath(new URL("../../../../src/bin/monitor.mjs", import.meta.url));
const usage = fileURLToPath(new URL("fixtures/agy-usage.json", import.meta.url));
const run = promisify(execFile);
const temporary = [];
afterEach(() => retainFixtures(temporary.splice(0)));

test("uses bounded successful nearest-rank samples, with cold-start, floor and account ceiling", () => {
  const account = { provider: "codex" };
  let state;
  for (let value = 1; value <= 140; value++) {
    if (value <= 5) expect(probeDeadline(account, state)).toBe(30_000);
    state = recordProbe(state, {
      outcome: "success",
      elapsedMs: value * 100,
      deadlineMs: 30_000,
      now: value,
    });
  }
  expect(state.samplesMs).toHaveLength(128);
  expect(state.samplesMs[0]).toBe(1300);
  expect(state.history).toHaveLength(128);
  expect(state.history[0]).toEqual({
    at: 13,
    outcome: "success",
    elapsedMs: 1300,
    deadlineMs: 30_000,
  });
  expect(state).toMatchObject({ p95Ms: 13_400, p99Ms: 13_900 });
  expect(probeDeadline(account, state)).toBe(26_800);
  expect(probeDeadline({ ...account, timeoutMs: 900 }, state)).toBe(900);
  expect(probeDeadline(account, { samplesMs: [1, 2, 3, 4, 5] })).toBe(1500);
  const timeout = recordProbe(state, {
    outcome: "timeout",
    elapsedMs: 26_800,
    deadlineMs: 26_800,
    now: 1000,
  });
  expect(timeout.samplesMs).toEqual(state.samplesMs);
  expect(probeDeadline(account, timeout)).toBe(30_000);
  let open = timeout;
  for (let i = 0; i < 25; i++)
    open = recordProbe(open, {
      outcome: "timeout",
      elapsedMs: 30_000,
      deadlineMs: 30_000,
      now: 1000,
    });
  expect(open.retryAt).toBe(301_000);
  expect(
    recordProbe(open, { outcome: "error", elapsedMs: 1, deadlineMs: 30_000, now: 1001 }),
  ).toMatchObject({ retryAt: 301_001, consecutiveTimeouts: 0 });
});

test("fresh CLI processes share the timeout breaker, retain verified quota, and recover one probe", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "monitor-adaptive-"));
  temporary.push(dir);
  const cache = path.join(dir, "cache");
  const cfg = path.join(dir, "config.json");
  const command = path.join(dir, "fake-agy");
  await writeFile(
    command,
    String.raw`#!${process.execPath}
const fs=require('node:fs');
const {ACCOUNT, MODE, CALLS, USAGE}=process.env;
fs.appendFileSync(CALLS,ACCOUNT+'\n');
const mode=fs.readFileSync(MODE,'utf8');
if(ACCOUNT==='a' && mode==='hang') setTimeout(()=>{},30000);
else if(ACCOUNT==='a' && mode==='auth') console.error('Authentication required.');
else setTimeout(()=>process.stdout.write(fs.readFileSync(USAGE)), mode==='slow-success' ? 200 : 0);
`,
    { mode: 0o700 },
  );
  const mode = path.join(dir, "mode"),
    calls = path.join(dir, "calls");
  const env = { HOME: dir, PATH: process.env.PATH, MONITOR_CONFIG: cfg, MONITOR_CACHE_DIR: cache };
  const accounts = ["a", "b"].map((id) => ({
    id,
    provider: "antigravity",
    command,
    timeoutMs: 1000,
    env: {
      ACCOUNT: id,
      MODE: mode,
      CALLS: calls,
      USAGE: usage,
      GEMINI_CLI_HOME: path.join(dir, id),
    },
  }));
  await writeFile(cfg, JSON.stringify({ accounts }));
  const refresh = async (...args) =>
    run(process.execPath, [cli, "json", ...args], { env, timeout: 15_000 });
  const snapshot = path.join(cache, "snapshot.json");
  const read = async () => JSON.parse(await readFile(snapshot, "utf8"));
  const count = async (id) =>
    (await readFile(calls, "utf8")).split("\n").filter((line) => line === id).length;
  await writeFile(mode, "ok");
  await refresh("--refresh");
  const good = (await read()).accounts.a;
  // Upgrade an old on-disk snapshot that predates probeHealth.
  const legacy = await read();
  delete legacy.accounts.a.probeHealth;
  await writeFile(snapshot, JSON.stringify(legacy));
  await writeFile(mode, "hang");
  await refresh("--refresh");
  await refresh("--refresh");
  const failed = (await read()).accounts.a;
  const observed = JSON.parse((await refresh()).stdout).accounts.find((a) => a.id === "a");
  expect(observed.probe).toMatchObject({
    lastOutcome: "timeout",
    retryAt: new Date(failed.probeHealth.retryAt).toISOString(),
  });
  expect(observed.probe.samplesMs).toBeUndefined();
  expect(failed).toMatchObject({
    ok: false,
    fetchedAt: good.fetchedAt,
    windows: good.windows,
    probeHealth: { lastOutcome: "timeout", consecutiveTimeouts: 2, samplesMs: [] },
  });
  expect(failed.probeHealth.history.map((entry) => entry.outcome)).toEqual(["timeout", "timeout"]);
  expect(failed.probeHealth.retryAt).toBeGreaterThan(Date.now());
  await refresh("--refresh");
  expect(await count("a")).toBe(3);
  expect(await count("b")).toBe(4);
  expect((await read()).accounts.a.probeHealth.history).toEqual(failed.probeHealth.history);
  const due = await read();
  due.accounts.a.probeHealth.retryAt = Date.now() - 1;
  await writeFile(snapshot, JSON.stringify(due));
  await refresh();
  expect(await count("a")).toBe(3); // The default 600s Antigravity floor still applies.
  accounts[0].minRefreshSeconds = 0;
  await writeFile(cfg, JSON.stringify({ accounts }));
  await writeFile(mode, "slow-success");
  await Promise.all([refresh(), refresh()]);
  expect(await count("a")).toBe(4);
  expect(await count("b")).toBe(4);
  expect((await read()).accounts.a).toMatchObject({
    ok: true,
    probeHealth: { retryAt: null, consecutiveTimeouts: 0 },
  });
  await writeFile(mode, "auth");
  await refresh("--refresh");
  expect((await read()).accounts.a.probeHealth.history.map((entry) => entry.outcome)).toEqual([
    "timeout",
    "timeout",
    "success",
    "error",
  ]);
  await refresh("--refresh");
  const afterTwoErrors = (await read()).accounts.a;
  expect(afterTwoErrors.probeHealth.retryAt).toBeGreaterThan(Date.now());
  const attempts = await count("a");
  await refresh("--refresh");
  expect(await count("a")).toBe(attempts);
  // A different profile must not inherit an open breaker or quota windows.
  await mkdir(path.join(dir, "replacement"));
  accounts[0].env.GEMINI_CLI_HOME = path.join(dir, "replacement");
  await writeFile(cfg, JSON.stringify({ accounts }));
  await refresh();
  const replacement = (await read()).accounts.a;
  expect(replacement.windows).toBeUndefined();
  expect(replacement.probeHealth.samplesMs).toEqual([]);
});

test("a warmed Codex JSON-RPC probe enforces the learned deadline on a real child", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "monitor-codex-deadline-"));
  temporary.push(root);
  const cache = path.join(root, "cache");
  const config = path.join(root, "config.json");
  const command = path.join(root, "fake-codex");
  const mode = path.join(root, "mode");
  await writeFile(
    command,
    String.raw`#!${process.execPath}
const fs=require("node:fs");
const send=(id,result)=>process.stdout.write(JSON.stringify({id,result})+"\n");
require("node:readline").createInterface({input:process.stdin}).on("line",line=>{
  const m=JSON.parse(line);
  if(m.id===1) send(1,{});
  if(m.id===2 && fs.readFileSync(process.env.MODE,"utf8")==="ok")
    send(2,{rateLimits:{primary:{usedPercent:25,windowDurationMins:300}}});
});
`,
    { mode: 0o700 },
  );
  await writeFile(
    config,
    JSON.stringify({ accounts: [{ id: "c", provider: "codex", command, env: { MODE: mode } }] }),
  );
  const env = {
    HOME: root,
    PATH: process.env.PATH,
    MONITOR_CONFIG: config,
    MONITOR_CACHE_DIR: cache,
  };
  const refresh = () => run(process.execPath, [cli, "json", "--refresh"], { env, timeout: 12_000 });
  const read = async () =>
    JSON.parse(await readFile(path.join(cache, "snapshot.json"), "utf8")).accounts.c;
  await writeFile(mode, "ok");
  for (let i = 0; i < 5; i++) await refresh();
  const warm = await read();
  expect(warm.ok).toBe(true);
  expect(warm.probeHealth.samplesMs).toHaveLength(5);
  const learned = probeDeadline({ provider: "codex" }, warm.probeHealth);
  expect(learned).toBeLessThan(30_000);
  await writeFile(mode, "hang");
  await refresh();
  const timeout = await read();
  expect(timeout).toMatchObject({
    ok: false,
    windows: warm.windows,
    probeHealth: {
      lastOutcome: "timeout",
      lastDeadlineMs: learned,
      samplesMs: warm.probeHealth.samplesMs,
    },
  });
  expect(timeout.probeHealth.lastDurationMs).toBeGreaterThanOrEqual(learned - 20);
});

test("a successful recovery sustains a slower baseline and a rolled-back clock permits a trial", () => {
  const account = { provider: "claude" };
  let health = { samplesMs: Array.from({ length: 120 }, () => 1000) };
  for (const budget of [2000, 4000, 8000]) {
    expect(probeDeadline(account, health)).toBe(budget);
    health = recordProbe(health, {
      outcome: "timeout",
      elapsedMs: budget,
      deadlineMs: budget,
      now: 10_000,
    });
  }
  expect(breakerRetryAt({ errorAt: 10_000, probeHealth: health }, 1000)).toBe(1000);
  expect(
    breakerRetryAt({ errorAt: 1000, probeHealth: { retryAt: Number.MAX_SAFE_INTEGER } }, 2000),
  ).toBe(2000);
  for (let i = 0; i < 20; i++) {
    const deadlineMs = probeDeadline(account, health);
    expect(deadlineMs).toBeGreaterThan(10_000);
    health = recordProbe(health, {
      outcome: "success",
      elapsedMs: 10_000,
      deadlineMs,
      now: Date.now(),
    });
  }
});

test("a restarted Claude probe recovers after wall-clock rollback and retains its verified quota", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "monitor-claude-rollback-"));
  temporary.push(home);
  const cache = path.join(home, "cache"),
    config = path.join(home, "config.json");
  const mode = path.join(home, "mode"),
    command = path.join(home, "fake-claude");
  await writeFile(
    command,
    `#!${process.execPath}
const fs=require("node:fs");
if(fs.readFileSync(process.env.MODE,"utf8")==="hang") setTimeout(()=>{},30000);
else process.stdout.write(JSON.stringify({type:"result",result:"Current session: 42% used - resets Sep 25 at 3pm (America/Toronto)"}));
`,
    { mode: 0o700 },
  );
  await writeFile(
    config,
    JSON.stringify({
      accounts: [{ id: "c", provider: "claude", command, timeoutMs: 700, env: { MODE: mode } }],
    }),
  );
  const env = {
    HOME: home,
    PATH: process.env.PATH,
    MONITOR_CONFIG: config,
    MONITOR_CACHE_DIR: cache,
  };
  const refresh = (...args) =>
    run(process.execPath, [cli, "json", ...args], { env, timeout: 8000 });
  await writeFile(mode, "ok");
  await refresh("--refresh");
  await writeFile(mode, "hang");
  await refresh("--refresh");
  await refresh("--refresh");
  const file = path.join(cache, "snapshot.json"),
    snapshot = JSON.parse(await readFile(file, "utf8"));
  const account = snapshot.accounts.c;
  expect(account.probeHealth.consecutiveTimeouts).toBe(2);
  expect(account.windows.length).toBeGreaterThan(0);
  account.errorAt = Date.now() + 3_600_000;
  account.probeHealth.retryAt = account.errorAt + 15_000;
  await writeFile(file, JSON.stringify(snapshot));
  await writeFile(mode, "ok");
  const recovered = JSON.parse((await refresh()).stdout).accounts[0];
  expect(recovered).toMatchObject({ ok: true, probe: { retryAt: null, lastOutcome: "success" } });
});
