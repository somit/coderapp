// coderapp backend — spawns coding-agent CLIs (claude / codex / copilot) per turn,
// streams their stdout/stderr line-by-line to the frontend as Tauri events.
//
// Design: "resume-per-turn" (Option B). Each turn is a fresh, short-lived process
// that exits when the turn ends — no long-lived agents to orphan, so we sidestep
// the zombie-process problem. Session continuity comes from each CLI's own
// on-disk session store, addressed by a session/thread id.

use std::cmp::Reverse;
use std::io::{BufRead, BufReader as StdBufReader};
use std::path::Path;
use std::process::Stdio;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

#[derive(Serialize, Clone)]
struct StreamLine {
    run_id: String,
    stream: String, // "stdout" | "stderr"
    line: String,
}

#[derive(Serialize, Clone)]
struct DonePayload {
    run_id: String,
    code: Option<i32>,
    error: Option<String>,
}

fn home() -> String {
    std::env::var("HOME").unwrap_or_default()
}

// ---- session history replay ----

fn claude_project_dir(cwd: &str) -> String {
    // Claude Code slugifies the cwd by replacing every non-alphanumeric char with '-'
    let slug: String = cwd.chars().map(|c| if c.is_alphanumeric() { c } else { '-' }).collect();
    format!("{}/.claude/projects/{}", home(), slug)
}

/// Read a Claude session `.jsonl` and return lines for the frontend to parse.
#[tauri::command]
fn load_session_history(session_id: String, cwd: String) -> Vec<String> {
    let path = format!("{}/{}.jsonl", claude_project_dir(&cwd), session_id);
    let f = match std::fs::File::open(&path) {
        Ok(f) => f,
        Err(_) => return vec![],
    };
    StdBufReader::new(f).lines().filter_map(|l| l.ok()).collect()
}

/// Find the most recent Claude session id for a given working directory.
#[tauri::command]
fn latest_session_id(cwd: String) -> String {
    let dir = claude_project_dir(&cwd);
    let read = match std::fs::read_dir(&dir) {
        Ok(r) => r,
        Err(_) => return String::new(),
    };
    let mut best: Option<(std::time::SystemTime, String)> = None;
    for entry in read.filter_map(|e| e.ok()) {
        let p = entry.path();
        if p.extension().and_then(|s| s.to_str()) != Some("jsonl") { continue; }
        let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
        if let Ok(meta) = entry.metadata() {
            if let Ok(modified) = meta.modified() {
                if best.as_ref().map_or(true, |(t, _)| modified > *t) {
                    best = Some((modified, stem));
                }
            }
        }
    }
    best.map(|(_, id)| id).unwrap_or_default()
}

/// Load a Codex session transcript by thread_id.
/// Codex stores sessions at ~/.codex/sessions/<year>/<month>/<day>/rollout-*-<id>.jsonl
#[tauri::command]
fn load_codex_session(thread_id: String) -> Vec<String> {
    let base = format!("{}/.codex/sessions", home());
    let mut result: Vec<String> = vec![];
    // walk year/month/day dirs to find the file containing thread_id
    let walk = walkdir_codex(&base, &thread_id);
    if let Some(path) = walk {
        if let Ok(f) = std::fs::File::open(&path) {
            result = StdBufReader::new(f).lines().filter_map(|l| l.ok()).collect();
        }
    }
    result
}

fn walkdir_codex(base: &str, thread_id: &str) -> Option<String> {
    // sessions are in base/YYYY/MM/DD/rollout-*-<thread_id>.jsonl
    // search newest-first: reverse-sort dirs
    let mut years: Vec<_> = std::fs::read_dir(base).ok()?.filter_map(|e| e.ok()).collect();
    years.sort_by_key(|e| std::cmp::Reverse(e.file_name()));
    for year in years {
        let mut months: Vec<_> = std::fs::read_dir(year.path()).ok()?.filter_map(|e| e.ok()).collect();
        months.sort_by_key(|e| std::cmp::Reverse(e.file_name()));
        for month in months {
            let mut days: Vec<_> = std::fs::read_dir(month.path()).ok()?.filter_map(|e| e.ok()).collect();
            days.sort_by_key(|e| std::cmp::Reverse(e.file_name()));
            for day in days {
                let mut files: Vec<_> = std::fs::read_dir(day.path()).ok()?.filter_map(|e| e.ok()).collect();
                files.sort_by_key(|e| std::cmp::Reverse(e.file_name()));
                for file in files {
                    let name = file.file_name().to_string_lossy().to_string();
                    if name.ends_with(&format!("-{}.jsonl", thread_id)) {
                        return Some(file.path().to_string_lossy().to_string());
                    }
                }
            }
        }
    }
    None
}

