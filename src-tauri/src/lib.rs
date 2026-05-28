// coderapp backend — spawns coding-agent CLIs (claude / codex / copilot) per turn,
// streams their stdout/stderr line-by-line to the frontend as Tauri events.
//
// Design: "resume-per-turn" (Option B). Each turn is a fresh, short-lived process
// that exits when the turn ends — no long-lived agents to orphan, so we sidestep
// the zombie-process problem. Session continuity comes from each CLI's own
// on-disk session store, addressed by a session/thread id.

use std::cmp::Reverse;
use std::collections::HashMap;
use std::io::{BufRead, BufReader as StdBufReader, Read, Write};
use std::path::Path;
use std::process::Stdio;
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

// ---- PTY session registry ----
struct PtySession {
    master: Box<dyn portable_pty::MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    #[allow(dead_code)]
    child: Box<dyn portable_pty::Child + Send>,
}
type PtyMap = Arc<Mutex<HashMap<String, PtySession>>>;

struct PtyState(PtyMap);
struct CaffeinateState(Mutex<Option<std::process::Child>>);
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

// ---- file read + tree for editor ----

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// Return the git HEAD version of a file (original before agent edits).
/// Returns empty string if file is untracked or repo has no HEAD.
#[tauri::command]
fn git_file_original(root: String, path: String) -> String {
    // make path relative to repo root
    let rel = path.strip_prefix(&root)
        .map(|p| p.trim_start_matches('/'))
        .unwrap_or(&path);
    let out = std::process::Command::new("git")
        .current_dir(&root)
        .args(["show", &format!("HEAD:{}", rel)])
        .output();
    match out {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).to_string(),
        _ => String::new(),
    }
}

