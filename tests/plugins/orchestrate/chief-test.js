import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { chiefCommand, renderChiefStatus } from "../../../plugins/orchestrate/bin/chief.mjs";
import {
  bindChief,
  chiefPath,
  chiefSend,
  chiefSpawn,
  chiefStatus,
  listDesk,
  readChiefBinding,
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
      const forced = await bindChief({ root, env, session: "x", clear: true, force: true });
      expect(forced.action).toBe("cleared");
      expect(fs.existsSync(chiefPath(root))).toBe(false);
      expect((await bindChief({ root, env, session: "x", clear: true })).action).toBe("none");

      writePeer(root, { session: "dead", name: "dead", cwd: tmp, pid: deadPid() });
      await bindChief({ root, env, session: "dead", runMailbox: mailboxMock(), now: NOW });
      const cleared = await bindChief({ root, env, session: "someone", clear: true, now: NOW });
      expect(cleared.action).toBe("cleared");
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
});
