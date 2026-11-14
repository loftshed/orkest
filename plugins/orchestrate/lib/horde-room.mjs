import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import {
  link,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { migrateSchema, openOrkestSqlite, withImmediateTransaction } from "./orkest-sqlite.mjs";
import { cacheHome } from "./runtime-paths.mjs";

export const ROOM_SCHEMA = "agent-executor.room.v1";
const ID = /^[\w-]{1,80}$/u;
const ENGINES = new Set(["claude", "agy", "codex", "opencode"]);
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);
const CLAUDE_TIER_MAP = Object.freeze({
  fast: "haiku",
  balanced: "sonnet",
  best: "opus",
  frontier: "fable",
  mythos: "claude-mythos-5-1",
  "mythos-5-1": "claude-mythos-5-1",
  "mythos-5.1": "claude-mythos-5-1",
  "mythos-5": "claude-mythos-5",
});
const AGY_TIER_MAP = Object.freeze({
  fast: "gemini:fast",
  flash: "gemini:fast",
  "flash-low": "gemini:flash-low",
  "flash-medium": "gemini:fast",
  "flash-high": "gemini:flash-high",
  pro: "gemini:pro",
  argon: "gemini:argon",
  "argon-low": "gemini:argon-low",
  "argon-medium": "gemini:argon",
  "argon-high": "gemini:argon-high",
  carbon: "gemini:carbon",
  "carbon-low": "gemini:carbon-low",
  "carbon-medium": "gemini:carbon",
  "carbon-high": "gemini:carbon-high",
  hydrogen: "gemini:hydrogen",
  "hydrogen-low": "gemini:hydrogen-low",
  "hydrogen-medium": "gemini:hydrogen",
  "hydrogen-high": "gemini:hydrogen-high",
  "hydrogen-xhigh": "gemini:hydrogen-xhigh",
  orchestrator: "gemini:orchestrator",
  "orchestrator-carbon": "gemini:orchestrator",
  "orchestrator-argon": "gemini:orchestrator-argon",
});

function resolveTeamModel(engine, tier, effort) {
  const loweredTier = tier.toLowerCase();
  switch (engine) {
    case "claude": {
      if (Object.hasOwn(CLAUDE_TIER_MAP, loweredTier)) {
        return CLAUDE_TIER_MAP[loweredTier];
      }
      if (/^(?:claude-)?(?:opus|sonnet|haiku|fable|mythos)-\d+(?:[.-]\d+)*$/iu.test(tier)) {
        const prefixed = loweredTier.startsWith("claude-") ? loweredTier : `claude-${loweredTier}`;
        return prefixed.replaceAll(".", "-");
      }
      return tier;
    }
    case "codex": {
      if (["luna", "sol", "terra", "astra"].includes(tier)) {
        return `gpt:${tier}`;
      }
      if (/^\d+(?:\.\d+)?-(?:luna|sol|terra|astra)$/iu.test(tier)) {
        return `gpt-${loweredTier}`;
      }
      return tier;
    }
    case "agy": {
      const agyKey =
        effort && Object.hasOwn(AGY_TIER_MAP, `${loweredTier}-${effort}`)
          ? `${loweredTier}-${effort}`
          : loweredTier;
      return Object.hasOwn(AGY_TIER_MAP, agyKey) ? AGY_TIER_MAP[agyKey] : tier;
    }
    default: {
      return tier;
    }
  }
}

const sourceRolesPath = new URL(
  "../skills/orchestrate/references/workforce-roles.json",
  import.meta.url,
);
const rolesPath = existsSync(sourceRolesPath)
  ? sourceRolesPath
  : new URL("../references/workforce-roles.json", import.meta.url);
export const WORKFORCE_ROLES = JSON.parse(readFileSync(rolesPath, "utf8"));
const ROLE_ALIASES = new Map(
  Object.values(WORKFORCE_ROLES).flatMap((role) => [
    [role.id, role.id],
    ...(role.aliases || []).map((alias) => [alias, role.id]),
  ]),
);

export function normalizeWorkforceRole(value) {
  if (value === undefined || value === null) return;
  if (typeof value !== "string") throw new Error("Invalid workforce role");
  const key = value.trim().toLowerCase();
  if (key === "native") return "native";
  const resolved = ROLE_ALIASES.get(key);
  if (!resolved) throw new Error(`Invalid workforce role: ${value}`);
  return resolved;
}

