/**
 * @module chief-bridge
 *
 * Optional, off-by-default bridge that forwards six committed Chief transitions (`done`, `failed`,
 * `escalation`, `question`, `pr_opened`, `pr_merged`) to one user-configured HTTPS webhook and/or one
 * trusted local executable. Every call site is the single authoritative writer of the transition, so a
 * render, refresh or status read never emits. Delivery is best-effort: `emit()` never throws, never
 * rejects, never alters tracked state, and callers invoke it only after releasing their write locks.
 *
 * Configuration lives in `<config home>/chief-bridge.json` (override: ORK_CHIEF_BRIDGE_CONFIG), a
 * user-owned, non-symlink, 0600 regular file in a user-owned 0700 directory:
 *
 *   { "version": 1, "enabled": true,
 *     "events": ["done", "failed"],                       // optional subset
 *     "webhook": { "url": "https://hooks.example.com/x", "bearerToken": "…" },
 *     "command": { "path": "/abs/trusted/hook", "args": ["--flag"] } }
 *
 * Without that file (or with `"enabled": true` missing) nothing is read beyond one lstat, no network is
 * opened and no process is started. ORK_CHIEF_BRIDGE=0 forces the bridge off.
 *
 * Detached workers share one durable queue (see chief-delivery.mjs): replay, per-sink acknowledgements and
 * the breaker survive across CLI processes, and one drain lease bounds workers and sink contacts.
 *
 * Payload (frozen): `{schema:"ork.chief.event.v1", id, event, at, roomId, prNumber?}`. The id is an
 * opaque hash of the event, room and the durable source identity (`key`), so a restarted process derives
 * the same id for the same record. Delivery is at-least-once with bounded replay suppression (durable across processes);
 * receivers should de-duplicate on `id`.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import dns from "node:dns/promises";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { configHome } from "./runtime-paths.mjs";

export const CHIEF_EVENT_SCHEMA = "ork.chief.event.v1";
export const CHIEF_EVENTS = Object.freeze([
  "done",
  "failed",
  "escalation",
  "question",
  "pr_opened",
  "pr_merged",
]);
const PR_EVENTS = new Set(["pr_opened", "pr_merged"]);
const ROOM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;

export const BRIDGE_LIMITS = Object.freeze({
  configBytes: 16 * 1024,
  payloadBytes: 1024,
  keyChars: 1024,
  pending: 32,
  replay: 256,
  attempts: 2,
  attemptMs: 3000,
  backoffMs: 200,
  breakerFailures: 3,
  breakerMs: 60_000,
  responseBytes: 4096,
  commandArgs: 16,
  commandArgChars: 256,
});

/** Opaque, deterministic identity for one source transition. `key` never leaves the process. */
export function chiefEventId({ event, roomId, key }) {
  const digest = createHash("sha256")
    .update(JSON.stringify([CHIEF_EVENT_SCHEMA, event, roomId, String(key)]))
    .digest("hex");
  return `ce_${digest.slice(0, 32)}`;
}

/** Builds the strict-allowlist payload, or null when the event is not one of the six. */
export function buildChiefPayload(input, clock = Date.now) {
  if (!input || typeof input !== "object") return null;
  const { event, roomId, key, prNumber } = input;
  if (
    !CHIEF_EVENTS.includes(event) ||
    typeof roomId !== "string" ||
    !ROOM_ID_RE.test(roomId) ||
    typeof key !== "string" ||
    key.length === 0 ||
    key.length > BRIDGE_LIMITS.keyChars
  )
    return null;
  const payload = {
    schema: CHIEF_EVENT_SCHEMA,
    id: chiefEventId({ event, roomId, key }),
    event,
    at: new Date(Number(clock())).toISOString(),
    roomId,
  };
  if (PR_EVENTS.has(event)) {
    if (!Number.isSafeInteger(prNumber) || prNumber <= 0) return null;
    payload.prNumber = prNumber;
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Address policy

const MASK32 = (1n << 32n) - 1n;
const MASK16 = (1n << 16n) - 1n;

function parseIPv4(text) {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!/^(?:0|[1-9]\d{0,2})$/u.test(part)) return null;
    const number = Number(part);
    if (number > 255) return null;
    value = (value << 8n) | BigInt(number);
  }
  return value;
}

