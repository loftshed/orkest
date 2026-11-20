import { auditLegacyRooms } from "../lib/horde-room.mjs";
import { exportLegacyRoot } from "../lib/outbox-export.mjs";
import { auditRooms, exportRoomsV2 } from "../lib/outbox-migration.mjs";

const [command, root, destination, ...extra] = process.argv.slice(2);
try {
  if (
    !root ||
    extra.length > 0 ||
    (command === "audit" && destination) ||
    (["export-rooms-v2", "export-v2"].includes(command) && !destination)
  )
    throw new Error("Invalid arguments");
  let result;
  switch (command) {
    case "audit": {
      result = { ...auditRooms(root), legacy: auditLegacyRooms(root) };
      break;
    }
    case "export-v2": {
      result = exportLegacyRoot(root, destination);
      break;
    }
    case "export-rooms-v2": {
      result = exportRoomsV2(root, destination);
      break;
    }
    default: {
      throw new Error(
        "Usage: outbox-migrate.mjs audit ROOT | export-rooms-v2 ROOT NEW_DIRECTORY | export-v2 ROOT NEW_CONTAINER",
      );
    }
  }
  process.stdout.write(JSON.stringify(result) + "\n");
} catch (error) {
  process.stderr.write(error.message + "\n");
  process.exitCode = 1;
}
