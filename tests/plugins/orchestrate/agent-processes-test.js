import { describe, expect, it } from "vitest";

import {
  ageSeconds,
  buildAgentProcesses,
  descendantsOf,
  isInternalOrHarnessProcess,
  parseProcessTable,
  redactCommand,
} from "../../../plugins/orchestrate/lib/agent-processes.mjs";

describe("agent process table", () => {
  it("parses Linux and macOS elapsed times, long arguments, blank rows, and malformed rows", () => {
    const longCommand = `node build.js ${"chunk ".repeat(500)}`;
    const table = parseProcessTable(
      [
        "",
        " 100  1 01:23 /usr/bin/node build.js",
        ` 101 100 2-03:04:05 ${longCommand}`,
        " 102 101 7:08 python -m pytest",
        "malformed process row",
        " 103 102 unknown node invalid-time",
        " -1 100 00:01 node negative-pid",
        "",
      ].join("\n"),
    );

    expect(table.size).toBe(3);
    expect(table.get(100)).toMatchObject({ pid: 100, ppid: 1, etime: "01:23" });
    expect(ageSeconds(table.get(100).etime)).toBe(83);
    expect(ageSeconds(table.get(101).etime)).toBe(183_845);
    expect(ageSeconds(table.get(102).etime)).toBe(428);
    expect(table.get(101).args.length).toBeGreaterThan(2000);
  });

  it("walks descendant trees safely when PPID rows form a cycle", () => {
    const table = parseProcessTable(
      [" 1 2 01:00 root", " 2 1 00:59 child", " 3 1 00:30 branch", " 4 3 00:10 leaf"].join("\n"),
    );

    expect(descendantsOf(table, 1)).toEqual(new Set([2, 3, 4]));
    expect(descendantsOf(table, 999)).toEqual(new Set());
  });

  it("redacts sensitive flags, environment assignments, URL credentials, and long commands", () => {
    const cases = [
      ["node app.js --token alpha-secret --password=beta-secret", "alpha-secret"],
      ["curl https://user:pa@ss-secret@example.test/a", "pa@ss-secret"],
      [
        "curl -H 'Authorization: Bearer header-secret' https://user:pass-secret@example.test/a",
        "header-secret",
      ],
      ["env API_KEY=api-secret node app.js", "api-secret"],
      ["node --auth=auth-secret https://user:pass-secret@example.test/", "pass-secret"],
    ];
    for (const [raw, secret] of cases) {
      expect(redactCommand(raw)).not.toContain(secret);
    }
    expect(redactCommand("/opt/node/bin/node app.js --token alpha-secret")).toBe(
      "node app.js --token ***",
    );
    expect(redactCommand("curl https://user:pass-secret@example.test/path")).toBe(
      "curl https://***@example.test/path",
    );
    expect(redactCommand("curl https://user:pa@ss-secret@example.test/a")).toBe(
      "curl https://***@example.test/a",
    );
    expect(redactCommand(`node ${"very-long-argument".repeat(20)}`)).toHaveLength(80);
    expect(redactCommand(`node ${"very-long-argument".repeat(20)}`).endsWith("…")).toBe(true);
    expect(redactCommand("env API_KEY=api-secret node app.js")).toContain("API_KEY=***");
  });

  it("attributes shared PID descendants by the most specific working directory without duplication", () => {
    const table = parseProcessTable(
      [
        " 100 1 10:00 /usr/bin/codex --workspace /tmp/repo",
        " 201 100 02:00 /usr/bin/python3 -m pytest tests/test_app.py --password test-secret",
        " 202 100 01:00 /usr/bin/node /tmp/repo/node_modules/.bin/vite --port 5173",
        " 203 100 03:00 /bin/sh build.sh",
        " 204 203 02:50 /usr/bin/make build",
        " 205 100 00:10 /usr/bin/ps -axo pid=,ppid=,etime=,args=",
        " 206 100 00:10 /usr/bin/lsof -a -p 201 -d cwd -Fn",
        " 207 100 01:00 /usr/bin/claude --model sonnet",
        " 208 100 01:00 /usr/bin/node unrelated.js",
        " 209 300 01:00 /usr/bin/node outside.js",
        " 300 999 10:00 /usr/bin/horde-tui",
        " 301 300 00:20 /usr/bin/node tui-child.js",
      ].join("\n"),
    );
    const members = [
      { id: "parent", pid: 100, cwd: "/tmp/repo" },
      {
        id: "worker-a",
        pid: 100,
        sharedProcess: true,
        worktree: { path: "/tmp/repo/worktree-a" },
        cwd: "/tmp/repo/worktree-a",
      },
      {
        id: "worker-b",
        pid: 100,
        sharedProcess: true,
        worktree: { path: "/tmp/repo/worktree-b" },
        cwd: "/tmp/repo/worktree-b",
      },
    ];
    const result = buildAgentProcesses({
      table,
      members,
      listeners: [{ pid: 202, port: 5173 }],
      cwdByPid: new Map([
        [201, "/tmp/repo/worktree-a"],
        [202, "/tmp/repo/worktree-a"],
        [203, "/tmp/repo"],
        [204, "/tmp/repo"],
        [208, "/tmp/repo/worktree-b"],
        [209, "/elsewhere"],
        [300, "/tmp/repo"],
        [301, "/tmp/repo"],
      ]),
      ignore: [300, 301],
    });

    expect(result.get("worker-a").processes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pid: 201,
          via: "cwd",
          command: "python3 -m pytest tests/test_app.py",
        }),
        expect.objectContaining({ pid: 202, via: "cwd", ports: [5173] }),
      ]),
    );
    expect(result.get("parent").processes.map((process) => process.pid)).toEqual([203, 204]);
    expect(result.get("worker-b").processes.map((process) => process.pid)).toEqual([208]);
    const allPids = result
      .values()
      .flatMap(({ processes }) => processes.map(({ pid }) => pid))
      .toArray();
    expect(new Set(allPids).size).toBe(allPids.length);
    expect(allPids).not.toEqual(expect.arrayContaining([205, 206, 207, 209, 300, 301]));
    expect(JSON.stringify(result.get("worker-a"))).not.toContain("test-secret");
    expect(isInternalOrHarnessProcess("claude", "claude", "claude --model sonnet")).toBe(true);
  });

  it("uses the shared internal-process filter for listener ports", () => {
    const table = parseProcessTable(
      [
        " 500 1 10:00 /usr/bin/agent root",
        " 501 500 00:10 /usr/bin/python3 worker.py",
        " 502 500 00:10 /usr/bin/node /repo/node_modules/.bin/vite --port 5173",
      ].join("\n"),
    );
    const result = buildAgentProcesses({
      table,
      members: [{ id: "worker", pid: 500 }],
      listeners: [
        { pid: 501, port: 58_406, command: "python3", comm: "python3" },
        { pid: 502, port: 5173, command: "node", comm: "node" },
      ],
    });

    expect(result.get("worker").processes.map(({ pid, ports }) => [pid, ports])).toEqual([
      [502, [5173]],
    ]);
  });

  it("caps each member at twenty processes and reports the remainder", () => {
    const rows = [" 500 1 10:00 /usr/bin/agent root"];
    for (let index = 0; index < 25; index++) {
      rows.push(` ${501 + index} 500 00:10 /usr/bin/node worker-${index}.js`);
    }
    const result = buildAgentProcesses({
      table: parseProcessTable(rows.join("\n")),
      members: [{ id: "worker", pid: 500 }],
    });

    expect(result.get("worker").processes).toHaveLength(20);
    expect(result.get("worker").more).toBe(5);
  });
});
