import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  statSync,
  symlinkSync,
} from "node:fs";
import path from "node:path";

import { listWorktreePorts } from "./worktree-ports.mjs";

const ENV_TEMPLATE_FILE = /^\.env\.(?:defaults|dist|example|sample|schema|template)(?:\..+)?$/iu;
const ROOT_ENV_FILE = /^\.env(?:\.[^/]+)?$/u;

function globToRegExp(globPattern) {
  let regexStr = "^";
  for (let index = 0; index < globPattern.length; index += 1) {
    const ch = globPattern[index];
    if (ch === "*") {
      if (globPattern[index + 1] === "*") {
        regexStr += ".*";
        index += 1;
      } else {
        regexStr += "[^/]*";
      }
    } else if (ch === "?") {
      regexStr += "[^/]";
    } else if (".+^${}()|[]\\".includes(ch)) {
      regexStr += `\\${ch}`;
    } else {
      regexStr += ch;
    }
  }
  regexStr += "$";
  return new RegExp(regexStr, "u");
}

function normalizeWorktreePattern(rawPath) {
  if (typeof rawPath !== "string") return "";
  const slashPath = rawPath.replaceAll("\\", "/").trim();
  if (!slashPath || slashPath.startsWith("/")) return "";
  const normalized = path.posix
    .normalize(slashPath)
    .replaceAll(/^(?:\.\/)+/gu, "")
    .replaceAll(/\/+$/gu, "");
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized === ".git" ||
    normalized.startsWith(".git/")
  ) {
    return "";
  }
  return normalized;
}

function isWithinRealRoot(realRoot, targetPath) {
  const rel = path.relative(realRoot, targetPath);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function listRelativeFilesRecursive(rootDir, realRoot, currentRel = "") {
  const absDir = currentRel ? path.join(rootDir, currentRel) : rootDir;
  let entries;
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const relPath = currentRel ? `${currentRel}/${entry.name}` : entry.name;
    const entryPath = path.join(rootDir, relPath);
    if (entry.isSymbolicLink()) {
      try {
        const realTarget = realpathSync(entryPath);
        if (isWithinRealRoot(realRoot, realTarget) && statSync(realTarget).isFile()) {
          files.push(relPath);
        }
      } catch {
        /* Ignore broken or unreadable symlinks. */
      }
      continue;
    }
    if (entry.isDirectory()) {
      files.push(...listRelativeFilesRecursive(rootDir, realRoot, relPath));
    } else if (entry.isFile()) {
      files.push(relPath);
    }
  }
  return files;
}

