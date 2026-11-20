//! `ork-fast herdr-status`: a bounded, read-only status line for Herdr's focused pane.
//!
//! Mirrors `scripts/herdr_status.py`. Every normal miss, bad record, timeout or ambiguity prints one
//! newline and exits zero. Unknown arguments hand over to the trusted Python script exactly once.

use std::collections::HashSet;
use std::env;
use std::fs;
use std::io::{self, Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::identity;
use crate::mailbox_records;
use crate::paths;
use crate::rooms_work;
use crate::sqlite;
use crate::terminal;

/// One monotonic budget for the whole lookup.
pub const OPERATION_BUDGET: Duration = Duration::from_millis(180);
/// Longest the Herdr CLI may run, further capped by what remains of the operation budget.
pub const CLI_BUDGET: Duration = Duration::from_millis(100);
const MAX_CLI_OUTPUT: usize = 256 * 1024;
const MAX_PEER_BYTES: u64 = 1024 * 1024;
const MAX_PEER_FILES: usize = 4096;
const FALLBACK_GUARD_ENV: &str = "ORK_HERDR_STATUS_FALLBACK";

/// Deadline over an injectable monotonic clock, so tests need no sleeping.
#[derive(Clone, Copy)]
pub struct Budget {
    deadline: Instant,
    clock: fn() -> Instant,
}

impl Budget {
    #[must_use]
    pub fn new(total: Duration, clock: fn() -> Instant) -> Self {
        Self {
            deadline: clock() + total,
            clock,
        }
    }

    #[must_use]
    pub fn expired(&self) -> bool {
        (self.clock)() >= self.deadline
    }

    #[must_use]
    pub fn remaining(&self) -> Duration {
        self.deadline.saturating_duration_since((self.clock)())
    }
}

/// Inputs read from the environment once, so lookups stay deterministic under test.
pub struct Request {
    pub pane_id: String,
    pub binary: Option<String>,
    pub room: Option<String>,
    pub endpoint: String,
}

impl Request {
    fn from_env() -> Self {
        let binary = env::var("HERDR_BIN_PATH")
            .ok()
            .filter(|v| !v.is_empty())
            .or_else(|| paths::find_in_path("herdr").map(|p| p.to_string_lossy().into_owned()));
        Self {
            pane_id: env::var("HERDR_ACTIVE_PANE_ID")
                .map(|v| v.trim().to_string())
                .unwrap_or_default(),
            binary,
            room: env::var("ORKEST_SWARM_ROOM").ok().filter(|v| !v.is_empty()),
            endpoint: terminal::herdr_endpoint(),
        }
    }
}

/// Runs `binary args…` for at most `limit`, returning bounded stdout of a zero exit.
type Query<'a> = dyn Fn(&str, &[&str], Duration) -> Option<Vec<u8>> + 'a;

/// Spawn with a hard time limit; the child and its group are killed and reaped on timeout.
#[must_use]
pub fn run_cli(binary: &str, args: &[&str], limit: Duration) -> Option<Vec<u8>> {
    run_command(Command::new(binary).args(args), None, limit)
}

fn run_command(command: &mut Command, input: Option<Vec<u8>>, limit: Duration) -> Option<Vec<u8>> {
    if limit.is_zero() {
        return None;
    }
    let started = Instant::now();
    let mut child = command
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .ok()?;
    if let Some(input) = input {
        let mut stdin = child.stdin.take()?;
        std::thread::spawn(move || {
            let _ = stdin.write_all(&input);
        });
    }
    let mut stdout = child.stdout.take()?;
    let (sender, receiver) = mpsc::sync_channel::<Vec<u8>>(1);
    // A detached reader: a grandchild holding the pipe open can never block this function.
    std::thread::spawn(move || {
        let mut chunk = [0u8; 8192];
        while let Ok(n) = stdout.read(&mut chunk) {
            if n == 0 || sender.send(chunk[..n].to_vec()).is_err() {
                break;
            }
        }
    });
    let reap = |child: &mut std::process::Child| {
        if let Ok(pid) = libc::pid_t::try_from(child.id()) {
            // SAFETY: signalling the process group created for this child above.
            unsafe { libc::kill(-pid, libc::SIGKILL) };
        }
        let _ = child.kill();
        let _ = child.wait();
    };
    let mut out = Vec::new();
    loop {
        if started.elapsed() >= limit {
            reap(&mut child);
            return None;
        }
        let wait = limit
            .saturating_sub(started.elapsed())
            .min(Duration::from_millis(2));
        match receiver.recv_timeout(wait) {
            Ok(chunk) => {
                if chunk.len() > MAX_CLI_OUTPUT - out.len() {
                    reap(&mut child);
                    return None;
                }
                out.extend_from_slice(&chunk);
                continue;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            // End of output: the child closed stdout, so it is exiting.
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                let status = wait_for_exit(&mut child, limit.saturating_sub(started.elapsed()));
                return status.is_some_and(|ok| ok).then_some(out);
            }
        }
    }
}

/// Wait up to `limit` for `child`, killing and reaping it on timeout. `Some(success)` when it exited.
fn wait_for_exit(child: &mut std::process::Child, limit: Duration) -> Option<bool> {
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status.success()),
            Ok(None) if started.elapsed() < limit => std::thread::sleep(Duration::from_millis(1)),
            _ => {
                if let Ok(pid) = libc::pid_t::try_from(child.id()) {
                    // SAFETY: signalling the process group created for this child.
                    unsafe { libc::kill(-pid, libc::SIGKILL) };
                }
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

/// Bounded, non-blocking JSON object read of a regular file (FIFOs and huge files are misses).
fn load_object(path: &Path) -> Option<Value> {
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(path)
        .ok()?;
    let meta = file.metadata().ok()?;
    if !meta.is_file() || meta.size() > MAX_PEER_BYTES {
        return None;
    }
    let mut text = String::new();
    file.take(MAX_PEER_BYTES).read_to_string(&mut text).ok()?;
    serde_json::from_str::<Value>(&text)
        .ok()
        .filter(Value::is_object)
}

/// Python `dict.get` for a possibly absent key: absent and `null` both read as `None`.
fn field<'a>(value: &'a Value, key: &str) -> &'a Value {
    value.get(key).unwrap_or(&Value::Null)
}

