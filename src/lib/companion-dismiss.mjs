import { execFile } from "node:child_process";

import { closeHerdrCompanionPane, isHerdrCompanionView } from "./herdr-view-state.mjs";
import { memberDisplayState } from "./member-state.mjs";
import { closeOrcaCompanionPane } from "./orca-context.mjs";

export const COMPANION_DISMISS_GRACE_MS = 4000;

const ACTIVE_MEMBER_STATES = new Set([
  "running",
  "working",
  "planning",
  "testing",
  "review",
  "reserved",
  "queued",
  "dispatching",
  "starting",
]);

const ACTIVE_CONTINUATION_STATES = new Set([
  "requested",
  "reserved",
  "awaiting_attachment",
  "running",
]);

function isConductorLive(room) {
  return room?.conductor?.sessionLive === true || room?.conductor?.runtimeState === "running";
}

/** Whether any worker or open continuation in the room is still running or awaiting finish. */
export function hasActiveRoomWork(room) {
  if (!room || typeof room !== "object") return false;
  if (Array.isArray(room.agents)) {
    for (const agent of room.agents) {
      if (!agent || typeof agent !== "object") continue;
      if (agent.runtimeState === "running" || ACTIVE_MEMBER_STATES.has(memberDisplayState(agent))) {
        return true;
      }
    }
  }
  if (Array.isArray(room.continuations)) {
    for (const item of room.continuations) {
      if (!item || typeof item !== "object") continue;
      if (
        ACTIVE_CONTINUATION_STATES.has(item.status) ||
        ACTIVE_CONTINUATION_STATES.has(item.state)
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Monitor a companion split Swarm View and dismiss it when its orchestrator exits with no
 * active workers left, holding open during handoffs, rebinds, cold post-mortem views, and drills.
 */
export function createCompanionDismissMonitor({
  env = process.env,
  exec = execFile,
  graceMs = COMPANION_DISMISS_GRACE_MS,
  now = Date.now,
  chiefMode = false,
  hasChiefView = false,
} = {}) {
  const isHerdr = isHerdrCompanionView(env);
  const isOrca = Boolean(env?.ORKEST_ORCA_VIEW_STATE) && env?.ORKEST_CHIEF_VIEW !== "1";
  const isActive = !chiefMode && !hasChiefView && (isHerdr || isOrca);

  let hasObservedLiveConductor = false;
  let missingSince = null;
  let hasHoldNotice = false;
  let hasDismissed = false;

  async function evaluate(room, { drilledRoomId } = {}) {
    if (!isActive || drilledRoomId || hasDismissed || !room || typeof room !== "object") {
      missingSince = null;
      return { action: "none" };
    }
    if (isConductorLive(room)) {
      hasObservedLiveConductor = true;
      missingSince = null;
      if (hasHoldNotice) {
        hasHoldNotice = false;
        return { action: "clear-notice" };
      }
      return { action: "none" };
    }
    if (!hasObservedLiveConductor) {
      return { action: "none" };
    }
    if (hasActiveRoomWork(room)) {
      missingSince = null;
      hasHoldNotice = true;
      return {
        action: "hold",
        notice: "Orchestrator exited — keeping Swarm View open while workers finish",
      };
    }
    const timestamp = typeof now === "function" ? now() : now;
    missingSince ??= timestamp;
    if (timestamp - missingSince < graceMs) {
      return { action: "none" };
    }
    const result = isHerdr
      ? await closeHerdrCompanionPane(room.id, { env, exec })
      : await closeOrcaCompanionPane(env.ORKEST_ORCA_VIEW_STATE, { env, exec, now });
    if (result?.multiplexerUnavailable || result?.reason === "close_failed") {
      return { action: "wait", result };
    }
    if (result?.dismissed) {
      hasDismissed = true;
      return { action: "dismiss", result };
    }
    return { action: "none", result };
  }

  return { evaluate };
}
