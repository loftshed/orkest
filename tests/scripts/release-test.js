import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  bump,
  checkRelease,
  gitIn,
  incrementFor,
  latestPublished,
  planRelease,
  productTag,
  publishRelease,
  RELEASE_SUBJECT,
  releaseChangelog,
  setFrontmatterVersion,
  writeRelease,
} from "../../scripts/release.js";
import { validate } from "../../scripts/validate.js";

describe("version arithmetic", () => {
  test.each([
    [["fix: a"], "patch"],
    [["docs: a", "feat(scope): b"], "minor"],
    [["refactor!: a"], "major"],
    [["fix: a\n\nBREAKING CHANGE: config moved"], "major"],
    [["Plain subject"], "patch"],
  ])("%j asks for a %s release", (messages, increment) => {
    expect(incrementFor(messages)).toBe(increment);
  });

  test.each([
    ["1.2.3", "patch", "1.2.4"],
    ["1.2.3", "minor", "1.3.0"],
    ["1.2.3", "major", "2.0.0"],
    ["0.4.3", "major", "0.5.0"],
  ])("%s plus a %s release is %s", (version, increment, next) => {
    expect(bump(version, increment)).toBe(next);
  });
});

describe("published history", () => {
  test("the highest version across the new and the earlier tag streams wins", () => {
    const tags = [
      "orchestrate--v0.91.1",
      "orchestrate--v0.9.0",
      "agent-executor--v0.80.0",
      "monitor--v0.19.4",
      "ai-usage--v0.50.0",
      "v0.92.0",
      "v0.100.0",
      "vX.Y.Z",
      "v1.0",
    ];
    expect(latestPublished(tags, ["orchestrate", "agent-executor"])).toEqual({
      tag: "v0.100.0",
      version: "0.100.0",
    });
    expect(latestPublished(tags.slice(0, 5), ["orchestrate", "agent-executor"])).toEqual({
      tag: "orchestrate--v0.91.1",
      version: "0.91.1",
    });
  });

  test("the monitor line, which ended, and unrelated tags are not history", () => {
    expect(latestPublished(["monitor--v0.19.4", "release-1"], ["orchestrate"])).toBe(null);
    expect(productTag("0.92.0")).toBe("v0.92.0");
  });

  test("the new tag format wins a tie", () => {
    expect(latestPublished(["orchestrate--v0.92.0", "v0.92.0"], ["orchestrate"]).tag).toBe(
      "v0.92.0",
    );
  });
});

describe("generated text", () => {
  test("Unreleased notes become the release section and history is kept", () => {
    const before =
      "# Changelog\n\n## Unreleased\n\n- Clearer summary.\n\n## 1.0.0 (2026-09-29)\n\n- Old.\n";
    expect(releaseChangelog(before, "1.0.1", ["fix: terse"])).toEqual({
      content: "# Changelog\n\n## 1.0.1\n\n- Clearer summary.\n\n## 1.0.0 (2026-09-29)\n\n- Old.\n",
      notes: "- Clearer summary.",
    });
  });

  test("without notes the commit subjects are listed once each", () => {
    const { content } = releaseChangelog(null, "0.1.0", ["feat: a\n\nbody", "feat: a", "fix: b"]);
    expect(content).toBe("# Changelog\n\n## 0.1.0\n\n- feat: a\n- fix: b\n");
  });

  test("a changelog that starts with a History section keeps it below the release", () => {
    const before = "# Changelog\n\n## History\n\nOlder lines live elsewhere.\n";
    expect(releaseChangelog(before, "0.2.0", ["fix: x"]).content).toBe(
      "# Changelog\n\n## 0.2.0\n\n- fix: x\n\n## History\n\nOlder lines live elsewhere.\n",
    );
  });

  test("only metadata.version in the frontmatter changes", () => {
    const skill = "---\nname: x\nversion: 7\nmetadata:\n  version: 0.1.0\n---\n  version: body\n";
    expect(setFrontmatterVersion(skill, "0.2.0")).toBe(skill.replace("0.1.0", "0.2.0"));
    expect(setFrontmatterVersion("no frontmatter\n", "1.0.0")).toBe("no frontmatter\n");
  });
});

