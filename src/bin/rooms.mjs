import path from "node:path";
import { parseArgs } from "node:util";

import { readDiffMarks } from "../lib/diff-marks.mjs";
import {
  loadPresets,
  mailboxRoot,
  parseTeam,
  readRoom,
  requireActiveRoom,
  updateRoom,
} from "../lib/horde-room.mjs";
import { checkRouteQuota, quotaGate } from "../lib/quota-gate.mjs";
import { integrateMemberWorktree } from "../lib/room-integrate.mjs";
import {
  archiveRoom,
  cancelRoom,
  clearCurrentRoom,
  reactivateRoom,
  reopenRoomView,
  roomHistory,
  searchRooms,
  startFreshRoom,
} from "../lib/room-lifecycle.mjs";
import { resumeRoomStatus } from "../lib/room-resume.mjs";
import {
  assignWorkforceRole,
  bindSession,
  coordinator,
  createMemberWorktree,
  dispatchMember,
  growRoom,
  keepWorktree,
  listRooms,
  newRoom,
  observeRoom,
  pauseBranch,
  readLaunchPlan,
  recoverRoom,
  reserveLead,
  writeCoordinatorBrief,
} from "../lib/rooms.mjs";
import { promoteSession } from "../lib/session-promotion.mjs";
import { plain } from "../lib/tui-box.mjs";

export const ROOMS_HELP = `ork rooms list [--all] [--json]   (current rooms; --all adds archived and cancelled)
ork rooms history [--cwd PATH] [--lifecycle active|archived|cancelled] [--limit N]   (read-only)
ork rooms search --query TEXT [--cwd PATH] [--limit N]   (read-only, every lifecycle)
ork rooms reopen-view --room ID   (read-only; resumes and launches nothing)
ork rooms archive --room ID [--reason TEXT]   (closes new dispatch; running workers stay owned)
ork rooms clear [--room ID] [--cwd PATH] [--session ID]   (archive the current room)
ork rooms start-fresh [--cwd PATH] [--objective TEXT] [--team TEAM] [--engine ENGINE]
                      (archive the current room, then open an empty one)
ork rooms reactivate --room ID   (explicit resume of an archived room)
ork rooms cancel --room ID [--member ID] [--reason TEXT]   (stop owned runs; native interruption is reported uncertain)
ork hall promote [--session ID] [--room ID] [--objective TEXT] [--cwd PATH]   (adopt this live conversation as coordinator)
ork rooms resume-status [--cwd PATH] [--json]   (read-only resume history)
ork rooms show --room ID [--json]
ork hall marks --room ID --member ID [--json]   (read marked diff lines; also ork rooms marks)
ork rooms create --team TEAM [--group GROUP] [--title TITLE] [--cwd PATH] [--id ID] [--authority TEAM_ID]
ork rooms add --room ID --team TEAM [--parent conductor|MEMBER] [--role ROLE] [--cwd PATH] [--confirm-low-quota]
ork rooms lead --room ID --member ID --objective TEXT [--role ROLE] [--cwd PATH] [--keep-worktree] [--confirm-low-quota]
               (reserves a native subswarm lead)
ork rooms role --room ID [--member ID|conductor] --role ROLE [--cwd PATH] [--keep-worktree]   (assign or switch workforce role)
ork rooms worktree --room ID --member ID [--slug SLUG] [--branch BRANCH]   (create a disposable member checkout)
ork rooms integrate --room ID --member ID --message SUBJECT [--target BRANCH]   (commit an accepted result into the smelter queue)
ork rooms worktree-keep --room ID --member ID|conductor [--cwd PATH]   (promote a disposable worktree to persistent)
ork rooms objective --room ID --objective TEXT
ork rooms pause|resume --room ID [--member conductor|MEMBER]   (gates new launches)
ork rooms init-task --task-spec FILE --task-dir DIR (--host codex|claude|agy|opencode|other | --authority TEAM_ID)
                    [--time-budget DURATION]   (task deadline, default 1h)
                    [--max-continues N] [--invocation-allowance N]   (continue cap 0-6, default 3)
ork rooms extend-task --task-dir DIR --add DURATION --reason TEXT   (add time to a task's deadline)
ork rooms dispatch --room ID --member ID --task-dir DIR
                   [--kind investigation|implementation|consultation|challenge|continue|correction]
                   [--transport executor|native] [--packet FILE] [--request-id ID] [--role ROLE] [--cwd PATH]
                   [--timeout DURATION]   (executor runner limit, default 15m; must fit the task deadline)
                   [--allow-credits]   (Codex credit spend; only with the user's permission)
                   [--verify-command CMD]... [--auto-correct ROUNDS]   (implementation gates; rounds 0-2)
                   [--protect-path PATH]...   (files an auto-correct round may not change)
                   [--task-spec FILE]   (required for continue, in the existing task/session)
                   [--evidence FILE | --review-id ID]   (required for correction; --evidence is
                                                        captured and reviewed by the host)
                   [--max-continues N]   (first dispatch only, hard ceiling 6)
                   [--confirm-low-quota]   (go ahead on a low or blocked pool; only with the user's agreement)
ork rooms launch --room ID --plan FILE [--allow-credits] [--confirm-low-quota]
                 (--allow-credits required when a plan member sets allowCredits: true)
ork rooms bind --room ID --member ID|conductor --session ID --engine ENGINE [--role ROLE] [--cwd PATH] [--keep-worktree]
ork rooms recover --room ID

A room or task under a team (--authority) is fenced: init-task, extend-task, dispatch, launch and recover also need
--lead-session and --lead-generation from authority.py show.

create/add queue members. dispatch/launch use the coordinator and may start billable work.
add, lead, dispatch and launch check the member's quota pool with monitor first: a low or blocked pool
stops with monitor's best alternative until --confirm-low-quota is passed.
Native dispatch returns a reservation for the conductor's native tools.
launch plan: {"members":[{"id":"haiku-1","taskDir":"/absolute/task","kind":"investigation","timeout":"25m"}]}
             (an implementation member also takes "verifyCommands":["CMD"], "autoCorrect":1
              and "protectPaths":["PATH"]; add "allowCredits":true plus launch --allow-credits only with the user's permission)
Task specs and task directories use the existing coordinator contract.
`;

