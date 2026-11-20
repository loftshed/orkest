import { createProjectionCheckpoint, rebuildProjections } from "../lib/projection-recovery.mjs";

const [command, ...args] = process.argv.slice(2);
try {
  let report;
  if (command === "checkpoint" && args.length === 2)
    report = await createProjectionCheckpoint(...args);
  else if (command === "rebuild" && args.length === 4) report = await rebuildProjections(...args);
  else
    throw new Error(
      "Usage: projection-recovery.mjs checkpoint ROOT NEW_DIRECTORY | rebuild ROOT CHECKPOINT_DB TRUSTED_SHA256 NEW_DIRECTORY",
    );
  console.log(JSON.stringify(report));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
