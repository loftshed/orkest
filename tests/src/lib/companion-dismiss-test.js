import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  COMPANION_DISMISS_GRACE_MS,
  createCompanionDismissMonitor,
  hasActiveRoomWork,
} from "../../../src/lib/companion-dismiss.mjs";
import {
  closeHerdrCompanionPane,
  isHerdrCompanionView,
} from "../../../src/lib/herdr-view-state.mjs";
import {
  closeOrcaCompanionPane,
  ORCA_VIEW_SCHEMA,
  readJsonState,
} from "../../../src/lib/orca-context.mjs";

const directories = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function herdrFixture({ chief = false, terminalId = "term-view" } = {}) {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "ork-companion-herdr-"));
  const root = await realpath(tempRoot);
  directories.push(root);
  const socket = path.join(root, "herdr.sock");
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  const directory = path.join(root, "herdr-views-v1", hash(socket).slice(0, 24));
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `${hash("room-a")}.json`);
  const pending = file.replace(/\.json$/u, ".pending");
  const closed = file.replace(/\.json$/u, ".closed");
  await writeFile(
    file,
    JSON.stringify({
      schema: "orkest.herdr-view.v1",
      room: "room-a",
      pane: "w1:p2",
      ...(terminalId && { terminal_id: terminalId }),
      ...(chief && { chief: true }),
      endpoint: socket,
      host: hostname(),
    }),
  );
  await writeFile(pending, "pending\n");
  return {
    root,
    file,
    pending,
    closed,
    env: {
      HERDR_ENV: "1",
      HERDR_PANE_ID: "w1:p2",
      HERDR_SOCKET_PATH: socket,
      ORCHESTRATE_HOME: root,
      ORKEST_HERDR_VIEW_STATE: file,
    },
  };
}

async function orcaFixture(overrides = {}) {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "ork-companion-orca-"));
  const root = await realpath(tempRoot);
  directories.push(root);
  const file = path.join(root, "orca-views-v1", "room-a.json");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    JSON.stringify({
      schema: ORCA_VIEW_SCHEMA,
      room: "room-a",
      workspaceId: "ws-1",
      terminalId: "term_view",
      sourceTerminalId: "term_coord",
      chief: false,
      closed: false,
      ...overrides,
    }),
  );
  return {
    root,
    file,
    env: {
      HOME: root,
      PATH: path.join(root, "empty-bin"),
      ORKEST_ORCA_VIEW_STATE: file,
    },
  };
}

