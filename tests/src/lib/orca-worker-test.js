import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { summarizeQuota as monitorSummarizeQuota } from "../../../src/lib/monitor/render.mjs";
import {
  closeOrcaCompanionPane,
  enrichedPath,
  findExecutable,
  isScreenReaderOrca,
  orcaPaneContext,
  orcaTerminalsPath,
  orcaViewPath,
  readJsonState,
  readOrcaView,
  resolveOrcaCli,
} from "../../../src/lib/orca-context.mjs";
import activate, {
  createOrcaWorker,
  deactivate,
  eligibleRooms,
  matchRoom,
  PANEL_ACTIONS,
  parsePanelAction,
  QUOTA_INTERVAL_MS,
  QUOTA_ITEM,
  REPO_ROOT,
  summarizeQuota,
  swarmViewCommand,
} from "../../../src/lib/orca-worker.mjs";
import { checkOrcaManifest } from "../../../scripts/validate.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SCREEN_READER = "/usr/bin/orca";

function hostError(code, message = code) {
  return Object.assign(new Error(message), { code });
}

/** A stand-in Orca host: records calls and answers from a small mutable workspace model. */
function mockOrca({
  terminals = ["term_coord"],
  workspaceId = "ws1",
  extra = {},
  without = [],
  panels = true,
} = {}) {
  const state = {
    workspaceId,
    terminals: [...terminals],
    next: 1,
    calls: [],
    status: [],
    posts: [],
  };
  const handlers = new Map();
  const commands = new Map();
  const panelHandlers = new Map();
  const results = {
    "workspace.readContext": () => ({
      workspaceId: state.workspaceId,
      branch: "main",
      displayName: "repo",
      terminals: state.terminals.map((id) => ({ id })),
    }),
    "terminal.list": ({ workspaceId: id }) => {
      if (id !== state.workspaceId) throw hostError("action_failed");
      return { terminals: state.terminals.map((terminal) => ({ id: terminal })), truncated: false };
    },
    "agents.list": () => ({
      agents: [{ terminalId: "term_coord", agent: "claude", state: "working", sessionId: "s-1" }],
    }),
    "terminal.create": ({ workspaceId: id, title, command }) => {
      if (!id || !title || !command) throw hostError("invalid_params");
      const terminalId = `term_new${state.next++}`;
      state.terminals.push(terminalId);
      return { terminalId };
    },
    "terminal.close": ({ terminalId }) => {
      state.terminals = state.terminals.filter((terminal) => terminal !== terminalId);
      return { closed: true };
    },
    "statusBar.update": (params) => {
      state.status.push(params);
      return { ok: true };
    },
    ...extra,
  };
  for (const method of without) delete results[method];
  const orca = {
    log: () => {},
    host: {
      has: (method) => Object.hasOwn(results, method),
      call: async (method, params) => {
        state.calls.push({ method, params });
        if (!Object.hasOwn(results, method)) throw hostError("unknown_method");
        return results[method](params ?? {});
      },
    },
    commands: { register: (id, handler) => commands.set(id, handler) },
    ...(panels && {
      panels: {
        handle: (name, handler) => panelHandlers.set(name, handler),
        post: (event, payload) => {
          state.posts.push({ event, payload });
        },
      },
    }),
    events: {
      on: (event, handler) => {
        handlers.set(event, handler);
        return { dispose: () => handlers.delete(event) };
      },
    },
  };
  return {
    orca,
    state,
    commands,
    handlers,
    panelHandlers,
    request: (name, input) => panelHandlers.get(name)(input, { panel: { id: "orkest-swarm" } }),
    methods: () => state.calls.map(({ method }) => method),
    emit: (event, payload) => handlers.get(event)?.(payload),
  };
}

const ROOM = {
  id: "room-a",
  orcaCoordinatorTerminalId: "term_coord",
  conductor: { session: { id: "s-1" } },
  updatedAt: "2026-11-18T00:00:00Z",
};

