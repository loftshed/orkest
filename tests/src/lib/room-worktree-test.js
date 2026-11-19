import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { roomsCommand } from "../../../src/bin/rooms.mjs";
import { parseTeam, readRoom, updateRoom } from "../../../src/lib/horde-room.mjs";
import { dispatchMember, newRoom } from "../../../src/lib/rooms.mjs";
import { worktreeLaunchEnv } from "../../../src/lib/worktree-env.mjs";
import { allocateWorktreePorts } from "../../../src/lib/worktree-ports.mjs";
import { provisionWorktree } from "../../../src/lib/worktree-provision.mjs";
import { retainFixtures } from "../../helpers/retain-fixtures.js";

const directories = [];

async function directory() {
  // Resolved, because the system temp directory is a symlink on macOS and Git reports real paths.
  const created = await mkdtemp(path.join(tmpdir(), "ork-room-worktree-"));
  const result = await realpath(created);
  directories.push(result);
  return result;
}

async function gitRepository() {
  const repo = await directory();
  execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Room Worktree Tests"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "room-worktree@example.invalid"], { cwd: repo });
  await writeFile(path.join(repo, "tracked.txt"), "tracked content\n");
  await writeFile(path.join(repo, "local-settings.json"), '{"copied":true}\n');
  await writeFile(path.join(repo, ".worktreeinclude"), "local-settings.json\n");
  execFileSync("git", ["add", "tracked.txt"], { cwd: repo });
  execFileSync("git", ["commit", "-m", "test fixture"], { cwd: repo, stdio: "ignore" });
  return repo;
}

async function roomFor(repo) {
  const root = await directory();
  const room = await newRoom(parseTeam("claude:haiku,codex:luna:max"), {
    id: "worktree-room",
    cwd: repo,
    root,
  });
  return { root, room };
}

afterEach(async () => {
  await retainFixtures(directories.splice(0));
});

describe("worktree provisioning", () => {
  it("creates a branch worktree and applies .worktreeinclude", async () => {
    const repo = await gitRepository();

    const result = provisionWorktree(repo, { slug: "haiku-1", branch: "ork/room-haiku-1" });

    expect(result).toEqual({
      path: path.join(repo, ".worktrees", "haiku-1"),
      branch: "ork/room-haiku-1",
      slug: "haiku-1",
      parentCwd: repo,
      prepared: {
        copied: ["local-settings.json"],
        linked: [],
        ports: null,
        setup: { status: "none" },
        warnings: [],
      },
    });
    expect(
      execFileSync("git", ["branch", "--show-current"], {
        cwd: result.path,
        encoding: "utf8",
      }).trim(),
    ).toBe("ork/room-haiku-1");
    await expect(readFile(path.join(result.path, "local-settings.json"), "utf8")).resolves.toBe(
      '{"copied":true}\n',
    );
  });

  it("refuses an invalid slug, an existing path, and a branch that already exists", async () => {
    const repo = await gitRepository();

    expect(() =>
      provisionWorktree(repo, { slug: "../outside", branch: "ork/room-outside" }),
    ).toThrow("lowercase letters, digits, and dashes");
    await mkdir(path.join(repo, ".worktrees", "occupied"), { recursive: true });
    expect(() =>
      provisionWorktree(repo, { slug: "occupied", branch: "ork/room-occupied" }),
    ).toThrow("Worktree path already exists");
    execFileSync("git", ["branch", "ork/room-taken"], { cwd: repo });
    expect(() => provisionWorktree(repo, { slug: "taken", branch: "ork/room-taken" })).toThrow(
      "ork/room-taken",
    );
  });
});

