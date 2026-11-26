import { describe, expect, it } from "vitest";

import { commandInvocation } from "../../../src/lib/harness-command.mjs";

describe("commandInvocation", () => {
  it.each([
    ["claude", "swarm", "/swarm"],
    ["codex", "swarm", "$swarm"],
    ["codex", "update", "$update"],
    ["gemini", "side", "/side"],
    ["agy", "side", "/side"],
    ["opencode", "update", "/update"],
  ])("names %s's %s command as %s", (harness, name, expected) => {
    expect(commandInvocation(harness, name)).toBe(expected);
  });

  it("falls back to the ork CLI when the harness is unknown", () => {
    expect(commandInvocation(undefined, "swarm")).toBe("ork swarm");
    expect(commandInvocation(null, "side")).toBe("ork side");
    expect(commandInvocation("something-else", "update")).toBe("ork update");
  });
});
