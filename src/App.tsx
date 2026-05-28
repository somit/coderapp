import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { AGENTS, AgentId, Item, Usage, parseLine, parseTranscriptLine, parseCodexTranscriptLine, SEED_SLASH } from "./agents";
import "./App.css";

interface StreamLine { run_id: string; stream: "stdout" | "stderr"; line: string; }
interface DonePayload { run_id: string; code: number | null; error: string | null; }
interface WorktreeInfo { path: string; branch: string; is_main: boolean; }

// One agent conversation within a worktree
interface Session {
  id: string;
  agent: AgentId;
  yolo: boolean;
  sessionId: string; // claude/codex resume id
  items: Item[];
  running: boolean;
}

// One git worktree (or the main checkout)
interface Worktree {
  id: string;
  path: string;
  branch: string;
  isMain: boolean;
  sessions: Session[];
  activeSessionId: string;
}

interface Project {
  id: string;
  name: string;
  rootPath: string;
  worktrees: Worktree[];
}

const PROJ_KEY = "coderapp.projects.v2";
const SLASH_KEY = "coderapp.slash";
const USAGE_KEY = "coderapp.usage"; // { [sessionId]: Usage[] }

function loadUsage(): Record<string, Usage[]> {
  try { const r = localStorage.getItem(USAGE_KEY); if (r) return JSON.parse(r); } catch {}
  return {};
}
function sumUsage(turns: Usage[]): Usage {
  return turns.reduce((a, b) => ({
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    costUsd: a.costUsd + b.costUsd,
  }), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 });
}
function fmt(u: Usage) {
  if (!u.costUsd && !u.inputTokens) return "";
  if (u.costUsd) return `$${u.costUsd.toFixed(4)}`;
  return `${((u.inputTokens + u.outputTokens) / 1000).toFixed(1)}k tok`;
}

function newSession(agent: AgentId = "claude"): Session {
  return { id: crypto.randomUUID(), agent, yolo: true, sessionId: "", items: [], running: false };
}
function newWorktreeFromInfo(info: WorktreeInfo): Worktree {
  const s = newSession();
  return { id: crypto.randomUUID(), path: info.path, branch: info.branch || "(no branch)", isMain: info.is_main, sessions: [s], activeSessionId: s.id };
}
function basename(p: string) { return p.replace(/\/+$/, "").split("/").pop() || p; }

function loadProjects(): Project[] {
  try {
    const raw = localStorage.getItem(PROJ_KEY);
    if (!raw) return [];
    return (JSON.parse(raw) as Project[]).map(p => ({
      ...p,
      worktrees: p.worktrees.map(w => ({
        ...w,
        sessions: (w.sessions ?? []).map(s => ({ ...s, items: [], running: false })),
      })),
    }));
  } catch { return []; }
}
function loadSlash(): Record<AgentId, string[]> {
  try { const r = localStorage.getItem(SLASH_KEY); if (r) return { ...SEED_SLASH, ...JSON.parse(r) }; } catch {}
  return { ...SEED_SLASH };
}

type Group =
  | { type: "thinking"; items: [Item] }
  | { type: "tools"; items: Item[] }
  | { type: "single"; items: [Item] };

function groupItems(items: Item[]): Group[] {
  const groups: Group[] = [];
  let toolBuf: Item[] = [];

  function flushTools() {
    if (toolBuf.length) { groups.push({ type: "tools", items: toolBuf }); toolBuf = []; }
  }

  for (const it of items) {
    if (it.kind === "tool" || it.kind === "tool_result") {
      toolBuf.push(it);
    } else {
      flushTools();
      if (it.kind === "reasoning") groups.push({ type: "thinking", items: [it] });
      else groups.push({ type: "single", items: [it] });
    }
  }
  flushTools();
  return groups;
}

