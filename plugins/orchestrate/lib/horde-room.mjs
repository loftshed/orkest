import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { cacheHome } from "./runtime-paths.mjs";

export const ROOM_SCHEMA = "agent-executor.room.v1";
const ID = /^[\w-]{1,80}$/u;
const ENGINES = new Set(["claude", "agy", "codex", "opencode"]);
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);

export const WORKFORCE_ROLES = JSON.parse(
  readFileSync(
    new URL("../skills/orchestrate/references/workforce-roles.json", import.meta.url),
    "utf8",
  ),
);
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
    let model = tier;
    if (engine === "codex" && ["luna", "sol", "terra", "astra"].includes(tier))
      model = `gpt:${tier}`;
    if (
      engine === "agy" &&
      [
        "fast",
        "flash",
        "flash-low",
        "flash-high",
        "pro",
        "argon",
        "argon-low",
        "argon-high",
      ].includes(tier)
    )
      model = tier === "flash" ? "gemini:fast" : `gemini:${tier}`;
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

export async function readRoom(id, root) {
  const text = await readFile(roomPath(id, root), "utf8");
  const room = validateRoom(JSON.parse(text));
  if (room.id !== id) throw new Error("Room identity does not match its filename");
  return room;
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

async function isStaleRoomLock(lock) {
  try {
    const rawOwner = await readFile(path.join(lock, "owner"), "utf8");
    const owner = Math.trunc(Number(rawOwner.trim()));
    if (Number.isSafeInteger(owner) && owner > 0) return !pidAlive(owner);
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

/** Atomic replacement under a bounded, exclusive lock prevents concurrent spawns losing members. */
export async function updateRoom(id, update, { root = mailboxRoot(), create = false } = {}) {
  const file = roomPath(id, root);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  const deadline = Date.now() + 3000;
  for (;;) {
    try {
      await mkdir(lock);
      await writeFile(path.join(lock, "owner"), `${process.pid}\n`);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (await isStaleRoomLock(lock)) {
        await rm(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`Room is locked: ${id}`, { cause: error });
      await sleep(25);
    }
  }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    let previous;
    try {
      previous = await readRoom(id, root);
    } catch (error) {
      if (!create || error.code !== "ENOENT") throw error;
    }
    if (create && previous) throw new Error(`Room already exists: ${id}`);
    const room = validateRoom(await update(previous));
    if (room.id !== id) throw new Error("Cannot change room identity");
    room.updatedAt = Date.now();
    await writeFile(temporary, `${JSON.stringify(room, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, file);
    return room;
  } finally {
    await rm(temporary, { force: true });
    await rm(lock, { recursive: true, force: true });
  }
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
