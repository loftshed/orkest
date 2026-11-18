//! Admission gate hook implementation for PreToolUse.
//! Matches gate.py's command unwrapping, classification, flock inspection, and refusal formatting.

use std::collections::HashSet;
use std::env;
use std::ffi::CString;
use std::fs;
use std::io::{self, Read};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use serde_json::Value;

use crate::paths;
use crate::sha256;

const MANY_FILES: usize = 10;
const WORKERS: i64 = 2;
const RUNS_KEPT: usize = 200;
const MAX_STATUS_ENTRIES: usize = 5000;
const INSTALL_STATES: &[&str] = &[
    "node_modules/.yarn-state.yml",
    "node_modules/.package-lock.json",
    "node_modules/.modules.yaml",
];
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

fn gate_dir() -> PathBuf {
    if let Ok(val) = env::var("AGENT_GATE_DIR")
        && !val.is_empty()
    {
        return PathBuf::from(val);
    }
    let uid = unsafe { libc::getuid() };
    PathBuf::from(format!("/tmp/agent-gate-{uid}"))
}

fn gate_command() -> String {
    if paths::find_in_path("ork").is_some() {
        "ork gate".to_string()
    } else {
        let gate_script = paths::scripts_root()
            .map(|s| s.join("gate.py"))
            .filter(|p| p.is_file())
            .unwrap_or_else(|| {
                paths::expand_home("~/.agents/skills/orchestrate/scripts/gate.py", None)
            });
        let resolved = fs::canonicalize(&gate_script).unwrap_or(gate_script);
        paths::shlex_join(["python3", resolved.to_string_lossy().as_ref()])
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
    let mut delimiters: Vec<String> = Vec::new();

    for text in line.lines() {
        if !delimiters.is_empty() {
            if text.trim() == delimiters[0] {
                delimiters.remove(0);
            }
            continue;
        }
        kept.push(text);
        let bytes = text.as_bytes();
        let mut i = 0;
        while i + 1 < bytes.len() {
            if bytes[i] == b'<' && bytes[i + 1] == b'<' && (i == 0 || bytes[i - 1] != b'<') {
                let mut j = i + 2;
                if j < bytes.len() && bytes[j] == b'-' {
                    j += 1;
                }
                // `<<<` is a bash here-string, never a multiline heredoc.
                if j < bytes.len() && bytes[j] == b'<' {
                    i = j + 1;
                    continue;
                }
                while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                    j += 1;
                }
                let quote = if j < bytes.len() && (bytes[j] == b'\'' || bytes[j] == b'"') {
                    let q = bytes[j];
                    j += 1;
                    Some(q)
                } else {
                    None
                };
                if j < bytes.len() && (bytes[j].is_ascii_alphabetic() || bytes[j] == b'_') {
                    let start = j;
                    while j < bytes.len() && (bytes[j].is_ascii_alphanumeric() || bytes[j] == b'_')
                    {
                        j += 1;
                    }
                    let closed = quote.is_none_or(|q| j < bytes.len() && bytes[j] == q);
                    if closed {
                        if let Ok(delim) = std::str::from_utf8(&bytes[start..j]) {
                            delimiters.push(delim.to_string());
                        }
                        if quote.is_some() {
                            j += 1;
                        }
                        i = j;
                        continue;
                    }
                }
            }
            i += 1;
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
    let mut punct = String::new();

    for c in line.chars() {
        if escaped {
            if c != '\n' {
                cur.push(c);
            }
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
        if matches!(c, ';' | '&' | '|' | '<' | '>') {
            if !cur.is_empty() {
                tokens.push(cur.clone());
                cur.clear();
            }
            punct.push(c);
            continue;
        }
        if !punct.is_empty() {
            tokens.push(punct.clone());
            punct.clear();
        }
        if matches!(c, ' ' | '\t' | '\r') {
            if !cur.is_empty() {
                tokens.push(cur.clone());
                cur.clear();
            }
            continue;
        }
        if matches!(c, '(' | ')' | '\n') {
            if !cur.is_empty() {
                tokens.push(cur.clone());
                cur.clear();
            }
            tokens.push(c.to_string());
            continue;
        }
        cur.push(c);
    }
    if in_single || in_double || escaped {
        return Vec::new();
    }
    if !punct.is_empty() {
        tokens.push(punct);
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
                && !last.is_empty()
                && last.chars().all(|c| c.is_ascii_digit())
            {
                words.pop();
            }
            redirect = true;
        } else if !token.is_empty()
            && token
                .chars()
                .all(|c| matches!(c, '(' | ')' | ';' | '|' | '&' | '\n'))
        {
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
                    if let Some(rest) = arg.strip_prefix('-')
                        && !rest.is_empty()
                        && rest.chars().all(|c| c.is_ascii_lowercase())
                        && rest.contains('c')
                    {
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
            let text = paths::shlex_join(bare.iter().map(String::as_str));
            found.push((kind, text, words));
        }
    }
    found
}

fn parse_porcelain_z(raw: &[u8]) -> Option<Vec<(String, String)>> {
    let mut tokens: Vec<&[u8]> = raw.split(|&b| b == 0).collect();
    if tokens.last() == Some(&b"".as_slice()) {
        tokens.pop();
    }
    let mut entries = Vec::new();
    let mut idx = 0;
    while idx < tokens.len() {
        let tok = tokens[idx];
        idx += 1;
        if tok.len() < 4 || tok[2] != b' ' {
            return None;
        }
        let status_code = String::from_utf8_lossy(&tok[..2]).into_owned();
        let path = String::from_utf8_lossy(&tok[3..]).into_owned();
        let is_ren_copy = status_code.contains('R') || status_code.contains('C');
        entries.push((status_code.clone(), path));
        if is_ren_copy {
            if idx >= tokens.len() {
                return None;
            }
            let src = String::from_utf8_lossy(tokens[idx]).into_owned();
            entries.push((format!("{status_code}<-"), src));
            idx += 1;
        }
        if entries.len() > MAX_STATUS_ENTRIES {
            return None;
        }
    }
    Some(entries)
}

fn stat_mtime_ns(meta: &fs::Metadata) -> i128 {
    i128::from(meta.mtime()) * 1_000_000_000 + i128::from(meta.mtime_nsec())
}

fn fingerprint(top: &Path) -> Option<String> {
    let top_str = top.to_str()?;
    let mut head_cmd = Command::new("git");
    head_cmd
        .args([
            "--no-optional-locks",
            "-C",
            top_str,
            "rev-parse",
            "--verify",
            "HEAD",
        ])
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(std::process::Stdio::null());
    let head_out = paths::run_output_with_timeout(&mut head_cmd, Duration::from_secs(3))?;
    let head_sha = String::from_utf8_lossy(&head_out.stdout).trim().to_string();
    if !head_out.status.success() || head_sha.is_empty() {
        return None;
    }

    let mut status_cmd = Command::new("git");
    status_cmd
        .args([
            "--no-optional-locks",
            "-C",
            top_str,
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
        ])
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(std::process::Stdio::null());
    let porcelain = paths::run_output_with_timeout(&mut status_cmd, Duration::from_secs(5))?;
    if !porcelain.status.success() {
        return None;
    }

    let entries = parse_porcelain_z(&porcelain.stdout)?;
    let mut records: Vec<String> = Vec::new();
    for (status_code, rel_path) in entries {
        let target = top.join(&rel_path);
        match fs::symlink_metadata(&target) {
            Ok(st) => {
                records.push(format!(
                    "{status_code}:{rel_path}:{}:{}:{}",
                    st.mode(),
                    st.size(),
                    stat_mtime_ns(&st)
                ));
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                records.push(format!("{status_code}:{rel_path}:deleted"));
            }
            Err(_) => return None,
        }
    }
    for rel_path in INSTALL_STATES {
        let target = top.join(rel_path);
        match fs::symlink_metadata(&target) {
            Ok(st) => {
                records.push(format!(
                    "install:{rel_path}:{}:{}:{}",
                    st.mode(),
                    st.size(),
                    stat_mtime_ns(&st)
                ));
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
            Err(_) => return None,
        }
    }
    records.sort();
    let mut bytes = format!("v1\0head:{head_sha}\0").into_bytes();
    for item in records {
        bytes.extend_from_slice(item.as_bytes());
        bytes.push(0);
    }
    let hex = sha256::sha256_hex(&bytes);
    Some(format!("v1:{}", &hex[..24]))
}

fn inspect_checkout(raw_cwd: Option<&str>) -> (Option<String>, Option<String>) {
    let Some(c) = raw_cwd.map(str::trim).filter(|s| !s.is_empty()) else {
        return (None, None);
    };
    let resolved = match fs::canonicalize(c) {
        Ok(r) if r.is_dir() => r,
        _ => return (None, None),
    };
    let Some(res_str) = resolved.to_str() else {
        return (None, None);
    };
    let mut cmd = Command::new("git");
    cmd.args(["-C", res_str, "rev-parse", "--show-toplevel"])
        .stdin(std::process::Stdio::null());
    let Some(out) = paths::run_output_with_timeout(&mut cmd, Duration::from_secs(3)) else {
        return (None, None);
    };
    let top_str = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if !out.status.success() || top_str.is_empty() {
        return (None, None);
    }
    let Ok(top) = fs::canonicalize(&top_str) else {
        return (None, None);
    };
    let rel = match resolved.strip_prefix(&top) {
        Ok(r) => {
            let s = r.to_string_lossy();
            if s.is_empty() {
                ".".to_string()
            } else {
                s.into_owned()
            }
        }
        Err(_) => return (None, None),
    };
    (Some(top.to_string_lossy().into_owned()), Some(rel))
}

fn hook_context(payload: &Value, line: &str) -> (Option<String>, Option<String>) {
    let mut raw_cwd: Option<&str> = None;
    if let Some(ti) = payload.get("tool_input").and_then(Value::as_object) {
        for key in ["workdir", "cwd"] {
            if let Some(v) = ti.get(key).and_then(Value::as_str)
                && !v.trim().is_empty()
            {
                raw_cwd = Some(v);
                break;
            }
        }
    }
    if raw_cwd.is_none()
        && let Some(v) = payload.get("cwd").and_then(Value::as_str)
        && !v.trim().is_empty()
    {
        raw_cwd = Some(v);
    }
    if raw_cwd.is_none()
        && let Some(args) = payload
            .get("toolCall")
            .and_then(|c| c.get("args"))
            .and_then(Value::as_object)
    {
        for key in ["cwd", "workingDirectory", "workdir"] {
            if let Some(v) = args.get(key).and_then(Value::as_str)
                && !v.trim().is_empty()
            {
                raw_cwd = Some(v);
                break;
            }
        }
    }
    if raw_cwd.is_none()
        && let Some(spaces) = payload.get("workspacePaths").and_then(Value::as_array)
        && spaces.len() == 1
        && let Some(v) = spaces[0].as_str()
        && !v.trim().is_empty()
    {
        raw_cwd = Some(v);
    }

    let (checkout_opt, mut relative_cwd) = inspect_checkout(raw_cwd);
    let (Some(checkout), Some(raw_cwd_str)) = (checkout_opt, raw_cwd) else {
        return (None, None);
    };
    let mut cur_dir = PathBuf::from(raw_cwd_str);
    for words in simple_commands(line, 0) {
        let (bare, _) = strip_prefixes(&words);
        if bare.first().map(String::as_str) == Some("cd") {
            if bare.len() != 2 || bare[1].starts_with('-') {
                return (None, None);
            }
            let arg = &bare[1];
            let target = if arg == "~" || arg.starts_with("~/") {
                paths::expand_home(arg, None)
            } else {
                let p = Path::new(arg);
                if p.is_absolute() {
                    p.to_path_buf()
                } else {
                    cur_dir.join(p)
                }
            };
            let (new_checkout, _) = inspect_checkout(target.to_str());
            if new_checkout.as_deref() != Some(checkout.as_str()) {
                return (None, None);
            }
            cur_dir = target;
            relative_cwd = None;
        } else if bare.iter().any(|w| {
            w == "workspace"
                || PACKAGE_VALUES.contains(&w.as_str())
                || PACKAGE_VALUES
                    .iter()
                    .any(|f| w.starts_with(f) && w.as_bytes().get(f.len()) == Some(&b'='))
        }) {
            relative_cwd = None;
        }
    }
    (Some(checkout), relative_cwd)
}

fn get_active_holders(dir: &Path) -> Vec<Value> {
    let mut slot_paths: Vec<(PathBuf, String)> = Vec::new();
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if let Some(name) = p.file_name().and_then(|f| f.to_str())
                && name.starts_with("slot-")
                && name.ends_with(".lock")
            {
                slot_paths.push((
                    p.clone(),
                    name.strip_suffix(".lock").unwrap_or("").to_string(),
                ));
            }
        }
    }
    slot_paths.sort_by(|a, b| a.0.cmp(&b.0));
    let queue_path = dir.join("queue.lock");
    if queue_path.exists() {
        slot_paths.push((queue_path, "queue".to_string()));
    }

    let mut result = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for (path, lock_stem) in slot_paths {
        let Ok(c_path) = CString::new(path.as_os_str().as_bytes()) else {
            continue;
        };
        let fd = unsafe { libc::open(c_path.as_ptr(), libc::O_RDWR) };
        if fd < 0 {
            continue;
        }
        let res = unsafe { libc::flock(fd, libc::LOCK_EX | libc::LOCK_NB) };
        if res == 0 {
            unsafe {
                libc::flock(fd, libc::LOCK_UN);
                libc::close(fd);
            }
            continue;
        }
        unsafe { libc::close(fd) };
        if let Ok(content) = fs::read_to_string(&path)
            && let Ok(mut val) = serde_json::from_str::<Value>(&content)
            && let Some(obj) = val.as_object_mut()
            && !obj.is_empty()
        {
            let dedup_key = obj
                .get("runId")
                .and_then(Value::as_str)
                .map(|s| format!("id:{s}"))
                .or_else(|| {
                    obj.get("pid")
                        .and_then(Value::as_i64)
                        .map(|p| format!("pid:{p}"))
                })
                .unwrap_or_default();
            if !dedup_key.is_empty() && !seen.insert(dedup_key) {
                continue;
            }
            obj.insert("lock".to_string(), Value::String(lock_stem));
            result.push(val);
        }
    }
    result
}

fn load_runs(dir: &Path) -> Vec<Value> {
    let path = dir.join("runs.jsonl");
    let Ok(content) = fs::read_to_string(&path) else {
        return Vec::new();
    };
    let mut entries = Vec::new();
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Ok(mut item) = serde_json::from_str::<Value>(trimmed)
            && item.get("runId").is_some_and(paths::is_truthy_json)
        {
            if let Some(lp) = item
                .get("logPath")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                && !Path::new(&lp).is_file()
                && let Some(obj) = item.as_object_mut()
            {
                obj.insert("logPath".to_string(), Value::Null);
                obj.insert("logExpired".to_string(), Value::Bool(true));
            }
            entries.push(item);
        }
    }
    if entries.len() > RUNS_KEPT {
        entries.drain(..entries.len() - RUNS_KEPT);
    }
    entries
}

fn capped(command: &[String], workers: i64) -> Vec<String> {
    if !classify(command).is_some_and(|(k, _)| k == "jest") {
        return command.to_vec();
    }
    let names: Vec<String> = command
        .iter()
        .map(|w| {
            let base = Path::new(w)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("");
            base.trim_end_matches(".cjs")
                .trim_end_matches(".mjs")
                .trim_end_matches(".js")
                .to_string()
        })
        .collect();
    let jest_start = names
        .iter()
        .position(|n| n == "jest")
        .map_or(1, |idx| idx + 1);
    let jest_args = command.get(jest_start..).unwrap_or(&[]);
    let sets_workers = jest_args.iter().any(|a| {
        a.starts_with("--maxWorkers") || a.starts_with("-w") || a == "-i" || a == "--runInBand"
    });
    if sets_workers {
        command.to_vec()
    } else {
        let mut out = command.to_vec();
        out.push(format!("--maxWorkers={workers}"));
        out
    }
}

fn is_exact_match(
    entry: &Value,
    checkout: &str,
    relative_cwd: Option<&str>,
    requested: &[String],
    effective: &[String],
    workers: i64,
) -> bool {
    let Some(rel) = relative_cwd.filter(|s| !s.is_empty()) else {
        return false;
    };
    if entry.get("checkout").and_then(Value::as_str) != Some(checkout)
        || entry.get("relativeCwd").and_then(Value::as_str) != Some(rel)
        || entry.get("workers").and_then(Value::as_i64) != Some(workers)
    {
        return false;
    }
    let vec_matches = |key: &str, expected: &[String]| {
        entry.get(key).and_then(Value::as_array).is_some_and(|arr| {
            arr.len() == expected.len()
                && arr
                    .iter()
                    .zip(expected.iter())
                    .all(|(v, e)| v.as_str() == Some(e.as_str()))
        })
    };
    vec_matches("requestedArgv", requested) && vec_matches("effectiveArgv", effective)
}

fn format_mm_ss(total_secs: i64) -> String {
    let s = total_secs.max(0);
    format!("{}m{:02}s", s / 60, s % 60)
}

fn describe_holder(holder: &Value) -> String {
    let started = holder
        .get("startedAt")
        .and_then(Value::as_str)
        .or_else(|| holder.get("queuedAt").and_then(Value::as_str));
    let elapsed = started
        .and_then(paths::parse_iso8601_utc_secs)
        .map_or_else(String::new, |secs| {
            format!(", {}", format_mm_ss(paths::utc_now_secs() - secs))
        });
    let what = if holder.get("lock").and_then(Value::as_str) == Some("queue") {
        "queued heavy run"
    } else if holder.get("heavy").is_some_and(paths::is_truthy_json) {
        "heavy run"
    } else {
        "run"
    };
    let agent = holder.get("agent").and_then(Value::as_str).unwrap_or("?");
    let label = holder.get("label").and_then(Value::as_str).unwrap_or("?");
    let pid_str = holder
        .get("pid")
        .map(|v| match v {
            Value::Number(n) => n.to_string(),
            Value::String(s) => s.clone(),
            _ => "?".to_string(),
        })
        .unwrap_or_else(|| "?".to_string());
    format!("{agent}'s {what} `{label}` (pid {pid_str}{elapsed})")
}

fn source_state(entry: &Value, current_fp: Option<&str>) -> &'static str {
    let start_fp = entry
        .get("startFingerprint")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    let end_fp = entry
        .get("endFingerprint")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    if entry
        .get("sourceChangedDuringRun")
        .is_some_and(paths::is_truthy_json)
        || matches!((start_fp, end_fp), (Some(s), Some(e)) if s != e)
    {
        return "source changed during the run";
    }
    let (Some(_), Some(e), Some(cur)) = (start_fp, end_fp, current_fp) else {
        return "source metadata unknown";
    };
    if e == cur {
        "source metadata matched"
    } else {
        "source metadata changed"
    }
}

