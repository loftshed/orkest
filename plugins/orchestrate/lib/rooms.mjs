import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { cacheHome } from "./runtime-paths.mjs";
import {
  addMembers,
  createRoom,
  detectWorktree,
  mailboxRoot,
  normalizeWorkforceRole,
  readRoom,
  refreshMemberWorktrees,
  resolveWorktreeMarkerPath,
  updateRoom,
  WORKFORCE_ROLES,
  workforceRoleInfo,
} from "./stooges-room.mjs";

const execute = promisify(execFile);
const plugin = fileURLToPath(new URL("../", import.meta.url));
const coordinatorPath = fileURLToPath(
  new URL("../skills/orchestrate/scripts/coordinator.py", import.meta.url),
);
const authorityPath = fileURLToPath(
  new URL("../skills/orchestrate/scripts/authority.py", import.meta.url),
);

const RUN_FIELDS = [
  "run_id",
  "request_id",
  "status",
  "runner_status",
  "engine",
  "transport",
  "result_path",
  "mailbox",
  "model",
  "effort",
  "native_handle",
  "recovery",
];
const TASK_STATES = {
  reserved: "reserved",
  active: "running",
  finished: "review",
  cancelled: "cancelled",
};
const TASK_VERDICTS = {
  accept: "completed",
  supported: "completed",
  reject: "rejected",
  takeover: "blocked",
};
const PROGRESS_STAGES = new Set([
  "planning",
  "working",
  "testing",
  "review",
  "blocked",
  "complete",
]);
const STATUS_COLORS = [31, 32, 33, 34, 35, 36];
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const MAX_PEER_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const UNKNOWN_PID_TTL_MS = 2 * 60 * 60 * 1000;
const SHARED_PROCESS_IDLE_TTL_MS = 3 * 60 * 60 * 1000;
const SHARED_PROCESS_BUSY_TTL_MS = 30 * 60 * 1000;
const PROGRESS_STALE_AFTER_MS = 30 * 60 * 1000;

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function readOptionalJson(filePath, maxBytes = 4 * 1024 * 1024) {
  try {
    const info = await stat(filePath);
    if (!info.isFile() || info.size > maxBytes) return null;
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function resolveCwd(cwd) {
  if (cwd === undefined) return;
  try {
    return await realpath(cwd);
  } catch {
    return path.resolve(cwd);
  }
}

export function memberOf(room, id = "conductor") {
  const member = id === "conductor" ? room.conductor : room.agents.find((agent) => agent.id === id);
  if (!member) throw new Error(`Unknown member: ${id}`);
  return member;
}

export { memberOf as swarmMember };

export function requireActiveBranch(room, id) {
  for (let current = id; current;) {
    const member = memberOf(room, current);
    if (member.paused)
      throw new Error(`Swarm branch ${current} is paused; resume it before launching work`);
    current = current === "conductor" ? null : member.parent || "conductor";
  }
}

/** One room owns the hierarchy and its limits. A native lead is not an audited worker. */
export function coordinatorBrief(room, memberId = "conductor") {
  const member = memberOf(room, memberId);
  const objective = member.objective || room.objective || "Ask the user what outcome they want.";
  const roleInfo = workforceRoleInfo(member.workforceRole);
  const workingFolder = member.cwd || room.cwd;
  const roleList = Object.keys(WORKFORCE_ROLES).join(", ");
  return `You are the ${memberId === "conductor" ? "root coordinator" : "subswarm lead"} of an Orkest swarm.

Room: ${room.id}
Your member ID: ${memberId}
Parent: ${member.parent || "user"}
Repository: ${room.cwd}
Working folder: ${workingFolder}${roleInfo ? `\nWorkforce role: ${roleInfo.id} — ${roleInfo.guidance}` : ""}
Overall objective: ${room.objective || "Awaiting the user's objective"}
Your assignment: ${objective}
${
  !room.objective && memberId === "conductor"
    ? `
If the user has already supplied their goal in this conversation, record it with ork rooms objective --room ${room.id}
--objective 'their goal', then organize the work. Otherwise, ask the user for their goal and wait for it before creating work assignments or starting workers.
`
    : ""
}

Read repository instructions first. Use programmatic tools before computer use. Use computer use only
for work that requires a graphical interface or when the user explicitly requests it. Preserve this
rule in every delegated brief. The objective authorizes relevant delegation, not unrelated work,
publication, billing changes, or takeover of another session.

Read ${path.join(plugin, "skills/orchestrate/references/swarm.md")} now. It describes the commands and
native supervision contract. Use ${path.join(plugin, "bin/ork.mjs")} through node if ork is not on PATH.

Bind your actual native session with ork rooms bind --room ${room.id} --member ${memberId}
--engine ${member.engine} --session YOUR_ACTUAL_SESSION_ID. Never guess a session ID.
Keep ork progress current with the overall objective, your current task, and actual stage.
Preset workforce roles (${roleList}) can be assigned with @role in --team, ork rooms role --room ${room.id}
--member MEMBER --role ROLE, or assumed on the fly with ork progress --session YOUR_ACTUAL_SESSION_ID --role ROLE.

You own planning, assignment, resolving conflicts, and reviewing results for your branch. Keep the
conversation available while workers run. Prefer bounded, useful tasks over spawning a preset team
without work. Check native tools and the live model catalog and quota before choosing workers.
Existing peer presence does not make a peer available; do not commandeer unrelated sessions.

All descendants belong to this SAME room. Add workers with --parent ${memberId}. The room has
${room.swarm.maxAgents} member slots shared by all branches and a maximum depth of ${room.swarm.maxDepth}.
These are roster limits, not hard spending caps. Task deadlines and invocation allowances still apply.
Never create a new room or dispatch outside this room to evade its limits.

For a substantial independent branch, add a member using your own engine, then use ork rooms lead
--room ${room.id} --member MEMBER --objective 'bounded outcome'. It reserves a native lead and returns
its brief. Spawn it ONCE only for native_handoff, using your native subagent tool. Bind the actual
native session ID; if the tool returns only a handle, supervise that handle and let the child bind
its own session. Never use a tool handle or nickname as a guessed session ID.
Use inherited model settings unless an explicit, supported model choice is authorized. Leads may
repeat this within the shared room limits. Never launch a peer CLI inside an audited worker job.

Leaf work uses ork rooms init-task and dispatch, which preserve the existing runner's scope, leases,
deadlines, evidence and review. Native workers use --transport native and your native supervision
tools; other harnesses use executor transport. Use background dispatch and return to the user while
work runs. Do not hold a writer lease as a lead while waiting for children to edit that checkout.
Resolve write ownership before work begins; independent concurrent edits need separate worktrees
and explicit integration ownership. For this room, mutating worker runs remain serialized.

Read results, recover finished runs and verify acceptance before declaring success. A lead's idle or
reported complete status is not acceptance. Use the existing workboard for native lead assignments
and review; do not duplicate coordinator tasks there. Report blockers to your parent through native
messaging. A root coordinator reports the combined verified outcome to the user.

When the user redirects or pauses a branch, stop new dispatch with ork rooms pause. This does not
interrupt active work: use native interruption for native handles and coordinator cancellation for
executor runs you own, then collect their results. Never stop another user's terminal or process.
`;
}

export async function writeCoordinatorBrief(room, { root = mailboxRoot() } = {}) {
  const directory = path.join(root, "swarm-briefs", room.id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, "conductor.md");
  await writeFile(target, coordinatorBrief(room, "conductor"), { mode: 0o600 });
  return target;
}

export async function reserveLead(
  id,
  memberId,
  objective,
  { root = mailboxRoot(), workforceRole, cwd } = {},
) {
  if (typeof objective !== "string" || !objective.trim() || objective.length > 12_000)
    throw new Error("A lead needs an objective of 1–12000 characters");
  if (memberId === "conductor") throw new Error("The root coordinator is already a lead");
  const normalizedRole =
    workforceRole === undefined ? undefined : normalizeWorkforceRole(workforceRole);
  const normalizedCwd = await resolveCwd(cwd);
  let isNew = false;
  const room = await updateRoom(
    id,
    (current) => {
      if (!current.swarm) throw new Error("Native leads require a conversational swarm room");
      requireActiveBranch(current, memberId);
      const member = memberOf(current, memberId);
      const parent = memberOf(current, member.parent || "conductor");
      if (member.engine !== parent.engine)
        throw new Error(
          "Subswarm leads use their parent's native harness; cross-harness agents are workers",
        );
      if (member.dispatch) throw new Error("An audited worker cannot become a lead");
      if (member.role === "lead" && member.objective !== objective)
        throw new Error(
          "A lead already has an assignment; use its native conversation to redirect it",
        );
      isNew = member.role !== "lead";
      member.role = "lead";
      member.objective = objective;
      if (normalizedRole) member.workforceRole = normalizedRole;
      if (normalizedCwd) member.cwd = normalizedCwd;
      member.status = "reserved";
      return current;
    },
    { root },
  );
  const member = memberOf(room, memberId);
  const directory = path.join(root, "swarm-briefs", room.id);
  let briefPath = path.join(directory, `${memberId}.md`);
  const brief = coordinatorBrief(room, memberId);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(briefPath, brief, { mode: 0o600 });
  } catch {
    // The inline brief still delivers this reservation if its optional file cannot be saved.
    briefPath = null;
  }
  let status = isNew ? "native_handoff" : "pending_attachment";
  let next = isNew
    ? "Spawn once through your native tools, then bind its actual session before any retry."
    : "An earlier reservation has no attached session. Recover its outcome through native tools; do not spawn again.";
  if (member.session) {
    status = "attached";
    next = "Continue supervising the existing native session; do not spawn again.";
  }
  return {
    status,
    member: memberId,
    engine: member.engine,
    session: member.session || null,
    briefPath,
    brief,
    next,
  };
}

export async function pauseBranch(
  id,
  memberId = "conductor",
  isPaused = true,
  { root = mailboxRoot() } = {},
) {
  return updateRoom(
    id,
    (room) => {
      memberOf(room, memberId).paused = isPaused;
      return room;
    },
    { root },
  );
}

export async function resumeBranch(id, memberId = "conductor", options = {}) {
  return pauseBranch(id, memberId, false, options);
}

export async function assignWorkforceRole(id, memberId, role, { root = mailboxRoot(), cwd } = {}) {
  if (role === undefined && cwd === undefined)
    throw new Error("Supply a workforce --role or --cwd to update the member");
  const isClearingRole =
    typeof role === "string" && ["", "none", "clear"].includes(role.trim().toLowerCase());
  const normalizedRole =
    role === undefined || isClearingRole ? undefined : normalizeWorkforceRole(role);
  const normalizedCwd = await resolveCwd(cwd);
  return updateRoom(
    id,
    (room) => {
      const member = memberOf(room, memberId);
      if (isClearingRole) delete member.workforceRole;
      else if (normalizedRole) member.workforceRole = normalizedRole;
      if (normalizedCwd) member.cwd = normalizedCwd;
      return room;
    },
    { root },
  );
}

/** The team's current lead and generation; the authority record is written only by authority.py. */
export async function authorityShow(team) {
  try {
    const { stdout } = await execute("python3", [authorityPath, "show", "--team", team], {
      maxBuffer: 8 * 1024 * 1024,
      timeout: 30_000,
    });
    const { authority } = JSON.parse(stdout);
    return {
      team,
      generation: authority.generation,
      status: authority.status,
      lead: authority.lead,
      offer: authority.offer?.to,
    };
  } catch (error) {
    return { team, error: error.stderr?.trim() || error.message };
  }
}

/** Coordinator arguments naming the caller as the team's lead at a generation. */
function leadArgs(options) {
  if (!options.leadSession) return [];
  return [
    "--lead-session",
    options.leadSession,
    "--lead-generation",
    String(options.leadGeneration),
  ];
}

export async function coordinator(args) {
  try {
    const { stdout } = await execute("python3", [coordinatorPath, ...args], {
      maxBuffer: 8 * 1024 * 1024,
      timeout: 30_000,
    });
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(error.stderr?.trim() || error.message, { cause: error });
  }
}

function compactTask(task) {
  if (!isPlainObject(task)) throw new Error("expected JSON object");
  if (task.schema !== "agent-executor.task.v1") throw new Error("unsupported task schema");
  const { runs, decisions } = task;
  if (!Array.isArray(runs) || !Array.isArray(decisions))
    throw new Error("Task runs and decisions must be lists");
  const result = {};
  for (const key of ["schema", "task_id", "repository", "updated_at", "authority"]) {
    if (Object.hasOwn(task, key)) result[key] = task[key];
  }
  if (isPlainObject(task.task_spec)) {
    result.task_spec = { objective: task.task_spec.objective };
  }
  result.runs = runs.filter(isPlainObject).map((run) => {
    const picked = {};
    for (const field of RUN_FIELDS) {
      if (Object.hasOwn(run, field)) picked[field] = run[field];
    }
    return picked;
  });
  result.decisions = decisions.filter(isPlainObject).map((decision) => {
    const picked = {};
    for (const field of ["run_id", "decision"]) {
      if (Object.hasOwn(decision, field)) picked[field] = decision[field];
    }
    return picked;
  });
  return result;
}

async function loadCompactedTask(directory) {
  const resolvedDir = await realpath(directory);
  const raw = JSON.parse(await readFile(path.join(resolvedDir, "task.json"), "utf8"));
  if (!isPlainObject(raw)) throw new Error("expected JSON object");
  if (!raw.authority) {
    const authority = await readOptionalJson(path.join(resolvedDir, "authority.json"));
    if (authority) raw.authority = authority;
  }
  if (Array.isArray(raw.runs)) {
    const topReady = await readOptionalJson(path.join(resolvedDir, "ready.json"));
    for (const run of raw.runs) {
      if (
        !isPlainObject(run) ||
        typeof run.run_id !== "string" ||
        !run.run_id ||
        run.transport !== "native" ||
        run.process_identity
      )
        continue;
      const ready =
        (await readOptionalJson(path.join(resolvedDir, "runs", run.run_id, "ready.json"))) ||
        (topReady?.run_id === run.run_id ? topReady : null);
      if (ready?.run_id !== run.run_id) {
        continue;
      }

      if (ready.pid !== undefined) run.pid = ready.pid;
      if (ready.process_identity !== undefined) run.process_identity = ready.process_identity;
    }
  }
  return compactTask(raw);
}

async function projectMemberTask(cwd, member, task) {
  const binding = member.dispatch;
  if (
    !isPlainObject(task) ||
    task.schema !== "agent-executor.task.v1" ||
    task.task_id !== binding.taskId ||
    typeof task.repository !== "string"
  )
    throw new Error("Task identity changed");
  const expectedCwd = typeof member.cwd === "string" && member.cwd ? member.cwd : cwd;
  const [resolvedRepo, resolvedExpected] = await Promise.all([
    realpath(task.repository),
    realpath(expectedCwd),
  ]);
  if (resolvedRepo !== resolvedExpected) throw new Error("Task identity changed");
  if (!Array.isArray(task.runs) || !Array.isArray(task.decisions))
    throw new Error("Task runs and decisions must be lists");
  const matches = task.runs.filter(
    (run) => isPlainObject(run) && run.request_id === binding.requestId,
  );
  if (matches.length !== 1)
    throw new Error("Dispatch has no unique recorded run; retry the same dispatch to recover");
  const run = matches[0];
  if (typeof run.run_id !== "string" || !run.run_id) throw new Error("Run identity changed");
  if (binding.runId && run.run_id !== binding.runId) throw new Error("Run identity changed");
  if (run.engine !== member.engine || run.transport !== binding.transport)
    throw new Error("Run executor differs from room member");
  const decisions = task.decisions.filter(
    (decision) => isPlainObject(decision) && decision.run_id === run.run_id,
  );
  const verdict = (decisions.length > 0 ? decisions.at(-1).decision : null) || "pending";
  let state = TASK_STATES[run.status] || "unknown";
  if (run.runner_status && run.runner_status !== "completed") state = "failed";
  state = TASK_VERDICTS[verdict] || state;
  const spec = isPlainObject(task.task_spec) ? task.task_spec : null;
  return {
    run,
    status: state,
    verdict,
    observedAt: task.updated_at,
    objective: spec ? spec.objective : null,
  };
}

async function roomTasks(request) {
  const tasks = { ...request.tasks };
  const errors = { ...request.errors };
  const members = {};
  for (const member of request.members) {
    const directory = member.dispatch.taskDir;
    if (!Object.hasOwn(tasks, directory) && !Object.hasOwn(errors, directory)) {
      try {
        tasks[directory] = await loadCompactedTask(directory);
      } catch (error) {
        errors[directory] = error.message;
      }
    } else if (Object.hasOwn(tasks, directory)) {
      try {
        tasks[directory] = compactTask(tasks[directory]);
      } catch (error) {
        delete tasks[directory];
        errors[directory] = error.message;
      }
    }
    try {
      if (Object.hasOwn(errors, directory)) throw new Error(errors[directory]);
      members[member.id] = {
        projection: await projectMemberTask(request.cwd, member, tasks[directory]),
      };
    } catch (error) {
      members[member.id] = { error: error.message };
    }
  }
  return { tasks, members };
}

export async function listRooms(root = mailboxRoot()) {
  let files;
  try {
    files = await readdir(path.join(root, "rooms"));
  } catch (error) {
    if (error.code === "ENOENT") return { rooms: [], errors: [] };
    throw error;
  }
  const rooms = [];
  const errors = [];
  files.sort((a, b) => a.localeCompare(b));
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      rooms.push(await readRoom(file.slice(0, -5), root));
    } catch (error) {
      errors.push({ file, error: error.message });
    }
  }
  return { rooms, errors };
}

