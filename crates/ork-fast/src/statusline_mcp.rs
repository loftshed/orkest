//! Codex custom status line provider: a long-lived stdio MCP server that draws the Orkest agent bar.
//!
//! Codex polls `resources/read` on [`URI`] about once a second with the displayed thread's
//! snapshot. An error or a read over one second stops Codex polling, so every read of our URI
//! answers with a tree: the identity bar, `null` where the private tmux footer already draws it,
//! or a minimal model/state row when the thread is unknown or the lookup runs out of time.

use std::collections::{HashMap, HashSet};
use std::env;
use std::io::{self, BufRead, Write};
use std::os::unix::fs::FileTypeExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::identity;
use crate::paths;
use crate::sqlite;
use crate::statusline;
use crate::terminal;

pub const SERVER_NAME: &str = "orkest-statusline";
pub const TOOL_NAME: &str = "statusline";
pub const URI: &str = "ui://orkest/statusline";
const STATE_KEY: &str = "com.openai/codex-statusline-state";
const PROTOCOL_VERSION: &str = "2025-06-18";
/// A first read waits this long for its lookup, well inside Codex's one-second budget.
const READ_BUDGET: Duration = Duration::from_millis(600);
/// Lookups stop waiting on locked stores here; a late result still fills the cache.
const LOOKUP_BUDGET: Duration = Duration::from_secs(2);
/// A cached tree at least this old is served once more while a worker refreshes it.
const REFRESH_AFTER: Duration = Duration::from_millis(500);
/// Trees for threads nobody has polled for this long are dropped.
const CACHE_LIFETIME: Duration = Duration::from_secs(300);
/// Codex reports no terminal width; parts shrink to this and Codex wraps the rest.
const DEFAULT_WIDTH: usize = 200;
const SWATCH_TEXT_COLOR: u32 = 232;

/// The `#RRGGBB` form of an xterm-256 color index.
fn xterm_hex(index: u32) -> String {
    const BASIC: [u32; 16] = [
        0x000000, 0x800000, 0x008000, 0x808000, 0x000080, 0x800080, 0x008080, 0xc0c0c0, 0x808080,
        0xff0000, 0x00ff00, 0xffff00, 0x0000ff, 0xff00ff, 0x00ffff, 0xffffff,
    ];
    const LEVELS: [u32; 6] = [0, 95, 135, 175, 215, 255];
    let rgb = match index {
        0..=15 => BASIC[index as usize],
        16..=231 => {
            let i = index - 16;
            (LEVELS[(i / 36) as usize] << 16)
                | (LEVELS[(i / 6 % 6) as usize] << 8)
                | LEVELS[(i % 6) as usize]
        }
        232..=255 => {
            let level = 8 + 10 * (index - 232);
            (level << 16) | (level << 8) | level
        }
        _ => 0xffffff,
    };
    format!("#{rgb:06x}")
}

fn str_at<'a>(value: &'a Value, path: &[&str]) -> &'a str {
    path.iter()
        .try_fold(value, |node, key| node.get(key))
        .and_then(Value::as_str)
        .unwrap_or("")
}

fn text_node(text: String, props: Value) -> Value {
    if props.as_object().is_some_and(serde_json::Map::is_empty) {
        json!({"type": "text", "children": [text]})
    } else {
        json!({"type": "text", "props": props, "children": [text]})
    }
}

/// Model and agent state from Codex's own snapshot, for a thread Orkest cannot name.
pub(crate) fn minimal_tree(state: &Value) -> Value {
    let display = str_at(state, &["thread", "model", "display_name"]).trim();
    let mut model = if display.is_empty() {
        "Codex".to_string()
    } else {
        paths::clean_text(display, 80)
    };
    let reasoning = paths::clean_text(str_at(state, &["thread", "model", "reasoning_level"]), 20);
    if !reasoning.is_empty() {
        model = format!("{model} {reasoning}");
    }
    let mut children = vec![text_node(model, json!({"color": "status-model"}))];
    let run_state = paths::clean_text(str_at(state, &["thread", "agent", "state"]), 20);
    if !run_state.is_empty() {
        children.push(text_node(
            run_state,
            json!({"color": "status-state", "italic": true}),
        ));
    }
    json!({"type": "row", "props": {"gap": 1, "wrap": "wrap"}, "children": children})
}