function parseIPv6(input) {
  if (input.includes("%")) return null;
  let text = input;
  const lastColon = text.lastIndexOf(":");
  let tail = [];
  if (text.slice(lastColon + 1).includes(".")) {
    const v4 = parseIPv4(text.slice(lastColon + 1));
    if (v4 === null) return null;
    tail = [Number(v4 >> 16n), Number(v4 & MASK16)];
    text = `${text.slice(0, lastColon + 1)}0:0`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const toGroups = (side) => (side === "" ? [] : side.split(":"));
  const head = toGroups(halves[0]);
  const rest = halves.length === 2 ? toGroups(halves[1]) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [
    ...head,
    ...Array.from({ length: halves.length === 2 ? missing : 0 }, () => "0"),
    ...rest,
  ];
  if (groups.length !== 8) return null;
  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/u.test(group)) return null;
    value = (value << 16n) | BigInt(Number.parseInt(group, 16));
  }
  if (tail.length === 2) value = (value & ~MASK32) | (BigInt(tail[0]) << 16n) | BigInt(tail[1]);
  return value;
}

const V4_DENY = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
].map(([base, bits]) => ({ base: parseIPv4(base), bits }));

function inV4(value, { base, bits }) {
  const shift = BigInt(32 - bits);
  return value >> shift === base >> shift;
}

function publicV4(value) {
  return V4_DENY.every((range) => !inV4(value, range));
}

const v6 = (text, bits) => ({ base: parseIPv6(text), bits });
const V6_DENY = [
  v6("::", 128),
  v6("::1", 128),
  v6("::", 96), // IPv4-compatible
  v6("100::", 64), // discard-only
  v6("2001::", 32), // Teredo
  v6("2001:db8::", 32),
  v6("2001:10::", 28),
  v6("2001:20::", 28),
  v6("fc00::", 7),
  v6("fe80::", 10),
  v6("fec0::", 10),
  v6("ff00::", 8),
];

function inV6(value, { base, bits }) {
  const shift = BigInt(128 - bits);
  return value >> shift === base >> shift;
}

/** True only for a globally routable unicast address; IPv4-mapped/NAT64/6to4 forms follow their IPv4. */
export function isPublicAddress(address) {
  const kind = net.isIP(typeof address === "string" ? address : "");
  if (kind === 4) {
    const value = parseIPv4(address);
    return value !== null && publicV4(value);
  }
  if (kind !== 6) return false;
  const value = parseIPv6(address);
  if (value === null) return false;
  const low32 = value & MASK32;
  if (value >> 32n === MASK16) return publicV4(low32); // ::ffff:a.b.c.d
  if (inV6(value, v6("64:ff9b::", 96))) return publicV4(low32); // NAT64
  if (inV6(value, v6("64:ff9b:1::", 48))) return false;
  if (inV6(value, v6("2002::", 16))) return publicV4((value >> 80n) & MASK32); // 6to4
  if (!inV6(value, v6("2000::", 3))) return false;
  return V6_DENY.every((range) => !inV6(value, range));
}

// ---------------------------------------------------------------------------
// Configuration

function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function isOwned(info) {
  const uid = currentUid();
  return uid === null || info.uid === uid;
}

