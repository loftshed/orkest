import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  diffCatalogAgainstSeen,
  loadBenchmarkPriors,
  radarCli,
} from "../../../plugins/orchestrate/lib/radar.mjs";
import {
  WORKFORCE_ROLES,
  workforceRoleInfo,
} from "../../../plugins/orchestrate/lib/stooges-room.mjs";
import { updateModelRadar } from "../../../scripts/update-model-radar.mjs";

describe("ork radar and benchmark priors", () => {
  it("loads structured benchmark priors for all supported model families", () => {
    const priors = loadBenchmarkPriors();
    expect(priors.schema).toBe("orkest.benchmarks.prior.v1");
    const expectedModels = [
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-haiku-4-5",
      "gpt-6-astra",
      "gpt-6-sol",
      "gpt-6-luna",
      "gemini-4-argon-high",
      "gemini-4-argon-medium",
      "gemini-3.8-flash-high",
      "openrouter/z-ai/glm-5.3-flash",
      "openrouter/deepseek/deepseek-v4-flash",
    ];
    for (const modelId of expectedModels) {
      expect(priors.models[modelId]).toBeDefined();
      expect(typeof priors.models[modelId].swe_bench_verified).toBe("number");
      expect(typeof priors.models[modelId].livecodebench).toBe("number");
      expect(typeof priors.models[modelId].aider_polyglot).toBe("number");
      expect(typeof priors.models[modelId].composite_prior).toBe("number");
      expect(Array.isArray(priors.models[modelId].strengths)).toBe(true);
      expect(typeof priors.models[modelId].updated_at).toBe("string");
    }
  });

  it("identifies new and deprecated models and merges silent-nerf telemetry health", () => {
    const priors = loadBenchmarkPriors();
    const liveCatalog = ["claude-opus-5-5", "gpt-6-sol", "claude-opus-6-0-preview"];
    const seenCatalog = ["claude-opus-5-5", "gpt-6-sol", "gpt-5.5-legacy"];
    const telemetry = {
      groups: [
        {
          accepted_rate: 0.85,
          degradation_drop: 0.45,
          degraded: true,
          engine: "codex",
          model: "gpt-6-sol",
          rolling_14d_runs: 6,
          rolling_14d_success_rate: 0.4,
          task_archetype: "debug-invariants",
        },
      ],
    };

    const diff = diffCatalogAgainstSeen(liveCatalog, seenCatalog, priors, { telemetry });
    expect(diff.newModels).toEqual(["claude-opus-6-0-preview"]);
    expect(diff.deprecatedModels).toEqual(["gpt-5.5-legacy"]);
    const sol = diff.models.find((item) => item.id === "gpt-6-sol");
    expect(sol.health).toBe("degraded");
    expect(sol.degradation_drop).toBe(0.45);
    expect(diff.alerts).toHaveLength(1);
    expect(diff.alerts[0]).toMatchObject({
      archetype: "debug-invariants",
      model: "gpt-6-sol",
      status: "DEGRADED",
    });
  });

  it("supports radarCli status, diff, and priors in text and JSON modes", async () => {
    const telemetry = {
      groups: [
        {
          accepted_rate: 0.9,
          degradation_drop: 0.3,
          degraded: true,
          engine: "claude",
          model: "claude-opus-5-5",
          rolling_14d_runs: 5,
          rolling_14d_success_rate: 0.6,
          task_archetype: "structural-refactor",
        },
      ],
    };
    const statusRes = await radarCli(["status", "--json"], {
      liveCatalog: ["claude-opus-5-5", "gpt-6-sol", "gemini-4.5-ultra"],
      seenCatalog: ["claude-opus-5-5", "gpt-6-sol"],
      telemetry,
    });
    expect(statusRes.exitCode).toBe(0);
    const parsed = JSON.parse(statusRes.stdout);
    expect(parsed.diff.newModels).toEqual(["gemini-4.5-ultra"]);
    expect(parsed.diff.alerts[0].model).toBe("claude-opus-5-5");

    const textRes = await radarCli(["diff"], {
      liveCatalog: ["claude-opus-5-5"],
      seenCatalog: ["claude-opus-5-5", "gpt-5.5-retired"],
      telemetry,
    });
    expect(textRes.stdout).toContain("Deprecated models: gpt-5.5-retired");
    expect(textRes.stdout).toContain("[DEGRADED] claude-opus-5-5 on structural-refactor");

    const priorsRes = await radarCli(["priors"], { telemetry: { groups: [] } });
    expect(priorsRes.stdout).toContain("Archetype Priors:");
    expect(priorsRes.stdout).toContain("web-research:");
  });

  it("defines researcher as a first-class web-research workforce role distinct from scout", () => {
    expect(WORKFORCE_ROLES.scout.aliases).not.toContain("researcher");
    expect(workforceRoleInfo("researcher")).toMatchObject({
      aliases: ["web-researcher", "analyst"],
      archetype: "web-research",
      id: "researcher",
    });
    expect(workforceRoleInfo("web-researcher")?.id).toBe("researcher");
  });

  it("runs update-model-radar.mjs offline against a static fixture without LLM tokens", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "radar-sync-"));
    const fixturePath = path.join(tmpDir, "openrouter-models.json");
    fs.writeFileSync(
      fixturePath,
      JSON.stringify({
        data: [
          { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
          { id: "anthropic/claude-opus-6-0", name: "Claude Opus 6.0" },
          { id: "openai/gpt-6.5-nova", name: "GPT 6.5 Nova" },
          { id: "other-vendor/ignored-model", name: "Ignored" },
        ],
      }),
      "utf8",
    );

    const syncResult = await updateModelRadar(["--dry-run", "--fixture", fixturePath, "--json"], {
      silent: true,
    });
    expect(syncResult.dry_run).toBe(true);
    expect(syncResult.new_models).toEqual(["anthropic/claude-opus-6-0", "openai/gpt-6.5-nova"]);
  });
});
