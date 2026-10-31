import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { mailboxRoot, updateRoom } from "./stooges-room.mjs";

const plugin = fileURLToPath(new URL("../", import.meta.url));

export function swarmMember(room, id = "conductor") {
  const member = id === "conductor" ? room.conductor : room.agents.find((entry) => entry.id === id);
  if (!member) throw new Error(`Unknown member: ${id}`);
  return member;
}

export function requireActiveBranch(room, id) {
  for (let current = id; current;) {
    const member = swarmMember(room, current);
    if (member.paused)
      throw new Error(`Swarm branch ${current} is paused; resume it before launching work`);
    current = current === "conductor" ? null : member.parent || "conductor";
  }
}

/** One room owns the hierarchy and its limits. A native lead is not an audited worker. */
export function coordinatorBrief(room, memberId = "conductor") {
  const member = swarmMember(room, memberId);
  const objective = member.objective || room.objective || "Ask the user what outcome they want.";
  return `You are the ${memberId === "conductor" ? "root coordinator" : "subswarm lead"} of an Orkest swarm.

Room: ${room.id}
Your member ID: ${memberId}
Parent: ${member.parent || "user"}
Repository: ${room.cwd}
Overall objective: ${room.objective || "Awaiting the user's objective"}
Your assignment: ${objective}
${
  !room.objective && memberId === "conductor"
    ? `
Ask the user for their goal in this conversation. Wait for it before creating work assignments or
starting workers. When they supply it, record it with ork rooms objective --room ${room.id}
--objective 'their goal', then organize the work.
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

export async function reserveLead(id, memberId, objective, { root = mailboxRoot() } = {}) {
  if (typeof objective !== "string" || !objective.trim() || objective.length > 12_000)
    throw new Error("A lead needs an objective of 1–12000 characters");
  if (memberId === "conductor") throw new Error("The root coordinator is already a lead");
  let isNew = false;
  const room = await updateRoom(
    id,
    (current) => {
      if (!current.swarm) throw new Error("Native leads require a conversational swarm room");
      requireActiveBranch(current, memberId);
      const member = swarmMember(current, memberId);
      const parent = swarmMember(current, member.parent || "conductor");
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
      member.status = "reserved";
      return current;
    },
    { root },
  );
  const member = swarmMember(room, memberId);
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

export async function pauseBranch(id, memberId, paused, { root = mailboxRoot() } = {}) {
  return updateRoom(
    id,
    (room) => {
      swarmMember(room, memberId).paused = paused;
      return room;
    },
    { root },
  );
}
