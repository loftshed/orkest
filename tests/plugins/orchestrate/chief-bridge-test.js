import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildChiefPayload,
  CHIEF_EVENTS,
  chiefEventId,
  createChiefBridge,
  emitChiefEvents,
  isPublicAddress,
  loadChiefBridgeConfig,
  spawnChiefDelivery,
} from "../../../plugins/orchestrate/lib/chief-bridge.mjs";

const ctx = { tmp: "", configFile: "" };

function writeConfig(value, { mode = 0o600, dirMode = 0o700 } = {}) {
  const directory = path.dirname(ctx.configFile);
  fs.mkdirSync(directory, { recursive: true });
  fs.chmodSync(directory, dirMode);
  fs.writeFileSync(ctx.configFile, JSON.stringify(value), { mode });
  fs.chmodSync(ctx.configFile, mode);
}

const WEBHOOK = { version: 1, enabled: true, webhook: { url: "https://hooks.example.test/in" } };
const envFor = () => ({ ORK_CHIEF_BRIDGE_CONFIG: ctx.configFile });
const done = (extra = {}) => ({ event: "done", roomId: "room-1", key: "report:one", ...extra });
const okTransport = (overrides = {}) => ({
  lookup: vi.fn(async () => ["93.184.216.34"]),
  https: vi.fn(async () => ({ status: 204 })),
  exec: vi.fn(async () => ({ ok: true })),
  sleep: vi.fn(async () => {}),
  ...overrides,
});

beforeEach(() => {
  ctx.tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ork-bridge-test-"));
  fs.chmodSync(ctx.tmp, 0o700);
  ctx.configFile = path.join(ctx.tmp, "cfg", "chief-bridge.json");
});

afterEach(() => {
  fs.rmSync(ctx.tmp, { recursive: true, force: true });
});

describe("chief bridge payload", () => {
  it("freezes the payload shape and derives a deterministic opaque id", () => {
    const clock = () => Date.UTC(2026, 0, 2, 3, 4, 5);
    const payload = buildChiefPayload(done(), clock);
    expect(payload).toEqual({
      schema: "ork.chief.event.v1",
      id: chiefEventId({ event: "done", roomId: "room-1", key: "report:one" }),
      event: "done",
      at: "2026-01-02T03:04:05.000Z",
      roomId: "room-1",
    });
    expect(payload.id).toMatch(/^ce_[0-9a-f]{32}$/u);
    expect(JSON.stringify(payload)).not.toContain("report:one");
    expect(buildChiefPayload(done({ key: "report:two" }), clock).id).not.toBe(payload.id);
    expect(buildChiefPayload(done({ event: "failed" }), clock).id).not.toBe(payload.id);
  });

  it("accepts exactly the six events and requires a PR number only for PR events", () => {
    expect(CHIEF_EVENTS).toEqual([
      "done",
      "failed",
      "escalation",
      "question",
      "pr_opened",
      "pr_merged",
    ]);
    expect(buildChiefPayload(done({ event: "update" }))).toBeNull();
    expect(buildChiefPayload(done({ event: "pr_opened" }))).toBeNull();
    expect(buildChiefPayload(done({ event: "pr_merged", prNumber: -1 }))).toBeNull();
    expect(buildChiefPayload(done({ event: "pr_merged", prNumber: 231 })).prNumber).toBe(231);
    expect(buildChiefPayload(done({ prNumber: 9 }))).not.toHaveProperty("prNumber");
    expect(buildChiefPayload(done({ roomId: "../etc" }))).toBeNull();
  });

  it("omits free text, paths and credentials even when the input carries them", () => {
    const payload = buildChiefPayload(
      done({
        text: "secret conversation",
        path: "/home/user/repo",
        token: "tok-123",
        reason: "freeform",
      }),
    );
    expect(Object.keys(payload).toSorted((left, right) => left.localeCompare(right))).toEqual([
      "at",
      "event",
      "id",
      "roomId",
      "schema",
    ]);
  });
});

