import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const holderPath = fileURLToPath(
  new URL("../skills/orchestrate/scripts/lease_holder.py", import.meta.url),
);

/** Advisory, non-blocking lease. Only the private holder receives its stdin pipe. */
export async function acquireWorkspaceLease(
  workspacePath,
  { readOnly = false, namespace, env = process.env, pythonCommand = "python3" } = {},
) {
  const args = ["-B", holderPath, workspacePath];
  if (readOnly) args.push("--read-only");
  if (namespace) args.push("--namespace", namespace);
  const child = spawn(pythonCommand, args, { env, stdio: ["pipe", "pipe", "pipe"] });
  // A holder can exit between acquisition and release; EPIPE must not crash the owner.
  child.stdin.on("error", () => {});
  let hasExited = false;
  let isReleased = false;
  let status;
  let exitDetails;
  const { promise: lost, resolve: resolveLost } = Promise.withResolvers();
  child.once("exit", (code, signal) => {
    hasExited = true;
    exitDetails = { code, signal };
    if (status?.status === "acquired" && !isReleased) resolveLost(exitDetails);
  });
  const closed = new Promise((resolve) =>
    child.once("close", () => {
      hasExited = true;
      resolve();
    }),
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-8192);
  });
  try {
    status = await new Promise((resolve, reject) => {
      let buffer = "";
      child.once("error", reject);
      const parseStatus = () => {
        const end = buffer.indexOf("\n");
        if (end === -1) return;
        try {
          const line = JSON.parse(buffer.slice(0, end));
          if (!["acquired", "busy"].includes(line.status))
            throw new Error("Invalid lease holder status");
          status = line;
          if (line.status === "acquired" && hasExited && !isReleased) resolveLost(exitDetails);
          resolve(line);
        } catch (error) {
          reject(error);
        }
      };
      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        parseStatus();
      });
      child.once("close", () => {
        // exit may precede stdout delivery; close follows the final stdio data.
        parseStatus();
        if (!status)
          reject(new Error(`Lease holder closed without a valid status line: ${stderr}`));
      });
    });
  } catch (error) {
    isReleased = true;
    child.stdin.end();
    await closed;
    throw error;
  }
  let releasePromise;
  const release = () => {
    isReleased = true;
    releasePromise ??= (async () => {
      if (!hasExited) child.stdin.end();
      await closed;
    })();
    return releasePromise;
  };
  if (status.status === "busy") await release();
  return {
    acquired: status.status === "acquired",
    busy: status.status === "busy",
    detail: status.detail ?? null,
    pid: status.pid,
    get held() {
      return status.status === "acquired" && !hasExited && !isReleased;
    },
    lost,
    release,
  };
}

export async function withWorkspaceLease(workspacePath, options, callback) {
  const lease = await acquireWorkspaceLease(workspacePath, options);
  if (!lease.acquired) throw new Error(lease.detail || "Workspace lease is busy");
  try {
    return await callback(lease);
  } finally {
    await lease.release();
  }
}

/** Check ownership again after an await and before each subsequent host mutation. */
export function assertWorkspaceLease(lease) {
  if (!lease?.held) throw new Error("Workspace lease holder was lost");
}