function readPrivateFile(file, maxBytes) {
  const directory = path.dirname(file);
  const dirInfo = lstatSync(directory);
  if (
    dirInfo.isSymbolicLink() ||
    !dirInfo.isDirectory() ||
    !isOwned(dirInfo) ||
    (dirInfo.mode & 0o077) !== 0
  )
    throw new Error("config directory must be a private user-owned directory");
  // Non-blocking, so a FIFO or device planted at the path can never stall the caller.
  const fd = openSync(
    file,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK | fsConstants.O_NOCTTY,
  );
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || !isOwned(info) || (info.mode & 0o777) !== 0o600)
      throw new Error("config must be a user-owned 0600 regular file");
    // The opened file must still be what the path names: a swap after the open is refused.
    const named = lstatSync(file);
    if (named.isSymbolicLink() || named.ino !== info.ino || named.dev !== info.dev)
      throw new Error("config changed while it was opened");
    if (info.size > maxBytes) throw new Error("config is too large");
    const buffer = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < buffer.length) {
      const read = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

export function chiefBridgeConfigPath(env = process.env) {
  const explicit = env.ORK_CHIEF_BRIDGE_CONFIG;
  if (typeof explicit === "string" && path.isAbsolute(explicit)) return explicit;
  return path.join(configHome(env), "chief-bridge.json");
}

function isCleanString(value, max) {
  return (
    typeof value === "string" && value.length > 0 && value.length <= max && !/[\p{Cc}]/u.test(value)
  );
}

function validateWebhook(raw) {
  if (!raw || typeof raw !== "object") return null;
  let url;
  try {
    url = new URL(raw.url);
  } catch {
    throw new Error("webhook.url is not a URL");
  }
  if (url.protocol !== "https:") throw new Error("webhook.url must be https");
  if (url.username || url.password) throw new Error("webhook.url may not carry credentials");
  if (raw.bearerToken !== undefined && !isCleanString(raw.bearerToken, 512))
    throw new Error("webhook.bearerToken is invalid");
  return { url: url.href, bearerToken: raw.bearerToken };
}

function validateCommand(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.path !== "string" || !path.isAbsolute(raw.path) || raw.path.includes("\0"))
    throw new Error("command.path must be absolute");
  const args = raw.args ?? [];
  if (
    !Array.isArray(args) ||
    args.length > BRIDGE_LIMITS.commandArgs ||
    args.some(
      (arg) =>
        !(
          typeof arg === "string" &&
          arg.length <= BRIDGE_LIMITS.commandArgChars &&
          !arg.includes("\0")
        ),
    )
  )
    throw new Error("command.args is invalid");
  return { path: raw.path, args };
}

/** Reads and validates the opt-in file. Returns null when the bridge is off or the file is unusable. */
export function loadChiefBridgeConfig(env = process.env) {
  if (env.ORK_CHIEF_BRIDGE === "0") return null;
  const file = chiefBridgeConfigPath(env);
  try {
    const parsed = JSON.parse(readPrivateFile(file, BRIDGE_LIMITS.configBytes));
    if (!parsed || typeof parsed !== "object" || parsed.version !== 1 || parsed.enabled !== true)
      return null;
    const events = parsed.events === undefined ? [...CHIEF_EVENTS] : parsed.events;
    if (!Array.isArray(events) || events.some((name) => !CHIEF_EVENTS.includes(name)))
      throw new Error("events must list known event names");
    const webhook = parsed.webhook === undefined ? null : validateWebhook(parsed.webhook);
    const command = parsed.command === undefined ? null : validateCommand(parsed.command);
    if (!webhook && !command) return null;
    return { events: new Set(events), webhook, command };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Transports (replaceable in tests)

function assertTrustedExecutable(file) {
  const real = realpathSync(file);
  const info = lstatSync(real);
  if (!info.isFile()) throw new Error("command is not a regular file");
  const uid = currentUid();
  if (uid !== null && info.uid !== uid && info.uid !== 0)
    throw new Error("command has an untrusted owner");
  if ((info.mode & 0o022) !== 0) throw new Error("command is writable by others");
  if ((info.mode & 0o100) === 0) throw new Error("command is not executable");
  const parent = lstatSync(path.dirname(real));
  if (
    !parent.isDirectory() ||
    (parent.mode & 0o022) !== 0 ||
    (uid !== null && parent.uid !== uid && parent.uid !== 0)
  )
    throw new Error("command directory is not trusted");
  return real;
}

function defaultExec({ file, args, input, env, timeoutMs, signal }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, {
        shell: false,
        env,
        stdio: ["pipe", "ignore", "ignore"],
        windowsHide: true,
        // Its own process group, so a timeout can end the hook and everything it started.
        detached: true,
      });
    } catch {
      resolve({ ok: false });
      return;
    }
    let isSettled = false;
    const done = (ok) => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timer);
      resolve({ ok });
    };
    const stop = () => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      done(false);
    };
    const timer = setTimeout(stop, timeoutMs);
    signal?.addEventListener("abort", stop, { once: true });
    child.on("error", () => done(false));
    child.on("close", (code) => done(code === 0));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

