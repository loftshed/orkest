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
    return { project: identityHash(direct), standaloneDirectory: identityHash(directory) };
  return { project: identityHash(resolveCommonDirectory(cwd, directory)) };
}

function identityHash(identity) {
  return createHash("sha256")
    .update(
      JSON.stringify([String(identity.dev), String(identity.ino), String(identity.birthtimeNs)]),
    )
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
    return identity;
  }
  return directory;
}

export function roomProject(db, room, removed) {
  const { origin, epoch } = localStream(db, "rooms-local");
  const previous = db.tagStore.get`SELECT body FROM outbox_views WHERE scope='rooms-local'
    AND origin=${origin} AND epoch=${epoch} AND kind='room.record' AND entity=${room.id}`;
  const prior = previous && JSON.parse(previous.body);
  const binding = prior?.project ?? null;
  if (removed) return binding;
  // A legacy path is mutable. Looking it up now cannot attest who owned it when
  // that grant was issued. Preserve the old record and reserve its scope.
  if (prior && !Object.hasOwn(prior, "project")) fail("room_project_unverified");
  const observed = projectIdentity(room.cwd);
  const current = observed?.project ?? null;
  // Only a continuing standalone directory can acquire its own new Git identity.
  // Linked/redirected repositories and tombstones cannot inherit that grant.
  if (
    binding &&
    !prior.removed &&
    prior.room?.cwd === room.cwd &&
    observed?.standaloneDirectory === binding
  )
    return current;
  if (prior && !prior.removed && binding === null && current !== null)
    fail("room_project_unverified");
  if (binding && !current && !prior.removed && prior.room?.cwd === room.cwd) return binding;
  if (prior && (binding ? binding !== current : prior.removed || prior.room?.cwd !== room.cwd))
    fail("room_project_conflict");
  return current;
}
