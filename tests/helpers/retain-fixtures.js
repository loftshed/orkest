import { randomUUID } from "node:crypto";
import { renameSync } from "node:fs";
import { rm } from "node:fs/promises";

/** Retain scratch evidence locally; CI may explicitly opt into fixture cleanup. */
export async function retainFixtures(directories) {
  if (process.env.ORKEST_TEST_CLEANUP !== "1") return;
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