export async function roomsCommand(
  argv,
  {
    stdout = process.stdout,
    env = process.env,
    root = mailboxRoot(env),
    run = coordinator,
    exec,
    refreshTerminal,
    stderr = process.stderr,
    quota = checkRouteQuota,
  } = {},
) {
  // parseArgs treats a separate negative number as an option; keep the cap's own error.
  argv = argv.flatMap((argument, index) => {
    if (index > 0 && argv[index - 1] === "--max-continues" && /^-\d/.test(argument)) return [];
    if (argument === "--max-continues" && /^-\d/.test(argv[index + 1] ?? ""))
      return [`${argument}=${argv[index + 1]}`];
    return [argument];
  });
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: "boolean" },
      json: { type: "boolean" },
      "allow-credits": { type: "boolean" },
      "confirm-low-quota": { type: "boolean" },
      all: { type: "boolean" },
      "keep-worktree": { type: "boolean" },
      "verify-command": { type: "string", multiple: true },
      "protect-path": { type: "string", multiple: true },
      ...Object.fromEntries(
        [
          "room",
          "id",
          "team",
          "preset",
          "cwd",
          "group",
          "title",
          "member",
          "slug",
          "branch",
          "task-dir",
          "task-spec",
          "host",
          "kind",
          "transport",
          "packet",
          "request-id",
          "session",
          "engine",
          "plan",
          "billing-mode",
          "authority",
          "lead-session",
          "lead-generation",
          "parent",
          "objective",
          "message",
          "target",
          "role",
          "time-budget",
          "add",
          "evidence",
          "review-id",
          "timeout",
          "auto-correct",
          "max-continues",
          "invocation-allowance",
          "reason",
          "query",
          "limit",
          "lifecycle",
        ].map((name) => [name, { type: "string" }]),
      ),
    },
  });
  const [action] = positionals;
  if (!action || values.help) {
    stdout.write(ROOMS_HELP);
    return;
  }
  if (values["allow-credits"] && action !== "dispatch" && action !== "launch") {
    throw new Error("--allow-credits is only valid on dispatch or launch");
  }
  if (values["confirm-low-quota"] && !["add", "lead", "dispatch", "launch"].includes(action)) {
    throw new Error("--confirm-low-quota is only valid on add, lead, dispatch or launch");
  }
  // Checked before anything changes; a confirmed warning still reaches the caller on stderr.
  const checkQuota = async (routes) => {
    const warnings = quotaGate(await quota(routes, { env }), {
      confirmed: values["confirm-low-quota"] === true,
    });
    for (const warning of warnings) stderr.write(`warning: ${warning}\n`);
  };
  const memberRoutes = async (roomId, memberIds) => {
    const room = await readRoom(roomId, root);
    return memberIds.map((memberId) => {
      const member =
        memberId === "conductor"
          ? room.conductor
          : room.agents.find((agent) => agent.id === memberId);
      return { engine: member?.engine, model: member?.model };
    });
  };
  const requireValue = (name) => {
    if (values[name] === undefined || values[name] === "") throw new Error(`--${name} is required`);
    return values[name];
  };
  const team = async () => {
    if (values.team && values.preset) throw new Error("Choose --team or --preset");
    if (values.preset) {
      const preset = (await loadPresets())[values.preset];
      if (!preset) throw new Error("Unknown preset");
      return parseTeam(preset.team);
    }
    return parseTeam(requireValue("team"));
  };
  const lead = { leadSession: values["lead-session"], leadGeneration: values["lead-generation"] };
  const leadArgs = lead.leadSession
    ? ["--lead-session", lead.leadSession, "--lead-generation", String(lead.leadGeneration)]
    : [];
  let result;
  switch (action) {
    case "promote": {
      result = await promoteSession(
        {
          session: values.session,
          room: values.room,
          objective: values.objective,
          cwd: values.cwd,
          engine: values.engine,
        },
        { root, env, ...(refreshTerminal && { refresh: refreshTerminal }) },
      );
      break;
    }
    case "resume-status": {
      result = await resumeRoomStatus({ root, cwd: values.cwd });
      break;
    }
    case "list": {
      const listing = await listRooms(root, { all: values.all });
      const tasks = new Map();
      const authorities = new Map();
      const rooms = [];
      for (const room of listing.rooms) {
        rooms.push(await observeRoom(room, { root, run, tasks, authorities }));
      }
      result = {
        ...listing,
        rooms,
      };

      break;
    }
    case "history": {
      result = await roomHistory({
        root,
        cwd: values.cwd,
        lifecycle: values.lifecycle,
        ...(values.limit !== undefined && { limit: Number(values.limit) }),
      });
      break;
    }
    case "search": {
      result = await searchRooms(requireValue("query"), {
        root,
        cwd: values.cwd,
        ...(values.limit !== undefined && { limit: Number(values.limit) }),
      });
      break;
    }
    case "reopen-view": {
      result = await reopenRoomView(requireValue("room"), { root });
      break;
    }
    case "archive": {
      result = await archiveRoom(requireValue("room"), {
        root,
        run,
        reason: values.reason,
        by: values.session,
      });
      break;
    }
    case "clear": {
      result = await clearCurrentRoom({
        root,
        run,
        room: values.room,
        cwd: values.cwd,
        session: values.session,
        reason: values.reason,
      });
      break;
    }
    case "start-fresh": {
      result = await startFreshRoom({
        root,
        run,
        cwd: values.cwd,
        session: values.session,
        members: values.team || values.preset ? await team() : [],
        objective: values.objective,
        title: values.title,
        engine: values.engine,
        id: values.id,
      });
      break;
    }
    case "reactivate": {
      result = await reactivateRoom(requireValue("room"), { root, run, by: values.session });
      break;
    }
    case "cancel": {
      result = await cancelRoom(requireValue("room"), {
        root,
        run,
        member: values.member,
        reason: values.reason,
        by: values.session,
      });
      break;
    }
    case "create": {
      result = await newRoom(await team(), {
        root,
        id: values.id,
        cwd: values.cwd,
        group: values.group,
        title: values.title,
        authority: values.authority,
        swarm: { maxAgents: 64, maxDepth: 8 },
      });

      break;
    }
    case "add": {
      const members = await team();
      await checkQuota(members);
      result = await growRoom(requireValue("room"), members, root, values.parent, {
        workforceRole: values.role,
        cwd: values.cwd,
      });

      break;
    }
    case "lead": {
      const roomId = requireValue("room");
      const memberId = requireValue("member");
      const objective = requireValue("objective");
      await checkQuota(await memberRoutes(roomId, [memberId]));
      result = await reserveLead(roomId, memberId, objective, {
        root,
        workforceRole: values.role,
        cwd: values.cwd,
      });
      if (values["keep-worktree"]) await keepWorktree(roomId, memberId, { root, cwd: values.cwd });
      break;
    }
    case "role": {
      const roomId = requireValue("room");
      const memberId = values.member || "conductor";
      if (!values["keep-worktree"] || values.role !== undefined || values.cwd !== undefined) {
        result = await assignWorkforceRole(
          roomId,
          memberId,
          values["keep-worktree"] ? values.role : requireValue("role"),
          { root, cwd: values.cwd },
        );
      }
      if (values["keep-worktree"])
        result = await keepWorktree(roomId, memberId, { root, cwd: values.cwd });
      break;
    }
    case "worktree-keep": {
      result = await keepWorktree(requireValue("room"), requireValue("member"), {
        root,
        cwd: values.cwd,
      });
      break;
    }
    case "worktree": {
      result = await createMemberWorktree(requireValue("room"), requireValue("member"), {
        root,
        run,
        slug: values.slug,
        branch: values.branch,
      });
      break;
    }
    case "integrate": {
      result = await integrateMemberWorktree(requireValue("room"), requireValue("member"), {
        root,
        run,
        exec,
        message: requireValue("message"),
        target: values.target,
      });
      break;
    }
    case "objective": {
      const objective = requireValue("objective");
      if (objective.length > 12_000) throw new Error("Objective must be at most 12000 characters");
      result = await updateRoom(
        requireValue("room"),
        (room) => {
          requireActiveRoom(room);
          room.objective = objective;
          room.title = objective.replaceAll(/\s+/gu, " ").trim().slice(0, 160);
          return room;
        },
        { root },
      );
      if (result.swarm) {
        try {
          await writeCoordinatorBrief(result, { root });
        } catch {
          // Best-effort refresh of conductor.md after objective update.
        }
      }
      break;
    }
    case "pause":
    case "resume": {
      result = await pauseBranch(
        requireValue("room"),
        values.member || "conductor",
        action === "pause",
        { root },
      );
      break;
    }
    case "show": {
      result = await observeRoom(requireValue("room"), { root, run });

      break;
    }
    case "marks": {
      // Observed, not stored: a member's result path only exists once its run has been read, and
      // without it every mark would look stale.
      const room = await observeRoom(requireValue("room"), { root, run });
      const memberId = requireValue("member");
      const member =
        memberId === "conductor"
          ? { ...room.conductor, id: "conductor" }
          : room.agents.find((agent) => agent.id === memberId);
      if (!member) throw new Error(`Unknown member: ${memberId}`);
      const stored = await readDiffMarks(room.id, member, { root });
      result = {
        member: memberId,
        stale: stored.stale,
        marks: stored.marks,
      };
      break;
    }
    case "init-task": {
      if (
        values["max-continues"] !== undefined &&
        (!/^\d+$/.test(values["max-continues"]) || Number(values["max-continues"]) > 6)
      )
        throw new Error("--max-continues must be an integer from 0 to 6 (hard ceiling 6)");
      result = await run([
        "init",
        "--task-spec",
        path.resolve(requireValue("task-spec")),
        "--task-dir",
        path.resolve(requireValue("task-dir")),
        ...(values.authority
          ? ["--authority", values.authority, ...leadArgs]
          : ["--host", requireValue("host")]),
        ...(values["time-budget"] === undefined ? [] : ["--time-budget", values["time-budget"]]),
        ...(values["max-continues"] === undefined
          ? []
          : ["--max-continues", values["max-continues"]]),
        ...(values["invocation-allowance"] === undefined
          ? []
          : ["--invocation-allowance", values["invocation-allowance"]]),
      ]);

      break;
    }
    case "extend-task": {
      result = await run([
        "extend",
        "--task-dir",
        path.resolve(requireValue("task-dir")),
        "--add",
        requireValue("add"),
        "--reason",
        requireValue("reason"),
        ...leadArgs,
      ]);
      break;
    }
    case "dispatch": {
      const roomId = requireValue("room");
      const memberId = requireValue("member");
      requireValue("task-dir");
      await checkQuota(await memberRoutes(roomId, [memberId]));
      result = await dispatchMember(roomId, memberId, {
        root,
        run,
        taskDir: requireValue("task-dir"),
        kind: values.kind,
        transport: values.transport,
        packet: values.packet,
        requestId: values["request-id"],
        billingMode: values["billing-mode"],
        allowCredits: values["allow-credits"],
        workforceRole: values.role,
        cwd: values.cwd,
        timeout: values.timeout,
        verifyCommands: values["verify-command"],
        protectPaths: values["protect-path"],
        autoCorrect: values["auto-correct"],
        maxContinues: values["max-continues"],
        taskSpec: values["task-spec"],
        evidence: values.evidence,
        reviewId: values["review-id"],
        ...lead,
      });

      break;
    }
    case "launch": {
      const plan = await readLaunchPlan(requireValue("plan"));
      const roomId = requireValue("room");
      for (const member of plan.members) {
        if (member.allowCredits !== undefined && typeof member.allowCredits !== "boolean") {
          throw new Error("--allow-credits / allowCredits must be a boolean");
        }
      }
      const planUsesCredits = plan.members.some((member) => member.allowCredits === true);
      if (planUsesCredits && !values["allow-credits"]) {
        throw new Error(
          "Launch plan sets allowCredits: true; pass --allow-credits on `ork rooms launch` only with the user's explicit permission",
        );
      }
      if (values["allow-credits"] && !planUsesCredits) {
        throw new Error(
          "--allow-credits on launch requires a member in the launch plan with allowCredits: true",
        );
      }
      await checkQuota(
        await memberRoutes(
          roomId,
          plan.members.map((member) => member.id),
        ),
      );
      // Stop on first failure. Completed requests are safe to revisit using their persisted IDs.
      result = [];
      for (const member of plan.members)
        result.push(await dispatchMember(roomId, member.id, { ...member, ...lead, root, run }));

      break;
    }
    case "bind": {
      const roomId = requireValue("room");
      const memberId = requireValue("member");
      result = await bindSession(roomId, memberId, {
        root,
        session: requireValue("session"),
        engine: requireValue("engine"),
        workforceRole: values.role,
        cwd: values.cwd,
      });
      if (values["keep-worktree"])
        result = await keepWorktree(roomId, memberId, { root, cwd: values.cwd });

      break;
    }
    case "recover": {
      result = await recoverRoom(requireValue("room"), { root, run, ...lead });

      break;
    }
    default: {
      throw new Error(ROOMS_HELP);
    }
  }
  if (action === "marks" && !values.json) {
    stdout.write(`stale: ${result.stale}\n`);
    if (result.marks.length === 0) stdout.write("[]\n");
    else
      stdout.write(
        `${result.marks
          .map((mark) => {
            const text = plain(mark.text);
            return `${plain(mark.file)}:${mark.line}${text ? ` ${text}` : ""}`;
          })
          .join("\n")}\n`,
      );
  } else {
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
  return result;
}