describe("orca worker", () => {
  let home;
  let env;
  let timers;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "orkest-orca-"));
    // Orca hands its worker a stripped environment; HOME and PATH are all this test supplies.
    env = { HOME: home, PATH: path.join(home, "no-bin") };
    timers = [];
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  function worker(host, options = {}) {
    return createOrcaWorker(host.orca, {
      env,
      cli: null,
      node: null,
      listRooms: async () => [ROOM],
      setInterval: (callback, delay) => {
        const timer = { callback, delay, unref: () => {} };
        timers.push(timer);
        return timer;
      },
      clearInterval: (timer) => {
        timer.cleared = true;
      },
      exec: () => {
        throw new Error("unexpected exec");
      },
      ...options,
    });
  }

  it("matches the manifest: commands, events, quota item and repository-relative main", async () => {
    const manifest = JSON.parse(await readFile(path.join(ROOT, "orca-plugin.json"), "utf8"));
    expect(manifest.main).toBe("src/lib/orca-worker.mjs");
    expect(findExecutable("node", env, { exists: () => false })).toBeNull();
    expect(REPO_ROOT).toBe(ROOT);
    expect(typeof activate).toBe("function");
    expect(typeof deactivate).toBe("function");
    expect(manifest.contributes.statusBarItems.map(({ id }) => id)).toEqual([QUOTA_ITEM]);
    expect(checkOrcaManifest(ROOT)).toEqual([]);

    const host = mockOrca();
    const instance = worker(host);
    await instance.start();
    await expect.poll(() => host.state.status.at(-1)?.text).toBe("Quota ?");
    const sorted = (values) => values.toSorted((left, right) => left.localeCompare(right));
    expect(sorted(host.commands.keys().toArray())).toEqual(
      sorted(manifest.contributes.commands.map(({ id }) => id)),
    );
    expect(manifest.contributes.commands.map(({ id }) => id)).toContain("orkest.chief.open");
    expect(sorted(host.panelHandlers.keys().toArray())).toEqual(["swarm.action", "swarm.status"]);
    expect(sorted(host.handlers.keys().toArray())).toEqual(
      sorted(manifest.contributes.events.map(({ on }) => on)),
    );
    await instance.stop();
    expect(host.handlers.size).toBe(0);
    expect(timers[0].cleared).toBe(true);
  });

  it("activates through the default export under a HOME and PATH only environment", async () => {
    const keys = ["HOME", "PATH", "ORCHESTRATE_HOME", "AGENT_EXECUTOR_HOME", "XDG_CACHE_HOME"];
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    const host = mockOrca();
    try {
      for (const key of keys) delete process.env[key];
      process.env.HOME = home;
      process.env.PATH = env.PATH;
      const bin = path.join(home, ".local", "bin");
      await mkdir(bin, { recursive: true });
      const node = path.join(bin, "node");
      await writeFile(node, `#!/bin/sh\nprintf '%s\\n' '{"accounts":[]}'\n`);
      await chmod(node, 0o755);
      await activate(host.orca);
      expect(host.commands.has("orkest.swarm.toggle")).toBe(true);
      await expect.poll(() => host.state.status.at(-1)?.text).toBe("Quota —");
    } finally {
      await deactivate();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("toggles the Swarm View open and closed, recording it under the cache", async () => {
    const host = mockOrca();
    const instance = worker(host);
    await instance.start();
    expect(await host.commands.get("orkest.swarm.toggle")()).toBe(
      "Swarm View opened (room room-a).",
    );
    const create = host.state.calls.find(({ method }) => method === "terminal.create");
    expect(create.params).toMatchObject({ workspaceId: "ws1", title: "Orkest Swarm · room-a" });
    expect(create.params.command).toContain("horde --attach-room 'room-a' --view");
    const record = await readOrcaView("room-a", env);
    expect(record).toMatchObject({ terminalId: "term_new1", workspaceId: "ws1", closed: false });
    expect(orcaViewPath("room-a", env).startsWith(path.join(home, ".cache/orchestrate"))).toBe(
      true,
    );

    expect(await host.commands.get("orkest.swarm.open")()).toBe(
      "Swarm View is already open (room room-a).",
    );
    expect(await host.commands.get("orkest.swarm.toggle")()).toBe(
      "Swarm View closed (room room-a).",
    );
    expect(host.state.terminals).toEqual(["term_coord"]);
    expect((await readOrcaView("room-a", env)).closed).toBe(true);
    expect(await host.commands.get("orkest.swarm.close")()).toBe(
      "Swarm View is already closed (room room-a).",
    );
    await instance.stop();
  });

  it("splits beside the coordinator through the Orca CLI and never runs the screen reader", async () => {
    const host = mockOrca();
    const calls = [];
    const exec = (command, args, options, callback) => {
      calls.push([command, args]);
      // The child gets a derived PATH; the worker's own environment is left alone.
      expect(options.env.PATH).toBe(enrichedPath(env));
      expect(env.PATH).toBe(path.join(home, "no-bin"));
      queueMicrotask(() =>
        callback(
          null,
          args[1] === "split"
            ? JSON.stringify({ result: { split: { handle: "term_split", tabId: "t1" } } })
            : "{}",
        ),
      );
    };
    const instance = worker(host, { cli: "/opt/orca/orca-ide", exec });
    await instance.start();
    expect(await host.commands.get("orkest.swarm.open")()).toContain("opened");
    expect(calls[0][1].slice(0, 6)).toEqual([
      "terminal",
      "split",
      "--terminal",
      "term_coord",
      "--direction",
      "vertical",
    ]);
    expect(calls[1][1]).toEqual([
      "terminal",
      "rename",
      "--terminal",
      "term_split",
      "--title",
      "Orkest Swarm · room-a",
      "--json",
    ]);
    expect(calls.every(([command]) => command !== SCREEN_READER)).toBe(true);
    expect(host.methods()).not.toContain("terminal.create");
    expect(await readOrcaView("room-a", env)).toMatchObject({
      terminalId: "term_split",
      method: "cli-split",
    });
    await instance.stop();
  });

  it("falls back from a host split the Orca build refuses, and stops after a timed-out split", async () => {
    const host = mockOrca({
      extra: {
        "terminal.split": () => {
          throw hostError("invalid_params");
        },
      },
    });
    const instance = worker(host);
    await instance.start();
    expect(await instance.swarm("open")).toMatchObject({ status: "opened", method: "create" });
    await instance.stop();

    const timedOut = mockOrca();
    const exec = (command, args, options, callback) =>
      queueMicrotask(() => callback(Object.assign(new Error("timeout"), { killed: true })));
    const slow = worker(timedOut, { cli: "/opt/orca/orca-ide", exec });
    await slow.start();
    expect(await slow.swarm("open")).toMatchObject({ status: "error" });
    expect(timedOut.methods()).not.toContain("terminal.create");
    await slow.stop();
  });

  it("reports when no swarm is bound to the focused workspace", async () => {
    const host = mockOrca();
    const instance = worker(host, { listRooms: async () => [] });
    await instance.start();
    expect(await host.commands.get("orkest.swarm.toggle")()).toContain("No Orkest swarm");
    expect(host.methods()).not.toContain("terminal.create");
    await instance.stop();
  });

  it("restores open views after a cold restart and leaves closed or present ones alone", async () => {
    const write = async (room, record) => {
      const file = orcaViewPath(room, env);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(
        file,
        JSON.stringify({ schema: "orkest.orca-view.v1", room, workspaceId: "ws1", ...record }),
      );
    };
    await write("room-gone", { terminalId: "term_old", sourceTerminalId: "term_coord" });
    await write("room-chief-less", { terminalId: "term_old3" });
    await write("room-closed", { terminalId: "term_old2", closed: true });
    await write("room-present", { terminalId: "term_live" });
    const host = mockOrca({ terminals: ["term_coord", "term_live"] });
    const bound = (id) => ({ id, orcaWorkspaceId: "ws1" });
    const instance = worker(host, {
      listRooms: async () => [bound("room-gone"), bound("room-closed"), bound("room-present")],
    });
    const outcomes = await instance.start();
    expect(outcomes).toContainEqual({ room: "room-chief-less", status: "room_missing" });
    const creates = host.state.calls.filter(({ method }) => method === "terminal.create");
    expect(creates).toHaveLength(1);
    expect(creates[0].params.command).toContain("'room-gone'");
    expect((await readOrcaView("room-gone", env)).terminalId).toBe("term_new1");
    expect((await readOrcaView("room-closed", env)).closed).toBe(true);
    expect((await readOrcaView("room-present", env)).terminalId).toBe("term_live");

    // Closing the view's pane while Orca runs records the person's intent.
    host.state.terminals = ["term_coord", "term_live"];
    await host.emit("workspace.changed", {
      context: { workspaceId: "ws1", branch: "main", displayName: "repo", terminals: [] },
    });
    expect((await readOrcaView("room-gone", env)).closed).toBe(true);
    await instance.stop();
  });

  it("records agent terminals with their pane keys and sessions", async () => {
    const host = mockOrca();
    const instance = worker(host);
    await instance.start();
    await host.emit("agent.status.changed", {
      workspaceId: "ws1",
      paneKey: "pane-7",
      terminalId: "term_agent",
      state: "working",
      receivedAt: 1,
      sessionId: "s-7",
    });
    await instance.swarm("open");
    const saved = JSON.parse(await readFile(orcaTerminalsPath(env), "utf8"));
    expect(saved.terminals.term_agent).toMatchObject({ paneKey: "pane-7", sessionId: "s-7" });
    expect(saved.terminals.term_coord).toMatchObject({ sessionId: "s-1", workspaceId: "ws1" });
    await instance.stop();
  });

  it("updates the quota item from monitor json every 60 seconds without overlapping runs", async () => {
    const host = mockOrca();
    const runs = [];
    const exec = (command, args, options, callback) => {
      runs.push(args);
      queueMicrotask(() =>
        callback(
          null,
          JSON.stringify({
            schema: "monitor.snapshot.v1",
            generatedAt: "2026-11-18T00:00:00Z",
            accounts: [
              {
                id: "c",
                short: "C",
                label: "Claude",
                windows: [{ label: "5h", remainingPct: 62 }],
              },
              { id: "x", short: "X", label: "Codex", windows: [{ label: "wk", remainingPct: 8 }] },
            ],
          }),
        ),
      );
    };
    const instance = worker(host, { node: "/usr/bin/node", exec });
    await instance.start();
    expect(timers[0].delay).toBe(QUOTA_INTERVAL_MS);
    expect(QUOTA_INTERVAL_MS).toBe(60_000);
    await expect.poll(() => host.state.status.length).toBe(1);
    expect(runs[0]).toEqual([path.join(ROOT, "src/bin/monitor.mjs"), "json"]);
    expect(host.state.status[0]).toMatchObject({
      id: QUOTA_ITEM,
      text: "X 8% · C 62%",
      tone: "danger",
    });
    timers[0].callback();
    timers[0].callback();
    await expect.poll(() => host.state.status.length).toBe(2);
    expect(runs).toHaveLength(2);
    expect(await host.commands.get("orkest.quota.refresh")()).toBe("Quota: X 8% · C 62%");
    await instance.stop();
  });

  it("summarizes quota snapshots and failures", () => {
    expect(summarizeQuota({ accounts: [] })).toMatchObject({ text: "Quota —", tone: "neutral" });
    expect(
      summarizeQuota({ accounts: [{ label: "Codex", ok: false, error: "expired" }] }),
    ).toMatchObject({ text: "Quota —", tone: "warning", tooltip: "Codex: expired" });
    expect(
      summarizeQuota({ accounts: [{ short: "C", windows: [{ remainingPct: 20 }] }] }).tone,
    ).toBe("warning");
  });

  it("matches rooms by coordinator terminal, then session, then workspace", () => {
    const context = { workspaceId: "ws1", terminals: [{ id: "term_a" }] };
    const rooms = [
      { id: "by-workspace", orcaWorkspaceId: "ws1" },
      { id: "by-session", conductor: { session: { id: "s-9" } } },
      { id: "by-terminal", orcaCoordinatorTerminalId: "term_a" },
    ];
    const registry = { term_b: { workspaceId: "ws1", sessionId: "s-9" } };
    expect(matchRoom(rooms, context, registry).id).toBe("by-terminal");
    expect(matchRoom(rooms.slice(0, 2), context, registry).id).toBe("by-session");
    expect(matchRoom(rooms.slice(0, 1), context, registry).id).toBe("by-workspace");
    expect(matchRoom(rooms, { workspaceId: "ws2", terminals: [] }, registry)).toBeNull();
  });

  it("quotes the view command for the terminal's shell", () => {
    expect(swarmViewCommand("it's", "/tmp/a b.json", { ork: "/x/ork.mjs" })).toBe(
      String.raw`exec env 'ORKEST_ORCA_VIEW_STATE=/tmp/a b.json' node '/x/ork.mjs' horde --attach-room 'it'\''s' --view`,
    );
  });

  it("closes auto-dismissed companion split terminals via host RPC without extra terminal.list polling", async () => {
    const host = mockOrca();
    const instance = worker(host);
    await instance.start();

    // Regular workspace/agent events make no terminal.list or terminal.close calls without pending auto-dismissals.
    host.state.calls.length = 0;
    await host.emit("workspace.changed", {
      context: {
        workspaceId: "ws1",
        branch: "main",
        displayName: "repo",
        terminals: [{ id: "term_coord" }],
      },
    });
    await host.emit("agent.status.changed", {
      workspaceId: "ws1",
      paneKey: "pane-coord",
      terminalId: "term_coord",
      state: "idle",
      sessionId: "s-1",
    });
    expect(host.methods()).not.toContain("terminal.list");
    expect(host.methods()).not.toContain("terminal.close");

    // Open the companion view, then auto-dismiss it with no Orca CLI on PATH.
    expect(await host.commands.get("orkest.swarm.open")()).toContain("opened");
    expect(host.state.terminals).toEqual(["term_coord", "term_new1"]);
    const viewFile = orcaViewPath("room-a", env);
    expect(await closeOrcaCompanionPane(viewFile, { env })).toEqual({
      dismissed: true,
      terminalId: "term_new1",
    });

    // Host worker notices autoDismissed on agent.status.changed and closes the split via host RPC.
    host.state.calls.length = 0;
    await host.emit("agent.status.changed", {
      workspaceId: "ws1",
      paneKey: "pane-coord",
      terminalId: "term_coord",
      state: "stopped",
      sessionId: "s-1",
    });
    expect(host.methods()).toContain("terminal.list");
    expect(host.methods()).toContain("terminal.close");
    expect(host.state.terminals).toEqual(["term_coord"]);
    expect(await readOrcaView("room-a", env)).toMatchObject({
      closed: true,
      autoDismissed: true,
      terminalClosed: true,
    });

    // Once terminalClosed is stamped, subsequent events do not re-poll terminal.list.
    host.state.calls.length = 0;
    await host.emit("workspace.changed", {
      context: {
        workspaceId: "ws1",
        branch: "main",
        displayName: "repo",
        terminals: [{ id: "term_coord" }],
      },
    });
    expect(host.methods()).not.toContain("terminal.list");
    expect(host.methods()).not.toContain("terminal.close");
    await instance.stop();
  });
});

describe("orca context", () => {
  const realpath = (file) => (file === "/bin/orca" ? SCREEN_READER : file);
  const which = (found) => (name) => found[name] ?? null;

  it("never resolves the Linux screen reader as the Orca CLI", () => {
    expect(isScreenReaderOrca(SCREEN_READER, { platform: "linux", realpath })).toBe(true);
    expect(isScreenReaderOrca("/bin/orca", { platform: "linux", realpath })).toBe(true);
    expect(isScreenReaderOrca(SCREEN_READER, { platform: "darwin", realpath })).toBe(false);
    const linux = { platform: "linux", realpath };
    expect(
      resolveOrcaCli({}, { ...linux, which: which({ orca: SCREEN_READER, "orca-ide": "/o/ide" }) }),
    ).toBe("/o/ide");
    expect(resolveOrcaCli({}, { ...linux, which: which({ orca: "/bin/orca" }) })).toBeNull();
    expect(resolveOrcaCli({}, { ...linux, which: which({ orca: "/shim/orca" }) })).toBe(
      "/shim/orca",
    );
    // An explicit choice never falls through to another executable.
    expect(
      resolveOrcaCli(
        { ORCA_CLI_COMMAND: SCREEN_READER },
        { ...linux, which: (name) => (name === SCREEN_READER ? name : "/o/ide") },
      ),
    ).toBeNull();
    expect(
      resolveOrcaCli(
        { ORCA_DEV_REPO_ROOT: "/src/orca" },
        { ...linux, which: which({ "orca-dev": "/o/dev", "orca-ide": "/o/ide" }) },
      ),
    ).toBe("/o/dev");
    expect(
      resolveOrcaCli(
        {},
        { platform: "darwin", realpath, which: which({ orca: "/usr/local/orca" }) },
      ),
    ).toBe("/usr/local/orca");
  });

  it("reads the Orca pane identity, accepting the scrub-safe aliases", () => {
    expect(orcaPaneContext({})).toBeNull();
    expect(
      orcaPaneContext({
        ORCA_AGENT_PANE: "pane-1",
        ORCA_TERMINAL_HANDLE: "term_1",
        ORCA_AGENT_LAUNCH: "token",
        ORCA_WORKTREE_ID: "wt",
      }),
    ).toMatchObject({ paneKey: "pane-1", terminalHandle: "term_1", launchToken: "token" });
    expect(
      orcaPaneContext({ ORCA_PANE_KEY: "p", ORCA_TERMINAL_HANDLE: "--bad" }).terminalHandle,
    ).toBe("");
  });

  it("flags manifests that break the Orca rules Orkest relies on", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "orkest-orca-manifest-"));
    try {
      await writeFile(
        path.join(root, "orca-plugin.json"),
        JSON.stringify({
          manifestVersion: 2,
          execution: "declarative",
          id: "orca-thing",
          publisher: "me",
          version: "1",
          engines: { orca: ">=1.4.248" },
          main: "missing.mjs",
          contributes: {
            commands: [{ id: "a" }],
            keybindings: [{ command: "b", key: "Mod+K" }],
            hooks: [{ event: "agent.tool.before" }],
          },
        }),
      );
      const errors = checkOrcaManifest(root).join("\n");
      for (const expected of [
        "trusted-worker",
        "publisher",
        "orca-",
        "semver",
        ">=1.4.259",
        "missing.mjs",
        "hooks",
        "b is not",
      ]) {
        expect(errors).toContain(expected);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ignores closed/archived/cancelled rooms, supports Chief View, and respects stop() mid-start", async () => {
    const chosen = matchRoom(
      [
        {
          id: "room-cancelled",
          lifecycle: "cancelled",
          status: "cancelled",
          cancelledAt: 200,
          orcaCoordinatorTerminalId: "term_coord",
          orcaWorkspaceId: "ws1",
        },
        {
          id: "room-archived",
          lifecycle: "archived",
          archivedAt: 150,
          orcaCoordinatorTerminalId: "term_coord",
          orcaWorkspaceId: "ws1",
        },
        {
          id: "room-live",
          lifecycle: "active",
          updatedAt: 50,
          orcaWorkspaceId: "ws1",
        },
      ],
      { workspaceId: "ws1", terminals: ["term_coord"] },
      {},
    );
    expect(chosen?.id).toBe("room-live");

    expect(
      swarmViewCommand("room-1", "/tmp/state.json", { ork: "/opt/ork.mjs", chief: true }),
    ).toContain(
      "ORKEST_CHIEF_VIEW=1 node '/opt/ork.mjs' horde --attach-room 'room-1' --view --chief",
    );
    expect(swarmViewCommand("", "/tmp/chief.json", { ork: "/opt/ork.mjs", chief: true })).toContain(
      "ORKEST_CHIEF_VIEW=1 node '/opt/ork.mjs' horde --view --chief",
    );
    expect(
      swarmViewCommand("", "/tmp/chief.json", { ork: "/opt/ork.mjs", chief: true }),
    ).not.toContain("--attach-room");

    const tmp = await mkdtemp(path.join(tmpdir(), "orkest-orca-chief-"));
    try {
      const host = mockOrca();
      const env = { HOME: tmp, ORCHESTRATE_HOME: tmp, PATH: "" };
      const worker = createOrcaWorker(host.orca, {
        env,
        exec: (_c, _a, cb) => cb(null, JSON.stringify({ accounts: [] })),
        listRooms: async () => [],
        startTimer: () => ({ unref() {} }),
        stopTimer: () => {},
      });
      await worker.start();
      const result = await host.commands.get("orkest.swarm.toggle")({ chief: true });
      expect(result).toContain("Swarm View opened");
      const chiefView = await readJsonState(orcaViewPath("__chief__", env));
      expect(chiefView).toMatchObject({ room: "", chief: true, closed: false });

      // Simulate cold restart with terminal missing: Chief View restores cleanly.
      host.state.terminals = ["term_coord"];
      await worker.stop();
      const worker2 = createOrcaWorker(host.orca, {
        env,
        exec: (_c, _a, cb) => cb(null, JSON.stringify({ accounts: [] })),
        listRooms: async () => [],
        startTimer: () => ({ unref() {} }),
        stopTimer: () => {},
      });
      const outcomes = await worker2.start();
      expect(outcomes).toEqual([{ room: "", status: "restored", chief: true }]);

      // Stop mid-startup never completes delayed restore/register after stop().
      let releaseReadContext;
      const slowHost = mockOrca({
        extra: {
          "workspace.readContext": () =>
            new Promise((resolve) => {
              releaseReadContext = () =>
                resolve({ workspaceId: "ws1", terminals: [{ id: "term_coord" }] });
            }),
        },
      });
      const worker3 = createOrcaWorker(slowHost.orca, {
        env,
        exec: (_c, _a, cb) => cb(null, JSON.stringify({ accounts: [] })),
        listRooms: async () => [],
        startTimer: () => ({ unref() {} }),
        stopTimer: () => {},
      });
      const starting = worker3.start();
      await vi.waitFor(() => expect(releaseReadContext).toBeTypeOf("function"));
      const stopping = worker3.stop();
      releaseReadContext();
      const [stoppedOutcomes] = await Promise.all([starting, stopping]);
      expect(stoppedOutcomes).toEqual([]);
      expect(worker3.isReady).toBe(false);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

const SNAPSHOT = (accounts) =>
  JSON.stringify({ schema: "monitor.snapshot.v1", generatedAt: "2026-11-18T00:00:00Z", accounts });
const CLAUDE_ACCOUNTS = [
  {
    id: "claude-personal",
    label: "Claude Personal",
    short: "CP",
    provider: "claude",
    windows: [{ label: "weekly", remainingPct: 57 }],
  },
  {
    id: "claude-work",
    label: "Claude Work",
    short: "CW",
    provider: "claude",
    windows: [{ label: "weekly", remainingPct: 31 }],
  },
];

describe("orca panel, host fallbacks and races", () => {
  let home;
  let env;
  let timers;
  let timeouts;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "orkest-orca-hard-"));
    env = { HOME: home, PATH: path.join(home, "no-bin") };
    timers = [];
    timeouts = [];
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  function worker(host, options = {}) {
    return createOrcaWorker(host.orca, {
      env,
      cli: null,
      node: null,
      listRooms: async () => [ROOM],
      setInterval: (callback, delay) => {
        const timer = { callback, delay, unref: () => {} };
        timers.push(timer);
        return timer;
      },
      clearInterval: (timer) => {
        timer.cleared = true;
      },
      setTimeout: (callback, delay) => {
        const timer = { callback, delay, unref: () => {} };
        timeouts.push(timer);
        return timer;
      },
      clearTimeout: (timer) => {
        timer.cleared = true;
      },
      exec: () => {
        throw new Error("unexpected exec");
      },
      ...options,
    });
  }

  async function writeView(room, record) {
    const file = orcaViewPath(room, env);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({ schema: "orkest.orca-view.v1", room, workspaceId: "ws1", ...record }),
    );
  }

  describe("manifest contract", () => {
    it("registers every contributed command, panel handler and event, within Orca's limits", async () => {
      const manifest = JSON.parse(await readFile(path.join(ROOT, "orca-plugin.json"), "utf8"));
      expect(manifest.engines.orca).toBe(">=1.4.259");
      expect(manifest.contributes.panels).toEqual([
        {
          id: "orkest-swarm",
          title: "Orkest",
          icon: "agent",
          ui: "html",
          entry: "src/lib/orca-panel.html",
        },
      ]);
      await expect(
        readFile(path.join(ROOT, manifest.contributes.panels[0].entry), "utf8"),
      ).resolves.toContain("<title>Orkest</title>");
      expect(manifest.contributes.events.length).toBeLessThanOrEqual(5);
      expect(manifest.contributes.commands.length).toBeLessThanOrEqual(256);
      expect(manifest.contributes.hooks).toEqual([]);
      const kinds = manifest.capabilities.map(({ kind }) => kind);
      expect(kinds).toEqual(
        expect.arrayContaining([
          "workspace:read",
          "agent:read",
          "terminal:send",
          "workspace:write",
        ]),
      );

      const host = mockOrca();
      const instance = worker(host);
      await instance.start();
      const ids = manifest.contributes.commands.map(({ id }) => id);
      for (const id of ids) expect(host.commands.has(id), id).toBe(true);
      for (const { command } of manifest.contributes.keybindings) expect(ids).toContain(command);
      for (const item of manifest.contributes.statusBarItems) expect(ids).toContain(item.command);
      expect(manifest.contributes.statusBarItems[0].id).toBe(QUOTA_ITEM);
      await instance.stop();
    });

    it("imports through the shipped manifest main in a clean Node process", async () => {
      const manifest = JSON.parse(await readFile(path.join(ROOT, "orca-plugin.json"), "utf8"));
      const { execFile } = await import("node:child_process");
      const script = `const m = await import(process.argv[1]);
        console.log(JSON.stringify([typeof m.default, typeof m.deactivate, typeof m.summarizeQuota,
          m.summarizeQuota({ accounts: [{ short: "A", windows: [{ remainingPct: 5 }] }] }).text]));`;
      const stdout = await new Promise((resolve, reject) => {
        execFile(
          process.execPath,
          ["--input-type=module", "-e", script, path.join(ROOT, manifest.main)],
          { cwd: home, env: { PATH: process.env.PATH, HOME: home } },
          (error, out) => (error ? reject(error) : resolve(out)),
        );
      });
      expect(JSON.parse(stdout)).toEqual(["function", "function", "function", "A 5%"]);
    });

    it("forwards the worker's summarizeQuota to Monitor's own summary", () => {
      const snapshot = JSON.parse(SNAPSHOT(CLAUDE_ACCOUNTS));
      expect(summarizeQuota(snapshot)).toEqual(monitorSummarizeQuota(snapshot));
      expect(summarizeQuota(snapshot).text).toBe("CW 31% · CP 57%");
    });
  });

  describe("sidebar panel handlers", () => {
    it("reports the active workspace's rooms and workers, and opens the Swarm View", async () => {
      const host = mockOrca();
      const instance = worker(host, {
        listRooms: async () => [
          ROOM,
          { id: "room-elsewhere", orcaWorkspaceId: "ws2" },
          { id: "room-done", orcaWorkspaceId: "ws1", status: "completed" },
        ],
      });
      await instance.start();
      const status = await host.request("swarm.status");
      expect(status).toMatchObject({
        schema: "orkest.orca-panel-status.v1",
        workspaceId: "ws1",
        rooms: [{ id: "room-a", selected: true, open: false }],
        view: { open: false, chief: false, room: "" },
      });
      expect(status.workers).toEqual([
        { terminalId: "term_coord", title: "term_coord", agent: "claude", state: "working" },
      ]);

      expect(await host.request("swarm.action", { action: "open", room: "room-a" })).toMatchObject({
        status: "opened",
        room: "room-a",
        message: "Swarm View opened (room room-a).",
      });
      expect((await host.request("swarm.status")).view).toMatchObject({
        open: true,
        room: "room-a",
      });
      expect((await host.request("swarm.status")).rooms[0].open).toBe(true);
      expect(await host.request("swarm.action", { action: "toggle" })).toMatchObject({
        status: "closed",
      });
      await instance.stop();
    });

    it("accepts only enumerated actions and rooms of the active workspace", async () => {
      const host = mockOrca();
      const instance = worker(host, {
        listRooms: async () => [ROOM, { id: "room-elsewhere", orcaWorkspaceId: "ws2" }],
      });
      await instance.start();
      for (const input of [
        undefined,
        null,
        "open",
        [],
        {},
        { action: "rm -rf" },
        { action: "open", extra: true },
        { action: "open", room: 5 },
        { action: "open", room: "x".repeat(300) },
        { action: "__proto__" },
      ]) {
        await expect(
          host.request("swarm.action", input),
          JSON.stringify(input),
        ).rejects.toMatchObject({
          code: "invalid_params",
        });
      }
      await expect(host.request("swarm.status", "nope")).rejects.toMatchObject({
        code: "invalid_params",
      });
      expect(
        await host.request("swarm.action", { action: "open", room: "room-elsewhere" }),
      ).toMatchObject({
        status: "unavailable",
      });
      expect(host.methods()).not.toContain("terminal.create");
      expect(parsePanelAction({ action: "chief" })).toEqual({ action: "chief", room: "" });
      expect(PANEL_ACTIONS).toEqual(["toggle", "open", "close", "chief"]);
      await instance.stop();
    });

    it("opens Chief through the same path from the command and the panel", async () => {
      const host = mockOrca();
      const instance = worker(host, { listRooms: async () => [] });
      await instance.start();
      expect(await host.commands.get("orkest.chief.open")()).toBe("Swarm View opened.");
      const create = host.state.calls.find(({ method }) => method === "terminal.create");
      expect(create.params.command).toContain("ORKEST_CHIEF_VIEW=1");
      expect(create.params.command).toContain("horde --view --chief");
      expect(await readJsonState(orcaViewPath("__chief__", env))).toMatchObject({ chief: true });
      expect(await host.commands.get("orkest.chief.open")()).toBe("Swarm View is already open.");
      expect(await host.request("swarm.action", { action: "chief" })).toMatchObject({
        status: "already_open",
      });
      await instance.stop();
    });

    it("pushes one coalesced status per change and skips an unchanged one", async () => {
      const host = mockOrca();
      const instance = worker(host);
      await instance.start();
      const event = { workspaceId: "ws1", paneKey: "p", terminalId: "term_w", state: "blocked" };
      await host.emit("agent.status.changed", { ...event, title: "Worker" });
      await host.emit("agent.status.changed", { ...event, title: "Worker" });
      expect(timeouts).toHaveLength(1);
      expect(timeouts[0].delay).toBe(500);
      timeouts[0].callback();
      await expect.poll(() => host.state.posts.length).toBe(1);
      const [{ event: name, payload }] = host.state.posts;
      expect(name).toBe("status.changed");
      expect(payload.workers).toContainEqual({
        terminalId: "term_w",
        title: "Worker",
        agent: "",
        state: "blocked",
      });
      await host.emit("agent.status.changed", { ...event, title: "Worker" });
      timeouts[1].callback();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(host.state.posts).toHaveLength(1);
      await instance.stop();
    });

    it("still works on a host without the panels API", async () => {
      const host = mockOrca({ panels: false });
      const instance = worker(host);
      await instance.start();
      expect(host.panelHandlers.size).toBe(0);
      expect(await host.commands.get("orkest.swarm.open")()).toContain("opened");
      await host.emit("agent.status.changed", {
        workspaceId: "ws1",
        terminalId: "t",
        state: "done",
      });
      expect(timeouts).toHaveLength(0);
      await instance.stop();
    });
  });

  describe("panel page", () => {
    async function mountPanel(statusPayload, bridge) {
      const html = await readFile(
        path.join(ROOT, "src/lib/orca-panel.html"),
        "utf8",
      );
      const script = /<script>([\s\S]*)<\/script>/u.exec(html)[1];
      class Element {
        constructor(tag) {
          this.tag = tag;
          this.children = [];
          this.dataset = {};
          this.listeners = {};
          this.value = "";
          this.disabled = false;
          this.className = "";
          this.own = "";
        }
        set textContent(value) {
          this.own = String(value);
          this.children = [];
        }
        get firstElementChild() {
          return this.children.at(0);
        }
        get textContent() {
          return this.own + this.children.map((child) => child.textContent).join("");
        }
        append(...nodes) {
          this.children.push(...nodes);
        }
        replaceChildren(...nodes) {
          this.children = nodes;
        }
        addEventListener(type, handler) {
          this.listeners[type] = handler;
        }
      }
      const byId = new Map();
      const buttons = ["open", "toggle", "close", "chief"].map((action) => {
        const button = new Element("button");
        button.dataset.action = action;
        return button;
      });
      const document = {
        getElementById: (id) => {
          if (!byId.has(id)) byId.set(id, new Element("div"));
          return byId.get(id);
        },
        createElement: (tag) => new Element(tag),
        querySelectorAll: () => buttons,
      };
      const requests = [];
      const subscriptions = {};
      const orca = {
        plugin: bridge ?? {
          request: async (name, input) => {
            requests.push({ name, input });
            return name === "swarm.status" ? statusPayload : { message: "Done <b>x</b>" };
          },
          on: (event, handler) => {
            subscriptions[event] = handler;
          },
        },
      };
      vm.runInNewContext(script, { document, orca });
      await new Promise((resolve) => setTimeout(resolve, 0));
      return { byId, buttons, requests, subscriptions };
    }

    const goodStatus = (overrides = {}) => ({
      schema: "orkest.orca-panel-status.v1",
      workspaceId: "ws1",
      workspaceName: "repo",
      rooms: [
        {
          id: "room-a",
          label: "<img src=x onerror=alert(1)>",
          status: "active",
          selected: true,
          open: false,
        },
      ],
      workers: [{ terminalId: "t1", title: "<b>w</b>", agent: "claude", state: "working" }],
      view: { open: false, chief: false, room: "" },
      quota: { text: "CW 31%", tone: "warning" },
      ...overrides,
    });

    it("keeps the newer workspace when a delayed request arrives after a change event", async () => {
      const pending = Promise.withResolvers();
      let push;
      const page = await mountPanel(null, {
        request: () => pending.promise,
        on: (_event, handler) => {
          push = handler;
        },
      });
      push(goodStatus({ workspaceId: "B", workspaceName: "second" }));
      pending.resolve(goodStatus({ workspaceId: "A", workspaceName: "first" }));
      await pending.promise;
      expect(page.byId.get("workspace").textContent).toBe("second");
    });

    it("drives the real worker through a bridge shaped like Orca's frame facade", async () => {
      // Orca's frame shell (plugin-panel-shell-facades.ts) resolves `plugin.request` with the
      // handler's JSON output, rejects with the handler's error code, and delivers `panels.post`
      // payloads to `plugin.on` listeners. Inline scripts are allowed by the frame CSP.
      const host = mockOrca();
      const instance = worker(host, { listRooms: async () => [ROOM] });
      await instance.start();
      const listeners = new Map();
      // eslint-disable-next-line unicorn/prefer-structured-clone -- the host transport carries JSON only
      const wire = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
      host.orca.panels.post = (event, payload) => {
        const subscribed = listeners.get(event) ?? [];
        for (const listener of subscribed) listener(wire(payload));
      };
      const requests = [];
      const bridge = {
        request: async (name, input) => {
          requests.push({ name, input });
          try {
            return wire(await host.request(name, wire(input)));
          } catch (error) {
            throw Object.assign(new Error(error.message), { code: error.code });
          }
        },
        on: (event, listener) => {
          listeners.set(event, [...(listeners.get(event) ?? []), listener]);
          return { dispose() {} };
        },
      };
      const page = await mountPanel(null, bridge);
      await vi.waitFor(() => expect(page.byId.get("workspace")?.textContent).toBe("repo"));
      expect(page.byId.get("rooms").firstElementChild.firstElementChild.textContent).toBe("room-a");
      expect(page.byId.get("workers").firstElementChild.firstElementChild.textContent).toBe(
        "term_coord (claude)",
      );

      page.buttons[0].listeners.click();
      await vi.waitFor(() =>
        expect(page.byId.get("workspace").textContent).toBe("repo · Swarm View open"),
      );
      expect(page.byId.get("message").textContent).toBe("Swarm View opened (room room-a).");
      expect(host.state.terminals).toContain("term_new1");

      // A worker push reaches the panel's listener and updates the list.
      await host.emit("agent.status.changed", {
        workspaceId: "ws1",
        paneKey: "p",
        terminalId: "term_w",
        title: "Pushed",
        state: "blocked",
      });
      timeouts.at(-1).callback();
      await vi.waitFor(() => {
        const rows = page.byId.get("workers").children.map((row) => row.textContent);
        expect(rows.some((text) => text.startsWith("Pushed"))).toBe(true);
      });

      page.buttons[2].listeners.click();
      await vi.waitFor(() =>
        expect(page.byId.get("message").textContent).toBe("Swarm View closed (room room-a)."),
      );
      await vi.waitFor(() => expect(page.buttons[3].disabled).toBe(false));
      page.buttons[3].listeners.click();
      await vi.waitFor(() =>
        expect(requests.findLast(({ name }) => name === "swarm.action").input).toEqual({
          action: "chief",
        }),
      );
      await vi.waitFor(() =>
        expect(host.state.calls.some(({ params }) => params?.command?.includes("--chief"))).toBe(
          true,
        ),
      );
      await instance.stop();
    });

    it("renders labels as text and never builds markup", async () => {
      const html = await readFile(
        path.join(ROOT, "src/lib/orca-panel.html"),
        "utf8",
      );
      expect(html).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/u);
      const page = await mountPanel(goodStatus());
      expect(page.byId.get("rooms").firstElementChild.firstElementChild.textContent).toBe(
        "<img src=x onerror=alert(1)>",
      );
      expect(page.byId.get("workers").firstElementChild.firstElementChild.textContent).toBe(
        "<b>w</b> (claude)",
      );
      expect(page.byId.get("quota").textContent).toBe("CW 31%");
      expect(page.buttons.every((button) => !button.disabled)).toBe(true);
    });

    it("sends only enumerated actions with a room from the validated status", async () => {
      const page = await mountPanel(goodStatus());
      page.byId.get("room").value = "room-a";
      page.buttons[0].listeners.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(page.requests).toContainEqual({
        name: "swarm.action",
        input: { action: "open", room: "room-a" },
      });
      expect(page.byId.get("message").textContent).toBe("Done <b>x</b>");

      const before = page.requests.length;
      page.buttons[1].dataset.action = "rm -rf";
      page.buttons[1].listeners.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(page.requests).toHaveLength(before);

      page.buttons[3].listeners.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(page.requests.findLast(({ name }) => name === "swarm.action").input).toEqual({
        action: "chief",
      });
    });

    it("ignores malformed worker messages and keeps the last valid status", async () => {
      const page = await mountPanel(goodStatus());
      for (const bad of [
        null,
        { schema: "other" },
        goodStatus({ workers: [{ terminalId: "t", title: "x", agent: "", state: "exploding" }] }),
        goodStatus({ rooms: [{ id: "", label: "x", status: "a", selected: true, open: false }] }),
        goodStatus({ quota: { text: "x", tone: "rainbow" } }),
      ]) {
        page.subscriptions["status.changed"](bad);
        expect(page.byId.get("message").textContent).toContain("malformed");
        expect(page.byId.get("quota").textContent).toBe("CW 31%");
      }
      page.subscriptions["status.changed"](
        goodStatus({ quota: { text: "CW 9%", tone: "danger" } }),
      );
      expect(page.byId.get("quota").textContent).toBe("CW 9%");
    });
  });

  describe("PATH enrichment", () => {
    it("keeps explicit entries and appends the usual install directories once", () => {
      const explicit = ["/opt/a", "/usr/local/bin", "/opt/b"].join(path.delimiter);
      const env = { HOME: "/home/u", PATH: explicit };
      expect(enrichedPath(env).split(path.delimiter)).toEqual([
        "/opt/a",
        "/usr/local/bin",
        "/opt/b",
        "/home/u/.local/bin",
        "/opt/homebrew/bin",
      ]);
      expect(env.PATH).toBe(explicit);
      expect(enrichedPath({ HOME: "/h", PATH: "" }).split(path.delimiter)).toEqual([
        "/h/.local/bin",
        "/opt/homebrew/bin",
        "/usr/local/bin",
      ]);
      expect(enrichedPath({ HOME: "/h", PATH: "/h/.local/bin" })).toBe(
        ["/h/.local/bin", "/opt/homebrew/bin", "/usr/local/bin"].join(path.delimiter),
      );
    });

    it("finds binaries a reduced PATH misses, leaves process.env alone and never picks the screen reader", async () => {
      const bin = path.join(home, ".local/bin");
      await mkdir(bin, { recursive: true });
      for (const name of ["orca-ide", "node", "fake-orca"]) {
        await writeFile(path.join(bin, name), "#!/bin/sh\n");
        await chmod(path.join(bin, name), 0o755);
      }
      const before = process.env.PATH;
      expect(findExecutable("node", env)).toBe(path.join(bin, "node"));
      expect(resolveOrcaCli(env, { platform: "linux" })).toBe(path.join(bin, "orca-ide"));
      expect(resolveOrcaCli({ ...env, ORCA_CLI_COMMAND: "fake-orca" }, { platform: "linux" })).toBe(
        path.join(bin, "fake-orca"),
      );
      const explicit = path.join(bin, "fake-orca");
      expect(resolveOrcaCli({ ...env, ORCA_CLI_COMMAND: explicit }, { platform: "linux" })).toBe(
        explicit,
      );
      expect(
        resolveOrcaCli({ ...env, ORCA_CLI_COMMAND: "/usr/bin/orca" }, { platform: "linux" }),
      ).toBe(null);
      expect(process.env.PATH).toBe(before);
    });

    it("looks up the CLI and node on the enriched PATH and spawns children with it", async () => {
      const bin = path.join(home, ".local/bin");
      await mkdir(bin, { recursive: true });
      for (const name of ["orca-ide", "node"]) {
        await writeFile(path.join(bin, name), "#!/bin/sh\n");
        await chmod(path.join(bin, name), 0o755);
      }
      const spawned = [];
      const exec = (command, args, options, callback) => {
        spawned.push({ command, args, env: options.env });
        queueMicrotask(() =>
          callback(
            null,
            args[0] === "terminal" && args[1] === "split"
              ? JSON.stringify({ result: { split: { handle: "term_split" } } })
              : SNAPSHOT(CLAUDE_ACCOUNTS),
          ),
        );
      };
      const host = mockOrca();
      const before = process.env.PATH;
      // No cli or node option: both come from lookup under the reduced PATH.
      const instance = createOrcaWorker(host.orca, {
        env,
        platform: "linux",
        exec,
        listRooms: async () => [ROOM],
        setInterval: () => ({ unref() {} }),
        clearInterval() {},
        setTimeout: () => ({ unref() {} }),
        clearTimeout() {},
      });
      await instance.start();
      await host.commands.get("orkest.swarm.open")();
      await expect.poll(() => host.state.status.length).toBe(1);
      const split = spawned.find(({ args }) => args[1] === "split");
      expect(split.command).toBe(path.join(bin, "orca-ide"));
      const monitor = spawned.find(({ args }) => args.at(-1) === "json");
      expect(monitor.command).toBe(path.join(bin, "node"));
      for (const { env: childEnv } of spawned) {
        expect(childEnv.PATH).toBe(enrichedPath(env));
        expect(childEnv.HOME).toBe(home);
      }
      expect(env.PATH).toBe(path.join(home, "no-bin"));
      expect(process.env.PATH).toBe(before);
      await instance.stop();
    });
  });

  describe("rooms reads", () => {
    it("coalesces concurrent reads per workspace and reads afresh once they settle", async () => {
      const host = mockOrca();
      let reads = 0;
      const { promise: gate, resolve: release } = Promise.withResolvers();
      const instance = worker(host, {
        listRooms: async () => {
          reads += 1;
          await gate;
          return [ROOM];
        },
      });
      await instance.start();
      const statuses = [
        host.request("swarm.status"),
        host.request("swarm.status"),
        host.request("swarm.status"),
      ];
      await vi.waitFor(() => expect(reads).toBe(1));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(reads).toBe(1);
      release();
      expect((await Promise.all(statuses)).every(({ rooms }) => rooms.length === 1)).toBe(true);
      expect(reads).toBe(1);
      // Nothing is cached once the reads settle: the next request reads again.
      await host.request("swarm.status");
      expect(reads).toBe(2);
      await instance.stop();
    });

    it("discards a read that finishes after the workspace changed and reads again", async () => {
      const host = mockOrca();
      const held = [];
      let reads = 0;
      const instance = worker(host, {
        listRooms: () => {
          reads += 1;
          return new Promise((resolve) => {
            held.push(() => resolve([ROOM]));
          });
        },
      });
      await instance.start();
      const pending = expect(host.request("swarm.status")).rejects.toMatchObject({
        code: "workspace_changed",
      });
      await vi.waitFor(() => expect(held).toHaveLength(1));
      host.state.workspaceId = "ws2";
      await host.emit("workspace.changed", {
        context: { workspaceId: "ws2", branch: "b", displayName: "other", terminals: [] },
      });
      held[0]();
      // The stale answer is dropped and a second read is made for the new generation.
      await vi.waitFor(() => expect(held).toHaveLength(2));
      held[1]();
      await pending;
      expect(reads).toBe(2);
      await instance.stop();
    });

    it("clears a failed read so the next request tries again", async () => {
      const host = mockOrca();
      let isFail = true;
      const instance = worker(host, {
        listRooms: async () => {
          if (isFail) throw new Error("store busy");
          return [ROOM];
        },
      });
      await instance.start();
      expect((await host.request("swarm.status")).error).toBe("Orkest could not list rooms.");
      isFail = false;
      expect((await host.request("swarm.status")).rooms).toHaveLength(1);
      await instance.stop();
    });
  });

  describe("quota item", () => {
    function monitorExec(script) {
      const runs = [];
      const exec = (command, args, options, callback) => {
        runs.push(args);
        const step = script[Math.min(runs.length, script.length) - 1];
        setTimeout(
          () => (step instanceof Error ? callback(step) : callback(null, step)),
          step?.delay ?? 0,
        );
      };
      return { exec, runs };
    }

    it("shows distinct account labels, joins concurrent refreshes and clears its promise afterwards", async () => {
      const host = mockOrca();
      const { exec, runs } = monitorExec([
        SNAPSHOT(CLAUDE_ACCOUNTS),
        new Error("boom"),
        SNAPSHOT(CLAUDE_ACCOUNTS),
      ]);
      const instance = worker(host, { node: "/usr/bin/node", exec });
      await instance.start();
      await expect.poll(() => host.state.status.length).toBe(1);
      const first = host.state.status[0];
      expect(first.text).toBe("CW 31% · CP 57%");
      expect(first.tooltip).toContain("Claude Personal (claude)");
      expect(first.tooltip).toContain("Claude Work (claude)");

      const joined = await Promise.all([
        instance.refreshQuota(),
        instance.refreshQuota(),
        instance.refreshQuota(),
      ]);
      // One failed run answers all three callers.
      expect(runs).toHaveLength(2);
      expect(new Set(joined.map(({ text }) => text)).size).toBe(1);

      const failed = host.state.status.at(-1);
      expect(failed.text).toBe("CW 31%! · CP 57%! · stale");
      expect((await host.request("swarm.status")).quota).toEqual({
        text: failed.text,
        tone: "warning",
      });
      expect(failed.tone).toBe("warning");
      expect(failed.tooltip).toContain("monitor json failed: boom");
      expect(failed.tooltip).toContain("Claude Personal (claude)");
      expect(failed.tooltip).toContain("Last good values");

      // The failed promise is gone: the next refresh runs again and recovers.
      expect((await instance.refreshQuota()).text).toBe("CW 31% · CP 57%");
      expect(runs).toHaveLength(3);
      await instance.stop();
    });

    it("publishes stale zero to both panel paths after a refresh fails", async () => {
      const host = mockOrca();
      const account = { ...CLAUDE_ACCOUNTS[0], windows: [{ label: "weekly", remainingPct: 0 }] };
      const { exec } = monitorExec([SNAPSHOT([account]), new Error("offline")]);
      const instance = worker(host, { node: "/usr/bin/node", exec });
      await instance.start();
      await expect.poll(() => host.state.status.length).toBe(1);
      expect(host.state.status[0].text).toContain("☠");
      await instance.refreshQuota();
      const expected = { text: "CP 0%! · stale", tone: "warning" };
      expect((await host.request("swarm.status")).quota).toEqual(expected);
      timeouts.at(-1).callback();
      await expect.poll(() => host.state.posts.at(-1)?.payload.quota).toEqual(expected);
      await instance.stop();
    });

    it("says so when there is no last good value to keep", async () => {
      const host = mockOrca();
      const { exec } = monitorExec([new Error("down")]);
      const instance = worker(host, { node: "/usr/bin/node", exec });
      await instance.start();
      await expect.poll(() => host.state.status.length).toBe(1);
      expect(host.state.status[0]).toMatchObject({ text: "Quota ?", tone: "warning" });
      await instance.stop();
    });

    it("does not update the item after stop and works without statusBar.update", async () => {
      const host = mockOrca({ without: ["statusBar.update"] });
      const { exec } = monitorExec([SNAPSHOT(CLAUDE_ACCOUNTS)]);
      const instance = worker(host, { node: "/usr/bin/node", exec });
      await instance.start();
      const summary = await instance.refreshQuota();
      expect(summary.text).toBe("CW 31% · CP 57%");
      expect(host.methods()).not.toContain("statusBar.update");
      await instance.stop();

      const late = mockOrca();
      let finish;
      const slow = worker(late, {
        node: "/usr/bin/node",
        exec: (_command, _args, _options, callback) => {
          finish = () => callback(null, SNAPSHOT(CLAUDE_ACCOUNTS));
        },
      });
      await slow.start();
      await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
      const stopping = slow.stop();
      finish();
      await stopping;
      expect(late.state.status).toEqual([]);
    });
  });

  describe("persisted views after a cold restart", () => {
    const bound = (id, extra = {}) => ({ id, orcaWorkspaceId: "ws1", ...extra });

    it("closes the record of a room confirmed archived or gone, and never reopens it", async () => {
      await writeView("room-archived", { terminalId: "term_old" });
      await writeView("room-gone", { terminalId: "term_old2" });
      await writeView("room-live", { terminalId: "term_old3" });
      const host = mockOrca();
      const instance = worker(host, {
        listRooms: async () => [
          bound("room-archived", { lifecycle: "archived" }),
          bound("room-live"),
        ],
      });
      const outcomes = await instance.start();
      expect(outcomes).toEqual(
        expect.arrayContaining([
          { room: "room-archived", status: "room_archived" },
          { room: "room-gone", status: "room_missing" },
          { room: "room-live", status: "restored" },
        ]),
      );
      expect(host.state.calls.filter(({ method }) => method === "terminal.create")).toHaveLength(1);
      expect(await readOrcaView("room-archived", env)).toMatchObject({
        closed: true,
        closedReason: "room_archived",
      });
      expect(await readOrcaView("room-gone", env)).toMatchObject({ closed: true });
      expect((await readOrcaView("room-live", env)).closed).toBe(false);
      await instance.stop();
    });

    it("keeps the record when the room lookup fails and restores once it works", async () => {
      await writeView("room-a", { terminalId: "term_old" });
      let isDown = true;
      const host = mockOrca();
      const instance = worker(host, {
        listRooms: async () => {
          if (isDown) throw new Error("store locked");
          return [bound("room-a")];
        },
      });
      expect(await instance.start()).toEqual([{ room: "room-a", status: "room_lookup_failed" }]);
      expect(host.methods()).not.toContain("terminal.create");
      expect((await readOrcaView("room-a", env)).closed).toBeFalsy();
      isDown = false;
      expect(await instance.restore()).toEqual([{ room: "room-a", status: "restored" }]);
      expect((await readOrcaView("room-a", env)).terminalId).toBe("term_new1");
      await instance.stop();
    });

    it("treats malformed room-store output as a failed lookup and restores on a valid retry", async () => {
      await writeView("room-a", { terminalId: "term_old" });
      const outputs = ["{}", "null", "not json", JSON.stringify([bound("room-a")])];
      const listed = [];
      const exec = (command, args, options, callback) => {
        listed.push(args);
        queueMicrotask(() => callback(null, outputs.shift()));
      };
      const host = mockOrca();
      const instance = worker(host, { listRooms: undefined, node: "/usr/bin/node", exec });
      for (const attempt of [1, 2, 3]) {
        const [outcome] = await instance.restore();
        expect(outcome).toEqual({ room: "room-a", status: "room_lookup_failed" });
        expect(listed).toHaveLength(attempt);
        expect((await readOrcaView("room-a", env)).closed).toBeFalsy();
      }
      expect(host.methods()).not.toContain("terminal.create");
      expect(await instance.restore()).toEqual([{ room: "room-a", status: "restored" }]);
      expect(listed[0].slice(1, 2)).toEqual(["list"]);
      await instance.stop();
    });

    it("does not restore a room that belongs to another workspace", async () => {
      await writeView("room-a", { terminalId: "term_old" });
      const host = mockOrca();
      const instance = worker(host, {
        listRooms: async () => [{ id: "room-a", orcaWorkspaceId: "ws9" }],
      });
      expect(await instance.start()).toEqual([{ room: "room-a", status: "workspace_mismatch" }]);
      expect(host.methods()).not.toContain("terminal.create");
      expect((await readOrcaView("room-a", env)).closed).toBeFalsy();
      await instance.stop();
    });

    it("reports an unreadable workspace as a failed inspection, not as a closed view", async () => {
      await writeView("room-a", { workspaceId: "ws-unknown", terminalId: "term_old" });
      const host = mockOrca();
      const instance = worker(host, { listRooms: async () => [bound("room-a")] });
      expect(await instance.start()).toEqual([{ room: "room-a", status: "inspection_failed" }]);
      expect((await readOrcaView("room-a", env)).closed).toBeFalsy();
      await instance.stop();
    });

    it("selects eligible rooms by workspace only", () => {
      const rooms = [
        bound("a"),
        { id: "b", orcaWorkspaceId: "ws2" },
        bound("c", { status: "closed" }),
      ];
      expect(
        eligibleRooms(rooms, { workspaceId: "ws1", terminals: [] }).map(({ id }) => id),
      ).toEqual(["a"]);
    });
  });

  describe("races", () => {
    it("a close requested during a pending open wins", async () => {
      const { promise: gate, resolve: release } = Promise.withResolvers();
      let host;
      host = mockOrca({
        extra: {
          "terminal.create": async () => {
            await gate;
            host.state.terminals.push("term_new1");
            return { terminalId: "term_new1" };
          },
        },
      });
      const instance = worker(host);
      await instance.start();
      const opening = host.commands.get("orkest.swarm.open")();
      await vi.waitFor(() => expect(host.methods()).toContain("terminal.create"));
      const closing = host.commands.get("orkest.swarm.close")();
      release();
      expect(await opening).toBe("Swarm View closed (room room-a).");
      expect(await closing).toBe("Swarm View is already closed (room room-a).");
      expect(host.state.terminals).toEqual(["term_coord"]);
      expect(await readOrcaView("room-a", env)).toMatchObject({ closed: true });
      // A fresh open afterwards is not cancelled by the old close.
      expect(await host.commands.get("orkest.swarm.open")()).toBe(
        "Swarm View opened (room room-a).",
      );
      await instance.stop();
    });

    it("the panel's close wins over a pending open too", async () => {
      const { promise: gate, resolve: release } = Promise.withResolvers();
      let host;
      host = mockOrca({
        extra: {
          "terminal.create": async () => {
            await gate;
            host.state.terminals.push("term_new1");
            return { terminalId: "term_new1" };
          },
        },
      });
      const instance = worker(host);
      await instance.start();
      const opening = host.request("swarm.action", { action: "open" });
      await vi.waitFor(() => expect(host.methods()).toContain("terminal.create"));
      const closing = host.request("swarm.action", { action: "toggle" });
      release();
      expect((await opening).status).toBe("closed");
      expect((await closing).status).toBe("closed");
      expect(host.state.terminals).toEqual(["term_coord"]);
      await instance.stop();
    });
  });

  describe("missing host methods", () => {
    it("reports plainly when this Orca can neither split nor create a terminal", async () => {
      const host = mockOrca({ without: ["terminal.create"] });
      const instance = worker(host);
      await instance.start();
      expect(await host.commands.get("orkest.swarm.open")()).toContain("cannot open a terminal");
      expect(host.methods()).not.toContain("terminal.create");
      await instance.stop();
    });

    it("closes through the CLI when the host has no terminal.close", async () => {
      const host = mockOrca({ without: ["terminal.close"] });
      const closes = [];
      const exec = (command, args, options, callback) => {
        closes.push(args);
        queueMicrotask(() => callback(null, "{}"));
      };
      const instance = worker(host, { cli: "/opt/orca/orca-ide", exec });
      await instance.start();
      // No terminal.split either, so the CLI splits; hand it a handle.
      const splitting = host.commands.get("orkest.swarm.open")();
      expect(await splitting).toContain("Orca split the pane without naming");
      await instance.stop();
      const calls = closes.map((args) => args.slice(0, 2).join(" "));
      expect(calls).toContain("terminal split");
    });

    it("closes an open view through the CLI when terminal.close is missing", async () => {
      const host = mockOrca({ without: ["terminal.close"] });
      const seen = [];
      const exec = (command, args, options, callback) => {
        seen.push(args);
        queueMicrotask(() =>
          callback(null, JSON.stringify({ result: { split: { handle: "term_split" } } })),
        );
      };
      const instance = worker(host, { cli: "/opt/orca/orca-ide", exec });
      await instance.start();
      expect(await host.commands.get("orkest.swarm.open")()).toContain("opened");
      host.state.terminals.push("term_split");
      expect(await host.commands.get("orkest.swarm.close")()).toBe(
        "Swarm View closed (room room-a).",
      );
      expect(seen.some((args) => args[0] === "terminal" && args[1] === "close")).toBe(true);
      expect(host.methods()).not.toContain("terminal.close");
      await instance.stop();
    });

    it("works on a host that exposes no has() and without agents.list or terminal.list", async () => {
      const host = mockOrca({ without: ["agents.list", "terminal.list"] });
      delete host.orca.host.has;
      const instance = worker(host);
      await instance.start();
      expect(await host.commands.get("orkest.swarm.open")()).toContain("opened");
      const lean = mockOrca({ without: ["agents.list", "terminal.list"] });
      const second = worker(lean);
      await second.start();
      expect(lean.methods()).not.toContain("agents.list");
      expect(lean.methods()).not.toContain("terminal.list");
      expect(await lean.commands.get("orkest.swarm.open")()).toMatch(/open/u);
      await instance.stop();
      await second.stop();
    });
  });
});
