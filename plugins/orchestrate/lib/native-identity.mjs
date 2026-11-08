import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

/** Read-only verification of the hook MAC; missing/legacy/changed claims fail closed. */
export function verifiedNativeIds(peer, root) {
  const signature = peer?.nativeSessionAttestation;
  if (typeof signature !== "string" || !/^[0-9a-f]{64}$/u.test(signature)) return [];
  try {
    const suffix =
      path.basename(root) === "mailbox-v1"
        ? "v1"
        : createHash("sha256").update(realpathSync(root)).digest("hex").slice(0, 12);
    const tokenPath = path.join(path.dirname(root), `mailbox-daemon-${suffix}`, "token.txt");
    const info = lstatSync(tokenPath);
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) return [];
    const tokenBytes = readFileSync(tokenPath);
    if (tokenBytes.some((byte) => byte > 127)) return [];
    const token = tokenBytes.toString("ascii").trim();
    if (!/^[A-Za-z0-9_-]{32,100}$/u.test(token)) return [];
    const message = JSON.stringify([
      "orkest.native-identity.v1",
      ...["session", "harness", "machine", "cwd", "checkout", "accountHome"].map(
        (key) => peer[key] ?? null,
      ),
      peer.nativeSession ?? null,
      peer.nativeSessions ?? null,
    ]);
    const expected = createHmac("sha256", token).update(message).digest();
    if (!timingSafeEqual(Buffer.from(signature, "hex"), expected)) return [];
    return [
      peer.nativeSession,
      ...(Array.isArray(peer.nativeSessions) ? peer.nativeSessions : []),
    ].filter(
      (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(value),
    );
  } catch {
    return [];
  }
}
