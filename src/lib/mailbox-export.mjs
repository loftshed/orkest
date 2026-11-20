// Export the current mailbox into the JSON layout understood by pre-cutover clients.
import { mkdirSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";

import { mailboxActive, openMailboxSnapshot } from "./mailbox-migration.mjs";
import { checkRecord } from "./mailbox-records.mjs";
import { copyRetained } from "./retained-files.mjs";

/** The caller reserves the private destination and holds a consistent database snapshot. */
export function exportLegacyMailboxRows(db, destination, identities = new Map()) {
  mkdirSync(path.join(destination, "peers"), { mode: 0o700 });
  mkdirSync(path.join(destination, "inbox"), { mode: 0o700 });
  const counts = { peers: 0, messages: 0, unread: 0 };
  let previousOwner;
  const rows = db.tagStore.iterate`SELECT collection, owner, key, body, updated_ms
    FROM mailbox_records ORDER BY collection, owner, key`;
  for (const row of rows) {
    const body = JSON.parse(row.body);
    checkRecord({ ...row, body });
    let dir = path.join(destination, "peers");
    if (row.collection === "inbox") {
      dir = path.join(destination, "inbox", row.owner);
      if (row.owner !== previousOwner) mkdirSync(dir, { mode: 0o700 });
      previousOwner = row.owner;
      counts.messages++;
      if (!body.readAt) counts.unread++;
    } else counts.peers++;
    const file = path.join(dir, row.key + ".json");
    writeFileSync(file, row.body + "\n", { flag: "wx", mode: 0o600 });
    const updated = new Date(row.updated_ms);
    utimesSync(file, updated, updated);
  }
  // A legacy retry consults its sender's durable send journal before assigning a new message ID.
  copyRetained(path.dirname(db.location()), destination, "journal", identities);
  return counts;
}

export function exportMailboxLegacy(root, destination) {
  if (!mailboxActive(root)) throw new Error("mailbox_not_activated");
  if (typeof destination !== "string" || !path.isAbsolute(destination))
    throw new Error("absolute_export_destination_required");
  const dest = path.join(realpathSync(path.dirname(destination)), path.basename(destination));
  const source = realpathSync(root);
  if (dest === source || dest.startsWith(source + path.sep))
    throw new Error("export_destination_inside_source");
  using db = openMailboxSnapshot(root);
  mkdirSync(dest, { mode: 0o700 });
  const counts = exportLegacyMailboxRows(db, dest);
  db.exec("COMMIT");
  return { destination: dest, ...counts };
}
