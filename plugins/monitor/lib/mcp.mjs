import { createInterface } from "node:readline";

import { jsonView } from "./render.mjs";
import { getAccounts } from "./store.mjs";
import { VERSION } from "./version.mjs";

const INSTRUCTIONS = `Subscription quota across local AI accounts (Claude, Codex, Antigravity/Gemini) for routing work.
Percentages are per-account allowances. surplusPts = weekly % left minus even-pace remainder; positive is under-used capacity lost at reset.
Prefer expiring pools (near weekly rollover) and larger tasks there; pools <10% usable now fit small tasks only.
Status "credits" (Codex after weekly quota) takes any task metered against persistent credits, ranked after free quota; only "blocked" cannot run work.
Respect user rules when switching accounts changes billing context (work vs personal).`;

const TOOLS = [
  {
    name: "get_usage",
    description:
      "Remaining quota for configured AI accounts (5h, weekly, per-model windows with % left and reset time) and ranked pools. Cached; set refresh=true to re-query (~5s).",
    inputSchema: {
      type: "object",
      properties: {
        refresh: { type: "boolean", description: "Bypass cache and query providers now." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "recommend",
    description:
      "Ranks AI account/model pools best-first by remaining quota, reset time, and pace (free quota before credit balances). Filter by family; includes CLI route hints.",
    inputSchema: {
      type: "object",
      properties: {
        family: {
          type: "string",
          enum: ["any", "claude", "gpt", "gemini"],
          description: "Model family filter.",
        },
        refresh: { type: "boolean", description: "Bypass cache and query providers now." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
];

function summarizeUsage(view) {
  const lines = view.accounts.map((a) => {
    const windows = a.windows
      .map((w) => {
        let left = `${Math.floor(w.remainingPct)}% left`;
        if (w.blockedBy) left = `unusable (${w.blockedBy} limit exhausted)`;
        if (w.exhausted) left = "exhausted";
        return `${w.label} ${left}${w.resetsInMinutes == null ? "" : ` (resets in ${Math.round(w.resetsInMinutes / 6) / 10}h)`}`;
      })
      .join(", ");
    const problem = a.error ? ` [refresh failed: ${a.error}]` : "";
    const balance = a.credits ? `, ${a.credits.text} credits` : "";
    return `- ${a.label}: ${windows || "no data"}${balance}${problem}`;
  });
  return lines.join("\n");
}

/** Lines calling out pools whose leftover capacity is lost at an imminent rollover. */
function expiringSummary(lanes) {
  const expiring = lanes.filter((l) => l.expiring && !l.redundant);
  if (expiring.length === 0) return "";
  const hours = (l) => Math.max(0, Math.round((Date.parse(l.expiresAt) - Date.now()) / 3_600_000));
  return `Expiring soon, spend first: ${expiring.map((l) => `${l.label} (${Math.floor(l.weeklyRemainingPct)}% left, resets in ${hours(l)}h at ${l.expiresAt}; ~${l.burnPctPerHour}%/h uses it all)`).join("; ")}\n\n`;
}

// What agents route on, without the display-only fields (pills, sections, headline) that double the tokens.
function compactView(view) {
  const billing = Object.fromEntries(view.accounts.map((a) => [a.id, a.billing]));
  return {
    schema: view.schema,
    generatedAt: view.generatedAt,
    accounts: view.accounts.map((a) => ({
      id: a.id,
      label: a.label,
      provider: a.provider,
      billing: a.billing,
      ok: a.ok,
      error: a.error,
      ageMinutes: a.ageMinutes,
      ...(a.credits && { credits: { text: a.credits.text, unlimited: a.credits.unlimited } }),
      windows: a.windows.map((w) => ({
        label: w.label,
        remainingPct: Math.round(w.remainingPct),
        resetsAt: w.resetsAt,
        ...(w.exhausted && { exhausted: true }),
        ...(w.blockedBy && { blockedBy: w.blockedBy }),
      })),
    })),
    lanes: compactLanes(view.lanes, billing),
  };
}

function compactLanes(lanes, billing) {
  return lanes
    .filter((l) => !l.redundant)
    .map((l) => ({
      label: l.label,
      accountId: l.accountId,
      poolId: l.poolId,
      billing: billing[l.accountId] ?? null,
      families: l.families,
      status: l.status,
      ...(l.credits && { credits: { text: l.credits.text, unlimited: l.credits.unlimited } }),
      availableNowPct: Math.round(l.availableNowPct),
      surplusPts: l.surplusPts,
      blockedUntil: l.blockedUntil,
      ...(l.expiring && {
        expiring: true,
        expiresAt: l.expiresAt,
        burnPctPerHour: l.burnPctPerHour,
      }),
      route: l.route,
      advice: l.advice,
    }));
}

export function summarizeLanes(lanes) {
  let rank = 0;
  return lanes
    .filter((l) => !l.redundant)
    .map((l) => {
      if (l.status === "credits")
        return `${++rank}. ${l.label}${l.route ? ` [${l.route}]` : ""}: ${l.advice}`;
      if (l.status !== "available")
        return `✗ ${l.label}${l.route ? ` [${l.route}]` : ""}: ${l.advice}`;
      const pts =
        l.surplusPts == null
          ? ""
          : `, ${l.surplusPts >= 0 ? "+" : ""}${l.surplusPts} pts vs even pace`;
      return `${++rank}. ${l.label}${l.route ? ` [${l.route}]` : ""}: ${Math.floor(l.availableNowPct)}% usable now${pts}; ${l.advice}`;
    })
    .join("\n");
}

async function callTool(name, rawArgs) {
  const args = rawArgs && typeof rawArgs === "object" ? rawArgs : {};
  const accounts = await getAccounts({ force: args.refresh === true });
  const view = jsonView(accounts);
  if (name === "get_usage") {
    return `${expiringSummary(view.lanes)}${summarizeUsage(view)}\n\n${JSON.stringify(compactView(view))}`;
  }
  if (name === "recommend") {
    const family = args.family && args.family !== "any" ? args.family : null;
    const lanes = family ? view.lanes.filter((l) => l.families.includes(family)) : view.lanes;
    if (lanes.length === 0) return `No configured account serves the ${family} family.`;
    const best = lanes.find((l) => l.status === "available" || l.status === "credits");
    const head = best
      ? `Best right now: ${best.label}${best.route ? ` (use: ${best.route})` : ""}. ${best.advice}.`
      : "Every matching pool is exhausted right now.";
    const billing = Object.fromEntries(view.accounts.map((a) => [a.id, a.billing]));
    return `${expiringSummary(lanes)}${head}\n\n${JSON.stringify({ schema: view.schema, generatedAt: view.generatedAt, lanes: compactLanes(lanes, billing) })}`;
  }
  throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32_602 });
}

const response = (id, body) => ({ jsonrpc: "2.0", id, ...body });

/** One JSON-RPC message in, one response out (null for notifications). */
async function handle(msg) {
  if (!msg || typeof msg !== "object" || Array.isArray(msg))
    return response(null, { error: { code: -32_600, message: "Invalid Request" } });
  const { id, method, params } = msg;
  if (id === undefined || id === null) return null; // notification
  try {
    if (method === "initialize") {
      return response(id, {
        result: {
          protocolVersion: params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "monitor", version: VERSION },
          instructions: INSTRUCTIONS,
        },
      });
    }
    if (method === "ping") return response(id, { result: {} });
    if (method === "tools/list") return response(id, { result: { tools: TOOLS } });
    if (method === "tools/call") {
      if (TOOLS.every((t) => t.name !== params?.name))
        return response(id, { error: { code: -32_602, message: `Unknown tool: ${params?.name}` } });
      try {
        const text = await callTool(params.name, params.arguments);
        return response(id, { result: { content: [{ type: "text", text }] } });
      } catch (error) {
        return response(id, {
          result: {
            content: [{ type: "text", text: `monitor failed: ${error.message}` }],
            isError: true,
          },
        });
      }
    }
    return response(id, { error: { code: -32_601, message: `Method not found: ${method}` } });
  } catch (error) {
    return response(id, { error: { code: -32_603, message: error.message } });
  }
}

export function serveMcp() {
  let inFlight = 0;
  let isStdinClosed = false;
  let lastActivityAt = Date.now();
  const initialPpid = process.ppid;
  const idleMs = Number(process.env.MONITOR_MCP_IDLE_MS ?? 30 * 60_000);
  const shutdown = () => {
    clearInterval(watchdog);
    process.exit(0);
  };
  const maybeExitOnDrain = () => {
    if (isStdinClosed && inFlight === 0) shutdown();
  };
  const watchdog = setInterval(() => {
    if (process.ppid === 1 || process.ppid !== initialPpid) shutdown();
    if (inFlight === 0 && idleMs > 0 && Date.now() - lastActivityAt >= idleMs) shutdown();
  }, 30_000);
  watchdog.unref();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(signal, shutdown);
  process.stdout.on("error", (error) => {
    if (error?.code === "EPIPE") shutdown();
  });
  const write = (payload) => {
    if (!process.stdout.writableEnded) process.stdout.write(`${JSON.stringify(payload)}\n`);
  };
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("close", () => {
    isStdinClosed = true;
    maybeExitOnDrain();
  });
  process.stdin.on("end", () => {
    isStdinClosed = true;
    maybeExitOnDrain();
  });
  rl.on("line", async (line) => {
    lastActivityAt = Date.now();
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return write(response(null, { error: { code: -32_700, message: "Parse error" } }));
    }
    inFlight++;
    try {
      // JSON-RPC batches (MCP 2025-03-26): answer with one array, leaving out notifications.
      if (Array.isArray(msg)) {
        if (msg.length === 0)
          return write(
            response(null, { error: { code: -32_600, message: "Invalid Request: empty batch" } }),
          );
        const replies = (await Promise.all(msg.map(handle))).filter(Boolean);
        if (replies.length > 0) write(replies);
        return;
      }
      const reply = await handle(msg);
      if (reply) write(reply);
    } finally {
      inFlight--;
      lastActivityAt = Date.now();
      maybeExitOnDrain();
    }
  });
}
