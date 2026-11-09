import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  addMembers,
  createRoom,
  detectWorktree,
  listRawRooms,
  mailboxRoot,
  normalizeWorkforceRole,
  processStarted,
  readRoom,
  refreshMemberWorktrees,
  resolveWorktreeMarkerPath,
  updateRawRoom,
  updateRoom,
  validateRoom,
  WORKFORCE_ROLES,
  workforceRoleInfo,
} from "./horde-room.mjs";
import { hasTerminalDecision, memberDisplayState } from "./member-state.mjs";
import { verifiedNativeIds } from "./native-identity.mjs";

const execute = promisify(execFile);
const plugin = fileURLToPath(new URL("../", import.meta.url));
const coordinatorPath = fileURLToPath(
  new URL("../skills/orchestrate/scripts/coordinator.py", import.meta.url),
);
const authorityPath = fileURLToPath(
  new URL("../skills/orchestrate/scripts/authority.py", import.meta.url),
);

const RUN_FIELDS = [
  "kind",
  "task_spec",
  "run_id",
  "request_id",
  "status",
  "runner_status",
  "result_sha256",
  "engine",
  "transport",
  "result_path",
  "mailbox",
  "model",
  "effort",
  "native_handle",
  "recovery",
  "resume_result",
  "resumed_from",
  "verification_of",
  "parent_run_id",
];
const TASK_STATES = {
  reserved: "reserved",
  active: "running",
  finished: "review",
  cancelled: "cancelled",
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

You own planning, assignment, resolving conflicts, and reviewing results for your branch. Your
context holds the user's intent and cross-cutting decisions; spend it on that and keep the
conversation available while workers run. Route every action:

1. Follow-up on a worker's output (a gap, a failing check, or a review note): send it back to the
   session that did the work and holds the file context. Native subagent: message or resume it.
   Audited executor run: dispatch at most one coordinator.py dispatch --kind correction with your
   reviewed evidence; a second gap or a scope/history violation requires a new bounded task or
   explicit conductor takeover. Do not repair worker output in-session while a worker session can
   continue, and do not start a cold worker for the same slice.
2. Sustained exploration, multi-step tracing, implementation, or any test/build run: delegate in
   the background and end your turn after attaching and establishing supervision. When your next
   read depends on a previous read that itself depended on a read, you are tracing—stop and
   dispatch a @scout or @debugger. When implementation scope is not yet localized, either dispatch
   a read-only @scout on the same task directory first (after you recover the finished scout run,
   its result.json automatically joins the builder's evidence) or grant scope_owner "worker" when
   repository-wide write scope is authorized.
3. Bounded deciding or answering: read to decide, never to produce. You may inspect a worker's
   result.json or diff, run git status or git diff, read a file the user named, or make a surgical
   edit only when you can state the diff before opening the file and no worker session or lease
   owns that path. If opening the file turns into figuring out what to change, stop and delegate.

Never edit the checkout while a worker holds its writer lease. After dispatching background work,
give the user a concise status and end your turn. Do not list, grep, tail, wc, or stat subagent
transcripts, scratch files, or task directories to check whether a worker is alive: completion
arrives via native notifications, completion events, or the "Swarm next step" advisor at your next
turn, and ork rooms show --room ${room.id} reads recorded state. Prefer bounded, useful tasks over
spawning a preset team without work. Check native tools and the live model catalog and quota before
choosing workers. Existing peer presence does not make a peer available; do not commandeer
unrelated sessions.

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
  const spawnNext =
    member.engine === "claude"
      ? "Spawn once through your native tools with this brief path in the prompt, then bind its actual session if the tool returns one; a Claude Code subagent is matched to this member by the brief path."
      : "Spawn once through your native tools, then bind its actual session before any retry.";
  let next = isNew
    ? spawnNext
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

const authorityCache = new Map();
const AUTHORITY_TTL_MS = 5000;

/** The team's current lead and generation; the authority record is written only by authority.py. */
export async function authorityShow(team) {
  const now = Date.now();
  const cached = authorityCache.get(team);
  if (cached && now - cached.fetchedAt < AUTHORITY_TTL_MS) {
    return cached.value;
  }
  try {
    const { stdout } = await execute("python3", [authorityPath, "show", "--team", team], {
      maxBuffer: 8 * 1024 * 1024,
      timeout: 30_000,
    });
    const { authority } = JSON.parse(stdout);
    const value = {
      team,
      generation: authority.generation,
      status: authority.status,
      lead: authority.lead,
      offer: authority.offer?.to,
    };
    authorityCache.set(team, { fetchedAt: now, value });
    return value;
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

// Reuse the runner's read-only audit so freshness uses exactly its candidate identity.
// -B keeps this observation from writing Python bytecode into the installed plugin.
async function candidateMatches(repository, result, { signal }) {
  const script = [
    "import json, sys",
    "from pathlib import Path",
    "sys.path.insert(0, sys.argv[1])",
    "import run_agent as runner",
    "result = json.loads(sys.argv[3])",
    "repo = Path(sys.argv[2])",
    'print(json.dumps(runner.git_state(repo, result.get("tracked_paths", []))["fingerprint"] == result["git_after"]["fingerprint"] and runner.git_identity(repo) == result["git_identity_after"]))',
  ].join("\n");
  const { stdout } = await execute(
    "python3",
    [
      "-B",
      "-c",
      script,
      path.dirname(coordinatorPath),
      repository,
      JSON.stringify({
        tracked_paths: result.tracked_paths,
        git_after: { fingerprint: result.git_after.fingerprint },
        git_identity_after: result.git_identity_after,
      }),
    ],
    { signal, timeout: 5000, maxBuffer: 1024 * 1024 },
  );
  const answer = JSON.parse(stdout);
  return typeof answer === "boolean" ? answer : null;
}

const probeCaches = new WeakMap();
const PROBE_INTERVAL_MS = 30_000;

// Observation never waits for a live audit; each repository permits one probe at a time.
function cachedCandidateMatch(repository, hash, result, options) {
  const { candidateProbe = candidateMatches, probeNow = Date.now, probeTimeoutMs = 5000 } = options;
  let repositories = probeCaches.get(candidateProbe);
  if (!repositories) {
    repositories = new Map();
    probeCaches.set(candidateProbe, repositories);
  }
  let repositoryCache = repositories.get(repository);
  if (!repositoryCache) {
    repositoryCache = { entries: new Map(), inFlight: null };
    repositories.set(repository, repositoryCache);
  }
  let entry = repositoryCache.entries.get(hash);
  if (!entry) {
    entry = { answer: null, checkedAt: null };
    repositoryCache.entries.set(hash, entry);
  }
  if (
    repositoryCache.inFlight ||
    (entry.checkedAt !== null && probeNow() - entry.checkedAt < PROBE_INTERVAL_MS)
  )
    return entry.answer;
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(
      () => {
        controller.abort();
        resolve(null);
      },
      Math.min(5000, Math.max(1, probeTimeoutMs)),
    );
    timer.unref?.();
  });
  const probe = Promise.try(() =>
    candidateProbe(repository, result, { signal: controller.signal }),
  );
  const inFlight = (async () => {
    try {
      return await probe;
    } finally {
      repositoryCache.inFlight = null;
    }
  })();
  repositoryCache.inFlight = inFlight;
  void (async () => {
    try {
      const answer = await Promise.race([inFlight, timeout]);
      entry.answer = typeof answer === "boolean" ? answer : null;
    } catch {
      entry.answer = null;
    } finally {
      clearTimeout(timer);
      entry.checkedAt = probeNow();
    }
  })();
  return entry.answer;
}

async function evidenceFreshness(repository, run, history, verdict, options) {
  const result = run.result_path ? await readOptionalJson(run.result_path) : null;
  const hasDecision = ["accept", "supported"].includes(verdict);
  const isFinished =
    run.status === "finished" && (!run.runner_status || run.runner_status === "completed");
  if (!hasDecision && !isFinished) return null;
  const hasVerification =
    run.kind === "verification" ||
    result?.verification?.status === "passed" ||
    result?.verification?.commands?.length > 0;
  if (!hasVerification && !hasDecision) return null;
  if (hasVerification && (!result?.git_after?.fingerprint || !result?.git_identity_after))
    return "stale";
  if (!result) return run.result_sha256 ? "stale" : null;
  const bytes = await readFile(run.result_path);
  const resultHash = createHash("sha256").update(bytes).digest("hex");
  if (run.result_sha256 && resultHash !== run.result_sha256) return "stale";
  if (run.kind === "verification") {
    const parent = history.find((item) => item.run_id === run.verification_of);
    const binding = result.verification_of;
    if (
      !parent?.result_sha256 ||
      binding?.sha256 !== parent.result_sha256 ||
      binding?.path !== parent.result_path
    )
      return "stale";
    let bytes;
    try {
      bytes = await readFile(parent.result_path);
    } catch {
      return "stale";
    }
    if (!bytes || createHash("sha256").update(bytes).digest("hex") !== binding.sha256)
      return "stale";
  }
  if (
    verdict === "pending" &&
    result.git_after?.fingerprint &&
    result.git_identity_after &&
    cachedCandidateMatch(repository, resultHash, result, options) === false
  )
    return "stale";
  return null;
}

async function projectMemberTask(cwd, member, task, options) {
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
  const anchor = matches[0];
  if (typeof anchor.run_id !== "string" || !anchor.run_id) throw new Error("Run identity changed");
  if (binding.runId && anchor.run_id !== binding.runId) throw new Error("Run identity changed");
  if (anchor.engine !== member.engine || anchor.transport !== binding.transport)
    throw new Error("Run executor differs from room member");
  const candidates = task.runs.filter(
    (run) =>
      run.engine === member.engine && [binding.transport, "host_checks"].includes(run.transport),
  );
  const byId = new Map(candidates.map((run) => [run.run_id, run]));
  const byResult = new Map(
    candidates.filter((run) => run.result_path).map((run) => [run.result_path, run]),
  );
  const chain = new Set([anchor.run_id]);
  let size;
  do {
    size = chain.size;
    for (const run of candidates) {
      if (!["continue", "correction", "verification"].includes(run.kind)) continue;
      const parent =
        byId.get(run.verification_of ?? run.parent_run_id) ??
        byResult.get(run.resume_result ?? run.resumed_from);
      if (!parent || (!chain.has(run.run_id) && !chain.has(parent.run_id))) continue;
      chain.add(parent.run_id);
      chain.add(run.run_id);
    }
  } while (chain.size !== size);
  const history = candidates.filter((run) => chain.has(run.run_id));
  const run = history.at(-1);
  if (typeof run.run_id !== "string" || !run.run_id) throw new Error("Run identity changed");
  const decisions = task.decisions.filter(
    (decision) => isPlainObject(decision) && decision.run_id === run.run_id,
  );
  const verdict = (decisions.length > 0 ? decisions.at(-1).decision : null) || "pending";
  let state = TASK_STATES[run.status] || "unknown";
  if (run.status !== "cancelled" && run.runner_status && run.runner_status !== "completed")
    state = "failed";
  const evidenceState = await evidenceFreshness(resolvedRepo, run, history, verdict, options);
  const displayState = memberDisplayState({ status: state, verdict, evidenceState });
  state = displayState === "reported" ? "review" : displayState;
  const spec = run.task_spec || task.task_spec;
  return {
    run,
    status: state,
    verdict,
    evidenceState,
    observedAt: task.updated_at,
    objective: spec ? spec.objective : null,
    history,
  };
}

async function roomTasks(request, options) {
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
        projection: await projectMemberTask(request.cwd, member, tasks[directory], options),
      };
    } catch (error) {
      members[member.id] = { error: error.message };
    }
  }
  return { tasks, members };
}

