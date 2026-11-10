import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  acquireWorkspaceLease,
  withWorkspaceLease,
} from "../../../plugins/orchestrate/lib/workspace-lease.mjs";

const scripts = fileURLToPath(
  new URL("../../../plugins/orchestrate/skills/orchestrate/scripts/", import.meta.url),
);
const leaseUrl = new URL("../../../plugins/orchestrate/lib/workspace-lease.mjs", import.meta.url)
  .href;
const nextUrl = new URL("../../../plugins/orchestrate/lib/next.mjs", import.meta.url).href;

// Every fixture is retained. Only processes started by these tests are signalled.
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "orkest-lease-"));
  const workspace = path.join(root, "workspace");
  mkdirSync(workspace);
  symlinkSync(root, path.join(root, "alias"));
  for (const name of ["orchestrate", "agent-executor"])
    mkdirSync(path.join(root, name, "worktree-locks-v1"), { recursive: true });
  const env = { ...process.env, XDG_CACHE_HOME: root };
  delete env.ORCHESTRATE_HOME;
  delete env.AGENT_EXECUTOR_HOME;
  return { root, workspace, alias: path.join(root, "alias", "workspace") + "/", env };
}

function start(command, args, env) {
  const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let errors = "";
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  const closed = new Promise((resolve) => child.once("close", resolve));
  child.stdin.on("error", () => {});
  return {
    child,
    closed,
    async line() {
      const next = await lines.next();
      if (next.done) throw new Error(`Child exited before status: ${errors}`);
      return JSON.parse(next.value);
    },
    async stop() {
      child.stdin.end();
      await closed;
    },
  };
}

function pythonLease(f, isReadOnly = false) {
  return start(
    "python3",
    [
      "-B",
      "-c",
      `
import json, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from execution_support import workspace_lease, ContractError
try:
    with workspace_lease(Path(sys.argv[2]), Path(sys.argv[3]), read_only=sys.argv[4] == 'true'):
        print(json.dumps({'status':'acquired'}), flush=True)
        sys.stdin.buffer.read()
except ContractError:
    print(json.dumps({'status':'busy'}), flush=True)
`,
      scripts,
      f.workspace,
      path.join(f.root, "agent-executor"),
      String(isReadOnly),
    ],
    f.env,
  );
}

async function assertFree(f) {
  const lease = await acquireWorkspaceLease(f.workspace, { env: f.env });
  try {
    expect(lease.acquired).toBe(true);
  } finally {
    await lease.release();
  }
}

