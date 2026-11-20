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
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, onTestFinished } from "vitest";

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

  // The host may lack tmux or Git (the macOS CI runner has no tmux); the prerequisite check only
  // needs them to exist, so stand-ins keep these tests about the installer, not the host.
  const hostTools = path.join(tempRoot, "host-tools");
  mkdirSync(hostTools);
  for (const tool of ["tmux", "git"]) writeExecutable(path.join(hostTools, tool), "#!/bin/sh\n");

  function makeEnvironment(overrides = {}) {
    return {
      ...process.env,
      PATH: `${hostTools}${path.delimiter}${process.env.PATH}`,
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
    expect(result.stdout).toContain("--trust-orkest-commands");
    expect(result.stdout).toContain("--allow-credits consent is unchanged");
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
    const result = runInstall(["--trust-codex-hooks", "--no-app"]);
    expect(result.status).toBe(0);
    expect(logLines()).toEqual([
      "orchestrate --trust-codex-hooks",
      "monitor --no-app",
      "monitor-launcher mcp-install",
      "doctor --check-messaging",
    ]);

    const orkLink = path.join(home, ".local/bin/ork");
    expect(lstatSync(orkLink).isSymbolicLink()).toBe(true);
    expect(readlinkSync(orkLink)).toBe(path.join(repo, "src/bin/ork.mjs"));
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

it("forwards the Orkest command approval opt-in only when asked", () =>
  withFixture(({ logLines, runInstall }) => {
    expect(runInstall(["--no-monitor"]).status).toBe(0);
    expect(runInstall(["--no-monitor", "--trust-orkest-commands"]).status).toBe(0);
    expect(runInstall(["--dry-run", "--untrust-orkest-commands"]).status).toBe(0);
    expect(logLines()).toEqual([
      "orchestrate",
      "doctor --check-messaging",
      "orchestrate --trust-orkest-commands",
      "doctor --check-messaging",
      "orchestrate --dry-run --untrust-orkest-commands",
    ]);
  }));

it("rejects trusting and untrusting Orkest commands together", () =>
  withFixture(({ logLines, runInstall }) => {
    const result = runInstall(["--trust-orkest-commands", "--untrust-orkest-commands"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("choose one of --trust-orkest-commands");
    expect(logLines()).toEqual([]);
  }));

// ── standalone Monitor runtime ─────────────────────────────────────────────

const monitorInstaller = path.join(repo, "plugins/monitor/install.sh");

/** A throwaway checkout with just what plugins/monitor/install.sh copies, and an empty HOME. */
function monitorFixture({ version = "9.9.9", failing = false } = {}) {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "orkest-monitor-install-test-"));
  onTestFinished(() => rmSync(tempRoot, { recursive: true, force: true }));
  const checkout = path.join(tempRoot, "checkout");
  const home = path.join(tempRoot, "home");
  const files = {
    "package.json": JSON.stringify({ name: "orkest", version }),
    "plugins/monitor/config.example.json": "{}\n",
    "plugins/monitor/skills/monitor/SKILL.md": "---\nname: monitor\n---\n",
    "src/bin/monitor.mjs": failing
      ? "process.exit(3);\n"
      : 'import { VERSION } from "../lib/monitor/version.mjs";\nconsole.log(VERSION);\n',
    "src/bin/observe.mjs": "// observer\n",
    "src/bin/ork.mjs": "// not part of the standalone copy\n",
    "src/lib/monitor/version.mjs":
      'import { readFileSync } from "node:fs";\nexport const VERSION = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")).version;\n',
    "src/lib/chief.mjs": "// not part of the standalone copy\n",
  };
  for (const [relative, contents] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(checkout, relative)), { recursive: true });
    writeFileSync(path.join(checkout, relative), contents, "utf8");
  }
  mkdirSync(home, { recursive: true });
  const script = path.join(checkout, "plugins/monitor/install.sh");
  writeExecutable(script, readFileSync(monitorInstaller, "utf8"));
  const run = (...args) =>
    spawnSync("sh", [script, "--no-app", ...args], {
      env: { ...process.env, HOME: home, MONITOR_CONFIG: path.join(home, "monitor-config.json") },
      encoding: "utf8",
    });
  const runtime = path.join(home, ".local/share/monitor");
  const launcher = path.join(home, ".local/bin/monitor");
  const launch = (...args) =>
    spawnSync(launcher, args, { env: { PATH: process.env.PATH, HOME: home }, encoding: "utf8" });
  return { tempRoot, checkout, home, run, runtime, launcher, launch };
}

it("installs a standalone Monitor that runs with the checkout out of the way", () => {
  const fixture = monitorFixture();
  const installed = fixture.run();
  expect(installed.status, installed.stderr).toBe(0);
  const binaries = readdirSync(path.join(fixture.runtime, "src/bin"));
  expect(binaries.toSorted((a, b) => a.localeCompare(b))).toEqual(["monitor.mjs", "observe.mjs"]);
  expect(existsSync(path.join(fixture.runtime, "src/lib/monitor/version.mjs"))).toBe(true);
  expect(existsSync(path.join(fixture.runtime, "src/lib/chief.mjs"))).toBe(false);
  const manifest = JSON.parse(readFileSync(path.join(fixture.runtime, "package.json"), "utf8"));
  expect(manifest).toMatchObject({
    name: "monitor",
    version: "9.9.9",
  });
  expect(readlinkSync(path.join(fixture.home, ".agents/skills/monitor"))).toBe(
    path.join(fixture.runtime, "skills/monitor"),
  );

  const away = `${fixture.checkout}.away`;
  renameSync(fixture.checkout, away);
  const ran = fixture.launch("--version");
  renameSync(away, fixture.checkout);
  expect(ran.status, ran.stderr).toBe(0);
  expect(ran.stdout.trim()).toBe("9.9.9");
});

