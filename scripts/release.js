#!/usr/bin/env node
// Orkest releases driven by conventional commits: one product, one version.
//
//   node scripts/release.js plan      print what the next release would publish
//   node scripts/release.js check     build that release in a scratch worktree and run the gates on it
//   node scripts/release.js publish   commit, tag, push and create GitHub releases (GitHub Actions only)
//
// The version lives in the root package.json and tags are `vX.Y.Z`. The commits since the
// highest published tag decide whether and how far it moves. Tags from the two earlier release
// streams (`orchestrate--vX.Y.Z`, `agent-executor--vX.Y.Z`; release.json `legacyTags`) count as
// published history, so the first product release continues orchestrate's line. The old
// `monitor--v` line has ended and is ignored.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { REPO_ROOT } from "./validate.js";

export const RELEASE_SUBJECT = "chore(release): publish orkest";
// Release commits from before the streams merged; they are never release notes either.
const LEGACY_RELEASE_SUBJECT = "chore(release): publish plugins";
const TRAILER = "Release-Of";
const VERSION = /^(\d+)\.(\d+)\.(\d+)$/u;

// ── git ────────────────────────────────────────────────────────────────────

export function gitIn(cwd, env) {
  return (args, { allowFailure = false } = {}) => {
    try {
      return execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        env,
        maxBuffer: 32 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      }).trimEnd();
    } catch (error) {
      if (allowFailure) return null;
      // Never echo git's stderr or keep it as the cause: a failed push can print the
      // authenticated remote.
      // eslint-disable-next-line preserve-caught-error -- the cause would carry that stderr.
      throw new Error(`git ${args[0]} failed (exit ${error.status ?? "?"})`);
    }
  };
}

const isAncestor = (git, older, newer) =>
  git(["merge-base", "--is-ancestor", older, newer], { allowFailure: true }) !== null;

function fileAt(git, ref, file) {
  return git(["show", `${ref}:${file}`], { allowFailure: true });
}

// ── versions ───────────────────────────────────────────────────────────────

export function compareVersions(left, right) {
  const a = VERSION.exec(left).slice(1).map(Number);
  const b = VERSION.exec(right).slice(1).map(Number);
  const index = a.findIndex((part, position) => part !== b[position]);
  return index === -1 ? 0 : Math.sign(a[index] - b[index]);
}

/** The increment a set of commit messages asks for: "major", "minor" or "patch". */
export function incrementFor(messages) {
  let increment = "patch";
  for (const message of messages) {
    const header = message.split("\n", 1)[0];
    const match = /^(\w+)(?:\([^)]*\))?(!)?:/u.exec(header);
    if (match?.[2] || /^BREAKING[- ]CHANGE:/mu.test(message)) return "major";
    if (match?.[1] === "feat") increment = "minor";
  }
  return increment;
}

/** Semantic versioning, where a breaking change before 1.0.0 only moves the minor. */
export function bump(version, increment) {
  let [major, minor, patch] = VERSION.exec(version).slice(1).map(Number);
  const effective = increment === "major" && major === 0 ? "minor" : increment;
  if (effective === "major") [major, minor, patch] = [major + 1, 0, 0];
  else if (effective === "minor") [minor, patch] = [minor + 1, 0];
  else patch += 1;
  return `${major}.${minor}.${patch}`;
}

// ── what changed ───────────────────────────────────────────────────────────

// What a checkout ships. Documentation, tests and repository tooling alone do not release. `src/`,
// `adapters/` (harness manifests, skill and command text) and `references/` are the planned layout
// (issue 233 stages 3 to 5); a commit that touches only those must still release.
const SHIPPED_PATHS = [
  "plugins",
  "src",
  "adapters",
  "references",
  "crates/ork-fast",
  "install.sh",
  "herdr-plugin.toml",
  "orca-plugin.json",
  ".opencode",
  ":(exclude)plugins/*/CHANGELOG.md",
  ":(exclude)plugins/*/package.json",
];
const CHANGELOG = "CHANGELOG.md";
const PRODUCT_TAG = /^v(\d+\.\d+\.\d+)$/u;

