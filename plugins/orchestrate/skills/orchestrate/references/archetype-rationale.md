# Why these task archetypes exist

## Decision rationale

Route work by the kind of judgment it requires and the evidence available to check it. A task with a
precise transformation and cheap checks can be delegated differently from a task whose requirements,
architecture, or acceptance criteria still need interpretation. The conductor owns that distinction
and the final conclusions; a worker's fluent explanation does not establish its correctness.

The seven archetypes separate recurring sources of difficulty. They are practical planning
categories, not an exhaustive taxonomy, mutually exclusive labels, or measured model rankings. For a
mixed task, identify the decision that dominates the risk, then delegate bounded parts with their
own checks.

| Archetype                | Why it needs a distinct treatment                                                                                                                | Evidence needed before accepting the work                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `debug-invariants`       | The failure is visible but its cause is uncertain. Guessing a plausible patch can conceal the underlying defect.                                 | A reproduced failure, a causal explanation, and checks that exercise the relevant invariant and nearby cases.                                    |
| `structural-refactor`    | Many edits must preserve the same behavior across module boundaries. Local correctness can hide broken interactions.                             | Explicit behavior to preserve, dependency analysis, and checks across affected boundaries.                                                       |
| `ui-design-system`       | Correctness includes visual hierarchy, interaction, accessibility, and consistency. Passing code checks covers only part of the task.            | Concrete design constraints, rendered and interaction evidence, and review against shared component rules.                                       |
| `architecture-conductor` | The main work is choosing responsibilities, resolving ambiguity, and sequencing dependent tasks. Those choices determine what workers build.     | Stated assumptions, evaluated tradeoffs, a coherent plan, and a way to verify each delegated result.                                             |
| `mechanical-sweep`       | The transformation is already decided and repeated across locations. Interpretation should be limited enough that mistakes are easy to detect.   | Examples of the transformation, exact scope, and automated or otherwise inexpensive checks. Escalate exceptions instead of inventing new policy. |
| `independent-review`     | The task is to challenge a result against requirements, rather than continue the author's argument. Independence is about evidence and judgment. | Reproduced defects, checked assumptions, and specific acceptance gaps. A different vendor alone does not make a review independent.              |
| `web-research`           | External docs, pricing, and vendor specifications drift over time and require primary-source verification rather than cached memory.             | Direct citations to retrieved primary sources, version/date bounds, and explicit gaps where facts remain unpublished.                            |

