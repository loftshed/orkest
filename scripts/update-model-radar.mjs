#!/usr/bin/env node
// Zero-LLM-token model release radar sync script.
// Fetches public static JSON catalogs (or reads an offline fixture) and reports
// newly released model IDs from Anthropic, OpenAI, Google, Z.AI, and DeepSeek
// that are not yet tracked in benchmarks.prior.json.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  DEFAULT_PRIORS_PATH,
  diffCatalogAgainstSeen,
  loadBenchmarkPriors,
} from "../plugins/orchestrate/lib/radar.mjs";

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

export const VENDOR_PREFIXES = [
  "anthropic/",
  "claude-",
  "deepseek/",
  "gemini-",
  "google/",
  "gpt-",
  "openai/",
  "openrouter/deepseek/",
  "openrouter/z-ai/",
  "z-ai/",
];

export function isTrackedVendorModel(modelId) {
  if (typeof modelId !== "string" || !modelId.trim()) return false;
  const normalized = modelId.trim().toLowerCase();
  return VENDOR_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function normalizeCatalogPayload(payload) {
  let rawList = [];
  if (Array.isArray(payload)) {
    rawList = payload;
  } else if (Array.isArray(payload?.data)) {
    rawList = payload.data;
  } else if (Array.isArray(payload?.models)) {
    rawList = payload.models;
  }
  const entries = [];
  for (const item of rawList) {
    const id = typeof item === "string" ? item : item?.id;
    if (!isTrackedVendorModel(id)) continue;
    entries.push({
      created: item?.created ?? null,
      id,
      name: item?.name ?? id,
    });
  }
  return entries;
}

export async function fetchPublicCatalog({
  fetchImpl = fetch,
  fixturePath,
  url = OPENROUTER_MODELS_URL,
} = {}) {
  if (fixturePath) {
    const text = fs.readFileSync(fixturePath, "utf8");
    return normalizeCatalogPayload(JSON.parse(text));
  }
  const response = await fetchImpl(url, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Catalog fetch failed with HTTP ${response.status}`);
  }
  const payload = await response.json();
  return normalizeCatalogPayload(payload);
}

export async function updateModelRadar(argv = process.argv.slice(2), options = {}) {
  const { values } = parseArgs({
    args: argv,
    options: {
      "dry-run": { type: "boolean" },
      fixture: { type: "string" },
      json: { type: "boolean" },
      priors: { type: "string" },
      url: { type: "string" },
    },
  });

  const priorsPath = values.priors || options.priorsPath || DEFAULT_PRIORS_PATH;
  const priors = options.priors || loadBenchmarkPriors(priorsPath);
  const liveCatalog =
    options.liveCatalog ||
    (await fetchPublicCatalog({
      fetchImpl: options.fetchImpl,
      fixturePath: values.fixture || options.fixturePath,
      url: values.url || options.url,
    }));

  const priorIds = Object.keys(priors.models || {});
  const mergedLive = [
    ...priorIds.map((id) => ({ id })),
    ...liveCatalog.filter((entry) => !priorIds.includes(entry.id)),
  ];
  const diff = diffCatalogAgainstSeen(mergedLive, priorIds, priors);
  const result = {
    checked_at: new Date().toISOString(),
    dry_run: Boolean(values["dry-run"] || options.dryRun),
    new_models: diff.newModels,
    priors_path: path.resolve(priorsPath),
    schema: "orkest.radar.sync.v1",
    tracked_count: priorIds.length,
  };

  const output = values.json
    ? JSON.stringify(result, null, 2)
    : `Radar sync complete (tracked=${result.tracked_count}, new=${result.new_models.length})${
        result.new_models.length > 0 ? `: ${result.new_models.join(", ")}` : ""
      }`;

  if (options.stdout && typeof options.stdout.write === "function") {
    options.stdout.write(`${output}\n`);
  } else if (!options.silent) {
    console.log(output);
  }
  return result;
}

async function main() {
  try {
    await updateModelRadar();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  main();
}
