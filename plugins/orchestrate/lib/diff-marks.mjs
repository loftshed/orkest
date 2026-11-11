import { randomUUID } from "node:crypto";
import { mkdir, readFile as readText, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

import { mailboxRoot } from "./horde-room.mjs";

const SAFE_ID = /^[\w-]{1,80}$/u;
/** A marked line is kept for the coordinator to quote; a minified bundle's single line is not. */
export const MAX_MARK_TEXT = 200;

/** The part of a diff line worth saving: one line, trimmed to `MAX_MARK_TEXT` characters. */
export function markText(line) {
  const text = String(line ?? "").replaceAll(/[\r\n]+/gu, " ");
  return text.length > MAX_MARK_TEXT ? `${text.slice(0, MAX_MARK_TEXT - 1)}…` : text;
}
const writeQueues = new Map();

function parsePath(value) {
  if (value === "/dev/null") return null;
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      const source = value.slice(1, -1);
      const bytes = [];
      for (let index = 0; index < source.length;) {
        if (source[index] === "\\") {
          const octal = /^[0-7]{1,3}/u.exec(source.slice(index + 1));
          if (octal) {
            bytes.push(Number.parseInt(octal[0], 8));
            index += octal[0].length + 1;
            continue;
          }
          const escaped = source[index + 1];
          const decoded =
            {
              a: "\u{7}",
              b: "\b",
              f: "\f",
              n: "\n",
              r: "\r",
              t: "\t",
              v: "\u{B}",
            }[escaped] || escaped;
          bytes.push(...Buffer.from(decoded, "utf8"));
          index += 2;
          continue;
        }
        const character = String.fromCodePoint(source.codePointAt(index));
        bytes.push(...Buffer.from(character, "utf8"));
        index += character.length;
      }
      return new TextDecoder().decode(Uint8Array.from(bytes));
    }
  }
  return value;
}

function fileFromHeader(line, prefix) {
  const header = prefix.slice(0, 4);
  if (!line.startsWith(header)) return null;
  const file = parsePath(line.slice(header.length));
  const side = prefix.slice(header.length);
  return file?.startsWith(side) ? file.slice(side.length) : null;
}

function validMarkFile(file) {
  return (
    typeof file === "string" &&
    file.length > 0 &&
    !file.includes("\0") &&
    !file.startsWith("/") &&
    !path.win32.isAbsolute(file) &&
    file.split("/").every((part) => part && part !== "." && part !== "..")
  );
}

function validMark(mark) {
  return (
    mark &&
    typeof mark === "object" &&
    validMarkFile(mark.file) &&
    Number.isSafeInteger(mark.line) &&
    mark.line > 0 &&
    (mark.side === "new" || mark.side === "old") &&
    typeof mark.text === "string" &&
    mark.text.length <= MAX_MARK_TEXT
  );
}

function marksPath(root, roomId, memberId) {
  if (!SAFE_ID.test(roomId || "") || !SAFE_ID.test(memberId || ""))
    throw new Error(
      "Room and member IDs must contain only letters, digits, underscores or hyphens",
    );
  return path.join(root, "diff-marks", roomId, `${memberId}.json`);
}

/** Map each unified-diff source line to its file, old/new line numbers, and kind. */
export function mapDiffLines(text) {
  const lines = String(text ?? "").split(/\r?\n/u);
  const mapped = [];
  let file = null;
  let oldLine = null;
  let newLine = null;

  for (const line of lines) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(?:.*)$/u.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      mapped.push({ file, newLine: null, oldLine: null, kind: "meta" });
      continue;
    }

    if (oldLine !== null && newLine !== null) {
      if (line.startsWith(" ")) {
        mapped.push({ file, newLine, oldLine, kind: "context" });
        oldLine++;
        newLine++;
        continue;
      }
      if (line.startsWith("+")) {
        mapped.push({ file, newLine, oldLine: null, kind: "added" });
        newLine++;
        continue;
      }
      if (line.startsWith("-")) {
        mapped.push({ file, newLine: null, oldLine, kind: "removed" });
        oldLine++;
        continue;
      }
      if (line.startsWith("\\")) {
        mapped.push({ file, newLine: null, oldLine: null, kind: "meta" });
        continue;
      }
      oldLine = null;
      newLine = null;
    }

    if (line.startsWith("diff --git ")) {
      file = null;
      oldLine = null;
      newLine = null;
    } else if (line.startsWith("--- ")) {
      file = fileFromHeader(line, "--- a/") || file;
    } else if (line.startsWith("+++ ")) {
      file = fileFromHeader(line, "+++ b/") || file;
    }
    mapped.push({ file, newLine: null, oldLine: null, kind: "meta" });
  }

  return mapped;
}

/** Read the result fingerprint used to detect marks from a previous worker result. */
export async function readResultFingerprint(resultPath, { readFile = readText } = {}) {
  if (typeof resultPath !== "string" || !resultPath.trim()) return;
  try {
    const result = JSON.parse(await readFile(resultPath, "utf8"));
    const fingerprint = result?.git_after?.fingerprint;
    if (typeof fingerprint === "string") return fingerprint;
  } catch {
    return;
  }
}

/** Load one member's saved marks, retaining the stored marks when their fingerprint is stale. */
export async function readDiffMarks(
  roomId,
  member,
  { root = mailboxRoot(), fingerprint, readFile = readText } = {},
) {
  const target = marksPath(root, roomId, member?.id);
  let record;
  try {
    record = JSON.parse(await readFile(target, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return { marks: [], stale: false, available: false };
    throw error;
  }
  if (
    !record ||
    record.member !== member.id ||
    !Array.isArray(record.marks) ||
    !record.marks.every(validMark)
  )
    throw new Error("Stored diff marks are invalid");

  const currentFingerprint =
    fingerprint === undefined
      ? await readResultFingerprint(member.resultPath, { readFile })
      : fingerprint;
  return {
    marks: record.marks,
    stale: (record.fingerprint ?? null) !== (currentFingerprint ?? null),
    available: true,
    record,
  };
}

/** Write marks atomically under the mailbox root, serializing updates per member. */
export async function writeDiffMarks(
  roomId,
  member,
  marks,
  { root = mailboxRoot(), now = Date.now, readFile = readText } = {},
) {
  if (!Array.isArray(marks) || !marks.every(validMark))
    throw new Error("Diff marks must have a safe file, positive line, side and text");
  const target = marksPath(root, roomId, member?.id);
  const operation = async () => {
    const fingerprint = await readResultFingerprint(member.resultPath, { readFile });
    const record = {
      member: member.id,
      resultPath: member.resultPath,
      fingerprint: fingerprint ?? null,
      updatedAt: new Date(now()).toISOString(),
      marks,
    };
    const directory = path.dirname(target);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporary, target);
    } catch (error) {
      try {
        await unlink(temporary);
      } catch {
        // The temporary file may not exist if creation failed.
      }
      throw error;
    }
    return record;
  };

  const previous = writeQueues.get(target);
  const next = (async () => {
    if (previous) {
      try {
        await previous;
      } catch {
        // A failed write must not prevent a later mark update from succeeding.
      }
    }
    return operation();
  })();
  writeQueues.set(target, next);
  try {
    return await next;
  } finally {
    if (writeQueues.get(target) === next) writeQueues.delete(target);
  }
}
