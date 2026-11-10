export const MEMBER_OUTCOMES = Object.freeze({
  reported: { label: "reported (awaiting review)", tone: "reported", glyphs: ["?", "○", "󰋗"] },
  supported: { label: "supported", tone: "supported", glyphs: ["s", "◇", "󰓎"] },
  accepted: { label: "accepted", tone: "accepted", glyphs: ["+", "✓", "󰄬"] },
  stale: { label: "stale (needs revalidation)", tone: "stale", glyphs: ["~", "↻", "󰑐"] },
  failed: { label: "failed", tone: "failed", glyphs: ["x", "✗", "󰅖"] },
  rejected: { label: "rejected", tone: "failed", glyphs: ["x", "✗", "󰅖"] },
});

const TASK_VERDICTS = {
  accept: "accepted",
  supported: "supported",
  reject: "rejected",
  takeover: "blocked",
};
const TERMINAL_STATUSES = new Set([
  "accepted",
  "supported",
  "rejected",
  "cancelled",
  "conductor_takeover",
  "failed",
]);

/** Decisions own outcomes; legacy completion strings are only worker reports. */
export function memberDisplayState(member = {}) {
  const status = member.status || member.stage || member.progress?.stage || "unknown";
  const decision = Object.hasOwn(TASK_VERDICTS, member.verdict)
    ? TASK_VERDICTS[member.verdict]
    : null;
  if (member.verdict === "reject" || member.verdict === "takeover") return decision;
  if (status === "cancelled" || status === "canceled") return "cancelled";
  if (status === "conductor_takeover") return "blocked";
  if (member.evidenceState === "stale" || status === "stale") return "stale";
  if (decision) return decision;
  if (["completed", "complete", "reported complete", "accepted", "supported"].includes(status))
    return "reported";
  if (member.dispatch && status === "review" && member.runtimeState !== "running")
    return "reported";
  return status || "unknown";
}

export function hasTerminalDecision(member) {
  return Object.hasOwn(TASK_VERDICTS, member.verdict) || TERMINAL_STATUSES.has(member.status);
}

export function isTerminalDisplayState(state) {
  return Object.hasOwn(MEMBER_OUTCOMES, state) || state === "cancelled";
}
