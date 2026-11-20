//! Shared runtime path discovery matching runtime_paths.py and runtime-paths.mjs.

use std::collections::HashMap;
use std::env;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_RANDOM_DEV_BYTES: usize = 64;
static TEMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// Expand a leading `~` or `~/` using the user's home directory.
#[must_use]
pub fn expand_home(value: &str, home: Option<&Path>) -> PathBuf {
    let home_dir = home
        .map(Path::to_path_buf)
        .or_else(|| env::var_os("HOME").map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("/"));

    if value == "~" {
        return home_dir;
    }
    if let Some(rest) = value.strip_prefix("~/") {
        return home_dir.join(rest);
    }
    PathBuf::from(value)
}

/// Return the first non-empty value among the given environment variable names.
#[must_use]
pub fn env_first(names: &[&str], env_map: Option<&HashMap<String, String>>) -> Option<String> {
    for &name in names {
        if let Some(map) = env_map {
            if let Some(val) = map.get(name)
                && !val.is_empty()
            {
                return Some(val.clone());
            }
        } else if let Ok(val) = env::var(name)
            && !val.is_empty()
        {
            return Some(val);
        }
    }
    None
}

/// Resolve the orchestrate cache directory with agent-executor legacy fallback.
#[must_use]
pub fn cache_home(env_map: Option<&HashMap<String, String>>, home: Option<&Path>) -> PathBuf {
    if let Some(explicit) = env_first(&["ORCHESTRATE_HOME", "AGENT_EXECUTOR_HOME"], env_map) {
        return expand_home(&explicit, home);
    }
    let home_path = home
        .map(Path::to_path_buf)
        .or_else(|| env::var_os("HOME").map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("/"));

    let xdg = env_map
        .and_then(|m| m.get("XDG_CACHE_HOME").cloned())
        .or_else(|| env::var("XDG_CACHE_HOME").ok());

    let cache_root = if let Some(xdg_val) = xdg {
        if !xdg_val.is_empty() {
            expand_home(&xdg_val, Some(&home_path))
        } else {
            home_path.join(".cache")
        }
    } else {
        home_path.join(".cache")
    };

    let primary = cache_root.join("orchestrate");
    let legacy = cache_root.join("agent-executor");
    if primary.exists() {
        return primary;
    }
    if legacy.exists() {
        return legacy;
    }
    primary
}

/// Resolve the orchestrate config directory with agent-executor legacy fallback.
#[allow(dead_code)]
#[must_use]
pub fn config_home(env_map: Option<&HashMap<String, String>>, home: Option<&Path>) -> PathBuf {
    if let Some(explicit) = env_first(&["ORCHESTRATE_CONFIG", "AGENT_EXECUTOR_CONFIG"], env_map) {
        let path = expand_home(&explicit, home);
        return path
            .parent()
            .map_or_else(|| path.clone(), Path::to_path_buf);
    }
    let home_path = home
        .map(Path::to_path_buf)
        .or_else(|| env::var_os("HOME").map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("/"));

    let xdg = env_map
        .and_then(|m| m.get("XDG_CONFIG_HOME").cloned())
        .or_else(|| env::var("XDG_CONFIG_HOME").ok());

    let config_root = if let Some(xdg_val) = xdg {
        if !xdg_val.is_empty() {
            expand_home(&xdg_val, Some(&home_path))
        } else {
            home_path.join(".config")
        }
    } else {
        home_path.join(".config")
    };

    let primary = config_root.join("orchestrate");
    let legacy = config_root.join("agent-executor");
    if primary.join("config.json").exists() || primary.exists() {
        return primary;
    }
    if legacy.join("config.json").exists() || legacy.exists() {
        return legacy;
    }
    primary
}

/// Resolve the orchestrate config file with agent-executor legacy fallback.
#[allow(dead_code)]
#[must_use]
pub fn config_path(env_map: Option<&HashMap<String, String>>, home: Option<&Path>) -> PathBuf {
    if let Some(explicit) = env_first(&["ORCHESTRATE_CONFIG", "AGENT_EXECUTOR_CONFIG"], env_map) {
        return expand_home(&explicit, home);
    }
    let home_path = home
        .map(Path::to_path_buf)
        .or_else(|| env::var_os("HOME").map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("/"));

    let xdg = env_map
        .and_then(|m| m.get("XDG_CONFIG_HOME").cloned())
        .or_else(|| env::var("XDG_CONFIG_HOME").ok());

    let config_root = if let Some(xdg_val) = xdg {
        if !xdg_val.is_empty() {
            expand_home(&xdg_val, Some(&home_path))
        } else {
            home_path.join(".config")
        }
    } else {
        home_path.join(".config")
    };

    let primary = config_root.join("orchestrate").join("config.json");
    let legacy = config_root.join("agent-executor").join("config.json");
    if primary.exists() {
        return primary;
    }
    if legacy.exists() {
        return legacy;
    }
    primary
}

/// Resolve the binary path for `ork-fast`, honoring `ORK_FAST_BIN`.
#[allow(dead_code)]
#[must_use]
pub fn ork_fast_bin(env_map: Option<&HashMap<String, String>>, home: Option<&Path>) -> PathBuf {
    if let Some(explicit) = env_map
        .and_then(|m| m.get("ORK_FAST_BIN").cloned())
        .or_else(|| env::var("ORK_FAST_BIN").ok())
        && !explicit.is_empty()
    {
        return expand_home(&explicit, home);
    }

    cache_home(env_map, home).join("bin").join("ork-fast")
}

/// Return true if `id` is a valid session identifier matching `mailbox_store.SESSION_ID`.
#[must_use]
pub fn valid_session_id(session: &str) -> bool {
    let bytes = session.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 128
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|&b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'-'))
}

