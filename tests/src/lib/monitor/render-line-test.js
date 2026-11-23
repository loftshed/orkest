import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, test } from "vitest";

import { dataAge, renderLine, resetClock } from "../../../../src/lib/monitor/render.mjs";

// Shared with ork-fast's turn-start quota line (crates/ork-fast/src/quota_line.rs), which must match it.
const shared = JSON.parse(
  readFileSync(
    new URL("../../../crates/ork-fast/fixtures/quota-line.json", import.meta.url),
    "utf8",
  ),
);
const accounts = () =>
  shared.config.accounts.map((a) => ({
    ...shared.snapshot.accounts[a.id],
    label: a.label,
    short: a.id.slice(0, 2).toUpperCase(),
  }));

const saved = { zone: process.env.TZ };
beforeEach(() => {
  process.env.TZ = "UTC";
});
afterEach(() => {
  if (saved.zone === undefined) delete process.env.TZ;
  else process.env.TZ = saved.zone;
});

test("the line names every window, its reset time and the data age", () => {
  expect(renderLine(accounts(), shared.now)).toBe(shared.line);
  const [claude] = accounts();
  expect(renderLine([claude], shared.now)).toBe(
    "Claude 5h 18% (↻8:10pm) · wk 42% (↻Thu 9:00am) · data 2m",
  );
});

test("a narrow line falls back to the terse form and keeps the age", () => {
  expect(renderLine(accounts(), shared.now, { width: 80 })).toBe(
    "CL 18·42 3d · CO 62,261.91 cr 7d · AN G99·49 12d C0·54 1d⏳ · data 5m",
  );
  expect(renderLine(accounts(), shared.now, { width: 1000 })).toBe(shared.line);
});

test("failed and empty accounts say so instead of showing a number", () => {
  const [claude] = accounts();
  expect(renderLine([{ ...claude, ok: false }], shared.now)).toBe(
    "Claude 5h 18% (↻8:10pm) · wk 42% (↻Thu 9:00am) (refresh failed) · data 2m",
  );
  expect(
    renderLine([{ id: "x", label: "Spare", ok: false, error: "not fetched yet" }], shared.now),
  ).toBe("Spare no data (refresh failed)");
  expect(renderLine([], shared.now)).toBe("");
});

test("reset clock and data age", () => {
  const now = shared.now; // Monday 15:00 UTC
  expect(resetClock(now + 70 * 60_000, now)).toBe("4:10pm");
  expect(resetClock(now + 3 * 86_400_000, now)).toBe("Thu 3:00pm");
  expect(resetClock(now + 10 * 86_400_000, now)).toBe("Dec 3");
  expect(resetClock(Date.parse("2026-11-24T00:05:00Z"), now)).toBe("Tue 12:05am");
  expect(dataAge(0)).toBe("0m");
  expect(dataAge(-5)).toBe("0m");
  expect(dataAge(59 * 60_000)).toBe("59m");
  expect(dataAge(3 * 3_600_000)).toBe("3h");
  expect(dataAge(50 * 3_600_000)).toBe("2d");
});
