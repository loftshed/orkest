import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const repo = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const installer = path.join(repo, "install.sh");

function writeExecutable(filePath, contents) {
  writeFileSync(filePath, contents, "utf8");
  chmodSync(filePath, 0o755);
}

function findExecutable(name) {
  for (const directory of process.env.PATH.split(path.delimiter)) {
    const candidate = path.join(directory, name);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`could not find ${name} on PATH`);
}

function createFixture() {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "orkest-install-test-"));
  const home = path.join(tempRoot, "home");
  const logPath = path.join(tempRoot, "calls.log");
  const stubs = path.join(tempRoot, "stubs");
  mkdirSync(home);
  mkdirSync(stubs);

  const orchestrateStub = path.join(stubs, "orchestrate");
  const monitorStub = path.join(stubs, "monitor-install");
  const doctorStub = path.join(stubs, "doctor");

  writeExecutable(
    orchestrateStub,
    String.raw`#!/bin/sh
printf 'orchestrate' >> "$LOG_PATH"
for arg do printf ' %s' "$arg" >> "$LOG_PATH"; done
printf '\n' >> "$LOG_PATH"
`,
  );
  writeExecutable(
    monitorStub,
    String.raw`#!/bin/sh
[ -L "$HOME/.local/bin/ork" ] || exit 90
printf 'monitor' >> "$LOG_PATH"
for arg do printf ' %s' "$arg" >> "$LOG_PATH"; done
printf '\n' >> "$LOG_PATH"
mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/monitor" <<'LAUNCHER'
#!/bin/sh
printf 'monitor-launcher %s\n' "$*" >> "$LOG_PATH"
LAUNCHER
chmod 755 "$HOME/.local/bin/monitor"
`,
  );
  writeExecutable(
    doctorStub,
    String.raw`#!/bin/sh
printf 'doctor %s\n' "$*" >> "$LOG_PATH"
exit "$DOCTOR_EXIT"
`,
  );

  function makeEnvironment(overrides = {}) {
    return {
      ...process.env,
      HOME: home,
      LOG_PATH: logPath,
      DOCTOR_EXIT: "0",
      ORKEST_INSTALL_ORCHESTRATE: orchestrateStub,
      ORKEST_INSTALL_MONITOR: monitorStub,
      ORKEST_INSTALL_DOCTOR: doctorStub,
      ...overrides,
    };
  }

  function runInstall(args = [], overrides = {}) {
    return spawnSync(installer, args, {
      cwd: tempRoot,
      encoding: "utf8",
      env: makeEnvironment(overrides),
    });
  }

  function logLines() {
    if (!existsSync(logPath)) return [];
    return readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
  }

  return { doctorStub, home, logLines, monitorStub, runInstall, tempRoot };
}

function withFixture(run) {
  const fixture = createFixture();
  try {
    return run(fixture);
  } finally {
    rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
}

it("rejects an unknown option before running any installer", () =>
  withFixture(({ logLines, runInstall }) => {
    const result = runInstall(["--not-an-option"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Usage: ./install.sh [options]");
    expect(logLines()).toEqual([]);
  }));

it("prints help without running an installer", () =>
  withFixture(({ logLines, runInstall }) => {
    const result = runInstall(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--trust-codex-hooks");
    expect(logLines()).toEqual([]);
  }));

it("reports missing prerequisites and runs no installers", () =>
  withFixture(({ home, logLines, runInstall, tempRoot }) => {
    const restrictedPath = path.join(tempRoot, "path-without-tmux");
    mkdirSync(restrictedPath);
    for (const name of ["dirname", "git", "node", "python3"]) {
      symlinkSync(
        name === "node" ? process.execPath : findExecutable(name),
        path.join(restrictedPath, name),
      );
    }

    const result = runInstall([], { PATH: restrictedPath });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing required prerequisites:");
    expect(result.stderr).toContain("- tmux");
    expect(logLines()).toEqual([]);
    expect(readdirSync(home)).toEqual([]);
  }));

it("runs installers in order, passes options, and links ork", () =>
  withFixture(({ home, logLines, runInstall }) => {
    const result = runInstall(["--no-claude", "--trust-codex-hooks", "--no-app"]);
    expect(result.status).toBe(0);
    expect(logLines()).toEqual([
      "orchestrate --no-claude --trust-codex-hooks",
      "monitor --no-app",
      "monitor-launcher mcp-install",
      "doctor --check-messaging",
    ]);

    const orkLink = path.join(home, ".local/bin/ork");
    expect(lstatSync(orkLink).isSymbolicLink()).toBe(true);
    expect(readlinkSync(orkLink)).toBe(path.join(repo, "plugins/orchestrate/bin/ork.mjs"));
  }));

it("keeps dry-run changes out of HOME and previews monitor and doctor steps", () =>
  withFixture(({ doctorStub, home, logLines, monitorStub, runInstall }) => {
    const result = runInstall(["--dry-run", "--no-app"]);
    expect(result.status).toBe(0);
    expect(logLines()).toEqual(["orchestrate --dry-run"]);
    expect(readdirSync(home)).toEqual([]);
    expect(result.stdout).toContain(`would run: ${monitorStub} --no-app`);
    expect(result.stdout).toContain(
      `would run: ${path.join(home, ".local/bin/monitor")} mcp-install`,
    );
    expect(result.stdout).toContain(`would run: ${doctorStub} --check-messaging`);
  }));

it("skips both monitor steps when --no-monitor is selected", () =>
  withFixture(({ logLines, runInstall }) => {
    const result = runInstall(["--no-monitor"]);
    expect(result.status).toBe(0);
    expect(logLines()).toEqual(["orchestrate", "doctor --check-messaging"]);
    expect(result.stdout).toContain("Skipping monitor installation and MCP registration");
  }));

it("succeeds on a second run with the same installed state", () =>
  withFixture(({ home, logLines, runInstall }) => {
    expect(runInstall().status).toBe(0);
    expect(runInstall().status).toBe(0);
    expect(logLines()).toEqual([
      "orchestrate",
      "monitor",
      "monitor-launcher mcp-install",
      "doctor --check-messaging",
      "orchestrate",
      "monitor",
      "monitor-launcher mcp-install",
      "doctor --check-messaging",
    ]);
    expect(lstatSync(path.join(home, ".local/bin/ork")).isSymbolicLink()).toBe(true);
    expect(existsSync(path.join(home, ".local/bin/ork.orkest-backup"))).toBe(false);
  }));

it("returns a failing doctor status with a recovery instruction", () =>
  withFixture(({ runInstall }) => {
    const result = runInstall([], { DOCTOR_EXIT: "23" });
    expect(result.status).toBe(23);
    expect(result.stderr).toContain("Fix the reported checks, then re-run ./install.sh");
  }));