fn is_peer_file(name: &str) -> bool {
    name.ends_with(".json")
}

/// The status line for the focused pane, or an empty string for any miss.
#[must_use]
#[cfg(test)]
pub fn status(base: &Path, request: &Request, budget: &Budget, query: &Query<'_>) -> String {
    query_pane(request, budget, query)
        .and_then(|raw| lookup(base, request, budget, &raw))
        .unwrap_or_default()
}

fn query_pane(request: &Request, budget: &Budget, query: &Query<'_>) -> Option<Vec<u8>> {
    let binary = request.binary.as_deref().filter(|b| !b.is_empty())?;
    if request.pane_id.is_empty() {
        return None;
    }
    let limit = CLI_BUDGET.min(budget.remaining());
    query(
        binary,
        &["pane", "current", "--pane", &request.pane_id],
        limit,
    )
}

fn lookup(base: &Path, request: &Request, budget: &Budget, raw: &[u8]) -> Option<String> {
    let payload: Value = serde_json::from_slice(raw).ok()?;
    let pane = payload.get("result")?.get("pane")?;
    if !pane.is_object() {
        return None;
    }
    let agent = field(pane, "agent");
    if !paths::is_truthy_json(agent) {
        return None;
    }
    let agent_kind = agent.as_str()?;
    if budget.expired() {
        return None;
    }

    let _bound = sqlite::set_operation_deadline(budget_deadline(budget));
    let mut peers: Vec<Value> = Vec::new();
    let mut codex_sessions: HashSet<String> = HashSet::new();
    let mut loaded: Vec<Value> = Vec::new();
    match mailbox_records::backend(base) {
        mailbox_records::Backend::Legacy => {
            let entries = fs::read_dir(base.join("peers")).ok()?;
            for (seen, entry) in entries.flatten().enumerate() {
                if budget.expired() || seen >= MAX_PEER_FILES {
                    return None;
                }
                let name = entry.file_name();
                if !is_peer_file(&name.to_string_lossy()) {
                    continue;
                }
                if let Some(peer) = load_object(&entry.path()) {
                    loaded.push(peer);
                }
            }
        }
        mailbox_records::Backend::Sqlite => {
            let listing = mailbox_records::list_peers(base).ok()?;
            if listing.records.len() >= MAX_PEER_FILES {
                return None;
            }
            loaded.extend(
                listing
                    .records
                    .into_iter()
                    .filter_map(|r| r.body)
                    .filter(Value::is_object),
            );
        }
        mailbox_records::Backend::Invalid => return None,
    }
    for peer in loaded {
        if budget.expired() {
            return None;
        }
        let valid = paths::valid_peer(&peer);
        if valid && field(&peer, "harness").as_str() == Some("codex") {
            codex_sessions.extend(identity::native_session_ids(Some(&peer), Some(base)));
        }
        if valid
            && !paths::is_truthy_json(field(&peer, "isSubagent"))
            && !paths::is_truthy_json(field(&peer, "delegatedRun"))
            && field(&peer, "herdrPaneId") == field(pane, "pane_id")
            && terminal::canonical_endpoint(field(&peer, "herdrEndpoint").as_str()).as_deref()
                == Some(request.endpoint.as_str())
            && identity::is_live_peer(&peer, None)
        {
            peers.push(peer);
        }
    }

    let agent_ref = field(pane, "agent_session");
    let empty = !paths::is_truthy_json(agent_ref);
    let owned =
        |peer: &Value, id: &str| identity::native_session_ids(Some(peer), Some(base)).contains(id);
    let mut matches: Vec<&Value> = Vec::new();
    if !empty && !agent_ref.is_object() {
        return None;
    }
    if !empty
        && agent_ref.get("kind").and_then(Value::as_str) == Some("id")
        && field(agent_ref, "agent") == agent
    {
        let harness = if agent_kind == "agy" {
            "gemini"
        } else {
            agent_kind
        };
        if let Some(value) = field(agent_ref, "value").as_str() {
            for peer in &peers {
                if owned(peer, value) && field(peer, "harness").as_str() == Some(harness) {
                    matches.push(peer);
                }
            }
        } else if !peers.is_empty() {
            return None;
        }
    } else if agent_kind == "codex" && empty {
        let title = field(pane, "terminal_title").as_str().unwrap_or("");
        let session = terminal::codex_title_session(title, &codex_sessions)?;
        for peer in &peers {
            if owned(peer, &session) && field(peer, "harness").as_str() == Some("codex") {
                matches.push(peer);
            }
        }
    } else {
        return None;
    }
    if matches.len() != 1 || budget.expired() {
        return None;
    }
    let peer = matches[0];
    let session = field(peer, "session").as_str()?;
    let harness = field(peer, "harness").as_str()?;
    let (_, role, _) = terminal::resolve_structural_role(
        base,
        session,
        Some(harness),
        Some(peer),
        request.room.as_deref(),
    );
    if budget.expired() {
        return None;
    }
    let progress = rooms_work::read_progress(base, peer);
    if budget.expired() {
        return None;
    }
    let title = terminal::work_title(progress.as_ref(), &role);
    let label = terminal::display_label(peer);
    let joined = [label, title]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" · ");
    Some(terminal::plain(&joined))
}

