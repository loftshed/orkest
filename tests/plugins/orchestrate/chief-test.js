import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { chiefCommand, renderChiefStatus } from "../../../plugins/orchestrate/bin/chief.mjs";
import {
  bindChief,
  chiefPath,
  chiefSend,
  chiefSpawn,
  chiefStatus,
  listDesk,
  missionBrief,
  readChiefBinding,
  readPeers,
  resolveChiefTarget,
  sessionKey,
} from "../../../plugins/orchestrate/lib/chief.mjs";
import { listRawRooms, readRawRoom } from "../../../plugins/orchestrate/lib/horde-room.mjs";

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
    env = {
      PATH: process.env.PATH,
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

    it("resolves a room ID and delivers through peer_mailbox with wake", async () => {
      const runMailbox = mailboxMock();
      const result = await chiefSend({
        root,
        env,
        to: "room-1",
        message: "please rebase",
        from: "me",
        kind: "update",
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
    const pluginRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../plugins/orchestrate",
    );
    const skillText = fs.readFileSync(path.join(pluginRoot, "skills/chief/SKILL.md"), "utf8");
    const commandText = fs.readFileSync(path.join(pluginRoot, "commands/chief.md"), "utf8");
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
      await new Promise((resolve) => locker.on("close", resolve));
      await expect(clearPromise).rejects.toThrow(/conflict/u);
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
});
