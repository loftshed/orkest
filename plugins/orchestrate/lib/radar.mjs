import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs, promisify } from "node:util";

import { cacheHome } from "./runtime-paths.mjs";

const execFileAsync = promisify(execFile);

export const DEFAULT_PRIORS_PATH = path.resolve(
  import.meta.dirname,
  "../skills/orchestrate/references/benchmarks.prior.json",
);

const TELEMETRY_SCRIPT_PATH = path.resolve(
  import.meta.dirname,
  "../skills/orchestrate/scripts/telemetry.py",
);

function mapModelArray(items) {
  return items
    .map((item) => {
      if (typeof item === "string") return { id: item };
      if (item && typeof item === "object" && typeof item.id === "string") return { ...item };
      if (item && typeof item === "object" && typeof item.model === "string") {
        return { ...item, id: item.model };
      }
      return null;
    })
    .filter(Boolean);
}

function extractModelList(catalog) {
  if (!catalog) return [];
  if (Array.isArray(catalog)) return mapModelArray(catalog);
  if (typeof catalog === "object") {
    if (Array.isArray(catalog.models)) return mapModelArray(catalog.models);
    if (Array.isArray(catalog.data)) return mapModelArray(catalog.data);
    if (catalog.models && typeof catalog.models === "object") {
      return Object.entries(catalog.models).map(([id, info]) => ({
        ...(typeof info === "object" && info !== null && info),
        id,
      }));
    }
    return Object.entries(catalog)
      .filter(([key]) => key !== "schema" && key !== "updated_at")
      .map(([id, info]) => ({
        ...(typeof info === "object" && info !== null && info),
        id,
      }));
  }
  return [];
}

export function loadBenchmarkPriors(priorsPath = DEFAULT_PRIORS_PATH) {
  const raw = readFileSync(priorsPath, "utf8");
  const parsed = JSON.parse(raw);
  if (
    !parsed ||
    parsed.schema !== "orkest.benchmarks.prior.v1" ||
    typeof parsed.models !== "object"
  ) {
    throw new Error(`Invalid benchmark priors file: ${priorsPath}`);
  }
  return parsed;
}

export function diffCatalogAgainstSeen(
  liveCatalog = [],
  seenCatalog = [],
  priors = loadBenchmarkPriors(),
  options = {},
) {
  const priorsMap =
    priors && typeof priors.models === "object" && !Array.isArray(priors.models)
      ? priors.models
      : priors || {};
  const liveEntries = extractModelList(liveCatalog);
  const seenEntries = extractModelList(seenCatalog);
  const liveIds = new Set(liveEntries.map((item) => item.id));
  const seenIds = new Set(seenEntries.map((item) => item.id));
  const priorIds = new Set(Object.keys(priorsMap));
  const knownIds = seenIds.union(priorIds);

  let telemetryGroups = [];
  if (Array.isArray(options?.telemetry?.groups)) {
    telemetryGroups = options.telemetry.groups;
  } else if (Array.isArray(options?.groups)) {
    telemetryGroups = options.groups;
  }

  const newModels = [];
  const models = [];
  const alerts = [];

  for (const entry of liveEntries) {
    const { id } = entry;
    const isNew = !knownIds.has(id);
    if (isNew) newModels.push(id);
    const prior = priorsMap[id] || null;
    const matchingGroups = telemetryGroups.filter(
      (group) =>
        group &&
        (group.model === id ||
          (Array.isArray(group.requested_models) && group.requested_models.includes(id)) ||
          (prior?.family &&
            Array.isArray(group.requested_models) &&
            group.requested_models.includes(prior.family))),
    );
    const degradedGroup = matchingGroups.find((group) => group.degraded === true);
    const health = degradedGroup ? "degraded" : "healthy";
    const degradationDrop = degradedGroup ? degradedGroup.degradation_drop : 0;
    if (degradedGroup) {
      alerts.push({
        archetype: degradedGroup.task_archetype,
        degradation_drop: degradationDrop,
        engine: degradedGroup.engine,
        model: id,
        rolling_14d_runs: degradedGroup.rolling_14d_runs,
        rolling_14d_success_rate: degradedGroup.rolling_14d_success_rate,
        status: "DEGRADED",
      });
    }
    let status = "tracked";
    if (isNew) status = "new";
    models.push({
      degradation_drop: degradationDrop,
      engine: entry.engine || prior?.engine || "unknown",
      family: prior?.family || null,
      health,
      id,
      prior,
      status,
    });
  }

  for (const group of telemetryGroups) {
    if (!group || group.degraded !== true) continue;
    const hasAlert = alerts.some(
      (alert) => alert.model === group.model && alert.archetype === group.task_archetype,
    );
    if (!hasAlert) {
      alerts.push({
        archetype: group.task_archetype,
        degradation_drop: group.degradation_drop ?? 0,
        engine: group.engine,
        model: group.model,
        rolling_14d_runs: group.rolling_14d_runs,
        rolling_14d_success_rate: group.rolling_14d_success_rate,
        status: "DEGRADED",
      });
    }
  }

  const deprecatedModels = seenEntries.map((item) => item.id).filter((id) => !liveIds.has(id));

  return {
    alerts,
    deprecatedModels,
    models,
    newModels,
  };
}

