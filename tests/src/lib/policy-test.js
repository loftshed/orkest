import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cachedQuota, filterAccountsByRepoPolicy } from "../../../src/bin/horde-tui.mjs";
import {
  evaluateRepoPolicy as evaluateMonitorPolicy,
  callTool as monitorCallTool,
  handle as monitorHandle,
} from "../../../src/lib/monitor/mcp.mjs";
import {
  isAccountAllowed,
  isHarnessAllowed,
  loadConfiguredAccounts,
  normalizeAccountTags,
  normalizeDenyToken,
  POLICY_SCHEMA,
  resolveConfiguredAccount,
  resolvePolicyConfigPath,
  resolveRepoPolicy,
  runPolicyCli,
  setRepoPolicyDeny,
} from "../../../src/lib/policy.mjs";

const REPO_ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SCRIPTS_DIR = path.join(REPO_ROOT_DIR, "src/py");

function git(cwd, ...args) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
  }
  return res.stdout.trim();
}

function makeRepo(parent, name, { remoteUrl = null } = {}) {
  const dir = path.join(parent, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "policy@example.test");
  git(dir, "config", "user.name", "Policy Test");
  fs.writeFileSync(path.join(dir, "README.md"), `# ${name}\n`, "utf8");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  if (remoteUrl) {
    git(dir, "remote", "add", "origin", remoteUrl);
  }
  return fs.realpathSync(dir);
}

function runPythonPolicy(cwd, { homeDir, configPath = null, env = {} } = {}) {
  const pyCode = [
    "import json, sys",
    `sys.path.insert(0, ${JSON.stringify(SCRIPTS_DIR)})`,
    "import repo_policy",
    "payload = json.loads(sys.stdin.read())",
    "res = repo_policy.resolve_repo_policy(",
    "    payload['cwd'],",
    "    home=payload.get('home'),",
    "    config_path=payload.get('config_path'),",
    "    env=payload.get('env'),",
    ")",
    "print(json.dumps(res))",
  ].join("\n");
  const pyEnv = {
    PATH: process.env.PATH || "",
    HOME: homeDir,
    ...env,
  };
  const res = spawnSync("python3", ["-c", pyCode], {
    input: JSON.stringify({
      cwd,
      home: homeDir,
      config_path: configPath,
      env: pyEnv,
    }),
    env: pyEnv,
    encoding: "utf8",
  });
  if (res.status !== 0) {
    throw new Error(`python repo_policy failed: ${res.stderr}`);
  }
  return JSON.parse(res.stdout.trim());
}

function assertParity(jsPolicy, pyPolicy) {
  expect(jsPolicy.schema).toBe(POLICY_SCHEMA);
  expect(pyPolicy.schema).toBe(POLICY_SCHEMA);
  expect(jsPolicy.repo).toBe(pyPolicy.repo);
  expect(jsPolicy.remote).toBe(pyPolicy.remote);
  expect(jsPolicy.deny).toEqual(pyPolicy.deny);
  expect(jsPolicy.allowed_harnesses).toEqual(pyPolicy.allowed_harnesses);
  expect(jsPolicy.matched_rules).toEqual(pyPolicy.matched_rules);
}

