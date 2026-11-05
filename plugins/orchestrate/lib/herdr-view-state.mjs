// cspell:words herdr
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import path from "node:path";

import { cacheHome } from "./runtime-paths.mjs";
import { plain } from "./tui-box.mjs";

async function resolveHerdrStateFile(roomId, env = process.env) {
  if (env.HERDR_ENV !== "1" || typeof roomId !== "string" || !roomId) return null;
  const config = path.join(env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "herdr");
  const socket =
    env.HERDR_SOCKET_PATH ||
    (env.HERDR_SESSION
      ? path.join(config, "sessions", env.HERDR_SESSION, "herdr.sock")
      : path.join(config, "herdr.sock"));
  let endpoint;
  try {
    endpoint = await realpath(socket);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const parent = await realpath(path.dirname(socket));
    endpoint = path.join(parent, path.basename(socket));
  }
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
  const cleaned = raw.replaceAll(/\s+/gu, " ").slice(0, 72);
  return cleaned ? `Swarm · ${cleaned}` : "Orkest Swarm";
}

/** Sync the Herdr pane border title with the swarm room title or coordinator goal. */
export async function syncHerdrViewLabel(room, { env = process.env, exec = execFile } = {}) {
  const roomId = typeof room?.id === "string" ? room.id : "";
  const resolved = await resolveHerdrStateFile(roomId, env);
  if (!resolved) return false;
  const { file, record } = resolved;
  const paneId = typeof record.pane === "string" ? record.pane.trim() : "";
  if (!paneId) return false;
  const nextLabel = herdrSwarmPaneLabel(room);
  if (record.label === nextLabel) return false;
  const updated = { ...record, label: nextLabel };
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
  const binary = env.HERDR_BIN_PATH || "herdr";
  await new Promise((resolve) => {
    exec(binary, ["pane", "rename", paneId, nextLabel], { timeout: 2000, env }, () => resolve());
  });
  return true;
}

/** Deliberate display closure; process termination during a server restart preserves intent. */
export async function markHerdrViewClosed(room, env = process.env) {
  const resolved = await resolveHerdrStateFile(room, env);
  if (!resolved) return;
  const { file } = resolved;
  await writeFile(file.replace(/\.json$/u, ".closed"), "closed\n", { mode: 0o600 });
  try {
    await unlink(file.replace(/\.json$/u, ".pending"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