function resolveTrackedFilesSet(repoRoot) {
  try {
    const out = execFileSync("git", ["ls-files"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return new Set(
      out
        .split(/\r?\n/u)
        .map((line) => normalizeWorktreePattern(line))
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

function parseWorktreeInclude(includeFile) {
  if (!existsSync(includeFile)) return { excludeMatchers: [], includePatterns: [] };
  const includePatterns = [];
  const excludeMatchers = [];
  const rawLines = readFileSync(includeFile, "utf8").split(/\r?\n/u);
  for (const rawLine of rawLines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("!")) {
      const negated = normalizeWorktreePattern(trimmed.slice(1));
      if (negated) excludeMatchers.push(globToRegExp(negated));
      continue;
    }
    const normalized = normalizeWorktreePattern(trimmed);
    if (normalized) includePatterns.push(normalized);
  }
  return { excludeMatchers, includePatterns };
}

function collectDefaultRootEnvFiles(resolvedRoot, realRoot, trackedSet) {
  let entries;
  try {
    entries = readdirSync(resolvedRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const name = entry.name;
    if (!ROOT_ENV_FILE.test(name) || ENV_TEMPLATE_FILE.test(name) || trackedSet.has(name)) {
      continue;
    }
    const candidatePath = path.join(resolvedRoot, name);
    try {
      const realTarget = realpathSync(candidatePath);
      if (isWithinRealRoot(realRoot, realTarget) && statSync(realTarget).isFile()) {
        files.push(name);
      }
    } catch {
      /* Ignore broken or unreadable candidates. */
    }
  }
  return files;
}

function isSensitiveEnvFile(relFile) {
  const base = path.posix.basename(relFile);
  return ROOT_ENV_FILE.test(base) && !ENV_TEMPLATE_FILE.test(base);
}

/**
 * Create `target` below `realRoot` one component at a time, refusing any symlinked or
 * non-directory component so nothing is created outside the worktree.
 */
function ensureContainedDirectory(realRoot, target) {
  const rel = path.relative(realRoot, path.resolve(target));
  if (rel.startsWith("..") || path.isAbsolute(rel)) return false;
  let current = realRoot;
  const parts = rel.split(path.sep).filter(Boolean);
  for (const part of parts) {
    current = path.join(current, part);
    let info;
    try {
      info = lstatSync(current);
    } catch (error) {
      if (error.code !== "ENOENT") return false;
      try {
        mkdirSync(current);
      } catch (mkdirError) {
        if (mkdirError.code !== "EEXIST") return false;
      }
      info = lstatSync(current);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) return false;
  }
  return isWithinRealRoot(realRoot, realpathSync(current));
}

/** Sorted, exclusion-filtered relative paths that an include pass would consider copying. */
function collectIncludeCandidates(resolvedRoot, realRoot, extraIncludes) {
  const trackedSet = resolveTrackedFilesSet(resolvedRoot);
  const includeFile = path.join(resolvedRoot, ".worktreeinclude");
  const { excludeMatchers, includePatterns } = parseWorktreeInclude(includeFile);
  // Configured copyFiles compose with .worktreeinclude; the file's exclusions still win below.
  for (const extra of extraIncludes) {
    const normalized = normalizeWorktreePattern(extra);
    if (normalized && !includePatterns.includes(normalized)) includePatterns.push(normalized);
  }

  const candidateFiles = new Set(collectDefaultRootEnvFiles(resolvedRoot, realRoot, trackedSet));
  let allFiles = null;

  for (const pattern of includePatterns) {
    if (/[*?[\]]/u.test(pattern)) {
      allFiles ??= listRelativeFilesRecursive(resolvedRoot, realRoot);
      const matcher = globToRegExp(pattern);
      for (const relFile of allFiles) {
        if (matcher.test(relFile) && !trackedSet.has(relFile)) {
          candidateFiles.add(relFile);
        }
      }
      continue;
    }

    const sourcePath = path.join(resolvedRoot, pattern);
    if (!existsSync(sourcePath)) continue;
    try {
      const realTarget = realpathSync(sourcePath);
      if (!isWithinRealRoot(realRoot, realTarget)) continue;
      const info = statSync(realTarget);
      if (info.isDirectory()) {
        for (const relFile of listRelativeFilesRecursive(resolvedRoot, realRoot, pattern)) {
          if (!trackedSet.has(relFile)) candidateFiles.add(relFile);
        }
      } else if (info.isFile() && !trackedSet.has(pattern)) {
        candidateFiles.add(pattern);
      }
    } catch {
      /* Ignore unreadable candidate paths. */
    }
  }

  return candidateFiles
    .values()
    .filter((relFile) => excludeMatchers.every((matcher) => !matcher.test(relFile)))
    .toArray()
    .sort((left, right) => left.localeCompare(right));
}

/**
 * Copies untracked local `.env*` files and `<repoRoot>/.worktreeinclude` patterns
 * from `repoRoot` into `worktreePath` while enforcing path and symlink containment.
 */
export function bootstrapWorktreeInclude(
  repoRoot,
  worktreePath,
  { overwrite = true, extraIncludes = [] } = {},
) {
  if (!repoRoot || !worktreePath) return [];
  const resolvedRoot = path.resolve(repoRoot);
  const resolvedWorktree = path.resolve(worktreePath);
  if (!existsSync(resolvedRoot) || !existsSync(resolvedWorktree)) return [];

  const realRoot = realpathSync(resolvedRoot);
  const realWorktree = realpathSync(resolvedWorktree);
  if (realRoot === realWorktree) return [];

  const sortedFiles = collectIncludeCandidates(resolvedRoot, realRoot, extraIncludes);

  const copied = [];
  for (const relFile of sortedFiles) {
    if (relFile === ".git" || relFile.startsWith(".git/") || relFile.startsWith("..")) continue;
    const src = path.join(resolvedRoot, relFile);
    const dest = path.join(realWorktree, relFile);
    if (
      path.relative(resolvedRoot, src).startsWith("..") ||
      path.relative(realWorktree, dest).startsWith("..")
    ) {
      continue;
    }
    let realSrc;
    try {
      realSrc = realpathSync(src);
      if (!isWithinRealRoot(realRoot, realSrc) || !statSync(realSrc).isFile()) continue;
    } catch {
      continue;
    }
    if (!overwrite && existsSync(dest)) continue;
    try {
      const destInfo = lstatSync(dest);
      if (destInfo.isSymbolicLink()) continue;
      // Writing through a hard link would rewrite the other names for the same inode.
      if (destInfo.isFile() && destInfo.nlink > 1) continue;
    } catch (error) {
      if (error.code !== "ENOENT") continue;
    }
    if (!ensureContainedDirectory(realWorktree, path.dirname(dest))) continue;
    const realDestParent = realpathSync(path.dirname(dest));
    if (!isWithinRealRoot(realWorktree, realDestParent)) continue;
    try {
      copyFileSync(realSrc, dest, overwrite ? 0 : fsConstants.COPYFILE_EXCL);
    } catch (error) {
      if (error.code === "EEXIST") continue;
      throw error;
    }
    if (isSensitiveEnvFile(relFile)) {
      chmodSync(dest, 0o600);
    }
    copied.push(relFile);
  }
  return copied;
}

// --- .orkest/worktree.json -------------------------------------------------------------------

export const WORKTREE_CONFIG_MAX_BYTES = 64 * 1024;
export const DEFAULT_PORT_RANGE_START = 31_000;
export const DEFAULT_PORT_RANGE_END = 49_151;
const MIN_PORT = 1024;
const MAX_PORT = 49_151;
const CONFIG_KEYS = new Set(["version", "symlinkDirs", "copyFiles", "setupCommand", "ports"]);
const PORT_KEYS = new Set(["names", "rangeStart", "rangeEnd"]);
const FORBIDDEN_SEGMENTS = new Set([".", "..", ".git", ".worktrees", ".orkest"]);
const MAX_LIST = 64;
const MAX_PATH_LENGTH = 256;
const MAX_ARGV = 32;
const MAX_ARG_LENGTH = 1024;
const MAX_PORT_NAMES = 16;

// App-level variable names only. Anything that steers loaders, runtimes or the harness is refused.
const PORT_NAME = /^[A-Z][A-Z0-9_]{0,31}$/u;
const RESERVED_PORT_NAME =
  /^(?:PATH|HOME|USER|LOGNAME|SHELL|PWD|OLDPWD|IFS|ENV|BASH_ENV|CDPATH|TERM|TZ|TMPDIR|TEMP|TMP|LANG|LC_[A-Z0-9_]*|LD_[A-Z0-9_]*|DYLD_[A-Z0-9_]*|NODE_[A-Z0-9_]*|NPM_[A-Z0-9_]*|PYTHON[A-Z0-9_]*|RUBY[A-Z0-9_]*|PERL[A-Z0-9_]*|JAVA[A-Z0-9_]*|GIT_[A-Z0-9_]*|SSH_[A-Z0-9_]*|ORKEST_[A-Z0-9_]*|ORCHESTRATE_[A-Z0-9_]*|AGENT_[A-Z0-9_]*|CLAUDE[A-Z0-9_]*|CODEX[A-Z0-9_]*|GEMINI[A-Z0-9_]*|ANTIGRAVITY[A-Z0-9_]*|OPENCODE[A-Z0-9_]*|XDG_[A-Z0-9_]*|AWS_[A-Z0-9_]*|[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY)[A-Z0-9_]*)$/u;

function configError(code, message, substage = "config", cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  error.stage = "bootstrap";
  error.substage = substage;
  return error;
}

export function isValidPortName(name) {
  return typeof name === "string" && PORT_NAME.test(name) && !RESERVED_PORT_NAME.test(name);
}

export function assertValidPortNames(names, { substage = "config" } = {}) {
  if (!Array.isArray(names) || names.length === 0 || names.length > MAX_PORT_NAMES) {
    throw configError(
      "ORK_WORKTREE_CONFIG_INVALID",
      `ports.names must list 1-${MAX_PORT_NAMES} names`,
      substage,
    );
  }
  const seen = new Set();
  for (const name of names) {
    if (!isValidPortName(name)) {
      throw configError(
        "ORK_WORKTREE_CONFIG_INVALID",
        `Port name ${JSON.stringify(name)} must match ${PORT_NAME} and not be a reserved variable`,
        substage,
      );
    }
    if (seen.has(name)) {
      throw configError("ORK_WORKTREE_CONFIG_INVALID", `Duplicate port name ${name}`, substage);
    }
    seen.add(name);
  }
  return names;
}

export function assertPortRange(rangeStart, rangeEnd, { substage = "config" } = {}) {
  for (const value of [rangeStart, rangeEnd]) {
    if (!Number.isSafeInteger(value) || value < MIN_PORT || value > MAX_PORT) {
      throw configError(
        "ORK_WORKTREE_CONFIG_INVALID",
        `Port range must be integers within ${MIN_PORT}..${MAX_PORT}`,
        substage,
      );
    }
  }
  if (rangeStart > rangeEnd) {
    throw configError(
      "ORK_WORKTREE_CONFIG_INVALID",
      "rangeStart must not exceed rangeEnd",
      substage,
    );
  }
}

function validateLiteralPath(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PATH_LENGTH) {
    throw configError("ORK_WORKTREE_CONFIG_INVALID", `${label} entries must be short strings`);
  }
  if (
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /[*?[\]{}!]/u.test(value) ||
    path.posix.normalize(value) !== value
  ) {
    throw configError(
      "ORK_WORKTREE_CONFIG_INVALID",
      `${label} entry ${JSON.stringify(value)} must be a normalized relative literal path`,
    );
  }
  for (const segment of value.split("/")) {
    if (!segment || FORBIDDEN_SEGMENTS.has(segment)) {
      throw configError(
        "ORK_WORKTREE_CONFIG_INVALID",
        `${label} entry ${JSON.stringify(value)} uses a forbidden path component`,
      );
    }
  }
  return value;
}

function validatePathList(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_LIST) {
    throw configError(
      "ORK_WORKTREE_CONFIG_INVALID",
      `${label} must be a list of up to ${MAX_LIST}`,
    );
  }
  const seen = new Set();
  for (const entry of value) {
    validateLiteralPath(entry, label);
    if (seen.has(entry)) {
      throw configError("ORK_WORKTREE_CONFIG_INVALID", `${label} repeats ${JSON.stringify(entry)}`);
    }
    seen.add(entry);
  }
  return [...value];
}

function overlaps(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

/** Validate parsed config JSON; exported so tests and the trust CLI share one shape. */
export function validateWorktreeConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw configError("ORK_WORKTREE_CONFIG_INVALID", "Worktree config must be a JSON object");
  }
  for (const key of Object.keys(raw)) {
    if (!CONFIG_KEYS.has(key)) {
      throw configError("ORK_WORKTREE_CONFIG_INVALID", `Unknown worktree config key: ${key}`);
    }
  }
  if (raw.version !== 1) {
    throw configError("ORK_WORKTREE_CONFIG_INVALID", "Worktree config version must be 1");
  }
  const symlinkDirs = validatePathList(raw.symlinkDirs, "symlinkDirs");
  const copyFiles = validatePathList(raw.copyFiles, "copyFiles");
  for (const dir of symlinkDirs) {
    for (const other of [...symlinkDirs.filter((item) => item !== dir), ...copyFiles]) {
      if (overlaps(dir, other)) {
        throw configError(
          "ORK_WORKTREE_CONFIG_INVALID",
          `${JSON.stringify(dir)} overlaps ${JSON.stringify(other)}`,
        );
      }
    }
  }
  let setupCommand = null;
  if (raw.setupCommand !== undefined) {
    const argv = raw.setupCommand;
    if (
      !Array.isArray(argv) ||
      argv.length === 0 ||
      argv.length > MAX_ARGV ||
      argv.some(
        (item) => typeof item !== "string" || item.length > MAX_ARG_LENGTH || item.includes("\0"),
      ) ||
      argv[0] === ""
    ) {
      throw configError(
        "ORK_WORKTREE_CONFIG_INVALID",
        `setupCommand must be an argv array of 1-${MAX_ARGV} strings`,
      );
    }
    setupCommand = [...argv];
  }
  let ports = null;
  if (raw.ports !== undefined) {
    if (!raw.ports || typeof raw.ports !== "object" || Array.isArray(raw.ports)) {
      throw configError("ORK_WORKTREE_CONFIG_INVALID", "ports must be an object");
    }
    for (const key of Object.keys(raw.ports)) {
      if (!PORT_KEYS.has(key)) {
        throw configError("ORK_WORKTREE_CONFIG_INVALID", `Unknown ports key: ${key}`);
      }
    }
    const names = assertValidPortNames(raw.ports.names);
    const rangeStart = raw.ports.rangeStart ?? DEFAULT_PORT_RANGE_START;
    const rangeEnd = raw.ports.rangeEnd ?? DEFAULT_PORT_RANGE_END;
    assertPortRange(rangeStart, rangeEnd);
    if (rangeEnd - rangeStart + 1 < names.length) {
      throw configError("ORK_WORKTREE_CONFIG_INVALID", "Port range is smaller than the name list");
    }
    ports = { names: [...names], rangeStart, rangeEnd };
  }
  return { version: 1, symlinkDirs, copyFiles, setupCommand, ports };
}

function readBoundedConfig(configPath) {
  let fd;
  try {
    fd = openSync(configPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    throw configError(
      "ORK_WORKTREE_CONFIG_UNSAFE",
      `Cannot read worktree config safely: ${error.code || error.message}`,
      "config",
      error,
    );
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) {
      throw configError("ORK_WORKTREE_CONFIG_UNSAFE", "Worktree config is not a regular file");
    }
    if (info.size > WORKTREE_CONFIG_MAX_BYTES) {
      throw configError(
        "ORK_WORKTREE_CONFIG_INVALID",
        `Worktree config exceeds ${WORKTREE_CONFIG_MAX_BYTES} bytes`,
      );
    }
    const buffer = Buffer.alloc(WORKTREE_CONFIG_MAX_BYTES + 1);
    let length = 0;
    for (;;) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
      if (length > WORKTREE_CONFIG_MAX_BYTES) {
        throw configError("ORK_WORKTREE_CONFIG_INVALID", "Worktree config is too large");
      }
    }
    const after = lstatSync(configPath);
    if (after.ino !== info.ino || after.dev !== info.dev) {
      throw configError("ORK_WORKTREE_CONFIG_UNSAFE", "Worktree config was replaced while reading");
    }
    return buffer.subarray(0, length);
  } finally {
    closeSync(fd);
  }
}

/**
 * Read `.orkest/worktree.json` from the main checkout. A missing file means legacy defaults.
 * Returns the validated config plus the SHA-256 of the exact bytes that were read.
 */
export function parseWorktreeConfig(repoRoot) {
  const canonicalRepo = realpathSync(path.resolve(repoRoot));
  const defaults = {
    version: 1,
    symlinkDirs: [],
    copyFiles: [],
    setupCommand: null,
    ports: null,
  };
  const directory = path.join(canonicalRepo, ".orkest");
  let directoryInfo;
  try {
    directoryInfo = lstatSync(directory);
  } catch (error) {
    if (error.code === "ENOENT") {
      return { present: false, repoRoot: canonicalRepo, sha256: null, config: defaults };
    }
    throw configError(
      "ORK_WORKTREE_CONFIG_UNSAFE",
      `Cannot inspect ${directory}: ${error.message}`,
    );
  }
  if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
    throw configError("ORK_WORKTREE_CONFIG_UNSAFE", `${directory} must be a real directory`);
  }
  const configPath = path.join(directory, "worktree.json");
  let fileInfo;
  try {
    fileInfo = lstatSync(configPath);
  } catch (error) {
    if (error.code === "ENOENT") {
      return { present: false, repoRoot: canonicalRepo, sha256: null, config: defaults };
    }
    throw configError(
      "ORK_WORKTREE_CONFIG_UNSAFE",
      `Cannot inspect ${configPath}: ${error.message}`,
    );
  }
  if (fileInfo.isSymbolicLink()) {
    throw configError("ORK_WORKTREE_CONFIG_UNSAFE", `${configPath} must not be a symlink`);
  }
  const bytes = readBoundedConfig(configPath);
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw configError(
      "ORK_WORKTREE_CONFIG_INVALID",
      `Worktree config is not valid JSON: ${error.message}`,
      "config",
      error,
    );
  }
  return {
    present: true,
    repoRoot: canonicalRepo,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    config: validateWorktreeConfig(parsed),
  };
}