describe("chief bridge configuration", () => {
  it("is off by default and performs no network or exec", async () => {
    const transport = okTransport();
    const bridge = createChiefBridge({ env: envFor(), transport });
    expect(await bridge.emit(done())).toEqual({ status: "disabled" });
    expect(transport.https).not.toHaveBeenCalled();
    expect(transport.exec).not.toHaveBeenCalled();
    expect(transport.lookup).not.toHaveBeenCalled();
  });

  it("requires explicit enabled:true and honours ORK_CHIEF_BRIDGE=0", async () => {
    writeConfig({ ...WEBHOOK, enabled: false });
    expect(loadChiefBridgeConfig(envFor())).toBeNull();
    writeConfig(WEBHOOK);
    expect(loadChiefBridgeConfig(envFor())).not.toBeNull();
    expect(loadChiefBridgeConfig({ ...envFor(), ORK_CHIEF_BRIDGE: "0" })).toBeNull();
  });

  it("rejects a loose file mode, loose directory, symlink, bad url and unknown event", () => {
    writeConfig(WEBHOOK, { mode: 0o644 });
    expect(loadChiefBridgeConfig(envFor())).toBeNull();
    fs.rmSync(path.dirname(ctx.configFile), { recursive: true });
    writeConfig(WEBHOOK, { dirMode: 0o755 });
    expect(loadChiefBridgeConfig(envFor())).toBeNull();
    fs.rmSync(path.dirname(ctx.configFile), { recursive: true });

    writeConfig(WEBHOOK);
    const real = path.join(ctx.tmp, "cfg", "real.json");
    fs.renameSync(ctx.configFile, real);
    fs.symlinkSync(real, ctx.configFile);
    expect(loadChiefBridgeConfig(envFor())).toBeNull();
    fs.rmSync(ctx.configFile);
    fs.renameSync(real, ctx.configFile);

    for (const bad of [
      { webhook: { url: ["http", "hooks.example.test/in"].join("://") } },
      { webhook: { url: "https://user:pw@hooks.example.test/in" } },
      { webhook: { url: "not a url" } },
      { ...WEBHOOK, events: ["done", "update"] },
      { command: { path: "relative/hook" } },
    ]) {
      writeConfig({ version: 1, enabled: true, ...bad });
      expect(loadChiefBridgeConfig(envFor())).toBeNull();
    }
  });

  it("ignores a symlinked config directory", () => {
    const real = path.join(ctx.tmp, "realdir");
    fs.mkdirSync(real, { mode: 0o700 });
    fs.writeFileSync(path.join(real, "chief-bridge.json"), JSON.stringify(WEBHOOK), {
      mode: 0o600,
    });
    fs.symlinkSync(real, path.join(ctx.tmp, "linkdir"));
    expect(
      loadChiefBridgeConfig({
        ORK_CHIEF_BRIDGE_CONFIG: path.join(ctx.tmp, "linkdir", "chief-bridge.json"),
      }),
    ).toBeNull();
  });
});

describe("address policy", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "fe80::1",
    "fc00::1",
    "fd12:3456::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:10.0.0.1",
    "::ffff:a00:1",
    "::127.0.0.1",
    "64:ff9b::7f00:1",
    "2002:7f00:1::1",
    "2001:db8::1",
    "2001:0:4136:e378::1",
    "fe80::1%eth0",
    "not-an-ip",
    "",
  ])("denies %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each([
    "93.184.216.34",
    "8.8.8.8",
    "2606:4700:4700::1111",
    "::ffff:8.8.8.8",
    "64:ff9b::808:808",
  ])("allows %s", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });
});

