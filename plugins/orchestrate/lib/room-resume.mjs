import { realpath } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";

import { listRawRoomsReadOnly, mailboxRoot } from "./horde-room.mjs";
import { resolveSessionPeer, roomOwnerSessions } from "./rooms.mjs";

async function canonical(cwd) {
  try {
    return await realpath(cwd);
  } catch {
    return path.resolve(cwd);
  }
}

/** Report historical resume rooms without migrating or modifying the store. */
export async function resumeRoomStatus({ root = mailboxRoot(), cwd } = {}) {
  const checkout = cwd && (await canonical(cwd));
  const rooms = [];
  for (const room of listRawRoomsReadOnly(root)) {
    if (!room.swarm || (room.machine && room.machine !== hostname()) || !room.cwd) continue;
    const roomCwd = await canonical(room.cwd);
    if (checkout && roomCwd !== checkout) continue;
    const owners = roomOwnerSessions(room);
    const live = [];
    for (const id of owners) {
      const peer = await resolveSessionPeer(id, root, {
        engine: room.conductor?.engine,
        cwd: roomCwd,
      });
      if (peer) live.push(peer.session);
    }
    let state = "unbound";
    if (owners.length > 0) state = "unavailable";
    if (live.length > 0) state = "live";
    if (room.closedAt || room.status === "closed") state = "closed";
    rooms.push({
      id: room.id,
      title: room.title || room.id,
      cwd: roomCwd,
      session: room.conductor?.session?.id || null,
      previousSessions: room.conductor?.previousSessions || [],
      state,
      resumeTitle: /^resume\b/iu.test(room.title || room.objective || ""),
    });
  }
  return { schema: "ork.rooms.resume-status.v1", rooms };
}
