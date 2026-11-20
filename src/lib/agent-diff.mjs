import { execFile } from "node:child_process";
import { lstat, readlink, readFile as readText } from "node:fs/promises";
import path from "node:path";

const MAX_DIFF_BYTES = 512 * 1024;
const MAX_DIFF_LINES = 4000;
const MAX_DIFF_FILES = 500;
const GIT_TIMEOUT_MS = 5000;
const GIT_STATUS_MAX_BUFFER = 4 * 1024 * 1024;

function titleFor(agent) {
  return String(agent?.progress?.name || agent?.name || agent?.id || "Agent");
}

function unavailable(agent, text) {
  return {
    agentId: agent?.id,
    title: titleFor(agent),
    kind: "diff",
    loading: false,
    text,
    files: [],
    stale: false,
    available: false,
  };
}

function validGitPath(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\0") ||
    value.startsWith("/") ||
    path.win32.isAbsolute(value)
  )
    return false;
  const segments = value.split("/");
  return segments.every((segment) => segment && segment !== "." && segment !== "..");
}

function literalPathspec(value) {
  return `:(literal)${value}`;
}

function runGit(exec, cwd, args, { allowDiffExit = false, maxBuffer = MAX_DIFF_BYTES + 1 } = {}) {
  const env = {
    ...process.env,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
  };
  return new Promise((resolve, reject) => {
    exec(
      "git",
      args,
      { cwd, env, timeout: GIT_TIMEOUT_MS, maxBuffer },
      (error, stdout = "", stderr = "") => {
        const output = Buffer.isBuffer(stdout) ? stdout.toString("utf8") : String(stdout);
        if (!error || (allowDiffExit && error.code === 1)) {
          resolve({ output, isTruncated: false });
          return;
        }
        if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          const partial = error.stdout;
          const partialOutput = Buffer.isBuffer(partial)
            ? partial.toString("utf8")
            : String(partial || "");
          resolve({
            output: output || partialOutput,
            isTruncated: true,
          });
          return;
        }
        const message = stderr || error.message || "git command failed";
        reject(new Error(String(message)));
      },
    );
  });
}

function parseStatusEntry(entry) {
  if (typeof entry !== "string" || entry.length < 4 || entry[2] !== " ") return null;
  const code = entry.slice(0, 2);
  if (/[RC]/u.test(code)) return null;
  let filePath = entry.slice(3);
  if (filePath.startsWith('"')) {
    try {
      filePath = JSON.parse(filePath);
    } catch {
      return null;
    }
  }
  if (filePath.includes(" -> ")) return null;
  return { code, filePath };
}

function currentStatusMap(output) {
  const result = new Map();
  for (const entry of output.split("\0")) {
    if (!entry) continue;
    if (entry.length < 4 || entry[2] !== " ") return null;
    const code = entry.slice(0, 2);
    if (/[RC]/u.test(code)) return null;
    result.set(entry.slice(3), code);
  }
  return result;
}

function recordedStatusMap(status, candidates) {
  if (!Array.isArray(status)) return null;
  const selected = new Set(candidates);
  const result = new Map();
  for (const entry of status) {
    const parsed = parseStatusEntry(entry);
    if (!parsed) return null;
    if (selected.has(parsed.filePath)) result.set(parsed.filePath, parsed.code);
  }
  return result;
}

function sameMap(left, right) {
  if (!left || !right || left.size !== right.size) return false;
  for (const [key, value] of left) if (right.get(key) !== value) return false;
  return true;
}

function diffCounts(diff) {
  if (/^(?:Binary files .* differ|GIT binary patch)/mu.test(diff))
    return { added: null, removed: null };
  let added = 0;
  let removed = 0;
  let isInHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@")) {
      isInHunk = true;
      continue;
    }
    if (!isInHunk) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

async function untrackedSymlinkDiff(repository, filePath) {
  let current = repository;
  const segments = filePath.split("/");
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    let details;
    try {
      details = await lstat(current);
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
      throw error;
    }
    if (details.isSymbolicLink()) {
      if (index < segments.length - 1) throw new Error("Changed path descends through a symlink");
      const target = await readlink(current);
      const content = target.split("\n").map((line) => `+${line}`);
      if (!target.endsWith("\n")) content.push(String.raw`\ No newline at end of file`);
      return [
        `diff --git a/${filePath} b/${filePath}`,
        "new file mode 120000",
        "--- /dev/null",
        `+++ b/${filePath}`,
        "@@ -0,0 +1 @@",
        ...content,
      ].join("\n");
    }
    if (index < segments.length - 1 && !details.isDirectory())
      throw new Error("Changed path is not a directory");
  }
  return null;
}

function cappedDiff(text, extraOmissions = []) {
  const sourceLines = text.split("\n");
  if (sourceLines.at(-1) === "") sourceLines.pop();
  const shown = [];
  const noticeParts = [...extraOmissions];
  let bytes = 0;
  let isTruncated = false;
  for (const line of sourceLines) {
    const nextBytes = Buffer.byteLength(line, "utf8") + (shown.length > 0 ? 1 : 0);
    if (shown.length >= MAX_DIFF_LINES - 1 || bytes + nextBytes > MAX_DIFF_BYTES - 128) {
      isTruncated = true;
      break;
    }
    shown.push(line);
    bytes += nextBytes;
  }
  if (isTruncated) noticeParts.unshift("diff output");
  if (noticeParts.length > 0) {
    const summary = `[Omitted ${noticeParts.join(" and ")}.]`;
    shown.push(summary);
  }
  return shown.join("\n");
}

