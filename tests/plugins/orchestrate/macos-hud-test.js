import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import {
  macosHudPayload,
  macosHudTarget,
  resolveMacosHudBinary,
  sendMacosHudToast,
} from "../../../plugins/orchestrate/lib/macos-hud.mjs";
import { sendHerdrApprovalNotification } from "../../../plugins/orchestrate/lib/next.mjs";

describe("macos-hud dispatch", () => {
  test("resolveMacosHudBinary honors ORKEST_HUD_BIN override and cacheHome default path", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "orkest-hud-resolve-"));
    try {
      const override = path.join(dir, "custom-hud");
      writeFileSync(override, "#!/bin/sh\nexit 0\n");
      chmodSync(override, 0o644);
      expect(resolveMacosHudBinary({ ORKEST_HUD_BIN: override })).toBeNull();
      chmodSync(override, 0o755);
      expect(resolveMacosHudBinary({ ORKEST_HUD_BIN: override })).toBe(override);

      const xdgCache = path.join(dir, "xdg-cache");
      const cachedHud = path.join(
        xdgCache,
        "orchestrate",
        "macos",
        "OrkestHUD.app",
        "Contents",
        "MacOS",
        "OrkestHUD",
      );
      mkdirSync(path.dirname(cachedHud), { recursive: true });
      writeFileSync(cachedHud, "#!/bin/sh\nexit 0\n");
      chmodSync(cachedHud, 0o755);

      expect(resolveMacosHudBinary({ XDG_CACHE_HOME: xdgCache })).toBe(cachedHud);
      expect(
        resolveMacosHudBinary({
          ORKEST_HUD_BIN: path.join(dir, "missing-override"),
          XDG_CACHE_HOME: xdgCache,
        }),
      ).toBeNull();
      expect(resolveMacosHudBinary({ XDG_CACHE_HOME: path.join(dir, "empty-cache") })).toBeNull();
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test("macosHudPayload normalizes fields and detects Herdr or Orca targets from env", () => {
    expect(
      macosHudTarget({
        HERDR_BIN_PATH: "/opt/bin/herdr",
        HERDR_ENV: "1",
        HERDR_PANE_ID: "w1:p4",
        ORCA_TERMINAL_HANDLE: "term_9",
      }),
    ).toEqual({
      bin: "/opt/bin/herdr",
      id: "w1:p4",
      kind: "herdr",
    });

    expect(
      macosHudTarget({
        ORCA_CLI_COMMAND: "/opt/orca/orca-ide",
        ORCA_TERMINAL_HANDLE: "term_9",
      }),
    ).toEqual({
      bin: "/opt/orca/orca-ide",
      id: "term_9",
      kind: "orca",
    });

    const payload = macosHudPayload(
      {
        agent: "builder",
        body: "All checks green",
        durationSeconds: 6,
        repo: "orkest",
        sound: "done",
        status: "done",
        title: "Task finished",
      },
      { ORCA_TERMINAL_HANDLE: "term_7" },
    );
    expect(payload).toEqual({
      agent: "builder",
      body: "All checks green",
      durationSeconds: 6,
      repo: "orkest",
      sound: "done",
      status: "done",
      target: { id: "term_7", kind: "orca" },
      title: "Task finished",
    });

    const withoutTarget = macosHudPayload(
      { body: "Plain alert", target: null, title: "Notice" },
      { ORCA_TERMINAL_HANDLE: "term_7" },
    );
    expect(withoutTarget.target).toBeUndefined();
  });

  test("sendMacosHudToast never spawns outside darwin or when binary is missing", () => {
    const calls = [];
    const execMock = (binary, args, options, callback) => {
      calls.push({ args, binary, options });
      callback?.(null, "", "");
    };

    expect(
      sendMacosHudToast(
        { body: "hi", title: "Test" },
        {
          env: { ORKEST_HUD_BIN: "/fake/OrkestHUD" },
          exec: execMock,
          exists: () => true,
          platform: "linux",
        },
      ),
    ).toBe(false);
    expect(
      sendMacosHudToast(
        { body: "hi", title: "Test" },
        {
          env: { ORKEST_HUD_BIN: "/fake/OrkestHUD" },
          exec: execMock,
          exists: () => false,
          platform: "darwin",
        },
      ),
    ).toBe(false);
    expect(calls).toHaveLength(0);

    expect(
      sendMacosHudToast(
        { body: "Ready", status: "done", title: "Build complete" },
        {
          env: { ORKEST_HUD_BIN: "/fake/OrkestHUD" },
          exec: execMock,
          exists: () => true,
          platform: "darwin",
        },
      ),
    ).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].binary).toBe("/fake/OrkestHUD");
    expect(calls[0].args[0]).toBe("--json");
    expect(JSON.parse(calls[0].args[1])).toEqual({
      body: "Ready",
      status: "done",
      title: "Build complete",
    });

    expect(
      sendMacosHudToast(
        { body: "Ready", title: "Test" },
        {
          env: { ORKEST_HUD_BIN: "/fake/OrkestHUD" },
          exec: () => {
            throw new Error("spawn failed");
          },
          exists: () => true,
          platform: "darwin",
        },
      ),
    ).toBe(false);
  });

  test("sendHerdrApprovalNotification keeps Herdr path and falls back to macOS HUD on darwin", () => {
    const herdrCalls = [];
    const hudCalls = [];

    expect(
      sendHerdrApprovalNotification("Orkest: Approval needed", "Review wt-1", {
        env: { HERDR_BIN_PATH: "/bin/herdr", HERDR_ENV: "1" },
        exec: (binary, args) => {
          hudCalls.push({ args, binary });
        },
        execFileSyncFn: (binary, args) => {
          herdrCalls.push({ args, binary });
        },
        exists: () => true,
        platform: "darwin",
      }),
    ).toBe(true);
    expect(herdrCalls).toEqual([
      {
        args: [
          "notification",
          "show",
          "Orkest: Approval needed",
          "--body",
          "Review wt-1",
          "--sound",
          "request",
        ],
        binary: "/bin/herdr",
      },
    ]);
    expect(hudCalls).toHaveLength(0);

    expect(
      sendHerdrApprovalNotification("Orkest: Approval needed", "High blast radius", {
        env: {
          ORCA_TERMINAL_HANDLE: "term_22",
          ORKEST_HUD_BIN: "/fake/OrkestHUD",
        },
        exec: (binary, args, _opts, cb) => {
          hudCalls.push({ args, binary });
          cb?.(null, "", "");
        },
        exists: () => true,
        platform: "darwin",
      }),
    ).toBe(true);
    expect(hudCalls).toHaveLength(1);
    expect(hudCalls[0].binary).toBe("/fake/OrkestHUD");
    expect(JSON.parse(hudCalls[0].args[1])).toEqual({
      body: "High blast radius",
      sound: "request",
      status: "approval",
      target: { id: "term_22", kind: "orca" },
      title: "Orkest: Approval needed",
    });

    expect(
      sendHerdrApprovalNotification("Orkest: Approval needed", "Body", {
        env: { ORKEST_HUD_BIN: "/fake/OrkestHUD" },
        exists: () => true,
        platform: "linux",
      }),
    ).toBe(false);
  });
});