describe("canonical repo policy parity & monitor adapter", () => {
  let tmpDir;
  let fakeHome;

  beforeEach(() => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ork-policy-test-"));
    tmpDir = fs.realpathSync(scratch);
    fakeHome = path.join(tmpDir, "home");
    fs.mkdirSync(fakeHome, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("matches JS and Python across all 5 deny keys individually and combined", () => {
    const repo = makeRepo(tmpDir, "deny-keys-repo");
    const keys = [
      ["deny", ["codex"]],
      ["denied", ["OpenAI", "gemini"]],
      ["denied_harnesses", ["openrouter"]],
      ["deniedHarnesses", ["claude"]],
      ["denied_engines", ["claude-personal", " ", 42, null]],
    ];

    for (const [key, values] of keys) {
      const cfgPath = path.join(tmpDir, `cfg-${key}.json`);
      fs.writeFileSync(
        cfgPath,
        JSON.stringify({
          repo_policies: [{ path: repo, [key]: values }],
        }),
        "utf8",
      );
      const jsPol = resolveRepoPolicy(repo, { configPath: cfgPath, homeDir: fakeHome });
      const pyPol = runPythonPolicy(repo, { configPath: cfgPath, homeDir: fakeHome });
      assertParity(jsPol, pyPol);
    }

    const combinedCfg = path.join(tmpDir, "cfg-combined.json");
    fs.writeFileSync(
      combinedCfg,
      JSON.stringify({
        repo_policies: [
          {
            path: repo,
            deny: ["codex", "  "],
            denied: ["gemini", "codex"],
            denied_harnesses: ["openrouter"],
            deniedHarnesses: ["claude"],
            denied_engines: ["personal-claude", 123],
          },
        ],
      }),
      "utf8",
    );
    const jsCombined = resolveRepoPolicy(repo, { configPath: combinedCfg, homeDir: fakeHome });
    const pyCombined = runPythonPolicy(repo, { configPath: combinedCfg, homeDir: fakeHome });
    assertParity(jsCombined, pyCombined);
    expect(jsCombined.deny).toEqual(["codex", "agy", "opencode", "claude", "claude-personal"]);
    expect(jsCombined.allowed_harnesses).toEqual([]);
  });

  it("accumulates snake and camel repo_policies/repoPolicies arrays & maps and selectorless scoping", () => {
    const repo = makeRepo(tmpDir, "target-repo");
    const otherRepo = makeRepo(tmpDir, "other-repo");
    const cfgPath = path.join(tmpDir, "snake-camel.json");
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        repo_policies: [
          { deny: ["codex"] }, // global selectorless array rule: must NOT match all
          { path: repo, deny: ["agy"] },
        ],
        repoPolicies: {
          "target-repo": ["opencode"], // map-to-array using key as match
          "ignored-key": { repo: "other-repo", deny: ["claude-work"] }, // explicit repo selector ignores map key
        },
      }),
      "utf8",
    );

    const jsTarget = resolveRepoPolicy(repo, { configPath: cfgPath, homeDir: fakeHome });
    const pyTarget = runPythonPolicy(repo, { configPath: cfgPath, homeDir: fakeHome });
    assertParity(jsTarget, pyTarget);
    expect(jsTarget.deny).toEqual(["agy", "opencode"]);

    const jsOther = resolveRepoPolicy(otherRepo, { configPath: cfgPath, homeDir: fakeHome });
    const pyOther = runPythonPolicy(otherRepo, { configPath: cfgPath, homeDir: fakeHome });
    assertParity(jsOther, pyOther);
    expect(jsOther.deny).toEqual(["claude-work"]);

    // Local .orkest/policy.json: top-level aliases + selectorless nested rules match all there
    fs.mkdirSync(path.join(repo, ".orkest"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, ".orkest", "policy.json"),
      JSON.stringify({
        deniedHarnesses: ["claude"],
        repo_policies: [{ deny: ["claude-alt"] }],
        repoPolicies: [{ denied: ["codex"] }],
      }),
      "utf8",
    );
    const jsLocal = resolveRepoPolicy(repo, { configPath: cfgPath, homeDir: fakeHome });
    const pyLocal = runPythonPolicy(repo, { configPath: cfgPath, homeDir: fakeHome });
    assertParity(jsLocal, pyLocal);
    expect(jsLocal.deny).toEqual(["agy", "opencode", "claude", "claude-alt", "codex"]);
  });

  it("matches globs (*, ?, [...]), ~, trailing /, /*, component boundaries, and symlink aliases identically", () => {
    const workParent = path.join(fakeHome, "work");
    const workSibling = path.join(fakeHome, "work-old");
    const orgDir = path.join(tmpDir, "acme");
    const badOrgDir = path.join(tmpDir, "myacme");
    fs.mkdirSync(workParent, { recursive: true });
    fs.mkdirSync(workSibling, { recursive: true });

    const repo1 = makeRepo(workParent, "svc-1");
    const repoA = makeRepo(workParent, "svc-a");
    const siblingRepo = makeRepo(workSibling, "otherrepo");
    const orgRepo = makeRepo(orgDir, "billing");
    const badOrgRepo = makeRepo(badOrgDir, "billing");

    // Symlink alias pointing to workParent
    const symlinkAlias = path.join(tmpDir, "alias-work");
    fs.symlinkSync(workParent, symlinkAlias);

    const cfgPath = path.join(tmpDir, "globs.json");
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        repo_policies: [
          { path: `${symlinkAlias}/*`, deny: ["codex"] },
          { path: "~/work/svc-[0-9]", deny: ["agy"] },
          { path: "~/work/svc-[!0-9]", deny: ["opencode"] },
          { path: "~/work/svc-?", deny: ["claude-work"] },
          { path: "acme/billing", deny: ["claude-alt"] },
          { path: "work", deny: ["should-not-match-bare"] },
        ],
      }),
      "utf8",
    );

    for (const candidate of [repo1, repoA, siblingRepo, orgRepo, badOrgRepo]) {
      const jsPol = resolveRepoPolicy(candidate, { configPath: cfgPath, homeDir: fakeHome });
      const pyPol = runPythonPolicy(candidate, { configPath: cfgPath, homeDir: fakeHome });
      assertParity(jsPol, pyPol);
    }

    const r1 = resolveRepoPolicy(repo1, { configPath: cfgPath, homeDir: fakeHome });
    expect(r1.deny).toEqual(["codex", "agy", "claude-work"]);

    const rA = resolveRepoPolicy(repoA, { configPath: cfgPath, homeDir: fakeHome });
    expect(rA.deny).toEqual(["codex", "opencode", "claude-work"]);

    // Sibling prefix work-old/otherrepo must NOT match ~/work/* or work/
    const rSib = resolveRepoPolicy(siblingRepo, { configPath: cfgPath, homeDir: fakeHome });
    expect(rSib.deny).toEqual([]);

    // Component boundary: acme/billing matches .../acme/billing but NOT .../myacme/billing
    expect(resolveRepoPolicy(orgRepo, { configPath: cfgPath, homeDir: fakeHome }).deny).toEqual([
      "claude-alt",
    ]);
    expect(resolveRepoPolicy(badOrgRepo, { configPath: cfgPath, homeDir: fakeHome }).deny).toEqual(
      [],
    );

    // Trailing slash on canonicalized alias matches root & descendants at component boundary
    const trailingCfg = path.join(tmpDir, "trailing.json");
    fs.writeFileSync(
      trailingCfg,
      JSON.stringify({
        repo_policies: [{ path: `${symlinkAlias}/`, deny: ["codex"] }],
      }),
      "utf8",
    );
    expect(resolveRepoPolicy(repo1, { configPath: trailingCfg, homeDir: fakeHome }).deny).toEqual([
      "codex",
    ]);
    expect(
      resolveRepoPolicy(siblingRepo, { configPath: trailingCfg, homeDir: fakeHome }).deny,
    ).toEqual([]);
    assertParity(
      resolveRepoPolicy(repo1, { configPath: trailingCfg, homeDir: fakeHome }),
      runPythonPolicy(repo1, { configPath: trailingCfg, homeDir: fakeHome }),
    );
  });

  it("evaluates remote substring/glob, conjunctive path+remote, disjunctive match, and keeps path separate from remote", () => {
    const repo = makeRepo(tmpDir, "corp-api", {
      remoteUrl: "git@github.com:CorpOrg/corp-api.git",
    });
    const cfgPath = path.join(tmpDir, "remote.json");
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        repo_policies: [
          { path: "CorpOrg", deny: ["codex"] }, // path selector must NOT match remote
          { remote: "corporg/*", deny: ["agy"] }, // case-insensitive remote glob
          { path: repo, remote: "github.com:corporg/corp-api.git", deny: ["opencode"] }, // conjunctive
          { path: repo, remote: "otherorg/*", deny: ["claude-work"] }, // conjunctive fails
          { match: "corporg/corp-api*", deny: ["claude-alt"] }, // match hits remote
        ],
      }),
      "utf8",
    );

    const jsPol = resolveRepoPolicy(repo, { configPath: cfgPath, homeDir: fakeHome });
    const pyPol = runPythonPolicy(repo, { configPath: cfgPath, homeDir: fakeHome });
    assertParity(jsPol, pyPol);
    expect(jsPol.deny).toEqual(["agy", "opencode", "claude-alt"]);
  });

  it("handles malformed config, all/claude-all, config lookup precedence, and alias deny -> allow -> show", () => {
    const repo = makeRepo(tmpDir, "alias-repo");
    const cfgDir = path.join(fakeHome, ".config", "orchestrate");
    const legacyDir = path.join(fakeHome, ".config", "agent-executor");
    fs.mkdirSync(legacyDir, { recursive: true });
    const legacyFile = path.join(legacyDir, "config.json");
    fs.writeFileSync(legacyFile, "{not-valid-json", "utf8");

    // Precedence: legacy exists when primary doesn't, malformed JSON falls back cleanly to allow all
    expect(resolvePolicyConfigPath({ homeDir: fakeHome, env: { HOME: fakeHome } })).toBe(
      legacyFile,
    );
    const malformedJs = resolveRepoPolicy(repo, {
      homeDir: fakeHome,
      env: { HOME: fakeHome },
    });
    const malformedPy = runPythonPolicy(repo, { homeDir: fakeHome });
    assertParity(malformedJs, malformedPy);
    expect(malformedJs.deny).toEqual([]);
    expect(malformedJs.allowed_harnesses).toEqual(["codex", "agy", "claude", "opencode"]);

    // Primary beats legacy when both exist
    fs.mkdirSync(cfgDir, { recursive: true });
    const primaryFile = path.join(cfgDir, "config.json");
    fs.writeFileSync(
      primaryFile,
      JSON.stringify({
        repo_policies: [
          {
            path: repo,
            deniedHarnesses: ["claude-all", "openai"],
          },
        ],
      }),
      "utf8",
    );
    expect(resolvePolicyConfigPath({ homeDir: fakeHome, env: { HOME: fakeHome } })).toBe(
      primaryFile,
    );
    const claudeAll = resolveRepoPolicy(repo, { homeDir: fakeHome, env: { HOME: fakeHome } });
    expect(claudeAll.allowed_harnesses).toEqual(["agy", "opencode"]);
    expect(
      isHarnessAllowed(repo, "claude-personal", { homeDir: fakeHome, env: { HOME: fakeHome } }),
    ).toBe(false);

    // allow removes provider & tag aliases cleanly
    const afterAllow = setRepoPolicyDeny(repo, ["claude", "codex"], {
      mode: "allow",
      configPath: primaryFile,
      homeDir: fakeHome,
      env: { HOME: fakeHome },
    });
    expect(afterAllow.deny).toEqual([]);
    expect(afterAllow.allowed_harnesses).toEqual(["codex", "agy", "claude", "opencode"]);

    const tagDeny = setRepoPolicyDeny(repo, ["claude-work", "claude-personal", "codex"], {
      mode: "add",
      configPath: primaryFile,
      homeDir: fakeHome,
      env: { HOME: fakeHome },
    });
    expect(tagDeny.allowed_harnesses).toEqual(["agy", "claude", "opencode"]);
    const afterPartialAllow = setRepoPolicyDeny(repo, ["claude-work", "codex"], {
      mode: "allow",
      configPath: primaryFile,
      homeDir: fakeHome,
      env: { HOME: fakeHome },
    });
    expect(afterPartialAllow.deny).toEqual(["claude-personal"]);
    expect(afterPartialAllow.allowed_harnesses).toEqual(["codex", "agy", "claude", "opencode"]);

    const shown = runPolicyCli(["show", "--cwd", repo, "--json"], {
      configPath: primaryFile,
      homeDir: fakeHome,
      env: { HOME: fakeHome },
      silent: true,
    });
    expect(shown.deny).toEqual(["claude-personal"]);

    // "all" denies every harness
    const allRes = setRepoPolicyDeny(repo, ["all"], {
      mode: "add",
      configPath: primaryFile,
      homeDir: fakeHome,
      env: { HOME: fakeHome },
    });
    expect(allRes.allowed_harnesses).toEqual([]);
    expect(normalizeDenyToken("ALL")).toBe("all");
  });

  it("prioritizes explicit billing over display label in filterAccountsByRepoPolicy and re-evaluates cachedQuota per cwd", async () => {
    const accounts = [
      {
        id: "c-work",
        provider: "claude",
        billing: "work",
        label: "Claude Personal Display",
      },
      {
        id: "c-pers",
        provider: "claude",
        billing: "personal",
        label: "Claude Work Display",
      },
      { id: "oc", provider: "opencode", label: "OpenCode" },
      { id: "cx", provider: "codex", label: "Codex" },
    ];
    expect(filterAccountsByRepoPolicy(accounts, ["claude-work"]).map((a) => a.id)).toEqual([
      "c-pers",
      "oc",
      "cx",
    ]);
    expect(
      filterAccountsByRepoPolicy(accounts, ["claude-personal", "opencode"]).map((a) => a.id),
    ).toEqual(["c-work", "cx"]);
    expect(filterAccountsByRepoPolicy(accounts, ["all"])).toEqual([]);

    const repoA = makeRepo(tmpDir, "quota-a");
    const repoB = makeRepo(tmpDir, "quota-b");
    fs.mkdirSync(path.join(repoB, ".orkest"), { recursive: true });
    fs.writeFileSync(
      path.join(repoB, ".orkest", "policy.json"),
      JSON.stringify({ deny: ["claude-work"] }),
      "utf8",
    );

    const quotaCacheDir = path.join(tmpDir, "monitor-cache");
    const monitorCfgPath = path.join(tmpDir, "monitor-config.json");
    fs.mkdirSync(quotaCacheDir, { recursive: true });
    fs.writeFileSync(
      path.join(quotaCacheDir, "snapshot.json"),
      JSON.stringify({
        accounts: {
          claude: { id: "claude", provider: "claude", billing: "work", label: "Claude Work" },
          "claude-alt": {
            id: "claude-alt",
            provider: "claude",
            billing: "personal",
            label: "Claude Personal",
          },
          codex: { id: "codex", provider: "codex", label: "Codex" },
          "gemini-openai": {
            id: "gemini-openai",
            provider: "antigravity",
            label: "Antigravity Custom",
          },
        },
      }),
      "utf8",
    );
    fs.writeFileSync(
      monitorCfgPath,
      JSON.stringify({
        accounts: [
          { id: "claude", provider: "claude", billing: "work", label: "Claude Work" },
          { id: "claude-alt", provider: "claude", billing: "personal", label: "Claude Personal" },
          { id: "codex", provider: "codex", label: "Codex" },
          { id: "gemini-openai", provider: "antigravity", label: "Antigravity Custom" },
        ],
      }),
      "utf8",
    );

    const first = await cachedQuota(repoA, {
      cacheDir: quotaCacheDir,
      monitorConfigPath: monitorCfgPath,
      homeDir: fakeHome,
      env: { HOME: fakeHome },
    });
    const second = await cachedQuota(repoB, {
      cacheDir: quotaCacheDir,
      monitorConfigPath: monitorCfgPath,
      homeDir: fakeHome,
      env: { HOME: fakeHome },
    });
    expect(first.map((a) => a.id)).toEqual(["claude", "claude-alt", "codex", "gemini-openai"]);
    expect(second.map((a) => a.id)).toEqual(["claude-alt", "codex", "gemini-openai"]);
  });

  it("handles project[1], Unicode ? globs, . and ./ selectors, symlink/.. + ~/repo cwd, custom account IDs, and rule-identity mutations", () => {
    // 1. Repository name with brackets ("project[1]")
    const bracketRepo = makeRepo(tmpDir, "project[1]");
    fs.mkdirSync(path.join(bracketRepo, ".orkest"), { recursive: true });
    fs.writeFileSync(
      path.join(bracketRepo, ".orkest", "policy.json"),
      JSON.stringify({ deny: ["codex"] }),
      "utf8",
    );
    const bracketLocalJs = resolveRepoPolicy(bracketRepo, {
      homeDir: fakeHome,
      env: { HOME: fakeHome },
    });
    const bracketLocalPy = runPythonPolicy(bracketRepo, { homeDir: fakeHome });
    assertParity(bracketLocalJs, bracketLocalPy);
    expect(bracketLocalJs.deny).toEqual(["codex"]);

    const bracketGlobalCfg = path.join(tmpDir, "bracket-global.json");
    fs.writeFileSync(
      bracketGlobalCfg,
      JSON.stringify({
        repo_policies: [
          { path: bracketRepo, deny: ["agy"] },
          { path: `${bracketRepo}/`, deny: ["opencode"] },
        ],
      }),
      "utf8",
    );
    const bracketGlobalJs = resolveRepoPolicy(bracketRepo, {
      configPath: bracketGlobalCfg,
      homeDir: fakeHome,
      env: { HOME: fakeHome },
    });
    const bracketGlobalPy = runPythonPolicy(bracketRepo, {
      configPath: bracketGlobalCfg,
      homeDir: fakeHome,
    });
    assertParity(bracketGlobalJs, bracketGlobalPy);
    expect(bracketGlobalJs.deny).toEqual(["agy", "opencode", "codex"]);

    // 2. Unicode ? glob parity: svc-? matches svc-😀 (single Unicode code point) in both JS & Python
    const emojiRepo = makeRepo(tmpDir, "svc-😀");
    const unicodeCfg = path.join(tmpDir, "unicode.json");
    fs.writeFileSync(
      unicodeCfg,
      JSON.stringify({
        repo_policies: [{ path: path.join(tmpDir, "svc-?"), deny: ["codex"] }],
      }),
      "utf8",
    );
    const emojiJs = resolveRepoPolicy(emojiRepo, {
      configPath: unicodeCfg,
      homeDir: fakeHome,
      env: { HOME: fakeHome },
    });
    const emojiPy = runPythonPolicy(emojiRepo, { configPath: unicodeCfg, homeDir: fakeHome });
    assertParity(emojiJs, emojiPy);
    expect(emojiJs.deny).toEqual(["codex"]);

    // 3. Relative "." and "./" selectors match evaluated repo
    const dotRepo = makeRepo(tmpDir, "dot-repo");
    const dotCfg = path.join(tmpDir, "dot.json");
    fs.writeFileSync(
      dotCfg,
      JSON.stringify({
        repo_policies: [
          { path: ".", deny: ["codex"] },
          { path: "./", deny: ["agy"] },
        ],
      }),
      "utf8",
    );
    const dotSubdir = path.join(dotRepo, "nested");
    fs.mkdirSync(dotSubdir, { recursive: true });
    const dotJs = resolveRepoPolicy(dotSubdir, {
      configPath: dotCfg,
      homeDir: fakeHome,
      env: { HOME: fakeHome },
    });
    const dotPy = runPythonPolicy(dotSubdir, { configPath: dotCfg, homeDir: fakeHome });
    assertParity(dotJs, dotPy);
    expect(dotJs.deny).toEqual(["codex", "agy"]);

    // 4. Symlink + ".." canonicalization & ~/repo cwd expansion parity
    const realRoot = path.join(tmpDir, "real-tree");
    const targetSub = path.join(realRoot, "target", "sub");
    fs.mkdirSync(targetSub, { recursive: true });
    const siblingRepo = makeRepo(path.join(realRoot, "target"), "sibling-repo");
    const linkHolder = path.join(tmpDir, "link-holder");
    fs.mkdirSync(linkHolder, { recursive: true });
    const symPath = path.join(linkHolder, "sym");
    fs.symlinkSync(targetSub, symPath);
    const homeRepo = makeRepo(fakeHome, "home-repo");

    const pathNormCfg = path.join(tmpDir, "path-norm.json");
    fs.writeFileSync(
      pathNormCfg,
      JSON.stringify({
        repo_policies: [
          { path: siblingRepo, deny: ["codex"] },
          { path: homeRepo, deny: ["opencode"] },
        ],
      }),
      "utf8",
    );
    const symDotDotInput = `${symPath}/../sibling-repo`;
    const symJs = resolveRepoPolicy(symDotDotInput, {
      configPath: pathNormCfg,
      homeDir: fakeHome,
      env: { HOME: fakeHome },
    });
    const symPy = runPythonPolicy(symDotDotInput, { configPath: pathNormCfg, homeDir: fakeHome });
    assertParity(symJs, symPy);
    expect(symJs.repo).toBe(siblingRepo);
    expect(symJs.deny).toEqual(["codex"]);

    const tildeJs = resolveRepoPolicy("~/home-repo", {
      configPath: pathNormCfg,
      homeDir: fakeHome,
      env: { HOME: fakeHome },
    });
    const tildePy = runPythonPolicy("~/home-repo", { configPath: pathNormCfg, homeDir: fakeHome });
    assertParity(tildeJs, tildePy);
    expect(tildeJs.repo).toBe(homeRepo);
    expect(tildeJs.deny).toEqual(["opencode"]);

    // 5. Provider precedence & exact custom account ID denials
    const agyOpenAiAcct = {
      id: "gemini-openai",
      provider: "antigravity",
      label: "Gemini OpenAI",
    };
    const customCodexAcct = {
      id: "work-box-2",
      provider: "codex",
      label: "Work Box 2",
    };
    expect(isHarnessAllowed(null, agyOpenAiAcct, { policy: { deny: ["codex"] } })).toBe(true);
    expect(isHarnessAllowed(null, agyOpenAiAcct, { policy: { deny: ["agy"] } })).toBe(false);
    expect(isHarnessAllowed(null, customCodexAcct, { policy: { deny: ["work-box-2"] } })).toBe(
      false,
    );
    expect(
      filterAccountsByRepoPolicy([agyOpenAiAcct, customCodexAcct], ["agy", "work-box-2"]),
    ).toEqual([]);

    // 6. setRepoPolicyDeny preserves selector kind & trailing-slash specificity on allow/reset
    const groupDir = path.join(tmpDir, "group");
    const groupRepo = makeRepo(tmpDir, "group");
    const childInGroup = makeRepo(groupDir, "child");
    const mutCfg = path.join(tmpDir, "mutate-specificity.json");
    fs.writeFileSync(
      mutCfg,
      JSON.stringify({
        repo_policies: [
          { path: `${groupRepo}/`, deny: ["codex"] },
          { repo: groupRepo, deny: ["agy", "opencode"] },
          { repo: "group", deny: ["claude-alt"] },
        ],
      }),
      "utf8",
    );
    const afterAllow = setRepoPolicyDeny(groupRepo, ["agy"], {
      mode: "allow",
      configPath: mutCfg,
      homeDir: fakeHome,
      env: { HOME: fakeHome },
    });
    expect(afterAllow.deny).toEqual(["codex", "opencode", "claude-alt"]);
    const savedAfterAllow = JSON.parse(fs.readFileSync(mutCfg, "utf8"));
    expect(savedAfterAllow.repo_policies).toEqual([
      { path: `${groupRepo}/`, deny: ["codex"] },
      { repo: groupRepo, deny: ["opencode"] },
      { repo: "group", deny: ["claude-alt"] },
    ]);

    setRepoPolicyDeny(groupRepo, [], {
      mode: "reset",
      configPath: mutCfg,
      homeDir: fakeHome,
      env: { HOME: fakeHome },
    });
    const savedAfterReset = JSON.parse(fs.readFileSync(mutCfg, "utf8"));
    expect(savedAfterReset.repo_policies).toEqual([
      { path: `${groupRepo}/`, deny: ["codex"] },
      { repo: "group", deny: ["claude-alt"] },
    ]);
    // Group trailing-slash rule still applies to childInGroup!
    expect(
      resolveRepoPolicy(childInGroup, {
        configPath: mutCfg,
        homeDir: fakeHome,
        env: { HOME: fakeHome },
      }).deny,
    ).toEqual(["codex"]);
  });

  it("enforces standalone Monitor policy evaluation without ork CLI while failing closed on invalid config or rules", async () => {
    const repo = makeRepo(tmpDir, "monitor-repo");
    const unrestrictedRepo = makeRepo(tmpDir, "unrestricted-monitor-repo");
    const cfgPath = path.join(tmpDir, "monitor-policy.json");
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        repo_policies: [{ path: repo, deny: ["claude-work", "codex"] }],
      }),
      "utf8",
    );

    const futureReset = Date.now() + 3_600_000;
    const nowMs = Date.now();
    const mockAccounts = [
      {
        id: "claude",
        provider: "claude",
        label: "Claude Personal Label",
        billing: "work",
        route: "claude",
        ok: true,
        fetchedAt: nowMs,
        windows: [
          {
            id: "session",
            label: "5h",
            kind: "session",
            windowMins: 300,
            remainingPct: 90,
            usedPct: 10,
            resetsAt: futureReset,
          },
        ],
        pools: [
          {
            id: "all",
            label: "Claude Personal Label",
            families: ["claude"],
            windowIds: ["session"],
            route: "claude",
          },
        ],
      },
      {
        id: "claude-alt",
        provider: "claude",
        label: "Claude Work Label",
        billing: "personal",
        route: "CLAUDE_CONFIG_DIR=~/.claude-personal claude",
        ok: true,
        fetchedAt: nowMs,
        windows: [
          {
            id: "session",
            label: "5h",
            kind: "session",
            windowMins: 300,
            remainingPct: 70,
            usedPct: 30,
            resetsAt: futureReset,
          },
        ],
        pools: [
          {
            id: "all",
            label: "Claude Work Label",
            families: ["claude"],
            windowIds: ["session"],
            route: "CLAUDE_CONFIG_DIR=~/.claude-personal claude",
          },
        ],
      },
      {
        id: "codex",
        provider: "codex",
        label: "Codex",
        billing: "work",
        route: "codex",
        ok: true,
        fetchedAt: nowMs,
        windows: [
          {
            id: "session",
            label: "5h",
            kind: "session",
            windowMins: 300,
            remainingPct: 80,
            usedPct: 20,
            resetsAt: futureReset,
          },
        ],
        pools: [
          {
            id: "all",
            label: "Codex",
            families: ["gpt"],
            windowIds: ["session"],
            route: "codex",
          },
        ],
      },
      {
        id: "gemini-openai",
        provider: "antigravity",
        label: "Gemini OpenAI Custom",
        billing: "personal",
        route: "agy",
        ok: true,
        fetchedAt: nowMs,
        windows: [
          {
            id: "session",
            label: "5h",
            kind: "session",
            windowMins: 300,
            remainingPct: 85,
            usedPct: 15,
            resetsAt: futureReset,
          },
        ],
        pools: [
          {
            id: "all",
            label: "Gemini OpenAI Custom",
            families: ["gemini"],
            windowIds: ["session"],
            route: "agy",
          },
        ],
      },
    ];

    // 1. Standalone Monitor filters denied lanes directly without ork subprocess
    const recText = await monitorCallTool(
      "recommend",
      { cwd: repo },
      {
        getAccounts: async () => mockAccounts,
        policyOptions: {
          configPath: cfgPath,
          homeDir: fakeHome,
          env: { HOME: fakeHome, PATH: "" },
        },
      },
    );
    expect(recText).toContain("Claude Work Label");
    expect(recText).toContain("Gemini OpenAI Custom");
    expect(recText).not.toContain("Claude Personal Label");
    expect(recText).not.toContain("Codex");

    // 2. Unrestricted repo succeeds cleanly on Monitor-only install even with empty PATH (no ork binary)
    const unrestrictedRec = await monitorCallTool(
      "recommend",
      { cwd: unrestrictedRepo },
      {
        getAccounts: async () => mockAccounts,
        policyOptions: { homeDir: fakeHome, env: { HOME: fakeHome, PATH: "" } },
      },
    );
    expect(unrestrictedRec).toContain("Claude Personal Label");

    // 3. Invalid / malformed JSON config fails closed for recommend, while get_usage stays independent
    const badJsonCfg = path.join(tmpDir, "bad-policy.json");
    fs.writeFileSync(badJsonCfg, "{not-valid-json", "utf8");
    await expect(
      evaluateMonitorPolicy(repo, {
        configPath: badJsonCfg,
        homeDir: fakeHome,
        env: { HOME: fakeHome },
      }),
    ).rejects.toThrow(/unavailable/u);

    const errReply = await monitorHandle(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "recommend", arguments: { cwd: repo } },
      },
      {
        getAccounts: async () => mockAccounts,
        policyOptions: { configPath: badJsonCfg, homeDir: fakeHome, env: { HOME: fakeHome } },
      },
    );
    expect(errReply.result.isError).toBe(true);
    expect(errReply.result.content[0].text).toContain("unavailable");

    const usageReply = await monitorHandle(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "get_usage", arguments: {} },
      },
      {
        getAccounts: async () => mockAccounts,
        policyOptions: { configPath: badJsonCfg, homeDir: fakeHome, env: { HOME: fakeHome } },
      },
    );
    expect(usageReply.result.isError).toBeUndefined();
    expect(usageReply.result.content[0].text).toContain("Claude Personal Label");

    // 4. Malformed rule field (non-array deny) or malformed .orkest/policy.json fails closed
    const badRuleCfg = path.join(tmpDir, "bad-rule.json");
    fs.writeFileSync(
      badRuleCfg,
      JSON.stringify({ repo_policies: [{ path: repo, deny: "codex" }] }),
      "utf8",
    );
    await expect(
      evaluateMonitorPolicy(repo, {
        configPath: badRuleCfg,
        homeDir: fakeHome,
        env: { HOME: fakeHome },
      }),
    ).rejects.toThrow(/unavailable/u);

    fs.mkdirSync(path.join(unrestrictedRepo, ".orkest"), { recursive: true });
    fs.writeFileSync(path.join(unrestrictedRepo, ".orkest", "policy.json"), "{broken", "utf8");
    await expect(
      evaluateMonitorPolicy(unrestrictedRepo, {
        homeDir: fakeHome,
        env: { HOME: fakeHome },
      }),
    ).rejects.toThrow(/unavailable/u);

    // 5. Invalid pre-evaluated policy schema fails closed
    await expect(
      evaluateMonitorPolicy(repo, { policy: { schema: "wrong", deny: [], allowed_harnesses: [] } }),
    ).rejects.toThrow(/invalid policy schema/u);

    // 6. Valid policy filters agy account with "openai" in ID only when agy is denied
    const agyDenyCfg = path.join(tmpDir, "agy-deny.json");
    fs.writeFileSync(
      agyDenyCfg,
      JSON.stringify({ repo_policies: [{ path: repo, deny: ["agy"] }] }),
      "utf8",
    );
    const agyDeniedRec = await monitorCallTool(
      "recommend",
      { cwd: repo },
      {
        getAccounts: async () => mockAccounts,
        policyOptions: { configPath: agyDenyCfg, homeDir: fakeHome, env: { HOME: fakeHome } },
      },
    );
    expect(agyDeniedRec).not.toContain("Gemini OpenAI Custom");
    expect(agyDeniedRec).toContain("Codex");
  });

  it("enforces strict deny member validation, git failure fail-closed, atomic config writes, fnmatch character-class parity, and Python check_execution_allowed account/provider/billing kwargs", () => {
    // 1. Nested/non-string deny members fail closed in strict mode (both array rules and map-shorthand rules)
    const repo = makeRepo(tmpDir, "strict-repo");
    const nestedCfg = path.join(tmpDir, "nested-deny.json");
    fs.writeFileSync(
      nestedCfg,
      JSON.stringify({ repo_policies: [{ path: repo, deny: [["all"]] }] }),
      "utf8",
    );
    expect(() =>
      resolveRepoPolicy(repo, { configPath: nestedCfg, homeDir: fakeHome, strict: true }),
    ).toThrow(/expected non-empty string/u);

    const shorthandNestedCfg = path.join(tmpDir, "shorthand-nested-deny.json");
    fs.writeFileSync(
      shorthandNestedCfg,
      JSON.stringify({ repo_policies: { [repo]: [["all"]] } }),
      "utf8",
    );
    expect(() =>
      resolveRepoPolicy(repo, { configPath: shorthandNestedCfg, homeDir: fakeHome, strict: true }),
    ).toThrow(/shorthand entry/u);

    const pyStrictCheck = spawnSync(
      "python3",
      [
        "-c",
        [
          "import sys",
          `sys.path.insert(0, ${JSON.stringify(SCRIPTS_DIR)})`,
          "import repo_policy",
          `repo_policy.check_execution_allowed(${JSON.stringify(repo)}, 'codex', config_path=${JSON.stringify(nestedCfg)}, home=${JSON.stringify(fakeHome)}, strict=True)`,
        ].join("\n"),
      ],
      { encoding: "utf8" },
    );
    expect(pyStrictCheck.status).not.toBe(0);
    expect(pyStrictCheck.stderr).toContain("PolicyConfigError");

    // 2. Git lookup failures fail closed in strict mode while ordinary non-repo and missing origin succeed
    const nonRepoDir = path.join(tmpDir, "plain-dir");
    fs.mkdirSync(nonRepoDir, { recursive: true });
    expect(() =>
      resolveRepoPolicy(nonRepoDir, {
        config: {},
        homeDir: fakeHome,
        strict: true,
      }),
    ).not.toThrow();

    expect(() =>
      resolveRepoPolicy(repo, {
        config: {},
        homeDir: fakeHome,
        strict: true,
        spawnSync: () => ({
          status: null,
          stdout: "",
          stderr: "",
          error: Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" }),
        }),
      }),
    ).toThrow(/Failed to resolve git repository root/u);

    expect(() =>
      resolveRepoPolicy(repo, {
        config: {},
        homeDir: fakeHome,
        strict: true,
        spawnSync: (_cmd, args) => {
          if (args.includes("rev-parse")) {
            return { status: 0, stdout: `${repo}\n`, stderr: "" };
          }
          return { status: 128, stdout: "", stderr: "fatal: detected dubious ownership" };
        },
      }),
    ).toThrow(/Failed to resolve git remote/u);

    // 3. setRepoPolicyDeny throws on malformed JSON without overwriting existing config, and preserves routes on valid write
    const badCfg = path.join(tmpDir, "corrupt-config.json");
    const rawCorrupt = '{"routes":{"implementation":{"engine":"codex"}}, broken';
    fs.writeFileSync(badCfg, rawCorrupt, "utf8");
    expect(() =>
      setRepoPolicyDeny(repo, ["codex"], {
        mode: "add",
        configPath: badCfg,
        homeDir: fakeHome,
        env: { HOME: fakeHome },
      }),
    ).toThrow(/Failed to parse policy JSON/u);
    expect(fs.readFileSync(badCfg, "utf8")).toBe(rawCorrupt);

    const validCfg = path.join(tmpDir, "valid-config.json");
    fs.writeFileSync(
      validCfg,
      JSON.stringify({ routes: { implementation: { engine: "codex", model: "gpt:luna" } } }),
      "utf8",
    );
    setRepoPolicyDeny(repo, ["agy"], {
      mode: "add",
      configPath: validCfg,
      homeDir: fakeHome,
      env: { HOME: fakeHome },
    });
    const savedValid = JSON.parse(fs.readFileSync(validCfg, "utf8"));
    expect(savedValid.routes.implementation.model).toBe("gpt:luna");
    expect(savedValid.repo_policies).toEqual([{ path: repo, deny: ["agy"] }]);

    // 4. Character-class glob parity: wave[z-a1] matches wave1 in both JS & Python, wave[z-a] matches neither
    const waveRepo = makeRepo(tmpDir, "wave1");
    const charClassCfg = path.join(tmpDir, "charclass.json");
    fs.writeFileSync(
      charClassCfg,
      JSON.stringify({
        repo_policies: [
          { match: "wave[z-a1]", deny: ["codex"] },
          { match: "wave[z-a]", deny: ["agy"] },
        ],
      }),
      "utf8",
    );
    const waveJs = resolveRepoPolicy(waveRepo, { configPath: charClassCfg, homeDir: fakeHome });
    const wavePy = runPythonPolicy(waveRepo, { configPath: charClassCfg, homeDir: fakeHome });
    assertParity(waveJs, wavePy);
    expect(waveJs.deny).toEqual(["codex"]);

    // 5. Python check_execution_allowed supports account_id, provider, billing_mode, strict kwargs
    const contractCheck = spawnSync(
      "python3",
      [
        "-c",
        [
          "import json, sys",
          `sys.path.insert(0, ${JSON.stringify(SCRIPTS_DIR)})`,
          "import repo_policy",
          "cfg = {'repo_policies': [{'path': " +
            JSON.stringify(repo) +
            ", 'deny': ['work-box-2', 'claude-work']}]}",
          "r1 = repo_policy.check_execution_allowed(" +
            JSON.stringify(repo) +
            ", 'codex', config=cfg, account_id='work-box-2', provider='codex', billing_mode='subscription', strict=True)",
          "r2 = repo_policy.check_execution_allowed(" +
            JSON.stringify(repo) +
            ", 'claude', config=cfg, account_id='p-acct', provider='claude', billing_mode='personal_subscription', strict=True)",
          "print(json.dumps({'r1': [r1[0], r1[1]], 'r2': [r2[0], r2[1]]}))",
        ].join("\n"),
      ],
      { encoding: "utf8" },
    );
    expect(contractCheck.status).toBe(0);
    const parsedContract = JSON.parse(contractCheck.stdout.trim());
    expect(parsedContract.r1[0]).toBe(false);
    expect(parsedContract.r1[1]).toContain("work-box-2");
    expect(parsedContract.r2[0]).toBe(true);
  });

  it("fails closed when .orkest policy dir is unreadable or non-directory, preserves config symlinks, and serializes concurrent writes", async () => {
    // 1. Unreadable .orkest directory (chmod 0o000) and non-directory .orkest (ENOTDIR) fail closed in strict mode
    const unreadableRepo = makeRepo(tmpDir, "unreadable-orkest");
    const orkestDir = path.join(unreadableRepo, ".orkest");
    fs.mkdirSync(orkestDir, { recursive: true });
    fs.writeFileSync(
      path.join(orkestDir, "policy.json"),
      JSON.stringify({ deny: ["codex"] }),
      "utf8",
    );

    if (typeof process.getuid === "function" && process.getuid() !== 0) {
      fs.chmodSync(orkestDir, 0o000);
      try {
        expect(() =>
          resolveRepoPolicy(unreadableRepo, {
            homeDir: fakeHome,
            env: { HOME: fakeHome },
            strict: true,
          }),
        ).toThrow(/Failed to read policy JSON/u);
        await expect(
          evaluateMonitorPolicy(unreadableRepo, {
            homeDir: fakeHome,
            env: { HOME: fakeHome },
          }),
        ).rejects.toThrow(/unavailable/u);
        const pyUnreadableCheck = spawnSync(
          "python3",
          [
            "-c",
            [
              "import sys",
              `sys.path.insert(0, ${JSON.stringify(SCRIPTS_DIR)})`,
              "import repo_policy",
              `repo_policy.check_execution_allowed(${JSON.stringify(unreadableRepo)}, 'codex', home=${JSON.stringify(fakeHome)}, strict=True)`,
            ].join("\n"),
          ],
          { encoding: "utf8" },
        );
        expect(pyUnreadableCheck.status).not.toBe(0);
        expect(pyUnreadableCheck.stderr).toContain("PolicyConfigError");
      } finally {
        fs.chmodSync(orkestDir, 0o755);
      }
    } else {
      const readSpy = vi.spyOn(fs, "readFileSync").mockImplementationOnce(() => {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      });
      try {
        expect(() =>
          resolveRepoPolicy(unreadableRepo, {
            homeDir: fakeHome,
            env: { HOME: fakeHome },
            strict: true,
          }),
        ).toThrow(/Failed to read policy JSON/u);
      } finally {
        readSpy.mockRestore();
      }
    }

    const fileAsDirRepo = makeRepo(tmpDir, "file-as-orkest");
    fs.writeFileSync(path.join(fileAsDirRepo, ".orkest"), "not-a-dir", "utf8");
    expect(() =>
      resolveRepoPolicy(fileAsDirRepo, {
        homeDir: fakeHome,
        env: { HOME: fakeHome },
        strict: true,
      }),
    ).toThrow(/Failed to read policy JSON/u);

    // 2. Symlinked config.json preserves the symlink and atomically updates the resolved target
    const symlinkRepo = makeRepo(tmpDir, "symlink-cfg-repo");
    const sharedDotfilesDir = path.join(tmpDir, "shared-dotfiles");
    fs.mkdirSync(sharedDotfilesDir, { recursive: true });
    const targetCfg = path.join(sharedDotfilesDir, "policy-target.json");
    fs.writeFileSync(
      targetCfg,
      JSON.stringify({ routes: { implementation: { engine: "codex" } } }),
      "utf8",
    );
    const linkCfg = path.join(tmpDir, "linked-config.json");
    fs.symlinkSync(targetCfg, linkCfg);

    const symlinkResult = setRepoPolicyDeny(symlinkRepo, ["codex"], {
      mode: "add",
      configPath: linkCfg,
      homeDir: fakeHome,
      env: { HOME: fakeHome },
    });
    expect(symlinkResult.deny).toEqual(["codex"]);
    expect(fs.lstatSync(linkCfg).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(linkCfg)).toBe(targetCfg);
    const savedTarget = JSON.parse(fs.readFileSync(targetCfg, "utf8"));
    expect(savedTarget.routes.implementation.engine).toBe("codex");
    expect(savedTarget.repo_policies).toEqual([{ path: symlinkRepo, deny: ["codex"] }]);

    // 3. Concurrent setRepoPolicyDeny edits across processes do not drop any rule
    const concurrentRepo = makeRepo(tmpDir, "concurrent-policy-repo");
    const concurrentCfg = path.join(tmpDir, "concurrent-config.json");
    fs.writeFileSync(concurrentCfg, JSON.stringify({}), "utf8");
    const targetsToAdd = [
      "codex",
      "agy",
      "opencode",
      "claude-work",
      "claude-personal",
      "custom-box",
    ];
    const policyModuleUrl = new URL("../../../src/lib/monitor/policy.mjs", import.meta.url).href;
    const workerScript = [
      `import { setRepoPolicyDeny } from ${JSON.stringify(policyModuleUrl)};`,
      "const [repo, cfg, home, target] = process.argv.slice(1);",
      'setRepoPolicyDeny(repo, [target], { mode: "add", configPath: cfg, homeDir: home, env: { HOME: home } });',
    ].join("\n");

    await Promise.all(
      targetsToAdd.map(
        (target) =>
          new Promise((resolve, reject) => {
            const child = spawn(
              process.execPath,
              [
                "--input-type=module",
                "-e",
                workerScript,
                concurrentRepo,
                concurrentCfg,
                fakeHome,
                target,
              ],
              { stdio: ["ignore", "pipe", "pipe"] },
            );
            let stderr = "";
            child.stderr.on("data", (chunk) => {
              stderr += chunk;
            });
            child.on("error", reject);
            child.on("close", (code) => {
              if (code === 0) {
                resolve();
              } else {
                reject(new Error(`worker ${target} exited ${code}: ${stderr}`));
              }
            });
          }),
      ),
    );

    const finalPolicy = resolveRepoPolicy(concurrentRepo, {
      configPath: concurrentCfg,
      homeDir: fakeHome,
      env: { HOME: fakeHome },
      strict: true,
    });
    expect(new Set(finalPolicy.deny)).toEqual(new Set(targetsToAdd));

    // 4. Slow live flock holder with >10s-old lock file is never preempted and never loses either writer's deny rule
    const slowRepo = makeRepo(tmpDir, "slow-lock-repo");
    const slowCfg = path.join(tmpDir, "slow-lock-config.json");
    const slowLock = `${slowCfg}.lock`;
    fs.writeFileSync(slowCfg, JSON.stringify({}), "utf8");
    const slowHolderScript = [
      "import fcntl, json, os, sys, time",
      "cfg_path, lock_path, repo_path = sys.argv[1:4]",
      "fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)",
      "fcntl.flock(fd, fcntl.LOCK_EX)",
      "old_ts = time.time() - 15.0",
      "os.utime(lock_path, (old_ts, old_ts))",
      String.raw`sys.stdout.write("LOCKED\n")`,
      "sys.stdout.flush()",
      "time.sleep(0.4)",
      "tmp_path = cfg_path + '.holder.tmp'",
      "with open(tmp_path, 'w', encoding='utf-8') as f:",
      "    json.dump({'repo_policies': [{'path': repo_path, 'deny': ['codex']}]}, f)",
      "    f.flush()",
      "    os.fsync(f.fileno())",
      "os.replace(tmp_path, cfg_path)",
      "os.close(fd)",
    ].join("\n");
    const holder = spawn("python3", ["-c", slowHolderScript, slowCfg, slowLock, slowRepo], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let holderStderr = "";
    holder.stderr.on("data", (chunk) => {
      holderStderr += chunk;
    });
    const holderDone = new Promise((resolve, reject) => {
      holder.on("error", reject);
      holder.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`holder exited ${code}: ${holderStderr}`));
        }
      });
    });
    await new Promise((resolve, reject) => {
      holder.on("error", reject);
      holder.stdout.on("data", (chunk) => {
        if (String(chunk).includes("LOCKED")) {
          resolve();
        }
      });
    });

    await new Promise((resolve, reject) => {
      const waiter = spawn(
        process.execPath,
        ["--input-type=module", "-e", workerScript, slowRepo, slowCfg, fakeHome, "agy"],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let waiterStderr = "";
      waiter.stderr.on("data", (chunk) => {
        waiterStderr += chunk;
      });
      waiter.on("error", reject);
      waiter.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`waiter exited ${code}: ${waiterStderr}`));
        }
      });
    });
    await holderDone;

    const slowFinalPolicy = resolveRepoPolicy(slowRepo, {
      configPath: slowCfg,
      homeDir: fakeHome,
      env: { HOME: fakeHome },
      strict: true,
    });
    expect(new Set(slowFinalPolicy.deny)).toEqual(new Set(["codex", "agy"]));
  });

  it("retains the flock-locked descriptor in the child writer after config read even if the lock wrapper is signaled", async () => {
    const repo = makeRepo(tmpDir, "lock-fd-inheritance-repo");
    const cfgPath = path.join(tmpDir, "lock-fd-inheritance.json");
    const lockPath = `${cfgPath}.lock`;
    fs.writeFileSync(cfgPath, JSON.stringify({}), "utf8");

    const pausedMarkerPath = path.join(tmpDir, "writer-paused.json");
    const resumeMarkerPath = path.join(tmpDir, "writer-resume.flag");
    const hookPath = path.join(tmpDir, "pause-after-read-hook.mjs");
    fs.writeFileSync(
      hookPath,
      [
        'import fs from "node:fs";',
        'import path from "node:path";',
        'if (process.env.ORKEST_POLICY_LOCK_HELD === "1") {',
        `  const targetCfg = ${JSON.stringify(fs.realpathSync(cfgPath))};`,
        `  const pausedPath = ${JSON.stringify(pausedMarkerPath)};`,
        `  const resumePath = ${JSON.stringify(resumeMarkerPath)};`,
        "  const origReadFileSync = fs.readFileSync.bind(fs);",
        "  let pausedOnce = false;",
        "  fs.readFileSync = (filePath, ...rest) => {",
        "    const content = origReadFileSync(filePath, ...rest);",
        '    if (!pausedOnce && typeof filePath === "string" && path.resolve(filePath) === targetCfg) {',
        "      pausedOnce = true;",
        "      const tmpMarker = `${pausedPath}.tmp`;",
        "      fs.writeFileSync(",
        "        tmpMarker,",
        "        JSON.stringify({ childPid: process.pid, wrapperPid: process.ppid }),",
        '        "utf8",',
        "      );",
        "      fs.renameSync(tmpMarker, pausedPath);",
        "      const sleepArr = new Int32Array(new SharedArrayBuffer(4));",
        "      const deadline = Date.now() + 15_000;",
        "      while (!fs.existsSync(resumePath) && Date.now() < deadline) {",
        "        Atomics.wait(sleepArr, 0, 0, 20);",
        "      }",
        "    }",
        "    return content;",
        "  };",
        "}",
      ].join("\n"),
      "utf8",
    );

    const policyModuleUrl = new URL("../../../src/lib/monitor/policy.mjs", import.meta.url).href;
    const workerScript = [
      `import { setRepoPolicyDeny } from ${JSON.stringify(policyModuleUrl)};`,
      "const [targetRepo, targetCfg, targetHome, targetDeny] = process.argv.slice(1);",
      "setRepoPolicyDeny(targetRepo, [targetDeny], {",
      '  mode: "add",',
      "  configPath: targetCfg,",
      "  homeDir: targetHome,",
      "  env: { HOME: targetHome },",
      "});",
    ].join("\n");

    const tryAcquireNonBlockingFlock = () => {
      const probe = spawnSync(
        "python3",
        [
          "-c",
          [
            "import fcntl, os, sys",
            "fd = os.open(sys.argv[1], os.O_CREAT | os.O_RDWR, 0o600)",
            "try:",
            "    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)",
            "    print('ACQUIRED')",
            "except BlockingIOError:",
            "    print('LOCKED')",
            "finally:",
            "    os.close(fd)",
          ].join("\n"),
          lockPath,
        ],
        { encoding: "utf8" },
      );
      if (probe.status !== 0) {
        throw new Error(`flock probe failed: ${probe.stderr}`);
      }
      return probe.stdout.trim();
    };

    const isPidAlive = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return error?.code !== "ESRCH";
      }
    };

    const waitForCondition = async (predicate, description, timeoutMs = 10_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate()) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`Timed out waiting for: ${description}`);
    };

    const firstWriter = spawn(
      process.execPath,
      ["--input-type=module", "-e", workerScript, repo, cfgPath, fakeHome, "codex"],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          NODE_OPTIONS: `--import=${pathToFileURL(hookPath).href}`,
        },
      },
    );
    const firstWriterDone = new Promise((resolve) => {
      firstWriter.on("close", (code, signal) => resolve({ code, signal }));
    });

    let childPid;
    let wrapperPid;
    try {
      await waitForCondition(
        () => fs.existsSync(pausedMarkerPath),
        "child writer to pause after reading config",
      );
      ({ childPid, wrapperPid } = JSON.parse(fs.readFileSync(pausedMarkerPath, "utf8")));
      expect(Number.isSafeInteger(childPid) && childPid > 0).toBe(true);
      expect(Number.isSafeInteger(wrapperPid) && wrapperPid > 0).toBe(true);

      // While wrapper and child are both alive and paused, lock cannot be acquired.
      expect(tryAcquireNonBlockingFlock()).toBe("LOCKED");

      // Simulate a lock wrapper signal terminating the Python wrapper early.
      process.kill(wrapperPid, "SIGTERM");
      await waitForCondition(() => !isPidAlive(wrapperPid), "Python lock wrapper to exit");
      const firstExit = await firstWriterDone;
      expect(firstExit.code).not.toBe(0);

      // Child writer is still alive and paused after config read, and must still hold the flock.
      expect(isPidAlive(childPid)).toBe(true);
      expect(tryAcquireNonBlockingFlock()).toBe("LOCKED");

      // Launch a second writer while the child writer is paused; it must wait on the flock.
      const secondWriter = spawn(
        process.execPath,
        ["--input-type=module", "-e", workerScript, repo, cfgPath, fakeHome, "agy"],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let secondStderr = "";
      let hasSecondExited = false;
      secondWriter.stderr.on("data", (chunk) => {
        secondStderr += chunk;
      });
      const secondWriterDone = new Promise((resolve, reject) => {
        secondWriter.on("error", reject);
        secondWriter.on("close", (code) => {
          hasSecondExited = true;
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`second writer exited ${code}: ${secondStderr}`));
          }
        });
      });

      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(hasSecondExited).toBe(false);
      expect(tryAcquireNonBlockingFlock()).toBe("LOCKED");

      // Resume the first child writer so it completes its atomic rename and exits.
      fs.writeFileSync(resumeMarkerPath, "go\n", "utf8");
      await waitForCondition(() => !isPidAlive(childPid), "child writer to finish and exit");
      await secondWriterDone;

      expect(tryAcquireNonBlockingFlock()).toBe("ACQUIRED");
      const finalPolicy = resolveRepoPolicy(repo, {
        configPath: cfgPath,
        homeDir: fakeHome,
        env: { HOME: fakeHome },
        strict: true,
      });
      expect(new Set(finalPolicy.deny)).toEqual(new Set(["codex", "agy"]));
    } finally {
      try {
        fs.writeFileSync(resumeMarkerPath, "go\n", "utf8");
      } catch {
        // Ignore cleanup write failure.
      }
      if (childPid && isPidAlive(childPid)) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch {
          // Ignore cleanup kill failure.
        }
      }
      if (wrapperPid && isPidAlive(wrapperPid)) {
        try {
          process.kill(wrapperPid, "SIGKILL");
        } catch {
          // Ignore cleanup kill failure.
        }
      }
    }
  });

  it("supports universal N-account free-form tags/aliases and dynamic profile resolution without path guessing in JS & Python", async () => {
    const repo = makeRepo(tmpDir, "n-account-repo");
    const monitorCfgDir = path.join(fakeHome, ".config", "monitor");
    fs.mkdirSync(monitorCfgDir, { recursive: true });
    const monitorCfgPath = path.join(monitorCfgDir, "config.json");

    const claudeDir1 = path.join(fakeHome, ".claude-p1");
    const claudeDir2 = path.join(fakeHome, ".claude-p2");
    const claudeWorkDir = path.join(fakeHome, ".claude-work");
    const codexWork1 = path.join(fakeHome, ".codex-work-1");
    const codexWork2 = path.join(fakeHome, ".codex-work-2");
    const agyAcme = path.join(fakeHome, ".antigravity-acme");
    const claudeUntaggedDir = path.join(fakeHome, ".claude-untagged");
    for (const dir of [
      claudeDir1,
      claudeDir2,
      claudeWorkDir,
      codexWork1,
      codexWork2,
      agyAcme,
      claudeUntaggedDir,
    ]) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const configuredAccounts = [
      {
        id: "c1",
        alias: "claude-alt",
        provider: "claude",
        label: "Claude Work-Named Personal",
        configDir: "~/.claude-p1",
        tags: ["personal"],
        billing: "subscription",
      },
      {
        id: "c2",
        alias: "claude-p2",
        provider: "claude",
        label: "Claude Personal Two",
        env: { CLAUDE_CONFIG_DIR: "~/.claude-p2" },
        billing: "personal",
      },
      {
        id: "cx-w1",
        alias: "codex-w1",
        provider: "codex",
        label: "Codex Work 1",
        env: { CODEX_HOME: "~/.codex-work-1" },
        tags: ["work"],
        billing: "subscription",
      },
      {
        id: "cx-w2",
        alias: "codex-w2",
        provider: "codex",
        label: "Codex Work 2",
        env: { CODEX_HOME: "~/.codex-work-2" },
        category: "work",
        billing: "api",
      },
      {
        id: "agy-acme",
        alias: "acme-agy",
        provider: "antigravity",
        label: "Antigravity Acme",
        env: { ANTIGRAVITY_APP_DATA_DIR: "~/.antigravity-acme" },
        tags: ["client-acme"],
        billing: "oauth",
      },
      {
        id: "c-untagged",
        provider: "claude",
        label: "Claude Personal Label But Untagged",
        configDir: "~/.claude-untagged",
        billing: "unknown",
      },
    ];
    fs.writeFileSync(monitorCfgPath, JSON.stringify({ accounts: configuredAccounts }), "utf8");

    // 1. normalizeAccountTags collects tags, category, and non-transport billing; ignores transport words and never guesses from label/id/path
    expect(normalizeAccountTags(configuredAccounts[0])).toEqual(["personal"]);
    expect(normalizeAccountTags(configuredAccounts[1])).toEqual(["personal"]);
    expect(normalizeAccountTags(configuredAccounts[3])).toEqual(["work"]);
    expect(normalizeAccountTags(configuredAccounts[4])).toEqual(["client-acme"]);
    expect(normalizeAccountTags(configuredAccounts[5])).toEqual([]);
    expect(
      normalizeAccountTags({
        id: "claude-work",
        label: "Claude Personal Work",
        configDir: "~/.claude-personal",
        billing: "oauth",
      }),
    ).toEqual([]);

    // 2. loadConfiguredAccounts & resolveConfiguredAccount resolve by id, alias, and isolated profile dirs
    const loaded = loadConfiguredAccounts({ homeDir: fakeHome, env: { HOME: fakeHome } });
    expect(loaded.map((a) => a.id)).toEqual([
      "c1",
      "c2",
      "cx-w1",
      "cx-w2",
      "agy-acme",
      "c-untagged",
    ]);
    expect(resolveConfiguredAccount("claude-alt", { homeDir: fakeHome })?.id).toBe("c1");
    expect(resolveConfiguredAccount("account:c2", { homeDir: fakeHome })?.id).toBe("c2");
    expect(
      resolveConfiguredAccount({ env: { CODEX_HOME: "~/.codex-work-2" } }, { homeDir: fakeHome })
        ?.id,
    ).toBe("cx-w2");
    expect(
      resolveConfiguredAccount(
        { env: { ANTIGRAVITY_APP_DATA_DIR: "~/.antigravity-acme" } },
        { homeDir: fakeHome },
      )?.id,
    ).toBe("agy-acme");

    // 3. Tag, alias, id, provider, and legacy claude-work/claude-personal deny matching in JS & Python
    const policyOpts = { homeDir: fakeHome, env: { HOME: fakeHome } };
    const denyCases = [
      {
        deny: ["tag:client-acme"],
        allowedIds: ["c1", "c2", "cx-w1", "cx-w2", "c-untagged"],
        deniedIds: ["agy-acme"],
        allowedStrings: ["claude", "codex", "agy", "opencode"],
        deniedStrings: [],
      },
      {
        deny: ["work"],
        allowedIds: ["c1", "c2", "agy-acme", "c-untagged"],
        deniedIds: ["cx-w1", "cx-w2"],
        allowedStrings: ["claude", "codex", "agy"],
        deniedStrings: ["claude-work", "codex:work"],
      },
      {
        deny: ["personal"],
        allowedIds: ["cx-w1", "cx-w2", "agy-acme", "c-untagged"],
        deniedIds: ["c1", "c2"],
        allowedStrings: ["claude", "claude-work"],
        deniedStrings: ["claude-personal", "claude-alt"],
      },
      {
        deny: ["account:c1", "claude-alt"],
        allowedIds: ["c2", "cx-w1", "cx-w2", "agy-acme", "c-untagged"],
        deniedIds: ["c1"],
        allowedStrings: ["claude", "claude-personal"],
        deniedStrings: ["c1", "account:c1", "claude-alt"],
      },
      {
        deny: ["claude:work", "codex:work"],
        allowedIds: ["c1", "c2", "agy-acme", "c-untagged"],
        deniedIds: ["cx-w1", "cx-w2"],
        allowedStrings: ["claude", "codex"],
        deniedStrings: ["claude-work", "codex:work"],
      },
      {
        deny: ["claude"],
        allowedIds: ["cx-w1", "cx-w2", "agy-acme"],
        deniedIds: ["c1", "c2", "c-untagged"],
        allowedStrings: ["codex", "agy", "opencode"],
        deniedStrings: ["claude", "claude-work", "claude-personal", "claude-alt"],
      },
    ];

    for (const c of denyCases) {
      const pol = {
        schema: POLICY_SCHEMA,
        deny: c.deny,
        allowed_harnesses: ["codex", "agy", "claude", "opencode"],
      };
      for (const id of c.allowedIds) {
        const acct = configuredAccounts.find((a) => a.id === id);
        expect(
          isHarnessAllowed(repo, acct, { ...policyOpts, policy: pol }),
          `${id} under ${c.deny}`,
        ).toBe(true);
        expect(isAccountAllowed(repo, acct, { ...policyOpts, policy: pol })).toBe(true);
      }
      for (const id of c.deniedIds) {
        const acct = configuredAccounts.find((a) => a.id === id);
        expect(
          isHarnessAllowed(repo, acct, { ...policyOpts, policy: pol }),
          `${id} under ${c.deny}`,
        ).toBe(false);
      }
      for (const s of c.allowedStrings) {
        expect(
          isHarnessAllowed(repo, s, { ...policyOpts, policy: pol }),
          `${s} under ${c.deny}`,
        ).toBe(true);
      }
      for (const s of c.deniedStrings) {
        expect(
          isHarnessAllowed(repo, s, { ...policyOpts, policy: pol }),
          `${s} under ${c.deny}`,
        ).toBe(false);
      }
    }

    // 4. Legacy .orkest/policy.json deny: ["claude-work"] / ["claude-personal"] works on tagged accounts without guessing from paths
    fs.mkdirSync(path.join(repo, ".orkest"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, ".orkest", "policy.json"),
      JSON.stringify({ deny: ["claude-personal"] }),
      "utf8",
    );
    const localPol = resolveRepoPolicy(repo, policyOpts);
    expect(localPol.allowed_harnesses).toEqual(["codex", "agy", "claude", "opencode"]);
    expect(isHarnessAllowed(repo, "claude", policyOpts)).toBe(true);
    expect(isHarnessAllowed(repo, "claude-personal", policyOpts)).toBe(false);
    expect(isHarnessAllowed(repo, "claude-alt", policyOpts)).toBe(false);
    expect(isHarnessAllowed(repo, configuredAccounts[0], policyOpts)).toBe(false);
    expect(isHarnessAllowed(repo, configuredAccounts[1], policyOpts)).toBe(false);
    // Path ~/.claude-personal without tags is NOT guessed as personal!
    expect(
      isHarnessAllowed(
        repo,
        { id: "path-only", provider: "claude", configDir: "~/.claude-personal" },
        policyOpts,
      ),
    ).toBe(true);

    // 5. Python parity: normalize_account_tags, load_configured_accounts, resolve_configured_account, and check_execution_allowed
    const pyCheck = spawnSync(
      "python3",
      [
        "-c",
        [
          "import json, sys",
          `sys.path.insert(0, ${JSON.stringify(SCRIPTS_DIR)})`,
          "import repo_policy",
          `home = ${JSON.stringify(fakeHome)}`,
          `repo = ${JSON.stringify(repo)}`,
          "accts = repo_policy.load_configured_accounts(home=home)",
          "res_c1 = repo_policy.resolve_configured_account('claude-alt', home=home)",
          "res_cx2 = repo_policy.resolve_configured_account({'codex_home': '~/.codex-work-2'}, home=home)",
          "res_agy = repo_policy.resolve_configured_account(agy_home='~/.antigravity-acme', home=home)",
          "p_personal = repo_policy.check_execution_allowed(repo, 'claude', account_alias='claude-alt', home=home)",
          "p_p2 = repo_policy.check_execution_allowed(repo, 'claude', claude_config_dir='~/.claude-p2', home=home)",
          "p_untagged_path = repo_policy.check_execution_allowed(repo, 'claude', claude_config_dir='~/.claude-personal', home=home)",
          "p_tag_acme = repo_policy.check_execution_allowed(repo, 'agy', agy_home='~/.antigravity-acme', config={'repo_policies': [{'path': repo, 'deny': ['tag:client-acme']}]}, home=home)",
          "p_codex_work = repo_policy.check_execution_allowed(repo, 'codex', codex_home='~/.codex-work-1', config={'repo_policies': [{'path': repo, 'deny': ['codex:work']}]}, home=home)",
          "p_acct_c1 = repo_policy.check_execution_allowed(repo, 'claude', account_id='c1', config={'repo_policies': [{'path': repo, 'deny': ['account:c1']}]}, home=home)",
          "p_untagged_ok = repo_policy.check_execution_allowed(repo, 'claude', config={'repo_policies': [{'path': repo, 'deny': ['claude-work']}]}, home=home)",
          "print(json.dumps({",
          "  'count': len(accts),",
          "  'res_c1': res_c1['id'] if res_c1 else None,",
          "  'res_cx2': res_cx2['id'] if res_cx2 else None,",
          "  'res_agy': res_agy['id'] if res_agy else None,",
          "  'p_personal': p_personal[0],",
          "  'p_p2': p_p2[0],",
          "  'p_untagged_path': p_untagged_path[0],",
          "  'p_tag_acme': p_tag_acme[0],",
          "  'p_codex_work': p_codex_work[0],",
          "  'p_acct_c1': p_acct_c1[0],",
          "  'p_untagged_ok': p_untagged_ok[0],",
          "}))",
        ].join("\n"),
      ],
      { encoding: "utf8", env: { ...process.env, HOME: fakeHome } },
    );
    expect(pyCheck.status, pyCheck.stderr).toBe(0);
    const pyOut = JSON.parse(pyCheck.stdout.trim());
    expect(pyOut).toEqual({
      count: 6,
      res_c1: "c1",
      res_cx2: "cx-w2",
      res_agy: "agy-acme",
      p_personal: false,
      p_p2: false,
      p_untagged_path: true,
      p_tag_acme: false,
      p_codex_work: false,
      p_acct_c1: false,
      p_untagged_ok: true,
    });

    // 6. Monitor MCP recommend honors tags & aliases via isLaneAllowedByPolicy
    const nowMs = Date.now();
    const futureReset = nowMs + 3_600_000;
    const mcpAccounts = [
      {
        id: "c1",
        alias: "claude-alt",
        provider: "claude",
        label: "Claude Alt Personal",
        tags: ["personal"],
        ok: true,
        fetchedAt: nowMs,
        windows: [
          {
            id: "session",
            label: "5h",
            kind: "session",
            windowMins: 300,
            remainingPct: 95,
            usedPct: 5,
            resetsAt: futureReset,
          },
        ],
        pools: [
          {
            id: "all",
            label: "Claude Alt Personal",
            families: ["claude"],
            windowIds: ["session"],
            route: "CLAUDE_CONFIG_DIR=~/.claude-p1 claude",
          },
        ],
      },
      {
        id: "c-acme",
        provider: "claude",
        label: "Claude Acme",
        tags: ["client-acme"],
        ok: true,
        fetchedAt: nowMs,
        windows: [
          {
            id: "session",
            label: "5h",
            kind: "session",
            windowMins: 300,
            remainingPct: 80,
            usedPct: 20,
            resetsAt: futureReset,
          },
        ],
        pools: [
          {
            id: "all",
            label: "Claude Acme",
            families: ["claude"],
            windowIds: ["session"],
            route: "CLAUDE_CONFIG_DIR=~/.claude-acme claude",
          },
        ],
      },
    ];
    const mcpRec = await monitorCallTool(
      "recommend",
      { cwd: repo },
      {
        getAccounts: async () => mcpAccounts,
        policyOptions: policyOpts,
      },
    );
    expect(mcpRec).toContain("Claude Acme");
    expect(mcpRec).not.toContain("Claude Alt Personal");
  });

  it("matches single-word route aliases, strict monitor config loading, implicit default account denies, and store -> MCP recommend metadata", async () => {
    const repo = makeRepo(tmpDir, "implicit-default-repo");
    const monitorCfgDir = path.join(fakeHome, ".config", "monitor");
    fs.mkdirSync(monitorCfgDir, { recursive: true });
    const monitorCfgPath = path.join(monitorCfgDir, "config.json");

    // 1. Malformed or non-array monitor/config.json fails closed under strict: true while missing config returns []
    const missingCfgPath = path.join(tmpDir, "does-not-exist-monitor.json");
    expect(loadConfiguredAccounts({ monitorConfigPath: missingCfgPath, strict: true })).toEqual([]);
    expect(() =>
      loadConfiguredAccounts({ config: { accounts: "not-an-array" }, strict: true }),
    ).toThrow(/Invalid accounts list in Monitor config: expected array/u);
    expect(loadConfiguredAccounts({ config: { accounts: { bad: true } } })).toEqual([]);
    fs.writeFileSync(monitorCfgPath, "{bad-json", "utf8");
    expect(() =>
      loadConfiguredAccounts({ homeDir: fakeHome, env: { HOME: fakeHome }, strict: true }),
    ).toThrow(/Failed to parse policy JSON/u);
    fs.writeFileSync(monitorCfgPath, JSON.stringify({ accounts: "bad" }), "utf8");
    expect(() =>
      loadConfiguredAccounts({ homeDir: fakeHome, env: { HOME: fakeHome }, strict: true }),
    ).toThrow(/Invalid accounts list in Monitor config .*config\.json: expected array/u);
    expect(
      loadConfiguredAccounts({ homeDir: fakeHome, env: { HOME: fakeHome }, strict: false }),
    ).toEqual([]);
    expect(() =>
      isHarnessAllowed(repo, "claude", {
        homeDir: fakeHome,
        env: { HOME: fakeHome },
        strict: true,
        policy: { deny: ["tag:work"] },
      }),
    ).toThrow(/Invalid accounts list in Monitor config .*config\.json: expected array/u);

    // 2. Single-word route alias parity + implicit default account resolution for tag:/account: denies
    const defaultClaudeDir = path.join(fakeHome, ".claude");
    const altClaudeDir = path.join(fakeHome, ".claude-personal");
    const defaultCodexDir = path.join(fakeHome, ".codex");
    const defaultGeminiDir = path.join(fakeHome, ".gemini");
    for (const d of [defaultClaudeDir, altClaudeDir, defaultCodexDir, defaultGeminiDir]) {
      fs.mkdirSync(d, { recursive: true });
    }

    fs.writeFileSync(
      monitorCfgPath,
      JSON.stringify({
        accounts: [
          {
            id: "c-def",
            provider: "claude",
            route: "claude-def-route",
            tags: ["work"],
          },
          {
            id: "c-alt",
            provider: "claude",
            configDir: "~/.claude-personal",
            route: "CLAUDE_CONFIG_DIR=~/.claude-personal claude",
            tags: ["personal"],
          },
          {
            id: "cx-def",
            provider: "codex",
            route: "codex",
            category: "work",
          },
          {
            id: "ag-def",
            provider: "antigravity",
            tags: ["client-acme"],
          },
        ],
      }),
      "utf8",
    );

    const opts = { homeDir: fakeHome, env: { HOME: fakeHome }, strict: true };
    // Single-word non-builtin route is resolved as an alias; builtin/multi-word routes are not
    expect(resolveConfiguredAccount("claude-def-route", opts)?.id).toBe("c-def");
    expect(
      isHarnessAllowed(repo, "claude-def-route", {
        ...opts,
        policy: { deny: ["account:claude-def-route"] },
      }),
    ).toBe(false);
    expect(
      isHarnessAllowed(repo, "cx-def", {
        ...opts,
        policy: { deny: ["account:codex"] },
      }),
    ).toBe(true);

    // Implicit default string targets ("claude", "codex", "agy") honor tag:* and account:* denies
    expect(isHarnessAllowed(repo, "claude", { ...opts, policy: { deny: ["tag:work"] } })).toBe(
      false,
    );
    expect(isHarnessAllowed(repo, "claude", { ...opts, policy: { deny: ["account:c-def"] } })).toBe(
      false,
    );
    expect(isHarnessAllowed(repo, "codex", { ...opts, policy: { deny: ["work"] } })).toBe(false);
    expect(isHarnessAllowed(repo, "agy", { ...opts, policy: { deny: ["tag:client-acme"] } })).toBe(
      false,
    );

    // Selecting an alternate CLAUDE_CONFIG_DIR resolves that profile's tags instead of default ~/.claude
    const altEnvOpts = {
      homeDir: fakeHome,
      env: { HOME: fakeHome, CLAUDE_CONFIG_DIR: "~/.claude-personal" },
      strict: true,
    };
    expect(
      isHarnessAllowed(repo, "claude", { ...altEnvOpts, policy: { deny: ["tag:work"] } }),
    ).toBe(true);
    expect(
      isHarnessAllowed(repo, "claude", { ...altEnvOpts, policy: { deny: ["tag:personal"] } }),
    ).toBe(false);

    // Strict mode fails closed on malformed monitor/config.json when policy needs account metadata
    fs.writeFileSync(monitorCfgPath, "{corrupt", "utf8");
    expect(() =>
      isHarnessAllowed(repo, "claude", { ...opts, policy: { deny: ["tag:work"] } }),
    ).toThrow(/Failed to parse policy JSON/u);

    // 3. End-to-end store.getAccounts() -> monitorCallTool("recommend") honors tag:* and account:<alias>
    const cacheDir = path.join(tmpDir, "store-mcp-cache");
    fs.mkdirSync(cacheDir, { recursive: true });
    const fakeClaudeBin = path.join(tmpDir, "fake-claude");
    fs.writeFileSync(
      fakeClaudeBin,
      '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({type:"result",is_error:false,result:"Current session: 10% used · resets Jan 1 at 1pm (UTC)"}));\n',
      "utf8",
    );
    fs.chmodSync(fakeClaudeBin, 0o755);

    const storeConfig = {
      accounts: [
        {
          id: "c-work-store",
          alias: "work-alias",
          route: "work-route",
          provider: "claude",
          label: "Work Store Claude",
          command: fakeClaudeBin,
          configDir: "~/.claude",
          tags: ["work"],
        },
        {
          id: "c-pers-store",
          alias: "pers-alias",
          provider: "claude",
          label: "Personal Store Claude",
          command: fakeClaudeBin,
          configDir: "~/.claude-personal",
          category: "personal",
        },
      ],
    };
    fs.writeFileSync(monitorCfgPath, JSON.stringify(storeConfig), "utf8");

    const prevHome = process.env.HOME;
    const prevCacheDir = process.env.MONITOR_CACHE_DIR;
    const prevMonitorCfg = process.env.MONITOR_CONFIG;
    try {
      process.env.HOME = fakeHome;
      process.env.MONITOR_CACHE_DIR = cacheDir;
      process.env.MONITOR_CONFIG = monitorCfgPath;
      const storeUrl = new URL("../../../src/lib/monitor/store.mjs?e2e-policy", import.meta.url)
        .href;
      const store = await import(storeUrl);

      fs.mkdirSync(path.join(repo, ".orkest"), { recursive: true });
      fs.writeFileSync(
        path.join(repo, ".orkest", "policy.json"),
        JSON.stringify({ deny: ["account:work-route", "tag:nonexistent"] }),
        "utf8",
      );
      const recByRouteAlias = await monitorCallTool(
        "recommend",
        { cwd: repo },
        {
          getAccounts: () => store.getAccounts({ force: true, config: storeConfig }),
          policyOptions: { homeDir: fakeHome, env: { HOME: fakeHome } },
        },
      );
      expect(recByRouteAlias).toContain("Personal Store Claude");
      expect(recByRouteAlias).not.toContain("Work Store Claude");

      fs.writeFileSync(
        path.join(repo, ".orkest", "policy.json"),
        JSON.stringify({ deny: ["tag:personal"] }),
        "utf8",
      );
      const recByTag = await monitorCallTool(
        "recommend",
        { cwd: repo },
        {
          getAccounts: () => store.getAccounts({ maxAgeSeconds: 100_000, config: storeConfig }),
          policyOptions: { homeDir: fakeHome, env: { HOME: fakeHome } },
        },
      );
      expect(recByTag).toContain("Work Store Claude");
      expect(recByTag).not.toContain("Personal Store Claude");
    } finally {
      process.env.HOME = prevHome;
      if (prevCacheDir === undefined) delete process.env.MONITOR_CACHE_DIR;
      else process.env.MONITOR_CACHE_DIR = prevCacheDir;
      if (prevMonitorCfg === undefined) delete process.env.MONITOR_CONFIG;
      else process.env.MONITOR_CONFIG = prevMonitorCfg;
    }

    // 4. Implicit process.env default-account metadata resolution (no env/homeDir/accounts/monitorConfigPath options)
    const implicitHome = path.join(tmpDir, "implicit-env-home");
    const implicitMonitorDir = path.join(implicitHome, ".config", "monitor");
    fs.mkdirSync(implicitMonitorDir, { recursive: true });
    fs.mkdirSync(path.join(implicitHome, ".codex"), { recursive: true });
    fs.mkdirSync(path.join(implicitHome, ".gemini"), { recursive: true });
    const implicitMonitorCfg = path.join(implicitMonitorDir, "config.json");
    fs.writeFileSync(
      implicitMonitorCfg,
      JSON.stringify({
        accounts: [
          { id: "cx-implicit-def", provider: "codex", tags: ["work"] },
          { id: "ag-implicit-def", provider: "antigravity", tags: ["client-beta"] },
        ],
      }),
      "utf8",
    );
    const savedHome = process.env.HOME;
    const savedMonitorCfg = process.env.MONITOR_CONFIG;
    const savedCodexHome = process.env.CODEX_HOME;
    const savedAgyAppData = process.env.ANTIGRAVITY_APP_DATA_DIR;
    const savedGeminiCliHome = process.env.GEMINI_CLI_HOME;
    try {
      process.env.HOME = implicitHome;
      delete process.env.MONITOR_CONFIG;
      delete process.env.CODEX_HOME;
      delete process.env.ANTIGRAVITY_APP_DATA_DIR;
      delete process.env.GEMINI_CLI_HOME;

      expect(isHarnessAllowed(repo, "codex", { policy: { deny: ["tag:work"] } })).toBe(false);
      expect(
        isHarnessAllowed(repo, "codex", { policy: { deny: ["account:cx-implicit-def"] } }),
      ).toBe(false);
      expect(isHarnessAllowed(repo, "codex", { policy: { deny: ["tag:personal"] } })).toBe(true);
      expect(isHarnessAllowed(repo, "agy", { policy: { deny: ["tag:client-beta"] } })).toBe(false);

      // Missing monitor/config.json under implicit process.env + strict: true still succeeds cleanly
      fs.rmSync(implicitMonitorCfg);
      expect(
        isHarnessAllowed(repo, "codex", { policy: { deny: ["tag:work"] }, strict: true }),
      ).toBe(true);
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      if (savedMonitorCfg === undefined) delete process.env.MONITOR_CONFIG;
      else process.env.MONITOR_CONFIG = savedMonitorCfg;
      if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = savedCodexHome;
      if (savedAgyAppData === undefined) delete process.env.ANTIGRAVITY_APP_DATA_DIR;
      else process.env.ANTIGRAVITY_APP_DATA_DIR = savedAgyAppData;
      if (savedGeminiCliHome === undefined) delete process.env.GEMINI_CLI_HOME;
      else process.env.GEMINI_CLI_HOME = savedGeminiCliHome;
    }
  });

  it("honors ORKEST_*_ACCOUNT_HOME, reserved route aliases, accounts: null, and ~ under env.HOME", () => {
    const repo = makeRepo(tmpDir, "astra-policy-parity");
    const claudeAcctHome = path.join(fakeHome, "acct-claude");
    const codexAcctHome = path.join(fakeHome, "acct-codex");
    const agyAcctHome = path.join(fakeHome, "acct-agy");
    const subEnvHome = path.join(tmpDir, "sub-env-home");
    const subBlueDir = path.join(subEnvHome, "blue");
    for (const d of [
      path.join(claudeAcctHome, ".claude"),
      codexAcctHome,
      agyAcctHome,
      subBlueDir,
    ]) {
      fs.mkdirSync(d, { recursive: true });
    }

    const diskCfgDir = path.join(fakeHome, ".config", "monitor");
    fs.mkdirSync(diskCfgDir, { recursive: true });
    const diskCfgPath = path.join(diskCfgDir, "config.json");
    fs.writeFileSync(
      diskCfgPath,
      JSON.stringify({
        accounts: [
          {
            id: "c-ork-home",
            provider: "claude",
            env: { HOME: claudeAcctHome },
            tags: ["work"],
          },
          {
            id: "cx-ork-home",
            provider: "codex",
            env: { CODEX_HOME: codexAcctHome },
            tags: ["client-a"],
          },
          {
            id: "ag-ork-home",
            provider: "antigravity",
            route: "gemini",
            env: { ANTIGRAVITY_APP_DATA_DIR: agyAcctHome },
            tags: ["client-b"],
          },
          {
            id: "ag-reserved-route",
            provider: "antigravity",
            route: "antigravity",
            tags: ["client-c"],
          },
          {
            id: "c-sub-tilde",
            provider: "claude",
            configDir: "~/blue",
            env: { HOME: subEnvHome },
            tags: ["sub-blue"],
          },
        ],
      }),
      "utf8",
    );

    // Astra #3: ORKEST_*_ACCOUNT_HOME resolves default account metadata for claude/codex/agy
    expect(
      isHarnessAllowed(repo, "claude", {
        homeDir: fakeHome,
        env: { HOME: fakeHome, ORKEST_CLAUDE_ACCOUNT_HOME: "~/acct-claude" },
        policy: { deny: ["tag:work"] },
      }),
    ).toBe(false);
    expect(
      isHarnessAllowed(repo, "codex", {
        homeDir: fakeHome,
        env: { HOME: fakeHome, ORKEST_CODEX_ACCOUNT_HOME: codexAcctHome },
        policy: { deny: ["tag:client-a"] },
      }),
    ).toBe(false);
    expect(
      isHarnessAllowed(repo, "agy", {
        homeDir: fakeHome,
        env: { HOME: fakeHome, ORKEST_AGY_ACCOUNT_HOME: agyAcctHome },
        policy: { deny: ["tag:client-b"] },
      }),
    ).toBe(false);

    // Astra #6-route: "gemini" and "antigravity" are reserved and never become route aliases
    expect(
      resolveConfiguredAccount("gemini", { homeDir: fakeHome, env: { HOME: fakeHome } }),
    ).toBeNull();
    expect(
      resolveConfiguredAccount("antigravity", { homeDir: fakeHome, env: { HOME: fakeHome } }),
    ).toBeNull();

    // Astra #6-JS: accounts: null in inline config fails in strict mode and returns [] without falling back to disk
    expect(() =>
      loadConfiguredAccounts({
        homeDir: fakeHome,
        env: { HOME: fakeHome },
        config: { accounts: null },
        strict: true,
      }),
    ).toThrow(/Invalid accounts list in Monitor config: expected array/u);
    expect(
      loadConfiguredAccounts({
        homeDir: fakeHome,
        env: { HOME: fakeHome },
        config: { accounts: null },
        strict: false,
      }),
    ).toEqual([]);
    // accounts: undefined still falls back to disk config as before
    expect(
      loadConfiguredAccounts({
        homeDir: fakeHome,
        env: { HOME: fakeHome },
        config: { accounts: undefined },
      }).map((a) => a.id),
    ).toContain("c-ork-home");

    // Astra #7-JS: ~/blue under env.HOME resolves to ${subEnvHome}/blue, not ${fakeHome}/blue
    expect(
      resolveConfiguredAccount(
        { provider: "claude", claudeConfigDir: subBlueDir },
        { homeDir: fakeHome, env: { HOME: fakeHome } },
      )?.id,
    ).toBe("c-sub-tilde");
    expect(
      resolveConfiguredAccount(
        { provider: "claude", claudeConfigDir: path.join(fakeHome, "blue") },
        { homeDir: fakeHome, env: { HOME: fakeHome } },
      ),
    ).toBeNull();
  });

  it("prioritizes explicit options, ORKEST_*_ACCOUNT_HOME, and ORKEST_PINNED_*_ACCOUNT over stale inherited env", () => {
    const repo = makeRepo(tmpDir, "account-home-precedence");
    const callerClaude = path.join(tmpDir, "caller", ".claude");
    const deniedHome = path.join(tmpDir, "denied-home");
    const deniedClaude = path.join(deniedHome, ".claude");
    const allowedClaude = path.join(tmpDir, "allowed");
    const defaultClaude = path.join(fakeHome, ".claude");

    const staleCodex = path.join(tmpDir, "stale-codex");
    const deniedCodex = path.join(tmpDir, "denied-codex");
    const defaultCodex = path.join(fakeHome, ".codex");

    const staleAgy = path.join(tmpDir, "stale-agy");
    const deniedAgy = path.join(tmpDir, "denied-agy");
    const defaultAgy = path.join(fakeHome, ".gemini");

    for (const d of [
      callerClaude,
      deniedClaude,
      allowedClaude,
      defaultClaude,
      staleCodex,
      deniedCodex,
      defaultCodex,
      staleAgy,
      deniedAgy,
      defaultAgy,
    ]) {
      fs.mkdirSync(d, { recursive: true });
    }

    const accounts = [
      { id: "c-caller", provider: "claude", configDir: callerClaude, tags: ["caller"] },
      { id: "c-denied", provider: "claude", env: { HOME: deniedHome }, tags: ["denied-acct"] },
      { id: "c-allowed", provider: "claude", configDir: allowedClaude, tags: ["allowed"] },
      { id: "c-default", provider: "claude", configDir: "~/.claude", tags: ["pinned-default"] },
      { id: "cx-stale", provider: "codex", codexHome: staleCodex, tags: ["stale"] },
      { id: "cx-denied", provider: "codex", codexHome: deniedCodex, tags: ["denied-acct"] },
      { id: "cx-default", provider: "codex", codexHome: "~/.codex", tags: ["pinned-default"] },
      { id: "ag-stale", provider: "antigravity", agyHome: staleAgy, tags: ["stale"] },
      { id: "ag-denied", provider: "antigravity", agyHome: deniedAgy, tags: ["denied-acct"] },
      { id: "ag-default", provider: "antigravity", agyHome: "~/.gemini", tags: ["pinned-default"] },
    ];

    // ORKEST_CLAUDE_ACCOUNT_HOME beats stale CLAUDE_CONFIG_DIR; explicit options.claudeConfigDir beats both
    const claudeEnv = {
      HOME: fakeHome,
      ORKEST_CLAUDE_ACCOUNT_HOME: deniedHome,
      CLAUDE_CONFIG_DIR: callerClaude,
    };
    expect(
      isHarnessAllowed(repo, "claude", {
        homeDir: fakeHome,
        env: claudeEnv,
        accounts,
        policy: { deny: ["tag:denied-acct"] },
      }),
    ).toBe(false);
    expect(
      isHarnessAllowed(repo, "claude", {
        homeDir: fakeHome,
        env: claudeEnv,
        claudeConfigDir: allowedClaude,
        accounts,
        policy: { deny: ["tag:denied-acct"] },
      }),
    ).toBe(true);

    // ORKEST_PINNED_*_ACCOUNT="1" resets to ~/.claude, ~/.codex, ~/.gemini ignoring stale inherited env
    expect(
      isHarnessAllowed(repo, "claude", {
        homeDir: fakeHome,
        env: { HOME: fakeHome, ORKEST_PINNED_CLAUDE_ACCOUNT: "1", CLAUDE_CONFIG_DIR: callerClaude },
        accounts,
        policy: { deny: ["tag:pinned-default"] },
      }),
    ).toBe(false);
    expect(
      isHarnessAllowed(repo, "claude", {
        homeDir: fakeHome,
        env: { HOME: fakeHome, ORKEST_PINNED_CLAUDE_ACCOUNT: "1", CLAUDE_CONFIG_DIR: callerClaude },
        accounts,
        policy: { deny: ["tag:caller"] },
      }),
    ).toBe(true);

    expect(
      isHarnessAllowed(repo, "codex", {
        homeDir: fakeHome,
        env: { HOME: fakeHome, ORKEST_PINNED_CODEX_ACCOUNT: "1", CODEX_HOME: staleCodex },
        accounts,
        policy: { deny: ["tag:pinned-default"] },
      }),
    ).toBe(false);
    expect(
      isHarnessAllowed(repo, "codex", {
        homeDir: fakeHome,
        env: { HOME: fakeHome, ORKEST_PINNED_CODEX_ACCOUNT: "1", CODEX_HOME: staleCodex },
        accounts,
        policy: { deny: ["tag:stale"] },
      }),
    ).toBe(true);

    expect(
      isHarnessAllowed(repo, "agy", {
        homeDir: fakeHome,
        env: {
          HOME: fakeHome,
          ORKEST_PINNED_AGY_ACCOUNT: "1",
          ANTIGRAVITY_APP_DATA_DIR: staleAgy,
          GEMINI_CLI_HOME: staleAgy,
        },
        accounts,
        policy: { deny: ["tag:pinned-default"] },
      }),
    ).toBe(false);
    expect(
      isHarnessAllowed(repo, "agy", {
        homeDir: fakeHome,
        env: {
          HOME: fakeHome,
          ORKEST_PINNED_AGY_ACCOUNT: "1",
          ANTIGRAVITY_APP_DATA_DIR: staleAgy,
          GEMINI_CLI_HOME: staleAgy,
        },
        accounts,
        policy: { deny: ["tag:stale"] },
      }),
    ).toBe(true);
    expect(
      isHarnessAllowed(repo, "agy", {
        homeDir: fakeHome,
        env: { HOME: fakeHome, ORKEST_AGY_ACCOUNT_HOME: deniedAgy },
        agyAppDataDir: staleAgy,
        accounts,
        policy: { deny: ["tag:denied-acct"] },
      }),
    ).toBe(true);

    // P1: named AGY profile (~/.gemini/antigravity-green) listed before default must never hijack ~/.gemini
    const greenProfileDir = path.join(defaultAgy, "antigravity-green");
    fs.mkdirSync(greenProfileDir, { recursive: true });
    const agyPrecedenceAccounts = [
      {
        id: "green",
        provider: "antigravity",
        agyHome: "~/.gemini/antigravity-green",
        tags: ["allowed"],
      },
      {
        id: "default",
        provider: "antigravity",
        agyHome: "~/.gemini",
      },
    ];
    expect(
      isHarnessAllowed(repo, "agy", {
        homeDir: fakeHome,
        env: { HOME: fakeHome, ORKEST_PINNED_AGY_ACCOUNT: "1" },
        accounts: agyPrecedenceAccounts,
        policy: { deny: ["account:default"] },
      }),
    ).toBe(false);
    expect(
      resolveConfiguredAccount("~/.gemini", {
        homeDir: fakeHome,
        accounts: [agyPrecedenceAccounts[0]],
      }),
    ).toBeNull();

    // Shared GEMINI_CLI_HOME=~/.gemini + ANTIGRAVITY_APP_DATA_DIR=~/.gemini/antigravity-green
    const sharedGeminiGreen = {
      id: "green-shared-gemini",
      provider: "antigravity",
      env: {
        GEMINI_CLI_HOME: "~/.gemini",
        ANTIGRAVITY_APP_DATA_DIR: "~/.gemini/antigravity-green",
      },
      tags: ["allowed"],
    };
    expect(
      isHarnessAllowed(repo, "agy", {
        homeDir: fakeHome,
        env: { HOME: fakeHome, ORKEST_PINNED_AGY_ACCOUNT: "1" },
        accounts: [sharedGeminiGreen, agyPrecedenceAccounts[1]],
        policy: { deny: ["account:default"] },
      }),
    ).toBe(false);
    expect(
      resolveConfiguredAccount("~/.gemini", {
        homeDir: fakeHome,
        accounts: [sharedGeminiGreen],
      }),
    ).toBeNull();

    // ANTIGRAVITY_APP_DATA_DIR=/shared preserves agyAppDataDir rather than collapsing into agyHome
    const sharedDir = path.join(tmpDir, "shared-agy");
    fs.mkdirSync(sharedDir, { recursive: true });
    const sharedAppAcct = {
      id: "shared-app",
      provider: "antigravity",
      env: { ANTIGRAVITY_APP_DATA_DIR: sharedDir },
    };
    const sharedCliAcct = {
      id: "shared-cli",
      provider: "antigravity",
      env: { GEMINI_CLI_HOME: sharedDir },
    };
    for (const ordered of [
      [sharedAppAcct, sharedCliAcct],
      [sharedCliAcct, sharedAppAcct],
    ]) {
      expect(
        isHarnessAllowed(repo, "agy", {
          homeDir: fakeHome,
          env: { HOME: fakeHome, ANTIGRAVITY_APP_DATA_DIR: sharedDir },
          accounts: ordered,
          policy: { deny: ["account:shared-app"] },
        }),
      ).toBe(false);
    }

    // Typed GEMINI_CLI_HOME=/profiles/antigravity-team appends /antigravity-cli (never infers antigravity-* basename)
    const profilesDir = path.join(tmpDir, "profiles");
    const teamCliHome = path.join(profilesDir, "antigravity-team");
    const teamAppDir = path.join(teamCliHome, "antigravity-cli");
    fs.mkdirSync(teamAppDir, { recursive: true });
    const parentAcct = {
      id: "parent",
      provider: "antigravity",
      agyHome: profilesDir,
    };
    const teamAppAcct = {
      id: "team_app",
      provider: "antigravity",
      env: { ANTIGRAVITY_APP_DATA_DIR: teamAppDir },
    };
    for (const ordered of [
      [parentAcct, teamAppAcct],
      [teamAppAcct, parentAcct],
    ]) {
      expect(
        isHarnessAllowed(repo, "agy", {
          homeDir: fakeHome,
          env: { HOME: fakeHome, GEMINI_CLI_HOME: teamCliHome },
          accounts: ordered,
          policy: { deny: ["account:team_app"] },
        }),
      ).toBe(false);
    }

    // Top-level config.env merges into each account's env (account overrides global; "" ignored, null deletes)
    const globalEnvCfg = {
      env: { GEMINI_CLI_HOME: teamCliHome },
      accounts: [{ id: "team", provider: "antigravity" }],
    };
    expect(
      isHarnessAllowed(repo, "agy", {
        homeDir: fakeHome,
        env: { HOME: fakeHome, GEMINI_CLI_HOME: teamCliHome },
        config: globalEnvCfg,
        policy: { deny: ["account:team"] },
      }),
    ).toBe(false);

    expect(
      isHarnessAllowed(repo, "agy", {
        homeDir: fakeHome,
        env: { HOME: fakeHome, GEMINI_CLI_HOME: teamCliHome },
        config: {
          env: { GEMINI_CLI_HOME: `  ${teamCliHome}  ` },
          accounts: [{ id: "team", provider: "antigravity", env: { GEMINI_CLI_HOME: "" } }],
        },
        policy: { deny: ["account:team"] },
      }),
    ).toBe(false);

    expect(
      isHarnessAllowed(repo, "agy", {
        homeDir: fakeHome,
        env: { HOME: fakeHome, ORKEST_PINNED_AGY_ACCOUNT: "1" },
        config: {
          env: { GEMINI_CLI_HOME: teamCliHome },
          accounts: [{ id: "team", provider: "antigravity", env: { GEMINI_CLI_HOME: null } }],
        },
        policy: { deny: ["account:team"] },
      }),
    ).toBe(false);

    // Claude dir precedence: claudeConfigDir > claude_config_dir > configDir > CLAUDE_CONFIG_DIR
    const legacyDir = path.join(tmpDir, "claude-legacy");
    const camelDir = path.join(tmpDir, "claude-camel");
    const snakeDir = path.join(tmpDir, "claude-snake");
    for (const d of [legacyDir, camelDir, snakeDir]) {
      fs.mkdirSync(d, { recursive: true });
    }
    expect(
      isHarnessAllowed(repo, "claude", {
        homeDir: fakeHome,
        env: { HOME: fakeHome, CLAUDE_CONFIG_DIR: camelDir },
        accounts: [
          {
            id: "team",
            provider: "claude",
            configDir: legacyDir,
            claudeConfigDir: camelDir,
            claude_config_dir: snakeDir,
          },
        ],
        policy: { deny: ["account:team"] },
      }),
    ).toBe(false);
  });
});
