"""Model family selectors: `deepseek`, `gpt:luna`, `gemini:fast` resolve to the newest live ID.

Rules live in references/families.json; a `families` key in the user's config overrides or adds a family
by name. The code holds no model IDs: a new release is picked up from the live catalog.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

DEFAULTS_PATH = Path(__file__).resolve().parent.parent / "references" / "families.json"


class SelectorError(ValueError):
    pass


def load_families(config: dict[str, Any] | None = None) -> dict[str, dict[str, Any]]:
    families = json.loads(DEFAULTS_PATH.read_text(encoding="utf-8"))["families"]
    if config is not None and not isinstance(config, dict):
        raise SelectorError("the config must be a JSON object")
    overrides = (config or {}).get("families")
    if overrides is None:
        overrides = {}
    if not isinstance(overrides, dict):
        raise SelectorError("`families` in the config must be an object of family name -> rules")
    for name, family in overrides.items():
        if not isinstance(family, dict) or not family.get("engine") or not isinstance(family.get("tiers"), dict):
            raise SelectorError(f"family {name!r} in the config needs an engine and a tiers object")
        families[name] = family
    return families


def parse_selector(text: str, families: dict[str, dict[str, Any]]) -> tuple[str, str | None] | None:
    """`deepseek`, `deepseek:pro` or `latest:deepseek:pro` -> (family, tier or None); None if not a selector."""
    parts = text.split(":")
    if parts[0] == "latest" and len(parts) > 1:
        parts = parts[1:]
    if len(parts) > 2 or parts[0] not in families or any(not p.strip() for p in parts):
        return None
    return parts[0], (parts[1].strip() if len(parts) == 2 else None)


def words(model_id: str) -> list[str]:
    """An ID's words: `/` and `-` both separate them."""
    return model_id.replace("/", "-").split("-")


def version_of(model_id: str) -> tuple[int, ...]:
    """The first word that is a version like `6`, `6.1`, `v4.1`, or attached `qwen2.5` / `glm4`, as a tuple; () when none.

    Only the first one counts, so a later date suffix (`-0731`) never outranks the version.
    """
    for word in words(model_id):
        if not word:
            continue
        parts = word.removeprefix("v").split(".")
        if all(part.isdigit() for part in parts):
            return tuple(int(part) for part in parts)
        if not word[0].isdigit():
            match = re.search(r"(\d+(?:\.\d+)*)$", word)
            if match:
                return tuple(int(part) for part in match.group(1).split("."))
    return ()


def resolve(family_name: str, tier: str | None, families: dict[str, dict[str, Any]], available: list[str]) -> str:
    family = families[family_name]
    if tier is not None and not tier.strip():
        raise SelectorError(f"Unsupported selector {f'{family_name}:{tier}'!r}")
    tier = tier.strip() if tier is not None else (family.get("default_tier") or next(iter(family["tiers"])))
    if tier not in family["tiers"]:
        raise SelectorError(f"{family_name} has no tier {tier!r}; tiers: {', '.join(family['tiers'])}")
    value = family["tiers"][tier]
    candidates = [item.strip() for item in value.split("|")] if isinstance(value, str) else list(value)
    for candidate in candidates:
        if candidate in available:
            return candidate
    prefix = family.get("prefix")
    if not prefix:
        # Without a prefix a keyword would match across vendors, so tier values must be exact IDs.
        raise SelectorError(f"{candidates[0]} ({family_name}:{tier}) is not in the live {family['engine']} catalog")
    for candidate in candidates:
        keyword = f"-{'-'.join(words(candidate))}-"
        matches = [i for i in available if i.startswith(prefix) and keyword in f"-{'-'.join(words(i[len(prefix) :]))}-"]
        if matches:
            return max(matches, key=version_of)
    raise SelectorError(f"no {family_name}:{tier} model in the live {family['engine']} catalog")


