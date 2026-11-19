import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createChiefBridge,
  emitChiefEvents,
} from "../../../src/lib/chief-bridge.mjs";
import {
  deliveryStatePath,
  openDeliveryStore,
} from "../../../src/lib/chief-delivery.mjs";
import { openOrkestSqlite } from "../../../src/lib/orkest-sqlite.mjs";
import { moveFixtureAside, retainFixtures } from "../../helpers/retain-fixtures.js";

const BRIDGE_URL = new URL("../../../src/lib/chief-bridge.mjs", import.meta.url)
  .href;
const ctx = { tmp: "", configFile: "", hooks: "", recorded: "", log: "", flag: "" };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const statePath = () => deliveryStatePath(ctx.configFile);
const envFor = () => ({ ORK_CHIEF_BRIDGE_CONFIG: ctx.configFile });
const done = (key, extra = {}) => ({ event: "done", roomId: "room-1", key, ...extra });

function writeConfig(value) {
  fs.mkdirSync(path.dirname(ctx.configFile), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(ctx.configFile), 0o700);
  fs.writeFileSync(ctx.configFile, JSON.stringify(value), { mode: 0o600 });
  fs.chmodSync(ctx.configFile, 0o600);
}

function writeHook(name, script) {
  fs.mkdirSync(ctx.hooks, { recursive: true, mode: 0o700 });
  fs.chmodSync(ctx.hooks, 0o700);
  const file = path.join(ctx.hooks, name);
  fs.writeFileSync(file, script, { mode: 0o700 });
  return file;
}

const lines = (file) =>
  fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
const payloads = () => lines(ctx.recorded).map((line) => JSON.parse(line));

async function waitFor(check, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) await sleep(40);
  return check();
}

/** Peeks at the shared state file the way a second process would. */
function readState(fn) {
  const db = openOrkestSqlite(statePath(), { timeout: 2000 });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}
const counts = () =>
  readState((db) => ({
    pending: db.prepare("SELECT COUNT(*) AS n FROM events WHERE state='pending'").get().n,
    sent: db.prepare("SELECT COUNT(*) AS n FROM events WHERE state='sent'").get().n,
  }));

// A real, independent `node` process that does what the CLI does after a committed transition.
const DRIVER = `import { emitChiefEvents } from ${JSON.stringify(BRIDGE_URL)};
const [event, roomId, key] = process.argv.slice(2);
await emitChiefEvents([{ event, roomId, key }], { env: process.env });
`;
function runDriver(key, event = "done") {
  const driver = path.join(ctx.tmp, "driver", "driver.mjs");
  fs.mkdirSync(path.dirname(driver), { recursive: true });
  fs.writeFileSync(driver, DRIVER);
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [driver, event, "room-1", key], {
      env: { PATH: process.env.PATH, HOME: ctx.tmp, ORK_CHIEF_BRIDGE_CONFIG: ctx.configFile },
      stdio: "ignore",
    });
    child.on("close", (status) => resolve({ status, ms: Date.now() - started }));
  });
}

const transport = (overrides = {}) => ({
  lookup: vi.fn(async () => ["93.184.216.34"]),
  https: vi.fn(async () => ({ status: 204 })),
  exec: vi.fn(async () => ({ ok: true })),
  sleep: vi.fn(async () => {}),
  ...overrides,
});
const WEBHOOK = { version: 1, enabled: true, webhook: { url: "https://hooks.example.test/in" } };
const stubSpawn = () =>
  vi.fn(() => ({
    on: () => {},
    unref: () => {},
    stdin: { on: () => {}, unref: () => {}, end: (_input, callback) => callback() },
  }));

beforeEach(() => {
  ctx.tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ork-delivery-test-"));
  fs.chmodSync(ctx.tmp, 0o700);
  ctx.configFile = path.join(ctx.tmp, "cfg", "chief-bridge.json");
  ctx.hooks = path.join(ctx.tmp, "hooks");
  ctx.recorded = path.join(ctx.tmp, "recorded.jsonl");
  ctx.log = path.join(ctx.tmp, "log.txt");
  ctx.flag = path.join(ctx.tmp, "healthy.flag");
});

afterEach(() => retainFixtures([ctx.tmp]));

