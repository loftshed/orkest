import { expect, test } from "vitest";

import { probeEnv } from "../../../plugins/monitor/lib/providers/antigravity.mjs";

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
