import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  isScreenReaderOrca,
  orcaPaneContext,
  orcaTerminalsPath,
  orcaViewPath,
  readOrcaView,
  resolveOrcaCli,
} from "../../../plugins/orchestrate/lib/orca-context.mjs";
import activate, {
  createOrcaWorker,
  deactivate,
  matchRoom,
  QUOTA_INTERVAL_MS,
  QUOTA_ITEM,
  REPO_ROOT,
  summarizeQuota,
  swarmViewCommand,
} from "../../../plugins/orchestrate/lib/orca-worker.mjs";
import { checkOrcaManifest } from "../../../scripts/validate-marketplace.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SCREEN_READER = "/usr/bin/orca";

function hostError(code, message = code) {
  return Object.assign(new Error(message), { code });
}

/** A stand-in Orca host: records calls and answers from a small mutable workspace model. */
function mockOrca({ terminals = ["term_coord"], workspaceId = "ws1", extra = {} } = {}) {
  const state = { workspaceId, terminals: [...terminals], next: 1, calls: [], status: [] };
  const handlers = new Map();
  const commands = new Map();
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
    expect(manifest.main).toBe("plugins/orchestrate/lib/orca-worker.mjs");
    expect(REPO_ROOT).toBe(ROOT);
    expect(typeof activate).toBe("function");
    expect(typeof deactivate).toBe("function");
    expect(manifest.contributes.statusBarItems.map(({ id }) => id)).toEqual([QUOTA_ITEM]);
    expect(checkOrcaManifest(ROOT)).toEqual([]);

    const host = mockOrca();
    const instance = worker(host);
    await instance.start();
    const sorted = (values) => values.toSorted((left, right) => left.localeCompare(right));
    expect(sorted(host.commands.keys().toArray())).toEqual(
      sorted(manifest.contributes.commands.map(({ id }) => id)),
    );
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
      await activate(host.orca);
      expect(host.commands.has("orkest.swarm.toggle")).toBe(true);
      // No node on PATH: the quota item says so instead of throwing.
      await expect.poll(() => host.state.status.at(-1)?.text).toBe("Quota ?");
      await deactivate();
    } finally {
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
      expect(options.env).toBe(env);
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
    await write("room-closed", { terminalId: "term_old2", closed: true });
    await write("room-present", { terminalId: "term_live" });
    const host = mockOrca({ terminals: ["term_coord", "term_live"] });
    const instance = worker(host);
    await instance.start();
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
    expect(runs[0]).toEqual([path.join(ROOT, "plugins/monitor/bin/monitor.mjs"), "json"]);
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
});
