import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

import {
  fetchAntigravity,
  hasAccountLoginFile,
  probeEnv,
} from "../../../../src/lib/monitor/providers/antigravity.mjs";

const withFile = { platform: "linux", hasLoginFile: () => true };

test("a probe with no SSH session is presented as one, so agy reads the sign-in file the other sessions use", () => {
  const original = Object.fromEntries(
    ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"].map((name) => [name, process.env[name]]),
  );
  for (const name of Object.keys(original)) delete process.env[name];
  try {
    expect(probeEnv({}, withFile).SSH_CONNECTION).toBe("127.0.0.1 0 127.0.0.1 22");
  } finally {
    for (const [name, value] of Object.entries(original))
      if (value !== undefined) process.env[name] = value;
  }
});

test("an existing SSH marker, from the caller or the account config, is left alone", () => {
  expect(probeEnv({ SSH_TTY: "/dev/pts/3" }, withFile).SSH_CONNECTION).not.toBe(
    "127.0.0.1 0 127.0.0.1 22",
  );
  expect(probeEnv({ SSH_CONNECTION: "10.0.0.1 1 10.0.0.2 22" }, withFile).SSH_CONNECTION).toBe(
    "10.0.0.1 1 10.0.0.2 22",
  );
});

test("without a sign-in file, or off Linux, the environment is not touched", () => {
  const clean = { SSH_CONNECTION: null, SSH_CLIENT: null, SSH_TTY: null };
  expect(probeEnv(clean, { platform: "linux", hasLoginFile: () => false }).SSH_CONNECTION).toBe(
    undefined,
  );
  expect(probeEnv(clean, { platform: "darwin", hasLoginFile: () => true }).SSH_CONNECTION).toBe(
    undefined,
  );
});

test("a null SSH variable in the account config opts out, even with a sign-in file", () => {
  expect(probeEnv({ SSH_CONNECTION: null }, withFile).SSH_CONNECTION).toBe(undefined);
});

test("strips synthetic loopback SSH_CONNECTION when no login file exists, while preserving real SSH or SSH_TTY", () => {
  const noFile = { platform: "linux", hasLoginFile: () => false };
  expect(
    probeEnv(
      { SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 22", SSH_CLIENT: null, SSH_TTY: null },
      noFile,
    ).SSH_CONNECTION,
  ).toBe(undefined);
  expect(
    probeEnv({ SSH_CONNECTION: "10.0.0.1 1 10.0.0.2 22", SSH_CLIENT: null, SSH_TTY: null }, noFile)
      .SSH_CONNECTION,
  ).toBe("10.0.0.1 1 10.0.0.2 22");
  expect(
    probeEnv(
      { SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 22", SSH_CLIENT: null, SSH_TTY: "/dev/pts/3" },
      noFile,
    ).SSH_CONNECTION,
  ).toBe("127.0.0.1 0 127.0.0.1 22");
});

test("ANTIGRAVITY_APP_DATA_DIR login-file lookup detects profile token files", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "monitor-ag-login-"));
  const original = Object.fromEntries(
    ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"].map((name) => [name, process.env[name]]),
  );
  for (const name of Object.keys(original)) delete process.env[name];
  try {
    expect(hasAccountLoginFile({ ANTIGRAVITY_APP_DATA_DIR: dir })).toBe(false);
    expect(probeEnv({ ANTIGRAVITY_APP_DATA_DIR: dir }, { platform: "linux" }).SSH_CONNECTION).toBe(
      undefined,
    );

    writeFileSync(path.join(dir, "antigravity-oauth-token"), "tok");
    expect(hasAccountLoginFile({ ANTIGRAVITY_APP_DATA_DIR: dir })).toBe(true);
    expect(probeEnv({ ANTIGRAVITY_APP_DATA_DIR: dir }, { platform: "linux" }).SSH_CONNECTION).toBe(
      "127.0.0.1 0 127.0.0.1 22",
    );

    const nested = mkdtempSync(path.join(tmpdir(), "monitor-ag-login-nested-"));
    try {
      mkdirSync(path.join(nested, "antigravity-cli"), { recursive: true });
      writeFileSync(path.join(nested, "antigravity-cli", "antigravity-oauth-token"), "tok");
      expect(hasAccountLoginFile({ ANTIGRAVITY_APP_DATA_DIR: nested })).toBe(true);
    } finally {
      rmSync(nested, { recursive: true, force: true });
    }
  } finally {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fetchAntigravity aborts quickly when agy waits for interactive authentication", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "monitor-ag-abort-"));
  try {
    const fakeAgy = path.join(dir, "fake-agy");
    writeFileSync(
      fakeAgy,
      String.raw`#!/usr/bin/env node
process.stdout.write("Authentication required.\nWaiting for authentication (timeout 60s)...\n");
setTimeout(() => {}, 30_000);
`,
    );
    chmodSync(fakeAgy, 0o755);
    const start = Date.now();
    await expect(
      fetchAntigravity({
        command: fakeAgy,
        env: { SSH_CONNECTION: null, SSH_CLIENT: null, SSH_TTY: null },
      }),
    ).rejects.toThrow(/requires interactive authentication/);
    expect(Date.now() - start).toBeLessThan(2000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