/// The same parts, colors and weights as the `ork-fast statusline` bar, as a Codex UI tree.
pub(crate) fn identity_tree(item: &Value, width: usize, nerd: bool) -> Value {
    let color = item
        .get("color")
        .and_then(Value::as_u64)
        .and_then(|c| u32::try_from(c).ok())
        .unwrap_or(31);
    let name_color = statusline::palette_color(color);
    let stage = item.get("stage").and_then(Value::as_str).unwrap_or("");
    let health = item
        .get("statusHealth")
        .and_then(Value::as_str)
        .unwrap_or("");
    // Codex lays out every row child on its own and drops spaces at the edges of its text, so
    // the swatch pads with no-break spaces and the bar is one inline text that keeps its spaces.
    let (swatch, pad) = if nerd {
        (
            format!("\u{a0}{}\u{a0}\u{a0}", statusline::NERD_AGENT_GLYPH),
            8,
        )
    } else {
        ("\u{a0}\u{a0}".to_string(), 6)
    };
    let swatch = json!({
        "type": "row",
        "props": {"gap": 0, "background": xterm_hex(name_color)},
        "children": [text_node(
            swatch,
            json!({"color": xterm_hex(SWATCH_TEXT_COLOR), "weight": "bold"}),
        )],
    });
    let mut children = Vec::new();
    for (key, text) in statusline::line_parts(item, width.saturating_sub(pad), 0) {
        let mut props = serde_json::Map::new();
        if let Some(c) = statusline::part_color(&key, name_color, stage, health) {
            props.insert("color".to_string(), json!(xterm_hex(c)));
        }
        if statusline::part_bold(&key) {
            props.insert("weight".to_string(), json!("bold"));
        }
        children.push(text_node(text, Value::Object(props)));
    }
    json!({
        "type": "row",
        "props": {"gap": 1, "wrap": "nowrap"},
        "children": [swatch, {"type": "text", "children": children}],
    })
}

fn tmux_socket_exists(server: &str) -> bool {
    let uid = unsafe { libc::getuid() };
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(dir) = env::var("TMUX_TMPDIR")
        && !dir.is_empty()
    {
        roots.push(PathBuf::from(dir));
    }
    roots.push(PathBuf::from("/tmp"));
    roots.push(PathBuf::from("/private/tmp"));
    roots.iter().any(|root| {
        std::fs::symlink_metadata(root.join(format!("tmux-{uid}")).join(server))
            .is_ok_and(|meta| meta.file_type().is_socket())
    })
}

/// Whether the private Orkest tmux footer already draws this thread's identity.
///
/// Codex may serve many panes from one shared app server, so the thread's own peer record
/// decides first: a Herdr pane has no footer, and a recorded private server that is still up
/// has one. The environment check covers a provider started inside the footer's own pane.
pub(crate) fn tmux_footer_draws(peer: Option<&Value>) -> bool {
    let recorded = |key: &str| {
        peer.and_then(|p| p.get(key))
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
    };
    if recorded("herdrPaneId").is_some() {
        return false;
    }
    if terminal::terminal_context(Some("codex")).is_some() {
        return true;
    }
    recorded("terminalServer")
        .is_some_and(|server| terminal::valid_tmux_server(server) && tmux_socket_exists(server))
}

fn bar_width() -> usize {
    env::var("COLUMNS")
        .ok()
        .and_then(|raw| raw.trim().parse::<usize>().ok())
        .filter(|&w| w > 0)
        .unwrap_or(DEFAULT_WIDTH)
        .clamp(32, 1000)
}

fn nerd_glyphs() -> bool {
    env::var("ORK_GLYPHS")
        .unwrap_or_else(|_| "nerd".to_string())
        .trim()
        .eq_ignore_ascii_case("nerd")
}

/// The tree for one snapshot: identity bar, `null` under the tmux footer, or the minimal row.
pub(crate) fn render_tree(base: &Path, state: &Value) -> Value {
    let thread_id = str_at(state, &["thread", "id"]).trim();
    if thread_id.is_empty() || paths::session_key(thread_id).is_err() {
        return if tmux_footer_draws(None) {
            Value::Null
        } else {
            minimal_tree(state)
        };
    }
    let peer = identity::session_peer(base, thread_id, Some("codex"), None, true);
    if tmux_footer_draws(peer.as_ref()) {
        return Value::Null;
    }
    let Some(peer) = peer else {
        return minimal_tree(state);
    };
    let model_id = str_at(state, &["thread", "model", "id"]);
    let display = str_at(state, &["thread", "model", "display_name"]);
    let payload = json!({
        "model": {"id": model_id, "display_name": display},
        "effort": str_at(state, &["thread", "model", "reasoning_level"]),
    });
    statusline::peer_identity_item(base, thread_id, &peer, &payload).map_or_else(
        || minimal_tree(state),
        |item| identity_tree(&item, bar_width(), nerd_glyphs()),
    )
}