fn describe_run(entry: &Value, current_fp: Option<&str>) -> String {
    let what = if entry.get("heavy").is_some_and(paths::is_truthy_json) {
        "heavy run"
    } else {
        "run"
    };
    let code = entry.get("exitCode").and_then(Value::as_i64);
    let outcome = entry
        .get("outcome")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or(if code == Some(0) { "passed" } else { "failed" });
    let status_text = if outcome == "failed"
        && let Some(c) = code
    {
        format!("failed (exit {c})")
    } else if outcome == "signaled" {
        if let Some(sig) = entry.get("signal").and_then(Value::as_i64) {
            format!("killed by signal {sig}")
        } else {
            let c_str = code.map_or_else(|| "None".to_string(), |c| c.to_string());
            format!("signaled (exit {c_str})")
        }
    } else if outcome == "launch_error" {
        "failed to launch".to_string()
    } else {
        outcome.to_string()
    };
    let age_part = entry
        .get("finishedAt")
        .and_then(Value::as_str)
        .and_then(paths::parse_iso8601_utc_secs)
        .map_or_else(String::new, |secs| {
            format!(" {} ago", format_mm_ss(paths::utc_now_secs() - secs))
        });
    let duration = entry
        .get("durationSeconds")
        .and_then(|v| if v.is_boolean() { None } else { v.as_f64() })
        .filter(|&d| d >= 0.0)
        .map_or_else(|| "?s".to_string(), |d| format_mm_ss(d.round() as i64));
    let src = source_state(entry, current_fp);
    let log_part = if let Some(lp) = entry
        .get("logPath")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    {
        format!("; log: {lp}")
    } else if entry.get("logExpired").is_some_and(paths::is_truthy_json) {
        "; log expired".to_string()
    } else {
        String::new()
    };
    let agent = entry.get("agent").and_then(Value::as_str).unwrap_or("?");
    let label = entry.get("label").and_then(Value::as_str).unwrap_or("?");
    format!("{agent}'s {what} `{label}` {status_text}{age_part} ({duration}, {src}{log_part})")
}

