import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

function expandHome(value, home = homedir()) {
  return value.replace(/^~(?=\/|$)/u, () => home);
}

export function envFirst(...args) {
  let env = process.env;
  let names = args;
  if (args.length > 0 && typeof args[0] === "object" && args[0] !== null) {
    [env, ...names] = args;
  } else if (args.length > 0 && typeof args.at(-1) === "object" && args.at(-1) !== null) {
    env = args.at(-1);
    names = args.slice(0, -1);
  }
  for (const name of names) {
    const value = env?.[name];
    if (typeof value === "string" && value.length > 0) return value;
  }
}

export function cacheHome(env = process.env, { home = homedir() } = {}) {
  const explicit = envFirst("ORCHESTRATE_HOME", "AGENT_EXECUTOR_HOME", env);
  if (explicit) return expandHome(explicit, home);
  const cacheRoot = expandHome(env.XDG_CACHE_HOME || path.join(home, ".cache"), home);
  const preferred = path.join(cacheRoot, "orchestrate");
  const legacy = path.join(cacheRoot, "agent-executor");
  if (!existsSync(preferred) && existsSync(legacy)) return legacy;
  return preferred;
}

export function configPath(env = process.env, { home = homedir() } = {}) {
  const explicit = envFirst("ORCHESTRATE_CONFIG", "AGENT_EXECUTOR_CONFIG", env);
  if (explicit) return expandHome(explicit, home);
  const configRoot = expandHome(env.XDG_CONFIG_HOME || path.join(home, ".config"), home);
  const preferred = path.join(configRoot, "orchestrate", "config.json");
  const legacy = path.join(configRoot, "agent-executor", "config.json");
  if (!existsSync(preferred) && existsSync(legacy)) return legacy;
  return preferred;
}

export const env_first = envFirst;
export const cache_home = cacheHome;
export const config_path = configPath;