export async function newRoom(
  members,
  {
    id = randomUUID(),
    cwd,
    group,
    title,
    authority,
    swarm = { maxAgents: 64, maxDepth: 8 },
    objective,
    engine,
    root = mailboxRoot(),
  } = {},
) {
  const conductorEngine = engine || members?.[0]?.engine || "codex";
  const room = createRoom(members, {
    id,
    cwd: await realpath(cwd || process.cwd()),
    swarm,
    engine: conductorEngine,
  });
  room.group = group || path.basename(room.cwd);
  room.title = title || room.id;
  room.machine = hostname();
  if (authority) room.authority = authority;
  if (swarm) {
    room.swarm = swarm;
    room.objective = objective || "";
    room.conductor = {
      engine: conductorEngine,
      role: "lead",
      status: "awaiting session",
      ...(room.conductor?.worktree && { worktree: room.conductor.worktree }),
    };
  }
  return updateRoom(id, () => room, { root, create: true });
}

export async function growRoom(
  id,
  members,
  root = mailboxRoot(),
  parent = "conductor",
  options = {},
) {
  const cwd = options.cwd ? await realpath(options.cwd) : undefined;
  return updateRoom(
    id,
    (room) => addMembers(room, members, { parent, workforceRole: options.workforceRole, cwd }),
    { root },
  );
}

