import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  canProbeDocker,
  createDockerProbeGuard,
  DOCKER_BROKEN_BINARY_BACKOFF_MS,
  DOCKER_FAILURE_BACKOFF_MS,
  resolveDockerBinary,
} from "../../../plugins/orchestrate/lib/docker-probe.mjs";

const tempDirs = [];
const servers = [];

function makeTempRoot() {
  const dir = realpathSync(mkdtempSync("/tmp/ork-dkr-"));
  tempDirs.push(dir);
  return dir;
}

function writeExecutable(filePath, content = "#!/bin/sh\necho '[]'\n") {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf8");
  chmodSync(filePath, 0o755);
}

function createFakeAppBundle(
  root,
  appName,
  {
    cliBinaryPath,
    withInfoPlist = true,
    withCodeSignature = true,
    withMainExecutable = true,
    withCliPlugins = true,
  } = {},
) {
  const appPath = path.join(root, "Applications", appName);
  const contentsPath = path.join(appPath, "Contents");
  mkdirSync(path.join(contentsPath, "MacOS"), { recursive: true });

  if (withInfoPlist) {
    writeFileSync(path.join(contentsPath, "Info.plist"), "<plist></plist>\n", "utf8");
  }
  if (withCodeSignature) {
    mkdirSync(path.join(contentsPath, "_CodeSignature"), { recursive: true });
    writeFileSync(
      path.join(contentsPath, "_CodeSignature", "CodeResources"),
      "<plist></plist>\n",
      "utf8",
    );
  }
  if (withMainExecutable) {
    const exeName =
      appName.toLowerCase() === "docker.app" ? "Docker Desktop" : appName.replace(/\.app$/iu, "");
    writeExecutable(path.join(contentsPath, "MacOS", exeName), "#!/bin/sh\nexit 0\n");
  }
  if (withCliPlugins) {
    mkdirSync(path.join(contentsPath, "Resources", "cli-plugins"), { recursive: true });
    writeExecutable(
      path.join(contentsPath, "Resources", "cli-plugins", "docker-compose"),
      "#!/bin/sh\nexit 0\n",
    );
  }

  const cliPath = path.join(appPath, cliBinaryPath);
  writeExecutable(cliPath);
  return { appPath, cliPath };
}

