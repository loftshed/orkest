import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  addAccount,
  listAccounts,
  removeAccount,
  tagAccount,
} from "../../../plugins/orchestrate/lib/accounts.mjs";

const ORK = fileURLToPath(new URL("../../../plugins/orchestrate/bin/ork.mjs", import.meta.url));
const ACCOUNTS = fileURLToPath(
  new URL("../../../plugins/orchestrate/lib/accounts.mjs", import.meta.url),
);
const POLICY = fileURLToPath(new URL("../../../plugins/monitor/lib/policy.mjs", import.meta.url));
const PYTHON_DIR = path.dirname(
  spawnSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).stdout.trim() || "/usr/bin/x",
);
const PROVIDERS = ["claude", "codex", "agy", "opencode"];
const OK_SYNC = () => ({ schema: "ork.account.sync.v1", dryRun: false, profiles: [], errors: [] });

describe("ork account", () => {
  let tmp;
  let home;
  let bin;
  let record;
  let env;

  beforeEach(() => {
    const prefix = path.join(os.tmpdir(), "ork-account-test-");
    tmp = fs.realpathSync(fs.mkdtempSync(prefix));
    home = path.join(tmp, "home");
    bin = path.join(tmp, "fakebin");
    record = path.join(tmp, "record.txt");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    for (const name of PROVIDERS) {
      fs.writeFileSync(
        path.join(bin, name),
        `#!/bin/sh\n{ echo "PROVIDER:${name}"; for a in "$@"; do echo "ARG:$a"; done; ` +
          `env | grep -E '^(CLAUDE_CONFIG_DIR|CODEX_HOME|ANTIGRAVITY_APP_DATA_DIR|GEMINI_CLI_HOME|XDG_[A-Z]+_HOME|ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|OPENAI_API_KEY)=' | sort; } > "$RECORD"\n`,
        { mode: 0o755 },
      );
    }
    env = {
      HOME: home,
      PATH: [bin, path.dirname(process.execPath), PYTHON_DIR, "/usr/bin", "/bin"].join(":"),
      RECORD: record,
    };
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const ctx = (extra = {}) => ({ env, home, runSync: OK_SYNC, ...extra });
  const configPath = () => path.join(home, ".config", "monitor", "config.json");
  const readConfig = () => JSON.parse(fs.readFileSync(configPath(), "utf8"));
  const mode = (file) => fs.statSync(file).mode & 0o777;

  function ork(args, overrides = {}) {
    const res = spawnSync(process.execPath, [ORK, "account", ...args], {
      env: { ...env, ...overrides },
      encoding: "utf8",
    });
    return { code: res.status, stdout: res.stdout, stderr: res.stderr };
  }

  function snapshot(root) {
    const out = {};
    const walk = (dir) => {
      for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        const st = fs.lstatSync(p);
        out[p] = [st.mode, st.mtimeMs, st.isFile() ? fs.readFileSync(p, "utf8") : null];
        if (st.isDirectory()) walk(p);
      }
    };
    walk(root);
    return out;
  }

  it("adds three profiles per provider through the real CLI and shapes the config", () => {
    const stored = { claude: "claude", codex: "codex", agy: "antigravity", opencode: "opencode" };
    for (const provider of PROVIDERS) {
      const plain = ork(["add", provider, "--profile", "one", "--no-sync", "--json"]);
      expect(plain.code, plain.stderr).toBe(0);
      const tagged = ork([
        "add",
        provider,
        "--profile",
        "two",
        "--tag",
        "work",
        "--tag",
        "work",
        "--tag",
        "fast",

        "--alias",
        `${provider}-two`,
        "--label",
        "Two",
        "--short",
        "T2",
        "--no-sync",
        "--json",
      ]);
      expect(tagged.code, tagged.stderr).toBe(0);
      const odd = path.join(home, `it's "odd" ${provider}`);
      const custom = ork([
        "add",
        provider,
        "--profile",
        "three",
        "--id",
        `${provider}-custom`,
        "--config-dir",
        odd,
        "--no-sync",
        "--json",
      ]);
      expect(custom.code, custom.stderr).toBe(0);
      const parsed = JSON.parse(custom.stdout);
      expect(parsed.home).toBe(odd);
      expect(mode(odd)).toBe(0o700);
      expect(mode(path.join(odd, ".orkest-account.json"))).toBe(0o600);
      expect(parsed.signIn.argv.slice(1)).toEqual(
        { claude: ["auth", "login"], codex: ["login"], agy: [], opencode: ["auth", "login"] }[
          provider
        ],
      );
      expect(parsed.signIn.command).toContain(String.raw`it'\''s "odd" ${provider}`);

      const accounts = readConfig().accounts.filter(
        (a) => a.provider === stored[provider] && a.id.includes("-"),
      );
      expect(accounts.map((a) => a.id)).toEqual([
        `${stored[provider]}-one`,
        `${stored[provider]}-two`,
        `${provider}-custom`,
      ]);
      expect(accounts[0].label).toBe(`${stored[provider]} · one`);
      expect(accounts[0].tags).toBeUndefined();
      expect(accounts[0].short).toBe(
        { claude: "CL", codex: "CX", agy: "AG", opencode: "OC" }[provider],
      );
      expect(accounts[1]).toMatchObject({
        alias: `${provider}-two`,
        route: `${provider}-two`,
        short: "T2",
      });
      expect(accounts[1].tags).toEqual(["work", "fast"]);
      expect(mode(path.join(home, ".local", "bin", `${provider}-two`))).toBe(0o755);
    }
    const byId = Object.fromEntries(readConfig().accounts.map((a) => [a.id, a]));
    expect(byId["claude-one"].configDir).toBe(path.join(home, ".claude-one"));
    expect(byId["claude-one"].route).toBe(
      `CLAUDE_CONFIG_DIR='${path.join(home, ".claude-one")}' claude`,
    );
    expect(byId["codex-one"].env).toEqual({ CODEX_HOME: path.join(home, ".codex-one") });
    expect(byId["antigravity-one"].env).toEqual({
      ANTIGRAVITY_APP_DATA_DIR: path.join(home, ".antigravity-one"),
      GEMINI_CLI_HOME: path.join(home, ".antigravity-one"),
    });
    expect(byId["opencode-one"].env).toEqual({
      XDG_CONFIG_HOME: path.join(home, ".opencode-one", "config"),
      XDG_DATA_HOME: path.join(home, ".opencode-one", "data"),
      XDG_STATE_HOME: path.join(home, ".opencode-one", "state"),
      XDG_CACHE_HOME: path.join(home, ".opencode-one", "cache"),
    });

    const all = JSON.parse(ork(["list", "--json"]).stdout).accounts;
    const list = all.filter((a) => a.id.includes("-"));
    expect(list).toHaveLength(12);
    expect(all.map((a) => a.id)).toEqual(readConfig().accounts.map((a) => a.id));
    expect(Object.keys(list[0]).toSorted((a, b) => a.localeCompare(b))).toEqual([
      "alias",
      "home",
      "id",
      "loginStatus",
      "provider",
      "syncStatus",
      "tags",
    ]);
    expect(list.every((a) => a.loginStatus === "unknown" && a.syncStatus === "pending")).toBe(true);
    expect(ork(["list", "--json"]).stdout).toBe(ork(["list", "--json"]).stdout);

    // Tag add / remove / set, by id and by alias.
    expect(ork(["tag", "claude-one", "add", "a", "b", "a"]).code).toBe(0);
    expect(readConfig().accounts.find((a) => a.id === "claude-one").tags).toEqual(["a", "b"]);
    expect(ork(["tag", "claude-two", "remove", "work"]).code).toBe(0);
    expect(readConfig().accounts.find((a) => a.id === "claude-two").tags).toEqual(["fast"]);
    expect(ork(["tag", "codex-two", "set", "x", "y"]).code).toBe(0);
    expect(readConfig().accounts.find((a) => a.id === "codex-two").tags).toEqual(["x", "y"]);
    expect(ork(["tag", "claude-one", "add", "Bad Tag"]).code).toBe(1);

    // Identical replay is a no-op.
    const before = fs.readFileSync(configPath(), "utf8");
    const again = JSON.parse(
      ork(["add", "claude", "--profile", "one", "--no-sync", "--json"]).stdout,
    );
    expect(again.changed).toBe(false);
    expect(fs.readFileSync(configPath(), "utf8")).toBe(before);

    // Remove preserves the profile and retires the wrapper into quarantine.
    const removed = JSON.parse(ork(["remove", "claude-two", "--json"]).stdout);
    expect(removed.wrapperQuarantined).toContain("account-quarantine");
    expect(fs.existsSync(path.join(home, ".local", "bin", "claude-two"))).toBe(false);
    expect(fs.existsSync(path.join(home, ".claude-two"))).toBe(true);
    expect(readConfig().accounts.some((a) => a.id === "claude-two")).toBe(false);
  }, 120_000);

  it("executes each wrapper with exact argv, home and sanitized credentials", () => {
    const spots = {
      claude: ["CLAUDE_CONFIG_DIR"],
      codex: ["CODEX_HOME"],
      agy: ["ANTIGRAVITY_APP_DATA_DIR", "GEMINI_CLI_HOME"],
      opencode: ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"],
    };
    for (const provider of PROVIDERS) {
      const dir = path.join(home, `p ${provider} 'q'`);
      const out = ork([
        "add",
        provider,
        "--profile",
        "w",
        "--alias",
        `w-${provider}`,
        "--config-dir",
        dir,
        "--no-sync",
      ]);
      expect(out.code, out.stderr).toBe(0);
      const wrapper = path.join(home, ".local", "bin", `w-${provider}`);
      const run = spawnSync(wrapper, ["a b", "it's", "--flag=x y", ""], {
        env: {
          ...env,
          ANTHROPIC_API_KEY: "k",
          CLAUDE_CODE_OAUTH_TOKEN: "t",
          OPENAI_API_KEY: "o",
          ...(provider === "claude" && { CLAUDE_CONFIG_DIR: "/wrong" }),
        },
        encoding: "utf8",
      });
      expect(run.status, run.stderr).toBe(0);
      const lines = fs.readFileSync(record, "utf8").trimEnd().split("\n");
      expect(lines[0]).toBe(`PROVIDER:${provider}`);
      expect(lines.filter((l) => l.startsWith("ARG:"))).toEqual([
        "ARG:a b",
        "ARG:it's",
        "ARG:--flag=x y",
        "ARG:",
      ]);
      const vars = Object.fromEntries(
        lines.filter((l) => !/^(PROVIDER|ARG):/.test(l)).map((l) => l.split(/=(.*)/s).slice(0, 2)),
      );
      expect(Object.keys(vars).toSorted((a, b) => a.localeCompare(b))).toEqual(
        spots[provider].toSorted((a, b) => a.localeCompare(b)),
      );
      const first = Object.values(vars)[0];
      expect(first.startsWith(dir)).toBe(true);
      const text = fs.readFileSync(wrapper, "utf8");
      expect(text.split("\n").slice(0, 4)).toEqual([
        "#!/bin/sh",
        "# orkest-managed-alias: v1",
        `# orkest-account-provider: ${provider === "agy" ? "antigravity" : provider}`,
        `# orkest-account-id: ${provider === "agy" ? "antigravity" : provider}-w`,
      ]);
      expect(text).toContain(`exec '${path.join(bin, provider)}' "$@"`);
    }
  }, 120_000);

  it("rejects unsafe aliases, slugs, paths and colliding executables", async () => {
    const add = (provider, o, c = {}) => addAccount({ provider, noSync: true, ...o }, ctx(c));
    await expect(add("claude", { profile: "a", alias: "cd" })).rejects.toThrow(/reserved/);
    await expect(add("claude", { profile: "a", alias: "precmd" })).rejects.toThrow(/reserved/);
    await expect(add("claude", { profile: "a", alias: "ork" })).rejects.toThrow(/reserved/);
    await expect(add("claude", { profile: "a", alias: "Bad" })).rejects.toThrow(/alias/);
    for (const bad of ["Bad", "..", ".", "a/b", "", "a\nb", "-x"]) {
      await expect(add("claude", { profile: bad })).rejects.toThrow();
    }
    await expect(add("claude", { profile: "a", short: "ABC" })).rejects.toThrow(/short/);
    await expect(add("claude", { profile: "a", short: "日本" })).rejects.toThrow(/short/);
    await expect(
      add("claude", { profile: "a", configDir: path.join(tmp, "outside") }),
    ).rejects.toThrow(/under the user home/);
    await expect(add("claude", { profile: "a", configDir: `${home}-evil/p` })).rejects.toThrow(
      /under the user home/,
    );
    await expect(add("claude", { profile: "a", configDir: home })).rejects.toThrow(/home itself/);
    await expect(add("claude", { profile: "a", configDir: "relative" })).rejects.toThrow(
      /absolute/,
    );
    await expect(add("nope", { profile: "a" })).rejects.toThrow(/provider/);
    expect(fs.existsSync(configPath())).toBe(false);

    // A foreign executable later on PATH blocks the alias, and nothing is written.
    const later = path.join(tmp, "later");
    fs.mkdirSync(later);
    fs.writeFileSync(path.join(later, "taken"), "#!/bin/sh\n", { mode: 0o755 });
    env.PATH = `${env.PATH}:${later}`;
    await expect(add("claude", { profile: "a", alias: "taken" })).rejects.toThrow(/shadow/);
    // Darwin treats names case-insensitively; pin the platform so the result is independent of the host.
    fs.writeFileSync(path.join(later, "MixedCase"), "#!/bin/sh\n", { mode: 0o755 });
    await expect(
      add("claude", { profile: "a", alias: "mixedcase" }, { platform: "darwin" }),
    ).rejects.toThrow(/shadow/);
    await expect(
      add("claude", { profile: "a", alias: "mixedcase" }, { platform: "linux" }),
    ).resolves.toBeTruthy();

    const local = path.join(home, ".local", "bin");
    fs.mkdirSync(local, { recursive: true });
    fs.writeFileSync(path.join(local, "unmanaged"), "#!/bin/sh\n", { mode: 0o755 });
    await expect(add("claude", { profile: "b", alias: "unmanaged" })).rejects.toThrow(
      /not an Orkest-managed/,
    );
    fs.writeFileSync(
      path.join(local, "wrongid"),
      "#!/bin/sh\n# orkest-managed-alias: v1\n# orkest-account-provider: claude\n# orkest-account-id: other\n",
      { mode: 0o755 },
    );
    await expect(add("claude", { profile: "b", alias: "wrongid" })).rejects.toThrow(
      /belongs to account other/,
    );
    fs.writeFileSync(
      path.join(local, "wrongprov"),
      "#!/bin/sh\n# orkest-managed-alias: v1\n# orkest-account-provider: codex\n# orkest-account-id: claude-b\n",
      { mode: 0o755 },
    );
    await expect(add("claude", { profile: "b", alias: "wrongprov" })).rejects.toThrow(
      /belongs to account/,
    );
    fs.symlinkSync(path.join(bin, "claude"), path.join(local, "linked"));
    await expect(add("claude", { profile: "b", alias: "linked" })).rejects.toThrow(/symlink/);
    fs.writeFileSync(path.join(tmp, "orig"), "x", { mode: 0o755 });
    fs.linkSync(path.join(tmp, "orig"), path.join(local, "hard"));
    await expect(add("claude", { profile: "b", alias: "hard" })).rejects.toThrow(/hard links/);

    // Symlinked profile descendant and overlapping roots.
    fs.mkdirSync(path.join(tmp, "elsewhere"));
    fs.symlinkSync(path.join(tmp, "elsewhere"), path.join(home, "sneaky"));
    await expect(
      add("claude", { profile: "b", configDir: path.join(home, "sneaky", "p") }),
    ).rejects.toThrow(/symlink/);
    expect(fs.existsSync(path.join(tmp, "elsewhere", "p"))).toBe(false);
    await add("codex", { profile: "root", configDir: path.join(home, "nest") });
    await expect(
      add("codex", { profile: "child", configDir: path.join(home, "nest", "child") }),
    ).rejects.toThrow(/overlaps/);
    await expect(add("codex", { profile: "parent", configDir: home })).rejects.toThrow();

    // Existing id with another provider or home is refused; collisions across accounts too.
    await expect(add("codex", { profile: "x", id: "mixedcase" })).rejects.toThrow(/collides/);
    await expect(add("claude", { profile: "root", id: "codex-root" })).rejects.toThrow(
      /already exists with provider/,
    );
    await expect(
      add("codex", { profile: "root", configDir: path.join(home, "other") }),
    ).rejects.toThrow(/already uses/);

    // A recursive provider (only found in ~/.local/bin) is refused.
    const lonely = { ...env, PATH: local };
    fs.writeFileSync(path.join(local, "opencode"), "#!/bin/sh\n", { mode: 0o755 });
    await expect(
      addAccount(
        { provider: "opencode", profile: "z", alias: "oc-z", noSync: true },
        ctx({ env: lonely }),
      ),
    ).rejects.toThrow(/not found on PATH outside/);
  }, 60_000);

  it("keeps a managed config symlink and contends on the target's lock", async () => {
    const real = path.join(tmp, "dotfiles", "monitor.json");
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.writeFileSync(real, JSON.stringify({ policy: { keep: 1 }, accounts: [] }));
    const link = path.join(tmp, "link.json");
    fs.symlinkSync(real, link);
    env.MONITOR_CONFIG = link;
    await addAccount({ provider: "claude", profile: "a", noSync: true }, ctx());
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(JSON.parse(fs.readFileSync(real, "utf8")).policy).toEqual({ keep: 1 });
    expect(JSON.parse(fs.readFileSync(real, "utf8")).accounts.map((a) => a.id)).toEqual([
      "claude-a",
    ]);
    expect(fs.existsSync(`${real}.lock`)).toBe(true);
    expect(fs.existsSync(`${link}.lock`)).toBe(false);
  });

  it("preserves a malformed config and every update from concurrent writers", async () => {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), "{not json");
    await expect(
      addAccount({ provider: "claude", profile: "a", noSync: true }, ctx()),
    ).rejects.toThrow(/not valid JSON/);
    expect(fs.readFileSync(configPath(), "utf8")).toBe("{not json");

    fs.writeFileSync(
      configPath(),
      JSON.stringify({
        unknown: { x: 1 },
        accounts: [{ id: "base", provider: "claude", route: "claude" }],
      }),
    );
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    spawnSync("git", ["init", "-q", repo]);
    const runNode = (code) =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
          env: { ...env },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let err = "";
        child.stderr.on("data", (d) => (err += d));
        child.on("close", (status) => resolve({ status, err }));
      });
    const jobs = [];
    for (let i = 0; i < 4; i += 1) {
      jobs.push(
        runNode(
          `import { addAccount } from ${JSON.stringify(ACCOUNTS)};` +
            `await addAccount({ provider: "codex", profile: "c${i}", noSync: true, tags: ["t${i}"] }, { runSync: () => ({ errors: [] }) });`,
        ),
      );
      jobs.push(
        runNode(
          `import { tagAccount } from ${JSON.stringify(ACCOUNTS)};` +
            `await tagAccount("base", "add", ["g${i}"], {});`,
        ),
      );
    }
    for (let i = 0; i < 3; i += 1) {
      const options = JSON.stringify({ configPath: configPath(), match: path.join(repo, `m${i}`) });
      jobs.push(
        runNode(
          `import { setRepoPolicyDeny } from ${JSON.stringify(POLICY)};` +
            `setRepoPolicyDeny(${JSON.stringify(repo)}, ["deny${i}"], ${options});`,
        ),
      );
    }
    const results = await Promise.all(jobs);
    for (const r of results) expect(r.status, r.err).toBe(0);
    const config = readConfig();
    expect(config.unknown).toEqual({ x: 1 });
    expect(config.accounts.map((a) => a.id).toSorted((a, b) => a.localeCompare(b))).toEqual([
      "base",
      "codex-c0",
      "codex-c1",
      "codex-c2",
      "codex-c3",
    ]);
    expect(
      config.accounts.find((a) => a.id === "base").tags.toSorted((a, b) => a.localeCompare(b)),
    ).toEqual(["g0", "g1", "g2", "g3"]);
    expect(JSON.stringify(config.repo_policies)).toMatch(/deny0/);
    expect(config.repo_policies.length).toBe(3);
  }, 120_000);

  it("recovers from failures before commit, after commit and during sync", async () => {
    const wrapper = path.join(home, ".local", "bin", "r1");
    const opts = { provider: "claude", profile: "r", alias: "r1" };
    await expect(
      addAccount({ ...opts, noSync: true }, ctx({ faults: { beforeCommit: true } })),
    ).rejects.toThrow(/injected/);
    expect(fs.existsSync(wrapper)).toBe(false);
    expect(fs.existsSync(configPath())).toBe(false);
    const retry = await addAccount({ ...opts, noSync: true }, ctx());
    expect(retry.sync.status).toBe("pending");
    expect(readConfig().accounts.filter((a) => a.id === "claude-r")).toHaveLength(1);
    expect(fs.existsSync(wrapper)).toBe(true);

    await expect(
      addAccount(
        { provider: "codex", profile: "r", alias: "r2", noSync: true },
        ctx({ faults: { afterCommit: true } }),
      ),
    ).rejects.toThrow(/injected/);
    expect(readConfig().accounts.some((a) => a.id === "codex-r")).toBe(true);
    const converged = await addAccount({ provider: "codex", profile: "r", alias: "r2" }, ctx());
    expect(converged.sync.status).toBe("current");
    expect(readConfig().accounts.filter((a) => a.id === "codex-r")).toHaveLength(1);

    // Sync failure: configured, pending, nonzero; repeating converges.
    const failed = await addAccount(
      { provider: "agy", profile: "s" },
      ctx({ faults: { sync: true } }),
    );
    expect(failed.exitCode).toBe(1);
    expect(failed.sync.status).toBe("pending");
    expect((await listAccounts(ctx())).find((a) => a.id === "antigravity-s").syncStatus).toBe(
      "pending",
    );
    const healed = await addAccount({ provider: "agy", profile: "s" }, ctx());
    expect(healed.sync.status).toBe("current");
    expect(healed.exitCode).toBeUndefined();
    expect((await listAccounts(ctx())).every((a) => a.syncStatus === "current")).toBe(true);
  }, 60_000);

  it("removes accounts without destroying profiles and gates purging", async () => {
    const dir = path.join(home, ".claude-p");
    await addAccount({ provider: "claude", profile: "p", alias: "rmprofile", noSync: true }, ctx());
    fs.writeFileSync(path.join(dir, "keep.txt"), "data");
    // --purge-profile alone never authorizes anything.
    await expect(removeAccount("rmprofile", { purgeProfile: true }, ctx())).rejects.toThrow(
      /confirmation/,
    );
    expect(readConfig().accounts.some((a) => a.id === "claude-p")).toBe(true);
    // A foreign marker is refused even when confirmed.
    const marker = path.join(dir, ".orkest-account.json");
    const original = fs.readFileSync(marker, "utf8");
    fs.writeFileSync(marker, JSON.stringify({ id: "someone-else", provider: "claude", home: dir }));
    await expect(
      removeAccount("rmprofile", { purgeProfile: true }, ctx({ confirm: () => true })),
    ).rejects.toThrow(/ownership marker/);
    fs.writeFileSync(marker, original);
    // A populated unrelated directory is never adopted as purgeable.
    const populated = path.join(home, "populated");
    fs.mkdirSync(populated);
    fs.writeFileSync(path.join(populated, "mine.txt"), "x");
    await addAccount(
      { provider: "codex", profile: "q", configDir: populated, noSync: true },
      ctx(),
    );
    expect(fs.existsSync(path.join(populated, ".orkest-account.json"))).toBe(false);
    await expect(
      removeAccount("codex-q", { purgeProfile: true }, ctx({ confirm: () => true })),
    ).rejects.toThrow(/ownership marker/);

    // Confirmed purge quarantines (recoverable); nothing is deleted.
    const done = await removeAccount(
      "rmprofile",
      { purgeProfile: true },
      ctx({ confirm: () => true }),
    );
    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.readFileSync(path.join(done.profileQuarantined, "keep.txt"), "utf8")).toBe("data");
    expect(fs.existsSync(done.wrapperQuarantined)).toBe(true);
    await tagAccount("codex-q", "set", ["x"], ctx());
  }, 60_000);

  it("syncs through the installer in dry-run mode without touching the home", () => {
    expect(ork(["add", "claude", "--profile", "d", "--no-sync"]).code).toBe(0);
    const before = snapshot(home);
    const run = ork(["sync", "--dry-run", "--json"]);
    expect(run.code, run.stderr).toBe(0);
    const payload = JSON.parse(run.stdout);
    expect(payload).toMatchObject({ schema: "ork.account.sync.v1", dryRun: true });
    expect(
      payload.profiles.some(
        (p) => p.id === "claude-d" && ["would-change", "unavailable"].includes(p.status),
      ),
    ).toBe(true);
    expect(snapshot(home)).toEqual(before);
    expect(JSON.stringify(payload)).not.toMatch(/Bearer|token/i);
  }, 60_000);
});