/** The product version at `ref`: `version` in the root package.json. */
export function productVersionAt(git, ref) {
  let version;
  try {
    version = JSON.parse(fileAt(git, ref, "package.json") ?? "{}").version;
  } catch {
    // Reported below, like a missing version.
  }
  if (!VERSION.test(version ?? "")) {
    throw new Error(`package.json: needs an x.y.z version at ${ref}`);
  }
  return version;
}

export const productTag = (version) => `v${version}`;

/**
 * The highest published version and its tag across `vX.Y.Z` and each earlier stream's
 * `<name>--vX.Y.Z`. A tie goes to the new format.
 */
export function latestPublished(tags, legacyTags = []) {
  const prefixes = ["v", ...legacyTags.map((name) => `${name}--v`)];
  let best = null;
  for (const tag of tags) {
    for (const prefix of prefixes) {
      const version = tag.slice(prefix.length);
      if (!tag.startsWith(prefix) || !VERSION.test(version)) continue;
      const order = best ? compareVersions(version, best.version) : 1;
      if (order > 0 || (order === 0 && prefix === "v")) best = { tag, version };
    }
  }
  return best;
}

/** Tell the workflow which tag to attach the `ork-fast` binaries to. */
function recordReleaseOutput(releases, env = process.env) {
  const output = env?.GITHUB_OUTPUT;
  if (!output) return;
  const match = releases.find((release) => PRODUCT_TAG.test(release.tag ?? ""));
  if (match) {
    fs.appendFileSync(output, `release_tag=${match.tag}\n`);
  }
}

// ── changelog ──────────────────────────────────────────────────────────────

function sections(changelog) {
  const found = [];
  const pattern = /^## (.+)$/gmu;
  let match;
  while ((match = pattern.exec(changelog)))
    found.push({ heading: match[1].trim(), at: match.index });
  return found.map((section, index) => ({
    ...section,
    end: found[index + 1]?.at ?? changelog.length,
  }));
}

/**
 * Insert a `## version` section at the top. Hand-written `## Unreleased` notes (and, for
 * a first release, notes already under the declared version) become its body; otherwise
 * the commit subjects do.
 */
