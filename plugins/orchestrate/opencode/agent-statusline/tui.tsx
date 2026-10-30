import { execFile } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";

import { Plugin } from "@opencode/plugin/tui";
import { useTerminalDimensions } from "@opentui/solid";
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

const defaultScript = path.join(
  homedir(),
  ".agents/skills/orchestrate/scripts/agent_statusline.py",
);

function Label(props: { sessionID?: string; plainColor: string; script: string }) {
  const [item, setItem] = createSignal<Identity | null>(null);
  const dimensions = useTerminalDimensions();

  createEffect(() => {
    const session = props.sessionID;
    // Leave room for the sidebar when the host has enough columns to show it.
    const columns = dimensions().width;
    const width = Math.max(32, columns - (columns >= 120 ? 40 : 6));
    setItem(null);
    if (!session) return;
    let active = true;
    let running = false;
    const refresh = () => {
      if (running) return;
      running = true;
      execFile(
        "python3",
        [
          props.script,
          "--session",
          session,
          "--harness",
          "opencode",
          "--width",
          String(width),
          "--json",
        ],
        { timeout: 2000 },
        (error, output) => {
          running = false;
          if (active) setItem(error ? null : parseIdentity(output));
        },
      );
    };
    refresh();
    const timer = setInterval(refresh, 3000);
    timer.unref?.();
    onCleanup(() => {
      active = false;
      clearInterval(timer);
    });
  });

  return (
    <Show when={item()}>
      {(identity) => (
        <text fg={props.plainColor} wrapMode="none">
          <span style={{ fg: process.env.NO_COLOR ? props.plainColor : colors[identity().color] }}>
            {identity().label}
          </span>
          {identity().details}
        </text>
      )}
    </Show>
  );
}

export default Plugin.define({
  id: "orkest.agent-statusline",
  setup(context) {
    const script =
      typeof context.options.script === "string" ? context.options.script : defaultScript;
    return context.ui.slot({
      append: "session.composer.top",
      render: (props) => (
        <Label sessionID={props.sessionID} plainColor={context.theme.text.base} script={script} />
      ),
    });
  },
});
