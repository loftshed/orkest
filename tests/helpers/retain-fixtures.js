import { rm } from "node:fs/promises";

/** Retain scratch evidence locally; CI may explicitly opt into fixture cleanup. */
export async function retainFixtures(directories) {
  if (process.env.ORKEST_TEST_CLEANUP !== "1") return;
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
}
