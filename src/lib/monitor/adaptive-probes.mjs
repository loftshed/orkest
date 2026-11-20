// Nearest-rank percentiles over the last 128 completed successes for this account identity.
const WINDOW = 128;
const WARMUP = 5;
const MAX_BACKOFF_MS = 5 * 60_000;

export const PROBE_CEILINGS_MS = { claude: 90_000, codex: 30_000, antigravity: 60_000 };

export function probeTimeoutError(message) {
  return Object.assign(new Error(message), { code: "MONITOR_PROBE_TIMEOUT" });
}

function samples(state) {
  if (!Array.isArray(state?.samplesMs)) return [];
  return state.samplesMs.slice(-WINDOW).filter((ms) => Number.isSafeInteger(ms) && ms >= 0);
}

function quantiles(values) {
  const sorted = values.toSorted((left, right) => left - right);
  const rank = (fraction) => sorted[Math.ceil(sorted.length * fraction) - 1] ?? null;
  return { p95Ms: rank(0.95), p99Ms: rank(0.99) };
}

export function probeDeadline(account, state) {
  const ceiling = account.timeoutMs ?? PROBE_CEILINGS_MS[account.provider];
  const values = samples(state);
  if (values.length < WARMUP) return ceiling;
  const { p95Ms, p99Ms } = quantiles(values);
  // A newly successful recovery may still sit above the historical p99. Keep headroom
  // for recent successes while the rolling percentile catches up to a slower baseline.
  const tail = Math.max(p99Ms, ...values.slice(-5));
  const learned = Math.max(1500, 2 * p95Ms, Math.ceil(1.25 * tail) + 250);
  // Give a recovering provider room to establish a slower baseline.
  return Math.min(ceiling, learned * 2 ** timeoutCount(state));
}

function timeoutCount(state) {
  return Number.isSafeInteger(state?.consecutiveTimeouts)
    ? Math.min(8, Math.max(0, state.consecutiveTimeouts))
    : 0;
}

export function recordProbe(state, { outcome, elapsedMs, deadlineMs, now }) {
  const values = samples(state);
  if (outcome === "success") {
    values.push(elapsedMs);
    if (values.length > WINDOW) values.shift();
  }
  const consecutiveTimeouts = outcome === "timeout" ? Math.min(8, timeoutCount(state) + 1) : 0;
  const backoff = Math.min(MAX_BACKOFF_MS, 15_000 * 2 ** (consecutiveTimeouts - 2));
  return {
    samplesMs: values,
    ...quantiles(values),
    lastDurationMs: elapsedMs,
    lastDeadlineMs: deadlineMs,
    lastOutcome: outcome,
    consecutiveTimeouts,
    retryAt: consecutiveTimeouts >= 2 ? now + backoff : null,
  };
}

/** A future error timestamp or an impossible delay must never strand an account on restart. */
export function breakerRetryAt(entry, now) {
  const retry = entry?.probeHealth?.retryAt;
  if (!Number.isSafeInteger(retry) || !Number.isSafeInteger(entry.errorAt)) return null;
  if (entry.errorAt > now || retry < entry.errorAt || retry - entry.errorAt > MAX_BACKOFF_MS)
    return now;
  return retry;
}
