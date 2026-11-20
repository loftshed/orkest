#!/usr/bin/env node
// Checks what still matters for a repository of skills and commands, and reports every
// problem in one run: skill frontmatter and description budget, that ${CLAUDE_SKILL_DIR}
// paths and the files a command names point at real files, that no retired Claude Code
// plugin manifest or ${CLAUDE_PLUGIN_ROOT} reference has come back, and the Orca manifest.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(import.meta.dirname, "..");

// Claude Code cuts a skill's description plus when_to_use at this length in the
// listing the model chooses skills from, so anything past it is never seen.
export const DESCRIPTION_BUDGET_CHARS = 1536;

const SEMVER = /^\d+\.\d+\.\d+(?:-[\w.]+)?$/u;
const TEXT_EXTENSIONS = new Set([".json", ".md", ".mjs", ".js", ".py", ".sh"]);

function readJson(filePath, context) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    context.errors.push(
      `${relative(context, filePath)}: ${error.code === "ENOENT" ? "missing" : error.message}`,
    );
    return null;
  }
}

function relative(context, filePath) {
  return path.relative(context.root, filePath);
}

function listDirectories(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .toSorted((left, right) => left.localeCompare(right));
}

function listFiles(directory) {
  const files = [];
  const entries = fs.readdirSync(directory, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const filePath = path.join(entry.parentPath, entry.name);
    if (filePath.includes(`${path.sep}node_modules${path.sep}`)) continue;
    files.push(filePath);
  }
  return files;
}

