import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, it } from "vitest";

import { runHordeTui } from "../../../plugins/orchestrate/bin/horde-tui.mjs";
import { markHerdrViewClosed } from "../../../plugins/orchestrate/lib/herdr-view-state.mjs";

const directories = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const created = await mkdtemp(path.join(tmpdir(), "ork-view-state-"));
  const root = await realpath(created);
  directories.push(root);
  const socket = path.join(root, "herdr.sock");
  const hash = (text) => createHash("sha256").update(text).digest("hex");
  const directory = path.join(root, "herdr-views-v1", hash(socket).slice(0, 24));
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `${hash("room-a")}.json`);
  await writeFile(
    file,
    JSON.stringify({
      schema: "orkest.herdr-view.v1",
      room: "room-a",
      endpoint: socket,
      host: hostname(),
    }),
  );
  return {
    file,
    closed: file.replace(/\.json$/u, ".closed"),
    env: {
      HERDR_ENV: "1",
      HERDR_SOCKET_PATH: socket,
      ORCHESTRATE_HOME: root,
      ORKEST_HERDR_VIEW_STATE: file,
    },
  };
}

it("records closure only for the matching server and room", async () => {
  const { env, closed } = await fixture();
  await markHerdrViewClosed("another-room", env);
  await expect(readFile(closed, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  await markHerdrViewClosed("room-a", env);
  expect(await readFile(closed, "utf8")).toBe("closed\n");
});

it("uses the same server identity through a socket symlink", async () => {
  const { env, closed } = await fixture();
  await writeFile(env.HERDR_SOCKET_PATH, "");
  const alias = `${env.HERDR_SOCKET_PATH}.alias`;
  await symlink(env.HERDR_SOCKET_PATH, alias);
  await markHerdrViewClosed("room-a", { ...env, HERDR_SOCKET_PATH: alias });
  expect(await readFile(closed, "utf8")).toBe("closed\n");
});

it.each(["q", "q then close", "close"])(
  "distinguishes deliberate q from terminal teardown: %s",
  async (event) => {
    const { env, closed } = await fixture();
    const input = Object.assign(new PassThrough(), {
      isTTY: true,
      isRaw: false,
      setRawMode() {},
      pause() {},
      resume() {
        setImmediate(() => {
          if (event !== "close") input.emit("data", "q");
          if (event !== "q") input.emit("close");
        });
      },
    });
    const output = Object.assign(new PassThrough(), {
      isTTY: true,
      rows: 24,
      columns: 80,
      write() {},
    });
    await runHordeTui(async () => ({ id: "room-a", conductor: {}, agents: [] }), {
      env,
      input,
      output,
      quota: false,
      services: false,
      update: false,
    });
    if (event === "close") {
      await expect(readFile(closed, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      expect(await readFile(closed, "utf8")).toBe("closed\n");
    }
  },
);
