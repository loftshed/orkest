import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { cacheHome } from "./runtime-paths.mjs";

const SOURCE_FAMILIES_URL = new URL(
  "../skills/orchestrate/references/families.json",
  import.meta.url,
);
const BUNDLED_FAMILIES_URL = new URL("../references/families.json", import.meta.url);
const DEFAULT_FAMILIES_URL = existsSync(SOURCE_FAMILIES_URL)
  ? SOURCE_FAMILIES_URL
  : BUNDLED_FAMILIES_URL;

const FALLBACK_EFFORTS = Object.freeze([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);

const DEFAULT_SCHEMA_CACHE = new Map();

function escapeRegex(value) {
  return String(value).replaceAll(
    new RegExp(String.raw`[.*+?^$\{}()|[\]\\]`, "gu"),
    String.raw`\$&`,
  );
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

export function defaultFamiliesPath() {
  return DEFAULT_FAMILIES_URL;
}

export function loadFamiliesSchema({ familiesPath, forceReload = false } = {}) {
  const cacheKey = "default";
  if (!familiesPath && DEFAULT_SCHEMA_CACHE.has(cacheKey) && !forceReload) {
    return DEFAULT_SCHEMA_CACHE.get(cacheKey);
  }
  const target = familiesPath || DEFAULT_FAMILIES_URL;
  const parsed = readJsonSafe(target);
  const schema = parsed && typeof parsed === "object" ? parsed : { families: {} };
  if (!familiesPath) DEFAULT_SCHEMA_CACHE.set(cacheKey, schema);
  return schema;
}

export function loadCachedModelCatalog({ cacheDir, env = process.env } = {}) {
  const base = cacheDir || cacheHome(env);
  const cachePath = path.join(base, "models-v1.json");
  const parsed = readJsonSafe(cachePath);
  return parsed && typeof parsed === "object" ? parsed : null;
}

export function catalogEntryForEngine(catalog, engine) {
  if (!catalog || !engine) return null;
  const platforms = catalog.platforms;
  if (Array.isArray(platforms)) {
    return platforms.find((item) => item && item.engine === engine) || null;
  }
  if (platforms && typeof platforms === "object") {
    const slot = platforms[engine];
    if (slot && typeof slot === "object") {
      return slot.catalog && typeof slot.catalog === "object" ? slot.catalog : slot;
    }
  }
  return null;
}

export function knownEngines(schema = loadFamiliesSchema()) {
  const engines = new Set();
  const families = Object.values(schema?.families || {});
  for (const family of families) {
    if (family && typeof family.engine === "string" && family.engine.trim()) {
      engines.add(family.engine.trim());
    }
  }
  return engines;
}

export function supportedEfforts(schema = loadFamiliesSchema(), catalog = null) {
  const raw = Array.isArray(schema?.effort_suffixes) ? schema.effort_suffixes : FALLBACK_EFFORTS;
  const efforts = new Set(
    raw
      .filter((item) => typeof item === "string" && item.trim())
      .map((item) => item.trim().toLowerCase()),
  );
  if (catalog) {
    const entries = Array.isArray(catalog.platforms)
      ? catalog.platforms
      : Object.values(catalog.platforms || {}).map((slot) => slot?.catalog || slot);
    for (const entry of entries) {
      const models = entry?.models || [];
      for (const model of models) {
        const list = Array.isArray(model?.supported_efforts)
          ? model.supported_efforts
          : model?.reasoning_efforts || [];
        for (const item of list) {
          if (typeof item === "string" && item.trim()) efforts.add(item.trim().toLowerCase());
        }
        if (typeof model?.effort_slug === "string" && model.effort_slug.trim()) {
          efforts.add(model.effort_slug.trim().toLowerCase());
        }
      }
    }
  }
  return efforts;
}

function defaultFamilyForEngine(engine, schema) {
  const families = Object.entries(schema?.families || {});
  const explicit = families.find(([, fam]) => fam?.engine === engine && fam?.default_for_engine);
  if (explicit) return explicit;
  const matching = families.filter(([, fam]) => fam?.engine === engine);
  return matching.length === 1 ? matching[0] : null;
}

function findCatalogRecord(engineCatalog, model) {
  const models = engineCatalog?.models;
  if (!Array.isArray(models) || !model) return null;
  const lowered = String(model).trim().toLowerCase();
  return (
    models.find((item) => typeof item?.id === "string" && item.id.toLowerCase() === lowered) ||
    models.find(
      (item) =>
        Array.isArray(item?.observed_resolved_ids) &&
        item.observed_resolved_ids.some((obs) => String(obs).toLowerCase() === lowered),
    ) ||
    null
  );
}

function findStemSiblingInCatalog(engineCatalog, stem, effort) {
  const models = engineCatalog?.models;
  if (!Array.isArray(models) || !stem || !effort) return null;
  const loweredStem = stem.toLowerCase();
  const loweredEffort = effort.toLowerCase();
  return (
    models.find(
      (item) =>
        typeof item?.family_stem === "string" &&
        item.family_stem.toLowerCase() === loweredStem &&
        String(item?.effort_slug || "").toLowerCase() === loweredEffort,
    ) || null
  );
}

function isSelectorOrFamilyMatch(model, engine, schema, engineCatalog) {
  if (!model || model === "host-default" || findCatalogRecord(engineCatalog, model)) return true;
  const families = schema?.families || {};
  const lowered = String(model).trim().toLowerCase();
  if (lowered.includes(":")) {
    const [famName, famTier = ""] = lowered.split(":", 2);
    const fam = families[famName];
    return Boolean(
      fam && fam.engine === engine && (!famTier || Object.hasOwn(fam.tiers || {}, famTier)),
    );
  }
  const familyValues = Object.values(families);
  for (const fam of familyValues) {
    if (!fam || fam.engine !== engine) continue;
    const tiers = fam.tiers || {};
    if (
      Object.values(tiers).some((target) => String(target).toLowerCase() === lowered) ||
      Object.values(fam.shorthands || {}).some((target) => String(target).toLowerCase() === lowered)
    ) {
      return true;
    }
    const prefix = typeof fam.prefix === "string" ? fam.prefix.toLowerCase() : "";
    if (prefix && lowered.startsWith(prefix)) return true;
  }
  const entry = defaultFamilyForEngine(engine, schema);
  if (entry?.[1]?.versioned_shorthand_stems?.length > 0) {
    const stems = entry[1].versioned_shorthand_stems.map(escapeRegex).join("|");
    if (
      new RegExp(String.raw`^(?:${escapeRegex(engine)}-|claude-)?(?:${stems})-\d`, "iu").test(
        lowered,
      )
    ) {
      return true;
    }
  }
  return false;
}

function validateModelAgainstCatalog(
  engine,
  model,
  tierInput,
  effort,
  { schema, catalog, validateCatalog },
) {
  const engineCatalog = catalogEntryForEngine(catalog, engine);
  if (!engineCatalog || engineCatalog.status !== "live") return;
  let record = findCatalogRecord(engineCatalog, model);
  if (!record && String(model).includes(":")) {
    const [famName, famTier = ""] = String(model).split(":", 2);
    const availableIds = (engineCatalog.models || []).map((item) => item?.id).filter(Boolean);
    const resolvedId = resolveFamilySelector(famName, famTier, availableIds, schema);
    if (resolvedId) record = findCatalogRecord(engineCatalog, resolvedId);
  }
  if (record) {
    if (effort) {
      if (record.composite) {
        throw new Error(`${engine}:${model} is composite and does not accept effort ${effort}`);
      }
      if (record.effort_slug && record.effort_slug.toLowerCase() !== effort.toLowerCase()) {
        throw new Error(
          `Effort ${effort} conflicts with ${engine} model slug ${record.id} (${record.effort_slug})`,
        );
      }
      const supported = Array.isArray(record.supported_efforts)
        ? record.supported_efforts
        : record.reasoning_efforts || [];
      if (
        supported.length > 0 &&
        !supported.map((s) => s.toLowerCase()).includes(effort.toLowerCase())
      ) {
        throw new Error(
          `Unsupported effort ${effort} for ${engine}:${model}; supported: ${supported.join(", ")}`,
        );
      }
    }
    return;
  }
  if (validateCatalog && !isSelectorOrFamilyMatch(model, engine, schema, engineCatalog)) {
    throw new Error(`Unknown ${engine} model or selector: ${tierInput}`);
  }
}

export function resolveTeamModel(
  engine,
  tier,
  effort,
  { schema = loadFamiliesSchema(), catalog = null, validateCatalog = false } = {},
) {
  const loweredTier = String(tier || "")
    .trim()
    .toLowerCase();
  if (!loweredTier) return tier;
  if (tier.includes(":") || tier.includes("/")) {
    validateModelAgainstCatalog(engine, tier, tier, effort, { schema, catalog, validateCatalog });
    return tier;
  }

  const engineCatalog = catalogEntryForEngine(catalog, engine);
  const defaultEntry = defaultFamilyForEngine(engine, schema);
  let resolved = tier;

  if (defaultEntry) {
    const [familyName, family] = defaultEntry;
    const format = family.team_selector_format || "passthrough";
    const tiers = family.tiers || {};
    const shorthands = family.shorthands || {};
    const bareAliases = family.bare_aliases || {};

    if (format === "exact") {
      const normalizedShorthandKey = loweredTier.replaceAll(".", "-");
      if (Object.hasOwn(tiers, loweredTier)) {
        resolved = tiers[loweredTier];
      } else if (Object.hasOwn(shorthands, loweredTier)) {
        resolved = shorthands[loweredTier];
      } else if (Object.hasOwn(shorthands, normalizedShorthandKey)) {
        resolved = shorthands[normalizedShorthandKey];
      } else if (
        Array.isArray(family.versioned_shorthand_stems) &&
        family.versioned_shorthand_stems.length > 0
      ) {
        const stems = family.versioned_shorthand_stems.map(escapeRegex).join("|");
        const versionMatch = new RegExp(
          String.raw`^(?:claude-)?(${stems})-(\d+(?:[.-]\d+)*)(\[1m\])?$`,
          "iu",
        ).exec(tier.trim());
        if (versionMatch) {
          const [, stem, version, suffix = ""] = versionMatch;
          resolved = `claude-${stem.toLowerCase()}-${version.replaceAll(".", "-")}${suffix.toLowerCase()}`;
        }
      }
    } else if (format === "family") {
      const candidates = effort
        ? [`${loweredTier}-${effort.toLowerCase()}`, loweredTier]
        : [loweredTier];
      let isMatched = false;
      for (const candidate of candidates) {
        if (Object.hasOwn(bareAliases, candidate)) {
          resolved = `${familyName}:${bareAliases[candidate]}`;
          isMatched = true;
          break;
        }
        if (Object.hasOwn(tiers, candidate)) {
          resolved = `${familyName}:${candidate}`;
          isMatched = true;
          break;
        }
      }
      if (!isMatched && effort && engineCatalog) {
        const sibling = findStemSiblingInCatalog(engineCatalog, tier, effort);
        if (sibling?.id) resolved = sibling.id;
      }
    } else {
      if (Object.hasOwn(bareAliases, loweredTier)) {
        resolved = `${familyName}:${bareAliases[loweredTier]}`;
      } else if (Object.hasOwn(tiers, loweredTier)) {
        resolved = `${familyName}:${loweredTier}`;
      } else if (typeof family.prefix === "string" && family.prefix) {
        const tierKeys = Object.keys(tiers);
        if (tierKeys.length > 0) {
          const versionTier = new RegExp(
            String.raw`^\d+(?:\.\d+)?-(?:${tierKeys.map(escapeRegex).join("|")})$`,
            "iu",
          );
          if (versionTier.test(loweredTier)) {
            resolved = `${family.prefix}${loweredTier}`;
          }
        }
      }
    }
  }

  validateModelAgainstCatalog(engine, resolved, tier, effort, { schema, catalog, validateCatalog });
  return resolved;
}

export function allBrandMarks(schema = loadFamiliesSchema()) {
  const seen = new Set();
  const marks = [];
  const familyValues = Object.values(schema?.families || {});
  for (const family of familyValues) {
    const brand = family?.brand;
    if (!brand?.glyph || !brand?.tone || seen.has(brand.glyph)) continue;
    seen.add(brand.glyph);
    marks.push({ glyph: brand.glyph, tone: brand.tone });
  }
  return marks;
}

export function brandForProvider(provider, { schema = loadFamiliesSchema(), catalog = null } = {}) {
  const name = String(provider || "")
    .trim()
    .toLowerCase();
  if (!name) return null;
  const familyEntries = Object.entries(schema?.families || {});
  for (const [familyName, family] of familyEntries) {
    const brand = family?.brand;
    if (!brand?.glyph) continue;
    const aliases =
      Array.isArray(brand.aliases) && brand.aliases.length > 0 ? brand.aliases : [familyName];
    const pattern = new RegExp(
      String.raw`^(?:${aliases.map(escapeRegex).join("|")})(?:$|[-_.:/\s\d])`,
      "u",
    );
    if (pattern.test(name)) {
      return { glyph: brand.glyph, tone: brand.tone };
    }
  }
  if (catalog) {
    const familyValues = Object.values(schema?.families || {});
    for (const fam of familyValues) {
      if (!fam?.brand?.glyph || !fam.engine) continue;
      const entry = catalogEntryForEngine(catalog, fam.engine);
      const record = findCatalogRecord(entry, name);
      if (!record) continue;
      const vendor = String(record.vendor || "").toLowerCase();
      if (!vendor || vendor === String(fam.vendor || "").toLowerCase()) {
        return { glyph: fam.brand.glyph, tone: fam.brand.tone };
      }
    }
  }
  return null;
}

export function modelWords(modelId) {
  return String(modelId || "")
    .replaceAll("/", "-")
    .split("-");
}

export function modelVersionTuple(modelId) {
  for (const word of modelWords(modelId)) {
    if (!word) continue;
    const stripped = word.startsWith("v") ? word.slice(1) : word;
    const parts = stripped.split(".");
    if (parts.every((part) => /^\d+$/u.test(part))) {
      return parts.map(Number);
    }
    if (/^\d/u.test(word)) continue;
    const match = /(\d+(?:\.\d+)*)$/u.exec(word);
    if (match) return match[1].split(".").map(Number);
  }
  return [];
}

function compareVersionTuples(left, right) {
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i++) {
    const a = left[i] ?? 0;
    const b = right[i] ?? 0;
    if (a !== b) return a - b;
  }
  return 0;
}

export function resolveFamilySelector(
  familyName,
  tier,
  availableIds = [],
  schema = loadFamiliesSchema(),
) {
  const families = schema?.families || {};
  const family = families[familyName];
  if (!family || !Array.isArray(availableIds) || availableIds.length === 0) return null;
  const resolvedTier = tier || family.default_tier || Object.keys(family.tiers || {})[0];
  const target = family.tiers?.[resolvedTier];
  if (!target) return null;
  const candidates =
    typeof target === "string"
      ? target
          .split("|")
          .map((item) => item.trim())
          .filter(Boolean)
      : [...target];
  const availableSet = new Set(availableIds);
  for (const candidate of candidates) {
    if (availableSet.has(candidate)) return candidate;
  }
  const prefix = family.prefix;
  if (!prefix) return null;
  for (const candidate of candidates) {
    const keyword = `-${modelWords(candidate).join("-")}-`;
    const matches = availableIds.filter(
      (id) =>
        id.startsWith(prefix) &&
        `-${modelWords(id.slice(prefix.length)).join("-")}-`.includes(keyword),
    );
    if (matches.length > 0) {
      matches.sort((a, b) => compareVersionTuples(modelVersionTuple(b), modelVersionTuple(a)));
      return matches[0];
    }
  }
  return null;
}

export function modelMatchesFamilySelector(modelId, selector, schema = loadFamiliesSchema()) {
  if (!modelId || !selector) return false;
  const families = schema?.families || {};
  const [familyName, rawTier] = String(selector).split(":", 2);
  const family = families[familyName];
  if (!family) return false;
  const tier = rawTier || family.default_tier || Object.keys(family.tiers || {})[0];
  const target = family.tiers?.[tier];
  if (!target) return false;
  const candidates =
    typeof target === "string"
      ? target
          .split("|")
          .map((item) => item.trim())
          .filter(Boolean)
      : [...target];
  const loweredId = String(modelId).trim().toLowerCase();
  for (const candidate of candidates) {
    if (candidate.toLowerCase() === loweredId) return true;
    const prefix = family.prefix;
    if (prefix && loweredId.startsWith(prefix.toLowerCase())) {
      const keyword = `-${modelWords(candidate.toLowerCase()).join("-")}-`;
      const hay = `-${modelWords(loweredId.slice(prefix.length)).join("-")}-`;
      if (hay.includes(keyword)) return true;
    }
    if (
      family.engine === "claude" &&
      loweredId.startsWith("claude-") &&
      modelWords(loweredId).includes(candidate.toLowerCase())
    ) {
      return true;
    }
  }
  return false;
}

function matchesExclusion(leaf, exclusion) {
  const excTokens = String(exclusion || "")
    .toLowerCase()
    .split(/[-_.:~/]+/u)
    .filter(Boolean);
  if (excTokens.length === 0) return false;
  const leafTokens = String(leaf || "")
    .toLowerCase()
    .split(/[^a-z0-9.]+/u)
    .filter(Boolean);
  for (let i = 0; i <= leafTokens.length - excTokens.length; i++) {
    if (excTokens.every((tok, idx) => leafTokens[i + idx] === tok)) return true;
  }
  return false;
}

export function nativeEngineForModel(modelId, schema = loadFamiliesSchema()) {
  if (!modelId) return null;
  const lowered = String(modelId).trim().toLowerCase();
  const segments = lowered.split("/");
  const leaf = segments.at(-1) || "";
  const tokens = leaf.split(/[-_.:~]/u);
  const exclusions = Array.isArray(schema?.native_exclusions) ? schema.native_exclusions : [];
  if (exclusions.some((exc) => matchesExclusion(leaf, exc))) return null;

  const preferredOrder = ["claude", "codex", "agy"];
  const byEngine = new Map();
  const familyValues = Object.values(schema?.families || {});
  for (const family of familyValues) {
    if (!family?.default_for_engine || !family.engine) continue;
    if (!byEngine.has(family.engine)) {
      byEngine.set(family.engine, { providers: new Set(), keywords: new Set() });
    }
    const bucket = byEngine.get(family.engine);
    const nativeProviders = family.native_providers || [];
    for (const p of nativeProviders) bucket.providers.add(String(p).toLowerCase());
    const nativeKeywords = family.native_keywords || [];
    for (const k of nativeKeywords) bucket.keywords.add(String(k).toLowerCase());
  }
  const ordered = [
    ...preferredOrder.filter((eng) => byEngine.has(eng)),
    ...byEngine.keys().filter((eng) => !preferredOrder.includes(eng)),
  ];
  for (const engine of ordered) {
    const { providers, keywords } = byEngine.get(engine);
    if (
      segments.slice(0, -1).some((seg) => providers.has(seg)) ||
      tokens.some((tok) => keywords.has(tok))
    ) {
      return engine;
    }
  }
  return null;
}

function isModelMappedByFamily(modelId, family) {
  const lowered = String(modelId).trim().toLowerCase();
  const prefix = family?.prefix;
  const tierTargets = Object.values(family?.tiers || {});
  for (const target of tierTargets) {
    if (typeof target !== "string") continue;
    const alternatives = target.split("|");
    for (const alt of alternatives) {
      const clean = alt.trim();
      if (!clean) continue;
      if (clean.toLowerCase() === lowered) return true;
      if (!prefix || !lowered.startsWith(prefix.toLowerCase())) continue;
      const needed = modelWords(clean.toLowerCase()).filter(Boolean);
      const words = modelWords(lowered);
      if (needed.length > 0 && needed.every((part) => words.includes(part))) return true;
    }
  }
  const shorthandTargets = Object.values(family?.shorthands || {});
  for (const target of shorthandTargets) {
    if (typeof target === "string" && target.trim().toLowerCase() === lowered) return true;
  }
  if (family?.engine === "claude" && lowered.startsWith("claude-")) {
    const words = modelWords(lowered);
    const stems = Array.isArray(family?.versioned_shorthand_stems)
      ? family.versioned_shorthand_stems
      : [];
    if (stems.some((stem) => words.includes(String(stem).toLowerCase()))) return true;
  }
  return false;
}

function belongsToFamilyVendor(entry, family) {
  const lowered = String(entry?.id || "").toLowerCase();
  const segments = lowered.split("/").filter(Boolean);
  const providers = new Set(
    [family?.vendor, ...(family?.native_providers || [])]
      .filter((p) => typeof p === "string" && p.trim())
      .map((p) => p.trim().toLowerCase()),
  );
  if (typeof entry?.vendor === "string" && providers.has(entry.vendor.trim().toLowerCase())) {
    return true;
  }
  if (segments.slice(0, -1).some((seg) => providers.has(seg.replace(/^~/u, "")))) {
    return true;
  }
  const leafTokens = (segments.at(-1) || "").split(/[-_.:~]/u);
  const keywords = new Set(
    (family?.native_keywords || [])
      .filter((k) => typeof k === "string" && k.trim())
      .map((k) => k.trim().toLowerCase()),
  );
  return leafTokens.some((tok) => keywords.has(tok));
}

export function auditCatalogDrift(liveEntries = [], schema = loadFamiliesSchema()) {
  const families = schema?.families || {};
  const byEngine = new Map();
  for (const entry of liveEntries) {
    if (!entry?.id) continue;
    const inferredEngine =
      entry.engine && entry.engine !== "unknown"
        ? entry.engine
        : nativeEngineForModel(entry.id, schema);
    if (!inferredEngine) continue;
    if (!byEngine.has(inferredEngine)) byEngine.set(inferredEngine, []);
    byEngine.get(inferredEngine).push(entry);
  }

  const unresolved_tiers = [];
  const unavailable_engines = [];
  const resolved_selectors = {};

  for (const [familyName, family] of Object.entries(families)) {
    const engine = family?.engine;
    if (!engine) continue;
    const engineEntries = byEngine.get(engine) || [];
    const availableIds = engineEntries.map((item) => item.id);
    if (availableIds.length === 0) {
      if (!unavailable_engines.includes(engine)) unavailable_engines.push(engine);
      continue;
    }
    const tierEntries = Object.entries(family.tiers || {});
    for (const [tierName, target] of tierEntries) {
      const resolved = resolveFamilySelector(familyName, tierName, availableIds, schema);
      resolved_selectors[`${familyName}:${tierName}`] = resolved;
      if (!resolved) {
        unresolved_tiers.push({
          engine,
          family: familyName,
          selector: `${familyName}:${tierName}`,
          target,
          tier: tierName,
        });
      }
    }
  }

  const familiesByEngine = new Map();
  for (const [familyName, family] of Object.entries(families)) {
    if (!family?.engine) continue;
    if (!familiesByEngine.has(family.engine)) familiesByEngine.set(family.engine, []);
    familiesByEngine.get(family.engine).push([familyName, family]);
  }

  const unmapped_models = [];
  const cross_harness_models = [];
  let untracked_aggregator_count = 0;

  for (const [engine, engineEntries] of byEngine) {
    const engineFamilies = familiesByEngine.get(engine) || [];
    const seenIds = new Set();
    for (const entry of engineEntries) {
      const lowered = entry.id.toLowerCase();
      if (seenIds.has(lowered)) continue;
      seenIds.add(lowered);
      if (engineFamilies.some(([, fam]) => isModelMappedByFamily(entry.id, fam))) continue;
      const native = nativeEngineForModel(entry.id, schema);
      if (native && native !== engine) {
        cross_harness_models.push({ engine, id: entry.id, native_engine: native });
        continue;
      }
      const belongs = engineFamilies.some(([, fam]) => belongsToFamilyVendor(entry, fam));
      if (engine === "opencode" && lowered.startsWith("openrouter/") && !belongs) {
        untracked_aggregator_count += 1;
        continue;
      }
      unmapped_models.push({
        engine,
        id: entry.id,
        reason: belongs ? "unmapped_family_variant" : "unmapped_model",
        vendor: entry.vendor || null,
      });
    }
  }

  return {
    cross_harness_models,
    has_drift: unresolved_tiers.length > 0 || unmapped_models.length > 0,
    resolved_selectors,
    unavailable_engines,
    unmapped_models,
    unresolved_tiers,
    untracked_aggregator_count,
  };
}
