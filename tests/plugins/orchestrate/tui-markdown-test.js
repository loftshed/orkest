import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";

import {
  extractAgentFocusMarkdown,
  HordeView,
} from "../../../plugins/orchestrate/lib/horde-view.mjs";
import { displayWidth } from "../../../plugins/orchestrate/lib/tui-box.mjs";
import {
  parseInlineSpans,
  renderLogLine,
  renderMarkdown,
  stripInlineMarkdown,
} from "../../../plugins/orchestrate/lib/tui-markdown.mjs";
import { DEFAULT_THEME, resolveTheme } from "../../../plugins/orchestrate/lib/tui-theme.mjs";

const ESC = "\u{1B}[";

describe("tui-markdown inline parsing", () => {
  it("parses code, bold, emphasis, and links while leaving identifiers intact", () => {
    const spans = parseInlineSpans(
      "Checked `search/view.mjs` with **3 fixes**, *clean* state, claude:haiku*2, snake_case_id, [docs](https://example.com), and [view.mjs](file:///workspace/search/view.mjs#L12).",
    );
    const styles = new Map(spans.map((span) => [span.text, span.style]));
    expect(styles.get("search/view.mjs")).toBe("mdCode");
    expect(styles.get("3 fixes")).toBe("bold");
    expect(styles.get("clean")).toBe("bold");
    expect(styles.get("docs")).toBe("bold");
    expect(styles.get(" (https://example.com)")).toBe("muted");
    expect(styles.get("view.mjs")).toBe("mdCode bold");
    const plainJoined = spans.map((span) => span.text).join("");
    expect(plainJoined).toContain("claude:haiku*2");
    expect(plainJoined).toContain("snake_case_id");
    expect(plainJoined).not.toContain("file:///workspace");
  });

  it("strips heading prefixes and inline Markdown markers for compact summaries", () => {
    expect(
      stripInlineMarkdown(
        "### **STATUS** — verified `grouping.mjs` via [guide](https://example.com)",
      ),
    ).toBe("STATUS — verified grouping.mjs via guide (https://example.com)");
  });
});