export function workforceRoleInfo(value) {
  const id = normalizeWorkforceRole(value);
  return id ? WORKFORCE_ROLES[id] : undefined;
}

export function resolveWorktreeMarkerPath(cwd) {
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) return;
  try {
    const dotGit = readFileSync(path.join(cwd, ".git"), "utf8");
    const match = /^gitdir:\s*(.+)$/mu.exec(dotGit);
    if (!match) return;
    const gitDir = path.resolve(cwd, match[1].trim());
    return path.join(gitDir, "orkest.json");
  } catch {
    return;
  }
}

function alignCanonicalPath(candidate, reference) {
  if (!candidate) return;
  const resolved = path.resolve(candidate);
  if (!reference || resolved === reference) return resolved;
  try {
    if (realpathSync(resolved) === realpathSync(reference)) return reference;
  } catch {
    // Keep the resolved path when either path does not exist on disk.
  }
  return resolved;
}

export function detectWorktree(cwd, existing, referenceCwd) {
  const resolvedCwd =
    typeof cwd === "string" && path.isAbsolute(cwd) ? path.resolve(cwd) : undefined;
  const markerPath = resolveWorktreeMarkerPath(resolvedCwd);
  if (markerPath) {
    try {
      const marker = JSON.parse(readFileSync(markerPath, "utf8"));
      if (
        marker &&
        typeof marker === "object" &&
        typeof marker.disposable === "boolean" &&
        (marker.parentCwd === undefined ||
          (typeof marker.parentCwd === "string" && path.isAbsolute(marker.parentCwd)))
      ) {
        const isSameTarget = !existing?.path || path.resolve(existing.path) === resolvedCwd;
        const isDisposable =
          Boolean(marker.disposable) && (!isSameTarget || existing?.disposable !== false);
        const parentCwd = alignCanonicalPath(
          marker.parentCwd || (isSameTarget ? existing?.parentCwd : undefined),
          referenceCwd,
        );
        if (!isDisposable || parentCwd) {
          const slug =
            (typeof marker.slug === "string" && marker.slug.trim()) ||
            (isSameTarget && typeof existing?.slug === "string" && existing.slug.trim()) ||
            path.basename(resolvedCwd);
          const branch =
            (typeof marker.branch === "string" && marker.branch.trim()) ||
            (isSameTarget ? existing?.branch : undefined);
          return {
            path: resolvedCwd,
            ...(branch && { branch }),
            disposable: isDisposable,
            ...(parentCwd && { parentCwd }),
            slug,
          };
        }
      }
    } catch {
      // Ignore missing or unreadable orkest.json and fall back to existing metadata.
    }
  }
  if (!existing || typeof existing !== "object" || typeof existing.disposable !== "boolean") return;
  if (
    existing.path &&
    resolvedCwd &&
    alignCanonicalPath(existing.path, resolvedCwd) !== resolvedCwd
  ) {
    return;
  }
  const wtPath = existing.path ? path.resolve(existing.path) : resolvedCwd;
  const parentCwd = alignCanonicalPath(existing.parentCwd, referenceCwd);
  const slug = existing.slug || (wtPath ? path.basename(wtPath) : undefined);
  return {
    ...(wtPath && { path: wtPath }),
    ...(existing.branch && { branch: existing.branch }),
    ...(existing.baseBranch && { baseBranch: existing.baseBranch }),
    disposable: existing.disposable,
    ...(parentCwd && { parentCwd }),
    ...(slug && { slug }),
  };
}

export function resolveMemberWorktree(member, roomCwd) {
  if (!member || typeof member !== "object") return;
  const existing = member.worktree;
  const isMovedAway = Boolean(
    existing?.path &&
    member.cwd &&
    alignCanonicalPath(member.cwd, existing.path) !== path.resolve(existing.path) &&
    (!existing.parentCwd ||
      alignCanonicalPath(member.cwd, existing.parentCwd) !== path.resolve(existing.parentCwd)),
  );
  const candidates = [
    member.cwd,
    member.session?.cwd,
    member.progress?.cwd,
    !isMovedAway && existing?.path,
  ].filter((item) => typeof item === "string" && path.isAbsolute(item));
  for (const candidate of candidates) {
    if (!resolveWorktreeMarkerPath(candidate)) continue;
    const detected = detectWorktree(candidate, isMovedAway ? undefined : existing, roomCwd);
    if (detected) return detected;
  }
  if (!isMovedAway && existing && typeof existing === "object") {
    return detectWorktree(existing.path || candidates[0], existing, roomCwd);
  }
}

