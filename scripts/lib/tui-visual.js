import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify, stripVTControlCharacters } from "node:util";

import { displayWidth } from "../../plugins/orchestrate/lib/tui-box.mjs";
import { ansiToWindowSvg } from "./readme.js";

const execute = promisify(execFile);
const runner = fileURLToPath(new URL("../test-tui-visual.js", import.meta.url));
const FIXED_TIME = Date.parse("2026-01-15T12:00:00Z");

export const VISUAL_CASES = Object.freeze([
  {
    name: "overview-dark-48",
    scenario: "overview",
    cols: 48,
    rows: 32,
    palette: "dark",
    tier: "nerd",
  },
  {
    name: "overview-light-100",
    scenario: "overview",
    cols: 100,
    rows: 32,
    palette: "light",
    tier: "nerd",
  },
  {
    name: "overview-mono-100",
    scenario: "overview",
    cols: 100,
    rows: 32,
    palette: "mono",
    tier: "ascii",
  },
  {
    name: "quota-expanded-100",
    scenario: "quota-expanded",
    cols: 100,
    rows: 40,
    palette: "dark",
    tier: "nerd",
  },
  {
    name: "shortcuts-dark-48",
    scenario: "shortcuts",
    cols: 48,
    rows: 32,
    palette: "dark",
    tier: "nerd",
  },
  {
    name: "preview-dark-160",
    scenario: "preview",
    cols: 160,
    rows: 40,
    palette: "dark",
    tier: "nerd",
  },
  {
    name: "preview-mono-48",
    scenario: "preview",
    cols: 48,
    rows: 32,
    palette: "mono",
    tier: "unicode",
  },
  {
    name: "diff-dark-100",
    scenario: "diff",
    cols: 100,
    rows: 40,
    palette: "dark",
    tier: "nerd",
  },
  {
    name: "diff-marks-dark-100",
    scenario: "diff-marks",
    cols: 100,
    rows: 40,
    palette: "dark",
    tier: "nerd",
  },
  {
    name: "overview-nerd-100",
    scenario: "overview",
    cols: 100,
    rows: 40,
    palette: "dark",
    tier: "nerd",
  },
  {
    name: "quota-hover-100",
    scenario: "quota-hover",
    cols: 100,
    rows: 40,
    palette: "dark",
    tier: "nerd",
  },
  {
    name: "activity-dark-160",
    scenario: "activity",
    cols: 160,
    rows: 40,
    palette: "dark",
    tier: "nerd",
  },
  {
    name: "activity-light-100",
    scenario: "activity",
    cols: 100,
    rows: 40,
    palette: "light",
    tier: "nerd",
  },
  {
    name: "processes-dark-100",
    scenario: "processes",
    cols: 100,
    rows: 40,
    palette: "dark",
    tier: "nerd",
  },
  {
    name: "cascade-deep-56",
    scenario: "cascade-deep",
    cols: 56,
    rows: 32,
    palette: "dark",
    tier: "nerd",
  },
  {
    name: "cascade-deep-100",
    scenario: "cascade-deep",
    cols: 100,
    rows: 34,
    palette: "dark",
    tier: "nerd",
  },
  {
    name: "crowded-all-panels-56",
    scenario: "crowded-all-panels",
    cols: 56,
    rows: 30,
    palette: "dark",
    tier: "nerd",
  },
  {
    name: "multi-worktree-subswarms",
    scenario: "multi-worktree-subswarms",
    cols: 68,
    rows: 32,
    palette: "dark",
    tier: "nerd",
  },
]);