describe("tui-markdown block rendering", () => {
  const sampleReport = [
    "Task: Audit result grouping and keyboard focus across narrow viewports.",
    "",
    "Messages to orchestrator:",
    "• [update] Checked clean HEAD `8dc70d7e` and reproduced layout shift at `720px`.",
    "• [done] Confirmed focus order holds across grouped cards.",
    "• [blocked] Waiting on fixture schema clarification.",
    "• [error] Legacy snapshot parser threw on empty input.",
    "",
    "Response:",
    "# Audit Overview",
    "",
    "## Summary",
    "",
    "### STATUS",
    "",
    "COMPLETE",
    "",
    "#### Notes",
    "",
    "> Focus ring stays visible in both dark and light themes.",
    "",
    "- [x] Keyboard navigation verified",
    "- [ ] Follow-up benchmark queued",
    "1. Inspect `search/grouping.mjs`",
    "",
    "```diff",
    "--- a/src/grouping.js",
    "+++ b/src/grouping.js",
    "-const gap = 0;",
    "+const gap = 2;",
    " const ready = true;",
    "```",
    "",
    "| Check | Result |",
    "| --- | --- |",
    "| Keyboard | Passed |",
    "| Narrow | Verified |",
    "",
    "---",
    "",
    "Used Bash · vitest run search (×2)",
    "Error: Sample failure detail",
    "Uncertainty: Follow-up benchmark pending",
    "Verification: passed",
  ].join("\n");

  it("applies theme SGR tokens to headings, banners, lists, badges, diffs, quotes, and tables", () => {
    const lines = renderMarkdown(sampleReport, 76, { color: true, tier: "unicode" });
    const joined = lines.join("\n");
    const stripped = stripVTControlCharacters(joined);

    expect(joined).toContain(`${ESC}${DEFAULT_THEME.mdSection}mTask:${ESC}0m`);
    expect(joined).toContain(`${ESC}${DEFAULT_THEME.mdSection}mMessages to orchestrator:${ESC}0m`);
    expect(joined).toContain(`${ESC}${DEFAULT_THEME.mdBadgeInfo}m[update]${ESC}0m`);
    expect(joined).toContain(`${ESC}32;1m[done]${ESC}0m`);
    expect(joined).toContain(`${ESC}33;1m[blocked]${ESC}0m`);
    expect(joined).toContain(`${ESC}31;1m[error]${ESC}0m`);
    expect(joined).toContain(`${ESC}${DEFAULT_THEME.mdH1}m Audit Overview ${ESC}0m`);
    expect(joined).toContain(`${ESC}${DEFAULT_THEME.mdH2}m▍ Summary${ESC}0m`);
    expect(joined).toContain(`${ESC}${DEFAULT_THEME.mdH3}m▸ STATUS${ESC}0m`);
    expect(joined).toContain(`${ESC}${DEFAULT_THEME.mdH4}m· Notes${ESC}0m`);
    expect(joined).toContain(`${ESC}32;1m✓ COMPLETE${ESC}0m`);
    expect(joined).toContain(`${ESC}${DEFAULT_THEME.mdCode}m8dc70d7e${ESC}0m`);
    expect(joined).toContain(`${ESC}${DEFAULT_THEME.success}m+const gap = 2;${ESC}0m`);
    expect(joined).toContain(`${ESC}${DEFAULT_THEME.error}m-const gap = 0;${ESC}0m`);
    expect(joined).toContain(`${ESC}${DEFAULT_THEME.mdQuoteBar}m▎ ${ESC}0m`);

    expect(stripped).not.toContain("### STATUS");
    expect(stripped).not.toContain("```");
    expect(stripped).toContain("✓ Keyboard navigation verified");
    expect(stripped).toContain("☐ Follow-up benchmark queued");
    expect(stripped).toContain("Used Bash · vitest run search (×2)");
  });

  it("supports custom resolved theme overrides and clean monochrome output", () => {
    const customTheme = resolveTheme({ mdH3: "34;1", mdCode: "35" });
    const themed = renderMarkdown("### HEADING\n\nUse `token`.", 48, {
      color: customTheme,
      tier: "unicode",
    }).join("\n");
    expect(themed).toContain(`${ESC}34;1m▸ HEADING${ESC}0m`);
    expect(themed).toContain(`${ESC}35mtoken${ESC}0m`);

    const mono = renderMarkdown(sampleReport, 64, { color: false, tier: "ascii" });
    for (const line of mono) {
      expect(line).not.toContain(ESC);
      expect(displayWidth(line)).toBeLessThanOrEqual(64);
    }
    const monoText = mono.join("\n");
    expect(monoText).toContain("> STATUS");
    expect(monoText).toContain("+ COMPLETE");
    expect(monoText).toContain("[ ] Follow-up benchmark queued");
    expect(monoText).toContain("  | +const gap = 2;");
  });

  it("never exceeds target display width across narrow viewports, long hashes, CJK, and control sequences", () => {
    const adversarial = [
      "Task: Verify `\u{1B}[31minjected\u{1B}[0m` and 44196d41c75b847301804dca95919e3fc5a29738ffff000011112222",
      "• [update] 漢字かな交じり文と🧪絵文字の幅計算を確認するテストケースです。",
      "| ColA | ColB | ColC | ColD |",
      "| --- | --- | --- | --- |",
      "| superlongunbrokencellvalue | 漢字テスト | third | fourth |",
      "```js",
      "const veryLongIdentifier = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';",
      "```",
      "BLOCKED",
      "FAILED",
    ].join("\n");

    for (const width of [12, 24, 40, 80, 120]) {
      for (const tier of ["ascii", "unicode", "nerd"]) {
        const lines = renderMarkdown(adversarial, width, { color: true, tier });
        for (const line of lines) {
          expect(displayWidth(line)).toBeLessThanOrEqual(width);
          expect(line).not.toContain("\u{1B}[31minjected");
        }
      }
    }
  });

  it("styles room log lines with sender accent, inline code, and repeat count", () => {
    const lines = renderLogLine("Builder", "Updated `grouping.mjs` checks", 3, 40, {
      color: true,
      tier: "unicode",
    });
    const joined = lines.join("\n");
    expect(joined).toContain(`${ESC}${DEFAULT_THEME.mdSection}mBuilder:${ESC}0m`);
    expect(joined).toContain(`${ESC}${DEFAULT_THEME.mdCode}mgrouping.mjs${ESC}0m`);
    expect(joined).toContain("(×3)");
    for (const line of lines) {
      expect(displayWidth(line)).toBeLessThanOrEqual(40);
    }
  });
});