export async function listRooms(root = mailboxRoot()) {
  const rooms = [];
  const errors = [];
  const rawRooms = listRawRooms(root).sort((a, b) => a.id.localeCompare(b.id));
  for (const room of rawRooms) {
    try {
      rooms.push(validateRoom(room));
    } catch (error) {
      errors.push({ file: `${room.id}.json`, error: error.message });
    }
  }
  let files;
  try {
    files = await readdir(path.join(root, "rooms"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    files = [];
  }
  files.sort((a, b) => a.localeCompare(b));
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const room = JSON.parse(await readFile(path.join(root, "rooms", file), "utf8"));
      if (!room || room.id !== file.slice(0, -5))
        throw new Error("Room identity does not match its filename");
      validateRoom(room);
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
  { session, engine, cwd, workforceRole, repairOnly = false, root = mailboxRoot() },
) {
  if (!session || !["claude", "codex", "agy", "opencode"].includes(engine))
    throw new Error("Session binding requires a session ID and supported engine");
  const resolvedCwd = cwd ? await realpath(cwd) : undefined;
  return updateRoom(
    id,
    async (room) => {
      const member = memberOf(room, memberId);
      if (!isLocalSessionBinding(room, member))
        throw new Error("The target binding belongs to a different machine");
      if (member.engine && member.engine !== engine)
        throw new Error("Session engine differs from room member");
      const owner = await resolveRoomSessionPeer(room, root, member);
      const peer =
        owner && sessionIdentities(owner, root).includes(session)
          ? owner
          : await resolveSessionPeer(session, root, {
              engine,
              cwd: resolvedCwd || member.cwd || room.cwd,
            });
      const replacing = member.session && member.session.id !== (peer?.session || session);
      if (repairOnly || (replacing && (memberId === "conductor" || member.role === "lead"))) {
        if (!peer || !(await ownsSessionBinding(room, peer, root, member)))
          throw new Error(
            "This lead already has a native session; repair requires its live attested peer",
          );
        if (room.authority && replacing)
          throw new Error(
            "An authority-managed room requires its existing leadership handoff workflow",
          );
      }
      session = peer?.session || session;
      rememberSession(member, session);
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
  const currentMemberCwd = await realpath(targetMember?.cwd || room.cwd);
  const resolvedMemberCwd = options.cwd ? await realpath(options.cwd) : currentMemberCwd;
  if ((await realpath(task.repository)) !== resolvedMemberCwd)
    throw new Error("Task repository differs from room checkout");
  // A room under a team only runs that team's tasks, so a superseded lead cannot dodge the fence here.
  if (room.authority && task.authority?.team !== room.authority)
    throw new Error(
      `Task is not under the room's team ${room.authority}; init it with --authority`,
    );
  const effectiveRole = options.workforceRole ?? targetMember?.workforceRole;
  const kind = options.kind || workforceRoleInfo(effectiveRole)?.defaultKind || "investigation";
  if (!["implementation", "investigation", "consultation", "challenge", "continue"].includes(kind))
    throw new Error("Unsupported dispatch kind");
  const transport =
    options.transport || (kind === "continue" && targetMember?.dispatch?.transport) || "executor";
  if (!["executor", "native"].includes(transport))
    throw new Error("Unsupported dispatch transport");
  // The coordinator validates the duration and checks it against the task deadline.
  if (options.timeout !== undefined && (typeof options.timeout !== "string" || !options.timeout))
    throw new Error("--timeout needs a duration such as 25m");
  // Runner gates for implementation work, the files its auto-correct rounds may not change, and the
  // rounds the coordinator caps.
  const verifyCommands = options.verifyCommands ?? [];
  if (
    !Array.isArray(verifyCommands) ||
    verifyCommands.some((command) => typeof command !== "string" || !command.trim())
  )
    throw new Error("--verify-command needs a non-empty command");
  const protectPaths = options.protectPaths ?? [];
  if (
    !Array.isArray(protectPaths) ||
    protectPaths.some((entry) => typeof entry !== "string" || !entry.trim())
  )
    throw new Error("--protect-path needs a repository-relative path");
  const rawAutoCorrect =
    options.autoCorrect === undefined ? undefined : String(options.autoCorrect);
  if (rawAutoCorrect !== undefined && !/^\d+$/.test(rawAutoCorrect))
    throw new Error("--auto-correct needs a number of rounds such as 1");
  // Canonical, so a retry with "01" and 1 is the same request.
  const autoCorrect = rawAutoCorrect === undefined ? undefined : String(Number(rawAutoCorrect));
  const maxContinues =
    options.maxContinues === undefined ? undefined : Number(options.maxContinues);
  if (
    maxContinues !== undefined &&
    (!/^\d+$/.test(String(options.maxContinues)) || maxContinues > 6)
  )
    throw new Error("--max-continues must be an integer from 0 to 6 (hard ceiling 6)");
  if (kind === "continue" && !options.taskSpec)
    throw new Error("continue requires a new --task-spec");
  // Checked before any member field changes: an invalid role never reaches the room.
  const hasRole = options.workforceRole !== undefined;
  const requestedRole = hasRole ? normalizeWorkforceRole(options.workforceRole) : undefined;
  const intent = {
    taskDir: directory,
    taskId: task.task_id,
    requestId: options.requestId || randomUUID(),
    kind,
    transport,
    billingMode: options.billingMode || "unknown",
    ...(options.packet && { packet: await realpath(options.packet) }),
    ...(options.timeout && { timeout: options.timeout }),
    ...(verifyCommands.length > 0 && { verifyCommands }),
    ...(protectPaths.length > 0 && { protectPaths }),
    ...(autoCorrect !== undefined && { autoCorrect }),
    ...(maxContinues !== undefined && { maxContinues }),
    ...(options.taskSpec && { taskSpec: await realpath(options.taskSpec) }),
  };
  const saved = await updateRoom(
    id,
    (current) => {
      if (memberId === "conductor") throw new Error("Dispatch a worker, not the conductor");
      const member = memberOf(current, memberId);
      if (member.role === "lead")
        throw new Error("A subswarm lead uses native supervision, not worker dispatch");
      if (kind === "continue" && !member.dispatch)
        throw new Error("continue requires an existing member dispatch");
      // Only an explicit request ID can retry a continuation; review belongs to the coordinator.
      const continuing =
        kind === "continue" &&
        member.dispatch &&
        (member.dispatch.kind !== "continue" ||
          (options.requestId && options.requestId !== member.dispatch.requestId) ||
          !options.requestId);
      if (
        continuing &&
        (member.dispatch.taskId !== intent.taskId || member.dispatch.taskDir !== directory)
      )
        throw new Error("continue must use the member's existing task");
      // A kept `restore` means a launch is still in flight, or its outcome is unknown. Replacing
      // that intent would let the two launches overwrite each other's binding.
      const hasPreviousRunEnded = task.runs.some(
        (entry) =>
          entry.request_id === member.dispatch?.requestId &&
          ["finished", "cancelled"].includes(entry.status),
      );
      if (continuing && member.dispatch.restore && !hasPreviousRunEnded)
        throw new Error(
          `Another dispatch of this member is still launching; wait for it, or retry it with --request-id ${member.dispatch.requestId}`,
        );
      if (member.dispatch && !continuing) {
        // A retry repeats the stored request exactly; the member it runs as is part of it.
        for (const key of [
          "taskDir",
          "taskId",
          "kind",
          "transport",
          "billingMode",
          "packet",
          "timeout",
          "verifyCommands",
          "protectPaths",
          "autoCorrect",
          "maxContinues",
          "taskSpec",
        ])
          if (JSON.stringify(member.dispatch[key]) !== JSON.stringify(intent[key]))
            throw new Error(`Existing dispatch differs: ${key}`);
        if (options.cwd && resolvedMemberCwd !== currentMemberCwd)
          throw new Error("Existing dispatch differs: cwd");
        if (hasRole && requestedRole !== member.workforceRole)
          throw new Error("Existing dispatch differs: workforceRole");
        if (options.requestId && options.requestId !== member.dispatch.requestId)
          throw new Error("A member already has a dispatch; add a member for new work");
      } else {
        requireActiveBranch(current, memberId);
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
        // Kept with the intent, so a retry after an unknown outcome can still undo these edits.
        member.dispatch = {
          ...intent,
          restore: {
            cwd: member.cwd ?? null,
            workforceRole: member.workforceRole ?? null,
            ...(continuing && { dispatch: { ...member.dispatch, restore: undefined } }),
          },
        };
        if (options.cwd) member.cwd = resolvedMemberCwd;
        if (requestedRole) member.workforceRole = requestedRole;
        else if (hasRole) delete member.workforceRole;
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
    ...(binding.kind === "continue" ? [] : ["--engine", member.engine, "--model", member.model]),
    "--billing-mode",
    binding.billingMode,
    "--background",
    ...leadArgs(options),
  ];
  if (binding.kind !== "continue" && member.effort)
    args.push(member.engine === "opencode" ? "--variant" : "--effort", member.effort);
  if (binding.packet) args.push("--packet", binding.packet);
  if (binding.timeout) args.push("--timeout", binding.timeout);
  const gates = binding.verifyCommands ?? [];
  for (const command of gates) args.push("--verify-command", command);
  const protectedPaths = binding.protectPaths ?? [];
  for (const entry of protectedPaths) args.push("--protect-path", entry);
  if (binding.autoCorrect !== undefined) args.push("--auto-correct", binding.autoCorrect);
  if (binding.maxContinues !== undefined)
    args.push("--max-continues", String(binding.maxContinues));
  if (binding.taskSpec) args.push("--task-spec", binding.taskSpec);
  let result;
  try {
    result = await run(args);
  } catch (error) {
    // The coordinator records a run before any side effect, so a refusal with no run for this
    // request launched nothing: clear the intent so the member can be dispatched again.
    let wasLaunched = true;
    let isLaunchConfirmed = false;
    try {
      const after = await run(["show", "--task-dir", binding.taskDir]);
      wasLaunched = after.runs.some((entry) => entry.request_id === binding.requestId);
      isLaunchConfirmed = wasLaunched;
    } catch {
      // Unknown outcome: keep the intent so retrying the same request can recover it.
    }
    await updateRoom(
      id,
      (current) => {
        const agent = memberOf(current, memberId);
        agent.dispatchError = error.message;
        if (isLaunchConfirmed && agent.dispatch?.requestId === binding.requestId)
          delete agent.dispatch.restore;
        if (!wasLaunched && agent.dispatch?.requestId === binding.requestId) {
          const restored = Object.entries(agent.dispatch.restore ?? {});
          const previousDispatch = agent.dispatch.restore?.dispatch;
          for (const [key, value] of restored) {
            if (value === null) delete agent[key];
            else agent[key] = value;
          }
          if (previousDispatch) agent.dispatch = previousDispatch;
          else delete agent.dispatch;
          agent.status = previousDispatch ? "unknown" : "queued";
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
      // A delayed response must not touch a newer dispatch that has since taken this member.
      if (agent.dispatch.requestId === binding.requestId) {
        agent.dispatch.runId = result.run_id;
        delete agent.dispatch.restore;
        delete agent.dispatchError;
      } else if (agent.dispatch.restore?.dispatch?.requestId === binding.requestId) {
        agent.dispatch.restore.dispatch.runId = result.run_id;
      }
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
export async function observeRoom(idOrRoom, options = {}) {
  const {
    root = mailboxRoot(),
    run = coordinator,
    authority = authorityShow,
    tasks = new Map(),
    authorities = new Map(),
    progress = interactiveProgress,
    discoverNativePeers,
  } = options;
  const room = typeof idOrRoom === "string" ? await readRoom(idOrRoom, root) : idOrRoom;
  // Observations are rebuilt, including when callers reuse the same room object.
  room.agents = room.agents.filter((member) => !member.consultation);
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
    const snapshot = await roomTasks(
      {
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
      },
      options,
    );
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
      const {
        run: record,
        status,
        verdict,
        evidenceState,
        observedAt,
        objective,
        history,
      } = item.projection;
      member.runHistory = history;
      member.runId = record.run_id;
      member.transport = record.transport;
      member.resultPath = record.result_path;
      member.mailboxSession = record.mailbox?.worker;
      member.resolvedModel = record.model;
      member.resolvedEffort = record.effort;
      member.verdict = verdict;
      member.evidenceState = evidenceState;
      member.status = status;
      member.runtimeState =
        { active: "running", finished: "stopped", cancelled: "stopped" }[record.status] ||
        "unknown";
      member.observedAt = observedAt ?? undefined;
      member.nativeHandle = record.native_handle;
      member.objective = objective ?? undefined;
      const runResult = member.resultPath ? await readOptionalJson(member.resultPath) : null;
      const reported =
        typeof (runResult?.answer || runResult?.final_message || runResult?.reported_outcome) ===
        "string"
          ? (runResult.answer || runResult.final_message || runResult.reported_outcome).trim()
          : "";
      const uncertainty =
        typeof runResult?.uncertainty === "string" ? runResult.uncertainty.trim() : "";
      const runError = typeof runResult?.error === "string" ? runResult.error.trim() : "";
      if (reported) member.answer = reported;
      if (uncertainty) member.uncertainty = uncertainty;
      if (runError) member.error = runError;
      member.output = [
        member.objective,
        ...(reported
          ? reported
              .split(/\r?\n/u)
              .map((line) => line.trim())
              .filter(Boolean)
          : []),
        uncertainty && `Uncertainty: ${uncertainty}`,
        runError && `Error: ${runError}`,
        `Coordinator observed: ${member.observedAt || "unknown"}`,
        record.recovery,
        member.dispatchError,
        member.resultPath,
      ].filter(Boolean);
    } catch (error) {
      member.status = "unknown";
      member.verdict = "pending";
      member.evidenceState = null;
      member.runtimeState = "unknown";
      member.output = [error.message];
    }
  }
  const snapshots = room.swarm ? await progress(room, root) : {};
  for (const member of [room.conductor, ...room.agents]) {
    if (!member) continue;
    const key = member === room.conductor ? "conductor" : member.id;
    const snapshot = snapshots[key];
    const sessionId =
      member.session?.id || member.nativeHandle || member.mailboxSession || member.id;
    const peer = sessionId
      ? await resolveSessionPeer(sessionId, root, {
          engine: member.engine,
          cwd: member.session?.cwd || member.cwd || room.cwd,
        })
      : null;
    if (member !== room.conductor && peer && peer.accountHome) {
      const memberCwd = member.cwd || room.cwd;
      const parentCwd = room.conductor?.cwd || room.cwd;
      member.activitySource = {
        engine: member.engine,
        session: sessionId,
        accountHome: peer.accountHome,
        parentSession: peer.parentSession || room.conductor?.session?.id,
        cwd: memberCwd,
        ...(parentCwd && parentCwd !== memberCwd && { parentCwd }),
        ...(room.cwd && room.cwd !== memberCwd && { roomCwd: room.cwd }),
        startedAt: peer.startedAt || snapshot?.startedAt,
      };
    }
    const peerClearedHerdr = peer && "herdrPaneId" in peer && peer.herdrPaneId === null;
    if (peerClearedHerdr && !snapshot?.herdrPaneId) {
      delete member.herdrPaneId;
      delete member.herdrWorkspaceId;
      delete member.herdrEndpoint;
    } else {
      const herdrPaneId = snapshot?.herdrPaneId || peer?.herdrPaneId || member.herdrPaneId;
      if (herdrPaneId) member.herdrPaneId = herdrPaneId;
      const herdrWorkspaceId =
        snapshot?.herdrWorkspaceId || peer?.herdrWorkspaceId || member.herdrWorkspaceId;
      const herdrEndpoint = snapshot?.herdrEndpoint || peer?.herdrEndpoint || member.herdrEndpoint;
      if (herdrWorkspaceId) member.herdrWorkspaceId = cleanLine(herdrWorkspaceId);
      if (herdrEndpoint) member.herdrEndpoint = cleanLine(herdrEndpoint);
    }
    const paneId = snapshot?.paneId || peer?.paneId || member.paneId;
    if (paneId) member.paneId = paneId;
    const pid = snapshot?.pid || peer?.pid || member.pid;
    const branch = snapshot?.branch || peer?.branch || member.branch;
    if (Number.isSafeInteger(pid) && pid > 0) member.pid = pid;
    if (branch) member.branch = cleanLine(branch);
    if (!room.swarm) continue;
    if (snapshot) {
      if (!member.dispatch && snapshot.runtimeState) member.runtimeState = snapshot.runtimeState;
      const previousProgress = member.progress;
      let resolvedTask = member.objective || snapshot.task;
      if (snapshot.task && snapshot.task !== "not set") {
        resolvedTask = snapshot.task;
      } else if (previousProgress?.task && previousProgress.task !== "not set") {
        resolvedTask = previousProgress.task;
      }
      let resolvedStage = snapshot.stage;
      if (snapshot.stage && snapshot.stage !== "not set") {
        resolvedStage = snapshot.stage;
      } else if (previousProgress?.stage && previousProgress.stage !== "not set") {
        resolvedStage = previousProgress.stage;
      }
      member.progress = {
        ...previousProgress,
        ...snapshot,
        task: resolvedTask,
        stage: resolvedStage,
      };
      member.name = snapshot.name;
      if (snapshot.person) member.person = snapshot.person;
      if (snapshot.role) member.workforceRole = snapshot.role;
      if (snapshot.cwd && (!member.worktree?.path || snapshot.cwd !== member.worktree.parentCwd))
        member.cwd = snapshot.cwd;
      if (
        !member.dispatch &&
        !hasTerminalDecision(member) &&
        member.progress.stage &&
        member.progress.stage !== "not set"
      ) {
        member.status =
          member.progress.stage === "complete" ? "reported complete" : member.progress.stage;
      }
    } else if (
      member.session &&
      !member.dispatch &&
      !hasTerminalDecision(member) &&
      !["completed", "reported complete"].includes(member.status)
    ) {
      member.status = "session unavailable";
      member.runtimeState = "unknown";
    }
  }
  const shouldDiscoverNative =
    discoverNativePeers === true ||
    (discoverNativePeers !== false &&
      Boolean(room.swarm && room.cwd) &&
      progress === interactiveProgress &&
      (typeof idOrRoom === "string" ||
        options.root !== undefined ||
        Boolean(room.conductor?.session) ||
        room.agents.some((agent) => agent.session || agent.mailboxSession)));
  if (shouldDiscoverNative) {
    await appendNativePeers(room, snapshots, root);
  }
  await appendConsultations(room, root);
  await appendRoomMessages(room, root);
  return refreshMemberWorktrees(room);
}

async function appendConsultations(room, root) {
  const seen = new Set(room.agents.map((member) => member.id));
  const parents = [room.conductor, ...room.agents];
  for (const parent of parents) {
    const sessions = new Set([parent?.session?.id, parent?.mailboxSession, parent?.nativeSession]);
    for (const session of sessions) {
      if (typeof session !== "string" || !SESSION_ID_RE.test(session)) continue;
      const directory = path.join(root, "consultations", session);
      let entries;
      try {
        entries = await readdir(directory);
      } catch {
        continue;
      }
      entries.sort((a, b) => a.localeCompare(b));
      for (const entry of entries) {
        if (!entry.endsWith(".json")) continue;
        const job = await readOptionalJson(path.join(directory, entry));
        if (
          job?.schema !== "orchestrate.consultation-observation.v1" ||
          job.parent_session !== session ||
          (job.room_id && job.room_id !== room.id) ||
          job.machine !== hostname() ||
          typeof job.id !== "string" ||
          seen.has(job.id) ||
          !Number.isFinite(Date.parse(job.started_at)) ||
          Date.parse(job.started_at) < parseStampMs(room.createdAt) ||
          typeof job.result_path !== "string"
        )
          continue;
        const result = await readOptionalJson(job.result_path);
        const isFinished = result?.schema === "agent-executor.consultation.v1";
        const isRunning =
          !isFinished &&
          pidAlive(job.pid) === true &&
          pidAlive(job.runner_pid) === true &&
          Number.isFinite(job.deadline_ms) &&
          Date.now() < job.deadline_ms;
        const observed =
          isFinished && Array.isArray(result.model_observed)
            ? result.model_observed.filter((model) => typeof model === "string" && model)
            : [];
        let status = isRunning ? "running" : "session unavailable";
        let runtimeState = isRunning ? "running" : "unknown";
        let stage = "working";
        if (isFinished) {
          status = result.status === "answered" ? "reported complete" : "failed";
          runtimeState = "stopped";
          stage = result.status === "answered" ? "complete" : "blocked";
        }
        const workerSession = (isFinished && result.session_id) || job.session_id;
        let consultationActivitySource;
        if (workerSession) {
          const matchingNative = room.agents.find(
            (member) => member.native && member.nativeSession === workerSession,
          );
          if (matchingNative?.activitySource) {
            consultationActivitySource = matchingNative.activitySource;
          }
          // Provider hooks may also publish this worker as an unbound interactive peer.
          room.agents = room.agents.filter(
            (member) => !(member.native && member.nativeSession === workerSession),
          );
        }
        const answer =
          isFinished && typeof (result.answer || result.final_message) === "string"
            ? (result.answer || result.final_message).trim()
            : "";
        const uncertainty =
          isFinished && typeof result.uncertainty === "string" ? result.uncertainty.trim() : "";
        const errorText = isFinished && typeof result.error === "string" ? result.error.trim() : "";
        const question =
          (isFinished && typeof result.question === "string" && result.question.trim()) ||
          job.task ||
          "";
        const output = [];
        if (answer) {
          for (const line of answer.split(/\r?\n/u)) {
            if (line.trim()) output.push(line.trim());
          }
        }
        if (uncertainty) output.push(`Uncertainty: ${uncertainty}`);
        if (errorText) output.push(`Error: ${errorText}`);
        if (output.length === 0 && job.task) output.push(job.task);
        room.agents.push({
          id: job.id,
          name: `${job.engine} consultation`,
          parent: parent === room.conductor ? "conductor" : parent.id,
          consultation: true,
          workforceRole: "consultant",
          engine: job.engine,
          model: observed.length > 0 ? observed.join(", ") : job.model,
          requestedModel: job.model,
          modelSource: observed.length > 0 ? "observed" : "requested",
          effort: job.effort,
          cwd: job.cwd || parent.cwd || room.cwd,
          status,
          runtimeState,
          nativeSession: workerSession || undefined,
          ...(consultationActivitySource && { activitySource: consultationActivitySource }),
          resultPath: job.result_path,
          ...(answer && { answer }),
          ...(uncertainty && { uncertainty }),
          ...(errorText && { error: errorText }),
          ...(question && { question }),
          objective: job.task,
          output,
          progress: {
            task: job.task,
            stage,
            reportedAt: isFinished ? result.finished_at : job.started_at,
          },
        });
        seen.add(job.id);
      }
    }
  }
}

async function appendRoomMessages(room, root) {
  let inboxDirs;
  try {
    inboxDirs = await readdir(path.join(root, "inbox"));
  } catch {
    return;
  }
  const minMs = Number.isFinite(parseStampMs(room.createdAt))
    ? parseStampMs(room.createdAt) - 60_000
    : -Infinity;
  const agentMatchers = room.agents.map((agent) => {
    const sessions = new Set(
      [
        agent.session?.id,
        agent.nativeSession,
        agent.mailboxSession,
        agent.runId ? `run-${agent.runId}-worker` : "",
      ].filter((val) => typeof val === "string" && val),
    );
    const names = new Set();
    for (const candidate of [
      agent.id,
      agent.name,
      agent.progress?.name,
      agent.person,
      agent.progress?.person,
    ]) {
      if (typeof candidate !== "string" || !candidate.trim()) continue;
      const cleaned = candidate.trim();
      names.add(cleaned);
      const firstToken = cleaned.split("-", 1)[0];
      if (firstToken && firstToken.length >= 3) names.add(firstToken);
    }
    return { agent, sessions, names, messages: [] };
  });
  const seenIds = new Set();
  const discoveredRoomMessages = [];
  inboxDirs.sort((a, b) => a.localeCompare(b));
  for (const dirName of inboxDirs) {
    const inboxPath = path.join(root, "inbox", dirName);
    let files;
    try {
      files = await readdir(inboxPath);
    } catch {
      continue;
    }
    files.sort((a, b) => a.localeCompare(b));
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const msg = await readOptionalJson(path.join(inboxPath, file), 64 * 1024);
      if (
        (msg?.schema && msg.schema !== "agent-executor.mail.v1") ||
        typeof msg?.text !== "string" ||
        !msg.text.trim()
      ) {
        continue;
      }
      const sentMs = parseStampMs(msg.sentAt);
      if (Number.isFinite(minMs) && Number.isFinite(sentMs) && sentMs < minMs) continue;
      let fromSession = "";
      if (typeof msg.from?.session === "string") {
        fromSession = msg.from.session;
      } else if (typeof msg.fromSession === "string") {
        fromSession = msg.fromSession;
      }
      let fromName = "";
      if (typeof msg.from?.name === "string") {
        fromName = msg.from.name;
      } else if (typeof msg.from === "string") {
        fromName = msg.from;
      }
      const fromPrefix = fromName ? fromName.split("-", 1)[0] : "";
      const matched = agentMatchers.find(
        (m) =>
          (fromSession && m.sessions.has(fromSession)) ||
          (fromName && m.names.has(fromName)) ||
          (fromPrefix && m.names.has(fromPrefix)) ||
          (typeof msg.run === "string" &&
            msg.run === m.agent.runId &&
            fromSession.endsWith("-worker")),
      );
      if (!matched) continue;
      const dedupeKey = msg.id || `${fromSession}:${msg.sentAt || ""}:${msg.text}`;
      if (seenIds.has(dedupeKey)) continue;
      seenIds.add(dedupeKey);
      const fromLabel = cleanLine(
        matched.agent.person ||
          matched.agent.progress?.person ||
          fromName ||
          fromSession ||
          matched.agent.name ||
          matched.agent.id,
      );
      const toLabel = cleanLine(
        msg.to?.name ||
          msg.to?.session ||
          (typeof msg.to === "string" ? msg.to : "") ||
          "orchestrator",
      );
      const entry = {
        from: fromLabel,
        to: toLabel,
        text: msg.text.trim(),
        ...(typeof msg.sentAt === "string" && { sentAt: msg.sentAt }),
        ...(typeof msg.kind === "string" && { kind: msg.kind }),
        ...(typeof msg.channel === "string" && { channel: msg.channel }),
      };
      matched.messages.push(entry);
      discoveredRoomMessages.push(entry);
    }
  }
  const sortChronologically = (left, right) => {
    const leftMs = parseStampMs(left.sentAt);
    const rightMs = parseStampMs(right.sentAt);
    if (Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs !== rightMs) {
      return leftMs - rightMs;
    }
    return 0;
  };
  for (const { agent, messages } of agentMatchers) {
    if (messages.length === 0) continue;
    messages.sort(sortChronologically);
    agent.messages = messages;
  }
  if (discoveredRoomMessages.length === 0) return;
  discoveredRoomMessages.sort(sortChronologically);
  const existing = Array.isArray(room.messages) ? room.messages : [];
  room.messages = [...existing, ...discoveredRoomMessages];
}

async function appendNativePeers(room, snapshots, root) {
  const roomCwd = await resolveCwd(room.cwd);
  if (!roomCwd) return;
  const currentHost = hostname();
  const boundSessions = new Set();
  const collectRoomSessions = (targetRoom) => {
    for (const member of [targetRoom?.conductor, ...(targetRoom?.agents || [])]) {
      if (!member) continue;
      if (member.session?.id) {
        boundSessions.add(member.session.id);
        // A lead may bind a Claude subagent by its bare agent ID; its peer is `subagent-<id>`.
        if (member.engine === "claude" && !member.session.id.startsWith("subagent-")) {
          boundSessions.add(`subagent-${member.session.id}`.slice(0, 80));
        }
      }
      if (member.mailboxSession) boundSessions.add(member.mailboxSession);
      if (member.nativeSession) boundSessions.add(member.nativeSession);
    }
  };
  collectRoomSessions(room);
  for (const otherRoom of listRawRooms(root)) {
    if (otherRoom.id !== room.id) collectRoomSessions(otherRoom);
  }
  const existingIds = new Set(["conductor", ...room.agents.map((agent) => agent.id)]);
  const claimedSlots = new Set();
  const conductorPid = snapshots?.conductor?.pid || room.conductor?.pid;
  const conductorWorkspace =
    snapshots?.conductor?.herdrWorkspaceId || room.conductor?.herdrWorkspaceId;
  const conductorEndpoint =
    snapshots?.conductor?.herdrEndpoint || room.conductor?.herdrEndpoint || room.herdrEndpoint;
  const roomCreatedMs = parseStampMs(room.createdAt);
  let rawPeerEntries;
  try {
    rawPeerEntries = await readdir(path.join(root, "peers"));
  } catch {
    rawPeerEntries = [];
  }
  const peerFiles = rawPeerEntries
    .filter((entry) => entry.endsWith(".json"))
    .sort((left, right) => left.localeCompare(right));
  const maxAgents = room.swarm?.maxAgents || 64;
  for (const entry of peerFiles) {
    const peer = await readOptionalJson(path.join(root, "peers", entry), 64 * 1024);
    if (
      !isValidPeer(peer) ||
      !isPeerLive(peer) ||
      peer.run ||
      peer.session.startsWith("run-") ||
      (peer.machine && peer.machine !== currentHost) ||
      boundSessions.has(peer.session)
    ) {
      continue;
    }
    if (room.herdrEndpoint && peer.herdrPaneId && peer.herdrEndpoint !== room.herdrEndpoint)
      continue;
    const peerCwd = await resolveCwd(peer.checkout || peer.cwd);
    if (!peerCwd || (peerCwd !== roomCwd && !peerCwd.startsWith(`${roomCwd}${path.sep}`))) continue;
    const isSameSharedProcess =
      peer.sharedProcess === true && Boolean(conductorPid) && peer.pid === conductorPid;
    const isSameParentSession = Boolean(
      peer.parentSession &&
      room.conductor?.session?.id &&
      peer.parentSession === room.conductor.session.id,
    );
    const isSameWorkspace = Boolean(
      peer.herdrWorkspaceId &&
      conductorWorkspace &&
      peer.herdrWorkspaceId === conductorWorkspace &&
      peer.herdrEndpoint &&
      conductorEndpoint &&
      peer.herdrEndpoint === conductorEndpoint,
    );
    const peerStartedMs = parseStampMs(peer.startedAt);
    const hasStartedSinceRoom =
      Number.isFinite(roomCreatedMs) &&
      Number.isFinite(peerStartedMs) &&
      peerStartedMs >= roomCreatedMs - 60_000;
    if (!(isSameSharedProcess || isSameParentSession || isSameWorkspace || hasStartedSinceRoom)) {
      continue;
    }
    const key = sessionKey(peer.session);
    const progressRecord = key
      ? await readProgressRecord(root, key, peer, peerCwd, currentHost)
      : null;
    if (!progressRecord && peer.state !== "busy" && !peer.isSubagent) continue;
    const subagentMeta =
      peer.harness === "claude" && (peer.isSubagent || peer.session.startsWith("subagent-"))
        ? await readClaudeSubagentInfo(peer, roomCwd, room)
        : null;
    const person = cleanLine(peer.person);
    const slot = subagentMeta
      ? claimReservedSlot(room, subagentMeta.briefClaims, claimedSlots)
      : null;
    let id = slot?.id;
    if (!slot) {
      const rawBase =
        cleanLine(peer.person || peer.shortName || peer.session.slice(0, 8))
          .toLowerCase()
          .replaceAll(/[^\w-]/gu, "-")
          .replaceAll(/^-+|-+$/gu, "")
          .slice(0, 48) || "native";
      id = rawBase;
      let index = 2;
      while (existingIds.has(id)) {
        id = `${rawBase}-${index}`;
        index++;
      }
      existingIds.add(id);
    }
    boundSessions.add(peer.session);
    const engine = peer.harness === "gemini" ? "agy" : peer.harness;
    let stage = progressRecord?.stage || (peer.state === "busy" ? "working" : "idle");
    if (subagentMeta?.finished) stage = "complete";
    let status = "idle";
    if (stage === "complete") {
      status = "reported complete";
    } else if (stage === "blocked") {
      status = "blocked";
    } else if (peer.state === "busy" || (peer.harness === "unknown" && progressRecord)) {
      // A plain script has no harness hooks to report busy or idle; its stage is the only signal.
      status = "running";
    }
    const resolvedModel = cleanLine(subagentMeta?.model || peer.model) || engine;
    const subagentRole =
      peer.harness === "claude" && (peer.isSubagent || peer.session.startsWith("subagent-"))
        ? claudeSubagentRole(
            subagentMeta?.agentType || cleanLine(peer.focus).replace(/^native\s+/iu, ""),
          )
        : undefined;
    const rawTask = cleanLine(
      subagentMeta?.description ||
        peer.subagentDescription ||
        progressRecord?.task ||
        peer.focus ||
        "Native agent session",
    );
    const taskText = rawTask;
    const goalText = cleanLine(
      progressRecord?.goal || (room.title && room.title !== room.id ? room.title : "") || "not set",
    );
    const herdrPaneId = cleanLine(peer.herdrPaneId);
    const herdrEndpoint = cleanLine(peer.herdrEndpoint);
    const paneId = cleanLine(peer.paneId);
    const branch = cleanLine(peer.branch);
    const latestActivityIso = subagentMeta?.lastActivityIso || peer.lastSeenAt || null;
    const observedAt =
      latestActivityIso || progressRecord?.updatedAt || peer.lastSeenAt || peer.startedAt;
    const projected = {
      id,
      name: cleanLine(peer.name),
      ...(person && { person }),
      engine,
      model: resolvedModel,
      ...(peer.effort && { effort: cleanLine(peer.effort) }),
      role: "worker",
      workforceRole: progressRecord?.role || subagentRole || "native",
      native: true,
      nativeSession: peer.session,
      activitySource: {
        engine,
        session: peer.session,
        accountHome: peer.accountHome,
        parentSession: peer.parentSession || room.conductor?.session?.id,
        cwd: peerCwd,
        ...(room.conductor?.cwd &&
          room.conductor.cwd !== peerCwd && { parentCwd: room.conductor.cwd }),
        ...(roomCwd && roomCwd !== peerCwd && { roomCwd }),
        startedAt: peer.startedAt,
      },
      parent: "conductor",
      cwd: peerCwd,
      ...(Number.isSafeInteger(peer.pid) && peer.pid > 0 && { pid: peer.pid }),
      ...(branch && { branch }),
      ...(herdrPaneId && { herdrPaneId }),
      ...(herdrEndpoint && { herdrEndpoint }),
      ...(paneId && { paneId }),
      observedAt,
      status,
      runtimeState: status === "running" ? "running" : "idle",
      objective: taskText,
      output: [taskText].filter(Boolean),
      progress: {
        name: cleanLine(peer.name),
        ...(person && { person }),
        model: resolvedModel || "—",
        effort: cleanLine(peer.effort) || "—",
        cwd: peerCwd,
        ...((progressRecord?.role || subagentRole) && {
          role: progressRecord?.role || subagentRole,
        }),
        ...(Number.isSafeInteger(peer.pid) && peer.pid > 0 && { pid: peer.pid }),
        ...(branch && { branch }),
        ...(herdrPaneId && { herdrPaneId }),
        ...(herdrEndpoint && { herdrEndpoint }),
        ...(paneId && { paneId }),
        goal: goalText,
        task: taskText,
        stage,
        reportedAt: latestActivityIso || progressRecord?.updatedAt || null,
        lastSeenAt: latestActivityIso,
        startedAt: peer.startedAt || null,
      },
    };
    if (slot) {
      fillReservedSlot(slot, projected);
    } else if (room.agents.length < maxAgents) {
      room.agents.push(projected);
    }
  }
  await appendClaudeProjectSubagents(
    root,
    room,
    roomCwd,
    boundSessions,
    existingIds,
    conductorPid,
    claimedSlots,
  );
}

// cspell:disable
const SUBAGENT_MARTIAN_NAMES = [
  "wubbit",
  "klorgis",
  "zibber",
  "ploomix",
  "fnordel",
  "snorfle",
  "gribnox",
  "tumblex",
  "quibble",
  "miffkin",
  "blorkin",
  "skitter",
  "drazzle",
  "pifflet",
  "vorgle",
  "nibblex",
];

const ALIEN_ONSETS = [
  "bl",
  "br",
  "ch",
  "cr",
  "dr",
  "fl",
  "fr",
  "gl",
  "gr",
  "kl",
  "kr",
  "m",
  "n",
  "pl",
  "pr",
  "qu",
  "sk",
  "skr",
  "sl",
  "sm",
  "sn",
  "spl",
  "spr",
  "squ",
  "st",
  "str",
  "th",
  "thr",
  "tr",
  "vr",
  "z",
  "zw",
];
const ALIEN_VOWELS = ["a", "e", "i", "o", "u", "oo", "or", "ar"];
const ALIEN_CODAS = [
  "b",
  "d",
  "f",
  "g",
  "k",
  "l",
  "m",
  "mp",
  "n",
  "nk",
  "p",
  "rk",
  "t",
  "x",
  "z",
  "zk",
];
const ALIEN_SUFFIXES = [
  "",
  "",
  "ax",
  "ek",
  "el",
  "ik",
  "ix",
  "le",
  "lo",
  "nak",
  "ok",
  "or",
  "ox",
  "oz",
  "ug",
  "ul",
];
// cspell:enable

function generateSubagentMartian(seed, step = 0) {
  const key = step === 0 ? String(seed) : `${seed}:${step}`;
  const digest = createHash("sha256").update(key, "utf8").digest();
  const onset = ALIEN_ONSETS[digest[0] % ALIEN_ONSETS.length];
  const vowel = ALIEN_VOWELS[digest[1] % ALIEN_VOWELS.length];
  const codaIdx = digest[2] % ALIEN_CODAS.length;
  let coda = ALIEN_CODAS[codaIdx];
  if (vowel.endsWith("r") && coda.startsWith("r")) {
    coda = ALIEN_CODAS[(codaIdx + 1) % ALIEN_CODAS.length];
  }
  const suffix = ALIEN_SUFFIXES[digest[3] % ALIEN_SUFFIXES.length];
  return `${onset}${vowel}${coda}${suffix}`;
}

function pickSubagentMartianName(subSid, existingIds, conductorPerson) {
  for (let step = 0; step < 256; step++) {
    const candidate = generateSubagentMartian(subSid, step);
    if (candidate !== conductorPerson && !existingIds.has(candidate)) {
      return candidate;
    }
  }
  const digest = createHash("sha1").update(String(subSid)).digest();
  const start = digest.readUInt32BE(0) % SUBAGENT_MARTIAN_NAMES.length;
  for (let offset = 0; offset < SUBAGENT_MARTIAN_NAMES.length; offset++) {
    const candidate = SUBAGENT_MARTIAN_NAMES[(start + offset) % SUBAGENT_MARTIAN_NAMES.length];
    if (candidate !== conductorPerson && !existingIds.has(candidate)) {
      return candidate;
    }
  }
  return `subagent-${String(subSid)
    .replace(/^subagent-/u, "")
    .slice(0, 6)}`;
}

async function readHeadText(filePath, maxBytes = 32_768) {
  let handle;
  try {
    handle = await open(filePath, "r");
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.toString("utf8", 0, bytesRead);
  } catch {
    return "";
  } finally {
    await handle?.close();
  }
}

// A lead hands a native subagent its room brief path in the launch prompt. That path names the
// reserved member slot the subagent fills, because a Claude subagent cannot see its own session ID
// to run `ork rooms bind` itself. Only the first transcript line (the launch prompt) counts, so
// briefs the subagent reads later never move it to another slot.
function parseBriefClaims(headText) {
  const firstLine = String(headText || "").split("\n", 1)[0];
  return Array.from(
    firstLine.matchAll(
      /swarm-briefs[\\/]+([A-Za-z0-9][A-Za-z0-9_.-]{0,127})[\\/]+([A-Za-z0-9][A-Za-z0-9_.-]{0,63})\.md/gu,
    ),
    (match) => ({ roomId: match[1], memberId: match[2] }),
  );
}

const CLAIMABLE_SLOT_STATUSES = new Set(["reserved", "queued"]);

function claimReservedSlot(room, claims, claimedSlots) {
  const memberIds = [
    ...new Set(
      (claims || []).filter((claim) => claim.roomId === room.id).map((claim) => claim.memberId),
    ),
  ];
  if (memberIds.length !== 1 || claimedSlots.has(memberIds[0])) return null;
  const slot = room.agents.find((agent) => agent.id === memberIds[0]);
  if (
    !slot ||
    slot.native ||
    slot.session?.id ||
    slot.mailboxSession ||
    slot.nativeSession ||
    slot.dispatch ||
    (slot.engine && slot.engine !== "claude") ||
    !CLAIMABLE_SLOT_STATUSES.has(slot.status)
  ) {
    return null;
  }
  claimedSlots.add(slot.id);
  return slot;
}

// Fill a reserved slot with a projected subagent, keeping the slot's identity, role, parent and
// assignment so the roster shows one member per agent.
function fillReservedSlot(slot, projected) {
  const role = slot.workforceRole || projected.workforceRole;
  const objective = slot.objective || projected.objective;
  // Before its first reply a subagent reports only its engine as the model; keep the slot's.
  const model =
    projected.model && projected.model !== projected.engine
      ? projected.model
      : slot.model || projected.model;
  const kept = {
    id: slot.id,
    name: slot.name || projected.name,
    person: slot.person || projected.person,
    role: slot.role || projected.role,
    parent: slot.parent || projected.parent,
    cwd: slot.cwd || projected.cwd,
    model,
  };
  Object.assign(slot, projected, kept, {
    workforceRole: role,
    objective,
    progress: { ...projected.progress, role, model, cwd: kept.cwd },
  });
}

async function readTailText(filePath, maxBytes = 65_536) {
  let handle;
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return null;
    const length = Math.min(info.size, maxBytes);
    const offset = Math.max(0, info.size - length);
    handle = await open(filePath, "r");
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return {
      text: buffer.toString("utf8", 0, bytesRead),
      mtimeMs: info.mtimeMs,
      birthtimeMs: info.birthtimeMs || info.ctimeMs || info.mtimeMs,
    };
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

function claudeSubagentsDirs(accountHome, parentSession, cwds) {
  if (!parentSession || !SESSION_ID_RE.test(parentSession)) return [];
  const home = accountHome || process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude");
  const seen = new Set();
  const dirs = [];
  for (const rawCwd of cwds) {
    if (typeof rawCwd !== "string" || !rawCwd.trim()) continue;
    const slug = rawCwd.replaceAll(/[^A-Za-z0-9-]/gu, "-");
    const candidate = path.join(home, "projects", slug, parentSession, "subagents");
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    dirs.push(candidate);
  }
  return dirs;
}

async function readClaudeSubagentFromDir(subagentsDir, agentId) {
  const metaPath = path.join(subagentsDir, `agent-${agentId}.meta.json`);
  const jsonlPath = path.join(subagentsDir, `agent-${agentId}.jsonl`);
  const [meta, tail, head] = await Promise.all([
    readOptionalJson(metaPath, 32 * 1024),
    readTailText(jsonlPath),
    readHeadText(jsonlPath),
  ]);
  if (!meta && !tail) return null;
  let observedModel = "";
  if (tail?.text) {
    const matches = tail.text.matchAll(/"model"\s*:\s*"([^"]+)"/gu).toArray();
    if (matches.length > 0) observedModel = matches.at(-1)[1];
  }
  const metaModel =
    typeof meta?.model === "string" && meta.model.trim() && meta.model.trim() !== "auto"
      ? meta.model.trim()
      : "";
  const description = typeof meta?.description === "string" ? cleanLine(meta.description) : "";
  let activity = tail;
  if (!activity && meta) {
    try {
      activity = await stat(metaPath);
    } catch {
      // The metadata may disappear between reading it and observing its timestamps.
    }
  }
  const lastActivityIso = Number.isFinite(activity?.mtimeMs)
    ? new Date(activity.mtimeMs).toISOString()
    : null;
  const startedIso = Number.isFinite(activity?.birthtimeMs)
    ? new Date(activity.birthtimeMs).toISOString()
    : lastActivityIso;
  return {
    agentId,
    agentType: typeof meta?.agentType === "string" ? cleanLine(meta.agentType) : "",
    description,
    model: observedModel || metaModel,
    finished: Boolean(meta?.finished),
    briefClaims: parseBriefClaims(head),
    lastActivityIso,
    startedIso,
    mtimeMs: activity?.mtimeMs ?? NaN,
  };
}

// Generic subagents have no workforce preset; the roster uses its existing native label.
function claudeSubagentRole(agentType) {
  const type = cleanLine(agentType).toLowerCase();
  if (type === "explore") return "scout";
  if (type === "plan") return "planner";
}

async function readClaudeSubagentInfo(peer, roomCwd, room) {
  const agentId = String(peer.session || "").replace(/^subagent-/u, "");
  const parentSession = peer.parentSession || room.conductor?.session?.id;
  if (!agentId || !parentSession) return null;
  const dirs = claudeSubagentsDirs(peer.accountHome, parentSession, [
    peer.checkout,
    peer.cwd,
    roomCwd,
    room.cwd,
  ]);
  for (const dir of dirs) {
    const info = await readClaudeSubagentFromDir(dir, agentId);
    if (info) return info;
  }
  return null;
}

async function appendClaudeProjectSubagents(
  root,
  room,
  roomCwd,
  boundSessions,
  existingIds,
  conductorPid,
  claimedSlots = new Set(),
) {
  const parentSession = room.conductor?.session?.id;
  if (!parentSession || (room.conductor?.engine && room.conductor.engine !== "claude")) return;
  const roomCreatedMs = parseStampMs(room.createdAt);
  const isConductorAlive = !conductorPid || pidAlive(conductorPid) !== false;
  const dirs = claudeSubagentsDirs(undefined, parentSession, [roomCwd, room.cwd]);
  for (const dir of dirs) {
    let entries;
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    const agentIds = [
      ...new Set(
        entries
          .filter((e) => /^agent-[A-Za-z0-9_.-]+\.(?:meta\.json|jsonl)$/u.test(e))
          .map((file) => file.replace(/^agent-/u, "").replace(/\.(?:meta\.json|jsonl)$/u, "")),
      ),
    ].sort((a, b) => a.localeCompare(b));
    for (const agentId of agentIds) {
      const subSid = `subagent-${agentId}`.slice(0, 80);
      const boundSlot = room.agents.find(
        (member) =>
          member.engine === "claude" &&
          !member.dispatch &&
          !member.mailboxSession &&
          isLocalSessionBinding(room, member) &&
          [subSid, agentId].includes(member.session?.id),
      );
      if (boundSlot) {
        // Bound sessions stay deduplicated, but their transcript can still hydrate the slot
        // after SubagentStop removes the peer. A live peer remains authoritative.
        const peerOptions = {
          engine: "claude",
          cwd: boundSlot.session?.cwd || boundSlot.cwd || roomCwd,
        };
        if (
          claimedSlots.has(boundSlot.id) ||
          (await resolveSessionPeer(boundSlot.session.id, root, peerOptions)) ||
          (boundSlot.session.id !== subSid && (await resolveSessionPeer(subSid, root, peerOptions)))
        )
          continue;
      } else if (boundSessions.has(subSid) || !entries.includes(`agent-${agentId}.meta.json`))
        continue;
      const info = await readClaudeSubagentFromDir(dir, agentId);
      if (!info) continue;
      if (
        !boundSlot &&
        Number.isFinite(roomCreatedMs) &&
        Number.isFinite(info.mtimeMs) &&
        info.mtimeMs < roomCreatedMs - 60_000
      ) {
        continue;
      }
      const key = sessionKey(subSid);
      const accountHome = process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude");
      const savedProgress = key
        ? await readProgressRecord(
            root,
            key,
            { session: subSid, harness: "claude", accountHome },
            roomCwd,
            hostname(),
          )
        : null;
      const savedPrefix =
        typeof savedProgress?.name === "string"
          ? cleanLine(savedProgress.name.split("-", 1)[0]).toLowerCase()
          : "";
      const workforceRole = savedProgress?.role || claudeSubagentRole(info.agentType) || "native";
      const isFinished =
        info.finished ||
        !isConductorAlive ||
        Boolean(boundSlot && savedProgress?.stage === "complete");
      const status = isFinished ? "reported complete" : "running";
      const stage = isFinished ? "complete" : "working";
      const slot = boundSlot || claimReservedSlot(room, info.briefClaims, claimedSlots);
      if (boundSlot) claimedSlots.add(boundSlot.id);
      let id = slot?.id;
      if (!slot) {
        const shortId =
          savedPrefix && !existingIds.has(savedPrefix)
            ? savedPrefix
            : pickSubagentMartianName(subSid, existingIds, room.conductor?.person);
        id = shortId;
        let index = 2;
        while (existingIds.has(id)) {
          id = `${shortId}-${index}`;
          index++;
        }
        existingIds.add(id);
      }
      boundSessions.add(subSid);
      const taskText =
        info.description ||
        (typeof savedProgress?.task === "string" ? cleanLine(savedProgress.task) : "") ||
        `Running subagent (${agentId.slice(0, 12)})`;
      const modelName = info.model || "claude";
      const projected = {
        id,
        name: id,
        person: id,
        engine: "claude",
        model: modelName,
        role: "worker",
        workforceRole,
        native: true,
        nativeSession: subSid,
        activitySource: {
          engine: "claude",
          session: subSid,
          accountHome,
          parentSession,
          cwd: roomCwd,
          startedAt: info.startedIso,
        },
        parent: "conductor",
        cwd: roomCwd,
        observedAt: info.lastActivityIso || info.startedIso,
        status,
        runtimeState: isFinished ? "stopped" : "running",
        objective: taskText,
        output: [taskText],
        progress: {
          name: id,
          person: id,
          model: modelName,
          effort: "—",
          cwd: roomCwd,
          ...(workforceRole !== "native" && { role: workforceRole }),
          goal: room.title && room.title !== room.id ? cleanLine(room.title) : "Native subagent",
          task: taskText,
          stage,
          reportedAt: info.lastActivityIso,
          lastSeenAt: info.lastActivityIso,
          startedAt: info.startedIso,
        },
      };
      if (slot) {
        fillReservedSlot(slot, projected);
      } else if (room.agents.length < (room.swarm?.maxAgents || 64)) {
        room.agents.push(projected);
      }
    }
  }
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
  if (typeof value === "number" && Number.isFinite(value)) return value;
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

export function isPeerLive(peer, nowMs = Date.now()) {
  const seenMs = parseStampMs(peer.lastSeenAt || peer.startedAt);
  if (!Number.isFinite(seenMs)) return false;
  const alive = pidAlive(peer.pid);
  if (alive === false) return false;
  if (alive && peer.pidBirth) {
    const birth = processStarted(peer.pid);
    if (birth && birth !== peer.pidBirth) return false;
  }
  const ageMs = nowMs - seenMs;
  if (ageMs > MAX_PEER_AGE_MS) return false;
  if (alive && peer.sharedProcess) {
    if (peer.state === "idle") return ageMs <= SHARED_PROCESS_IDLE_TTL_MS;
    if (peer.state === "busy") return ageMs <= SHARED_PROCESS_BUSY_TTL_MS;
  }
  return alive ?? ageMs <= UNKNOWN_PID_TTL_MS;
}

/** Only MAC-verified hook claims supplement the exact mailbox identity. */
export function sessionIdentities(peer, root = mailboxRoot()) {
  return [peer?.session, ...verifiedNativeIds(peer, root)].filter(
    (id) => typeof id === "string" && sessionKey(id),
  );
}

async function sessionPeerCandidates(
  session,
  root = mailboxRoot(),
  { engine, cwd, now = Date.now() } = {},
) {
  const key = sessionKey(session);
  if (!key) return [];
  const expectedCwd = cwd ? await resolveCwd(cwd) : undefined;
  const harness = engine === "agy" ? "gemini" : engine;
  const eligible = async (peer, isAlias = false) =>
    isValidPeer(peer) &&
    isPeerLive(peer, now) &&
    (!peer.machine || peer.machine === hostname()) &&
    (!harness || peer.harness === harness) &&
    (!isAlias ||
      !(peer.isSubagent || peer.delegatedRun || peer.run || peer.session.startsWith("run-"))) &&
    (!expectedCwd || (await resolveCwd(peer.checkout || peer.cwd)) === expectedCwd);
  const direct = await readOptionalJson(path.join(root, "peers", `${key}.json`), 64 * 1024);
  if (direct?.session === session && (await eligible(direct))) return [direct];
  let files;
  try {
    files = await readdir(path.join(root, "peers"));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const matches = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const peer = await readOptionalJson(path.join(root, "peers", file), 64 * 1024);
    if (sessionIdentities(peer, root).includes(session) && (await eligible(peer, true)))
      matches.push(peer);
  }
  return matches;
}

export async function resolveSessionPeer(session, root = mailboxRoot(), options = {}) {
  const matches = await sessionPeerCandidates(session, root, options);
  return matches.length === 1 ? matches[0] : null;
}

export function roomOwnerSessions(room, member = room.conductor) {
  return [
    ...new Set(
      [
        member?.session?.id,
        member?.mailboxSession,
        ...(member === room.conductor || member?.id === "conductor"
          ? [room.promotion?.session]
          : []),
        ...(Array.isArray(member?.previousSessions) ? member.previousSessions : []),
      ].filter((id) => typeof id === "string" && id),
    ),
  ];
}

export function isLocalSessionBinding(room, member = room.conductor) {
  return (
    (!room.machine || room.machine === hostname()) &&
    (!member?.session?.machine || member.session.machine === hostname())
  );
}

async function roomSessionPeers(room, root, member = room.conductor) {
  if (!isLocalSessionBinding(room, member)) return [];
  const ids = roomOwnerSessions(room, member);
  const options = {
    engine: member?.session?.engine || member?.engine,
    cwd: member?.session?.cwd || member?.cwd || room.cwd,
  };
  const candidates = new Map();
  for (const id of ids) {
    const matches = await sessionPeerCandidates(id, root, options);
    const recorded = matches.find((owner) => owner.session === id);
    if (recorded) return [recorded];
    for (const owner of matches) candidates.set(owner.session, owner);
  }
  // Room-recorded mailbox keys outrank unbound native-ID claimants. Without
  // that evidence, retain every claimant so ambiguity cannot authorize repair.
  return candidates.values().toArray();
}

export async function resolveRoomSessionPeer(room, root = mailboxRoot(), member = room.conductor) {
  const peers = await roomSessionPeers(room, root, member);
  return peers.length === 1 ? peers[0] : null;
}

export async function hasOtherLiveOwner(room, peer, root, member = room.conductor) {
  return (await roomSessionPeers(room, root, member)).some(
    (owner) => owner.session !== peer.session,
  );
}

export async function ownsSessionBinding(room, peer, root, member = room.conductor) {
  const owner = await resolveRoomSessionPeer(room, root, member);
  return Boolean(owner && owner.session === peer.session);
}

export function rememberSession(member, session, additional = []) {
  const previous = [member.session?.id, ...additional].filter(
    (id) => typeof id === "string" && id && id !== session,
  );
  if (previous.length === 0) return;
  const history = [...new Set([...(member.previousSessions || []), ...previous])];
  member.previousSessions = history.length > 32 ? [history[0], ...history.slice(-31)] : history;
}

/** Hook /clear repair shares the same ownership guard as explicit binding. */
export async function rebindSession(id, memberId, session, root = mailboxRoot()) {
  return updateRawRoom(
    id,
    async (room) => {
      const member = memberOf(room, memberId);
      if (!isLocalSessionBinding(room, member))
        throw new Error("The target binding belongs to a different machine");
      const owner = await resolveRoomSessionPeer(room, root, member);
      const peer =
        owner && sessionIdentities(owner, root).includes(session)
          ? owner
          : await resolveSessionPeer(session, root, {
              engine: member.engine,
              cwd: member.session?.cwd || member.cwd || room.cwd,
            });
      if (!peer || !(await ownsSessionBinding(room, peer, root, member)))
        throw new Error("Repair requires the live attested owner of this binding");
      if (room.authority && member.session?.id !== peer.session)
        throw new Error(
          "An authority-managed room requires its existing leadership handoff workflow",
        );
      rememberSession(member, peer.session);
      if (member.session) member.session.id = peer.session;
      return room;
    },
    { root },
  );
}

function repositoryName(peer) {
  const raw = peer.repo || peer.checkout || peer.cwd || "";
  const base = path.basename(raw);
  return base === ".git" ? path.basename(path.dirname(raw)) : base;
}

function sessionProgressPath(root, sessionId) {
  return path.join(root, "progress", `${sessionId}.json`);
}

async function readProgressRecord(root, sessionId, peer, peerCwd, currentHost) {
  if (!sessionId) return null;
  const row = await readOptionalJson(sessionProgressPath(root, sessionId), 8192);
  if (
    !row ||
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
    return null;
  }
  const updatedMs = parseStampMs(row.updatedAt);
  if (!Number.isFinite(updatedMs)) return null;
  const ageMs = Date.now() - updatedMs;
  if (ageMs < -5 * 60 * 1000) return null;
  return {
    ...row,
    stale: row.stage !== "complete" && ageMs > PROGRESS_STALE_AFTER_MS,
  };
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
    let peer = await resolveRoomSessionPeer(room, root, member);
    // Exact conductor keys can retain their established room after a directory move.
    // Native alias searches remain confined to the bound checkout.
    if (!peer && member.id === "conductor" && isLocalSessionBinding(room, member)) {
      const exact = await resolveSessionPeer(binding.id, root, { engine: binding.engine });
      if (exact?.session === binding.id) peer = exact;
    }
    if (!peer && binding.engine === "claude" && !binding.id.startsWith("subagent-")) {
      // A lead may bind a Claude subagent by its bare agent ID; its peer is `subagent-<id>`.
      const subagent = await resolveSessionPeer(`subagent-${binding.id}`.slice(0, 80), root, {
        engine: binding.engine,
      });
      if (subagent?.isSubagent) peer = subagent;
    }
    if (!peer) continue;
    const key = sessionKey(peer.session);
    const expectedCwd = await resolveCwd(binding.cwd || member.cwd || room.cwd);
    const peerCwd = await resolveCwd(peer.checkout || peer.cwd);
    const isBoundConductor =
      member.id === "conductor" &&
      (peer.swarmBriefed === room.id ||
        Boolean(
          peer.herdrWorkspaceId &&
          room.herdrWorkspaceId &&
          peer.herdrWorkspaceId === room.herdrWorkspaceId &&
          peer.herdrEndpoint &&
          room.herdrEndpoint &&
          peer.herdrEndpoint === room.herdrEndpoint,
        ));
    if (!peerCwd || (!isBoundConductor && peerCwd !== expectedCwd && peerCwd !== roomCwd)) continue;
    const effectiveCwd =
      peerCwd === expectedCwd || peerCwd === roomCwd ? peerCwd : expectedCwd || roomCwd || peerCwd;
    const name = peer.name;
    if (!name || cleanLine(name) !== name) continue;
    const progress = await readProgressRecord(root, key, peer, effectiveCwd, currentHost);
    // A subagent's hook-assigned role must not replace the role its slot was reserved for.
    if (peer.isSubagent && member.workforceRole && progress) delete progress.role;
    let goal = room.title && room.title !== room.id ? cleanLine(room.title) : "";
    let isManual = false;
    if (!goal && progress) {
      goal = cleanLine(progress.goal);
      isManual = true;
    }
    const existingTask = cleanLine(
      member.progress?.task && member.progress.task !== "not set"
        ? member.progress.task
        : member.objective,
    );
    const displayState = memberDisplayState(member);
    const fallbackStatus = displayState === "reported" ? "complete" : cleanLine(displayState);
    let existingStage = "";
    if (member.progress?.stage && member.progress.stage !== "not set") {
      existingStage = cleanLine(member.progress.stage);
    } else if (
      !["not set", "queued", "idle", "awaiting session", "session unavailable", "unknown"].includes(
        fallbackStatus,
      )
    ) {
      existingStage = fallbackStatus;
    }
    let task;
    let stage = "";
    if (progress) {
      task = cleanLine(progress.task) || existingTask;
      stage = progress.stage || existingStage;
      isManual = true;
    } else {
      task = cleanLine(peer.focus) || existingTask;
      if (peer.state === "busy") {
        stage = "working";
      } else if (
        member.id !== "conductor" &&
        peer.state === "idle" &&
        typeof peer.lastStopReason === "string" &&
        peer.lastStopReason.trim() &&
        (!existingStage || existingStage === "working")
      ) {
        stage = "complete";
      } else if (existingStage) {
        stage = existingStage;
      }
    }
    let health = goal && task && stage ? "fresh" : "missing";
    if (isManual && progress?.stale) {
      health = "stale";
      stage = `${stage || "not set"} (stale)`;
    }
    const repo = cleanLine(peer.repository || repositoryName(peer)) || "not set";
    const role = progress?.role || member.workforceRole;
    const herdrPaneId = cleanLine(peer.herdrPaneId || member.herdrPaneId);
    const paneId = cleanLine(peer.paneId || member.paneId);
    const branch = cleanLine(peer.branch || member.branch);
    const herdrWorkspaceId = cleanLine(peer.herdrWorkspaceId || member.herdrWorkspaceId);
    const herdrEndpoint = cleanLine(peer.herdrEndpoint || member.herdrEndpoint);
    const person = cleanLine(peer.person);
    const color =
      STATUS_COLORS[createHash("sha256").update(binding.id).digest()[0] % STATUS_COLORS.length];
    result[member.id] = {
      name,
      ...(person && { person }),
      color,
      model: cleanLine(peer.model) || "—",
      effort: cleanLine(peer.effort) || "—",
      repo,
      repository: repo,
      cwd: peerCwd,
      ...(role && { role }),
      ...(Number.isSafeInteger(peer.pid) && peer.pid > 0 && { pid: peer.pid }),
      ...(branch && { branch }),
      ...(herdrWorkspaceId && { herdrWorkspaceId }),
      ...(herdrEndpoint && { herdrEndpoint }),
      ...(herdrPaneId && { herdrPaneId }),
      ...(paneId && { paneId }),
      goal: goal || "not set",
      task: task || "not set",
      stage: stage || "not set",
      statusHealth: health,
      runtimeState: peer.state === "busy" ? "running" : "idle",
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
