import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  extractTaskSpec,
  readFoundryState,
  resolveTaskSpecPath,
  resolveWorktreeGitDir,
  writeFoundryState,
} from "../../../plugins/orchestrate/lib/foundry.mjs";
import {
  buildColdReviewQuestion,
  parseColdReviewFindings,
  smeltWorktree,
} from "../../../plugins/orchestrate/lib/smelter.mjs";

// Retained real repositories, with non-disposable markers: no cleanup or pruning.
function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function fixture(taskSpec = {}, { high = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "ork-verification-retained-"));
  const repo = path.join(root, "repo");
  const wt = path.join(root, "candidate");
  mkdirSync(repo);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Verification Test");
  git(repo, "config", "user.email", "verification@example.invalid");
  writeFileSync(path.join(repo, "base.txt"), "base\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "base");
  git(repo, "worktree", "add", "-b", "builder", wt);
  const file = high ? ".github/workflows/check.yml" : "change.txt";
  mkdirSync(path.dirname(path.join(wt, file)), { recursive: true });
  writeFileSync(path.join(wt, file), "candidate\n");
  git(wt, "add", ".");
  git(wt, "commit", "-m", "candidate");
  const specPath = resolveTaskSpecPath(wt);
  mkdirSync(path.dirname(specPath), { recursive: true });
  writeFileSync(specPath, JSON.stringify({ allow_paths: [file], ...taskSpec }));
  writeFileSync(
    path.join(resolveWorktreeGitDir(wt), "orkest.json"),
    JSON.stringify({ disposable: false, slug: "candidate", branch: "builder" }),
  );
  writeFoundryState(wt, { status: "verified", attemptCount: 2, maxAttempts: 2 });
  return { root, wt, repo, env: { ...process.env, ORCHESTRATE_HOME: path.join(root, "cache") } };
}
function smelt(f, options = {}) {
  return smeltWorktree(f.wt, {
    env: f.env,
    gateRunner: async () => "ok",
    reviewRunner: async () => "FINDINGS:\nnone",
    ...options,
  });
}

