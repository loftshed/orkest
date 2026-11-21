import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";

import { evaluateNextCandidates } from "../../../src/lib/next.mjs";
import { retainFixtures } from "../../helpers/retain-fixtures.js";

const temporary = [];
afterEach(() => retainFixtures(temporary.splice(0)));

const evaluate = async (agents) => {
  const created = await mkdtemp(path.join(tmpdir(), "orkest-next-"));
  temporary.push(created);
  const cwd = await realpath(created);
  return evaluateNextCandidates({
    cwd,
    discoverWorktreesFn: async () => [],
    getAccountsFn: async () => ({ accounts: [] }),
    room: { id: "room-next", cwd, agents },
  });
};
const questions = (result) => JSON.stringify(result).match(/room_question/gu)?.length ?? 0;

it("ork next does not ask a human about an answered consultation or a finished member", async () => {
  const done = { status: "reported complete", question: "Which strategy?" };
  const result = await evaluate([
    { id: "consult", ...done, completion: "answered" },
    { id: "subagent", ...done, completion: "untracked" },
  ]);
  expect(questions(result)).toBe(0);
});

it("ork next still surfaces a member that is blocked or asking", async () => {
  const result = await evaluate([
    { id: "asking", status: "running", question: "Archive by default?" },
    { id: "stuck", status: "blocked" },
    { id: "unreviewed", status: "reported complete", question: "Is this right?" },
  ]);
  expect(questions(result)).toBeGreaterThanOrEqual(3);
});
