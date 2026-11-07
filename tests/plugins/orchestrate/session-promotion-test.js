import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { roomsCommand } from "../../../plugins/orchestrate/bin/rooms.mjs";
import { herdrEndpoint } from "../../../plugins/orchestrate/lib/herdr-context.mjs";
import {
  listRawRooms,
  parseTeam,
  readRoom,
  updateRoom,
} from "../../../plugins/orchestrate/lib/horde-room.mjs";
import { openOrkestSqlite } from "../../../plugins/orchestrate/lib/orkest-sqlite.mjs";
import { resumeRoomStatus } from "../../../plugins/orchestrate/lib/room-resume.mjs";
import {
  bindSession,
  interactiveProgress,
  newRoom,
  resolveSessionPeer,
} from "../../../plugins/orchestrate/lib/rooms.mjs";
import { promoteSession } from "../../../plugins/orchestrate/lib/session-promotion.mjs";

const directories = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(changes = {}) {
  const temporary = await mkdtemp(path.join(tmpdir(), "ork-promote-"));
  const directory = await realpath(temporary);
  directories.push(directory);
  const root = path.join(directory, "mailbox-v1");
  const cwd = path.join(directory, "checkout");
  await mkdir(cwd);
  await mkdir(path.join(root, "peers"), { recursive: true });
  const peer = {
    schema: "agent-executor.peer.v1",
    session: "live-session",
    harness: "codex",
    name: "nova-sol-demo-01",
    cwd,
    checkout: cwd,
    machine: hostname(),
    pid: process.pid,
    state: "busy",
    startedAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    herdrPaneId: "w1:p2",
    herdrWorkspaceId: "w1",
    herdrEndpoint: path.join(directory, "herdr.sock"),
    model: "gpt:sol",
    ...changes,
  };
  const peerFile = path.join(root, "peers/live-session.json");
  await writeFile(peerFile, JSON.stringify(peer));
  const refreshed = [];
  const options = {
    root,
    env: {},
    refresh: async ({ room, peer: target }) => {
      refreshed.push({ room: room.id, session: target.session });
      return { attempted: true };
    },
  };
  return { root, cwd, peer, options, refreshed, directory };
}