describe("verification claims follow evidence", () => {
  it("describes lint-only, acceptance and missing checks without inventing verification", () => {
    const base = { candidate: { commit: "candidate-sha" }, target: { sha: "target-sha" } };
    const lint = buildColdReviewQuestion({
      ...base,
      checks: [
        { kind: "default-lint", command: "./scripts/check.sh", result: "passed", exitCode: 0 },
      ],
    });
    expect(lint).toContain("Candidate commit: candidate-sha");
    expect(lint).toContain("Target SHA: target-sha");
    expect(lint).toContain('"./scripts/check.sh": passed (exit 0)');
    expect(lint).toContain("No acceptance checks were defined.");
    expect(lint).toContain("Only the lint default ran; tests were not run.");
    expect(lint).not.toContain("have already passed");
    const acceptance = buildColdReviewQuestion({
      ...base,
      checks: [
        { kind: "acceptance", command: "node test-a.mjs", result: "passed", exitCode: 0 },
        { kind: "acceptance", command: "node test-b.mjs", result: "failed", exitCode: 2 },
      ],
    });
    expect(acceptance).toContain('[acceptance] "node test-a.mjs": passed (exit 0)');
    expect(acceptance).toContain('[acceptance] "node test-b.mjs": failed (exit 2)');
    expect(acceptance).not.toContain("No acceptance checks were defined");
    expect(buildColdReviewQuestion({ ...base, checks: [] })).toContain("No checks were run.");
  });

  it("runs each acceptance command separately and sends precisely its evidence to review", async () => {
    const f = fixture({
      acceptance_checks: ["node test-a.mjs", "node test-b.mjs"],
      verify_command: "unused",
      development_checks: ["also unused"],
    });
    const commands = [];
    let question;
    const result = await smelt(f, {
      gateRunner: ({ verifyCommand }) => {
        commands.push(verifyCommand);
        return "ok";
      },
      reviewRunner: ({ args }) => {
        question = args.at(-1);
        return "FINDINGS:\nnone";
      },
    });
    expect(result).toMatchObject({
      status: "merged",
      evidence: {
        checks: [
          { kind: "acceptance", command: "node test-a.mjs", result: "passed", exitCode: 0 },
          { kind: "acceptance", command: "node test-b.mjs", result: "passed", exitCode: 0 },
        ],
      },
    });
    expect(commands).toEqual(["node test-a.mjs", "node test-b.mjs"]);
    expect(question).toBe(buildColdReviewQuestion(result.evidence));
    expect(question).toContain(`Candidate commit: ${result.candidate.commit}`);
    expect(readFoundryState(f.wt).evidence).toEqual(result.evidence);
  });

  it("falls back to development verify_command, then lint, never development_checks", async () => {
    for (const [spec, kind, command] of [
      [{ verify_command: "node test.mjs" }, "development", "node test.mjs"],
      [{ development_checks: ["unused"] }, "default-lint", "./scripts/check.sh"],
    ]) {
      const f = fixture(spec);
      const result = await smelt(f);
      expect(result).toMatchObject({
        status: "merged",
        acceptanceChecksDefined: false,
        verificationSummary: "No acceptance checks were defined",
        evidence: { checks: [{ kind, command, result: "passed" }] },
      });
    }
  });

  it.each([false, true])(
    "reports skipped and dry-run review as not_reviewed (dry=%s)",
    async (dryRun) => {
      const f = fixture();
      const result = await smelt(f, { skipReview: !dryRun, dryRun });
      expect(result).toMatchObject({
        ok: true,
        reviewStatus: "not_reviewed",
        evidence: { review: { result: "not_reviewed", outputSha256: null } },
        stages: { coldReview: { status: "not_reviewed", findings: null } },
      });
      if (dryRun) return;
      {
        expect(result.evidence.waivers).toEqual([
          {
            policy: "skip-review",
            candidateCommit: result.candidate.commit,
            suppliedBy: "cli --skip-review",
            at: expect.any(String),
          },
        ]);
        expect(readFoundryState(f.wt).evidence.review.result).toBe("not_reviewed");
      }
    },
  );

  it.each([
    [null, "infrastructure_failure"],
    ["", "infrastructure_failure"],
    ["No section", "infrastructure_failure"],
    ["{broken", "infrastructure_failure"],
    [{ sections: { FINDINGS: [] } }, "infrastructure_failure"],
    [
      {
        status: "failed",
        task_outcome: "failed",
        exit_code: 1,
        error: "executor unavailable",
        sections: null,
        answer: null,
        uncertainty: null,
        answer_format: null,
        session_id: null,
      },
      "infrastructure_failure",
    ],
    [{ error: "runner failed", sections: { FINDINGS: "none" } }, "infrastructure_failure"],
    ["FINDINGS:\nnone", "passed"],
    ["FINDINGS:\n- Data loss in merge", "findings"],
  ])("parses review output %j into %s", (output, result) => {
    expect(parseColdReviewFindings(output)).toMatchObject({ result, passed: result === "passed" });
  });

  it.each([
    null,
    "No section",
    { status: "failed", error: "review runner failed", sections: null },
  ])("records review infrastructure failure without spending repairs: %j", async (output) => {
    const f = fixture();
    const result = await smelt(f, { reviewRunner: () => output });
    expect(result).toMatchObject({
      status: "review_infrastructure_failure",
      retryable: true,
      evidence: { review: { result: "infrastructure_failure" } },
    });
    expect(readFoundryState(f.wt)).toMatchObject({
      status: "review_infrastructure_failure",
      attemptCount: 2,
      infrastructureRetry: { count: 1 },
    });
    expect(git(f.repo, "rev-parse", "HEAD")).not.toBe(result.candidate.commit);
  });

  it("catches a thrown reviewer and distinguishes concrete findings", async () => {
    const f = fixture();
    const failed = await smelt(f, {
      reviewRunner: () => {
        throw new Error("runner unavailable");
      },
    });
    expect(failed.status).toBe("review_infrastructure_failure");
    const findings = await smelt(f, { reviewRunner: () => "FINDINGS:\n- Race in merge" });
    expect(findings).toMatchObject({
      status: "review_changes_requested",
      evidence: { review: { result: "findings" } },
    });
    expect(readFoundryState(f.wt)).toMatchObject({
      attemptCount: 2,
      findings: "- Race in merge",
      infrastructureRetry: null,
    });
  });

  it("reports a real missing ork binary as infrastructure, keeping the candidate and repair allowance", async () => {
    const f = fixture();
    const bin = path.join(f.root, "bin");
    mkdirSync(bin);
    for (const command of ["git", "python3", "ps", "sh"]) {
      const executable = execFileSync("sh", ["-c", `command -v ${command}`], {
        encoding: "utf8",
      }).trim();
      symlinkSync(executable, path.join(bin, command));
    }
    const result = await smelt(f, { gateRunner: null, env: { ...f.env, PATH: bin } });
    expect(result).toMatchObject({
      status: "gate_infrastructure_failure",
      retryable: true,
      evidence: {
        checks: [{ kind: "default-lint", result: "infrastructure_failure", exitCode: null }],
      },
    });
    expect(readFoundryState(f.wt)).toMatchObject({
      status: "gate_infrastructure_failure",
      attemptCount: 2,
    });
    expect(git(f.wt, "rev-parse", "HEAD")).toBe(result.candidate.commit);
  });

  it.each(["failed", "launch_error", "missing"])(
    "uses default gate receipt %s rather than assuming exit 2 means code failure",
    async (outcome) => {
      const f = fixture();
      const directory = path.join(f.root, "gate");
      mkdirSync(directory);
      const result = await smelt(f, {
        gateRunner: null,
        env: { ...f.env, AGENT_GATE_DIR: directory },
        execFileSyncFn: (command, args, options) => {
          if (command !== "ork") return execFileSync(command, args, options);
          const label = args[args.indexOf("--label") + 1];
          // Exercise execFileSync's real nonzero-exit shape. The fixture stands in
          // for the gate only; its real Python launch-error path deletes logs.
          const source = String.raw`import {writeFileSync} from 'node:fs';
          if(process.argv[1] !== 'missing') writeFileSync(process.argv[2], JSON.stringify({
            label:process.argv[3], cwd:process.cwd(), outcome:process.argv[1], exitCode:2
          })+'\n'); process.exit(2);`;
          return execFileSync(
            process.execPath,
            [
              "--input-type=module",
              "-e",
              source,
              outcome,
              path.join(directory, "runs.jsonl"),
              label,
            ],
            options,
          );
        },
      });
      expect(result).toMatchObject({
        status: outcome === "failed" ? "gate_failed" : "gate_infrastructure_failure",
        evidence: {
          checks: [
            {
              result: outcome === "failed" ? "failed" : "infrastructure_failure",
              exitCode: outcome === "failed" ? 2 : null,
            },
          ],
        },
      });
      expect(readFoundryState(f.wt).attemptCount).toBe(2);
    },
  );

  it("leaves later acceptance checks not_run when an earlier one fails", async () => {
    const f = fixture({ acceptance_checks: ["node test-a.mjs", "node test-b.mjs"] });
    const result = await smelt(f, {
      gateRunner: () => {
        throw Object.assign(new Error("failed assertions"), { status: 2 });
      },
    });
    expect(result).toMatchObject({
      status: "gate_failed",
      evidence: {
        checks: [
          { result: "failed", exitCode: 2 },
          { result: "not_run", exitCode: null, startedAt: null },
        ],
      },
    });
    expect(readFoundryState(f.wt).attemptCount).toBe(2);
  });

  it.each(["candidate", "policy"])(
    "ignores a mismatched approval and waiver (%s)",
    async (mismatch) => {
      const f = fixture({}, { high: true });
      const commit = git(f.wt, "rev-parse", "HEAD");
      const result = await smelt(f, {
        approveHighBlast: {
          candidateCommit: mismatch === "candidate" ? "other-commit" : commit,
          policy: mismatch === "policy" ? "skip-review" : "high-blast",
          approvedBy: "tester",
        },
        skipReview: true,
        skipReviewWaiver: {
          candidateCommit: mismatch === "candidate" ? "other-commit" : commit,
          policy: mismatch === "policy" ? "high-blast" : "skip-review",
          suppliedBy: "tester",
        },
      });
      expect(result).toMatchObject({
        status: "awaiting_human_approval",
        evidence: { approval: null, waivers: [], review: { result: "passed" } },
      });
      expect(result.evidence.rejectedAuthorizations).toEqual([
        {
          policy: "high-blast",
          candidateCommit: mismatch === "candidate" ? "other-commit" : commit,
          reason: "Approval ignored: candidate or policy does not match",
        },
        {
          policy: "skip-review",
          candidateCommit: mismatch === "candidate" ? "other-commit" : commit,
          reason: "Waiver ignored: candidate, policy or supplier does not match",
        },
      ]);
      expect(readFileSync(resolveTaskSpecPath(f.wt), "utf8")).toContain("allow_paths");
    },
  );

  it("validates optional executable acceptance checks separately from prose criteria", () => {
    const spec = {
      schema: "agent-executor.task-spec.v1",
      objective: "Check candidate",
      allow_paths: ["src"],
      acceptance_checks: ["node test.mjs"],
    };
    const extract = (value) => extractTaskSpec("```json\n" + JSON.stringify(value) + "\n```");
    expect(extract(spec)).toEqual(spec);
    expect(extract({ ...spec, acceptance_checks: "node test.mjs" })).toBeNull();
    expect(
      extract({ ...spec, acceptance_checks: [42], acceptance_criteria: ["Works"] }),
    ).toBeNull();
  });
});
