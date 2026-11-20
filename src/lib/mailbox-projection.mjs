// Read active mailbox projections without initializing a database or refreshing a filesystem index.
import { mailboxActive, openMailboxSnapshot } from "./mailbox-migration.mjs";
import { getRecord, inboxOwners, listRecords } from "./mailbox-records.mjs";

export function mailboxProjection(root, op, req = {}) {
  if (!mailboxActive(root)) return;
  using db = openMailboxSnapshot(root);
  switch (op) {
    case "get": {
      return getRecord(db, req);
    }
    case "list": {
      return listRecords(db, req);
    }
    case "owners": {
      return inboxOwners(db);
    }
    default: {
      throw new Error("invalid_mailbox_projection");
    }
  }
}

export function mailboxFileMap(root, collection, owner = "") {
  const rows = mailboxProjection(root, "list", { collection, owner });
  return rows && new Map(rows.map(({ key, body }) => [key + ".json", body]));
}
