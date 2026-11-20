import { lstatSync, mkdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { exportLegacyChiefDeskRows } from "./chief-outbox.mjs";
import { exportLegacyFoundryStates } from "./foundry-outbox.mjs";
import { exportLegacyMailboxRows } from "./mailbox-export.mjs";
import { retainMailboxDomains } from "./mailbox-retained-domains.mjs";
import { exportRoomsV2 } from "./outbox-migration.mjs";
import { copyRetained } from "./retained-files.mjs";

export function exportLegacyRoot(root, container) {
  const source = realpathSync(root);
  const requested = path.resolve(container);
  const dest = path.join(realpathSync(path.dirname(requested)), path.basename(requested));
  if (dest === source || dest.startsWith(source + path.sep))
    throw new Error("Destination inside source");
  mkdirSync(dest, { mode: 0o700 });
  const stage = path.join(dest, "incomplete");
  const ready = path.join(dest, "ready");
  const result = exportRoomsV2(source, stage, (db, directory) => {
    const identities = new Map();
    const retain = (relative) => copyRetained(source, directory, relative, identities);
    const mailboxTable = db.tagStore
      .get`SELECT 1 FROM sqlite_schema WHERE type='table' AND name='mailbox_cutover'`;
    const isPromoted = Boolean(
      mailboxTable && db.tagStore.get`SELECT singleton FROM mailbox_cutover WHERE singleton=1`,
    );
    const mailbox = isPromoted
      ? { promoted: isPromoted, ...exportLegacyMailboxRows(db, directory, identities) }
      : { promoted: isPromoted, files: retain("peers") + retain("inbox") + retain("journal") };
    const chief = exportLegacyChiefDeskRows(db, directory);
    if (!chief.promoted) {
      const chiefDir = lstatSync(path.join(source, "chief"), { throwIfNoEntry: false });
      if (chiefDir && !chiefDir.isDirectory())
        throw new Error("Unsupported retained Chief directory");
      mkdirSync(path.join(directory, "chief"), { mode: 0o700 });
      chief.files = ["desk.jsonl", "desk", "ack-transactions"].reduce(
        (n, name) => n + retain(path.join("chief", name)),
        0,
      );
    }
    const retainedFiles = retainMailboxDomains(source, directory, identities);
    return { mailbox, chief, retainedFiles, foundry: exportLegacyFoundryStates(db, directory) };
  });
  writeFileSync(path.join(stage, "rollback.json"), JSON.stringify(result) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  renameSync(stage, ready);
  return { root: ready, ...result };
}