export function syntheticRoom() {
  return {
    id: "visual-room",
    title: "Improve search results",
    objective: "Make search results easier to review",
    cwd: "/workspace/demo",
    herdrCoordinatorPaneId: "w1:p1",
    conductor: {
      id: "lead",
      name: "Lead",
      status: "running",
      objective: "Coordinate the search update",
      herdrPaneId: "w1:p1",
    },
    agents: [
      {
        id: "builder",
        name: "Builder",
        status: "working",
        engine: "codex",
        model: "gpt:sol",
        effort: "high",
        objective: "Improve result grouping",
        herdrPaneId: "w1:p2",
        output: ["Grouped matching results", "Checking keyboard navigation"],
        progress: {
          task: "Checking keyboard navigation",
          stage: "testing",
          updatedAt: "2026-01-15T11:59:45Z",
        },
      },
      {
        id: "reviewer",
        name: "Reviewer",
        status: "blocked",
        engine: "claude",
        model: "claude:best",
        objective: "Review the search changes",
        question: "Should archived results appear by default?",
        output: ["Reviewing empty states"],
        herdrPaneId: "w1:p3",
      },
      {
        id: "scout",
        name: "Scout",
        status: "completed",
        engine: "agy",
        model: "gemini:fast",
        objective: "Check existing search patterns",
        output: ["Found three reusable patterns"],
      },
    ],
    accounts: [
      {
        id: "claude-work",
        label: "Claude work",
        provider: "claude",
        short: "CW",
        fetchedAt: FIXED_TIME,
        windows: [
          {
            id: "session",
            label: "session",
            pool: "all",
            remainingPct: 72,
            resetsAt: "2026-01-15T15:00:00Z",
          },
          {
            id: "weekly",
            label: "week",
            pool: "fable",
            remainingPct: 44,
            resetsAt: "2026-01-19T12:00:00Z",
          },
        ],
      },
      {
        id: "claude-personal",
        label: "Claude personal",
        provider: "claude",
        short: "CP",
        fetchedAt: FIXED_TIME,
        windows: [
          {
            id: "session",
            label: "session",
            pool: "all",
            remainingPct: 88,
            resetsAt: "2026-01-15T17:00:00Z",
          },
        ],
      },
      {
        id: "antigravity",
        short: "AG",
        provider: "antigravity",
        fetchedAt: FIXED_TIME,
        windows: [
          {
            id: "claude-session",
            label: "session",
            pool: "claude-gpt",
            remainingPct: 33,
            resetsAt: "2026-01-15T16:00:00Z",
          },
          {
            id: "gemini-session",
            label: "session",
            pool: "gemini",
            remainingPct: 79,
            resetsAt: "2026-01-15T18:00:00Z",
          },
        ],
      },
      {
        id: "codex",
        provider: "codex",
        short: "CX",
        fetchedAt: FIXED_TIME,
        windows: [{ id: "session", label: "session", remainingPct: 82 }],
      },
    ],
    services: [{ name: "Demo server", port: 5179, status: "running", uptime: "2m" }],
    messages: [{ from: "Builder", text: "Search grouping is ready for review" }],
    swarm: { maxAgents: 6, maxDepth: 3 },
  };
}

