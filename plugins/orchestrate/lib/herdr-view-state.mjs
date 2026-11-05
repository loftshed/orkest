import { createHash } from "node:crypto";
import { readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import path from "node:path";

import { cacheHome } from "./runtime-paths.mjs";

/** Deliberate display closure; process termination during a server restart preserves intent. */
export async function markHerdrViewClosed(room, env = process.env) {
  if (env.HERDR_ENV !== "1" || typeof room !== "string") return;
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
  const file = env.ORKEST_HERDR_VIEW_STATE || path.join(directory, `${digest(room)}.json`);
  if (path.dirname(path.resolve(file)) !== directory || path.extname(file) !== ".json") return;
  let record;
  try {
    record = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (
    record.schema !== "orkest.herdr-view.v1" ||
    record.room !== room ||
    record.endpoint !== endpoint ||
    record.host !== hostname()
  )
    return;
  await writeFile(file.replace(/\.json$/u, ".closed"), "closed\n", { mode: 0o600 });
  try {
    await unlink(file.replace(/\.json$/u, ".pending"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
