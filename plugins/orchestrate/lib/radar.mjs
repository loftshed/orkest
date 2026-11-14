/**
 * @module radar
 *
 * Model Release Radar (`ork radar`): Compares live model catalogs from
 * supported harnesses (`claude`, `codex`, `agy`, `opencode`) against
 * `models-seen.json` and external scoreboard priors (`benchmarks.prior.json`),
 * resolves moving targets via `prior.family` and `families.json`, surfaces
 * catalog/family drift, and merges `DEGRADED` silent-nerf warnings from `telemetry.py`.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs, promisify } from "node:util";

import { shouldUseColor } from "../../monitor/lib/render.mjs";
import {
  auditCatalogDrift,
  knownEngines,
  loadFamiliesSchema,
  modelMatchesFamilySelector,
  nativeEngineForModel,
} from "./families-schema.mjs";
import { cacheHome } from "./runtime-paths.mjs";
import { glyphSet, glyphTier, renderPanel, renderTable, tone, wrapText } from "./tui-box.mjs";

const execFileAsync = promisify(execFile);

export const DEFAULT_PRIORS_PATH = path.resolve(
  import.meta.dirname,
  "../skills/orchestrate/references/benchmarks.prior.json",
);

const TELEMETRY_SCRIPT_PATH = path.resolve(
  import.meta.dirname,
  "../skills/orchestrate/scripts/telemetry.py",
);

const RUN_AGENT_SCRIPT_PATH = path.resolve(
  import.meta.dirname,
  "../skills/orchestrate/scripts/run_agent.py",
);

const MODELS_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SEEN_SCHEMA = "orkest.models-seen.v1";

const METRIC_COLUMNS = Object.freeze([
  { key: "terminal_bench_4_1", label: "TB4.1" },
  { key: "deepswe_v1_1", label: "DeepSWE" },
  { key: "osworld_2_1", label: "OSW2.1" },
  { key: "frontier_swe_2", label: "FSWE2" },
  { key: "swe_bench_verified", label: "SWE" },
  { key: "livecodebench", label: "LCB" },
  { key: "aider_polyglot", label: "Aider" },
]);

export const RADAR_HELP = `ork radar [status|diff|priors|ack] [--refresh] [--ack] [--json] [--line] [--priors <path>] [--runs-dir <dir>] [--width 120]
`;

function numericMetric(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function compareNullableDesc(left, right) {
  const a = numericMetric(left);
  const b = numericMetric(right);
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

function formatPercentMetric(value) {
  const num = numericMetric(value);
  return num === null ? "—" : `${(num * 100).toFixed(1)}%`;
}

export function detectInstalledEngines(env = process.env) {
  const pathDirs = String(env?.PATH || "")
    .split(path.delimiter)
    .filter(Boolean);
  const harnesses = [...knownEngines(loadFamiliesSchema())];
  return harnesses.filter((engine) => pathDirs.some((dir) => existsSync(path.join(dir, engine))));
}

function readJsonFileSafe(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function mapModelArray(items, engineOverride = null) {
  return items
    .map((item) => {
      if (typeof item === "string") {
        return engineOverride ? { id: item, engine: engineOverride } : { id: item };
      }
      if (item && typeof item === "object" && typeof item.id === "string") {
        return engineOverride && !item.engine ? { ...item, engine: engineOverride } : { ...item };
      }
      if (item && typeof item === "object" && typeof item.model === "string") {
        return {
          ...item,
          ...(engineOverride && !item.engine && { engine: engineOverride }),
          id: item.model,
        };
      }
      return null;
    })
    .filter(Boolean);
}

export function extractModelList(catalog) {
  if (!catalog) return [];
  if (Array.isArray(catalog)) return mapModelArray(catalog);
  if (typeof catalog === "object") {
    if (Array.isArray(catalog.platforms)) {
      const merged = [];
      for (const slot of catalog.platforms) {
        if (!slot || slot.status !== "live" || !Array.isArray(slot.models)) continue;
        const visible = slot.models.filter((item) => !item?.hidden);
        merged.push(...mapModelArray(visible, slot.engine || null));
      }
      return merged;
    }
    if (catalog.platforms && typeof catalog.platforms === "object") {
      const merged = [];
      for (const [engine, slot] of Object.entries(catalog.platforms)) {
        const inner = slot?.catalog && typeof slot.catalog === "object" ? slot.catalog : slot;
        if (!inner || inner.status !== "live" || !Array.isArray(inner.models)) continue;
        const visible = inner.models.filter((item) => !item?.hidden);
        merged.push(...mapModelArray(visible, inner.engine || engine));
      }
      return merged;
    }
    if (Array.isArray(catalog.models)) return mapModelArray(catalog.models);
    if (Array.isArray(catalog.data)) return mapModelArray(catalog.data);
    if (catalog.models && typeof catalog.models === "object") {
      return Object.entries(catalog.models).map(([id, info]) => ({
        ...(typeof info === "object" && info !== null && info),
        id,
      }));
    }
    return Object.entries(catalog)
      .filter(
        ([key]) =>
          key !== "schema" &&
          key !== "updated_at" &&
          key !== "generated_at" &&
          key !== "acknowledged_at",
      )
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
    !["orkest.benchmarks.prior.v1", "orkest.benchmarks.prior.v2"].includes(parsed.schema) ||
    typeof parsed.models !== "object"
  ) {
    throw new Error(`Invalid benchmark priors file: ${priorsPath}`);
  }
  return parsed;
}

function isCatalogMissingOrStale(cacheObj, nowMs = Date.now(), maxAgeMs = MODELS_CACHE_MAX_AGE_MS) {
  if (!cacheObj || typeof cacheObj !== "object" || !cacheObj.platforms) return true;
  const slots = Array.isArray(cacheObj.platforms)
    ? cacheObj.platforms.map((item) => ({ catalog: item, cached_at_epoch: nowMs / 1000 }))
    : Object.values(cacheObj.platforms);
  const liveSlots = slots.filter((slot) => (slot?.catalog || slot)?.status === "live");
  if (liveSlots.length === 0) return true;
  for (const slot of slots) {
    const inner = slot?.catalog && typeof slot.catalog === "object" ? slot.catalog : slot;
    if (!inner || inner.status !== "live") continue;
    const epoch = slot?.cached_at_epoch;
    if (typeof epoch !== "number" || !Number.isFinite(epoch) || nowMs - epoch * 1000 > maxAgeMs) {
      return true;
    }
    const models = Array.isArray(inner.models) ? inner.models : [];
    if (models.some((item) => !item || !Object.hasOwn(item, "supported_efforts"))) {
      return true;
    }
  }
  return false;
}

async function refreshModelsCatalog({ cacheDir, env = process.env, refresh = false, execFn } = {}) {
  const args = [RUN_AGENT_SCRIPT_PATH, "models", "--format", "json"];
  if (refresh) args.push("--refresh");
  const childEnv = cacheDir
    ? { ...env, ORCHESTRATE_HOME: cacheDir, AGENT_EXECUTOR_HOME: cacheDir }
    : env;
  if (execFn) {
    return execFn(args, { env: childEnv });
  }
  const { stdout } = await execFileAsync("python3", args, { env: childEnv });
  return JSON.parse(stdout);
}

function resolvePriorMatch(entry, priorsMap, schema, resolvedSelectors = {}) {
  if (Object.hasOwn(priorsMap, entry.id)) {
    return { matchedBy: "exact", prior: priorsMap[entry.id], priorId: entry.id };
  }
  const entryEngine =
    entry.engine && entry.engine !== "unknown"
      ? entry.engine
      : nativeEngineForModel(entry.id, schema);
  const candidates = [];
  for (const [priorId, info] of Object.entries(priorsMap)) {
    if (!info?.family) continue;
    if (entryEngine && info.engine && info.engine !== entryEngine) continue;
    const isResolvedPrimary = resolvedSelectors[info.family] === entry.id;
    if (isResolvedPrimary || modelMatchesFamilySelector(entry.id, info.family, schema)) {
      candidates.push({
        isResolvedPrimary,
        prior: info,
        priorId,
        score: numericMetric(info.composite_prior),
      });
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    if (a.isResolvedPrimary !== b.isResolvedPrimary) return a.isResolvedPrimary ? -1 : 1;
    return compareNullableDesc(a.score, b.score);
  });
  return {
    matchedBy: "family",
    prior: candidates[0].prior,
    priorId: candidates[0].priorId,
  };
}

export function diffCatalogAgainstSeen(
  liveCatalog = [],
  seenCatalog = [],
  priors = loadBenchmarkPriors(),
  options = {},
) {
  const schema = options.schema || loadFamiliesSchema();
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

  const audit = options.audit || auditCatalogDrift(liveEntries, schema);
  const resolvedSelectors = audit?.resolved_selectors || {};

  let telemetryGroups = [];
  if (Array.isArray(options?.telemetry?.groups)) {
    telemetryGroups = options.telemetry.groups;
  } else if (Array.isArray(options?.groups)) {
    telemetryGroups = options.groups;
  }

  const newModels = [];
  const models = [];
  const alerts = [];
  const alertedGroups = new Set();

  for (const entry of liveEntries) {
    const { id } = entry;
    const isNew = !knownIds.has(id);
    if (isNew) newModels.push(id);
    const match = resolvePriorMatch(entry, priorsMap, schema, resolvedSelectors);
    const prior = match?.prior || null;
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
      alertedGroups.add(degradedGroup);
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
      engine: entry.engine || prior?.engine || nativeEngineForModel(id, schema) || "unknown",
      family: prior?.family || null,
      health,
      id,
      prior,
      priorId: match?.priorId || null,
      priorMatch: match?.matchedBy || null,
      status,
    });
  }

  for (const group of telemetryGroups) {
    if (!group || group.degraded !== true || alertedGroups.has(group)) continue;
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
    audit,
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
    const strengths = info?.strengths || [];
    for (const archetype of strengths) {
      const current = byArchetype.get(archetype) || [];
      const row = {
        composite_prior: numericMetric(info.composite_prior),
        engine: info.engine,
        family: info.family,
        id,
      };
      for (const spec of METRIC_COLUMNS) {
        if (Object.hasOwn(info, spec.key)) {
          row[spec.key] = numericMetric(info[spec.key]);
        }
      }
      current.push(row);
      byArchetype.set(archetype, current);
    }
  }
  const result = {};
  for (const [archetype, list] of byArchetype) {
    list.sort((left, right) => compareNullableDesc(left.composite_prior, right.composite_prior));
    result[archetype] = list;
  }
  return result;
}

function activeMetricColumns(priorsModels) {
  const entries = Object.values(priorsModels || {});
  const present = METRIC_COLUMNS.filter((spec) =>
    entries.some((info) => info && Object.hasOwn(info, spec.key) && info[spec.key] !== undefined),
  );
  if (present.length > 0) return present;
  return METRIC_COLUMNS.filter((spec) =>
    ["swe_bench_verified", "livecodebench", "aider_polyglot"].includes(spec.key),
  );
}

function formatRadarLine(report) {
  const audit = report.audit || {};
  const unresolvedCount = audit.unresolved_tiers?.length || 0;
  const unmappedCount = audit.unmapped_models?.length || 0;
  const ackTag = report.acknowledged ? " acked" : "";
  return `radar: tracked=${report.diff.models.length} new=${report.diff.newModels.length} deprecated=${report.diff.deprecatedModels.length} alerts=${report.diff.alerts.length} unresolved=${unresolvedCount} unmapped=${unmappedCount}${ackTag}`;
}

function formatRadarText(subcommand, report, options = {}) {
  const tier = options.tier || glyphTier(options.env);
  const hasColor = Boolean(options.color);
  const width = Math.max(40, Math.min(1000, Number(options.width) || 120));
  const bodyWidth = Math.max(20, width - 6);
  const title = `Model Release Radar (${subcommand})`;

  if (subcommand === "priors") {
    const body = [tone("Archetype Priors:", "heading", hasColor)];
    const archetypeEntries = Object.entries(report.archetypes || {});
    for (const [archetype, entries] of archetypeEntries) {
      const summary = entries
        .map((item) => `${item.id} (${formatPercentMetric(item.composite_prior)})`)
        .join(", ");
      body.push(...wrapText(`  ${archetype}: ${summary}`, bodyWidth));
    }
    body.push("", tone("Model Scoreboard Priors:", "heading", hasColor));
    const modelsMap = report.priors.models || {};
    const metricCols = activeMetricColumns(modelsMap);
    const modelEntries = Object.entries(modelsMap).sort(([, a], [, b]) =>
      compareNullableDesc(a?.composite_prior, b?.composite_prior),
    );
    const tableRows = modelEntries.map(([id, info]) => [
      id,
      info.engine || "—",
      formatPercentMetric(info.composite_prior),
      ...metricCols.map((spec) => formatPercentMetric(info[spec.key])),
    ]);
    const metricWeight = metricCols.length > 0 ? 0.36 / metricCols.length : 0;
    const weights = [0.36, 0.14, 0.14, ...metricCols.map(() => metricWeight)];
    body.push(
      ...renderTable(
        ["Model", "Engine", "Composite", ...metricCols.map((spec) => spec.label)],
        tableRows,
        bodyWidth,
        {
          color: hasColor,
          tier,
          weights,
        },
      ),
    );
    return renderPanel(title, body, width, { color: hasColor, glyphs: glyphSet(tier) })
      .map((line) => line.trimEnd())
      .join("\n");
  }

  const body = [
    `Tracked models: ${report.diff.models.length} | New: ${report.diff.newModels.length} | Deprecated: ${report.diff.deprecatedModels.length}`,
  ];
  if (report.acknowledged && report.seenPath) {
    body.push(tone(`Acknowledged live catalog to ${report.seenPath}.`, "success", hasColor));
  }
  if (report.diff.newModels.length > 0) {
    body.push(
      ...wrapText(
        `${tone("New models:", "success bold", hasColor)} ${report.diff.newModels.join(", ")}`,
        bodyWidth,
      ),
    );
  }
  if (report.diff.deprecatedModels.length > 0) {
    body.push(
      ...wrapText(
        `${tone("Deprecated models:", "warning bold", hasColor)} ${report.diff.deprecatedModels.join(", ")}`,
        bodyWidth,
      ),
    );
  }
  const audit = report.audit || { unresolved_tiers: [], unmapped_models: [] };
  if ((audit.unresolved_tiers?.length || 0) > 0 || (audit.unmapped_models?.length || 0) > 0) {
    body.push("", tone("Catalog & Family Drift:", "warning bold", hasColor));
    const unresolvedTiers = audit.unresolved_tiers || [];
    for (const item of unresolvedTiers) {
      body.push(
        ...wrapText(
          `  [UNRESOLVED] ${item.selector} (${item.engine}, target=${item.target}) -> None`,
          bodyWidth,
        ),
      );
    }
    const unmapped = audit.unmapped_models || [];
    for (const item of unmapped.slice(0, 10)) {
      body.push(...wrapText(`  [UNMAPPED] ${item.engine}: ${item.id}`, bodyWidth));
    }
    if (unmapped.length > 10) {
      body.push(`  ... (+${unmapped.length - 10} more unmapped live catalog IDs)`);
    }
  }
  if (report.diff.alerts.length > 0) {
    body.push("", tone("Silent-Nerf Telemetry Alerts:", "error bold", hasColor));
    for (const alert of report.diff.alerts) {
      const dropPct = ((alert.degradation_drop || 0) * 100).toFixed(1);
      body.push(
        ...wrapText(
          `  ${tone("[DEGRADED]", "error bold", hasColor)} ${alert.model} on ${alert.archetype}: 14d drop -${dropPct}% (${alert.rolling_14d_runs} runs)`,
          bodyWidth,
        ),
      );
    }
  } else {
    body.push(tone("Telemetry health: all tracked buckets healthy.", "success", hasColor));
  }
  return renderPanel(title, body, width, { color: hasColor, glyphs: glyphSet(tier) })
    .map((line) => line.trimEnd())
    .join("\n");
}

function writeSeenCatalog(seenPath, liveEntries) {
  mkdirSync(path.dirname(seenPath), { recursive: true, mode: 0o700 });
  const payload = {
    acknowledged_at: new Date().toISOString(),
    models: liveEntries.map((entry) => ({
      ...(typeof entry.composite === "boolean" && { composite: entry.composite }),
      ...(entry.engine && { engine: entry.engine }),
      ...(entry.family_stem && { family_stem: entry.family_stem }),
      id: entry.id,
      ...(entry.vendor && { vendor: entry.vendor }),
    })),
    schema: SEEN_SCHEMA,
  };
  writeFileSync(seenPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  return payload;
}

export async function radarCli(argv = [], options = {}) {
  const args = argv[0] === "radar" ? argv.slice(1) : [...argv];
  if (args.includes("--help") || args.includes("-h") || args[0] === "help") {
    if (options.stdout && typeof options.stdout.write === "function") {
      options.stdout.write(RADAR_HELP);
    }
    return { data: null, exitCode: 0, stdout: RADAR_HELP };
  }
  let subcommand = "status";
  if (args[0] && !args[0].startsWith("-")) {
    subcommand = args.shift();
  }
  if (!["ack", "diff", "priors", "status"].includes(subcommand)) {
    throw new Error(
      `Unknown radar subcommand: ${subcommand}. Expected status, diff, priors, or ack.`,
    );
  }
  const { values } = parseArgs({
    args,
    options: {
      ack: { type: "boolean" },
      help: { short: "h", type: "boolean" },
      json: { type: "boolean" },
      line: { type: "boolean" },
      "live-catalog": { type: "string" },
      priors: { type: "string" },
      refresh: { type: "boolean" },
      "runs-dir": { type: "string" },
      "seen-catalog": { type: "string" },
      width: { type: "string" },
    },
  });

  const env = options.env || process.env;
  const cacheDir = options.cacheDir || cacheHome(env);
  const modelsCachePath = path.join(cacheDir, "models-v1.json");
  const seenCachePath = path.join(cacheDir, "models-seen.json");
  const familiesSchema = options.schema || loadFamiliesSchema();
  const priors = options.priors || loadBenchmarkPriors(values.priors || options.priorsPath);

  let telemetry = options.telemetry;
  if (!telemetry) {
    if (subcommand === "priors") {
      telemetry = {
        groups: [],
        runs: 0,
        schema: "agent-executor.telemetry.v1",
        skipped_results: 0,
      };
    } else {
      try {
        telemetry = await summarizeTelemetry(
          values["runs-dir"] || options.runsDir || path.join(cacheDir, "runs-v1"),
        );
      } catch {
        telemetry = {
          groups: [],
          runs: 0,
          schema: "agent-executor.telemetry.v1",
          skipped_results: 0,
        };
      }
    }
  }

  let liveCatalog = options.liveCatalog;
  if (liveCatalog === undefined) {
    if (values["live-catalog"]) {
      liveCatalog = JSON.parse(readFileSync(values["live-catalog"], "utf8"));
    } else if (subcommand === "priors" && !values.refresh) {
      liveCatalog = readJsonFileSafe(modelsCachePath) || [];
    } else {
      const cached = readJsonFileSafe(modelsCachePath);
      if (values.refresh || isCatalogMissingOrStale(cached)) {
        try {
          liveCatalog = await refreshModelsCatalog({
            cacheDir,
            env,
            execFn: options.refreshCatalog,
            refresh: Boolean(values.refresh),
          });
        } catch {
          liveCatalog = cached || [];
        }
      } else {
        liveCatalog = cached;
      }
    }
  }

  let seenCatalog = options.seenCatalog;
  if (seenCatalog === undefined) {
    if (values["seen-catalog"]) {
      seenCatalog = JSON.parse(readFileSync(values["seen-catalog"], "utf8"));
    } else {
      seenCatalog = readJsonFileSafe(seenCachePath) || [];
    }
  }

  const liveEntries = extractModelList(liveCatalog);
  const audit = options.audit || auditCatalogDrift(liveEntries, familiesSchema);
  const isAckRequested = subcommand === "ack" || Boolean(values.ack);
  let hasAcknowledged = false;
  if (isAckRequested) {
    seenCatalog = writeSeenCatalog(seenCachePath, liveEntries);
    hasAcknowledged = true;
  }

  const diff = diffCatalogAgainstSeen(liveCatalog, seenCatalog, priors, {
    audit,
    schema: familiesSchema,
    telemetry,
  });
  const archetypes = buildArchetypePriors(priors);
  const installedEngines = options.installedEngines || detectInstalledEngines(env);
  const report = {
    acknowledged: hasAcknowledged,
    archetypes,
    audit,
    diff,
    installedEngines,
    priors,
    schema: "orkest.radar.v1",
    ...(hasAcknowledged && { seenPath: seenCachePath }),
    subcommand,
    telemetry,
  };

  let output;
  if (values.json) {
    output = JSON.stringify(report, null, 2);
  } else if (values.line) {
    output = formatRadarLine(report);
  } else {
    output = formatRadarText(subcommand, report, {
      color: options.color ?? (options.stdout ? shouldUseColor(options.stdout) : false),
      env,
      tier: options.tier,
      width: values.width || options.width || options.stdout?.columns || 120,
    });
  }
  if (options.stdout && typeof options.stdout.write === "function") {
    options.stdout.write(`${output}\n`);
  }
  return {
    data: report,
    exitCode: 0,
    stdout: output,
  };
}

export const radarCommand = radarCli;
