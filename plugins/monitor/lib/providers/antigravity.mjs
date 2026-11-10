import { existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import { childEnv, expandHome, resolveBinary, run } from "../exec.mjs";

const slug = (s) =>
  s
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "");

const WINDOW_MINS = { "5h": 300, weekly: 10_080 };

// Families come from the group's model list when present ("Models within this group: Claude Opus, Claude
// Sonnet, GPT-OSS"); the group name "Claude and GPT models" alone would overstate them. GPT-OSS is its own
// family: open-weight models, not the GPT models Codex serves, so "gpt" keeps meaning Codex.
function families(group) {
  const text = String(group?.description || group?.name || "").toLowerCase();
  const found = ["gemini", "claude"].filter((f) => text.includes(f));
  if (text.includes("gpt-oss")) found.push("gpt-oss");
  if (/gpt(?!-oss)/.test(text)) found.push("gpt");
  return found;
}

function shortGroupName(name) {
  const raw = String(name ?? "");
  if (/^gemini/i.test(raw)) return "Gemini";
  if (/claude.*gpt/i.test(raw)) return "Claude & GPT";
  return raw.replace(/\s+models?$/i, "");
}

/** Normalises `agy -p /usage --output-format json` (Antigravity CLI 1.1.11+). */
export function parseAntigravityUsage(payload) {
  const groups = payload?.command?.data?.groups;
  if (!Array.isArray(groups) || groups.length === 0) {
    throw new Error(
      `agy /usage returned no quota groups: ${String(payload?.response ?? "").slice(0, 160)}`,
    );
  }
  const windows = [];
  const pools = [];
  for (const group of groups) {
    if (!group || typeof group !== "object") continue;
    const poolId = slug(shortGroupName(group.name));
    const label = shortGroupName(group.name);
    const windowIds = [];
    const buckets = Array.isArray(group.buckets) ? group.buckets : [];
    for (const bucket of buckets) {
      if (!bucket || typeof bucket !== "object") continue;
      const kind = bucket.window ?? bucket.id;
      if (
        !kind ||
        typeof bucket.remaining_fraction !== "number" ||
        !Number.isFinite(bucket.remaining_fraction)
      ) {
        continue;
      }
      const id = `${poolId}-${kind}`;
      const remainingPct = Math.round(bucket.remaining_fraction * 1000) / 10;
      windows.push({
        id,
        label: `${label} ${kind === "5h" ? "5-hour" : kind}`,
        kind,
        windowMins: WINDOW_MINS[kind] ?? null,
        usedPct: Math.round((100 - remainingPct) * 10) / 10,
        remainingPct,
        resetsAt: bucket.reset_time ? Date.parse(bucket.reset_time) : null,
        pool: poolId,
      });
      windowIds.push(id);
    }
    const models = String(group.description ?? "").replace(/^Models within this group:\s*/i, "");
    if (windowIds.length > 0)
      pools.push({ id: poolId, label, families: families(group), models, windowIds });
  }
  if (windows.length === 0) {
    throw new Error(
      `agy /usage returned no quota windows: ${String(payload?.response ?? "").slice(0, 160)}`,
    );
  }
  return { windows, pools, notes: [] };
}

const SSH_MARKERS = ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"];
const LOGIN_FILE = "~/.gemini/antigravity-cli/antigravity-oauth-token";

// On Linux agy keeps its sign-in in one of two places: the file above or the desktop keyring (KWallet).
// It picks the file when it sees an SSH session and the keyring otherwise, and each place holds its own
// copy of the refresh token. Sessions started from a terminal, over SSH or not, refresh the file; a probe
// launched by the desktop (the KDE widget, a timer) inherits no SSH variable and reads the keyring copy,
// which nothing else refreshes. Once a newer sign-in exists the probe finds that copy expired, refreshes
// it with a superseded refresh token, and Google revokes the grant: every agy session is signed out a
// minute or two later. Presenting the probe as an SSH session makes it read, and refresh, the file the
// other sessions use. Without a sign-in file the keyring stays in charge.
export function probeEnv(
  extra = {},
  { platform = process.platform, hasLoginFile = () => existsSync(expandHome(LOGIN_FILE)) } = {},
) {
  const env = childEnv(extra);
  // A null in the account's env removes a variable; for these it also opts out of the marker.
  const isOptedOut = SSH_MARKERS.some((name) => extra[name] === null);
  if (
    platform !== "linux" ||
    isOptedOut ||
    SSH_MARKERS.some((name) => env[name]) ||
    !hasLoginFile()
  )
    return env;
  return { ...env, SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 22" };
}

async function runUsage(bin, account) {
  const { code, stdout, stderr } = await run(bin, ["-p", "/usage", "--output-format", "json"], {
    env: probeEnv(account.env ?? {}),
    timeoutMs: account.timeoutMs ?? 60_000,
    maxBytes: 1024 * 1024,
  });
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`agy exited ${code}: ${(stderr || stdout).trim().slice(0, 200)}`);
  }
}

export async function fetchAntigravity(account) {
  const bin = resolveBinary("agy", account.command);
  let payload = await runUsage(bin, account);
  if (!payload || typeof payload !== "object") {
    throw new Error("agy /usage returned a non-object JSON payload");
  }
  // agy occasionally answers status ERROR with no detail and succeeds a moment later; retry once.
  if (payload.status && payload.status !== "SUCCESS") {
    await sleep(1500);
    payload = await runUsage(bin, account);
    if (!payload || typeof payload !== "object") {
      throw new Error("agy /usage returned a non-object JSON payload");
    }
  }
  if (payload.status && payload.status !== "SUCCESS") {
    const detail = String(payload.error || payload.response || "no detail")
      .trim()
      .slice(0, 160);
    throw new Error(`agy /usage status ${payload.status}: ${detail}`);
  }
  return parseAntigravityUsage(payload);
}