export function refreshMemberWorktrees(room) {
  if (!room || typeof room !== "object") return room;
  for (const member of [room.conductor, ...(Array.isArray(room.agents) ? room.agents : [])]) {
    if (!member) continue;
    const detectedWorktree =
      resolveMemberWorktree(member, room.cwd) ||
      (member === room.conductor && !member.cwd
        ? detectWorktree(room.cwd, member.worktree, room.cwd)
        : undefined);
    if (detectedWorktree) member.worktree = detectedWorktree;
    else delete member.worktree;
  }
  return room;
}

export function mailboxRoot(env = process.env) {
  return path.join(cacheHome(env), "mailbox-v1");
}

export function roomPath(id, root = mailboxRoot()) {
  if (typeof id !== "string" || !ID.test(id))
    throw new Error("Room ID must contain 1–80 letters, digits, underscores or hyphens");
  return path.join(root, "rooms", `${id}.json`);
}

export async function loadPresets() {
  return JSON.parse(
    await readFile(new URL("../references/swarm-presets.json", import.meta.url), "utf8"),
  );
}

/** Team shorthand is resolved by the runner's live catalog at launch, never pinned here. */
export function parseTeam(text) {
  if (typeof text !== "string" || !text.trim()) throw new Error("A nonempty team is required");
  const members = [];
  for (const raw of text.split(",")) {
    const match =
      /^(claude|agy|codex|opencode):([^*@,\s]+?)(?:@([A-Za-z0-9_-]+))?(?:\*(\d+))?(?:@([A-Za-z0-9_-]+))?$/u.exec(
        raw.trim(),
      );
    if (!match || (match[3] && match[5])) throw new Error(`Invalid team member: ${raw}`);
    const [, engine, selection, roleBefore, copies = "1", roleAfter] = match;
    const workforceRole =
      roleBefore || roleAfter ? normalizeWorkforceRole(roleBefore || roleAfter) : undefined;
    const count = Number(copies);
    if (count < 1 || count > 64 || members.length + count > 64)
      throw new Error("A room supports 1–64 members");
    const parts = selection.split(":");
    if (parts.some((part) => !part)) throw new Error(`Invalid team member: ${raw}`);
    const effort = parts.length > 1 && EFFORTS.has(parts.at(-1)) ? parts.pop() : undefined;
    const tier = parts.join(":");
    const model = resolveTeamModel(engine, tier, effort);
    for (let i = 0; i < count; i++)
      members.push({
        engine,
        model,
        ...(effort && { effort }),
        ...(workforceRole && { workforceRole }),
        label: tier,
      });
  }
  return members;
}