function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const preview = text.slice(0, 80).replace(/\n/g, " ") + (text.length > 80 ? "…" : "");
  return (
    <div className="item reasoning">
      <div className="think-header" onClick={() => setOpen(o => !o)}>
        <span className="think-arrow">{open ? "▾" : "▶"}</span>
        <span className="think-label">thinking</span>
        {!open && <span className="think-preview">{preview}</span>}
      </div>
      {open && <pre className="think-body">{text}</pre>}
    </div>
  );
}

function ToolLoop({ items }: { items: Item[] }) {
  const [open, setOpen] = useState(false);
  // build a short summary from tool names
  const tools = items.filter(i => i.kind === "tool").map(i => i.text.replace(/^▶\s*/, "").split(/\s+/)[0]);
  const unique = [...new Set(tools)];
  const summary = unique.slice(0, 4).join(", ") + (unique.length > 4 ? ` +${unique.length - 4}` : "");
  return (
    <div className="item tool-loop">
      <div className="think-header" onClick={() => setOpen(o => !o)}>
        <span className="think-arrow">{open ? "▾" : "▶"}</span>
        <span className="think-label">{items.filter(i => i.kind === "tool").length} tool calls</span>
        {!open && <span className="think-preview">{summary}</span>}
      </div>
      {open && (
        <div className="tool-loop-body">
          {items.map((it, i) => (
            <div key={i} className={`item-inner ${it.kind}`}><pre>{it.text}</pre></div>
          ))}
        </div>
      )}
    </div>
  );
}