def report(families: dict[str, dict[str, Any]], catalogs: dict[str, list[str]]) -> list[dict[str, Any]]:
    rows = []
    for name, family in families.items():
        available = catalogs.get(family["engine"])
        resolved: dict[str, str | None] = {}
        for tier in family["tiers"]:
            try:
                resolved[tier] = None if available is None else resolve(name, tier, families, available)
            except SelectorError:
                resolved[tier] = None
        rows.append(
            {
                "family": name,
                "engine": family["engine"],
                "default_tier": family.get("default_tier"),
                "catalog": "live" if available is not None else "unavailable",
                "resolved": resolved,
            }
        )
    return rows


DEFAULT_EFFORT_SUFFIXES = ("minimal", "low", "medium", "high", "xhigh", "max", "ultra")


def load_schema(config: dict[str, Any] | None = None) -> dict[str, Any]:
    """Load the full families schema metadata plus any user overrides."""
    schema = json.loads(DEFAULTS_PATH.read_text(encoding="utf-8"))
    if isinstance(config, dict):
        if isinstance(config.get("effort_suffixes"), list):
            schema["effort_suffixes"] = list(config["effort_suffixes"])
        if isinstance(config.get("native_exclusions"), list):
            schema["native_exclusions"] = list(config["native_exclusions"])
    schema["families"] = load_families(config)
    return schema


def effort_suffixes(schema: dict[str, Any] | None = None) -> tuple[str, ...]:
    source = schema if isinstance(schema, dict) else load_schema()
    raw = source.get("effort_suffixes")
    if isinstance(raw, list) and raw:
        cleaned = tuple(str(item).strip().lower() for item in raw if isinstance(item, str) and item.strip())
        if cleaned:
            return cleaned
    return DEFAULT_EFFORT_SUFFIXES


def native_exclusions(schema: dict[str, Any] | None = None) -> tuple[str, ...]:
    source = schema if isinstance(schema, dict) else load_schema()
    raw = source.get("native_exclusions")
    if isinstance(raw, list):
        return tuple(str(item).strip().lower() for item in raw if isinstance(item, str) and item.strip())
    return ()


def engine_default_families(families: dict[str, dict[str, Any]] | None = None) -> dict[str, str]:
    loaded = families if families is not None else load_families()
    defaults: dict[str, str] = {}
    counts: dict[str, list[str]] = {}
    for name, family in loaded.items():
        if not isinstance(family, dict):
            continue
        engine = family.get("engine")
        if not isinstance(engine, str) or not engine:
            continue
        counts.setdefault(engine, []).append(name)
        if family.get("default_for_engine"):
            defaults[engine] = name
    for engine, names in counts.items():
        if engine not in defaults and len(names) == 1:
            defaults[engine] = names[0]
    return defaults


def bare_tier_aliases(families: dict[str, dict[str, Any]] | None = None) -> dict[tuple[str, str], tuple[str, str]]:
    loaded = families if families is not None else load_families()
    aliases: dict[tuple[str, str], tuple[str, str]] = {}
    for family_name, family in loaded.items():
        if not isinstance(family, dict):
            continue
        engine = family.get("engine")
        raw_aliases = family.get("bare_aliases")
        if not isinstance(engine, str) or not isinstance(raw_aliases, dict):
            continue
        for alias, target_tier in raw_aliases.items():
            if isinstance(alias, str) and isinstance(target_tier, str) and alias.strip() and target_tier.strip():
                aliases[(engine.strip().lower(), alias.strip().lower())] = (family_name, target_tier.strip().lower())
    return aliases


def claude_aliases(families: dict[str, dict[str, Any]] | None = None) -> tuple[str, ...]:
    loaded = families if families is not None else load_families()
    claude = loaded.get("claude")
    tiers = claude.get("tiers") if isinstance(claude, dict) else None
    if not isinstance(tiers, dict):
        return ()
    seen: list[str] = []
    for target in tiers.values():
        if isinstance(target, str) and target.strip() and target not in seen:
            seen.append(target.strip())
    return tuple(seen)


