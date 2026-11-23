//! Turn-start quota line for coordinators and leads, read from monitor's cache.
//!
//! The per-account text mirrors `renderLine` in `src/lib/monitor/render.mjs`: every window named, its
//! reset time, and the age of the oldest reading. Both are checked against
//! `tests/crates/ork-fast/fixtures/quota-line.json`. Reading two small files keeps the hook fast; data past
//! monitor's max age starts a background refresh instead of blocking the turn.

use std::env;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;

use crate::paths;

const EXHAUSTED_PCT: f64 = 0.5;
const DAY_MINS: f64 = 1440.0;
const HOUR_MS: f64 = 3_600_000.0;
const WEEK_MS: i64 = 7 * 24 * 3_600_000;
const DEFAULT_MAX_AGE_SECS: i64 = 180;
// Monitor's own threshold for stale lanes: older numbers are not shown at all.
const SHOWN_MAX_AGE_MS: i64 = 3_600_000;
const WEEKDAYS: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

struct Window {
    id: String,
    mins: Option<f64>,
    pct: f64,
    resets_at: Option<i64>,
}

struct Gauge {
    mins: Option<f64>,
    pct: f64,
    resets_at: Option<i64>,
    expiring: bool,
}

fn number(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64).filter(|n| n.is_finite())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

