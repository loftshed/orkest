import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";

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
 * Copies untracked local `.env*` files and `<repoRoot>/.worktreeinclude` patterns
 * from `repoRoot` into `worktreePath` while enforcing path and symlink containment.
 */
export function bootstrapWorktreeInclude(repoRoot, worktreePath, { overwrite = true } = {}) {
  if (!repoRoot || !worktreePath) return [];
  const resolvedRoot = path.resolve(repoRoot);
  const resolvedWorktree = path.resolve(worktreePath);
  if (!existsSync(resolvedRoot) || !existsSync(resolvedWorktree)) return [];

  const realRoot = realpathSync(resolvedRoot);
  const realWorktree = realpathSync(resolvedWorktree);
  if (realRoot === realWorktree) return [];

  const trackedSet = resolveTrackedFilesSet(resolvedRoot);
  const includeFile = path.join(resolvedRoot, ".worktreeinclude");
  const { excludeMatchers, includePatterns } = parseWorktreeInclude(includeFile);

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

  const sortedFiles = candidateFiles
    .values()
    .filter((relFile) => excludeMatchers.every((matcher) => !matcher.test(relFile)))
    .toArray()
    .sort((left, right) => left.localeCompare(right));

  const copied = [];
  for (const relFile of sortedFiles) {
    if (relFile === ".git" || relFile.startsWith(".git/") || relFile.startsWith("..")) continue;
    const src = path.join(resolvedRoot, relFile);
    const dest = path.join(resolvedWorktree, relFile);
    if (
      path.relative(resolvedRoot, src).startsWith("..") ||
      path.relative(resolvedWorktree, dest).startsWith("..")
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
      if (lstatSync(dest).isSymbolicLink()) continue;
    } catch (error) {
      if (error.code !== "ENOENT") continue;
    }
    mkdirSync(path.dirname(dest), { recursive: true });
    const realDestParent = realpathSync(path.dirname(dest));
    if (!isWithinRealRoot(realWorktree, realDestParent)) continue;
    copyFileSync(realSrc, dest);
    if (isSensitiveEnvFile(relFile)) {
      chmodSync(dest, 0o600);
    }
    copied.push(relFile);
  }
  return copied;
}