def claude_shorthands(families: dict[str, dict[str, Any]] | None = None) -> dict[str, str]:
    loaded = families if families is not None else load_families()
    claude = loaded.get("claude")
    raw = claude.get("shorthands") if isinstance(claude, dict) else None
    if not isinstance(raw, dict):
        return {}
    return {
        key.strip().lower(): value.strip()
        for key, value in raw.items()
        if isinstance(key, str) and isinstance(value, str) and key.strip() and value.strip()
    }


def claude_versioned_stems(families: dict[str, dict[str, Any]] | None = None) -> tuple[str, ...]:
    loaded = families if families is not None else load_families()
    claude = loaded.get("claude")
    if isinstance(claude, dict):
        raw = claude.get("versioned_shorthand_stems")
        if isinstance(raw, list) and raw:
            return tuple(str(item).strip().lower() for item in raw if isinstance(item, str) and item.strip())
    stems: list[str] = []
    for alias in claude_aliases(loaded):
        if "-" not in alias and alias.lower() not in stems:
            stems.append(alias.lower())
    for key in claude_shorthands(loaded):
        if "-" not in key and key not in stems:
            stems.append(key)
    return tuple(stems)


def claude_default_efforts(families: dict[str, dict[str, Any]] | None = None) -> tuple[str, ...]:
    loaded = families if families is not None else load_families()
    claude = loaded.get("claude")
    raw = claude.get("default_efforts") if isinstance(claude, dict) else None
    if isinstance(raw, list) and raw:
        cleaned = tuple(str(item).strip().lower() for item in raw if isinstance(item, str) and item.strip())
        if cleaned:
            return cleaned
    return ("low", "medium", "high", "xhigh", "max")


def native_family_specs(
    families: dict[str, dict[str, Any]] | None = None,
) -> tuple[tuple[str, frozenset[str], frozenset[str]], ...]:
    loaded = families if families is not None else load_families()
    by_engine: dict[str, tuple[set[str], set[str]]] = {}
    for family in loaded.values():
        if not isinstance(family, dict) or not family.get("default_for_engine"):
            continue
        engine = family.get("engine")
        if not isinstance(engine, str) or not engine:
            continue
        providers, keywords = by_engine.setdefault(engine, (set(), set()))
        for item in family.get("native_providers", []):
            if isinstance(item, str) and item.strip():
                providers.add(item.strip().lower())
        for item in family.get("native_keywords", []):
            if isinstance(item, str) and item.strip():
                keywords.add(item.strip().lower())
    preferred_order = ("claude", "codex", "agy")
    ordered_engines = [eng for eng in preferred_order if eng in by_engine] + [
        eng for eng in by_engine if eng not in preferred_order
    ]
    return tuple(
        (engine, frozenset(by_engine[engine][0]), frozenset(by_engine[engine][1])) for engine in ordered_engines
    )


def _matches_exclusion(leaf: str, exclusion: str) -> bool:
    exc_tokens = [token for token in re.split(r"[-_.:~/]+", exclusion.lower()) if token]
    leaf_tokens = [token for token in re.split(r"[^a-z0-9.]+", leaf.lower()) if token]
    if not exc_tokens:
        return False
    width = len(exc_tokens)
    return any(leaf_tokens[index : index + width] == exc_tokens for index in range(len(leaf_tokens) - width + 1))


def native_engine_for_model(
    model: str,
    families: dict[str, dict[str, Any]] | None = None,
    schema: dict[str, Any] | None = None,
) -> str | None:
    loaded_schema = schema if isinstance(schema, dict) else load_schema()
    loaded_families = families if families is not None else loaded_schema.get("families")
    segments = model.lower().split("/")
    tokens = re.split(r"[-_.:~]", segments[-1])
    exclusions = native_exclusions(loaded_schema)
    if any(_matches_exclusion(segments[-1], exc) for exc in exclusions):
        return None
    for engine, providers, names in native_family_specs(loaded_families):
        if any(segment in providers for segment in segments[:-1]):
            return engine
        if any(token in names for token in tokens):
            return engine
    return None


