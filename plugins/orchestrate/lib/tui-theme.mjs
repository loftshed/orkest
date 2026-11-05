/** Shared SGR tokens. Terminal palette colours adapt to the user's terminal theme. */
export const DEFAULT_THEME = Object.freeze({
  cyan: "36",
  green: "32",
  yellow: "33",
  red: "31",
  dim: "2",
  bold: "1",
  inverse: "7",
  border: "36",
  heading: "1",
  muted: "2",
  selected: "7;1",
  running: "36",
  success: "32",
  warning: "33",
  error: "31",
  // Compatibility names used by existing command renderers.
  headerBg: "48;5;236;97;1",
  folderHeader: "1",
});

/** Resolve once per view; customising one view never changes another. */
export function resolveTheme(overrides = {}) {
  for (const [name, code] of Object.entries(overrides)) {
    if (
      !Object.hasOwn(DEFAULT_THEME, name) ||
      typeof code !== "string" ||
      !/^(?:\d+(?:;\d+)*)?$/u.test(code)
    ) {
      throw new TypeError(`Invalid terminal theme token: ${name}`);
    }
  }
  const theme = { ...DEFAULT_THEME, ...overrides };
  if (overrides.selected !== undefined && overrides.headerBg === undefined)
    theme.headerBg = overrides.selected;
  if (overrides.heading !== undefined && overrides.folderHeader === undefined)
    theme.folderHeader = overrides.heading;
  return Object.freeze(theme);
}
