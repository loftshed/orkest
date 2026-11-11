import path from "node:path";

const KNOWN_SERVICE_TOKENS = [
  "vite",
  "next",
  "astro",
  "wrangler",
  "uvicorn",
  "gunicorn",
  "flask",
  "django",
  "storybook",
  "webpack",
  "parcel",
  "remix",
  "nuxt",
  "svelte",
  "esbuild",
  "rollup",
  "http-server",
  "serve",
  "prism",
  "wiremock",
  "mock",
  "postgres",
  "redis",
  "mysqld",
  "mongod",
  "minio",
  "caddy",
  "nginx",
  "rails",
  "puma",
  "spring",
  "gradle",
  "maven",
  "cargo",
  "deno",
  "bun",
];

const INTERNAL_OR_HARNESS_TOKENS = [
  "agy",
  "antigravity",
  "language_server",
  "claude",
  "plaude",
  "codex",
  "opencode",
  "cclsp",
  "tsserver",
  "vtsls",
  "rust-analyzer",
  "pyright",
  "mailbox_daemon",
  "peer_mailbox",
  "horde-tui",
  "agent_statusline",
  "tmux",
  "herdr",
  "code helper",
  "cursor",
  "electron",
  "crashpad",
];

const SENSITIVE_NAME_RE = /token|secret|password|passwd|api[_-]?key|auth|bearer|credential/iu;
const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/u;
const MAX_PROCESSES_PER_AGENT = 20;

function matchTokenInText(text, tokens) {
  const lower = String(text || "").toLowerCase();
  for (const token of tokens) {
    const escaped = token.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
    if (new RegExp(`(?:^|[^a-z0-9_])${escaped}(?:$|[^a-z0-9_])`, "u").test(lower)) return token;
  }
  return "";
}

export function matchKnownServiceToken(command = "", comm = "", args = "") {
  return matchTokenInText(`${args} ${comm} ${command}`, KNOWN_SERVICE_TOKENS);
}

/** Shared room-service filter for framework and agent process probes. */
export function isInternalOrHarnessProcess(command = "", comm = "", args = "", port = 0) {
  const execIdentity = `${path.basename(comm || "")} ${command} ${args}`;
  if (matchTokenInText(execIdentity, INTERNAL_OR_HARNESS_TOKENS)) return true;
  if (Number.isFinite(port) && port >= 49_152) {
    const knownToken = matchKnownServiceToken(command, comm, args);
    const hasExplicitPortFlag = /(?:^|\s)(?:--port(?:\s|=)|\b-p\s+\d+)/iu.test(args);
    if (!knownToken && !hasExplicitPortFlag) return true;
  }
  return false;
}

export function inferServiceProcessName(command = "", comm = "", args = "") {
  const known = matchKnownServiceToken(command, comm, args);
  if (known) return known;
  const base = path.basename(comm || command || "process").trim();
  return base || "process";
}

function isEtime(value) {
  return /^\d+(?:-\d+)?(?::\d+){1,2}$/u.test(value);
}

/** Parse headerless Linux and macOS `ps -axo pid=,ppid=,etime=,args=` output. */
export function parseProcessTable(raw) {
  const table = new Map();
  const lines = String(raw || "").split(/\r?\n/u);
  for (const line of lines) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)(?:\s+(.*))?$/u.exec(line);
    if (!match || !isEtime(match[3])) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(ppid) || ppid < 0) {
      continue;
    }
    table.set(pid, {
      pid,
      ppid,
      etime: match[3],
      args: (match[4] || "").trimEnd(),
    });
  }
  return table;
}

/** Convert the `etime` formats used by Linux and macOS ps into elapsed seconds. */
export function ageSeconds(etime) {
  if (typeof etime !== "string") return 0;
  const parts = etime.split("-");
  const dayPart = parts.length === 2 ? parts[0] : undefined;
  const clock = parts.length === 2 ? parts[1] : parts[0];
  if (typeof clock !== "string") return 0;
  const units = clock.split(":").map(Number);
  if (units.some((unit) => !Number.isSafeInteger(unit) || unit < 0)) return 0;
  let days = 0;
  let hours;
  let minutes;
  let seconds;
  if (units.length === 3) [hours, minutes, seconds] = units;
  else if (units.length === 2) {
    hours = 0;
    [minutes, seconds] = units;
  } else return 0;
  if (dayPart !== undefined) {
    days = Number(dayPart);
    if (!Number.isSafeInteger(days) || days < 0 || units.length !== 3) return 0;
  }
  if (minutes > 59 || seconds > 59 || (dayPart !== undefined && hours > 23)) return 0;
  return days * 86_400 + hours * 3600 + minutes * 60 + seconds;
}