def selector_capability_tiers(families: dict[str, dict[str, Any]] | None = None) -> dict[str, int]:
    loaded = families if families is not None else load_families()
    tiers: dict[str, int] = {}
    for family_name, family in loaded.items():
        if not isinstance(family, dict):
            continue
        cap_map = family.get("capability_tiers")
        if not isinstance(cap_map, dict):
            continue
        raw_tiers = family.get("tiers")
        if isinstance(raw_tiers, dict):
            for tier_name, target in raw_tiers.items():
                score = cap_map.get(tier_name)
                if score is None and isinstance(target, str):
                    score = cap_map.get(target.strip().lower())
                if isinstance(score, int):
                    tiers[f"{family_name}:{tier_name}"] = score
        default_tier = family.get("default_tier")
        if not family.get("prefix") and not family.get("default_for_engine") and isinstance(default_tier, str):
            bare_score = tiers.get(f"{family_name}:{default_tier}") or cap_map.get(default_tier)
            if isinstance(bare_score, int):
                tiers[family_name] = bare_score
    return tiers


def _family_matches_leaf(leaf: str, family_name: str, family: dict[str, Any], exclusions: tuple[str, ...]) -> bool:
    if any(_matches_exclusion(leaf, exc) for exc in exclusions):
        return False
    prefix = family.get("prefix")
    if isinstance(prefix, str) and prefix and leaf.startswith(prefix.lower()):
        return True
    tokens = set(re.split(r"[^a-z0-9.]+", leaf))
    keywords = {str(k).lower() for k in family.get("native_keywords", []) if isinstance(k, str)}
    if keywords & tokens:
        return True
    if family_name.lower() in tokens:
        return True
    bare = {str(k).lower() for k in family.get("bare_aliases", {}) if isinstance(k, str)}
    return leaf in bare or bool(bare & tokens)


def capability_tier(
    model: str | None,
    families: dict[str, dict[str, Any]] | None = None,
    schema: dict[str, Any] | None = None,
    catalog: dict[str, Any] | None = None,
) -> int | None:
    """Return a coarse capability tier (1=fast/lightweight .. 4=apex frontier), or None when unknown."""
    if not isinstance(model, str) or not model.strip():
        return None
    loaded_schema = schema if isinstance(schema, dict) else load_schema()
    loaded_families = families if families is not None else loaded_schema.get("families")
    exclusions = native_exclusions(loaded_schema)
    sel_tiers = selector_capability_tiers(loaded_families)
    normalized = model.strip().lower().removeprefix("latest:")
    if normalized in sel_tiers:
        return sel_tiers[normalized]

    # Check explicit alias -> selector mappings across families (e.g. orchestrator-carbon).
    for (engine, alias), (fam_name, target_tier) in bare_tier_aliases(loaded_families).items():
        del engine
        if normalized == alias:
            key = f"{fam_name}:{target_tier}"
            if key in sel_tiers:
                return sel_tiers[key]

    leaf = normalized.rsplit("/", 1)[-1].split("[", 1)[0]
    if any(_matches_exclusion(leaf, exc) for exc in exclusions):
        return None
    tokens = [token for token in re.split(r"[^a-z0-9.]+", leaf) if token]
    token_set = set(tokens)
    # Build adjacent compound phrases (e.g. hydrogen-xhigh, orchestrator-carbon, pro-high).
    compounds = {"-".join(tokens[i : j + 1]) for i in range(len(tokens)) for j in range(i, len(tokens))}

    for family_name, family in loaded_families.items():
        if not isinstance(family, dict):
            continue
        cap_map = family.get("capability_tiers")
        if not isinstance(cap_map, dict) or not _family_matches_leaf(leaf, family_name, family, exclusions):
            continue
        # Longest key first ensures compound keys like `hydrogen-xhigh` or `pro-high` beat single words.
        for key in sorted(cap_map, key=lambda item: (-len(str(item)), str(item))):
            score = cap_map[key]
            if not isinstance(score, int):
                continue
            key_lower = str(key).lower()
            if key_lower in compounds or key_lower in token_set:
                return score
        default_score = family.get("default_capability_tier")
        if isinstance(default_score, int):
            return default_score

    if isinstance(catalog, dict):
        for entry in catalog.get("models", []):
            if not isinstance(entry, dict):
                continue
            if str(entry.get("id", "")).strip().lower() == normalized:
                stem = entry.get("family_stem")
                if isinstance(stem, str) and stem.strip() and stem.strip().lower() != normalized:
                    return capability_tier(stem, loaded_families, loaded_schema, None)
    return None