function git(cwd, args) {
  try {
    return {
      status: 0,
      stdout: execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    };
  } catch (error) {
    return { status: error.status ?? 1, stdout: error.stdout?.toString() ?? "" };
  }
}

/**
 * Check every configured link before anything is created: tracked paths are refused, and the
 * generated link (a non-directory entry) must be ignored by the repository's own rules.
 */
export function previewWorktreeLinks(repoRoot, worktreePath, symlinkDirs) {
  for (const rel of symlinkDirs) {
    const tracked = git(worktreePath, ["ls-files", "--", rel]);
    const trackedMain = git(repoRoot, ["ls-files", "--", rel]);
    if (tracked.stdout.trim() || trackedMain.stdout.trim()) {
      throw configError(
        "ORK_WORKTREE_LINK_TRACKED",
        `symlinkDirs path ${rel} is tracked by Git; refusing to replace tracked content with a link`,
        "link",
      );
    }
    // A symlink is not a directory to Git, so a `name/` pattern would not hide it.
    const ignored = git(worktreePath, ["check-ignore", "-q", "--no-index", "--", rel]);
    if (ignored.status !== 0) {
      throw configError(
        "ORK_WORKTREE_LINK_NOT_IGNORED",
        `The link ${rel} would show up as untracked. Add the repo-local ignore pattern "/${rel}" (without a trailing slash) to .gitignore, then retry.`,
        "link",
      );
    }
  }
}

function isSameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

/** Create the link, or confirm an existing one already points at the same directory. */
function ensureLink(dest, sourceReal, rel) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let existing = null;
    try {
      existing = lstatSync(dest);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (!existing) {
      try {
        symlinkSync(sourceReal, dest, "dir");
        return "linked";
      } catch (error) {
        if (error.code === "EEXIST") continue; // Lost a race; re-evaluate what is there now.
        throw error;
      }
    }
    if (existing.isSymbolicLink() && isReusableLink(dest, sourceReal)) return "reused";
    break;
  }
  throw configError(
    "ORK_WORKTREE_LINK_CONFLICT",
    `${rel} already exists in the worktree and is not the expected link; leaving it untouched`,
    "link",
  );
}

function isReusableLink(dest, sourceReal) {
  try {
    readlinkSync(dest);
    return (
      realpathSync(dest) === sourceReal && isSameIdentity(statSync(dest), statSync(sourceReal))
    );
  } catch {
    return false;
  }
}

/** Create or verify the configured links. Never overwrites existing user content. */
export function linkWorktreeDirs(repoRoot, worktreePath, symlinkDirs) {
  const realRoot = realpathSync(path.resolve(repoRoot));
  const realWorktree = realpathSync(path.resolve(worktreePath));
  const results = [];
  for (const rel of symlinkDirs) {
    const sourcePath = path.join(realRoot, rel);
    let sourceReal;
    try {
      const sourceLstat = lstatSync(sourcePath);
      if (sourceLstat.isSymbolicLink()) {
        throw configError(
          "ORK_WORKTREE_LINK_UNSAFE",
          `${rel} in the main checkout is a symlink`,
          "link",
        );
      }
      sourceReal = realpathSync(sourcePath);
    } catch (error) {
      if (error.code === "ENOENT") {
        results.push({ path: rel, status: "skipped-missing" });
        continue;
      }
      throw error;
    }
    if (!isWithinRealRoot(realRoot, sourceReal) || !statSync(sourceReal).isDirectory()) {
      throw configError(
        "ORK_WORKTREE_LINK_UNSAFE",
        `${rel} in the main checkout is not a directory inside it`,
        "link",
      );
    }
    const dest = path.join(realWorktree, rel);
    if (!ensureContainedDirectory(realWorktree, path.dirname(dest))) {
      throw configError(
        "ORK_WORKTREE_LINK_UNSAFE",
        `The parent of ${rel} is not a plain directory inside the worktree`,
        "link",
      );
    }
    const status = ensureLink(dest, sourceReal, rel);
    results.push({ path: rel, status });
  }
  return results;
}