/// Find the most recent Codex thread_id for a given cwd.
#[tauri::command]
fn latest_codex_session(cwd: String) -> String {
    // session_index.jsonl doesn't have cwd, but session files have turn_context with cwd.
    // Faster: scan session_meta lines newest-first from session_index order.
    let index_path = format!("{}/.codex/session_index.jsonl", home());
    let base = format!("{}/.codex/sessions", home());
    let index_content = std::fs::read_to_string(&index_path).unwrap_or_default();
    // read ids newest-first (file is append-only, so reverse)
    let ids: Vec<String> = index_content.lines().rev()
        .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
        .filter_map(|v| v["id"].as_str().map(String::from))
        .collect();
    for id in &ids {
        if let Some(path) = walkdir_codex(&base, id) {
            if let Ok(f) = std::fs::File::open(&path) {
                for line in StdBufReader::new(f).lines().filter_map(|l| l.ok()) {
                    if let Ok(ev) = serde_json::from_str::<serde_json::Value>(&line) {
                        if ev["type"] == "turn_context" {
                            if let Some(c) = ev["payload"]["cwd"].as_str() {
                                if c == cwd { return id.clone(); }
                            }
                        }
                    }
                }
            }
        }
    }
    String::new()
}

// ---- file read for editor ----

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

// ---- fetch slash commands from claude init event ----

