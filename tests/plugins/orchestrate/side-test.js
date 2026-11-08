import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readRawRoom } from "../../../plugins/orchestrate/lib/horde-room.mjs";
import {
  checkRepoPolicyForSide,
  classifySideMode,
  parseSideArgs,
  SIDE_HELP,
  sideCommand,
} from "../../../plugins/orchestrate/lib/side.mjs";

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
            stdout: JSON.stringify({ id: "work-side-park01", status: "open" }),
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
      const roomPath = path.join(mailboxDir, "rooms", "room-alpha.json");
      fs.writeFileSync(
        roomPath,
        JSON.stringify({
          id: "room-alpha",
          cwd: repoDir,
          parent: { id: "conductor", session: "parent-session-999" },
          agents: [],
        }),
        "utf8",
      );

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
              return { status: 0, stdout: JSON.stringify({ status: "active" }), stderr: "" };
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

      // Verify room registration
      const updatedRoom = readRawRoom(path.basename(roomPath, ".json"), mailboxDir);
      expect(updatedRoom.agents).toHaveLength(1);
      expect(updatedRoom.agents[0].id).toBe("side-1");
      expect(updatedRoom.agents[0].role).toBe("side");
      expect(updatedRoom.agents[0].sideMode).toBe("investigate");
      expect(updatedRoom.agents[0].isolatedInbox).toBe(true);
      expect(updatedRoom.agents[0].dispatch.runId).toBe("run-inv-1");
    });

    it("validates an investigate spec through the real coordinator init", async () => {
      expect(spawnSync("git", ["init", repoDir], { encoding: "utf8" }).status).toBe(0);
      const result = await sideCommand(["--investigate", "--json", "trace the parser"], {
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
      });
      expect(result.status).toBe("dispatched");
      const task = JSON.parse(
        fs.readFileSync(path.join(cacheDir, "side-missions", "side-schema", "task.json"), "utf8"),
      );
      expect(task.task_spec.scope_owner).toBe("conductor");
      expect(task.task_spec.effective_scope).toEqual([]);
    });

    it("preserves both registrations after two processes discover the same room snapshot", async () => {
      const roomPath = path.join(mailboxDir, "rooms", "concurrent.json");
      fs.writeFileSync(roomPath, JSON.stringify({ id: "concurrent", cwd: repoDir, agents: [] }));
      const script = `
        import fs from "node:fs";
        import { sideCommand } from ${JSON.stringify(new URL("../../../plugins/orchestrate/lib/side.mjs", import.meta.url).href)};
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
            return { status: 0, stdout: "{}", stderr: "" };
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
      try {
        await vi.waitFor(
          () => {
            expect(
              ["first", "second"].map((id) => fs.existsSync(path.join(cacheDir, `ready-${id}`))),
            ).toEqual([true, true]);
          },
          // Two cold Node processes can take several seconds to start on shared CI runners.
          { timeout: 20_000 },
        );
      } finally {
        fs.writeFileSync(path.join(cacheDir, "release"), "go");
        await Promise.all(children.map(({ done }) => done));
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
      const roomPath = path.join(mailboxDir, "rooms", "room-beta.json");
      fs.writeFileSync(
        roomPath,
        JSON.stringify({
          id: "room-beta",
          cwd: repoDir,
          parent: { id: "conductor", session: "parent-session-777" },
          agents: [{ id: "side-1", role: "side" }],
        }),
        "utf8",
      );
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
              return { status: 0, stdout: JSON.stringify({ status: "active" }), stderr: "" };
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
      });
    });

    it("enforces per-repo harness denylist policy and routes personal Claude to ~/.claude-personal", async () => {
      const configDir = path.join(tmpDir, "config");
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        path.join(configDir, "config.json"),
        JSON.stringify({
          repo_policies: {
            [repoDir]: {
              deny: ["opencode", "claude-work"],
            },
          },
        }),
        "utf8",
      );

      // 1. Explicit denied engine ("opencode") returns policy_denied
      const denied = await sideCommand(["--engine", "opencode", "--json", "fix pagination"], {
        cwd: repoDir,
        mailboxDir,
        cacheDir,
        configDir,
        runCommand: (cmd, args) => {
          if (cmd === "git" && args[0] === "rev-parse") {
            return { status: 0, stdout: `${repoDir}\n`, stderr: "" };
          }
          return { status: 0, stdout: "", stderr: "" };
        },
      });
      expect(denied.status).toBe("policy_denied");
      expect(denied.error).toContain("opencode");

      // 2. Explicit --engine claude when claude-work is denied routes to ~/.claude-personal (plaude)
      const claudePolicy = checkRepoPolicyForSide(repoDir, "claude", { configDir });
      expect(claudePolicy.ok).toBe(true);
      expect(claudePolicy.profile).toBe("plaude");
      expect(claudePolicy.claudeConfigDir).toBe(path.join(os.homedir(), ".claude-personal"));
      expect(claudePolicy.extraArgs).toEqual([
        "--claude-config-dir",
        path.join(os.homedir(), ".claude-personal"),
      ]);

      // 3. Default engine fallback when codex is denied in .orkest/policy.json
      fs.mkdirSync(path.join(repoDir, ".orkest"), { recursive: true });
      fs.writeFileSync(
        path.join(repoDir, ".orkest", "policy.json"),
        JSON.stringify({ deny: ["codex"] }),
        "utf8",
      );
      const fallbackPolicy = checkRepoPolicyForSide(repoDir, null, { configDir });
      expect(fallbackPolicy.ok).toBe(true);
      expect(fallbackPolicy.engine).toBe("agy");
      expect(fallbackPolicy.fallbackFrom).toBe("codex");
    });
  });
});