export function releaseChangelog(changelog, version, messages) {
  const text = changelog?.trim() ? changelog : "# Changelog\n";
  const claimed = sections(text).filter(
    ({ heading }) => heading === "Unreleased" || heading.split(" ", 1)[0] === version,
  );
  const handWritten = claimed
    .map(({ at, end }) =>
      text
        .slice(at, end)
        .replace(/^## .*\n/u, "")
        .trim(),
    )
    .filter(Boolean)
    .join("\n\n");
  const subjects = [...new Set(messages.map((message) => `- ${message.split("\n", 1)[0]}`))];
  const notes = handWritten || subjects.join("\n");
  let rest = text;
  for (const { at, end } of claimed.toReversed()) rest = rest.slice(0, at) + rest.slice(end);
  const title = /^# .*\n/u.exec(rest)?.[0] ?? "# Changelog\n";
  const history = (rest.startsWith(title) ? rest.slice(title.length) : rest).trim();
  const body = `${title}\n## ${version}\n\n${notes}\n`;
  return { notes, content: history ? `${body}\n${history}\n` : body };
}

// ── planning ───────────────────────────────────────────────────────────────

export function planRelease({ root = REPO_ROOT, git = gitIn(root), head } = {}) {
  head ??= git(["rev-parse", "HEAD"]);
  const config = JSON.parse(
    fileAt(git, head, "release.json") ?? fs.readFileSync(path.join(root, "release.json"), "utf8"),
  );
  if (!/^[\da-f]{40}$/u.test(config.since ?? "")) {
    throw new Error("release.json needs `since`: the full SHA releases are counted from");
  }
  const tags = git(["tag", "--list", "v*", "*--v*"]).split("\n").filter(Boolean);
  const published = latestPublished(tags, config.legacyTags ?? []);
  const baseline = published ? git(["rev-list", "-n", "1", published.tag]) : config.since;
  if (isAncestor(git, head, baseline)) return { head, releases: [] };
  if (!isAncestor(git, baseline, head)) {
    throw new Error(`${published?.tag ?? "release.json"} is not in this branch's history`);
  }
  const declared = productVersionAt(git, head);
  const released = published?.version;
  if (released && declared !== released) {
    throw new Error(
      `package.json: version ${declared} was edited by hand; the release job sets it (last release ${released})`,
    );
  }

  const isContentChanged =
    git(["diff", "--quiet", baseline, head, "--", ...SHIPPED_PATHS], { allowFailure: true }) ===
    null;
  if (!isContentChanged) return { head, releases: [] };

  const log = git([
    "log",
    "--no-merges",
    "--format=%B%x1E",
    `${baseline}..${head}`,
    "--",
    ...SHIPPED_PATHS,
  ]);
  const messages = log
    .split("\u{1E}")
    .map((message) => message.trim())
    .filter(
      (message) =>
        message &&
        !message.startsWith(RELEASE_SUBJECT) &&
        !message.startsWith(LEGACY_RELEASE_SUBJECT),
    );
  if (messages.length === 0) messages.push("chore: update orkest");

  const version = released ? bump(released, incrementFor(messages)) : declared;
  const { notes, content } = releaseChangelog(fileAt(git, head, CHANGELOG), version, messages);
  return {
    head,
    releases: [
      {
        changelog: content,
        changelogPath: CHANGELOG,
        name: "orkest",
        notes,
        previous: released ?? null,
        tag: productTag(version),
        version,
      },
    ],
  };
}

// ── writing ────────────────────────────────────────────────────────────────

function setJsonVersion(file, version) {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  data.version = version;
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

/** `metadata.version` inside a SKILL.md frontmatter; other text is left alone. */
export function setFrontmatterVersion(markdown, version) {
  const end = markdown.startsWith("---\n") ? markdown.indexOf("\n---", 3) : -1;
  if (end === -1) return markdown;
  const lines = markdown.slice(0, end).split("\n");
  let isInMetadata = false;
  for (const [index, line] of lines.entries()) {
    if (/^\S/u.test(line)) isInMetadata = line.startsWith("metadata:");
    else if (isInMetadata && /^\s+version:/u.test(line)) {
      lines[index] = line.replace(/version:.*/u, () => `version: ${version}`);
    }
  }
  return lines.join("\n") + markdown.slice(end);
}

/** Every version written down in a checkout: the root package.json and the files that copy it. */
export function writeRelease(plan, root = REPO_ROOT) {
  const written = new Set();
  const write = (relative, content) => {
    fs.writeFileSync(path.join(root, relative), content);
    written.add(relative);
  };
  for (const release of plan.releases) {
    setJsonVersion(path.join(root, "package.json"), release.version);
    written.add("package.json");
    const pluginsRoot = path.join(root, "plugins");
    const plugins = fs.existsSync(pluginsRoot) ? fs.readdirSync(pluginsRoot) : [];
    for (const plugin of plugins) {
      // The installed monitor copy writes its own package.json from the root version; this one is kept in step.
      const manifest = `plugins/${plugin}/package.json`;
      if (!fs.existsSync(path.join(root, manifest))) {
        continue;
      }

      setJsonVersion(path.join(root, manifest), release.version);
      written.add(manifest);
    }
    const skillsRoot = path.join(root, "adapters", "skills");
    const skills = fs.existsSync(skillsRoot) ? fs.readdirSync(skillsRoot) : [];
    for (const skill of skills) {
      const relative = `adapters/skills/${skill}/SKILL.md`;
      if (!fs.existsSync(path.join(root, relative))) continue;
      const original = fs.readFileSync(path.join(root, relative), "utf8");
      const updated = setFrontmatterVersion(original, release.version);
      if (updated !== original) write(relative, updated);
    }
    write(release.changelogPath, release.changelog);
  }
  return [...written].toSorted((left, right) => left.localeCompare(right));
}

// ── gates ──────────────────────────────────────────────────────────────────

function runGates(files, root, { withTests }) {
  const run = (command, args = []) => execFileSync(command, args, { cwd: root, stdio: "inherit" });
  run("./node_modules/.bin/prettier", ["--write", "--log-level", "warn", ...files]);
  run("./scripts/check.sh");
  if (withTests) run("./scripts/test.sh");
}

/** Build the pending release in a throwaway worktree and gate it; the checkout is untouched. */
export function checkRelease({
  root = REPO_ROOT,
  gate = (files, dir) => runGates(files, dir, { withTests: false }),
} = {}) {
  const git = gitIn(root);
  const plan = planRelease({ root, git });
  if (plan.releases.length === 0) return plan;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "orkest-release-check-"));
  const worktree = path.join(scratch, "tree");
  git(["worktree", "add", "--detach", "--quiet", worktree, plan.head]);
  try {
    const modules = path.join(root, "node_modules");
    if (fs.existsSync(modules)) fs.symlinkSync(modules, path.join(worktree, "node_modules"), "dir");
    gate(writeRelease(plan, worktree), worktree);
    return plan;
  } finally {
    git(["worktree", "remove", "--force", worktree]);
    fs.rmSync(scratch, { force: true, recursive: true });
  }
}