fn budget_deadline(budget: &Budget) -> Instant {
    Instant::now() + budget.remaining()
}

/// Remove the `--fallback-script <path>` pair, returning the path and the remaining arguments.
fn split_args(args: &[String]) -> (Option<String>, Vec<String>) {
    let mut script = None;
    let mut rest = Vec::new();
    let mut idx = 0;
    while idx < args.len() {
        if args[idx] == "--fallback-script" && idx + 1 < args.len() && script.is_none() {
            script = Some(args[idx + 1].clone());
            idx += 2;
            continue;
        }
        rest.push(args[idx].clone());
        idx += 1;
    }
    (script, rest)
}

/// The Python script to hand over to: an explicit `--fallback-script` or the installed one. Either way it
/// must be a real `herdr_status.py` file (no symlink) owned by this user that nobody else can write.
fn fallback_script(explicit: Option<&Path>) -> Option<PathBuf> {
    let candidate = explicit
        .map(Path::to_path_buf)
        .or_else(|| paths::scripts_root().map(|dir| dir.join("herdr_status.py")))?;
    if candidate.file_name().and_then(|n| n.to_str()) != Some("herdr_status.py") {
        return None;
    }
    let meta = fs::symlink_metadata(&candidate).ok()?;
    // SAFETY: getuid has no preconditions.
    let owner_ok = meta.uid() == unsafe { libc::getuid() };
    (meta.is_file() && owner_ok && meta.mode() & 0o022 == 0).then_some(candidate)
}

