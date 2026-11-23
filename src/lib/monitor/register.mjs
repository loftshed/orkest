import { chmodSync, existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { childEnv, expandHome, resolveBinary, run } from "./exec.mjs";
import { editJsonSection, stripJsonc } from "./harness-files.mjs";

const NAME = "monitor";

/** A retired `monitor@…` Claude Code plugin still enabled: its cached .mcp.json serves the tools. */
function pluginEnabled(claudeDir) {
  try {
    const settings = JSON.parse(readFileSync(path.join(claudeDir, "settings.json"), "utf8"));
    return Object.entries(settings.enabledPlugins ?? {}).some(
      ([id, on]) => on && id.startsWith(`${NAME}@`),
    );
  } catch {
    return false;
  }
}

function codexPluginEnabled(home) {
  try {
    const toml = readFileSync(path.join(home, ".codex", "config.toml"), "utf8");
    return /^\[plugins\."monitor@[^"\r\n]+"\]\s*\r?\n(?:[^\][\r\n]*\r?\n)*?enabled\s*=\s*true\b/m.test(
      toml,
    );
  } catch {
    return false;
  }
}

function binary(name, override) {
  try {
    return resolveBinary(name, override);
  } catch {
    return null;
  }
}

/**
 * The agent harnesses on this machine that can call the MCP server: each Claude Code profile, then any
 * installed Codex, agy, Gemini CLI and OpenCode. CLIs with an `mcp add` command are driven through it;
 * OpenCode gets a guarded config-file edit.
 */
export function registrationPlan(
  config,
  launcher,
  { remove = false, home = homedir(), env: processEnv = process.env } = {},
) {
  const plan = [];
  // `configFile` is where the CLI keeps its MCP servers, so a step can tell an identical registration
  // from a missing one and keep the file's owner-only mode, which some CLIs drop when they rewrite it.
  const cli = (target, bin, args, env = {}, configFile = null) => {
    if (bin) plan.push({ kind: "cli", target, bin, args, env, launcher, configFile });
  };
  const file = (target, apply) => {
    plan.push({ kind: "file", target, apply });
  };

  // Every Claude Code profile gets the server at user scope. Only a profile that still has the retired
  // monitor plugin enabled is left alone, because registering again would show every tool twice;
  // `ork update` prints how to uninstall that plugin, and rerunning this then registers the server.
  const seenClaudeDirs = new Set();
  for (const account of config.accounts) {
    if (account.provider !== "claude") continue;
    const dir = account.configDir
      ? path.resolve(expandHome(account.configDir))
      : path.join(home, ".claude");
    if (seenClaudeDirs.has(dir)) continue;
    seenClaudeDirs.add(dir);
    const isDefault = dir === path.join(home, ".claude");
    const target = `Claude Code (${isDefault ? "~/.claude" : dir.replace(home, "~")})`;
    if (!remove && pluginEnabled(dir)) {
      const note = "provided by the retired monitor plugin; uninstall it, then rerun to register";
      plan.push({ kind: "file", target, note, apply: () => ({ changed: false, note }) });
      continue;
    }
    cli(
      target,
      binary("claude", account.command),
      remove
        ? ["mcp", "remove", "--scope", "user", NAME]
        : ["mcp", "add", "--scope", "user", NAME, "--", launcher, "mcp"],
      { CLAUDE_CONFIG_DIR: isDefault ? null : dir },
      { path: isDefault ? path.join(home, ".claude.json") : path.join(dir, ".claude.json") },
    );
  }
  const codexTarget = "Codex (CLI and app)";
  if (!remove && codexPluginEnabled(home)) {
    const note = "provided by the retired monitor plugin; uninstall it, then rerun to register";
    plan.push({
      kind: "file",
      target: codexTarget,
      note,
      apply: () => ({ changed: false, note }),
    });
  } else {
    cli(
      codexTarget,
      binary("codex"),
      remove ? ["mcp", "remove", NAME] : ["mcp", "add", NAME, "--", launcher, "mcp"],
      {},
      {
        path: path.join(
          processEnv.CODEX_HOME ? expandHome(processEnv.CODEX_HOME) : path.join(home, ".codex"),
          "config.toml",
        ),
        format: "toml",
      },
    );
  }
  cli(
    "Antigravity (agy)",
    binary("agy"),
    remove ? ["mcp", "remove", NAME] : ["mcp", "add", NAME, launcher, "mcp"],
    {},
    { path: path.join(home, ".gemini", "config", "mcp_config.json") },
  );
  cli(
    "Gemini CLI",
    binary("gemini"),
    remove
      ? ["mcp", "remove", "-s", "user", NAME]
      : ["mcp", "add", "-s", "user", NAME, launcher, "mcp"],
    {},
    { path: path.join(home, ".gemini", "settings.json") },
  );

  // OpenCode is one of orchestrate's execution engines, so its delegated runs can check quota too.
  const opencodeDir = path.join(home, ".config", "opencode");
  if (binary("opencode") || existsSync(opencodeDir)) {
    const jsonc = path.join(opencodeDir, "opencode.jsonc");
    const target = existsSync(jsonc) ? jsonc : path.join(opencodeDir, "opencode.json");
    file("OpenCode", () =>
      editJsonSection(
        target,
        "mcp",
        NAME,
        { type: "local", command: [launcher, "mcp"], enabled: true },
        { remove },
      ),
    );
  }
  return plan;
}

