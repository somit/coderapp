# coderapp

A minimal, Conductor-style desktop app for driving coding agents — but it runs
**in-place on your current branch** by default (no forced worktree/branch), and
supports **Claude, Codex, and Copilot** behind one UI.

## Why

Conductor forces every session into a git worktree because it's built around
*parallel* agents. Most of the time you just want one agent editing your current
checkout. coderapp makes the worktree optional and lets you pick the backend.

## How it works

- **Resume-per-turn** (no long-lived agent processes). Each turn spawns a fresh,
  short-lived CLI process that exits when the turn ends — so there are no
  background agents to orphan (the runaway-`bun`-process failure mode). Session
  continuity comes from each CLI's own on-disk session store, addressed by a
  session/thread id captured from the event stream.
- **Backend** (`src-tauri/src/lib.rs`): the `send_message` Tauri command builds
  per-agent args, spawns the CLI with `stdin=null` + `kill_on_drop`, and streams
  stdout/stderr line-by-line to the frontend via `agent-event` / `agent-done`.
- **Frontend** (`src/agents.ts`): per-agent parsers normalize each CLI's output
  into a common transcript and extract the resume id.

## Agent adapters

| Agent   | Turn command                                          | Resume                     | Output            |
|---------|-------------------------------------------------------|----------------------------|-------------------|
| claude  | `claude -p <p> --output-format stream-json --verbose` | `--resume <session_id>`    | rich NDJSON        |
| codex   | `codex exec --json -s workspace-write <p>`            | `codex exec resume <id> …` | JSONL events       |
| copilot | `copilot -p <p> --allow-all-tools`                    | `--continue` (latest only) | plain text         |

`yolo` toggles each CLI's auto-approve flag (`--dangerously-skip-permissions` /
`--dangerously-bypass-approvals-and-sandbox` / `--allow-all`).

## Run

```bash
npm install
npm run tauri dev
```

## Roadmap

- [ ] Render history from `~/.claude/projects/<dir>/<id>.jsonl` on restart
- [ ] Optional worktree mode (per-session toggle) for parallel agents
- [ ] Diff viewer from tool-call file edits
- [ ] Process-group kill + cancel button for long turns
