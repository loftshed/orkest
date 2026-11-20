import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

import { deleteRoom, openRooms, updateRawRoom } from "../../../src/lib/horde-room.mjs";
import { localStream, readPage } from "../../../src/lib/outbox.mjs";
import {
  createProjectionCheckpoint,
  rebuildProjections,
} from "../../../src/lib/projection-recovery.mjs";

it("keeps an existing scope with the same project through worktree changes and room recreation", async () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "room-project-"));
  const root = path.join(fixture, "store");
  const repo = path.join(fixture, "repo");
  const linked = path.join(fixture, "linked");
  const independent = path.join(fixture, "independent");
  for (const dir of [repo, independent]) {
    mkdirSync(dir);
    execFileSync("git", ["-C", dir, "init", "-q"]);
  }
  execFileSync("git", [
    "-C",
    repo,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@localhost",
    "commit",
    "--allow-empty",
    "-qm",
    "root",
  ]);
  execFileSync("git", ["-C", repo, "worktree", "add", "--detach", "-q", linked]);
  const create = (id, cwd) => updateRawRoom(id, () => ({ id, cwd }), { create: true, root });
  const page = () => {
    using db = openRooms(root);
    const scope = "room:reused";
    return readPage(db, {
      ...localStream(db, scope),
      scope,
      after: 0,
      limit: 128,
      max_bytes: 65_536,
    }).events;
  };
  await create("reused", repo);
  await updateRawRoom("reused", (r) => ({ ...r, cwd: linked }), { root });
  const before = page();
  const checkpoint = await createProjectionCheckpoint(root, path.join(fixture, "checkpoint"));
  await expect(
    updateRawRoom("reused", (r) => ({ ...r, cwd: independent }), { root }),
  ).rejects.toThrow("room_project_conflict");
  expect(page()).toEqual(before);
  expect(deleteRoom("reused", root)).toBe(true);
  const tombstone = page();
  expect(tombstone.at(-1).body.removed).toBe(true);
  const recovered = await rebuildProjections(
    root,
    checkpoint.database,
    checkpoint.sha256,
    path.join(fixture, "recovered"),
  );
  await expect(
    updateRawRoom("reused", () => ({ id: "reused", cwd: independent }), {
      create: true,
      root: path.dirname(recovered.database),
    }),
  ).rejects.toThrow("room_project_conflict");
  await expect(create("reused", independent)).rejects.toThrow("room_project_conflict");
  await create("fresh", independent);
  expect(page()).toEqual(tombstone);
  await create("reused", repo);
  expect(page().at(-1).body.removed).toBe(false);
  expect(JSON.stringify(page())).not.toContain(repo);
  await create("unknown");
  expect(deleteRoom("unknown", root)).toBe(true);
  await expect(create("unknown", independent)).rejects.toThrow("room_project_conflict");
});

it("preserves and reserves a legacy active scope whose first verified identity is unknown", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "room-unverified-"));
  const cwd = path.join(root, "project");
  mkdirSync(cwd);
  await updateRawRoom("legacy", () => ({ id: "legacy", cwd }), { root, create: true });
  {
    using db = openRooms(root);
    db.exec(
      "UPDATE outbox_views SET body=json_remove(body,'$.project') WHERE kind='room.record' AND entity='legacy'",
    );
  }
  await expect(
    updateRawRoom("legacy", (r) => ({ ...r, title: "later" }), { root }),
  ).rejects.toThrow("room_project_unverified");
  expect(deleteRoom("legacy", root)).toBe(true);
  await expect(
    updateRawRoom("legacy", () => ({ id: "legacy", cwd }), { root, create: true }),
  ).rejects.toThrow("room_project_conflict");
});

it("continues an active standalone room through git init and retains its repository binding", async () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "room-init-"));
  const root = path.join(fixture, "store");
  const cwd = path.join(fixture, "repo");
  mkdirSync(cwd);
  const create = (id) => updateRawRoom(id, () => ({ id, cwd }), { root, create: true });
  const update = () => updateRawRoom("active", (r) => ({ ...r, title: "continued" }), { root });
  await create("active");
  await create("retired");
  expect(deleteRoom("retired", root)).toBe(true);
  mkdirSync(path.join(cwd, ".git", "worktrees", "one"), { recursive: true });
  await update();
  execFileSync("git", ["-C", cwd, "init", "-q"]);
  await update();
  await expect(create("retired")).rejects.toThrow("room_project_conflict");
  expect(deleteRoom("active", root)).toBe(true);
  await create("active");
});

it("refuses a redirected repository or replacement directory for a continuing standalone room", async () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "room-replaced-"));
  const root = path.join(fixture, "store");
  const cwd = path.join(fixture, "standalone");
  const other = path.join(fixture, "other");
  mkdirSync(cwd);
  execFileSync("git", ["init", "-q", other]);
  await updateRawRoom("standalone", () => ({ id: "standalone", cwd }), { root, create: true });
  const update = () => updateRawRoom("standalone", (r) => ({ ...r, title: "later" }), { root });
  writeFileSync(path.join(cwd, ".git"), "gitdir: " + path.join(other, ".git") + "\n");
  await expect(update()).rejects.toThrow("room_project_conflict");
  renameSync(cwd, path.join(fixture, "preserved"));
  execFileSync("git", ["init", "-q", cwd]);
  await expect(update()).rejects.toThrow("room_project_conflict");
});
