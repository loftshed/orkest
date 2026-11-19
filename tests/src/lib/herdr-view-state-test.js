import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";

import { runHordeTui } from "../../../src/bin/horde-tui.mjs";
import {
  createHerdrLifecycleSubscriber,
  herdrEndpoint,
  herdrPaneIdsFromRoom,
  normalizePaneIds,
} from "../../../src/lib/herdr-context.mjs";
import {
  herdrSwarmPaneLabel,
  markHerdrViewClosed,
  syncHerdrViewLabel,
} from "../../../src/lib/herdr-view-state.mjs";

const directories = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const created = await mkdtemp(path.join(tmpdir(), "ork-view-state-"));
  const root = await realpath(created);
  directories.push(root);
  const socket = path.join(root, "herdr.sock");
  const hash = (text) => createHash("sha256").update(text).digest("hex");
  const directory = path.join(root, "herdr-views-v1", hash(socket).slice(0, 24));
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `${hash("room-a")}.json`);
  await writeFile(
    file,
    JSON.stringify({
      schema: "orkest.herdr-view.v1",
      room: "room-a",
      pane: "w1:p2",
      endpoint: socket,
      host: hostname(),
    }),
  );
  return {
    file,
    closed: file.replace(/\.json$/u, ".closed"),
    env: {
      HERDR_ENV: "1",
      HERDR_PANE_ID: "w1:p2",
      HERDR_SOCKET_PATH: socket,
      ORCHESTRATE_HOME: root,
      ORKEST_HERDR_VIEW_STATE: file,
    },
  };
}

