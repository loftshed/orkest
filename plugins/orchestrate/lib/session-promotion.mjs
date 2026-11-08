import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { herdrEndpoint } from "./herdr-context.mjs";
import { createRoom, listRawRooms, mailboxRoot, readRoom, updateRoom } from "./horde-room.mjs";
import {
  coordinatorBrief,
  hasOtherLiveOwner,
  isLocalSessionBinding,
  isPeerLive,
  ownsSessionBinding,
  rememberSession,
  resolveSessionPeer,
  roomOwnerSessions,
  sessionIdentities,
  writeCoordinatorBrief,
} from "./rooms.mjs";

const execute = promisify(execFile);
const statusline = fileURLToPath(
  new URL("../skills/orchestrate/scripts/agent_statusline.py", import.meta.url),
);
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const ENGINES = new Set(["codex", "claude", "agy", "opencode"]);

function sessionKey(session) {
  if (typeof session !== "string" || !SESSION_ID.test(session))
    throw new Error("Pass the actual native session ID with --session");
  const key = session.replaceAll(":", "%3A");
  if (session === session.toLowerCase() && key.length <= 128) return key;
  return `${key.slice(0, 128)}~${createHash("sha1").update(session).digest("hex").slice(0, 10)}`;
}

function isSameSession(binding, peer, engine, checkout) {
  return (
    binding?.id === peer.session &&
    binding.engine === engine &&
    binding.machine === hostname() &&
    path.resolve(binding.cwd || "") === checkout
  );
}

