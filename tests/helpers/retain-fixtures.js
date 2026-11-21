import { randomUUID } from "node:crypto";
import { renameSync } from "node:fs";
import { rm } from "node:fs/promises";

/** Delete scratch fixtures by default; keep them only when ORKEST_TEST_RETAIN=1. */
export async function retainFixtures(directories) {
  if (process.env.ORKEST_TEST_RETAIN === "1" && process.env.ORKEST_TEST_CLEANUP !== "1") return;
  if (process.env.ORKEST_TEST_CLEANUP === "0") return;
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
}

/** Vacate a fixture name for the next case while retaining its original entry beside it. */
export function moveFixtureAside(file) {
  try {
    renameSync(file, `${file}.retained-${randomUUID()}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