describe("independent CLI processes share one delivery", () => {
  it("never overlaps sink contacts across simultaneous senders and delivers each event once", async () => {
    const hook = writeHook(
      "slow.sh",
      `#!/bin/sh\necho start >> '${ctx.log}'\nsleep 0.3\ncat >> '${ctx.recorded}'\necho >> '${ctx.recorded}'\necho end >> '${ctx.log}'\n`,
    );
    writeConfig({ version: 1, enabled: true, command: { path: hook } });
    const keys = Array.from({ length: 8 }, (_, index) => `report:${index}`);
    const runs = await Promise.all(keys.map((key) => runDriver(key)));
    for (const run of runs) expect(run.status).toBe(0);
    // Admission has a small budget, so under a simultaneous burst a sender may be told no and queue
    // nothing; the committed transition is unaffected and a repeat of the same record fills the gap.
    await waitFor(() => counts().pending === 0);
    for (const key of keys) expect((await runDriver(key)).status).toBe(0);
    expect(await waitFor(() => payloads().length >= keys.length)).toBe(true);
    await sleep(500);
    const ids = payloads().map((item) => item.id);
    expect(ids).toHaveLength(keys.length);
    expect(new Set(ids).size).toBe(keys.length);
    // Shell appends preserve arrival order, so overlapping hooks produce consecutive starts.
    expect(lines(ctx.log)).toEqual(keys.flatMap(() => ["start", "end"]));
    expect(counts()).toEqual({ pending: 0, sent: keys.length });
  }, 40_000);

  it("returns before a slow sink receives, then receives exactly once and not again on a later re-emit", async () => {
    const hook = writeHook(
      "late.sh",
      `#!/bin/sh\nsleep 1.5\ncat >> '${ctx.recorded}'\necho >> '${ctx.recorded}'\n`,
    );
    writeConfig({ version: 1, enabled: true, command: { path: hook } });
    const first = await runDriver("report:late");
    expect(first.status).toBe(0);
    expect(first.ms).toBeLessThan(1400);
    expect(payloads()).toEqual([]);
    expect(await waitFor(() => payloads().length === 1)).toBe(true);
    await waitFor(() => counts().sent === 1);
    const again = await runDriver("report:late");
    expect(again.status).toBe(0);
    await sleep(2200);
    expect(payloads()).toHaveLength(1);
  }, 30_000);

  it("opens one shared breaker, holds new events back, then recovers and replays each once", async () => {
    const hook = writeHook(
      "flaky.sh",
      `#!/bin/sh\nif [ -f '${ctx.flag}' ]; then cat >> '${ctx.recorded}'; echo >> '${ctx.recorded}'; exit 0; fi\necho call >> '${ctx.log}'\nexit 1\n`,
    );
    writeConfig({ version: 1, enabled: true, command: { path: hook } });
    // Three failing events, each from its own process, trip the persistent breaker (2 tries each).
    for (const key of ["a", "b", "c"]) {
      await runDriver(key);
      await waitFor(() => counts().pending >= 1);
    }
    expect(await waitFor(() => lines(ctx.log).length >= 6)).toBe(true);
    await waitFor(() =>
      readState(
        (db) => Number(db.prepare("SELECT v FROM meta WHERE k='breaker_until'").get()?.v ?? 0) > 0,
      ),
    );
    expect(lines(ctx.log)).toHaveLength(6);
    // A later distinct event, from a new process after the restart, is queued but never contacts the sink.
    await runDriver("d");
    await sleep(900);
    expect(lines(ctx.log)).toHaveLength(6);
    expect(counts()).toEqual({ pending: 4, sent: 0 });

    // The sink heals and the breaker interval passes: the next event replays everything once.
    fs.writeFileSync(ctx.flag, "ok");
    readState((db) => db.exec("UPDATE meta SET v='0' WHERE k='breaker_until'"));
    await runDriver("e");
    expect(await waitFor(() => payloads().length >= 5)).toBe(true);
    await sleep(600);
    const ids = payloads().map((item) => item.id);
    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
    expect(counts()).toEqual({ pending: 0, sent: 5 });
  }, 60_000);

  it("keeps the original id and timestamp when a failed event is retried after a restart", async () => {
    const hook = writeHook(
      "retry.sh",
      `#!/bin/sh\nif [ -f '${ctx.flag}' ]; then cat >> '${ctx.recorded}'; echo >> '${ctx.recorded}'; exit 0; fi\nexit 1\n`,
    );
    writeConfig({ version: 1, enabled: true, command: { path: hook } });
    await runDriver("report:retry");
    await waitFor(() =>
      readState((db) => db.prepare("SELECT drains FROM events").get()?.drains === 1),
    );
    const before = readState((db) => db.prepare("SELECT id, at FROM events").get());
    await sleep(1100);
    fs.writeFileSync(ctx.flag, "ok");
    await runDriver("report:retry");
    expect(await waitFor(() => payloads().length === 1)).toBe(true);
    expect(payloads()[0]).toMatchObject({ id: before.id, at: before.at });
  }, 30_000);
});