fn format_refusal(
    runs: &[(String, String, Vec<String>)],
    dir: Option<&Path>,
    checkout: Option<&str>,
    relative_cwd: Option<&str>,
) -> String {
    let (kind, text, raw_argv) = &runs[0];
    let gate_cmd = gate_command();
    let base = format!(
        "`{text}` runs a whole {kind} pass, and several agents share this machine. To check whether your \
change broke something, run the tests that exercise it instead: the test file beside the code you \
changed, or `vitest related` / `jest --findRelatedTests` with the source files you changed. If you \
really need the full run, as the final check, wrap it so it waits for other heavy runs: \
`{gate_cmd} --heavy -- {text}`."
    );

    let (Some(g_dir), Some(co)) = (dir, checkout) else {
        return base;
    };
    let my_pid = i64::from(std::process::id());
    let active: Vec<Value> = get_active_holders(g_dir)
        .into_iter()
        .filter(|h| {
            h.get("checkout").and_then(Value::as_str) == Some(co)
                && h.get("pid").and_then(Value::as_i64) != Some(my_pid)
        })
        .collect();
    let history: Vec<Value> = load_runs(g_dir)
        .into_iter()
        .filter(|r| r.get("checkout").and_then(Value::as_str) == Some(co))
        .collect();
    let effective = capped(raw_argv, WORKERS);
    let exact: Vec<&Value> = history
        .iter()
        .filter(|r| is_exact_match(r, co, relative_cwd, raw_argv, &effective, WORKERS))
        .collect();

    let mut notes = Vec::new();
    if let Some(first_active) = active.first() {
        notes.push(format!(
            "Active in this checkout: {}.",
            describe_holder(first_active)
        ));
    }
    if let Some(&last_exact) = exact.last() {
        let fp = fingerprint(Path::new(co));
        notes.push(format!(
            "Last matching run in this checkout: {}.",
            describe_run(last_exact, fp.as_deref())
        ));
    }
    if notes.is_empty() && history.is_empty() {
        return base;
    }
    if notes.len() < 2 {
        notes.push(format!(
            "Run `{gate_cmd} status` to see active and recent runs."
        ));
    }
    let kept = &notes[..notes.len().min(2)];
    format!("{base}\n{}", kept.join("\n"))
}