/** An explicit binding is a session reference, never permission to prompt that session. */
export async function bindSession(
  id,
  memberId,
  { session, engine, cwd, workforceRole, root = mailboxRoot() },
) {
  if (!session || !["claude", "codex", "agy", "opencode"].includes(engine))
    throw new Error("Session binding requires a session ID and supported engine");
  const resolvedCwd = cwd ? await realpath(cwd) : undefined;
  return updateRoom(
    id,
    (room) => {
      const member = memberOf(room, memberId);
      if (member.engine && member.engine !== engine)
        throw new Error("Session engine differs from room member");
      if (member.role === "lead" && member.session && member.session.id !== session)
        throw new Error(
          "This lead already has a native session; continue supervising that session",
        );
      if (resolvedCwd) member.cwd = resolvedCwd;
      if (workforceRole !== undefined) {
        const normalized = normalizeWorkforceRole(workforceRole);
        if (normalized) member.workforceRole = normalized;
        else delete member.workforceRole;
      }
      member.session = {
        id: session,
        engine,
        machine: hostname(),
        cwd: resolvedCwd || member.cwd || room.cwd,
      };
      return room;
    },
    { root },
  );
}

/** Promote a disposable agent worktree to a persistent folder in both gitdir metadata and room state. */
export async function keepWorktree(id, memberId = "conductor", { root = mailboxRoot(), cwd } = {}) {
  const resolvedCwd = cwd ? await realpath(cwd) : undefined;
  return updateRoom(
    id,
    async (room) => {
      const member = memberOf(room, memberId);
      if (resolvedCwd) member.cwd = resolvedCwd;
      const targetCwd =
        resolvedCwd ||
        member.worktree?.path ||
        member.progress?.cwd ||
        member.cwd ||
        member.session?.cwd ||
        (member === room.conductor ? room.cwd : undefined);
      const detected = detectWorktree(targetCwd, member.worktree, room.cwd);
      const markerPath = resolveWorktreeMarkerPath(targetCwd);
      if (markerPath) {
        try {
          const marker = JSON.parse(await readFile(markerPath, "utf8"));
          if (marker && typeof marker === "object") {
            marker.disposable = false;
            await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
          }
        } catch {
          // Worktree marker file is optional when promoting an in-memory worktree binding.
        }
      }
      const base =
        detected ||
        member.worktree ||
        (targetCwd ? { path: targetCwd, slug: path.basename(targetCwd) } : {});
      member.worktree = {
        ...base,
        ...(targetCwd && !base.path && { path: targetCwd }),
        ...(targetCwd && !base.slug && { slug: path.basename(targetCwd) }),
        disposable: false,
      };
      return room;
    },
    { root },
  );
}