/// Runs each lookup on a worker so a slow mailbox read degrades to the minimal row in time.
///
/// A known thread gets its last tree at once while a worker looks it up again, so the bar trails
/// the mailbox by about one poll. A new thread waits up to [`READ_BUDGET`] for its first lookup
/// and otherwise shows the minimal row until the lookup lands.
#[derive(Default)]
struct Renderer {
    shared: Arc<Mutex<Shared>>,
}

/// A rendered tree and when its lookup finished.
struct Cached {
    tree: Value,
    at: Instant,
}

#[derive(Default)]
struct Shared {
    trees: HashMap<String, Cached>,
    in_flight: HashSet<String>,
}

/// Everything in the snapshot that changes the tree.
fn cache_key(state: &Value) -> String {
    [
        &["thread", "id"][..],
        &["thread", "model", "id"],
        &["thread", "model", "display_name"],
        &["thread", "model", "reasoning_level"],
        &["thread", "agent", "state"],
    ]
    .iter()
    .map(|path| str_at(state, path))
    .collect::<Vec<_>>()
    .join("\n")
}

impl Renderer {
    fn lock(&self) -> MutexGuard<'_, Shared> {
        self.shared.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Start a lookup for `key` unless one is already running; the receiver gets its tree.
    fn refresh(&self, key: &str, state: Value) -> Option<mpsc::Receiver<Value>> {
        if !self.lock().in_flight.insert(key.to_string()) {
            return None;
        }
        let (sender, receiver) = mpsc::channel();
        let shared = Arc::clone(&self.shared);
        let owned_key = key.to_string();
        let spawned = thread::Builder::new()
            .name("statusline-read".to_string())
            .spawn(move || {
                let _deadline = sqlite::set_operation_deadline(Instant::now() + LOOKUP_BUDGET);
                let base = paths::cache_home(None, None).join("mailbox-v1");
                let tree = render_tree(&base, &state);
                let now = Instant::now();
                let mut guard = shared.lock().unwrap_or_else(PoisonError::into_inner);
                guard
                    .trees
                    .retain(|_, cached| now.duration_since(cached.at) < CACHE_LIFETIME);
                let cached = Cached {
                    tree: tree.clone(),
                    at: now,
                };
                guard.trees.insert(owned_key.clone(), cached);
                guard.in_flight.remove(&owned_key);
                drop(guard);
                let _ = sender.send(tree);
            });
        if spawned.is_err() {
            self.lock().in_flight.remove(key);
            return None;
        }
        Some(receiver)
    }

    fn render(&self, state: Value) -> Value {
        let key = cache_key(&state);
        let cached = self
            .lock()
            .trees
            .get(&key)
            .map(|c| (c.tree.clone(), c.at.elapsed()));
        if let Some((tree, age)) = cached {
            if age >= REFRESH_AFTER {
                let _ = self.refresh(&key, state);
            }
            return tree;
        }
        let fallback = minimal_tree(&state);
        self.refresh(&key, state)
            .and_then(|receiver| receiver.recv_timeout(READ_BUDGET).ok())
            .unwrap_or(fallback)
    }
}

fn tool() -> Value {
    json!({
        "name": TOOL_NAME,
        "title": "Orkest agent bar",
        "description": "Show this session's Orkest identity (name, model, repository, stage, goal and task) in the Codex footer.",
        "inputSchema": {"type": "object", "properties": {}},
        "_meta": {"openai/ui": {"entrypoints": [{"type": "statusline", "resourceUri": URI}]}},
    })
}

fn error(code: i64, message: &str) -> Result<Value, (i64, String)> {
    Err((code, message.to_string()))
}