/// Return true if `room_id` matches `[\w-]{1,80}` ASCII.
#[must_use]
pub fn valid_room_id(room_id: &str) -> bool {
    !room_id.is_empty()
        && room_id.len() <= 80
        && room_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Return true if `id` matches `[0-9a-f]+-[0-9a-f]{6}`.
#[must_use]
pub fn valid_message_id(id: &str) -> bool {
    let Some((prefix, suffix)) = id.split_once('-') else {
        return false;
    };
    !prefix.is_empty()
        && prefix
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        && suffix.len() == 6
        && suffix
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Find the canonical Python modules from a checkout path, including a resolved installed skill link.
fn checkout_scripts(start: &Path) -> Option<PathBuf> {
    start
        .ancestors()
        .map(|dir| dir.join("src/py"))
        .find(|p| p.join("run_agent.py").is_file())
}

/// Prefer explicit overrides, then this binary's checkout, the installed hub, or the build checkout.
#[must_use]
pub fn scripts_root() -> Option<PathBuf> {
    if let Ok(val) = env::var("ORKEST_SCRIPTS_DIR")
        && !val.trim().is_empty()
    {
        let p = expand_home(val.trim(), None);
        if p.is_dir() {
            return Some(p);
        }
    }
    if let Ok(val) = env::var("ORKEST_PLUGIN_ROOT")
        && !val.trim().is_empty()
    {
        let plugin = expand_home(val.trim(), None);
        if let Some(p) = checkout_scripts(&plugin) {
            return Some(p);
        }
        let legacy = plugin.join("skills/orchestrate/scripts");
        if legacy.is_dir() {
            return Some(legacy);
        }
    }
    if let Ok(exe) = env::current_exe()
        && let Some(p) = checkout_scripts(&fs::canonicalize(&exe).unwrap_or(exe))
    {
        return Some(p);
    }
    let hub = expand_home("~/.agents/skills/orchestrate", None);
    if let Ok(skill) = fs::canonicalize(&hub) {
        if let Some(p) = checkout_scripts(&skill) {
            return Some(p);
        }
        let bundle = skill.join("scripts");
        if bundle.is_dir() {
            return Some(bundle);
        }
    }
    fs::canonicalize(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src/py")).ok()
}

/// The checkout root above a `plugins/orchestrate` directory, when it holds the shared Node
/// runtime (`src/bin/ork.mjs`).
fn checkout_of_plugin(plugin: &Path) -> Option<PathBuf> {
    let root = plugin.parent()?.parent()?;
    root.join("src/bin/ork.mjs")
        .is_file()
        .then(|| root.to_path_buf())
}

/// Resolve the checkout root holding the shared Node runtime: `src/bin` and `src/lib`.
#[must_use]
pub fn runtime_root() -> Option<PathBuf> {
    checkout_of_plugin(&plugin_root()?)
}

/// Resolve the `plugins/orchestrate` root containing `skills/`. Its checkout holds the Node runtime
/// under `src/`; see [`runtime_root`].
#[must_use]
pub fn plugin_root() -> Option<PathBuf> {
    if let Ok(val) = env::var("ORKEST_PLUGIN_ROOT")
        && !val.trim().is_empty()
    {
        let p = expand_home(val.trim(), None);
        if p.is_dir() {
            return Some(p);
        }
    }
    if let Some(scripts) = scripts_root() {
        let resolved = fs::canonicalize(&scripts).unwrap_or(scripts);
        if let Some(root) = resolved
            .ancestors()
            .find(|p| p.join("src/bin/ork.mjs").is_file())
        {
            return Some(root.join("plugins/orchestrate"));
        }
        if let Some(plugin) = resolved
            .parent()
            .and_then(|p| p.parent())
            .and_then(|p| p.parent())
            && checkout_of_plugin(plugin).is_some()
        {
            return Some(plugin.to_path_buf());
        }
    }
    let manifest_candidate =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../plugins/orchestrate");
    if checkout_of_plugin(&manifest_candidate).is_some() {
        return fs::canonicalize(&manifest_candidate)
            .ok()
            .or(Some(manifest_candidate));
    }
    None
}

fn is_executable_file(path: &Path) -> bool {
    fs::metadata(path).is_ok_and(|m| m.is_file() && (m.permissions().mode() & 0o111) != 0)
}

/// Find `cmd` on `PATH` and return its executable path if present.
#[must_use]
pub fn find_in_path(cmd: &str) -> Option<PathBuf> {
    let path_var = env::var_os("PATH")?;
    for dir in env::split_paths(&path_var) {
        let candidate = dir.join(cmd);
        if is_executable_file(&candidate) {
            return Some(candidate);
        }
    }
    None
}

const MIN_NODE: (u32, u32, u32) = (26, 8, 0);

fn parse_nvm_version(name: &str) -> Option<(u32, u32, u32)> {
    let stripped = name.strip_prefix('v')?;
    let mut parts = stripped.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((major, minor, patch))
}

/// Discover `node` matching `room_store.py::_node_binary()`.
#[must_use]
pub fn node_binary() -> String {
    if let Ok(explicit) = env::var("ORKEST_NODE_BIN")
        && !explicit.trim().is_empty()
    {
        return explicit.trim().to_string();
    }
    let system_dirs = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
    let found = find_in_path("node");
    if let Some(ref p) = found {
        let s = p.to_string_lossy();
        if let Some(parent) = p.parent().and_then(|d| d.to_str())
            && !system_dirs.contains(&parent)
        {
            return s.into_owned();
        }
        for comp in p.components() {
            if let Component::Normal(os_name) = comp
                && let Some(ver) = parse_nvm_version(&os_name.to_string_lossy())
                && ver >= MIN_NODE
            {
                return s.into_owned();
            }
        }
    }
    let nvm_dir = expand_home("~/.nvm/versions/node", None);
    if let Ok(entries) = fs::read_dir(&nvm_dir) {
        let mut best: Option<((u32, u32, u32), PathBuf)> = None;
        for entry in entries.flatten() {
            let bin = entry.path().join("bin/node");
            if let Some(ver) = parse_nvm_version(&entry.file_name().to_string_lossy())
                && ver >= MIN_NODE
                && bin.is_file()
                && best.as_ref().is_none_or(|(b, _)| ver > *b)
            {
                best = Some((ver, bin));
            }
        }
        if let Some((_, bin)) = best {
            return bin.to_string_lossy().into_owned();
        }
    }
    if let Some(p) = found {
        return p.to_string_lossy().into_owned();
    }
    for sys in [
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
    ] {
        let p = Path::new(sys);
        if is_executable_file(p) {
            return sys.to_string();
        }
    }
    "node".to_string()
}

/// Resolve `python3` executable path.
#[must_use]
pub fn python_binary() -> String {
    find_in_path("python3").map_or_else(
        || "python3".to_string(),
        |p| p.to_string_lossy().into_owned(),
    )
}

/// Resolve the current host's `hostname`.
#[must_use]
pub fn current_hostname() -> Option<String> {
    let mut buf = [0u8; 256];
    let rc = unsafe { libc::gethostname(buf.as_mut_ptr().cast::<libc::c_char>(), buf.len()) };
    if rc != 0 {
        return None;
    }
    let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
    String::from_utf8(buf[..end].to_vec()).ok()
}

/// Return true when `val` is Python-truthy.
#[must_use]
pub fn is_truthy_json(val: &serde_json::Value) -> bool {
    match val {
        serde_json::Value::Null => false,
        serde_json::Value::Bool(b) => *b,
        serde_json::Value::Number(n) => n.as_f64().is_some_and(|x| x != 0.0),
        serde_json::Value::String(s) => !s.is_empty(),
        serde_json::Value::Array(a) => !a.is_empty(),
        serde_json::Value::Object(o) => !o.is_empty(),
    }
}

/// Clean printable whitespace into a bounded single line (`<= max_chars`).
#[must_use]
pub fn clean_text(val: &str, max_chars: usize) -> String {
    let printable: String = val
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    printable
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(max_chars)
        .collect()
}

/// POSIX shell-quote a single argument matching Python `shlex.quote`.
#[must_use]
pub fn shlex_quote(s: &str) -> String {
    if s.is_empty() {
        return "''".to_string();
    }
    if s.bytes()
        .all(|b| matches!(b, b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'_' | b'@' | b'%' | b'+' | b'=' | b':' | b',' | b'.' | b'/' | b'-'))
    {
        return s.to_string();
    }
    let escaped = s.replace('\'', "'\"'\"'");
    format!("'{escaped}'")
}

/// Join arguments with POSIX shell quoting matching Python `shlex.join`.
#[must_use]
pub fn shlex_join<'a>(args: impl IntoIterator<Item = &'a str>) -> String {
    args.into_iter()
        .map(shlex_quote)
        .collect::<Vec<_>>()
        .join(" ")
}

/// Run a command and capture output with a strict wall-clock timeout.
pub fn run_output_with_timeout(
    cmd: &mut std::process::Command,
    timeout: std::time::Duration,
) -> Option<std::process::Output> {
    use std::io::Read;
    use std::process::Stdio;
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().ok()?;
    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();
    let out_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut s) = stdout_pipe {
            let _ = s.read_to_end(&mut buf);
        }
        buf
    });
    let err_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut s) = stderr_pipe {
            let _ = s.read_to_end(&mut buf);
        }
        buf
    });
    let deadline = std::time::Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break Some(st),
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    break None;
                }
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let stdout = out_handle.join().unwrap_or_default();
    let stderr = err_handle.join().unwrap_or_default();
    status.map(|st| std::process::Output {
        status: st,
        stdout,
        stderr,
    })
}