describe("HordeView themed activity and inner padding", () => {
  function sampleRoom() {
    return {
      id: "room-md",
      title: "Format recorded activity",
      cwd: "/workspace/demo",
      conductor: { id: "lead", name: "Lead", status: "running", herdrPaneId: "w1:p1" },
      agents: [
        {
          id: "scout",
          name: "Scout",
          status: "completed",
          engine: "codex",
          model: "gpt:sol",
          objective: "Audit layout spacing",
          output: ["Verified `grouping.mjs` with **zero** regressions"],
        },
      ],
      accounts: [],
      messages: [{ from: "Scout", text: "Finished `grouping.mjs` check" }],
      swarm: { maxAgents: 6, maxDepth: 3 },
    };
  }

  it("renders Recorded activity with 1-column inner padding and themed Markdown while keeping terminal previews verbatim", () => {
    const view = new HordeView(sampleRoom(), { height: 24, color: true, tier: "unicode" });
    view.focusId = "scout";
    view.setPreview({
      agentId: "scout",
      title: "codex:search-audit",
      kind: "activity",
      loading: false,
      text: "Task: Check spacing\n\nResponse:\n### STATUS\n\nCOMPLETE",
    });

    const rendered = view.render(90);
    const plainLines = rendered.map((line) => stripVTControlCharacters(line));
    const taskLine = plainLines.find((line) => line.includes("Task: Check spacing"));
    expect(taskLine).toMatch(/^│ Task: Check spacing/u);
    expect(rendered.join("\n")).toContain(`${ESC}${DEFAULT_THEME.mdH3}m▸ STATUS${ESC}0m`);
    expect(rendered.join("\n")).toContain(`${ESC}32;1m✓ COMPLETE${ESC}0m`);

    view.setPreview({
      agentId: "scout",
      title: "codex:search-audit",
      kind: "terminal",
      loading: false,
      text: "### RAW_TERMINAL_LINE",
    });
    const terminalPlain = view.render(90).map((line) => stripVTControlCharacters(line));
    expect(terminalPlain.some((line) => line.includes("│ ### RAW_TERMINAL_LINE"))).toBe(true);
  });

  it("renders a framed multi-line Focus card with themed Markdown and formats room logs", () => {
    const view = new HordeView(sampleRoom(), { height: 28, color: true, tier: "unicode" });
    view.focusId = "scout";
    const sidebarRendered = view.render(90);
    const sidebarPlain = sidebarRendered.map((line) => stripVTControlCharacters(line)).join("\n");
    expect(sidebarPlain).toContain("┌ Focus · Scout ");
    expect(sidebarPlain).toContain("Enter open · p pin ┐");
    expect(sidebarPlain).toContain("│ Task: Audit layout spacing");
    expect(sidebarPlain).toContain("│ Verified grouping.mjs with zero regressions");
    expect(sidebarRendered.join("\n")).toContain(
      `${ESC}${DEFAULT_THEME.mdCode}mgrouping.mjs${ESC}0m`,
    );

    // Clicking the framed Focus card opens Recorded activity preview:
    const focusTarget = view.targets.find((target) => target.id === "focus-card");
    expect(focusTarget).toBeDefined();
    expect(
      view.handleMouse({ x: focusTarget.x + 2, y: focusTarget.y + 1, button: 0, action: "press" }),
    ).toBe(true);
    expect(view.preview?.agentId).toBe("scout");
    view.setPreview(null);

    view.handleInput("g");
    const logRendered = view.render(90).join("\n");
    expect(logRendered).toContain(`${ESC}${DEFAULT_THEME.mdSection}mScout:${ESC}0m`);
    expect(logRendered).toContain(`${ESC}${DEFAULT_THEME.mdCode}mgrouping.mjs${ESC}0m`);
  });

  it("surfaces consultation questions and lead answers instead of trailing Uncertainty or result paths", () => {
    const consultSummary = extractAgentFocusMarkdown({
      id: "consult-1",
      name: "claude consultation",
      consultation: true,
      question: "When does SessionStart fire relative to UserPromptSubmit?",
      answer: [
        "### Verdict",
        "",
        "COMPLETE",
        "",
        "`SessionStart` runs once before the first `UserPromptSubmit` hook on fresh sessions.",
        "",
        "### Verification",
        "Checked hook lifecycle.",
      ].join("\n"),
      output: [
        "`SessionStart` runs once before the first `UserPromptSubmit` hook on fresh sessions.",
        "Uncertainty: - That `SessionStart` precedes the first `UserPromptSubmit` on custom forks",
      ],
    });
    expect(consultSummary).toContain(
      "Asked: When does SessionStart fire relative to UserPromptSubmit?",
    );
    expect(consultSummary).toContain(
      "`SessionStart` runs once before the first `UserPromptSubmit` hook on fresh sessions.",
    );
    expect(consultSummary).not.toContain("Uncertainty:");

    const workerSummary = extractAgentFocusMarkdown(
      {
        id: "worker-1",
        objective: "Harden SQLite room store",
        resultPath: "/tmp/orchestrate/runs/run-1/result.json",
        output: [
          "Harden SQLite room store",
          "### STATUS",
          "COMPLETE",
          "All 5 concurrency invariants verified across processes.",
          "Uncertainty: None",
          "Coordinator observed: 2026-11-06T15:00:00Z",
          "/tmp/orchestrate/runs/run-1/result.json",
        ],
      },
      { isCardCollapsed: true },
    );
    expect(workerSummary).toContain("Task: Harden SQLite room store");
    expect(workerSummary).toContain("All 5 concurrency invariants verified across processes.");
    expect(workerSummary).not.toContain("Coordinator observed");
    expect(workerSummary).not.toContain("result.json");
    expect(workerSummary).not.toContain("Uncertainty");
  });
});