describe("durable bridge state", () => {
  const configureBoth = () => {
    const hook = writeHook("ok.sh", "#!/bin/sh\nexit 0\n");
    writeConfig({
      version: 1,
      enabled: true,
      webhook: { url: "https://hooks.example.test/in", bearerToken: "tok-SECRET-123" },
      command: { path: hook },
    });
  };

  it("keeps an acknowledged sink acknowledged across a restart and retries only the failed one", async () => {
    configureBoth();
    let now = 1_000_000;
    const failing = transport({ https: vi.fn(async () => ({ status: 500 })) });
    const first = createChiefBridge({
      env: envFor(),
      clock: () => now,
      transport: failing,
      isDurable: true,
    });
    expect(await first.emit(done("report:one"))).toMatchObject({
      status: "failed",
      delivered: ["command"],
    });
    await first.close();
    now += 5000;
    const healed = transport();
    const second = createChiefBridge({
      env: envFor(),
      clock: () => now,
      transport: healed,
      isDurable: true,
    });
    expect((await second.emit(done("report:one"))).status).toBe("sent");
    await second.close();
    expect(failing.exec).toHaveBeenCalledTimes(1);
    expect(healed.exec).not.toHaveBeenCalled();
    expect(healed.https).toHaveBeenCalledTimes(1);
    // Same payload bytes, including the original timestamp.
    expect(healed.https.mock.calls[0][0].body).toBe(failing.https.mock.calls[0][0].body);
    const third = createChiefBridge({
      env: envFor(),
      clock: () => now,
      transport: healed,
      isDurable: true,
    });
    expect((await third.emit(done("report:one"))).status).toBe("duplicate");
    await third.close();
  });

  it("holds events while the breaker is open and replays them in order after a restart", async () => {
    writeConfig(WEBHOOK);
    let now = 2_000_000;
    const limits = { breakerFailures: 2, breakerMs: 5000, attempts: 1 };
    const bad = transport({ https: vi.fn(async () => ({ status: 503 })) });
    const first = createChiefBridge({
      env: envFor(),
      clock: () => now,
      transport: bad,
      limits,
      isDurable: true,
    });
    expect((await first.emit(done("a"))).status).toBe("failed");
    // The older failed event is retried first; that second failure opens the breaker, so "b" is held.
    expect(await first.emit(done("b"))).toMatchObject({ status: "queued", reason: "breaker-open" });
    expect(await first.emit(done("c"))).toMatchObject({ status: "queued", reason: "breaker-open" });
    await first.close();
    expect(bad.https).toHaveBeenCalledTimes(2);

    now += 6000;
    const good = transport();
    const second = createChiefBridge({
      env: envFor(),
      clock: () => now,
      transport: good,
      limits,
      isDurable: true,
    });
    expect((await second.emit(done("d"))).status).toBe("sent");
    await second.close();
    expect(good.https).toHaveBeenCalledTimes(4);
    expect(counts()).toEqual({ pending: 0, sent: 4 });
  });

  it("bounds pending entries and the delivered-id ledger", async () => {
    writeConfig(WEBHOOK);
    const { promise: gate, resolve: release } = Promise.withResolvers();
    const slow = transport({
      https: vi.fn(async () => {
        await gate;
        return { status: 204 };
      }),
    });
    const bridge = createChiefBridge({
      env: envFor(),
      transport: slow,
      limits: { pending: 2, replay: 2 },
      isDurable: true,
    });
    const first = bridge.emit(done("a"));
    await vi.waitFor(() => expect(slow.https).toHaveBeenCalledTimes(1));
    expect(await bridge.emit(done("b"))).toMatchObject({ status: "queued" });
    expect(await bridge.emit(done("c"))).toEqual({ status: "dropped", reason: "queue-full" });
    release();
    expect((await first).status).toBe("sent");
    // The lease holder drained the second event too; nothing else was contacted for the dropped one.
    expect(slow.https).toHaveBeenCalledTimes(2);
    for (const key of ["d", "e"]) await bridge.emit(done(key));
    expect(counts().sent).toBeLessThanOrEqual(3);
    // "a" fell out of the replay ledger, so it is accepted again.
    expect((await bridge.emit(done("a"))).status).toBe("sent");
    await bridge.close();
  });

  it("never reroutes queued events to sinks of a changed profile", async () => {
    writeConfig({
      version: 1,
      enabled: true,
      webhook: { url: "https://old.example.test/in", bearerToken: "tok-OLD-111" },
    });
    const bad = transport({ https: vi.fn(async () => ({ status: 500 })) });
    const first = createChiefBridge({
      env: envFor(),
      transport: bad,
      limits: { attempts: 1 },
      isDurable: true,
    });
    expect((await first.emit(done("report:old"))).status).toBe("failed");
    await first.close();
    expect(counts().pending).toBe(1);

    writeConfig({
      version: 1,
      enabled: true,
      webhook: { url: "https://new.example.test/in", bearerToken: "tok-NEW-222" },
    });
    const good = transport();
    const second = createChiefBridge({ env: envFor(), transport: good, isDurable: true });
    expect((await second.emit(done("report:new"))).status).toBe("sent");
    await second.close();
    expect(good.https).toHaveBeenCalledTimes(1);
    expect(good.https.mock.calls[0][0].url).toBe("https://new.example.test/in");
    expect(counts()).toEqual({ pending: 0, sent: 1 });
  });

  it("stores no credentials, URLs, paths, source keys or free text", async () => {
    configureBoth();
    const bridge = createChiefBridge({
      env: envFor(),
      transport: transport({ https: vi.fn(async () => ({ status: 500 })) }),
      limits: { attempts: 1 },
      isDurable: true,
    });
    await bridge.emit(done("report:very-secret-key", { text: "free text", path: "/home/x" }));
    await bridge.close();
    const directory = path.dirname(statePath());
    const stateFiles = fs
      .readdirSync(directory)
      .filter((name) => name.startsWith(path.basename(statePath())));
    expect(stateFiles.length).toBeGreaterThan(0);
    for (const name of stateFiles) {
      const bytes = fs.readFileSync(path.join(directory, name)).toString("latin1");
      for (const secret of [
        "tok-SECRET-123",
        "hooks.example.test",
        "report:very-secret-key",
        "free text",
        "/home/x",
        ctx.tmp,
      ])
        expect(bytes).not.toContain(secret);
      if (name === path.basename(statePath()))
        expect(fs.statSync(path.join(directory, name)).mode & 0o777).toBe(0o600);
    }
  });
});

