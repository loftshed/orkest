import {
  constants,
  copyFileSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  utimesSync,
} from "node:fs";
import path from "node:path";

// Earlier file-only writers must be stopped for the documented maintenance window.
export function copyRetained(source, target, relative, identities = new Map()) {
  const file = path.join(source, relative);
  const dest = path.join(target, relative);
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return 0;
  if (stat.isDirectory()) {
    mkdirSync(dest, { mode: 0o700 });
    let count = 0;
    for (const name of readdirSync(file))
      count += copyRetained(source, target, path.join(relative, name), identities);
    return count;
  }
  if (!stat.isFile()) throw new Error(`Unsupported retained entry: ${relative}`);
  const key = `${stat.dev}:${stat.ino}`;
  if (identities.has(key)) linkSync(identities.get(key), dest);
  else {
    copyFileSync(file, dest, constants.COPYFILE_EXCL);
    utimesSync(dest, stat.atime, stat.mtime);
    identities.set(key, dest);
  }
  return 1;
}
