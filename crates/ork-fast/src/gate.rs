//! Admission gate hook implementation for PreToolUse.
//! Matches gate.py's command unwrapping, classification, flock inspection, and refusal formatting.

use std::collections::HashSet;
use std::env;
use std::ffi::CString;
use std::fs;
use std::io::{self, Read};
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::process::Command;

const MANY_FILES: usize = 10;

/// Return whether `cmd` is available on the PATH.
fn which(cmd: &str) -> bool {
    if let Ok(path_var) = env::var("PATH") {
        for dir in env::split_paths(&path_var) {
            let candidate = dir.join(cmd);
            if candidate.is_file() {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    if let Ok(meta) = candidate.metadata()
                        && (meta.permissions().mode() & 0o111) != 0
                    {
                        return true;
                    }
                }
            }
        }
    }
    false
}

fn gate_dir() -> PathBuf {
    if let Ok(val) = env::var("AGENT_GATE_DIR")
        && !val.is_empty()
    {
        return PathBuf::from(val);
    }
    let uid = unsafe { libc::getuid() };
    PathBuf::from(format!("/tmp/agent-gate-{uid}"))
}

fn gate_command(fallback_script: Option<&Path>) -> String {
    if which("ork") {
        "ork gate".to_string()
    } else if let Some(fb) = fallback_script {
        format!("python3 {}", fb.display())
    } else {
        let default_gate =
            crate::paths::expand_home("~/.agents/skills/orchestrate/scripts/gate.py", None);
        format!("python3 {}", default_gate.display())
    }
}

/// Positional target extraction matching gate.py::targets.
fn targets(args: &[String], values: &HashSet<&str>) -> Vec<String> {
    let mut found = Vec::new();
    let mut skip = false;
    let mut literal = false;
    for arg in args {
        if skip {
            skip = false;
        } else if literal || !arg.starts_with('-') {
            found.push(arg.clone());
        } else if arg == "--" {
            literal = true;
        } else if !arg.contains('=') && values.contains(arg.as_str()) {
            skip = true;
        }
    }
    found
}

fn is_source_file(path: &str) -> bool {
    path.ends_with(".js")
        || path.ends_with(".jsx")
        || path.ends_with(".ts")
        || path.ends_with(".tsx")
        || path.ends_with(".cjs")
        || path.ends_with(".mjs")
        || path.ends_with(".py")
        || path.ends_with(".vue")
        || path.ends_with(".svelte")
}

fn strip_package_options(mut args: &[String]) -> &[String] {
    const PACKAGE_VALUES: &[&str] = &[
        "--cwd",
        "-C",
        "--prefix",
        "--filter",
        "-F",
        "--workspace",
        "-w",
        "--dir",
    ];
    while !args.is_empty() {
        let arg = &args[0];
        if (arg == "workspace" || PACKAGE_VALUES.contains(&arg.as_str())) && args.len() > 1 {
            args = &args[2..];
        } else if arg.starts_with('-') && arg != "--" {
            args = &args[1..];
        } else {
            break;
        }
    }
    args
}

