import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  HerdrCliError,
  inspectAgent,
  lookupWorkspace,
  openWorktreePane,
  resolveAgentPane,
  runHerdr,
  showNotification,
  trustedWorktreePath,
} from "../../../plugins/orchestrate/lib/herdr-cli.mjs";
import { herdrEndpoint } from "../../../plugins/orchestrate/lib/herdr-context.mjs";

/** A fake `herdr` binary: records argv and options, answers from a handler. */
function fakeHerdr(handler = () => ({ stdout: "{}" })) {
  const calls = [];
  const exec = (binary, args, options, callback) => {
    calls.push({ binary, args, options });
    const answer = handler(args, options);
    if (answer.error) callback(answer.error);
    else if (!answer.hang) callback(null, answer.stdout);
  };
  return { calls, exec };
}

function workspaceInfo(id, checkout = {}) {
  return {
    type: "workspace_info",
    workspace: {
      workspace_id: id,
      number: 1,
      label: "main",
      ...(checkout && {
        worktree: {
          repo_key: "k",
          repo_name: "repo",
          repo_root: "/nonexistent",
          checkout_path: "/nonexistent",
          is_linked_worktree: false,
          ...checkout,
        },
      }),
    },
  };
}

function worktreeOpened(worktreePath, overrides = {}) {
  return {
    type: "worktree_opened",
    workspace: { workspace_id: "w3" },
    tab: { tab_id: "w3:t1", workspace_id: "w3" },
    root_pane: { pane_id: "w3:p1", terminal_id: "t1" },
    worktree: { path: worktreePath, is_bare: false, is_linked_worktree: true, label: "wt" },
    already_open: false,
    ...overrides,
  };
}

const ok = (result) => ({ stdout: JSON.stringify({ id: "cli", result }) });