/// Read random bytes from `/dev/urandom` with clock/pid fallback.
#[must_use]
pub fn random_bytes(len: usize) -> Vec<u8> {
    let bounded = len.min(MAX_RANDOM_DEV_BYTES);
    let mut out = vec![0u8; bounded];
    if let Ok(mut file) = fs::File::open("/dev/urandom") {
        use std::io::Read;
        if file.read_exact(&mut out).is_ok() {
            return out;
        }
    }
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let mut state = (nanos as u64)
        ^ ((std::process::id() as u64) << 17)
        ^ TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
    for b in &mut out {
        state = state
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1);
        *b = (state >> 32) as u8;
    }
    out
}

/// Generate a mailbox message ID matching `<hex_time_ns>-<6hex>`.
#[must_use]
pub fn message_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let rnd = random_bytes(3);
    format!("{nanos:x}-{:02x}{:02x}{:02x}", rnd[0], rnd[1], rnd[2])
}

/// Compute the filename key for a session matching mailbox_store.py::session_key.
pub fn session_key(session: &str) -> Result<String, String> {
    if session.is_empty() || session.len() > 128 {
        return Err(format!("invalid session id length: {session}"));
    }
    let bytes = session.as_bytes();
    if !bytes[0].is_ascii_alphanumeric() {
        return Err(format!("invalid session id start: {session}"));
    }
    for &b in bytes {
        if !b.is_ascii_alphanumeric() && b != b'_' && b != b'.' && b != b':' && b != b'-' {
            return Err(format!("invalid character in session id: {session}"));
        }
    }

    let key = session.replace(':', "%3A");
    if session == session.to_ascii_lowercase() && key.len() <= 128 {
        return Ok(key);
    }

    let hash_part = &crate::sha1::sha1_hex(session.as_bytes())[..10];
    let prefix_len = 128.min(key.len());
    Ok(format!("{}~{}", &key[..prefix_len], hash_part))
}

/// Return the path to a session's peer file in `<base>/peers/<session_key>.json`.
pub fn peer_path(base: &Path, session: &str) -> Result<PathBuf, String> {
    let key = session_key(session)?;
    Ok(base.join("peers").join(format!("{key}.json")))
}

/// Return the path to a session's inbox directory `<base>/inbox/<session_key>`.
pub fn inbox_dir(base: &Path, session: &str) -> Result<PathBuf, String> {
    let key = session_key(session)?;
    Ok(base.join("inbox").join(key))
}

/// Exclusive POSIX flock guard with inode verification (`mailbox_store.acquire_lock`).
pub struct FileLockGuard {
    pub(crate) fd: libc::c_int,
}

impl Drop for FileLockGuard {
    fn drop(&mut self) {
        unsafe {
            libc::close(self.fd);
        }
    }
}

const LOCK_ACQUIRE_ATTEMPTS: usize = 64;

#[cfg(test)]
pub(crate) fn fd_identity(fd: libc::c_int) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    use std::os::unix::io::FromRawFd;
    let file = std::mem::ManuallyDrop::new(unsafe { fs::File::from_raw_fd(fd) });
    let meta = file.metadata().ok()?;
    Some((meta.dev(), meta.ino()))
}

// cspell:ignore dirfd fstatat mkfifo
fn open_parent_dirfd(parent: &Path) -> io::Result<std::os::unix::io::OwnedFd> {
    use std::ffi::CString;
    use std::os::unix::io::FromRawFd;

    let c_parent = CString::new(parent.as_os_str().as_encoded_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "invalid lock parent path"))?;
    let fd = unsafe {
        libc::open(
            c_parent.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
    };
    if fd >= 0 {
        return Ok(unsafe { std::os::unix::io::OwnedFd::from_raw_fd(fd) });
    }
    let err = io::Error::last_os_error();
    if err.kind() != io::ErrorKind::NotFound {
        return Err(err);
    }
    fs::create_dir_all(parent)?;
    let fd2 = unsafe {
        libc::open(
            c_parent.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
    };
    if fd2 < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { std::os::unix::io::OwnedFd::from_raw_fd(fd2) })
}

fn is_regular_fd(fd: libc::c_int) -> io::Result<bool> {
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstat(fd, &mut st) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok((st.st_mode as libc::mode_t & libc::S_IFMT) == libc::S_IFREG)
}

fn same_regular_inode_in_dirfd(
    fd: libc::c_int,
    parent_fd: libc::c_int,
    c_name: &std::ffi::CStr,
) -> bool {
    let mut fd_st: libc::stat = unsafe { std::mem::zeroed() };
    let mut path_st: libc::stat = unsafe { std::mem::zeroed() };
    (unsafe { libc::fstat(fd, &mut fd_st) } == 0)
        && (unsafe {
            libc::fstatat(
                parent_fd,
                c_name.as_ptr(),
                &mut path_st,
                libc::AT_SYMLINK_NOFOLLOW,
            )
        } == 0)
        && (fd_st.st_mode as libc::mode_t & libc::S_IFMT) == libc::S_IFREG
        && (path_st.st_mode as libc::mode_t & libc::S_IFMT) == libc::S_IFREG
        && fd_st.st_dev == path_st.st_dev
        && fd_st.st_ino == path_st.st_ino
}

