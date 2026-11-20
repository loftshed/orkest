import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Plugin } from "@opencode/plugin/tui";
import { createEffect, createSignal, onCleanup, Show } from "solid-js";

type Color = 31 | 32 | 33 | 34 | 35 | 36;
type Identity = { label: string; details: string; color: Color };

const colors: Record<Color, string> = {
  31: "#ed7777",
  32: "#80c979",
  33: "#dbb85c",
  34: "#87a7ed",
  35: "#ce94e8",
  36: "#70c5c4",
};

function parseIdentity(output: string): Identity | null {
  try {
    const value: unknown = JSON.parse(output);
    if (
      typeof value !== "object" ||
      value === null ||
      !("label" in value) ||
      !("details" in value) ||
      !("color" in value)
    )
      return null;
    if (typeof value.label !== "string" || typeof value.details !== "string") return null;
    switch (value.color) {
      case 31:
      case 32:
      case 33:
      case 34:
      case 35:
      case 36:
        return { label: value.label, details: value.details, color: value.color };
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function resolveCacheHome(): string {
  const explicit = process.env.ORCHESTRATE_HOME || process.env.AGENT_EXECUTOR_HOME;
  if (explicit) return explicit;
  const cacheRoot = process.env.XDG_CACHE_HOME || path.join(homedir(), ".cache");
  const primary = path.join(cacheRoot, "orchestrate");
  if (existsSync(primary)) return primary;
  const legacy = path.join(cacheRoot, "agent-executor");
  return existsSync(legacy) ? legacy : primary;
}

function resolveDefaultFastBin(): string {
  const explicit = process.env.ORK_FAST_BIN;
  if (explicit) return explicit;
  return path.join(resolveCacheHome(), "bin/ork-fast");
}

function resolveScriptsDir(): string {
  const local = path.dirname(fileURLToPath(import.meta.url));
  const source = path.resolve(existsSync(local) ? realpathSync(local) : local, "../../../src/py");
  if (existsSync(path.join(source, "agent_statusline_tmux.py"))) return source;
  const skill = path.join(homedir(), ".agents/skills/orchestrate");
  if (existsSync(skill)) {
    const installed = path.resolve(realpathSync(skill), "../../../src/py");
    if (existsSync(path.join(installed, "agent_statusline_tmux.py"))) return installed;
  }
  return source;
}

const defaultFastBin = resolveDefaultFastBin();
const defaultScriptsDir = resolveScriptsDir();

function Label(props: { sessionID?: string; plainColor: string; fastBin: string }) {
  const [item, setItem] = createSignal<Identity | null>(null);
  const [columns, setColumns] = createSignal(0);
  const terminal = Boolean(process.env.ORKEST_TERMINAL_SERVER || process.env.HERDR_ENV === "1");

  createEffect(() => {
    const session = props.sessionID;
    // Measure the actual composer slot so the band ends before any visible sidebar.
    const width = columns() - 6;
    setItem(null);
    if (!session || (!terminal && width < 32)) return;
    let active = true;
    let running = false;
    let child: ReturnType<typeof execFile> | undefined;
    const refresh = () => {
      if (running) return;
      running = true;
      const args = [
        "statusline",
        ...(terminal ? ["--native-status"] : []),
        "--session",
        session,
        "--harness",
        "opencode",
        "--width",
        String(Math.max(width, 32)),
        "--json",
      ];
      child = execFile(props.fastBin, args, { timeout: 2000 }, (error, output) => {
        running = false;
        child = undefined;
        if (active) setItem(error ? null : parseIdentity(output));
      });
    };
    refresh();
    const timer = setInterval(refresh, 3000);
    timer.unref?.();
    onCleanup(() => {
      active = false;
      clearInterval(timer);
      child?.kill();
      if (terminal) {
        execFile(
          props.fastBin,
          ["statusline", "--harness", "opencode", "--clear-terminal", session],
          { timeout: 2000 },
          () => {},
        );
      }
    });
  });

  return (
    <box
      width="100%"
      height={item() ? 1 : 0}
      flexDirection="row"
      onSizeChange={function () {
        setColumns(this.width);
      }}
    >
      <Show when={item()}>
        {(identity) => (
          <>
            <box
              width={2}
              height={1}
              flexShrink={0}
              backgroundColor={process.env.NO_COLOR ? undefined : colors[identity().color]}
            />
            <text fg={props.plainColor} wrapMode="none" flexShrink={0}>
              {" "}
              <span
                style={{ fg: process.env.NO_COLOR ? props.plainColor : colors[identity().color] }}
              >
                {identity().label}
              </span>
              {identity().details}
              {"   "}
            </text>
          </>
        )}
      </Show>
    </box>
  );
}

export default Plugin.define({
  id: "orkest.agent-statusline",
  setup(context) {
    const fastBin =
      typeof context.options.fastBin === "string" ? context.options.fastBin : defaultFastBin;
    const scriptsDir =
      typeof context.options.script === "string"
        ? path.dirname(context.options.script)
        : defaultScriptsDir;
    const tmuxScript = path.join(scriptsDir, "agent_statusline_tmux.py");
    const cmdApi = (
      context as unknown as {
        command?: { register?: (cb: () => unknown[]) => (() => void) | void };
      }
    ).command;
    const unregisterCmd = cmdApi?.register?.(() => [
      {
        title: "Toggle Orkest Swarm View",
        value: "orkest.swarm.toggle",
        description: "Open or close the Orkest Swarm View split pane",
        category: "Orkest",
        keybind: "ctrl+alt+s",
        slash: {
          name: "swarm",
          aliases: ["horde"],
        },
        onSelect(dialog?: { clear?: () => void }) {
          dialog?.clear?.();
          execFile(
            "python3",
            [tmuxScript, "--toggle-swarm", "toggle", "--harness", "opencode"],
            { timeout: 5000 },
            () => {},
          );
        },
      },
    ]);
    const unregisterSlot = context.ui.slot({
      append: "session.composer.top",
      render: (props) => (
        <Label sessionID={props.sessionID} plainColor={context.theme.text.base} fastBin={fastBin} />
      ),
    });
    return () => {
      if (typeof unregisterCmd === "function") unregisterCmd();
      if (typeof unregisterSlot === "function") unregisterSlot();
    };
  },
});
