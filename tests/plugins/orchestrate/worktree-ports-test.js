import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readlink,
  realpath,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  allocateWorktreePorts,
  clearWorktreePortFence,
  fenceWorktreePorts,
  isWorktreeFenced,
  listWorktreePorts,
  PORTS_APPLICATION_ID,
  releaseWorktreePorts,
  worktreePortKey,
  worktreePortsDbPath,
} from "../../../plugins/orchestrate/lib/worktree-ports.mjs";
import { retainFixtures } from "../../helpers/retain-fixtures.js";

const directories = [];

async function scratch() {
  const made = await mkdtemp(path.join(tmpdir(), "ork-ports-"));
  const created = await realpath(made);
  directories.push(created);
  return created;
}

async function fixture() {
  const root = await scratch();
  const repoRoot = path.join(root, "repo");
  const worktreePath = path.join(repoRoot, ".worktrees", "one");
  await mkdir(worktreePath, { recursive: true });
  return { root, repoRoot, worktreePath, env: { ORCHESTRATE_HOME: path.join(root, "cache") } };
}

function bind(port, host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen({ port, host, exclusive: true }, () => resolve(server));
  });
}

async function freeRange(count) {
  for (let base = 41_000 + Math.floor(Math.random() * 3000); ; base += count + 7) {
    const held = [];
    try {
      for (let index = 0; index < count; index += 1) held.push(await bind(base + index));
      await Promise.all(held.map((s) => new Promise((resolve) => s.close(resolve))));
      return base;
    } catch {
      await Promise.all(held.map((s) => new Promise((resolve) => s.close(resolve))));
    }
  }
}

afterEach(async () => {
  await retainFixtures(directories.splice(0));
});