export async function renderFixture(repo, spec) {
  const { HordeView } = await import(
    pathToFileURL(path.join(repo, "plugins/orchestrate/lib/horde-view.mjs")).href
  );
  const room = syntheticRoom();
  switch (spec.scenario) {
    case "cascade-deep": {
      room.agents = [
        {
          id: "search-lead",
          name: "SearchLead",
          parent: "conductor",
          engine: "claude",
          model: "claude:best",
          status: "working",
          role: "lead",
          objective: "Coordinate search engine revamp",
          progress: {
            task: "Overseeing query parser and index pipeline",
            stage: "working",
            updatedAt: "2026-01-15T11:59:00Z",
          },
        },
        {
          id: "parser-lead",
          name: "ParserLead",
          parent: "search-lead",
          engine: "codex",
          model: "gpt:sol",
          status: "working",
          objective: "Build AST parser for queries",
          progress: {
            task: "Tokenizing filter operators",
            stage: "parsing",
            updatedAt: "2026-01-15T11:59:10Z",
          },
        },
        {
          id: "ast-builder",
          name: "AstBuilder",
          parent: "parser-lead",
          engine: "codex",
          model: "gpt:astra",
          status: "working",
          objective: "Construct syntax tree nodes",
          progress: {
            task: "Generating boolean operator nodes",
            stage: "ast",
            updatedAt: "2026-01-15T11:59:20Z",
          },
        },
        {
          id: "opt-pass",
          name: "OptPass",
          parent: "ast-builder",
          engine: "agy",
          model: "gemini:pro",
          status: "working",
          objective: "Constant folding on filters",
          progress: {
            task: "Simplifying redundant clauses",
            stage: "opt",
            updatedAt: "2026-01-15T11:59:30Z",
          },
        },
        {
          id: "type-checker",
          name: "TypeChecker",
          parent: "ast-builder",
          engine: "claude",
          model: "claude:fast",
          status: "blocked",
          question: "Should missing schema fields default to nullable?",
          objective: "Check field types in predicates",
          progress: {
            task: "Validating schema types",
            stage: "blocked",
            updatedAt: "2026-01-15T11:59:25Z",
          },
        },
        {
          id: "index-lead",
          name: "IndexLead",
          parent: "search-lead",
          engine: "codex",
          model: "gpt:sol",
          status: "starting",
          objective: "Initialize inverted index partitioner",
          progress: {
            task: "Bootstrapping shards",
            stage: "starting",
            updatedAt: "2026-01-15T11:59:40Z",
          },
        },
        {
          id: "bloom-filter",
          name: "BloomFilter",
          parent: "index-lead",
          engine: "agy",
          model: "gemini:fast",
          status: "reported",
          outcome: "reported",
          objective: "Pre-filter missing terms",
          answer: "Generated 64k bloom filter with 0.01 error rate.",
          progress: {
            task: "Filter evaluation completed",
            stage: "completed",
            updatedAt: "2026-01-15T11:58:00Z",
          },
        },
        {
          id: "cache-sync",
          name: "CacheSync",
          parent: "search-lead",
          engine: "opencode",
          model: "glm:flash",
          status: "failed",
          error: "Connection reset while syncing cache replica",
          objective: "Sync query cache",
          progress: {
            task: "Replicating cache shards",
            stage: "failed",
            updatedAt: "2026-01-15T11:57:30Z",
          },
        },
        {
          id: "benchmarker",
          name: "Benchmarker",
          parent: "conductor",
          engine: "codex",
          model: "gpt:sol",
          status: "working",
          objective: "Measure latency regressions",
          progress: {
            task: "Running p99 latency sweeps",
            stage: "benchmarking",
            updatedAt: "2026-01-15T11:59:50Z",
          },
        },
        {
          id: "doc-gen",
          name: "DocGen",
          parent: "benchmarker",
          engine: "claude",
          model: "claude:fast",
          status: "reported",
          outcome: "reported",
          objective: "Document query syntax grammar",
          answer: "Grammar specification published to docs/syntax.md",
          progress: {
            task: "Writing BNF grammar tables",
            stage: "completed",
            updatedAt: "2026-01-15T11:56:00Z",
          },
        },
        {
          id: "fuzz-tester",
          name: "FuzzTester",
          parent: "benchmarker",
          engine: "codex",
          model: "gpt:luna",
          status: "working",
          objective: "Fuzz query parser inputs",
          progress: {
            task: "Fuzzing edge cases (120k queries)",
            stage: "fuzzing",
            updatedAt: "2026-01-15T11:59:55Z",
          },
        },
      ];

      break;
    }
    case "crowded-all-panels": {
      room.update = {
        available: true,
        commitsBehind: 3,
        localSha: "e2f1a0c",
        remoteSha: "b4d9c8e",
        status: "available",
      };
      room.accounts = [
        {
          id: "claude-work",
          label: "Claude work",
          provider: "claude",
          short: "CW",
          fetchedAt: FIXED_TIME,
          windows: [
            {
              id: "session",
              label: "session",
              pool: "all",
              remainingPct: 18,
              resetsAt: "2026-01-15T15:00:00Z",
            },
          ],
        },
        {
          id: "claude-personal",
          label: "Claude personal",
          provider: "claude",
          short: "CP",
          fetchedAt: FIXED_TIME,
          windows: [
            {
              id: "session",
              label: "session",
              pool: "all",
              remainingPct: 84,
              resetsAt: "2026-01-15T17:00:00Z",
            },
          ],
        },
      ];
      room.services = [{ name: "Dev server", port: 5173, status: "running", uptime: "5m" }];
      room.agents = [
        {
          id: "search-coord",
          name: "SearchCoord",
          parent: "conductor",
          engine: "codex",
          model: "gpt:sol",
          status: "working",
          role: "lead",
          objective: "Manage search redesign",
          progress: { task: "Coordinating index and query workers", stage: "working" },
        },
        {
          id: "query-worker",
          name: "QueryWorker",
          parent: "search-coord",
          engine: "claude",
          model: "claude:best",
          status: "blocked",
          question: "Retain legacy query operators?",
          objective: "Refactor query syntax",
          progress: { task: "Awaiting answer on operators", stage: "blocked" },
        },
        {
          id: "arch-scout",
          name: "ArchScout",
          parent: "search-coord",
          engine: "agy",
          model: "gemini:fast",
          status: "completed",
          outcome: "completed",
          objective: "Explore existing search patterns",
          output: ["Found reusable index abstractions"],
        },
      ];
      room.agentProcesses = {
        "arch-scout": {
          processes: [
            {
              pid: 9012,
              ppid: 9000,
              ageSeconds: 240,
              command: "python3 -m unittest test_indexer",
              via: "cwd",
              ports: [3000],
            },
          ],
          more: 0,
        },
      };

      break;
    }
    case "multi-worktree-subswarms": {
      room.agents = [
        {
          id: "main-builder",
          name: "MainBuilder",
          parent: "conductor",
          engine: "claude",
          model: "claude:best",
          status: "working",
          objective: "Core search coordination",
          cwd: "/workspace/demo",
          progress: { task: "Wiring root index pipeline", stage: "working" },
        },
        {
          id: "query-lead",
          name: "QueryLead",
          parent: "main-builder",
          engine: "codex",
          model: "gpt:sol",
          status: "working",
          cwd: "/workspace/demo/.worktrees/wt-query",
          worktree: {
            disposable: true,
            slug: "wt-query",
            path: "/workspace/demo/.worktrees/wt-query",
            parentCwd: "/workspace/demo",
          },
          objective: "Build AST streaming parser",
          progress: { task: "Writing streaming AST lexer", stage: "working" },
        },
        {
          id: "query-worker",
          name: "QueryWorker",
          parent: "query-lead",
          engine: "agy",
          model: "gemini:fast",
          status: "working",
          cwd: "/workspace/demo/.worktrees/wt-query",
          worktree: {
            disposable: true,
            slug: "wt-query",
            path: "/workspace/demo/.worktrees/wt-query",
            parentCwd: "/workspace/demo",
          },
          objective: "Implement token stream",
          progress: { task: "Token stream buffer implementation", stage: "working" },
        },
        {
          id: "index-lead",
          name: "IndexLead",
          parent: "main-builder",
          engine: "codex",
          model: "gpt:astra",
          status: "blocked",
          question: "Merge segments before or after compacting?",
          cwd: "/workspace/demo/.worktrees/wt-indexer",
          worktree: {
            disposable: true,
            slug: "wt-indexer",
            path: "/workspace/demo/.worktrees/wt-indexer",
            parentCwd: "/workspace/demo",
          },
          objective: "Partition inverted index",
          progress: { task: "Waiting for compaction policy", stage: "blocked" },
        },
        {
          id: "index-helper",
          name: "IndexHelper",
          parent: "index-lead",
          engine: "opencode",
          model: "glm:flash",
          status: "working",
          cwd: "/workspace/demo/.worktrees/wt-indexer",
          worktree: {
            disposable: true,
            slug: "wt-indexer",
            path: "/workspace/demo/.worktrees/wt-indexer",
            parentCwd: "/workspace/demo",
          },
          objective: "Hash shard keys",
          progress: { task: "Partitioning segment keys", stage: "working" },
        },
      ];

      break;
    }
    case "processes": {
      room.agents = [
        {
          id: "builder",
          name: "Builder",
          engine: "codex",
          model: "gpt-5.1-codex",
          parent: "conductor",
          status: "working",
          progress: { task: "Run the integration suite", stage: "testing" },
          output: ["The build and tests are running"],
        },
      ];
      room.agentProcesses = {
        builder: {
          processes: [
            {
              pid: 4121,
              ppid: 4100,
              ageSeconds: 42,
              command: "python3 -m pytest tests/plugins/orchestrate --maxfail=1",
              via: "tree",
              ports: [],
            },
            {
              pid: 4125,
              ppid: 4100,
              ageSeconds: 420,
              command: "node node_modules/.bin/vite --port",
              via: "cwd",
              ports: [5179],
            },
            {
              pid: 4130,
              ppid: 4100,
              ageSeconds: 7200,
              command: "npm run build",
              via: "tree",
              ports: [],
            },
          ],
          more: 1,
        },
      };

      break;
    }
    // No default
  }
  const view = new HordeView(room, {
    now: () => FIXED_TIME,
    height: spec.rows,
    color: spec.palette !== "mono",
    tier: spec.tier,
    ...(spec.scenario === "quota-expanded" && { quotaMode: "expanded" }),
  });
  switch (spec.scenario) {
    case "shortcuts": {
      view.handleInput("?");
      break;
    }
    case "preview": {
      if (typeof view.setPreview !== "function")
        return {
          status: "unsupported",
          reason: "This revision does not expose HordeView.setPreview",
        };
      view.focusId = "builder";
      view.setPreview({
        agentId: "builder",
        title: "Builder",
        kind: "terminal",
        loading: false,
        text: "User: Improve search result grouping.\n\nAssistant: I grouped related matches and kept keyboard navigation.\n\nChanged search grouping and empty states.\nRunning focused checks.\n\nAssistant: The checks passed. Ready for review.",
      });

      break;
    }
    case "activity": {
      if (typeof view.setPreview !== "function")
        return {
          status: "unsupported",
          reason: "This revision does not expose HordeView.setPreview",
        };
      view.focusId = "scout";
      view.setPreview({
        agentId: "scout",
        title: "codex:search-audit-17",
        kind: "activity",
        loading: false,
        text: [
          "Task: Audit search grouping, keyboard navigation, and empty-state rendering across narrow viewports.",
          "",
          "Messages to orchestrator:",
          "• [update] Checked clean HEAD `8dc70d7e` and reproduced layout shift below `740px`.",
          "• [done] Confirmed keyboard navigation preserves focus across grouped sections.",
          "",
          "Response:",
          "### STATUS",
          "",
          "COMPLETE",
          "",
          "Verified **3 reusable patterns** against `search/grouping.mjs` and `search/view.mjs`.",
          "",
          "### FILES CHANGED",
          "",
          "None. Read-only audit completed.",
          "",
          "### COMMANDS RUN",
          "",
          "Read-only Git history inspection; `rg`, `sed`, and focused `vitest` probes.",
          "",
          "### VERIFICATION",
          "",
          "- [x] Keyboard focus order preserved",
          "- [x] Empty-state fallback verified",
          "",
          "Uncertainty: None",
          "Verification: passed",
        ].join("\n"),
      });

      break;
    }
    case "diff":
    case "diff-marks": {
      view.focusId = "builder";
      view.setPreview({
        agentId: "builder",
        title: "Builder",
        kind: "diff",
        loading: false,
        stale: false,
        available: true,
        files: [
          { path: "src/search/grouping.mjs", added: 3, removed: 1 },
          { path: "tests/search/grouping-test.js", added: 2, removed: 0 },
        ],
        ...(spec.scenario === "diff-marks" && {
          marks: [
            {
              file: "src/search/grouping.mjs",
              line: 13,
              side: "new",
              text: "  const normalized = normalizeQuery(query);",
            },
            {
              file: "tests/search/grouping-test.js",
              line: 1,
              side: "new",
              text: 'it("groups normalized queries", () => {',
            },
          ],
        }),
        text: [
          "diff --git a/src/search/grouping.mjs b/src/search/grouping.mjs",
          "index 9e6c123..be56f01 100644",
          "--- a/src/search/grouping.mjs",
          "+++ b/src/search/grouping.mjs",
          "@@ -12,4 +12,6 @@ export function groupMatches(matches) {",
          "   const groups = new Map();",
          "+  const normalized = normalizeQuery(query);",
          "+  const ranked = rankMatches(matches, normalized);",
          "-  for (const match of matches) {",
          "+  for (const match of ranked) {",
          "+    if (!groups.has(match.category)) groups.set(match.category, []);",
          "     groups.get(match.category).push(match);",
          "diff --git a/tests/search/grouping-test.js b/tests/search/grouping-test.js",
          "new file mode 100644",
          "--- /dev/null",
          "+++ b/tests/search/grouping-test.js",
          "@@ -0,0 +1,2 @@",
          '+it("groups normalized queries", () => {',
          "+  expect(groupMatches(matches)).toHaveLength(2);",
        ].join("\n"),
      });
      if (spec.scenario === "diff-marks") view.diffCursor = 6;
      break;
    }
    case "quota-hover": {
      if (typeof view.handleMouse !== "function")
        return { status: "unsupported", reason: "This revision does not expose mouse hover" };
      view.render(spec.cols);
      const quota = view.targets.find((target) => target.id === "quota-heading");
      if (!quota) throw new Error("Quota heading has no mouse target");
      view.handleMouse({ x: quota.x + 1, y: quota.y, action: "move", button: 0 });

      break;
    }
    case "processes": {
      view.focusId = "builder";
      view.hasExplicitFocus = true;
      break;
    }
    case "crowded-all-panels": {
      view.focusId = "arch-scout";
      view.hasExplicitFocus = true;
      break;
    }
    // No default
  }
  const lines = view.render(spec.cols).slice(0, spec.rows);
  return { status: "captured", lines };
}