function fileStepStatus(target, result, remove) {
  if (result.manual) return `! ${target}: ${result.manual}`;
  if (!result.changed) {
    return `• ${target}: ${result.note ?? (remove ? "not present" : "already registered")}`;
  }
  return `✓ ${target}: ${remove ? "removed" : "added"}`;
}

/** Reads `[mcp_servers.<name>]` from a Codex config.toml: only the plain keys monitor uses. */
function tomlServer(text, name) {
  const lines = text.split(/\r?\n/u);
  const header = new Set([`[mcp_servers.${name}]`, `[mcp_servers."${name}"]`]);
  const start = lines.findIndex((line) => header.has(line.trim()));
  if (start === -1) return null;
  const entry = {};
  const body = lines.slice(start + 1);
  for (const line of body) {
    if (line.trimStart().startsWith("[")) break;
    const match = /^\s*([A-Za-z_][\w-]*)\s*=\s*(.+?)\s*$/u.exec(line);
    if (!match) continue;
    try {
      entry[match[1]] = JSON.parse(match[2]);
    } catch {
      entry[match[1]] = undefined;
    }
  }
  return entry;
}

function registeredEntry(configFile) {
  try {
    const text = readFileSync(configFile.path, "utf8");
    if (configFile.format === "toml") return tomlServer(text, NAME);
    return JSON.parse(stripJsonc(text))?.mcpServers?.[NAME] ?? null;
  } catch {
    return null;
  }
}

/** True when the CLI's config already runs `<launcher> mcp`, enabled, so `mcp add` would only rewrite it. */
export function isAlreadyRegistered(step) {
  if (!step.configFile) return false;
  const entry = registeredEntry(step.configFile);
  return (
    Boolean(entry) &&
    typeof entry === "object" &&
    entry.command === step.launcher &&
    Array.isArray(entry.args) &&
    entry.args.length === 1 &&
    entry.args[0] === "mcp" &&
    (entry.type === undefined || entry.type === "stdio") &&
    entry.disabled !== true &&
    entry.enabled !== false
  );
}

/** The mode of a config file that only its owner can read, which a CLI rewrite must not widen. */
function ownerOnlyMode(file) {
  try {
    const info = statSync(file);
    const mode = info.mode & 0o777;
    return info.isFile() && (mode & 0o077) === 0 ? mode : null;
  } catch {
    return null;
  }
}

function restoreMode(file, mode) {
  if (mode === null) return;
  try {
    if ((statSync(file).mode & 0o777) !== mode) chmodSync(file, mode);
  } catch {
    // The CLI removed the file; there is nothing left to protect.
  }
}

/** Runs one `mcp add` or `mcp remove` and returns its status line. */
export async function applyCliStep(step, { remove = false } = {}) {
  if (!remove && isAlreadyRegistered(step)) return `• ${step.target}: already registered`;
  // agy rewrites mcp_config.json as 0644, exposing the peer-mailbox bearer token stored beside monitor.
  const configPath = step.configFile?.path;
  const mode = configPath ? ownerOnlyMode(configPath) : null;
  const env = childEnv(step.env, { strip: [/^CLAUDE_CODE_/, "CLAUDECODE"] });
  try {
    const { code, stdout, stderr } = await run(step.bin, step.args, { env, timeoutMs: 60_000 });
    const output = `${stdout}${stderr}`
      .trim()
      .split("\n")
      .filter((l) => !/not trusted|^\s*$/i.test(l));
    const already = !remove && output.some((l) => /already exists/i.test(l));
    const absent =
      remove &&
      code !== 0 &&
      output.some((l) => /not found|no .*(server|mcp)|does not exist/i.test(l));
    let note = output[0] || `exit ${code}`;
    if (absent) note = "not registered";
    if (already) note = "already registered";
    let mark = "✗";
    if (already || absent) mark = "•";
    if (code === 0) mark = "✓";
    return `${mark} ${step.target}: ${note}`;
  } catch (error) {
    return `✗ ${step.target}: ${error.message}`;
  } finally {
    if (configPath) restoreMode(configPath, mode);
  }
}

export async function registerMcp(config, { launcher, dryRun = false, remove = false } = {}) {
  const plan = registrationPlan(config, launcher, { remove });
  for (const step of plan) {
    if (step.kind === "file") {
      if (dryRun) {
        console.log(`${step.target}: ${step.note ?? "edit its config file"}`);
        continue;
      }
      try {
        const result = step.apply();
        console.log(fileStepStatus(step.target, result, remove));
      } catch (error) {
        console.log(`✗ ${step.target}: ${error.message}`);
      }
      continue;
    }
    if (dryRun) {
      if (!remove && isAlreadyRegistered(step)) {
        console.log(`${step.target}: already registered`);
        continue;
      }
      let envPrefix = "";
      if (step.env.CLAUDE_CONFIG_DIR === null) envPrefix = "env -u CLAUDE_CONFIG_DIR ";
      if (step.env.CLAUDE_CONFIG_DIR)
        envPrefix = `CLAUDE_CONFIG_DIR=${step.env.CLAUDE_CONFIG_DIR} `;
      const shown = `${envPrefix}${step.bin} ${step.args.map((a) => (/[\s"{]/.test(a) ? `'${a}'` : a)).join(" ")}`;
      console.log(`${step.target}:\n  ${shown}`);
      continue;
    }
    console.log(await applyCliStep(step, { remove }));
  }
}
