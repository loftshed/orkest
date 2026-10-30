import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";

import { roomsCommand } from "../../../plugins/orchestrate/bin/rooms.mjs";
import {
  bindSession,
  dispatchMember,
  growRoom,
  newRoom,
  observeRoom,
} from "../../../plugins/orchestrate/lib/rooms.mjs";
import { parseTeam, readRoom, updateRoom } from "../../../plugins/orchestrate/lib/stooges-room.mjs";
import { StoogesView } from "../../../plugins/orchestrate/lib/stooges-view.mjs";
import { pauseBranch, reserveLead } from "../../../plugins/orchestrate/lib/swarm.mjs";

const execute = promisify(execFile);
const cli = fileURLToPath(new URL("../../../plugins/orchestrate/bin/ork.mjs", import.meta.url));
const directories = [];
async function fixture({ maxAgents = 6, maxDepth = 3 } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "ork-swarm-"));
  directories.push(root);
  const room = await newRoom([], {
    id: "test-swarm",
    cwd: root,
    root,
    engine: "codex",
    title: "Fix cache",
    objective: "Fix cache",
    swarm: { maxAgents, maxDepth },
  });
  return { root, room };
}
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});

it("creates a conversational room through the CLI without launching a model in JSON mode", async () => {
  const { root } = await fixture();
  const result = await execute(
    process.execPath,
    [cli, "stooges", "Fix a cache failure", "--engine", "agy", "--max-agents", "4", "--json"],
    {
      env: { ...process.env, AGENT_EXECUTOR_HOME: root },
    },
  );
  const room = JSON.parse(result.stdout);
  expect(room).toMatchObject({
    objective: "Fix a cache failure",
    conductor: { engine: "agy", status: "awaiting session" },
    swarm: { maxAgents: 4, maxDepth: 3 },
    agents: [],
  });
  expect((await readRoom(room.id, path.join(root, "mailbox-v1"))).objective).toBe(
    "Fix a cache failure",
  );
});

it.each(["agy", "codex", "claude", "opencode"])(
  "opens %s through its short command with the goal left for the conversation",
  async (engine) => {
    const { root } = await fixture();
    const result = await execute(process.execPath, [cli, engine, "--json", "--max-agents", "4"], {
      env: { ...process.env, AGENT_EXECUTOR_HOME: root },
    });
    const room = JSON.parse(result.stdout);
    expect(room).toMatchObject({
      objective: "",
      title: "New swarm",
      conductor: { engine, status: "awaiting session" },
      swarm: { maxAgents: 4 },
      agents: [],
    });
  },
);

it("lets a native lead build another branch while sharing the root's member limit", async () => {
  const { root, room } = await fixture({ maxAgents: 3 });
  await growRoom(room.id, parseTeam("codex:host-default"), root);
  const lead = await reserveLead(room.id, "host-default-1", "Investigate cache", { root });
  expect(lead).toMatchObject({
    status: "native_handoff",
    engine: "codex",
    member: "host-default-1",
  });
  expect(await readFile(lead.briefPath, "utf8")).toContain("Your assignment: Investigate cache");
  await growRoom(room.id, parseTeam("agy:flash,claude:haiku"), root, "host-default-1");
  await expect(growRoom(room.id, parseTeam("codex:luna"), root)).rejects.toThrow(
    "Swarm agent limit reached",
  );
  expect(
    (await readRoom(room.id, root)).agents.map((member) => [member.id, member.parent]),
  ).toEqual([
    ["host-default-1", "conductor"],
    ["flash-1", "host-default-1"],
    ["haiku-1", "host-default-1"],
  ]);
});

it("does not turn another harness or an existing audited worker into a subswarm lead", async () => {
  const { root, room } = await fixture();
  await growRoom(room.id, parseTeam("agy:flash,codex:luna"), root);
  await expect(reserveLead(room.id, "flash-1", "Research", { root })).rejects.toThrow(
    "parent's native harness",
  );
  await reserveLead(room.id, "luna-1", "Research", { root });
  expect(await reserveLead(room.id, "luna-1", "Research", { root })).toMatchObject({
    status: "pending_attachment",
    session: null,
  });
  await bindSession(room.id, "luna-1", { root, engine: "codex", session: "native-child-1" });
  expect(await reserveLead(room.id, "luna-1", "Research", { root })).toMatchObject({
    status: "attached",
    session: { id: "native-child-1" },
  });
  await expect(reserveLead(room.id, "luna-1", "Different task", { root })).rejects.toThrow(
    "already has an assignment",
  );
  await expect(
    bindSession(room.id, "luna-1", { root, engine: "codex", session: "duplicate-child" }),
  ).rejects.toThrow("already has a native session");
});

it("rejects excessive depth, unknown parents and cycles without changing the saved tree", async () => {
  const { root, room } = await fixture({ maxDepth: 2 });
  await growRoom(room.id, parseTeam("codex:host-default"), root);
  await reserveLead(room.id, "host-default-1", "Explore", { root });
  await growRoom(room.id, parseTeam("codex:host-default"), root, "host-default-1");
  await reserveLead(room.id, "host-default-2", "Inspect", { root });
  await expect(growRoom(room.id, parseTeam("agy:flash"), root, "host-default-2")).rejects.toThrow(
    "depth limit",
  );
  await expect(growRoom(room.id, parseTeam("agy:flash"), root, "missing")).rejects.toThrow(
    "existing lead",
  );
  await expect(
    updateRoom(
      room.id,
      (current) => {
        current.agents[0].parent = "host-default-2";
        return current;
      },
      { root },
    ),
  ).rejects.toThrow("cycle");
  expect((await readRoom(room.id, root)).agents.map((member) => member.parent)).toEqual([
    "conductor",
    "host-default-1",
  ]);
});