function defaultHttps({ address, family, url, headers, body, timeoutMs, signal }) {
  return new Promise((resolve) => {
    let isSettled = false;
    const done = (value) => {
      if (isSettled) return;
      isSettled = true;
      resolve(value);
    };
    const target = new URL(url);
    const request = https.request(
      {
        method: "POST",
        host: address,
        family,
        port: target.port || 443,
        path: `${target.pathname}${target.search}`,
        servername: net.isIP(target.hostname) ? undefined : target.hostname,
        headers: { ...headers, host: target.host },
        rejectUnauthorized: true,
        timeout: timeoutMs,
        agent: false,
      },
      (response) => {
        let seen = 0;
        response.on("data", (chunk) => {
          seen += chunk.length;
          if (seen > BRIDGE_LIMITS.responseBytes) response.destroy();
        });
        response.on("end", () => done({ status: response.statusCode ?? 0 }));
        response.on("error", () => done({ status: response.statusCode ?? 0 }));
        response.on("close", () => done({ status: response.statusCode ?? 0 }));
      },
    );
    request.on("timeout", () => request.destroy());
    signal?.addEventListener(
      "abort",
      () => {
        request.destroy();
        done({ status: 0 });
      },
      { once: true },
    );
    request.on("error", () => done({ status: 0 }));
    request.end(body);
  });
}