describe("ork hall worktree", () => {
  it("records each member checkout, prints its absolute path, and refuses a second allocation", async () => {
    const repo = await gitRepository();
    const { root, room } = await roomFor(repo);
    let output = "";

    const first = await roomsCommand(["worktree", "--room", room.id, "--member", "haiku-1"], {
      root,
      stdout: { write: (value) => (output += value) },
    });
    const printed = JSON.parse(output);
    expect(printed).toMatchObject({
      memberId: "haiku-1",
      path: path.join(repo, ".worktrees", "haiku-1"),
      branch: "ork/room-haiku-1",
    });
    expect(path.isAbsolute(printed.path)).toBe(true);
    expect(first.path).toBe(printed.path);
    expect(await readRoom(room.id, root)).toMatchObject({
      agents: [
        {
          id: "haiku-1",
          cwd: printed.path,
          worktree: { path: printed.path, parentCwd: repo, baseBranch: "main", disposable: true },
        },
        { id: "luna-1" },
      ],
    });

    await expect(
      roomsCommand(["worktree", "--room", room.id, "--member", "haiku-1"], { root }),
    ).rejects.toThrow("already has a worktree");

    const second = await roomsCommand(["worktree", "--room", room.id, "--member", "luna-1"], {
      root,
      stdout: { write: () => {} },
    });
    expect(second.path).toBe(path.join(repo, ".worktrees", "luna-1"));
    expect(second.path).not.toBe(first.path);
  });

  it("requires a git room and refuses a member with an active dispatch", async () => {
    const notRepo = await directory();
    const { root, room } = await roomFor(notRepo);
    await expect(
      roomsCommand(["worktree", "--room", room.id, "--member", "haiku-1"], { root }),
    ).rejects.toThrow("not a git repository");

    const repo = await gitRepository();
    const activeRoom = await newRoom(parseTeam("claude:haiku"), {
      id: "active-worktree-room",
      cwd: repo,
      root,
    });
    const taskDir = await directory();
    const task = {
      schema: "agent-executor.task.v1",
      task_id: "active-task",
      repository: repo,
      runs: [{ request_id: "active-request", status: "active" }],
      decisions: [],
    };
    await updateRoom(
      activeRoom.id,
      (current) => {
        current.agents[0].dispatch = {
          taskDir,
          taskId: task.task_id,
          requestId: "active-request",
          transport: "executor",
        };
        return current;
      },
      { root },
    );
    const run = async (args) => {
      if (args[0] === "show") return structuredClone(task);
      throw new Error(`Unexpected coordinator command: ${args[0]}`);
    };
    await expect(
      roomsCommand(["worktree", "--room", activeRoom.id, "--member", "haiku-1"], {
        root,
        run,
      }),
    ).rejects.toThrow("active or unresolved dispatch");
    expect((await readRoom(activeRoom.id, root)).agents[0].worktree).toBeUndefined();
  });

  it("dispatches by default to the recorded worktree and rejects a task for the parent checkout", async () => {
    const repo = await gitRepository();
    const { root, room } = await roomFor(repo);
    const created = await roomsCommand(["worktree", "--room", room.id, "--member", "haiku-1"], {
      root,
      stdout: { write: () => {} },
    });
    const env = { ...process.env, ORCHESTRATE_HOME: await directory() };
    const { API_PORT: port } = await allocateWorktreePorts({
      repoRoot: repo,
      worktreePath: created.path,
      slug: "haiku-1",
      names: ["API_PORT"],
      env,
    });
    const taskDir = await directory();
    const task = {
      schema: "agent-executor.task.v1",
      task_id: "dispatch-task",
      repository: repo,
      runs: [],
      decisions: [],
    };
    const run = async (args, options) => {
      if (args[0] === "show") return structuredClone(task);
      if (args[0] !== "dispatch") throw new Error(`Unexpected coordinator command: ${args[0]}`);
      const seen = execFileSync(process.execPath, ["-p", "process.env.API_PORT"], {
        cwd: created.path,
        env: options.env,
        encoding: "utf8",
      });
      expect(seen.trim()).toBe(String(port));
      const requestId = args[args.indexOf("--request-id") + 1];
      const recorded = {
        run_id: "run-1",
        request_id: requestId,
        status: "active",
        kind: "implementation",
        transport: "executor",
        engine: "claude",
        result_path: path.join(taskDir, "result.json"),
      };
      task.runs.push(recorded);
      return structuredClone(recorded);
    };

    await expect(
      dispatchMember(room.id, "haiku-1", { root, taskDir, run, env, kind: "implementation" }),
    ).rejects.toThrow("Task repository differs from room checkout");
    task.repository = created.path;
    await expect(
      dispatchMember(room.id, "haiku-1", { root, taskDir, run, env, kind: "implementation" }),
    ).resolves.toMatchObject({ dispatch: { run_id: "run-1" } });
    expect((await readRoom(room.id, root)).agents[0].dispatch).toBeDefined();
  });
});

describe("room worktree preparation failures", () => {
  it("keeps registered membership and names the failed substage for a preparation failure", async () => {
    const repo = await gitRepository();
    await mkdir(path.join(repo, ".orkest"));
    await writeFile(path.join(repo, ".orkest", "worktree.json"), '{"version":1,"nope":true}');
    const { root, room } = await roomFor(repo);

    let thrown;
    try {
      await roomsCommand(["worktree", "--room", room.id, "--member", "haiku-1"], {
        root,
        stdout: { write: () => {} },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ stage: "bootstrap", substage: "config" });
    // stage=bootstrap keeps the reservation because git already created the worktree.
    const saved = await readRoom(room.id, root);
    expect(saved.agents[0].worktree).toMatchObject({
      path: path.join(repo, ".worktrees", "haiku-1"),
    });
    expect(execFileSync("git", ["worktree", "list"], { cwd: repo, encoding: "utf8" })).toContain(
      "haiku-1",
    );
  });

  it("drops the reservation for a non-bootstrap failure (branch already exists)", async () => {
    const repo = await gitRepository();
    execFileSync("git", ["branch", "ork/room-haiku-1"], { cwd: repo });
    const { root, room } = await roomFor(repo);
    await expect(
      roomsCommand(["worktree", "--room", room.id, "--member", "haiku-1"], {
        root,
        stdout: { write: () => {} },
      }),
    ).rejects.toMatchObject({ stage: "add" });
    expect((await readRoom(room.id, root)).agents[0].worktree).toBeUndefined();
  });

  it("allocates configured ports for a room checkout and exposes them to a launched child", async () => {
    const repo = await gitRepository();
    await mkdir(path.join(repo, ".orkest"));
    await writeFile(
      path.join(repo, ".orkest", "worktree.json"),
      JSON.stringify({ version: 1, ports: { names: ["WEB_PORT"] } }),
    );
    const cache = await directory();
    const env = { ...process.env, ORCHESTRATE_HOME: cache };
    const result = provisionWorktree(repo, {
      slug: "ported",
      branch: "ork/room-ported",
      env,
    });
    const port = result.prepared.ports.WEB_PORT;
    expect(port).toBeGreaterThanOrEqual(31_000);

    const launched = worktreeLaunchEnv(env, { repoRoot: repo, worktreePath: result.path });
    const out = execFileSync(
      process.execPath,
      ["-e", "process.stdout.write(process.env.WEB_PORT)"],
      { cwd: result.path, env: launched, encoding: "utf8" },
    );
    expect(out).toBe(String(port));
  });
});