/// Windows as monitor uses them: a passed reset keeps the reading but no longer has a reset time.
fn windows(account: &Value, now: i64) -> Vec<Window> {
    account
        .get("windows")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|w| {
                    Some(Window {
                        id: w.get("id")?.as_str()?.to_string(),
                        mins: number(w.get("windowMins")),
                        pct: number(w.get("remainingPct"))?,
                        resets_at: number(w.get("resetsAt"))
                            .map(|r| r as i64)
                            .filter(|r| *r > now),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Pools that are not a per-model sub-limit of another pool (`independentPools` in analyze.mjs).
fn independent_pools(account: &Value) -> Vec<(String, String, Vec<String>)> {
    let pools: Vec<(String, String, Vec<String>)> = account
        .get("pools")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|p| {
                    let ids: Vec<String> = p
                        .get("windowIds")?
                        .as_array()?
                        .iter()
                        .filter_map(|id| id.as_str().map(str::to_string))
                        .collect();
                    let id = p
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    let label = p
                        .get("label")
                        .and_then(Value::as_str)
                        .map_or_else(|| id.clone(), str::to_string);
                    (!ids.is_empty()).then_some((id, label, ids))
                })
                .collect()
        })
        .unwrap_or_default();
    pools
        .iter()
        .enumerate()
        .filter(|(i, (_, _, ids))| {
            !pools.iter().enumerate().any(|(j, (_, _, other))| {
                j != *i && other.len() < ids.len() && other.iter().all(|id| ids.contains(id))
            })
        })
        .map(|(_, pool)| pool.clone())
        .collect()
}

fn is_expiring(w: &Window, now: i64) -> bool {
    let (Some(resets_at), Some(mins)) = (w.resets_at, w.mins) else {
        return false;
    };
    if mins < DAY_MINS || w.pct < 5.0 {
        return false;
    }
    let hours_left = (resets_at - now) as f64 / HOUR_MS;
    hours_left > 0.0 && hours_left <= (mins / 60.0) * 0.2
}

fn gauge(w: &Window, now: i64) -> Gauge {
    Gauge {
        mins: w.mins,
        pct: w.pct,
        resets_at: w.resets_at,
        expiring: is_expiring(w, now),
    }
}

/// "5h", "wk", "1d", "30d" (`durationLabel` in analyze.mjs).
fn duration_label(mins: Option<f64>) -> String {
    let Some(mins) = mins.filter(|m| *m > 0.0) else {
        return "limit".to_string();
    };
    if (mins - 10_080.0).abs() < f64::EPSILON {
        return "wk".to_string();
    }
    if mins % 1440.0 == 0.0 {
        return format!("{}d", mins / 1440.0);
    }
    if mins % 60.0 == 0.0 {
        return format!("{}h", mins / 60.0);
    }
    format!("{mins}m")
}

unsafe extern "C" {
    // POSIX; the libc crate does not bind it. localtime_r alone may keep a time zone read earlier.
    fn tzset();
}

/// Local calendar fields of a UTC millisecond instant.
fn local_tm(ms: i64) -> Option<libc::tm> {
    let secs = libc::time_t::try_from(ms.div_euclid(1000)).ok()?;
    // SAFETY: tzset reads TZ; localtime_r writes into the zeroed struct we own and reads only `secs`.
    unsafe {
        let mut tm: libc::tm = std::mem::zeroed();
        tzset();
        (!libc::localtime_r(&raw const secs, &raw mut tm).is_null()).then_some(tm)
    }
}

/// "3:10pm" today, "Thu 9:00am" within a week, "Nov 30" after that (`resetClock` in render.mjs).
fn reset_clock(ms: i64, now: i64) -> String {
    let (Some(at), Some(today)) = (local_tm(ms), local_tm(now)) else {
        return String::new();
    };
    let hour = at.tm_hour;
    let time = format!(
        "{}:{:02}{}",
        if hour % 12 == 0 { 12 } else { hour % 12 },
        at.tm_min,
        if hour < 12 { "am" } else { "pm" }
    );
    if at.tm_year == today.tm_year && at.tm_yday == today.tm_yday {
        return time;
    }
    let weekday = usize::try_from(at.tm_wday).unwrap_or(0) % 7;
    if ms > now && ms - now < WEEK_MS {
        return format!("{} {time}", WEEKDAYS[weekday]);
    }
    let month = usize::try_from(at.tm_mon).unwrap_or(0) % 12;
    format!("{} {}", MONTHS[month], at.tm_mday)
}

/// "0m", "12m", "3h", "2d" (`dataAge` in render.mjs).
fn data_age(ms: i64) -> String {
    let minutes = ms.max(0) / 60_000;
    if minutes < 60 {
        return format!("{minutes}m");
    }
    let hours = minutes / 60;
    if hours < 48 {
        format!("{hours}h")
    } else {
        format!("{}d", hours / 24)
    }
}

fn gauge_text(g: &Gauge, now: i64) -> String {
    let value = if g.pct <= EXHAUSTED_PCT {
        "☠".to_string()
    } else {
        format!("{}%", g.pct.floor() as i64)
    };
    let reset = g
        .resets_at
        .map(|r| format!(" (↻{})", reset_clock(r, now)))
        .unwrap_or_default();
    format!(
        "{} {value}{}{reset}",
        duration_label(g.mins),
        if g.expiring { "⏳" } else { "" }
    )
}

/// Codex's credit balance as monitor prints it: "62,261.91 cr", "<0.01 cr", "∞ cr".
fn credit_text(credits: &Value) -> Option<String> {
    let unlimited = credits.get("unlimited").is_some_and(paths::is_truthy_json);
    if unlimited {
        return Some("∞ cr".to_string());
    }
    let balance = number(credits.get("balance"))?;
    if balance > 0.0 && balance < 0.01 {
        return Some("<0.01 cr".to_string());
    }
    let fixed = format!("{:.10}", balance.abs());
    let (whole, fraction) = fixed.split_once('.').unwrap_or((&fixed, ""));
    let cents = fraction.get(..2).unwrap_or("").trim_end_matches('0');
    let mut grouped = String::new();
    for (i, c) in whole.chars().enumerate() {
        if i > 0 && (whole.len() - i) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(c);
    }
    let sign = if balance < 0.0 && (whole != "0" || !cents.is_empty()) {
        "-"
    } else {
        ""
    };
    let decimals = if cents.is_empty() {
        String::new()
    } else {
        format!(".{cents}")
    };
    Some(format!("{sign}{grouped}{decimals} cr"))
}

/// One account with every window named (`labeledAccountText` in render.mjs).
fn account_text(label: &str, account: &Value, now: i64) -> String {
    let failed = if account.get("ok") == Some(&Value::Bool(false)) {
        " (refresh failed)"
    } else {
        ""
    };
    let all = windows(account, now);
    let pools = if all.is_empty() {
        Vec::new()
    } else {
        independent_pools(account)
    };
    let tagged = pools.len() > 1;
    let is_codex = account.get("provider").and_then(Value::as_str) == Some("codex");
    let mut parts = Vec::new();
    for (pool_id, pool_label, ids) in &pools {
        let ws: Vec<&Window> = ids
            .iter()
            .filter_map(|id| all.iter().find(|w| &w.id == id))
            .collect();
        let short = ws
            .iter()
            .find(|w| w.mins.unwrap_or(f64::INFINITY) < DAY_MINS)
            .map(|w| gauge(w, now));
        let long = ws
            .iter()
            .filter(|w| w.mins.unwrap_or(0.0) >= DAY_MINS)
            .min_by(|a, b| a.pct.total_cmp(&b.pct))
            .map(|w| gauge(w, now));
        let long_exhausted = long.as_ref().is_some_and(|g| g.pct <= EXHAUSTED_PCT);
        let credits = (long_exhausted && is_codex && pool_id == "codex")
            .then(|| account.get("credits").and_then(credit_text))
            .flatten();
        let text = match (&long, credits) {
            (Some(week), Some(credit)) => {
                format!("{}, on credits {credit}", gauge_text(week, now))
            }
            (Some(week), None) if long_exhausted => gauge_text(week, now),
            _ => [short.as_ref(), long.as_ref()]
                .into_iter()
                .flatten()
                .map(|g| gauge_text(g, now))
                .collect::<Vec<_>>()
                .join(" · "),
        };
        parts.push(if tagged {
            format!("{pool_label} {text}")
        } else {
            text
        });
    }
    if parts.is_empty() {
        return format!("{label} no data{failed}");
    }
    format!("{label} {}{failed}", parts.join(", "))
}

/// Accounts joined as `renderLine` joins them, with the age of the oldest reading.
fn labeled_line(accounts: &[(String, &Value)], now: i64) -> String {
    let body = accounts
        .iter()
        .map(|(label, account)| account_text(label, account, now))
        .collect::<Vec<_>>()
        .join(" | ");
    let oldest = accounts
        .iter()
        .filter_map(|(_, a)| number(a.get("fetchedAt")))
        .map(|f| f as i64)
        .min();
    match oldest {
        Some(fetched) => format!("{body} · data {}", data_age(now - fetched)),
        None => body,
    }
}

fn default_label(id: &str, provider: &str) -> String {
    match provider {
        "claude" => "Claude".to_string(),
        "codex" => "Codex".to_string(),
        "antigravity" => "Antigravity".to_string(),
        _ => id.to_string(),
    }
}

/// The turn-start line, and whether any reading is past monitor's max age.
fn turn_line(snapshot: &Value, config: Option<&Value>, now: i64) -> (String, bool) {
    let Some(entries) = snapshot.get("accounts").and_then(Value::as_object) else {
        return (String::new(), false);
    };
    let max_age_secs = config
        .and_then(|c| number(c.get("maxAgeSeconds")))
        .map_or(DEFAULT_MAX_AGE_SECS, |n| n as i64);
    // Config order and labels when there is a config, as monitor itself lists accounts.
    let configured: Vec<(String, String, Option<f64>)> = match config
        .and_then(|c| c.get("accounts"))
        .and_then(Value::as_array)
    {
        Some(list) => list
            .iter()
            .filter_map(|a| {
                let id = a.get("id")?.as_str()?.to_string();
                let label = a
                    .get("label")
                    .and_then(Value::as_str)
                    .map_or_else(|| id.clone(), str::to_string);
                Some((id, label, number(a.get("minRefreshSeconds"))))
            })
            .collect(),
        None => entries
            .iter()
            .map(|(id, entry)| {
                let provider = entry.get("provider").and_then(Value::as_str).unwrap_or("");
                (id.clone(), default_label(id, provider), None)
            })
            .collect(),
    };
    let mut fresh = Vec::new();
    let mut cached = Vec::new();
    let mut too_old = Vec::new();
    let mut is_past_max_age = false;
    for (id, label, min_refresh) in configured {
        let Some(entry) = entries.get(&id) else {
            continue;
        };
        let Some(fetched) = number(entry.get("fetchedAt")).map(|f| f as i64) else {
            continue;
        };
        let provider = entry.get("provider").and_then(Value::as_str).unwrap_or("");
        // An expensive probe is not repeated more often than its floor (store.mjs MIN_REFRESH_SECONDS).
        let floor = min_refresh.map_or(if provider == "antigravity" { 600 } else { 0 }, |n| {
            n as i64
        });
        let age = now - fetched;
        if age > max_age_secs.max(floor) * 1000 {
            is_past_max_age = true;
        }
        if age > SHOWN_MAX_AGE_MS {
            too_old.push(format!("{label} data {} old", data_age(age)));
        } else if age > max_age_secs.max(floor) * 1000 {
            cached.push((label, entry));
        } else {
            fresh.push((label, entry));
        }
    }
    let is_all_fresh = cached.is_empty();
    let shown: Vec<(String, &Value)> = fresh.into_iter().chain(cached).collect();
    if shown.is_empty() {
        if too_old.is_empty() {
            return (String::new(), false);
        }
        return (
            format!(
                "Quota: monitor's readings are too old to use ({}); a refresh has started. Run ork quota --refresh before choosing workers.",
                too_old.join(", ")
            ),
            true,
        );
    }
    let mut line = labeled_line(&shown, now);
    if !too_old.is_empty() {
        line.push_str(&format!(" | not shown: {}", too_old.join(", ")));
    }
    let prefix = if is_all_fresh {
        "Quota now (read at turn start; never reuse a quota number from an earlier turn)"
    } else {
        "Quota (cached past monitor's max age, refresh started; run ork quota --refresh before assigning)"
    };
    (format!("{prefix}: {line}"), is_past_max_age)
}

fn monitor_cache_dir() -> PathBuf {
    env::var("MONITOR_CACHE_DIR")
        .ok()
        .filter(|s| !s.is_empty())
        .map_or_else(
            || paths::expand_home("~/.cache/monitor", None),
            |s| paths::expand_home(&s, None),
        )
}

fn monitor_config_path() -> PathBuf {
    env::var("MONITOR_CONFIG")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .map_or_else(
            || paths::expand_home("~/.config/monitor/config.json", None),
            |s| paths::expand_home(s.trim(), None),
        )
}

fn monitor_binary() -> PathBuf {
    if let Some(bin) = env::var_os("MONITOR_BIN").filter(|v| !v.is_empty()) {
        return PathBuf::from(bin);
    }
    let local = paths::expand_home("~/.local/bin/monitor", None);
    if local.is_file() {
        local
    } else {
        PathBuf::from("monitor")
    }
}

/// Starts `monitor line` detached so the next turn reads fresh data; never waits for it.
fn start_background_refresh(cache: &Path) {
    let isolated = env::var_os("PYTEST_CURRENT_TEST").is_some_and(|v| !v.is_empty())
        || env::var("ORKEST_TEST_MODE").as_deref() == Ok("1");
    // A refresh already holds monitor's lock; a second one would only wait for it.
    if isolated || cache.join("refresh.lock").exists() {
        return;
    }
    let _ = Command::new(monitor_binary())
        .arg("line")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn();
}

/// One line of current quota for a coordinator turn, or nothing when monitor has no data here.
#[must_use]
pub fn turn_quota_line() -> String {
    let cache = monitor_cache_dir();
    let Some(snapshot) = paths::read_json_file(&cache.join("snapshot.json")) else {
        return String::new();
    };
    let config = paths::read_json_file(&monitor_config_path());
    let (line, is_past_max_age) = turn_line(&snapshot, config.as_ref(), now_ms());
    if is_past_max_age {
        start_background_refresh(&cache);
    }
    line
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mailbox_lifecycle::tests::{EnvGuard, lock_test_env};

    fn fixture() -> Value {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/crates/ork-fast/fixtures/quota-line.json");
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    #[test]
    fn line_matches_the_js_renderer_on_the_shared_fixture() {
        let _lock = lock_test_env();
        let mut env = EnvGuard::new();
        env.set("TZ", "UTC");
        let fx = fixture();
        let now = fx["now"].as_i64().unwrap();
        let (line, is_past_max_age) = turn_line(&fx["snapshot"], Some(&fx["config"]), now);
        let expected = fx["line"].as_str().unwrap();
        assert_eq!(
            line,
            format!(
                "Quota now (read at turn start; never reuse a quota number from an earlier turn): {expected}"
            )
        );
        assert!(!is_past_max_age);
    }

    #[test]
    fn old_readings_are_marked_and_very_old_ones_are_not_shown() {
        let _lock = lock_test_env();
        let mut env = EnvGuard::new();
        env.set("TZ", "UTC");
        let fx = fixture();
        let now = fx["now"].as_i64().unwrap();
        // Ten minutes later Claude and Codex are past the 180 s max age; Antigravity's floor is 600 s.
        let (line, is_past_max_age) =
            turn_line(&fx["snapshot"], Some(&fx["config"]), now + 10 * 60_000);
        assert!(is_past_max_age);
        assert!(line.starts_with("Quota (cached past monitor's max age"));
        assert!(line.ends_with("· data 15m"));
        // Two hours later nothing is usable.
        let (line, _) = turn_line(&fx["snapshot"], Some(&fx["config"]), now + 2 * 3_600_000);
        assert!(
            line.starts_with("Quota: monitor's readings are too old to use (Claude data 2h old")
        );
        assert!(line.contains("ork quota --refresh"));
        // Without a config: snapshot order and provider names.
        let (line, _) = turn_line(&fx["snapshot"], None, now);
        assert!(line.contains("Antigravity Gemini 5h 99%"));
        assert!(line.contains("Claude 5h 18%"));
    }

    #[test]
    fn nothing_without_monitor_data() {
        let _lock = lock_test_env();
        let mut env = EnvGuard::new();
        let dir = crate::mailbox_lifecycle::tests::TestDir::new("ork-fast-quota-line");
        env.set("MONITOR_CACHE_DIR", &dir.path);
        env.set("MONITOR_CONFIG", dir.path.join("config.json"));
        env.set("ORKEST_TEST_MODE", "1");
        assert_eq!(turn_quota_line(), "");
        std::fs::write(dir.path.join("snapshot.json"), "{}").unwrap();
        assert_eq!(turn_quota_line(), "");
        std::fs::write(dir.path.join("snapshot.json"), "not json").unwrap();
        assert_eq!(turn_quota_line(), "");
    }

    #[test]
    fn credit_and_age_text() {
        assert_eq!(
            credit_text(&serde_json::json!({"balance": 62_261.912_9})).as_deref(),
            Some("62,261.91 cr")
        );
        assert_eq!(
            credit_text(&serde_json::json!({"balance": 500})).as_deref(),
            Some("500 cr")
        );
        assert_eq!(
            credit_text(&serde_json::json!({"balance": 0.29})).as_deref(),
            Some("0.29 cr")
        );
        assert_eq!(
            credit_text(&serde_json::json!({"balance": 0.009})).as_deref(),
            Some("<0.01 cr")
        );
        assert_eq!(
            credit_text(&serde_json::json!({"unlimited": true})).as_deref(),
            Some("∞ cr")
        );
        assert_eq!(credit_text(&serde_json::json!({"balance": null})), None);
        assert_eq!(data_age(0), "0m");
        assert_eq!(data_age(61 * 60_000), "1h");
        assert_eq!(data_age(50 * 3_600_000), "2d");
        assert_eq!(duration_label(Some(300.0)), "5h");
        assert_eq!(duration_label(Some(10_080.0)), "wk");
        assert_eq!(duration_label(Some(1440.0)), "1d");
    }
}