This is the rationale used for the current guidance, not a reconstruction of undocumented author
intent. Commit [3f160c4](https://github.com/loftshed/orkest/commit/3f160c4608d04551a8592c6d9655ffeb0e61df98)
introduced the route defaults, strength hints, and telemetry without a recorded benchmark comparison.
The [design checkpoint](design-completion.md) also leaves calibration pending.

## Choosing workers without outsourcing judgment

Use [routes.default.json](../../../../../references/routes.default.json) as a starting candidate list, subject to explicit user
choices, observed access, and billing authorization. Its exact model order has not been validated by
a local comparison. Do not infer that a named model leads an archetype because a benchmark proved it.

The working hypothesis is to spend more reasoning capacity where uncertainty or an undetected error
is costly, and use faster workers where a clear brief and strong checks bound the risk. A small file
can still require architectural judgment; a large edit can still be mechanical. Scope size alone
is not a routing rule.

For example, a worker can collect benchmark sources, trace code, and identify missing evidence. The
conductor should interpret that evidence and own a routing rationale. Delegating the writing does
not transfer responsibility for its conclusions. The same principle applies to architecture and
ambiguous design decisions.

The `tier_strengths` strings in [families.json](../../../../../references/families.json) are qualitative hints displayed by the
route viewer. They are not measured scores and do not participate in selector resolution or telemetry
ranking. Keep the current descriptions separate from verified capabilities of a pinned model version.
[profiles.json](../../../../../references/profiles.json) explicitly labels its guidance as workload hypotheses.

## What the local evidence can establish

[telemetry.py](../../../../../src/py/telemetry.py) groups recorded results by task archetype, engine, resolved
model, and effort. It reports accepted outcomes, first-pass outcomes, duration, and the lower endpoint
of a 95% Wilson interval for the accepted proportion.

The current reorder heuristic considers candidate slots with `available` quota status,
at least three matching runs, and a Wilson lower-bound difference strictly greater than 0.05.
Candidates without that evidence retain their slots. These thresholds avoid reacting to every result;
they are not a statistical test that one model is superior. Three runs are little evidence, different
task difficulty can distort comparisons, and accepted outcomes depend on the quality of verification.

Matching can also use a recorded requested selector, so evidence for an alias may include more than
one resolved model version. Candidates without an explicit effort can aggregate matching effort
groups. Inspect those versions and settings before treating a displayed score as evidence about a
specific model. The current code does not correct for task selection bias or changing evaluators.

To validate a route change, compare candidates on the same fixed tasks and starting revisions, with
the same acceptance criteria and recorded model/effort/tool configuration. Include held-out tasks and
repeated runs. Report failures, recovery, elapsed time, and verification effort as well as successes.
Cost per independently accepted task and overlap in failures between vendors are useful proposed
criteria; the current reorder heuristic does not measure or optimize either. The
[calibration tooling](../scripts/calibration.py) has separate API-reference cost estimates, which are
not subscription invoices.

## Quota is a separate constraint

[conductor_policy.py](../../../../../src/py/conductor_policy.py) requires observed access, rejects observations
older than 24 hours, and excludes unauthorized personal subscription access. The launch-time
[quota check](../../../../../src/py/quota.py) checks pool availability again. Available quota does not prove that
a model fits a task, and a favorable score does not authorize a billing switch.

Monitor's `surplusPts` compares remaining weekly capacity with an even-use schedule. An `expiring`
window is at least a day long, in its final 20%, and has at least 5% remaining. These signals help use
capacity before rollover. The generic profile recommender leaves out pools on credits (they bill the
user's balance), orders low-quota pools last, then prefers expiring pools, native routes, and greater
surplus in that priority order. Archetype routing instead starts with its configured candidate order and uses the telemetry
gate above; it does not apply that generic quota sort. See
[Monitor's ranking rules](../../../../monitor/README.md#ranking).

## 2026-11-14 audit findings

### Measured benchmark and pricing facts

- **Retired legacy priors:** Direct audits of `swebench.com`, LiveCodeBench's generation JSON, and
  Aider Polyglot (`2025-10-03`) confirmed zero 2026-H2 models (`gpt-6*`, `claude-5.5`/`5.2`,
  `gemini-4-*`, `glm-5.3*`, `deepseek-v4.1*`, `kimi-k3*`) appear on those leaderboards. [benchmarks.prior.json](../../../../../references/benchmarks.prior.json)
  now tracks `terminal_bench_4_1`, `deepswe_v1_1`, `osworld_2_1`, and `frontier_swe_2`, leaving
  unpublished metrics strictly `null` (_unknown is never zero_).
- **Published cross-vendor signal:** On Terminal-Bench 4.1 (`tbench.ai`, `n = 330`), `claude-fable-5-2`
  and `claude-opus-5-5` tie at `0.6576`, followed by `gemini-4-carbon-high` (`0.6455`, plus `0.962`
  GraphWalks 1M BFS), `claude-sonnet-5-5` (`0.6394`), `gpt-6.1-sol` (`0.6091`; `0.7522` DeepSWE v1.1),
  `gpt-6-astra` (`0.6030`), `kimi-k3.1-pro` (`0.5970`, `#8` overall and highest open-weight),
  `gemini-4-hydrogen-high` (`0.5636`), `gemini-4-argon-high` (`0.5545`; `#1` DeepSWE v1.1 at `0.779`),
  and `gpt-6.1-terra` (`0.5333` vs `gpt-6-luna` `0.1515`). `claude-haiku-5-5` reaches `0.4000` TB4.1
  and `0.724` OSWorld-2.1 (up from `0.157` on Haiku 4.5).
- **Verified tariffs and expiries:** [model-registry.json](../../../../../references/model-registry.json) reflects `2026-11-14`
  standard API tariffs: `claude-opus-5-5` (`$4/$20`, `$0.20` cache read), `claude-sonnet-5-5` (`$2/$10`,
  `$0.10` cache read), `claude-fable-5-2` (`$8/$40`), `claude-haiku-5-5` (`$0.10/$0.50 <= 100K`, `5x`
  over `100K`), `gpt-6.1-terra` (`$1/$5`), `gemini-4-hydrogen` (`$1.50/$7.50`), and `gemini-4-carbon` /
  `gemini-4-argon` (`$2/$10` intro pricing with `revalidate_on: "2026-12-01"`, when rates double to `$4/$20`).

### Local telemetry measurements

- Across `17` receipts in the local `runs-v1` cache (`0` skipped), only `n = 4` were executed tasks
  (all `codex`): `gpt-6.1-sol` (`1/1` complete on `debug-invariants` at `high`; `0/1` `blocked` on
  `unspecified` at `xhigh`) and `gpt-6-luna` (`1/2` complete, `1/2` timed out on `implementation` at `max`).
- `11` `claude`/`sonnet` records had `status: "native_handoff"` and `task_outcome: "not_run"`, which
  previously counted as `0/11` quality failures until `NON_QUALITY_OUTCOMES` was updated in [telemetry.py](../../../../../src/py/telemetry.py).
- Zero executed receipts exist for `agy`, `opencode`, non-dry `claude`, `gpt-6-astra`, or `gpt-6.1-terra`.
  Consequently, **no route clears `rank_candidates_by_telemetry`** (`min_runs = 3`, `min_wilson_delta > 0.05`).

### Two-phase `gemini-pro-orchestrator*` vs leaf workers

Antigravity exposes `gemini-pro-orchestrator` and `gemini-pro-orchestrator-argon`, which switch
internally across models (such as Carbon and Hydrogen) during a session. Google's release post
reports near-Carbon Terminal-Bench 4.0 results with qualitative efficiency gains (`24%` less quota,
`19%` faster), but neither variant has a published TB4.1 score, standalone API tariff, or effort slug.
Keep orchestrator slugs in [profiles.json](../../../../../references/profiles.json) (`conductor`, `effort_candidate: "not_applicable"`)
separate from single-model leaf workers (`gemini:carbon*`, `gemini:argon*`, `gemini:hydrogen*`, `gpt:sol`)
when bounded execution, effort control, and API tariff accounting are required.

### Routing hypotheses (pending paired calibration)

Because local `n = 4` telemetry cannot justify empirical reorders, all updates to the seven archetype
routes in [routes.default.json](../../../../../references/routes.default.json) are **grounded benchmark and pricing hypotheses**:

- `debug-invariants`: keeps `gpt:sol` (`high`) primary and promotes `claude:best` (`claude-opus-5-5`,
  tied `#1` TB4.1 at roughly half `claude-fable-5-2` cost) alongside `claude:frontier`.
- `structural-refactor`: evaluates `claude:best` (`claude-opus-5-5`) primary with `gpt:sol` and
  `claude:balanced` (`claude-sonnet-5-5`) alternates; `claude:frontier` (`claude-fable-5-2`) remains
  the highest-FrontierSWE-v2 (`0.699`) escalation option.
- `ui-design-system`: keeps `gpt:astra` (`high`) primary and adds `agy / gemini:carbon-high` (`0.815`
  OSWorld-2.1, WebDev Arena `#4`) and `claude:best` (`claude-opus-5-5`) as alternates.
- `architecture-conductor` & `web-research`: keep `gemini:pro` (now `gemini-4-carbon-high`, `0.962`
  GraphWalks 1M) primary with `claude:best` / `claude:balanced` and `gpt:sol` alternates.
- `mechanical-sweep`: keeps `claude:fast` (`claude-haiku-5-5`, `0.400` TB4.1 at `$0.10/$0.50 <= 100K`)
  primary, replacing legacy `gemini:flash-high` (`0.1818` TB4.1) and `gpt:luna` (`0.1515` TB4.1) with
  `gemini:hydrogen-high` (`0.5636` TB4.1) and `gpt:terra` (`0.5333` TB4.1).
- `independent-review`: keeps `gpt:sol` (`high`) primary and updates alternates to `claude:best` and
  `gemini:carbon-high`.
- Open base-route hypotheses (deferred from `routes.default.json` defaults to preserve compatibility):
  evaluating `gpt:terra` vs `gpt:luna` for `implementation`, and `deepseek:flash` (`v4.1-flash-1017`,
  `0.770` DeepSWE v1.1) vs `glm:flash` for `opencode`.

## What the benchmarks contribute

These sources suggest evaluation tasks. They do not establish the current candidate order or prove
that these seven labels are the right taxonomy. Source descriptions were audited on `2026-11-14`.

| Source                                                                                                    | Useful evidence for a future evaluation                                                  | What it does not establish here                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Terminal-Bench 4.1](https://www.tbench.ai/) (`n = 330`)                                                  | Cross-vendor CLI and terminal task completion under standardized agent harnesses.        | Behavior-preserving multi-module refactors, architectural tradeoffs, or local subscription quota fit.                                                                                            |
| DeepSWE v1.1 (vendor model cards)                                                                         | Repository-level issue resolution across active 2026-H2 models.                          | Cross-harness comparability when evaluation scaffolds differ across vendors.                                                                                                                     |
| OSWorld-2.1 (offline subset)                                                                              | UI, browser, and computer-use execution across Anthropic, Google, and OpenAI cards.      | Design-system consistency, accessibility, or aesthetics beyond functional task completion.                                                                                                       |
| FrontierSWE v2                                                                                            | Difficult software engineering tasks where flagship models separate (`0.55–0.70` range). | Complete cross-vendor coverage (several open-weight and mid-tier models are unpublished).                                                                                                        |
| GraphWalks 256k–1M BFS & [MRCR](https://huggingface.co/datasets/openai/mrcr)                              | Long-context graph traversal, aggregation, and retrieval across `256K–1M` tokens.        | Architecture judgment or effective multi-worker coordination merely because context fits.                                                                                                        |
| Legacy baselines ([SWE-bench](https://www.swebench.com/), [Aider](https://aider.chat/docs/leaderboards/)) | Historical context for earlier 2025/2026-H1 model generations only.                      | Current model selection; `SWE-bench Verified`, LiveCodeBench JSON, and Aider Polyglot lack 2026-H2 entries (`null` in [benchmarks.prior.json](../../../../../references/benchmarks.prior.json)). |

Different vendors may provide useful alternative approaches, but failure independence must be
measured with paired tasks. Treat cross-vendor review as a hypothesis to test, not an automatic
quality multiplier. None of the cited sources supplies a local calibration result for Orkest's current
model selectors.

## Repeatable refresh procedure

Run these checks together before refreshing priors, tariffs, or route hypotheses:

1. **Detect catalog drift:** Run `ork radar diff` (or `node scripts/update-model-radar.mjs --dry-run`)
   and `python3 src/py/run_agent.py models --format json` to
   compare live `codex`, `agy`, `claude`, and `opencode` catalogs against tracked priors.
2. **Inspect local telemetry:** Run `python3 src/py/telemetry.py summarize`
   (or `ork telemetry --json`) to review executed quality counts, `wilson_lb_95`, and 14-day `degraded`
   alerts while confirming non-executed statuses stay excluded.
3. **Audit official sources:** Re-verify vendor pricing pages (`platform.claude.com`, `developers.openai.com`,
   `ai.google.dev`, `openrouter.ai/api/v1/models`) and primary benchmark leaderboards/model cards
   (`tbench.ai` and vendor cards) before updating `verified_at` or `updated_at`. Honor `revalidate_on`
   dates on promo tariffs and keep unpublished benchmark metrics strictly `null`.