describe("workspace lease with retained real-process fixtures", () => {
  it("Python legacy-root ownership excludes Node through a symlink and trailing slash, then releases without unlink", async () => {
    const f = fixture();
    const python = pythonLease(f);
    try {
      expect(await python.line()).toEqual({ status: "acquired" });
      const node = await acquireWorkspaceLease(f.alias, { env: f.env });
      expect({ acquired: node.acquired, busy: node.busy }).toEqual({ acquired: false, busy: true });
      await node.release();
      const dir = path.join(f.root, "agent-executor", "worktree-locks-v1");
      const file = path.join(dir, readdirSync(dir)[0]);
      const inode = statSync(file).ino;
      await python.stop();
      await assertFree(f);
      expect(statSync(file).ino).toBe(inode);
    } finally {
      await python.stop();
    }
  });

  it("Node ownership excludes Python resolving the other cache root", async () => {
    const f = fixture();
    const node = await acquireWorkspaceLease(f.alias, { env: f.env });
    const python = pythonLease(f);
    try {
      expect(node.acquired).toBe(true);
      expect(await python.line()).toEqual({ status: "busy" });
    } finally {
      await python.stop();
      await node.release();
    }
    await assertFree(f);
  });

  it("200 sequential contended acquisitions resolve busy without rejecting", async () => {
    const f = fixture();
    const owner = await acquireWorkspaceLease(f.workspace, { env: f.env });
    try {
      expect(owner.held).toBe(true);
      for (let i = 0; i < 200; i++) {
        const contender = await acquireWorkspaceLease(f.alias, { env: f.env });
        try {
          expect({
            acquired: contender.acquired,
            busy: contender.busy,
            held: contender.held,
          }).toEqual({ acquired: false, busy: true, held: false });
          expect(contender.detail).toContain("another executor owns the worktree");
        } finally {
          await contender.release();
        }
      }
    } finally {
      await owner.release();
    }
    await assertFree(f);
  });

  it("normal release immediately clears held and leaves lost pending", async () => {
    const f = fixture();
    const lease = await acquireWorkspaceLease(f.workspace, { env: f.env });
    try {
      expect(lease.held).toBe(true);
      const released = lease.release();
      expect(lease.held).toBe(false);
      await released;
      expect(
        await Promise.race([
          lease.lost,
          new Promise((resolve) => setImmediate(() => resolve("pending"))),
        ]),
      ).toBe("pending");
    } finally {
      await lease.release();
    }
    await assertFree(f);
  });

  it("a nonexistent interpreter rejects and its Node caller exits naturally within two seconds", async () => {
    const f = fixture();
    const probe = start(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
import { acquireWorkspaceLease } from ${JSON.stringify(leaseUrl)};
try {
  await acquireWorkspaceLease(process.argv[1], { pythonCommand: process.argv[2] });
  console.log(JSON.stringify({status:'unexpected acquisition'}));
} catch (error) {
  console.log(JSON.stringify({status:'infrastructure error', code:error.code}));
}
`,
        f.workspace,
        path.join(f.root, "nonexistent-python"),
      ],
      f.env,
    );
    let timer;
    const startedAt = Date.now();
    try {
      const [status, exitCode] = await Promise.race([
        Promise.all([probe.line(), probe.closed]),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("spawn failure left pending handles")), 2000);
        }),
      ]);
      expect(status).toEqual({ status: "infrastructure error", code: "ENOENT" });
      expect(exitCode).toBe(0);
      expect(Date.now() - startedAt).toBeLessThan(2000);
    } finally {
      clearTimeout(timer);
      probe.child.kill("SIGKILL");
      await probe.closed;
    }
    await assertFree(f);
  });

  it("shared readers coexist across languages and exclude a writer", async () => {
    const f = fixture();
    const python = pythonLease(f, true);
    let reader;
    try {
      expect(await python.line()).toEqual({ status: "acquired" });
      reader = await acquireWorkspaceLease(f.alias, { env: f.env, readOnly: true });
      expect(reader.acquired).toBe(true);
      const writer = await acquireWorkspaceLease(f.workspace, { env: f.env });
      expect(writer.busy).toBe(true);
      await writer.release();
    } finally {
      await python.stop();
      await reader?.release();
    }
    await assertFree(f);
  });

  it("releases on holder SIGKILL and releases withWorkspaceLease after callback failure", async () => {
    const f = fixture();
    const lease = await acquireWorkspaceLease(f.workspace, { env: f.env });
    try {
      expect(lease.held).toBe(true);
      process.kill(lease.pid, "SIGKILL");
      expect(await lease.lost).toEqual({ code: null, signal: "SIGKILL" });
      expect(lease.held).toBe(false);
    } finally {
      await lease.release();
    }
    await expect(
      withWorkspaceLease(f.workspace, { env: f.env }, () => {
        throw new Error("callback failed");
      }),
    ).rejects.toThrow("callback failed");
    await assertFree(f);
  });

  it("Node owner SIGKILL releases even with a live sibling child", async () => {
    const f = fixture();
    const owner = start(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
import { spawn } from 'node:child_process';
import { acquireWorkspaceLease } from ${JSON.stringify(leaseUrl)};
const lease = await acquireWorkspaceLease(process.argv[1]);
const sibling = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {stdio:'ignore'});
console.log(JSON.stringify({acquired:lease.acquired,sibling:sibling.pid}));
process.stdin.resume();
`,
        f.alias,
      ],
      f.env,
    );
    let sibling;
    try {
      const status = await owner.line();
      sibling = status.sibling;
      expect(status.acquired).toBe(true);
      owner.child.kill("SIGKILL");
      await owner.closed;
      // Await the orphan holder's EOF exit without relying on a fixed delay.
      let probe;
      for (let i = 0; i < 100; i++) {
        probe = await acquireWorkspaceLease(f.workspace, { env: f.env });
        if (probe.acquired) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(probe.acquired).toBe(true);
      await probe.release();
      expect(realpathSync(f.alias)).toBe(realpathSync(f.workspace));
    } finally {
      if (sibling) process.kill(sibling, "SIGKILL");
      owner.child.kill("SIGKILL");
      await owner.closed;
    }
  });

  it("exactly one simultaneous Next contender wins after a dead owner; lock inode survives", async () => {
    const f = fixture();
    const source = `
import { acquireNextLock, releaseNextLock } from ${JSON.stringify(nextUrl)};
console.log(JSON.stringify({status:'ready'}));
await new Promise(resolve => process.stdin.once('data',resolve));
let lock;
try { lock = await acquireNextLock(process.argv[1]); console.log(JSON.stringify({status:'acquired'})); }
catch (error) { console.log(JSON.stringify({status:'busy',detail:error.message})); }
await new Promise(resolve => process.stdin.once('end',resolve));
await releaseNextLock(lock);
`;
    const old = start(process.execPath, ["--input-type=module", "-e", source, f.workspace], f.env);
    const contenders = [];
    try {
      expect(await old.line()).toEqual({ status: "ready" });
      old.child.stdin.write("go\n");
      expect(await old.line()).toEqual({ status: "acquired" });
      const lockDir = path.join(f.root, "orchestrate", "next-locks", "worktree-locks-v1");
      const lockFile = path.join(lockDir, readdirSync(lockDir)[0]);
      const inode = statSync(lockFile).ino;
      old.child.kill("SIGKILL");
      await old.closed;
      for (let i = 0; i < 8; i++)
        contenders.push(
          start(process.execPath, ["--input-type=module", "-e", source, f.alias], f.env),
        );
      expect(await Promise.all(contenders.map((c) => c.line()))).toEqual(
        Array.from({ length: 8 }, () => ({ status: "ready" })),
      );
      for (const contender of contenders) contender.child.stdin.write("go\n");
      const results = await Promise.all(contenders.map((c) => c.line()));
      expect(results.filter((r) => r.status === "acquired")).toHaveLength(1);
      expect(
        results.filter((r) => r.status === "busy" && r.detail.includes("already running")),
      ).toHaveLength(7);
      expect(statSync(lockFile).ino).toBe(inode);
    } finally {
      old.child.kill("SIGKILL");
      await old.closed;
      await Promise.all(contenders.map((c) => c.stop()));
    }
  });
});
