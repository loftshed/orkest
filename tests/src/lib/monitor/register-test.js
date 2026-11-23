import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

import {
  applyCliStep,
  isAlreadyRegistered,
  registrationPlan,
} from "../../../../src/lib/monitor/register.mjs";

const home = mkdtempSync(path.join(tmpdir(), "monitor-register-"));
const bin = path.join(home, "bin");
const originalPath = process.env.PATH;
const launcher = path.join(bin, "monitor");
const cliPaths = Object.fromEntries(
  ["claude", "codex", "agy", "gemini", "opencode"].map((name) => [name, path.join(bin, name)]),
);

beforeAll(() => {
  mkdirSync(bin);
  for (const file of [launcher, ...Object.values(cliPaths)]) {
    writeFileSync(file, "#!/bin/sh\nexit 0\n");
    chmodSync(file, 0o700);
  }
  process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`;
});

afterAll(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  rmSync(home, { recursive: true, force: true });
});

const account = (provider, extra = {}) => ({ provider, command: cliPaths.claude, ...extra });
const config = (accounts = [account("claude")]) => ({ accounts });

function stepsFor(plan, target) {
  return plan.filter((step) => step.target === target);
}

test("plans the default Claude profile with its normal keychain environment and add command", () => {
  const [step] = stepsFor(
    registrationPlan(config(), launcher, { home }),
    "Claude Code (~/.claude)",
  );

  expect(step).toMatchObject({
    kind: "cli",
    bin: cliPaths.claude,
    args: ["mcp", "add", "--scope", "user", "monitor", "--", launcher, "mcp"],
    env: { CLAUDE_CONFIG_DIR: null },
  });
});

test("plans a named Claude profile at its resolved directory", () => {
  const profile = path.join(home, ".claude-personal");
  const accounts = [account("claude", { configDir: profile })];
  const plan = registrationPlan(config(accounts), launcher, { home });
  const [step] = stepsFor(plan, "Claude Code (~/.claude-personal)");

  expect(step).toMatchObject({
    kind: "cli",
    args: ["mcp", "add", "--scope", "user", "monitor", "--", launcher, "mcp"],
    env: { CLAUDE_CONFIG_DIR: profile },
  });
});

test("a still-enabled retired monitor plugin is left alone instead of adding a duplicate Claude server", () => {
  const pluginHome = path.join(home, "plugin-case");
  const profile = path.join(pluginHome, ".claude");
  mkdirSync(profile, { recursive: true });
  writeFileSync(
    path.join(profile, "settings.json"),
    JSON.stringify({ enabledPlugins: { "monitor@marketplace": true } }),
  );

  const plan = registrationPlan(config(), launcher, { home: pluginHome });
  const steps = stepsFor(plan, "Claude Code (~/.claude)");

  expect(steps).toHaveLength(1);
  expect(steps[0]).toMatchObject({
    kind: "file",
    note: "provided by the retired monitor plugin; uninstall it, then rerun to register",
  });
  expect(steps[0].apply()).toStrictEqual({
    changed: false,
    note: "provided by the retired monitor plugin; uninstall it, then rerun to register",
  });
});

test("a still-enabled retired monitor plugin is left alone instead of adding a duplicate Codex server", () => {
  const pluginHome = path.join(home, "codex-plugin-case");
  const codexDir = path.join(pluginHome, ".codex");
  mkdirSync(codexDir, { recursive: true });
  writeFileSync(path.join(codexDir, "config.toml"), '[plugins."monitor@orkest"]\nenabled = true\n');

  const plan = registrationPlan(config(), launcher, { home: pluginHome });
  const steps = stepsFor(plan, "Codex (CLI and app)");

  expect(steps).toHaveLength(1);
  expect(steps[0]).toMatchObject({
    kind: "file",
    note: "provided by the retired monitor plugin; uninstall it, then rerun to register",
  });
  expect(steps[0].apply()).toStrictEqual({
    changed: false,
    note: "provided by the retired monitor plugin; uninstall it, then rerun to register",
  });
});

test("deduplicates Claude profiles", () => {
  const profile = path.join(home, ".claude-personal");
  const accounts = [
    account("claude", { configDir: profile }),
    account("claude", { command: "/different/claude", configDir: profile }),
  ];
  const plan = registrationPlan(config(accounts), launcher, { home });

  expect(stepsFor(plan, "Claude Code (~/.claude-personal)")).toHaveLength(1);
  expect(plan.find((step) => step.target === "Claude Code (~/.claude-personal)").bin).toBe(
    cliPaths.claude,
  );
  expect(plan.some((step) => step.target.startsWith("Claude Code"))).toBe(true);
});

test("plans add and remove commands for each installed CLI", () => {
  const add = registrationPlan(config(), launcher, { home });
  const remove = registrationPlan(config(), launcher, { home, remove: true });

  expect(stepsFor(add, "Codex (CLI and app)")[0]).toMatchObject({
    bin: cliPaths.codex,
    args: ["mcp", "add", "monitor", "--", launcher, "mcp"],
  });
  expect(stepsFor(remove, "Codex (CLI and app)")[0]).toMatchObject({
    bin: cliPaths.codex,
    args: ["mcp", "remove", "monitor"],
  });
  expect(stepsFor(add, "Antigravity (agy)")[0]).toMatchObject({
    bin: cliPaths.agy,
    args: ["mcp", "add", "monitor", launcher, "mcp"],
  });
  expect(stepsFor(remove, "Antigravity (agy)")[0]).toMatchObject({
    bin: cliPaths.agy,
    args: ["mcp", "remove", "monitor"],
  });
  expect(stepsFor(add, "Gemini CLI")[0]).toMatchObject({
    bin: cliPaths.gemini,
    args: ["mcp", "add", "-s", "user", "monitor", launcher, "mcp"],
  });
  expect(stepsFor(remove, "Gemini CLI")[0]).toMatchObject({
    bin: cliPaths.gemini,
    args: ["mcp", "remove", "-s", "user", "monitor"],
  });
  expect(stepsFor(add, "Claude Code (~/.claude)")[0].args).toStrictEqual([
    "mcp",
    "add",
    "--scope",
    "user",
    "monitor",
    "--",
    launcher,
    "mcp",
  ]);
  expect(stepsFor(remove, "Claude Code (~/.claude)")[0].args).toStrictEqual([
    "mcp",
    "remove",
    "--scope",
    "user",
    "monitor",
  ]);
});

test("plans OpenCode registration in its config file", () => {
  const opencodeDir = path.join(home, ".config", "opencode");
  mkdirSync(opencodeDir, { recursive: true });

  const plan = registrationPlan(config(), launcher, { home });
  const [step] = stepsFor(plan, "OpenCode");

  expect(step.kind).toBe("file");
  expect(step.apply()).toStrictEqual({ changed: true });
  const savedConfig = JSON.parse(readFileSync(path.join(opencodeDir, "opencode.json"), "utf8"));
  expect(savedConfig).toMatchObject({
    mcp: { monitor: { type: "local", command: [launcher, "mcp"], enabled: true } },
  });
});

test("re-registering monitor keeps an owner-only agy config owner-only and skips an identical entry", async () => {
  const agyHome = path.join(home, "agy-case");
  const configFile = path.join(agyHome, ".gemini", "config", "mcp_config.json");
  const log = path.join(agyHome, "agy-calls.log");
  mkdirSync(path.dirname(configFile), { recursive: true });
  const mailbox = {
    serverUrl: "http://127.0.0.1:49152/mcp",
    headers: { Authorization: "Bearer secret" },
  };
  writeFileSync(configFile, `${JSON.stringify({ mcpServers: { "peer-mailbox": mailbox } })}\n`);
  chmodSync(configFile, 0o600);
  // Like agy 1.5.15: rewrite the whole file, as 0644, and report "Added" even when nothing changed.
  const rewritten = JSON.stringify({
    mcpServers: { "peer-mailbox": mailbox, monitor: { command: launcher, args: ["mcp"] } },
  });
  const fakeAgy = path.join(agyHome, "agy");
  writeFileSync(
    fakeAgy,
    [
      "#!/bin/sh",
      `echo "$*" >> '${log}'`,
      String.raw`printf '%s\n' '${rewritten}' > '${configFile}'`,
      `/bin/chmod 644 '${configFile}'`,
      `echo 'Added MCP server "monitor" (stdio)'`,
      "",
    ].join("\n"),
  );
  chmodSync(fakeAgy, 0o700);
  const plan = (isRemove = false) => {
    const [step] = stepsFor(
      registrationPlan(config([]), launcher, { home: agyHome, remove: isRemove }),
      "Antigravity (agy)",
    );
    return { ...step, bin: fakeAgy };
  };
  const mode = () => statSync(configFile).mode & 0o777;
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);

  expect(isAlreadyRegistered(plan())).toBe(false);
  expect(await applyCliStep(plan())).toBe(
    '✓ Antigravity (agy): Added MCP server "monitor" (stdio)',
  );
  expect(mode()).toBe(0o600);
  expect(calls()).toHaveLength(1);

  const before = readFileSync(configFile, "utf8");
  expect(isAlreadyRegistered(plan())).toBe(true);
  expect(await applyCliStep(plan())).toBe("• Antigravity (agy): already registered");
  expect(calls()).toHaveLength(1);
  expect(readFileSync(configFile, "utf8")).toBe(before);
  expect(mode()).toBe(0o600);

  await applyCliStep(plan(true), { remove: true });
  expect(calls()).toEqual([`mcp add monitor ${launcher} mcp`, "mcp remove monitor"]);
  expect(mode()).toBe(0o600);
});

test("a config another user could already read keeps its mode, and a different launcher is re-added", async () => {
  const agyHome = path.join(home, "agy-shared-case");
  const configFile = path.join(agyHome, ".gemini", "config", "mcp_config.json");
  mkdirSync(path.dirname(configFile), { recursive: true });
  writeFileSync(
    configFile,
    JSON.stringify({ mcpServers: { monitor: { command: "/old/monitor", args: ["mcp"] } } }),
  );
  chmodSync(configFile, 0o644);
  const [step] = stepsFor(
    registrationPlan(config([]), launcher, { home: agyHome }),
    "Antigravity (agy)",
  );

  expect(isAlreadyRegistered(step)).toBe(false);
  expect(await applyCliStep(step)).toBe("✓ Antigravity (agy): exit 0");
  expect(statSync(configFile).mode & 0o777).toBe(0o644);
});

test("recognizes an identical Codex registration in config.toml, honoring CODEX_HOME", () => {
  const codexHome = path.join(home, "codex-home");
  mkdirSync(codexHome, { recursive: true });
  const toml = path.join(codexHome, "config.toml");
  const plan = () =>
    stepsFor(
      registrationPlan(config([]), launcher, { home, env: { CODEX_HOME: codexHome } }),
      "Codex (CLI and app)",
    )[0];

  writeFileSync(
    toml,
    `model = "x"\n\n[mcp_servers.monitor]\ncommand = ${JSON.stringify(launcher)}\nargs = ["mcp"]\n`,
  );
  expect(plan().configFile.path).toBe(toml);
  expect(isAlreadyRegistered(plan())).toBe(true);

  writeFileSync(
    toml,
    `[mcp_servers.monitor]\ncommand = ${JSON.stringify(launcher)}\nargs = ["mcp"]\nenabled = false\n`,
  );
  expect(isAlreadyRegistered(plan())).toBe(false);

  writeFileSync(
    toml,
    `[mcp_servers.other]\ncommand = ${JSON.stringify(launcher)}\nargs = ["mcp"]\n`,
  );
  expect(isAlreadyRegistered(plan())).toBe(false);
});
