export const CHECKPOINT_LIFETIME_MS = 86_400_000;

const hash = /^[a-f0-9]{64}$/u;
const publicId = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;

function keys(object, expected) {
  return (
    object &&
    typeof object === "object" &&
    !Array.isArray(object) &&
    Object.keys(object).length === expected.length &&
    expected.every((key) => Object.hasOwn(object, key))
  );
}

export function isExportableScope(scope) {
  return (
    typeof scope === "string" &&
    scope.length > 0 &&
    Buffer.byteLength(scope) <= 256 &&
    [...scope].every((c) => !(c.codePointAt(0) < 32 || c.codePointAt(0) === 127)) &&
    scope !== "mailbox-local" &&
    scope !== "rooms-local" &&
    !scope.startsWith("local:")
  );
}

function validLimit(limit) {
  return (
    keys(limit, ["id", "remainingPct", "windowMins", "resetsAt"]) &&
    typeof limit.id === "string" &&
    publicId.test(limit.id) &&
    Number.isFinite(limit.remainingPct) &&
    limit.remainingPct >= 0 &&
    limit.remainingPct <= 100 &&
    (limit.windowMins === null ||
      (Number.isSafeInteger(limit.windowMins) && limit.windowMins > 0)) &&
    (limit.resetsAt === null || (Number.isSafeInteger(limit.resetsAt) && limit.resetsAt >= 0))
  );
}

export function validPayload({ scope, kind, entity, body }) {
  switch (kind) {
    case "room.record": {
      return (
        scope === "rooms-local" &&
        (keys(body, ["removed", "room"]) ||
          (keys(body, ["removed", "room", "project"]) &&
            (body.project === null || hash.test(body.project))) ||
          (keys(body, ["removed", "room", "project", "projectVerified"]) &&
            (body.project === null || hash.test(body.project)) &&
            typeof body.projectVerified === "boolean")) &&
        typeof body.removed === "boolean" &&
        (body.removed ? body.room === null : body.room?.id === entity)
      );
    }
    case "room.summary": {
      return (
        scope === "room:" + entity &&
        keys(body, ["removed", "lifecycle", "members"]) &&
        typeof body.removed === "boolean" &&
        ["active", "archived", "cancelled"].includes(body.lifecycle) &&
        Number.isSafeInteger(body.members) &&
        body.members >= 0
      );
    }
    case "foundry.transition": {
      const statuses = [
        "abandoned",
        "completed",
        "escalated",
        "gate_failed",
        "launch_uncertain",
        "launching",
        "merged",
        "needs_human",
        "noop",
        "pr_closed",
        "pr_conflict",
        "pr_creating",
        "pr_lookup_failed",
        "pr_opened",
        "pr_unverified",
        "review_changes_requested",
        "running",
        "scope_violated",
        "stale",
        "verification_failed",
        "verified",
        "worker_failed",
        "other",
      ];
      return (
        scope.startsWith("room:") &&
        /^[a-f0-9]{32}$/u.test(entity) &&
        keys(body, ["revision", "status", "attempt", "attemptStatus", "pr"]) &&
        Number.isSafeInteger(body.revision) &&
        body.revision > 0 &&
        statuses.includes(body.status) &&
        Number.isSafeInteger(body.attempt) &&
        body.attempt >= 0 &&
        [null, "launching", "running", "finished", "failed", "uncertain"].includes(
          body.attemptStatus,
        ) &&
        [null, "OPEN", "MERGED", "CLOSED", "UNKNOWN"].includes(body.pr)
      );
    }
    case "chief.item": {
      return (
        scope.startsWith("room:") &&
        /^[a-f0-9]{32}$/u.test(entity) &&
        keys(body, ["state", "kind"]) &&
        body.state === "queued" &&
        ["done", "escalation", "update", "question", "other"].includes(body.kind)
      );
    }
    case "chief.ack": {
      return (
        scope.startsWith("room:") &&
        /^[a-f0-9]{32}$/u.test(entity) &&
        keys(body, ["state"]) &&
        body.state === "acked"
      );
    }
    case "peer.presence": {
      return (
        isExportableScope(scope) &&
        hash.test(entity) &&
        keys(body, ["present", "observedAt"]) &&
        typeof body.present === "boolean" &&
        Number.isSafeInteger(body.observedAt) &&
        body.observedAt > 0
      );
    }
    case "mailbox.peer": {
      return (
        scope === "mailbox-local" &&
        hash.test(entity) &&
        keys(body, ["present"]) &&
        typeof body.present === "boolean"
      );
    }
    case "mailbox.inbox": {
      return (
        scope === "mailbox-local" &&
        hash.test(entity) &&
        keys(body, ["state"]) &&
        ["unread", "read", "removed"].includes(body.state)
      );
    }
    case "monitor.quota": {
      return (
        isExportableScope(scope) &&
        typeof entity === "string" &&
        publicId.test(entity) &&
        keys(body, ["provider", "observedAt", "stale", "limits"]) &&
        ["claude", "codex", "antigravity"].includes(body.provider) &&
        Number.isSafeInteger(body.observedAt) &&
        body.observedAt > 0 &&
        typeof body.stale === "boolean" &&
        Array.isArray(body.limits) &&
        body.limits.length <= 128 &&
        body.limits.every(validLimit)
      );
    }
    default: {
      return false;
    }
  }
}

// Receipt time caps freshness even when the producer clock is ahead. Replays retain first receipt.
export const PRESENCE_TTL_MS = 120_000;
export const QUOTA_TTL_MS = 900_000;

export function observationFreshness(kind, body, receivedAt, now) {
  if (kind !== "peer.presence" && kind !== "monitor.quota") return null;
  const expiresAt =
    Math.min(body.observedAt, receivedAt) +
    (kind === "peer.presence" ? PRESENCE_TTL_MS : QUOTA_TTL_MS);
  const isExpired = receivedAt <= 0 || now < receivedAt || now >= expiresAt;
  return kind === "peer.presence"
    ? { observedAt: body.observedAt, receivedAt, expiresAt, present: body.present && !isExpired }
    : { observedAt: body.observedAt, receivedAt, expiresAt, stale: body.stale || isExpired };
}
