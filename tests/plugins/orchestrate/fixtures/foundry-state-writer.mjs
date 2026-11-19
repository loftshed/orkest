import { once } from "node:events";

import { writeFoundryState } from "../../../../plugins/orchestrate/lib/foundry.mjs";

const observed = once(process, "message");
for (let generation = 1; generation <= 100; generation++) {
  writeFoundryState(process.argv[2], { generation, payload: String(generation).repeat(100_000) });
  // Keep an intermediate generation available even if the reader was slow to start.
  if (generation === 50) await observed;
}
process.disconnect();