describe("webhook delivery", () => {
  beforeEach(() => writeConfig(WEBHOOK));

  it("posts the allowlisted payload once, pinned to the checked address with the TLS name", async () => {
    const transport = okTransport();
    const bridge = createChiefBridge({ env: envFor(), clock: () => 1_700_000_000_000, transport });
    expect(await bridge.emit(done())).toMatchObject({ status: "sent" });
    expect(transport.https).toHaveBeenCalledTimes(1);
    const request = transport.https.mock.calls[0][0];
    expect(request).toMatchObject({
      url: "https://hooks.example.test/in",
      address: "93.184.216.34",
      family: 4,
      servername: "hooks.example.test",
    });
    const body = JSON.parse(request.body);
    expect(Object.keys(body).toSorted((left, right) => left.localeCompare(right))).toEqual([
      "at",
      "event",
      "id",
      "roomId",
      "schema",
    ]);
    expect(request.headers.authorization).toBeUndefined();
    expect(request.body).not.toMatch(/report:one/u);
  });

  it("sends a configured bearer token only as a header", async () => {
    writeConfig({ ...WEBHOOK, webhook: { ...WEBHOOK.webhook, bearerToken: "tok-secret" } });
    const transport = okTransport();
    await createChiefBridge({ env: envFor(), transport }).emit(done());
    const request = transport.https.mock.calls[0][0];
    expect(request.headers.authorization).toBe("Bearer tok-secret");
    expect(request.body).not.toContain("tok-secret");
  });

  it.each([
    ["private A record", ["10.0.0.5"]],
    ["loopback", ["127.0.0.1"]],
    ["link-local metadata", ["169.254.169.254"]],
    ["IPv4-mapped IPv6", ["::ffff:127.0.0.1"]],
    ["IPv6 unique-local", ["fd00::1"]],
    ["a mixed answer", ["93.184.216.34", "10.0.0.5"]],
    ["an empty answer", []],
  ])("refuses to connect for %s", async (_name, addresses) => {
    const transport = okTransport({ lookup: vi.fn(async () => addresses) });
    const bridge = createChiefBridge({ env: envFor(), transport });
    expect((await bridge.emit(done())).status).toBe("failed");
    expect(transport.https).not.toHaveBeenCalled();
  });

  it("refuses a literal private address without a lookup", async () => {
    writeConfig({ version: 1, enabled: true, webhook: { url: "https://192.168.0.9/in" } });
    const transport = okTransport();
    expect((await createChiefBridge({ env: envFor(), transport }).emit(done())).status).toBe(
      "failed",
    );
    expect(transport.https).not.toHaveBeenCalled();
    expect(transport.lookup).not.toHaveBeenCalled();
  });

  it("treats a redirect, a server error and a thrown transport as failures and retries once", async () => {
    for (const https of [
      vi.fn(async () => ({ status: 302 })),
      vi.fn(async () => ({ status: 500 })),
      vi.fn(async () => {
        throw new Error("timeout");
      }),
    ]) {
      const transport = okTransport({ https });
      const bridge = createChiefBridge({ env: envFor(), transport });
      expect((await bridge.emit(done())).status).toBe("failed");
      expect(https).toHaveBeenCalledTimes(2);
      expect(transport.sleep).toHaveBeenCalledTimes(1);
    }
  });

  it("succeeds on the retry and suppresses an in-process replay of the same record", async () => {
    const https = vi.fn().mockResolvedValueOnce({ status: 503 }).mockResolvedValue({ status: 200 });
    const bridge = createChiefBridge({ env: envFor(), transport: okTransport({ https }) });
    expect((await bridge.emit(done())).status).toBe("sent");
    expect(https).toHaveBeenCalledTimes(2);
    expect((await bridge.emit(done())).status).toBe("duplicate");
    expect(https).toHaveBeenCalledTimes(2);
    expect((await bridge.emit(done({ key: "report:two" }))).status).toBe("sent");
  });

  it("derives the same id in a fresh bridge, as after a process restart", async () => {
    const first = okTransport();
    const second = okTransport();
    await createChiefBridge({ env: envFor(), transport: first }).emit(done());
    await createChiefBridge({ env: envFor(), transport: second }).emit(done());
    expect(JSON.parse(first.https.mock.calls[0][0].body).id).toBe(
      JSON.parse(second.https.mock.calls[0][0].body).id,
    );
  });

  it("bounds the replay memory and the pending queue", async () => {
    const { promise: gate, resolve: release } = Promise.withResolvers();
    const https = vi.fn(async () => {
      await gate;
      return { status: 200 };
    });
    const bridge = createChiefBridge({
      env: envFor(),
      transport: okTransport({ https }),
      limits: { pending: 2, replay: 2 },
    });
    const first = bridge.emit(done({ key: "a" }));
    const second = bridge.emit(done({ key: "b" }));
    const third = await bridge.emit(done({ key: "c" }));
    expect(third).toEqual({ status: "dropped", reason: "queue-full" });
    release();
    expect((await first).status).toBe("sent");
    expect((await second).status).toBe("sent");
    // Replay memory holds two ids: "a" was evicted once "b" and "d" arrived.
    await bridge.emit(done({ key: "d" }));
    expect((await bridge.emit(done({ key: "a" }))).status).toBe("sent");
  });

  it("opens a breaker after repeated failures and closes it after the interval", async () => {
    let now = 1_000_000;
    const https = vi.fn(async () => ({ status: 500 }));
    const bridge = createChiefBridge({
      env: envFor(),
      clock: () => now,
      transport: okTransport({ https }),
      limits: { breakerFailures: 2, breakerMs: 5000, attempts: 1 },
    });
    await bridge.emit(done({ key: "a" }));
    await bridge.emit(done({ key: "b" }));
    const calls = https.mock.calls.length;
    expect(await bridge.emit(done({ key: "c" }))).toEqual({
      status: "dropped",
      reason: "breaker-open",
    });
    expect(https.mock.calls.length).toBe(calls);
    now += 6000;
    await bridge.emit(done({ key: "d" }));
    expect(https.mock.calls.length).toBe(calls + 1);
  });

  it("filters events outside the configured subset", async () => {
    writeConfig({ ...WEBHOOK, events: ["failed"] });
    const transport = okTransport();
    expect((await createChiefBridge({ env: envFor(), transport }).emit(done())).status).toBe(
      "ignored",
    );
    expect(transport.https).not.toHaveBeenCalled();
  });

  it("never throws or rejects for hostile input", async () => {
    const bridge = createChiefBridge({ env: envFor(), transport: okTransport() });
    for (const input of [
      null,
      undefined,
      5,
      "x",
      {},
      { event: "done" },
      { event: "done", roomId: 1 },
    ]) {
      await expect(bridge.emit(input)).resolves.toBeTruthy();
    }
    const throwing = { emit: vi.fn(() => Promise.reject(new Error("x"))) };
    await expect(emitChiefEvents([done()], { bridge: throwing })).resolves.toBeUndefined();
  });
});