describe("admission and recovery", () => {
  it("starts one worker for concurrent emitters and none for duplicates", async () => {
    writeConfig(WEBHOOK);
    const spawnFn = stubSpawn();
    await Promise.all(
      ["a", "b", "c", "d"].map((key) => emitChiefEvents([done(key)], { env: envFor(), spawnFn })),
    );
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(counts().pending).toBe(4);
    // Every id is already queued or delivered: a repeat never starts a process on its own either.
    const quiet = stubSpawn();
    const store = openDeliveryStore(statePath());
    store.db?.close?.();
    store.close();
    await emitChiefEvents([done("a")], { env: envFor(), spawnFn: quiet });
    expect(quiet).not.toHaveBeenCalled();
  });

  it("releases the claim at once when the worker cannot start", async () => {
    writeConfig(WEBHOOK);
    const broken = vi.fn(() => {
      throw new Error("EAGAIN");
    });
    await emitChiefEvents([done("a")], { env: envFor(), spawnFn: broken });
    const healthy = stubSpawn();
    await emitChiefEvents([done("b")], { env: envFor(), spawnFn: healthy });
    expect(healthy).toHaveBeenCalledTimes(1);
  });

  it("recovers a lease whose worker never started or died, and fences the stale holder", () => {
    writeConfig(WEBHOOK);
    let now = 10_000_000;
    const store = openDeliveryStore(statePath(), { clock: () => now });
    const { spawnGraceMs, leaseMs } = store.limits;
    expect(store.acquireLease("aaaa", spawnGraceMs)).toBe(true);
    expect(store.acquireLease("bbbb")).toBe(false);
    now += spawnGraceMs + 1;
    expect(store.acquireLease("bbbb")).toBe(true);
    expect(store.renewLease("aaaa")).toBe(false);
    expect(store.renewLease("bbbb")).toBe(true);
    now += leaseMs + 1;
    expect(store.renewLease("bbbb")).toBe(false);
    store.close();
  });

  it("evicts a queue entry after its drain rounds and keeps later events deliverable", async () => {
    writeConfig(WEBHOOK);
    const limits = { maxDrains: 2, attempts: 1, breakerFailures: 99 };
    const bad = transport({ https: vi.fn(async () => ({ status: 500 })) });
    const bridge = createChiefBridge({ env: envFor(), transport: bad, limits, isDurable: true });
    await bridge.emit(done("stuck"));
    await bridge.emit(done("stuck"));
    expect(counts().pending).toBe(1);
    const healed = transport();
    const next = createChiefBridge({ env: envFor(), transport: healed, limits, isDurable: true });
    expect((await next.emit(done("fresh"))).status).toBe("sent");
    expect(healed.https).toHaveBeenCalledTimes(1);
    expect(counts().pending).toBe(0);
    await bridge.close();
    await next.close();
  });
});

