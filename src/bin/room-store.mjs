#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { deleteRoom, listRawRooms, readRawRoom, updateRawRoom } from "../lib/horde-room.mjs";
import { rebindSession } from "../lib/rooms.mjs";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { root: { type: "string" } },
});
const [command, id] = positionals;
if (!values.root) throw new Error("--root is required");
const root = values.root;

function payload() {
  return JSON.parse(readFileSync(0, "utf8"));
}

async function put(room) {
  for (let attempt = 0; attempt < 16; attempt++) {
    try {
      return await updateRawRoom(id, () => room, { root });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    try {
      return await updateRawRoom(id, () => room, { root, create: true });
    } catch (error) {
      if (error.message !== `Room already exists: ${id}`) throw error;
    }
  }
  throw new Error(`Room put exceeded concurrent retries: ${id}`);
}

async function run() {
  switch (command) {
    case "list": {
      return listRawRooms(root);
    }
    case "get": {
      return readRawRoom(id, root);
    }
    case "put": {
      return put(payload());
    }
    case "set-meta": {
      const fields = payload();
      if (!fields || typeof fields !== "object" || Array.isArray(fields))
        throw new Error("Metadata must be an object");
      return updateRawRoom(
        id,
        (room) => {
          for (const [key, value] of Object.entries(fields)) {
            if (value === null) delete room[key];
            else room[key] = value;
          }
          return room;
        },
        { root },
      );
    }
    case "rebind": {
      const { member: memberId, session } = payload();
      if (typeof memberId !== "string" || typeof session !== "string" || !session)
        throw new Error("Member and session are required");
      return rebindSession(id, memberId, session, root);
    }
    case "delete": {
      const text = readFileSync(0, "utf8").trim();
      return deleteRoom(id, root, text ? JSON.parse(text) : undefined);
    }
    default: {
      throw new Error("Expected list, get, put, set-meta, rebind or delete");
    }
  }
}

try {
  process.stdout.write(`${JSON.stringify(await run())}\n`);
} catch (error) {
  if (error.code === "ENOENT") process.stdout.write("null\n");
  else {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