function xml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const rasterizerCache = { promise: undefined };
function detectRasterizer() {
  rasterizerCache.promise ??= (async () => {
    try {
      await execute("magick", ["-version"]);
      return "magick";
    } catch {
      try {
        await execute("rsvg-convert", ["-v"]);
        return "rsvg-convert";
      } catch {
        return null;
      }
    }
  })();
  return rasterizerCache.promise;
}

async function rasterizeToPng(svgPath, pngPath) {
  const tool = await detectRasterizer();
  if (!tool) return;
  if (tool === "magick") {
    await execute("magick", [
      "-background",
      "none",
      "-density",
      "192",
      svgPath,
      "-strip",
      "-colors",
      "255",
      `PNG8:${pngPath}`,
    ]);
  } else if (tool === "rsvg-convert") {
    await execute("rsvg-convert", ["--zoom=2", "-o", pngPath, svgPath]);
  }
}

/** Visualize captured terminal cells with per-cell positioning, stroked box lines and Nerd Font icons. */
export function ansiToSvg(ansi, spec) {
  return ansiToWindowSvg(ansi, {
    title: spec.name || spec.title || "terminal capture",
    cols: spec.cols,
    rows: spec.rows,
    palette: spec.palette,
    cellWidth: displayWidth,
  });
}

