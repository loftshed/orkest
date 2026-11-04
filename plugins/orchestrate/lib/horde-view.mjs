/**
 * @module horde-view
 *
 * Horde View (`ork horde`): Unified live terminal card-tree TUI (`HordeView`)
 * rendering the coordinator summary card, subscription quota strip, folder
 * banners with continuous vertical tree rails, and multi-column agent cards
 * with disposable worktree badges (`wt:<slug>`).
 */
export {
  agentFolder,
  ANSI,
  cellWidth,
  displayWidth,
  fit,
  fitStyled,
  frame,
  GLYPHS,
  glyphSet,
  glyphTier,
  HordeView,
  plain,
  progressBar,
  renderPanel,
  renderTable,
  SPINNER,
  StoogesView,
  tone,
  worktreeBadge,
  wrapText,
} from "./stooges-view.mjs";