export function validateRoom(room) {
  if (
    !room ||
    room.schema !== ROOM_SCHEMA ||
    typeof room.id !== "string" ||
    !ID.test(room.id) ||
    !Array.isArray(room.agents)
  )
    throw new Error("Invalid swarm room: expected agent-executor.room.v1, id and agents");
  if (room.agents.length > 64) throw new Error("A room supports at most 64 members");
  if (room.cwd !== undefined && (typeof room.cwd !== "string" || !path.isAbsolute(room.cwd)))
    throw new Error("Room checkout must be an absolute path");
  if (
    room.authority !== undefined &&
    (typeof room.authority !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(room.authority))
  )
    throw new Error("Invalid room authority team");
  for (const key of ["group", "title", "machine"])
    if (
      room[key] !== undefined &&
      (typeof room[key] !== "string" ||
        !room[key].trim() ||
        room[key].length > 160 ||
        [...room[key]].some(
          (character) => character.codePointAt(0) < 32 || character.codePointAt(0) === 127,
        ))
    )
      throw new Error(`Invalid room ${key}`);
  const ids = new Set();
  for (const agent of room.agents) {
    if (
      !agent ||
      typeof agent.id !== "string" ||
      !ID.test(agent.id) ||
      ids.has(agent.id) ||
      !ENGINES.has(agent.engine) ||
      typeof agent.model !== "string"
    )
      throw new Error("Invalid or duplicate room member");
    ids.add(agent.id);
  }
  if (ids.has("conductor")) throw new Error("conductor is reserved for the root coordinator");
  if (room.swarm) {
    const { maxAgents, maxDepth } = room.swarm;
    if (
      !Number.isSafeInteger(maxAgents) ||
      maxAgents < 1 ||
      maxAgents > 64 ||
      !Number.isSafeInteger(maxDepth) ||
      maxDepth < 1 ||
      maxDepth > 8
    )
      throw new Error("Swarm limits require 1–64 agents and 1–8 levels");
    if (room.agents.length > maxAgents) throw new Error("Swarm agent limit reached");
    if (!ENGINES.has(room.conductor?.engine)) throw new Error("A swarm needs a coordinator engine");
  }
  for (const agent of room.agents) {
    if (agent.role !== undefined && !["lead", "worker"].includes(agent.role))
      throw new Error("Invalid swarm role");
    const visited = new Set([agent.id]);
    let parent = agent.parent || "conductor";
    let depth = 1;
    while (parent !== "conductor") {
      const lead = room.agents.find((entry) => entry.id === parent);
      if (!lead || lead.role !== "lead" || visited.has(parent))
        throw new Error("Swarm parent must be an existing lead without a cycle");
      visited.add(parent);
      depth++;
      parent = lead.parent || "conductor";
    }
    if (room.swarm && depth > room.swarm.maxDepth) throw new Error("Swarm depth limit reached");
  }
  for (const member of [room.conductor, ...room.agents]) {
    if (!member) continue;
    if (member.workforceRole !== undefined)
      member.workforceRole = normalizeWorkforceRole(member.workforceRole);
    if (
      member.cwd !== undefined &&
      (typeof member.cwd !== "string" || !path.isAbsolute(member.cwd))
    )
      throw new Error("Member working folder must be an absolute path");
    if (
      member.worktree !== undefined &&
      (!member.worktree ||
        typeof member.worktree !== "object" ||
        Array.isArray(member.worktree) ||
        typeof member.worktree.disposable !== "boolean" ||
        (member.worktree.path !== undefined &&
          (typeof member.worktree.path !== "string" || !path.isAbsolute(member.worktree.path))) ||
        (member.worktree.parentCwd !== undefined &&
          (typeof member.worktree.parentCwd !== "string" ||
            !path.isAbsolute(member.worktree.parentCwd))) ||
        (member.worktree.branch !== undefined && typeof member.worktree.branch !== "string") ||
        (member.worktree.baseBranch !== undefined &&
          typeof member.worktree.baseBranch !== "string") ||
        (member.worktree.slug !== undefined && typeof member.worktree.slug !== "string"))
    )
      throw new Error("Invalid member worktree metadata");
    if (
      member.session &&
      (typeof member.session.id !== "string" ||
        !member.session.id ||
        !ENGINES.has(member.session.engine) ||
        typeof member.session.machine !== "string" ||
        !path.isAbsolute(member.session.cwd || ""))
    )
      throw new Error("Invalid member session binding");
    if (
      member.dispatch &&
      (!path.isAbsolute(member.dispatch.taskDir || "") ||
        typeof member.dispatch.taskId !== "string" ||
        !member.dispatch.taskId ||
        typeof member.dispatch.requestId !== "string" ||
        !ID.test(member.dispatch.requestId) ||
        !["native", "executor"].includes(member.dispatch.transport))
    )
      throw new Error("Invalid member dispatch binding");
  }
  if (
    room.services !== undefined &&
    (!Array.isArray(room.services) ||
      room.services.some((svc) => !svc || typeof svc !== "object" || Array.isArray(svc)))
  )
    throw new Error("Invalid room services metadata");
  if (
    room.update !== undefined &&
    (!room.update || typeof room.update !== "object" || Array.isArray(room.update))
  )
    throw new Error("Invalid room update metadata");
  return refreshMemberWorktrees(room);
}