async function defaultLookup(hostname) {
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Bridge

/**
 * @param {object} [options]
 * @param {object} [options.env] environment that locates the opt-in file
 * @param {() => number} [options.clock] milliseconds
 * @param {{https?: Function, exec?: Function, lookup?: Function, sleep?: Function}} [options.transport]
 * @param {object} [options.limits] test-only tightening of BRIDGE_LIMITS
 * @param {boolean} [options.isDurable] keep queue, acknowledgements and breaker in the shared state file
 */
export function createChiefBridge({
  env = process.env,
  clock = Date.now,
  transport = {},
  limits = {},
  isDurable = false,
} = {}) {
  const lim = { ...BRIDGE_LIMITS, ...limits };
  const send = {
    https: transport.https ?? defaultHttps,
    exec: transport.exec ?? defaultExec,
    lookup: transport.lookup ?? defaultLookup,
    sleep: transport.sleep ?? sleep,
  };
  let config;
  let isLoaded = false;
  const seen = new Set();
  const acked = new Map();
  let pending = 0;
  let tail = Promise.resolve();
  let failures = 0;
  let openUntil = 0;

  // One delivery at a time keeps the breaker and replay state coherent without blocking callers' locks.
  const serially = async (task) => {
    const previous = tail;
    const turn = Promise.withResolvers();
    tail = turn.promise;
    await previous;
    try {
      return await task();
    } finally {
      turn.resolve();
    }
  };

  const getConfig = () => {
    if (!isLoaded) {
      isLoaded = true;
      config = loadChiefBridgeConfig(env);
    }
    return config;
  };

  const remember = (id) => {
    seen.add(id);
    if (seen.size > lim.replay) seen.delete(seen.values().next().value);
  };

  async function deliverWebhook(webhook, body, signal) {
    const url = new URL(webhook.url);
    const host = url.hostname.replaceAll(/^\[|\]$/gu, "");
    const addresses = net.isIP(host) ? [host] : await send.lookup(host, { signal });
    if (!Array.isArray(addresses) || addresses.length === 0) return false;
    // Every resolved address must be public, so a mixed answer cannot steer the connection.
    if (addresses.some((address) => !isPublicAddress(address))) return false;
    const address = addresses[0];
    const headers = {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body)),
      "user-agent": "ork-chief-bridge",
      "idempotency-key": JSON.parse(body).id,
    };
    if (webhook.bearerToken) headers.authorization = `Bearer ${webhook.bearerToken}`;
    const response = await send.https({
      url: webhook.url,
      address,
      family: net.isIP(address),
      servername: net.isIP(host) ? undefined : host,
      headers,
      body,
      timeoutMs: lim.attemptMs,
      signal,
    });
    // A redirect is never followed: only a direct 2xx counts.
    return Boolean(response) && response.status >= 200 && response.status < 300;
  }

  async function deliverCommand(command, payload, body, signal) {
    const file = assertTrustedExecutable(command.path);
    const result = await send.exec({
      file,
      args: command.args,
      input: body,
      env: {
        PATH: "/usr/bin:/bin",
        ORK_CHIEF_EVENT: payload.event,
        ORK_CHIEF_EVENT_ID: payload.id,
        ORK_CHIEF_ROOM: payload.roomId,
      },
      timeoutMs: lim.attemptMs,
      signal,
    });
    return Boolean(result?.ok);
  }

  /** One wall-clock deadline across name resolution, address checks, TLS and the exchange. */
  async function withDeadline(run) {
    const controller = new AbortController();
    const expired = Promise.withResolvers();
    const timer = setTimeout(() => {
      controller.abort();
      expired.resolve(false);
    }, lim.attemptMs);
    const work = (async () => {
      try {
        return await run(controller.signal);
      } catch {
        return false;
      }
    })();
    try {
      return await Promise.race([work, expired.promise]);
    } finally {
      clearTimeout(timer);
    }
  }

  const sinksOf = (cfg, payload, body) => [
    ...(cfg.webhook ? [["webhook", (signal) => deliverWebhook(cfg.webhook, body, signal)]] : []),
    ...(cfg.command
      ? [["command", (signal) => deliverCommand(cfg.command, payload, body, signal)]]
      : []),
  ];

  /** Contacts only the sinks not yet in `done`, retrying with backoff. False when `renew` refuses. */
  async function attemptSinks(sinks, done, { onAck, renew } = {}) {
    for (let tries = 0; tries < lim.attempts; tries++) {
      const waiting = sinks.filter(([name]) => !done.has(name));
      if (waiting.length === 0) break;
      if (tries > 0) await send.sleep(lim.backoffMs * 2 ** (tries - 1));
      if (renew && !renew()) return false;
      const outcomes = await Promise.all(
        waiting.map(async ([name, run]) => [name, await withDeadline(run)]),
      );
      for (const [name, isAcknowledged] of outcomes) {
        if (!isAcknowledged) continue;
        done.add(name);
        onAck?.(name);
      }
    }
    return true;
  }

  async function deliver(cfg, payload) {
    if (clock() < openUntil) return { status: "dropped", reason: "breaker-open" };
    const body = JSON.stringify(payload);
    // A sink that already acknowledged this exact event is never contacted again; only failed sinks retry.
    const done = acked.get(payload.id) ?? new Set();
    acked.set(payload.id, done);
    if (acked.size > lim.replay) acked.delete(acked.keys().next().value);
    const sinks = sinksOf(cfg, payload, body);
    await attemptSinks(sinks, done);
    if (sinks.every(([name]) => done.has(name))) {
      failures = 0;
      acked.delete(payload.id);
      return { status: "sent", id: payload.id };
    }
    failures += 1;
    if (failures >= lim.breakerFailures) {
      openUntil = Number(clock()) + lim.breakerMs;
      failures = 0;
    }
    return { status: "failed", id: payload.id, delivered: [...done] };
  }

  // Durable mode: queue, replay, acknowledgements and breaker live in the shared state file.
  let durable = null;
  const getDurable = async () => {
    durable ??= (async () => {
      const { openDeliveryStore, deliveryStatePath } = await import("./chief-delivery.mjs");
      return openDeliveryStore(deliveryStatePath(chiefBridgeConfigPath(env)), {
        clock,
        limits: lim,
      });
    })();
    return durable;
  };

  const deliverRow =
    (cfg) =>
    async (payload, { acked: done, ack, renew }) => {
      const sinks = sinksOf(cfg, payload, JSON.stringify(payload));
      const isLive = await attemptSinks(sinks, done, { onAck: ack, renew });
      return isLive ? sinks.every(([name]) => done.has(name)) : null;
    };

  async function drain(token) {
    const cfg = getConfig();
    if (!cfg) return { lost: false };
    const { drainQueue } = await import("./chief-delivery.mjs");
    const store = await getDurable();
    return drainQueue(store, {
      token,
      profile: store.fingerprint(cfg),
      clock,
      deliverRow: deliverRow(cfg),
    });
  }

  async function emitDurable(cfg, payload) {
    const { drainQueue } = await import("./chief-delivery.mjs");
    const store = await getDurable();
    const profile = store.fingerprint(cfg);
    const queued = store.enqueue(payload, profile);
    if (queued.status === "dropped") return queued;
    const id = queued.payload.id;
    if (queued.status === "duplicate") return { status: "duplicate", id };
    const token = store.newToken();
    // Another holder is draining: the event is durable and its loop (or the next emit) delivers it.
    if (!store.acquireLease(token)) return { status: "queued", id };
    const { tried } = await drainQueue(store, {
      token,
      profile,
      clock,
      deliverRow: deliverRow(cfg),
    });
    const state = store.status(id);
    if (!state) return { status: "failed", id };
    if (state.state === "sent") return { status: "sent", id };
    if (tried?.has(id)) return { status: "failed", id, delivered: state.delivered };
    return { status: "queued", id, ...(store.isBreakerOpen() && { reason: "breaker-open" }) };
  }

  return {
    drain,
    async close() {
      try {
        (await durable)?.close();
      } catch {
        // Never opened, or already closed.
      }
      durable = null;
    },
    /** Best-effort and bounded. Resolves with a status; never rejects and never throws. */
    async emit(input) {
      try {
        const cfg = getConfig();
        if (!cfg) return { status: "disabled" };
        if (!input || !cfg.events.has(input.event)) return { status: "ignored" };
        const payload = buildChiefPayload(input, clock);
        if (!payload) return { status: "invalid" };
        const body = JSON.stringify(payload);
        if (Buffer.byteLength(body) > lim.payloadBytes) return { status: "invalid" };
        if (isDurable) return await emitDurable(cfg, payload);
        if (seen.has(payload.id)) return { status: "duplicate", id: payload.id };
        if (pending >= lim.pending) return { status: "dropped", reason: "queue-full" };
        remember(payload.id);
        pending += 1;
        try {
          const result = await serially(() => deliver(cfg, payload));
          // A failed or breaker-dropped delivery may be retried by a later emit of the same record.
          if (result.status !== "sent") seen.delete(payload.id);
          return result;
        } finally {
          pending -= 1;
        }
      } catch {
        return { status: "failed" };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Process-wide default, shared by Chief and by the Foundry PR writer

const defaults = new Map();

/** The lazy default bridge for an environment's config location (one per process). */
export function getChiefBridge(env = process.env) {
  const key = `${chiefBridgeConfigPath(env)}\0${env.ORK_CHIEF_BRIDGE ?? ""}`;
  if (!defaults.has(key)) defaults.set(key, createChiefBridge({ env }));
  return defaults.get(key);
}

// Bind a source intent to the opted-in sink configuration. No credential enters the intent table.
export function chiefNotificationProfile(cfg, env) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        chiefBridgeConfigPath(env),
        cfg.webhook,
        cfg.command,
        [...cfg.events].toSorted((a, b) => a.localeCompare(b)),
      ]),
    )
    .digest("hex");
}

