#!/usr/bin/env node
// One bounded child per provision: allocates ports (async bind probes) and runs the approved
// setup argv. The parent has already validated the config and verified trust; this process only
// does the asynchronous work. Input is JSON on stdin, output one JSON object on stdout.
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { allocateWorktreePorts } from "./worktree-ports.mjs";

const MAX_OUTPUT_BYTES = 16 * 1024;
const MAX_STDIN_BYTES = 256 * 1024;

/** A stable per-process start identity, so a recycled PID is not mistaken for the original owner. */
export function processStartIdentity(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const ticks = stat
      .slice(stat.lastIndexOf(")") + 1)
      .trim()
      .split(/\s+/u, 20)[19];
    if (ticks) return `ticks:${ticks}`;
  } catch {
    // No /proc (macOS): fall back to ps.
  }
  try {
    const started = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return started || null;
  } catch {
    return null;
  }
}

/** Record this worker's and the setup process's PIDs in the claim, if the claim is still ours. */
function annotateClaim(claim, patch) {
  if (!claim?.lockPath) return;
  try {
    const current = JSON.parse(readFileSync(claim.lockPath, "utf8"));
    if (current.token !== claim.token) return;
    const temporary = `${claim.lockPath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ ...current, ...patch })}\n`, { mode: 0o600 });
    renameSync(temporary, claim.lockPath);
  } catch {
    // The parent still holds the claim; liveness then falls back to the parent alone.
  }
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    process.stdin.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_STDIN_BYTES) {
        reject(new Error("Worker input too large"));
        process.stdin.destroy();
        return;
      }
      chunks.push(chunk);
    });
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

function substitutePorts(argv, ports) {
  return argv.map((arg) =>
    arg.replaceAll(/\$\{([A-Z][A-Z0-9_]*)\}/gu, (match, name) =>
      Object.hasOwn(ports, name) ? String(ports[name]) : match,
    ),
  );
}

/** Run argv without a shell in its own process group, bounded in time and captured output. */
export function runBounded(argv, { cwd, env, timeoutMs, onSpawn }) {
  return new Promise((resolve) => {
    let tail = Buffer.alloc(0);
    let isTruncated = false;
    let isTimedOut = false;
    let isSettled = false;
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env,
      shell: false,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (child.pid && typeof onSpawn === "function") onSpawn(child.pid);
    const finish = (result) => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timer);
      resolve({ ...result, outputTail: tail.toString("utf8"), truncated: isTruncated });
    };
    const collect = (chunk) => {
      tail = Buffer.concat([tail, chunk]);
      if (!(tail.length > MAX_OUTPUT_BYTES)) {
        return;
      }

      isTruncated = true;
      tail = tail.subarray(tail.length - MAX_OUTPUT_BYTES);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => {
      isTimedOut = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    child.on("error", (error) =>
      finish({
        status: "failed",
        exitCode: null,
        signal: null,
        error: error.code || error.message,
      }),
    );
    child.on("close", (exitCode, signal) => {
      if (isTimedOut) finish({ status: "timeout", exitCode, signal });
      else if (exitCode === 0) finish({ status: "done", exitCode, signal });
      else finish({ status: "failed", exitCode, signal });
    });
  });
}

export async function runWorker(request) {
  const output = { ports: request.knownPorts ?? null, setup: null, error: null };
  annotateClaim(request.claim, {
    workerPid: process.pid,
    workerStart: processStartIdentity(process.pid),
  });
  if (request.ports) {
    try {
      output.ports = await allocateWorktreePorts({
        repoRoot: request.repoRoot,
        worktreePath: request.worktreePath,
        slug: request.slug,
        names: request.ports.names,
        rangeStart: request.ports.rangeStart,
        rangeEnd: request.ports.rangeEnd,
        env: request.env,
      });
    } catch (error) {
      output.error = {
        code: error.code || "ORK_PORTS_FAILED",
        message: error.message,
        substage: "ports",
      };
      return output;
    }
  }
  if (request.setup) {
    const portEnv = Object.fromEntries(
      Object.entries(output.ports ?? {}).map(([name, port]) => [name, String(port)]),
    );
    const childEnv = { ...request.setup.env, ...portEnv };
    if (output.ports) childEnv.ORKEST_WORKTREE_PORTS = JSON.stringify(output.ports);
    output.setup = await runBounded(substitutePorts(request.setup.argv, output.ports ?? {}), {
      cwd: request.worktreePath,
      env: childEnv,
      timeoutMs: request.setup.timeoutMs,
      onSpawn: (pid) =>
        annotateClaim(request.claim, { setupPid: pid, setupStart: processStartIdentity(pid) }),
    });
  }
  return output;
}

async function main() {
  let output;
  try {
    output = await runWorker(JSON.parse(await readStdin()));
  } catch (error) {
    output = {
      ports: null,
      setup: null,
      error: { code: "ORK_WORKER_FAILED", message: error.message },
    };
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
  process.exit(0);
}

if (import.meta.main) {
  await main();
}

export const WORKER_PATH = path.resolve(fileURLToPath(import.meta.url));