/** Top-level `key: value` pairs of a Markdown file's YAML frontmatter, plus `metadata.version`. */
export function parseFrontmatter(text) {
  const lines = text.split(/\r?\n/u);
  if (lines[0]?.trimEnd() !== "---") return { error: "missing frontmatter", fields: {} };
  const end = lines.indexOf("---", 1);
  if (end === -1) return { error: "unterminated frontmatter", fields: {} };

  const fields = {};
  let section = "";
  for (const line of lines.slice(1, end)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = /^(\s*)([\w-]+):\s*(.*)$/u.exec(line);
    if (!match) continue;
    const [, indent, key, rawValue] = match;
    const value = rawValue.replace(/^(["'])(.*)\1$/u, "$2");
    if (indent) {
      if (section === "metadata" && key === "version") fields["metadata.version"] = value;
      continue;
    }
    section = key;
    fields[key] = value;
  }
  return { error: null, fields };
}

function checkSkill(skillDirectory, context) {
  const { errors } = context;
  const skillFile = path.join(skillDirectory, "SKILL.md");
  if (!fs.existsSync(skillFile)) {
    errors.push(`${relative(context, skillDirectory)}: missing SKILL.md`);
    return {};
  }
  const { error, fields } = parseFrontmatter(fs.readFileSync(skillFile, "utf8"));
  const label = relative(context, skillFile);
  if (error) {
    errors.push(`${label}: ${error}`);
    return {};
  }
  const expected = path.basename(skillDirectory);
  if (fields.name !== expected) errors.push(`${label}: name should be ${expected}`);
  if (!fields.description) errors.push(`${label}: missing description`);
  const budget = (fields.description ?? "").length + (fields.when_to_use ?? "").length;
  if (budget > DESCRIPTION_BUDGET_CHARS) {
    errors.push(
      `${label}: description is ${budget} chars; the budget is ${DESCRIPTION_BUDGET_CHARS}`,
    );
  }
  return fields;
}

function checkPathReferences(pluginDirectory, context) {
  const skillPattern = /\$\{CLAUDE_SKILL_DIR\}\/([\w./-]+)/gu;
  // A repo-relative path a command names in backticks, e.g. `src/lib/x.mjs`.
  const commandPattern = /`((?:adapters|plugins|skills|src|crates|scripts|docs)\/[\w./-]+)`/gu;
  const retired = /\$\{CLAUDE_PLUGIN_ROOT[}:]/u;
  for (const filePath of listFiles(pluginDirectory)) {
    if (!TEXT_EXTENSIONS.has(path.extname(filePath))) continue;
    const text = fs.readFileSync(filePath, "utf8");
    const [top, skill] = path.relative(pluginDirectory, filePath).split(path.sep);
    if (retired.test(text) && !filePath.endsWith("CHANGELOG.md")) {
      context.errors.push(
        `${relative(context, filePath)}: \${CLAUDE_PLUGIN_ROOT} is retired; call \`ork\` or \`monitor\``,
      );
    }
    if (top === "skills" && skill) {
      const base = path.join(pluginDirectory, "skills", skill);
      for (const [, reference] of text.matchAll(skillPattern)) {
        const target = reference.replace(/[.,]+$/u, "");
        if (!fs.existsSync(path.join(base, target))) {
          context.errors.push(
            `${relative(context, filePath)}: \${CLAUDE_SKILL_DIR}/${target} does not exist`,
          );
        }
      }
    }
    if (top === "commands" || (top === "claude" && skill === "commands")) {
      for (const [, reference] of text.matchAll(commandPattern)) {
        const target = reference.replace(/[.,]+$/u, "");
        if (!fs.existsSync(path.join(context.root, target))) {
          context.errors.push(`${relative(context, filePath)}: ${target} does not exist`);
        }
      }
    }
  }
}

// The Orca IDE plugin at the repository root: the host API methods it calls need this release.
export const ORCA_MIN_ENGINE = [1, 4, 259];

function compareVersions(left, right) {
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

/** Problems with `orca-plugin.json` against the rules Orkest relies on; [] when it is absent. */
export function checkOrcaManifest(root = REPO_ROOT) {
  const file = path.join(root, "orca-plugin.json");
  if (!fs.existsSync(file)) return [];
  const errors = [];
  const context = { errors, root };
  const manifest = readJson(file, context);
  if (!manifest) return errors;
  const label = "orca-plugin.json";
  if (manifest.manifestVersion !== 2) errors.push(`${label}: manifestVersion must be 2`);
  if (manifest.execution !== "trusted-worker")
    errors.push(`${label}: execution must be trusted-worker`);
  if ("publisher" in manifest)
    errors.push(`${label}: leave out publisher; Orca derives it from the repository owner`);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(manifest.id ?? "") || manifest.id.startsWith("orca-"))
    errors.push(`${label}: id must be kebab-case and must not start with orca-`);
  if (!SEMVER.test(manifest.version ?? "")) errors.push(`${label}: version is not semver`);
  const engine = /^>=(\d+)\.(\d+)\.(\d+)$/u.exec(manifest.engines?.orca ?? "");
  if (!engine || compareVersions(engine.slice(1).map(Number), ORCA_MIN_ENGINE) < 0)
    errors.push(`${label}: engines.orca must be >=${ORCA_MIN_ENGINE.join(".")} or newer`);
  if (!manifest.main || !fs.existsSync(path.join(root, manifest.main)))
    errors.push(`${label}: main ${manifest.main ?? "(missing)"} does not exist`);
  const contributes = manifest.contributes ?? {};
  if ((contributes.hooks ?? []).length > 0)
    errors.push(`${label}: hooks must stay empty; they run synchronously on every action`);
  const commands = new Set((contributes.commands ?? []).map((command) => command.id));
  for (const { command } of [
    ...(contributes.keybindings ?? []),
    ...(contributes.statusBarItems ?? []).filter((item) => item.command),
  ]) {
    if (!commands.has(command)) errors.push(`${label}: ${command} is not a contributed command`);
  }
  return errors;
}

export function validate(root = REPO_ROOT) {
  const errors = [];
  const context = { errors, root };
  // Orkest installs through install.sh; a Claude Code plugin manifest or marketplace must not return.
  const pluginsRoot = path.join(root, "plugins");
  const retired = [".claude-plugin"];
  for (const name of listDirectories(pluginsRoot)) {
    retired.push(`plugins/${name}/.claude-plugin`, `plugins/${name}/.mcp.json`);
  }
  for (const manifest of retired) {
    if (fs.existsSync(path.join(root, manifest))) {
      errors.push(`${manifest}: Orkest is not a Claude Code plugin any more; remove it`);
    }
  }
  for (const name of listDirectories(pluginsRoot)) {
    const pluginDirectory = path.join(pluginsRoot, name);
    const pluginSkills = listDirectories(path.join(pluginDirectory, "skills"));
    for (const skill of pluginSkills) {
      checkSkill(path.join(pluginDirectory, "skills", skill), context);
    }
    checkPathReferences(pluginDirectory, context);
  }
  const adapters = path.join(root, "adapters");
  if (fs.existsSync(adapters)) {
    const adapterSkills = listDirectories(path.join(adapters, "skills"));
    for (const skill of adapterSkills) {
      checkSkill(path.join(adapters, "skills", skill), context);
    }
    checkPathReferences(adapters, context);
  }
  errors.push(...checkOrcaManifest(root));

  const looseSkills = listDirectories(path.join(root, "skills"));
  for (const skill of looseSkills) {
    checkSkill(path.join(root, "skills", skill), context);
  }
  return errors;
}

function main() {
  const errors = validate();
  if (errors.length > 0) {
    console.error("validation failed:");
    for (const error of errors) console.error(`  - ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log("validation ok.");
}

// Compare real paths: the script may be started through a symlink.
if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) main();
