import { spawn, spawnSync } from "node:child_process";
import fs, { readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { chiefCommand, renderChiefStatus } from "../../../plugins/orchestrate/bin/chief.mjs";
import {
  bindChief,
  chiefClose,
  chiefDesk,
  chiefInbox,
  chiefPath,
  chiefReconcile,
  chiefSend,
  chiefSpawn,
  chiefStatus,
  installCompletionHook,
  isWithinPath,
  listDesk,
  missionBrief,
  planCompletionHook,
  readChiefBinding,
  readPeers,
  resolveChiefTarget,
  sessionKey,
} from "../../../plugins/orchestrate/lib/chief.mjs";
import {
  listRawRooms,
  readRawRoom,
  updateRawRoom,
} from "../../../plugins/orchestrate/lib/horde-room.mjs";
import { displayWidth } from "../../../plugins/orchestrate/lib/tui-box.mjs";

const NOW = Date.now();
const deadPid = () => spawnSync("true").pid;

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function makeRepo(parent, name) {
  const repo = path.join(parent, name);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "chief@example.test");
  git(repo, "config", "user.name", "Chief Test");
  fs.writeFileSync(path.join(repo, "README.md"), `# ${name}\n`);
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  return fs.realpathSync(repo);
}

function writePeer(root, peer) {
  const record = {
    schema: "agent-executor.peer.v1",
    harness: "claude",
    pid: process.pid,
    startedAt: new Date(NOW - 60_000).toISOString(),
    lastSeenAt: new Date(NOW).toISOString(),
    state: "idle",
    ...peer,
  };
  fs.mkdirSync(path.join(root, "peers"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "peers", `${sessionKey(record.session)}.json`),
    JSON.stringify(record),
  );
  return record;
}

function writeInbox(root, session, message) {
  const directory = path.join(root, "inbox", sessionKey(session));
  fs.mkdirSync(directory, { recursive: true });
  const id = `m-${Math.random().toString(16).slice(2)}`;
  fs.writeFileSync(
    path.join(directory, `${id}.json`),
    JSON.stringify({ id, readAt: null, sentAt: new Date(NOW).toISOString(), ...message }),
  );
}

function room(id, cwd, extra = {}) {
  return {
    schema: "agent-executor.room.v1",
    id,
    title: id,
    cwd,
    createdAt: NOW - 1000,
    updatedAt: NOW - 1000,
    swarm: { maxAgents: 64, maxDepth: 8 },
    conductor: { engine: "claude", model: "opus", status: "running" },
    agents: [],
    messages: [],
    ...extra,
  };
}

function mailboxMock(status = 0, stdout = '{"id":"m1","wake":{"status":"woken"}}') {
  return vi.fn(() => ({ status, stdout, stderr: status === 0 ? "" : "peer_unavailable" }));
}

function capture() {
  const chunks = [];
  return {
    columns: 120,
    write: (chunk) => {
      chunks.push(chunk);
    },
    text: () => chunks.join(""),
  };
}

