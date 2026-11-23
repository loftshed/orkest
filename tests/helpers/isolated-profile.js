// Run each suite and its child processes with private state, including calls that rely on defaults.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

import { retainFixtures } from "./retain-fixtures.js";

const home = mkdtempSync(path.join(tmpdir(), "ork-test-home-"));
process.env.HOME = home;
process.env.XDG_CONFIG_HOME = path.join(home, ".config");
process.env.XDG_CACHE_HOME = path.join(home, ".cache");
process.env.XDG_DATA_HOME = path.join(home, ".local", "share");
process.env.XDG_STATE_HOME = path.join(home, ".local", "state");

// Drop the agent session this suite may have been started from; see agent-env.txt.
const patterns = readFileSync(new URL("agent-env.txt", import.meta.url), "utf8")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"));
const kept = new Set(patterns.filter((line) => line.startsWith("!")).map((line) => line.slice(1)));
const matches = (name, pattern) =>
  pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern;
for (const name of Object.keys(process.env)) {
  if (!kept.has(name) && patterns.some((pattern) => matches(name, pattern)))
    delete process.env[name];
}

afterAll(() => retainFixtures([home]));