describe("worktree port allocation", () => {
  it("allocates in range, reuses the same row, and lists ordered by name", async () => {
    const { repoRoot, worktreePath, env } = await fixture();
    const first = await allocateWorktreePorts({
      repoRoot,
      worktreePath,
      slug: "one",
      names: ["WEB_PORT", "API_PORT"],
      env,
    });
    expect(Object.keys(first).toSorted((a, b) => a.localeCompare(b))).toEqual([
      "API_PORT",
      "WEB_PORT",
    ]);
    for (const port of Object.values(first)) {
      expect(port).toBeGreaterThanOrEqual(31_000);
      expect(port).toBeLessThanOrEqual(49_151);
    }
    expect(first.WEB_PORT).not.toBe(first.API_PORT);
    expect(listWorktreePorts({ repoRoot, worktreePath, env })).toEqual([
      { name: "API_PORT", port: first.API_PORT },
      { name: "WEB_PORT", port: first.WEB_PORT },
    ]);

    // A running service already binds the port; retrieval must reuse the row, not re-probe.
    const service = await bind(first.WEB_PORT);
    try {
      const again = await allocateWorktreePorts({
        repoRoot,
        worktreePath,
        slug: "one",
        names: ["WEB_PORT", "API_PORT"],
        env,
      });
      expect(again).toEqual(first);
    } finally {
      await new Promise((resolve) => service.close(resolve));
    }
    const mode = (await stat(worktreePortsDbPath(env))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("adds a new slot later without disturbing existing ones", async () => {
    const { repoRoot, worktreePath, env } = await fixture();
    const base = await allocateWorktreePorts({ repoRoot, worktreePath, names: ["A_PORT"], env });
    const more = await allocateWorktreePorts({
      repoRoot,
      worktreePath,
      names: ["A_PORT", "B_PORT"],
      env,
    });
    expect(more.A_PORT).toBe(base.A_PORT);
    expect(more.B_PORT).not.toBe(base.A_PORT);
  });

  it("gives simultaneous same-identity calls one answer and different worktrees distinct ports", async () => {
    const { repoRoot, worktreePath, env, root } = await fixture();
    const other = path.join(repoRoot, ".worktrees", "two");
    await mkdir(other, { recursive: true });
    const calls = [
      ...Array.from({ length: 4 }, () =>
        allocateWorktreePorts({ repoRoot, worktreePath, names: ["P_ONE", "P_TWO"], env }),
      ),
      ...Array.from({ length: 4 }, () =>
        allocateWorktreePorts({ repoRoot, worktreePath: other, names: ["P_ONE", "P_TWO"], env }),
      ),
    ];
    const results = await Promise.all(calls);
    for (const result of results.slice(1, 4)) expect(result).toEqual(results[0]);
    for (const result of results.slice(5)) expect(result).toEqual(results[4]);
    const all = [...Object.values(results[0]), ...Object.values(results[4])];
    expect(new Set(all).size).toBe(4);
    expect(root).toBeTruthy();
  });

  it("skips ports the OS already has bound and reports exhaustion separately", async () => {
    const { repoRoot, worktreePath, env } = await fixture();
    const base = await freeRange(3);
    const blockers = [await bind(base), await bind(base + 1)];
    try {
      const got = await allocateWorktreePorts({
        repoRoot,
        worktreePath,
        names: ["ONLY_PORT"],
        rangeStart: base,
        rangeEnd: base + 2,
        env,
      });
      expect(got.ONLY_PORT).toBe(base + 2);

      // The probe sockets are closed again once the reservation is committed.
      const after = await bind(base + 2);
      await new Promise((resolve) => after.close(resolve));
    } finally {
      await Promise.all(blockers.map((s) => new Promise((resolve) => s.close(resolve))));
    }
    const second = path.join(repoRoot, ".worktrees", "full");
    await mkdir(second, { recursive: true });
    const holders = [await bind(base), await bind(base + 1)];
    try {
      await expect(
        allocateWorktreePorts({
          repoRoot,
          worktreePath: second,
          names: ["ONLY_PORT"],
          rangeStart: base,
          rangeEnd: base + 2,
          env,
        }),
      ).rejects.toMatchObject({ code: "ORK_PORTS_EXHAUSTED" });
    } finally {
      await Promise.all(holders.map((s) => new Promise((resolve) => s.close(resolve))));
    }
    expect(listWorktreePorts({ repoRoot, worktreePath: second, env })).toEqual([]);
  });

  it("rolls back every slot when one insert fails", async () => {
    const { repoRoot, worktreePath, env } = await fixture();
    await allocateWorktreePorts({ repoRoot, worktreePath, names: ["SEED_PORT"], env });
    const db = new DatabaseSync(worktreePortsDbPath(env));
    db.exec(
      "CREATE TRIGGER refuse_b BEFORE INSERT ON ports WHEN NEW.slot = 'B_PORT' BEGIN SELECT RAISE(ABORT, 'refused'); END",
    );
    db.close();
    const other = path.join(repoRoot, ".worktrees", "rb");
    await mkdir(other, { recursive: true });
    await expect(
      allocateWorktreePorts({ repoRoot, worktreePath: other, names: ["A_PORT", "B_PORT"], env }),
    ).rejects.toThrow("refused");
    expect(listWorktreePorts({ repoRoot, worktreePath: other, env })).toEqual([]);
    expect(listWorktreePorts({ repoRoot, worktreePath, env })).toHaveLength(1);
  });

  it("reports a busy database as ORK_PORTS_BUSY", async () => {
    const { repoRoot, worktreePath, env } = await fixture();
    await allocateWorktreePorts({ repoRoot, worktreePath, names: ["SEED_PORT"], env });
    const holder = new DatabaseSync(worktreePortsDbPath(env));
    holder.exec("BEGIN IMMEDIATE");
    const other = path.join(repoRoot, ".worktrees", "busy");
    await mkdir(other, { recursive: true });
    try {
      await expect(
        allocateWorktreePorts({
          repoRoot,
          worktreePath: other,
          names: ["X_PORT"],
          env,
          busyTimeoutMs: 50,
        }),
      ).rejects.toMatchObject({ code: "ORK_PORTS_BUSY" });
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
  });

  it("releases exactly one canonical identity and repeats safely", async () => {
    const { repoRoot, worktreePath, env } = await fixture();
    const other = path.join(repoRoot, ".worktrees", "keep");
    await mkdir(other, { recursive: true });
    await allocateWorktreePorts({ repoRoot, worktreePath, names: ["A_PORT", "B_PORT"], env });
    const kept = await allocateWorktreePorts({
      repoRoot,
      worktreePath: other,
      names: ["A_PORT"],
      env,
    });
    // Persist the key before a move; the original path may be reused afterwards.
    const key = worktreePortKey(repoRoot, worktreePath);
    expect(releaseWorktreePorts({ repoRoot, worktreePath: other + "-nope", env })).toEqual({
      released: 0,
    });
    expect(releaseWorktreePorts({ key, env })).toEqual({ released: 2 });
    expect(releaseWorktreePorts({ key, env })).toEqual({ released: 0 });
    expect(listWorktreePorts({ repoRoot, worktreePath: other, env })).toEqual([
      { name: "A_PORT", port: kept.A_PORT },
    ]);
  });

  it("reads and releases a missing database as empty without creating files", async () => {
    const { repoRoot, worktreePath, env, root } = await fixture();
    expect(listWorktreePorts({ repoRoot, worktreePath, env })).toEqual([]);
    expect(releaseWorktreePorts({ repoRoot, worktreePath, env })).toEqual({ released: 0 });
    expect(existsSync(path.join(root, "cache"))).toBe(false);
  });

  it("rejects wrong, newer, corrupt and look-alike databases without rewriting them", async () => {
    const { repoRoot, worktreePath, env, root } = await fixture();
    const dbPath = worktreePortsDbPath(env);
    await mkdir(path.dirname(dbPath), { recursive: true });
    const names = ["A_PORT"];

    await writeFile(dbPath, "this is not a database at all");
    await expect(
      allocateWorktreePorts({ repoRoot, worktreePath, names, env }),
    ).rejects.toMatchObject({ code: "ORK_PORTS_DB_CORRUPT" });
    expect(() => listWorktreePorts({ repoRoot, worktreePath, env })).toThrow();
    expect(readFileSync(dbPath, "utf8")).toBe("this is not a database at all");

    for (const [label, setup, code] of [
      ["wrong id", "PRAGMA application_id = 12345", "ORK_PORTS_DB_INCOMPATIBLE"],
      [
        "newer version",
        `PRAGMA application_id = ${PORTS_APPLICATION_ID}; PRAGMA user_version = 9`,
        "ORK_PORTS_DB_INCOMPATIBLE",
      ],
      [
        "look-alike table",
        "CREATE TABLE ports (repo_key TEXT, port INTEGER)",
        "ORK_PORTS_DB_INCOMPATIBLE",
      ],
      [
        "reshaped v1",
        `PRAGMA application_id = ${PORTS_APPLICATION_ID}; PRAGMA user_version = 1; CREATE TABLE ports (repo_key TEXT)`,
        "ORK_PORTS_DB_INCOMPATIBLE",
      ],
    ]) {
      const file = path.join(root, `case-${label.replaceAll(" ", "-")}`);
      const caseEnv = { ORCHESTRATE_HOME: file };
      await mkdir(file, { recursive: true });
      const target = worktreePortsDbPath(caseEnv);
      const db = new DatabaseSync(target);
      db.exec(setup);
      db.close();
      const before = readFileSync(target);
      await expect(
        allocateWorktreePorts({ repoRoot, worktreePath, names, env: caseEnv }),
        label,
      ).rejects.toMatchObject({ code });
      expect(() => listWorktreePorts({ repoRoot, worktreePath, env: caseEnv }), label).toThrow();
      expect(readFileSync(target).equals(before), label).toBe(true);
    }
  });

  it("migrates a freshly created database to v1 with the dedicated application id", async () => {
    const { repoRoot, worktreePath, env } = await fixture();
    await allocateWorktreePorts({ repoRoot, worktreePath, names: ["A_PORT"], env });
    const db = new DatabaseSync(worktreePortsDbPath(env), { readOnly: true });
    expect(db.prepare("PRAGMA application_id").get().application_id).toBe(1_330_335_828);
    expect(db.prepare("PRAGMA user_version").get().user_version).toBe(1);
    db.close();
  });

  it("rejects bad names and ranges before touching the database", async () => {
    const { repoRoot, worktreePath, env } = await fixture();
    for (const names of [[], ["lower"], ["A_PORT", "A_PORT"], ["1BAD"], "A_PORT"]) {
      await expect(
        allocateWorktreePorts({ repoRoot, worktreePath, names, env }),
      ).rejects.toMatchObject({ code: "ORK_PORTS_INVALID" });
    }
    await expect(
      allocateWorktreePorts({ repoRoot, worktreePath, names: ["A_PORT"], rangeStart: 80, env }),
    ).rejects.toMatchObject({ code: "ORK_PORTS_INVALID" });
    await expect(
      allocateWorktreePorts({
        repoRoot,
        worktreePath,
        names: ["A_PORT"],
        rangeStart: 40_000,
        rangeEnd: 39_000,
        env,
      }),
    ).rejects.toMatchObject({ code: "ORK_PORTS_INVALID" });
    expect(existsSync(worktreePortsDbPath(env))).toBe(false);
  });

  it("fences re-allocation while a quarantine is unfinished", async () => {
    const { repoRoot, worktreePath, env } = await fixture();
    await allocateWorktreePorts({ repoRoot, worktreePath, names: ["A_PORT"], env });
    const key = worktreePortKey(repoRoot, worktreePath);
    fenceWorktreePorts({ key, env, reason: "quarantine" });
    await expect(
      allocateWorktreePorts({ repoRoot, worktreePath, names: ["A_PORT"], env }),
    ).rejects.toMatchObject({ code: "ORK_PORTS_FENCED" });
    releaseWorktreePorts({ key, env });
    expect(clearWorktreePortFence({ key, env })).toEqual({ unfenced: true });
    const fresh = await allocateWorktreePorts({ repoRoot, worktreePath, names: ["A_PORT"], env });
    expect(fresh.A_PORT).toBeGreaterThan(0);
  });

  it("closes probe sockets promptly even when a client connection is retained", async () => {
    const { repoRoot, worktreePath, env } = await fixture();
    const base = await freeRange(1);
    let client;
    const started = Date.now();
    const got = await allocateWorktreePorts({
      repoRoot,
      worktreePath,
      names: ["ONLY_PORT"],
      rangeStart: base,
      rangeEnd: base,
      env,
      afterReserve: async () => {
        // A local connection lands on the held probe and is kept open by its owner.
        client = net.connect({ port: base, host: "127.0.0.1" });
        client.on("error", () => {});
        await new Promise((resolve) => client.once("connect", resolve));
      },
    });
    const elapsed = Date.now() - started;
    client.destroy();
    expect(got.ONLY_PORT).toBe(base);
    // The close grace is one second; a prompt drain finishes far inside it.
    expect(elapsed).toBeLessThan(900);
    const after = await bind(base);
    await new Promise((resolve) => after.close(resolve));
  });

  it("lets a fence installed while an allocation is in flight win, then permits a retry", async () => {
    const { repoRoot, worktreePath, env } = await fixture();
    const base = await freeRange(2);
    const key = worktreePortKey(repoRoot, worktreePath);
    await expect(
      allocateWorktreePorts({
        repoRoot,
        worktreePath,
        names: ["A_PORT"],
        rangeStart: base,
        rangeEnd: base + 1,
        env,
        afterReserve: () => {
          fenceWorktreePorts({ key, env, reason: "quarantine started" });
        },
      }),
    ).rejects.toMatchObject({ code: "ORK_PORTS_FENCED" });
    expect(listWorktreePorts({ repoRoot, worktreePath, env })).toEqual([]);
    // The stale probe sockets were released with the rollback.
    for (const port of [base, base + 1]) {
      const probe = await bind(port);
      await new Promise((resolve) => probe.close(resolve));
    }
    clearWorktreePortFence({ key, env });
    const retry = await allocateWorktreePorts({
      repoRoot,
      worktreePath,
      names: ["A_PORT"],
      rangeStart: base,
      rangeEnd: base + 1,
      env,
    });
    expect(retry.A_PORT).toBeGreaterThanOrEqual(base);
  });

  it("keeps fence files private and never touches a foreign entry or directory", async () => {
    const { repoRoot, worktreePath, env, root } = await fixture();
    const key = worktreePortKey(repoRoot, worktreePath);
    const fenceDir = path.join(root, "cache", "worktree-port-fences");
    const result = fenceWorktreePorts({ key, env, reason: "x" });
    expect((await stat(result.path)).mode & 0o777).toBe(0o600);
    expect((await stat(fenceDir)).mode & 0o777).toBe(0o700);
    expect(fenceWorktreePorts({ key, env }).path).toBe(result.path); // idempotent
    clearWorktreePortFence({ key, env });

    // A symlink squatting on the fence name is preserved, treated as a fence, and never followed.
    const target = path.join(root, "victim.txt");
    await writeFile(target, "victim\n", { mode: 0o644 });
    const id = createHash("sha256").update(`${key.repoKey}\0${key.worktreePath}`).digest("hex");
    await symlink(target, path.join(fenceDir, `${id}.json`));
    expect(() => fenceWorktreePorts({ key, env })).toThrow(
      expect.objectContaining({ code: "ORK_PORTS_FENCE_UNSAFE" }),
    );
    expect(() => clearWorktreePortFence({ key, env })).toThrow(
      expect.objectContaining({ code: "ORK_PORTS_FENCE_UNSAFE" }),
    );
    expect(await readlink(path.join(fenceDir, `${id}.json`))).toBe(target);
    expect((await stat(target)).mode & 0o777).toBe(0o644);
    expect(isWorktreeFenced({ key, env })).toBe(true);
    await expect(
      allocateWorktreePorts({ repoRoot, worktreePath, names: ["A_PORT"], env }),
    ).rejects.toMatchObject({ code: "ORK_PORTS_FENCED" });

    // A loosely-permitted fence directory is reported rather than repaired.
    const other = await fixture();
    const otherKey = worktreePortKey(other.repoRoot, other.worktreePath);
    await mkdir(path.join(other.root, "cache", "worktree-port-fences"), { recursive: true });
    await chmod(path.join(other.root, "cache", "worktree-port-fences"), 0o755);
    expect(() => fenceWorktreePorts({ key: otherKey, env: other.env })).toThrow(
      expect.objectContaining({ code: "ORK_PORTS_FENCE_UNSAFE" }),
    );
    expect((await stat(path.join(other.root, "cache", "worktree-port-fences"))).mode & 0o777).toBe(
      0o755,
    );
  });
});
