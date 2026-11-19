import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  listWorktreePorts,
  worktreePortsDbPath,
} from "../../../src/lib/worktree-ports.mjs";
import {
  prepareWorktree,
  provisionWorktree,
  recoverInterruptedSetup,
} from "../../../src/lib/worktree-provision.mjs";
import { processStartIdentity } from "../../../src/lib/worktree-setup-worker.mjs";
import {
  approveWorktreeSetup,
  describeWorktreeSetup,
} from "../../../src/lib/worktree-trust.mjs";
import { retainFixtures } from "../../helpers/retain-fixtures.js";

const directories = [];

const SETUP_SCRIPT = String.raw`import fs from "node:fs";
fs.appendFileSync("setup-runs.log", "run\n");
fs.writeFileSync(
  "setup-env.json",
  JSON.stringify({ env: process.env, argv: process.argv.slice(3), cwd: process.cwd() }),
);
const mode = process.argv[2];
if (mode === "fail") process.exit(3);
if (mode === "sleep") await new Promise((resolve) => setTimeout(resolve, 60000));
`;

async function scratch() {
  const made = await mkdtemp(path.join(tmpdir(), "ork-setup-"));
  const created = await realpath(made);
  directories.push(created);
  return created;
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

async function repository({ config, extra = {} } = {}) {
  const root = await scratch();
  const repo = path.join(root, "repo");
  await mkdir(path.join(repo, "scripts"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "Setup Tests");
  git(repo, "config", "user.email", "setup@example.invalid");
  await writeFile(
    path.join(repo, ".gitignore"),
    "node_modules\nsetup-runs.log\nsetup-env.json\n.env\n.env.*\nhelper.js\n",
  );
  await writeFile(path.join(repo, "scripts", "setup.mjs"), SETUP_SCRIPT);
  if (config) {
    await mkdir(path.join(repo, ".orkest"));
    await writeFile(path.join(repo, ".orkest", "worktree.json"), JSON.stringify(config));
  }
  for (const [name, content] of Object.entries(extra)) {
    await mkdir(path.dirname(path.join(repo, name)), { recursive: true });
    await writeFile(path.join(repo, name), content);
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "fixture");
  const env = {
    HOME: path.join(root, "home"),
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    XDG_CONFIG_HOME: path.join(root, "config"),
    ORCHESTRATE_HOME: path.join(root, "cache"),
    SECRET_TOKEN: "must-not-leak",
    GITHUB_TOKEN: "must-not-leak-either",
  };
  await mkdir(env.HOME, { recursive: true });
  return { root, repo, env };
}

function addWorktree(repo, name) {
  const target = path.join(repo, ".worktrees", name);
  git(repo, "worktree", "add", "-q", "-b", `ork/${name}`, target, "HEAD");
  return realpathSync(target);
}

afterEach(async () => {
  await retainFixtures(directories.splice(0));
});

const SETUP_CONFIG = {
  version: 1,
  setupCommand: [process.execPath, "scripts/setup.mjs", "ok", "--web=${WEB_PORT}"],
  ports: { names: ["WEB_PORT"] },
};

describe("worktree preparation without configured work", () => {
  it("starts no helper process and keeps the legacy include behavior", async () => {
    const { repo, env } = await repository();
    await writeFile(path.join(repo, ".env"), "A=1\n");
    const wt = addWorktree(repo, "legacy");
    let spawned = 0;
    const outcome = prepareWorktree(repo, wt, {
      slug: "legacy",
      env,
      runWorker: () => {
        spawned += 1;
        throw new Error("no helper expected");
      },
    });
    expect(spawned).toBe(0);
    expect(outcome).toMatchObject({ copied: [".env"], linked: [], ports: null });
    expect(outcome.setup).toEqual({ status: "none" });
    expect(existsSync(worktreePortsDbPath(env))).toBe(false);
  });

  it("rejects an invalid config at the config substage before any effect", async () => {
    const { repo, env } = await repository({ config: { version: 1, surprise: true } });
    await writeFile(path.join(repo, ".env"), "A=1\n");
    const wt = addWorktree(repo, "bad-config");
    let thrown;
    try {
      prepareWorktree(repo, wt, { slug: "bad-config", env });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      stage: "bootstrap",
      substage: "config",
      code: "ORK_WORKTREE_CONFIG_INVALID",
    });
    expect(existsSync(path.join(wt, ".env"))).toBe(false);
    expect(existsSync(wt)).toBe(true);
  });
});

describe("setup trust", () => {
  it("skips an unapproved command with a visible warning but still allocates ports", async () => {
    const { repo, env } = await repository({ config: SETUP_CONFIG });
    const wt = addWorktree(repo, "untrusted");
    const warnings = [];
    const outcome = prepareWorktree(repo, wt, {
      slug: "untrusted",
      env,
      warn: (message) => {
        warnings.push(message);
      },
    });
    expect(outcome.setup).toMatchObject({ status: "skipped-untrusted", reason: "not-approved" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("ork setup --trust-worktree");
    expect(existsSync(path.join(wt, "setup-runs.log"))).toBe(false);
    expect(outcome.ports.WEB_PORT).toBeGreaterThan(0);
  });

  it("describes then approves canonical repo, argv and hash in a private record", async () => {
    const { repo, env } = await repository({ config: SETUP_CONFIG });
    const description = describeWorktreeSetup(repo);
    expect(description).toMatchObject({
      repo,
      argv: SETUP_CONFIG.setupCommand,
      clean: true,
    });
    expect(description.configSha256).toMatch(/^[0-9a-f]{64}$/u);

    const approved = approveWorktreeSetup(repo, { env });
    expect(approved).toMatchObject({ repo, configSha256: description.configSha256 });
    const file = lstatSync(approved.recordPath);
    expect(file.mode & 0o777).toBe(0o600);
    expect(lstatSync(path.dirname(approved.recordPath)).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(approved.recordPath, "utf8")).commit).toBe(
      git(repo, "rev-parse", "HEAD").trim(),
    );
  });

  it("runs the approved argv once with a scoped env, ports and no shell", async () => {
    const { repo, env } = await repository({ config: SETUP_CONFIG });
    approveWorktreeSetup(repo, { env });
    const wt = addWorktree(repo, "trusted");
    const outcome = prepareWorktree(repo, wt, { slug: "trusted", env });
    expect(outcome.setup).toMatchObject({ status: "done", exitCode: 0 });

    const seen = JSON.parse(readFileSync(path.join(wt, "setup-env.json"), "utf8"));
    const port = outcome.ports.WEB_PORT;
    expect(seen.env.WEB_PORT).toBe(String(port));
    expect(JSON.parse(seen.env.ORKEST_WORKTREE_PORTS)).toEqual({ WEB_PORT: port });
    expect(seen.argv).toEqual([`--web=${port}`]);
    expect(seen.env.ORKEST_WORKTREE_PATH).toBe(wt);
    expect(seen.env.ORKEST_REPO_ROOT).toBe(repo);
    expect(seen.env.SECRET_TOKEN).toBeUndefined();
    expect(seen.env.GITHUB_TOKEN).toBeUndefined();
    expect(seen.env.PATH).toBe(env.PATH);
    expect(seen.cwd).toBe(wt);

    // A retry neither repeats the setup nor starts a helper for already-reserved ports.
    let spawned = 0;
    const retry = prepareWorktree(repo, wt, {
      slug: "trusted",
      env,
      runWorker: () => {
        spawned += 1;
        throw new Error("unexpected helper");
      },
    });
    expect(retry.setup).toEqual({ status: "already-done" });
    expect(retry.ports).toEqual(outcome.ports);
    expect(spawned).toBe(0);
    expect(readFileSync(path.join(wt, "setup-runs.log"), "utf8")).toBe("run\n");
    expect(listWorktreePorts({ repoRoot: repo, worktreePath: wt, env })).toEqual([
      { name: "WEB_PORT", port },
    ]);
  });

  it("invalidates the grant when any config byte changes", async () => {
    const { repo, env } = await repository({ config: SETUP_CONFIG });
    approveWorktreeSetup(repo, { env });
    writeFileSync(path.join(repo, ".orkest", "worktree.json"), `${JSON.stringify(SETUP_CONFIG)}\n`);
    const wt = addWorktree(repo, "drift");
    const outcome = prepareWorktree(repo, wt, { slug: "drift", env, warn: () => {} });
    expect(outcome.setup).toMatchObject({ status: "skipped-untrusted", reason: "config-changed" });
    expect(existsSync(path.join(wt, "setup-runs.log"))).toBe(false);
  });

  it("does not let the same config text authorize modified or newer checkout code", async () => {
    const { repo, env } = await repository({ config: SETUP_CONFIG });
    approveWorktreeSetup(repo, { env });

    // 1. A worktree whose scripts differ from the reviewed tree.
    const dirty = addWorktree(repo, "dirty");
    writeFileSync(path.join(dirty, "scripts", "setup.mjs"), "process.exit(0)\n");
    const dirtyOutcome = prepareWorktree(repo, dirty, { slug: "dirty", env, warn: () => {} });
    expect(dirtyOutcome.setup).toMatchObject({ reason: "checkout-dirty" });
    expect(existsSync(path.join(dirty, "setup-runs.log"))).toBe(false);

    // 2. New commits after the review move HEAD away from the approved commit.
    await writeFile(path.join(repo, "scripts", "setup.mjs"), `${SETUP_SCRIPT}// changed\n`);
    git(repo, "commit", "-q", "-am", "change setup script");
    const moved = addWorktree(repo, "moved");
    const movedOutcome = prepareWorktree(repo, moved, { slug: "moved", env, warn: () => {} });
    expect(movedOutcome.setup).toMatchObject({ reason: "checkout-changed" });
    expect(existsSync(path.join(moved, "setup-runs.log"))).toBe(false);
  });

  it("refuses to approve a dirty checkout or a missing setup command", async () => {
    const { repo, env } = await repository({ config: SETUP_CONFIG });
    await writeFile(path.join(repo, "scripts", "setup.mjs"), "// edited\n");
    expect(() => approveWorktreeSetup(repo, { env })).toThrow(/uncommitted/u);

    const plain = await repository({ config: { version: 1 } });
    expect(() => approveWorktreeSetup(plain.repo, { env: plain.env })).toThrow(/No setupCommand/u);
  });

  it("treats a symlinked or foreign trust record as untrusted", async () => {
    const { repo, env, root } = await repository({ config: SETUP_CONFIG });
    const approved = approveWorktreeSetup(repo, { env });
    const copy = path.join(root, "elsewhere.json");
    writeFileSync(copy, readFileSync(approved.recordPath), { mode: 0o600 });
    renameSync(copy, `${approved.recordPath}.real`);
    renameSync(approved.recordPath, `${approved.recordPath}.orig`);
    symlinkSync(`${approved.recordPath}.real`, approved.recordPath);
    const wt = addWorktree(repo, "linked-record");
    const outcome = prepareWorktree(repo, wt, { slug: "linked-record", env, warn: () => {} });
    expect(outcome.setup).toMatchObject({ status: "skipped-untrusted", reason: "unsafe-record" });
  });
});

describe("setup trust covers ignored and copied inputs", () => {
  const CONFIG = { version: 1, setupCommand: [process.execPath, "scripts/setup.mjs", "ok"] };

  it("runs with the reviewed copied files and skips when they change after approval", async () => {
    const { repo, env } = await repository({ config: CONFIG });
    await writeFile(path.join(repo, ".env"), "TOKEN_FILE=reviewed\n");
    const description = describeWorktreeSetup(repo);
    expect(description.inputs.map((input) => input.path)).toEqual([".env"]);
    approveWorktreeSetup(repo, { env });

    const good = addWorktree(repo, "same-inputs");
    expect(prepareWorktree(repo, good, { slug: "same-inputs", env }).setup.status).toBe("done");

    await writeFile(path.join(repo, ".env"), "TOKEN_FILE=swapped\n");
    const changed = addWorktree(repo, "changed-inputs");
    const outcome = prepareWorktree(repo, changed, { slug: "changed-inputs", env, warn: () => {} });
    expect(outcome.setup).toMatchObject({ status: "skipped-untrusted", reason: "inputs-changed" });
    expect(existsSync(path.join(changed, "setup-runs.log"))).toBe(false);

    // A file newly picked up by the include rules is also an unreviewed input.
    await writeFile(path.join(repo, ".env"), "TOKEN_FILE=reviewed\n");
    await writeFile(path.join(repo, ".env.local"), "EXTRA=1\n");
    const added = addWorktree(repo, "added-inputs");
    expect(
      prepareWorktree(repo, added, { slug: "added-inputs", env, warn: () => {} }).setup.reason,
    ).toBe("inputs-changed");
  });

  it("skips when an unreviewed ignored file is already in the worktree, then runs once it is gone", async () => {
    const { repo, env } = await repository({ config: CONFIG });
    approveWorktreeSetup(repo, { env });
    const wt = addWorktree(repo, "planted");
    writeFileSync(path.join(wt, "helper.js"), "// ignored by git, not attested\n");
    const outcome = prepareWorktree(repo, wt, { slug: "planted", env, warn: () => {} });
    expect(outcome.setup).toMatchObject({
      status: "skipped-untrusted",
      reason: "unreviewed-files",
    });
    expect(existsSync(path.join(wt, "setup-runs.log"))).toBe(false);

    renameSync(path.join(wt, "helper.js"), path.join(repo, "moved-aside-helper.txt"));
    expect(prepareWorktree(repo, wt, { slug: "planted", env }).setup.status).toBe("done");
  });

  it("scopes PATH so repo-local and relative entries cannot shadow trusted tools", async () => {
    const { repo, env } = await repository({ config: CONFIG });
    approveWorktreeSetup(repo, { env });
    const wt = addWorktree(repo, "scoped-path");
    const dirty = [
      path.join(repo, "node_modules", ".bin"),
      path.join(wt, "bin"),
      "relative/bin",
      "",
      env.PATH,
    ].join(path.delimiter);
    prepareWorktree(repo, wt, { slug: "scoped-path", env: { ...env, PATH: dirty } });
    const seen = JSON.parse(readFileSync(path.join(wt, "setup-env.json"), "utf8"));
    expect(seen.env.PATH).toBe(env.PATH);
  });
});

describe("setup failure, interruption and retry", () => {
  async function trustedRepo(mode) {
    const config = {
      version: 1,
      setupCommand: [process.execPath, "scripts/setup.mjs", mode],
    };
    const fixture = await repository({ config });
    approveWorktreeSetup(fixture.repo, { env: fixture.env });
    return fixture;
  }

  it("retains the worktree on failure, names the substage and runs again on retry", async () => {
    const { repo, env } = await trustedRepo("fail");
    const wt = addWorktree(repo, "failing");
    for (const attempt of [1, 2]) {
      let thrown;
      try {
        prepareWorktree(repo, wt, { slug: "failing", env });
      } catch (error) {
        thrown = error;
      }
      expect(thrown, `attempt ${attempt}`).toMatchObject({
        stage: "bootstrap",
        substage: "setup",
        code: "ORK_WORKTREE_SETUP_FAILED",
      });
    }
    expect(existsSync(wt)).toBe(true);
    expect(readFileSync(path.join(wt, "setup-runs.log"), "utf8")).toBe("run\nrun\n");
  });

  it("bounds a runaway setup with a timeout and fails visibly", async () => {
    const { repo, env } = await trustedRepo("sleep");
    const wt = addWorktree(repo, "slow");
    const started = Date.now();
    expect(() => prepareWorktree(repo, wt, { slug: "slow", env, setupTimeoutMs: 1000 })).toThrow(
      expect.objectContaining({ code: "ORK_WORKTREE_SETUP_TIMEOUT", substage: "setup" }),
    );
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it("never treats an interrupted setup as done until recovery is explicit", async () => {
    const { repo, env } = await trustedRepo("ok");
    const wt = addWorktree(repo, "interrupted");
    const gitDir = git(wt, "rev-parse", "--absolute-git-dir").trim();
    writeFileSync(path.join(gitDir, "orkest-setup.json"), JSON.stringify({ state: "running" }));

    let thrown;
    try {
      prepareWorktree(repo, wt, { slug: "interrupted", env });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      stage: "bootstrap",
      substage: "setup",
      code: "ORK_WORKTREE_SETUP_INTERRUPTED",
    });
    expect(existsSync(path.join(wt, "setup-runs.log"))).toBe(false);

    const recovered = recoverInterruptedSetup(wt);
    expect(recovered.recovered).toBe(true);
    expect(existsSync(recovered.movedTo)).toBe(true);
    const outcome = prepareWorktree(repo, wt, { slug: "interrupted", env });
    expect(outcome.setup.status).toBe("done");
    expect(recoverInterruptedSetup(wt)).toEqual({ recovered: false, state: "done" });
  });

  it("marks setup interrupted when the helper dies mid-run", async () => {
    const { repo, env } = await trustedRepo("ok");
    const wt = addWorktree(repo, "dies");
    expect(() =>
      prepareWorktree(repo, wt, {
        slug: "dies",
        env,
        runWorker: () => ({ crashed: true, reason: "SIGKILL" }),
      }),
    ).toThrow(expect.objectContaining({ code: "ORK_WORKTREE_SETUP_INTERRUPTED" }));
    expect(() => prepareWorktree(repo, wt, { slug: "dies", env })).toThrow(
      expect.objectContaining({ code: "ORK_WORKTREE_SETUP_INTERRUPTED" }),
    );
  });
});

describe("provisionWorktree keeps the rooms contract", () => {
  it("fails with stage=bootstrap and a substage, retaining the created worktree", async () => {
    const { repo, env } = await repository({
      config: { version: 1, symlinkDirs: ["cache-dir"] },
    });
    // cache-dir is not ignored, so the generated link would show up as untracked.
    await mkdir(path.join(repo, "cache-dir"));
    let thrown;
    try {
      provisionWorktree(repo, { slug: "kept", branch: "ork/kept", env });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      stage: "bootstrap",
      substage: "link",
      code: "ORK_WORKTREE_LINK_NOT_IGNORED",
    });
    expect(thrown.message).toContain("/cache-dir");
    expect(existsSync(path.join(repo, ".worktrees", "kept"))).toBe(true);
    expect(readdirSync(path.join(repo, ".worktrees", "kept"))).not.toContain("cache-dir-link");
    expect(existsSync(path.join(repo, ".worktrees", "kept", "cache-dir"))).toBe(false);
  });
});

describe("exclusive setup claim", () => {
  const CONFIG = { version: 1, setupCommand: [process.execPath, "scripts/setup.mjs", "slow"] };

  it("runs a non-idempotent setup once when several processes prepare the same worktree", async () => {
    const { repo, env, root } = await repository({ config: CONFIG });
    // Slow enough that every contender overlaps the owner.
    writeFileSync(
      path.join(repo, "scripts", "setup.mjs"),
      `${SETUP_SCRIPT}await new Promise((resolve) => setTimeout(resolve, 400));\n`,
    );
    git(repo, "commit", "-q", "-am", "slow setup");
    approveWorktreeSetup(repo, { env });
    const wt = addWorktree(repo, "contended");
    const barrier = path.join(root, "go");
    const url = new URL("../../../src/lib/worktree-provision.mjs", import.meta.url);
    const scriptPath = path.join(root, "contender.mjs");
    writeFileSync(
      scriptPath,
      `import fs from "node:fs";
import { prepareWorktree } from ${JSON.stringify(url.href)};
fs.writeFileSync(process.argv[2], "ready");
while (!fs.existsSync(${JSON.stringify(barrier)})) await new Promise((r) => setTimeout(r, 1));
try {
  const outcome = prepareWorktree(${JSON.stringify(repo)}, ${JSON.stringify(wt)}, { slug: "contended", env: JSON.parse(process.argv[3]) });
  console.log(outcome.setup.status);
} catch (error) { console.log(error.code); }
`,
    );
    const workers = Array.from({ length: 4 }, (_, index) => {
      const child = spawn(
        process.execPath,
        [scriptPath, path.join(root, `ready-${index}`), JSON.stringify(env)],
        { stdio: ["ignore", "pipe", "inherit"] },
      );
      const done = new Promise((resolve) => {
        let out = "";
        child.stdout.on("data", (chunk) => {
          out += chunk;
        });
        child.on("close", () => resolve(out.trim()));
      });
      return done;
    });
    while (readdirSync(root).filter((name) => name.startsWith("ready-")).length < 4) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    writeFileSync(barrier, "go");
    const results = await Promise.all(workers);
    expect(results.toSorted((a, b) => a.localeCompare(b))).toEqual([
      "already-done",
      "already-done",
      "already-done",
      "done",
    ]);
    expect(readFileSync(path.join(wt, "setup-runs.log"), "utf8")).toBe("run\n");
  });

  async function trusted() {
    const fixture = await repository({ config: CONFIG });
    approveWorktreeSetup(fixture.repo, { env: fixture.env });
    const wt = addWorktree(fixture.repo, "claimed");
    const gitDir = git(wt, "rev-parse", "--absolute-git-dir").trim();
    return { ...fixture, wt, gitDir };
  }

  function plantClaim(gitDir, owner) {
    writeFileSync(
      path.join(gitDir, "orkest-setup.lock"),
      `${JSON.stringify({ token: "planted", claimedAt: new Date().toISOString(), ...owner })}\n`,
    );
  }

  it("refuses to restart or recover while a live owner is executing, then recovers once it is gone", async () => {
    const { repo, env, wt, gitDir } = await trusted();
    const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
      stdio: "ignore",
    });
    try {
      // The claiming parent is gone; only the setup process it started is still alive.
      plantClaim(gitDir, {
        pid: 2_147_483_000,
        setupPid: sleeper.pid,
        setupStart: processStartIdentity(sleeper.pid),
      });
      writeFileSync(path.join(gitDir, "orkest-setup.json"), JSON.stringify({ state: "running" }));

      expect(() => prepareWorktree(repo, wt, { slug: "claimed", env, claimWaitMs: 150 })).toThrow(
        expect.objectContaining({ code: "ORK_WORKTREE_SETUP_ACTIVE", substage: "setup" }),
      );
      expect(() => recoverInterruptedSetup(wt)).toThrow(
        expect.objectContaining({ code: "ORK_WORKTREE_SETUP_ACTIVE" }),
      );
      expect(existsSync(path.join(gitDir, "orkest-setup.lock"))).toBe(true);
      expect(existsSync(path.join(wt, "setup-runs.log"))).toBe(false);
    } finally {
      sleeper.kill("SIGKILL");
      await new Promise((resolve) => sleeper.once("close", resolve));
    }

    // Owner gone: the claim is stale, so setup reports interruption instead of silently restarting.
    expect(() => prepareWorktree(repo, wt, { slug: "claimed", env })).toThrow(
      expect.objectContaining({ code: "ORK_WORKTREE_SETUP_INTERRUPTED" }),
    );
    const recovered = recoverInterruptedSetup(wt);
    expect(recovered.recovered).toBe(true);
    expect(recovered.moved.length).toBe(2);
    for (const file of recovered.moved) expect(existsSync(file)).toBe(true);
    expect(existsSync(path.join(gitDir, "orkest-setup.lock"))).toBe(false);
    expect(prepareWorktree(repo, wt, { slug: "claimed", env }).setup.status).toBe("done");

    // History survives the crash, the recovery and the later run.
    const events = readFileSync(path.join(gitDir, "orkest-setup.history.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).event);
    expect(events).toEqual(["recovered", "claimed", "setup-started", "setup-finished"]);
    expect(recoverInterruptedSetup(wt)).toEqual({ recovered: false, state: "done" });
  });

  it("reports an unreadable claim as unverifiable instead of taking it over", async () => {
    const { repo, env, wt, gitDir } = await trusted();
    writeFileSync(path.join(gitDir, "orkest-setup.lock"), "not json");
    expect(() => prepareWorktree(repo, wt, { slug: "claimed", env, claimWaitMs: 50 })).toThrow(
      expect.objectContaining({ code: "ORK_WORKTREE_SETUP_ACTIVE" }),
    );
    expect(() => recoverInterruptedSetup(wt)).toThrow(
      expect.objectContaining({ code: "ORK_WORKTREE_SETUP_ACTIVE" }),
    );
    expect(readFileSync(path.join(gitDir, "orkest-setup.lock"), "utf8")).toBe("not json");
  });
});
