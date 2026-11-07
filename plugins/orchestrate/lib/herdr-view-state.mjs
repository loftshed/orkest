import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";

import { herdrEndpoint } from "./herdr-context.mjs";
import { cacheHome } from "./runtime-paths.mjs";
import { plain } from "./tui-box.mjs";

async function resolveHerdrStateFile(roomId, env = process.env) {
  if (env.HERDR_ENV !== "1" || !env.HERDR_PANE_ID || typeof roomId !== "string" || !roomId)
    return null;
  const endpoint = herdrEndpoint(env);
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  const directory = path.join(cacheHome(env), "herdr-views-v1", digest(endpoint).slice(0, 24));
  const file = env.ORKEST_HERDR_VIEW_STATE || path.join(directory, `${digest(roomId)}.json`);
  if (path.dirname(path.resolve(file)) !== directory || path.extname(file) !== ".json") return null;
  let record;
  try {
    record = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (
    record.schema !== "orkest.herdr-view.v1" ||
    record.room !== roomId ||
    record.endpoint !== endpoint ||
    record.host !== hostname()
  )
    return null;
  return { file, record };
}

export function herdrSwarmPaneLabel(room) {
  if (!room || typeof room !== "object") return "Orkest Swarm";
  const roomId = typeof room.id === "string" ? room.id.trim() : "";
  const candidates = [room.title, room.conductor?.progress?.goal, room.objective];
  const raw =
    candidates
      .map((value) => plain(value || "").trim())
      .find((value) => value && value !== "New swarm" && value !== "not set" && value !== roomId) ||
    "";
  const cleaned = raw.replaceAll(/\s+/gu, " ").slice(0, 72).trimEnd();
  return cleaned ? `Swarm · ${cleaned}` : "Orkest Swarm";
}

async function ownedViewPane(record, env, exec) {
  if (!record.terminal_id) return env.HERDR_PANE_ID === record.pane ? record.pane : null;
  const binary = env.HERDR_BIN_PATH || "herdr";
  return new Promise((resolve) => {
    exec(binary, ["pane", "current", "--current"], { timeout: 2000, env }, (error, stdout) => {
      try {
        const pane = !error && JSON.parse(stdout).result.pane;
        resolve(pane?.terminal_id === record.terminal_id ? pane.pane_id : null);
      } catch {
        resolve(null);
      }
    });
  });
}

/** Sync the Herdr pane border title with the swarm room title or coordinator goal. */
export async function syncHerdrViewLabel(room, { env = process.env, exec = execFile } = {}) {
  const roomId = typeof room?.id === "string" ? room.id : "";
  const resolved = await resolveHerdrStateFile(roomId, env);
  if (!resolved) return false;
  const { file, record } = resolved;
  const nextLabel = herdrSwarmPaneLabel(room);
  if (record.label === nextLabel) return false;
  const paneId = await ownedViewPane(record, env, exec);
  if (!paneId) return false;
  const binary = env.HERDR_BIN_PATH || "herdr";
  const renamed = await new Promise((resolve) => {
    exec(binary, ["pane", "rename", paneId, nextLabel], { timeout: 2000, env }, (error) =>
      resolve(!error),
    );
  });
  if (!renamed) return false;
  const updated = { ...record, pane: paneId, label: nextLabel };
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tempFile = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    await writeFile(tempFile, `${JSON.stringify(updated)}\n`, { mode: 0o600 });
    await rename(tempFile, file);
  } catch (error) {
    try {
      await unlink(tempFile);
    } catch {
      // Ignore cleanup error for missing temp file.
    }
    throw error;
  }
  return true;
}

/** Deliberate display closure; process termination during a server restart preserves intent. */
export async function markHerdrViewClosed(room, env = process.env, exec = execFile) {
  const resolved = await resolveHerdrStateFile(room, env);
  if (!resolved || !(await ownedViewPane(resolved.record, env, exec))) return;
  const { file } = resolved;
  await writeFile(file.replace(/\.json$/u, ".closed"), "closed\n", { mode: 0o600 });
  try {
    await unlink(file.replace(/\.json$/u, ".pending"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