// ── publishing ─────────────────────────────────────────────────────────────

export function publishSettings(env, head) {
  const problems = [];
  if (env.GITHUB_ACTIONS !== "true" || env.GITHUB_SERVER_URL !== "https://github.com") {
    problems.push("not running in GitHub Actions on github.com");
  }
  if (!/^[\w.-]+\/[\w.-]+$/u.test(env.GITHUB_REPOSITORY ?? ""))
    problems.push("no GITHUB_REPOSITORY");
  if (env.GITHUB_EVENT_NAME !== "push") problems.push("the workflow was not started by a push");
  if (!env.DEFAULT_BRANCH || env.GITHUB_REF !== `refs/heads/${env.DEFAULT_BRANCH}`) {
    problems.push("the push was not to the default branch");
  }
  if (env.GITHUB_SHA !== head) problems.push("the checkout is not the commit that was tested");
  const token = env.RELEASE_TOKEN || env.GITHUB_TOKEN;
  if (!token) problems.push("no GITHUB_TOKEN or RELEASE_TOKEN");
  if (problems.length > 0) throw new Error(`Refusing to publish: ${problems.join("; ")}.`);
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    branch: env.DEFAULT_BRANCH,
    gitEnv: {
      ...env,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
      GIT_TERMINAL_PROMPT: "0",
    },
    remote: `https://github.com/${env.GITHUB_REPOSITORY}.git`,
    repository: env.GITHUB_REPOSITORY,
    token,
  };
}

export async function createGitHubReleases(
  releases,
  commit,
  { repository, token, request = fetch },
) {
  const api = `https://api.github.com/repos/${repository}/releases`;
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  for (const release of releases) {
    const lookup = await request(`${api}/tags/${encodeURIComponent(release.tag)}`, { headers });
    if (lookup.ok) continue;
    if (lookup.status !== 404)
      throw new Error(`GitHub release lookup for ${release.tag}: HTTP ${lookup.status}`);
    const created = await request(api, {
      body: JSON.stringify({
        body: release.notes,
        name: `Orkest ${release.version}`,
        tag_name: release.tag,
        target_commitish: commit,
      }),
      headers: { ...headers, "Content-Type": "application/json" },
      method: "POST",
    });
    if (!created.ok) {
      throw new Error(
        `Creating the GitHub release ${release.tag} failed: HTTP ${created.status}. Rerun the job to retry.`,
      );
    }
  }
}

/** The release commit already pushed for `head`, when a previous run got that far. */
function existingReleaseCommit(git, head, remoteHead) {
  const commits = git(["rev-list", "--first-parent", `${head}..${remoteHead}`]);
  for (const commit of commits.split("\n")) {
    if (!commit) continue;
    const message = git(["show", "-s", "--format=%B", commit]);
    if (git(["rev-parse", `${commit}^`]) === head && message.includes(`${TRAILER}: ${head}`)) {
      return commit;
    }
  }
  return null;
}

