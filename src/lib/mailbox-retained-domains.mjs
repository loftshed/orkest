// Durable legacy inputs which remain file-backed after database promotion.
import { lstatSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";

import { copyRetained } from "./retained-files.mjs";

const directories = [
  "aliases",
  "channel-ops",
  "channels",
  "cleared",
  "consultations",
  "continuations",
  "delegations",
  "diff-marks",
  "presence-events",
  "progress",
  "swarm-briefs",
  "tasks",
  "work",
];
const files = ["chief.json", "chief.json.bak", "workboard.json"];

function directoryExists(source) {
  const stat = lstatSync(source, { throwIfNoEntry: false });
  if (stat && !stat.isDirectory()) throw new Error(`Unsupported retained directory: ${source}`);
  return Boolean(stat);
}

export function retainMailboxDomains(source, destination, identities) {
  const retain = (name) => copyRetained(source, destination, name, identities);
  let count = 0;
  for (const name of directories) {
    if (directoryExists(path.join(source, name))) count += retain(name);
  }
  for (const name of files) {
    const stat = lstatSync(path.join(source, name), { throwIfNoEntry: false });
    if (stat && !stat.isFile()) throw new Error(`Unsupported retained file: ${name}`);
    if (stat) count += retain(name);
  }
  if (
    directoryExists(path.join(source, "chief")) &&
    directoryExists(path.join(source, "chief", "missions"))
  )
    count += retain(path.join("chief", "missions"));

  // Old wake clients store delivery receipts and credential-bearing live control routes together.
  const wakes = path.join(source, "wakes");
  if (directoryExists(wakes)) {
    mkdirSync(path.join(destination, "wakes"), { mode: 0o700 });
    for (const session of readdirSync(wakes)) {
      const relative = path.join("wakes", session);
      if (!directoryExists(path.join(source, relative)))
        throw new Error("Missing retained wake session");
      mkdirSync(path.join(destination, relative), { mode: 0o700 });
      const entries = readdirSync(path.join(source, relative), { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) throw new Error(`Unsupported retained wake entry: ${entry.name}`);
        if (entry.name === "agy-control.json" || entry.name.endsWith(".lock")) continue;
        if (!/^(?:pending|agy-wake|claude-wake|[a-f0-9]+-[a-f0-9]{6})\.json$/u.test(entry.name))
          throw new Error(`Unknown wake entry: ${entry.name}`);
        count += retain(path.join(relative, entry.name));
      }
    }
  }
  return count;
}