describe("command delivery", () => {
  const hookDir = () => path.join(ctx.tmp, "hooks");

  function writeHook(script, { mode = 0o700 } = {}) {
    fs.mkdirSync(hookDir(), { recursive: true, mode: 0o700 });
    fs.chmodSync(hookDir(), 0o700);
    const file = path.join(hookDir(), "hook.sh");
    fs.writeFileSync(file, script, { mode });
    fs.chmodSync(file, mode);
    return file;
  }

  it("runs a disposable executable with argv, no shell, a bounded env and the payload on stdin", async () => {
    const out = path.join(ctx.tmp, "out.txt");
    const file = writeHook(
      `#!/bin/sh\n{ cat; echo; echo "$ORK_CHIEF_EVENT|$ORK_CHIEF_ROOM|$#|$1|$SECRET|$HOME"; } > '${out}'\n`,
    );
    writeConfig({ version: 1, enabled: true, command: { path: file, args: ["a b;c"] } });
    const bridge = createChiefBridge({
      env: { ...envFor(), SECRET: "leak" },
      transport: { sleep: async () => {} },
    });
    expect((await bridge.emit(done())).status).toBe("sent");
    const [json, line] = fs.readFileSync(out, "utf8").trim().split("\n", 2);
    expect(JSON.parse(json)).toMatchObject({ event: "done", roomId: "room-1" });
    expect(line).toBe("done|room-1|1|a b;c||");
  });

  it("kills a hook that outlives its lifespan", async () => {
    const file = writeHook("#!/bin/sh\nsleep 30\n");
    writeConfig({ version: 1, enabled: true, command: { path: file } });
    const bridge = createChiefBridge({
      env: envFor(),
      transport: { sleep: async () => {} },
      limits: { attemptMs: 150, attempts: 1 },
    });
    const started = Date.now();
    expect((await bridge.emit(done())).status).toBe("failed");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("fails a non-zero exit and refuses untrusted executables", async () => {
    const failing = writeHook("#!/bin/sh\nexit 3\n");
    writeConfig({ version: 1, enabled: true, command: { path: failing } });
    expect(
      (
        await createChiefBridge({ env: envFor(), transport: { sleep: async () => {} } }).emit(
          done(),
        )
      ).status,
    ).toBe("failed");

    const exec = vi.fn(async () => ({ ok: true }));
    const writable = writeHook("#!/bin/sh\nexit 0\n", { mode: 0o722 });
    writeConfig({ version: 1, enabled: true, command: { path: writable } });
    expect(
      (
        await createChiefBridge({ env: envFor(), transport: { exec, sleep: async () => {} } }).emit(
          done(),
        )
      ).status,
    ).toBe("failed");
    fs.chmodSync(writable, 0o600);
    expect(
      (
        await createChiefBridge({ env: envFor(), transport: { exec, sleep: async () => {} } }).emit(
          done({ key: "k2" }),
        )
      ).status,
    ).toBe("failed");
    fs.chmodSync(writable, 0o700);
    fs.chmodSync(hookDir(), 0o777);
    expect(
      (
        await createChiefBridge({ env: envFor(), transport: { exec, sleep: async () => {} } }).emit(
          done({ key: "k3" }),
        )
      ).status,
    ).toBe("failed");
    expect(exec).not.toHaveBeenCalled();
  });

  it("uses the mock process transport with an absolute resolved file and scrubbed env", async () => {
    const file = writeHook("#!/bin/sh\nexit 0\n");
    writeConfig({ version: 1, enabled: true, command: { path: file, args: ["x"] } });
    const exec = vi.fn(async () => ({ ok: true }));
    await createChiefBridge({ env: envFor(), transport: { exec } }).emit(done());
    const call = exec.mock.calls[0][0];
    expect(call.file).toBe(fs.realpathSync(file));
    expect(call.args).toEqual(["x"]);
    expect(Object.keys(call.env).toSorted((left, right) => left.localeCompare(right))).toEqual([
      "ORK_CHIEF_EVENT",
      "ORK_CHIEF_EVENT_ID",
      "ORK_CHIEF_ROOM",
      "PATH",
    ]);
    expect(Buffer.byteLength(call.input)).toBeLessThan(1024);
  });
});

describe("deadlines, config hazards and sink independence", () => {
  const hookFile = (script) => {
    const directory = path.join(ctx.tmp, "hooks");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    const file = path.join(directory, "hook.sh");
    fs.writeFileSync(file, script, { mode: 0o700 });
    return file;
  };

  it("bounds a DNS lookup that never answers, then delivers the next healthy event", async () => {
    writeConfig(WEBHOOK);
    let isHealthy = false;
    const transport = okTransport({
      lookup: vi.fn(() => (isHealthy ? Promise.resolve(["93.184.216.34"]) : new Promise(() => {}))),
    });
    const bridge = createChiefBridge({
      env: envFor(),
      transport,
      limits: { attempts: 1, attemptMs: 40 },
    });
    const started = Date.now();
    expect((await bridge.emit(done({ key: "a" }))).status).toBe("failed");
    expect(Date.now() - started).toBeLessThan(1000);
    expect(transport.https).not.toHaveBeenCalled();
    isHealthy = true;
    expect((await bridge.emit(done({ key: "b" }))).status).toBe("sent");
  });

  it("bounds a connection that never produces a response", async () => {
    writeConfig(WEBHOOK);
    let seenSignal;
    const transport = okTransport({
      https: vi.fn(({ signal }) => {
        seenSignal = signal;
        return new Promise(() => {});
      }),
    });
    const bridge = createChiefBridge({
      env: envFor(),
      transport,
      limits: { attempts: 1, attemptMs: 40 },
    });
    expect((await bridge.emit(done())).status).toBe("failed");
    expect(seenSignal.aborted).toBe(true);
  });

  it("keeps the bridge inactive and returns promptly for a FIFO, socket, directory or loose swap", async () => {
    const target = ctx.configFile;
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(target), 0o700);
    const attempts = [
      () => spawnSync("mkfifo", [target]),
      () => {
        fs.mkdirSync(target);
      },
      () =>
        new Promise((resolve) => {
          const server = net.createServer();
          server.listen(target, () => resolve(server));
        }),
    ];
    for (const plant of attempts) {
      fs.rmSync(target, { recursive: true, force: true });
      const server = await plant();
      const started = Date.now();
      expect(loadChiefBridgeConfig(envFor())).toBeNull();
      expect(Date.now() - started).toBeLessThan(1000);
      const transport = okTransport();
      expect(await createChiefBridge({ env: envFor(), transport }).emit(done())).toEqual({
        status: "disabled",
      });
      expect(transport.https).not.toHaveBeenCalled();
      server?.close?.();
    }
  });

  it("acknowledges a successful sink once and retries only the failed sink with the same payload", async () => {
    const file = hookFile("#!/bin/sh\nexit 0\n");
    writeConfig({
      version: 1,
      enabled: true,
      webhook: { url: "https://hooks.example.test/in" },
      command: { path: file },
    });
    const https = vi.fn().mockResolvedValueOnce({ status: 500 }).mockResolvedValue({ status: 200 });
    const exec = vi.fn(async () => ({ ok: true }));
    const bridge = createChiefBridge({
      env: envFor(),
      transport: okTransport({ https, exec }),
    });
    expect((await bridge.emit(done())).status).toBe("sent");
    expect(exec).toHaveBeenCalledTimes(1);
    expect(https).toHaveBeenCalledTimes(2);
    expect(https.mock.calls[0][0].body).toBe(https.mock.calls[1][0].body);
    expect(JSON.parse(exec.mock.calls[0][0].input).id).toBe(
      JSON.parse(https.mock.calls[1][0].body).id,
    );
  });

  it("resumes a partially delivered event on a later emit without repeating the acknowledged sink", async () => {
    const file = hookFile("#!/bin/sh\nexit 0\n");
    writeConfig({
      version: 1,
      enabled: true,
      webhook: { url: "https://hooks.example.test/in" },
      command: { path: file },
    });
    const https = vi
      .fn()
      .mockResolvedValueOnce({ status: 500 })
      .mockResolvedValueOnce({ status: 500 })
      .mockResolvedValue({ status: 200 });
    const exec = vi.fn(async () => ({ ok: true }));
    const bridge = createChiefBridge({ env: envFor(), transport: okTransport({ https, exec }) });
    const first = await bridge.emit(done());
    expect(first).toMatchObject({ status: "failed", delivered: ["command"] });
    expect((await bridge.emit(done())).status).toBe("sent");
    expect(exec).toHaveBeenCalledTimes(1);
    expect(https).toHaveBeenCalledTimes(3);
  });

  it("ends an unterminated hook and the descendants it started when the deadline passes", async () => {
    const pidFile = path.join(ctx.tmp, "descendant.pid");
    const file = hookFile(`#!/bin/sh\nsleep 60 &\necho $! > '${pidFile}'\nsleep 60\n`);
    writeConfig({ version: 1, enabled: true, command: { path: file } });
    const bridge = createChiefBridge({
      env: envFor(),
      transport: { sleep: async () => {} },
      limits: { attemptMs: 400, attempts: 1 },
    });
    expect((await bridge.emit(done())).status).toBe("failed");
    const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
    expect(pid).toBeGreaterThan(1);
    let isAlive = true;
    for (let wait = 0; wait < 40 && isAlive; wait++) {
      try {
        process.kill(pid, 0);
        await new Promise((resolve) => setTimeout(resolve, 50));
      } catch {
        isAlive = false;
      }
    }
    expect(isAlive).toBe(false);
  });

  it("keeps the queue bound and breaker across retries", async () => {
    writeConfig(WEBHOOK);
    let now = 5_000_000;
    const https = vi.fn(async () => ({ status: 503 }));
    const bridge = createChiefBridge({
      env: envFor(),
      clock: () => now,
      transport: okTransport({ https }),
      limits: { attempts: 2, breakerFailures: 2, breakerMs: 1000, pending: 1 },
    });
    await bridge.emit(done({ key: "a" }));
    await bridge.emit(done({ key: "b" }));
    expect(https).toHaveBeenCalledTimes(4);
    expect((await bridge.emit(done({ key: "c" }))).reason).toBe("breaker-open");
    now += 2000;
    expect((await bridge.emit(done({ key: "d" }))).status).toBe("failed");
    expect(https).toHaveBeenCalledTimes(6);
  });
});

describe("non-blocking hand-off", () => {
  it("returns promptly when an injected bridge never settles", async () => {
    const bridge = { emit: vi.fn(() => new Promise(() => {})) };
    const started = Date.now();
    await emitChiefEvents([done()], { bridge, waitMs: 80 });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(bridge.emit).toHaveBeenCalledTimes(1);
  });

  it("starts no worker while disabled", async () => {
    const spawnFn = vi.fn();
    await emitChiefEvents([done()], { env: envFor(), spawnFn });
    writeConfig({ ...WEBHOOK, enabled: false });
    await emitChiefEvents([done()], { env: envFor(), spawnFn });
    await emitChiefEvents([done()], { env: { ...envFor(), ORK_CHIEF_BRIDGE: "0" }, spawnFn });
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it("hands an opted-in batch to one detached worker with a bounded environment", async () => {
    writeConfig(WEBHOOK);
    const written = [];
    const spawnFn = vi.fn(() => ({
      on: () => {},
      unref: () => {},
      stdin: {
        on: () => {},
        unref: () => {},
        end: (input, callback) => {
          written.push(input);
          callback();
        },
      },
    }));
    const env = { ...envFor(), SECRET: "leak", HOME: ctx.tmp, PATH: "/usr/bin" };
    await emitChiefEvents([done({ text: "free text" }), done({ key: "k2" })], { env, spawnFn });
    expect(spawnFn).toHaveBeenCalledTimes(1);
    const [file, args, options] = spawnFn.mock.calls[0];
    expect(file).toBe(process.execPath);
    expect(args[1]).toBe("--deliver");
    expect(options).toMatchObject({ detached: true, shell: false });
    expect(options.env.SECRET).toBeUndefined();
    expect(options.env.ORK_CHIEF_BRIDGE_CONFIG).toBe(ctx.configFile);
    const batch = JSON.parse(written[0]);
    expect(batch).toHaveLength(2);
    expect(JSON.stringify(batch)).not.toContain("free text");
  });

  it("spawnChiefDelivery never rejects when the spawn fails", async () => {
    writeConfig(WEBHOOK);
    const spawnFn = vi.fn(() => {
      throw new Error("EAGAIN");
    });
    await expect(spawnChiefDelivery([done()], { env: envFor(), spawnFn })).resolves.toBe(false);
  });
});
