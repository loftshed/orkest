import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
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

function resolveDefaultScript(): string {
  const homeCandidate = path.join(
    homedir(),
    ".agents/skills/orchestrate/scripts/agent_statusline.py",
  );
  if (existsSync(homeCandidate)) return homeCandidate;
  const colocated = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../skills/orchestrate/scripts/agent_statusline.py",
  );
  return existsSync(colocated) ? colocated : homeCandidate;
}

const defaultScript = resolveDefaultScript();

function Label(props: { sessionID?: string; plainColor: string; script: string }) {
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
        props.script,
        ...(terminal ? ["--native-status"] : []),
        "--session",
        session,
        "--harness",
        "opencode",
        "--width",
        String(Math.max(width, 32)),
        "--json",
      ];
      child = execFile("python3", args, { timeout: 2000 }, (error, output) => {
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
          "python3",
          [props.script, "--harness", "opencode", "--clear-terminal", session],
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
    const script =
      typeof context.options.script === "string" ? context.options.script : defaultScript;
    const tmuxScript = path.join(path.dirname(script), "agent_statusline_tmux.py");
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
        <Label sessionID={props.sessionID} plainColor={context.theme.text.base} script={script} />
      ),
    });
    return () => {
      if (typeof unregisterCmd === "function") unregisterCmd();
      if (typeof unregisterSlot === "function") unregisterSlot();
    };
  },
});