def _extract_catalog_records(entry: Any) -> tuple[str, list[dict[str, Any]]]:
    if isinstance(entry, list):
        records: list[dict[str, Any]] = []
        for item in entry:
            if isinstance(item, str) and item.strip():
                records.append({"id": item.strip()})
            elif isinstance(item, dict) and isinstance(item.get("id"), str) and item["id"].strip():
                records.append(item)
        return ("live" if records else "unavailable", records)
    if isinstance(entry, dict):
        status = str(entry.get("status") or "")
        models = entry.get("models")
        if isinstance(models, list):
            records = []
            for item in models:
                if isinstance(item, str) and item.strip():
                    records.append({"id": item.strip()})
                elif isinstance(item, dict) and isinstance(item.get("id"), str) and item["id"].strip():
                    records.append(item)
            if not status:
                status = "live" if records else "unavailable"
            return (status, records)
    return ("unavailable", [])


def _is_model_mapped_by_family(model_id: str, family: dict[str, Any]) -> bool:
    tiers = family.get("tiers") if isinstance(family.get("tiers"), dict) else {}
    lowered = model_id.strip().lower()
    prefix = family.get("prefix")
    for target in tiers.values():
        if not isinstance(target, str):
            continue
        for alt in target.split("|"):
            alt_clean = alt.strip()
            if not alt_clean:
                continue
            if alt_clean.lower() == lowered:
                return True
            if isinstance(prefix, str) and prefix and lowered.startswith(prefix.lower()):
                model_words = words(lowered)
                needed = [part.lower() for part in alt_clean.split("-") if part]
                if needed and all(part in model_words for part in needed):
                    return True
    shorthands = family.get("shorthands") if isinstance(family.get("shorthands"), dict) else {}
    if any(isinstance(v, str) and v.strip().lower() == lowered for v in shorthands.values()):
        return True
    stems = family.get("versioned_shorthand_stems") if isinstance(family.get("versioned_shorthand_stems"), list) else []
    if family.get("engine") == "claude" and lowered.startswith("claude-"):
        model_words = words(lowered)
        if any(isinstance(stem, str) and stem.lower() in model_words for stem in stems):
            return True
    return False


def _belongs_to_family_vendor(model_id: str, vendor: str | None, family: dict[str, Any]) -> bool:
    lowered = model_id.lower()
    segments = [seg for seg in lowered.split("/") if seg]
    providers = {
        str(p).strip().lower() for p in (family.get("native_providers") or []) if isinstance(p, str) and p.strip()
    }
    vendor_val = family.get("vendor")
    if isinstance(vendor_val, str) and vendor_val.strip():
        providers.add(vendor_val.strip().lower())
    if isinstance(vendor, str) and vendor.strip().lower() in providers:
        return True
    if any(seg.lstrip("~") in providers for seg in segments[:-1]):
        return True
    leaf_tokens = set(re.split(r"[-_.:~]", segments[-1])) if segments else set()
    keywords = {
        str(k).strip().lower() for k in (family.get("native_keywords") or []) if isinstance(k, str) and k.strip()
    }
    return bool(keywords & leaf_tokens)


