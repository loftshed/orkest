import { isDeepStrictEqual } from "node:util";

import { fail, identifier } from "./outbox.mjs";

export function createRoomCommands(db) {
  db.exec(
    "CREATE TABLE outbox_room_commands(room TEXT NOT NULL, id TEXT NOT NULL, request TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(room,id)) STRICT",
  );
}

export function previousRoomCommand(db, room, operation) {
  if (!operation) return;
  identifier(operation.id);
  const row = db.tagStore
    .get`SELECT request,result FROM outbox_room_commands WHERE room=${room} AND id=${operation.id}`;
  if (!row) return;
  if (!isDeepStrictEqual(JSON.parse(row.request), operation.request)) fail("content_conflict");
  return JSON.parse(row.result);
}

export function completeRoomCommand(db, room, operation, result) {
  if (!operation) return;
  db.tagStore
    .run`INSERT INTO outbox_room_commands VALUES(${room},${operation.id},${JSON.stringify(operation.request)},${JSON.stringify(result)})`;
}