describe("ork chief", () => {
  let tmp;
  let root;
  let env;

  beforeEach(() => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ork-chief-test-"));
    tmp = fs.realpathSync(scratch);
    root = path.join(tmp, "mailbox");
    fs.mkdirSync(root, { recursive: true });
    const binDir = path.join(tmp, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    for (const binName of ["claude", "codex", "agy", "opencode"]) {
      const binPath = path.join(binDir, binName);
      fs.writeFileSync(binPath, "#!/bin/sh\nexit 0\n");
      fs.chmodSync(binPath, 0o755);
    }
    env = {
      PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
      HOME: tmp,
      ORCHESTRATE_HOME: path.join(tmp, "cache"),
      ORCHESTRATE_CONFIG: path.join(tmp, "config", "config.json"),
    };
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe("bind", () => {
    it("binds the session atomically from its peer record and sets mailbox focus", async () => {
      writePeer(root, {
        session: "chief-1",
        name: "opus-chief",
        cwd: tmp,
        model: "claude-opus-5-5",
        herdrPaneId: "w1:p2",
      });
      const runMailbox = mailboxMock();
      const result = await bindChief({ root, env, session: "chief-1", runMailbox, now: NOW });
      expect(result.action).toBe("bound");
      const stored = JSON.parse(fs.readFileSync(chiefPath(root), "utf8"));
      expect(stored).toMatchObject({
        schema: "ork.chief.v1",
        session: "chief-1",
        name: "opus-chief",
        engine: "claude",
        model: "claude-opus-5-5",
        pid: process.pid,
        herdrPaneId: "w1:p2",
        previous: null,
      });
      expect(fs.readdirSync(root).filter((file) => file.endsWith(".tmp"))).toEqual([]);
      expect(runMailbox).toHaveBeenCalledWith(
        ["focus", "--session", "chief-1", "--text", expect.stringContaining("Ork Chief")],
        expect.anything(),
      );
      expect(readChiefBinding({ root, now: NOW })).toMatchObject({
        session: "chief-1",
        live: true,
      });
    });

    it("reads the session from the agent environment", async () => {
      const result = await bindChief({
        root,
        env: { ...env, AGENT_MAILBOX_SESSION: "env-session" },
        runMailbox: mailboxMock(),
        now: NOW,
      });
      expect(result.binding.session).toBe("env-session");
      await expect(bindChief({ root, env, runMailbox: mailboxMock() })).rejects.toThrow(
        /--session/u,
      );
    });

    it("expires a binding whose process died without mutating chief.json", async () => {
      writePeer(root, { session: "gone", name: "gone-chief", cwd: tmp, pid: deadPid() });
      await bindChief({ root, env, session: "gone", runMailbox: mailboxMock(), now: NOW });
      const before = fs.readFileSync(chiefPath(root), "utf8");
      expect(readChiefBinding({ root, now: NOW })).toBeNull();
      const stale = readChiefBinding({ root, now: NOW, includeStale: true });
      expect(stale).toMatchObject({ session: "gone", stale: true, live: false });
      expect(stale.staleReason).toMatch(/exited|no longer live/u);
      expect(fs.readFileSync(chiefPath(root), "utf8")).toBe(before);
      const status = await chiefStatus({ root, env, quota: false, listRooms: () => [] });
      expect(status.chief).toBeNull();
      expect(status.staleChief).toMatchObject({ session: "gone" });
    });

    it("hands the desk over last-writer-wins and notifies the displaced live Chief", async () => {
      writePeer(root, { session: "first", name: "first-chief", cwd: tmp });
      writePeer(root, { session: "second", name: "second-chief", cwd: tmp });
      await bindChief({ root, env, session: "first", runMailbox: mailboxMock(), now: NOW });
      const runMailbox = mailboxMock();
      const result = await bindChief({ root, env, session: "second", runMailbox, now: NOW + 5 });
      expect(result.action).toBe("taken");
      expect(result.binding.previous).toMatchObject({ session: "first", name: "first-chief" });
      expect(result.notified).toBe(true);
      const notice = runMailbox.mock.calls.find(([args]) => args[0] === "send")[0];
      expect(notice).toEqual(expect.arrayContaining(["--to", "first", "--no-wake"]));
      expect(runMailbox.mock.calls.map(([args]) => args)).toContainEqual([
        "focus",
        "--session",
        "first",
        "--clear",
        "--only-if",
        expect.stringContaining("Ork Chief"),
      ]);
      const again = await bindChief({ root, env, session: "second", runMailbox, now: NOW + 9 });
      expect(again.action).toBe("refreshed");
    });

    it("clears only for the holder unless forced or stale", async () => {
      writePeer(root, { session: "holder", name: "holder", cwd: tmp });
      await bindChief({ root, env, session: "holder", runMailbox: mailboxMock(), now: NOW });
      await expect(
        bindChief({ root, env, session: "intruder", clear: true, now: NOW }),
      ).rejects.toThrow(/--force/u);
      expect(fs.existsSync(chiefPath(root))).toBe(true);
      const forced = await bindChief({
        root,
        env,
        session: "x",
        clear: true,
        force: true,
        runMailbox: mailboxMock(),
      });
      expect(forced.action).toBe("cleared");
      expect(fs.existsSync(chiefPath(root))).toBe(false);
      expect(
        (await bindChief({ root, env, session: "x", clear: true, runMailbox: mailboxMock() }))
          .action,
      ).toBe("none");

      writePeer(root, { session: "dead", name: "dead", cwd: tmp, pid: deadPid() });
      await bindChief({ root, env, session: "dead", runMailbox: mailboxMock(), now: NOW });
      const clearMailbox = mailboxMock();
      const cleared = await bindChief({
        root,
        env,
        session: "someone",
        clear: true,
        runMailbox: clearMailbox,
        now: NOW,
      });
      expect(cleared.action).toBe("cleared");
      expect(clearMailbox.mock.calls.map(([args]) => args)).toContainEqual([
        "focus",
        "--session",
        "dead",
        "--clear",
        "--only-if",
        expect.stringContaining("Ork Chief"),
      ]);
    });
  });

  describe("status", () => {
    let repoA;
    let repoB;
    let worktreeB;
    let rooms;

    beforeEach(() => {
      repoA = makeRepo(tmp, "alpha");
      repoB = makeRepo(tmp, "beta");
      worktreeB = path.join(repoB, ".worktrees", "fix-login");
      git(repoB, "worktree", "add", "-q", "-b", "fix/login", worktreeB, "HEAD");
      const repoC = makeRepo(tmp, "gamma");
      writePeer(root, { session: "chief-s", name: "the-chief", cwd: tmp });
      writePeer(root, { session: "lead-a", name: "lead-alpha", cwd: repoA, state: "busy" });
      writePeer(root, {
        session: "helper-a",
        name: "helper",
        cwd: repoA,
        parentSession: "lead-a",
        state: "busy",
      });
      writePeer(root, { session: "solo", name: "solo-gamma", cwd: repoC, focus: "fix docs" });
      writePeer(root, { session: "run-123-worker", name: "run worker", cwd: repoC, run: "123" });
      writePeer(root, { session: "ghost", name: "ghost", cwd: repoC, pid: deadPid() });
      rooms = [
        room("room-alpha", repoA, {
          conductor: {
            engine: "claude",
            model: "opus",
            status: "running",
            session: { id: "lead-a", engine: "claude", machine: os.hostname(), cwd: repoA },
          },
          objective: "Ship alpha",
          agents: [
            { id: "w-1", engine: "claude", model: "haiku", status: "running" },
            {
              id: "w-2",
              engine: "claude",
              model: "haiku",
              status: "blocked",
              blocker: "needs key",
            },
            { id: "w-3", engine: "claude", model: "haiku", status: "completed" },
          ],
          messages: [{ from: "w-3", text: "tests green" }],
        }),
        room("room-beta", worktreeB, {
          conductor: {
            engine: "agy",
            model: "flash",
            status: "running",
            session: { id: "lead-b", engine: "agy", machine: os.hostname(), cwd: worktreeB },
          },
          agents: [{ id: "w-1", engine: "agy", model: "flash", status: "running" }],
          chief: {
            parent: { session: "chief-s", name: "the-chief" },
            spawnedAt: NOW,
            goal: "Fix login",
          },
        }),
        room("room-old", repoC, {
          updatedAt: NOW - 3 * 86_400_000,
          conductor: { engine: "codex" },
        }),
      ];
      fs.writeFileSync(
        chiefPath(root),
        JSON.stringify({
          schema: "ork.chief.v1",
          session: "chief-s",
          name: "the-chief",
          machine: os.hostname(),
          pid: process.pid,
          boundAt: new Date(NOW).toISOString(),
        }),
      );
      writeInbox(root, "chief-s", {
        from: { session: "lead-a", name: "lead-alpha" },
        text: "[chief:escalation] need a decision on the schema",
      });
      writeInbox(root, "chief-s", {
        from: { session: "stranger", name: "stranger" },
        text: "hello from elsewhere",
      });
    });

    it("aggregates rooms across repos and worktrees with counts and attention", async () => {
      const quotaReader = vi.fn(async () => [{ id: "claude", short: "C" }]);
      const status = await chiefStatus({
        root,
        env,
        now: NOW,
        listRooms: () => rooms,
        quotaReader,
      });
      expect(status.schema).toBe("ork.chief.status.v1");
      expect(status.chief).toMatchObject({ session: "chief-s", live: true });
      expect(
        status.rooms.map((entry) => entry.id).toSorted((left, right) => left.localeCompare(right)),
      ).toEqual(["room-alpha", "room-beta"]);
      const alpha = status.rooms.find((entry) => entry.id === "room-alpha");
      expect(alpha.repo).toEqual({ name: "alpha", path: repoA });
      expect(alpha.branch).toBe("main");
      expect(alpha.worktree).toBeNull();
      expect(alpha.coordinator).toMatchObject({
        session: "lead-a",
        name: "lead-alpha",
        engine: "claude",
        live: true,
        status: "busy",
      });
      // The parent-session helper counts toward its room instead of standalone.
      expect(alpha.counts).toEqual({ working: 2, blocked: 1, done: 1, idle: 0, total: 4 });
      expect(
        alpha.attention
          .map((item) => item.kind)
          .toSorted((left, right) => left.localeCompare(right)),
      ).toEqual(["blocked", "escalation"]);
      expect(alpha.attention.find((item) => item.kind === "escalation").text).toBe(
        "need a decision on the schema",
      );
      expect(alpha.latest).toMatchObject({ from: "w-3", text: "tests green" });
      const beta = status.rooms.find((entry) => entry.id === "room-beta");
      expect(beta.repo).toEqual({ name: "beta", path: repoB });
      expect(beta.branch).toBe("fix/login");
      expect(beta.worktree).toEqual({ slug: "fix-login", path: worktreeB });
      expect(beta.coordinator.live).toBe(false);
      expect(beta.attention.map((item) => item.kind)).toContain("stale-coordinator");
      expect(beta.parentChief).toEqual({ session: "chief-s", name: "the-chief" });
      expect(status.standalone.map((peer) => peer.session)).toEqual(["solo"]);
      expect(status.standalone[0]).toMatchObject({ repo: { name: "gamma" }, task: "fix docs" });
      expect(status.inbox).toEqual([expect.objectContaining({ kind: "unread", from: "stranger" })]);
      expect(status.summary).toMatchObject({
        orchestrators: 2,
        working: 3,
        blocked: 1,
        standalone: 1,
        escalations: 1,
        unread: 2,
      });
      expect(status.accounts).toEqual([{ id: "claude", short: "C" }]);
      const all = await chiefStatus({
        root,
        env,
        now: NOW,
        all: true,
        quota: false,
        listRooms: () => rooms,
      });
      expect(all.rooms.map((entry) => entry.id)).toContain("room-old");
    });

    it("prints a compact table and JSON through the CLI", async () => {
      const out = capture();
      await chiefCommand(["status", "--no-quota"], {
        stdout: out,
        root,
        env,
        listRooms: () => rooms,
      });
      const lines = out.text().trimEnd().split("\n");
      expect(lines[0]).toContain("★ the-chief");
      expect(lines.length).toBeLessThanOrEqual(40);
      expect(out.text()).toMatch(/! room-alpha {2}alpha@main/u);
      expect(out.text()).toContain("beta@fix/login");
      expect(out.text()).toContain("STANDALONE");
      const json = capture();
      await chiefCommand(["--json", "--no-quota"], {
        stdout: json,
        root,
        env,
        listRooms: () => rooms,
      });
      expect(JSON.parse(json.text())).toMatchObject({ summary: { orchestrators: 2 } });
      const one = capture();
      await chiefCommand(["status", "--room", "room-beta", "--no-quota"], {
        stdout: one,
        root,
        env,
        listRooms: () => rooms,
      });
      expect(one.text()).toContain("worktree fix-login");
    });

    it("renders the quota strip and a missing-Chief header", () => {
      const lines = renderChiefStatus({
        generatedAt: new Date(NOW).toISOString(),
        chief: null,
        staleChief: null,
        summary: { orchestrators: 0, working: 0, blocked: 0, attention: 0, standalone: 0 },
        rooms: [],
        standalone: [],
        accounts: [],
        quotaError: "monitor offline",
      });
      expect(lines[0]).toContain("no Chief bound");
      expect(lines.at(-1)).toContain("monitor offline");
    });
  });

  describe("send", () => {
    let repo;
    let rooms;

    beforeEach(() => {
      repo = makeRepo(tmp, "orkest");
      const other = makeRepo(path.join(tmp, "elsewhere"), "orkest");
      writePeer(root, { session: "me", name: "me", cwd: tmp });
      writePeer(root, { session: "lead-1", name: "lead-one", cwd: repo });
      writePeer(root, { session: "lead-2", name: "lead-two", cwd: other });
      rooms = [
        room("room-1", repo, {
          conductor: {
            engine: "claude",
            session: { id: "lead-1", engine: "claude", machine: os.hostname(), cwd: repo },
          },
        }),
        room("room-2", other, {
          conductor: {
            engine: "claude",
            session: { id: "lead-2", engine: "claude", machine: os.hostname(), cwd: other },
          },
        }),
      ];
    });

    it("resolves a room ID and delivers through peer_mailbox with wake when explicitly requested", async () => {
      const runMailbox = mailboxMock();
      const result = await chiefSend({
        root,
        env,
        to: "room-1",
        message: "please rebase",
        from: "me",
        kind: "update",
        noWake: false,
        runMailbox,
        listRooms: () => rooms,
      });
      expect(result).toMatchObject({ status: "sent", woke: true });
      expect(result.target).toMatchObject({ tier: "room", session: "lead-1", roomId: "room-1" });
      const [args] = runMailbox.mock.calls[0];
      expect(args.slice(0, 5)).toEqual(["send", "--session", "me", "--to", "lead-1"]);
      expect(args).toEqual(expect.arrayContaining(["--scope", "cross-project"]));
      expect(args.at(-1)).toBe("[chief:update] please rebase");
      expect(args).not.toContain("--no-wake");
    });

    it("keeps updates quiet by default and wakes for the other kinds", async () => {
      const cases = [
        { kind: "update", wakes: false },
        { kind: "question", wakes: true },
        { kind: "escalation", wakes: true },
        { kind: "done", wakes: true },
        { kind: undefined, wakes: true },
      ];
      for (const { kind, wakes } of cases) {
        const runMailbox = mailboxMock();
        const result = await chiefSend({
          root,
          env,
          to: "room-1",
          message: "note",
          from: "me",
          kind,
          runMailbox,
          listRooms: () => rooms,
        });
        const [args] = runMailbox.mock.calls[0];
        const body = args[args.indexOf("--text") + 1];
        expect(body).toBe(kind ? `[chief:${kind}] note` : "note");
        expect(args.includes("--no-wake")).toBe(!wakes);
        expect(result.woke).toBe(wakes);
      }
    });

    it("routes --wake and --no-wake through the CLI and rejects both together", async () => {
      const runMailbox = mailboxMock();
      const base = { root, env, runMailbox, listRooms: () => rooms, stdout: capture() };
      await chiefCommand(
        ["send", "--to", "room-1", "--from", "me", "--kind", "update", "--wake", "hi"],
        base,
      );
      expect(runMailbox.mock.calls.at(-1)[0]).not.toContain("--no-wake");
      await chiefCommand(
        ["send", "--to", "room-1", "--from", "me", "--kind", "done", "--no-wake", "hi"],
        base,
      );
      expect(runMailbox.mock.calls.at(-1)[0]).toContain("--no-wake");
      await expect(
        chiefCommand(["send", "--to", "room-1", "--from", "me", "--wake", "--no-wake", "hi"], base),
      ).rejects.toThrow(/not both/u);
      expect(runMailbox).toHaveBeenCalledTimes(2);
    });

    it("passes --no-wake and resolves agent names and exact sessions", async () => {
      const runMailbox = mailboxMock();
      await chiefSend({
        root,
        env,
        to: "lead-two",
        message: "fyi",
        from: "me",
        noWake: true,
        runMailbox,
        listRooms: () => rooms,
      });
      expect(runMailbox.mock.calls[0][0]).toEqual(
        expect.arrayContaining(["--to", "lead-2", "--no-wake"]),
      );
      const peers = [{ session: "lead-1", name: "lead-one", live: true }];
      expect(resolveChiefTarget("lead-1", { peers })).toMatchObject({ tier: "session" });
    });

    it("fails with a candidate list when a repository name is ambiguous", async () => {
      const runMailbox = mailboxMock();
      let error;
      try {
        await chiefSend({
          root,
          env,
          to: "orkest",
          message: "hi",
          from: "me",
          runMailbox,
          listRooms: () => rooms,
        });
      } catch (error_) {
        error = error_;
      }
      expect(error.code).toBe("ambiguous");
      expect(error.exitCode).toBe(2);
      expect(error.message).toContain("lead-1");
      expect(error.message).toContain("lead-2");
      expect(error.candidates).toHaveLength(2);
      expect(runMailbox).not.toHaveBeenCalled();
      await expect(
        chiefSend({
          root,
          env,
          to: "nobody",
          message: "hi",
          from: "me",
          runMailbox,
          listRooms: () => rooms,
        }),
      ).rejects.toMatchObject({ code: "not_found" });
    });

    it("exits 2-worthy ambiguity through the CLI and queues reports when no Chief is live", async () => {
      const out = capture();
      const runMailbox = mailboxMock();
      const queued = await chiefCommand(
        ["send", "--to", "chief", "--kind", "done", "--from", "me", "all", "green"],
        {
          stdout: out,
          root,
          env,
          runMailbox,
          listRooms: () => rooms,
        },
      );
      expect(queued.status).toBe("queued");
      expect(runMailbox).not.toHaveBeenCalled();
      expect(listDesk(root)).toEqual([
        expect.objectContaining({ kind: "done", text: "all green", from: "me" }),
      ]);
      const status = await chiefStatus({ root, env, quota: false, listRooms: () => rooms });
      expect(status.desk).toHaveLength(1);
      expect(status.summary.attention).toBeGreaterThanOrEqual(1);
      const desk = capture();
      await chiefCommand(["desk", "--ack", "--json"], { stdout: desk, root, env });
      expect(JSON.parse(desk.text())).toMatchObject({ acknowledged: 1 });
      expect(listDesk(root)).toEqual([]);
    });

    it("routes `chief` to the bound Chief lazily and queues when delivery fails", async () => {
      writePeer(root, { session: "boss", name: "boss", cwd: tmp });
      await bindChief({ root, env, session: "boss", runMailbox: mailboxMock(), now: NOW });
      const sent = await chiefSend({
        root,
        env,
        to: "chief",
        message: "done",
        from: "me",
        runMailbox: mailboxMock(),
        listRooms: () => rooms,
      });
      expect(sent.target).toMatchObject({ tier: "chief", session: "boss" });
      const failed = await chiefSend({
        root,
        env,
        to: "chief",
        message: "blocked",
        kind: "escalation",
        from: "me",
        runMailbox: mailboxMock(1, ""),
        listRooms: () => rooms,
      });
      expect(failed.status).toBe("queued");
      expect(listDesk(root)[0]).toMatchObject({ kind: "escalation" });
    });
  });

  describe("spawn", () => {
    let repo;

    beforeEach(() => {
      repo = makeRepo(tmp, "service");
      writePeer(root, { session: "chief-z", name: "zed-chief", cwd: tmp });
      fs.writeFileSync(
        chiefPath(root),
        JSON.stringify({
          schema: "ork.chief.v1",
          session: "chief-z",
          name: "zed-chief",
          machine: os.hostname(),
          pid: process.pid,
          boundAt: new Date(NOW).toISOString(),
        }),
      );
    });

    it("plans without side effects on --dry-run", async () => {
      const launch = vi.fn();
      const out = capture();
      const plan = await chiefCommand(
        [
          "spawn",
          "--cwd",
          repo,
          "--worktree",
          "add-cache",
          "--goal",
          "Add a cache layer",
          "--dry-run",
          "--json",
        ],
        { stdout: out, root, env, launch },
      );
      expect(plan).toMatchObject({
        dryRun: true,
        status: "planned",
        roomId: "chief-add-cache",
        worktree: {
          slug: "add-cache",
          branch: "chief/add-cache",
          path: path.join(repo, ".worktrees", "add-cache"),
        },
        parentChief: { alias: "chief", session: "chief-z", name: "zed-chief" },
        engine: "claude",
      });
      expect(plan.command).toEqual(
        expect.arrayContaining(["--detach", "--transport", "executor", "--engine", "claude"]),
      );
      expect(plan.command).not.toContain("--allow-credits");
      expect(plan.command).not.toContain("--ignore-quota");
      expect(plan.brief).toContain("--to chief");
      expect(launch).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(repo, ".worktrees"))).toBe(false);
      expect(listRawRooms(root)).toEqual([]);
      expect(JSON.parse(out.text()).roomId).toBe("chief-add-cache");
    });

    it("provisions a worktree, records parentChief in a new room, and launches detached", async () => {
      const launch = vi.fn(() => ({
        status: 0,
        stdout:
          "AGENT_JOB_STATUS=started\nAGENT_JOB_PID=4242\nAGENT_JOB=/tmp/job.json\nAGENT_MAILBOX=run-x-conductor\n",
        stderr: "",
      }));
      const result = await chiefSpawn({
        cwd: repo,
        branch: "feat/cache",
        goal: "Add a cache layer\nwith eviction",
        model: "opus",
        effort: "high",
        root,
        env,
        launch,
        now: NOW,
      });
      const worktree = path.join(repo, ".worktrees", result.worktree.slug);
      expect(result).toMatchObject({
        status: "launched",
        workspace: worktree,
        title: "Add a cache layer",
      });
      expect(result.worktree.branch).toBe("feat/cache");
      expect(git(worktree, "branch", "--show-current")).toBe("feat/cache");
      const [command, options] = launch.mock.calls[0];
      expect(command).toEqual(
        expect.arrayContaining(["--cwd", worktree, "--model", "opus", "--effort", "high"]),
      );
      expect(options.cwd).toBe(worktree);
      expect(options.env.ORK_CHIEF_ROOM).toBe(result.roomId);
      const stored = readRawRoom(result.roomId, root);
      expect(stored.cwd).toBe(fs.realpathSync(worktree));
      expect(stored.chief).toMatchObject({
        parent: { alias: "chief", session: "chief-z", name: "zed-chief" },
        goal: "Add a cache layer\nwith eviction",
        state: "running",
        mission: { session: result.missionSession },
        launch: { pid: 4242, status: "started", runMailbox: "run-x-conductor" },
      });
      expect(stored.conductor).toMatchObject({
        mailboxSession: result.missionSession,
        status: "running",
        worktree: { branch: "feat/cache", path: worktree },
      });
      const brief = fs.readFileSync(result.briefPath, "utf8");
      expect(brief).toContain(`--from ${result.missionSession} --to chief`);
      expect(brief).toContain("with eviction");

      const status = await chiefStatus({ root, env, quota: false, now: NOW });
      const summary = status.rooms.find((entry) => entry.id === result.roomId);
      expect(summary).toMatchObject({ branch: "feat/cache", parentChief: { session: "chief-z" } });
      writePeer(root, { session: result.missionSession, name: "mission-orch", cwd: worktree });
      const routed = await chiefSend({
        root,
        env,
        to: "feat/cache",
        message: "status?",
        from: "chief-z",
        runMailbox: mailboxMock(),
      });
      expect(routed.target.session).toBe(result.missionSession);
    });

    it("keeps a crashed mission visible until its done report clears the attention", async () => {
      const launch = () => ({ status: 0, stdout: `AGENT_JOB_PID=${deadPid()}\n`, stderr: "" });
      const result = await chiefSpawn({
        cwd: repo,
        worktree: "crashy",
        goal: "Refactor the parser",
        root,
        env,
        launch,
        now: NOW,
      });
      const later = NOW + 3 * 86_400_000;
      const crashed = await chiefStatus({ root, env, quota: false, now: later });
      const entry = crashed.rooms.find((candidate) => candidate.id === result.roomId);
      expect(entry.attention.map((item) => item.kind)).toContain("stale-coordinator");

      const runMailbox = mailboxMock();
      const report = await chiefSend({
        root,
        env,
        to: "chief",
        kind: "done",
        message: "merged-ready on chief/crashy, tests green",
        from: result.missionSession,
        runMailbox,
        now: later,
      });
      expect(report.mission).toEqual({ roomId: result.roomId, state: "done" });
      expect(runMailbox.mock.calls[0][0]).toEqual(expect.arrayContaining(["--to", "chief-z"]));
      expect(readRawRoom(result.roomId, root).chief).toMatchObject({
        state: "done",
        lastReport: { kind: "done", text: "merged-ready on chief/crashy, tests green" },
      });
      const settled = await chiefStatus({ root, env, quota: false, now: later, all: true });
      const done = settled.rooms.find((candidate) => candidate.id === result.roomId);
      expect(done.attention.map((item) => item.kind)).not.toContain("stale-coordinator");
      expect(done.stage).toBe("done");
      const active = await chiefStatus({ root, env, quota: false, now: later + 86_400_000 });
      expect(active.rooms.map((candidate) => candidate.id)).not.toContain(result.roomId);
    });

    it("warns when a mission shares the main checkout", async () => {
      const plan = await chiefSpawn({ cwd: repo, goal: "Tidy docs", dryRun: true, root, env });
      expect(plan.worktree).toBeNull();
      expect(plan.workspace).toBe(repo);
      expect(plan.warnings.join(" ")).toMatch(/--worktree/u);
    });

    it("records a failed launch on the room and reads --goal-file", async () => {
      const goalFile = path.join(tmp, "goal.md");
      fs.writeFileSync(goalFile, "Write the migration guide\n");
      const result = await chiefSpawn({
        cwd: repo,
        goalFile,
        engine: "agy",
        root,
        env,
        launch: () => ({ status: 3, stdout: "", stderr: "quota exhausted" }),
        now: NOW,
      });
      expect(result).toMatchObject({
        status: "failed",
        workspace: repo,
        worktree: null,
        engine: "agy",
      });
      expect(result.error).toContain("quota exhausted");
      expect(readRawRoom(result.roomId, root).chief).toMatchObject({
        state: "failed",
        launch: { status: "failed" },
      });
      await expect(chiefSpawn({ cwd: repo, root, env })).rejects.toThrow(/--goal/u);
      await expect(
        chiefSpawn({ cwd: repo, goal: "x", engine: "bogus", root, env }),
      ).rejects.toThrow(/Unsupported engine/u);
    });
  });

  it("forwards view to the horde Chief View", async () => {
    const main = vi.fn(async () => "viewed");
    const out = capture();
    await expect(
      chiefCommand(["view", "--print", "--width", "50"], { stdout: out, main, root, env }),
    ).resolves.toBe("viewed");
    expect(main).toHaveBeenCalledWith(["horde", "--view", "--chief", "--print", "--width", "50"], {
      stdout: out,
    });
  });

  it("propagates Orca terminal fields on bindChief and coordinatorOf", async () => {
    const writeRawRooms = (dir, items) => {
      const roomsDir = path.join(dir, "rooms");
      fs.mkdirSync(roomsDir, { recursive: true });
      for (const item of items) {
        fs.writeFileSync(path.join(roomsDir, `${item.id}.json`), JSON.stringify(item));
      }
    };
    const repo = makeRepo(tmp, "orca-chief-repo");
    const orcaEnv = {
      ...env,
      ORCA_TERMINAL_HANDLE: "term_chief_1",
      ORCA_PANE_KEY: "pane-chief",
      ORCA_WORKSPACE_ID: "ws-chief",
      ORCA_TAB_ID: "tab-chief",
      ORCA_ENVIRONMENT: "ssh:box",
    };
    const bound = await bindChief({ root, env: orcaEnv, session: "chief-orca", now: NOW });
    expect(bound.binding).toMatchObject({
      orcaTerminalHandle: "term_chief_1",
      orcaPaneKey: "pane-chief",
      orcaWorkspaceId: "ws-chief",
      orcaTabId: "tab-chief",
      orcaEnvironment: "ssh:box",
    });

    await writeRawRooms(root, [
      room("orca-room", repo, {
        orcaCoordinatorTerminalId: "term_coord_7",
        orcaWorkspaceId: "ws-room",
        orcaEnvironment: "ssh:box",
      }),
    ]);
    const status = await chiefStatus({ root, env: orcaEnv, quota: false, now: NOW });
    expect(status.chief).toMatchObject({
      orcaTerminalHandle: "term_chief_1",
      orcaPaneKey: "pane-chief",
      orcaWorkspaceId: "ws-chief",
      orcaTabId: "tab-chief",
      orcaEnvironment: "ssh:box",
    });
    expect(status.rooms[0].coordinator).toMatchObject({
      orcaTerminalHandle: "term_coord_7",
      orcaWorkspaceId: "ws-room",
      orcaEnvironment: "ssh:box",
    });
  });

  it("rejects recycled Chief PIDs when pidBirth does not match", async () => {
    fs.writeFileSync(
      chiefPath(root),
      JSON.stringify({
        schema: "ork.chief.v1",
        session: "chief-recycled",
        name: "Recycled",
        engine: "claude",
        cwd: tmp,
        machine: os.hostname(),
        pid: process.pid,
        pidBirth: "1999-01-01T00:00:00Z",
        boundAt: new Date(NOW).toISOString(),
      }),
    );
    expect(readChiefBinding({ root, now: NOW })).toBeNull();
    expect(readChiefBinding({ root, now: NOW, includeStale: true })).toMatchObject({
      live: false,
      stale: true,
      staleReason: expect.stringContaining("recycled"),
    });
  });

  it("excludes cancelled rooms from status and keeps peers from inactive rooms standalone", async () => {
    const writeRawRooms = (dir, items) => {
      const roomsDir = path.join(dir, "rooms");
      fs.mkdirSync(roomsDir, { recursive: true });
      for (const item of items) {
        fs.writeFileSync(path.join(roomsDir, `${item.id}.json`), JSON.stringify(item));
      }
    };
    const repo = makeRepo(tmp, "cancelled-repo");
    const repo2 = makeRepo(tmp, "solo-repo");
    writePeer(root, {
      session: "coord-cancelled",
      name: "GoneCoord",
      cwd: repo,
      pid: process.pid,
    });
    writePeer(root, {
      session: "solo-from-archived",
      name: "StillRunning",
      cwd: repo2,
      pid: process.pid,
    });
    await writeRawRooms(root, [
      room("room-cancelled", repo, {
        status: "cancelled",
        lifecycle: "cancelled",
        cancelledAt: NOW - 100,
        conductor: { engine: "claude", status: "running", session: { id: "coord-cancelled" } },
      }),
      room("room-archived", repo2, {
        lifecycle: "archived",
        archivedAt: NOW - 200,
        conductor: { engine: "claude", status: "running", session: { id: "solo-from-archived" } },
      }),
    ]);
    const status = await chiefStatus({ root, env, quota: false, now: NOW, all: true });
    expect(status.rooms).toEqual([]);
    expect(status.standalone.map((peer) => peer.session)).toEqual(
      expect.arrayContaining(["coord-cancelled", "solo-from-archived"]),
    );
  });

  it("only updates mission state after Chief delivery succeeds and preserves terminal states", async () => {
    const writeRawRooms = (dir, items) => {
      const roomsDir = path.join(dir, "rooms");
      fs.mkdirSync(roomsDir, { recursive: true });
      for (const item of items) {
        fs.writeFileSync(path.join(roomsDir, `${item.id}.json`), JSON.stringify(item));
      }
    };
    const repo = makeRepo(tmp, "send-mission");
    const otherRepo = makeRepo(tmp, "other-peer-repo");
    await bindChief({ root, env, session: "chief-live", now: NOW });
    writePeer(root, { session: "chief-live", name: "Chief", cwd: tmp, pid: process.pid });
    writePeer(root, {
      session: "other-worker",
      name: "Other",
      cwd: otherRepo,
      pid: process.pid,
    });
    const missionRoom = room("chief-mission-1", repo, {
      chief: { goal: "Ship hardening", state: "running", mission: { session: "mission-1-orch" } },
      conductor: { engine: "claude", status: "running", mailboxSession: "mission-1-orch" },
    });
    await writeRawRooms(root, [missionRoom]);

    // 1. Failing delivery to non-Chief peer leaves mission state untouched.
    await expect(
      chiefSend({
        to: "other-worker",
        message: "ping",
        from: "mission-1-orch",
        root,
        env,
        now: NOW,
        runMailbox: mailboxMock(1, ""),
      }),
    ).rejects.toThrow(/failed/u);
    expect(readRawRoom("chief-mission-1", root).chief.state).toBe("running");

    // 2. Successful delivery to non-Chief peer does NOT hijack mission state even with --kind done.
    const toPeer = await chiefSend({
      to: "other-worker",
      kind: "done",
      message: "handoff complete",
      from: "mission-1-orch",
      root,
      env,
      now: NOW,
      runMailbox: mailboxMock(0),
    });
    expect(toPeer.mission).toBeNull();
    expect(readRawRoom("chief-mission-1", root).chief.state).toBe("running");

    // 3. Report to chief moves state to done; plain follow-up omitting kind preserves done.
    await chiefSend({
      to: "chief",
      kind: "done",
      message: "all green",
      from: "mission-1-orch",
      root,
      env,
      now: NOW,
      runMailbox: mailboxMock(0),
    });
    expect(readRawRoom("chief-mission-1", root).chief.state).toBe("done");
    expect(readRawRoom("chief-mission-1", root).conductor.status).toBe("completed");

    await chiefSend({
      to: "chief",
      message: "follow-up note with branch details",
      from: "mission-1-orch",
      root,
      env,
      now: NOW + 1000,
      runMailbox: mailboxMock(0),
    });
    expect(readRawRoom("chief-mission-1", root).chief.state).toBe("done");
    expect(readRawRoom("chief-mission-1", root).conductor.status).toBe("completed");
  });

  it("checks existing room IDs before provisioning a Chief spawn worktree", async () => {
    const roomsDir = path.join(root, "rooms");
    fs.mkdirSync(roomsDir, { recursive: true });
    const repo = makeRepo(tmp, "dup-spawn");
    fs.writeFileSync(
      path.join(roomsDir, "chief-taken.json"),
      JSON.stringify(room("chief-taken", repo)),
    );
    const provision = vi.fn();
    await expect(
      chiefSpawn({
        cwd: repo,
        worktree: "taken",
        goal: "Should fail before worktree creation",
        root,
        env,
        provision,
      }),
    ).rejects.toThrow(/already exists/u);
    expect(provision).not.toHaveBeenCalled();
  });

  it("sweeps stale Chief focus from displaced peers and hides stale Chief focus from non-Chief status", async () => {
    const repo = makeRepo(tmp, "stale-focus");
    const chiefFocus = "Ork Chief — machine-wide master orchestrator";
    writePeer(root, { session: "chief-old", name: "old-chief", cwd: repo, focus: chiefFocus });
    writePeer(root, { session: "chief-new", name: "new-chief", cwd: repo });
    const runMailbox = mailboxMock();
    await bindChief({ root, env, session: "chief-new", runMailbox, now: NOW });
    expect(runMailbox.mock.calls.map(([args]) => args)).toContainEqual([
      "focus",
      "--session",
      "chief-old",
      "--clear",
      "--only-if",
      chiefFocus,
    ]);
    // Even if a legacy peer file still retains the old Chief focus string, non-Chief status ignores it.
    const status = await chiefStatus({ root, env, now: NOW, quota: false, listRooms: () => [] });
    const oldPeer = status.standalone.find((peer) => peer.session === "chief-old");
    expect(oldPeer).toBeDefined();
    expect(oldPeer.task).toBe("");
  });

  it("instructs Chief to route code/design questions directly and tells missions how to answer", () => {
    const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
    const skillText = fs.readFileSync(
      path.join(pluginRoot, "adapters/skills/chief/SKILL.md"),
      "utf8",
    );
    const commandText = fs.readFileSync(
      path.join(pluginRoot, "adapters/claude/commands/chief.md"),
      "utf8",
    );
    expect(skillText).toContain("--kind question");
    expect(skillText).toMatch(/without asking/u);
    expect(commandText).toContain("--kind question");
    expect(commandText).toMatch(/without asking permission first/u);

    const brief = missionBrief({
      roomId: "chief-demo-1",
      goal: "Port settings cleanly",
      workspace: "/tmp/demo",
      branch: "feat/demo",
      chief: { name: "chief" },
      missionSession: "chief-demo-orch",
      title: "Demo",
    });
    expect(brief).toContain("--kind question");
    expect(brief).toMatch(/without making extra edits or\s+expanding scope/u);
  });

  describe("pre-provision policy & route gate", () => {
    it("refuses denied explicit engine, denied implicit candidate, and denied/unknown named routes before any side effects", async () => {
      const repo = makeRepo(tmp, "gated-repo");
      fs.mkdirSync(path.join(repo, ".orkest"), { recursive: true });
      fs.writeFileSync(
        path.join(repo, ".orkest", "policy.json"),
        JSON.stringify({ deny: ["agy", "codex"] }),
        "utf8",
      );

      const provision = vi.fn();
      const launch = vi.fn();

      // 1. Denied explicit engine
      await expect(
        chiefSpawn({
          cwd: repo,
          worktree: "wt-denied-eng",
          goal: "Should not run",
          engine: "codex",
          root,
          env,
          provision,
          launch,
        }),
      ).rejects.toThrow(/denied/u);

      // 2. Denied named route (gemini -> agy) including on dryRun
      await expect(
        chiefSpawn({
          cwd: repo,
          worktree: "wt-denied-route",
          goal: "Should not run",
          route: "gemini",
          dryRun: true,
          root,
          env,
          provision,
          launch,
        }),
      ).rejects.toThrow(/denied/u);

      // 3. Unknown named route
      await expect(
        chiefSpawn({
          cwd: repo,
          worktree: "wt-unknown-route",
          goal: "Should not run",
          route: "nonexistent-route",
          root,
          env,
          provision,
          launch,
        }),
      ).rejects.toThrow(/Unknown --route/u);

      // 4. Denied implicit candidate when all harnesses are denied
      fs.writeFileSync(
        path.join(repo, ".orkest", "policy.json"),
        JSON.stringify({ deny: ["all"] }),
        "utf8",
      );
      await expect(
        chiefSpawn({
          cwd: repo,
          worktree: "wt-all-denied",
          goal: "Should not run",
          root,
          env,
          provision,
          launch,
        }),
      ).rejects.toThrow(/denied/u);

      expect(provision).not.toHaveBeenCalled();
      expect(launch).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(repo, ".worktrees"))).toBe(false);
      expect(listRawRooms(root)).toEqual([]);
      expect(fs.existsSync(path.join(root, "chief", "missions"))).toBe(false);
    });

    it("preserves permitted Claude default, resolves agy named route without codex fallback, and propagates N-account reroutes cleanly", async () => {
      const repo = makeRepo(tmp, "allowed-repo");
      const launch = vi.fn(() => ({
        status: 0,
        stdout: "AGENT_JOB_STATUS=started\nAGENT_JOB_PID=4321\n",
        stderr: "",
      }));

      // 1. Named route "gemini" selects engine "agy", never "--engine codex"
      const agyPlan = await chiefSpawn({
        cwd: repo,
        goal: "Research design",
        route: "gemini",
        dryRun: true,
        root,
        env,
        launch,
      });
      expect(agyPlan.engine).toBe("agy");
      expect(agyPlan.command).toEqual(
        expect.arrayContaining(["--route", "gemini", "--engine", "agy"]),
      );
      expect(agyPlan.command).not.toContain("codex");

      // 2. Multi-account Monitor config: when work Claude is denied, auto-selection picks allowed personal Claude account (claude-p1 / claude-alt)
      const monitorCfgPath = path.join(tmp, "chief-monitor.json");
      const personalDir = path.join(tmp, ".claude-p1");
      const personalDir2 = path.join(tmp, ".claude-p2");
      const acmeDir = path.join(tmp, ".claude-acme");
      const codexPersHome = path.join(tmp, ".codex-personal");
      fs.writeFileSync(
        monitorCfgPath,
        JSON.stringify({
          accounts: [
            { id: "claude-work-1", provider: "claude", tags: ["work"] },
            {
              id: "claude-p1",
              alias: "claude-alt",
              provider: "claude",
              configDir: personalDir,
              tags: ["personal"],
            },
            {
              id: "claude-p2",
              provider: "claude",
              configDir: personalDir2,
              tags: ["personal"],
            },
            {
              id: "claude-acme",
              provider: "claude",
              configDir: acmeDir,
              tags: ["client-acme"],
            },
            { id: "codex-work", provider: "codex", tags: ["work"] },
            {
              id: "codex-p1",
              alias: "codex-pers",
              provider: "codex",
              codexHome: codexPersHome,
              tags: ["personal"],
            },
          ],
        }),
        "utf8",
      );
      const multiEnv = { ...env, MONITOR_CONFIG: monitorCfgPath };

      fs.mkdirSync(path.join(repo, ".orkest"), { recursive: true });
      fs.writeFileSync(
        path.join(repo, ".orkest", "policy.json"),
        JSON.stringify({ deny: ["work"] }),
        "utf8",
      );
      const autoPersonalPlan = await chiefSpawn({
        cwd: repo,
        goal: "Default auto personal",
        dryRun: true,
        root,
        env: multiEnv,
      });
      expect(autoPersonalPlan.engine).toBe("claude");
      expect(autoPersonalPlan.accountId).toBe("claude-p1");
      expect(autoPersonalPlan.accountAlias).toBe("claude-alt");
      expect(autoPersonalPlan.claudeConfigDir).toBe(personalDir);

      // 3. Explicit --engine claude with ORCHESTRATE_AUTO_ACCOUNT=1 reroutes to claude-p2 when claude-p1 is also denied
      fs.writeFileSync(
        path.join(repo, ".orkest", "policy.json"),
        JSON.stringify({ deny: ["work", "claude-p1"] }),
        "utf8",
      );
      const rerouteRes = await chiefSpawn({
        cwd: repo,
        goal: "Run with second personal profile",
        engine: "claude",
        root,
        env: { ...multiEnv, ORCHESTRATE_AUTO_ACCOUNT: "1" },
        launch,
        now: NOW,
      });
      expect(rerouteRes.engine).toBe("claude");
      expect(rerouteRes.accountId).toBe("claude-p2");
      expect(rerouteRes.claudeConfigDir).toBe(personalDir2);
      expect(rerouteRes.command.filter((token) => token === "--claude-config-dir")).toHaveLength(1);
      expect(rerouteRes.command).toEqual(
        expect.arrayContaining(["--claude-config-dir", personalDir2, "--account", "claude-p2"]),
      );
      const [, launchOpts] = launch.mock.calls[0];
      expect(launchOpts.env.CLAUDE_CONFIG_DIR).toBeUndefined();
      const storedRoom = readRawRoom(rerouteRes.roomId, root);
      expect(storedRoom.conductor.accountId).toBe("claude-p2");
      expect(storedRoom.conductor.claudeConfigDir).toBe(personalDir2);

      // 4. Explicit --account across Codex resolves codexHome, forwards --account, and strips raw provider env vars
      const codexPlan = await chiefSpawn({
        cwd: repo,
        goal: "Codex personal run",
        account: "codex-pers",
        dryRun: true,
        root,
        env: multiEnv,
        isEngineInstalled: (eng) => eng === "codex",
      });
      expect(codexPlan.engine).toBe("codex");
      expect(codexPlan.accountId).toBe("codex-p1");
      expect(codexPlan.codexHome).toBe(codexPersHome);
      expect(codexPlan.command).toEqual(expect.arrayContaining(["--account", "codex-p1"]));

      const codexLiveLaunch = vi.fn(() => ({
        status: 0,
        stdout: "AGENT_JOB_STATUS=started\nAGENT_JOB_PID=4888\n",
        stderr: "",
      }));
      const codexLiveRes = await chiefSpawn({
        cwd: repo,
        goal: "Codex live launcher env isolation",
        account: "codex-pers",
        root,
        env: {
          ...multiEnv,
          CODEX_HOME: "/stale/codex",
          CLAUDE_CONFIG_DIR: "/stale/claude",
          GEMINI_CLI_HOME: "/stale/gemini",
          ANTIGRAVITY_APP_DATA_DIR: "/stale/agy",
        },
        launch: codexLiveLaunch,
        now: NOW,
        isEngineInstalled: (eng) => eng === "codex",
      });
      expect(codexLiveRes.command.filter((token) => token === "--account")).toHaveLength(1);
      expect(codexLiveRes.command).toEqual(expect.arrayContaining(["--account", "codex-p1"]));
      const [, codexLiveOpts] = codexLiveLaunch.mock.calls[0];
      expect(codexLiveOpts.env.HOME).toBe(multiEnv.HOME);
      expect(codexLiveOpts.env.ORKEST_CODEX_ACCOUNT_HOME).toBe(codexPersHome);
      expect(codexLiveOpts.env.CODEX_HOME).toBeUndefined();
      expect(codexLiveOpts.env.CLAUDE_CONFIG_DIR).toBeUndefined();
      expect(codexLiveOpts.env.GEMINI_CLI_HOME).toBeUndefined();
      expect(codexLiveOpts.env.ANTIGRAVITY_APP_DATA_DIR).toBeUndefined();

      // 5. Account env.HOME preserves caller HOME on launchEnv and deduplicates --account in command
      const customClaudeHome = path.join(tmp, "custom-chief-claude-home");
      const customCodexHome = path.join(tmp, "custom-chief-codex-home");
      fs.mkdirSync(customClaudeHome, { recursive: true });
      fs.mkdirSync(customCodexHome, { recursive: true });
      const homeMonitorCfg = path.join(tmp, "chief-home-monitor.json");
      fs.writeFileSync(
        homeMonitorCfg,
        JSON.stringify({
          accounts: [
            {
              id: "claude-alt-home",
              provider: "claude",
              env: { HOME: customClaudeHome },
              tags: ["personal"],
            },
            {
              id: "codex-alt-home",
              provider: "codex",
              env: { HOME: customCodexHome },
              tags: ["personal"],
            },
          ],
        }),
        "utf8",
      );
      fs.writeFileSync(
        path.join(repo, ".orkest", "policy.json"),
        JSON.stringify({ deny: [] }),
        "utf8",
      );
      const homeEnv = { ...env, MONITOR_CONFIG: homeMonitorCfg };
      const homeLaunch = vi.fn(() => ({
        status: 0,
        stdout: "AGENT_JOB_STATUS=started\nAGENT_JOB_PID=4999\n",
        stderr: "",
      }));

      const claudeHomeRes = await chiefSpawn({
        cwd: repo,
        goal: "Claude custom home without HOME override",
        engine: "claude",
        account: "claude-alt-home",
        root,
        env: homeEnv,
        launch: homeLaunch,
        now: NOW,
        isEngineInstalled: (eng) => eng === "claude",
      });
      expect(claudeHomeRes.command.filter((token) => token === "--account")).toHaveLength(1);
      expect(claudeHomeRes.command).toEqual(
        expect.arrayContaining(["--account", "claude-alt-home"]),
      );
      const [, claudeHomeLaunchOpts] = homeLaunch.mock.calls[0];
      expect(claudeHomeLaunchOpts.env.HOME).toBe(homeEnv.HOME);
      expect(claudeHomeLaunchOpts.env.ORKEST_CLAUDE_ACCOUNT_HOME).toBe(customClaudeHome);

      const codexHomeRes = await chiefSpawn({
        cwd: repo,
        goal: "Codex custom home without HOME override",
        engine: "codex",
        account: "codex-alt-home",
        root,
        env: homeEnv,
        launch: homeLaunch,
        now: NOW,
        isEngineInstalled: (eng) => eng === "codex",
      });
      expect(codexHomeRes.command.filter((token) => token === "--account")).toHaveLength(1);
      const [, codexHomeLaunchOpts] = homeLaunch.mock.calls[1];
      expect(codexHomeLaunchOpts.env.HOME).toBe(homeEnv.HOME);
      expect(codexHomeLaunchOpts.env.ORKEST_CODEX_ACCOUNT_HOME).toBe(
        path.join(customCodexHome, ".codex"),
      );
    });

    it("resolves named-route alternates against repo policy and installed harnesses", async () => {
      const repo = makeRepo(tmp, "route-alternates-repo");
      fs.mkdirSync(path.join(repo, ".orkest"), { recursive: true });
      // independent-review: primary=codex, alt1=claude (claude:best/high), alt2=agy (gemini:carbon-high)
      fs.writeFileSync(
        path.join(repo, ".orkest", "policy.json"),
        JSON.stringify({ deny: ["codex"] }),
        "utf8",
      );

      // 1. Primary codex denied -> selects installed & allowed alternate 1 (claude)
      const alt1Plan = await chiefSpawn({
        cwd: repo,
        goal: "Review architecture",
        route: "independent-review",
        dryRun: true,
        root,
        env,
        isEngineInstalled: (eng) => eng === "claude" || eng === "agy",
      });
      expect(alt1Plan.engine).toBe("claude");
      expect(alt1Plan.model).toBe("claude:best");
      expect(alt1Plan.effort).toBe("high");
      expect(alt1Plan.command).toEqual(
        expect.arrayContaining([
          "--route",
          "independent-review",
          "--engine",
          "claude",
          "--model",
          "claude:best",
          "--effort",
          "high",
        ]),
      );

      // 2. Primary codex allowed, but NOT installed -> selects installed alternate 1 (claude)
      fs.writeFileSync(
        path.join(repo, ".orkest", "policy.json"),
        JSON.stringify({ deny: [] }),
        "utf8",
      );
      const uninstalledPrimaryPlan = await chiefSpawn({
        cwd: repo,
        goal: "Review when codex missing",
        route: "independent-review",
        dryRun: true,
        root,
        env,
        isEngineInstalled: (eng) => eng === "claude",
      });
      expect(uninstalledPrimaryPlan.engine).toBe("claude");
      expect(uninstalledPrimaryPlan.model).toBe("claude:best");
      expect(uninstalledPrimaryPlan.effort).toBe("high");

      // 3. Both codex and claude unavailable/denied -> selects alternate 2 (agy) and records it in room.conductor
      fs.writeFileSync(
        path.join(repo, ".orkest", "policy.json"),
        JSON.stringify({ deny: ["codex", "claude-work"] }),
        "utf8",
      );
      const launch = vi.fn(() => ({
        status: 0,
        stdout: "AGENT_JOB_STATUS=started\nAGENT_JOB_PID=5151\n",
        stderr: "",
      }));
      const alt2Res = await chiefSpawn({
        cwd: repo,
        goal: "Fallback to agy alternate",
        route: "independent-review",
        root,
        env,
        launch,
        isEngineInstalled: (eng) => eng === "agy",
      });
      expect(alt2Res.engine).toBe("agy");
      expect(alt2Res.model).toBe("gemini:carbon-high");
      const alt2Room = readRawRoom(alt2Res.roomId, root);
      expect(alt2Room.conductor.engine).toBe("agy");
      expect(alt2Room.conductor.model).toBe("gemini:carbon-high");

      // 4. All route candidates denied -> rejects before provisioning
      fs.writeFileSync(
        path.join(repo, ".orkest", "policy.json"),
        JSON.stringify({ deny: ["codex", "claude-all", "agy"] }),
        "utf8",
      );
      const provision = vi.fn();
      await expect(
        chiefSpawn({
          cwd: repo,
          worktree: "wt-should-not-exist",
          goal: "Should fail",
          route: "independent-review",
          root,
          env,
          provision,
          isEngineInstalled: () => true,
        }),
      ).rejects.toThrow(/denied/u);
      expect(provision).not.toHaveBeenCalled();
    });
  });

  describe("chiefLiveness table & chief.lock CAS", () => {
    it("enforces exact 600s grace boundaries, PID reuse, wrong host, same-PID replacement, shared child non-replacement, and read-only stability", () => {
      const chiefFile = chiefPath(root);

      // 1. 599s / 600s / 601s grace window when no PID and no exact peer
      const boundAt = new Date(NOW).toISOString();
      fs.writeFileSync(
        chiefFile,
        JSON.stringify({
          schema: "ork.chief.v1",
          session: "chief-grace",
          name: "grace",
          machine: os.hostname(),
          pid: null,
          boundAt,
        }),
      );
      const beforeBytes = fs.readFileSync(chiefFile, "utf8");
      expect(readChiefBinding({ root, now: NOW + 599_000, peers: [] })).toMatchObject({
        session: "chief-grace",
        live: true,
      });
      expect(readChiefBinding({ root, now: NOW + 600_000, peers: [] })).toMatchObject({
        session: "chief-grace",
        live: true,
      });
      expect(readChiefBinding({ root, now: NOW + 601_000, peers: [] })).toBeNull();
      expect(
        readChiefBinding({ root, now: NOW + 601_000, peers: [], includeStale: true }),
      ).toMatchObject({
        live: false,
        stale: true,
      });
      expect(readChiefBinding({ root, now: NOW - 1000, peers: [] })).toBeNull();
      expect(fs.readFileSync(chiefFile, "utf8")).toBe(beforeBytes);

      // 2. Wrong host -> stale
      fs.writeFileSync(
        chiefFile,
        JSON.stringify({
          schema: "ork.chief.v1",
          session: "chief-remote",
          name: "remote",
          machine: `${os.hostname()}-other`,
          pid: process.pid,
          boundAt,
        }),
      );
      expect(readChiefBinding({ root, now: NOW, peers: [] })).toBeNull();
      expect(readChiefBinding({ root, now: NOW, peers: [], includeStale: true })).toMatchObject({
        stale: true,
        staleReason: expect.stringContaining("another machine"),
      });

      // 3. PID reuse rejected even when a stale live-looking peer record exists
      writePeer(root, { session: "chief-reused", name: "reused", cwd: tmp, pid: process.pid });
      fs.writeFileSync(
        chiefFile,
        JSON.stringify({
          schema: "ork.chief.v1",
          session: "chief-reused",
          name: "reused",
          machine: os.hostname(),
          pid: process.pid,
          pidBirth: "1999-01-01T00:00:00Z",
          boundAt,
        }),
      );
      expect(readChiefBinding({ root, now: NOW })).toBeNull();
      expect(readChiefBinding({ root, now: NOW, includeStale: true })).toMatchObject({
        stale: true,
        staleReason: expect.stringContaining("recycled"),
      });

      // 4. Shared child / run peer on same PID past grace does NOT replace Chief
      fs.rmSync(path.join(root, "peers"), { recursive: true, force: true });
      fs.writeFileSync(
        chiefFile,
        JSON.stringify({
          schema: "ork.chief.v1",
          session: "chief-parent",
          name: "parent",
          machine: os.hostname(),
          pid: process.pid,
          boundAt: new Date(NOW - 700_000).toISOString(),
        }),
      );
      writePeer(root, {
        session: "child-sub",
        name: "sub",
        cwd: tmp,
        pid: process.pid,
        isSubagent: true,
        sharedProcess: true,
        parentSession: "chief-parent",
      });
      writePeer(root, {
        session: "run-99-worker",
        name: "worker",
        cwd: tmp,
        pid: process.pid,
        run: "99",
      });
      expect(readChiefBinding({ root, now: NOW })).toMatchObject({
        session: "chief-parent",
        live: true,
      });

      // 5. Same-PID top-level replacement past grace marks Chief cleared/replaced
      writePeer(root, {
        session: "chief-cleared-new",
        name: "new-top-level",
        cwd: tmp,
        pid: process.pid,
        sharedProcess: true,
      });
      expect(readChiefBinding({ root, now: NOW })).toBeNull();
      expect(readChiefBinding({ root, now: NOW, includeStale: true })).toMatchObject({
        stale: true,
        staleReason: expect.stringContaining("cleared or replaced"),
      });
    });

    it("serializes concurrent bindChief mutations via chief.lock flock CAS without losing history", async () => {
      writePeer(root, { session: "race-a", name: "race-a", cwd: tmp });
      writePeer(root, { session: "race-b", name: "race-b", cwd: tmp });

      // Hold chief.lock from an external Python process briefly while bindChief waits and retries CAS
      const lockScript = [
        "import fcntl, json, os, sys, time",
        "root = sys.argv[1]",
        "lock_path = os.path.join(root, 'chief.lock')",
        "chief_path = os.path.join(root, 'chief.json')",
        "fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)",
        "fcntl.flock(fd, fcntl.LOCK_EX)",
        "print('LOCKED', flush=True)",
        "time.sleep(0.15)",
        "with open(chief_path, 'w') as fh:",
        "    json.dump({'schema': 'ork.chief.v1', 'session': 'ext-holder', 'name': 'ext', 'machine': os.uname().nodename, 'pid': os.getpid(), 'boundAt': '2026-01-01T00:00:00Z'}, fh)",
        "os.close(fd)",
      ].join("\n");

      const locker = spawn("python3", ["-c", lockScript, root], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const lockerDone = new Promise((resolve) => locker.on("close", resolve));
      await new Promise((resolve, reject) => {
        locker.on("error", reject);
        locker.stdout.on("data", (chunk) => {
          if (String(chunk).includes("LOCKED")) resolve();
        });
      });

      const [resA, resB] = await Promise.all([
        bindChief({ root, env, session: "race-a", runMailbox: mailboxMock(), now: NOW }),
        bindChief({ root, env, session: "race-b", runMailbox: mailboxMock(), now: NOW + 5 }),
      ]);
      await lockerDone;

      const finalStored = JSON.parse(fs.readFileSync(chiefPath(root), "utf8"));
      expect(["race-a", "race-b"]).toContain(finalStored.session);
      expect(finalStored.revision).toBeGreaterThanOrEqual(1);
      expect(finalStored.previous).toBeTruthy();
      expect([resA.action, resB.action].every((act) => act === "taken" || act === "bound")).toBe(
        true,
      );
      // chief.lock remains on disk (never unlinked on release)
      expect(fs.existsSync(path.join(root, "chief.lock"))).toBe(true);
    });

    it("reconciles focus to the winning binding revision and rejects stale clear when same session rebinds", async () => {
      writePeer(root, { session: "race-win", name: "race-win", cwd: tmp });
      writePeer(root, { session: "race-lose", name: "race-lose", cwd: tmp });

      let focusOwner = null;
      const focusLog = [];
      const trackingMailbox = (delayLoseMs = 0) =>
        vi.fn((args) => {
          if (args[0] === "focus") {
            const sessIdx = args.indexOf("--session");
            const sess = sessIdx === -1 ? null : args[sessIdx + 1];
            const isClear = args.includes("--clear");
            focusLog.push({ sess, isClear, delayLoseMs });
            if (isClear) {
              if (focusOwner === sess) focusOwner = null;
            } else {
              focusOwner = sess;
            }
          }
          return { status: 0, stdout: '{"id":"m1","wake":{"status":"woken"}}', stderr: "" };
        });

      const [resWin, resLose] = await Promise.all([
        bindChief({
          root,
          env,
          session: "race-lose",
          runMailbox: trackingMailbox(1),
          now: NOW,
        }),
        bindChief({
          root,
          env,
          session: "race-win",
          runMailbox: trackingMailbox(2),
          now: NOW + 10,
        }),
      ]);
      const finalStored = JSON.parse(fs.readFileSync(chiefPath(root), "utf8"));
      expect(finalStored.session).toBe(focusOwner);
      expect(resWin.binding.revision).not.toBe(resLose.binding.revision);

      // Rebinding the same session increments revision; a stale clear holding the old revision must NOT clear the live renewal
      const liveSession = finalStored.session;
      const stalePre = readChiefBinding({ root, now: NOW + 20, includeStale: true });
      const renewed = await bindChief({
        root,
        env,
        session: liveSession,
        runMailbox: trackingMailbox(),
        now: NOW + 30,
      });
      expect(renewed.binding.revision).toBe(stalePre.revision + 1);
      await expect(
        bindChief({
          root,
          env,
          session: "outsider",
          clear: true,
          runMailbox: trackingMailbox(),
          now: NOW + 35,
        }),
      ).rejects.toThrow(/--force/u);
      expect(fs.existsSync(chiefPath(root))).toBe(true);
    });

    it("enforces liveness parity (contradictory peers, unavailable birth grace, 7-day heartbeat), generation CAS on clear, and route fidelity / missing executable rejection", async () => {
      const chiefFile = chiefPath(root);

      // 1. Liveness parity: exact peer PID / pidBirth contradiction -> stale
      writePeer(root, {
        session: "chief-contra",
        name: "contra",
        cwd: tmp,
        pid: process.pid + 999_999,
      });
      fs.writeFileSync(
        chiefFile,
        JSON.stringify({
          schema: "ork.chief.v1",
          session: "chief-contra",
          name: "contra",
          machine: os.hostname(),
          pid: process.pid,
          boundAt: new Date(NOW).toISOString(),
        }),
      );
      expect(readChiefBinding({ root, now: NOW })).toBeNull();
      expect(readChiefBinding({ root, now: NOW, includeStale: true })).toMatchObject({
        stale: true,
        staleReason: expect.stringContaining("contradicts"),
      });

      // 2. Liveness parity: unavailable birth lookup respects 600s grace both with and without exact peer
      fs.rmSync(path.join(root, "peers"), { recursive: true, force: true });
      writePeer(root, {
        session: "chief-nobirth",
        name: "nobirth",
        cwd: tmp,
        pid: process.pid,
        lastSeenAt: new Date(NOW - 86_400_000).toISOString(),
      });
      fs.writeFileSync(
        chiefFile,
        JSON.stringify({
          schema: "ork.chief.v1",
          session: "chief-nobirth",
          name: "nobirth",
          machine: os.hostname(),
          pid: process.pid,
          pidBirth: "2026-01-01T00:00:00Z",
          boundAt: new Date(NOW - 700_000).toISOString(),
        }),
      );
      expect(readChiefBinding({ root, now: NOW, getProcessStarted: () => {} })).toBeNull();
      expect(
        readChiefBinding({
          root,
          now: NOW - 200_000,
          getProcessStarted: () => {},
        }),
      ).toMatchObject({ session: "chief-nobirth", live: true });

      // 3. Liveness parity: aged 7-day heartbeat is rejected even if peer.live was pre-populated true
      fs.writeFileSync(
        chiefFile,
        JSON.stringify({
          schema: "ork.chief.v1",
          session: "chief-aged",
          name: "aged",
          machine: os.hostname(),
          pid: null,
          boundAt: new Date(NOW - 8 * 86_400_000).toISOString(),
        }),
      );
      expect(
        readChiefBinding({
          root,
          now: NOW,
          peers: [
            {
              session: "chief-aged",
              name: "aged",
              cwd: tmp,
              pid: null,
              lastSeenAt: new Date(NOW - 8 * 86_400_000).toISOString(),
              live: true,
            },
          ],
        }),
      ).toBeNull();

      // 3b. Liveness parity: 8-day-old non-shared exact peer with verified live PID returns null (live: false),
      // while exact 7-day-old non-shared exact peer stays live, and fresh exact peer cannot bypass expired birth grace.
      const birth = "2026-01-01T00:00:00Z";
      fs.writeFileSync(
        chiefFile,
        JSON.stringify({
          schema: "ork.chief.v1",
          session: "chief-aged-live",
          name: "aged-live",
          machine: os.hostname(),
          pid: process.pid,
          pidBirth: birth,
          boundAt: new Date(NOW - 8 * 86_400_000).toISOString(),
        }),
      );
      expect(
        readChiefBinding({
          root,
          now: NOW,
          getProcessStarted: () => birth,
          peers: [
            {
              session: "chief-aged-live",
              name: "aged-live",
              cwd: tmp,
              pid: process.pid,
              pidBirth: birth,
              sharedProcess: false,
              lastSeenAt: new Date(NOW - 8 * 86_400_000).toISOString(),
              live: true,
            },
          ],
        }),
      ).toBeNull();
      expect(
        readChiefBinding({
          root,
          now: NOW,
          getProcessStarted: () => birth,
          peers: [
            {
              session: "chief-aged-live",
              name: "aged-live",
              cwd: tmp,
              pid: process.pid,
              pidBirth: birth,
              sharedProcess: false,
              lastSeenAt: new Date(NOW - 7 * 86_400_000).toISOString(),
              live: true,
            },
          ],
        }),
      ).toMatchObject({ session: "chief-aged-live", live: true });

      fs.writeFileSync(
        chiefFile,
        JSON.stringify({
          schema: "ork.chief.v1",
          session: "chief-nobirth-fresh-peer",
          name: "nobirth-fresh",
          machine: os.hostname(),
          pid: process.pid,
          pidBirth: birth,
          boundAt: new Date(NOW - 601_000).toISOString(),
        }),
      );
      expect(
        readChiefBinding({
          root,
          now: NOW,
          getProcessStarted: () => {},
          peers: [
            {
              session: "chief-nobirth-fresh-peer",
              name: "nobirth-fresh",
              cwd: tmp,
              pid: process.pid,
              pidBirth: birth,
              sharedProcess: false,
              lastSeenAt: new Date(NOW).toISOString(),
              live: true,
            },
          ],
        }),
      ).toBeNull();

      // 4. bindChief records unique generation UUID and stale clear does NOT retry against newer revision/generation
      fs.rmSync(chiefFile, { force: true });
      writePeer(root, { session: "gen-chief", name: "gen-chief", cwd: tmp });
      const firstBind = await bindChief({
        root,
        env,
        session: "gen-chief",
        runMailbox: mailboxMock(),
        now: NOW,
      });
      expect(typeof firstBind.binding.generation).toBe("string");
      expect(firstBind.binding.generation.length).toBeGreaterThan(10);

      // Hold chief.lock while renewing the same session so a concurrent clear observes old (rev, gen) and fails on conflict
      const renewFirst = await bindChief({
        root,
        env,
        session: "gen-chief",
        runMailbox: mailboxMock(),
        now: NOW + 5,
      });
      expect(renewFirst.binding.generation).not.toBe(firstBind.binding.generation);

      // Simulate stale clear holding firstBind's generation via a concurrent bind while clear waits on chief.lock
      const lockScript = [
        "import fcntl, os, sys, time",
        'fd = os.open(os.path.join(sys.argv[1], "chief.lock"), os.O_CREAT | os.O_RDWR, 0o600)',
        "fcntl.flock(fd, fcntl.LOCK_EX)",
        String.raw`sys.stdout.write("LOCKED\n"); sys.stdout.flush()`,
        "time.sleep(0.2)",
        "os.close(fd)",
      ].join("\n");
      const locker = spawn("python3", ["-c", lockScript, root], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      await new Promise((resolve, reject) => {
        locker.on("error", reject);
        locker.stdout.on("data", (chunk) => {
          if (String(chunk).includes("LOCKED")) resolve();
        });
      });
      const clearPromise = bindChief({
        root,
        env,
        session: "gen-chief",
        clear: true,
        runMailbox: mailboxMock(),
        now: NOW + 10,
      });
      // Replace chief.json while lock is held (simulating renewal between read and clear CAS)
      const renewedRecord = {
        ...renewFirst.binding,
        revision: renewFirst.binding.revision + 1,
        generation: "renewed-generation-uuid",
      };
      fs.writeFileSync(chiefFile, JSON.stringify(renewedRecord, null, 2));
      await Promise.all([
        new Promise((resolve) => locker.on("close", resolve)),
        expect(clearPromise).rejects.toThrow(/conflict/u),
      ]);
      expect(JSON.parse(fs.readFileSync(chiefFile, "utf8")).generation).toBe(
        "renewed-generation-uuid",
      );

      // 5. Route fidelity: route with tags/alias preserves --model, --effort, --claude-config-dir with --engine claude
      const repo = makeRepo(tmp, "route-fidelity-repo");
      const cfgDir = path.dirname(env.ORCHESTRATE_CONFIG);
      fs.mkdirSync(cfgDir, { recursive: true });
      const personalDir = path.join(tmp, ".claude-p1");
      const monitorCfgPath = path.join(tmp, "route-monitor.json");
      fs.writeFileSync(
        monitorCfgPath,
        JSON.stringify({
          accounts: [
            { id: "claude-work", provider: "claude", tags: ["work"] },
            {
              id: "claude-p1",
              alias: "claude-alt",
              provider: "claude",
              configDir: personalDir,
              tags: ["personal"],
            },
          ],
        }),
        "utf8",
      );
      const routeEnv = { ...env, MONITOR_CONFIG: monitorCfgPath };
      fs.writeFileSync(
        env.ORCHESTRATE_CONFIG,
        JSON.stringify({
          routes: {
            "personal-fast": {
              engine: "claude-alt",
              tags: ["personal"],
              model: "claude:fast",
              effort: "low",
            },
          },
        }),
        "utf8",
      );
      const personalPlan = await chiefSpawn({
        cwd: repo,
        goal: "Fast personal review",
        route: "personal-fast",
        dryRun: true,
        root,
        env: routeEnv,
        isEngineInstalled: (eng) => eng === "claude",
      });
      expect(personalPlan.engine).toBe("claude");
      expect(personalPlan.accountId).toBe("claude-p1");
      expect(personalPlan.accountAlias).toBe("claude-alt");
      expect(personalPlan.model).toBe("claude:fast");
      expect(personalPlan.effort).toBe("low");
      expect(personalPlan.command).toEqual(
        expect.arrayContaining([
          "--route",
          "personal-fast",
          "--engine",
          "claude",
          "--account",
          "claude-p1",
          "--model",
          "claude:fast",
          "--effort",
          "low",
          "--claude-config-dir",
          personalDir,
        ]),
      );

      // 6. Unavailable executables fail before provisioning worktree or room
      const provision = vi.fn();
      await expect(
        chiefSpawn({
          cwd: repo,
          worktree: "wt-missing-bin",
          goal: "Should fail unavailable",
          route: "independent-review",
          root,
          env: routeEnv,
          provision,
          isEngineInstalled: () => false,
        }),
      ).rejects.toThrow(/no installed executable/u);
      expect(provision).not.toHaveBeenCalled();

      // 7. Denied personal primary falling back to work-profile Claude alternate does not revert to ~/.claude-p1
      const altWorkRepo = makeRepo(tmp, "personal-to-work-alt-repo");
      fs.mkdirSync(path.join(altWorkRepo, ".orkest"), { recursive: true });
      fs.writeFileSync(
        path.join(altWorkRepo, ".orkest", "policy.json"),
        JSON.stringify({ deny: ["personal"] }),
        "utf8",
      );
      fs.writeFileSync(
        env.ORCHESTRATE_CONFIG,
        JSON.stringify({
          routes: {
            "personal-or-work": {
              engine: "claude",
              tags: ["personal"],
              model: "claude:fast",
              effort: "low",
              alternates: [
                {
                  engine: "claude",
                  model: "claude:balanced",
                  effort: "medium",
                },
              ],
            },
          },
        }),
        "utf8",
      );
      const workClaudeDir = path.join(tmp, ".claude");
      const altWorkPlan = await chiefSpawn({
        cwd: altWorkRepo,
        goal: "Run allowed work alternate",
        route: "personal-or-work",
        dryRun: true,
        root,
        env: routeEnv,
        isEngineInstalled: (eng) => eng === "claude",
      });
      expect(altWorkPlan.engine).toBe("claude");
      expect(altWorkPlan.accountId).toBe("claude-work");
      expect(altWorkPlan.model).toBe("claude:balanced");
      expect(altWorkPlan.effort).toBe("medium");
      expect(altWorkPlan.claudeConfigDir).toBe(workClaudeDir);
      expect(altWorkPlan.command).not.toContain("--route");
      expect(altWorkPlan.command).toEqual(
        expect.arrayContaining([
          "--engine",
          "claude",
          "--model",
          "claude:balanced",
          "--effort",
          "medium",
          "--claude-config-dir",
          workClaudeDir,
        ]),
      );

      // Round-trip the spawned command's routing flags through Python run_agent.parse_args + resolve_route
      const runAgentScript = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../../plugins/orchestrate/skills/orchestrate/scripts/run_agent.py",
      );
      const cliFlags = altWorkPlan.command.slice(2);
      const pyCheck = spawnSync(
        "python3",
        [
          "-c",
          [
            "import importlib.util, json, sys",
            `spec = importlib.util.spec_from_file_location("run_agent_mod", ${JSON.stringify(runAgentScript)})`,
            "mod = importlib.util.module_from_spec(spec)",
            "spec.loader.exec_module(mod)",
            "args = mod.resolve_route(mod.parse_args(json.loads(sys.argv[1])))",
            "print(json.dumps({'engine': args.engine, 'model': args.model, 'effort': args.effort, 'claude_config_dir': str(args.claude_config_dir) if args.claude_config_dir else None}))",
          ].join("\n"),
          JSON.stringify(cliFlags),
        ],
        {
          env: {
            ...process.env,
            HOME: tmp,
            MONITOR_CONFIG: routeEnv.MONITOR_CONFIG,
            ORCHESTRATE_CONFIG: env.ORCHESTRATE_CONFIG,
          },
          encoding: "utf8",
        },
      );
      expect(pyCheck.status).toBe(0);
      expect(JSON.parse(pyCheck.stdout)).toEqual({
        engine: "claude",
        model: "claude:balanced",
        effort: "medium",
        claude_config_dir: workClaudeDir,
      });

      // 8. Canonical peer precedence: stale legacy copy sorting before <sessionKey>.json never poisons bindChief or chiefLiveness
      fs.rmSync(chiefFile, { force: true });
      fs.rmSync(path.join(root, "peers"), { recursive: true, force: true });
      const canonSession = "chief:Canon";
      writePeer(root, {
        session: canonSession,
        name: "live-canonical-chief",
        cwd: tmp,
        pid: process.pid,
        paneId: "%42",
      });
      // Write a stale legacy peer file that sorts lexicographically BEFORE <sessionKey(canonSession)>.json
      fs.writeFileSync(
        path.join(root, "peers", "000-stale-legacy-chief.json"),
        JSON.stringify({
          schema: "agent-executor.peer.v1",
          session: canonSession,
          name: "stale-legacy-chief",
          harness: "claude",
          cwd: tmp,
          machine: os.hostname(),
          pid: deadPid(),
          pidBirth: "2020-01-01T00:00:00Z",
          paneId: "%999",
          startedAt: new Date(NOW - 86_400_000).toISOString(),
          lastSeenAt: new Date(NOW - 86_400_000).toISOString(),
        }),
      );
      const resolvedPeers = readPeers(root, { now: NOW });
      expect(resolvedPeers.filter((p) => p.session === canonSession)).toHaveLength(1);
      expect(resolvedPeers.find((p) => p.session === canonSession)).toMatchObject({
        name: "live-canonical-chief",
        pid: process.pid,
        paneId: "%42",
        live: true,
      });
      const boundCanon = await bindChief({
        root,
        env,
        session: canonSession,
        runMailbox: mailboxMock(),
        now: NOW,
      });
      expect(boundCanon.binding).toMatchObject({
        session: canonSession,
        name: "live-canonical-chief",
        pid: process.pid,
        paneId: "%42",
      });
      expect(readChiefBinding({ root, now: NOW })).toMatchObject({
        session: canonSession,
        name: "live-canonical-chief",
        pid: process.pid,
        paneId: "%42",
        live: true,
      });
    });
  });

  describe("mission lifecycle, digest, close and interactive launch", () => {
    const HEX = "a".repeat(32);
    const OTHER_HEX = "b".repeat(32);
    const ORK_BIN = fileURLToPath(
      new URL("../../../plugins/orchestrate/bin/ork.mjs", import.meta.url),
    );
    const CHIEF_BIN = fileURLToPath(
      new URL("../../../plugins/orchestrate/bin/chief.mjs", import.meta.url),
    );
    let cache;
    let repo;
    let runMailbox;

    beforeEach(() => {
      cache = path.join(tmp, "cache");
      env = { ...env, ORCHESTRATE_HOME: cache };
      repo = makeRepo(tmp, "lifecycle");
      runMailbox = mailboxMock();
    });

    const completionDir = () => path.join(cache, "completions-v1");

    async function writeRooms(items) {
      for (const item of items) await updateRawRoom(item.id, () => item, { root, create: true });
    }

    function missionRoom(roomId, { launch = {}, chiefState = "running", status } = {}) {
      const jobDir = path.join(root, "chief", "missions", roomId, "job");
      return room(roomId, repo, {
        ...(status && { status }),
        chief: {
          goal: "Ship",
          spawnedAt: new Date(NOW - 120_000).toISOString(),
          state: chiefState,
          mission: { session: `${roomId}-orch`, jobDir },
          launch: {
            mode: "detached",
            status: "started",
            roomId,
            generation: "gen-1",
            jobDir,
            completionDir: completionDir(),
            pid: deadPid(),
            launchedAt: new Date(NOW - 120_000).toISOString(),
            ...launch,
          },
        },
        conductor: { engine: "claude", status: "running", mailboxSession: `${roomId}-orch` },
      });
    }

    /** Writes the executor's artifacts for one mission. Pass null to omit an artifact. */
    function writeArtifacts(
      roomId,
      { manifest, result, event, steering, eventHex = HEX, resultOverride } = {},
    ) {
      const jobDir = path.join(root, "chief", "missions", roomId, "job");
      const resultPath = path.join(jobDir, "run", "result.json");
      const eventPath = path.join(completionDir(), `${eventHex}.json`);
      fs.mkdirSync(path.dirname(resultPath), { recursive: true });
      fs.mkdirSync(completionDir(), { recursive: true });
      if (manifest !== null) {
        fs.writeFileSync(
          path.join(jobDir, "job.json"),
          typeof manifest === "string"
            ? manifest
            : JSON.stringify({
                schema: "agent-executor.job.v1",
                job_dir: jobDir,
                result_path: resultPath,
                completion_event_path: eventPath,
                completion_event_id: eventHex,
                pid: deadPid(),
                status: "started",
                repository: repo,
                ...manifest,
              }),
        );
      }
      if (result)
        fs.writeFileSync(
          resultPath,
          JSON.stringify({ status: "completed", exit_code: 0, ...result }),
        );
      if (event)
        fs.writeFileSync(
          eventPath,
          JSON.stringify({
            schema: "agent-executor.completion.v1",
            event_id: eventHex,
            result_path: resultOverride ?? resultPath,
            repository: repo,
            status: result?.status,
            exit_code: result?.exit_code ?? 0,
            ...event,
          }),
        );
      if (steering) fs.writeFileSync(path.join(jobDir, "steering.json"), JSON.stringify(steering));
      return { jobDir, resultPath, eventPath };
    }

    function deskPuts() {
      const file = path.join(root, "chief", "desk.jsonl");
      if (!fs.existsSync(file)) return 0;
      return fs
        .readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line.includes('"op":"put"')).length;
    }

    function bindLiveChief() {
      writePeer(root, { session: "chief-live", name: "Chief", cwd: tmp, pid: process.pid });
      return bindChief({ root, env, session: "chief-live", runMailbox: mailboxMock(), now: NOW });
    }

    const quotaOk = async () => ({ status: "available", label: "claude-default" });

    /** A mailbox double whose ack marks the named messages read, as the real mailbox does. */
    function ackingMailbox() {
      return vi.fn((args) => {
        if (args[0] !== "ack")
          return { status: 0, stdout: '{"id":"m1","wake":{"status":"woken"}}', stderr: "" };
        const directory = path.join(root, "inbox", sessionKey(args[2]));
        for (const file of fs.readdirSync(directory)) {
          const full = path.join(directory, file);
          const message = JSON.parse(fs.readFileSync(full, "utf8"));
          if (args.slice(3).includes(message.id))
            fs.writeFileSync(
              full,
              JSON.stringify({ ...message, readAt: new Date(NOW).toISOString() }),
            );
        }
        return { status: 0, stdout: "{}", stderr: "" };
      });
    }

    function sends() {
      return runMailbox.mock.calls.filter(([args]) => args[0] === "send").length;
    }

    const reconcile = (roomId, extra = {}) =>
      chiefReconcile({ roomId, root, env, now: NOW, runMailbox, ...extra });

    describe("routing through the real ork dispatcher", () => {
      const runOrk = (args) =>
        spawnSync(process.execPath, [ORK_BIN, ...args], {
          env: { ...process.env, PATH: env.PATH, HOME: tmp, ORCHESTRATE_HOME: cache },
          encoding: "utf8",
          timeout: 60_000,
        });

      it("runs inbox, close and reconcile, rejects unknown verbs and positionals", () => {
        const inbox = runOrk(["chief", "inbox", "--json"]);
        expect(inbox.status).toBe(0);
        expect(JSON.parse(inbox.stdout)).toMatchObject({
          schema: "ork.chief.inbox.v1",
          groups: [],
        });
        const unknown = runOrk(["chief", "frobnicate"]);
        expect(unknown.status).not.toBe(0);
        expect(unknown.stderr).toMatch(/Unknown chief command/u);
        const extra = runOrk(["chief", "status", "stray"]);
        expect(extra.status).not.toBe(0);
        expect(runOrk(["chief", "close"]).status).not.toBe(0);
        expect(runOrk(["chief", "reconcile"]).status).not.toBe(0);
        expect(runOrk(["chief", "--help"]).stdout).toMatch(/ork chief inbox/u);
      });

      it("keeps bare chief as status and forwards view", async () => {
        const out = capture();
        const main = vi.fn(async () => "viewed");
        await chiefCommand([], { stdout: out, root, env, quota: false, main });
        expect(out.text()).toMatch(/ORK CHIEF/u);
        await chiefCommand(["view"], { stdout: capture(), main, root, env });
        expect(main).toHaveBeenCalledWith(["horde", "--view", "--chief"], expect.anything());
      });

      it("rejects both wake switches and passes --wake as noWake:false", async () => {
        await bindLiveChief();
        await writeRooms([missionRoom("route-room")]);
        await expect(
          chiefCommand(["send", "--to", "route-room", "--wake", "--no-wake", "x"], { root, env }),
        ).rejects.toThrow(/not both/u);
        const sent = capture();
        await chiefCommand(["send", "--to", "chief", "--wake", "--from", "me", "x"], {
          stdout: sent,
          root,
          env,
          runMailbox,
          listRooms: () => [],
        });
        expect(runMailbox.mock.calls.at(-1)[0]).not.toContain("--no-wake");
      });
    });

    describe("completion hook", () => {
      it("generates a 0700 hook that forwards the event to a mission reconcile", async () => {
        const mailboxDir = path.join(tmp, "mail box root");
        fs.mkdirSync(mailboxDir, { recursive: true });
        root = fs.realpathSync(mailboxDir);
        await writeRooms([missionRoom("hook-room")]);
        writeArtifacts("hook-room", {
          result: { status: "completed", task_outcome: "complete" },
          event: true,
        });
        const plan = planCompletionHook({ root, roomId: "hook-room", workspaces: [repo] });
        const hook = installCompletionHook(plan);
        expect(fs.statSync(hook).mode & 0o777).toBe(0o700);
        expect(fs.statSync(path.dirname(hook)).mode & 0o777).toBe(0o700);
        expect(fs.readFileSync(hook, "utf8")).toMatch(/--event "\$1"/u);
        // The hook runs with the same sanitized environment the executor gives it.
        const eventPath = path.join(completionDir(), `${HEX}.json`);
        const hookEnv = {
          PATH: process.env.PATH,
          HOME: tmp,
          LANG: "C",
          LC_ALL: "C",
          AGENT_EVENT: eventPath,
          AGENT_RESULT: path.join(
            root,
            "chief",
            "missions",
            "hook-room",
            "job",
            "run",
            "result.json",
          ),
          AGENT_STATUS: "completed",
        };
        const first = spawnSync(hook, [eventPath], {
          env: hookEnv,
          encoding: "utf8",
          timeout: 10_000,
        });
        expect(first.status, first.stderr).toBe(0);
        expect(readRawRoom("hook-room", root).chief.state).toBe("done");
        const second = spawnSync(hook, [eventPath], {
          env: hookEnv,
          encoding: "utf8",
          timeout: 10_000,
        });
        expect(second.status).toBe(0);
        expect(deskPuts()).toBe(1);
      });

      it("installs and runs through an aliased temporary root", async () => {
        const alias = `${root}-alias`;
        fs.symlinkSync(root, alias);
        try {
          const plan = planCompletionHook({
            root: alias,
            roomId: "alias-room",
            workspaces: [repo],
          });
          expect(plan.root).toBe(fs.realpathSync(root));
          const hook = installCompletionHook(plan);
          expect(fs.statSync(hook).mode & 0o777).toBe(0o700);
          expect(fs.readFileSync(hook, "utf8")).toContain(fs.realpathSync(root));
        } finally {
          fs.unlinkSync(alias);
        }
      });

      it("delivers a hook's report through the real local mailbox exactly once", async () => {
        root = path.join(cache, "mailbox-v1");
        fs.mkdirSync(root, { recursive: true });
        await writeRooms([missionRoom("hook-mail")]);
        writeArtifacts("hook-mail", {
          result: { status: "timed_out", exit_code: 124 },
          event: true,
        });
        await bindLiveChief();
        writePeer(root, {
          session: "hook-mail-orch",
          name: "hook-mail",
          cwd: repo,
          pid: process.pid,
        });
        const hook = installCompletionHook(
          planCompletionHook({ root, roomId: "hook-mail", workspaces: [repo] }),
        );
        const eventPath = path.join(completionDir(), `${HEX}.json`);
        const hookEnv = {
          PATH: process.env.PATH,
          HOME: tmp,
          LANG: "C",
          LC_ALL: "C",
          AGENT_EVENT: eventPath,
          AGENT_RESULT: path.join(
            root,
            "chief",
            "missions",
            "hook-mail",
            "job",
            "run",
            "result.json",
          ),
          AGENT_STATUS: "timed_out",
        };
        const first = spawnSync(hook, [eventPath], {
          env: hookEnv,
          encoding: "utf8",
          timeout: 10_000,
        });
        expect(first.status, first.stderr).toBe(0);
        const again = spawnSync(hook, [eventPath], {
          env: hookEnv,
          encoding: "utf8",
          timeout: 10_000,
        });
        expect(again.status).toBe(0);
        const report = readRawRoom("hook-mail", root).chief.report;
        expect(report).toMatchObject({ status: "delivered", messageId: expect.any(String) });
        const inbox = path.join(root, "inbox", sessionKey("chief-live"));
        const copies = fs
          .readdirSync(inbox)
          .map((file) => JSON.parse(fs.readFileSync(path.join(inbox, file), "utf8")))
          .filter((message) => message.text.includes("hook-mail failed: timed_out"));
        expect(copies).toHaveLength(1);
        expect(copies[0]).toMatchObject({
          id: report.messageId,
          from: { session: "hook-mail-orch" },
        });
        expect(copies[0].text).toMatch(/\[chief:escalation\] hook-mail failed: timed_out/u);
        expect(listDesk(root)).toEqual([
          expect.objectContaining({ id: report.id, mailboxId: report.messageId }),
        ]);
        expect(deskPuts()).toBe(1);
      });

      it("rejects hooks inside a workspace, traversal IDs and symlinked mission paths", () => {
        expect(() => planCompletionHook({ root, roomId: "ok-room", workspaces: [root] })).toThrow(
          /outside every executor workspace/u,
        );
        expect(() => planCompletionHook({ root, roomId: "../escape", workspaces: [repo] })).toThrow(
          /Invalid room ID/u,
        );
        const outside = path.join(tmp, "outside-target");
        fs.mkdirSync(outside, { recursive: true });
        fs.mkdirSync(root, { recursive: true });
        fs.symlinkSync(outside, path.join(root, "chief"));
        expect(() =>
          installCompletionHook(
            planCompletionHook({ root, roomId: "link-room", workspaces: [repo] }),
          ),
        ).toThrow(/symlinked/u);
        expect(fs.readdirSync(outside)).toEqual([]);
      });

      it("refuses a foreign existing script and keeps workspace containment component-based", () => {
        const plan = planCompletionHook({ root, roomId: "exists-room", workspaces: [repo] });
        installCompletionHook(plan);
        fs.writeFileSync(plan.path, "#!/bin/sh\necho other\n", { mode: 0o700 });
        expect(() => installCompletionHook(plan)).toThrow(/different content/u);
        expect(isWithinPath(path.join(tmp, "lifecycle-other"), path.join(tmp, "lifecycle"))).toBe(
          false,
        );
        expect(isWithinPath(path.join(tmp, "lifecycle", "x"), path.join(tmp, "lifecycle"))).toBe(
          true,
        );
      });

      it("launches a detached mission with the hook in argv and no notify", async () => {
        const launch = vi.fn(() => ({
          status: 0,
          stdout: `AGENT_JOB_PID=${deadPid()}\nAGENT_EVENT=${completionDir()}/x.json\n`,
          stderr: "",
        }));
        const result = await chiefSpawn({
          cwd: repo,
          goal: "Hook it",
          root,
          env,
          launch,
          now: NOW,
        });
        const [command] = launch.mock.calls[0];
        expect(command).toEqual(expect.arrayContaining(["--notify", "none", "--completion-hook"]));
        const hookPath = command[command.indexOf("--completion-hook") + 1];
        expect(hookPath).toBe(path.join(fs.realpathSync(root), "chief", "hooks", result.roomId));
        expect(fs.statSync(hookPath).mode & 0o777).toBe(0o700);
        expect(readRawRoom(result.roomId, root).chief.launch).toMatchObject({
          mode: "detached",
          completionDir: completionDir(),
          pid: expect.any(Number),
        });
      });
    });

    describe("exit classification and reconciliation", () => {
      const cases = [
        {
          name: "completed",
          result: { status: "completed", task_outcome: "complete", exit_code: 0 },
          expect: { state: "done", reason: "completed", puts: 1, sends: 1 },
        },
        {
          name: "timed out",
          result: { status: "timed_out", exit_code: 124 },
          expect: { state: "failed", reason: "timed_out", puts: 1, sends: 1 },
        },
        {
          name: "quota exhausted",
          result: { status: "provider_quota_exhausted", exit_code: 3 },
          expect: { state: "failed", reason: "provider_quota_exhausted", puts: 1, sends: 1 },
        },
        {
          name: "generic failure",
          result: { status: "failed", exit_code: 1 },
          expect: { state: "failed", reason: "failed", puts: 1, sends: 1 },
        },
        {
          name: "incomplete task outcome",
          result: { status: "completed", task_outcome: "blocked", exit_code: 0 },
          expect: { state: "failed", reason: "task_blocked", puts: 1, sends: 1 },
        },
      ];
      for (const [index, testCase] of cases.entries()) {
        it(`records ${testCase.name} once`, async () => {
          const roomId = `case-${index}`;
          await writeRooms([missionRoom(roomId)]);
          writeArtifacts(roomId, { result: testCase.result, event: true });
          await bindLiveChief();
          const outcome = await reconcile(roomId, { hook: true });
          expect(outcome).toMatchObject({
            state: testCase.expect.state,
            reason: testCase.expect.reason,
          });
          expect(readRawRoom(roomId, root).chief).toMatchObject({ state: testCase.expect.state });
          expect(deskPuts()).toBe(testCase.expect.puts);
          expect(sends()).toBe(testCase.expect.sends);
        });
      }

      it("completes a steered job from its current segment and ignores the superseded event", async () => {
        await writeRooms([missionRoom("steer-done")]);
        const first = writeArtifacts("steer-done", {
          result: { status: "failed", exit_code: 1 },
          event: true,
        });
        const segmentResult = path.join(first.jobDir, "run", "segment-2", "result.json");
        fs.mkdirSync(path.dirname(segmentResult), { recursive: true });
        fs.writeFileSync(
          segmentResult,
          JSON.stringify({ status: "completed", task_outcome: "complete", exit_code: 0 }),
        );
        const segmentEvent = path.join(completionDir(), `${OTHER_HEX}.json`);
        fs.writeFileSync(
          segmentEvent,
          JSON.stringify({
            schema: "agent-executor.completion.v1",
            event_id: OTHER_HEX,
            result_path: segmentResult,
            repository: repo,
            status: "completed",
            exit_code: 0,
          }),
        );
        fs.writeFileSync(
          path.join(first.jobDir, "steering.json"),
          JSON.stringify({
            schema: "agent-executor.steering.v1",
            result_path: segmentResult,
            completion_event_path: segmentEvent,
            completion_event_id: OTHER_HEX,
          }),
        );
        const outcome = await reconcile("steer-done", { hook: true });
        expect(outcome).toMatchObject({ decided: "done", state: "done", reason: "completed" });
        expect(readRawRoom("steer-done", root).chief).toMatchObject({ state: "done" });
        expect(deskPuts()).toBe(1);
      });

      it("keeps a started, positively live executor and records nothing", async () => {
        await writeRooms([missionRoom("live-room", { launch: { pid: process.pid } })]);
        writeArtifacts("live-room", { manifest: { pid: process.pid } });
        const outcome = await reconcile("live-room", { hook: true });
        expect(outcome).toMatchObject({ decided: null, evidence: "live" });
        expect(readRawRoom("live-room", root).chief.state).toBe("running");
        expect(deskPuts()).toBe(0);
        expect(sends()).toBe(0);
      });

      it("fails a dead runner without a result only on manual reconcile after the grace", async () => {
        await writeRooms([missionRoom("dead-room")]);
        writeArtifacts("dead-room", {});
        await bindLiveChief();
        const early = await reconcile("dead-room", { hook: true });
        expect(early.decided).toBeNull();
        const fresh = missionRoom("dead-fresh", {
          launch: { launchedAt: new Date(NOW - 5000).toISOString() },
        });
        await writeRooms([fresh]);
        writeArtifacts("dead-fresh", {});
        expect((await reconcile("dead-fresh")).decided).toBeNull();
        const manual = await reconcile("dead-room");
        expect(manual).toMatchObject({ state: "failed", reason: "runner_exited_without_result" });
        expect(deskPuts()).toBe(1);
        expect(sends()).toBe(1);
      });

      it("ignores a foreign event and a malformed manifest instead of inferring success", async () => {
        await writeRooms([missionRoom("foreign-room"), missionRoom("bad-room")]);
        writeArtifacts("foreign-room", {
          result: { status: "completed", task_outcome: "complete", exit_code: 0 },
          event: { event_id: HEX, result_path: path.join(tmp, "other-result.json") },
        });
        writeArtifacts("bad-room", { manifest: "{not json" });
        for (const roomId of ["foreign-room", "bad-room"]) {
          const outcome = await reconcile(roomId, { hook: true });
          expect(outcome.decided).toBeNull();
          expect(readRawRoom(roomId, root).chief.state).toBe("running");
        }
        expect(deskPuts()).toBe(0);
      });

      it("ignores events from a superseded steering segment", async () => {
        await writeRooms([missionRoom("steer-room", { launch: { pid: process.pid } })]);
        const old = writeArtifacts("steer-room", {
          result: { status: "completed", task_outcome: "complete", exit_code: 0 },
          event: true,
        });
        writeArtifacts("steer-room", {
          manifest: { pid: process.pid },
          eventHex: OTHER_HEX,
          steering: {
            schema: "agent-executor.steering.v1",
            result_path: path.join(old.jobDir, "run", "segment-2", "result.json"),
            completion_event_path: path.join(completionDir(), `${OTHER_HEX}.json`),
            completion_event_id: OTHER_HEX,
          },
        });
        const outcome = await reconcile("steer-room", { hook: true });
        expect(outcome.decided).toBeNull();
        expect(readRawRoom("steer-room", root).chief.state).toBe("running");
      });

      it("never duplicates a child done report and records a later failure separately", async () => {
        await writeRooms([
          missionRoom("child-done", { launch: { pid: process.pid } }),
          missionRoom("late-fail"),
        ]);
        writeArtifacts("child-done", {
          result: { status: "completed", task_outcome: "complete" },
          event: true,
        });
        await chiefSend({
          root,
          env,
          to: "chief",
          kind: "done",
          message: "all green",
          from: "child-done-orch",
          runMailbox,
          now: NOW,
          listRooms: () => listRawRooms(root),
        });
        const before = sends();
        const deskBefore = deskPuts();
        const outcome = await reconcile("child-done", { hook: true });
        expect(outcome.status).toBe("already-recorded");
        expect(deskPuts()).toBe(deskBefore);
        expect(sends()).toBe(before);
        expect(readRawRoom("child-done", root).chief.state).toBe("done");

        writeArtifacts("late-fail", { result: { status: "failed", exit_code: 1 }, event: true });
        await chiefSend({
          root,
          env,
          to: "chief",
          kind: "done",
          message: "done early",
          from: "late-fail-orch",
          runMailbox,
          now: NOW,
          listRooms: () => listRawRooms(root),
        });
        await reconcile("late-fail", { hook: true });
        expect(readRawRoom("late-fail", root).chief).toMatchObject({
          state: "done",
          exitAfterReport: { state: "failed", reason: "failed" },
        });
      });

      it("keeps a racing child done and reconcile to one completion report", async () => {
        await writeRooms([missionRoom("race-done", { launch: { pid: process.pid } })]);
        writeArtifacts("race-done", {
          result: { status: "completed", task_outcome: "complete" },
          event: true,
        });
        const send = chiefSend({
          root,
          env,
          to: "chief",
          kind: "done",
          message: "all green",
          from: "race-done-orch",
          runMailbox,
          now: NOW,
          listRooms: () => listRawRooms(root),
        });
        const reconciled = reconcile("race-done", { hook: true });
        const [sent, outcome] = await Promise.all([send, reconciled]);
        expect(["sent", "queued", "already-reported"]).toContain(sent.status);
        expect(outcome.status).toMatch(/recorded|already-recorded/u);
        expect(readRawRoom("race-done", root).chief.state).toBe("done");
        expect(deskPuts()).toBe(1);
      });

      it("handles a hook that runs before the manifest, then after it", async () => {
        await writeRooms([missionRoom("early-room", { launch: { status: "launching" } })]);
        expect(await reconcile("early-room", { hook: true })).toMatchObject({ status: "retry" });
        writeArtifacts("early-room", {
          result: { status: "completed", task_outcome: "complete" },
          event: true,
        });
        await reconcile("early-room", { hook: true });
        expect(readRawRoom("early-room", root).chief.state).toBe("done");
      });

      it("repeats reconciliation without duplicate desk items or wakes", async () => {
        await writeRooms([missionRoom("repeat-room")]);
        writeArtifacts("repeat-room", {
          result: { status: "completed", task_outcome: "complete" },
          event: true,
        });
        await bindLiveChief();
        await reconcile("repeat-room");
        await reconcile("repeat-room");
        expect(deskPuts()).toBe(1);
        expect(sends()).toBe(1);
      });

      it("resumes delivery after a crash between the desk commit and mailbox delivery", async () => {
        await writeRooms([missionRoom("crash-room")]);
        writeArtifacts("crash-room", {
          result: { status: "completed", task_outcome: "complete" },
          event: true,
        });
        await bindLiveChief();
        const crashing = vi.fn(() => {
          throw new Error("crash after the desk commit");
        });
        await expect(reconcile("crash-room", { runMailbox: crashing })).rejects.toThrow(/crash/u);
        expect(deskPuts()).toBe(1);
        expect(readRawRoom("crash-room", root).chief.report).toMatchObject({ status: "pending" });
        const resumed = await reconcile("crash-room");
        expect(resumed.delivery).toMatchObject({ status: "delivered" });
        expect(deskPuts()).toBe(1);
        expect(runMailbox.mock.calls.findLast(([args]) => args[0] === "send")[0]).toEqual(
          expect.arrayContaining(["--id", expect.stringMatching(/^chief-report-/u)]),
        );
      });

      it("serializes two reconcile processes into one desk item", async () => {
        await writeRooms([missionRoom("race-room")]);
        writeArtifacts("race-room", {
          result: { status: "completed", task_outcome: "complete" },
          event: true,
        });
        const run = () =>
          new Promise((resolve) => {
            const child = spawn(
              process.execPath,
              [
                CHIEF_BIN,
                "reconcile",
                "race-room",
                "--hook",
                "--mailbox-root",
                root,
                "--event",
                path.join(completionDir(), `${HEX}.json`),
              ],
              { env },
            );
            child.on("close", (code) => resolve(code));
          });
        const codes = await Promise.all([run(), run()]);
        expect(codes).toEqual([0, 0]);
        expect(deskPuts()).toBe(1);
        expect(readRawRoom("race-room", root).chief.state).toBe("done");
      });

      it("does not reopen a mission after a forced close", async () => {
        await writeRooms([missionRoom("closed-room")]);
        writeArtifacts("closed-room", {
          result: { status: "completed", task_outcome: "complete" },
          event: true,
        });
        await chiefClose({
          roomId: "closed-room",
          force: true,
          root,
          env,
          now: NOW,
          runMailbox,
          peers: [],
        });
        const outcome = await reconcile("closed-room", { hook: true });
        expect(outcome.status).toBe("closed");
        expect(deskPuts()).toBe(0);
      });
    });

    describe("status observation", () => {
      // SQLite opens the room store's WAL and SHM sidecars on read; they are store plumbing, not Chief writes.
      function treeSnapshot(dir) {
        const entries = [];
        const walk = (current) => {
          const children = fs.readdirSync(current, { withFileTypes: true });
          for (const entry of children) {
            const full = path.join(current, entry.name);
            const stat = fs.lstatSync(full);
            entries.push([path.relative(dir, full), stat.size, stat.mtimeMs]);
            if (entry.isDirectory()) walk(full);
          }
        };
        walk(dir);
        return entries
          .filter(([name]) => !/^rooms\.db-(?:wal|shm)$/u.test(name))
          .sort((left, right) => left[0].localeCompare(right[0]));
      }

      it("projects completed and failed detached exits twice without writing", async () => {
        await writeRooms([missionRoom("status-done"), missionRoom("status-fail")]);
        writeArtifacts("status-done", {
          result: { status: "completed", task_outcome: "complete" },
          event: true,
        });
        writeArtifacts("status-fail", {
          result: { status: "timed_out", exit_code: 124 },
          event: true,
          eventHex: OTHER_HEX,
        });
        const before = treeSnapshot(root);
        const first = await chiefStatus({ root, env, quota: false, now: NOW, all: true });
        const second = await chiefStatus({ root, env, quota: false, now: NOW, all: true });
        const stateOf = (status, id) => status.rooms.find((room) => room.id === id)?.mission;
        expect(stateOf(first, "status-done")).toMatchObject({ state: "done" });
        expect(stateOf(second, "status-fail")).toMatchObject({
          state: "failed",
          reason: "timed_out",
        });
        expect(
          first.rooms.find((room) => room.id === "status-fail").attention.map((item) => item.kind),
        ).not.toContain("stale-coordinator");
        expect(treeSnapshot(root)).toEqual(before);
        expect(readRawRoom("status-done", root).chief.state).toBe("running");
      });
    });

    describe("digest, acknowledgment and close", () => {
      function sessionFor(roomId) {
        return `${roomId}-orch`;
      }

      async function setupRooms(count) {
        const rooms = [];
        for (let index = 0; index < count; index++) {
          const roomId = `digest-${index}`;
          rooms.push(missionRoom(roomId, { chiefState: "running" }));
        }
        await writeRooms(rooms);
        return rooms.map((item) => item.id).slice(0, count);
      }

      it("renders fifty records across five rooms in fifteen lines and three per room", async () => {
        await bindLiveChief();
        const ids = await setupRooms(5);
        for (const roomId of ids)
          for (let index = 0; index < 10; index++)
            writeInbox(root, "chief-live", {
              from: { session: sessionFor(roomId), name: roomId },
              text: index % 3 === 0 ? `[chief:question] q${index}` : `[chief:update] u${index}`,
              sentAt: new Date(NOW - index * 1000).toISOString(),
            });
        const out = capture();
        await chiefCommand(["inbox"], {
          stdout: out,
          root,
          env,
          listRooms: () => listRawRooms(root),
        });
        const lines = out.text().trimEnd().split("\n");
        expect(lines.length).toBeLessThanOrEqual(15);
        const headers = lines.filter((line) => !line.startsWith("  ") && !line.startsWith("…"));
        expect(headers).toHaveLength(5);
        const payload = await chiefInbox({
          root,
          env,
          listRooms: () => listRawRooms(root),
          peers: [],
        });
        const byName = (left, right) => left.localeCompare(right);
        expect(payload.groups.map((group) => group.roomId).toSorted(byName)).toEqual(
          ids.toSorted(byName),
        );
        expect(payload.groups.every((group) => group.inboxIds.length === 10)).toBe(true);
      });

      it("keeps an old unread ask behind two hundred newer read files", async () => {
        await bindLiveChief();
        await setupRooms(1);
        writeInbox(root, "chief-live", {
          from: { session: sessionFor("digest-0"), name: "old" },
          text: "[chief:question] needs an answer",
          sentAt: new Date(NOW - 10 * 86_400_000).toISOString(),
        });
        for (let index = 0; index < 250; index++)
          writeInbox(root, "chief-live", {
            readAt: new Date(NOW).toISOString(),
            from: { session: "noise" },
            text: "old read",
            sentAt: new Date(NOW).toISOString(),
          });
        const payload = await chiefInbox({
          root,
          env,
          listRooms: () => listRawRooms(root),
          peers: [],
        });
        const asks = payload.groups.flatMap((group) => group.asks.map((ask) => ask.text));
        expect(asks).toContain("needs an answer");
      });

      it("clips digest lines by terminal cells, including wide text", async () => {
        await bindLiveChief();
        await writeRooms([missionRoom("wide-room")]);
        writeInbox(root, "chief-live", {
          from: { session: "wide-room-orch", name: "wide-room" },
          text: `[chief:question] ${"界面問題🙂".repeat(20)}`,
          sentAt: new Date(NOW).toISOString(),
        });
        const out = { ...capture(), columns: 48 };
        await chiefCommand(["inbox"], {
          stdout: out,
          root,
          env,
          listRooms: () => listRawRooms(root),
        });
        for (const line of out.text().trimEnd().split("\n"))
          expect(displayWidth(line)).toBeLessThanOrEqual(48);
      });

      it("collapses six rooms into four groups plus a footer within fifteen lines", async () => {
        await bindLiveChief();
        for (let index = 0; index < 6; index++) {
          await writeRooms([missionRoom(`six-${index}`)]);
          writeInbox(root, "chief-live", {
            from: { session: `six-${index}-orch`, name: `six-${index}` },
            text: "[chief:question] needs you",
            sentAt: new Date(NOW - index).toISOString(),
          });
        }
        const out = capture();
        await chiefCommand(["inbox"], {
          stdout: out,
          root,
          env,
          listRooms: () => listRawRooms(root),
        });
        const lines = out.text().trimEnd().split("\n");
        expect(lines.length).toBeLessThanOrEqual(15);
        expect(lines.at(-1)).toMatch(/2 more rooms/u);
      });

      it("shows one logical report for a desk item and its mailbox copy", async () => {
        await bindLiveChief();
        await writeRooms([missionRoom("digest-0")]);
        writeArtifacts("digest-0", {
          result: { status: "timed_out", exit_code: 124 },
          event: true,
        });
        await reconcile("digest-0");
        const [desk] = listDesk(root);
        // The mailbox copy carries the same stable report ID, so the digest shows one logical report.
        writeInbox(root, "chief-live", {
          clientId: desk.id,
          from: { session: "digest-0-orch", name: "digest-0" },
          text: "[chief:escalation] digest-0 failed: timed_out",
          sentAt: new Date(NOW).toISOString(),
        });
        const payload = await chiefInbox({
          root,
          env,
          listRooms: () => listRawRooms(root),
          peers: [],
        });
        const group = payload.groups.find((item) => item.roomId === "digest-0");
        expect(group.asks).toHaveLength(1);
        expect(group.deskIds).toEqual([desk.id]);
        expect(group.inboxIds).toHaveLength(1);
      });

      it("places unattributed mail in its own group and never trusts a forged legacy file field", async () => {
        await bindLiveChief();
        writeInbox(root, "chief-live", {
          from: { session: "stranger", name: "stranger" },
          text: "hello",
        });
        const legacy = path.join(root, "chief", "desk");
        fs.mkdirSync(legacy, { recursive: true });
        fs.writeFileSync(
          path.join(legacy, "legacy-1.json"),
          JSON.stringify({ text: "old", kind: "update", from: "x", file: "/outside" }),
        );
        const payload = await chiefInbox({
          root,
          env,
          listRooms: () => listRawRooms(root),
          peers: [],
        });
        expect(payload.groups.map((group) => group.roomId)).toEqual([null]);
        const items = listDesk(root);
        expect(items).toEqual([expect.objectContaining({ id: "legacy:legacy-1" })]);
        expect(items[0].file).toBe(path.join(root, "chief", "desk", "legacy-1.json"));
        await chiefDesk({
          root,
          env,
          ack: true,
          snapshot: { session: null, revision: null, deskIds: ["legacy:legacy-1"], inboxIds: [] },
          runMailbox,
        });
        expect(listDesk(root)).toEqual([]);
      });

      it("acknowledges only the snapshot, survives arrivals, and rejects rebinding or foreign IDs", async () => {
        const bound = await bindLiveChief();
        writeInbox(root, "chief-live", {
          from: { session: "stranger", name: "stranger" },
          text: "first",
        });
        const snapshotDigest = await chiefInbox({
          root,
          env,
          listRooms: () => listRawRooms(root),
          peers: [],
        });
        const inboxIds = snapshotDigest.groups.flatMap((group) => group.inboxIds);
        writeInbox(root, "chief-live", {
          from: { session: "stranger", name: "stranger" },
          text: "arrived later",
        });
        const snapshot = {
          session: "chief-live",
          revision: String(bound.revision ?? readChiefBinding({ root, now: NOW }).revision),
          deskIds: [],
          inboxIds,
        };
        await chiefDesk({
          root,
          env,
          ack: true,
          snapshot,
          runMailbox: ackingMailbox(),
          now: NOW,
          listRooms: () => listRawRooms(root),
          peers: undefined,
        });
        const remaining = await chiefInbox({
          root,
          env,
          listRooms: () => listRawRooms(root),
          peers: [],
        });
        expect(remaining.groups.flatMap((group) => group.asks.map((ask) => ask.text))).toEqual([
          "arrived later",
        ]);
        await expect(
          chiefDesk({
            root,
            env,
            ack: true,
            snapshot: { ...snapshot, session: "someone-else" },
            runMailbox: ackingMailbox(),
            now: NOW,
          }),
        ).rejects.toMatchObject({ code: "snapshot_changed" });
        await expect(
          chiefDesk({
            root,
            env,
            ack: true,
            snapshot: { session: null, revision: null, deskIds: ["forged"], inboxIds: [] },
            runMailbox: ackingMailbox(),
            now: NOW,
          }),
        ).rejects.toMatchObject({ code: "snapshot_stale" });
      });

      it("retries a failed mailbox ack without losing items or re-hiding arrivals", async () => {
        await bindLiveChief();
        writeInbox(root, "chief-live", {
          id: "ack-1",
          from: { session: "stranger", name: "stranger" },
          text: "retry me",
        });
        const failing = mailboxMock(1, "");
        await expect(
          chiefInbox({
            root,
            env,
            ack: true,
            runMailbox: failing,
            listRooms: () => listRawRooms(root),
            peers: [],
          }),
        ).rejects.toThrow(/Mailbox acknowledgment failed/u);
        const hidden = await chiefInbox({
          root,
          env,
          listRooms: () => listRawRooms(root),
          peers: [],
        });
        expect(hidden.groups).toEqual([]);
        const retried = await chiefInbox({
          root,
          env,
          ack: true,
          runMailbox: ackingMailbox(),
          listRooms: () => listRawRooms(root),
          peers: [],
        });
        expect(retried.groups).toEqual([]);
        const transactions = readdirSync(path.join(root, "chief", "ack-transactions")).map((file) =>
          JSON.parse(fs.readFileSync(path.join(root, "chief", "ack-transactions", file), "utf8")),
        );
        expect(transactions.length).toBeGreaterThan(0);
        expect(transactions.every((record) => record.state === "complete")).toBe(true);
      });

      it("closes by ID and repeats safely, rejects live and standalone targets, and leaves other rooms visible", async () => {
        await writeRooms([
          missionRoom("close-me"),
          missionRoom("keep-me"),
          missionRoom("live-one", { launch: { pid: process.pid } }),
        ]);
        await bindLiveChief();
        writePeer(root, {
          session: "live-one-orch",
          name: "live-coordinator",
          cwd: repo,
          pid: process.pid,
          state: "busy",
        });
        await expect(
          chiefClose({ roomId: "live-one", root, env, now: NOW, runMailbox, peers: [] }),
        ).rejects.toMatchObject({ code: "room_live" });
        const first = await chiefClose({
          roomId: "close-me",
          root,
          env,
          now: NOW,
          runMailbox,
          peers: [],
        });
        expect(first).toMatchObject({
          schema: "ork.chief.close.v1",
          roomId: "close-me",
          status: "closed",
        });
        expect(readRawRoom("close-me", root)).toMatchObject({
          status: "closed",
          closedAt: expect.any(String),
        });
        const again = await chiefClose({
          roomId: "close-me",
          root,
          env,
          now: NOW,
          runMailbox,
          peers: [],
        });
        expect(again.status).toBe("already-closed");
        await expect(
          chiefClose({
            roomId: "standalone-peer",
            target: "lead-two",
            root,
            env,
            now: NOW,
            runMailbox,
            peers: [],
          }),
        ).rejects.toThrow();
        const status = await chiefStatus({ root, env, quota: false, now: NOW, peers: [] });
        const ids = status.rooms.map((item) => item.id);
        expect(ids).toContain("keep-me");
        expect(ids).not.toContain("close-me");
        const all = await chiefStatus({ root, env, quota: false, now: NOW, all: true, peers: [] });
        expect(all.rooms.map((item) => item.id)).not.toContain("close-me");
      });

      it("clears a closed mission's desk attention by ID", async () => {
        await writeRooms([missionRoom("desk-room")]);
        writeArtifacts("desk-room", { result: { status: "failed", exit_code: 1 }, event: true });
        await reconcile("desk-room");
        expect(listDesk(root).map((item) => item.roomId)).toEqual(["desk-room"]);
        await chiefClose({ roomId: "desk-room", root, env, now: NOW, runMailbox, peers: [] });
        expect(listDesk(root)).toEqual([]);
      });
    });

    describe("interactive launch", () => {
      const tmuxLog = () => path.join(tmp, "tmux.log");
      const tmuxEnv = (extra = {}) => ({
        ...env,
        TMUX_PANE: "%3",
        TMUX: "/tmp/tmux-socket,1234,0",
        ...extra,
      });

      function fakeBinary(name, script) {
        const file = path.join(tmp, "bin", name);
        fs.writeFileSync(file, `#!/bin/sh\n${script}\n`);
        fs.chmodSync(file, 0o755);
      }

      beforeEach(() => {
        fakeBinary(
          "tmux",
          `if [ "$1" = display-message ]; then echo %3; exit 0; fi\nprintf '%s\\n' "$@" '--' >> '${tmuxLog()}'\nif [ "$1" = new-window ]; then echo %9; fi`,
        );
      });

      it("asks the detached gate's own quota check when no decision is injected", async () => {
        // No monitor answers: the real quota.check reports unknown, so preflight refuses before any mutation.
        const spawning = chiefSpawn({
          cwd: repo,
          goal: "x",
          interactive: true,
          root,
          env: tmuxEnv({ MONITOR_BIN: path.join(tmp, "no-such-monitor") }),
        });
        await expect(spawning).rejects.toMatchObject({ code: "interactive_unavailable" });
        expect(listRawRooms(root)).toEqual([]);
        expect(fs.existsSync(path.join(root, "chief", "missions"))).toBe(false);
      });

      it("applies the detached gate's quota decision to the interactive route", async () => {
        const decide = (decision) => async () => decision;
        await expect(
          chiefSpawn({
            cwd: repo,
            goal: "x",
            interactive: true,
            root,
            env: tmuxEnv(),
            quotaDecision: decide({ status: "blocked", label: "claude-default" }),
          }),
        ).rejects.toThrow(/blocked/u);
        await expect(
          chiefSpawn({
            cwd: repo,
            goal: "x",
            interactive: true,
            root,
            env: tmuxEnv(),
            quotaDecision: decide({ status: "credits", label: "codex" }),
          }),
        ).rejects.toThrow(/credits/u);
        await expect(
          chiefSpawn({
            cwd: repo,
            goal: "x",
            interactive: true,
            root,
            env: tmuxEnv(),
            quotaDecision: decide({ status: "unknown" }),
          }),
        ).rejects.toMatchObject({ code: "interactive_unavailable" });
        const low = await chiefSpawn({
          cwd: repo,
          goal: "x",
          interactive: true,
          dryRun: true,
          root,
          env: tmuxEnv(),
          quotaDecision: decide({ status: "low", label: "claude-default" }),
        });
        expect(low.warnings.join(" ")).toMatch(/low on included quota/u);
        expect(listRawRooms(root)).toEqual([]);
      });

      it("hands the brief to the harness and resolves its reply to the mission session", async () => {
        const realPython = spawnSync("python3", ["-c", "import sys;print(sys.executable)"], {
          encoding: "utf8",
        }).stdout.trim();
        const briefCopy = path.join(tmp, "harness-brief.txt");
        const sessionCopy = path.join(tmp, "harness-session.txt");
        // Deterministic stand-ins: python runs the statusline wrapper's harness argv directly, the harness
        // records what it received, replies through the real local mailbox, and tmux runs the launcher.
        fakeBinary(
          "python3",
          `case "$1" in *agent_statusline_tmux.py) shift; while [ "$1" != "--" ]; do shift; done; shift; exec "$@";; esac\nexec '${realPython}' "$@"`,
        );
        fakeBinary(
          "claude",
          `printf '%s' "$1" > '${briefCopy}'\nprintf '%s' "$AGENT_MAILBOX_SESSION" > '${sessionCopy}'\n'${process.execPath}' '${ORK_BIN}' chief send --from "$AGENT_MAILBOX_SESSION" --to chief --kind update 'reply: brief received'`,
        );
        fakeBinary(
          "tmux",
          `if [ "$1" = display-message ]; then echo %3; exit 0; fi\nfor last; do :; done\nif [ "$1" = new-window ]; then sh "$last" >/dev/null 2>&1; echo %9; fi`,
        );
        root = path.join(cache, "mailbox-v1");
        fs.mkdirSync(root, { recursive: true });
        await bindLiveChief();
        writePeer(root, {
          session: "chief-brief-orch",
          name: "brief-orch",
          cwd: repo,
          pid: process.pid,
        });
        const result = await chiefSpawn({
          cwd: repo,
          goal: "Trace the flaky parser test",
          title: "brief",
          worktree: "brief",
          interactive: true,
          quotaDecision: async () => ({ status: "available", label: "claude-default" }),
          root,
          env: tmuxEnv({
            PATH: `${path.join(tmp, "bin")}${path.delimiter}${process.env.PATH}`,
            ORCHESTRATE_HOME: cache,
          }),
          now: NOW,
        });
        expect(result).toMatchObject({ status: "launched", roomId: "chief-brief" });
        expect(fs.readFileSync(briefCopy, "utf8")).toContain("Trace the flaky parser test");
        expect(fs.readFileSync(sessionCopy, "utf8")).toBe("chief-brief-orch");
        const inbox = path.join(root, "inbox", sessionKey("chief-live"));
        const replies = fs
          .readdirSync(inbox)
          .map((file) => JSON.parse(fs.readFileSync(path.join(inbox, file), "utf8")))
          .filter((message) => message.text.includes("reply: brief received"));
        expect(replies).toHaveLength(1);
        expect(replies[0].from).toMatchObject({ session: "chief-brief-orch" });
      });

      it("previews a tmux launch and performs no mutation on dry-run", async () => {
        const plan = await chiefSpawn({
          cwd: repo,
          goal: "Tidy",
          interactive: true,
          quotaDecision: quotaOk,
          dryRun: true,
          root,
          env: tmuxEnv(),
        });
        expect(plan).toMatchObject({ backend: "tmux", status: "planned" });
        expect(plan.command.slice(0, 9)).toEqual([
          "tmux",
          "new-window",
          "-d",
          "-P",
          "-F",
          "#{pane_id}",
          "-t",
          "%3",
          "-c",
        ]);
        expect(fs.existsSync(path.join(root, "chief"))).toBe(false);
        expect(listRawRooms(root)).toEqual([]);
        expect(fs.existsSync(tmuxLog())).toBe(false);
      });

      it("launches one tmux pane and persists its identity on conductor and launch", async () => {
        const launch = vi.fn();
        const result = await chiefSpawn({
          cwd: repo,
          goal: "Tidy",
          interactive: true,
          quotaDecision: quotaOk,
          root,
          env: tmuxEnv(),
          launch,
          now: NOW,
        });
        expect(result).toMatchObject({
          status: "launched",
          launch: {
            backend: "tmux",
            paneId: "%9",
            tmuxPane: "%9",
            terminalServer: "/tmp/tmux-socket",
          },
        });
        expect(launch).not.toHaveBeenCalled();
        const log = fs.readFileSync(tmuxLog(), "utf8");
        expect(log.match(/new-window/gu)).toHaveLength(1);
        expect(log).toContain(repo);
        const saved = readRawRoom(result.roomId, root);
        expect(saved.chief.launch).toMatchObject({
          mode: "interactive",
          backend: "tmux",
          paneId: "%9",
        });
        expect(saved.conductor).toMatchObject({
          tmuxPane: "%9",
          paneId: "%9",
          terminalServer: "/tmp/tmux-socket",
        });
        expect(fs.existsSync(path.join(root, "chief", "hooks"))).toBe(false);
      });

      it("fails preflight before any room exists when the multiplexer is unusable", async () => {
        await expect(
          chiefSpawn({
            cwd: repo,
            goal: "x",
            interactive: true,
            quotaDecision: quotaOk,
            root,
            env: tmuxEnv({ TMUX_PANE: "%4" }),
          }),
        ).rejects.toMatchObject({ code: "interactive_unavailable" });
        await expect(
          chiefSpawn({
            cwd: repo,
            goal: "x",
            interactive: true,
            quotaDecision: quotaOk,
            root,
            env: { ...env, PATH: path.join(tmp, "bin"), HERDR_ENV: "1" },
          }),
        ).rejects.toMatchObject({ code: "interactive_unavailable" });
        await expect(
          chiefSpawn({
            cwd: repo,
            goal: "x",
            interactive: true,
            quotaDecision: quotaOk,
            root,
            env: env,
          }),
        ).rejects.toMatchObject({ code: "interactive_unavailable" });
        await expect(
          chiefSpawn({
            cwd: repo,
            goal: "x",
            interactive: true,
            quotaDecision: quotaOk,
            engine: "agy",
            root,
            env: tmuxEnv(),
          }),
        ).rejects.toThrow(/Interactive launch supports/u);
        await expect(
          chiefSpawn({
            cwd: repo,
            goal: "x",
            interactive: true,
            quotaDecision: quotaOk,
            timeout: "1h",
            root,
            env: tmuxEnv(),
          }),
        ).rejects.toThrow(/--timeout/u);
        expect(listRawRooms(root)).toEqual([]);
      });

      it("records a partial launch failure and never retries it", async () => {
        const exec = vi.fn((file, args) => {
          if (args[0] === "display-message") return "%3\n";
          throw new Error("split refused");
        });
        const result = await chiefSpawn({
          cwd: repo,
          goal: "x",
          interactive: true,
          quotaDecision: quotaOk,
          root,
          env: tmuxEnv(),
          interactiveExec: exec,
          now: NOW,
        });
        expect(result).toMatchObject({
          status: "failed",
          error: expect.stringMatching(/split refused/u),
        });
        expect(readRawRoom(result.roomId, root).chief.state).toBe("failed");
        expect(exec.mock.calls.filter(([, args]) => args[0] === "new-window")).toHaveLength(1);
      });

      it("treats a timed-out Orca split as unconfirmed rather than launching again", async () => {
        const exec = vi.fn((file, args) => {
          if (args[1] === "split") throw Object.assign(new Error("timeout"), { killed: true });
          return "";
        });
        const orcaEnv = {
          ...env,
          ORCA_PANE_KEY: "pane-k",
          ORCA_TERMINAL_HANDLE: "term_1",
          ORCA_CLI_COMMAND: "orca",
        };
        fakeBinary("orca", "exit 0");
        const result = await chiefSpawn({
          cwd: repo,
          goal: "x",
          interactive: true,
          quotaDecision: quotaOk,
          root,
          env: orcaEnv,
          interactiveExec: exec,
          now: NOW,
        });
        expect(result.status).toBe("failed");
        expect(result.error).toMatch(/did not confirm/u);
        expect(exec.mock.calls.filter(([, args]) => args[1] === "split")).toHaveLength(1);
      });

      it("opens a Herdr pane and persists the pane and endpoint", async () => {
        const exec = vi.fn((file, args) => {
          if (args[0] === "pane" && args[1] === "split")
            return JSON.stringify({ result: { pane: { pane_id: "w1-2" } } });
          return "";
        });
        const herdrEnv = { ...env, HERDR_ENV: "1", HERDR_PANE_ID: "w1-1" };
        fakeBinary("herdr", "exit 0");
        const result = await chiefSpawn({
          cwd: repo,
          goal: "x",
          interactive: true,
          quotaDecision: quotaOk,
          root,
          env: herdrEnv,
          interactiveExec: exec,
          now: NOW,
        });
        expect(result).toMatchObject({
          status: "launched",
          launch: { backend: "herdr", herdrPaneId: "w1-2" },
        });
        expect(
          exec.mock.calls.some(([, args]) => args.includes(repo) && args.includes("--no-focus")),
        ).toBe(true);
        expect(readRawRoom(result.roomId, root).conductor).toMatchObject({ herdrPaneId: "w1-2" });
      });
    });
  });
});