describe("herdr structured CLI operations", () => {
  let root;
  let env;
  beforeEach(() => {
    const base = mkdtempSync(path.join(tmpdir(), "herdr-cli-"));
    root = realpathSync(base);
    env = { HERDR_ENV: "1", HERDR_SOCKET_PATH: path.join(root, "herdr.sock") };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function makeWorktree(parent = path.join(root, "my repo"), slug = "wt one") {
    const worktree = path.join(parent, ".worktrees", slug);
    mkdirSync(worktree, { recursive: true });
    writeFileSync(path.join(worktree, ".git"), "gitdir: elsewhere\n");
    return { parent, worktree };
  }

  function agentAt({ parent, worktree }, extra = {}) {
    return {
      id: "a1",
      herdrPaneId: "w1:p2",
      herdrEndpoint: herdrEndpoint(env),
      worktree: { path: worktree, parentCwd: parent },
      ...extra,
    };
  }

  describe("runHerdr", () => {
    it("passes argv verbatim, honours HERDR_BIN_PATH and bounds the call", async () => {
      const fake = fakeHerdr();
      await runHerdr(["pane", "get", "--odd arg"], {
        env: { ...env, HERDR_BIN_PATH: "/opt/herdr bin/herdr" },
        exec: fake.exec,
        cwd: root,
        timeoutMs: 700,
      });
      expect(fake.calls).toHaveLength(1);
      expect(fake.calls[0].binary).toBe("/opt/herdr bin/herdr");
      expect(fake.calls[0].args).toEqual(["pane", "get", "--odd arg"]);
      expect(fake.calls[0].options).toMatchObject({ cwd: root, timeout: 700 });
      expect(fake.calls[0].options.shell).toBeUndefined();
    });

    it("rejects non-string arguments without running anything", async () => {
      const fake = fakeHerdr();
      await expect(runHerdr(["a", 1], { env, exec: fake.exec })).rejects.toMatchObject({
        code: "invalid_argument",
      });
      expect(fake.calls).toHaveLength(0);
    });

    it("reports a missing binary and a timeout with distinct codes", async () => {
      const missing = fakeHerdr(() => ({
        error: Object.assign(new Error("x"), { code: "ENOENT" }),
      }));
      await expect(runHerdr(["x"], { env, exec: missing.exec })).rejects.toMatchObject({
        code: "missing_binary",
      });
      const killed = fakeHerdr(() => ({ error: Object.assign(new Error("x"), { killed: true }) }));
      await expect(runHerdr(["x"], { env, exec: killed.exec })).rejects.toMatchObject({
        code: "timeout",
      });
    });

    it("bounds an executor that never answers", async () => {
      const hung = fakeHerdr(() => ({ hang: true }));
      const started = Date.now();
      await expect(runHerdr(["x"], { env, exec: hung.exec, timeoutMs: 20 })).rejects.toMatchObject({
        code: "timeout",
      });
      expect(Date.now() - started).toBeLessThan(2000);
    });
  });

  describe("workspace lookup and agent inspection", () => {
    it("validates workspace identifiers and the workspace_info envelope", async () => {
      const fake = fakeHerdr((args) => ok(workspaceInfo(args[2])));
      expect(await lookupWorkspace("w1", { env, exec: fake.exec })).toMatchObject({
        workspace_id: "w1",
        label: "main",
      });
      expect(fake.calls[0].args).toEqual(["workspace", "get", "w1"]);

      for (const bad of ["--help", "-x", "", "w 1", "w1\nw2", 7, "a".repeat(80)]) {
        await expect(lookupWorkspace(bad, { env, exec: fake.exec })).rejects.toMatchObject({
          code: "invalid_argument",
        });
      }
      expect(fake.calls).toHaveLength(1);

      const cases = {
        "another workspace": ok(workspaceInfo("w9")),
        "wrong type": ok({ ...workspaceInfo("w1"), type: "workspace_list" }),
        "missing type": ok({ workspace: workspaceInfo("w1").workspace }),
        "missing workspace": ok({ type: "workspace_info" }),
        "malformed worktree": ok({
          type: "workspace_info",
          workspace: { workspace_id: "w1", worktree: { repo_root: 1 } },
        }),
      };
      for (const [name, answer] of Object.entries(cases)) {
        const other = fakeHerdr(() => answer);
        await expect(lookupWorkspace("w1", { env, exec: other.exec }), name).rejects.toMatchObject({
          code: "invalid_result",
        });
      }
    });

    it("rejects malformed JSON, error envelopes and incomplete agent_info results", async () => {
      const garbage = fakeHerdr(() => ({ stdout: "not json" }));
      await expect(inspectAgent("w1:p1", { env, exec: garbage.exec })).rejects.toMatchObject({
        code: "invalid_result",
      });
      const refused = fakeHerdr(() => ({ stdout: '{"error":{"code":"nope","message":"gone"}}' }));
      await expect(inspectAgent("w1:p1", { env, exec: refused.exec })).rejects.toMatchObject({
        code: "failed",
      });
      const full = { terminal_id: "t1", workspace_id: "w1", tab_id: "w1:t1", pane_id: "w1:p1" };
      const cases = [
        { type: "pane_info", agent: full },
        { type: "agent_info" },
        { type: "agent_info", agent: { ...full, pane_id: "--evil" } },
        { type: "agent_info", agent: { ...full, workspace_id: undefined } },
        { type: "agent_info", agent: { ...full, tab_id: "a b" } },
        { type: "agent_info", agent: { ...full, terminal_id: "" } },
      ];
      for (const result of cases) {
        const fake = fakeHerdr(() => ok(result));
        await expect(inspectAgent("w1:p1", { env, exec: fake.exec })).rejects.toMatchObject({
          code: "invalid_result",
        });
      }
      const good = fakeHerdr(() => ok({ type: "agent_info", agent: full }));
      expect(await inspectAgent("w1:p1", { env, exec: good.exec })).toEqual(full);
      // Pane verification alone tolerates records without the locator keys, but not bad ones.
      const bare = fakeHerdr(() => ok({ type: "agent_info", agent: { agent_session: {} } }));
      expect(await inspectAgent("w1:p1", { env, exec: bare.exec, lenient: true })).toEqual({
        agent_session: {},
      });
      const bad = fakeHerdr(() => ok({ type: "agent_info", agent: { pane_id: "--x" } }));
      await expect(
        inspectAgent("w1:p1", { env, exec: bad.exec, lenient: true }),
      ).rejects.toMatchObject({ code: "invalid_result" });
    });

    it("resolves a moved pane through its alias and requires the same session", async () => {
      const fake = fakeHerdr((args) => {
        if (args[0] === "agent" && args[2] === "old:p1")
          return { error: new Error("no such pane") };
        if (args[0] === "pane") return ok({ pane: { pane_id: "w2:p5" } });
        return ok({
          type: "agent_info",
          agent: { pane_id: args[2], agent_session: { kind: "id", value: "s1" } },
        });
      });
      expect(await resolveAgentPane("old:p1", "s1", { env, exec: fake.exec })).toBe("w2:p5");
      expect(fake.calls.map((call) => call.args)).toEqual([
        ["agent", "get", "old:p1"],
        ["pane", "current", "--pane", "old:p1"],
        ["agent", "get", "w2:p5"],
      ]);
      expect(await resolveAgentPane("old:p1", "other", { env, exec: fake.exec })).toBeNull();
      expect(await resolveAgentPane("--bad", "s1", { env, exec: fake.exec })).toBeNull();
    });
  });

  describe("openWorktreePane", () => {
    /** Answers workspace get for `parentWorkspace` and worktree open with the upstream envelope. */
    function openHost(tree, overrides = {}, parentWorkspace = {}) {
      return fakeHerdr((args) => {
        if (args[0] === "workspace") {
          return ok(workspaceInfo(args[2], { repo_root: tree.parent, ...parentWorkspace }));
        }
        return ok(worktreeOpened(tree.worktree, overrides));
      });
    }
    const openArgs = (fake) => fake.calls.find((call) => call.args[0] === "worktree");

    it("uses --workspace alone when Herdr confirms it is the trusted repo's parent workspace", async () => {
      const tree = makeWorktree();
      const fake = openHost(tree);
      const result = await openWorktreePane(agentAt(tree), {
        env,
        exec: fake.exec,
        workspaceId: "w1",
      });
      expect(result).toEqual({
        workspaceId: "w3",
        tabId: "w3:t1",
        paneId: "w3:p1",
        alreadyOpen: false,
      });
      expect(fake.calls.map((call) => call.args[0])).toEqual(["workspace", "worktree"]);
      expect(openArgs(fake).args).toEqual([
        "worktree",
        "open",
        "--workspace",
        "w1",
        "--path",
        realpathSync(tree.worktree),
        "--focus",
      ]);
      expect(openArgs(fake).args).not.toContain("--cwd");
      expect(openArgs(fake).args).not.toContain("create");
      expect(openArgs(fake).args).not.toContain("--trust-repository");
      expect(openArgs(fake).options.cwd).toBe(realpathSync(tree.parent));
    });

    it("uses the explicit root --cwd alone when no workspace hint is given", async () => {
      const tree = makeWorktree();
      const fake = openHost(tree, { already_open: true });
      const result = await openWorktreePane(agentAt(tree), { env, exec: fake.exec });
      expect(result.alreadyOpen).toBe(true);
      expect(fake.calls).toHaveLength(1);
      expect(openArgs(fake).args).toEqual([
        "worktree",
        "open",
        "--cwd",
        realpathSync(tree.parent),
        "--path",
        realpathSync(tree.worktree),
        "--focus",
      ]);
      expect(openArgs(fake).args).not.toContain("--workspace");
    });

    it("falls back to --cwd when the workspace hint cannot be trusted", async () => {
      const tree = makeWorktree();
      const otherRepo = path.join(root, "other repo");
      mkdirSync(otherRepo);
      const untrusted = {
        "another repo": { repo_root: otherRepo },
        "linked worktree workspace": { is_linked_worktree: true },
      };
      for (const [name, parentWorkspace] of Object.entries(untrusted)) {
        const fake = openHost(tree, {}, parentWorkspace);
        await openWorktreePane(agentAt(tree), { env, exec: fake.exec, workspaceId: "w1" });
        const args = openArgs(fake).args;
        expect(args, name).toContain("--cwd");
        expect(args, name).not.toContain("--workspace");
      }
      const missing = fakeHerdr((args) =>
        args[0] === "workspace"
          ? { error: new Error("workspace_not_found") }
          : ok(worktreeOpened(tree.worktree)),
      );
      await openWorktreePane(agentAt(tree), { env, exec: missing.exec, workspaceId: "w1" });
      expect(openArgs(missing).args).toContain("--cwd");
      const bare = fakeHerdr((args) =>
        ok(args[0] === "workspace" ? workspaceInfo(args[2], null) : worktreeOpened(tree.worktree)),
      );
      await openWorktreePane(agentAt(tree), { env, exec: bare.exec, workspaceId: "w1" });
      expect(openArgs(bare).args).toContain("--cwd");
    });

    it("never sends --workspace and --cwd together", async () => {
      const tree = makeWorktree();
      for (const workspaceId of [undefined, "w1"]) {
        const fake = openHost(tree);
        await openWorktreePane(agentAt(tree), { env, exec: fake.exec, workspaceId });
        const args = openArgs(fake).args;
        expect(args.includes("--workspace") && args.includes("--cwd")).toBe(false);
        expect(args.includes("--workspace") || args.includes("--cwd")).toBe(true);
      }
    });

    it("keeps leading-dash directory names as option values", async () => {
      const tree = makeWorktree(path.join(root, "-weird parent"), "--wt");
      const fake = openHost(tree);
      await openWorktreePane(agentAt(tree), { env, exec: fake.exec });
      const args = openArgs(fake).args;
      expect(args[args.indexOf("--path") + 1]).toBe(realpathSync(tree.worktree));
      expect(path.basename(args[args.indexOf("--path") + 1])).toBe("--wt");
    });

    it("refuses another Herdr endpoint, a missing endpoint and non-Herdr environments", async () => {
      const tree = makeWorktree();
      const fake = openHost(tree);
      const foreign = agentAt(tree, { herdrEndpoint: path.join(root, "other.sock") });
      await expect(openWorktreePane(foreign, { env, exec: fake.exec })).rejects.toMatchObject({
        code: "endpoint_mismatch",
      });
      await expect(
        openWorktreePane(agentAt(tree, { herdrEndpoint: undefined }), { env, exec: fake.exec }),
      ).rejects.toMatchObject({ code: "endpoint_mismatch" });
      await expect(
        openWorktreePane(agentAt(tree), { env: {}, exec: fake.exec }),
      ).rejects.toMatchObject({ code: "not_herdr" });
      expect(fake.calls).toHaveLength(0);
    });

    it("matches endpoints canonically through symlinks", async () => {
      const tree = makeWorktree();
      const link = path.join(root, "link.sock");
      symlinkSync(env.HERDR_SOCKET_PATH, link);
      writeFileSync(env.HERDR_SOCKET_PATH, "");
      const fake = openHost(tree);
      await openWorktreePane(agentAt(tree, { herdrEndpoint: link }), { env, exec: fake.exec });
      expect(fake.calls).toHaveLength(1);
    });

    it("rejects malformed workspace hints without running anything", async () => {
      const tree = makeWorktree();
      const fake = openHost(tree);
      await expect(
        openWorktreePane(agentAt(tree), { env, exec: fake.exec, workspaceId: "--bad" }),
      ).rejects.toMatchObject({ code: "invalid_argument" });
      expect(fake.calls).toHaveLength(0);
    });

    it("validates the worktree_opened envelope and every returned identifier", async () => {
      const tree = makeWorktree();
      const base = worktreeOpened(tree.worktree);
      const without = (key) =>
        Object.fromEntries(Object.entries(base).filter(([name]) => name !== key));
      const cases = {
        "wrong type": { ...base, type: "worktree_created" },
        "missing type": without("type"),
        "missing workspace": without("workspace"),
        "missing tab": without("tab"),
        "missing root_pane": without("root_pane"),
        "missing worktree": without("worktree"),
        "missing already_open": without("already_open"),
        "non-boolean already_open": { ...base, already_open: "yes" },
        "malformed workspace id": { ...base, workspace: { workspace_id: "-x" } },
        "malformed tab id": { ...base, tab: { tab_id: "a b" } },
        "malformed pane id": { ...base, root_pane: { pane_id: "--p" } },
        "different worktree": { ...base, worktree: { path: tree.parent } },
        "non-object result": [],
      };
      for (const [name, result] of Object.entries(cases)) {
        const fake = fakeHerdr(() => ({ stdout: JSON.stringify({ result }) }));
        await expect(
          openWorktreePane(agentAt(tree), { env, exec: fake.exec }),
          name,
        ).rejects.toMatchObject({ code: "invalid_result" });
      }
      const garbage = fakeHerdr(() => ({ stdout: "worktree opened" }));
      await expect(
        openWorktreePane(agentAt(tree), { env, exec: garbage.exec }),
      ).rejects.toMatchObject({
        code: "invalid_result",
      });
    });

    it("surfaces timeout and missing binary", async () => {
      const tree = makeWorktree();
      const killed = fakeHerdr(() => ({ error: Object.assign(new Error("t"), { killed: true }) }));
      await expect(
        openWorktreePane(agentAt(tree), { env, exec: killed.exec }),
      ).rejects.toMatchObject({
        code: "timeout",
      });
      const missing = fakeHerdr(() => ({
        error: Object.assign(new Error("m"), { code: "ENOENT" }),
      }));
      await expect(
        openWorktreePane(agentAt(tree), { env, exec: missing.exec }),
      ).rejects.toMatchObject({
        code: "missing_binary",
      });
    });
  });

  describe("real Herdr parser acceptance (zero side effects)", () => {
    const herdrPath = spawnSync("herdr", ["--version"], { encoding: "utf8" });
    const hasHerdr = herdrPath.status === 0;
    // No server listens on the temp socket, so a parsed request ends in server_not_running.
    const probe = (args) => {
      const run = spawnSync("herdr", args, {
        encoding: "utf8",
        timeout: 5000,
        cwd: root,
        env: {
          PATH: process.env.PATH,
          HOME: root,
          HERDR_SOCKET_PATH: "./absent.sock",
        },
      });
      return { status: run.status, stdout: `${run.stdout}${run.stderr}` };
    };

    it.skipIf(!hasHerdr)("accepts exactly the argv shapes we send and rejects both-sources", () => {
      const tree = makeWorktree();
      const path_ = realpathSync(tree.worktree);
      const cwdForm = probe([
        "worktree",
        "open",
        "--cwd",
        realpathSync(tree.parent),
        "--path",
        path_,
        "--focus",
      ]);
      expect(cwdForm.stdout).toContain("server_not_running");
      const workspaceForm = probe([
        "worktree",
        "open",
        "--workspace",
        "w1",
        "--path",
        path_,
        "--focus",
      ]);
      expect(workspaceForm.stdout).toContain("server_not_running");
      const both = probe([
        "worktree",
        "open",
        "--workspace",
        "w1",
        "--cwd",
        tree.parent,
        "--path",
        path_,
      ]);
      expect(both.status).toBe(2);
      expect(both.stdout).not.toContain("server_not_running");
      expect(probe(["workspace", "get", "w1"]).stdout).toContain("server_not_running");
      expect(probe(["agent", "get", "w1:p1"]).stdout).toContain("server_not_running");
      expect(
        probe(["notification", "show", "Orkest: -x", "--body", "--y", "--sound", "request"]).stdout,
      ).toContain("server_not_running");
    });
  });

  describe("trustedWorktreePath", () => {
    it("accepts only existing checkouts inside the root", () => {
      const tree = makeWorktree();
      expect(trustedWorktreePath(agentAt(tree)).worktree).toBe(realpathSync(tree.worktree));
      // An explicit root wins over the record's own parentCwd.
      expect(() => trustedWorktreePath(agentAt(tree), path.join(root, "elsewhere"))).toThrow(
        HerdrCliError,
      );
      expect(() => trustedWorktreePath({ worktree: { path: "relative/x" } })).toThrow(
        HerdrCliError,
      );
      expect(() => trustedWorktreePath({})).toThrow(HerdrCliError);
    });

    it("rejects the root itself, symlink escapes and plain directories", () => {
      const tree = makeWorktree();
      expect(() =>
        trustedWorktreePath({ worktree: { path: tree.parent, parentCwd: tree.parent } }),
      ).toThrow(HerdrCliError);
      const outside = path.join(root, "outside");
      mkdirSync(outside);
      writeFileSync(path.join(outside, ".git"), "gitdir: x\n");
      const escape = path.join(tree.parent, ".worktrees", "escape");
      symlinkSync(outside, escape);
      expect(() =>
        trustedWorktreePath({ worktree: { path: escape, parentCwd: tree.parent } }),
      ).toThrow(/outside its root/u);
      const plain = path.join(tree.parent, ".worktrees", "plain");
      mkdirSync(plain);
      expect(() =>
        trustedWorktreePath({ worktree: { path: plain, parentCwd: tree.parent } }),
      ).toThrow(/Git worktree/u);
    });
  });

  describe("showNotification", () => {
    it("sends exactly one notification with title first and dash-leading text kept as values", async () => {
      const fake = fakeHerdr();
      expect(
        await showNotification(
          { title: "-rf now", body: "--body --sound", sound: "request" },
          { env, exec: fake.exec },
        ),
      ).toBe(true);
      expect(fake.calls).toHaveLength(1);
      expect(fake.calls[0].args).toEqual([
        "notification",
        "show",
        "Orkest: -rf now",
        "--body",
        "--body --sound",
        "--sound",
        "request",
      ]);
      expect(fake.calls[0].args).not.toContain("--");
    });

    it("flattens control characters and rejects unknown sounds without running", async () => {
      const fake = fakeHerdr();
      await showNotification({ title: "a\nb", body: "x\u{0}y" }, { env, exec: fake.exec });
      expect(fake.calls[0].args).toEqual(["notification", "show", "a b", "--body", "x y"]);
      expect(await showNotification({ title: "t", sound: "boom" }, { env, exec: fake.exec })).toBe(
        false,
      );
      expect(await showNotification({ title: "  " }, { env, exec: fake.exec })).toBe(false);
      expect(fake.calls).toHaveLength(1);
    });

    it("reports false when Herdr rejects, times out or is missing, without retrying", async () => {
      for (const failure of [
        () => ({ error: new Error("rejected") }),
        () => ({ error: Object.assign(new Error("t"), { killed: true }) }),
        () => ({ error: Object.assign(new Error("m"), { code: "ENOENT" }) }),
        () => ({ stdout: '{"error":{"code":"x"}}' }),
      ]) {
        const fake = fakeHerdr(failure);
        expect(await showNotification({ title: "t", body: "b" }, { env, exec: fake.exec })).toBe(
          false,
        );
        expect(fake.calls).toHaveLength(1);
      }
    });
  });
});