it("upgrades an old Monitor copy, keeping custom files and the previous copy, and is repeatable", () => {
  const fixture = monitorFixture();
  const old = fixture.runtime;
  mkdirSync(path.join(old, "bin"), { recursive: true });
  mkdirSync(path.join(old, "lib"), { recursive: true });
  mkdirSync(path.join(old, "src/bin"), { recursive: true });
  writeFileSync(path.join(old, "bin/monitor.mjs"), "// old\n");
  writeFileSync(path.join(old, "lib/old.mjs"), "// old\n");
  writeFileSync(path.join(old, "package.json"), '{"version":"0.0.1"}\n');
  writeFileSync(path.join(old, "notes.txt"), "mine\n");
  writeFileSync(path.join(old, "src/bin/custom.mjs"), "// mine\n");

  const first = fixture.run();
  expect(first.status, first.stderr).toBe(0);
  expect(readFileSync(path.join(old, "notes.txt"), "utf8")).toBe("mine\n");
  expect(readFileSync(path.join(old, "src/bin/custom.mjs"), "utf8")).toBe("// mine\n");
  expect(readFileSync(path.join(old, "bin/monitor.mjs"), "utf8")).toBe("// old\n");
  expect(fixture.launch("--version").stdout.trim()).toBe("9.9.9");
  const backups = path.join(fixture.home, ".local/share/monitor-backups");
  const [previous] = readdirSync(backups);
  expect(readFileSync(path.join(backups, previous, "package.json"), "utf8")).toBe(
    '{"version":"0.0.1"}\n',
  );

  const second = fixture.run();
  expect(second.status, second.stderr).toBe(0);
  expect(second.stdout).toContain("runtime unchanged");
  expect(readdirSync(backups)).toEqual([previous]);
});

it("leaves the installed Monitor runnable when the new copy fails its check", () => {
  const fixture = monitorFixture();
  expect(fixture.run().status).toBe(0);
  const before = readFileSync(fixture.launcher, "utf8");
  writeFileSync(
    path.join(fixture.checkout, "package.json"),
    '{"name":"orkest","version":"9.9.10"}',
  );
  writeFileSync(path.join(fixture.checkout, "src/bin/monitor.mjs"), "process.exit(3);\n");

  const failed = fixture.run();
  expect(failed.status).toBe(1);
  expect(failed.stderr).toContain("existing runtime was left in place");
  expect(readFileSync(fixture.launcher, "utf8")).toBe(before);
  expect(fixture.launch("--version").stdout.trim()).toBe("9.9.9");
  const backups = readdirSync(path.join(fixture.home, ".local/share/monitor-backups"));
  expect(backups.some((name) => name.startsWith("failed-"))).toBe(true);
});

it("keeps links the user made and never writes through them", () => {
  const fixture = monitorFixture();
  const own = path.join(fixture.home, "my-skill");
  mkdirSync(own, { recursive: true });
  mkdirSync(path.join(fixture.home, ".claude/skills"), { recursive: true });
  symlinkSync(own, path.join(fixture.home, ".claude/skills/monitor"));
  mkdirSync(path.join(fixture.home, ".codex/skills"), { recursive: true });
  symlinkSync("/nowhere/skills/monitor", path.join(fixture.home, ".codex/skills/monitor"));
  const historical = path.join(fixture.home, ".agents/skills");
  mkdirSync(historical, { recursive: true });
  symlinkSync("/old/checkout/plugins/monitor/skills/monitor", path.join(historical, "monitor"));

  const installed = fixture.run();
  expect(installed.status, installed.stderr).toBe(0);
  expect(readlinkSync(path.join(fixture.home, ".claude/skills/monitor"))).toBe(own);
  expect(readlinkSync(path.join(fixture.home, ".codex/skills/monitor"))).toBe(
    "/nowhere/skills/monitor",
  );
  expect(readlinkSync(path.join(historical, "monitor"))).toBe(
    path.join(fixture.runtime, "skills/monitor"),
  );

  const target = path.join(fixture.home, "elsewhere");
  mkdirSync(target);
  rmSync(path.join(fixture.runtime, "src/lib"), { recursive: true });
  // Neither the user's own link nor one that points where our installer once did is written through.
  symlinkSync(target, path.join(fixture.runtime, "src/lib"));
  const blocked = fixture.run();
  expect(blocked.status).toBe(1);
  expect(readdirSync(target)).toEqual([]);

  const skill = path.join(fixture.runtime, "skills/monitor");
  const skillBefore = readdirSync(skill);
  unlinkSync(path.join(fixture.runtime, "src/lib"));
  symlinkSync(skill, path.join(fixture.runtime, "src/lib"));
  expect(fixture.run().status).toBe(1);
  expect(readdirSync(skill)).toEqual(skillBefore);
});