describe("releases in a repository", () => {
  let scratch, root, git, since;
  const file = (relative) => path.join(root, relative);
  const read = (relative) => fs.readFileSync(file(relative), "utf8");
  const json = (relative) => JSON.parse(read(relative));
  const put = (relative, content = `${relative} ${Math.random()}\n`) => {
    fs.mkdirSync(path.dirname(file(relative)), { recursive: true });
    fs.writeFileSync(
      file(relative),
      typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`,
    );
  };
  const commit = (subject, relative, content) => {
    if (relative) put(relative, content);
    git(["add", "--all"]);
    git(["commit", "--quiet", "--allow-empty", "-m", subject]);
    return git(["rev-parse", "HEAD"]);
  };
  const planned = () =>
    planRelease({ root }).releases.map(({ tag, version }) => `${tag}@${version}`);
  // The last release of the stream that came before the merge: one product continues from it.
  const publishedBefore = (version = "0.3.0", tag = `one--v${version}`) => {
    commit("chore(release): publish plugins", "package.json", { name: "orkest", version });
    git(["tag", tag]);
  };

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "release-test-"));
    root = path.join(scratch, "repo");
    fs.mkdirSync(root);
    git = gitIn(root);
    git(["init", "--quiet", "--initial-branch=main"]);
    for (const [key, value] of [
      ["user.name", "Test"],
      ["user.email", "test@example.invalid"],
      ["commit.gpgsign", "false"],
      ["core.hooksPath", "/dev/null"],
    ]) {
      git(["config", key, value]);
    }
    put("package.json", { name: "orkest", version: "0.3.0" });
    put("CHANGELOG.md", "# Changelog\n\n## History\n\n- Before the merge.\n");
    for (const name of ["one", "two"]) {
      put(`plugins/${name}/CHANGELOG.md`, "# Changelog\n\n## 0.3.0\n\n- Earlier.\n");
      put(`adapters/skills/${name}/SKILL.md`, `---\nname: ${name}\ndescription: ${name}.\n---\n`);
    }
    put("plugins/two/package.json", { name: "two", version: "0.3.0" });
    since = commit("chore: start");
    commit("chore: count releases from here", "release.json", {
      legacyTags: ["one", "ancient"],
      since,
    });
  });
  afterEach(() => fs.rmSync(scratch, { force: true, recursive: true }));

  test("a first release goes out at the version package.json declares", () => {
    commit("feat: new skill", "adapters/skills/extra/SKILL.md");
    expect(planned()).toEqual(["v0.3.0@0.3.0"]);
  });

  test("the first product release continues the earlier stream's line", () => {
    publishedBefore("0.3.0");
    commit("fix: wording", "adapters/skills/two/SKILL.md");
    commit("feat: new skill", "adapters/skills/extra/SKILL.md");
    const [release] = planRelease({ root }).releases;
    expect([release.tag, release.previous, release.version]).toEqual(["v0.4.0", "0.3.0", "0.4.0"]);
    expect(release.notes).toContain("feat: new skill");
    expect(release.notes).toContain("fix: wording");
  });

  test("a legacy tag from another stream of the product still counts, the monitor's does not", () => {
    publishedBefore("0.3.0");
    git(["tag", "monitor--v9.9.9"]);
    git(["tag", "ancient--v0.2.0"]);
    commit("fix: wording", "adapters/skills/two/SKILL.md");
    expect(planned()).toEqual(["v0.3.1@0.3.1"]);
  });

  test("tests, repository docs, changelogs and reverted edits release nothing", () => {
    publishedBefore();
    commit("test: cases", "tests/one-test.js");
    commit("docs: readme", "README.md");
    commit("docs: history", "CHANGELOG.md", `${read("CHANGELOG.md")}\nNote.\n`);
    commit("docs: old history", "plugins/one/CHANGELOG.md", "# Changelog\n\nNote.\n");
    const original = read("adapters/skills/two/SKILL.md");
    commit("feat: try something", "adapters/skills/two/SKILL.md");
    commit("revert: try something", "adapters/skills/two/SKILL.md", original);
    expect(planned()).toEqual([]);
  });

  test("the crate, the installer and the host manifests all release", () => {
    publishedBefore();
    commit("perf: accelerate", "crates/ork-fast/src/main.rs");
    expect(planned()).toEqual(["v0.3.1@0.3.1"]);
    publishedBefore("0.3.1", "v0.3.1");
    commit("fix: installer", "install.sh");
    expect(planned()).toEqual(["v0.3.2@0.3.2"]);
    publishedBefore("0.3.2", "v0.3.2");
    git(["rm", "--quiet", "adapters/skills/one/SKILL.md"]);
    commit("remove a skill");
    expect(planned()).toEqual(["v0.3.3@0.3.3"]);
  });

  test.each([
    ["feat: new command", "adapters/claude/commands/new.md", "v0.4.0@0.4.0"],
    ["fix: skill wording", "adapters/skills/new/SKILL.md", "v0.3.1@0.3.1"],
    ["fix: runtime", "src/lib/thing.mjs", "v0.3.1@0.3.1"],
    ["feat: data", "references/routes/x.json", "v0.4.0@0.4.0"],
  ])("%s touching only %s releases %s", (subject, file, expected) => {
    publishedBefore();
    commit(subject, file);
    expect(planned()).toEqual([expected]);
  });

  test("command-only and skill-only commits in the planned layout each release in turn", () => {
    publishedBefore();
    commit("feat(claude): new command", "adapters/claude/commands/new.md");
    expect(planned()).toEqual(["v0.4.0@0.4.0"]);
    publishedBefore("0.4.0", "v0.4.0");
    commit("fix(skills): reword", "adapters/skills/new/SKILL.md");
    expect(planned()).toEqual(["v0.4.1@0.4.1"]);
    expect(planRelease({ root }).releases[0].notes).toBe("- fix(skills): reword");
  });

  test("a hand-edited version is refused", () => {
    publishedBefore();
    commit("feat: bump", "package.json", { name: "orkest", version: "0.9.0" });
    expect(() => planRelease({ root })).toThrow("edited by hand");
  });

  test("a missing version is reported", () => {
    publishedBefore();
    commit("feat: no version", "package.json", { name: "orkest" });
    expect(() => planRelease({ root })).toThrow("needs an x.y.z version");
  });

  test("the written release updates every version and passes the validator", () => {
    publishedBefore();
    commit(
      "fix: two",
      "adapters/skills/two/SKILL.md",
      "---\nname: two\ndescription: 2.\nmetadata:\n  version: 0.3.0\n---\n",
    );
    const files = writeRelease(planRelease({ root }), root);
    expect(files).toEqual([
      "CHANGELOG.md",
      "package.json",
      "plugins/two/package.json",
      "adapters/skills/two/SKILL.md",
    ]);
    expect(json("package.json").version).toBe("0.3.1");
    expect(json("plugins/two/package.json").version).toBe("0.3.1");
    expect(read("adapters/skills/two/SKILL.md")).toContain("  version: 0.3.1");
    expect(read("CHANGELOG.md")).toMatch(/^# Changelog\n\n## 0\.3\.1\n\n- fix: two\n\n## History/u);
    expect(validate(root)).toEqual([]);
  });

  test("a tag becomes the next baseline, and a tag off this history is refused", () => {
    publishedBefore();
    const source = commit("fix: one", "adapters/skills/one/SKILL.md");
    writeRelease(planRelease({ root }), root);
    commit(RELEASE_SUBJECT);
    git(["tag", "v0.3.1"]);
    expect(planned()).toEqual([]);
    commit("fix: again", "adapters/skills/one/SKILL.md");
    expect(planned()).toEqual(["v0.3.2@0.3.2"]);
    git(["checkout", "--quiet", "--detach", source]);
    expect(planned()).toEqual([]);
    git(["checkout", "--quiet", "-b", "elsewhere", since]);
    put("release.json", { legacyTags: ["one"], since });
    commit("fix: unrelated", "adapters/skills/one/SKILL.md");
    expect(() => planRelease({ root })).toThrow("not in this branch's history");
  });

  test("release commits of either subject are not release notes", () => {
    publishedBefore();
    commit("chore(release): publish plugins", "adapters/skills/one/SKILL.md");
    commit(`${RELEASE_SUBJECT}\n\n- v0.3.1`, "adapters/skills/two/SKILL.md");
    commit("fix: real change", "adapters/skills/one/SKILL.md");
    expect(planRelease({ root }).releases[0].notes).toBe("- fix: real change");
  });

  test("check gates the release in a scratch worktree and leaves the checkout alone", () => {
    publishedBefore();
    commit("fix: one", "adapters/skills/one/SKILL.md");
    put("scratch.txt", "local work\n");
    const status = git(["status", "--porcelain"]);
    let seen;
    const gate = vi.fn((files, dir) => {
      seen = dir;
      expect(dir).not.toBe(root);
      const manifest = fs.readFileSync(path.join(dir, "package.json"), "utf8");
      expect(JSON.parse(manifest).version).toBe("0.3.1");
      expect(files).toContain("CHANGELOG.md");
    });
    expect(checkRelease({ gate, root }).releases).toHaveLength(1);
    expect(gate).toHaveBeenCalledOnce();
    expect(fs.existsSync(seen)).toBe(false);
    expect(git(["status", "--porcelain"])).toBe(status);
    expect(git(["worktree", "list"]).split("\n")).toHaveLength(1);
    expect(() =>
      checkRelease({
        gate: () => {
          throw new Error("gate failed");
        },
        root,
      }),
    ).toThrow("gate failed");
    expect(git(["worktree", "list"]).split("\n")).toHaveLength(1);
  });

  describe("publishing", () => {
    let remote, env, created, request;
    const tagsOnRemote = () => git(["ls-remote", "--tags", remote]);
    const branchOnRemote = () => git(["ls-remote", remote, "refs/heads/main"]).split("\t", 1)[0];

    beforeEach(() => {
      publishedBefore();
      const source = commit("fix: ship two", "adapters/skills/two/SKILL.md");
      remote = path.join(scratch, "remote.git");
      execFileSync("git", ["init", "--quiet", "--bare", remote]);
      git(["push", "--quiet", remote, "HEAD:refs/heads/main"]);
      env = {
        ...process.env,
        DEFAULT_BRANCH: "main",
        GITHUB_ACTIONS: "true",
        GITHUB_EVENT_NAME: "push",
        GITHUB_REF: "refs/heads/main",
        GITHUB_REPOSITORY: "someone/orkest",
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_SHA: source,
        GITHUB_TOKEN: "token-for-tests",
      };
      delete env.GITHUB_OUTPUT;
      created = new Map();
      request = vi.fn(async (url, options = {}) => {
        if (options.method === "POST") {
          const body = JSON.parse(options.body);
          created.set(body.tag_name, body);
          return new Response("{}", { status: 201 });
        }
        const tag = decodeURIComponent(url.slice(url.lastIndexOf("/") + 1));
        return new Response("{}", { status: created.has(tag) ? 200 : 404 });
      });
    });
    const publish = (overrides = {}) =>
      publishRelease({ env, gate: vi.fn(), remote, request, root, ...overrides });

    test("pushes the release commit with its one tag, then creates the GitHub release", async () => {
      expect(await publish()).toBe("Released v0.3.1.");
      const released = git(["rev-parse", "HEAD"]);
      expect(branchOnRemote()).toBe(released);
      expect(tagsOnRemote()).toContain("refs/tags/v0.3.1");
      expect(git(["show", "-s", "--format=%B", released])).toContain(
        `Release-Of: ${env.GITHUB_SHA}`,
      );
      expect(git(["show", "-s", "--format=%s", released])).toBe(RELEASE_SUBJECT);
      expect(created.get("v0.3.1")).toMatchObject({
        name: "Orkest 0.3.1",
        target_commitish: released,
      });
      expect(request.mock.calls[0][0]).toBe(
        "https://api.github.com/repos/someone/orkest/releases/tags/v0.3.1",
      );
    });

    test("earlier tags stay where they were", async () => {
      const before = git(["rev-parse", "one--v0.3.0"]);
      await publish();
      expect(git(["rev-parse", "one--v0.3.0"])).toBe(before);
    });

    test("a rerun after a failed GitHub call only restores the missing release", async () => {
      request.mockResolvedValueOnce(new Response("", { status: 404 }));
      request.mockResolvedValueOnce(new Response("", { status: 502 }));
      await expect(publish()).rejects.toThrow("HTTP 502");
      git(["checkout", "--quiet", "--detach", env.GITHUB_SHA]);
      expect(await publish()).toContain("Already released");
      expect(created.keys().toArray()).toEqual(["v0.3.1"]);
      expect(created.get("v0.3.1").body).toContain("fix: ship two");
      expect(git(["tag", "--list", "v*"])).toBe("v0.3.1");
    });

    test("a newer push wins and publishes everything since the last release once", async () => {
      const newer = commit("feat: grow one", "adapters/skills/one/SKILL.md");
      git(["push", "--quiet", remote, "HEAD:refs/heads/main"]);
      git(["checkout", "--quiet", "--detach", env.GITHUB_SHA]);
      expect(await publish()).toContain("moved on");
      git(["checkout", "--quiet", "--detach", newer]);
      env.GITHUB_SHA = newer;
      expect(await publish()).toBe("Released v0.4.0.");
      expect(created.get("v0.4.0").body).toMatch(/feat: grow one[\s\S]*fix: ship two/u);
    });

    test.each([
      { GITHUB_EVENT_NAME: "pull_request" },
      { GITHUB_REF: "refs/heads/topic" },
      { GITHUB_SHA: "0".repeat(40) },
      { GITHUB_TOKEN: "" },
      { GITHUB_ACTIONS: "" },
    ])("refuses to publish with %j", async (override) => {
      const gate = vi.fn();
      await expect(publish({ env: { ...env, ...override }, gate })).rejects.toThrow(
        "Refusing to publish",
      );
      expect(gate).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
    });

    test("nothing is pushed when the gates fail or touch other files", async () => {
      const head = env.GITHUB_SHA;
      const failing = vi.fn(() => {
        throw new Error("gate failed");
      });
      await expect(publish({ gate: failing })).rejects.toThrow("gate failed");
      git(["checkout", "--quiet", "--force", "--detach", head]);
      const straying = vi.fn(() => put("stray.txt", "x\n"));
      await expect(publish({ gate: straying })).rejects.toThrow("stray.txt");
      expect(branchOnRemote()).toBe(head);
      expect(tagsOnRemote()).not.toContain("refs/tags/v");
    });

    test("a push that races the release publishes no tags", async () => {
      const racing = commit("docs: racing", "notes.md");
      git(["checkout", "--quiet", "--detach", env.GITHUB_SHA]);
      const gate = vi.fn(() => git(["push", "--quiet", remote, `${racing}:refs/heads/main`]));
      await expect(publish({ gate })).rejects.toThrow("git push failed");
      expect(branchOnRemote()).toBe(racing);
      expect(tagsOnRemote()).not.toContain("refs/tags/v");
    });

    test("crates/ork-fast edits release the product and write release_tag to GITHUB_OUTPUT", async () => {
      await publish();
      git(["checkout", "--quiet", "--detach", "main"]);
      put("crates/ork-fast/src/main.rs", "fn main() {}\n");
      const edited = commit("perf(orchestrate): accelerate hooks");
      expect(planned()).toEqual(["v0.3.2@0.3.2"]);

      git(["push", "--quiet", remote, "HEAD:refs/heads/main"]);
      const outputFile = path.join(scratch, "github_output.txt");
      await publish({ env: { ...env, GITHUB_OUTPUT: outputFile, GITHUB_SHA: edited } });
      const output = fs.readFileSync(outputFile, "utf8");
      expect(output).toContain("release_tag=v0.3.2");
      expect(output).not.toContain("orchestrate_release_tag");
    });
  });
});