describe("adopting the running conversation", () => {
  it("resolves attested native IDs consistently and repairs a binding while ignoring unrelated aliases", async () => {
    const { cwd, root, options, peer } = await fixture({
      nativeSession: "native-owner",
      nativeSessions: ["native-owner"],
      focus: "Repair resume",
    });
    const first = await promoteSession(
      { session: peer.session, cwd, objective: "Keep the swarm" },
      options,
    );
    await updateRoom(
      first.room.id,
      (room) => {
        room.conductor.session.id = "native-owner";
        return room;
      },
      { root },
    );
    const collisions = Object.entries({
      subagent: { isSubagent: true, nativeSessions: ["native-owner"] },
      delegated: { delegatedRun: "run-x", nativeSessions: ["native-owner"] },
      unrelated: { cwd: root, checkout: root, nativeSessions: ["native-owner"] },
      wrongHarness: { harness: "claude", nativeSessions: ["native-owner"] },
      freeAlias: { aliases: ["native-owner"] },
    });
    for (const [id, changes] of collisions)
      await writeFile(
        path.join(root, "peers", `${id}.json`),
        JSON.stringify({
          ...peer,
          nativeSession: undefined,
          nativeSessions: [],
          session: id,
          ...changes,
        }),
      );
    expect((await resolveSessionPeer("native-owner", root, { engine: "codex", cwd })).session).toBe(
      peer.session,
    );
    const progress = await interactiveProgress(await readRoom(first.room.id, root), root);
    expect(progress.conductor).toMatchObject({
      name: peer.name,
      model: "gpt:sol",
      task: "Repair resume",
    });
    const repaired = await bindSession(first.room.id, "conductor", {
      session: peer.session,
      engine: "codex",
      root,
      repairOnly: true,
    });
    expect(repaired.conductor.session.id).toBe(peer.session);
    expect(repaired.conductor.previousSessions).toContain("native-owner");
    const promoted = await promoteSession(
      { session: "native-owner", engine: "codex", cwd },
      options,
    );
    expect(promoted.room.id).toBe(first.room.id);
    expect(promoted.session).toBe(peer.session);
  });

  it.each(["aliases", "nativeSessions"])(
    "cannot hijack a live promoted coordinator through another peer's %s",
    async (field) => {
      const { cwd, root, options, peer } = await fixture();
      const first = await promoteSession({ session: peer.session, cwd }, options);
      await updateRoom(
        first.room.id,
        (room) => {
          room.conductor.session.id = "unattested-native";
          return room;
        },
        { root },
      );
      await writeFile(
        path.join(root, "peers/attacker.json"),
        JSON.stringify({ ...peer, session: "attacker", [field]: ["unattested-native"] }),
      );
      const before = await readRoom(first.room.id, root);
      await expect(
        promoteSession({ session: "attacker", cwd, room: first.room.id }, options),
      ).rejects.toThrow("another coordinator");
      await expect(
        bindSession(first.room.id, "conductor", { session: "attacker", engine: "codex", root }),
      ).rejects.toThrow("attested peer");
      expect(await readRoom(first.room.id, root)).toEqual(before);
    },
  );

  it("uses room history on a later resume and compares symlink-resolved checkouts", async () => {
    const { cwd, root, directory, options, peer } = await fixture();
    const alias = path.join(directory, "checkout-link");
    await symlink(cwd, alias);
    const first = await promoteSession({ session: peer.session, cwd }, options);
    await rm(path.join(root, "peers/live-session.json"));
    await writeFile(
      path.join(root, "peers/later-resume.json"),
      JSON.stringify({ ...peer, session: "later-resume" }),
    );
    await updateRoom(
      first.room.id,
      (room) => {
        room.cwd = alias;
        room.conductor.session.id = "recent-session";
        room.conductor.previousSessions = ["original-native"];
        room.promotion.session = "recent-session";
        return room;
      },
      { root },
    );
    const result = await promoteSession(
      { session: "later-resume", cwd },
      { ...options, env: { ORKEST_RESUME_SWARM: "1", ORKEST_RESUME_TARGET: "original-native" } },
    );
    expect(result.room.id).toBe(first.room.id);
    const again = await promoteSession(
      { session: "later-resume", cwd },
      { ...options, env: { ORKEST_RESUME_SWARM: "1", ORKEST_SWARM_ROOM: first.room.id } },
    );
    expect(again.room.id).toBe(first.room.id);
    expect(listRawRooms(root)).toHaveLength(1);
  });

  it("reports legacy resume rooms without creating SQLite or changing their bytes", async () => {
    const { cwd, root, directory } = await fixture();
    await mkdir(path.join(root, "rooms"));
    const alias = path.join(directory, "link");
    await symlink(cwd, alias);
    for (const [id, machine] of [
      ["legacy-no-machine", undefined],
      ["legacy-with-machine", hostname()],
    ]) {
      const file = path.join(root, "rooms", `${id}.json`);
      await writeFile(
        file,
        JSON.stringify({
          schema: "agent-executor.room.v1",
          id,
          machine,
          cwd: alias,
          swarm: {},
          title: "resume old-native",
          conductor: {},
          agents: [],
        }),
      );
    }
    const before = await Promise.all(
      (await readdir(path.join(root, "rooms"))).map((file) =>
        readFile(path.join(root, "rooms", file), "utf8"),
      ),
    );
    const report = await resumeRoomStatus({ root, cwd });
    expect(report.rooms.map((room) => room.id).sort((a, b) => a.localeCompare(b))).toEqual([
      "legacy-no-machine",
      "legacy-with-machine",
    ]);
    expect(report.rooms.map((room) => room.state)).toEqual(["unbound", "unbound"]);
    expect(await readdir(root)).toEqual(["peers", "rooms"]);
    const files = await readdir(path.join(root, "rooms"));
    const after = await Promise.all(
      files.map((file) => readFile(path.join(root, "rooms", file), "utf8")),
    );
    expect(after).toEqual(before);
  });

  it("exposes a read-only SQLite resume report through the CLI", async () => {
    const { cwd, root, options, peer } = await fixture();
    const first = await promoteSession({ session: peer.session, cwd }, options);
    const files = await readdir(root);
    const before = await readFile(path.join(root, "rooms.db"));
    let output = "";
    const report = await roomsCommand(["resume-status", "--cwd", cwd, "--json"], {
      root,
      env: {},
      stdout: {
        write(text) {
          output += text;
        },
      },
    });
    expect(report.rooms).toMatchObject([
      { id: first.room.id, state: "live", session: peer.session },
    ]);
    expect(JSON.parse(output)).toEqual(report);
    expect(await readdir(root)).toEqual(files);
    expect(await readFile(path.join(root, "rooms.db"))).toEqual(before);
  });

  it("reads committed WAL state without modifying the active database or its sidecars", async () => {
    const { cwd, root, options, peer } = await fixture();
    const first = await promoteSession({ session: peer.session, cwd }, options);
    using writer = openOrkestSqlite(path.join(root, "rooms.db"));
    writer.exec("UPDATE rooms SET data = json_set(data, '$.title', 'Committed WAL')");
    const files = ["rooms.db", "rooms.db-wal", "rooms.db-shm"];
    const before = await Promise.all(files.map((file) => readFile(path.join(root, file))));
    const report = await resumeRoomStatus({ root, cwd });
    expect(report.rooms).toMatchObject([
      { id: first.room.id, title: "Committed WAL", state: "live" },
    ]);
    const after = await Promise.all(files.map((file) => readFile(path.join(root, file))));
    expect(after).toEqual(before);
  });
  it.each(["claude", "codex", "gemini"])(
    "reuses a %s coordinator's room after SessionEnd removed its peer",
    async (harness) => {
      const { cwd, root, options, peer } = await fixture({ harness });
      const first = await promoteSession({ session: peer.session, cwd }, options);
      await updateRoom(
        first.room.id,
        (room) => {
          room.conductor.session.id = "old-visible-native";
          return room;
        },
        { root },
      );
      await rm(path.join(root, "peers/live-session.json"));
      await writeFile(
        path.join(root, "peers/resumed-session.json"),
        JSON.stringify({
          ...peer,
          session: "resumed-session",
          name: "resumed-coordinator",
          focus: "Finish the repair",
        }),
      );
      const resumed = await promoteSession(
        { session: "resumed-session", cwd },
        {
          ...options,
          env: { ORKEST_RESUME_SWARM: "1", ORKEST_RESUME_TARGET: peer.session },
        },
      );
      expect(resumed.room.id).toBe(first.room.id);
      expect(resumed.room.conductor.session.id).toBe("resumed-session");
      expect(resumed.room.conductor.previousSessions).toEqual(["old-visible-native", peer.session]);
      expect(listRawRooms(root)).toHaveLength(1);
    },
  );
  it("binds the registered session as coordinator without replacing the chat and refreshes native metadata", async () => {
    const { cwd, peer, options, refreshed, root } = await fixture();
    const result = await promoteSession(
      { session: peer.session, cwd, objective: "Coordinate search work" },
      options,
    );
    expect(result.status).toBe("promoted");
    expect(result.room.conductor).toMatchObject({
      role: "lead",
      name: "nova-sol-demo-01",
      session: { id: "live-session", engine: "codex", machine: hostname(), cwd },
      herdrPaneId: "w1:p2",
    });
    expect(result.room.herdrCoordinatorPaneId).toBe("w1:p2");
    expect(result.room.herdrEndpoint).toBe(peer.herdrEndpoint);
    expect(result.room.objective).toBe("Coordinate search work");
    expect(result.brief).toContain("You are the root coordinator of an Orkest swarm.");
    expect(result.brief).toContain("Route every action:");
    expect(result.brief).toContain("live-session");
    expect(result.briefPath).toBe(path.join(root, "swarm-briefs", result.room.id, "conductor.md"));
    expect(await readFile(result.briefPath, "utf8")).toContain("Coordinate search work");
    expect(refreshed).toEqual([{ room: result.room.id, session: "live-session" }]);
    expect((await readRoom(result.room.id, root)).conductor.session.id).toBe("live-session");
    const presence = await readFile(path.join(root, "peers/live-session.json"), "utf8");
    expect(JSON.parse(presence)).toEqual(peer);
  });

  it("rejects a pane binding from another Herdr server", async () => {
    const { cwd, options, directory } = await fixture();
    options.env = {
      HERDR_ENV: "1",
      HERDR_PANE_ID: "w1:p2",
      HERDR_SOCKET_PATH: path.join(directory, "different-herdr.sock"),
    };
    expect(herdrEndpoint(options.env)).not.toBe(path.join(directory, "herdr.sock"));
    await expect(promoteSession({ session: "live-session", cwd }, options)).rejects.toThrow(
      "different Herdr server",
    );
  });

  it("repeats promotion idempotently and preserves existing workers and objective", async () => {
    const { cwd, options, root } = await fixture();
    const first = await promoteSession(
      { session: "live-session", cwd, objective: "Review search" },
      options,
    );
    await updateRoom(
      first.room.id,
      (room) => {
        room.agents.push({
          id: "worker",
          engine: "codex",
          model: "gpt:sol",
          parent: "conductor",
          role: "worker",
          status: "queued",
          output: [],
        });
        room.conductor.workforceRole = "builder";
        return room;
      },
      { root },
    );
    const second = await promoteSession({ session: "live-session", cwd }, options);
    expect(second.room.id).toBe(first.room.id);
    expect(second.room.objective).toBe("Review search");
    expect(second.room.agents).toEqual([
      {
        id: "worker",
        engine: "codex",
        model: "gpt:sol",
        parent: "conductor",
        role: "worker",
        status: "queued",
        output: [],
      },
    ]);
    expect(second.room.conductor.workforceRole).toBe("builder");
    expect(listRawRooms(root).map((room) => room.id)).toEqual([first.room.id]);
  });

  it("never adopts a historical room or a stale inherited room belonging to another coordinator", async () => {
    const { cwd, options, root } = await fixture();
    const historical = await newRoom([], {
      id: "old-room",
      cwd,
      root,
      engine: "codex",
      objective: "Historical work",
    });
    await updateRoom(
      historical.id,
      (room) => {
        room.conductor.session = { id: "old-session", engine: "codex", cwd, machine: hostname() };
        return room;
      },
      { root },
    );
    const before = await readRoom("old-room", root);
    const result = await promoteSession(
      { session: "live-session", cwd },
      { ...options, env: { ORKEST_SWARM_ROOM: historical.id } },
    );
    expect(result.room.id).toMatch(/^conversation-/u);
    expect(result.room.conductor.session.id).toBe("live-session");
    expect(await readRoom("old-room", root)).toEqual(before);
  });

  it("refuses explicit replacement of another coordinator without changing the room", async () => {
    const { cwd, root, options, refreshed } = await fixture();
    const target = await newRoom(parseTeam("claude:haiku"), { id: "occupied", cwd, root });
    await updateRoom(
      target.id,
      (room) => {
        room.conductor.session = {
          id: "other-session",
          engine: "claude",
          cwd,
          machine: hostname(),
        };
        return room;
      },
      { root },
    );
    const before = await readRoom("occupied", root);
    await expect(
      promoteSession({ session: "live-session", cwd, room: target.id }, options),
    ).rejects.toThrow("already has another coordinator");
    expect(await readRoom("occupied", root)).toEqual(before);
    expect(refreshed).toEqual([]);
  });

  it("adopts an explicitly chosen unbound room and keeps its queued members", async () => {
    const { cwd, root, options } = await fixture();
    const target = await newRoom(parseTeam("claude:haiku"), {
      id: "chosen",
      cwd,
      root,
      objective: "Review results",
    });
    const result = await promoteSession({ session: "live-session", cwd, room: target.id }, options);
    expect(result.room.id).toBe("chosen");
    expect(result.room.conductor.engine).toBe("codex");
    expect(result.room.objective).toBe("Review results");
    expect(result.room.agents[0]).toMatchObject({ id: "haiku-1", status: "queued" });
  });

  it.each([
    { isSubagent: true },
    { delegatedRun: "worker-run" },
    { machine: "another-host" },
    { lastSeenAt: "2000-01-01T00:00:00Z" },
  ])("rejects a non-caller or stale peer: %j", async (changes) => {
    const { cwd, options, root } = await fixture(changes);
    await expect(promoteSession({ session: "live-session", cwd }, options)).rejects.toThrow();
    await expect(readdir(path.join(root, "rooms"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a different checkout and terminal instead of borrowing another conversation", async () => {
    const { cwd, directory, options } = await fixture();
    await expect(
      promoteSession({ session: "live-session", cwd: directory }, options),
    ).rejects.toThrow("different checkout");
    await expect(
      promoteSession(
        { session: "live-session", cwd },
        { ...options, env: { HERDR_PANE_ID: "w1:p3" } },
      ),
    ).rejects.toThrow("different terminal pane");
    expect(
      (await promoteSession({ session: "live-session", cwd }, options)).room.conductor.session.id,
    ).toBe("live-session");
  });

  it("keeps promotion when native metadata refresh fails and permits retry", async () => {
    const { cwd, options } = await fixture();
    const failed = await promoteSession(
      { session: "live-session", cwd },
      {
        ...options,
        refresh: async () => {
          throw new Error("terminal unavailable");
        },
      },
    );
    expect(failed.nativeMetadata).toEqual({ attempted: true, error: "terminal unavailable" });
    const retried = await promoteSession({ session: "live-session", cwd }, options);
    expect(retried.room.id).toBe(failed.room.id);
    expect(retried.nativeMetadata).toEqual({ attempted: true });
  });

  it("serializes concurrent retries into one promotion room", async () => {
    const { cwd, root, options } = await fixture();
    const [first, second] = await Promise.all([
      promoteSession({ session: "live-session", cwd }, options),
      promoteSession({ session: "live-session", cwd }, options),
    ]);
    expect(first.room.id).toBe(second.room.id);
    expect(listRawRooms(root).map((room) => room.id)).toEqual([first.room.id]);
    expect((await readRoom(first.room.id, root)).conductor.session.id).toBe("live-session");
  });

  it("accepts a recent registration with cwd but no optional checkout, machine or pid fields", async () => {
    const { cwd, options } = await fixture({
      checkout: undefined,
      machine: undefined,
      pid: undefined,
    });
    const result = await promoteSession({ session: "live-session", cwd }, options);
    expect(result.room.conductor.session).toEqual({
      id: "live-session",
      engine: "codex",
      machine: hostname(),
      cwd,
    });
  });

  it("does not bypass team authority for an unbound coordinator slot", async () => {
    const { cwd, root, options } = await fixture();
    await newRoom([], { id: "authority-room", cwd, root, authority: "team-a" });
    const before = await readRoom("authority-room", root);
    await expect(
      promoteSession({ session: "live-session", cwd, room: "authority-room" }, options),
    ).rejects.toThrow("leadership handoff");
    expect(await readRoom("authority-room", root)).toEqual(before);
  });

  it("exposes promotion through hall/rooms with the caller's native session environment", async () => {
    const { cwd, root, options } = await fixture({ harness: "gemini" });
    let text = "";
    const result = await roomsCommand(
      ["promote", "--cwd", cwd, "--objective", "Coordinate review"],
      {
        root,
        env: { ANTIGRAVITY_CONVERSATION_ID: "live-session" },
        refreshTerminal: options.refresh,
        stdout: {
          write(value) {
            text += value;
          },
        },
      },
    );
    expect(result.room.conductor.session).toMatchObject({ id: "live-session", engine: "agy", cwd });
    expect(JSON.parse(text).status).toBe("promoted");
  });

  it("publishes the existing progress through the real statusline bridge without touching a terminal", async () => {
    const { cwd, root, directory } = await fixture();
    const result = await promoteSession(
      { session: "live-session", cwd, objective: "Coordinate search work" },
      { root, env: { PATH: process.env.PATH, HOME: directory } },
    );
    expect(result.nativeMetadata.attempted).toBe(true);
    expect(result.nativeMetadata.error).toBeUndefined();
    expect(result.nativeMetadata.status.goal).toBe("Coordinate search work");
    expect(result.room.conductor.session.id).toBe("live-session");
  });
});
