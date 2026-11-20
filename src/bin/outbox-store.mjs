import { readFileSync } from "node:fs";

import { openRooms } from "../lib/horde-room.mjs";
import {
  applyCheckpoint,
  readCheckpoint,
  readCheckpointProgress,
} from "../lib/outbox-checkpoint.mjs";
import { isExportableScope } from "../lib/outbox-policy.mjs";
import { applyPage, localStream, readCursor, readPage, readView } from "../lib/outbox.mjs";

function run() {
  const [command, root] = process.argv.slice(2);
  const args = JSON.parse(readFileSync(0, "utf8"));
  if (command === "is_exportable_scope") return isExportableScope(args.scope);
  using db = openRooms(root);
  let result;
  switch (command) {
    case "local_stream": {
      result = localStream(db, args.scope);
      break;
    }
    case "read_checkpoint": {
      result = readCheckpoint(db, args);
      break;
    }
    case "read_checkpoint_progress": {
      result = readCheckpointProgress(db, args);
      break;
    }
    case "apply_checkpoint": {
      result = applyCheckpoint(db, args);
      break;
    }
    case "read_view": {
      result = readView(db, args);
      break;
    }
    case "read_page": {
      result = readPage(db, args);
      break;
    }
    case "read_cursor": {
      result = readCursor(db, args);
      break;
    }
    case "apply_page": {
      result = applyPage(db, args);
      break;
    }
    default: {
      throw new Error("unknown_command");
    }
  }
  return result;
}

try {
  process.stdout.write(JSON.stringify(run()));
} catch (error) {
  process.stderr.write(error.code ?? error.message);
  process.exitCode = 1;
}