/**
 * Only the variables a worktree's allocated ports contribute: each validated port name plus
 * `ORKEST_WORKTREE_PORTS` (JSON). Empty when nothing is allocated or the database is unreadable.
 * Callers that assemble a launch env elsewhere merge this object into it.
 */
export function worktreePortEnv({ repoRoot, worktreePath, env = process.env } = {}) {
  if (!repoRoot || !worktreePath) return {};
  let ports;
  try {
    ports = listWorktreePorts({ repoRoot, worktreePath, env });
  } catch {
    return {};
  }
  const valid = ports.filter(({ name }) => isValidPortName(name));
  if (valid.length === 0) return {};
  return {
    ...Object.fromEntries(valid.map(({ name, port }) => [name, String(port)])),
    ORKEST_WORKTREE_PORTS: JSON.stringify(Object.fromEntries(valid.map((p) => [p.name, p.port]))),
  };
}

/** The base env plus the worktree's allocated ports (see `worktreePortEnv`). */
export function worktreeLaunchEnv(baseEnv, { repoRoot, worktreePath } = {}) {
  return { ...baseEnv, ...worktreePortEnv({ repoRoot, worktreePath, env: baseEnv }) };
}

/**
 * The ignored or untracked files a new worktree receives from the main checkout (default `.env*`,
 * `.worktreeinclude`, configured `copyFiles`) with their SHA-256, in a stable order. Setup trust
 * covers these because setup can read them but Git's commit does not attest them.
 */