pub fn lock_path_exclusive(lock_path: &Path) -> io::Result<FileLockGuard> {
    use std::ffi::CString;
    use std::os::unix::io::AsRawFd;

    let file_name = lock_path
        .file_name()
        .filter(|n| !n.is_empty())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "lock path has no filename"))?;
    let c_name = CString::new(file_name.as_encoded_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "invalid lock filename"))?;
    let parent = lock_path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));

    for _ in 0..LOCK_ACQUIRE_ATTEMPTS {
        let parent_fd = open_parent_dirfd(parent)?;
        let fd = unsafe {
            libc::openat(
                parent_fd.as_raw_fd(),
                c_name.as_ptr(),
                libc::O_RDWR
                    | libc::O_CREAT
                    | libc::O_NOFOLLOW
                    | libc::O_NONBLOCK
                    | libc::O_CLOEXEC,
                0o600,
            )
        };
        if fd < 0 {
            let err = io::Error::last_os_error();
            if err.kind() == io::ErrorKind::NotFound {
                fs::create_dir_all(parent)?;
                continue;
            }
            return Err(err);
        }
        let guard = FileLockGuard { fd };
        if !is_regular_fd(fd)? {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "lock target is not a regular file",
            ));
        }
        loop {
            if unsafe { libc::flock(fd, libc::LOCK_EX) } == 0 {
                break;
            }
            let err = io::Error::last_os_error();
            if err.kind() != io::ErrorKind::Interrupted {
                return Err(err);
            }
        }
        if same_regular_inode_in_dirfd(fd, parent_fd.as_raw_fd(), &c_name) {
            unsafe {
                libc::futimens(fd, std::ptr::null());
            }
            return Ok(guard);
        }
    }
    Err(io::Error::new(
        io::ErrorKind::WouldBlock,
        "could not acquire a stable lock",
    ))
}

pub fn lock_for(target_path: &Path) -> io::Result<FileLockGuard> {
    if let Some(parent) = target_path.parent() {
        fs::create_dir_all(parent)?;
    }
    lock_path_exclusive(&target_path.with_extension("lock"))
}

/// Maximum size (256 KiB) accepted when reading `chief.json`.
pub const CHIEF_JSON_MAX_BYTES: usize = 256 * 1024;

/// Read and parse `chief.json` inside an already-pinned directory descriptor without
/// following symlinks or blocking on FIFOs, verifying regular-file type, matching UID,
/// and a 256 KiB read cap.
pub fn read_chief_json_in_dir_fd(
    dir_fd: std::os::unix::io::BorrowedFd<'_>,
) -> io::Result<Option<serde_json::Value>> {
    use std::ffi::CString;
    use std::io::Read;
    use std::os::unix::io::{AsRawFd, FromRawFd};

    let c_name = CString::new("chief.json").expect("static name has no NUL");
    let fd = unsafe {
        libc::openat(
            dir_fd.as_raw_fd(),
            c_name.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        let err = io::Error::last_os_error();
        if err.kind() == io::ErrorKind::NotFound {
            return Ok(None);
        }
        return Err(err);
    }
    let file = unsafe { fs::File::from_raw_fd(fd) };
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstat(file.as_raw_fd(), &mut st) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let fmt = st.st_mode as libc::mode_t & libc::S_IFMT;
    if fmt == libc::S_IFDIR {
        return Err(io::Error::from_raw_os_error(libc::EISDIR));
    }
    if fmt != libc::S_IFREG {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "chief.json is not a regular file",
        ));
    }
    let uid = unsafe { libc::getuid() };
    if st.st_uid != uid {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "chief.json owner mismatch",
        ));
    }
    if st.st_size < 0 || st.st_size as u64 > CHIEF_JSON_MAX_BYTES as u64 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "chief.json exceeds size cap",
        ));
    }
    let mut buf = Vec::with_capacity((st.st_size as usize).min(CHIEF_JSON_MAX_BYTES));
    file.take((CHIEF_JSON_MAX_BYTES + 1) as u64)
        .read_to_end(&mut buf)?;
    if buf.len() > CHIEF_JSON_MAX_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "chief.json exceeds size cap",
        ));
    }
    let val = serde_json::from_slice::<serde_json::Value>(&buf)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    Ok(Some(val))
}

/// Pin `base` via `O_RDONLY | O_DIRECTORY | O_CLOEXEC`, open `chief.json` via
/// `openat(..., O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)`, verify regular file
/// and matching UID, read capped at 256 KiB, and parse JSON.
pub fn read_chief_json_bounded(base: &Path) -> io::Result<Option<serde_json::Value>> {
    use std::ffi::CString;
    use std::os::unix::io::{AsFd, FromRawFd, OwnedFd};

    let c_base = CString::new(base.as_os_str().as_encoded_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "invalid base path"))?;
    let base_fd = unsafe {
        libc::open(
            c_base.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
    };
    if base_fd < 0 {
        let err = io::Error::last_os_error();
        if err.kind() == io::ErrorKind::NotFound {
            return Ok(None);
        }
        return Err(err);
    }
    let owned_base = unsafe { OwnedFd::from_raw_fd(base_fd) };
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstat(base_fd, &mut st) } != 0 {
        return Err(io::Error::last_os_error());
    }
    if (st.st_mode as libc::mode_t & libc::S_IFMT) != libc::S_IFDIR {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "base is not a directory",
        ));
    }
    read_chief_json_in_dir_fd(owned_base.as_fd())
}

/// Read JSON from `path`, returning `None` on I/O or parse failure.
#[must_use]
pub fn read_json_file(path: &Path) -> Option<serde_json::Value> {
    let content = fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

/// Write a JSON value atomically via temp file + fsync + rename with `0o600` mode.
pub fn write_json_atomic(path: &Path, value: &serde_json::Value) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no parent"))?;
    fs::create_dir_all(parent)?;
    let _ = fs::set_permissions(parent, fs::Permissions::from_mode(0o700));
    let seq = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp_path = parent.join(format!(".mail-{}-{seq}.tmp", std::process::id()));
    let payload =
        serde_json::to_vec(value).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;

    let write_result = (|| -> io::Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&tmp_path)?;
        file.write_all(&payload)?;
        file.sync_all()?;
        Ok(())
    })();

    if let Err(err) = write_result {
        let _ = fs::remove_file(&tmp_path);
        return Err(err);
    }

    if let Err(err) = fs::rename(&tmp_path, path) {
        let _ = fs::remove_file(&tmp_path);
        return Err(err);
    }
    Ok(())
}

