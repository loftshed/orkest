/**
 * @module hall
 *
 * Ork Hall (`ork hall` / `ork rooms`): Shared multi-agent coordination room
 * store and process observer. Manages room creation, member binding, leadership
 * branches, disposable worktree metadata (`ork hall worktree-keep`), and
 * direct Node.js observation of peer/progress/task JSON state.
 */
export * from "./rooms.mjs";
export * from "./stooges-room.mjs";