async function listenUnixSocket(socketPath) {
  mkdirSync(path.dirname(socketPath), { recursive: true });
  const server = net.createServer();
  servers.push(server);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return socketPath;
}

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    await new Promise((resolve) => server.close(resolve));
  }
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("docker probe prechecks", () => {
  it("reports missing-binary when docker is not on PATH", async () => {
    const root = makeTempRoot();
    const emptyBin = path.join(root, "bin");
    mkdirSync(emptyBin, { recursive: true });

    await expect(
      canProbeDocker({ env: { PATH: emptyBin, HOME: root }, systemSockets: [] }),
    ).resolves.toEqual({ ok: false, reason: "missing-binary" });
  });

  it("reports broken-binary for a dangling symlink into Docker.app", async () => {
    const root = makeTempRoot();
    const binDir = path.join(root, "bin");
    mkdirSync(binDir, { recursive: true });
    symlinkSync(
      path.join(root, "Applications", "Docker.app", "Contents", "Resources", "bin", "docker"),
      path.join(binDir, "docker"),
    );

    await expect(
      canProbeDocker({
        env: { PATH: binDir, HOME: root, DOCKER_HOST: "tcp://127.0.0.1:2375" },
        systemSockets: [],
      }),
    ).resolves.toMatchObject({ ok: false, reason: "broken-binary" });
  });

  it("reports damaged-app-bundle for a half-copied Docker.app missing Contents/Resources/cli-plugins even with remote DOCKER_HOST", async () => {
    const root = makeTempRoot();
    const binDir = path.join(root, "bin");
    mkdirSync(binDir, { recursive: true });
    const { appPath, cliPath } = createFakeAppBundle(root, "Docker.app", {
      cliBinaryPath: "Contents/Resources/bin/docker",
      withCliPlugins: false,
    });
    symlinkSync(cliPath, path.join(binDir, "docker"));

    await expect(
      canProbeDocker({
        env: { PATH: binDir, HOME: root, DOCKER_HOST: "tcp://127.0.0.1:2375" },
        systemSockets: [],
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "damaged-app-bundle",
      binaryPath: cliPath,
      appBundlePath: appPath,
    });
  });

  it("reports damaged-app-bundle when Info.plist or _CodeSignature/CodeResources is missing", () => {
    const rootNoSig = makeTempRoot();
    const binNoSig = path.join(rootNoSig, "bin");
    mkdirSync(binNoSig, { recursive: true });
    const noSig = createFakeAppBundle(rootNoSig, "Docker.app", {
      cliBinaryPath: "Contents/Resources/bin/docker",
      withCodeSignature: false,
    });
    symlinkSync(noSig.cliPath, path.join(binNoSig, "docker"));

    expect(resolveDockerBinary({ env: { PATH: binNoSig } })).toEqual({
      ok: false,
      reason: "damaged-app-bundle",
      binaryPath: noSig.cliPath,
      appBundlePath: noSig.appPath,
    });

    const rootNoPlist = makeTempRoot();
    const binNoPlist = path.join(rootNoPlist, "bin");
    mkdirSync(binNoPlist, { recursive: true });
    const noPlist = createFakeAppBundle(rootNoPlist, "Docker.app", {
      cliBinaryPath: "Contents/Resources/bin/docker",
      withInfoPlist: false,
    });
    symlinkSync(noPlist.cliPath, path.join(binNoPlist, "docker"));

    expect(resolveDockerBinary({ env: { PATH: binNoPlist } })).toEqual({
      ok: false,
      reason: "damaged-app-bundle",
      binaryPath: noPlist.cliPath,
      appBundlePath: noPlist.appPath,
    });
  });

  it("accepts a healthy OrbStack.app bundle without Resources/cli-plugins when a socket is listening", async () => {
    const root = makeTempRoot();
    const binDir = path.join(root, "bin");
    mkdirSync(binDir, { recursive: true });
    const { cliPath } = createFakeAppBundle(root, "OrbStack.app", {
      cliBinaryPath: "Contents/MacOS/xbin/docker",
      withCliPlugins: false,
    });
    symlinkSync(cliPath, path.join(binDir, "docker"));
    const socketPath = await listenUnixSocket(path.join(root, ".orbstack", "run", "docker.sock"));

    await expect(
      canProbeDocker({
        env: { PATH: binDir, HOME: root },
        systemSockets: [],
      }),
    ).resolves.toMatchObject({
      ok: true,
      binaryPath: cliPath,
      socketPath,
    });
  });

  it("reports no-daemon-socket when Docker.app is healthy but no socket files exist", async () => {
    const root = makeTempRoot();
    const binDir = path.join(root, "bin");
    mkdirSync(binDir, { recursive: true });
    const { cliPath } = createFakeAppBundle(root, "Docker.app", {
      cliBinaryPath: "Contents/Resources/bin/docker",
    });
    symlinkSync(cliPath, path.join(binDir, "docker"));

    await expect(
      canProbeDocker({
        env: { PATH: binDir, HOME: root },
        systemSockets: [],
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "no-daemon-socket",
      binaryPath: cliPath,
    });
  });

  it("reports daemon-unreachable when socket exists on disk but refuses connections", async () => {
    const root = makeTempRoot();
    const binDir = path.join(root, "bin");
    mkdirSync(binDir, { recursive: true });
    const { cliPath } = createFakeAppBundle(root, "Docker.app", {
      cliBinaryPath: "Contents/Resources/bin/docker",
    });
    symlinkSync(cliPath, path.join(binDir, "docker"));
    await listenUnixSocket(path.join(root, ".docker", "run", "docker.sock"));

    const refusedConnect = () => ({
      once(event, handler) {
        if (event === "error") {
          queueMicrotask(() =>
            handler(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })),
          );
        }
      },
      destroy() {},
    });

    await expect(
      canProbeDocker({
        env: { PATH: binDir, HOME: root },
        systemSockets: [],
        connect: refusedConnect,
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "daemon-unreachable",
      binaryPath: cliPath,
    });
  });

  it("allows probing when a healthy binary finds a live ~/.docker/run/docker.sock", async () => {
    const root = makeTempRoot();
    const binDir = path.join(root, "bin");
    mkdirSync(binDir, { recursive: true });
    const { cliPath } = createFakeAppBundle(root, "Docker.app", {
      cliBinaryPath: "Contents/Resources/bin/docker",
    });
    symlinkSync(cliPath, path.join(binDir, "docker"));
    const socketPath = await listenUnixSocket(path.join(root, ".docker", "run", "docker.sock"));

    await expect(
      canProbeDocker({
        env: { PATH: binDir, HOME: root },
        systemSockets: [],
      }),
    ).resolves.toMatchObject({
      ok: true,
      binaryPath: cliPath,
      socketPath,
    });
  });

  it("honors active Docker context unix sockets and remote endpoints", async () => {
    const root = makeTempRoot();
    const binDir = path.join(root, "bin");
    const cliPath = path.join(binDir, "docker");
    writeExecutable(cliPath);

    const dockerConfigDir = path.join(root, ".docker");
    const colimaSocket = await listenUnixSocket(path.join(root, "colima.sock"));
    mkdirSync(path.join(dockerConfigDir, "contexts", "meta", "ctx-colima"), { recursive: true });
    writeFileSync(
      path.join(dockerConfigDir, "config.json"),
      JSON.stringify({ currentContext: "colima" }),
      "utf8",
    );
    writeFileSync(
      path.join(dockerConfigDir, "contexts", "meta", "ctx-colima", "meta.json"),
      JSON.stringify({
        Name: "colima",
        Endpoints: { docker: { Host: `unix://${colimaSocket}` } },
      }),
      "utf8",
    );

    await expect(
      canProbeDocker({
        env: { PATH: binDir, HOME: root, DOCKER_CONFIG: dockerConfigDir },
        systemSockets: [],
      }),
    ).resolves.toMatchObject({
      ok: true,
      binaryPath: cliPath,
      socketPath: colimaSocket,
    });

    writeFileSync(
      path.join(dockerConfigDir, "config.json"),
      JSON.stringify({ currentContext: "remote-box" }),
      "utf8",
    );
    mkdirSync(path.join(dockerConfigDir, "contexts", "meta", "ctx-ssh"), { recursive: true });
    writeFileSync(
      path.join(dockerConfigDir, "contexts", "meta", "ctx-ssh", "meta.json"),
      JSON.stringify({
        Name: "remote-box",
        Endpoints: { docker: { Host: "ssh://devbox" } },
      }),
      "utf8",
    );

    await expect(
      canProbeDocker({
        env: { PATH: binDir, HOME: root, DOCKER_CONFIG: dockerConfigDir },
        systemSockets: [],
      }),
    ).resolves.toMatchObject({
      ok: true,
      binaryPath: cliPath,
      endpoint: "ssh://devbox",
    });
  });

  it("applies distinct cooldowns for killed/EPERM binaries vs daemon failures and resets when binary mtime updates", async () => {
    const root = makeTempRoot();
    const binDir = path.join(root, "bin");
    const cliPath = path.join(binDir, "docker");
    writeExecutable(cliPath);
    const guard = createDockerProbeGuard();
    const env = { PATH: binDir, HOME: root, DOCKER_HOST: "tcp://127.0.0.1:2375" };

    const firstCheck = await guard.check({ env, now: 1000, systemSockets: [] });
    expect(firstCheck.ok).toBe(true);

    guard.recordFailure(Object.assign(new Error("killed"), { signal: "SIGKILL" }), {
      binaryKey: firstCheck.binaryKey,
      now: 1000,
    });

    await expect(
      guard.check({ env, now: 1000 + DOCKER_FAILURE_BACKOFF_MS + 1, systemSockets: [] }),
    ).resolves.toMatchObject({ ok: false, reason: "backoff" });

    await expect(
      guard.check({ env, now: 1000 + DOCKER_BROKEN_BINARY_BACKOFF_MS, systemSockets: [] }),
    ).resolves.toMatchObject({ ok: true });

    const nextCheck = await guard.check({ env, now: 500_000, systemSockets: [] });
    guard.recordFailure(new Error("daemon error"), {
      binaryKey: nextCheck.binaryKey,
      now: 500_000,
    });
    await expect(
      guard.check({ env, now: 500_000 + DOCKER_FAILURE_BACKOFF_MS - 1, systemSockets: [] }),
    ).resolves.toMatchObject({ ok: false, reason: "backoff" });
    await expect(
      guard.check({ env, now: 500_000 + DOCKER_FAILURE_BACKOFF_MS, systemSockets: [] }),
    ).resolves.toMatchObject({ ok: true });

    // Reinstalling Docker (updating binary mtime) immediately clears a broken-binary backoff.
    const thirdCheck = await guard.check({ env, now: 700_000, systemSockets: [] });
    guard.recordFailure(Object.assign(new Error("EPERM"), { code: "EPERM" }), {
      binaryKey: thirdCheck.binaryKey,
      now: 700_000,
    });
    await expect(guard.check({ env, now: 701_000, systemSockets: [] })).resolves.toMatchObject({
      ok: false,
      reason: "backoff",
    });

    const bumpedSeconds = Math.floor(Date.now() / 1000) + 120;
    utimesSync(cliPath, bumpedSeconds, bumpedSeconds);
    await expect(guard.check({ env, now: 701_000, systemSockets: [] })).resolves.toMatchObject({
      ok: true,
    });
  });
});