/** Persist intent before coordinator dispatch; retries use the same task and request. */
export async function dispatchMember(id, memberId, options = {}) {
  const { root = mailboxRoot(), run = coordinator } = options;
  const directory = await realpath(options.taskDir);
  const task = await run(["show", "--task-dir", directory]);
  if (task.schema !== "agent-executor.task.v1" || typeof task.task_id !== "string")
    throw new Error("Unsupported coordinator task");
  const room = await readRoom(id, root);
  const targetMember =
    memberId === "conductor" ? room.conductor : room.agents.find((agent) => agent.id === memberId);
  const resolvedMemberCwd = options.cwd
    ? await realpath(options.cwd)
    : await realpath(targetMember?.cwd || room.cwd);
  if ((await realpath(task.repository)) !== resolvedMemberCwd)
    throw new Error("Task repository differs from room checkout");
  // A room under a team only runs that team's tasks, so a superseded lead cannot dodge the fence here.
  if (room.authority && task.authority?.team !== room.authority)
    throw new Error(
      `Task is not under the room's team ${room.authority}; init it with --authority`,
    );
  const effectiveRole = options.workforceRole ?? targetMember?.workforceRole;
  const kind = options.kind || workforceRoleInfo(effectiveRole)?.defaultKind || "investigation";
  if (!["implementation", "investigation", "consultation", "challenge"].includes(kind))
    throw new Error("Unsupported dispatch kind");
  const transport = options.transport || "executor";
  if (!["executor", "native"].includes(transport))
    throw new Error("Unsupported dispatch transport");
  const intent = {
    taskDir: directory,
    taskId: task.task_id,
    requestId: options.requestId || randomUUID(),
    kind,
    transport,
    billingMode: options.billingMode || "unknown",
    ...(options.packet && { packet: await realpath(options.packet) }),
  };
  const saved = await updateRoom(
    id,
    (current) => {
      if (memberId === "conductor") throw new Error("Dispatch a worker, not the conductor");
      const member = memberOf(current, memberId);
      if (member.role === "lead")
        throw new Error("A subswarm lead uses native supervision, not worker dispatch");
      if (!member.dispatch) requireActiveBranch(current, memberId);
      if (options.cwd) member.cwd = resolvedMemberCwd;
      if (options.workforceRole !== undefined) {
        const normalized = normalizeWorkforceRole(options.workforceRole);
        if (normalized) member.workforceRole = normalized;
        else delete member.workforceRole;
      }
      if (member.dispatch) {
        for (const key of ["taskDir", "taskId", "kind", "transport", "billingMode", "packet"])
          if (member.dispatch[key] !== intent[key])
            throw new Error(`Existing dispatch differs: ${key}`);
        if (options.requestId && options.requestId !== member.dispatch.requestId)
          throw new Error("A member already has a dispatch; add a member for new work");
      } else {
        if (
          task.runs.some((entry) => entry.request_id === intent.requestId) ||
          current.agents.some(
            (entry) =>
              entry.id !== memberId &&
              entry.dispatch?.taskId === intent.taskId &&
              entry.dispatch?.requestId === intent.requestId,
          )
        )
          throw new Error("Request ID already belongs to another dispatch");
        member.dispatch = intent;
      }
      member.status = "unknown";
      return current;
    },
    { root },
  );
  const member = memberOf(saved, memberId);
  const binding = member.dispatch;
  const args = [
    "dispatch",
    "--task-dir",
    binding.taskDir,
    "--request-id",
    binding.requestId,
    "--kind",
    binding.kind,
    "--transport",
    binding.transport,
    "--engine",
    member.engine,
    "--model",
    member.model,
    "--billing-mode",
    binding.billingMode,
    "--background",
    ...leadArgs(options),
  ];
  if (member.effort) args.push("--effort", member.effort);
  if (binding.packet) args.push("--packet", binding.packet);
  let result;
  try {
    result = await run(args);
  } catch (error) {
    // The coordinator records a run before any side effect, so a refusal with no run for this
    // request launched nothing: clear the intent so the member can be dispatched again.
    let wasLaunched = true;
    try {
      const after = await run(["show", "--task-dir", binding.taskDir]);
      wasLaunched = after.runs.some((entry) => entry.request_id === binding.requestId);
    } catch {
      // Unknown outcome: keep the intent so retrying the same request can recover it.
    }
    await updateRoom(
      id,
      (current) => {
        const agent = memberOf(current, memberId);
        agent.dispatchError = error.message;
        if (!wasLaunched && agent.dispatch?.requestId === binding.requestId) {
          delete agent.dispatch;
          agent.status = "queued";
        }
        return current;
      },
      { root },
    );
    throw error;
  }
  await updateRoom(
    id,
    (current) => {
      const agent = memberOf(current, memberId);
      // A concurrent refused dispatch of this member may have cleared the intent; this one launched.
      agent.dispatch ||= binding;
      agent.dispatch.runId = result.run_id;
      delete agent.dispatchError;
      return current;
    },
    { root },
  );
  return {
    room: await observeRoom(id, { root, run, authority: options.authority }),
    dispatch: result,
  };
}