async function currentPeer(root, session, cwd, env, now, expectedEngine) {
  let peer;
  try {
    const peerFile = path.join(root, "peers", `${sessionKey(session)}.json`);
    peer =
      (await resolveSessionPeer(session, root, {
        now,
        cwd: cwd || process.cwd(),
        engine: expectedEngine || env.ORKEST_TERMINAL_HARNESS,
      })) || JSON.parse(await readFile(peerFile, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT")
      throw new Error(
        "Register this live interactive session with the peer mailbox before promoting it",
        { cause: error },
      );
    throw error;
  }
  const engine = peer?.harness === "gemini" ? "agy" : peer?.harness;
  if (
    !peer ||
    peer.schema !== "agent-executor.peer.v1" ||
    !sessionIdentities(peer, root).includes(session) ||
    typeof peer.name !== "string" ||
    typeof peer.cwd !== "string" ||
    !Number.isFinite(Date.parse(peer.startedAt)) ||
    !ENGINES.has(engine)
  )
    throw new Error("The registered session identity is invalid or uses an unsupported harness");
  if (peer.isSubagent || peer.delegatedRun || peer.run || session.startsWith("run-"))
    throw new Error("A delegated worker cannot promote itself to root coordinator");
  if ((peer.machine && peer.machine !== hostname()) || !isPeerLive(peer, now))
    throw new Error("The registered session is not live on this machine");
  const checkout = await realpath(peer.checkout || peer.cwd);
  const workingCwd = await realpath(cwd || process.cwd());
  const relative = path.relative(checkout, workingCwd);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error("The live session belongs to a different checkout");
  if (env.HERDR_PANE_ID && peer.herdrPaneId && env.HERDR_PANE_ID !== peer.herdrPaneId)
    throw new Error("The live session belongs to a different terminal pane");
  if (env.HERDR_ENV === "1" && peer.herdrPaneId && peer.herdrEndpoint !== herdrEndpoint(env))
    throw new Error("The live session belongs to a different Herdr server");
  return { peer, engine, checkout };
}

export async function refreshPromotedTerminal({ peer, room, root, env = process.env }) {
  const { stdout } = await execute(
    "python3",
    [
      statusline,
      "--native-status",
      "--refresh-terminal",
      "--session",
      peer.session,
      "--harness",
      peer.harness,
      "--json",
    ],
    {
      env: {
        ...env,
        ORCHESTRATE_HOME: path.dirname(root),
        AGENT_EXECUTOR_HOME: path.dirname(root),
        ORKEST_SWARM_ROOM: room.id,
      },
      timeout: 5000,
      maxBuffer: 64 * 1024,
    },
  );
  return { attempted: true, ...(stdout.trim() && { status: JSON.parse(stdout) }) };
}

/** Adopt the caller's running conversation; this never launches a replacement harness. */
export async function promoteSession(
  { session, room: explicitRoom, cwd, objective, engine: requestedEngine } = {},
  {
    env = process.env,
    root = mailboxRoot(env),
    now = Date.now(),
    refresh = refreshPromotedTerminal,
  } = {},
) {
  session ||= [
    "AGENT_MAILBOX_SESSION",
    "CODEX_THREAD_ID",
    "CLAUDE_CODE_SESSION_ID",
    "ANTIGRAVITY_CONVERSATION_ID",
    "OPENCODE_SESSION_ID",
  ]
    .map((key) => env[key])
    .find(Boolean);
  const { peer, engine, checkout } = await currentPeer(
    root,
    session,
    cwd,
    env,
    now,
    requestedEngine,
  );
  if (requestedEngine && requestedEngine !== engine)
    throw new Error("The requested engine differs from the registered live session");
  if (
    objective !== undefined &&
    (typeof objective !== "string" || !objective.trim() || objective.length > 12_000)
  )
    throw new Error("Objective must contain 1–12000 characters");
  const isResume = env.ORKEST_RESUME_SWARM === "1";
  const resumeTarget = env.ORKEST_RESUME_TARGET;
  const available = (room) => room && !room.closedAt && room.status !== "closed";
  const sameCheckout = async (room) => {
    if (!isLocalSessionBinding(room)) return false;
    let roomCwd;
    try {
      roomCwd = await realpath(room.cwd);
    } catch {
      roomCwd = path.resolve(room.cwd);
    }
    return roomCwd === checkout;
  };
  const mayResume = async (room) =>
    isResume &&
    available(room) &&
    (await sameCheckout(room)) &&
    room.conductor?.engine === engine &&
    !room.authority &&
    (room.id === env.ORKEST_SWARM_ROOM || roomOwnerSessions(room).includes(resumeTarget)) &&
    !(await hasOtherLiveOwner(room, peer, root));
  const mayReuse = async (room) =>
    available(room) &&
    room.conductor?.engine === engine &&
    (await sameCheckout(room)) &&
    ((await ownsSessionBinding(room, peer, root)) || (await mayResume(room)));
  let roomId = explicitRoom;
  if (!roomId && env.ORKEST_SWARM_ROOM) {
    try {
      const current = await readRoom(env.ORKEST_SWARM_ROOM, root);
      if (await mayReuse(current)) roomId = current.id;
      else if (isResume && available(current) && (await sameCheckout(current)))
        throw new Error(
          "This room already has another coordinator; use the explicit leadership handoff workflow",
        );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  if (!roomId) {
    for (const room of listRawRooms(root)) {
      if (await mayReuse(room)) {
        roomId = room.id;
        break;
      }
    }
  }
  const association = createHash("sha256")
    .update(JSON.stringify([peer.session, peer.harness, hostname(), checkout, peer.startedAt]))
    .digest("hex")
    .slice(0, 24);
  roomId ||= `conversation-${association}`;
  let previous;
  try {
    previous = await readRoom(roomId, root);
  } catch (error) {
    if (error.code !== "ENOENT" || explicitRoom) throw error;
  }
  const promote = async (existing) => {
    const room = existing || createRoom([], { id: roomId, cwd: checkout, engine, now });
    if (!(await sameCheckout(room)))
      throw new Error("The target room belongs to a different machine or checkout");
    const binding = room.conductor?.session;
    if (!available(room)) throw new Error("Cannot promote into a closed room");
    const owned = await ownsSessionBinding(room, peer, root);
    const resuming = await mayResume(room);
    if (binding && !owned && !resuming)
      throw new Error(
        "This room already has another coordinator; use a new room or the explicit leadership handoff workflow",
      );
    if (room.authority && !isSameSession(binding, peer, engine, checkout))
      throw new Error(
        "An authority-managed room requires its existing leadership handoff workflow",
      );
    if (
      !explicitRoom &&
      !env.ORKEST_SWARM_ROOM &&
      existing &&
      !owned &&
      !resuming &&
      room.promotion?.association !== association
    )
      throw new Error("This conversation's promotion room has a different owner");
    const matching = room.agents.filter((member) =>
      isSameSession(member.session, peer, engine, checkout),
    );
    const ids = new Set(matching.map((member) => member.id));
    room.agents = room.agents.filter((member) => !ids.has(member.id));
    for (const member of room.agents) if (ids.has(member.parent)) member.parent = "conductor";
    room.machine = hostname();
    room.group ||= path.basename(checkout);
    if (objective !== undefined) {
      room.objective = objective.trim();
      room.title = objective.replaceAll(/\s+/gu, " ").trim().slice(0, 160);
    }
    room.title ||= peer.focus || "Current conversation";
    rememberSession(room.conductor, peer.session, [room.promotion?.session]);
    room.conductor = {
      ...room.conductor,
      engine,
      role: "lead",
      status: peer.state === "busy" ? "working" : "idle",
      name: peer.name,
      ...(peer.person && { person: peer.person }),
      ...(peer.model && { model: peer.model }),
      ...(peer.effort && { effort: peer.effort }),
      session: { id: peer.session, engine, machine: hostname(), cwd: checkout },
      ...(peer.herdrPaneId && { herdrPaneId: peer.herdrPaneId }),
      ...(peer.herdrEndpoint && { herdrEndpoint: peer.herdrEndpoint }),
      ...(peer.herdrWorkspaceId && { herdrWorkspaceId: peer.herdrWorkspaceId }),
      ...(peer.paneId && { paneId: peer.paneId }),
      ...(peer.terminalServer && { terminalServer: peer.terminalServer }),
    };
    room.promotion = { association, session: peer.session, startedAt: peer.startedAt };
    if (peer.herdrPaneId) room.herdrCoordinatorPaneId = peer.herdrPaneId;
    if (peer.herdrEndpoint) room.herdrEndpoint = peer.herdrEndpoint;
    if (peer.herdrWorkspaceId) room.herdrWorkspaceId = peer.herdrWorkspaceId;
    return room;
  };
  let promoted;
  try {
    promoted = await updateRoom(roomId, promote, { root, create: !previous });
  } catch (error) {
    if (previous || !error.message.startsWith("Room already exists:")) throw error;
    promoted = await updateRoom(roomId, promote, { root });
  }
  let briefPath;
  const brief = coordinatorBrief(promoted, "conductor")
    .split("YOUR_ACTUAL_SESSION_ID")
    .join(peer.session)
    .trim();
  try {
    briefPath = await writeCoordinatorBrief(promoted, { root });
  } catch {
    briefPath = null;
  }
  let nativeMetadata;
  try {
    nativeMetadata = await refresh({ peer, room: promoted, root, env });
  } catch (error) {
    nativeMetadata = { attempted: true, error: error.message };
  }
  return {
    status: "promoted",
    room: promoted,
    session: peer.session,
    engine,
    briefPath,
    brief,
    nativeMetadata,
  };
}
