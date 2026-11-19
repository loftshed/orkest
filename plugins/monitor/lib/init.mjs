import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { resolveBinary } from "./exec.mjs";

const has = (name) => {
  try {
    resolveBinary(name);
    return true;
  } catch {
    return false;
  }
};

const titleCase = (s) =>
  s.replaceAll(/(^|[-_ ])(\w)/g, (_, sep, c) => (sep ? " " : "") + c.toUpperCase());

const CLAUDE_MARKERS = [".claude.json", "projects"];
const CODEX_MARKERS = ["auth.json", "config.toml", "sessions", "history.jsonl"];
const AGY_MARKERS = [
  "antigravity-oauth-token",
  "antigravity",
  "antigravity-cli",
  "settings.json",
  "User",
  path.join("antigravity-cli", "antigravity-oauth-token"),
];

function discoverProfileNames(home, prefix, markers) {
  if (!existsSync(home)) {
    return [];
  }
  const pattern = new RegExp(String.raw`^\.${prefix}-([\w-]+)$`);
  return readdirSync(home, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({ dir: d.name, match: pattern.exec(d.name) }))
    .filter(({ dir, match }) => match && markers.some((m) => existsSync(path.join(home, dir, m))))
    .map(({ match }) => match[1])
    .toSorted((a, b) => a.localeCompare(b));
}

/**
 * Builds a starter config from what is installed on this machine: default profiles and any extra
 * `~/.claude-<name>`, `~/.codex-<name>`, and `~/.antigravity-<name>` multi-account directories.
 * Only checks that files exist; never reads credentials or guesses account categories.
 */
export function detectConfig({ home = homedir(), binaries = has, env = process.env } = {}) {
  const accounts = [];
  if (binaries("claude")) {
    const extra = discoverProfileNames(home, "claude", CLAUDE_MARKERS);
    const isMulti = extra.length > 0;
    if (existsSync(path.join(home, ".claude")) || existsSync(path.join(home, ".claude.json"))) {
      accounts.push({
        id: "claude",
        provider: "claude",
        label: isMulti ? "Claude · default" : "Claude",
        short: isMulti ? "CD" : "CL",
        route: "claude",
      });
    }
    for (const name of extra) {
      accounts.push({
        id: `claude-${name}`,
        provider: "claude",
        label: `Claude · ${titleCase(name).toLowerCase()}`,
        short: `C${name[0].toUpperCase()}`,
        configDir: `~/.claude-${name}`,
        route: `CLAUDE_CONFIG_DIR=~/.claude-${name} claude`,
      });
    }
  }
  if (binaries("codex")) {
    const extraCodex = discoverProfileNames(home, "codex", CODEX_MARKERS);
    accounts.push({
      id: "codex",
      provider: "codex",
      label: extraCodex.length > 0 ? "Codex · default" : "Codex · ChatGPT",
      short: "CX",
      route: "codex",
    });
    for (const name of extraCodex) {
      accounts.push({
        id: `codex-${name}`,
        provider: "codex",
        label: `Codex · ${titleCase(name).toLowerCase()}`,
        short: `X${name[0].toUpperCase()}`,
        env: { CODEX_HOME: `~/.codex-${name}` },
        route: `CODEX_HOME=~/.codex-${name} codex`,
      });
    }
  }
  if (binaries("agy")) {
    const extraAgy = discoverProfileNames(home, "antigravity", AGY_MARKERS);
    accounts.push({
      id: "antigravity",
      provider: "antigravity",
      label: extraAgy.length > 0 ? "Antigravity · default" : "Antigravity",
      short: "AG",
      route: "agy",
      routes: {
        gemini: "agy --model <gemini model>",
        "claude-gpt": "agy --model <claude or gpt-oss model>",
      },
    });
    for (const name of extraAgy) {
      const appDataDir = `~/.antigravity-${name}`;
      accounts.push({
        id: `antigravity-${name}`,
        provider: "antigravity",
        label: `Antigravity · ${titleCase(name).toLowerCase()}`,
        short: `A${name[0].toUpperCase()}`,
        env: { ANTIGRAVITY_APP_DATA_DIR: appDataDir },
        route: `ANTIGRAVITY_APP_DATA_DIR=${appDataDir} agy`,
        routes: {
          gemini: `ANTIGRAVITY_APP_DATA_DIR=${appDataDir} agy --model <gemini model>`,
          "claude-gpt": `ANTIGRAVITY_APP_DATA_DIR=${appDataDir} agy --model <claude or gpt-oss model>`,
        },
      });
    }
  }
  // Corporate TLS inspection: carry an extra CA bundle through to the child CLIs.
  const configEnv = env.NODE_EXTRA_CA_CERTS
    ? { NODE_EXTRA_CA_CERTS: env.NODE_EXTRA_CA_CERTS.replace(home, "~") }
    : {};
  return { maxAgeSeconds: 180, env: configEnv, accounts };
}