/** Read task snapshots through the coordinator. A terminal's idle state is never a verdict. */
export async function observeRoom(
  idOrRoom,
  {
    root = mailboxRoot(),
    run = coordinator,
    authority = authorityShow,
    tasks = new Map(),
    authorities = new Map(),
    progress = interactiveProgress,
  } = {},
) {
  const room = typeof idOrRoom === "string" ? await readRoom(idOrRoom, root) : idOrRoom;
  if (room.authority) {
    if (!authorities.has(room.authority))
      authorities.set(room.authority, await authority(room.authority));
    room.lead = authorities.get(room.authority);
  }
  const dispatched = room.agents.filter((member) => member.dispatch);
  if (dispatched.length > 0) await realpath(room.cwd);
  const taskErrors = new Map();
  if (run !== coordinator) {
    for (const { dispatch } of dispatched) {
      if (tasks.has(dispatch.taskDir) || taskErrors.has(dispatch.taskDir)) continue;
      try {
        tasks.set(dispatch.taskDir, await run(["show", "--task-dir", dispatch.taskDir]));
      } catch (error) {
        taskErrors.set(dispatch.taskDir, error.message);
      }
    }
  }
  const projections = new Map();
  const project = async (members) => {
    const directories = new Set(members.map((member) => member.dispatch.taskDir));
    const snapshot = await roomTasks({
      cwd: room.cwd,
      members: members.map(({ id, engine, dispatch, cwd }) => ({
        id,
        engine,
        dispatch,
        ...(cwd && { cwd }),
      })),
      tasks: Object.fromEntries([...tasks].filter(([directory]) => directories.has(directory))),
      errors: Object.fromEntries(
        [...taskErrors].filter(([directory]) => directories.has(directory)),
      ),
    });
    for (const [directory, task] of Object.entries(snapshot.tasks)) tasks.set(directory, task);
    for (const [id, projection] of Object.entries(snapshot.members))
      projections.set(id, projection);
  };
  if (dispatched.length > 0) {
    try {
      await project(dispatched);
    } catch (error) {
      if (dispatched.length === 1) {
        projections.set(dispatched[0].id, { error: error.message });
      } else {
        for (const member of dispatched) {
          try {
            await project([member]);
          } catch (memberError) {
            projections.set(member.id, { error: memberError.message });
          }
        }
      }
    }
  }
  for (const member of dispatched) {
    try {
      const item = projections.get(member.id);
      if (!item?.projection) throw new Error(item?.error || "Task snapshot unavailable");
      const { run: record, status, verdict, observedAt, objective } = item.projection;
      member.runId = record.run_id;
      member.transport = record.transport;
      member.resultPath = record.result_path;
      member.mailboxSession = record.mailbox?.worker;
      member.resolvedModel = record.model;
      member.resolvedEffort = record.effort;
      member.verdict = verdict;
      member.status = status;
      member.observedAt = observedAt ?? undefined;
      member.nativeHandle = record.native_handle;
      member.objective = objective ?? undefined;
      member.output = [
        member.objective,
        `Coordinator observed: ${member.observedAt || "unknown"}`,
        record.recovery,
        member.dispatchError,
        member.resultPath,
      ].filter(Boolean);
    } catch (error) {
      member.status = "unknown";
      member.output = [error.message];
    }
  }
  if (room.swarm) {
    const snapshots = await progress(room, root);
    for (const member of [room.conductor, ...room.agents]) {
      if (!member) continue;
      const key = member === room.conductor ? "conductor" : member.id;
      const snapshot = snapshots[key];
      if (snapshot) {
        member.progress = snapshot;
        member.name = snapshot.name;
        if (snapshot.role) member.workforceRole = snapshot.role;
        if (snapshot.cwd && (!member.worktree?.path || snapshot.cwd !== member.worktree.parentCwd))
          member.cwd = snapshot.cwd;
        if (!member.dispatch)
          member.status = snapshot.stage === "complete" ? "reported complete" : snapshot.stage;
      } else if (member.session && !member.dispatch) member.status = "session unavailable";
    }
  }
  return refreshMemberWorktrees(room);
}