def audit(
    families: dict[str, dict[str, Any]],
    catalogs: dict[str, Any],
    schema: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Detect drift between configured families.json selectors and available engine catalogs."""
    loaded_schema = schema if isinstance(schema, dict) else load_schema()
    unresolved_tiers: list[dict[str, Any]] = []
    unmapped_models: list[dict[str, Any]] = []
    cross_harness_models: list[dict[str, Any]] = []
    unavailable_engines: list[str] = []
    untracked_aggregator_count = 0

    parsed_catalogs: dict[str, tuple[str, list[dict[str, Any]]]] = {}
    for engine, entry in catalogs.items():
        parsed_catalogs[engine] = _extract_catalog_records(entry)

    # Check unresolved tiers for every family whose engine has an available live catalog.
    for family_name, family in families.items():
        if not isinstance(family, dict):
            continue
        engine = family.get("engine")
        if not isinstance(engine, str) or not engine:
            continue
        status, records = parsed_catalogs.get(engine, ("unavailable", []))
        available_ids = [rec["id"] for rec in records if isinstance(rec.get("id"), str)]
        if status != "live" or not available_ids:
            if engine not in unavailable_engines:
                unavailable_engines.append(engine)
            continue
        available_lower = {mid.lower() for mid in available_ids}
        prefix = family.get("prefix")
        for tier_name, target in (family.get("tiers") or {}).items():
            if isinstance(prefix, str) and prefix:
                try:
                    resolved = resolve(family_name, tier_name, families, available_ids)
                except SelectorError:
                    resolved = None
                is_resolved = bool(resolved)
            else:
                is_resolved = isinstance(target, str) and target.strip().lower() in available_lower
            if not is_resolved:
                unresolved_tiers.append(
                    {
                        "selector": f"{family_name}:{tier_name}",
                        "family": family_name,
                        "tier": tier_name,
                        "engine": engine,
                        "target": target,
                    }
                )

    # Check unmapped live catalog IDs across engines.
    families_by_engine: dict[str, list[tuple[str, dict[str, Any]]]] = {}
    for family_name, family in families.items():
        if isinstance(family, dict) and isinstance(family.get("engine"), str):
            families_by_engine.setdefault(family["engine"], []).append((family_name, family))

    for engine, (status, records) in parsed_catalogs.items():
        if status != "live" or not records:
            continue
        engine_families = families_by_engine.get(engine, [])
        seen_ids: set[str] = set()
        for record in records:
            model_id = record["id"]
            lowered_id = model_id.lower()
            if lowered_id in seen_ids:
                continue
            seen_ids.add(lowered_id)
            if any(_is_model_mapped_by_family(model_id, fam) for _, fam in engine_families):
                continue
            native = native_engine_for_model(model_id, families, loaded_schema)
            if native and native != engine:
                cross_harness_models.append({"engine": engine, "id": model_id, "native_engine": native})
                continue
            vendor = record.get("vendor") if isinstance(record.get("vendor"), str) else None
            belongs_to_configured = any(_belongs_to_family_vendor(model_id, vendor, fam) for _, fam in engine_families)
            if engine == "opencode" and lowered_id.startswith("openrouter/") and not belongs_to_configured:
                untracked_aggregator_count += 1
                continue
            unmapped_models.append(
                {
                    "engine": engine,
                    "id": model_id,
                    "vendor": vendor,
                    "reason": "unmapped_family_variant" if belongs_to_configured else "unmapped_model",
                }
            )

    return {
        "unresolved_tiers": unresolved_tiers,
        "unmapped_models": unmapped_models,
        "cross_harness_models": cross_harness_models,
        "unavailable_engines": unavailable_engines,
        "untracked_aggregator_count": untracked_aggregator_count,
        "has_drift": bool(unresolved_tiers or unmapped_models),
    }
