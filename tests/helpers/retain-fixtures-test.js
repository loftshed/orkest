import { existsSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { retainFixtures } from "./retain-fixtures.js";

const created = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of created.splice(0)) await rm(dir, { recursive: true, force: true });
});

it("deletes temporary fixtures by default and keeps them when ORKEST_TEST_RETAIN=1", async () => {
  const removed = mkdtempSync(path.join(tmpdir(), "ork-retain-default-"));
  created.push(removed);
  vi.stubEnv("ORKEST_TEST_RETAIN", "");
  vi.stubEnv("ORKEST_TEST_CLEANUP", "");
  await retainFixtures([removed]);
  expect(existsSync(removed)).toBe(false);

  const kept = mkdtempSync(path.join(tmpdir(), "ork-retain-keep-"));
  created.push(kept);
  vi.stubEnv("ORKEST_TEST_RETAIN", "1");
  await retainFixtures([kept]);
  expect(existsSync(kept)).toBe(true);

  vi.stubEnv("ORKEST_TEST_CLEANUP", "1");
  await retainFixtures([kept]);
  expect(existsSync(kept)).toBe(false);
});