describe.runIf(process.platform === "darwin")("OrkestHUD.app Swift integration", () => {
  test("build.sh compiles OrkestHUD.app and --dump-card emits normalized card JSON", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "orkest-hud-build-"));
    try {
      const appPath = path.join(dir, "OrkestHUD.app");
      const buildScript = new URL("../../../plugins/orchestrate/macos/build.sh", import.meta.url)
        .pathname;
      const build = spawnSync(buildScript, [appPath], {
        encoding: "utf8",
        env: { ...process.env, ORKEST_HUD_BUILD_HASH: "test-hash-1" },
        timeout: 90_000,
      });
      expect(build.status, build.stderr).toBe(0);

      const plist = readFileSync(path.join(appPath, "Contents", "Info.plist"), "utf8");
      expect(plist).toContain("local.orkest.hud");
      expect(plist).toContain("<key>LSUIElement</key><true/>");
      expect(plist).toContain("test-hash-1");

      const binary = path.join(appPath, "Contents", "MacOS", "OrkestHUD");
      expect(existsSync(binary)).toBe(true);

      const dumpDone = spawnSync(
        binary,
        [
          "--dump-card",
          "--json",
          JSON.stringify({
            agent: "worker-1",
            body: "6 tests passed",
            repo: "orkest",
            status: "done",
            target: { id: "w1:p2", kind: "herdr" },
            title: "Build finished",
          }),
        ],
        { encoding: "utf8", timeout: 15_000 },
      );
      expect(dumpDone.status, dumpDone.stderr).toBe(0);
      expect(JSON.parse(dumpDone.stdout)).toEqual({
        accentHex: "#10B981",
        actionHint: "Click to focus pane",
        badge: "DONE",
        body: "6 tests passed",
        durationSeconds: 5,
        header: "Orkest · orkest · worker-1",
        target: { id: "w1:p2", kind: "herdr" },
        title: "Build finished",
      });

      const dumpBlocked = spawnSync(binary, ["--dump-card", "--stdin-json"], {
        encoding: "utf8",
        input: JSON.stringify({
          body: "Requires approval",
          status: "approval",
          title: "Approval needed",
        }),
        timeout: 15_000,
      });
      expect(dumpBlocked.status, dumpBlocked.stderr).toBe(0);
      expect(JSON.parse(dumpBlocked.stdout)).toEqual({
        accentHex: "#F59E0B",
        actionHint: "",
        badge: "APPROVAL",
        body: "Requires approval",
        durationSeconds: 7,
        header: "Orkest",
        target: null,
        title: "Approval needed",
      });
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  }, 120_000);
});