fn respond(renderer: &Renderer, method: &str, params: &Value) -> Result<Value, (i64, String)> {
    match method {
        "initialize" => {
            let version = params
                .get("protocolVersion")
                .and_then(Value::as_str)
                .filter(|v| !v.is_empty())
                .unwrap_or(PROTOCOL_VERSION);
            Ok(json!({
                "protocolVersion": version,
                "capabilities": {"tools": {}, "resources": {}},
                "serverInfo": {"name": SERVER_NAME, "version": env!("CARGO_PKG_VERSION")},
            }))
        }
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({"tools": [tool()]})),
        "tools/call" => {
            if params.get("name").and_then(Value::as_str) != Some(TOOL_NAME) {
                return error(-32602, "Unknown tool name");
            }
            Ok(json!({"content": [{
                "type": "text",
                "text": format!("The Orkest agent bar is the status line resource {URI}; choose it in /statusline."),
            }]}))
        }
        "resources/list" => Ok(json!({"resources": [{
            "name": "statusline",
            "title": "Orkest agent bar",
            "uri": URI,
            "mimeType": "application/json",
        }]})),
        "resources/templates/list" => Ok(json!({"resourceTemplates": []})),
        "resources/read" => {
            if params.get("uri").and_then(Value::as_str) != Some(URI) {
                return error(-32602, "Unknown resource URI");
            }
            let state = params
                .get("_meta")
                .and_then(|meta| meta.get(STATE_KEY))
                .cloned()
                .unwrap_or_else(|| json!({}));
            let tree = renderer.render(state);
            Ok(json!({"contents": [{
                "uri": URI,
                "mimeType": "application/json",
                "text": tree.to_string(),
            }]}))
        }
        _ => error(-32601, "Method not found"),
    }
}

/// One reply line for one request line, or `None` for a notification.
fn handle_line(renderer: &Renderer, line: &str) -> Option<Value> {
    let request: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => {
            return Some(json!({
                "jsonrpc": "2.0", "id": null,
                "error": {"code": -32700, "message": "Parse error"},
            }));
        }
    };
    let Some(method) = request.get("method").and_then(Value::as_str) else {
        return Some(json!({
            "jsonrpc": "2.0", "id": request.get("id").cloned().unwrap_or(Value::Null),
            "error": {"code": -32600, "message": "Invalid request"},
        }));
    };
    let id = request.get("id")?.clone();
    let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
    Some(match respond(renderer, method, &params) {
        Ok(result) => json!({"jsonrpc": "2.0", "id": id, "result": result}),
        Err((code, message)) => {
            json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
        }
    })
}