fn hand_over_to_python(script: Option<&Path>, rest: &[String]) -> io::Result<()> {
    let mut out = io::stdout();
    if env::var_os(FALLBACK_GUARD_ENV).is_some() {
        return out.write_all(b"\n");
    }
    let Some(script) = fallback_script(script) else {
        return out.write_all(b"\n");
    };
    let err = Command::new(paths::python_binary())
        .arg(&script)
        .args(rest)
        .env(FALLBACK_GUARD_ENV, "1")
        .exec();
    // exec only returns on failure: print the single empty line instead.
    let _ = err;
    out.write_all(b"\n")
}

/// Bound discovery on filesystems that may stall inside a syscall.
fn read_before<T: Send + 'static>(
    budget: Budget,
    read: impl FnOnce() -> T + Send + 'static,
) -> Option<T> {
    if budget.expired() {
        return None;
    }
    let (sender, receiver) = mpsc::sync_channel(1);
    std::thread::Builder::new()
        .spawn(move || {
            let _ = sender.send(read());
        })
        .ok()?;
    let value = receiver.recv_timeout(budget.remaining()).ok()?;
    (!budget.expired()).then_some(value)
}

/// Entry point for `ork-fast herdr-status`.
pub fn run(args: &[String], fallback: Option<&Path>) -> io::Result<()> {
    let (flag_script, rest) = split_args(args);
    if !rest.is_empty() {
        let explicit = flag_script.map(PathBuf::from);
        return hand_over_to_python(explicit.as_deref().or(fallback), &rest);
    }
    let budget = Budget::new(OPERATION_BUDGET, Instant::now);
    let result = read_before(budget, Request::from_env).and_then(|request| {
        let raw = query_pane(&request, &budget, &run_cli)?;
        // Storage lookups can block in the filesystem, SQLite or a peer birth-time probe.
        // Keep that work and any children in a process group the caller can stop and reap.
        let mut command = Command::new(env::current_exe().ok()?);
        command.arg("herdr-status-read-pane");
        run_command(&mut command, Some(raw), budget.remaining())
    });
    io::stdout().write_all(
        result
            .as_deref()
            .filter(|bytes| !bytes.is_empty())
            .unwrap_or(b"\n"),
    )
}