function processRows(table) {
  if (table instanceof Map) return table;
  return new Map(
    (Array.isArray(table) ? table : [])
      .filter((row) => row && Number.isSafeInteger(row.pid))
      .map((row) => [row.pid, row]),
  );
}

function childrenByPid(table) {
  const children = new Map();
  for (const row of processRows(table).values()) {
    if (!children.has(row.ppid)) children.set(row.ppid, []);
    children.get(row.ppid).push(row.pid);
  }
  return children;
}

/** Return descendant PIDs, excluding the supplied PID; loops in PPID data are safe. */
export function descendantsOf(table, pid) {
  const children = childrenByPid(table);
  const root = Number(pid);
  const visited = new Set([root]);
  const descendants = new Set();
  const queue = [root];
  for (let index = 0; index < queue.length; index++) {
    const childrenOfCurrent = children.get(queue[index]) || [];
    for (const childPid of childrenOfCurrent) {
      if (visited.has(childPid)) continue;
      visited.add(childPid);
      descendants.add(childPid);
      queue.push(childPid);
    }
  }
  return descendants;
}

/** Split a ps argument string without evaluating shell syntax or expanding variables. */
function commandArguments(raw) {
  const text = String(raw || "");
  const args = [];
  let current = "";
  let quote = "";
  let isEscaped = false;
  let hasStarted = false;
  for (const char of text) {
    if (isEscaped) {
      current += char;
      isEscaped = false;
      hasStarted = true;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      isEscaped = true;
      hasStarted = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = "";
      else current += char;
      hasStarted = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      hasStarted = true;
      continue;
    }
    if (/\s/u.test(char)) {
      if (hasStarted) args.push(current);
      current = "";
      hasStarted = false;
      continue;
    }
    current += char;
    hasStarted = true;
  }
  if (isEscaped) current += "\\";
  if (hasStarted) args.push(current);
  return args;
}

function redactUrlCredentials(value) {
  return value.replaceAll(/([a-z][a-z0-9+.-]*:\/\/)[^/\s]+@/giu, "$1***@");
}

function safeArgument(args, index) {
  const value = redactUrlCredentials(args[index]);
  const equalsAt = value.indexOf("=");
  const name = equalsAt === -1 ? "" : value.slice(0, equalsAt);
  if (equalsAt > 0 && (SENSITIVE_NAME_RE.test(name) || ENV_ASSIGNMENT_RE.test(value))) {
    return `${name}=***`;
  }
  if (SENSITIVE_NAME_RE.test(value)) return "***";
  return value;
}

/** Show a basename and at most three safe argv values, capped at 80 characters. */
export function redactCommand(raw) {
  const args = commandArguments(raw);
  if (args.length === 0) return "";
  const safeExecutable = safeArgument(args, 0);
  const executable = path.basename(safeExecutable.replaceAll("\\", "/")) || "***";
  const shown = [redactUrlCredentials(executable)];
  let shouldMaskNext = false;
  let shownArguments = 0;
  for (let index = 1; index < args.length && shownArguments < 3; index++) {
    if (shouldMaskNext) {
      shown.push("***");
      shouldMaskNext = false;
      shownArguments++;
      continue;
    }
    const arg = redactUrlCredentials(args[index]);
    const equalsAt = arg.indexOf("=");
    const name = equalsAt === -1 ? "" : arg.slice(0, equalsAt);
    if (SENSITIVE_NAME_RE.test(name)) {
      shown.push(`${name}=***`);
    } else if (SENSITIVE_NAME_RE.test(arg)) {
      const isFlag = /^--?[A-Za-z0-9_-]+$/u.test(arg);
      shown.push(isFlag ? arg : "***");
      shouldMaskNext = equalsAt === -1;
    } else {
      shown.push(safeArgument(args, index));
    }
    shownArguments++;
  }
  const command = shown.join(" ");
  return [...command].length <= 80 ? command : `${[...command].slice(0, 79).join("")}…`;
}

function commandName(args) {
  const executable = commandArguments(args)[0] || "";
  return path.basename(executable.replaceAll("\\", "/"));
}

