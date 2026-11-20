import { readFileSync } from "node:fs";

import { openRooms } from "../lib/horde-room.mjs";
import { exportMailboxLegacy } from "../lib/mailbox-export.mjs";
import {
  auditMailbox,
  ensureMailbox,
  mailboxActive,
  openMailboxSnapshot,
} from "../lib/mailbox-migration.mjs";
import { mailboxProjection } from "../lib/mailbox-projection.mjs";
import { changeRecord } from "../lib/mailbox-records.mjs";

try {
  const [op, root] = process.argv.slice(2);
  if (!root) throw new Error("mailbox_root_required");
  const req = JSON.parse(readFileSync(0, "utf8"));
  let result;
  switch (op) {
    case "ensure": {
      result = ensureMailbox(root);
      break;
    }
    case "migrate": {
      if (req.quiesced !== true) throw new Error("quiescence_confirmation_required");
      result = ensureMailbox(root, { quiesced: true });

      break;
    }
    case "export": {
      result = exportMailboxLegacy(root, req.destination);
      break;
    }
    case "status": {
      result = auditMailbox(root);
      break;
    }
    default: {
      if (!mailboxActive(root)) throw new Error("mailbox_not_activated");
      if (op === "put" || op === "delete") {
        openMailboxSnapshot(root).close();
        using db = openRooms(root);
        result = changeRecord(db, op, req);
      } else result = mailboxProjection(root, op, req);
    }
  }
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  process.stderr.write(error.message);
  process.exitCode = 1;
}