describe("optional state hazards", () => {
  it("fails admission promptly when the state file is write-locked, then works once released", async () => {
    writeConfig(WEBHOOK);
    const seed = openDeliveryStore(statePath());
    seed.close();
    const holder = openOrkestSqlite(statePath(), { timeout: 100 });
    holder.exec("BEGIN IMMEDIATE");
    const spawnFn = stubSpawn();
    const started = Date.now();
    try {
      await expect(
        emitChiefEvents([done("a")], { env: envFor(), spawnFn }),
      ).resolves.toBeUndefined();
      const run = await runDriver("b");
      expect(run.status).toBe(0);
      expect(run.ms).toBeLessThan(1500);
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
    expect(Date.now() - started).toBeLessThan(3000);
    expect(spawnFn).not.toHaveBeenCalled();
    expect(counts()).toEqual({ pending: 0, sent: 0 });
    await emitChiefEvents([done("c")], { env: envFor(), spawnFn });
    expect(spawnFn).toHaveBeenCalledTimes(1);
  }, 20_000);

  it("leaves a foreign database untouched: bytes, tables, journal mode and permissions", async () => {
    writeConfig(WEBHOOK);
    const foreign = (setup) => {
      const file = statePath();
      moveFixtureAside(file);
      const db = new DatabaseSync(file);
      setup(db);
      db.close();
      fs.chmodSync(file, 0o644);
      return file;
    };
    const cases = [
      (db) => db.exec("CREATE TABLE notes (x TEXT); INSERT INTO notes VALUES ('keep')"),
      (db) => db.exec("PRAGMA application_id = 12345; CREATE TABLE events (z TEXT)"),
      (db) => db.exec("PRAGMA user_version = 3"),
    ];
    for (const setup of cases) {
      const file = foreign(setup);
      const before = fs.readFileSync(file);
      expect(() => openDeliveryStore(file)).toThrow();
      const spawnFn = stubSpawn();
      await emitChiefEvents([done("a")], { env: envFor(), spawnFn });
      const bridge = createChiefBridge({ env: envFor(), transport: transport(), isDurable: true });
      expect((await bridge.emit(done("a"))).status).toBe("failed");
      await bridge.close();
      expect(spawnFn).not.toHaveBeenCalled();
      expect(fs.readFileSync(file).equals(before)).toBe(true);
      expect(fs.statSync(file).mode & 0o777).toBe(0o644);
      expect(fs.existsSync(`${file}-wal`)).toBe(false);
    }
    // Not a database at all.
    const file = statePath();
    fs.writeFileSync(file, "plain text, not sqlite".repeat(10), { mode: 0o644 });
    const before = fs.readFileSync(file);
    expect(() => openDeliveryStore(file)).toThrow();
    expect(fs.readFileSync(file).equals(before)).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o644);
  });

  it("refuses a newer own-format state and adopts an empty file", () => {
    writeConfig(WEBHOOK);
    const file = statePath();
    const own = openDeliveryStore(file);
    own.close();
    const db = new DatabaseSync(file);
    db.exec("PRAGMA user_version = 99");
    db.close();
    expect(() => openDeliveryStore(file)).toThrow(/newer/u);
    moveFixtureAside(file);
    moveFixtureAside(`${file}-wal`);
    moveFixtureAside(`${file}-shm`);
    fs.writeFileSync(file, "", { mode: 0o600 });
    openDeliveryStore(file).close();
  });
});

describe("disabled path", () => {
  it("opens no state file and starts nothing", async () => {
    const spawnFn = stubSpawn();
    await emitChiefEvents([done("a")], { env: envFor(), spawnFn });
    writeConfig({ ...WEBHOOK, enabled: false });
    await emitChiefEvents([done("a")], { env: envFor(), spawnFn });
    await emitChiefEvents([done("a")], { env: { ...envFor(), ORK_CHIEF_BRIDGE: "0" }, spawnFn });
    const bridge = createChiefBridge({ env: envFor(), transport: transport(), isDurable: true });
    expect(await bridge.emit(done("a"))).toEqual({ status: "disabled" });
    expect(spawnFn).not.toHaveBeenCalled();
    expect(fs.existsSync(statePath())).toBe(false);
  });

  it("keeps the module path resolvable for the detached worker", () => {
    expect(fs.existsSync(fileURLToPath(BRIDGE_URL))).toBe(true);
  });
});