const HANDOFF_MS = 500;
const WORKER_ENV_KEYS = [
  "HOME",
  "PATH",
  "XDG_CONFIG_HOME",
  "ORCHESTRATE_CONFIG",
  "AGENT_EXECUTOR_CONFIG",
  "ORK_CHIEF_BRIDGE_CONFIG",
  "ORK_CHIEF_BRIDGE",
];
const WORKER_INPUT_BYTES = 64 * 1024;
const WORKER_LIFESPAN_MS = 60_000;

function cleanEvent(event) {
  if (!event || typeof event !== "object") return null;
  return {
    event: event.event,
    roomId: event.roomId,
    key: event.key,
    ...(event.prNumber !== undefined && { prNumber: event.prNumber }),
  };
}

const LEASE_ENV = "ORK_CHIEF_DELIVERY_LEASE";
const LEASE_TOKEN_RE = /^[0-9a-f]{24}$/u;

/**
 * Records committed events in the shared durable queue, then hands delivery to the single detached
 * worker (`--deliver`) so a slow sink can never hold the caller or a CLI exit. Nothing is opened or
 * started unless the opt-in file is valid. The worker is started only by the process that wins the one
 * drain lease; any other emitter just queues and returns, so concurrent CLIs never multiply workers.
 * Resolves once the events are durable and any worker has its hand-off (bounded) and never rejects.
 */
