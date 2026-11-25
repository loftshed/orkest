import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { chiefClose } from "../../../src/lib/chief.mjs";
import { deleteRoom, openRooms, readRawRoom, updateRawRoom } from "../../../src/lib/horde-room.mjs";
import { localStream, readPage } from "../../../src/lib/outbox.mjs";
import {
  createProjectionCheckpoint,
  rebuildProjections,
} from "../../../src/lib/projection-recovery.mjs";
import { retainFixtures } from "../../helpers/retain-fixtures.js";

// Stands in for a reboot or remount: bigint stats under `prefix` report another st_dev.
const device = vi.hoisted(() => ({ prefix: null, shift: 0n }));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal();
  const shifted = (original) =>
    function (target, options) {
      const info = original(target, options);
      if (!info || !options?.bigint || !device.prefix || !String(target).startsWith(device.prefix))
        return info;
      return Object.assign(Object.create(Object.getPrototypeOf(info)), info, {
        dev: info.dev + device.shift,
      });
    };
  const statSync = shifted(fs.statSync);
  const lstatSync = shifted(fs.lstatSync);
  return { ...fs, default: { ...fs, statSync, lstatSync }, statSync, lstatSync };
});

const temporary = [];
afterEach(() => {
  device.prefix = null;
  device.shift = 0n;
  retainFixtures(temporary.splice(0));
});

function legacyHash(directory) {
  const info = statSync(directory, { bigint: true });
  const fields = [info.dev, info.ino, info.birthtimeNs].map(String);
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}

function roomRecord(root, id) {
  using db = openRooms(root);
  const { origin, epoch } = localStream(db, "rooms-local");
  const row = db.tagStore.get`SELECT body FROM outbox_views WHERE scope='rooms-local'
    AND origin=${origin} AND epoch=${epoch} AND kind='room.record' AND entity=${id}`;
  return JSON.parse(row.body);
}

function rewriteRecord(root, id, body) {
  using db = openRooms(root);
  db.tagStore.run`UPDATE outbox_views SET body=${JSON.stringify(body)}
    WHERE scope='rooms-local' AND kind='room.record' AND entity=${id}`;
}

function repository(fixture, name) {
  const dir = path.join(fixture, name);
  mkdirSync(dir);
  execFileSync("git", ["-C", dir, "init", "-q"]);
  execFileSync("git", [
    "-C",
    dir,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@localhost",
    "commit",
    "--allow-empty",
    "-qm",
    "root",
  ]);
  return dir;
}

it("keeps a room writable when its common directory reports a new st_dev", async () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "room-device-"));
  temporary.push(fixture);
  const root = path.join(fixture, "store");
  const cwd = repository(fixture, "repo");
  await updateRawRoom("stable", () => ({ id: "stable", cwd }), { root, create: true });
  const before = roomRecord(root, "stable");
  expect(before.projectVerified).toBe(true);
  Object.assign(device, { prefix: fixture, shift: 7n });
  await updateRawRoom("stable", (r) => ({ ...r, title: "after reboot" }), { root });
  expect(roomRecord(root, "stable").project).toBe(before.project);
});

it("re-binds a legacy record once and still refuses a different repository", async () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "room-legacy-"));
  temporary.push(fixture);
  const root = path.join(fixture, "store");
  const repo = repository(fixture, "repo");
  const other = repository(fixture, "other");
  const legacy = (id, cwd) => {
    const { removed, room } = roomRecord(root, id);
    rewriteRecord(root, id, { removed, room, project: legacyHash(path.join(cwd, ".git")) });
  };
  for (const id of ["same-boot", "rebooted", "moved"]) {
    await updateRawRoom(id, () => ({ id, cwd: repo }), { root, create: true });
    legacy(id, repo);
  }
  const verified = { project: expect.stringMatching(/^[a-f0-9]{64}$/u), projectVerified: true };
  // Written on this boot, the legacy hash still matches with the current st_dev.
  await updateRawRoom("same-boot", (r) => ({ ...r, title: "x" }), { root });
  expect(roomRecord(root, "same-boot")).toMatchObject(verified);
  const bound = roomRecord(root, "same-boot").project;
  Object.assign(device, { prefix: fixture, shift: 7n });
  await updateRawRoom("rebooted", (r) => ({ ...r, title: "x" }), { root });
  expect(roomRecord(root, "rebooted")).toMatchObject({ ...verified, project: bound });
  await updateRawRoom("rebooted", (r) => ({ ...r, title: "y" }), { root });
  await expect(updateRawRoom("rebooted", (r) => ({ ...r, cwd: other }), { root })).rejects.toThrow(
    "room_project_conflict",
  );
  await expect(updateRawRoom("moved", (r) => ({ ...r, cwd: other }), { root })).rejects.toThrow(
    "room_project_conflict",
  );
  expect(roomRecord(root, "moved").projectVerified).toBeUndefined();
});

it("closes a Chief mission whose saved identity no longer matches", async () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "room-close-"));
  temporary.push(fixture);
  const root = path.join(fixture, "store");
  const cwd = repository(fixture, "repo");
  const chief = { goal: "Ship", state: "running", mission: { session: "stuck-orch" } };
  await updateRawRoom("stuck", () => ({ id: "stuck", cwd, chief }), { root, create: true });
  rewriteRecord(root, "stuck", { ...roomRecord(root, "stuck"), project: "0".repeat(64) });
  await expect(updateRawRoom("stuck", (r) => ({ ...r, title: "x" }), { root })).rejects.toThrow(
    "room_project_conflict",
  );
  const closed = await chiefClose({
    roomId: "stuck",
    root,
    env: {},
    runMailbox: vi.fn(() => ({ status: 0, stdout: "{}", stderr: "" })),
    peers: [],
  });
  expect(closed.status).toBe("closed");
  expect(readRawRoom("stuck", root).status).toBe("closed");
  expect(roomRecord(root, "stuck").project).toBe("0".repeat(64));
  await expect(
    updateRawRoom("stuck", (r) => ({ ...r, status: "running", closedAt: undefined }), { root }),
  ).rejects.toThrow("room_project_conflict");
});

it("replaces an identity Git could not verify with the verified one found later", async () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "room-fallback-"));
  temporary.push(fixture);
  const root = path.join(fixture, "store");
  const repo = repository(fixture, "repo");
  const linked = path.join(fixture, "linked");
  execFileSync("git", ["-C", repo, "worktree", "add", "--detach", "-q", linked]);
  const dotGit = path.join(linked, ".git");
  const pointer = readFileSync(dotGit, "utf8");
  const update = () => updateRawRoom("linked", (r) => ({ ...r, title: "later" }), { root });
  writeFileSync(dotGit, "gitdir: " + path.join(fixture, "missing") + "\n");
  await updateRawRoom("linked", () => ({ id: "linked", cwd: linked }), { root, create: true });
  const fallback = roomRecord(root, "linked");
  expect(fallback.projectVerified).toBe(false);
  writeFileSync(dotGit, pointer);
  await update();
  const verified = roomRecord(root, "linked");
  expect(verified).toMatchObject({ projectVerified: true });
  expect(verified.project).not.toBe(fallback.project);
  writeFileSync(dotGit, "gitdir: " + path.join(fixture, "missing") + "\n");
  await update();
  expect(roomRecord(root, "linked")).toMatchObject({
    project: verified.project,
    projectVerified: true,
  });
});

it("keeps an existing scope with the same project through worktree changes and room recreation", async () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "room-project-"));
  temporary.push(fixture);
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
  temporary.push(root);
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
  temporary.push(fixture);
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
  temporary.push(fixture);
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