function App() {
  const [projects, setProjects] = useState<Project[]>(loadProjects);
  // activeId = worktree id
  const [activeWtId, setActiveWtId] = useState<string>(() => loadProjects()[0]?.worktrees[0]?.id ?? "");
  const [slashByAgent, setSlashByAgent] = useState<Record<AgentId, string[]>>(loadSlash);
  const [prompt, setPrompt] = useState("");
  const [attachments, setAttachments] = useState<string[]>([]);
  const [menuIdx, setMenuIdx] = useState(0);
  const [addingTo, setAddingTo] = useState("");
  const [newName, setNewName] = useState("");
  const [err, setErr] = useState("");
  const [usageMap, setUsageMap] = useState<Record<string, Usage[]>>(loadUsage);

  const runMap = useRef<Record<string, string>>({}); // run_id -> session id
  const runAgent = useRef<Record<string, AgentId>>({});
  const endRef = useRef<HTMLDivElement>(null);

  // find active worktree + active session within it
  const found = useMemo(() => {
    for (const p of projects) {
      const w = p.worktrees.find(x => x.id === activeWtId);
      if (w) {
        const s = w.sessions.find(x => x.id === w.activeSessionId) ?? w.sessions[0];
        return { project: p, wt: w, session: s };
      }
    }
    return null;
  }, [projects, activeWtId]);
  const { wt: activeWt, session: activeSession } = found ?? {};

  useEffect(() => {
    const persist = projects.map(p => ({
      ...p,
      worktrees: p.worktrees.map(w => ({ ...w, sessions: w.sessions.map(s => ({ ...s, items: [], running: false })) })),
    }));
    localStorage.setItem(PROJ_KEY, JSON.stringify(persist));
  }, [projects]);
  useEffect(() => { localStorage.setItem(SLASH_KEY, JSON.stringify(slashByAgent)); }, [slashByAgent]);
  useEffect(() => { localStorage.setItem(USAGE_KEY, JSON.stringify(usageMap)); }, [usageMap]);

  // Fetch live slash commands from claude init on startup (uses any valid cwd)
  useEffect(() => {
    const cwd = projects.flatMap(p => p.worktrees)[0]?.path ?? "/tmp";
    invoke<string[]>("fetch_slash_commands", { cwd })
      .then(cmds => { if (cmds.length) setSlashByAgent(prev => ({ ...prev, claude: cmds })); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const unEvent = listen<StreamLine>("agent-event", e => {
      const { run_id, stream, line } = e.payload;
      const sessId = runMap.current[run_id];
      if (!sessId) return;
      const agent = runAgent.current[run_id] ?? "claude";
      const parsed = parseLine(agent, stream, line);
      if (parsed.slashCommands) setSlashByAgent(prev => ({ ...prev, [agent]: parsed.slashCommands! }));
      if (parsed.usage) {
        // key by the session's claude/codex sessionId if known, else by our internal session id
        const key = parsed.sessionId ?? sessId;
        setUsageMap(prev => ({ ...prev, [key]: [...(prev[key] ?? []), parsed.usage!] }));
      }
      if (parsed.sessionId || parsed.items.length) {
        patchSession(sessId, s => ({
          sessionId: parsed.sessionId ?? s.sessionId,
          items: parsed.items.length ? [...s.items, ...parsed.items] : s.items,
        }));
      }
    });
    const unDone = listen<DonePayload>("agent-done", e => {
      const sessId = runMap.current[e.payload.run_id];
      if (!sessId) return;
      patchSession(sessId, s => ({
        running: false,
        items: e.payload.error ? [...s.items, { kind: "stderr", text: e.payload.error! }] : s.items,
      }));
      delete runMap.current[e.payload.run_id];
      delete runAgent.current[e.payload.run_id];
    });
    return () => { unEvent.then(f => f()); unDone.then(f => f()); };
  }, []);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [activeSession?.items.length]);

  // When switching to a session with no items:
  //   1. If sessionId already known → load history directly.
  //   2. If no sessionId → auto-discover the most recent session for this worktree path,
  //      then load its history. This handles sessions started outside the app (Conductor, terminal).
  useEffect(() => {
    if (!activeSession || !activeWt) return;
    if (activeSession.items.length > 0) return;

    const agent = activeSession.agent;

    async function loadHistory(sessId: string) {
      let lines: string[];
      let parseF: (l: string) => { items: Item[] };
      if (agent === "codex") {
        lines = await invoke<string[]>("load_codex_session", { threadId: sessId });
        parseF = parseCodexTranscriptLine;
      } else {
        lines = await invoke<string[]>("load_session_history", { sessionId: sessId, cwd: activeWt!.path });
        parseF = parseTranscriptLine;
      }
      const items: Item[] = [];
      for (const line of lines) items.push(...parseF(line).items);
      if (items.length) patchSession(activeSession!.id, () => ({ items, sessionId: sessId }));
    }

    if (activeSession.sessionId) {
      loadHistory(activeSession.sessionId).catch(() => {});
    } else {
      const cmd = agent === "codex" ? "latest_codex_session" : "latest_session_id";
      const arg = agent === "codex" ? { cwd: activeWt.path } : { cwd: activeWt.path };
      invoke<string>(cmd, arg)
        .then(id => { if (id) loadHistory(id); })
        .catch(() => {});
    }
  }, [activeSession?.id]);

  function patchSession(sessId: string, patch: (s: Session) => Partial<Session>) {
    setProjects(prev => prev.map(p => ({
      ...p,
      worktrees: p.worktrees.map(w => ({
        ...w,
        sessions: w.sessions.map(s => s.id === sessId ? { ...s, ...patch(s) } : s),
      })),
    })));
  }

  function patchActiveSession(patch: Partial<Session>) {
    if (activeSession) patchSession(activeSession.id, () => patch);
  }

  async function addProject() {
    setErr("");
    const picked = await open({ directory: true, title: "Pick a repo / working directory" });
    if (!picked || typeof picked !== "string") return;
    let worktrees: Worktree[];
    try {
      const infos = await invoke<WorktreeInfo[]>("list_worktrees", { root: picked });
      worktrees = infos.map(newWorktreeFromInfo);
    } catch {
      worktrees = [newWorktreeFromInfo({ path: picked, branch: "(no git)", is_main: true })];
    }
    const proj: Project = { id: crypto.randomUUID(), name: basename(picked), rootPath: picked, worktrees };
    setProjects(prev => [...prev, proj]);
    setActiveWtId(worktrees[0].id);
  }

  async function addWorktree(project: Project) {
    const name = newName.trim();
    if (!name) return;
    setErr("");
    try {
      const info = await invoke<WorktreeInfo>("create_worktree", { root: project.rootPath, name });
      const wt = newWorktreeFromInfo(info);
      setProjects(prev => prev.map(p => p.id === project.id ? { ...p, worktrees: [...p.worktrees, wt] } : p));
      setActiveWtId(wt.id);
    } catch (e) { setErr(String(e)); }
    setAddingTo(""); setNewName("");
  }

  async function removeWorktree(project: Project, wt: Worktree) {
    if (!wt.isMain) {
      try { await invoke("remove_worktree", { root: project.rootPath, path: wt.path }); }
      catch (e) { setErr(String(e)); return; }
    }
    setProjects(prev =>
      prev.map(p => p.id === project.id ? { ...p, worktrees: p.worktrees.filter(w => w.id !== wt.id) } : p)
          .filter(p => p.worktrees.length > 0)
    );
    if (activeWtId === wt.id) {
      const next = projects.flatMap(p => p.worktrees).find(w => w.id !== wt.id);
      setActiveWtId(next?.id ?? "");
    }
  }

  // Add a new agent session to the active worktree
  function addSession(agent: AgentId) {
    if (!activeWt) return;
    const s = newSession(agent);
    setProjects(prev => prev.map(p => ({
      ...p,
      worktrees: p.worktrees.map(w => w.id === activeWt.id
        ? { ...w, sessions: [...w.sessions, s], activeSessionId: s.id }
        : w),
    })));
  }

  function removeSession(sessId: string) {
    if (!activeWt) return;
    setProjects(prev => prev.map(p => ({
      ...p,
      worktrees: p.worktrees.map(w => {
        if (w.id !== activeWt.id) return w;
        const remaining = w.sessions.filter(s => s.id !== sessId);
        if (remaining.length === 0) return w; // don't remove last session
        return {
          ...w,
          sessions: remaining,
          activeSessionId: w.activeSessionId === sessId ? remaining[remaining.length - 1].id : w.activeSessionId,
        };
      }),
    })));
  }

  function switchSession(sessId: string) {
    if (!activeWt) return;
    setProjects(prev => prev.map(p => ({
      ...p,
      worktrees: p.worktrees.map(w => w.id === activeWt.id ? { ...w, activeSessionId: sessId } : w),
    })));
  }

  async function attach() {
    const picked = await open({
      multiple: true,
      filters: [{ name: "Media & Files", extensions: ["png","jpg","jpeg","gif","webp","pdf","txt","md","json","csv","ts","tsx","js","py","go","rs","rb","sh"] }],
    });
    if (!picked) return;
    const paths = Array.isArray(picked) ? picked : [picked];
    setAttachments(prev => [...prev, ...paths]);
  }

  function removeAttachment(path: string) {
    setAttachments(prev => prev.filter(p => p !== path));
  }

  async function send() {
    if (!activeSession || !activeWt || (!prompt.trim() && !attachments.length) || activeSession.running) return;
    const rid = crypto.randomUUID();
    runMap.current[rid] = activeSession.id;
    runAgent.current[rid] = activeSession.agent;
    // build prompt: text + attachment paths appended so the agent can read them
    const fullPrompt = [
      prompt.trim(),
      ...attachments.map(p => `[attached file: ${p}]`),
    ].filter(Boolean).join("\n\n");
    const displayPrompt = [prompt.trim(), ...attachments.map(p => `📎 ${p.split("/").pop()}`)].filter(Boolean).join("  ");
    setPrompt("");
    setAttachments([]);
    patchSession(activeSession.id, s => ({ running: true, items: [...s.items, { kind: "text", text: `❯ ${displayPrompt}` }] }));
    try {
      await invoke("send_message", {
        agent: activeSession.agent, repoPath: activeWt.path,
        prompt: fullPrompt, sessionId: activeSession.sessionId || null,
        yolo: activeSession.yolo, runId: rid,
      });
    } catch (e) {
      patchActiveSession({ running: false, items: [...activeSession.items, { kind: "stderr", text: String(e) }] });
    }
  }

  // slash command menu
  const slashMatch = prompt.match(/^\/(\S*)$/);
  const slashList = activeSession ? slashByAgent[activeSession.agent] ?? [] : [];
  const slashMatches = useMemo(() => {
    if (!slashMatch) return [];
    const q = slashMatch[1].toLowerCase();
    return slashList.filter(c => c.toLowerCase().startsWith(q)).slice(0, 8);
  }, [slashMatch?.[1], slashList]);
  const menuOpen = slashMatches.length > 0;
  useEffect(() => setMenuIdx(0), [slashMatch?.[1]]);
  const pickSlash = (cmd: string) => setPrompt("/" + cmd + " ");

  const resumeNote = activeSession ? AGENTS.find(a => a.id === activeSession.agent)?.resumeNote : undefined;

  return (
    <div className="app">
      {/* ---- sidebar: projects + worktrees ---- */}
      <aside className="sidebar">
        <div className="side-head">
          <span>Projects</span>
          <button className="add" onClick={addProject} title="Add project">+</button>
        </div>
        <div className="ws-list">
          {projects.length === 0 && <div className="side-empty">Click + to pick a repo folder.</div>}
          {projects.map(p => {
            const projUsage = sumUsage(
              p.worktrees.flatMap(w => w.sessions.flatMap(s =>
                usageMap[s.sessionId] ?? usageMap[s.id] ?? []
              ))
            );
            const projCost = fmt(projUsage);
            return (
            <div key={p.id} className="project">
              <div className="proj-head">
                <span className="proj-name" title={p.rootPath}>{p.name}</span>
                {projCost && <span className="proj-cost">{projCost}</span>}
                <button className="add small" title="Add worktree" onClick={() => { setAddingTo(addingTo === p.id ? "" : p.id); setNewName(""); }}>+</button>
              </div>
              {addingTo === p.id && (
                <div className="add-wt">
                  <input autoFocus placeholder="new branch name…" value={newName}
                    onChange={e => setNewName(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") addWorktree(p); if (e.key === "Escape") setAddingTo(""); }} />
                  <button onClick={() => addWorktree(p)}>add</button>
                </div>
              )}
              {p.worktrees.map(w => {
                const busy = w.sessions.some(s => s.running);
                return (
                  <div key={w.id} className={`wt ${w.id === activeWtId ? "active" : ""}`} onClick={() => setActiveWtId(w.id)}>
                    <span className={`dot ${busy ? "on" : ""}`} />
                    <span className="wt-branch">{w.isMain ? `${w.branch} · main` : w.branch}</span>
                    <span className="sess-count">{w.sessions.length}</span>
                    <button className="x" title={w.isMain ? "Remove project" : "Remove worktree"}
                      onClick={e => { e.stopPropagation(); removeWorktree(p, w); }}>×</button>
                  </div>
                );
              })}
            </div>
            );
          })}
        </div>
        {err && <div className="side-err" onClick={() => setErr("")}>{err}</div>}
      </aside>

      {/* ---- main pane ---- */}
      <div className="pane">
        {!activeWt || !activeSession ? (
          <div className="empty">Add a project from the sidebar to start.</div>
        ) : (
          <>
            {/* session tabs */}
            <div className="session-tabs">
              {activeWt.sessions.map(s => {
                const sessUsage = sumUsage(usageMap[s.sessionId] ?? usageMap[s.id] ?? []);
                const costLabel = fmt(sessUsage);
                return (
                  <div key={s.id} className={`stab ${s.id === activeSession.id ? "active" : ""} ${s.running ? "running" : ""}`}
                    onClick={() => switchSession(s.id)}>
                    <span className={`dot-sm ${s.running ? "on" : ""}`} />
                    {s.agent}
                    {costLabel && <span className="cost-badge">{costLabel}</span>}
                    {activeWt.sessions.length > 1 && (
                      <button className="tx" onClick={e => { e.stopPropagation(); removeSession(s.id); }}>×</button>
                    )}
                  </div>
                );
              })}
              {/* add session buttons */}
              <div className="stab-add">
                {AGENTS.map(a => (
                  <button key={a.id} className="ghost-sm" onClick={() => addSession(a.id)} title={`Open new ${a.label} session`}>
                    + {a.label}
                  </button>
                ))}
              </div>
            </div>

            <header className="bar">
              <label className="yolo" title="auto-approve all tools">
                <input type="checkbox" checked={activeSession.yolo}
                  onChange={e => patchActiveSession({ yolo: e.target.checked })} /> yolo
              </label>
              <button className="ghost" onClick={() => patchActiveSession({ sessionId: "", items: [] })}
                disabled={activeSession.running}>new session</button>
            </header>

            <div className="meta">
              <span className="branch-tag">{activeWt.isMain ? `${activeWt.branch} · main` : activeWt.branch}</span>
              {activeSession.sessionId
                ? <span className="sid">session: {activeSession.sessionId}</span>
                : <span className="sid dim">no session yet</span>}
              {resumeNote && <span className="note">{resumeNote}</span>}
            </div>

            <main className="transcript">
              {activeSession.items.length === 0 && (
                <div className="empty">
                  <b>{activeSession.agent}</b> on <b>{activeWt.branch}</b>. Type a prompt or <b>/</b> for commands.
                </div>
              )}
              {groupItems(activeSession.items).map((g, i) => {
                if (g.type === "thinking") return <ThinkingBlock key={i} text={g.items[0].text} />;
                if (g.type === "tools") return <ToolLoop key={i} items={g.items} />;
                return <div key={i} className={`item ${g.items[0].kind}`}><pre>{g.items[0].text}</pre></div>;
              })}
              {activeSession.running && <div className="item running"><pre>… running</pre></div>}
              <div ref={endRef} />
            </main>

            <footer className="composer">
              {menuOpen && (
                <div className="slash-menu">
                  {slashMatches.map((c, i) => (
                    <div key={c} className={`slash-item ${i === menuIdx ? "hl" : ""}`}
                      onMouseEnter={() => setMenuIdx(i)}
                      onMouseDown={e => { e.preventDefault(); pickSlash(c); }}>
                      /{c}
                    </div>
                  ))}
                </div>
              )}
              <div className="composer-body">
                {attachments.length > 0 && (
                  <div className="attachments">
                    {attachments.map(p => (
                      <div key={p} className="pill-attach">
                        <span>📎 {p.split("/").pop()}</span>
                        <button onClick={() => removeAttachment(p)}>×</button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="composer-row">
                  <button className="attach-btn" onClick={attach} title="Attach file / image" disabled={activeSession.running}>
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                      <path d="M13.5 7.5L7 14a4 4 0 01-5.657-5.657l7-7a2.5 2.5 0 013.536 3.536L5.5 11.5a1 1 0 01-1.414-1.414L10 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
                    </svg>
                  </button>
                  <textarea
                    value={prompt}
                    placeholder={activeSession.running ? "running…" : "Message… (Enter to send, Shift+Enter for newline)"}
                    onChange={e => setPrompt(e.target.value)}
                    onKeyDown={e => {
                      if (menuOpen) {
                        if (e.key === "ArrowDown") { e.preventDefault(); setMenuIdx(i => (i + 1) % slashMatches.length); return; }
                        if (e.key === "ArrowUp") { e.preventDefault(); setMenuIdx(i => (i - 1 + slashMatches.length) % slashMatches.length); return; }
                        if (e.key === "Tab" || e.key === "Enter") { e.preventDefault(); pickSlash(slashMatches[menuIdx]); return; }
                      }
                      // Enter = send, Shift+Enter = newline
                      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); return; }
                    }}
                    disabled={activeSession.running}
                  />
                  <button className="send-btn" onClick={send} disabled={activeSession.running || (!prompt.trim() && !attachments.length)}>
                    {activeSession.running ? "…" : "↑"}
                  </button>
                </div>
              </div>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}

export default App;