/// Return full git diff for the worktree (staged + unstaged).
#[tauri::command]
fn git_diff(root: String) -> String {
    let staged = std::process::Command::new("git")
        .current_dir(&root)
        .args(["diff", "HEAD"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();
    staged
}

#[derive(Serialize, Clone)]
struct FileNode {
    name: String,
    path: String,
    is_dir: bool,
    children: Vec<FileNode>,
}

fn build_tree(dir: &std::path::Path, depth: u32) -> Vec<FileNode> {
    if depth == 0 { return vec![]; }
    let mut entries = match std::fs::read_dir(dir) {
        Ok(e) => e.filter_map(|e| e.ok()).collect::<Vec<_>>(),
        Err(_) => return vec![],
    };
    entries.sort_by_key(|e| {
        let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
        (!is_dir, e.file_name()) // dirs first, then alpha
    });
    entries.iter().filter_map(|entry| {
        let name = entry.file_name().to_string_lossy().to_string();
        // skip hidden files/dirs and common noise
        if name.starts_with('.') || name == "node_modules" || name == "target"
            || name == "dist" || name == "__pycache__" { return None; }
        let path = entry.path();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let children = if is_dir { build_tree(&path, depth - 1) } else { vec![] };
        Some(FileNode {
            name,
            path: path.to_string_lossy().to_string(),
            is_dir,
            children,
        })
    }).collect()
}

#[tauri::command]
fn list_files(root: String) -> Vec<FileNode> {
    build_tree(std::path::Path::new(&root), 6)
}

#[tauri::command]
fn list_dir(path: String) -> Vec<FileNode> {
    build_tree(std::path::Path::new(&path), 1)
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

// ---- system stats ----

#[derive(Serialize, Clone)]
struct SysStats {
    cpu: f32,    // overall CPU %
    mem_used_gb: f32,
    mem_total_gb: f32,
}

#[tauri::command]
fn system_stats() -> SysStats {
    // macOS: use vm_stat + sysctl for memory, and top snapshot for CPU
    let mem = get_mem_stats();
    let cpu = get_cpu_percent();
    SysStats { cpu, mem_used_gb: mem.0, mem_total_gb: mem.1 }
}

fn get_mem_stats() -> (f32, f32) {
    // total: sysctl hw.memsize
    let total = std::process::Command::new("sysctl")
        .args(["-n", "hw.memsize"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse::<u64>().ok())
        .unwrap_or(0);
    // used: vm_stat gives page counts; page size is 16384 on Apple Silicon
    let vm = std::process::Command::new("vm_stat")
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();
    let page_size: u64 = std::process::Command::new("sysctl")
        .args(["-n", "hw.pagesize"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse().ok())
        .unwrap_or(16384);
    let parse_pages = |key: &str| -> u64 {
        vm.lines().find(|l| l.contains(key))
            .and_then(|l| l.split_whitespace().last())
            .and_then(|v| v.trim_end_matches('.').parse::<u64>().ok())
            .unwrap_or(0)
    };
    let wired = parse_pages("Pages wired down");
    let active = parse_pages("Pages active");
    let compressed = parse_pages("Pages occupied by compressor");
    let used_bytes = (wired + active + compressed) * page_size;
    (used_bytes as f32 / 1e9, total as f32 / 1e9)
}

fn get_cpu_percent() -> f32 {
    // Sample ps load average as a proxy (cheap, no sysctl loop needed)
    let out = std::process::Command::new("sh")
        .args(["-c", "ps -A -o %cpu | awk '{s+=$1} END {print s}'"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().parse::<f32>().unwrap_or(0.0))
        .unwrap_or(0.0);
    // Normalize by logical CPU count
    let ncpu = std::process::Command::new("sysctl")
        .args(["-n", "hw.logicalcpu"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse::<f32>().ok())
        .unwrap_or(8.0);
    (out / ncpu).min(100.0)
}

// ---- caffeinate (prevent sleep) ----

#[tauri::command]
fn caffeinate_on(app: AppHandle) -> Result<(), String> {
    let child = std::process::Command::new("caffeinate")
        .args(["-d", "-i", "-m", "-s"]) // display + idle + disk + system sleep
        .spawn()
        .map_err(|e| e.to_string())?;
    *app.state::<CaffeinateState>().0.lock().unwrap() = Some(child);
    Ok(())
}

#[tauri::command]
fn caffeinate_off(app: AppHandle) {
    if let Some(mut child) = app.state::<CaffeinateState>().0.lock().unwrap().take() {
        child.kill().ok();
    }
}

// ---- PTY commands ----

#[tauri::command]
fn pty_create(app: AppHandle, id: String, cwd: String, cols: u16, rows: u16) -> Result<(), String> {
    let pty_system = native_pty_system();
    let pair = pty_system.openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut cmd = CommandBuilder::new(&shell);
    cmd.cwd(&cwd);
    // pass user environment so PATH, homebrew, etc. work
    cmd.env("TERM", "xterm-256color");
    cmd.env("HOME", home());
    if let Ok(path) = std::env::var("PATH") { cmd.env("PATH", path); }

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

    // stream PTY output to frontend
    let app2 = app.clone();
    let id2 = id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app2.emit(&format!("pty-output-{}", id2), data);
                }
            }
        }
    });

    let state = app.state::<PtyState>();
    state.0.lock().unwrap().insert(id, PtySession { master: pair.master, writer, child });
    Ok(())
}

#[tauri::command]
fn pty_write(app: AppHandle, id: String, data: String) -> Result<(), String> {
    let state = app.state::<PtyState>();
    let mut map = state.0.lock().unwrap();
    if let Some(sess) = map.get_mut(&id) {
        sess.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
        sess.writer.flush().ok();
    }
    Ok(())
}

#[tauri::command]
fn pty_resize(app: AppHandle, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let state = app.state::<PtyState>();
    let map = state.0.lock().unwrap();
    if let Some(sess) = map.get(&id) {
        sess.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn pty_kill(app: AppHandle, id: String) {
    let state = app.state::<PtyState>();
    state.0.lock().unwrap().remove(&id);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(PtyState(Arc::new(Mutex::new(HashMap::new()))))
        .manage(CaffeinateState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            send_message,
            read_file,
            git_file_original,
            git_diff,
            list_files,
            list_dir,
            load_session_history,
            latest_session_id,
            load_codex_session,
            latest_codex_session,
            fetch_slash_commands,
            list_worktrees,
            create_worktree,
            remove_worktree,
            pty_create,
            pty_write,
            pty_resize,
            pty_kill,
            caffeinate_on,
            caffeinate_off,
            system_stats
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