fn is_env_assignment(word: &str) -> bool {
    let mut parts = word.splitn(2, '=');
    let key = parts.next().unwrap_or("");
    if parts.next().is_none() || key.is_empty() {
        return false;
    }
    let mut chars = key.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn strip_prefixes(mut words: &[String]) -> (Vec<String>, bool) {
    let mut saw_gate_held = false;
    while !words.is_empty() {
        let first = &words[0];
        if first == "ORK_GATE_HELD=1" {
            saw_gate_held = true;
        }
        let name = Path::new(first)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("");
        if name == "command" && words.get(1).is_some_and(|w| w == "-v" || w == "-V") {
            return (Vec::new(), saw_gate_held);
        }
        if is_env_assignment(first) {
            words = &words[1..];
        } else if name == "corepack" {
            words = &words[1..];
            while !words.is_empty() && words[0].starts_with('-') {
                if words[0] == "--" {
                    words = &words[1..];
                    break;
                }
                words = &words[1..];
            }
        } else if name == "direnv" && words.get(1).is_some_and(|w| w == "exec") {
            words = &words[2..];
            while !words.is_empty() && words[0].starts_with('-') {
                if words[0] == "--" {
                    words = &words[1..];
                    break;
                }
                words = &words[1..];
            }
            if !words.is_empty() {
                words = &words[1..]; // the directory
            }
        } else if matches!(
            name,
            "time"
                | "nohup"
                | "caffeinate"
                | "command"
                | "exec"
                | "env"
                | "nice"
                | "timeout"
                | "gtimeout"
        ) {
            words = &words[1..];
            while !words.is_empty()
                && (words[0].starts_with('-') || (name == "env" && words[0].contains('=')))
            {
                if matches!(words[0].as_str(), "-n" | "-k" | "-s" | "-u") {
                    words = if words.len() > 1 { &words[2..] } else { &[] };
                } else {
                    words = &words[1..];
                }
            }
            if (name == "timeout" || name == "gtimeout") && !words.is_empty() {
                words = &words[1..]; // duration
            }
        } else {
            return (words.to_vec(), saw_gate_held);
        }
    }
    (words.to_vec(), saw_gate_held)
}

fn is_script_name(script: &str) -> bool {
    const PREFIXES: &[&str] = &[
        "test",
        "tests",
        "e2e",
        "lint",
        "eslint",
        "typecheck",
        "type-check",
        "types",
        "tsc",
        "build",
        "check",
    ];
    for &prefix in PREFIXES {
        if script == prefix {
            return true;
        }
        if let Some(rest) = script.strip_prefix(prefix)
            && (rest.starts_with(':') || rest.starts_with('_') || rest.starts_with('-'))
        {
            return true;
        }
    }
    false
}

fn is_narrow_script(script: &str) -> bool {
    script.contains("changed")
        || script.contains("related")
        || script.contains("staged")
        || script.contains("affected")
        || script.contains("watch")
}

fn is_gated(words: &[String], saw_gate_held_prefix: bool) -> bool {
    if saw_gate_held_prefix || env::var("ORK_GATE_HELD").as_deref() == Ok("1") {
        return true;
    }
    if words.is_empty() {
        return false;
    }
    let head = Path::new(&words[0])
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("");
    if head == "ork" && words.get(1).is_some_and(|w| w == "gate") {
        return true;
    }
    if head == "gate.py" {
        return true;
    }
    if head.starts_with("python") && words.len() > 1 {
        let second = Path::new(&words[1])
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("");
        if second == "gate.py" {
            return true;
        }
    }
    false
}

fn runner(head: &str, rest: &[String]) -> Option<(String, bool)> {
    let test_values: HashSet<&str> = [
        "-t",
        "--testNamePattern",
        "--project",
        "-c",
        "--config",
        "--reporter",
        "--outputFile",
        "--maxWorkers",
        "-w",
        "--root",
        "-r",
        "--dir",
        "--shard",
        "--environment",
        "--pool",
        "--exclude",
        "--selectProjects",
        "--testPathIgnorePatterns",
        "--coverageDirectory",
        "--testTimeout",
        "--seed",
        "--mode",
    ]
    .into_iter()
    .collect();

    let eslint_values: HashSet<&str> = [
        "-c",
        "--config",
        "--ext",
        "--rule",
        "-f",
        "--format",
        "-o",
        "--output-file",
        "--cache-location",
        "--parser",
        "--parser-options",
        "--plugin",
        "--rulesdir",
        "--max-warnings",
        "--ignore-pattern",
        "--env",
        "--global",
        "--resolve-plugins-relative-to",
        "--flag",
    ]
    .into_iter()
    .collect();

    let pytest_values: HashSet<&str> = [
        "-k",
        "-m",
        "-p",
        "-c",
        "--rootdir",
        "-n",
        "--maxfail",
        "--junitxml",
        "-o",
        "--durations",
        "--tb",
    ]
    .into_iter()
    .collect();

    let playwright_values: HashSet<&str> = [
        "-c",
        "--config",
        "--project",
        "-g",
        "--grep",
        "-j",
        "--workers",
        "--reporter",
        "--shard",
    ]
    .into_iter()
    .collect();

    let tsc_values: HashSet<&str> = [
        "-p",
        "--project",
        "--outDir",
        "--target",
        "--module",
        "--lib",
        "--jsx",
    ]
    .into_iter()
    .collect();

    if head == "vitest" {
        if rest.first().is_some_and(|w| w == "list" || w == "init") {
            return None;
        }
        let args = if rest
            .first()
            .is_some_and(|w| matches!(w.as_str(), "run" | "related" | "watch" | "dev" | "bench"))
        {
            &rest[1..]
        } else {
            rest
        };
        let found = targets(args, &test_values);
        let changed = args
            .iter()
            .any(|a| a == "--changed" || a.starts_with("--changed="));
        let heavy = (!changed && found.is_empty()) || found.len() > MANY_FILES;
        return Some(("vitest".to_string(), heavy));
    }

    if head == "jest" {
        let found = targets(rest, &test_values);
        let changed = rest.iter().any(|a| {
            matches!(
                a.as_str(),
                "-o" | "--onlyChanged" | "--lastCommit" | "--findRelatedTests"
            ) || a.starts_with("--changedSince")
        });
        let heavy = (!changed && found.is_empty()) || found.len() > MANY_FILES;
        return Some(("jest".to_string(), heavy));
    }

    if head == "tsc" {
        let found = targets(rest, &tsc_values);
        let heavy = !found.iter().any(|t| is_source_file(t));
        return Some(("tsc".to_string(), heavy));
    }

    if head == "eslint" {
        let found = targets(rest, &eslint_values);
        let broad = found.is_empty()
            || found.iter().any(|t| {
                !is_source_file(t) || t.contains('*') || t.contains('?') || t.contains('{')
            });
        let heavy = broad || found.len() > MANY_FILES;
        return Some(("eslint".to_string(), heavy));
    }

    if head == "pytest" {
        let found = targets(rest, &pytest_values);
        return Some(("pytest".to_string(), found.is_empty()));
    }

    if head == "playwright" {
        if rest.first().is_some_and(|w| w == "test") {
            let found = targets(&rest[1..], &playwright_values);
            return Some(("playwright test".to_string(), found.is_empty()));
        }
        return None;
    }

    if head == "mocha" {
        let found = targets(rest, &HashSet::new());
        return Some(("mocha".to_string(), found.is_empty()));
    }

    if head == "vite" || head == "next" {
        if rest.first().is_some_and(|w| w == "build") {
            return Some((format!("{head} build"), true));
        }
        return None;
    }

    if matches!(head, "webpack" | "rollup" | "tsup") {
        if rest
            .iter()
            .any(|w| w == "serve" || w == "--watch" || w == "-w")
        {
            return None;
        }
        return Some((head.to_string(), true));
    }

    None
}

fn classify(words: &[String]) -> Option<(String, bool)> {
    let (stripped, _) = strip_prefixes(words);
    if stripped.is_empty() {
        return None;
    }

    let head = Path::new(&stripped[0])
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();
    let rest = stripped[1..].to_vec();

    const INFO_FLAGS: &[&str] = &[
        "-h",
        "--help",
        "-v",
        "--version",
        "--listTests",
        "--showConfig",
        "--print-config",
        "--init",
    ];
    if rest.iter().any(|arg| INFO_FLAGS.contains(&arg.as_str())) {
        return None;
    }

    const RUNNERS: &[&str] = &[
        "vitest",
        "jest",
        "tsc",
        "eslint",
        "pytest",
        "playwright",
        "vite",
        "next",
        "webpack",
        "rollup",
        "tsup",
        "mocha",
    ];

    if matches!(head.as_str(), "node" | "bun" | "deno") && !rest.is_empty() {
        let stem = Path::new(&rest[0])
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .trim_end_matches(".js")
            .trim_end_matches(".cjs")
            .trim_end_matches(".mjs");
        if RUNNERS.contains(&stem) {
            return runner(stem, &rest[1..]);
        }
        return None;
    }

    if (head == "python"
        || head == "python3"
        || (head.starts_with("python3.") && head[8..].chars().all(|c| c.is_ascii_digit())))
        && rest.first().is_some_and(|w| w == "-m")
        && rest.len() > 1
    {
        if rest[1] == "unittest" {
            let args = &rest[2..];
            let narrow = args.iter().any(|a| a == "-p" || a == "--pattern")
                && !args.iter().any(|a| a.contains('*'));
            let heavy = (args.is_empty() || args.iter().any(|a| a == "discover")) && !narrow;
            return Some(("unittest".to_string(), heavy));
        }
        if rest[1] == "pytest" {
            return runner("pytest", &rest[2..]);
        }
        return None;
    }

    const EXECUTORS: &[&str] = &["npx", "bunx", "pnpx"];
    const PACKAGE_MANAGERS: &[&str] = &["yarn", "npm", "pnpm", "bun"];

    if EXECUTORS.contains(&head.as_str()) && !rest.is_empty() {
        let stripped_rest = strip_package_options(&rest);
        if stripped_rest.is_empty() {
            return None;
        }
        let exec_head = Path::new(&stripped_rest[0])
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("");
        return runner(exec_head, &stripped_rest[1..]);
    }

    if PACKAGE_MANAGERS.contains(&head.as_str()) && !rest.is_empty() {
        let stripped_rest = strip_package_options(&rest);
        if stripped_rest.is_empty() {
            return None;
        }
        let sub = &stripped_rest[0];
        let sub_args = &stripped_rest[1..];
        if matches!(sub.as_str(), "exec" | "dlx" | "x") {
            let inner_rest = strip_package_options(sub_args);
            if inner_rest.is_empty() {
                return None;
            }
            let inner_head = Path::new(&inner_rest[0])
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("");
            return runner(inner_head, &inner_rest[1..]);
        }
        if RUNNERS.contains(&sub.as_str()) {
            return runner(sub, sub_args);
        }
        let (script, remaining_args) = if matches!(sub.as_str(), "run" | "run-script") {
            let s_args = strip_package_options(sub_args);
            if s_args.is_empty() {
                return None;
            }
            (&s_args[0], &s_args[1..])
        } else {
            (sub, sub_args)
        };

        if !is_script_name(script) {
            return None;
        }
        let found = targets(remaining_args, &HashSet::new());
        let narrow = is_narrow_script(script);
        let heavy = (!narrow && found.is_empty()) || found.len() > MANY_FILES;
        return Some((format!("{head} {script}"), heavy));
    }

    runner(&head, &rest)
}

fn drop_heredocs(line: &str) -> String {
    let mut kept = Vec::new();
    let mut delimiter: Option<String> = None;

    for text in line.lines() {
        if let Some(ref delim) = delimiter {
            if text.trim() == delim {
                delimiter = None;
            }
            continue;
        }
        kept.push(text);
        if let Some(idx) = text.find("<<") {
            let after = &text[idx + 2..];
            let after = after.strip_prefix('-').unwrap_or(after).trim_start();
            let mut delim_chars = String::new();
            let mut quote = None;
            for c in after.chars() {
                if quote.is_none() && (c == '\'' || c == '"') {
                    quote = Some(c);
                } else if Some(c) == quote
                    || (quote.is_none() && (c.is_whitespace() || c == ';' || c == '&' || c == '|'))
                {
                    break;
                } else {
                    delim_chars.push(c);
                }
            }
            if !delim_chars.is_empty() {
                delimiter = Some(delim_chars);
            }
        }
    }
    kept.join("\n")
}

fn parse_tokens(line: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut cur = String::new();
    let mut in_single = false;
    let mut in_double = false;
    let mut escaped = false;

    for c in line.chars() {
        if escaped {
            cur.push(c);
            escaped = false;
            continue;
        }
        if c == '\\' && !in_single {
            escaped = true;
            continue;
        }
        if c == '\'' && !in_double {
            in_single = !in_single;
            continue;
        }
        if c == '"' && !in_single {
            in_double = !in_double;
            continue;
        }
        if in_single || in_double {
            cur.push(c);
            continue;
        }
        if c.is_whitespace() {
            if !cur.is_empty() {
                tokens.push(cur.clone());
                cur.clear();
            }
            continue;
        }
        if matches!(c, ';' | '&' | '|' | '(' | ')' | '<' | '>') {
            if !cur.is_empty() {
                tokens.push(cur.clone());
                cur.clear();
            }
            tokens.push(c.to_string());
            continue;
        }
        cur.push(c);
    }
    if !cur.is_empty() {
        tokens.push(cur);
    }
    tokens
}

fn simple_commands(line: &str, depth: usize) -> Vec<Vec<String>> {
    let cleaned = drop_heredocs(line);
    let tokens = parse_tokens(&cleaned);

    let mut found: Vec<Vec<String>> = Vec::new();
    let mut words: Vec<String> = Vec::new();
    let mut redirect = false;

    let mut all_tokens = tokens;
    all_tokens.push(";".to_string());

    for token in all_tokens {
        if redirect {
            redirect = false;
        } else if (token.contains('<') || token.contains('>'))
            && token.chars().all(|c| matches!(c, '<' | '>' | '&'))
        {
            if let Some(last) = words.last()
                && last.chars().all(|c| c.is_ascii_digit())
            {
                words.pop();
            }
            redirect = true;
        } else if matches!(
            token.as_str(),
            ";" | "&" | "&&" | "|" | "||" | "(" | ")" | "\n"
        ) {
            if !words.is_empty() {
                found.push(words.clone());
            }
            words.clear();
        } else {
            words.push(token);
        }
    }

    let mut expanded: Vec<Vec<String>> = Vec::new();
    const SHELLS: &[&str] = &["sh", "bash", "zsh", "dash"];
    for words in found {
        let (bare, _) = strip_prefixes(&words);
        let mut script: Option<String> = None;
        if depth < 3 && !bare.is_empty() {
            let head = Path::new(&bare[0])
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("");
            if SHELLS.contains(&head) && bare.len() > 2 {
                for (idx, arg) in bare[1..bare.len() - 1].iter().enumerate() {
                    if arg.starts_with('-') && arg.contains('c') {
                        script = Some(bare[idx + 2].clone());
                        break;
                    }
                }
            }
        }
        if let Some(s) = script {
            expanded.extend(simple_commands(&s, depth + 1));
        } else {
            expanded.push(words);
        }
    }
    expanded
}

fn heavy_runs(line: &str) -> Vec<(String, String, Vec<String>)> {
    let mut found = Vec::new();
    for words in simple_commands(line, 0) {
        let (bare, saw_gate_held) = strip_prefixes(&words);
        if is_gated(&bare, saw_gate_held) {
            continue;
        }
        if let Some((kind, is_heavy)) = classify(&words)
            && is_heavy
        {
            let text = bare.join(" ");
            found.push((kind, text, words));
        }
    }
    found
}

fn inspect_checkout(raw_cwd: Option<&str>) -> (Option<String>, Option<String>) {
    let cwd = match raw_cwd {
        Some(c) if !c.trim().is_empty() => PathBuf::from(c),
        _ => match env::current_dir() {
            Ok(d) => d,
            Err(_) => return (None, None),
        },
    };
    let resolved = match fs::canonicalize(&cwd) {
        Ok(r) if r.is_dir() => r,
        _ => return (None, None),
    };

    let output = Command::new("git")
        .args([
            "-C",
            resolved.to_str().unwrap_or(""),
            "rev-parse",
            "--show-toplevel",
        ])
        .output();
    let top_str = match output {
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout).trim().to_string(),
        _ => return (None, None),
    };
    if top_str.is_empty() {
        return (None, None);
    }
    let top = match fs::canonicalize(&top_str) {
        Ok(t) => t,
        Err(_) => return (None, None),
    };
    let rel = match resolved.strip_prefix(&top) {
        Ok(r) => r.to_string_lossy().to_string(),
        Err(_) => String::new(),
    };
    (Some(top.to_string_lossy().to_string()), Some(rel))
}

