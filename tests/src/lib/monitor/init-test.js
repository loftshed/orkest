import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";

import { detectConfig } from "../../../../src/lib/monitor/init.mjs";

const home = mkdtempSync(path.join(tmpdir(), "monitor-home-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

test("detectConfig finds the default and extra Claude profiles plus installed CLIs", () => {
  mkdirSync(path.join(home, ".claude"));
  mkdirSync(path.join(home, ".claude-personal", "projects"), { recursive: true });
  mkdirSync(path.join(home, ".claude-history-viewer"));
  writeFileSync(path.join(home, ".claude-history-viewer", "cache.json"), "{}");

  const config = detectConfig({
    home,
    binaries: () => true,
    env: { NODE_EXTRA_CA_CERTS: path.join(home, "corp.pem") },
  });
  expect(config.accounts.map((a) => [a.id, a.short, a.configDir ?? null])).toStrictEqual([
    ["claude", "CD", null],
    ["claude-personal", "CP", "~/.claude-personal"],
    ["codex", "CX", null],
    ["antigravity", "AG", null],
  ]);
  expect(config.env).toStrictEqual({ NODE_EXTRA_CA_CERTS: "~/corp.pem" });
});

test("detectConfig leaves out CLIs that are not installed", () => {
  const config = detectConfig({ home, binaries: (name) => name === "codex", env: {} });
  expect(config.accounts.map((a) => a.id)).toStrictEqual(["codex"]);
  expect(config.env).toStrictEqual({});
});

test("detectConfig discovers multi-account claude, codex, and antigravity dirs without guessing categories", () => {
  const multiHome = mkdtempSync(path.join(tmpdir(), "monitor-multi-home-"));
  try {
    mkdirSync(path.join(multiHome, ".claude"));
    mkdirSync(path.join(multiHome, ".claude-acme", "projects"), { recursive: true });
    mkdirSync(path.join(multiHome, ".claude-personal"));
    writeFileSync(path.join(multiHome, ".claude-personal", ".claude.json"), "{}");

    mkdirSync(path.join(multiHome, ".codex-work"));
    writeFileSync(path.join(multiHome, ".codex-work", "auth.json"), "{}");
    mkdirSync(path.join(multiHome, ".codex-acme"));
    writeFileSync(path.join(multiHome, ".codex-acme", "config.toml"), "");
    mkdirSync(path.join(multiHome, ".codex-unrelated"));

    mkdirSync(path.join(multiHome, ".antigravity-work"));
    writeFileSync(path.join(multiHome, ".antigravity-work", "antigravity-oauth-token"), "tok");
    mkdirSync(path.join(multiHome, ".antigravity-client"));
    writeFileSync(path.join(multiHome, ".antigravity-client", "settings.json"), "{}");
    mkdirSync(path.join(multiHome, ".antigravity-empty"));

    const config = detectConfig({ home: multiHome, binaries: () => true, env: {} });
    expect(config.accounts.map((a) => a.id)).toStrictEqual([
      "claude",
      "claude-acme",
      "claude-personal",
      "codex",
      "codex-acme",
      "codex-work",
      "antigravity",
      "antigravity-client",
      "antigravity-work",
    ]);
    for (const acct of config.accounts) {
      expect(acct.billing).toBeUndefined();
      expect(acct.category).toBeUndefined();
      expect(acct.tags).toBeUndefined();
    }
    const codexWork = config.accounts.find((a) => a.id === "codex-work");
    expect(codexWork?.env).toStrictEqual({ CODEX_HOME: "~/.codex-work" });
    expect(codexWork?.route).toBe("CODEX_HOME=~/.codex-work codex");

    const agyWork = config.accounts.find((a) => a.id === "antigravity-work");
    expect(agyWork?.env).toStrictEqual({ ANTIGRAVITY_APP_DATA_DIR: "~/.antigravity-work" });
    expect(agyWork?.route).toBe("ANTIGRAVITY_APP_DATA_DIR=~/.antigravity-work agy");
  } finally {
    rmSync(multiHome, { recursive: true, force: true });
  }
});
