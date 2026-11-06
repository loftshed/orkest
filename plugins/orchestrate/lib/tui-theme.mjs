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
  button: "48;5;237;97",
  buttonPrimary: "48;5;237;97;1",
  buttonActive: "46;30;1",
  buttonHover: "7;1",
  buttonDisabled: "48;5;235;90",
  buttonDanger: "41;97;1",
  identity31: "38;5;203;1",
  identity32: "38;5;114;1",
  identity33: "38;5;221;1",
  identity34: "38;5;111;1",
  identity35: "38;5;176;1",
  identity36: "38;5;80;1",
  leadModel: "38;5;117;1",
  leadEffort: "38;5;180;1",
  leadSeparator: "38;5;245",
  leadBranch: "38;5;176",
  leadEngine: "38;5;80",
  leadWarning: "38;5;221;1",
  leadError: "38;5;203;1",
  leadSuccess: "38;5;114;1",
  leadPlanning: "38;5;180;1",
  leadTesting: "38;5;80;1",
  quotaHover: "97;1",
  agentSelected: "48;5;237;97;1",
  quotaWork: "36",
  quotaPersonal: "35",
  quotaOk: "38;5;71",
  quotaMid: "38;5;179",
  quotaLow: "38;5;208",
  quotaTrack: "2;38;5;240",
  brandClaude: "38;5;173",
  brandGoogle: "38;5;33",
  brandOpenAI: "37",
  swarmHeading: "48;5;237;97;1",
  shimmerBase: "38;5;245",
  shimmerEdge: "38;5;108",
  shimmerMid: "38;5;107",
  shimmerPeak: "38;5;150;1",
  shimmerSpinner: "38;5;149",
  mdH1: "48;5;237;97;1",
  mdH2: "36;1",
  mdH3: "33;1",
  mdH4: "35;1",
  mdSection: "36;1",
  mdCode: "36",
  mdCodeBorder: "2;36",
  mdBullet: "36",
  mdQuote: "2",
  mdQuoteBar: "36",
  mdRule: "2",
  mdBadgeInfo: "36;1",
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
