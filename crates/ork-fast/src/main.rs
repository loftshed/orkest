//! Fast native accelerator binary for Orkest hooks, gate, lease, and statusline.

mod gate;
mod herdr_status;
mod identity;
mod lease;
mod mailbox;
mod mailbox_lifecycle;
mod mailbox_records;
mod mailbox_swarm;
mod mailbox_transcript;
mod paths;
mod quota_line;
mod rooms_work;
mod sha1;
mod sha256;
mod sqlite;
mod statusline;
mod terminal;

use std::env;
use std::path::PathBuf;

fn print_help() {
    println!(
        "ork-fast {}\n\
Fast native accelerator binary for Orkest hooks, gate, lease, and statusline.\n\n\
USAGE:\n\
    ork-fast <SUBCOMMAND> [OPTIONS]\n\n\
SUBCOMMANDS:\n\
    lease-holder <path> [--read-only] [--namespace <ns>]\n\
    gate-hook --harness <claude|codex|gemini> [--fallback-script <gate.py>]\n\
    statusline [OPTIONS] [--fallback-script <agent_statusline.py>]\n\
    mailbox-hook --harness <claude|codex|gemini> [--event <Event>] [--fallback-script <peer_mailbox.py>]\n\
    herdr-status [--fallback-script <herdr_status.py>]\n\n\
FLAGS:\n\
    -h, --help       Print help information\n\
    -V, --version    Print version information",
        env!("CARGO_PKG_VERSION")
    );
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = env::args().collect();
    if args.len() < 2 {
        print_help();
        std::process::exit(1);
    }

    match args[1].as_str() {
        "-V" | "--version" => {
            println!("ork-fast {}", env!("CARGO_PKG_VERSION"));
            return Ok(());
        }
        "-h" | "--help" | "help" => {
            print_help();
            return Ok(());
        }
        "lease-holder" => {
            let mut path_opt: Option<PathBuf> = None;
            let mut read_only = false;
            let mut namespace: Option<String> = None;
            let mut idx = 2;
            while idx < args.len() {
                match args[idx].as_str() {
                    "--read-only" => read_only = true,
                    "--namespace" => {
                        if idx + 1 < args.len() {
                            namespace = Some(args[idx + 1].clone());
                            idx += 1;
                        }
                    }
                    val if !val.starts_with('-') && path_opt.is_none() => {
                        path_opt = Some(PathBuf::from(val));
                    }
                    _ => {}
                }
                idx += 1;
            }
            let path = match path_opt {
                Some(p) => p,
                None => {
                    eprintln!("error: lease-holder requires a workspace path");
                    std::process::exit(2);
                }
            };
            lease::run(&path, read_only, namespace.as_deref())?;
        }
        "gate-hook" => {
            let mut harness = "claude".to_string();
            let mut fallback_script: Option<PathBuf> = None;
            let mut idx = 2;
            while idx < args.len() {
                match args[idx].as_str() {
                    "--harness" => {
                        if idx + 1 < args.len() {
                            harness = args[idx + 1].clone();
                            idx += 1;
                        }
                    }
                    "--fallback-script" if idx + 1 < args.len() => {
                        fallback_script = Some(PathBuf::from(&args[idx + 1]));
                        idx += 1;
                    }
                    _ => {}
                }
                idx += 1;
            }
            gate::run(&harness, fallback_script.as_deref())?;
        }
        "statusline" => {
            let mut fallback_script: Option<PathBuf> = None;
            for (idx, arg) in args[2..].iter().enumerate() {
                if arg == "--fallback-script" && idx + 1 < args[2..].len() {
                    fallback_script = Some(PathBuf::from(&args[2..][idx + 1]));
                    break;
                }
            }
            statusline::run(&args[2..], fallback_script.as_deref())?;
        }
        "mailbox-hook" => {
            let mut harness_opt: Option<String> = None;
            let mut event_opt: Option<String> = None;
            let mut fallback_script: Option<PathBuf> = None;
            let mut idx = 2;
            while idx < args.len() {
                match args[idx].as_str() {
                    "--harness" => {
                        if idx + 1 < args.len() {
                            harness_opt = Some(args[idx + 1].clone());
                            idx += 1;
                        }
                    }
                    "--event" => {
                        if idx + 1 < args.len() {
                            event_opt = Some(args[idx + 1].clone());
                            idx += 1;
                        }
                    }
                    "--fallback-script" if idx + 1 < args.len() => {
                        fallback_script = Some(PathBuf::from(&args[idx + 1]));
                        idx += 1;
                    }
                    _ => {}
                }
                idx += 1;
            }
            mailbox::run(
                harness_opt.as_deref(),
                event_opt.as_deref(),
                fallback_script.as_deref(),
            )?;
        }
        "herdr-status-read-pane" => herdr_status::read_pane()?,
        "herdr-status" => {
            let mut fallback_script: Option<PathBuf> = None;
            for (idx, arg) in args[2..].iter().enumerate() {
                if arg == "--fallback-script" && idx + 1 < args[2..].len() {
                    fallback_script = Some(PathBuf::from(&args[2..][idx + 1]));
                    break;
                }
            }
            herdr_status::run(&args[2..], fallback_script.as_deref())?;
        }
        unknown => {
            eprintln!("error: unrecognized subcommand '{unknown}'");
            print_help();
            std::process::exit(1);
        }
    }

    Ok(())
}