fn get_active_holders(dir: &Path) -> Vec<serde_json::Value> {
    let mut result = Vec::new();
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return result,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let fname = path.file_name().and_then(|f| f.to_str()).unwrap_or("");
        if (fname.starts_with("slot-") || fname == "queue.lock") && fname.ends_with(".lock") {
            let c_path = match CString::new(path.as_os_str().as_bytes()) {
                Ok(c) => c,
                Err(_) => continue,
            };
            let fd = unsafe { libc::open(c_path.as_ptr(), libc::O_RDWR) };
            if fd >= 0 {
                let res = unsafe { libc::flock(fd, libc::LOCK_EX | libc::LOCK_NB) };
                if res == 0 {
                    // Lock succeeded => file is free!
                    unsafe {
                        libc::flock(fd, libc::LOCK_UN);
                        libc::close(fd);
                    }
                } else {
                    // Lock failed => held! Read holder json
                    unsafe { libc::close(fd) };
                    if let Ok(content) = fs::read_to_string(&path)
                        && let Ok(val) = serde_json::from_str::<serde_json::Value>(&content)
                    {
                        result.push(val);
                    }
                }
            }
        }
    }
    result
}

fn format_refusal(
    runs: &[(String, String, Vec<String>)],
    fallback_script: Option<&Path>,
    checkout: Option<&str>,
) -> String {
    let (kind, text, _) = &runs[0];
    let gate_cmd = gate_command(fallback_script);
    let base = format!(
        "`{text}` runs a whole {kind} pass, and several agents share this machine. To check whether your \
change broke something, run the tests that exercise it instead: the test file beside the code you \
changed, or `vitest related` / `jest --findRelatedTests` with the source files you changed. If you \
really need the full run, as the final check, wrap it so it waits for other heavy runs: \
`{gate_cmd} --heavy -- {text}`."
    );

    let g_dir = gate_dir();
    let mut notes = Vec::new();

    if let Some(co) = checkout {
        let holders = get_active_holders(&g_dir);
        let my_pid = std::process::id();
        for h in holders {
            if h.get("checkout").and_then(|v| v.as_str()) == Some(co)
                && h.get("pid").and_then(|v| v.as_u64()) != Some(my_pid as u64)
            {
                let agent = h.get("agent").and_then(|v| v.as_str()).unwrap_or("?");
                let label = h.get("label").and_then(|v| v.as_str()).unwrap_or("?");
                let pid = h.get("pid").and_then(|v| v.as_u64()).unwrap_or(0);
                notes.push(format!(
                    "Active in this checkout: {agent}'s run `{label}` (pid {pid})."
                ));
                break;
            }
        }
    }

    if notes.len() < 2 {
        notes.push(format!(
            "Run `{gate_cmd} status` to see active and recent runs."
        ));
    }

    if notes.is_empty() {
        base
    } else {
        format!("{base}\n{}", notes[..notes.len().min(2)].join("\n"))
    }
}