export function planWorktreeInputs(repoRoot, { extraIncludes = [] } = {}) {
  const resolvedRoot = path.resolve(repoRoot);
  const realRoot = realpathSync(resolvedRoot);
  const inputs = [];
  for (const rel of collectIncludeCandidates(resolvedRoot, realRoot, extraIncludes)) {
    if (rel === ".git" || rel.startsWith(".git/") || rel.startsWith("..")) continue;
    try {
      const realSrc = realpathSync(path.join(resolvedRoot, rel));
      if (!isWithinRealRoot(realRoot, realSrc) || !statSync(realSrc).isFile()) continue;
      inputs.push({
        path: rel,
        sha256: createHash("sha256").update(readFileSync(realSrc)).digest("hex"),
      });
    } catch {
      continue;
    }
  }
  return inputs;
}

/** Hash the same planned paths as they exist inside a worktree (missing files hash as null). */
export function hashWorktreeInputs(worktreePath, planned) {
  const realWorktree = realpathSync(path.resolve(worktreePath));
  return planned.map(({ path: rel }) => {
    try {
      const target = path.join(realWorktree, rel);
      if (!lstatSync(target).isFile()) return { path: rel, sha256: null };
      return {
        path: rel,
        sha256: createHash("sha256").update(readFileSync(target)).digest("hex"),
      };
    } catch {
      return { path: rel, sha256: null };
    }
  });
}
