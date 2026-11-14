//! POSIX workspace lease holder with flock, matching execution_support.py & lease_holder.py.

use std::collections::BTreeSet;
use std::env;
use std::ffi::CString;
use std::fs;
use std::io::{self, Read, Write};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use crate::paths;
use crate::sha256;

/// Resolve lease roots preserving any nested namespace.
#[must_use]
pub fn lease_roots(cache: &Path) -> Vec<PathBuf> {
    let cache = fs::canonicalize(cache).unwrap_or_else(|_| cache.to_path_buf());
    let mut roots = BTreeSet::new();
    roots.insert(cache.clone());

    if env::var("ORCHESTRATE_HOME").is_err() && env::var("AGENT_EXECUTOR_HOME").is_err() {
        let mut curr: Option<&Path> = Some(&cache);
        while let Some(base) = curr {
            if let Some(name) = base.file_name().and_then(|n| n.to_str())
                && (name == "orchestrate" || name == "agent-executor")
            {
                let other_name = if name == "orchestrate" {
                    "agent-executor"
                } else {
                    "orchestrate"
                };
                if let Some(parent) = base.parent() {
                    let other = parent.join(other_name);
                    if other.join("worktree-locks-v1").is_dir()
                        && let Ok(rel) = cache.strip_prefix(base)
                    {
                        let candidate = other.join(rel);
                        roots.insert(fs::canonicalize(&candidate).unwrap_or(candidate));
                    }
                }
                break;
            }
            curr = base.parent();
        }
    }
    roots.into_iter().collect()
}

/// Run the lease-holder command.
pub fn run(path: &Path, read_only: bool, namespace: Option<&str>) -> io::Result<()> {
    if let Some(ns) = namespace
        && (ns == "."
            || ns == ".."
            || ns.contains('/')
            || ns.contains('\\')
            || Path::new(ns).file_name().and_then(|f| f.to_str()) != Some(ns))
    {
        eprintln!("error: namespace must be a single directory name");
        std::process::exit(2);
    }

    let mut cache = paths::cache_home(None, None);
    if let Some(ns) = namespace {
        cache.push(ns);
    }

    let repository = match fs::canonicalize(path) {
        Ok(canon) => canon,
        Err(err) => {
            let msg = serde_json::json!({
                "status": "busy",
                "detail": format!("failed to resolve repository {}: {err}", path.display())
            });
            println!("{msg}");
            io::stdout().flush()?;
            return Ok(());
        }
    };

    let key = sha256::sha256_hex(repository.as_os_str().as_bytes());
    let roots = lease_roots(&cache);

    let mut open_fds = Vec::new();

    for root in roots {
        let directory = root.join("worktree-locks-v1");
        if directory == repository || directory.starts_with(&repository) {
            let msg = serde_json::json!({
                "status": "busy",
                "detail": "the executor cache must be outside the repository"
            });
            println!("{msg}");
            io::stdout().flush()?;
            return Ok(());
        }

        let _ = fs::create_dir_all(&directory);
        let _ = fs::set_permissions(&directory, fs::Permissions::from_mode(0o700));

        let lock_path = directory.join(format!("{key}.lock"));
        let c_path = match CString::new(lock_path.as_os_str().as_bytes()) {
            Ok(c) => c,
            Err(err) => {
                let msg = serde_json::json!({
                    "status": "busy",
                    "detail": format!("invalid lock file path: {err}")
                });
                println!("{msg}");
                io::stdout().flush()?;
                return Ok(());
            }
        };

        let fd = unsafe { libc::open(c_path.as_ptr(), libc::O_CREAT | libc::O_RDWR, 0o600) };
        if fd < 0 {
            let err = io::Error::last_os_error();
            let msg = serde_json::json!({
                "status": "busy",
                "detail": format!("cannot open lock file: {err}")
            });
            println!("{msg}");
            io::stdout().flush()?;
            return Ok(());
        }
        open_fds.push(fd);

        let op = if read_only {
            libc::LOCK_SH
        } else {
            libc::LOCK_EX
        } | libc::LOCK_NB;
        let res = unsafe { libc::flock(fd, op) };
        if res != 0 {
            let errno = io::Error::last_os_error().raw_os_error().unwrap_or(0);
            if errno == libc::EWOULDBLOCK || errno == libc::EAGAIN {
                let msg = serde_json::json!({
                    "status": "busy",
                    "detail": format!("another executor owns the worktree: {}", repository.display())
                });
                println!("{msg}");
                io::stdout().flush()?;
                for &f in &open_fds {
                    unsafe { libc::close(f) };
                }
                return Ok(());
            }
            let err = io::Error::last_os_error();
            let msg = serde_json::json!({
                "status": "busy",
                "detail": format!("flock failed: {err}")
            });
            println!("{msg}");
            io::stdout().flush()?;
            for &f in &open_fds {
                unsafe { libc::close(f) };
            }
            return Ok(());
        }
    }

    // All acquired!
    let acquired = serde_json::json!({
        "status": "acquired",
        "pid": std::process::id()
    });
    println!("{acquired}");
    io::stdout().flush()?;

    // Wait until stdin is closed
    let mut stdin = io::stdin();
    let mut buf = [0u8; 65536];
    loop {
        match stdin.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
    }

    // Process exits, kernel closes fds and releases flocks without unlinking.
    Ok(())
}