it("records closure only for the matching server and room", async () => {
  const { env, closed } = await fixture();
  await markHerdrViewClosed("another-room", env);
  await expect(readFile(closed, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  await markHerdrViewClosed("room-a", env);
  expect(await readFile(closed, "utf8")).toBe("closed\n");
});

it("uses the same server identity through a socket symlink", async () => {
  const { env, closed } = await fixture();
  await writeFile(env.HERDR_SOCKET_PATH, "");
  const alias = `${env.HERDR_SOCKET_PATH}.alias`;
  await symlink(env.HERDR_SOCKET_PATH, alias);
  await markHerdrViewClosed("room-a", { ...env, HERDR_SOCKET_PATH: alias });
  expect(await readFile(closed, "utf8")).toBe("closed\n");
});

it.each(["q", "q then close", "close"])(
  "distinguishes deliberate q from terminal teardown: %s",
  async (event) => {
    const { env, closed } = await fixture();
    const input = Object.assign(new PassThrough(), {
      isTTY: true,
      isRaw: false,
      setRawMode() {},
      pause() {},
      resume() {
        setImmediate(() => {
          // The embedded view pane closes on a second q, so a stray keystroke cannot retire it.
          if (event !== "close") input.emit("data", "qq");
          if (event !== "q") input.emit("close");
        });
      },
    });
    const output = Object.assign(new PassThrough(), {
      isTTY: true,
      rows: 24,
      columns: 80,
      write() {},
    });
    await runHordeTui(async () => ({ id: "room-a", conductor: {}, agents: [] }), {
      env,
      input,
      output,
      quota: false,
      services: false,
      update: false,
    });
    if (event === "close") {
      await expect(readFile(closed, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      expect(await readFile(closed, "utf8")).toBe("closed\n");
    }
  },
);

it("formats Herdr swarm pane labels and syncs live title changes to Herdr", async () => {
  const { env, file } = await fixture();
  const initialRecord = JSON.parse(await readFile(file, "utf8"));
  await writeFile(
    file,
    JSON.stringify({
      ...initialRecord,
      pane: "w1:p2",
      terminal_id: "room-terminal",
      label: "Orkest Swarm",
    }),
  );
  const calls = [];
  const exec = (binary, args, _options, callback) => {
    calls.push([binary, ...args]);
    callback(
      null,
      JSON.stringify({ result: { pane: { pane_id: "w2:p5", terminal_id: "room-terminal" } } }),
    );
  };
  const room = {
    id: "room-a",
    title: "Refine Orkest coordinator delegation",
    conductor: {},
    agents: [],
  };
  expect(herdrSwarmPaneLabel(room)).toBe("Swarm · Refine Orkest coordinator delegation");
  expect(await syncHerdrViewLabel(room, { env, exec })).toBe(true);
  expect(calls).toEqual([
    ["herdr", "pane", "current", "--current"],
    ["herdr", "pane", "rename", "w2:p5", "Swarm · Refine Orkest coordinator delegation"],
  ]);
  expect(JSON.parse(await readFile(file, "utf8")).label).toBe(
    "Swarm · Refine Orkest coordinator delegation",
  );
  expect(await syncHerdrViewLabel(room, { env, exec })).toBe(false);
  expect(calls).toHaveLength(2);
  const changedRoom = { ...room, title: "New task" };
  const failedRename = (_binary, _args, _options, callback) => callback(new Error("pane closed"));
  expect(await syncHerdrViewLabel(changedRoom, { env, exec: failedRename })).toBe(false);
  expect(JSON.parse(await readFile(file, "utf8")).label).toBe(
    "Swarm · Refine Orkest coordinator delegation",
  );
  expect(
    herdrSwarmPaneLabel({
      id: "room-b",
      title:
        "Toggle compact usage meters (5h/weekly), add rich color differentiation to Orchestrator header",
    }),
  ).toBe("Swarm · Toggle compact usage meters (5h/weekly), add rich color differentiation");
});

it("keeps a managed view open when a separate viewer of the same room quits", async () => {
  const { env, file, closed } = await fixture();
  const record = JSON.parse(await readFile(file, "utf8"));
  await writeFile(file, JSON.stringify({ ...record, terminal_id: "room-terminal" }));
  const exec = (_binary, _args, _options, callback) =>
    callback(
      null,
      JSON.stringify({ result: { pane: { pane_id: "w2:p8", terminal_id: "other" } } }),
    );
  await markHerdrViewClosed("room-a", { ...env, HERDR_PANE_ID: "w2:p8" }, exec);
  await expect(readFile(closed, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

function fakeSocketFactory() {
  const sockets = [];
  const connect = () => {
    const handlers = new Map();
    const socket = {
      written: [],
      destroyed: false,
      on(event, fn) {
        handlers.set(event, [...(handlers.get(event) || []), fn]);
      },
      emit(event, ...args) {
        const listeners = handlers.get(event) || [];
        for (const fn of listeners) fn(...args);
      },
      write(chunk) {
        socket.written.push(JSON.parse(String(chunk)));
      },
      destroy() {
        socket.destroyed = true;
      },
      /** Complete the connect + subscribe handshake as the Herdr server would. */
      acknowledge() {
        socket.emit("connect");
        const request = socket.written.at(-1);
        socket.emit(
          "data",
          `${JSON.stringify({ id: request.id, result: { type: "subscription_started" } })}\n`,
        );
      },
      watched() {
        return socket.written
          .at(-1)
          .params.subscriptions.filter((item) => item.type === "pane.agent_status_changed")
          .map((item) => item.pane_id);
      },
    };
    sockets.push(socket);
    return socket;
  };
  return { sockets, connect };
}

function lifecycle(options = {}) {
  const factory = fakeSocketFactory();
  const events = [];
  const subscriber = createHerdrLifecycleSubscriber({
    env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/fake-herdr.sock" },
    connect: factory.connect,
    onInvalidate: (event) => void events.push(["invalidate", event.reason]),
    onReconcile: (event) => void events.push(["reconcile", event.reason]),
    reconnectDelayMs: 5,
    maxReconnectDelayMs: 20,
    ...options,
  });
  return { ...factory, events, subscriber };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

it("normalizes pane IDs to a sorted set of valid host identifiers", () => {
  expect(normalizePaneIds(["w1:p2", " w1:p1 ", "w1:p2", "", "--x", "a b", 7, null])).toEqual([
    "w1:p1",
    "w1:p2",
  ]);
  expect(normalizePaneIds(new Set(["b", "a"]))).toEqual(["a", "b"]);
  expect(normalizePaneIds("w1:p1")).toEqual([]);
});

it("collects only this endpoint's member pane IDs from a snapshot", () => {
  const env = { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/fake-herdr.sock" };
  const endpoint = herdrEndpoint(env);
  const room = {
    conductor: { herdrPaneId: "w1:p0", herdrEndpoint: endpoint },
    agents: [
      { herdrPaneId: "w1:p2", herdrEndpoint: endpoint },
      { progress: { herdrPaneId: "w1:p1", herdrEndpoint: endpoint } },
      { herdrPaneId: "w9:p1", herdrEndpoint: "/tmp/another.sock" },
      { herdrPaneId: "--bad", herdrEndpoint: endpoint },
      { id: "no-pane" },
    ],
  };
  expect(herdrPaneIdsFromRoom(room, env)).toEqual(["w1:p0", "w1:p1", "w1:p2"]);
  expect(herdrPaneIdsFromRoom(room, {})).toEqual([]);
  expect(herdrPaneIdsFromRoom(null, env)).toEqual([]);
});

it("setPaneIds does no I/O for unchanged sets and only records state before start", () => {
  const { sockets, subscriber } = lifecycle({ paneIds: ["w1:p1"] });
  expect(subscriber.setPaneIds(["w1:p1", "w1:p1"])).toBe(false);
  expect(subscriber.setPaneIds(["w1:p2"])).toBe(true);
  expect(sockets).toHaveLength(0);
  expect(subscriber.paneIds).toEqual(["w1:p2"]);
  subscriber.start();
  sockets[0].acknowledge();
  expect(sockets[0].watched()).toEqual(["w1:p2"]);
  expect(subscriber.setPaneIds(["w1:p2", "bad id", ""])).toBe(false);
  expect(subscriber.setPaneIds(new Set(["w1:p2"]))).toBe(false);
  expect(sockets).toHaveLength(1);
  expect(sockets[0].written).toHaveLength(1);
  subscriber.stop();
});

it("replaces the watched set on a concurrent stream and retires the old one after promotion", () => {
  const { sockets, events, subscriber } = lifecycle({ paneIds: ["w1:p1"] });
  subscriber.start();
  sockets[0].acknowledge();
  expect(subscriber.generation).toBe(1);

  expect(subscriber.setPaneIds(["w1:p2"])).toBe(true);
  expect(sockets).toHaveLength(2);
  // The established stream stays live and keeps delivering hints until the replacement is promoted.
  expect(sockets[0].destroyed).toBe(false);
  expect(subscriber.isSubscribed).toBe(true);
  sockets[0].emit("data", `${JSON.stringify({ event: "pane_updated" })}\n`);
  expect(events.at(-1)).toEqual(["invalidate", "pane_updated"]);
  // No repeated events.subscribe on the live stream (Herdr resets the connection if one is sent).
  expect(sockets[0].written).toHaveLength(1);

  sockets[1].acknowledge();
  expect(sockets[0].destroyed).toBe(true);
  expect(sockets[1].watched()).toEqual(["w1:p2"]);
  expect(subscriber.generation).toBe(2);
  expect(events.slice(-2)).toEqual([
    ["invalidate", "subscription_started"],
    ["reconcile", "subscription_started"],
  ]);
  // Superseded callbacks from the retired stream are discarded.
  const before = events.length;
  sockets[0].emit("data", `${JSON.stringify({ event: "pane_closed" })}\n`);
  sockets[0].emit("close");
  expect(events).toHaveLength(before);
  expect(subscriber.isSubscribed).toBe(true);
  subscriber.stop();
});

it("never promotes a superseded set when A→B→C happens before acknowledgment", () => {
  const { sockets, events, subscriber } = lifecycle({ paneIds: ["a:p1"] });
  subscriber.start();
  sockets[0].acknowledge();
  subscriber.setPaneIds(["b:p1"]);
  subscriber.setPaneIds(["c:p1"]);
  expect(sockets).toHaveLength(3);
  expect(sockets[1].destroyed).toBe(true);
  expect(sockets[2].destroyed).toBe(false);

  // A late acknowledgment for B must not win.
  sockets[1].emit("connect");
  sockets[1].emit(
    "data",
    `${JSON.stringify({ id: "x", result: { type: "subscription_started" } })}\n`,
  );
  expect(subscriber.generation).toBe(1);
  expect(sockets[0].destroyed).toBe(false);

  sockets[2].acknowledge();
  expect(sockets[2].watched()).toEqual(["c:p1"]);
  expect(sockets[0].destroyed).toBe(true);
  expect(subscriber.generation).toBe(2);
  expect(events.filter(([kind]) => kind === "reconcile")).toHaveLength(2);
  subscriber.stop();
});

it("supersedes the first stream when the set changes before it is acknowledged", () => {
  const { sockets, subscriber } = lifecycle({ paneIds: ["w1:p1"] });
  subscriber.start();
  subscriber.setPaneIds(["w1:p2"]);
  expect(sockets).toHaveLength(2);
  expect(sockets[0].destroyed).toBe(true);
  sockets[1].acknowledge();
  expect(sockets[1].watched()).toEqual(["w1:p2"]);
  subscriber.stop();
});

it("keeps the old live stream when the replacement handshake fails, then retries", async () => {
  const { sockets, subscriber } = lifecycle({ paneIds: ["w1:p1"] });
  subscriber.start();
  sockets[0].acknowledge();
  subscriber.setPaneIds(["w1:p2"]);
  sockets[1].emit("connect");
  sockets[1].emit("data", `${JSON.stringify({ error: { code: "bad_request" } })}\n`);
  expect(sockets[1].destroyed).toBe(true);
  expect(sockets[0].destroyed).toBe(false);
  expect(subscriber.isSubscribed).toBe(true);
  expect(subscriber.generation).toBe(1);

  await sleep(30);
  expect(sockets).toHaveLength(3);
  sockets[2].acknowledge();
  expect(sockets[2].watched()).toEqual(["w1:p2"]);
  expect(sockets[0].destroyed).toBe(true);
  subscriber.stop();
});

it("recovers from a silent subscription, including after losing the previous socket", () => {
  vi.useFakeTimers();
  const { sockets, subscriber } = lifecycle({ handshakeTimeoutMs: 50 });
  try {
    subscriber.start();
    vi.advanceTimersByTime(55);
    expect(sockets[0].destroyed).toBe(true);
    sockets[1].acknowledge();
    subscriber.setPaneIds(["w1:p2"]);
    sockets[2].emit("connect");
    sockets[1].emit("end");
    vi.advanceTimersByTime(55);
    expect(sockets[2].destroyed).toBe(true);
    sockets[3].acknowledge();
    vi.advanceTimersByTime(500);
    expect(subscriber.isSubscribed).toBe(true);
    expect(sockets).toHaveLength(4);
  } finally {
    subscriber.stop();
    vi.useRealTimers();
  }
});

it("reconnects with the latest desired set after the live stream is lost", async () => {
  const { sockets, subscriber } = lifecycle({ paneIds: ["w1:p1"] });
  subscriber.start();
  sockets[0].acknowledge();
  sockets[0].emit("data", `${JSON.stringify({ error: { code: "events_lost" } })}\n`);
  expect(subscriber.isSubscribed).toBe(false);
  // Changed while disconnected: only desired state moves, no new socket yet.
  subscriber.setPaneIds(["w1:p9"]);
  expect(sockets).toHaveLength(1);
  await sleep(20);
  expect(sockets).toHaveLength(2);
  sockets[1].acknowledge();
  expect(sockets[1].watched()).toEqual(["w1:p9"]);
  subscriber.stop();
});

it("promotes the replacement even when the old stream dies first", () => {
  const { sockets, subscriber } = lifecycle({ paneIds: ["w1:p1"] });
  subscriber.start();
  sockets[0].acknowledge();
  subscriber.setPaneIds(["w1:p2"]);
  sockets[0].emit("close");
  expect(subscriber.isSubscribed).toBe(false);
  expect(sockets).toHaveLength(2);
  sockets[1].acknowledge();
  expect(subscriber.isSubscribed).toBe(true);
  expect(sockets[1].watched()).toEqual(["w1:p2"]);
  subscriber.stop();
});

it("stops all work on stop: sockets destroyed, timers cleared, later changes ignored", async () => {
  const { sockets, subscriber } = lifecycle({ paneIds: ["w1:p1"] });
  subscriber.start();
  sockets[0].acknowledge();
  subscriber.setPaneIds(["w1:p2"]);
  subscriber.stop();
  expect(sockets.map((socket) => socket.destroyed)).toEqual([true, true]);
  expect(subscriber.isSubscribed).toBe(false);
  expect(subscriber.setPaneIds(["w1:p3"])).toBe(false);
  sockets[1].emit("connect");
  expect(sockets[1].written).toHaveLength(0);
  await sleep(30);
  expect(sockets).toHaveLength(2);

  const failing = lifecycle();
  failing.subscriber.start();
  failing.sockets[0].emit("close");
  failing.subscriber.stop();
  await sleep(30);
  expect(failing.sockets).toHaveLength(1);
});

it("wires every authoritative snapshot of the Swarm View to the lifecycle subscription", async () => {
  const { env } = await fixture();
  const herdrEnv = { HERDR_ENV: "1", HERDR_SOCKET_PATH: env.HERDR_SOCKET_PATH };
  const endpoint = herdrEndpoint(herdrEnv);
  const member = (id, pane) => ({
    id,
    status: "working",
    herdrPaneId: pane,
    herdrEndpoint: endpoint,
  });
  let agents = [member("a1", "w1:p1"), member("a2", "w1:p2")];
  const { sockets, connect } = fakeSocketFactory();
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  const output = Object.assign(new PassThrough(), { isTTY: true, rows: 24, columns: 100 });
  output.resume();
  const running = runHordeTui(
    async () => ({ id: "room-a", conductor: {}, agents: structuredClone(agents), messages: [] }),
    {
      env: herdrEnv,
      input,
      output,
      exec: (_binary, _args, _options, callback) => callback(null, "{}"),
      herdrConnect: connect,
      quota: false,
      services: false,
      update: false,
      chiefHint: false,
      mouse: false,
    },
  );
  const waitFor = async (check) => {
    for (let index = 0; index < 400 && !check(); index += 1) await sleep(10);
    expect(check()).toBe(true);
  };
  try {
    await waitFor(() => sockets.length === 1);
    sockets[0].acknowledge();
    expect(sockets[0].watched()).toEqual(["w1:p1", "w1:p2"]);

    // A member leaves: the next snapshot narrows the watched set on a replacement stream.
    agents = [member("a1", "w1:p1")];
    await waitFor(() => sockets.length === 2);
    sockets[1].acknowledge();
    expect(sockets[1].watched()).toEqual(["w1:p1"]);
    expect(sockets[0].destroyed).toBe(true);

    // Everyone left: the set is cleared.
    agents = [];
    await waitFor(() => sockets.length === 3);
    sockets[2].acknowledge();
    expect(sockets[2].watched()).toEqual([]);
  } finally {
    input.emit("data", "qq");
    await running;
  }
  expect(sockets.every((socket) => socket.destroyed)).toBe(true);
});