function isProbeProcess(args) {
  const tokens = commandArguments(args);
  const executable = path.basename((tokens[0] || "").replaceAll("\\", "/")).toLowerCase();
  return (
    executable === "ps" || executable === "lsof" || (executable === "docker" && tokens[1] === "ps")
  );
}

function validPid(member) {
  const value = member?.pid ?? member?.progress?.pid;
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function within(candidate, root) {
  if (!candidate || !root) return false;
  const resolvedCandidate = path.resolve(candidate);
  const resolvedRoot = path.resolve(root);
  return (
    resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)
  );
}

function memberDirectories(member) {
  return [
    ...new Set(
      [member?.worktree?.path, member?.progress?.cwd, member?.cwd, member?.session?.cwd]
        .filter((value) => typeof value === "string" && path.isAbsolute(value))
        .map((value) => path.resolve(value)),
    ),
  ];
}

function ignoreSet(ignore) {
  if (ignore instanceof Set || Array.isArray(ignore)) return new Set(ignore);
  return Number.isSafeInteger(ignore) && ignore > 0 ? new Set([ignore]) : new Set();
}

function processIsExcluded(row, ignored, internalListenersByPid) {
  if (!row || ignored.has(row.pid) || isProbeProcess(row.args)) return true;
  const listenerFlags = internalListenersByPid.get(row.pid) || [];
  if (listenerFlags.length > 0 && listenerFlags.every(Boolean)) return true;
  const command = commandName(row.args);
  return isInternalOrHarnessProcess(command, command, row.args, 0);
}

function treeAttribution(
  table,
  children,
  members,
  memberCounts,
  memberPidSet,
  ignored,
  internalListenersByPid,
) {
  const best = new Map();
  for (const member of members) {
    const rootPid = validPid(member);
    if (!rootPid || memberCounts.get(rootPid) !== 1 || member.sharedProcess === true) continue;
    const visited = new Set([rootPid]);
    const queue = [{ pid: rootPid, distance: 0 }];
    for (let index = 0; index < queue.length; index++) {
      const current = queue[index];
      const childrenOfCurrent = children.get(current.pid) || [];
      for (const childPid of childrenOfCurrent) {
        if (visited.has(childPid)) continue;
        visited.add(childPid);
        const row = table.get(childPid);
        const distance = current.distance + 1;
        if (
          !memberPidSet.has(childPid) &&
          !processIsExcluded(row, ignored, internalListenersByPid)
        ) {
          const existing = best.get(childPid);
          if (!existing || distance < existing.distance) {
            best.set(childPid, { memberId: member.id, distance, tied: false });
          } else if (distance === existing.distance && existing.memberId !== member.id) {
            existing.tied = true;
          }
        }
        queue.push({ pid: childPid, distance });
      }
    }
  }
  return new Map([...best].filter(([, assignment]) => !assignment.tied));
}

function sharedPidAttribution(
  table,
  children,
  members,
  memberCounts,
  memberPidSet,
  ignored,
  internalListenersByPid,
  cwdByPid,
  assigned,
) {
  const sharedRoots = new Set();
  for (const member of members) {
    const pid = validPid(member);
    if (pid && (memberCounts.get(pid) > 1 || member.sharedProcess === true)) sharedRoots.add(pid);
  }
  const candidates = new Set();
  for (const rootPid of sharedRoots) {
    for (const childPid of descendantsOfFromChildren(children, rootPid)) {
      const row = table.get(childPid);
      if (
        !memberPidSet.has(childPid) &&
        !assigned.has(childPid) &&
        !processIsExcluded(row, ignored, internalListenersByPid)
      ) {
        candidates.add(childPid);
      }
    }
  }

  const sharedMembers = members.filter((member) => {
    const pid = validPid(member);
    return pid && (memberCounts.get(pid) > 1 || member.sharedProcess === true);
  });
  const attribution = new Map();
  for (const pid of candidates) {
    const cwd = cwdByPid.get(pid);
    if (typeof cwd !== "string" || !path.isAbsolute(cwd)) continue;
    const matching = [];
    for (const member of members) {
      for (const root of memberDirectories(member)) {
        if (within(cwd, root)) matching.push({ member, root });
      }
    }
    if (matching.length === 0) continue;
    const deepest = Math.max(...matching.map(({ root }) => root.length));
    const owners = new Map();
    for (const { member, root } of matching) {
      if (root.length === deepest) owners.set(member.id, member);
    }
    if (owners.size !== 1) continue;
    const memberId = owners.keys().next().value;
    if (sharedMembers.every((member) => member.id !== memberId)) continue;
    attribution.set(pid, { memberId, via: "cwd", row: table.get(pid) });
  }
  return attribution;
}