/// Validate a message JSON object matching `mailbox_store.py::valid_message`.
#[must_use]
pub fn valid_message(msg: &serde_json::Value) -> bool {
    let Some(obj) = msg.as_object() else {
        return false;
    };
    if obj.get("schema").and_then(|v| v.as_str()) != Some("agent-executor.mail.v1") {
        return false;
    }
    if !obj.get("text").is_some_and(|v| v.is_string()) {
        return false;
    }
    if !obj
        .get("id")
        .and_then(|v| v.as_str())
        .is_some_and(valid_message_id)
    {
        return false;
    }
    if !obj
        .get("sentAt")
        .and_then(|v| v.as_str())
        .is_some_and(|s| parse_iso8601_utc_secs(s).is_some())
    {
        return false;
    }
    let Some(from_obj) = obj.get("from").and_then(|v| v.as_object()) else {
        return false;
    };
    if !from_obj.get("session").is_some_and(|v| v.is_string()) {
        return false;
    }
    if !obj.get("to").is_some_and(|v| v.is_object()) {
        return false;
    }
    for field in ["clientId", "replyTo", "kind", "run"] {
        if let Some(val) = obj.get(field)
            && !val.is_null()
            && !val.is_string()
        {
            return false;
        }
    }
    true
}

/// Resolve a path like Python's `Path.resolve(strict=False)`, canonicalizing existing
/// ancestors and normalizing any trailing nonexistent components.
pub fn resolve_path(path: &Path) -> io::Result<PathBuf> {
    let abs = if path.is_absolute() {
        path.to_path_buf()
    } else {
        env::current_dir()?.join(path)
    };
    if let Ok(canon) = fs::canonicalize(&abs) {
        return Ok(canon);
    }
    let mut resolved = PathBuf::new();
    let mut hit_missing = false;
    for comp in abs.components() {
        match comp {
            Component::Prefix(p) => resolved.push(p.as_os_str()),
            Component::RootDir => resolved.push(Component::RootDir.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                resolved.pop();
                if !hit_missing && let Ok(canon) = fs::canonicalize(&resolved) {
                    resolved = canon;
                }
            }
            Component::Normal(part) => {
                resolved.push(part);
                if !hit_missing {
                    match fs::canonicalize(&resolved) {
                        Ok(canon) => resolved = canon,
                        Err(_) => hit_missing = true,
                    }
                }
            }
        }
    }
    Ok(resolved)
}

/// Current UTC time as whole seconds since the Unix epoch.
#[must_use]
pub fn utc_now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = y - i64::from(m <= 2);
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    let y = y + i64::from(m <= 2);
    (y, m as u32, d as u32)
}

/// Format Unix epoch seconds as `YYYY-MM-DDTHH:MM:SSZ` matching `mailbox_store.stamp()`.
#[must_use]
pub fn format_utc_iso_z(epoch_secs: i64) -> String {
    let days = epoch_secs.div_euclid(86_400);
    let secs_of_day = epoch_secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = secs_of_day / 3600;
    let minute = (secs_of_day % 3600) / 60;
    let second = secs_of_day % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

fn is_leap_year(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || (y % 400 == 0)
}

fn days_in_month(y: i64, m: u32) -> u32 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if is_leap_year(y) {
                29
            } else {
                28
            }
        }
        _ => 0,
    }
}

/// Parse an ISO-8601 timestamp (`YYYY-MM-DDTHH:MM:SS[.frac][Z|+HH:MM|-HH:MM]`) into UTC epoch seconds.
#[must_use]
pub fn parse_iso8601_utc_secs(s: &str) -> Option<i64> {
    if !s.is_ascii() {
        return None;
    }
    let b = s.as_bytes();
    if b.len() < 19
        || b[4] != b'-'
        || b[7] != b'-'
        || (b[10] != b'T' && b[10] != b't' && b[10] != b' ')
        || b[13] != b':'
        || b[16] != b':'
    {
        return None;
    }
    let year: i64 = s.get(0..4)?.parse().ok()?;
    let month: u32 = s.get(5..7)?.parse().ok()?;
    let day: u32 = s.get(8..10)?.parse().ok()?;
    let hour: i64 = s.get(11..13)?.parse().ok()?;
    let minute: i64 = s.get(14..16)?.parse().ok()?;
    let second: i64 = s.get(17..19)?.parse().ok()?;

    if !(1..=12).contains(&month)
        || day == 0
        || day > days_in_month(year, month)
        || !(0..=23).contains(&hour)
        || !(0..=59).contains(&minute)
        || !(0..=59).contains(&second)
    {
        return None;
    }

    let mut rest = &s[19..];
    if let Some(after_dot) = rest.strip_prefix('.') {
        let frac_len = after_dot.bytes().take_while(|c| c.is_ascii_digit()).count();
        if frac_len == 0 {
            return None;
        }
        rest = &after_dot[frac_len..];
    }

    let tz_offset: i64 = if rest.is_empty() || rest == "Z" || rest == "z" {
        0
    } else if let Some(sign_char) = rest.chars().next()
        && (sign_char == '+' || sign_char == '-')
    {
        let sign = if sign_char == '+' { 1 } else { -1 };
        let tz = &rest[1..];
        let (tz_h, tz_m): (i64, i64) = if tz.len() == 5 && &tz[2..3] == ":" {
            (tz[0..2].parse().ok()?, tz[3..5].parse().ok()?)
        } else if tz.len() == 4 {
            (tz[0..2].parse().ok()?, tz[2..4].parse().ok()?)
        } else if tz.len() == 2 {
            (tz[0..2].parse().ok()?, 0)
        } else {
            return None;
        };
        if !(0..=23).contains(&tz_h) || !(0..=59).contains(&tz_m) {
            return None;
        }
        sign * (tz_h * 3600 + tz_m * 60)
    } else {
        return None;
    };

    let days = days_from_civil(year, i64::from(month), i64::from(day));
    Some(days * 86_400 + hour * 3600 + minute * 60 + second - tz_offset)
}

/// Validate a peer JSON object matching `mailbox_store.py::valid_peer`.
#[must_use]
pub fn valid_peer(peer: &serde_json::Value) -> bool {
    let Some(obj) = peer.as_object() else {
        return false;
    };
    if obj.get("schema").and_then(|v| v.as_str()) != Some("agent-executor.peer.v1") {
        return false;
    }
    for field in ["session", "name", "harness", "cwd"] {
        if !obj.get(field).is_some_and(|v| v.is_string()) {
            return false;
        }
    }
    let started_ok = obj
        .get("startedAt")
        .and_then(|v| v.as_str())
        .is_some_and(|s| parse_iso8601_utc_secs(s).is_some());
    let seen_ok = obj
        .get("lastSeenAt")
        .and_then(|v| v.as_str())
        .is_some_and(|s| parse_iso8601_utc_secs(s).is_some());
    started_ok && seen_ok
}