function releasesIn(git, commit) {
  const tags = git(["tag", "--points-at", commit]).split("\n").filter(Boolean);
  return tags
    .filter((tag) => PRODUCT_TAG.test(tag))
    .map((tag) => {
      const version = PRODUCT_TAG.exec(tag)[1];
      const changelog = fileAt(git, commit, CHANGELOG) ?? "";
      const section = sections(changelog).find(({ heading }) => heading === version);
      const notes = section
        ? changelog
            .slice(section.at, section.end)
            .replace(/^## .*\n/u, "")
            .trim()
        : "";
      return { name: "orkest", notes, tag, version };
    });
}

export async function publishRelease({
  root = REPO_ROOT,
  env = process.env,
  gate = (files, dir) => runGates(files, dir, { withTests: false }),
  request = fetch,
  remote,
} = {}) {
  const head = gitIn(root)(["rev-parse", "HEAD"]);
  const settings = publishSettings(env, head);
  const git = gitIn(root, settings.gitEnv);
  if (git(["status", "--porcelain", "--untracked-files=all"])) {
    throw new Error("The checkout has local changes; publish from a clean checkout.");
  }
  const origin = remote ?? settings.remote;
  const tracking = `refs/release-remote/${settings.branch}`;
  git(["fetch", "--quiet", "--no-tags", origin, `+refs/heads/${settings.branch}:${tracking}`]);
  git(["fetch", "--quiet", "--no-tags", origin, "+refs/tags/*:refs/tags/*"]);
  const remoteHead = git(["rev-parse", tracking]);

  if (remoteHead !== head) {
    if (!isAncestor(git, head, remoteHead)) {
      throw new Error("The default branch no longer contains the tested commit.");
    }
    const released = existingReleaseCommit(git, head, remoteHead);
    if (!released) return "The default branch has moved on; the newer run will publish.";
    const existing = releasesIn(git, released);
    recordReleaseOutput(existing, env);
    await createGitHubReleases(existing, released, { ...settings, request });
    return `Already released ${head.slice(0, 7)}; GitHub releases are in place.`;
  }

  const plan = planRelease({ root, git, head });
  if (plan.releases.length === 0) return "Nothing to release.";
  const files = writeRelease(plan, root);
  gate(files, root);
  const dirty = git(["status", "--porcelain", "--untracked-files=all"])
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3));
  const unexpected = dirty.filter((file) => !files.includes(file));
  if (unexpected.length > 0) {
    throw new Error(`The gates changed files the release does not own: ${unexpected.join(", ")}`);
  }
  git(["add", "--", ...files]);
  git([
    "-c",
    "user.name=github-actions[bot]",
    "-c",
    "user.email=41898282+github-actions[bot]@users.noreply.github.com",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    RELEASE_SUBJECT,
    "-m",
    `${plan.releases.map((release) => `- ${release.tag}`).join("\n")}\n\n[skip ci]`,
    "-m",
    `${TRAILER}: ${head}`,
  ]);
  const commit = git(["rev-parse", "HEAD"]);
  for (const release of plan.releases) git(["tag", release.tag, commit]);
  // Branch and tags land together or not at all, so no version is ever published untagged.
  git([
    "push",
    "--atomic",
    "--quiet",
    origin,
    `${commit}:refs/heads/${settings.branch}`,
    ...plan.releases.map((release) => `refs/tags/${release.tag}`),
  ]);
  recordReleaseOutput(plan.releases, env);
  await createGitHubReleases(plan.releases, commit, { ...settings, request });
  return `Released ${plan.releases.map((release) => release.tag).join(", ")}.`;
}

// ── command line ───────────────────────────────────────────────────────────

function summary(plan) {
  const releases = plan.releases.map(({ name, previous, version, tag, notes }) => ({
    name,
    notes,
    previous,
    tag,
    version,
  }));
  return JSON.stringify({ head: plan.head, releases }, null, 2);
}

async function main(command) {
  if (command === "plan") return summary(planRelease());
  if (command === "check") return summary(checkRelease());
  if (command === "publish") return publishRelease();
  throw new Error("usage: node scripts/release.js plan|check|publish");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  try {
    console.log(await main(process.argv[2]));
  } catch (error) {
    console.error(`release: ${error.message}`);
    process.exitCode = 1;
  }
}