pub fn run(harness: &str, fallback_script: Option<&Path>) -> io::Result<()> {
    let mut raw_stdin = Vec::new();
    io::stdin().read_to_end(&mut raw_stdin)?;

    if raw_stdin.is_empty() {
        return Ok(());
    }

    let payload: serde_json::Value = match serde_json::from_slice(&raw_stdin) {
        Ok(v) => v,
        Err(_) => return Ok(()),
    };

    let command_line = if let Some(input) = payload.get("tool_input") {
        if let Some(cmd) = input.get("command") {
            if let Some(s) = cmd.as_str() {
                Some(s.to_string())
            } else if let Some(arr) = cmd.as_array() {
                let parts: Vec<String> = arr
                    .iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect();
                Some(parts.join(" "))
            } else {
                None
            }
        } else {
            None
        }
    } else if let Some(call) = payload.get("toolCall") {
        call.get("args")
            .and_then(|a| a.get("CommandLine"))
            .and_then(|c| c.as_str())
            .map(String::from)
    } else {
        None
    };

    let line = match command_line {
        Some(ref l) if !l.trim().is_empty() => l,
        _ => return Ok(()),
    };

    let detailed = heavy_runs(line);
    if detailed.is_empty() {
        return Ok(());
    }

    let raw_cwd = payload
        .get("tool_input")
        .and_then(|i| i.get("workdir").or_else(|| i.get("cwd")))
        .and_then(|v| v.as_str())
        .or_else(|| payload.get("cwd").and_then(|v| v.as_str()));

    let (checkout, _) = inspect_checkout(raw_cwd);
    let reason = format_refusal(&detailed, fallback_script, checkout.as_deref());

    if harness == "gemini" {
        let resp = serde_json::json!({
            "decision": "deny",
            "reason": reason
        });
        println!("{resp}");
    } else {
        let resp = serde_json::json!({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": reason
            }
        });
        println!("{resp}");
    }

    Ok(())
}