/// Schema of `<base>/rooms-index.json`, written by `horde-room.mjs` after every room commit.
pub const ROOMS_INDEX_SCHEMA: &str = "orkest.rooms-index.v1";

fn status_is_closed(status: Option<&serde_json::Value>) -> bool {
    let status = status
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    matches!(
        status.as_str(),
        "closed" | "archived" | "completed" | "cancelled"
    )
}

fn room_is_closed(room: &serde_json::Value) -> bool {
    if room
        .get("closed")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
    {
        return true;
    }
    if room.get("closedAt").is_some_and(|v| !v.is_null()) {
        return true;
    }
    if let Some(lifecycle) = room.get("lifecycle").and_then(|v| v.as_str())
        && matches!(
            lifecycle.to_ascii_lowercase().as_str(),
            "archived" | "cancelled"
        )
    {
        return true;
    }
    status_is_closed(room.get("status"))
}

/// `Some(answer)` from a valid rooms index, `None` when it is missing or unreadable.
fn index_has_active_session(base: &Path, session: &str) -> Option<bool> {
    let content = fs::read_to_string(base.join("rooms-index.json")).ok()?;
    let index: serde_json::Value = serde_json::from_str(&content).ok()?;
    if index.get("schema").and_then(|v| v.as_str()) != Some(ROOMS_INDEX_SCHEMA) {
        return None;
    }
    let rooms = index.get("rooms")?.as_array()?;
    for room in rooms {
        if room_is_closed(room) {
            continue;
        }
        let Some(sessions) = room.get("sessions").and_then(|v| v.as_array()) else {
            // A malformed entry cannot prove the session is absent.
            return None;
        };
        if sessions.iter().any(|value| value.as_str() == Some(session)) {
            return Some(true);
        }
    }
    Some(false)
}

/// Legacy `<base>/rooms/*.json` records not yet imported into `rooms.db`.
/// Returns `true` if a legacy open room may reference `session` or if legacy room status is unreadable/unknown.
fn legacy_room_references_session(base: &Path, session: &str) -> bool {
    let rooms_dir = base.join("rooms");
    match fs::symlink_metadata(&rooms_dir) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => return false,
        Err(_) => return true,
        Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir() => return true,
        Ok(_) => {}
    }
    let Ok(entries) = fs::read_dir(&rooms_dir) else {
        return true;
    };
    for entry_res in entries {
        let Ok(entry) = entry_res else {
            return true;
        };
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(meta) = fs::symlink_metadata(&p) else {
            return true;
        };
        if meta.file_type().is_symlink() || !meta.is_file() {
            return true;
        }
        let Ok(content) = fs::read_to_string(&p) else {
            return true;
        };
        let Ok(val) = serde_json::from_str::<serde_json::Value>(&content) else {
            return true;
        };
        if !val.is_object() {
            return true;
        }
        if !room_is_closed(&val) && content.contains(session) {
            return true;
        }
    }
    false
}

/// Return true if a team record under `<cache>/authority-v1/*/authority.json` gives `session` a role the
/// Python hook acts on (`mailbox_hooks.succession_notice`, `handoff.find_team`): the lead of an active or
/// pending team, an active planned handover offeree (`offer.to.session`), or the deputy of an active team,
/// named by session or (when no session is named) by harness, since the deputy's account and repository are
/// only known to Python. A record that is unreadable or of another schema is skipped, as `authority.load`
/// refuses it there.
#[must_use]
pub fn has_active_authority_for_session(cache: &Path, session: &str, harness: &str) -> bool {
    let Ok(entries) = fs::read_dir(cache.join("authority-v1")) else {
        return false;
    };
    for entry in entries.flatten() {
        let Ok(content) = fs::read_to_string(entry.path().join("authority.json")) else {
            continue;
        };
        let Ok(record) = serde_json::from_str::<serde_json::Value>(&content) else {
            continue;
        };
        if record.get("schema").and_then(|v| v.as_str()) != Some("orchestrate.authority.v1") {
            continue;
        }
        let status = record.get("status").and_then(|v| v.as_str()).unwrap_or("");
        let lead = record
            .get("lead")
            .and_then(|v| v.get("session"))
            .and_then(|v| v.as_str());
        if lead == Some(session) && matches!(status, "active" | "pending") {
            return true;
        }
        if status != "active" {
            continue;
        }
        if record
            .get("offer")
            .and_then(|o| o.get("to"))
            .and_then(|t| t.get("session"))
            .and_then(serde_json::Value::as_str)
            == Some(session)
        {
            return true;
        }
        let Some(deputy) = record.get("deputy").and_then(|v| v.as_object()) else {
            continue;
        };
        match deputy.get("session").and_then(|v| v.as_str()) {
            Some(named) if !named.is_empty() => {
                if named == session {
                    return true;
                }
            }
            _ => {
                if deputy.get("harness").and_then(|v| v.as_str()) == Some(harness)
                    && deputy
                        .get("account")
                        .and_then(|v| v.as_str())
                        .is_some_and(|a| !a.is_empty())
                {
                    return true;
                }
            }
        }
    }
    false
}

