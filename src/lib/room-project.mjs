import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, statSync } from "node:fs";
import path from "node:path";

import { fail, localStream } from "./outbox.mjs";

// These identities stay in the private rooms-local record, including its tombstone.
// Worktrees share Git's common directory; standalone projects use their directory identity.
function projectIdentity(cwd) {
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) return null;
  const directory = statSync(cwd, { bigint: true, throwIfNoEntry: false });
  if (!directory?.isDirectory()) return null;
  const dotGit = path.join(cwd, ".git");
  const direct = lstatSync(dotGit, { bigint: true, throwIfNoEntry: false });
  const inPlaceRepository =
    direct?.isDirectory() &&
    statSync(path.join(dotGit, "HEAD"), { throwIfNoEntry: false })?.isFile() &&
    statSync(path.join(dotGit, "objects"), { throwIfNoEntry: false })?.isDirectory() &&
    !statSync(path.join(dotGit, "commondir"), { throwIfNoEntry: false });
  if (inPlaceRepository)
    return {
      ...identities(direct),
      standaloneDirectory: identityHash(directory),
      legacyStandaloneDirectory: legacyIdentityHash(directory),
      verified: true,
    };
  const { identity, verified } = resolveCommonDirectory(cwd, directory);
  return { ...identities(identity), verified };
}

function identities(identity) {
  return { project: identityHash(identity), legacyProject: legacyIdentityHash(identity) };
}

// st_dev is left out: a volume's device number changes across reboots (APFS) and
// remounts, while the inode and birth time of one directory on it do not.
function identityHash(identity) {
  return digest([identity.ino, identity.birthtimeNs]);
}

// Records written before that change also hashed st_dev. Only used to recognise them.
function legacyIdentityHash(identity) {
  return digest([identity.dev, identity.ino, identity.birthtimeNs]);
}

function digest(fields) {
  return createHash("sha256")
    .update(JSON.stringify(fields.map(String)))
    .digest("hex");
}

function resolveCommonDirectory(cwd, directory) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  const git = spawnSync(
    "git",
    ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    {
      env,
      timeout: 1000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (git.error || git.signal) fail("room_project_unavailable");
  if (git.status === 0) {
    const gitDir = git.stdout.trimEnd();
    const identity = statSync(gitDir, { bigint: true });
    if (!identity.isDirectory()) fail("room_project_unavailable");
    return { identity, verified: true };
  }
  // Git refusing a directory with a .git at or above it (a sandbox, an ownership check)
  // does not show a standalone project, so that fallback identity stays unverified.
  return { identity: directory, verified: !insideGitTree(cwd) };
}

function insideGitTree(cwd) {
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    if (lstatSync(path.join(dir, ".git"), { throwIfNoEntry: false })) return true;
    if (path.dirname(dir) === dir) return false;
  }
}

// The record fields for a binding. A record without projectVerified holds a legacy hash.
function fields(project, verified) {
  return verified === undefined ? { project } : { project, projectVerified: verified };
}

/**
 * The project fields for a room's next rooms-local record. `closing` marks a write that
 * leaves the room closed: that only stops tracking, so it keeps the saved binding unchecked.
 */
export function roomProject(db, room, { removed = false, closing = false } = {}) {
  const { origin, epoch } = localStream(db, "rooms-local");
  const previous = db.tagStore.get`SELECT body FROM outbox_views WHERE scope='rooms-local'
    AND origin=${origin} AND epoch=${epoch} AND kind='room.record' AND entity=${room.id}`;
  const prior = previous && JSON.parse(previous.body);
  let binding = prior?.project ?? null;
  let verified = prior?.projectVerified;
  if (removed) return fields(binding, verified);
  const isSameRoom = Boolean(prior && !prior.removed && prior.room?.cwd === room.cwd);
  if (closing && isSameRoom) return fields(binding, verified);
  // A legacy path is mutable. Looking it up now cannot attest who owned it when
  // that grant was issued. Preserve the old record and reserve its scope.
  if (prior && !Object.hasOwn(prior, "project")) fail("room_project_unverified");
  const observed = projectIdentity(room.cwd);
  const current = observed?.project ?? null;
  if (binding && verified === undefined && observed) {
    // A legacy hash cannot be split back into its fields. It still matches while st_dev
    // is unchanged. Otherwise a continuing room whose cwd is unchanged re-binds once to
    // the identity found there now: the one case this admits wrongly is cwd having been
    // replaced by another repository between the two writes.
    const rebound =
      (binding === observed.legacyProject && observed.project) ||
      (binding === observed.legacyStandaloneDirectory && observed.standaloneDirectory) ||
      (isSameRoom && observed.verified && current);
    if (rebound) [binding, verified] = [rebound, observed.verified];
  }
  // Only a continuing standalone directory can acquire its own new Git identity.
  // Linked/redirected repositories and tombstones cannot inherit that grant.
  if (isSameRoom && binding && observed?.standaloneDirectory === binding)
    return fields(current, true);
  if (prior && !prior.removed && binding === null && current !== null)
    fail("room_project_unverified");
  // An unverified identity attests nothing: it neither replaces a saved binding nor
  // holds against a verified one found later for the same room.
  if (isSameRoom && binding && (!current || !observed.verified)) return fields(binding, verified);
  if (isSameRoom && binding && verified === false) return fields(current, true);
  if (prior && (binding ? binding !== current : prior.removed || prior.room?.cwd !== room.cwd))
    fail("room_project_conflict");
  return fields(current, observed?.verified ?? true);
}