it("enforces the shared limit under competing branch additions", async () => {
  const { root, room } = await fixture({ maxAgents: 1 });
  const outcomes = await Promise.allSettled([
    growRoom(room.id, parseTeam("agy:flash"), root),
    growRoom(room.id, parseTeam("claude:haiku"), root),
  ]);
  expect(outcomes.map((result) => result.status).sort((a, b) => a.localeCompare(b))).toEqual([
    "fulfilled",
    "rejected",
  ]);
  expect((await readRoom(room.id, root)).agents.map((member) => member.status)).toEqual(["queued"]);
});

it("pauses new descendants while preserving recovery of previously dispatched work", async () => {
  const { root, room } = await fixture();
  await growRoom(room.id, parseTeam("codex:host-default,agy:flash"), root);
  await reserveLead(room.id, "host-default-1", "Lead investigation", { root });
  await growRoom(room.id, parseTeam("claude:haiku"), root, "host-default-1");
  const task = {
    schema: "agent-executor.task.v1",
    task_id: "cache-task",
    repository: room.cwd,
    runs: [],
    decisions: [],
    updated_at: "2026-10-30T20:00:00Z",
  };
  const run = async (args) => {
    if (args[0] === "show") return structuredClone(task);
    const request = args[args.indexOf("--request-id") + 1];
    const record = task.runs.find((entry) => entry.request_id === request) || {
      request_id: request,
      run_id: "cache-run",
      status: "active",
      engine: args[args.indexOf("--engine") + 1],
      transport: "executor",
    };
    if (!task.runs.includes(record)) task.runs.push(record);
    return record;
  };
  const options = { root, taskDir: room.cwd, run };
  await dispatchMember(room.id, "flash-1", options);
  await pauseBranch(room.id, "conductor", true, { root });
  await pauseBranch(room.id, "host-default-1", false, { root });
  await expect(dispatchMember(room.id, "haiku-1", options)).rejects.toThrow("conductor is paused");
  await expect(
    reserveLead(room.id, "host-default-1", "Lead investigation", { root }),
  ).rejects.toThrow("paused");
  expect((await dispatchMember(room.id, "flash-1", options)).dispatch.run_id).toBe("cache-run");
  expect(task.runs.map((entry) => entry.run_id)).toEqual(["cache-run"]);
  await pauseBranch(room.id, "conductor", false, { root });
  expect((await dispatchMember(room.id, "haiku-1", options)).room.agents.at(-1).status).toBe(
    "running",
  );
  await expect(reserveLead(room.id, "flash-1", "Take over", { root })).rejects.toThrow(
    "parent's native harness",
  );
});

it("projects current session status and nesting without treating a lead report as accepted work", async () => {
  const { root, room } = await fixture();
  await growRoom(room.id, parseTeam("codex:host-default,claude:haiku"), root);
  await reserveLead(room.id, "host-default-1", "Investigate", { root });
  await growRoom(room.id, parseTeam("agy:flash"), root, "host-default-1");
  await bindSession(room.id, "host-default-1", { root, engine: "codex", session: "lead-session" });
  const observed = await observeRoom(room.id, {
    root,
    progress: async () => ({
      "host-default-1": {
        name: "example-gpt-test-high-cache-aa",
        model: "runtime-model",
        effort: "high",
        stage: "complete",
        task: "Investigate",
        statusHealth: "fresh",
      },
    }),
  });
  expect(observed.agents[0]).toMatchObject({
    name: "example-gpt-test-high-cache-aa",
    status: "reported complete",
  });
  const view = new StoogesView(observed, { height: 30, tier: "unicode" });
  const output = view.render(85).join("\n");
  expect(output).toContain("├─ 1 example-gpt-test-high-cache-aa (lead)");
  expect(output).toContain("│  └─ 2 flash-1");
  expect(output).toContain("└─ 3 haiku-1");
  expect(output).toContain("runtime-model / high | reported complete");
  const absent = await observeRoom(room.id, { root, progress: async () => ({}) });
  expect(absent.agents[0].status).toBe("session unavailable");
});

it("records a conversation's objective and pauses through the public room commands", async () => {
  const { root, room } = await fixture();
  const stdout = { write() {} };
  await roomsCommand(
    ["objective", "--room", room.id, "--objective", "Repair cache\nand verify recovery"],
    { root, stdout },
  );
  await roomsCommand(["pause", "--room", room.id], { root, stdout });
  expect(await readRoom(room.id, root)).toMatchObject({
    title: "Repair cache and verify recovery",
    objective: "Repair cache\nand verify recovery",
    conductor: { paused: true },
  });
  await roomsCommand(["resume", "--room", room.id], { root, stdout });
  expect((await readRoom(room.id, root)).conductor.paused).toBe(false);
});
