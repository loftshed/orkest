import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { roomsCommand } from "../../../plugins/orchestrate/bin/rooms.mjs";
import { parseTeam, readRoom, updateRoom } from "../../../plugins/orchestrate/lib/horde-room.mjs";
import { newRoom } from "../../../plugins/orchestrate/lib/rooms.mjs";
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
    expect(await readdir(path.join(root, "rooms"))).toEqual([`${first.room.id}.json`]);
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
    const before = await readFile(path.join(root, "rooms/old-room.json"), "utf8");
    const result = await promoteSession(
      { session: "live-session", cwd },
      { ...options, env: { ORKEST_SWARM_ROOM: historical.id } },
    );
    expect(result.room.id).toMatch(/^conversation-/u);
    expect(result.room.conductor.session.id).toBe("live-session");
    expect(await readFile(path.join(root, "rooms/old-room.json"), "utf8")).toBe(before);
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
    const before = await readFile(path.join(root, "rooms/occupied.json"), "utf8");
    await expect(
      promoteSession({ session: "live-session", cwd, room: target.id }, options),
    ).rejects.toThrow("already has another coordinator");
    expect(await readFile(path.join(root, "rooms/occupied.json"), "utf8")).toBe(before);
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
    expect(await readdir(path.join(root, "rooms"))).toEqual([`${first.room.id}.json`]);
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
    const before = await readFile(path.join(root, "rooms/authority-room.json"), "utf8");
    await expect(
      promoteSession({ session: "live-session", cwd, room: "authority-room" }, options),
    ).rejects.toThrow("leadership handoff");
    expect(await readFile(path.join(root, "rooms/authority-room.json"), "utf8")).toBe(before);
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