export async function summarizeTelemetry(runsDir) {
  const targetDir = runsDir || path.join(cacheHome(), "runs-v1");
  if (!existsSync(targetDir)) {
    return { groups: [], runs: 0, schema: "agent-executor.telemetry.v1", skipped_results: 0 };
  }
  const { stdout } = await execFileAsync("python3", [
    TELEMETRY_SCRIPT_PATH,
    "summarize",
    "--runs-dir",
    targetDir,
  ]);
  return JSON.parse(stdout);
}

function buildArchetypePriors(priors) {
  const byArchetype = new Map();
  const modelEntries = Object.entries(priors.models || {});
  for (const [id, info] of modelEntries) {
    const strengths = info.strengths || [];
    for (const archetype of strengths) {
      const current = byArchetype.get(archetype) || [];
      current.push({
        aider_polyglot: info.aider_polyglot,
        composite_prior: info.composite_prior,
        engine: info.engine,
        family: info.family,
        id,
        livecodebench: info.livecodebench,
        swe_bench_verified: info.swe_bench_verified,
      });
      byArchetype.set(archetype, current);
    }
  }
  const result = {};
  for (const [archetype, list] of byArchetype) {
    list.sort((left, right) => right.composite_prior - left.composite_prior);
    result[archetype] = list;
  }
  return result;
}

function formatRadarText(subcommand, report) {
  const lines = [`Model Release Radar (${subcommand})`];
  if (subcommand === "priors") {
    lines.push("", "Archetype Priors:");
    const archetypeEntries = Object.entries(report.archetypes || {});
    for (const [archetype, entries] of archetypeEntries) {
      const summary = entries
        .map((item) => `${item.id} (${(item.composite_prior * 100).toFixed(1)}%)`)
        .join(", ");
      lines.push(`  ${archetype}: ${summary}`);
    }
    lines.push("", "Model Scoreboard Priors:");
    const modelEntries = Object.entries(report.priors.models || {});
    for (const [id, info] of modelEntries) {
      lines.push(
        `  ${id} [${info.engine}] composite=${(info.composite_prior * 100).toFixed(1)}% swe=${(info.swe_bench_verified * 100).toFixed(1)}% lcb=${(info.livecodebench * 100).toFixed(1)}% aider=${(info.aider_polyglot * 100).toFixed(1)}%`,
      );
    }
    return lines.join("\n");
  }

  lines.push(
    `Tracked models: ${report.diff.models.length} | New: ${report.diff.newModels.length} | Deprecated: ${report.diff.deprecatedModels.length}`,
  );
  if (report.diff.newModels.length > 0) {
    lines.push(`New models: ${report.diff.newModels.join(", ")}`);
  }
  if (report.diff.deprecatedModels.length > 0) {
    lines.push(`Deprecated models: ${report.diff.deprecatedModels.join(", ")}`);
  }
  if (report.diff.alerts.length > 0) {
    lines.push("", "Silent-Nerf Telemetry Alerts:");
    for (const alert of report.diff.alerts) {
      const dropPct = ((alert.degradation_drop || 0) * 100).toFixed(1);
      lines.push(
        `  [DEGRADED] ${alert.model} on ${alert.archetype}: 14d drop -${dropPct}% (${alert.rolling_14d_runs} runs)`,
      );
    }
  } else {
    lines.push("Telemetry health: all tracked buckets healthy.");
  }
  return lines.join("\n");
}

export async function radarCli(argv = [], options = {}) {
  const args = argv[0] === "radar" ? argv.slice(1) : [...argv];
  let subcommand = "status";
  if (args[0] && !args[0].startsWith("-")) {
    subcommand = args.shift();
  }
  if (!["diff", "priors", "status"].includes(subcommand)) {
    throw new Error(`Unknown radar subcommand: ${subcommand}. Expected status, diff, or priors.`);
  }
  const { values } = parseArgs({
    args,
    options: {
      json: { type: "boolean" },
      "live-catalog": { type: "string" },
      priors: { type: "string" },
      "runs-dir": { type: "string" },
      "seen-catalog": { type: "string" },
    },
  });

  const priors = options.priors || loadBenchmarkPriors(values.priors || options.priorsPath);
  const telemetry =
    options.telemetry || (await summarizeTelemetry(values["runs-dir"] || options.runsDir));
  const liveCatalog =
    options.liveCatalog ??
    (values["live-catalog"]
      ? JSON.parse(readFileSync(values["live-catalog"], "utf8"))
      : Object.keys(priors.models));
  const seenCatalog =
    options.seenCatalog ??
    (values["seen-catalog"]
      ? JSON.parse(readFileSync(values["seen-catalog"], "utf8"))
      : Object.keys(priors.models));

  const diff = diffCatalogAgainstSeen(liveCatalog, seenCatalog, priors, { telemetry });
  const archetypes = buildArchetypePriors(priors);
  const report = {
    archetypes,
    diff,
    priors,
    schema: "orkest.radar.v1",
    subcommand,
    telemetry,
  };

  const output = values.json
    ? JSON.stringify(report, null, 2)
    : formatRadarText(subcommand, report);
  if (options.stdout && typeof options.stdout.write === "function") {
    options.stdout.write(`${output}\n`);
  }
  return {
    data: report,
    exitCode: 0,
    stdout: output,
  };
}