export function addMembers(room, members, { parent = "conductor", workforceRole, cwd } = {}) {
  if (room.agents.length + members.length > 64)
    throw new Error("A room supports at most 64 members");
  const defaultRole = workforceRole ? normalizeWorkforceRole(workforceRole) : undefined;
  const defaultCwd = cwd ? path.resolve(cwd) : undefined;
  for (const member of members) {
    let index = 1;
    const stem = member.label.replaceAll(/[^\w-]/gu, "-").slice(0, 60);
    while (room.agents.some((agent) => agent.id === `${stem}-${index}`)) index++;
    const resolvedRole = member.workforceRole
      ? normalizeWorkforceRole(member.workforceRole)
      : defaultRole;
    const resolvedCwd = member.cwd ? path.resolve(member.cwd) : defaultCwd;
    const worktree = detectWorktree(
      resolvedCwd || member.worktree?.path,
      member.worktree,
      room.cwd,
    );
    room.agents.push({
      ...member,
      ...(resolvedRole && { workforceRole: resolvedRole }),
      ...(resolvedCwd && { cwd: resolvedCwd }),
      ...(worktree && { worktree }),
      id: `${stem}-${index}`,
      parent,
      status: "queued",
      output: [],
    });
  }
  return room;
}

export function createRoom(
  members,
  {
    id = randomUUID(),
    cwd = process.cwd(),
    now = Date.now(),
    swarm = { maxAgents: 64, maxDepth: 8 },
    engine,
  } = {},
) {
  const conductorEngine = engine || members?.[0]?.engine || "codex";
  const room = addMembers(
    {
      schema: ROOM_SCHEMA,
      id,
      cwd: path.resolve(cwd),
      createdAt: now,
      updatedAt: now,
      swarm,
      conductor: { engine: conductorEngine, status: "idle" },
      agents: [],
      messages: [],
      accounts: [],
    },
    members,
  );
  return validateRoom(room);
}

export function roomsDbPath(root = mailboxRoot()) {
  return path.join(root, "rooms.db");
}

function validateRawRoom(room, id) {
  if (
    !room ||
    typeof room !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(room))
  )
    throw new Error("Invalid room: expected a plain object");
  if (room.id !== id) throw new Error("Cannot change room identity");
  return room;
}

function missingRoom(id) {
  return Object.assign(new Error(`Room not found: ${id}`), { code: "ENOENT" });
}

