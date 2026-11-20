import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { probeTimeoutError } from "./adaptive-probes.mjs";
export function expandHome(p) {
  if (typeof p !== "string") return p;
  if (p === "~") return homedir();
  return p.startsWith("~/") ? path.join(homedir(), p.slice(2)) : p;
}

const FALLBACK_DIRS = [
  "~/.local/bin",
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "~/.volta/bin",
  "~/.bun/bin",
  "/usr/bin",
  "/bin",
];

// GUI launches (the menu bar app, launchd) get a bare PATH, so fall back to the usual install locations.
export function resolveBinary(name, override) {
  if (override) return expandHome(override);
  const dirs = [
    ...(process.env.PATH ?? "").split(path.delimiter),
    ...FALLBACK_DIRS.map(expandHome),
  ];
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here or not executable: try the next directory.
    }
  }
  throw new Error(`${name} not found on PATH or in ${FALLBACK_DIRS.join(", ")}`);
}

export function childEnv(extra = {}, { strip = [] } = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (strip.some((pattern) => (pattern instanceof RegExp ? pattern.test(key) : pattern === key)))
      delete env[key];
  }
  const fallbackPath = FALLBACK_DIRS.map(expandHome).join(path.delimiter);
  env.PATH = env.PATH ? `${env.PATH}${path.delimiter}${fallbackPath}` : fallbackPath;
  for (const [key, value] of Object.entries(extra)) {
    if (value === null) delete env[key];
    else env[key] = expandHome(String(value));
  }
  return env;
}

export function run(
  cmd,
  args,
  { env, timeoutMs = 60_000, maxBytes = 4 * 1024 * 1024, cwd, abortOnOutput } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env,
      cwd: cwd ?? homedir(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const onExit = () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Child already exited.
      }
    };
    process.on("exit", onExit);
    let stdout = "";
    let stderr = "";
    let isKilledForSize = false;
    let isSettled = false;
    const cleanup = () => {
      clearTimeout(timer);
      process.off("exit", onExit);
    };
    const abortInteractive = () => {
      if (isSettled) return;
      isSettled = true;
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.kill("SIGKILL");
      cleanup();
      reject(new Error(`${cmd} requires interactive authentication`));
    };
    const timer = setTimeout(() => {
      if (isSettled) return;
      isSettled = true;
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.kill("SIGKILL");
      cleanup();
      reject(probeTimeoutError(`${cmd} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      if (isSettled || isKilledForSize) return;
      stdout += d;
      if (abortOnOutput instanceof RegExp && abortOnOutput.test(stdout)) {
        abortInteractive();
        return;
      }
      if (stdout.length <= maxBytes) return;
      isKilledForSize = true;
      child.stdout.destroy();
      child.stderr.destroy();
      child.kill("SIGKILL");
    });
    child.stderr.on("data", (d) => {
      if (isSettled) return;
      if (stderr.length < 64 * 1024) stderr += d;
      if (abortOnOutput instanceof RegExp && abortOnOutput.test(stderr)) {
        abortInteractive();
      }
    });
    child.on("error", (err) => {
      if (isSettled) return;
      isSettled = true;
      cleanup();
      reject(err);
    });
    child.on("close", (code) => {
      if (isSettled) return;
      isSettled = true;
      cleanup();
      resolve({ code, stdout, stderr });
    });
  });
}