/// Serve newline-delimited JSON-RPC on stdin/stdout until Codex closes the pipe.
pub fn run() -> io::Result<()> {
    let renderer = Renderer::default();
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        if let Some(reply) = handle_line(&renderer, &line) {
            writeln!(stdout, "{reply}")?;
            stdout.flush()?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mailbox_lifecycle::tests::lock_test_env;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn renderer() -> Renderer {
        Renderer::default()
    }

    fn state(thread: &str) -> Value {
        json!({
            "thread": {
                "id": thread,
                "agent": {"state": "working"},
                "model": {"display_name": "GPT-5.5", "id": "gpt-5.5", "reasoning_level": "high", "provider": "openai"},
                "workspace": {"cwd": "/tmp"},
                "usage": {"context": {}},
            },
        })
    }

    #[test]
    fn known_threads_answer_from_the_cache_and_refresh_behind_it() {
        let _lock = lock_test_env();
        let dir = crate::mailbox_lifecycle::tests::TestDir::new("ork-statusline-mcp-cache");
        let mut env_guard = crate::mailbox_lifecycle::tests::EnvGuard::new();
        env_guard.set("ORCHESTRATE_HOME", &dir.path);
        let r = renderer();
        let first = state("019a5da8-1234-5678-9abc-123456789012");
        let key = cache_key(&first);
        assert_eq!(r.render(first.clone()), minimal_tree(&first));
        assert!(r.lock().trees.contains_key(&key));

        // A cached answer is immediate, and a stale one starts exactly one refresh.
        let marker = json!("cached");
        r.lock().trees.insert(
            key.clone(),
            Cached {
                tree: marker.clone(),
                at: Instant::now() - REFRESH_AFTER,
            },
        );
        assert_eq!(r.render(first.clone()), marker);
        let deadline = Instant::now() + Duration::from_secs(5);
        while r.lock().trees.get(&key).is_some_and(|c| c.tree == marker) {
            assert!(Instant::now() < deadline, "refresh never landed");
            thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(r.render(first.clone()), minimal_tree(&first));

        let mut other_model = first.clone();
        other_model["thread"]["model"]["id"] = json!("gpt-6");
        assert_ne!(cache_key(&other_model), key);
        drop(env_guard);
    }

    #[test]
    fn xterm_palette_matches_the_256_color_table() {
        assert_eq!(xterm_hex(203), "#ff5f5f");
        assert_eq!(xterm_hex(117), "#87d7ff");
        assert_eq!(xterm_hex(180), "#d7af87");
        assert_eq!(xterm_hex(245), "#8a8a8a");
        assert_eq!(xterm_hex(232), "#080808");
        assert_eq!(xterm_hex(1), "#800000");
    }

    #[test]
    fn minimal_row_shows_model_and_state() {
        let tree = minimal_tree(&state("x"));
        assert_eq!(tree["type"], "row");
        assert_eq!(tree["children"][0]["children"][0], "GPT-5.5 high");
        assert_eq!(tree["children"][0]["props"]["color"], "status-model");
        assert_eq!(tree["children"][1]["children"][0], "working");
        assert_eq!(
            minimal_tree(&json!({}))["children"][0]["children"][0],
            "Codex"
        );
    }

    #[test]
    fn identity_tree_keeps_bar_parts_and_colors() {
        let item = json!({
            "name": "ziggy", "color": 31, "model": "gpt-5.5", "effort": "high",
            "repo": "orkest", "stage": "working", "goal": "Ship", "task": "Verify",
            "statusHealth": "fresh",
        });
        let tree = identity_tree(&item, 200, true);
        let row = tree["children"].as_array().unwrap();
        assert_eq!(row[0]["props"]["background"], "#ff5f5f");
        // Codex trims spaces at a text node's edges, but not no-break spaces.
        assert_eq!(row[0]["children"][0]["children"][0], "\u{a0}󰚩\u{a0}\u{a0}");
        // One inline text node, so the spaces between parts survive Codex's layout.
        assert_eq!(row[1]["type"], "text");
        let children = row[1]["children"].as_array().unwrap();
        let texts: Vec<&str> = children
            .iter()
            .map(|c| c["children"][0].as_str().unwrap())
            .collect();
        assert_eq!(
            texts.concat(),
            "ziggy | gpt-5.5 / high | repo : orkest | stage : working | goal : Ship | task : Verify"
        );
        assert_eq!(children[0]["props"]["color"], "#ff5f5f");
        assert_eq!(children[0]["props"]["weight"], "bold");
        assert_eq!(children[1]["props"]["color"], "#8a8a8a");
        assert!(children[1]["props"].get("weight").is_none());
        let serialized = tree.to_string();
        assert!(serialized.len() < 64 * 1024);
        assert!(children.len() < 256);
    }

    #[test]
    fn herdr_pane_wins_over_a_recorded_tmux_server() {
        let _lock = lock_test_env();
        let peer = json!({"herdrPaneId": "w1:p1", "terminalServer": "orkest-label-0123456789ab"});
        assert!(!tmux_footer_draws(Some(&peer)));
        let missing = json!({"terminalServer": "orkest-label-ffffffffffff"});
        assert!(!tmux_footer_draws(Some(&missing)));
        let invalid = json!({"terminalServer": "../escape"});
        assert!(!tmux_footer_draws(Some(&invalid)));
    }

    #[test]
    fn protocol_lists_one_statusline_tool_and_never_errors_a_valid_read() {
        let _lock = lock_test_env();
        let r = renderer();
        let init = handle_line(
            &r,
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}"#,
        )
        .unwrap();
        assert_eq!(init["result"]["serverInfo"]["name"], SERVER_NAME);
        assert!(
            handle_line(
                &r,
                r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#
            )
            .is_none()
        );
        let tools = handle_line(&r, r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#).unwrap();
        let entry = &tools["result"]["tools"][0]["_meta"]["openai/ui"]["entrypoints"][0];
        assert_eq!(entry["type"], "statusline");
        assert_eq!(entry["resourceUri"], URI);

        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base = env::temp_dir().join(format!("ork-statusline-mcp-{nanos}/mailbox-v1"));
        fs::create_dir_all(base.join("peers")).unwrap();
        let tree = render_tree(&base, &state("019a5da8-1234-5678-9abc-123456789012"));
        assert_eq!(tree["children"][0]["children"][0], "GPT-5.5 high");
        let _ = fs::remove_dir_all(base.parent().unwrap());

        let read = json!({"jsonrpc": "2.0", "id": 3, "method": "resources/read",
            "params": {"uri": URI, "_meta": {STATE_KEY: "not an object"}}});
        let reply = handle_line(&r, &read.to_string()).unwrap();
        let content = &reply["result"]["contents"][0];
        assert_eq!(content["mimeType"], "application/json");
        assert!(serde_json::from_str::<Value>(content["text"].as_str().unwrap()).is_ok());

        let other = handle_line(
            &r,
            r#"{"jsonrpc":"2.0","id":4,"method":"resources/read","params":{"uri":"ui://other"}}"#,
        )
        .unwrap();
        assert_eq!(other["error"]["code"], -32602);
        let bad = handle_line(&r, "{not json").unwrap();
        assert_eq!(bad["error"]["code"], -32700);
    }
}
