import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import path from "node:path";

import { cacheHome } from "./runtime-paths.mjs";

const VALID_STATUSES = new Set(["approval", "blocked", "done", "failed", "info"]);
const VALID_SOUNDS = new Set(["done", "none", "request"]);

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isExecutable(filePath) {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function normalizeTarget(rawTarget) {
  if (!rawTarget || typeof rawTarget !== "object") return null;
  const kind = cleanText(rawTarget.kind).toLowerCase();
  const id = cleanText(rawTarget.id);
  if (!["herdr", "orca"].includes(kind) || !id || id.startsWith("-")) return null;
  const bin = cleanText(rawTarget.bin);
  return bin ? { bin, id, kind } : { id, kind };
}

export function macosHudTarget(env = process.env) {
  if (env?.HERDR_ENV === "1") {
    const paneId = cleanText(env.HERDR_PANE_ID);
    if (paneId) {
      const bin = cleanText(env.HERDR_BIN_PATH);
      return bin ? { bin, id: paneId, kind: "herdr" } : { id: paneId, kind: "herdr" };
    }
  }
  const terminal = cleanText(env?.ORCA_TERMINAL_HANDLE);
  if (terminal) {
    const bin = cleanText(env.ORCA_CLI_COMMAND);
    return bin ? { bin, id: terminal, kind: "orca" } : { id: terminal, kind: "orca" };
  }
  return null;
}

export function resolveMacosHudBinary(env = process.env, { exists = isExecutable } = {}) {
  const explicit = cleanText(env?.ORKEST_HUD_BIN);
  if (explicit) return exists(explicit) ? explicit : null;
  const candidate = path.join(
    cacheHome(env),
    "macos",
    "OrkestHUD.app",
    "Contents",
    "MacOS",
    "OrkestHUD",
  );
  return exists(candidate) ? candidate : null;
}

export function macosHudPayload(options = {}, env = process.env) {
  const statusInput = cleanText(options?.status).toLowerCase();
  const status = VALID_STATUSES.has(statusInput) ? statusInput : "info";
  const soundInput = cleanText(options?.sound).toLowerCase();
  const title = cleanText(options?.title) || "Orkest";
  const body = typeof options?.body === "string" ? options.body : "";
  const subtitle = cleanText(options?.subtitle);
  const repo = cleanText(options?.repo);
  const agent = cleanText(options?.agent);
  const target =
    options?.target === undefined ? macosHudTarget(env) : normalizeTarget(options.target);

  const payload = {
    body,
    status,
    title,
  };
  if (subtitle) payload.subtitle = subtitle;
  if (repo) payload.repo = repo;
  if (agent) payload.agent = agent;
  if (VALID_SOUNDS.has(soundInput)) payload.sound = soundInput;
  if (Number.isFinite(options?.durationSeconds) && options.durationSeconds > 0) {
    payload.durationSeconds = options.durationSeconds;
  }
  if (target) payload.target = target;
  return payload;
}

export function sendMacosHudToast(
  payload,
  { env = process.env, exec = execFile, exists, platform = process.platform } = {},
) {
  if (platform !== "darwin") return false;
  const binary = resolveMacosHudBinary(env, { exists });
  if (!binary) return false;
  const normalized = macosHudPayload(payload, env);
  try {
    exec(binary, ["--json", JSON.stringify(normalized)], { env, timeout: 5000 }, () => {});
    return true;
  } catch {
    return false;
  }
}
