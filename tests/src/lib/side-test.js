import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readRawRoom, readRoom } from "../../../src/lib/horde-room.mjs";
import {
  checkRepoPolicyForSide,
  classifySideMode,
  parseSideArgs,
  SIDE_HELP,
  sideCommand,
} from "../../../src/lib/side.mjs";
import { listWorktreePorts } from "../../../src/lib/worktree-ports.mjs";

describe("ork side (side missions)", () => {
  let tmpDir;
  let mailboxDir;
  let cacheDir;
  let repoDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ork-side-test-"));
    mailboxDir = path.join(tmpDir, "mailbox");
    cacheDir = path.join(tmpDir, "cache");
    repoDir = path.join(tmpDir, "repo");
    fs.mkdirSync(path.join(mailboxDir, "rooms"), { recursive: true });
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.mkdirSync(repoDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** A legacy room file in the canonical agent-executor.room.v1 shape; the store imports it. */
  function writeRoom(id, { session, agents = [] } = {}) {
    const roomPath = path.join(mailboxDir, "rooms", `${id}.json`);
    fs.writeFileSync(
      roomPath,
      JSON.stringify({
        schema: "agent-executor.room.v1",
        id,
        cwd: repoDir,
        machine: os.hostname(),
        conductor: {
          engine: "claude",
          ...(session && {
            session: { id: session, engine: "claude", machine: os.hostname(), cwd: repoDir },
          }),
        },
        agents,
      }),
      "utf8",
    );
    return roomPath;
  }

  describe("classifySideMode & parseSideArgs", () => {
    it("classifies imperative statements as execute mode by default", () => {
      const res = classifySideMode("fix the off-by-one error in pagination");
      expect(res.mode).toBe("execute");
      expect(res.idea).toBe("fix the off-by-one error in pagination");
      expect(res.title).toBe("fix the off-by-one error in pagination");
    });

    it("classifies questions and ask:/check:/investigate: prefixes as investigate mode", () => {
      expect(classifySideMode("why does token refresh retry twice?").mode).toBe("investigate");
      const prefixed = classifySideMode("ask: how does wakeup coalescing work");
      expect(prefixed.mode).toBe("investigate");
      expect(prefixed.idea).toBe("how does wakeup coalescing work");
    });

    it("classifies later:/todo:/park: prefixes and --later/--park flags as park mode", () => {
      const prefixed = classifySideMode("later: refactor legacy retry helper");
      expect(prefixed.mode).toBe("park");
      expect(prefixed.idea).toBe("refactor legacy retry helper");

      const flagged = classifySideMode("clean up unused fixtures", { later: true });
      expect(flagged.mode).toBe("park");
    });

    it("classifies issue: prefix and --issue flag as issue mode", () => {
      const prefixed = classifySideMode("issue: support dark mode in status modal");
      expect(prefixed.mode).toBe("issue");
      expect(prefixed.idea).toBe("support dark mode in status modal");

      const flagged = classifySideMode("add CSV export", { issue: true });
      expect(flagged.mode).toBe("issue");
    });

    it("parses CLI flags cleanly", () => {
      const parsed = parseSideArgs([
        "--later",
        "--engine",
        "codex",
        "--model=gpt-5.6-sol",
        "--allow-paths",
        "src,tests",
        "refactor parser",
      ]);
      expect(parsed.options.later).toBe(true);
      expect(parsed.options.mode).toBe("park");
      expect(parsed.options.engine).toBe("codex");
      expect(parsed.options.model).toBe("gpt-5.6-sol");
      expect(parsed.options.allowPaths).toEqual(["src", "tests"]);
      expect(parsed.rawIdea).toBe("refactor parser");
    });
  });

  describe("sideCommand execution modes & parent-inbox isolation", () => {
    it("returns help output when --help is passed", async () => {
      let printed = "";
      const res = await sideCommand(["--help"], {
        stdout: { write: (s) => (printed += s) },
      });
      expect(res.status).toBe("help");
      expect(printed).toContain("Usage: ork side");
      expect(res.help).toBe(SIDE_HELP);
    });

    it("supports --dry-run without running external commands", async () => {
      const calls = [];
      const res = await sideCommand(["--dry-run", "--json", "ask: where is rooms.mjs used?"], {
        cwd: repoDir,
        mailboxDir,
        cacheDir,
        shortId: "dry123",
        runCommand: (cmd, args) => {
          calls.push([cmd, args]);
          return { status: 0, stdout: "", stderr: "" };
        },
      });
      expect(res.schema).toBe("ork.side.v1");
      expect(res.status).toBe("dry_run");
      expect(res.mode).toBe("investigate");
      expect(res.isolatedInbox).toBe(true);
      expect(res.parentInboxTouched).toBe(false);
      expect(calls).toHaveLength(0);
    });

    it("parks an idea on the workboard in park mode with isolated session env", async () => {
      const calls = [];
      const parentEnv = {
        ...process.env,
        CLAUDE_SESSION_ID: "parent-claude-session-111",
        ANTIGRAVITY_CONVERSATION_ID: "parent-agy-session-222",
      };

      const res = await sideCommand(["--later", "--json", "refactor retry helper"], {
        cwd: repoDir,
        mailboxDir,
        cacheDir,
        shortId: "park01",
        env: parentEnv,
        runCommand: (cmd, args, opts) => {
          calls.push({ cmd, args, env: opts.env });
          return {
            status: 0,
            stdout: JSON.stringify({ item: { id: "work-side-park01", state: "open" } }),
            stderr: "",
          };
        },
      });

      expect(res.mode).toBe("park");
      expect(res.status).toBe("parked");
      expect(res.workId).toBe("work-side-park01");
      expect(res.parentInboxTouched).toBe(false);
      expect(calls).toHaveLength(1);
      expect(calls[0].cmd).toBe("python3");
      expect(calls[0].args).toContain("work");
      expect(calls[0].args).toContain("create");
      expect(calls[0].env.CLAUDE_SESSION_ID).toBeUndefined();
      expect(calls[0].env.ANTIGRAVITY_CONVERSATION_ID).toBeUndefined();
      expect(calls[0].env.AGENT_MAILBOX_SESSION).toBe("side-coord-park01");
    });

    it("names the Swarm View command the way the caller's harness invokes it", async () => {
      const park = (harnessArgs) =>
        sideCommand(["--later", "--json", ...harnessArgs, "refactor retry helper"], {
          cwd: repoDir,
          mailboxDir,
          cacheDir,
          shortId: "park02",
          env: process.env,
          runCommand: () => ({
            status: 0,
            stdout: JSON.stringify({ item: { id: "work-side-park02", state: "open" } }),
            stderr: "",
          }),
        });

      expect((await park(["--harness", "codex"])).summary).toContain("visible in $swarm and");
      expect((await park(["--harness", "claude"])).summary).toContain("visible in /swarm and");
      expect((await park([])).summary).toContain("visible in ork swarm and");
    });

    it("creates an open workboard card with the requested scope", async () => {
      expect(spawnSync("git", ["init", repoDir]).status).toBe(0);
      const cli = path.resolve(import.meta.dirname, "../../../src/bin/ork.mjs");
      const run = spawnSync(
        process.execPath,
        [cli, "side", "--later", "--json", "Review retry behavior"],
        {
          cwd: repoDir,
          env: { ...process.env, HOME: tmpDir, ORCHESTRATE_MAILBOX_DIR: mailboxDir },
          encoding: "utf8",
        },
      );
      expect(run.stderr).toBe("");
      expect(run.status).toBe(0);
      const parked = JSON.parse(run.stdout);
      expect(parked.workItem.scope).toBe("Review retry behavior");
      expect(parked.workItem.state).toBe("open");
      expect(parked.workId).toBe(parked.workItem.id);
    });

    it("files a GitHub issue with agent:raw label in issue mode", async () => {
      const calls = [];
      const res = await sideCommand(["--issue", "--json", "support dark mode in status modal"], {
        cwd: repoDir,
        mailboxDir,
        cacheDir,
        shortId: "iss01",
        runCommand: (cmd, args) => {
          calls.push({ cmd, args });
          return {
            status: 0,
            stdout: "https://github.com/example/orkest/issues/42\n",
            stderr: "",
          };
        },
      });

      expect(res.mode).toBe("issue");
      expect(res.status).toBe("filed");
      expect(res.issueUrl).toBe("https://github.com/example/orkest/issues/42");
      expect(calls).toHaveLength(1);
      expect(calls[0].cmd).toBe("gh");
      expect(calls[0].args).toEqual([
        "issue",
        "create",
        "--title",
        "support dark mode in status modal",
        "--body",
        "support dark mode in status modal",
        "--label",
        "agent:raw",
      ]);
    });

    it("dispatches a read-only background scout in investigate mode and registers side-1 in the room", async () => {
      const roomPath = writeRoom("room-alpha", { session: "parent-session-999" });

      const calls = [];
      const res = await sideCommand(
        ["--session", "parent-session-999", "--json", "why does token refresh retry twice?"],
        {
          cwd: repoDir,
          mailboxDir,
          cacheDir,
          shortId: "inv01",
          env: { ...process.env, CLAUDE_SESSION_ID: "parent-session-999" },
          runCommand: (cmd, args, opts) => {
            calls.push({ cmd, args, env: opts.env });
            if (cmd === "git" && args[0] === "rev-parse") {
              return { status: 0, stdout: `${repoDir}\n`, stderr: "" };
            }
            if (cmd === "python3" && args.includes("init")) {
              return {
                status: 0,
                stdout: JSON.stringify({ status: "active", task_id: "task-side" }),
                stderr: "",
              };
            }
            if (cmd === "python3" && args.includes("dispatch")) {
              return {
                status: 0,
                stdout: JSON.stringify({
                  run_id: "run-inv-1",
                  engine: "codex",
                  model: "gpt-5.6-sol",
                }),
                stderr: "",
              };
            }
            return { status: 0, stdout: "", stderr: "" };
          },
        },
      );

      expect(res.mode).toBe("investigate");
      expect(res.status).toBe("dispatched");
      expect(res.memberId).toBe("side-1");
      expect(res.roomId).toBe("room-alpha");
      expect(res.runId).toBe("run-inv-1");
      expect(res.worktreePath).toBeNull();
      expect(res.isolatedInbox).toBe(true);
      expect(res.parentInboxTouched).toBe(false);

      // Verify parent session env var was stripped from coordinator subprocesses
      const coordCalls = calls.filter((c) => c.cmd === "python3");
      expect(coordCalls.length).toBe(2);
      for (const call of coordCalls) {
        expect(call.env.CLAUDE_SESSION_ID).toBeUndefined();
        expect(call.env.AGENT_MAILBOX_SESSION).toBe("side-coord-inv01");
      }

      // Verify room registration: the member satisfies the room schema readers validate against.
      const updatedRoom = await readRoom(path.basename(roomPath, ".json"), mailboxDir);
      expect(updatedRoom.agents).toHaveLength(1);
      expect(updatedRoom.agents[0]).toMatchObject({
        id: "side-1",
        role: "worker",
        workforceRole: "scout",
        engine: "codex",
        model: "gpt-5.6-sol",
        effort: "medium",
        sideMode: "investigate",
        isolatedInbox: true,
        cwd: repoDir,
        dispatch: {
          taskDir: path.join(cacheDir, "side-missions", "side-inv01"),
          taskId: "task-side",
          requestId: "side-inv01-run-1",
          transport: "executor",
          runId: "run-inv-1",
        },
      });
    });

    it("validates an investigate spec through the real coordinator init", async () => {
      expect(spawnSync("git", ["init", repoDir], { encoding: "utf8" }).status).toBe(0);
      writeRoom("room-real", { session: "parent-real" });
      const result = await sideCommand(
        ["--investigate", "--session", "parent-real", "--json", "trace the parser"],
        {
          cwd: repoDir,
          mailboxDir,
          cacheDir,
          shortId: "schema",
          env: {
            ...process.env,
            ORCHESTRATE_HOME: cacheDir,
            AGENT_EXECUTOR_HOME: cacheDir,
            PYTHONDONTWRITEBYTECODE: "1",
          },
          runCommand: (cmd, args, opts) => {
            if (args.includes("dispatch"))
              return { status: 0, stdout: '{"run_id":"controlled-run"}', stderr: "" };
            return spawnSync(cmd, args, { ...opts, encoding: "utf8" });
          },
        },
      );
      expect(result.status).toBe("dispatched");
      const task = JSON.parse(
        fs.readFileSync(path.join(cacheDir, "side-missions", "side-schema", "task.json"), "utf8"),
      );
      expect(task.task_spec.scope_owner).toBe("conductor");
      expect(task.task_spec.effective_scope).toEqual([]);
      // The registered member names the task the real coordinator created and passes room validation.
      expect(result.roomId).toBe("room-real");
      const room = await readRoom("room-real", mailboxDir);
      expect(room.agents[0].dispatch).toMatchObject({
        taskId: task.task_id,
        requestId: "side-schema-run-1",
        transport: "executor",
        runId: "controlled-run",
      });
    });

    it("preserves both registrations after two processes discover the same room snapshot", async () => {
      const roomPath = writeRoom("concurrent");
      const script = `
        import fs from "node:fs";
        import { sideCommand } from ${JSON.stringify(new URL("../../../src/lib/side.mjs", import.meta.url).href)};
        const [cwd, mailboxDir, cacheDir, shortId] = process.argv.slice(1);
        const result = await sideCommand(["--investigate", "--room", "concurrent", "--json", "trace " + shortId], {
          cwd, mailboxDir, cacheDir, shortId,
          runCommand: (cmd, args) => {
            if (cmd === "git") return { status: 0, stdout: cwd, stderr: "" };
            if (args.includes("dispatch")) {
              fs.writeFileSync(cacheDir + "/ready-" + shortId, "ready");
              const deadline = Date.now() + 20000;
              while (!fs.existsSync(cacheDir + "/release")) {
                if (Date.now() > deadline) throw new Error("barrier timed out");
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
              }
              return { status: 0, stdout: JSON.stringify({ run_id: shortId, engine: "codex", model: "test-model" }), stderr: "" };
            }
            return { status: 0, stdout: JSON.stringify({ task_id: "task-" + shortId }), stderr: "" };
          },
        });
        console.log(JSON.stringify(result));
      `;
      const children = ["first", "second"].map((id) => {
        const child = spawn(process.execPath, [
          "--input-type=module",
          "-e",
          script,
          repoDir,
          mailboxDir,
          cacheDir,
          id,
        ]);
        let output = "";
        let errors = "";
        child.stdout.on("data", (chunk) => {
          output += chunk;
        });
        child.stderr.on("data", (chunk) => {
          errors += chunk;
        });
        return { child, done: once(child, "close"), output: () => output, errors: () => errors };
      });
      let isReady = false;
      try {
        await vi.waitFor(
          () => {
            expect(
              ["first", "second"].map((id) => fs.existsSync(path.join(cacheDir, `ready-${id}`))),
            ).toEqual([true, true]);
            isReady = true;
          },
          // Two cold Node processes can take several seconds to start on shared CI runners.
          { timeout: 20_000 },
        );
      } finally {
        fs.writeFileSync(path.join(cacheDir, "release"), "go");
        await Promise.all(children.map(({ done }) => done));
        // This has flaked on macOS CI with one process never reaching dispatch; say why.
        if (!isReady) {
          console.error(
            children.map(({ child, errors, output }) => ({
              code: child.exitCode,
              errors: errors(),
              output: output(),
            })),
          );
        }
      }
      for (const child of children) {
        expect(child.child.exitCode, child.errors()).toBe(0);
        expect(JSON.parse(child.output()).status).toBe("dispatched");
      }
      const room = readRawRoom(path.basename(roomPath, ".json"), mailboxDir);
      expect(room.agents.map((agent) => agent.id).sort((a, b) => a.localeCompare(b))).toEqual([
        "side-1",
        "side-2",
      ]);
      expect(
        room.agents.map((agent) => agent.dispatch.runId).sort((a, b) => a.localeCompare(b)),
      ).toEqual(["first", "second"]);
    }, 60_000);

    it("provisions an isolated git worktree, copies .worktreeinclude, and registers side-1 in execute mode", async () => {
      const roomPath = writeRoom("room-beta", {
        session: "parent-session-777",
        agents: [
          { id: "side-1", engine: "codex", model: "gpt-5.6-sol", role: "worker", sideId: "old" },
        ],
      });
      fs.writeFileSync(path.join(repoDir, ".worktreeinclude"), ".env.local\n", "utf8");
      fs.writeFileSync(path.join(repoDir, ".env.local"), "SECRET_TOKEN=test\n", "utf8");

      const calls = [];
      const res = await sideCommand(
        ["--room", "room-beta", "--json", "fix the off-by-one error in pagination"],
        {
          cwd: repoDir,
          mailboxDir,
          cacheDir,
          shortId: "exec02",
          runCommand: (cmd, args, opts) => {
            calls.push({ cmd, args, cwd: opts.cwd });
            if (cmd === "git" && args[0] === "rev-parse") {
              return { status: 0, stdout: `${repoDir}\n`, stderr: "" };
            }
            if (cmd === "git" && args[0] === "worktree" && args[1] === "add") {
              const wtPath = args[4];
              fs.mkdirSync(wtPath, { recursive: true });
              return { status: 0, stdout: "", stderr: "" };
            }
            if (cmd === "python3" && args.includes("init")) {
              return {
                status: 0,
                stdout: JSON.stringify({ status: "active", task_id: "task-side" }),
                stderr: "",
              };
            }
            if (cmd === "python3" && args.includes("dispatch")) {
              return {
                status: 0,
                stdout: JSON.stringify({
                  run_id: "run-exec-2",
                  engine: "codex",
                  model: "gpt-5.6-sol",
                }),
                stderr: "",
              };
            }
            return { status: 0, stdout: "", stderr: "" };
          },
        },
      );

      expect(res.mode).toBe("execute");
      expect(res.status).toBe("dispatched");
      expect(res.memberId).toBe("side-2");
      expect(res.roomId).toBe("room-beta");
      expect(res.branch).toBe("ork/side-exec02");
      expect(res.worktreePath).toBe(path.join(repoDir, ".worktrees", "wt-side-exec02"));
      expect(fs.existsSync(path.join(res.worktreePath, ".env.local"))).toBe(true);

      const updatedRoom = readRawRoom(path.basename(roomPath, ".json"), mailboxDir);
      expect(updatedRoom.agents).toHaveLength(2);
      expect(updatedRoom.agents[1].id).toBe("side-2");
      expect(updatedRoom.agents[1].keepWorktree).toBe(true);
      expect(updatedRoom.agents[1].worktree).toEqual({
        path: res.worktreePath,
        branch: "ork/side-exec02",
        disposable: false,
        parentCwd: repoDir,
        slug: "wt-side-exec02",
      });
      expect(updatedRoom.agents[1]).toMatchObject({
        role: "worker",
        workforceRole: "builder",
        cwd: res.worktreePath,
      });
      await expect(readRoom("room-beta", mailboxDir)).resolves.toBeTruthy();
    });

    it("keeps the detached fallback when the side branch already exists", async () => {
      writeRoom("room-detached", { session: "parent-session-detached" });
      spawnSync("git", ["init"], { cwd: repoDir, stdio: "ignore" });
      spawnSync("git", ["config", "user.name", "Side Worktree Tests"], { cwd: repoDir });
      spawnSync("git", ["config", "user.email", "side-worktree@example.invalid"], {
        cwd: repoDir,
      });
      fs.writeFileSync(path.join(repoDir, "tracked.txt"), "fixture\n", "utf8");
      spawnSync("git", ["add", "tracked.txt"], { cwd: repoDir });
      spawnSync("git", ["commit", "-m", "side fixture"], { cwd: repoDir, stdio: "ignore" });
      spawnSync("git", ["branch", "ork/side-detach01"], { cwd: repoDir });

      const res = await sideCommand(["--room", "room-detached", "--json", "fix a fixture"], {
        cwd: repoDir,
        mailboxDir,
        cacheDir,
        shortId: "detach01",
        runCommand: (cmd, args, opts) => {
          if (cmd === "git") {
            const result = spawnSync(cmd, args, { cwd: opts.cwd, encoding: "utf8" });
            return {
              status: result.status,
              stdout: result.stdout || "",
              stderr: result.stderr || "",
            };
          }
          if (cmd === "python3" && args.includes("init"))
            return { status: 0, stdout: JSON.stringify({ status: "active" }), stderr: "" };
          if (cmd === "python3" && args.includes("dispatch"))
            return {
              status: 0,
              stdout: JSON.stringify({ run_id: "run-detached", engine: "codex", model: "test" }),
              stderr: "",
            };
          return { status: 0, stdout: "", stderr: "" };
        },
      });

      expect(res.status).toBe("dispatched");
      // Git reports the resolved checkout, which differs from the temp path where it is a symlink.
      expect(res.worktreePath).toBe(
        path.join(fs.realpathSync(repoDir), ".worktrees", "wt-side-detach01"),
      );
      const branch = spawnSync("git", ["branch", "--show-current"], {
        cwd: res.worktreePath,
        encoding: "utf8",
      });
      expect(branch.stdout.trim()).toBe("");
      expect(branch.status).toBe(0);
    });

    function initSideRepo() {
      spawnSync("git", ["init", "-b", "main"], { cwd: repoDir, stdio: "ignore" });
      spawnSync("git", ["config", "user.name", "Side Worktree Tests"], { cwd: repoDir });
      spawnSync("git", ["config", "user.email", "side-worktree@example.invalid"], {
        cwd: repoDir,
      });
      fs.writeFileSync(path.join(repoDir, "tracked.txt"), "fixture\n", "utf8");
      spawnSync("git", ["add", "tracked.txt"], { cwd: repoDir });
      spawnSync("git", ["commit", "-m", "side fixture"], { cwd: repoDir, stdio: "ignore" });
    }

    function gitRunner(seen) {
      return (cmd, args, opts) => {
        if (cmd === "git") {
          const result = spawnSync(cmd, args, { cwd: opts.cwd, encoding: "utf8" });
          return {
            status: result.status,
            stdout: result.stdout || "",
            stderr: result.stderr || "",
          };
        }
        if (cmd === "python3" && args.includes("init")) {
          seen.initEnv = opts.env;
          return { status: 0, stdout: JSON.stringify({ status: "active" }), stderr: "" };
        }
        if (cmd === "python3" && args.includes("dispatch")) {
          seen.dispatchEnv = opts.env;
          return {
            status: 0,
            stdout: JSON.stringify({ run_id: "run-ports", engine: "codex", model: "test" }),
            stderr: "",
          };
        }
        return { status: 0, stdout: "", stderr: "" };
      };
    }

    it("prepares the detached fallback like every other path and passes ports to the launch env", async () => {
      writeRoom("room-prepared", { session: "parent-session-prepared" });
      initSideRepo();
      spawnSync("git", ["branch", "ork/side-prep01"], { cwd: repoDir });
      fs.mkdirSync(path.join(repoDir, ".orkest"));
      fs.writeFileSync(
        path.join(repoDir, ".orkest", "worktree.json"),
        JSON.stringify({ version: 1, copyFiles: ["local.json"], ports: { names: ["WEB_PORT"] } }),
      );
      fs.writeFileSync(path.join(repoDir, "local.json"), '{"local":true}\n');
      const env = { ...process.env, ORCHESTRATE_HOME: path.join(tmpDir, "ports-cache") };
      const seen = {};

      const res = await sideCommand(["--room", "room-prepared", "--json", "fix a fixture"], {
        cwd: repoDir,
        env,
        mailboxDir,
        cacheDir,
        shortId: "prep01",
        runCommand: gitRunner(seen),
      });

      expect(res.status).toBe("dispatched");
      expect(fs.readFileSync(path.join(res.worktreePath, "local.json"), "utf8")).toBe(
        '{"local":true}\n',
      );
      const ports = listWorktreePorts({ repoRoot: repoDir, worktreePath: res.worktreePath, env });
      expect(ports).toHaveLength(1);
      expect(seen.initEnv.WEB_PORT).toBe(String(ports[0].port));
      expect(seen.dispatchEnv.WEB_PORT).toBe(String(ports[0].port));
    });

    it("keeps the detached worktree and surfaces the stage when its preparation fails", async () => {
      writeRoom("room-prep-fail", { session: "parent-session-prep-fail" });
      initSideRepo();
      spawnSync("git", ["branch", "ork/side-fail01"], { cwd: repoDir });
      fs.mkdirSync(path.join(repoDir, ".orkest"));
      fs.writeFileSync(path.join(repoDir, ".orkest", "worktree.json"), '{"version":1,"x":1}');

      await expect(
        sideCommand(["--room", "room-prep-fail", "--json", "fix a fixture"], {
          cwd: repoDir,
          env: { ...process.env, ORCHESTRATE_HOME: path.join(tmpDir, "fail-cache") },
          mailboxDir,
          cacheDir,
          shortId: "fail01",
          runCommand: gitRunner({}),
        }),
      ).rejects.toMatchObject({ stage: "bootstrap", substage: "config" });
      expect(fs.existsSync(path.join(repoDir, ".worktrees", "wt-side-fail01"))).toBe(true);
    });

    it("enforces per-repo harness/tag/account denylist policy and resolves multi-provider N-accounts via Monitor config", async () => {
      const fakeHome = path.join(tmpDir, "home-multi");
      fs.mkdirSync(fakeHome, { recursive: true });
      const monitorCfgPath = path.join(tmpDir, "monitor-multi.json");
      const claudeWorkDir = path.join(fakeHome, ".claude");
      const claudeP1Dir = path.join(fakeHome, ".claude-p1");
      const claudeP2Dir = path.join(fakeHome, ".claude-p2");
      const claudeAcmeDir = path.join(fakeHome, ".claude-acme");
      const codexPersHome = path.join(fakeHome, ".codex-personal");
      const agyPersHome = path.join(fakeHome, ".gemini-personal");
      fs.writeFileSync(
        monitorCfgPath,
        JSON.stringify({
          accounts: [
            { id: "claude-work-1", provider: "claude", tags: ["work"] },
            {
              id: "claude-work-2",
              provider: "claude",
              configDir: "~/.claude-w2",
              tags: ["work"],
            },
            {
              id: "claude-p1",
              alias: "claude-alt",
              provider: "claude",
              configDir: claudeP1Dir,
              tags: ["personal"],
            },
            {
              id: "claude-p2",
              provider: "claude",
              configDir: claudeP2Dir,
              tags: ["personal"],
            },
            {
              id: "claude-acme",
              provider: "claude",
              configDir: claudeAcmeDir,
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
            {
              id: "agy-p1",
              alias: "agy-pers",
              provider: "antigravity",
              agyHome: agyPersHome,
              tags: ["personal"],
            },
          ],
        }),
        "utf8",
      );

      const configDir = path.join(tmpDir, "config");
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        path.join(configDir, "config.json"),
        JSON.stringify({
          repo_policies: {
            [repoDir]: {
              deny: ["opencode", "work", "client-acme"],
            },
          },
        }),
        "utf8",
      );
      const baseEnv = {
        PATH: process.env.PATH,
        HOME: fakeHome,
        MONITOR_CONFIG: monitorCfgPath,
      };

      // 1. Explicit denied engine ("opencode") returns policy_denied
      const denied = await sideCommand(["--engine", "opencode", "--json", "fix pagination"], {
        cwd: repoDir,
        mailboxDir,
        cacheDir,
        configDir,
        env: baseEnv,
        runCommand: (cmd, args) => {
          if (cmd === "git" && args[0] === "rev-parse") {
            return { status: 0, stdout: `${repoDir}\n`, stderr: "" };
          }
          return { status: 0, stdout: "", stderr: "" };
        },
      });
      expect(denied.status).toBe("policy_denied");
      expect(denied.error).toContain("opencode");

      // 2. Explicit --engine claude when work accounts are denied: refuses with ORCHESTRATE_AUTO_ACCOUNT off, reroutes to first allowed personal account when on
      const claudeFlagOff = checkRepoPolicyForSide(repoDir, "claude", {
        configDir,
        env: baseEnv,
      });
      expect(claudeFlagOff.ok).toBe(false);
      expect(claudeFlagOff.status).toBe("policy_denied");

      const claudePolicy = checkRepoPolicyForSide(repoDir, "claude", {
        configDir,
        env: { ...baseEnv, ORCHESTRATE_AUTO_ACCOUNT: "1" },
      });
      expect(claudePolicy.ok).toBe(true);
      expect(claudePolicy.accountId).toBe("claude-p1");
      expect(claudePolicy.accountAlias).toBe("claude-alt");
      expect(claudePolicy.claudeConfigDir).toBe(claudeP1Dir);
      expect(claudePolicy.extraArgs).toEqual([
        "--claude-config-dir",
        claudeP1Dir,
        "--account",
        "claude-p1",
      ]);

      // 3. Explicit --account across Codex and Antigravity resolves codexHome / agyHome / accountEnv
      const codexPers = checkRepoPolicyForSide(repoDir, null, {
        configDir,
        account: "codex-pers",
        env: baseEnv,
      });
      expect(codexPers).toMatchObject({
        ok: true,
        engine: "codex",
        accountId: "codex-p1",
        accountAlias: "codex-pers",
        codexHome: codexPersHome,
        accountEnv: { CODEX_HOME: codexPersHome },
        extraArgs: ["--account", "codex-p1"],
      });

      const agyPers = checkRepoPolicyForSide(repoDir, null, {
        configDir,
        account: "agy-pers",
        env: baseEnv,
      });
      expect(agyPers).toMatchObject({
        ok: true,
        engine: "agy",
        accountId: "agy-p1",
        accountAlias: "agy-pers",
        agyHome: agyPersHome,
        accountEnv: { GEMINI_CLI_HOME: agyPersHome },
        extraArgs: ["--account", "agy-p1"],
      });

      // 4. Default engine fallback when codex and agy are denied selects allowed personal Claude account, skipping denied work/client-acme accounts
      fs.mkdirSync(path.join(repoDir, ".orkest"), { recursive: true });
      fs.writeFileSync(
        path.join(repoDir, ".orkest", "policy.json"),
        JSON.stringify({ deny: ["codex", "agy", "claude-p1"] }),
        "utf8",
      );
      const fallbackPolicy = checkRepoPolicyForSide(repoDir, null, { configDir, env: baseEnv });
      expect(fallbackPolicy).toMatchObject({
        ok: true,
        engine: "claude",
        accountId: "claude-p2",
        claudeConfigDir: claudeP2Dir,
        fallbackFrom: "codex",
      });

      // 5. Client-tagged account is denied when its tag is in policy.deny
      const acmeDenied = checkRepoPolicyForSide(repoDir, null, {
        configDir,
        account: "claude-acme",
        env: baseEnv,
      });
      expect(acmeDenied.ok).toBe(false);
      expect(acmeDenied.status).toBe("policy_denied");
      expect(fs.existsSync(claudeWorkDir)).toBe(false);
    });

    it("covers custom aliases via --engine/--account, env config file vs configDir, fallback order, all denied, and contradiction checks", async () => {
      const fakeHome = path.join(tmpDir, "home");
      fs.mkdirSync(fakeHome, { recursive: true });
      const expectedPersonalDir = path.join(fakeHome, ".claude-p1");
      const secondPersonalDir = path.join(fakeHome, ".claude-p2");
      const monitorCfgPath = path.join(tmpDir, "monitor-custom.json");
      fs.writeFileSync(
        monitorCfgPath,
        JSON.stringify({
          accounts: [
            { id: "claude-work", provider: "claude", tags: ["work"] },
            {
              id: "claude-p1",
              alias: "claude-alt",
              provider: "claude",
              configDir: expectedPersonalDir,
              tags: ["personal"],
            },
            {
              id: "claude-p2",
              provider: "claude",
              configDir: secondPersonalDir,
              tags: ["personal"],
            },
          ],
        }),
        "utf8",
      );
      const explicitCfgFile = path.join(tmpDir, "custom-orchestrate.json");
      fs.writeFileSync(
        explicitCfgFile,
        JSON.stringify({
          repo_policies: {
            [repoDir]: {
              deny: ["codex", "agy", "claude-work"],
            },
          },
        }),
        "utf8",
      );
      const envWithCfg = {
        PATH: process.env.PATH,
        HOME: fakeHome,
        ORCHESTRATE_CONFIG: explicitCfgFile,
        MONITOR_CONFIG: monitorCfgPath,
      };

      // 1. Auto-selection evaluates all configured accounts and picks claude-p1 when codex, agy, and claude-work are denied
      const fallbackAuto = checkRepoPolicyForSide(repoDir, null, { env: envWithCfg });
      expect(fallbackAuto).toMatchObject({
        ok: true,
        engine: "claude",
        accountId: "claude-p1",
        accountAlias: "claude-alt",
        fallbackFrom: "codex",
        claudeConfigDir: expectedPersonalDir,
        extraArgs: ["--claude-config-dir", expectedPersonalDir, "--account", "claude-p1"],
      });

      // 2. When all personal Claude accounts are also denied, auto-selection falls back to opencode
      fs.writeFileSync(
        explicitCfgFile,
        JSON.stringify({
          repo_policies: {
            [repoDir]: {
              deny: ["codex", "agy", "claude-work", "personal"],
            },
          },
        }),
        "utf8",
      );
      const fallbackOpencode = checkRepoPolicyForSide(repoDir, null, { env: envWithCfg });
      expect(fallbackOpencode).toMatchObject({
        ok: true,
        engine: "opencode",
        fallbackFrom: "codex",
      });

      // Restore deny list to allow personal accounts
      fs.writeFileSync(
        explicitCfgFile,
        JSON.stringify({
          repo_policies: {
            [repoDir]: {
              deny: ["codex", "agy", "claude-work"],
            },
          },
        }),
        "utf8",
      );

      // 3. Explicit work claude ("claude-work" or claude with ~/.claude) refuses even when ORCHESTRATE_AUTO_ACCOUNT=1
      const explicitWork = checkRepoPolicyForSide(repoDir, "claude-work", {
        env: { ...envWithCfg, ORCHESTRATE_AUTO_ACCOUNT: "1" },
      });
      expect(explicitWork.ok).toBe(false);
      expect(explicitWork.status).toBe("policy_denied");

      const explicitWorkDir = checkRepoPolicyForSide(repoDir, "claude", {
        claudeConfigDir: path.join(fakeHome, ".claude"),
        env: { ...envWithCfg, ORCHESTRATE_AUTO_ACCOUNT: "1" },
      });
      expect(explicitWorkDir.ok).toBe(false);

      // 4. Explicit custom alias "claude-alt" via --engine or --account succeeds and injects exact extraArgs once in sideCommand
      const explicitAlias = checkRepoPolicyForSide(repoDir, "claude-alt", { env: envWithCfg });
      expect(explicitAlias).toMatchObject({
        ok: true,
        engine: "claude",
        accountId: "claude-p1",
        accountAlias: "claude-alt",
        claudeConfigDir: expectedPersonalDir,
        extraArgs: ["--claude-config-dir", expectedPersonalDir, "--account", "claude-p1"],
      });

      let recordedDispatchArgs = [];
      const sideRes = await sideCommand(
        ["--account", "claude-alt", "--investigate", "--json", "check auth"],
        {
          cwd: repoDir,
          mailboxDir,
          cacheDir,
          env: envWithCfg,
          shortId: "alt01",
          runCommand: (cmd, args) => {
            if (cmd === "git" && args[0] === "rev-parse") {
              return { status: 0, stdout: `${repoDir}\n`, stderr: "" };
            }
            if (cmd === "python3" && args.includes("init")) {
              return { status: 0, stdout: JSON.stringify({ task_id: "t-1" }), stderr: "" };
            }
            if (cmd === "python3" && args.includes("dispatch")) {
              recordedDispatchArgs = args;
              return {
                status: 0,
                stdout: JSON.stringify({ run_id: "run-alt", engine: "claude", model: "sonnet" }),
                stderr: "",
              };
            }
            return { status: 0, stdout: "", stderr: "" };
          },
        },
      );
      expect(sideRes.status).toBe("dispatched");
      expect(sideRes.accountId).toBe("claude-p1");
      expect(sideRes.accountAlias).toBe("claude-alt");
      expect(recordedDispatchArgs.filter((token) => token === "--claude-config-dir")).toHaveLength(
        1,
      );
      expect(recordedDispatchArgs.filter((token) => token === "--account")).toHaveLength(1);
      expect(recordedDispatchArgs).toContain(expectedPersonalDir);
      expect(recordedDispatchArgs).toContain("claude-p1");

      // 5. Explicit configDir overrides env ORCHESTRATE_CONFIG
      const injectedConfigDir = path.join(tmpDir, "injected-cfg");
      fs.mkdirSync(injectedConfigDir, { recursive: true });
      fs.writeFileSync(
        path.join(injectedConfigDir, "config.json"),
        JSON.stringify({
          repo_policies: {
            [repoDir]: { deny: ["all"] },
          },
        }),
        "utf8",
      );
      const allDenied = checkRepoPolicyForSide(repoDir, null, {
        configDir: injectedConfigDir,
        env: { ...envWithCfg, ORCHESTRATE_AUTO_ACCOUNT: "1" },
      });
      expect(allDenied.ok).toBe(false);
      expect(allDenied.status).toBe("policy_denied");

      const explicitAliasAllDenied = checkRepoPolicyForSide(repoDir, "claude-alt", {
        configDir: injectedConfigDir,
        env: envWithCfg,
      });
      expect(explicitAliasAllDenied.ok).toBe(false);

      // 6. Contradictory account/alias vs claudeConfigDir or --engine is rejected before room/worktree creation
      const cleanConfigDir = path.join(tmpDir, "clean-cfg");
      fs.mkdirSync(cleanConfigDir, { recursive: true });
      fs.writeFileSync(path.join(cleanConfigDir, "config.json"), JSON.stringify({}), "utf8");
      const aliasWithWorkDir = checkRepoPolicyForSide(repoDir, "claude-alt", {
        configDir: cleanConfigDir,
        claudeConfigDir: path.join(fakeHome, ".claude"),
        env: { ...envWithCfg, HOME: fakeHome },
      });
      expect(aliasWithWorkDir.ok).toBe(false);
      expect(aliasWithWorkDir.status).toBe("profile_mismatch");
      expect(aliasWithWorkDir.error).toContain("contradicts");

      const workWithPersonalDir = checkRepoPolicyForSide(repoDir, "claude-work", {
        configDir: cleanConfigDir,
        claudeConfigDir: expectedPersonalDir,
        env: { ...envWithCfg, HOME: fakeHome },
      });
      expect(workWithPersonalDir.ok).toBe(false);
      expect(workWithPersonalDir.status).toBe("profile_mismatch");
      expect(workWithPersonalDir.error).toContain("contradicts");

      const engineVsAccountMismatch = checkRepoPolicyForSide(repoDir, "codex", {
        configDir: cleanConfigDir,
        account: "claude-alt",
        env: { ...envWithCfg, HOME: fakeHome },
      });
      expect(engineVsAccountMismatch.ok).toBe(false);
      expect(engineVsAccountMismatch.status).toBe("profile_mismatch");
      expect(engineVsAccountMismatch.error).toContain("contradicts");

      const sideMismatch = await sideCommand(
        ["--account", "claude-alt", "--json", "check profile mismatch"],
        {
          cwd: repoDir,
          mailboxDir,
          cacheDir,
          configDir: cleanConfigDir,
          claudeConfigDir: path.join(fakeHome, ".claude"),
          env: { ...envWithCfg, HOME: fakeHome },
          runCommand: (cmd, args) => {
            if (cmd === "git" && args[0] === "rev-parse") {
              return { status: 0, stdout: `${repoDir}\n`, stderr: "" };
            }
            throw new Error(`Unexpected command ${cmd} after profile mismatch`);
          },
        },
      );
      expect(sideMismatch.status).toBe("profile_mismatch");
      expect(fs.readdirSync(path.join(mailboxDir, "rooms"))).toEqual([]);
    });

    it("refuses archived or cancelled --room targets and skips them during auto-discovery", async () => {
      const archivedId = "archived-side";
      fs.writeFileSync(
        path.join(mailboxDir, "rooms", `${archivedId}.json`),
        JSON.stringify({
          schema: "agent-executor.room.v1",
          id: archivedId,
          cwd: repoDir,
          machine: os.hostname(),
          lifecycle: "archived",
          archivedAt: Date.now() - 1000,
          conductor: { engine: "claude" },
          agents: [],
        }),
        "utf8",
      );
      await expect(
        sideCommand(["--room", archivedId, "--dry-run", "audit auth"], {
          cwd: repoDir,
          mailboxDir,
          cacheDir,
          runCommand: (cmd, args) => {
            if (cmd === "git" && args[0] === "rev-parse") {
              return { status: 0, stdout: `${repoDir}\n`, stderr: "" };
            }
            return { status: 0, stdout: "", stderr: "" };
          },
        }),
      ).rejects.toThrow(/archived/u);

      // Auto-discovery with no active rooms returns standalone side plan (room: null) instead of adopting archived room.
      const plan = await sideCommand(["--dry-run", "--json", "standalone check"], {
        cwd: repoDir,
        mailboxDir,
        cacheDir,
        runCommand: (cmd, args) => {
          if (cmd === "git" && args[0] === "rev-parse") {
            return { status: 0, stdout: `${repoDir}\n`, stderr: "" };
          }
          return { status: 0, stdout: "", stderr: "" };
        },
      });
      expect(plan.roomId).toBeNull();
    });

    it("fails closed on malformed policy rules, rejects personal-named symlinks to ~/.claude, and preserves explicit claudeConfigDir during fallback", async () => {
      const fakeHome = path.join(tmpDir, "side-home");
      const workDir = path.join(fakeHome, ".claude");
      const personalDir = path.join(fakeHome, ".claude-p1");
      const personalSymlinkToWork = path.join(fakeHome, ".claude-personal-alias");
      fs.mkdirSync(workDir, { recursive: true });
      fs.mkdirSync(personalDir, { recursive: true });
      fs.symlinkSync(workDir, personalSymlinkToWork);

      const monitorCfgPath = path.join(tmpDir, "side-strict-monitor.json");
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

      const cfgFile = path.join(tmpDir, "side-strict-cfg.json");
      // 1. Malformed policy ("deny": "all") fails closed in strict mode before provisioning
      fs.writeFileSync(
        cfgFile,
        JSON.stringify({ repo_policies: [{ path: repoDir, deny: "all" }] }),
        "utf8",
      );
      expect(() =>
        checkRepoPolicyForSide(repoDir, "codex", {
          configPath: cfgFile,
          homeDir: fakeHome,
          env: { PATH: process.env.PATH, HOME: fakeHome, MONITOR_CONFIG: monitorCfgPath },
        }),
      ).toThrow(/expected array/u);
      await expect(
        sideCommand(["--engine", "codex", "--json", "malformed policy test"], {
          cwd: repoDir,
          mailboxDir,
          cacheDir,
          env: {
            PATH: process.env.PATH,
            HOME: fakeHome,
            ORCHESTRATE_CONFIG: cfgFile,
            MONITOR_CONFIG: monitorCfgPath,
          },
          runCommand: (cmd, args) => {
            if (cmd === "git" && args[0] === "rev-parse") {
              return { status: 0, stdout: `${repoDir}\n`, stderr: "" };
            }
            throw new Error(`Unexpected command ${cmd} on malformed policy`);
          },
        }),
      ).rejects.toThrow(/expected array/u);

      // 2. Personal-named symlink pointing to ~/.claude cannot bypass claude-work denial
      fs.writeFileSync(
        cfgFile,
        JSON.stringify({
          repo_policies: [{ path: repoDir, deny: ["codex", "agy", "claude-work"] }],
        }),
        "utf8",
      );
      const symlinkAttempt = checkRepoPolicyForSide(repoDir, "claude", {
        configPath: cfgFile,
        homeDir: fakeHome,
        claudeConfigDir: personalSymlinkToWork,
        env: { PATH: process.env.PATH, HOME: fakeHome, MONITOR_CONFIG: monitorCfgPath },
      });
      expect(symlinkAttempt.ok).toBe(false);
      expect(symlinkAttempt.status).toBe("policy_denied");

      // 3. Automatic engine selection preserves explicit personal claudeConfigDir on fallback to claude
      const autoFallbackPersonal = checkRepoPolicyForSide(repoDir, null, {
        configPath: cfgFile,
        homeDir: fakeHome,
        claudeConfigDir: personalDir,
        env: { PATH: process.env.PATH, HOME: fakeHome, MONITOR_CONFIG: monitorCfgPath },
      });
      expect(autoFallbackPersonal).toMatchObject({
        ok: true,
        engine: "claude",
        accountId: "claude-p1",
        accountAlias: "claude-alt",
        fallbackFrom: "codex",
        claudeConfigDir: personalDir,
        extraArgs: ["--claude-config-dir", personalDir, "--account", "claude-p1"],
      });

      // 4. Contradictory explicit work claudeConfigDir with ORCHESTRATE_AUTO_ACCOUNT=1 is not silently swapped to personal
      const workDeniedFallback = checkRepoPolicyForSide(repoDir, null, {
        configPath: cfgFile,
        homeDir: fakeHome,
        claudeConfigDir: workDir,
        candidates: ["codex", "agy", "claude"],
        env: {
          PATH: process.env.PATH,
          HOME: fakeHome,
          MONITOR_CONFIG: monitorCfgPath,
          ORCHESTRATE_AUTO_ACCOUNT: "1",
        },
      });
      expect(workDeniedFallback.ok).toBe(false);
      expect(workDeniedFallback.status).toBe("policy_denied");
    });

    it("allows --engine codex --account codex-blue when an id:'codex' account exists, and preserves caller HOME on coordinator.py env", async () => {
      const callerHome = path.join(tmpDir, "caller-home");
      const customClaudeHome = path.join(tmpDir, "custom-claude-home");
      const customCodexHome = path.join(tmpDir, "custom-codex-home");
      const customAgyHome = path.join(tmpDir, "custom-agy-home");
      fs.mkdirSync(callerHome, { recursive: true });
      fs.mkdirSync(customClaudeHome, { recursive: true });
      fs.mkdirSync(customCodexHome, { recursive: true });
      fs.mkdirSync(customAgyHome, { recursive: true });

      const monitorCfgPath = path.join(tmpDir, "monitor-collision-home.json");
      fs.writeFileSync(
        monitorCfgPath,
        JSON.stringify({
          accounts: [
            { id: "codex", provider: "codex", tags: ["work"] },
            {
              id: "codex-blue",
              provider: "codex",
              codexHome: path.join(callerHome, ".codex-blue"),
              tags: ["personal"],
            },
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
            {
              id: "agy-alt-home",
              provider: "antigravity",
              env: { HOME: customAgyHome },
              tags: ["personal"],
            },
          ],
        }),
        "utf8",
      );

      const cleanCfgDir = path.join(tmpDir, "clean-collision-cfg");
      fs.mkdirSync(cleanCfgDir, { recursive: true });
      fs.writeFileSync(path.join(cleanCfgDir, "config.json"), JSON.stringify({}), "utf8");
      const testEnv = {
        PATH: process.env.PATH,
        HOME: callerHome,
        MONITOR_CONFIG: monitorCfgPath,
      };

      // 1. Canonical engine token "codex" does not collide with an account whose id is "codex"
      const codexBluePolicy = checkRepoPolicyForSide(repoDir, "codex", {
        configDir: cleanCfgDir,
        account: "codex-blue",
        env: testEnv,
      });
      expect(codexBluePolicy).toMatchObject({
        ok: true,
        engine: "codex",
        accountId: "codex-blue",
      });

      const codexBlueSide = await sideCommand(
        ["--engine", "codex", "--account", "codex-blue", "--investigate", "--json", "check codex"],
        {
          cwd: repoDir,
          mailboxDir,
          cacheDir,
          configDir: cleanCfgDir,
          env: testEnv,
          shortId: "blue01",
          runCommand: (cmd, args) => {
            if (cmd === "git" && args[0] === "rev-parse") {
              return { status: 0, stdout: `${repoDir}\n`, stderr: "" };
            }
            if (cmd === "python3" && args.includes("init")) {
              return { status: 0, stdout: JSON.stringify({ task_id: "t-blue" }), stderr: "" };
            }
            if (cmd === "python3" && args.includes("dispatch")) {
              return {
                status: 0,
                stdout: JSON.stringify({
                  run_id: "run-blue",
                  engine: "codex",
                  model: "gpt-5.6-sol",
                }),
                stderr: "",
              };
            }
            return { status: 0, stdout: "", stderr: "" };
          },
        },
      );
      expect(codexBlueSide.status).toBe("dispatched");
      expect(codexBlueSide.accountId).toBe("codex-blue");

      // 2. Mismatched canonical engine still rejects with profile_mismatch
      const engineMismatch = checkRepoPolicyForSide(repoDir, "claude", {
        configDir: cleanCfgDir,
        account: "codex-blue",
        env: testEnv,
      });
      expect(engineMismatch.ok).toBe(false);
      expect(engineMismatch.status).toBe("profile_mismatch");

      // 3. Account env.HOME translates to ORKEST_*_ACCOUNT_HOME and never overrides HOME on coordinator.py
      const claudeHomePolicy = checkRepoPolicyForSide(repoDir, "claude", {
        configDir: cleanCfgDir,
        account: "claude-alt-home",
        env: testEnv,
      });
      expect(claudeHomePolicy.ok).toBe(true);
      expect(claudeHomePolicy.accountEnv).toEqual({
        ORKEST_CLAUDE_ACCOUNT_HOME: customClaudeHome,
      });
      expect(claudeHomePolicy.accountEnv.HOME).toBeUndefined();
      expect(claudeHomePolicy.extraArgs).toEqual(["--account", "claude-alt-home"]);

      const codexHomePolicy = checkRepoPolicyForSide(repoDir, "codex", {
        configDir: cleanCfgDir,
        account: "codex-alt-home",
        env: testEnv,
      });
      expect(codexHomePolicy.ok).toBe(true);
      expect(codexHomePolicy.accountEnv).toEqual({
        ORKEST_CODEX_ACCOUNT_HOME: path.join(customCodexHome, ".codex"),
      });
      expect(codexHomePolicy.accountEnv.HOME).toBeUndefined();

      const agyHomePolicy = checkRepoPolicyForSide(repoDir, "agy", {
        configDir: cleanCfgDir,
        account: "agy-alt-home",
        env: testEnv,
      });
      expect(agyHomePolicy.ok).toBe(true);
      expect(agyHomePolicy.accountEnv).toEqual({
        ORKEST_AGY_ACCOUNT_HOME: path.join(customAgyHome, ".gemini"),
      });
      expect(agyHomePolicy.accountEnv.HOME).toBeUndefined();

      const coordCalls = [];
      const sideHomeRes = await sideCommand(
        ["--account", "claude-alt-home", "--investigate", "--json", "verify home isolation"],
        {
          cwd: repoDir,
          mailboxDir,
          cacheDir,
          configDir: cleanCfgDir,
          env: testEnv,
          shortId: "home01",
          runCommand: (cmd, args, opts) => {
            if (cmd === "git" && args[0] === "rev-parse") {
              return { status: 0, stdout: `${repoDir}\n`, stderr: "" };
            }
            if (cmd === "python3") {
              coordCalls.push({ args, env: opts.env });
              if (args.includes("init")) {
                return { status: 0, stdout: JSON.stringify({ task_id: "t-home" }), stderr: "" };
              }
              if (args.includes("dispatch")) {
                return {
                  status: 0,
                  stdout: JSON.stringify({ run_id: "run-home", engine: "claude", model: "sonnet" }),
                  stderr: "",
                };
              }
            }
            return { status: 0, stdout: "", stderr: "" };
          },
        },
      );
      expect(sideHomeRes.status).toBe("dispatched");
      expect(coordCalls).toHaveLength(2);
      for (const call of coordCalls) {
        expect(call.env.HOME).toBe(callerHome);
        expect(call.env.ORKEST_CLAUDE_ACCOUNT_HOME).toBe(customClaudeHome);
      }
      const dispatchCall = coordCalls.find((call) => call.args.includes("dispatch"));
      expect(dispatchCall.args).toEqual(expect.arrayContaining(["--account", "claude-alt-home"]));
    });

    it("forwards --account for codex and agy, strips raw provider env from coordinator.py, and fails closed on malformed monitor config", async () => {
      const callerHome = path.join(tmpDir, "side-env-home");
      const codexBlueHome = path.join(callerHome, ".codex-blue");
      const agyBlueHome = path.join(callerHome, ".gemini-blue");
      fs.mkdirSync(codexBlueHome, { recursive: true });
      fs.mkdirSync(agyBlueHome, { recursive: true });

      const monitorCfgPath = path.join(tmpDir, "monitor-provider-strip.json");
      fs.writeFileSync(
        monitorCfgPath,
        JSON.stringify({
          accounts: [
            { id: "codex-blue", provider: "codex", codexHome: codexBlueHome, tags: ["personal"] },
            { id: "agy-blue", provider: "antigravity", agyHome: agyBlueHome, tags: ["personal"] },
          ],
        }),
        "utf8",
      );

      const cleanCfgDir = path.join(tmpDir, "provider-strip-cfg");
      fs.mkdirSync(cleanCfgDir, { recursive: true });
      fs.writeFileSync(path.join(cleanCfgDir, "config.json"), JSON.stringify({}), "utf8");

      const pollutedEnv = {
        PATH: process.env.PATH,
        HOME: callerHome,
        MONITOR_CONFIG: monitorCfgPath,
        CODEX_HOME: "/stale/codex",
        GEMINI_CLI_HOME: "/stale/gemini",
        ANTIGRAVITY_APP_DATA_DIR: "/stale/agy",
        CLAUDE_CONFIG_DIR: "/stale/claude",
      };

      const runSideForAccount = async (account, engine, shortId) => {
        const coordCalls = [];
        const res = await sideCommand(
          ["--engine", engine, "--account", account, "--investigate", "--json", `check ${engine}`],
          {
            cwd: repoDir,
            mailboxDir,
            cacheDir,
            configDir: cleanCfgDir,
            env: pollutedEnv,
            shortId,
            runCommand: (cmd, args, opts) => {
              if (cmd === "git" && args[0] === "rev-parse") {
                return { status: 0, stdout: `${repoDir}\n`, stderr: "" };
              }
              if (cmd === "python3") {
                coordCalls.push({ args, env: opts.env });
                if (args.includes("init")) {
                  return {
                    status: 0,
                    stdout: JSON.stringify({ task_id: `t-${shortId}` }),
                    stderr: "",
                  };
                }
                if (args.includes("dispatch")) {
                  return {
                    status: 0,
                    stdout: JSON.stringify({ run_id: `run-${shortId}`, engine, model: "m1" }),
                    stderr: "",
                  };
                }
              }
              return { status: 0, stdout: "", stderr: "" };
            },
          },
        );
        return { res, coordCalls };
      };

      const codexRun = await runSideForAccount("codex-blue", "codex", "cx01");
      expect(codexRun.res.status).toBe("dispatched");
      expect(codexRun.coordCalls).toHaveLength(2);
      for (const call of codexRun.coordCalls) {
        expect(call.env.HOME).toBe(callerHome);
        expect(call.env.ORKEST_CODEX_ACCOUNT_HOME).toBe(codexBlueHome);
        expect(call.env.CODEX_HOME).toBeUndefined();
        expect(call.env.GEMINI_CLI_HOME).toBeUndefined();
        expect(call.env.ANTIGRAVITY_APP_DATA_DIR).toBeUndefined();
        expect(call.env.CLAUDE_CONFIG_DIR).toBeUndefined();
      }
      const codexDispatch = codexRun.coordCalls.find((call) => call.args.includes("dispatch"));
      expect(codexDispatch.args).toEqual(expect.arrayContaining(["--account", "codex-blue"]));

      const agyRun = await runSideForAccount("agy-blue", "agy", "ag01");
      expect(agyRun.res.status).toBe("dispatched");
      expect(agyRun.coordCalls).toHaveLength(2);
      for (const call of agyRun.coordCalls) {
        expect(call.env.HOME).toBe(callerHome);
        expect(call.env.ORKEST_AGY_ACCOUNT_HOME).toBe(agyBlueHome);
        expect(call.env.CODEX_HOME).toBeUndefined();
        expect(call.env.GEMINI_CLI_HOME).toBeUndefined();
        expect(call.env.ANTIGRAVITY_APP_DATA_DIR).toBeUndefined();
        expect(call.env.CLAUDE_CONFIG_DIR).toBeUndefined();
      }
      const agyDispatch = agyRun.coordCalls.find((call) => call.args.includes("dispatch"));
      expect(agyDispatch.args).toEqual(expect.arrayContaining(["--account", "agy-blue"]));

      const badMonitorCfg = path.join(tmpDir, "malformed-monitor.json");
      fs.writeFileSync(badMonitorCfg, "{ not valid json", "utf8");
      expect(() =>
        checkRepoPolicyForSide(repoDir, "codex", {
          configDir: cleanCfgDir,
          env: { PATH: process.env.PATH, HOME: callerHome, MONITOR_CONFIG: badMonitorCfg },
        }),
      ).toThrow(/Failed to parse policy JSON/);
    });
  });
});
