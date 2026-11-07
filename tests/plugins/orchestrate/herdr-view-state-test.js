import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, it } from "vitest";

import { runHordeTui } from "../../../plugins/orchestrate/bin/horde-tui.mjs";
import {
  herdrSwarmPaneLabel,
  markHerdrViewClosed,
  syncHerdrViewLabel,
} from "../../../plugins/orchestrate/lib/herdr-view-state.mjs";

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
      pane: "w1:p2",
      endpoint: socket,
      host: hostname(),
    }),
  );
  return {
    file,
    closed: file.replace(/\.json$/u, ".closed"),
    env: {
      HERDR_ENV: "1",
      HERDR_PANE_ID: "w1:p2",
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

it("formats Herdr swarm pane labels and syncs live title changes to Herdr", async () => {
  const { env, file } = await fixture();
  const initialRecord = JSON.parse(await readFile(file, "utf8"));
  await writeFile(
    file,
    JSON.stringify({
      ...initialRecord,
      pane: "w1:p2",
      terminal_id: "room-terminal",
      label: "Orkest Swarm",
    }),
  );
  const calls = [];
  const exec = (binary, args, _options, callback) => {
    calls.push([binary, ...args]);
    callback(
      null,
      JSON.stringify({ result: { pane: { pane_id: "w2:p5", terminal_id: "room-terminal" } } }),
    );
  };
  const room = {
    id: "room-a",
    title: "Refine Orkest coordinator delegation",
    conductor: {},
    agents: [],
  };
  expect(herdrSwarmPaneLabel(room)).toBe("Swarm · Refine Orkest coordinator delegation");
  expect(await syncHerdrViewLabel(room, { env, exec })).toBe(true);
  expect(calls).toEqual([
    ["herdr", "pane", "current", "--current"],
    ["herdr", "pane", "rename", "w2:p5", "Swarm · Refine Orkest coordinator delegation"],
  ]);
  expect(JSON.parse(await readFile(file, "utf8")).label).toBe(
    "Swarm · Refine Orkest coordinator delegation",
  );
  expect(await syncHerdrViewLabel(room, { env, exec })).toBe(false);
  expect(calls).toHaveLength(2);
  const changedRoom = { ...room, title: "New task" };
  const failedRename = (_binary, _args, _options, callback) => callback(new Error("pane closed"));
  expect(await syncHerdrViewLabel(changedRoom, { env, exec: failedRename })).toBe(false);
  expect(JSON.parse(await readFile(file, "utf8")).label).toBe(
    "Swarm · Refine Orkest coordinator delegation",
  );
  expect(
    herdrSwarmPaneLabel({
      id: "room-b",
      title:
        "Toggle compact usage meters (5h/weekly), add rich color differentiation to Orchestrator header",
    }),
  ).toBe("Swarm · Toggle compact usage meters (5h/weekly), add rich color differentiation");
});

it("keeps a managed view open when a separate viewer of the same room quits", async () => {
  const { env, file, closed } = await fixture();
  const record = JSON.parse(await readFile(file, "utf8"));
  await writeFile(file, JSON.stringify({ ...record, terminal_id: "room-terminal" }));
  const exec = (_binary, _args, _options, callback) =>
    callback(
      null,
      JSON.stringify({ result: { pane: { pane_id: "w2:p8", terminal_id: "other" } } }),
    );
  await markHerdrViewClosed("room-a", { ...env, HERDR_PANE_ID: "w2:p8" }, exec);
  await expect(readFile(closed, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});
