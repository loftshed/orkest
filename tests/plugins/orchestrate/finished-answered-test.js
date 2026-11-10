import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { notifyHerdrTransitions } from "../../../plugins/orchestrate/bin/horde-tui.mjs";
import { roomsCommand } from "../../../plugins/orchestrate/bin/rooms.mjs";
import { createRoom, parseTeam, updateRoom } from "../../../plugins/orchestrate/lib/horde-room.mjs";
import { HordeView } from "../../../plugins/orchestrate/lib/horde-view.mjs";
import {
  isTerminalDisplayState,
  memberDisplayState,
} from "../../../plugins/orchestrate/lib/member-state.mjs";
import { newRoom, observeRoom } from "../../../plugins/orchestrate/lib/rooms.mjs";
import { plain } from "../../../plugins/orchestrate/lib/tui-box.mjs";

afterEach(() => vi.unstubAllEnvs());

const done = { status: "reported complete" };

function render(agents, tier = "unicode", completedMode = "expanded") {
  const room = createRoom(parseTeam("codex:luna"), { id: "neutral" });
  room.agents = agents.map((agent, index) => ({ id: `member-${index}`, ...agent }));
  return new HordeView(room, { tier, height: 60, completedMode, now: () => 1000 })
    .render(150)
    .map(plain)
    .join("\n");
}

describe("finished and answered display states", () => {
  it("derives them only from provenance on a completion status", () => {
    expect(memberDisplayState({ ...done, completion: "untracked" })).toBe("finished");
    expect(memberDisplayState({ ...done, completion: "answered" })).toBe("answered");
    expect(memberDisplayState({ ...done })).toBe("reported");
    expect(memberDisplayState({ status: "running", completion: "untracked" })).toBe("running");
  });

  it("lets verdicts, stale evidence and cancellation outrank completion", () => {
    const base = { ...done, completion: "untracked" };
    expect(memberDisplayState({ ...base, verdict: "accept" })).toBe("accepted");
    expect(memberDisplayState({ ...base, verdict: "supported" })).toBe("supported");
    expect(memberDisplayState({ ...base, verdict: "reject" })).toBe("rejected");
    expect(memberDisplayState({ ...base, evidenceState: "stale" })).toBe("stale");
    expect(memberDisplayState({ ...base, status: "cancelled" })).toBe("cancelled");
  });

  it("stays non-terminal so a resumed member can replace it", () => {
    expect(isTerminalDisplayState("finished")).toBe(false);
    expect(isTerminalDisplayState("answered")).toBe(false);
    expect(isTerminalDisplayState("reported")).toBe(true);
  });

  it("keeps a dispatched task without a decision awaiting review", () => {
    const member = { status: "review", dispatch: { taskId: "t" }, runtimeState: "idle" };
    expect(memberDisplayState(member)).toBe("reported");
  });

  it.each(["ascii", "unicode", "nerd"])(
    "labels them neutrally and counts only reported members (%s)",
    (tier) => {
      const text = render(
        [{ ...done, completion: "untracked" }, { ...done, completion: "answered" }, { ...done }],
        tier,
      );
      expect(text).toContain("finished");
      expect(text).toContain("answered");
      expect(text).toContain("reported (awaiting review)");
      expect(text).toMatch(/ 1 reported/u);
      expect(text).not.toMatch(/\d+ (finished|answered)/u);
    },
  );

  it("hides neutral members as inactive without counting them as reported", () => {
    const text = render(
      [
        { ...done, completion: "untracked" },
        { ...done, completion: "untracked" },
        { ...done, completion: "answered" },
      ],
      "unicode",
      "hidden",
    );
    expect(text).toMatch(/\d+ inactive hidden/u);
    expect(text).not.toMatch(/\d+ reported/u);
  });
});

describe("finished and answered notifications", () => {
  const options = (exec) => ({ env: { HERDR_ENV: "1" }, exec });

  it("does not announce neutral members as review requests", () => {
    const exec = vi.fn();
    const previous = [{ id: "worker", status: "working" }];
    const next = [{ id: "worker", ...done, completion: "untracked" }];
    expect(notifyHerdrTransitions(previous, next, new Set(), options(exec))).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });

  it("ignores neutral members when summarising real outcomes", () => {
    const exec = vi.fn();
    const previous = [{ id: "one", status: "working" }];
    const next = [
      { id: "one", status: "completed", verdict: "accept" },
      { id: "two", ...done, completion: "answered" },
    ];
    expect(notifyHerdrTransitions(previous, next, new Set(), options(exec))).toBe(true);
    expect(exec.mock.calls[0][1]).toContain("Orkest: Swarm accepted");
    expect(exec.mock.calls[0][1].at(-1)).toBe("done");
  });
});

async function directory() {
  const created = await mkdtemp(path.join(tmpdir(), "orkest-finished-"));
  return realpath(created);
}

describe("completion provenance in rooms", () => {
  it("marks answered consultations and exposes the field through rooms show --json", async () => {
    const root = await directory();
    const cwd = await directory();
    const room = await newRoom(parseTeam("claude:haiku"), { id: "room-json", cwd, root });
    const session = { id: "supervisor-j", engine: "claude", machine: hostname(), cwd };
    room.conductor.engine = "claude";
    room.conductor.session = session;
    // Persisted, so the command below reloads the room and still finds the consultation.
    await updateRoom(
      room.id,
      async (current) => {
        current.conductor.engine = "claude";
        current.conductor.session = session;
        return current;
      },
      { root },
    );
    const dir = path.join(root, "consultations", "supervisor-j");
    await mkdir(dir, { recursive: true });
    const resultPath = path.join(root, "result.json");
    const startedAt = new Date().toISOString();
    await writeFile(
      path.join(dir, "consult-j.json"),
      JSON.stringify({
        schema: "orchestrate.consultation-observation.v1",
        id: "consult-j",
        parent_session: "supervisor-j",
        room_id: room.id,
        machine: hostname(),
        pid: process.pid,
        runner_pid: process.pid,
        deadline_ms: Date.now() + 60_000,
        engine: "claude",
        model: "m",
        effort: "high",
        task: "Ask",
        started_at: startedAt,
        result_path: resultPath,
      }),
    );
    const options = { root, progress: async () => new Map(), discoverNativePeers: false };
    const result = (status) =>
      writeFile(resultPath, JSON.stringify({ schema: "agent-executor.consultation.v1", status }));

    await result("failed");
    const failed = await observeRoom(room, options);
    expect(failed.agents.find((agent) => agent.id === "consult-j").completion).toBeUndefined();

    await result("answered");
    const observed = await observeRoom(room, options);
    const consult = observed.agents.find((agent) => agent.id === "consult-j");
    expect(consult.completion).toBe("answered");
    expect(memberDisplayState(consult)).toBe("answered");

    let output = "";
    await roomsCommand(["show", "--room", room.id, "--json"], {
      root,
      stdout: { write: (text) => (output += text) },
    });
    const listed = JSON.parse(output).agents.find((agent) => agent.id === "consult-j");
    expect(listed.completion).toBe("answered");
  });
});