function descendantsOfFromChildren(children, root) {
  const visited = new Set([root]);
  const descendants = new Set();
  const queue = [root];
  for (let index = 0; index < queue.length; index++) {
    const childrenOfCurrent = children.get(queue[index]) || [];
    for (const child of childrenOfCurrent) {
      if (visited.has(child)) continue;
      visited.add(child);
      descendants.add(child);
      queue.push(child);
    }
  }
  return descendants;
}

function listenerInfo(table, listeners) {
  const portsByPid = new Map();
  const internalByPid = new Map();
  const listenerRows = Array.isArray(listeners) ? listeners : [];
  for (const listener of listenerRows) {
    const pid = Number(listener?.pid);
    const port = Number(listener?.port);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(port) || port <= 0)
      continue;
    const row = table.get(pid);
    const command = String(listener?.command || "");
    const comm = String(listener?.comm || commandName(row?.args || ""));
    const args = String(listener?.args || row?.args || "");
    const isInternal = isInternalOrHarnessProcess(command, comm, args, port);
    if (!internalByPid.has(pid)) internalByPid.set(pid, []);
    internalByPid.get(pid).push(isInternal);
    if (isInternal) continue;
    if (!portsByPid.has(pid)) portsByPid.set(pid, new Set());
    portsByPid.get(pid).add(port);
  }
  return { portsByPid, internalByPid };
}

/** Attribute observed descendants to unique PID trees or shared-session working directories. */
export function buildAgentProcesses({
  table: inputTable,
  members = [],
  listeners = [],
  cwdByPid = new Map(),
  ignore,
} = {}) {
  const table = processRows(inputTable);
  const validMembers = members.filter((member) => typeof member?.id === "string" && member.id);
  const results = new Map(validMembers.map((member) => [member.id, { processes: [], more: 0 }]));
  const memberCounts = new Map();
  const memberPidSet = new Set();
  for (const member of validMembers) {
    const pid = validPid(member);
    if (!pid) continue;
    memberPidSet.add(pid);
    memberCounts.set(pid, (memberCounts.get(pid) || 0) + 1);
  }
  const ignored = ignoreSet(ignore);
  const children = childrenByPid(table);
  const { portsByPid, internalByPid } = listenerInfo(table, listeners);
  const tree = treeAttribution(
    table,
    children,
    validMembers,
    memberCounts,
    memberPidSet,
    ignored,
    internalByPid,
  );
  const cwdMap =
    cwdByPid instanceof Map
      ? cwdByPid
      : new Map(Object.entries(cwdByPid || {}).map(([pid, cwd]) => [Number(pid), cwd]));
  const cwd = sharedPidAttribution(
    table,
    children,
    validMembers,
    memberCounts,
    memberPidSet,
    ignored,
    internalByPid,
    cwdMap,
    new Set(tree.keys()),
  );
  const assignments = new Map();
  for (const [pid, assignment] of tree) {
    assignments.set(pid, { ...assignment, via: "tree", row: table.get(pid) });
  }
  for (const [pid, assignment] of cwd) {
    if (!assignments.has(pid)) assignments.set(pid, assignment);
  }
  const byMember = new Map(validMembers.map((member) => [member.id, []]));
  for (const [, assignment] of assignments) {
    const row = assignment.row;
    if (!row || processIsExcluded(row, ignored, internalByPid)) continue;
    const memberProcesses = byMember.get(assignment.memberId);
    if (!memberProcesses) continue;
    memberProcesses.push({
      pid: row.pid,
      ppid: row.ppid,
      ageSeconds: ageSeconds(row.etime),
      command: redactCommand(row.args) || "(no command line)",
      via: assignment.via,
      ports: [...(portsByPid.get(row.pid) || [])].toSorted((left, right) => left - right),
    });
  }
  for (const [memberId, processes] of byMember) {
    processes.sort(
      (left, right) =>
        Number(right.ports.length > 0) - Number(left.ports.length > 0) || left.pid - right.pid,
    );
    const more = Math.max(0, processes.length - MAX_PROCESSES_PER_AGENT);
    results.set(memberId, {
      processes: processes.slice(0, MAX_PROCESSES_PER_AGENT),
      more,
    });
  }
  return results;
}
