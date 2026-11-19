import nodeFs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export const DOCKER_FAILURE_BACKOFF_MS = 60_000;
export const DOCKER_BROKEN_BINARY_BACKOFF_MS = 5 * 60_000;

const DEFAULT_PATH_ENTRIES = ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin"];
const APP_BUNDLE_RE = /^(.*?\/[^/]+\.app)(?:\/|$)/iu;

function stampFrom(now) {
  return typeof now === "function" ? now() : (now ?? Date.now());
}

function isNonEmptyFile(fs, filePath) {
  try {
    const info = fs.statSync(filePath);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

function isRegularFile(fs, filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isNonEmptyDirectory(fs, dirPath) {
  try {
    const info = fs.statSync(dirPath);
    if (!info.isDirectory()) return false;
    return fs.readdirSync(dirPath).length > 0;
  } catch {
    return false;
  }
}

function isSocketFile(fs, socketPath) {
  if (!socketPath) return false;
  try {
    return fs.statSync(socketPath).isSocket();
  } catch {
    return false;
  }
}

function findEnclosingAppBundle(targetPath) {
  const match = APP_BUNDLE_RE.exec(String(targetPath || ""));
  return match ? match[1] : null;
}

function isIntactAppBundle(fs, appBundlePath) {
  if (
    !isNonEmptyFile(fs, path.join(appBundlePath, "Contents", "Info.plist")) ||
    !isNonEmptyFile(fs, path.join(appBundlePath, "Contents", "_CodeSignature", "CodeResources")) ||
    !isNonEmptyDirectory(fs, path.join(appBundlePath, "Contents", "MacOS"))
  ) {
    return false;
  }

  if (path.basename(appBundlePath).toLowerCase() === "docker.app") {
    if (
      !isNonEmptyDirectory(fs, path.join(appBundlePath, "Contents", "Resources", "cli-plugins"))
    ) {
      return false;
    }
    const desktopExe = path.join(appBundlePath, "Contents", "MacOS", "Docker Desktop");
    const legacyExe = path.join(appBundlePath, "Contents", "MacOS", "Docker");
    if (!isRegularFile(fs, desktopExe) && !isRegularFile(fs, legacyExe)) {
      return false;
    }
  }
  return true;
}

/**
 * Locate the Docker CLI on PATH and verify its target (plus any enclosing macOS .app bundle)
 * is intact before spawning it, so broken bundles never trigger LaunchServices damaged-app dialogs.
 */
export function resolveDockerBinary({ env = process.env, fs = nodeFs } = {}) {
  const hasExplicitPath = Boolean(env) && Object.hasOwn(env, "PATH");
  const rawPath = hasExplicitPath ? String(env.PATH ?? "") : "";
  const searchDirs = hasExplicitPath
    ? rawPath.split(path.delimiter).filter(Boolean)
    : DEFAULT_PATH_ENTRIES;

  let candidate = null;
  for (const dir of searchDirs) {
    const probePath = path.join(dir, "docker");
    try {
      fs.lstatSync(probePath);
      candidate = probePath;
      break;
    } catch {
      continue;
    }
  }
  if (!candidate) {
    return { ok: false, reason: "missing-binary" };
  }

  let resolved;
  let info;
  try {
    resolved = fs.realpathSync(candidate);
    info = fs.statSync(resolved);
    if (!info.isFile()) {
      return { ok: false, reason: "broken-binary", candidate };
    }
    fs.accessSync(resolved, fs.constants.X_OK);
  } catch {
    return { ok: false, reason: "broken-binary", candidate };
  }

  const appBundlePath = findEnclosingAppBundle(resolved) || findEnclosingAppBundle(candidate);
  if (appBundlePath && !isIntactAppBundle(fs, appBundlePath)) {
    return {
      ok: false,
      reason: "damaged-app-bundle",
      binaryPath: resolved,
      appBundlePath,
    };
  }

  return {
    ok: true,
    binaryPath: resolved,
    mtimeMs: Math.trunc(info.mtimeMs),
  };
}

function parseDockerEndpoint(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("unix://")) {
    return { kind: "unix", socketPath: trimmed.slice("unix://".length) };
  }
  if (trimmed.startsWith("/")) {
    return { kind: "unix", socketPath: trimmed };
  }
  return { kind: "remote", endpoint: trimmed };
}

function readActiveContextEndpoint(fs, dockerConfigDir) {
  try {
    const configRaw = fs.readFileSync(path.join(dockerConfigDir, "config.json"), "utf8");
    const config = JSON.parse(configRaw);
    const currentContext =
      typeof config?.currentContext === "string" ? config.currentContext.trim() : "";
    if (!currentContext || currentContext === "default") return null;

    const metaRoot = path.join(dockerConfigDir, "contexts", "meta");
    const entries = fs.readdirSync(metaRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const metaPath = path.join(metaRoot, entry.name, "meta.json");
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
        if (meta?.Name !== currentContext) continue;
        const host = meta?.Endpoints?.docker?.Host;
        return parseDockerEndpoint(host);
      } catch {
        continue;
      }
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Determine whether the configured Docker endpoint is a remote host or a set of local Unix sockets
 * present on disk.
 */
export function resolveDockerDaemonTarget({
  env = process.env,
  homeDir = env?.HOME || os.homedir(),
  fs = nodeFs,
  uid = process.getuid?.(),
  systemSockets,
} = {}) {
  const dockerHost = typeof env?.DOCKER_HOST === "string" ? env.DOCKER_HOST.trim() : "";
  if (dockerHost) {
    const parsed = parseDockerEndpoint(dockerHost);
    if (parsed?.kind === "remote") {
      return { kind: "remote", endpoint: parsed.endpoint };
    }
    if (parsed?.kind === "unix") {
      return {
        kind: "unix",
        sockets: isSocketFile(fs, parsed.socketPath) ? [parsed.socketPath] : [],
      };
    }
  }

  const dockerConfigDir =
    (typeof env?.DOCKER_CONFIG === "string" && env.DOCKER_CONFIG.trim()) ||
    path.join(homeDir, ".docker");
  const contextEndpoint = readActiveContextEndpoint(fs, dockerConfigDir);
  if (contextEndpoint?.kind === "remote") {
    return { kind: "remote", endpoint: contextEndpoint.endpoint };
  }

  const xdgRuntimeDir = typeof env?.XDG_RUNTIME_DIR === "string" ? env.XDG_RUNTIME_DIR.trim() : "";
  const defaultSystemSockets = Array.isArray(systemSockets)
    ? systemSockets
    : [
        "/var/run/docker.sock",
        "/run/docker.sock",
        ...(Number.isSafeInteger(uid) ? [`/run/user/${uid}/docker.sock`] : []),
      ];

  const candidates = [
    ...(contextEndpoint?.kind === "unix" ? [contextEndpoint.socketPath] : []),
    path.join(homeDir, ".docker", "run", "docker.sock"),
    ...defaultSystemSockets.slice(0, 2),
    ...(xdgRuntimeDir
      ? [path.join(xdgRuntimeDir, "docker.sock"), path.join(xdgRuntimeDir, "podman", "podman.sock")]
      : []),
    ...defaultSystemSockets.slice(2),
    path.join(homeDir, ".colima", "default", "docker.sock"),
    path.join(homeDir, ".config", "colima", "default", "docker.sock"),
    path.join(homeDir, ".orbstack", "run", "docker.sock"),
    path.join(homeDir, ".rd", "docker.sock"),
  ];

  const seen = new Set();
  const sockets = [];
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    if (isSocketFile(fs, candidate)) sockets.push(candidate);
  }
  return { kind: "unix", sockets };
}

/** Check whether a local Docker daemon is actively accepting connections on a Unix socket. */
export function probeUnixSocket(
  socketPath,
  { connect = net.createConnection, timeoutMs = 150 } = {},
) {
  return new Promise((resolve) => {
    let isSettled = false;
    let socket = null;
    const finish = (connected) => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timer);
      try {
        socket?.destroy();
      } catch {
        // Ignore teardown errors on failed probe sockets.
      }
      resolve(connected);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();

    try {
      socket = connect({ path: socketPath });
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
    } catch {
      finish(false);
    }
  });
}

/** Return readiness metadata describing whether `docker ps` can run safely right now. */
export async function canProbeDocker(options = {}) {
  const binary = resolveDockerBinary(options);
  if (!binary.ok) return binary;

  const target = resolveDockerDaemonTarget(options);
  if (target.kind === "remote") {
    return {
      ok: true,
      binaryPath: binary.binaryPath,
      mtimeMs: binary.mtimeMs,
      endpoint: target.endpoint,
    };
  }
  if (target.sockets.length === 0) {
    return {
      ok: false,
      reason: "no-daemon-socket",
      binaryPath: binary.binaryPath,
    };
  }

  for (const sock of target.sockets) {
    if (await probeUnixSocket(sock, options)) {
      return {
        ok: true,
        binaryPath: binary.binaryPath,
        mtimeMs: binary.mtimeMs,
        socketPath: sock,
      };
    }
  }
  return {
    ok: false,
    reason: "daemon-unreachable",
    binaryPath: binary.binaryPath,
  };
}

/** Create a stateful guard that combines binary/socket readiness with failure backoff caching. */
export function createDockerProbeGuard() {
  const state = {
    failedAt: 0,
    cooldownMs: 0,
    binaryKey: "",
  };

  return {
    async check(options = {}) {
      const stamp = stampFrom(options.now);
      const readiness = await canProbeDocker(options);
      if (!readiness.ok) return readiness;

      const binaryKey = `${readiness.binaryPath}:${readiness.mtimeMs}`;
      if (
        state.cooldownMs > 0 &&
        state.binaryKey === binaryKey &&
        stamp - state.failedAt < state.cooldownMs
      ) {
        return {
          ok: false,
          reason: "backoff",
          binaryPath: readiness.binaryPath,
        };
      }
      return { ...readiness, binaryKey };
    },
    recordSuccess() {
      state.failedAt = 0;
      state.cooldownMs = 0;
      state.binaryKey = "";
    },
    recordFailure(error, { binaryKey = "", now = Date.now } = {}) {
      const code = String(error?.code || "");
      const isBrokenBinary =
        code === "ENOENT" || code === "EACCES" || code === "EPERM" || Boolean(error?.signal);
      state.failedAt = stampFrom(now);
      state.cooldownMs = isBrokenBinary
        ? DOCKER_BROKEN_BINARY_BACKOFF_MS
        : DOCKER_FAILURE_BACKOFF_MS;
      state.binaryKey = String(binaryKey || "");
    },
  };
}

export const defaultDockerProbeGuard = createDockerProbeGuard();

export function resetDockerProbeGuard() {
  defaultDockerProbeGuard.recordSuccess();
}
