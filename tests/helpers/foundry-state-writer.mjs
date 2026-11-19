// Real writer for the concurrent-reader test. Reports phases over IPC so the parent can tell
// startup, handshake and each real writeFoundryState call apart when something stalls.
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";

import { writeFoundryState } from "../../plugins/orchestrate/lib/foundry.mjs";

const [worktree, countArg = "100", gateArg = "50", handshakeMsArg = "30000"] =
  process.argv.slice(2);
const total = Number(countArg);
const gate = Number(gateArg);
const handshakeMs = Number(handshakeMsArg);
const started = performance.now();
const report = (phase, extra = {}) =>
  process.send({
    phase,
    generation: extra.generation ?? null,
    ms: Math.round(performance.now() - started),
    ...extra,
  });

report("started");
// Listen before the first write so a reader acknowledgement is never lost.
const observed = once(process, "message");
for (let generation = 1; generation <= total; generation++) {
  report("write-begin", { generation });
  const t0 = performance.now();
  writeFoundryState(worktree, { generation, payload: String(generation).repeat(100_000) });
  report("write-end", { generation, writeMs: Math.round(performance.now() - t0) });
  if (generation !== gate) continue;
  // Keep an intermediate generation available even if the reader was slow to start.
  report("awaiting-observed", { generation });
  const outcome = await Promise.race([
    observed.then(() => "ack"), // eslint-disable-line unicorn/prefer-await -- race needs a promise, not a statement
    sleep(handshakeMs, "timeout", { ref: false }),
  ]);
  if (outcome === "timeout") {
    report("handshake-timeout", { generation });
    process.disconnect();
    process.exit(3);
  }
  report("observed-ack", { generation });
}
report("done", { generation: total });
process.disconnect();
