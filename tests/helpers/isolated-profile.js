// Run each suite and its child processes with private state, including calls that rely on defaults.
import { mkdtempSync } from "node:fs";
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
delete process.env.ORCHESTRATE_HOME;
delete process.env.AGENT_EXECUTOR_HOME;

afterAll(() => retainFixtures([home]));