function sessionKey(session) {
  if (typeof session !== "string" || !SESSION_ID_RE.test(session)) return null;
  const key = session.replaceAll(":", "%3A");
  if (session === session.toLowerCase() && key.length <= 128) return key;
  const digest = createHash("sha1").update(session).digest("hex").slice(0, 10);
  return `${key.slice(0, 128)}~${digest}`;
}

function cleanLine(value) {
  if (typeof value !== "string") return "";
  return [...value]
    .map((char) => {
      const code = char.codePointAt(0);
      return code >= 32 && code !== 127 ? char : " ";
    })
    .join("")
    .trim()
    .replaceAll(/\s+/gu, " ")
    .slice(0, 240);
}

function parseStampMs(value) {
  if (typeof value !== "string" || !value) return NaN;
  return Date.parse(value);
}

function pidAlive(pid) {
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function isValidPeer(peer) {
  return (
    isPlainObject(peer) &&
    peer.schema === "agent-executor.peer.v1" &&
    typeof peer.session === "string" &&
    typeof peer.name === "string" &&
    typeof peer.harness === "string" &&
    typeof peer.cwd === "string" &&
    Number.isFinite(parseStampMs(peer.startedAt)) &&
    Number.isFinite(parseStampMs(peer.lastSeenAt))
  );
}

function isPeerLive(peer, nowMs = Date.now()) {
  const seenMs = parseStampMs(peer.lastSeenAt || peer.startedAt);
  if (!Number.isFinite(seenMs)) return false;
  const alive = pidAlive(peer.pid);
  if (alive === false) return false;
  const ageMs = nowMs - seenMs;
  if (ageMs > MAX_PEER_AGE_MS) return false;
  if (alive && peer.sharedProcess) {
    if (peer.state === "idle") return ageMs <= SHARED_PROCESS_IDLE_TTL_MS;
    if (peer.state === "busy") return ageMs <= SHARED_PROCESS_BUSY_TTL_MS;
  }
  return alive ?? ageMs <= UNKNOWN_PID_TTL_MS;
}

function repositoryName(peer) {
  const raw = peer.repo || peer.checkout || peer.cwd || "";
  const base = path.basename(raw);
  return base === ".git" ? path.basename(path.dirname(raw)) : base;
}

async function readProgressRecord(root, key, peer, peerCwd, currentHost) {
  const candidates = [
    path.join(root, "progress", `${key}.json`),
    path.join(path.dirname(root), "progress-v1", `${key}.json`),
    path.join(cacheHome(), "progress-v1", `${key}.json`),
  ];
  for (const candidate of candidates) {
    const row = await readOptionalJson(candidate, 8192);
    if (!row) continue;
    if (
      row.schema !== "orchestrate.progress.v1" ||
      row.session !== peer.session ||
      row.harness !== peer.harness ||
      row.machine !== currentHost ||
      (row.accountHome ?? undefined) !== (peer.accountHome ?? undefined) ||
      row.checkout !== peerCwd ||
      !PROGRESS_STAGES.has(row.stage) ||
      (row.role !== undefined && row.role !== null && !Object.hasOwn(WORKFORCE_ROLES, row.role)) ||
      typeof row.goal !== "string" ||
      !row.goal.trim() ||
      row.goal.length > 160 ||
      typeof row.task !== "string" ||
      !row.task.trim() ||
      row.task.length > 160
    ) {
      continue;
    }
    const updatedMs = parseStampMs(row.updatedAt);
    if (!Number.isFinite(updatedMs)) continue;
    const ageMs = Date.now() - updatedMs;
    if (ageMs < -5 * 60 * 1000) continue;
    return {
      ...row,
      stale: row.stage !== "complete" && ageMs > PROGRESS_STALE_AFTER_MS,
    };
  }
  return null;
}

export async function interactiveProgress(room, root = mailboxRoot()) {
  const members = [
    ...(room.conductor ? [{ ...room.conductor, id: "conductor" }] : []),
    ...(Array.isArray(room.agents) ? room.agents : []),
  ];
  if (members.every((member) => !(member?.session || member?.mailboxSession))) return {};
  const currentHost = hostname();
  const roomCwd = room.cwd ? await resolveCwd(room.cwd) : "";
  const result = {};
  for (const member of members) {
    let binding = member.session;
    if (!binding && member.mailboxSession) {
      binding = {
        id: member.mailboxSession,
        engine: member.engine,
        machine: room.machine,
      };
    }
    if (
      !binding ||
      typeof binding.id !== "string" ||
      !binding.id ||
      binding.machine !== currentHost
    )
      continue;
    const key = sessionKey(binding.id);
    if (!key) continue;
    const expectedHarness = binding.engine === "agy" ? "gemini" : binding.engine;
    const peer = await readOptionalJson(path.join(root, "peers", `${key}.json`), 64 * 1024);
    if (!isValidPeer(peer) || peer.session !== binding.id) continue;
    if (expectedHarness && peer.harness !== expectedHarness) continue;
    if (!isPeerLive(peer)) continue;
    const expectedCwd = await resolveCwd(binding.cwd || member.cwd || room.cwd);
    const peerCwd = await resolveCwd(peer.checkout || peer.cwd);
    if (!peerCwd || (peerCwd !== expectedCwd && peerCwd !== roomCwd)) continue;
    const name = peer.name;
    if (!name || cleanLine(name) !== name) continue;
    const progress = await readProgressRecord(root, key, peer, peerCwd, currentHost);
    let goal = room.title && room.title !== room.id ? cleanLine(room.title) : "";
    let isManual = false;
    if (!goal && progress) {
      goal = cleanLine(progress.goal);
      isManual = true;
    }
    let task;
    let stage = "";
    if (progress) {
      task = cleanLine(progress.task);
      stage = progress.stage;
      isManual = true;
    } else {
      task = cleanLine(peer.focus);
    }
    let health = goal && task && stage ? "fresh" : "missing";
    if (isManual && progress?.stale) {
      health = "stale";
      stage = `${stage || "not set"} (stale)`;
    }
    const repo = cleanLine(peer.repository || repositoryName(peer)) || "not set";
    const role = progress?.role || member.workforceRole;
    const color =
      STATUS_COLORS[createHash("sha256").update(binding.id).digest()[0] % STATUS_COLORS.length];
    result[member.id] = {
      name,
      color,
      model: cleanLine(peer.model) || "—",
      effort: cleanLine(peer.effort) || "—",
      repo,
      repository: repo,
      cwd: peerCwd,
      ...(role && { role }),
      goal: goal || "not set",
      task: task || "not set",
      stage: stage || "not set",
      statusHealth: health,
      reportedAt: progress ? progress.updatedAt : null,
      lastSeenAt: peer.lastSeenAt || null,
      startedAt: peer.startedAt || null,
    };
  }
  return result;
}

export async function recoverRoom(id, options = {}) {
  const { root = mailboxRoot(), run = coordinator } = options;
  const room = await readRoom(id, root);
  const directories = new Set(
    room.agents.map((member) => member.dispatch?.taskDir).filter(Boolean),
  );
  const roomCwd = directories.size > 0 ? await realpath(room.cwd) : null;
  for (const directory of directories) {
    const task = await run(["show", "--task-dir", directory]);
    const taskRepo = await realpath(task.repository);
    const matchingMembers = room.agents.filter((member) => member.dispatch?.taskDir === directory);
    const memberCwds = await Promise.all(
      matchingMembers.map((member) => (member.cwd ? realpath(member.cwd) : Promise.resolve(null))),
    );
    const isValidRepo = taskRepo === roomCwd || memberCwds.includes(taskRepo);
    if (!isValidRepo || matchingMembers.some((member) => member.dispatch.taskId !== task.task_id))
      throw new Error("Task identity changed; refusing to recover a different task");
  }
  for (const directory of directories)
    await run(["recover", "--task-dir", directory, ...leadArgs(options)]);
  return observeRoom(room, { root, run, authority: options.authority });
}

export async function readLaunchPlan(file) {
  const plan = JSON.parse(await readFile(file, "utf8"));
  if (!Array.isArray(plan.members) || plan.members.length === 0)
    throw new Error("Launch plan requires members with id and taskDir");
  return plan;
}
