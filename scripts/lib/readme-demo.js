/** Invented accounts, agents and services for the README screenshots: no real session data. */

/** The fixed clock every screenshot is rendered at. */
export const DEMO_NOW = Date.parse("2026-11-10T17:00:00Z");

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const REPO = "/home/dev/src/payments-api";

function quotaWindow(id, label, kind, remainingPct, resetsIn, extra = {}) {
  return {
    id,
    label,
    kind,
    windowMins: kind === "5h" ? 300 : 10_080,
    usedPct: 100 - remainingPct,
    remainingPct,
    resetsAt: DEMO_NOW + resetsIn,
    ...extra,
  };
}

function claudeAccount(id, label, short, route, billing, session, week) {
  return {
    id,
    provider: "claude",
    label,
    short,
    route,
    billing,
    ok: true,
    fetchedAt: DEMO_NOW - 40_000,
    plan: "subscription",
    windows: [
      quotaWindow("5h", "5-hour", "5h", ...session),
      quotaWindow("week", "weekly", "weekly", ...week),
    ],
    pools: [{ id: "all", label: "all models", families: ["claude"], windowIds: ["5h", "week"] }],
  };
}

/** Accounts in the shape of a monitor snapshot. */
export function demoAccounts() {
  return [
    claudeAccount(
      "claude-work",
      "Claude · work",
      "CW",
      "claude",
      "work",
      [72, 2.5 * HOUR],
      [38, 2.6 * DAY],
    ),
    claudeAccount(
      "claude-personal",
      "Claude · personal",
      "CP",
      "plaude",
      "personal",
      [100, 5 * HOUR],
      [89, 3.2 * DAY],
    ),
    {
      id: "codex",
      provider: "codex",
      label: "Codex · ChatGPT",
      short: "CX",
      route: "codex",
      billing: "work",
      ok: true,
      fetchedAt: DEMO_NOW - 40_000,
      plan: "pro",
      windows: [quotaWindow("weekly", "weekly", "weekly", 45, 4.6 * DAY)],
      pools: [{ id: "codex", label: "Codex models", families: ["gpt"], windowIds: ["weekly"] }],
    },
    {
      id: "antigravity",
      provider: "antigravity",
      label: "Antigravity",
      short: "AG",
      route: "agy",
      routes: { gemini: "agy --model gemini:best", "claude-gpt": "agy --model claude:best" },
      billing: "work",
      ok: true,
      fetchedAt: DEMO_NOW - 40_000,
      windows: [
        quotaWindow("gemini-weekly", "Gemini weekly", "weekly", 76, 2.1 * DAY, { pool: "gemini" }),
        quotaWindow("gemini-5h", "Gemini 5-hour", "5h", 91, 3 * HOUR, { pool: "gemini" }),
        quotaWindow("claude-gpt-weekly", "Claude & GPT weekly", "weekly", 0, 0.4 * DAY, {
          pool: "claude-gpt",
        }),
        quotaWindow("claude-gpt-5h", "Claude & GPT 5-hour", "5h", 100, 5 * HOUR, {
          pool: "claude-gpt",
        }),
      ],
      pools: [
        {
          id: "gemini",
          label: "Gemini",
          families: ["gemini"],
          windowIds: ["gemini-weekly", "gemini-5h"],
        },
        {
          id: "claude-gpt",
          label: "Claude & GPT",
          families: ["claude", "gpt-oss"],
          windowIds: ["claude-gpt-weekly", "claude-gpt-5h"],
        },
      ],
    },
  ];
}

/** A swarm room with a lead, three workers at different stages and one nested reviewer. */
export function demoRoom() {
  return {
    id: "demo-room",
    title: "Fix stale cache invalidation",
    objective: "Find out why the cache goes stale and ship a tested fix",
    cwd: REPO,
    herdrCoordinatorPaneId: "w1:p1",
    conductor: {
      id: "lead",
      name: "atlas",
      status: "running",
      engine: "claude",
      model: "claude:best",
      effort: "high",
      objective: "Coordinate the cache fix and review worker patches",
      herdrPaneId: "w1:p1",
      progress: {
        task: "Reviewing the TTL patch",
        stage: "review",
        updatedAt: "2026-11-10T16:59:50Z",
      },
    },
    agents: [
      {
        id: "birch",
        name: "birch",
        status: "working",
        engine: "codex",
        model: "gpt:sol",
        effort: "high",
        objective: "Patch the TTL race in the Redis store",
        herdrPaneId: "w1:p2",
        output: ["Added regression test", "Running focused cache tests"],
        checklist: { completed: 2, total: 4 },
        progress: {
          task: "Running focused cache tests",
          stage: "testing",
          role: "builder",
          updatedAt: "2026-11-10T16:59:45Z",
        },
      },
      {
        id: "cedar",
        name: "cedar",
        status: "working",
        engine: "agy",
        model: "gemini:best",
        effort: "high",
        objective: "Cold-review the eviction ordering diff",
        parent: "birch",
        herdrPaneId: "w1:p3",
        output: ["Reading eviction ordering"],
        progress: {
          task: "Comparing eviction order with main",
          stage: "review",
          role: "reviewer",
          updatedAt: "2026-11-10T16:59:40Z",
        },
      },
      {
        id: "rowan",
        name: "rowan",
        status: "blocked",
        engine: "claude",
        model: "claude:fast",
        objective: "Add cache metrics to the dashboard",
        question: "Should stale reads count as misses?",
        herdrPaneId: "w1:p4",
        output: ["Wiring hit-rate counters"],
        progress: { role: "builder" },
      },
      {
        id: "maple",
        name: "maple",
        status: "completed",
        engine: "agy",
        model: "gemini:fast",
        objective: "Trace the stale read path across replicas",
        output: ["Stale read comes from replica lag after TTL refresh"],
        progress: { role: "scout" },
      },
    ],
    accounts: demoAccounts(),
    services: [
      { name: "vite", port: 5173, status: "running", uptime: "14m", cwd: REPO },
      { name: "postgres:16", port: 5432, status: "running", uptime: "2h", kind: "docker" },
    ],
    messages: [{ from: "birch", text: "TTL patch is ready for review" }],
    swarm: { maxAgents: 12, maxDepth: 3 },
  };
}

/** What the builder's terminal shows in the live preview screenshot. */
export const DEMO_TERMINAL = [
  "› Patch the TTL race in the Redis store and add a regression test.",
  "",
  "● The race is in refresh(): the TTL is read before the write lock is taken, so a",
  "  concurrent refresh can extend an entry that was just evicted.",
  "",
  "● Edit src/cache/redis-store.ts",
  "  └ Take the lock before reading the TTL (+9 −4)",
  "",
  "● Write tests/cache/ttl-race.test.ts",
  "  └ Two refreshes racing an eviction (+41)",
  "",
  "● Bash ork gate -- vitest run tests/cache",
  "  └ 18 passed (2 files) in 1.9s",
  "",
  "● The regression test fails on main and passes with the patch.",
  "  Running the wider cache suite before I report back.",
].join("\n");
