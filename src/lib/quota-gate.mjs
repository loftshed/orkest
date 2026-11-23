/**
 * Quota check before a room member is added, made a lead or dispatched. It reads monitor's snapshot (fresh,
 * or cached within monitor's max age) and asks quota.check, the decision run_agent's quota gate makes,
 * which pool pays for each engine and model. A `low` or `blocked` pool needs explicit confirmation; the
 * message names monitor's best alternative. A low pool monitor marks use-it-or-lose-it (its `expiring` flag,
 * with the 5% floor) passes with a note. Nothing here switches accounts or billing.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS_DIR = fileURLToPath(new URL("../py/", import.meta.url));
const GATED = new Set(["low", "blocked"]);
const ENGINE_FOR_PROVIDER = { claude: "claude", codex: "codex", antigravity: "agy" };
// Long enough for a provider refresh, short enough that a hung probe cannot hold up a room command.
const LOOKUP_TIMEOUT_MS = 30_000;

const CHECK_PY = `
import json, sys
sys.path.insert(0, sys.argv[1])
import quota
payload = json.loads(sys.stdin.read())
out = []
for route in payload["routes"]:
    result = quota.check(route["engine"], route["model"], payload["view"])
    out.append({key: result.get(key) for key in ("status", "label", "accountId", "poolId", "availableNowPct", "advice", "spendToZero")})
print(json.dumps(out))
`;

function monitorConfigPath(env) {
  const home = env.HOME || homedir();
  const override = env.MONITOR_CONFIG?.trim();
  if (override === "~") return home;
  if (override?.startsWith("~/")) return path.join(home, override.slice(2));
  if (override) return override;
  return path.join(home, ".config", "monitor", "config.json");
}

/** Monitor's snapshot view, or null when monitor is not set up here or does not answer in time. */
async function monitorView(env) {
  if (!existsSync(monitorConfigPath(env))) return null;
  try {
    const [{ getAccounts }, { jsonView }] = await Promise.all([
      import("./monitor/store.mjs"),
      import("./monitor/render.mjs"),
    ]);
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), LOOKUP_TIMEOUT_MS);
      timer.unref?.();
    });
    const accounts = await Promise.race([getAccounts(), timeout]);
    clearTimeout(timer);
    return accounts ? jsonView(accounts) : null;
  } catch {
    return null;
  }
}

function checkRoutes(routes, view, env) {
  const result = spawnSync("python3", ["-I", "-c", CHECK_PY, SCRIPTS_DIR], {
    input: JSON.stringify({ routes, view }),
    encoding: "utf8",
    env,
    timeout: LOOKUP_TIMEOUT_MS,
  });
  try {
    const parsed = JSON.parse(result.stdout.trim().split("\n").at(-1));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Monitor's first-ranked pool with room now, other than the one being checked (`monitor recommend`). */
export function bestAlternative(view, { accountId, poolId } = {}) {
  const providers = new Map((view?.accounts ?? []).map((a) => [a.id, a.provider]));
  const lane = (view?.lanes ?? []).find(
    (l) =>
      !l.redundant &&
      l.status === "available" &&
      !l.lowRoom &&
      !l.stale &&
      !(l.accountId === accountId && l.poolId === poolId),
  );
  if (!lane) return null;
  return {
    label: lane.label,
    engine: ENGINE_FOR_PROVIDER[providers.get(lane.accountId)] ?? null,
    route: lane.route ?? null,
    availableNowPct: lane.availableNowPct,
  };
}

/**
 * Each distinct engine/model route with its pool status, plus monitor's best alternative. Empty when
 * monitor is not set up or cannot answer: an unknown pool is not a reason to stop.
 */
export async function checkRouteQuota(routes, { env = process.env, view } = {}) {
  const distinct = new Map(
    routes
      .filter((r) => r?.engine)
      .map((r) => [`${r.engine}\n${r.model ?? ""}`, { engine: r.engine, model: r.model ?? "" }]),
  )
    .values()
    .toArray();
  if (distinct.length === 0) return [];
  const snapshot = view === undefined ? await monitorView(env) : view;
  if (!snapshot) return [];
  return checkRoutes(distinct, snapshot, env).map((decision, index) => ({
    ...distinct[index],
    ...decision,
    alternative: GATED.has(decision?.status) ? bestAlternative(snapshot, decision) : null,
  }));
}

function describe(finding) {
  const route = finding.model ? `${finding.engine}:${finding.model}` : finding.engine;
  const pool = finding.label || finding.engine;
  const usable = Number.isFinite(finding.availableNowPct)
    ? `${Math.floor(finding.availableNowPct)}% usable now`
    : "";
  const state = finding.status === "blocked" ? "blocked" : "low";
  const detail = [usable, finding.advice].filter(Boolean).join("; ");
  const alt = finding.alternative;
  const alternative = alt
    ? ` Monitor's best alternative: ${alt.label}, ${Math.floor(alt.availableNowPct)}% usable now${alt.engine ? ` (engine ${alt.engine})` : ""}; see monitor recommend.`
    : " Monitor has no other pool with room now; see monitor recommend.";
  return `${pool} quota is ${state} for ${route}${detail ? ` (${detail})` : ""}.${alternative}`;
}

/** A low pool monitor marks use-it-or-lose-it (quota.check's spendToZero): spend it, do not gate. */
const isSpentToZero = (finding) => finding.status === "low" && Boolean(finding.spendToZero);

function spendNote(finding) {
  const route = finding.model ? `${finding.engine}:${finding.model}` : finding.engine;
  const spend = finding.spendToZero;
  return `${finding.label || finding.engine} quota is low for ${route}, but its ${spend.window} remainder (${Math.floor(spend.remainingPct)}%) is lost at the reset (${spend.resetsAt}) unless spent: use it or lose it; a quota handoff happens only on exhaustion.`;
}

/**
 * Stops on a `low` or `blocked` pool unless confirmed; once confirmed, returns the warnings to print.
 * A low pool monitor marks use-it-or-lose-it passes with a note. Healthy, unknown and unmonitored pools
 * pass silently.
 */
export function quotaGate(findings, { confirmed = false } = {}) {
  const notes = findings.filter(isSpentToZero).map(spendNote);
  const flagged = findings.filter((f) => GATED.has(f.status) && !isSpentToZero(f));
  if (flagged.length === 0) return notes;
  const messages = flagged.map(describe);
  if (!confirmed)
    throw new Error(
      `${messages.join("\n")}\nPass --confirm-low-quota to go ahead on this pool anyway, after checking with the user. Orkest never switches accounts or billing for you.`,
    );
  return [...notes, ...messages];
}