export function compareCaptures(before, after) {
  if (before?.status === "unsupported" || after.status === "unsupported") return "unsupported";
  if (!before) return "missing-baseline";
  if (before.status === "error" || after.status === "error") return "error";
  return before.cols === after.cols && before.rows === after.rows && before.ansi === after.ansi
    ? "same"
    : "changed";
}

async function jsonFile(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", String.raw`'\''`)}'`;
}

async function captureCase(repo, spec, directory) {
  await mkdir(directory, { recursive: true });
  const socket = path.join(directory, "t.sock");
  const ready = path.join(directory, "ready.json");
  const log = path.join(directory, "fixture.log");
  const config = path.join(directory, "tmux.conf");
  await writeFile(
    config,
    "set -g status off\nset -g default-terminal xterm-256color\nset -g history-limit 0\n",
  );
  const env = {
    PATH: process.env.PATH || "/usr/bin:/bin",
    HOME: directory,
    XDG_CONFIG_HOME: directory,
    TERM: "xterm-256color",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    TZ: "UTC",
  };
  const command = [
    process.execPath,
    runner,
    "--fixture",
    "--repo",
    repo,
    "--case",
    spec.name,
    "--ready",
    ready,
  ]
    .map(shellQuote)
    .join(" ");
  const tmux = (...args) =>
    execute("tmux", ["-u", "-S", socket, "-f", config, ...args], {
      env,
      timeout: 15_000,
      maxBuffer: 2 * 1024 * 1024,
    });
  try {
    await tmux(
      "new-session",
      "-d",
      "-s",
      "visual",
      "-x",
      String(spec.cols),
      "-y",
      String(spec.rows),
      `exec ${command} 2>${shellQuote(log)}`,
    );
    let result;
    for (let attempt = 0; attempt < 100; attempt++) {
      result = await jsonFile(ready);
      if (result) break;
      await delay(25);
    }
    if (!result) {
      let details = "";
      try {
        details = await readFile(log, "utf8");
      } catch {
        /* The child may not have opened its log. */
      }
      throw new Error(`Fixture did not become ready: ${details.slice(0, 300)}`);
    }
    if (result.status !== "captured") return { ...spec, ...result };
    const dimensions = (
      await tmux("display-message", "-p", "-t", "visual:0.0", "#{pane_width} #{pane_height}")
    ).stdout.trim();
    if (dimensions !== `${spec.cols} ${spec.rows}`)
      throw new Error(`Unexpected terminal dimensions: ${dimensions}`);
    let ansi = "";
    let previous;
    for (let attempt = 0; attempt < 10; attempt++) {
      ansi = (await tmux("capture-pane", "-p", "-e", "-N", "-t", "visual:0.0")).stdout.replaceAll(
        "\r\n",
        "\n",
      );
      if (ansi === previous && stripVTControlCharacters(ansi).includes(result.firstLine))
        return { ...spec, status: "captured", ansi };
      previous = ansi;
      await delay(25);
    }
    throw new Error("Terminal capture did not settle after fixture readiness");
  } finally {
    try {
      await tmux("kill-server");
    } catch {
      /* An exited owned server needs no further cleanup. */
    }
  }
}