/** Read a worker's uncommitted diff without changing its repository or index. */
export async function readAgentDiff(agent, { exec = execFile, readFile = readText } = {}) {
  if (typeof agent?.resultPath !== "string" || !agent.resultPath.trim())
    return unavailable(agent, "No recorded worker result is available for this agent.");

  let result;
  try {
    result = JSON.parse(await readFile(agent.resultPath, "utf8"));
  } catch {
    return unavailable(agent, "The worker result could not be read.");
  }

  const repository = result?.repository;
  if (typeof repository !== "string" || !path.isAbsolute(repository))
    return unavailable(agent, "The worker result does not name an absolute repository path.");
  const changedPaths = result?.run_delta?.changed_paths;
  if (!Array.isArray(changedPaths))
    return unavailable(agent, "The worker result has no changed-path list.");

  const validPaths = changedPaths.filter(validGitPath);
  const allPaths = [...new Set(validPaths)];
  if (allPaths.length === 0 && changedPaths.length > 0)
    return unavailable(agent, "The worker result has no safe changed paths.");

  const paths = allPaths.slice(0, MAX_DIFF_FILES);
  const invalidCount = changedPaths.length - validPaths.length;
  const excessFileCount = allPaths.length - paths.length;
  const omissionNotes = [];
  if (invalidCount > 0) omissionNotes.push(`${invalidCount} invalid paths`);
  if (excessFileCount > 0) omissionNotes.push(`${excessFileCount} files`);

  if (paths.length === 0) {
    return {
      ...unavailable(agent, "No changed paths were recorded for this run."),
      available: true,
    };
  }

  const statusByPath = new Map();
  let isStatusReliable = true;
  try {
    for (let index = 0; index < paths.length; index += 64) {
      const group = paths.slice(index, index + 64);
      const { output } = await runGit(
        exec,
        repository,
        [
          "--no-pager",
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
          "--no-renames",
          "--",
          ...group.map(literalPathspec),
        ],
        { maxBuffer: GIT_STATUS_MAX_BUFFER },
      );
      const current = currentStatusMap(output);
      if (current) {
        for (const [filePath, code] of current) statusByPath.set(filePath, code);
      } else {
        isStatusReliable = false;
      }
    }
  } catch {
    return unavailable(agent, "The worker repository could not be read.");
  }

  const recorded = recordedStatusMap(result.git_after?.status, paths);
  const isStale = Boolean(recorded && isStatusReliable && !sameMap(recorded, statusByPath));
  const files = paths.map((filePath) => ({ path: filePath, added: null, removed: null }));
  const diffs = [];
  let stoppedAt = paths.length;
  let isCommandTruncated = false;
  let collectedBytes = 0;

  for (const [index, filePath] of paths.entries()) {
    const isUntracked = statusByPath.get(filePath) === "??";
    const args = isUntracked
      ? [
          "--no-pager",
          "diff",
          "--no-index",
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
          "--unified=3",
          "--",
          "/dev/null",
          filePath,
        ]
      : [
          "--no-pager",
          "diff",
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
          "--no-renames",
          "--unified=3",
          "HEAD",
          "--",
          literalPathspec(filePath),
        ];
    let response;
    if (isUntracked) {
      try {
        const symlinkDiff = await untrackedSymlinkDiff(repository, filePath);
        if (symlinkDiff !== null) response = { output: symlinkDiff, isTruncated: false };
      } catch {
        return unavailable(agent, "The worker diff includes a path through a symlink.");
      }
    }
    try {
      response ??= await runGit(exec, repository, args, { allowDiffExit: isUntracked });
    } catch {
      return unavailable(agent, "The worker diff could not be read.");
    }
    isCommandTruncated ||= response.isTruncated;
    const diff = response.output;
    const counts = response.isTruncated ? { added: null, removed: null } : diffCounts(diff);
    files[index] = { path: filePath, ...counts };
    if (diff) {
      if (diffs.length > 0) diffs.push("");
      diffs.push(diff.replace(/\n+$/u, ""));
      collectedBytes += Buffer.byteLength(diff, "utf8");
    }
    if (
      response.isTruncated ||
      collectedBytes >= MAX_DIFF_BYTES ||
      diff.split("\n").length >= MAX_DIFF_LINES
    ) {
      stoppedAt = index + 1;
      break;
    }
  }

  if (stoppedAt < paths.length) omissionNotes.push(`${paths.length - stoppedAt} files`);
  if (isCommandTruncated) omissionNotes.push("a file diff");
  const diffText = diffs.join("\n");
  const text = cappedDiff(
    diffText || "No diff is available for the recorded paths.",
    omissionNotes,
  );
  return {
    agentId: agent?.id,
    title: titleFor(agent),
    kind: "diff",
    loading: false,
    text,
    files,
    stale: isStale,
    available: true,
  };
}