export async function spawnChiefDelivery(
  events,
  { env = process.env, spawnFn = spawn, expectedProfile, onAdmitted, resumePending = false } = {},
) {
  let store = null;
  let token = null;
  try {
    const cfg = loadChiefBridgeConfig(env);
    if (!cfg || (expectedProfile && chiefNotificationProfile(cfg, env) !== expectedProfile))
      return false;
    const batch = events.map((event) => cleanEvent(event)).filter(Boolean);
    const input = JSON.stringify(batch.slice(0, BRIDGE_LIMITS.pending));
    if ((!resumePending && batch.length === 0) || Buffer.byteLength(input) > WORKER_INPUT_BYTES)
      return false;
    const { openDeliveryStore, deliveryStatePath, DELIVERY_LIMITS } =
      await import("./chief-delivery.mjs");
    // The caller never waits on the optional state file beyond this one small budget.
    store = openDeliveryStore(deliveryStatePath(chiefBridgeConfigPath(env)), {
      admissionMs: DELIVERY_LIMITS.admissionMs,
    });
    const profile = store.fingerprint(cfg);
    let isQueued = resumePending && store.due(profile).length > 0;
    const admitted = [];
    for (const event of batch.slice(0, BRIDGE_LIMITS.pending)) {
      const payload = cfg.events.has(event.event) ? buildChiefPayload(event) : null;
      if (!payload) continue;
      const { status } = store.enqueue(payload, profile);
      if (status === "queued") isQueued = true;
      if (status === "queued" || status === "duplicate") admitted.push(payload.id);
    }
    if (!isQueued) {
      onAdmitted?.(admitted);
      return false;
    }
    token = store.newToken();
    // A live holder drains what was just queued, and cannot release without seeing it.
    if (!store.acquireLease(token, store.limits.spawnGraceMs)) {
      onAdmitted?.(admitted);
      return true;
    }
    const workerEnv = { [LEASE_ENV]: token };
    for (const key of WORKER_ENV_KEYS) if (typeof env[key] === "string") workerEnv[key] = env[key];
    const child = spawnFn(process.execPath, [fileURLToPath(import.meta.url), "--deliver"], {
      detached: true,
      shell: false,
      env: workerEnv,
      stdio: ["pipe", "ignore", "ignore"],
    });
    const written = Promise.withResolvers();
    const timer = setTimeout(() => written.resolve(false), HANDOFF_MS);
    child.on("error", () => written.resolve(false));
    child.stdin.on("error", () => written.resolve(false));
    child.stdin.end(input, () => written.resolve(true));
    const isWritten = await written.promise;
    clearTimeout(timer);
    child.unref();
    child.stdin.unref?.();
    if (isWritten) onAdmitted?.(admitted);
    else store.abandonLease(token);
    return isWritten;
  } catch {
    // A worker that never started must not hold the lease for its whole grace period.
    try {
      if (token) store?.abandonLease(token);
    } catch {
      // Expires on its own.
    }
    return false;
  } finally {
    try {
      store?.close();
    } catch {
      // Nothing left to release.
    }
  }
}

/**
 * Emits each already-committed event. Call after releasing write locks; failures are swallowed so the
 * committed outcome never changes. With an injected `bridge` the call waits at most `waitMs`; the default
 * path delivers from a detached worker, so the caller returns as soon as the hand-off is written.
 */
export async function emitChiefEvents(
  events,
  { env = process.env, bridge, waitMs = HANDOFF_MS, spawnFn } = {},
) {
  if (!Array.isArray(events) || events.length === 0) return;
  if (!bridge) {
    await spawnChiefDelivery(events, { env, spawnFn });
    return;
  }
  const expired = Promise.withResolvers();
  const timer = setTimeout(() => expired.resolve(), waitMs);
  const work = (async () => {
    for (const event of events) {
      try {
        await bridge.emit(event);
      } catch {
        // Optional bridge: never surfaces.
      }
    }
  })();
  try {
    await Promise.race([work, expired.promise]);
  } finally {
    clearTimeout(timer);
  }
}

/** The batch on stdin is only a wake-up: the parent already queued it durably. Drain, bounded. */
async function discardWorkerInput() {
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > WORKER_INPUT_BYTES) break;
  }
}

/** Entry for the detached worker: drains the shared queue under the lease its parent took, then exits. */
async function runDeliveryWorker() {
  const watchdog = setTimeout(() => process.exit(1), WORKER_LIFESPAN_MS);
  const token = process.env[LEASE_ENV];
  if (typeof token === "string" && LEASE_TOKEN_RE.test(token)) {
    const bridge = createChiefBridge({ env: process.env, isDurable: true });
    try {
      await discardWorkerInput();
      await bridge.drain(token);
    } catch {
      // Best effort: the lease expires and the next emit retries.
    } finally {
      await bridge.close();
    }
  }
  clearTimeout(watchdog);
  process.exit(0);
}

try {
  if (import.meta.main && process.argv[2] === "--deliver") await runDeliveryWorker();
} catch {
  process.exit(1);
}
