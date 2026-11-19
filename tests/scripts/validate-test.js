import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

import { DESCRIPTION_BUDGET_CHARS, parseFrontmatter, validate } from "../../scripts/validate.js";

function write(root, file, contents) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, typeof contents === "string" ? contents : JSON.stringify(contents));
}

function fixtureRepo({ skillName = "demo", description = "Does a demo." } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "validate-"));
  write(
    root,
    "plugins/demo/skills/demo/SKILL.md",
    `---\nname: ${skillName}\ndescription: ${description}\n---\n\nRun \`node \${CLAUDE_SKILL_DIR}/run.mjs\`.\n`,
  );
  write(root, "plugins/demo/skills/demo/run.mjs", "");
  write(root, "plugins/demo/commands/go.md", "---\ndescription: Go\n---\n\nRun `ork go`.\n");
  return root;
}

test("a consistent repository validates cleanly", () => {
  expect(validate(fixtureRepo())).toStrictEqual([]);
});

test("a repository without any manifest or version bookkeeping needs none", () => {
  const root = fixtureRepo();
  expect(fs.readdirSync(root)).toStrictEqual(["plugins"]);
  expect(validate(root)).toStrictEqual([]);
});

test("validates relocated adapter skills and command references", () => {
  const root = fixtureRepo();
  write(root, "adapters/skills/demo/SKILL.md", "---\nname: other\ndescription: Test\n---\n");
  write(root, "adapters/claude/commands/go.md", "See `adapters/missing.md`.\n");
  expect(validate(root)).toStrictEqual([
    "adapters/skills/demo/SKILL.md: name should be demo",
    "adapters/claude/commands/go.md: adapters/missing.md does not exist",
  ]);
});

test("a skill whose name differs from its directory is reported", () => {
  const errors = validate(fixtureRepo({ skillName: "other" }));
  expect(errors.length).toBe(1);
  expect(errors[0]).toMatch(/SKILL\.md: name should be demo/u);
});

test("a description over the budget is reported", () => {
  const errors = validate(fixtureRepo({ description: "x".repeat(DESCRIPTION_BUDGET_CHARS + 1) }));
  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatch(/description is 1537 chars/u);
});

test("a missing skill-directory reference is reported", () => {
  const root = fixtureRepo();
  fs.rmSync(path.join(root, "plugins/demo/skills/demo/run.mjs"));
  expect(validate(root)).toStrictEqual([
    "plugins/demo/skills/demo/SKILL.md: ${CLAUDE_SKILL_DIR}/run.mjs does not exist",
  ]);
});

test("a file a command names must exist", () => {
  const root = fixtureRepo();
  write(root, "plugins/demo/commands/go.md", "Read `plugins/demo/lib/gone.mjs`, then `ork go`.\n");
  expect(validate(root)).toStrictEqual([
    "plugins/demo/commands/go.md: plugins/demo/lib/gone.mjs does not exist",
  ]);
  write(root, "plugins/demo/lib/gone.mjs", "");
  expect(validate(root)).toStrictEqual([]);
});

test("the retired plugin variable is reported wherever it returns", () => {
  const root = fixtureRepo();
  write(root, "plugins/demo/commands/go.md", 'node "${CLAUDE_PLUGIN_ROOT}/bin/ork.mjs" go\n');
  write(root, "plugins/demo/lib/x.mjs", "const dir = '${CLAUDE_PLUGIN_ROOT:-.}';\n");
  expect(validate(root).toSorted((a, b) => a.localeCompare(b))).toStrictEqual([
    "plugins/demo/commands/go.md: ${CLAUDE_PLUGIN_ROOT} is retired; call `ork` or `monitor`",
    "plugins/demo/lib/x.mjs: ${CLAUDE_PLUGIN_ROOT} is retired; call `ork` or `monitor`",
  ]);
});

test.each([
  ".claude-plugin/marketplace.json",
  "plugins/demo/.claude-plugin/plugin.json",
  "plugins/demo/.mcp.json",
])("the retired manifest %s is reported", (manifest) => {
  const root = fixtureRepo();
  write(root, manifest, {});
  const errors = validate(root);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatch(/not a Claude Code plugin any more/u);
});

test("frontmatter parsing reads top-level keys and metadata.version", () => {
  const { error, fields } = parseFrontmatter(
    '---\nname: x\ndescription: "quoted"\nmetadata:\n  version: 1.2.3\n---\nbody\n',
  );
  expect(error).toBe(null);
  expect(fields).toStrictEqual({
    description: "quoted",
    metadata: "",
    "metadata.version": "1.2.3",
    name: "x",
  });
  expect(parseFrontmatter("no frontmatter").error).toBe("missing frontmatter");
});