function legacyFiles(root) {
  try {
    return readdirSync(path.join(root, "rooms"))
      .filter((file) => file.endsWith(".json"))
      .sort((a, b) => a.localeCompare(b));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function legacyRecord(root, file) {
  const id = file.slice(0, -5);
  const source = roomPath(id, root);
  const raw = readFileSync(source, "utf8");
  const info = statSync(source, { bigint: true });
  const room = JSON.parse(raw);
  if (!room || typeof room !== "object" || Array.isArray(room))
    throw new Error("Invalid room: expected a plain object");
  if (room.id !== undefined && room.id !== id)
    throw new Error("Room identity does not match its filename");
  room.id ??= id;
  validateRawRoom(room, id);
  const digest = createHash("sha256").update(`${info.ino}:${info.mtimeNs}:${raw}`).digest("hex");
  const updated = room.updatedAt;
  const timestamp = typeof updated === "number" ? updated : Date.parse(updated);
  room.updatedAt ??= Number(info.mtimeMs);
  return {
    room,
    source,
    digest,
    updatedAt: Number.isFinite(timestamp) ? Math.trunc(timestamp) : Number(info.mtimeMs),
  };
}

const ROOMS_APPLICATION_ID = 1_330_793_298;
const MAX_ROOM_CAS_ATTEMPTS = 32;
const ROOMS_MIGRATIONS = [
  (connection) =>
    connection.exec(`
    CREATE TABLE rooms (
      id TEXT PRIMARY KEY, cwd TEXT NOT NULL, updated_at INTEGER NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1, data TEXT NOT NULL CHECK (json_valid(data))
    ) STRICT;
    CREATE INDEX rooms_updated_at ON rooms (updated_at DESC);
    CREATE INDEX rooms_cwd ON rooms (cwd);
    CREATE TABLE legacy_room_imports (file TEXT PRIMARY KEY, digest TEXT NOT NULL) STRICT;
  `),
];

function validLegacyRecords(root) {
  const records = [];
  for (const file of legacyFiles(root)) {
    try {
      records.push({ file, ...legacyRecord(root, file) });
    } catch {
      // Invalid legacy files stay discoverable so listRooms can report their errors.
    }
  }
  return records;
}

/** Commit imports before archiving. The ledger makes interrupted archival safe to resume. */
function syncLegacyRoomFiles(db, root) {
  const initialRecords = validLegacyRecords(root);
  if (initialRecords.length === 0) return;
  withImmediateTransaction(db, () => {
    for (const { file, room, digest, updatedAt } of validLegacyRecords(root)) {
      if (
        db.tagStore.get`SELECT digest FROM legacy_room_imports WHERE file = ${file}`?.digest ===
        digest
      )
        continue;
      db.tagStore.run`
        INSERT INTO rooms (id, cwd, updated_at, data) VALUES (${room.id}, ${typeof room.cwd === "string" ? room.cwd : ""}, ${updatedAt}, ${JSON.stringify(room)})
        ON CONFLICT(id) DO UPDATE SET cwd = excluded.cwd, updated_at = excluded.updated_at,
          revision = rooms.revision + 1, data = excluded.data`;
      db.tagStore.run`INSERT INTO legacy_room_imports (file, digest) VALUES (${file}, ${digest})
        ON CONFLICT(file) DO UPDATE SET digest = excluded.digest`;
    }
  });
  withImmediateTransaction(db, () => {
    for (const { file, source, digest } of validLegacyRecords(root)) {
      if (
        db.tagStore.get`SELECT digest FROM legacy_room_imports WHERE file = ${file}`?.digest !==
        digest
      )
        continue;
      const backup = path.join(root, "rooms.v1-backup");
      mkdirSync(backup, { recursive: true, mode: 0o700 });
      const destination = path.join(backup, file);
      const target = existsSync(destination) ? path.join(backup, `${file}.${digest}`) : destination;
      renameSync(source, target);
      chmodSync(target, 0o400);
    }
  });
}

function openRooms(root) {
  const db = openOrkestSqlite(roomsDbPath(root), { synchronous: "FULL" });
  try {
    migrateSchema(db, {
      applicationId: ROOMS_APPLICATION_ID,
      migrations: ROOMS_MIGRATIONS,
    });
    syncLegacyRoomFiles(db, root);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function openRoomsForRead(root) {
  const dbPath = roomsDbPath(root);
  if (existsSync(dbPath) && validLegacyRecords(root).length === 0) {
    const db = openOrkestSqlite(dbPath, { readOnly: true });
    let isCurrent;
    try {
      using appQuery = db.prepare("PRAGMA application_id");
      using versionQuery = db.prepare("PRAGMA user_version");
      isCurrent =
        appQuery.get().application_id === ROOMS_APPLICATION_ID &&
        versionQuery.get().user_version === ROOMS_MIGRATIONS.length;
    } catch (error) {
      db.close();
      throw error;
    }
    if (isCurrent) return db;
    db.close();
  }
  return openRooms(root);
}

export function readRawRoom(id, root = mailboxRoot()) {
  roomPath(id, root);
  if (!existsSync(roomsDbPath(root)) && !existsSync(path.join(root, "rooms")))
    throw missingRoom(id);
  using db = openRoomsForRead(root);
  const row = db.tagStore.get`SELECT data FROM rooms WHERE id = ${id}`;
  if (!row) throw missingRoom(id);
  return JSON.parse(row.data);
}

/** Diagnostic snapshot: never initialize, migrate, archive or repair a room store. */
export function listRawRoomsReadOnly(root = mailboxRoot()) {
  const rooms = new Map();
  if (existsSync(roomsDbPath(root))) {
    const rows = readRoomSnapshot(root);
    for (const row of rows) {
      const room = JSON.parse(row.data);
      rooms.set(room.id, room);
    }
  }
  for (const file of legacyFiles(root)) {
    try {
      const { room } = legacyRecord(root, file);
      rooms.set(room.id, room);
    } catch {
      /* Leave malformed records untouched. */
    }
  }
  return rooms
    .values()
    .toArray()
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function snapshotSignature(files) {
  return files.map((file) => {
    try {
      const info = lstatSync(file, { bigint: true });
      if (!info.isFile()) throw new Error(`Expected a regular SQLite file: ${file}`);
      return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  });
}

function readRoomSnapshot(root) {
  // Even SQLite read-only connections may create WAL/SHM sidecars. Open a private
  // copy instead, checking for concurrent checkpoints or commits around the copy.
  const scratch = mkdtempSync(path.join(tmpdir(), "ork-room-snapshot-"));
  const source = roomsDbPath(root);
  const files = [source, `${source}-wal`];
  try {
    for (let attempt = 0; attempt < 8; attempt++) {
      const before = snapshotSignature(files);
      if (!before[0]) return [];
      const directory = path.join(scratch, String(attempt));
      mkdirSync(directory, { mode: 0o700 });
      const target = path.join(directory, "rooms.db");
      try {
        copyFileSync(source, target);
        if (before[1]) copyFileSync(`${source}-wal`, `${target}-wal`);
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      const after = snapshotSignature(files);
      if (before.some((value, index) => value !== after[index])) continue;
      using db = openOrkestSqlite(target, { readOnly: true });
      return db.tagStore.all`SELECT data FROM rooms ORDER BY updated_at DESC, id ASC`;
    }
    throw new Error("Room store changed while taking the read-only snapshot; retry resume-status");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function listRawRooms(root = mailboxRoot()) {
  if (!existsSync(roomsDbPath(root)) && !existsSync(path.join(root, "rooms"))) return [];
  using db = openRoomsForRead(root);
  return db.tagStore.all`SELECT data FROM rooms ORDER BY updated_at DESC, id ASC`.map((row) =>
    JSON.parse(row.data),
  );
}

export async function readRoom(id, root = mailboxRoot()) {
  return validateRoom(readRawRoom(id, root));
}

export function deleteRoom(id, root = mailboxRoot(), expected) {
  roomPath(id, root);
  if (!existsSync(roomsDbPath(root)) && !existsSync(path.join(root, "rooms"))) return false;
  using db = openRooms(root);
  return withImmediateTransaction(db, () => {
    const result =
      expected === undefined
        ? db.tagStore.run`DELETE FROM rooms WHERE id = ${id}`
        : db.tagStore
            .run`DELETE FROM rooms WHERE id = ${id} AND data = ${JSON.stringify(expected)}`;
    return result.changes === 1;
  });
}

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

export function processStarted(pid) {
  try {
    return (
      execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
        env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
        timeout: 2000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || undefined
    );
  } catch {
    return;
  }
}

function parseLockOwner(raw) {
  try {
    const value = JSON.parse(raw);
    const owner = typeof value === "number" ? { pid: value } : value;
    if (Number.isSafeInteger(owner?.pid) && owner.pid > 0) return owner;
  } catch {
    // An incomplete owner record gets the same grace period as a missing one.
  }
}

async function isStaleRoomLock(lock) {
  try {
    const owner = parseLockOwner(await readFile(path.join(lock, "owner"), "utf8"));
    if (owner) {
      if (!pidAlive(owner.pid)) return true;
      const birth = owner.pidBirth && processStarted(owner.pid);
      return Boolean(birth && birth !== owner.pidBirth);
    }
  } catch {
    // Missing owner file while lock creator is still writing it; check lock age below.
  }
  try {
    const info = await stat(lock);
    return Date.now() - info.mtimeMs > 15_000;
  } catch {
    return false;
  }
}

async function removeEmptyLock(lock) {
  try {
    await rmdir(lock);
  } catch (error) {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error;
  }
}

async function reapRoomLock(lock) {
  // Recover an interrupted reaper without discarding the owner it had claimed.
  const names = await readdir(lock);
  for (const name of names) {
    const match = /^owner\.(\d+)\.[\da-f-]+\.retired$/u.exec(name);
    if (!match || pidAlive(Number(match[1]))) continue;
    try {
      await link(path.join(lock, name), path.join(lock, "owner"));
      await rm(path.join(lock, name));
    } catch (error) {
      if (!["EEXIST", "ENOENT"].includes(error.code)) throw error;
    }
  }
  if (!(await isStaleRoomLock(lock))) return;
  const ownerFile = path.join(lock, "owner");
  const retired = path.join(lock, `owner.${process.pid}.${randomUUID()}.retired`);
  const previous = await stat(lock);
  try {
    // Keep the directory nonempty until the claimed owner has been checked again.
    // A competing reaper may have observed an earlier acquisition at this path.
    await rename(ownerFile, retired);
  } catch (error) {
    if (error.code === "ENOENT") await removeEmptyLock(lock);
    return;
  }
  const owner = parseLockOwner(await readFile(retired, "utf8"));
  const current = await stat(lock);
  const birth = owner?.pidBirth && processStarted(owner.pid);
  if (
    current.ino !== previous.ino ||
    current.dev !== previous.dev ||
    (owner && pidAlive(owner.pid) && (!birth || birth === owner.pidBirth)) ||
    (!owner && Date.now() - previous.mtimeMs <= 15_000)
  ) {
    await rename(retired, ownerFile);
    return;
  }
  await rm(retired, { force: true });
  await removeEmptyLock(lock);
}

/** Shared with Python's _node_room_lock; live legacy PID-only owners remain valid. */
export async function withRoomLock(file, update) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  const deadline = Date.now() + 3000;
  const owner = { pid: process.pid, token: randomUUID(), pidBirth: processStarted(process.pid) };
  for (;;) {
    try {
      await mkdir(lock);
      try {
        await writeFile(path.join(lock, "owner"), `${JSON.stringify(owner)}\n`, { flag: "wx" });
      } catch (error) {
        await removeEmptyLock(lock);
        throw error;
      }
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (await isStaleRoomLock(lock)) {
        try {
          await reapRoomLock(lock);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
      if (Date.now() >= deadline) throw new Error(`Room is locked: ${file}`, { cause: error });
      await sleep(25);
    }
  }
  try {
    return await update();
  } finally {
    let current;
    try {
      current = parseLockOwner(await readFile(path.join(lock, "owner"), "utf8"));
    } catch {
      // A replaced acquisition is no longer ours to release.
    }
    if (current?.token === owner.token) {
      await rm(path.join(lock, "owner"), { force: true });
      await rmdir(lock);
    }
  }
}

/** Callbacks can await work; conflicting revisions retry with a fresh room outside the transaction. */
async function updateStoredRoom(
  id,
  update,
  { root = mailboxRoot(), create = false, maxAttempts = MAX_ROOM_CAS_ATTEMPTS } = {},
  validate,
) {
  roomPath(id, root);
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError("maxAttempts must be a positive safe integer.");
  }
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let row;
    {
      using db = openRooms(root);
      row = db.tagStore.get`SELECT data, revision FROM rooms WHERE id = ${id}`;
    }
    if (create && row) throw new Error(`Room already exists: ${id}`);
    if (!create && !row) throw missingRoom(id);
    const previous = row ? validate(JSON.parse(row.data), id) : undefined;
    const room = validate(validateRawRoom(await update(previous), id), id);
    if (room.id !== id) throw new Error("Cannot change room identity");
    room.updatedAt = Date.now();
    using db = openRooms(root);
    const committed = withImmediateTransaction(db, () => {
      const data = JSON.stringify(room);
      const result = row
        ? db.tagStore
            .run`UPDATE rooms SET cwd = ${typeof room.cwd === "string" ? room.cwd : ""}, updated_at = ${room.updatedAt},
            data = ${data}, revision = revision + 1 WHERE id = ${id} AND revision = ${row.revision} AND data = ${row.data}`
        : db.tagStore.run`INSERT INTO rooms (id, cwd, updated_at, data)
            VALUES (${id}, ${typeof room.cwd === "string" ? room.cwd : ""}, ${room.updatedAt}, ${data}) ON CONFLICT(id) DO NOTHING`;
      return result.changes === 1;
    });
    if (committed) return room;
    const delayMs = Math.floor(Math.random() * Math.min(5 * 2 ** Math.min(attempt, 5), 100));
    if (delayMs > 0) await sleep(delayMs);
  }
  throw new Error(`Room update exceeded ${maxAttempts} concurrent retries: ${id}`);
}

export async function updateRoom(id, update, options) {
  return updateStoredRoom(id, update, options, validateRoom);
}

export async function updateRawRoom(id, update, options) {
  return updateStoredRoom(id, update, options, validateRawRoom);
}

export function coalesceMessages(messages = []) {
  const result = [];
  for (const message of messages) {
    const text = typeof message === "string" ? message : message.text;
    const from = typeof message === "string" ? "peer-mailbox" : message.from || "peer-mailbox";
    const last = result.at(-1);
    if (last?.text === text && last.from === from) last.count++;
    else result.push({ from, text, count: 1 });
  }
  return result;
}