/// Private subprocess entry, fed the already bounded Herdr reply on stdin.
pub fn read_pane() -> io::Result<()> {
    let mut raw = Vec::new();
    io::stdin()
        .take(MAX_CLI_OUTPUT as u64 + 1)
        .read_to_end(&mut raw)?;
    let budget = Budget::new(OPERATION_BUDGET, Instant::now);
    let base = paths::cache_home(None, None).join("mailbox-v1");
    let line = if raw.len() > MAX_CLI_OUTPUT {
        None
    } else {
        lookup(&base, &Request::from_env(), &budget, &raw)
    }
    .unwrap_or_default();
    let mut out = io::stdout();
    out.write_all(line.as_bytes())?;
    out.write_all(b"\n")?;
    out.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::cell::Cell;

    thread_local! {
        static ORIGIN: Instant = Instant::now();
        static TICKS: Cell<u64> = const { Cell::new(0) };
        static STEP_MS: Cell<u64> = const { Cell::new(0) };
    }

    /// A per-thread clock that advances `STEP_MS` milliseconds on every reading.
    fn fake_clock() -> Instant {
        let n = TICKS.with(|t| {
            t.set(t.get() + STEP_MS.with(Cell::get));
            t.get()
        });
        ORIGIN.with(|o| *o + Duration::from_millis(n))
    }

    fn request(binary: Option<&str>) -> Request {
        Request {
            pane_id: "p1".into(),
            binary: binary.map(str::to_string),
            room: None,
            endpoint: "/nowhere/herdr.sock".into(),
        }
    }

    fn temp(name: &str) -> PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = env::temp_dir().join(format!(
            "herdr-status-{name}-{}-{stamp}",
            std::process::id()
        ));
        fs::create_dir(&dir).unwrap();
        fs::create_dir(dir.join("peers")).unwrap();
        dir
    }

    #[test]
    fn budget_follows_the_injected_clock() {
        STEP_MS.with(|s| s.set(0));
        let budget = Budget::new(Duration::from_millis(180), fake_clock);
        assert!(!budget.expired());
        STEP_MS.with(|s| s.set(60));
        assert!(!budget.expired());
        assert!(!budget.expired());
        assert!(budget.expired());
        assert_eq!(budget.remaining(), Duration::ZERO);
        STEP_MS.with(|s| s.set(0));
    }

    #[test]
    fn cli_limit_is_capped_by_remaining_budget() {
        STEP_MS.with(|s| s.set(0));
        let seen = Cell::new(Duration::ZERO);
        let budget = Budget::new(Duration::from_millis(40), fake_clock);
        let dir = temp("cap");
        let query = |_: &str, _: &[&str], limit: Duration| {
            seen.set(limit);
            None
        };
        assert_eq!(status(&dir, &request(Some("herdr")), &budget, &query), "");
        assert_eq!(seen.get(), Duration::from_millis(40));
        let budget = Budget::new(Duration::from_millis(500), fake_clock);
        let _ = status(&dir, &request(Some("herdr")), &budget, &query);
        assert_eq!(seen.get(), CLI_BUDGET);
    }

    #[test]
    fn zero_budget_gives_the_cli_no_time() {
        STEP_MS.with(|s| s.set(0));
        let dir = temp("expired");
        let budget = Budget::new(Duration::ZERO, fake_clock);
        let called = Cell::new(false);
        let query = |_: &str, _: &[&str], _: Duration| {
            called.set(true);
            Some(b"{}".to_vec())
        };
        assert_eq!(status(&dir, &request(Some("herdr")), &budget, &query), "");
        assert!(called.get());
    }

    #[test]
    fn misses_are_empty() {
        STEP_MS.with(|s| s.set(0));
        let dir = temp("misses");
        let budget = || Budget::new(OPERATION_BUDGET, fake_clock);
        let reply = |text: &'static str| {
            move |_: &str, _: &[&str], _: Duration| Some(text.as_bytes().to_vec())
        };
        let mut none = request(None);
        assert_eq!(status(&dir, &none, &budget(), &reply("{}")), "");
        none = request(Some("herdr"));
        none.pane_id.clear();
        assert_eq!(status(&dir, &none, &budget(), &reply("{}")), "");
        for body in [
            "not json",
            "[]",
            "{}",
            r#"{"result":{}}"#,
            r#"{"result":{"pane":{}}}"#,
            r#"{"result":{"pane":{"agent":null}}}"#,
            r#"{"result":{"pane":{"agent":"claude","agent_session":"x"}}}"#,
            r#"{"result":{"pane":{"agent":"claude"}}}"#,
        ] {
            assert_eq!(
                status(&dir, &request(Some("herdr")), &budget(), &reply(body)),
                "",
                "{body}"
            );
        }
    }

    #[test]
    fn split_args_extracts_flag_once() {
        let args: Vec<String> = [
            "--fallback-script",
            "x.py",
            "--wat",
            "--fallback-script",
            "y.py",
        ]
        .map(String::from)
        .to_vec();
        let (script, rest) = split_args(&args);
        assert_eq!(script.as_deref(), Some("x.py"));
        assert_eq!(rest, ["--wat", "--fallback-script", "y.py"]);
        let (script, rest) = split_args(&["--fallback-script".to_string()]);
        assert!(script.is_none());
        assert_eq!(rest, ["--fallback-script"]);
    }

    #[test]
    fn peer_loader_ignores_oversized_and_non_object_files() {
        let dir = temp("loader");
        let big = dir.join("big.json");
        fs::write(&big, vec![b' '; (MAX_PEER_BYTES + 1) as usize]).unwrap();
        assert!(load_object(&big).is_none());
        let list = dir.join("list.json");
        fs::write(&list, "[1]").unwrap();
        assert!(load_object(&list).is_none());
        let ok = dir.join("ok.json");
        fs::write(&ok, json!({"a": 1}).to_string()).unwrap();
        assert!(load_object(&ok).is_some());
    }

    #[test]
    fn run_cli_kills_and_reaps_a_slow_child() {
        let started = Instant::now();
        assert!(run_cli("/bin/sleep", &["5"], Duration::from_millis(50)).is_none());
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn run_cli_bounds_output_and_requires_success() {
        assert_eq!(
            run_cli("/bin/echo", &["hello"], Duration::from_millis(500)).as_deref(),
            Some(&b"hello\n"[..])
        );
        assert!(run_cli("/bin/false", &[], Duration::from_millis(500)).is_none());
        assert!(run_cli("/nonexistent/herdr", &[], Duration::from_millis(500)).is_none());
        // Endless output is cut off at the cap instead of buffering forever.
        assert!(run_cli("/usr/bin/yes", &[], Duration::from_millis(500)).is_none());
    }
}