/// Spawn `claude --output-format stream-json -p ""` in a throwaway way,
/// read only the first `system/init` line, extract `slash_commands`, kill.
#[tauri::command]
fn fetch_slash_commands(cwd: String) -> Vec<String> {
    let bin = resolve_bin("claude");
    let mut child = match std::process::Command::new(&bin)
        .current_dir(&cwd)
        .args(["-p", "", "--output-format", "stream-json", "--dangerously-skip-permissions"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(_) => return vec![],
    };

    let mut cmds: Vec<String> = vec![];
    if let Some(stdout) = child.stdout.take() {
        let reader = StdBufReader::new(stdout);
        for line in reader.lines().filter_map(|l| l.ok()) {
            if let Ok(ev) = serde_json::from_str::<serde_json::Value>(&line) {
                if ev["type"] == "system" && ev["subtype"] == "init" {
                    if let Some(arr) = ev["slash_commands"].as_array() {
                        cmds = arr.iter().filter_map(|v| v.as_str().map(String::from)).collect();
                    }
                    break; // got what we need
                }
            }
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    cmds
}

// ---- git worktree management ----

#[derive(Serialize, Clone)]
struct WorktreeInfo {
    path: String,
    branch: String,
    is_main: bool,
}

fn run_git(root: &str, args: &[&str]) -> Result<String, String> {
    let out = std::process::Command::new("git")
        .current_dir(root)
        .args(args)
        .output()
        .map_err(|e| format!("git spawn failed: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// List existing worktrees of a repo. The first entry is the main worktree.
#[tauri::command]
fn list_worktrees(root: String) -> Result<Vec<WorktreeInfo>, String> {
    let out = run_git(&root, &["worktree", "list", "--porcelain"])?;
    let mut res: Vec<WorktreeInfo> = Vec::new();
    let mut cur_path: Option<String> = None;
    let mut cur_branch = String::new();
    let mut flush = |path: &mut Option<String>, branch: &mut String, v: &mut Vec<WorktreeInfo>| {
        if let Some(p) = path.take() {
            v.push(WorktreeInfo {
                path: p,
                branch: std::mem::take(branch),
                is_main: false,
            });
        }
    };
    for line in out.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            flush(&mut cur_path, &mut cur_branch, &mut res);
            cur_path = Some(p.to_string());
        } else if let Some(b) = line.strip_prefix("branch ") {
            cur_branch = b.strip_prefix("refs/heads/").unwrap_or(b).to_string();
        } else if line == "detached" {
            cur_branch = "(detached)".to_string();
        }
    }
    flush(&mut cur_path, &mut cur_branch, &mut res);
    if let Some(first) = res.first_mut() {
        first.is_main = true;
    }
    Ok(res)
}

/// Create a new worktree on a fresh branch, placed in a sibling
/// `<repo>.worktrees/<name>` directory.
#[tauri::command]
fn create_worktree(root: String, name: String) -> Result<WorktreeInfo, String> {
    let safe: String = name
        .trim()
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' || c == '/' { c } else { '-' })
        .collect();
    if safe.is_empty() {
        return Err("empty worktree name".into());
    }
    let root_path = std::path::Path::new(&root);
    let base = root_path.file_name().and_then(|s| s.to_str()).unwrap_or("repo");
    let parent = root_path.parent().ok_or("repo has no parent directory")?;
    let wt_dir = parent.join(format!("{base}.worktrees")).join(safe.replace('/', "-"));
    let wt_str = wt_dir.to_string_lossy().to_string();
    run_git(&root, &["worktree", "add", "-b", &safe, &wt_str])?;
    Ok(WorktreeInfo {
        path: wt_str,
        branch: safe,
        is_main: false,
    })
}

#[tauri::command]
fn remove_worktree(root: String, path: String) -> Result<(), String> {
    run_git(&root, &["worktree", "remove", "--force", &path])?;
    Ok(())
}

/// Resolve an agent's binary. GUI apps can have a thin PATH, so we prefer known
/// absolute install locations and fall back to the bare name (PATH lookup).
fn resolve_bin(agent: &str) -> String {
    let candidates: Vec<String> = match agent {
        "claude" => vec![format!("{}/.local/bin/claude", home()), "claude".into()],
        "codex" => vec!["/opt/homebrew/bin/codex".into(), "codex".into()],
        "copilot" => vec!["/opt/homebrew/bin/copilot".into(), "copilot".into()],
        other => vec![other.into()],
    };
    for c in &candidates {
        if c.contains('/') && Path::new(c).exists() {
            return c.clone();
        }
    }
    candidates.last().cloned().unwrap_or_else(|| agent.into())
}

/// Build the per-agent argument vector for a single turn.
fn build_args(agent: &str, prompt: &str, session_id: &Option<String>, yolo: bool) -> Vec<String> {
    let sid = session_id.as_deref().filter(|s| !s.is_empty());
    match agent {
        "claude" => {
            let mut a = vec![
                "-p".into(),
                prompt.into(),
                "--output-format".into(),
                "stream-json".into(),
                "--verbose".into(),
            ];
            if let Some(s) = sid {
                a.push("--resume".into());
                a.push(s.into());
            }
            if yolo {
                a.push("--dangerously-skip-permissions".into());
            }
            a
        }
        "codex" => {
            let mut a: Vec<String> = vec!["exec".into()];
            if let Some(s) = sid {
                a.push("resume".into());
                a.push(s.into());
            }
            a.push("--json".into());
            a.push("--skip-git-repo-check".into());
            if yolo {
                a.push("--dangerously-bypass-approvals-and-sandbox".into());
            } else {
                a.push("-s".into());
                a.push("workspace-write".into());
            }
            a.push(prompt.into());
            a
        }
        "copilot" => {
            // --allow-all-tools is required for non-interactive (-p) mode.
            let mut a = vec![
                "-p".into(),
                prompt.into(),
                "--allow-all-tools".into(),
                "--log-level".into(),
                "error".into(),
            ];
            if yolo {
                a.push("--allow-all-paths".into());
                a.push("--allow-all-urls".into());
            }
            // copilot can only resume the most-recent session (no per-id resume).
            if sid.is_some() {
                a.push("--continue".into());
            }
            a
        }
        _ => vec![],
    }
}

#[tauri::command]
async fn send_message(
    app: AppHandle,
    agent: String,
    repo_path: String,
    prompt: String,
    session_id: Option<String>,
    yolo: bool,
    run_id: String,
) -> Result<(), String> {
    let bin = resolve_bin(&agent);
    let args = build_args(&agent, &prompt, &session_id, yolo);
    if args.is_empty() {
        return Err(format!("unknown agent: {agent}"));
    }

    let mut cmd = Command::new(&bin);
    cmd.current_dir(&repo_path)
        .args(&args)
        .stdin(Stdio::null()) // don't let the CLI block waiting on stdin
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let msg = format!("spawn {bin} failed: {e}");
            let _ = app.emit(
                "agent-done",
                DonePayload {
                    run_id: run_id.clone(),
                    code: None,
                    error: Some(msg.clone()),
                },
            );
            return Err(msg);
        }
    };

    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");

    let app_out = app.clone();
    let rid_out = run_id.clone();
    let t_out = tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app_out.emit(
                "agent-event",
                StreamLine {
                    run_id: rid_out.clone(),
                    stream: "stdout".into(),
                    line,
                },
            );
        }
    });

    let app_err = app.clone();
    let rid_err = run_id.clone();
    let t_err = tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let _ = app_err.emit(
                "agent-event",
                StreamLine {
                    run_id: rid_err.clone(),
                    stream: "stderr".into(),
                    line,
                },
            );
        }
    });

    let _ = t_out.await;
    let _ = t_err.await;
    let status = child.wait().await.map_err(|e| e.to_string())?;
    let _ = app.emit(
        "agent-done",
        DonePayload {
            run_id: run_id.clone(),
            code: status.code(),
            error: None,
        },
    );
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            send_message,
            read_file,
            load_session_history,
            latest_session_id,
            load_codex_session,
            latest_codex_session,
            fetch_slash_commands,
            list_worktrees,
            create_worktree,
            remove_worktree
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
