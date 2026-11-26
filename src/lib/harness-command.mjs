// Name an Orkest command the way the user invokes it in their harness (twin of
// `identity::command_invocation` in crates/ork-fast).

const SLASH_HARNESSES = new Set(["claude", "gemini", "agy", "antigravity", "opencode"]);

/**
 * Claude Code, Antigravity and OpenCode run Orkest's commands and skills as `/name`; Codex runs
 * skills as `$name`. An unknown harness gets the `ork name` CLI command, which works anywhere.
 *
 * @param {string | null | undefined} harness
 * @param {string} name
 * @returns {string}
 */
export function commandInvocation(harness, name) {
  const normalized = typeof harness === "string" ? harness.trim() : "";
  if (normalized === "codex") return `$${name}`;
  if (SLASH_HARNESSES.has(normalized)) return `/${name}`;
  return `ork ${name}`;
}