describe("Herdr companion pane dismissal", () => {
  it("recognizes Herdr companion split views only when non-chief env variables are present", () => {
    expect(
      isHerdrCompanionView({
        HERDR_ENV: "1",
        HERDR_PANE_ID: "w1:p2",
        ORKEST_HERDR_VIEW_STATE: "/tmp/view.json",
      }),
    ).toBe(true);
    expect(
      isHerdrCompanionView({
        HERDR_ENV: "1",
        HERDR_PANE_ID: "w1:p2",
        ORKEST_HERDR_VIEW_STATE: "/tmp/view.json",
        ORKEST_CHIEF_VIEW: "1",
      }),
    ).toBe(false);
    expect(isHerdrCompanionView({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p2" })).toBe(false);
    expect(
      isHerdrCompanionView({ HERDR_PANE_ID: "w1:p2", ORKEST_HERDR_VIEW_STATE: "/tmp/view.json" }),
    ).toBe(false);
  });

  it("refuses to dismiss chief or non-companion views", async () => {
    const { env, closed } = await herdrFixture({ chief: true });
    expect(await closeHerdrCompanionPane("room-a", { env })).toEqual({
      dismissed: false,
      reason: "not_companion",
    });
    expect(
      await closeHerdrCompanionPane("room-a", {
        env: { ...env, ORKEST_CHIEF_VIEW: "1" },
      }),
    ).toEqual({ dismissed: false, reason: "not_companion" });
    await expect(readFile(closed, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves restore state when the Herdr multiplexer is unavailable", async () => {
    const { env, closed, pending } = await herdrFixture();
    const exec = vi.fn((_binary, _args, _options, callback) => callback(new Error("unreachable")));
    expect(await closeHerdrCompanionPane("room-a", { env, exec })).toEqual({
      dismissed: false,
      multiplexerUnavailable: true,
    });
    expect(exec).toHaveBeenCalledTimes(1);
    await expect(readFile(closed, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(pending, "utf8")).toBe("pending\n");
  });

  it("writes closure markers before closing via pane close or plugin pane close fallback", async () => {
    const { env, closed, pending } = await herdrFixture();
    const calls = [];
    const exec = (binary, args, _options, callback) => {
      calls.push([binary, ...args]);
      if (args[0] === "pane" && args[1] === "current") {
        callback(
          null,
          JSON.stringify({ result: { pane: { pane_id: "w2:p5", terminal_id: "term-view" } } }),
        );
        return;
      }
      if (args[0] === "pane" && args[1] === "close") {
        callback(new Error("plugin pane required"));
        return;
      }
      callback(null, "{}");
    };
    expect(await closeHerdrCompanionPane("room-a", { env, exec })).toEqual({
      dismissed: true,
      paneId: "w2:p5",
    });
    expect(calls).toEqual([
      ["herdr", "pane", "current", "--current"],
      ["herdr", "pane", "close", "w2:p5"],
      ["herdr", "plugin", "pane", "close", "w2:p5"],
    ]);
    expect(await readFile(closed, "utf8")).toBe("closed\n");
    await expect(readFile(pending, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("Orca companion pane dismissal", () => {
  it("refuses chief views, standalone tabs without sourceTerminalId, and missing files", async () => {
    const chief = await orcaFixture({ chief: true });
    expect(await closeOrcaCompanionPane(chief.file, { env: chief.env })).toEqual({
      dismissed: false,
      reason: "not_companion",
    });
    expect((await readJsonState(chief.file)).closed).toBe(false);

    const standalone = await orcaFixture({ sourceTerminalId: null });
    expect(await closeOrcaCompanionPane(standalone.file, { env: standalone.env })).toEqual({
      dismissed: false,
      reason: "not_companion",
    });
    expect(
      await closeOrcaCompanionPane(standalone.file, {
        env: { ...standalone.env, ORKEST_CHIEF_VIEW: "1" },
      }),
    ).toEqual({ dismissed: false, reason: "not_companion" });
    expect(await closeOrcaCompanionPane(path.join(chief.root, "missing.json"))).toEqual({
      dismissed: false,
      reason: "not_companion",
    });
  });

  it("marks autoDismissed and attempts best-effort CLI close when Orca CLI is present", async () => {
    const { root, file, env } = await orcaFixture();
    const binDir = path.join(root, "bin");
    const fakeCli = path.join(binDir, "orca-ide");
    await mkdir(binDir, { recursive: true });
    await writeFile(fakeCli, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    const calls = [];
    const exec = (command, args, _options, callback) => {
      calls.push([command, args]);
      callback(new Error("cli close failed"));
    };
    const result = await closeOrcaCompanionPane(file, {
      env: { ...env, ORCA_CLI_COMMAND: fakeCli },
      exec,
      now: () => 1_700_000_000_000,
    });
    expect(result).toEqual({ dismissed: true, terminalId: "term_view" });
    expect(calls).toEqual([[fakeCli, ["terminal", "close", "--terminal", "term_view", "--json"]]]);
    expect(await readJsonState(file)).toMatchObject({
      closed: true,
      autoDismissed: true,
      closedAt: new Date(1_700_000_000_000).toISOString(),
    });
  });
});

describe("hasActiveRoomWork", () => {
  it("recognizes active worker states and open continuations while ignoring settled outcomes", () => {
    expect(hasActiveRoomWork({ agents: [], continuations: [] })).toBe(false);
    expect(
      hasActiveRoomWork({
        agents: [
          { status: "completed", verdict: "accept" },
          { status: "cancelled" },
          { status: "failed" },
          { status: "review", dispatch: { taskId: "t-1" }, runtimeState: "idle" },
        ],
        continuations: [{ status: "completed" }, { status: "paused" }],
      }),
    ).toBe(false);

    for (const status of [
      "running",
      "working",
      "planning",
      "testing",
      "review",
      "reserved",
      "queued",
      "dispatching",
      "starting",
    ]) {
      expect(hasActiveRoomWork({ agents: [{ status }] })).toBe(true);
    }
    expect(hasActiveRoomWork({ agents: [{ status: "idle", runtimeState: "running" }] })).toBe(true);

    for (const status of ["requested", "reserved", "awaiting_attachment", "running"]) {
      expect(hasActiveRoomWork({ agents: [], continuations: [{ status }] })).toBe(true);
      expect(hasActiveRoomWork({ agents: [], continuations: [{ state: status }] })).toBe(true);
    }
  });
});

describe("companion auto-dismiss monitor", () => {
  it("stays inactive outside companion splits, in Chief mode, and while drilled into a room", async () => {
    const { env } = await herdrFixture();
    let clock = 0;
    const exec = vi.fn((_b, _a, _o, cb) => cb(null, "{}"));

    const standalone = createCompanionDismissMonitor({ env: {}, exec, now: () => clock });
    const chief = createCompanionDismissMonitor({ env, exec, chiefMode: true, now: () => clock });
    const withChief = createCompanionDismissMonitor({
      env,
      exec,
      hasChiefView: true,
      now: () => clock,
    });
    for (const monitor of [standalone, chief, withChief]) {
      expect(await monitor.evaluate({ id: "room-a", conductor: { sessionLive: true } })).toEqual({
        action: "none",
      });
      expect(await monitor.evaluate({ id: "room-a", conductor: { sessionLive: false } })).toEqual({
        action: "none",
      });
      clock += COMPANION_DISMISS_GRACE_MS + 1000;
      expect(await monitor.evaluate({ id: "room-a", conductor: { sessionLive: false } })).toEqual({
        action: "none",
      });
    }
    expect(exec).not.toHaveBeenCalled();

    const drilled = createCompanionDismissMonitor({ env, exec, now: () => clock });
    expect(await drilled.evaluate({ id: "room-a", conductor: { sessionLive: true } })).toEqual({
      action: "none",
    });
    clock = 1000;
    expect(
      await drilled.evaluate(
        { id: "room-b", conductor: { sessionLive: false } },
        { drilledRoomId: "room-b" },
      ),
    ).toEqual({ action: "none" });
    clock = 10_000;
    expect(
      await drilled.evaluate(
        { id: "room-b", conductor: { sessionLive: false } },
        { drilledRoomId: "room-b" },
      ),
    ).toEqual({ action: "none" });
    // Exiting drill starts a fresh grace window from the first un-drilled dead observation.
    expect(await drilled.evaluate({ id: "room-a", conductor: { sessionLive: false } })).toEqual({
      action: "none",
    });
    expect(exec).not.toHaveBeenCalled();
  });

  it("never dismisses a cold-opened post-mortem room whose conductor was never seen live", async () => {
    const { env, closed } = await herdrFixture();
    let clock = 0;
    const exec = vi.fn();
    const monitor = createCompanionDismissMonitor({ env, exec, now: () => clock });
    const deadRoom = {
      id: "room-a",
      conductor: { status: "reported complete", sessionLive: false, runtimeState: "unknown" },
      agents: [],
    };
    expect(await monitor.evaluate(deadRoom)).toEqual({ action: "none" });
    clock += COMPANION_DISMISS_GRACE_MS + 1000;
    expect(await monitor.evaluate(deadRoom)).toEqual({ action: "none" });
    expect(exec).not.toHaveBeenCalled();
    await expect(readFile(closed, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("holds open while workers run, clears the notice on recovery, and dismisses after grace", async () => {
    const { env, closed } = await herdrFixture();
    let clock = 0;
    const calls = [];
    const exec = (binary, args, _options, callback) => {
      calls.push([binary, ...args]);
      if (args[0] === "pane" && args[1] === "current") {
        callback(
          null,
          JSON.stringify({ result: { pane: { pane_id: "w1:p2", terminal_id: "term-view" } } }),
        );
        return;
      }
      callback(null, "{}");
    };
    const monitor = createCompanionDismissMonitor({ env, exec, now: () => clock });

    // 1. Live idle conductor is observed.
    expect(
      await monitor.evaluate({
        id: "room-a",
        conductor: { sessionLive: true, runtimeState: "idle" },
        agents: [],
      }),
    ).toEqual({ action: "none" });

    // 2. Conductor exits while a worker is active -> holds open with notice.
    clock = 1000;
    expect(
      await monitor.evaluate({
        id: "room-a",
        conductor: { sessionLive: false, runtimeState: "unknown" },
        agents: [{ id: "worker-1", status: "working", runtimeState: "running" }],
      }),
    ).toEqual({
      action: "hold",
      notice: "Orchestrator exited — keeping Swarm View open while workers finish",
    });

    // 3. Conductor returns before workers finish -> clears the hold notice.
    clock = 2000;
    expect(
      await monitor.evaluate({
        id: "room-a",
        conductor: { sessionLive: true, runtimeState: "idle" },
        agents: [{ id: "worker-1", status: "working", runtimeState: "running" }],
      }),
    ).toEqual({ action: "clear-notice" });

    // 4. Conductor exits with no active work, then rebinds inside 4s -> resets grace timer.
    clock = 3000;
    expect(
      await monitor.evaluate({
        id: "room-a",
        conductor: { sessionLive: false },
        agents: [{ id: "worker-1", status: "completed", verdict: "accept" }],
      }),
    ).toEqual({ action: "none" });
    clock = 6999;
    expect(
      await monitor.evaluate({
        id: "room-a",
        conductor: { sessionLive: true },
        agents: [{ id: "worker-1", status: "completed", verdict: "accept" }],
      }),
    ).toEqual({ action: "none" });

    // 5. Conductor exits again -> waits full 4000ms before closing.
    clock = 7000;
    expect(
      await monitor.evaluate({
        id: "room-a",
        conductor: { sessionLive: false },
        agents: [{ id: "worker-1", status: "completed", verdict: "accept" }],
      }),
    ).toEqual({ action: "none" });
    clock = 10_999;
    expect(
      await monitor.evaluate({
        id: "room-a",
        conductor: { sessionLive: false },
        agents: [{ id: "worker-1", status: "completed", verdict: "accept" }],
      }),
    ).toEqual({ action: "none" });
    expect(calls).toEqual([]);

    clock = 11_000;
    expect(
      await monitor.evaluate({
        id: "room-a",
        conductor: { sessionLive: false },
        agents: [{ id: "worker-1", status: "completed", verdict: "accept" }],
      }),
    ).toEqual({ action: "dismiss", result: { dismissed: true, paneId: "w1:p2" } });
    expect(calls).toEqual([
      ["herdr", "pane", "current", "--current"],
      ["herdr", "pane", "close", "w1:p2"],
    ]);
    expect(await readFile(closed, "utf8")).toBe("closed\n");
  });

  it("keeps waiting when Herdr is temporarily unavailable and dismisses Orca companion views", async () => {
    const herdr = await herdrFixture();
    let clock = 0;
    let isHerdrUp = false;
    const herdrExec = (_binary, args, _options, callback) => {
      if (!isHerdrUp) {
        callback(new Error("restarting"));
        return;
      }
      if (args[0] === "pane" && args[1] === "current") {
        callback(
          null,
          JSON.stringify({ result: { pane: { pane_id: "w1:p2", terminal_id: "term-view" } } }),
        );
        return;
      }
      callback(null, "{}");
    };
    const herdrMonitor = createCompanionDismissMonitor({
      env: herdr.env,
      exec: herdrExec,
      now: () => clock,
    });
    await herdrMonitor.evaluate({ id: "room-a", conductor: { sessionLive: true } });
    clock = 1000;
    await herdrMonitor.evaluate({ id: "room-a", conductor: { sessionLive: false } });
    clock = 5000;
    expect(
      await herdrMonitor.evaluate({ id: "room-a", conductor: { sessionLive: false } }),
    ).toEqual({
      action: "wait",
      result: { dismissed: false, multiplexerUnavailable: true },
    });
    await expect(readFile(herdr.closed, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    isHerdrUp = true;
    expect(
      await herdrMonitor.evaluate({ id: "room-a", conductor: { sessionLive: false } }),
    ).toEqual({
      action: "dismiss",
      result: { dismissed: true, paneId: "w1:p2" },
    });
    expect(await readFile(herdr.closed, "utf8")).toBe("closed\n");

    // Orca companion flow: writes closed + autoDismissed even without CLI on PATH.
    const orca = await orcaFixture();
    let orcaClock = 0;
    const orcaMonitor = createCompanionDismissMonitor({ env: orca.env, now: () => orcaClock });
    expect(
      await orcaMonitor.evaluate({
        id: "room-a",
        conductor: { runtimeState: "running" },
        agents: [],
      }),
    ).toEqual({ action: "none" });
    orcaClock = 100;
    expect(
      await orcaMonitor.evaluate({
        id: "room-a",
        conductor: { sessionLive: false },
        agents: [],
      }),
    ).toEqual({ action: "none" });
    orcaClock = 4100;
    expect(
      await orcaMonitor.evaluate({
        id: "room-a",
        conductor: { sessionLive: false },
        agents: [],
      }),
    ).toEqual({
      action: "dismiss",
      result: { dismissed: true, terminalId: "term_view" },
    });
    expect(await readJsonState(orca.file)).toMatchObject({
      closed: true,
      autoDismissed: true,
    });
  });
});