pub fn run(harness: &str, fallback_script: Option<&Path>) -> io::Result<()> {
    let _ = fallback_script;
    let mut raw_stdin = Vec::new();
    if io::stdin().read_to_end(&mut raw_stdin).is_err() || raw_stdin.is_empty() {
        return Ok(());
    }

    let payload: Value = match serde_json::from_slice(&raw_stdin) {
        Ok(v) => v,
        Err(_) => return Ok(()),
    };

    let command_line = if let Some(input) = payload.get("tool_input").and_then(Value::as_object) {
        if let Some(cmd) = input.get("command") {
            if let Some(s) = cmd.as_str() {
                Some(s.to_string())
            } else if let Some(arr) = cmd.as_array()
                && arr.iter().all(Value::is_string)
            {
                Some(paths::shlex_join(arr.iter().filter_map(Value::as_str)))
            } else {
                None
            }
        } else {
            None
        }
    } else if let Some(call) = payload.get("toolCall") {
        call.get("args")
            .and_then(|a| a.get("CommandLine"))
            .and_then(Value::as_str)
            .map(String::from)
    } else {
        None
    };

    let Some(ref line) = command_line else {
        return Ok(());
    };
    if line.trim().is_empty() {
        return Ok(());
    }

    let detailed = heavy_runs(line);
    if detailed.is_empty() {
        return Ok(());
    }

    let (checkout, relative_cwd) = hook_context(&payload, line);
    let g_dir = gate_dir();
    let reason = format_refusal(
        &detailed,
        Some(&g_dir),
        checkout.as_deref(),
        relative_cwd.as_deref(),
    );

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_drop_heredocs_and_here_strings_and_redirects() {
        let commit_msg = "git commit -m \"$(cat <<'EOF'\nvitest run\nEOF\n)\"";
        assert!(heavy_runs(commit_msg).is_empty());

        let herestring = "cat <<< hello && vitest run";
        let runs = heavy_runs(herestring);
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].0, "vitest");
        assert_eq!(runs[0].1, "vitest run");

        let with_redirect = "npx eslint . 2>&1";
        let exact_runs = heavy_runs(with_redirect);
        assert_eq!(exact_runs.len(), 1);
        assert_eq!(exact_runs[0].1, "npx eslint .");
    }

    #[test]
    fn test_unbalanced_quotes_do_not_false_deny() {
        assert!(heavy_runs("echo \"unterminated && vitest run").is_empty());
    }

    #[test]
    fn test_hook_context_requires_explicit_cwd_and_invalidates_rel_on_cd() {
        let payload = serde_json::json!({"tool_input": {"command": "vitest run"}});
        assert_eq!(hook_context(&payload, "vitest run"), (None, None));
    }

    #[test]
    fn test_refusal_suppresses_status_hint_without_holders_or_history() {
        let tmp = env::temp_dir().join(format!("ork-fast-gate-refusal-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let runs = vec![(
            "vitest".to_string(),
            "vitest run".to_string(),
            vec!["vitest".to_string(), "run".to_string()],
        )];
        let msg = format_refusal(&runs, Some(&tmp), Some("/tmp"), Some("."));
        assert!(!msg.contains("status` to see active"));
        let _ = fs::remove_dir_all(&tmp);
    }
}