async function sourceInfo(repo, ref = "working-tree") {
  const commit = (await execute("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
  const isDirty =
    ref === "working-tree" &&
    Boolean((await execute("git", ["status", "--porcelain"], { cwd: repo })).stdout);
  return { ref, commit, dirty: isDirty };
}

async function rendererFingerprint(repo) {
  const hash = createHash("sha256");
  for (const directory of ["plugins/orchestrate/lib", "plugins/monitor/lib"]) {
    const files = (await readdir(path.join(repo, directory), { recursive: true }))
      .filter((file) => file.endsWith(".mjs"))
      .sort((left, right) => left.localeCompare(right, "en"));
    for (const file of files) {
      hash.update(`${directory}/${file}\0`);
      hash.update(await readFile(path.join(repo, directory, file)));
    }
  }
  return hash.digest("hex");
}

async function fixtureFingerprint() {
  const hash = createHash("sha256");
  for (const file of [fileURLToPath(import.meta.url), runner]) hash.update(await readFile(file));
  return hash.digest("hex");
}

async function writeCapture(output, side, capture, source) {
  const directory = path.join(output, side);
  await mkdir(directory, { recursive: true });
  const record = {
    ...capture,
    source,
    captureKind: "tmux ANSI terminal capture visualized as SVG",
  };
  const stem = path.join(directory, capture.name);
  await writeFile(`${stem}.json`, `${JSON.stringify(record, null, 2)}\n`);
  if (capture.status === "captured") {
    await writeFile(`${stem}.ansi`, capture.ansi);
    await writeFile(`${stem}.svg`, ansiToSvg(capture.ansi, capture));
    try {
      await rasterizeToPng(`${stem}.svg`, `${stem}.png`);
    } catch {
      // Gracefully skip .png if rasterizer is unavailable or fails
    }
  } else {
    await rm(`${stem}.ansi`, { force: true });
    await rm(`${stem}.svg`, { force: true });
    await rm(`${stem}.png`, { force: true });
  }
  return record;
}

function htmlReport(comparisons) {
  const pane = (item, side) =>
    item?.status === "captured"
      ? `<img alt="${side} ${xml(item.name)} terminal capture" src="${side}/${xml(item.name)}.svg"/>`
      : `<p>${xml(item?.reason || item?.error || "No baseline captured")}</p>`;
  const sections = comparisons
    .map(
      ({ name, status, before, after }) =>
        `<section><h2>${xml(name)} <small>${status}</small></h2><div class="pair"><figure><figcaption>Before · ${xml(before?.source?.ref || "no baseline")} · ${xml(before?.source?.commit?.slice(0, 12) || "")}</figcaption>${pane(before, "before")}</figure><figure><figcaption>After · ${xml(after.source.ref)} · ${xml(after.source.commit.slice(0, 12))}${after.source.dirty ? " + working changes" : ""}</figcaption>${pane(after, "after")}</figure></div></section>`,
    )
    .join("");
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Terminal visual comparison</title><style>body{font:16px system-ui;margin:24px;background:#f4f5f7;color:#202124}section{margin-block:32px}small{font-weight:400}.pair{display:grid;grid-template-columns:1fr 1fr;gap:16px}figure{margin:0;overflow:auto;background:white;border:1px solid #ccd0d6}figcaption{padding:12px}img{display:block;max-width:none}@media(max-width:900px){.pair{grid-template-columns:1fr}}</style><h1>Terminal visual comparison</h1><p>Real private tmux terminal captures, visualized as SVG. These are not native-window pixel screenshots. ANSI content and terminal dimensions determine changes. Nerd icons require a compatible installed font.</p>${sections}</html>\n`;
}

export async function runVisualRegression({
  repo,
  output,
  baseRef,
  baseline,
  update = false,
  cases = VISUAL_CASES,
}) {
  if (baseRef && baseline) throw new Error("Choose --base-ref or --baseline, not both");
  if (update && !baseline) throw new Error("--update requires --baseline");
  const temporary = await mkdtemp(path.join(tmpdir(), "ork-viz-"));
  const comparisons = [];
  try {
    const currentSource = await sourceInfo(repo);
    currentSource.rendererFingerprint = await rendererFingerprint(repo);
    const fixtureBefore = await fixtureFingerprint();
    const runtime = {
      node: process.versions.node,
      tmux: (await execute("tmux", ["-V"])).stdout.trim(),
    };
    let baseRepo;
    let baseSource;
    if (baseRef) {
      const revisionSha = (
        await execute("git", ["rev-parse", "--verify", "--end-of-options", `${baseRef}^0`], {
          cwd: repo,
        })
      ).stdout.trim();
      baseRepo = path.join(temporary, "base");
      await mkdir(baseRepo);
      const archive = path.join(temporary, "base.tar");
      await execute("git", ["archive", "--format=tar", `--output=${archive}`, revisionSha], {
        cwd: repo,
      });
      await execute("tar", ["-xf", archive, "-C", baseRepo]);
      baseSource = {
        ref: baseRef,
        commit: revisionSha,
        dirty: false,
        rendererFingerprint: await rendererFingerprint(baseRepo),
      };
    }
    for (const spec of cases) {
      const capture = async (root, side) => {
        try {
          return await captureCase(root, spec, path.join(temporary, `${side}-${spec.name}`));
        } catch (error) {
          return { ...spec, status: "error", error: error.message };
        }
      };
      const current = await capture(repo, "after");
      current.runtime = runtime;
      current.fixtureFingerprint = fixtureBefore;
      const after = await writeCapture(output, "after", current, currentSource);
      let previous = baseRepo ? await capture(baseRepo, "before") : null;
      if (previous) {
        previous.runtime = runtime;
        previous.fixtureFingerprint = fixtureBefore;
      }
      if (baseline && !update) {
        previous = await jsonFile(path.join(baseline, `${spec.name}.json`));
        if (previous?.status === "captured") {
          try {
            previous.ansi = await readFile(path.join(baseline, `${spec.name}.ansi`), "utf8");
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
            previous = null;
          }
        }
      }
      const before = previous
        ? await writeCapture(
            output,
            "before",
            previous,
            baseSource ||
              previous.source || { ref: "saved baseline", commit: "unknown", dirty: false },
          )
        : null;
      comparisons.push({ name: spec.name, status: compareCaptures(before, after), before, after });
    }
    const validation = {
      fixtureBefore,
      fixtureAfter: await fixtureFingerprint(),
      rendererBefore: currentSource.rendererFingerprint,
      rendererAfter: await rendererFingerprint(repo),
      ...(baseRepo && {
        baseBefore: baseSource.rendererFingerprint,
        baseAfter: await rendererFingerprint(baseRepo),
      }),
    };
    const isStale =
      validation.fixtureBefore !== validation.fixtureAfter ||
      validation.rendererBefore !== validation.rendererAfter ||
      validation.baseBefore !== validation.baseAfter;
    if (isStale) for (const item of comparisons) item.status = "stale";
    const canUpdate =
      update && !isStale && comparisons.every(({ after }) => after.status === "captured");
    if (canUpdate) {
      await mkdir(baseline, { recursive: true });
      for (const { name, after } of comparisons) {
        await writeFile(path.join(baseline, `${name}.json`), `${JSON.stringify(after, null, 2)}\n`);
        await writeFile(path.join(baseline, `${name}.ansi`), after.ansi);
      }
    }
    await mkdir(output, { recursive: true });
    await writeFile(
      path.join(output, "comparison.json"),
      `${JSON.stringify({ format: 1, runtime, validation, stale: isStale, comparisons }, null, 2)}\n`,
    );
    await writeFile(path.join(output, "report.html"), htmlReport(comparisons));
    return {
      output,
      baselineUpdated: Boolean(canUpdate),
      cases: comparisons.map(({ name, status }) => ({ name, status })),
      failed:
        isStale ||
        (update && !canUpdate) ||
        comparisons.some(
          ({ status, after }) =>
            status === "error" ||
            after.status === "error" ||
            (baseline && !update && status !== "same"),
        ),
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