/// Return true if an open room may reference `session`, so the hook must take the full path.
///
/// Reads the rooms index first. Unimported legacy room files still count. When `rooms.db`
/// exists without a valid index, the answer is unknown and therefore conservatively true.
#[must_use]
pub fn has_active_room_for_session(base: &Path, session: &str) -> bool {
    if legacy_room_references_session(base, session) {
        return true;
    }
    if let Some(active) = crate::sqlite::room_hook_hint(base, session) {
        return active;
    }
    match index_has_active_session(base, session) {
        Some(found) => found,
        None => !matches!(
            fs::symlink_metadata(base.join("rooms.db")),
            Err(ref e) if e.kind() == io::ErrorKind::NotFound
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_session_key() {
        assert_eq!(session_key("session-123").unwrap(), "session-123");
        assert_eq!(session_key("session:123").unwrap(), "session%3A123");
        // Upper case gets SHA-1 trailer
        let with_upper = session_key("Session123").unwrap();
        assert!(with_upper.starts_with("Session123~"));
        assert_eq!(with_upper.len(), "Session123~".len() + 10);
    }

    #[test]
    fn test_expand_home() {
        let fake_home = Path::new("/custom/home");
        assert_eq!(expand_home("~", Some(fake_home)), fake_home);
        assert_eq!(
            expand_home("~/dir/file", Some(fake_home)),
            fake_home.join("dir/file")
        );
        assert_eq!(
            expand_home("/absolute/path", Some(fake_home)),
            PathBuf::from("/absolute/path")
        );
    }

    #[test]
    fn test_cache_and_config_paths() {
        let fake_home = Path::new("/fake/home");
        let mut map = HashMap::new();
        map.insert("ORCHESTRATE_HOME".to_string(), "~/custom-cache".to_string());
        map.insert(
            "ORCHESTRATE_CONFIG".to_string(),
            "~/custom-cfg/cfg.json".to_string(),
        );

        let cache = cache_home(Some(&map), Some(fake_home));
        assert_eq!(cache, fake_home.join("custom-cache"));

        let cfg_dir = config_home(Some(&map), Some(fake_home));
        assert_eq!(cfg_dir, fake_home.join("custom-cfg"));

        let cfg_file = config_path(Some(&map), Some(fake_home));
        assert_eq!(cfg_file, fake_home.join("custom-cfg/cfg.json"));

        let bin = ork_fast_bin(Some(&map), Some(fake_home));
        assert_eq!(bin, fake_home.join("custom-cache/bin/ork-fast"));

        map.insert("ORK_DISABLE_FAST".to_string(), "1".to_string());
        assert_eq!(
            ork_fast_bin(Some(&map), Some(fake_home)),
            fake_home.join("custom-cache/bin/ork-fast")
        );
    }

    #[test]
    fn test_iso8601_roundtrip_and_parse() {
        assert_eq!(format_utc_iso_z(0), "1970-01-01T00:00:00Z");
        assert_eq!(format_utc_iso_z(1_709_209_496), "2024-02-29T12:24:56Z");
        assert_eq!(parse_iso8601_utc_secs("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(
            parse_iso8601_utc_secs("2024-02-29T12:24:56Z"),
            Some(1_709_209_496)
        );
        assert_eq!(
            parse_iso8601_utc_secs("2024-02-29T14:24:56.123456+02:00"),
            Some(1_709_209_496)
        );
        assert_eq!(parse_iso8601_utc_secs("not-a-timestamp"), None);
    }

    #[test]
    fn test_resolve_path_nonexistent_leaf() {
        let dir = env::temp_dir().join(format!("ork-fast-resolve-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let canonical_dir = fs::canonicalize(&dir).unwrap();

        let missing = dir
            .join("missing-a")
            .join("missing-b")
            .join("..")
            .join("leaf");
        assert_eq!(
            resolve_path(&missing).unwrap(),
            canonical_dir.join("missing-a").join("leaf")
        );
        let _ = fs::remove_dir_all(&dir);
    }
    #[test]
    fn test_has_active_authority_for_session() {
        let cache = env::temp_dir().join(format!("ork-fast-authority-{}", std::process::id()));
        let _ = fs::remove_dir_all(&cache);
        assert!(!has_active_authority_for_session(&cache, "lead", "claude"));
        let write = |team: &str, record: &serde_json::Value| {
            let dir = cache.join("authority-v1").join(team);
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("authority.json"), record.to_string()).unwrap();
        };
        let schema = "orchestrate.authority.v1";
        write(
            "a",
            &serde_json::json!({"schema": schema, "status": "active", "lead": {"session": "lead"},
                "deputy": {"session": "dep", "harness": "codex", "account": "codex"}}),
        );
        write(
            "b",
            &serde_json::json!({"schema": schema, "status": "pending", "lead": {"session": "next"},
                "deputy": {"session": "pending-dep"}}),
        );
        write(
            "c",
            &serde_json::json!({"schema": schema, "status": "active", "lead": {"session": "other"},
                "deputy": {"harness": "gemini", "account": "agy"}}),
        );
        write(
            "d",
            &serde_json::json!({"schema": "other", "status": "active", "lead": {"session": "wrong"}}),
        );
        write(
            "f",
            &serde_json::json!({"schema": schema, "status": "active", "lead": {"session": "lead-f"},
                "offer": {"to": {"session": "offeree-only", "harness": "claude"}}}),
        );
        write(
            "g",
            &serde_json::json!({"schema": schema, "status": "pending", "lead": {"session": "lead-g"},
                "offer": {"to": {"session": "pending-offeree", "harness": "claude"}}}),
        );
        fs::create_dir_all(cache.join("authority-v1").join("e")).unwrap();
        fs::write(cache.join("authority-v1/e/authority.json"), "{not json").unwrap();
        assert!(has_active_authority_for_session(&cache, "lead", "claude"));
        assert!(has_active_authority_for_session(&cache, "dep", "claude"));
        assert!(has_active_authority_for_session(&cache, "next", "claude"));
        assert!(!has_active_authority_for_session(
            &cache,
            "pending-dep",
            "claude"
        ));
        assert!(has_active_authority_for_session(
            &cache,
            "offeree-only",
            "claude"
        ));
        assert!(!has_active_authority_for_session(
            &cache,
            "pending-offeree",
            "claude"
        ));
        assert!(has_active_authority_for_session(&cache, "anyone", "gemini"));
        assert!(!has_active_authority_for_session(
            &cache, "anyone", "claude"
        ));
        assert!(!has_active_authority_for_session(&cache, "wrong", "claude"));
        let _ = fs::remove_dir_all(&cache);
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = env::temp_dir().join(format!("ork-fast-rooms-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn test_rooms_index_answers_for_sqlite_store() {
        let dir = scratch("index");
        let db = rusqlite::Connection::open(dir.join("rooms.db")).unwrap();
        db.pragma_update(None, "application_id", crate::sqlite::ROOMS_APPLICATION_ID)
            .unwrap();
        db.pragma_update(None, "user_version", 2).unwrap();
        drop(db);
        fs::write(
            dir.join("rooms-index.json"),
            r#"{"schema":"orkest.rooms-index.v1","rooms":[
              {"id":"open","closed":false,"sessions":["session-open"]},
              {"id":"done","closed":true,"sessions":["session-closed"]},
              {"id":"arch","closed":false,"lifecycle":"archived","sessions":["session-archived"]},
              {"id":"canc-lc","closed":false,"lifecycle":"cancelled","sessions":["session-cancelled-lc"]},
              {"id":"canc-st","closed":false,"status":"cancelled","sessions":["session-cancelled-st"]}]}"#,
        )
        .unwrap();
        assert!(has_active_room_for_session(&dir, "session-open"));
        assert!(!has_active_room_for_session(&dir, "session-closed"));
        assert!(!has_active_room_for_session(&dir, "session-archived"));
        assert!(!has_active_room_for_session(&dir, "session-cancelled-lc"));
        assert!(!has_active_room_for_session(&dir, "session-cancelled-st"));
        assert!(!has_active_room_for_session(&dir, "session-other"));
        assert!(!has_active_room_for_session(&dir, "session"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_outbox_room_hint_uses_the_committed_projection() {
        let dir = scratch("transactional-hint");
        let db = rusqlite::Connection::open(dir.join("rooms.db")).unwrap();
        db.pragma_update(None, "application_id", crate::sqlite::ROOMS_APPLICATION_ID)
            .unwrap();
        db.pragma_update(None, "user_version", crate::sqlite::ROOMS_SCHEMA_VERSION)
            .unwrap();
        db.execute_batch("CREATE TABLE outbox_room_hints(room TEXT,session TEXT); INSERT INTO outbox_room_hints VALUES('room','current');").unwrap();
        fs::write(dir.join("rooms-index.json"), r#"{"schema":"orkest.rooms-index.v1","rooms":[{"id":"old","closed":false,"sessions":["obsolete"]}]}"#).unwrap();
        assert!(has_active_room_for_session(&dir, "current"));
        assert!(!has_active_room_for_session(&dir, "obsolete"));
    }

    #[test]
    fn test_rooms_index_missing_or_invalid_is_conservative() {
        let dir = scratch("conservative");
        assert!(!has_active_room_for_session(&dir, "session-a"));
        fs::write(dir.join("rooms.db"), b"").unwrap();
        assert!(has_active_room_for_session(&dir, "session-a"));
        fs::write(
            dir.join("rooms-index.json"),
            r#"{"schema":"other","rooms":[]}"#,
        )
        .unwrap();
        assert!(has_active_room_for_session(&dir, "session-a"));
        fs::write(
            dir.join("rooms-index.json"),
            r#"{"schema":"orkest.rooms-index.v1","rooms":[{"id":"x","closed":false}]}"#,
        )
        .unwrap();
        assert!(has_active_room_for_session(&dir, "session-a"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_legacy_room_files_still_count() {
        let dir = scratch("legacy");
        fs::create_dir_all(dir.join("rooms")).unwrap();
        fs::write(
            dir.join("rooms/a.json"),
            r#"{"id":"a","conductor":{"session":{"id":"session-legacy"}}}"#,
        )
        .unwrap();
        fs::write(
            dir.join("rooms/b.json"),
            r#"{"id":"b","closedAt":"2026-01-01T00:00:00Z","agents":[{"session":{"id":"session-closed"}}]}"#,
        )
        .unwrap();
        fs::write(
            dir.join("rooms/c.json"),
            r#"{"id":"c","lifecycle":"archived","agents":[{"session":{"id":"session-legacy-arch"}}]}"#,
        )
        .unwrap();
        fs::write(
            dir.join("rooms/d.json"),
            r#"{"id":"d","status":"cancelled","agents":[{"session":{"id":"session-legacy-canc"}}]}"#,
        )
        .unwrap();
        fs::write(
            dir.join("rooms-index.json"),
            r#"{"schema":"orkest.rooms-index.v1","rooms":[]}"#,
        )
        .unwrap();
        assert!(has_active_room_for_session(&dir, "session-legacy"));
        assert!(!has_active_room_for_session(&dir, "session-closed"));
        assert!(!has_active_room_for_session(&dir, "session-legacy-arch"));
        assert!(!has_active_room_for_session(&dir, "session-legacy-canc"));
        // Corrupt legacy JSON is treated conservatively as active/unknown.
        fs::write(dir.join("rooms/corrupt.json"), "{not-json").unwrap();
        assert!(has_active_room_for_session(&dir, "session-closed"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_parse_iso8601_utf8_malformed_timezone_no_panic() {
        assert_eq!(parse_iso8601_utc_secs("2026-01-01T00:00:00+aé:0"), None);
        assert_eq!(parse_iso8601_utc_secs("2026-01-01T00:00:00+aé0"), None);
        assert_eq!(parse_iso8601_utc_secs("2026-01-01T00:00:00+é"), None);
        assert_eq!(parse_iso8601_utc_secs("2026-01-01T00:00:00.éZ"), None);
        assert!(parse_iso8601_utc_secs("2026-01-01T00:00:00+02:30").is_some());
    }

    #[test]
    fn test_lock_path_exclusive_rejects_symlink_and_fifo() {
        use std::ffi::CString;
        use std::os::unix::fs::symlink;

        let dir = scratch("lock-safety");
        let target = dir.join("target.txt");
        fs::write(&target, "keep").unwrap();
        let sym_lock = dir.join("sym.lock");
        symlink(&target, &sym_lock).unwrap();
        assert!(lock_path_exclusive(&sym_lock).is_err());

        let fifo_lock = dir.join("fifo.lock");
        let c_fifo = CString::new(fifo_lock.as_os_str().as_encoded_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(c_fifo.as_ptr(), 0o600) }, 0);
        assert!(lock_path_exclusive(&fifo_lock).is_err());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_read_chief_json_bounded_handles_missing_valid_symlink_fifo_size_and_json() {
        use std::ffi::CString;
        use std::os::unix::fs::symlink;

        let dir = scratch("chief-bounded");
        assert_eq!(read_chief_json_bounded(&dir).unwrap(), None);
        assert_eq!(
            read_chief_json_bounded(&dir.join("missing-dir")).unwrap(),
            None
        );

        let chief_path = dir.join("chief.json");
        write_json_atomic(&chief_path, &serde_json::json!({"session": "c1"})).unwrap();
        let loaded = read_chief_json_bounded(&dir).unwrap().unwrap();
        assert_eq!(loaded["session"], "c1");

        // Oversized (> 256 KiB) -> Err
        let big = format!(r#"{{"pad":"{}"}}"#, "x".repeat(CHIEF_JSON_MAX_BYTES + 16));
        fs::write(&chief_path, big).unwrap();
        assert!(read_chief_json_bounded(&dir).is_err());

        // Invalid JSON -> Err
        fs::write(&chief_path, "{corrupt").unwrap();
        assert!(read_chief_json_bounded(&dir).is_err());

        // Symlink -> Err
        let outside = dir.join("outside.json");
        fs::write(&outside, r#"{"session":"outside"}"#).unwrap();
        fs::remove_file(&chief_path).unwrap();
        symlink(&outside, &chief_path).unwrap();
        assert!(read_chief_json_bounded(&dir).is_err());

        // FIFO -> Err without blocking
        fs::remove_file(&chief_path).unwrap();
        let c_fifo = CString::new(chief_path.as_os_str().as_encoded_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(c_fifo.as_ptr(), 0o600) }, 0);
        assert!(read_chief_json_bounded(&dir).is_err());

        let _ = fs::remove_dir_all(&dir);
    }
}
