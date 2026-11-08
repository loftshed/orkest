import path from "node:path";
import { parseArgs } from "node:util";

import { loadPresets, mailboxRoot, parseTeam, updateRoom } from "../lib/horde-room.mjs";
import { resumeRoomStatus } from "../lib/room-resume.mjs";
import {
  assignWorkforceRole,
  bindSession,
  coordinator,
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

export const ROOMS_HELP = `ork rooms list [--json]
ork hall promote [--session ID] [--room ID] [--objective TEXT] [--cwd PATH]   (adopt this live conversation as coordinator)
ork rooms resume-status [--cwd PATH] [--json]   (read-only resume history)
ork rooms show --room ID [--json]
ork rooms create --team TEAM [--group GROUP] [--title TITLE] [--cwd PATH] [--id ID] [--authority TEAM_ID]
ork rooms add --room ID --team TEAM [--parent conductor|MEMBER] [--role ROLE] [--cwd PATH]
ork rooms lead --room ID --member ID --objective TEXT [--role ROLE] [--cwd PATH] [--keep-worktree]   (reserves a native subswarm lead)
ork rooms role --room ID [--member ID|conductor] --role ROLE [--cwd PATH] [--keep-worktree]   (assign or switch workforce role)
ork rooms worktree-keep --room ID --member ID|conductor [--cwd PATH]   (promote a disposable worktree to persistent)
ork rooms objective --room ID --objective TEXT
ork rooms pause|resume --room ID [--member conductor|MEMBER]   (gates new launches)
ork rooms init-task --task-spec FILE --task-dir DIR (--host codex|claude|agy|opencode|other | --authority TEAM_ID)
                    [--time-budget DURATION]   (task deadline, default 1h)
ork rooms dispatch --room ID --member ID --task-dir DIR [--kind investigation|implementation|consultation|challenge]
                   [--transport executor|native] [--packet FILE] [--request-id ID] [--role ROLE] [--cwd PATH]
                   [--timeout DURATION]   (executor runner limit, default 15m; must fit the task deadline)
                   [--verify-command CMD]... [--auto-correct ROUNDS]   (implementation gates; rounds 0-2)
                   [--protect-path PATH]...   (files an auto-correct round may not change)
ork rooms launch --room ID --plan FILE
ork rooms bind --room ID --member ID|conductor --session ID --engine ENGINE [--role ROLE] [--cwd PATH] [--keep-worktree]
ork rooms recover --room ID

A room or task under a team (--authority) is fenced: init-task, dispatch, launch and recover also need
--lead-session and --lead-generation from authority.py show.

create/add queue members. dispatch/launch use the coordinator and may start billable work.
Native dispatch returns a reservation for the conductor's native tools.
launch plan: {"members":[{"id":"haiku-1","taskDir":"/absolute/task","kind":"investigation","timeout":"25m"}]}
             (an implementation member also takes "verifyCommands":["CMD"], "autoCorrect":1
              and "protectPaths":["PATH"])
Task specs and task directories use the existing coordinator contract.
`;

export async function roomsCommand(
  argv,
  {
    stdout = process.stdout,
    env = process.env,
    root = mailboxRoot(env),
    run = coordinator,
    refreshTerminal,
  } = {},
) {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: "boolean" },
      json: { type: "boolean" },
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
          "role",
          "time-budget",
          "timeout",
          "auto-correct",
        ].map((name) => [name, { type: "string" }]),
      ),
    },
  });
  const [action] = positionals;
  if (!action || values.help) {
    stdout.write(ROOMS_HELP);
    return;
  }
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
      const listing = await listRooms(root);
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
      result = await growRoom(requireValue("room"), await team(), root, values.parent, {
        workforceRole: values.role,
        cwd: values.cwd,
      });

      break;
    }
    case "lead": {
      const roomId = requireValue("room");
      const memberId = requireValue("member");
      result = await reserveLead(roomId, memberId, requireValue("objective"), {
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
    case "objective": {
      const objective = requireValue("objective");
      if (objective.length > 12_000) throw new Error("Objective must be at most 12000 characters");
      result = await updateRoom(
        requireValue("room"),
        (room) => {
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
    case "init-task": {
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
      ]);

      break;
    }
    case "dispatch": {
      result = await dispatchMember(requireValue("room"), requireValue("member"), {
        root,
        run,
        taskDir: requireValue("task-dir"),
        kind: values.kind,
        transport: values.transport,
        packet: values.packet,
        requestId: values["request-id"],
        billingMode: values["billing-mode"],
        workforceRole: values.role,
        cwd: values.cwd,
        timeout: values.timeout,
        verifyCommands: values["verify-command"],
        protectPaths: values["protect-path"],
        autoCorrect: values["auto-correct"],
        ...lead,
      });

      break;
    }
    case "launch": {
      const plan = await readLaunchPlan(requireValue("plan"));
      const roomId = requireValue("room");
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
  stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}
