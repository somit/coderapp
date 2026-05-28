import React, { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";
import Editor, { DiffEditor } from "@monaco-editor/react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { AGENTS, AgentId, Item, Usage, parseLine, parseTranscriptLine, parseCodexTranscriptLine, SEED_SLASH } from "./agents";
import { Terminal } from "./Terminal";
import "./App.css";

interface StreamLine { run_id: string; stream: "stdout" | "stderr"; line: string; }
interface DonePayload { run_id: string; code: number | null; error: string | null; }
interface WorktreeInfo { path: string; branch: string; is_main: boolean; }

// One agent conversation within a worktree
interface Session {
  id: string;
  agent: AgentId;
  yolo: boolean;
  sessionId: string;
  items: Item[];
  running: boolean;
  activeFile?: string; // last file the agent touched
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

interface SysStats { cpu: number; mem_used_gb: number; mem_total_gb: number; }
interface ProcStat { name: string; pid: number; cpu: number; mem_mb: number; }

function SysBar() {
  const [stats, setStats] = useState<SysStats | null>(null);
  const [procs, setProcs] = useState<ProcStat[]>([]);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const poll = () => {
      invoke<SysStats>("system_stats").then(setStats).catch(() => {});
      invoke<ProcStat[]>("process_stats").then(setProcs).catch(() => {});
    };
    poll();
    const t = setInterval(poll, 3000);
    return () => clearInterval(t);
  }, []);

  if (!stats) return null;
  const memPct = Math.round((stats.mem_used_gb / stats.mem_total_gb) * 100);
  const cpuPct = Math.round(stats.cpu);

  return (
    <div className="sys-bar-wrap">
      <div className="sys-bar" onClick={() => setExpanded(e => !e)} title="Click to see process detail">
        <span className="sys-item">
          <span className="sys-label">CPU</span>
          <span className={`sys-val ${cpuPct > 80 ? "hot" : cpuPct > 50 ? "warm" : ""}`}>{cpuPct}%</span>
        </span>
        <span className="sys-item">
          <span className="sys-label">MEM</span>
          <span className={`sys-val ${memPct > 85 ? "hot" : memPct > 65 ? "warm" : ""}`}>{stats.mem_used_gb.toFixed(1)}G</span>
        </span>
        <span className="sys-arrow">{expanded ? "▴" : "▾"}</span>
      </div>
      {expanded && (
        <div className="proc-list">
          {procs.length === 0
            ? <div className="proc-row dim">no agents running</div>
            : procs.map(p => (
              <div key={p.pid} className="proc-row">
                <span className="proc-name">{p.name}</span>
                <span className={`proc-cpu ${p.cpu > 50 ? "hot" : p.cpu > 20 ? "warm" : ""}`}>{p.cpu.toFixed(1)}%</span>
                <span className="proc-mem">{p.mem_mb.toFixed(0)}M</span>
              </div>
            ))
          }
        </div>
      )}
    </div>
  );
}

function TermPanel({ cwd, open, height, onToggle, onResize, children }: {
  cwd: string; open: boolean; height: number;
  onToggle: () => void; onResize: (h: number) => void;
  children?: React.ReactNode;
}) {
  const dragging = useRef(false);
  const startY = useRef(0);
  const startH = useRef(0);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const delta = startY.current - e.clientY;
      onResize(Math.min(Math.max(startH.current + delta, 80), 600));
    };
    const onUp = () => { dragging.current = false; };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, []);

  return (
    <div className="term-panel" style={{ height: open ? height : "auto" }}>
      <div className="term-titlebar">
        {open && (
          <div className="term-drag-handle"
            onMouseDown={e => { dragging.current = true; startY.current = e.clientY; startH.current = height; e.preventDefault(); }} />
        )}
        <button className="term-toggle" onClick={onToggle}>
          <span>{open ? "▾" : "▸"}</span> Terminal
          <span className="term-cwd">{cwd.split("/").pop()}</span>
        </button>
      </div>
      {/* Terminal instances rendered by parent, shown/hidden here */}
      {open && <div className="term-body">{children}</div>}
    </div>
  );
}

function SplitPane({ children, chatWidth, onChatWidthChange }: {
  children: React.ReactNode;
  chatWidth: number;
  onChatWidthChange: (w: number) => void;
}) {
  const dragging = useRef(false);
  const startX = useRef(0);
  const startW = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const onMouseDown = (e: React.MouseEvent) => {
    dragging.current = true;
    startX.current = e.clientX;
    startW.current = chatWidth;
    e.preventDefault();
  };

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current || !containerRef.current) return;
      const totalW = containerRef.current.offsetWidth;
      const delta = e.clientX - startX.current;
      const next = Math.min(Math.max(startW.current + delta, 0), totalW);
      onChatWidthChange(next);
    };
    const onUp = () => { dragging.current = false; };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, [chatWidth]);

  const arr = React.Children.toArray(children);
  const left = arr[0];
  const right = arr[1];

  const totalW = containerRef.current?.offsetWidth ?? 800;
  const codeHidden = chatWidth >= totalW;
  const chatHidden = chatWidth <= 0;

  return (
    <div className="split" ref={containerRef}>
      {!chatHidden && (
        <div style={{ width: chatWidth, flexShrink: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          {left}
        </div>
      )}
      {right && !codeHidden && !chatHidden && (
        <div className="split-handle" onMouseDown={onMouseDown} />
      )}
      {right && !codeHidden && (
        <div style={{ flex: 1, display: "flex", overflow: "hidden", minWidth: 0 }}>
          {right}
        </div>
      )}
    </div>
  );
}

interface FileNode { name: string; path: string; is_dir: boolean; children: FileNode[]; }

function FileTree({ root, onSelect, activeFile }: {
  root: string;
  onSelect: (path: string) => void;
  activeFile: string;
}) {
  const [nodes, setNodes] = useState<FileNode[]>([]);
  const [open, setOpen] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!root) return;
    invoke<FileNode[]>("list_files", { root }).then(setNodes).catch(() => {});
  }, [root]);

  function toggle(path: string) {
    setOpen(prev => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });
  }

  function renderNode(node: FileNode, depth: number): React.ReactNode {
    const indent = depth * 12;
    if (node.is_dir) {
      const isOpen = open.has(node.path);
      return (
        <div key={node.path}>
          <div className="ft-row ft-dir" style={{ paddingLeft: indent + 6 }}
            onClick={() => toggle(node.path)}>
            <span className="ft-arrow">{isOpen ? "▾" : "▸"}</span>
            <span className="ft-icon">📁</span>
            <span className="ft-name">{node.name}</span>
          </div>
          {isOpen && node.children.map(c => renderNode(c, depth + 1))}
        </div>
      );
    }
    return (
      <div key={node.path}
        className={`ft-row ft-file ${node.path === activeFile ? "active" : ""}`}
        style={{ paddingLeft: indent + 6 }}
        onClick={() => onSelect(node.path)}>
        <span className="ft-icon">{fileIcon(node.name)}</span>
        <span className="ft-name">{node.name}</span>
      </div>
    );
  }

  return (
    <div className="file-tree">
      <div className="ft-header">Explorer</div>
      <div className="ft-body">{nodes.map(n => renderNode(n, 0))}</div>
    </div>
  );
}

function fileIcon(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["ts","tsx"].includes(ext)) return "𝙏";
  if (["js","jsx"].includes(ext)) return "𝙅";
  if (ext === "rs") return "🦀";
  if (ext === "go") return "𝙂";
  if (ext === "py") return "𝙋";
  if (["md","mdx"].includes(ext)) return "📝";
  if (["json","toml","yaml","yml"].includes(ext)) return "⚙";
  if (["png","jpg","jpeg","gif","svg","webp"].includes(ext)) return "🖼";
  return "📄";
}

function langFromPath(p: string): string {
  const ext = p.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts:"typescript", tsx:"typescript", js:"javascript", jsx:"javascript",
    py:"python", rs:"rust", go:"go", rb:"ruby", java:"java", kt:"kotlin",
    swift:"swift", cpp:"cpp", c:"c", cs:"csharp", sh:"shell", bash:"shell",
    zsh:"shell", json:"json", yaml:"yaml", yml:"yaml", toml:"toml",
    md:"markdown", html:"html", css:"css", scss:"scss", sql:"sql",
    graphql:"graphql", proto:"protobuf", tf:"hcl",
  };
  return map[ext] ?? "plaintext";
}

type ViewMode = "editor" | "diff" | "git-diff";

function CodePane({ filePath, repoPath, onOpenFile, agentRunning }: {
  filePath: string;
  repoPath: string;
  onOpenFile: (fp: string) => void;
  agentRunning: boolean;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [original, setOriginal] = useState<string>("");
  const [gitDiff, setGitDiff] = useState<string>("");
  const [err, setErr] = useState("");
  const [resolvedPath, setResolvedPath] = useState("");
  const [view, setView] = useState<ViewMode>("editor");

  // load file content
  async function loadFile(fp: string) {
    try {
      const c = await invoke<string>("read_file", { path: fp });
      setContent(c); setErr(""); setResolvedPath(fp);
    } catch {
      try {
        const rel = `${repoPath}/${fp}`;
        const c = await invoke<string>("read_file", { path: rel });
        setContent(c); setErr(""); setResolvedPath(rel);
      } catch (e) { setErr(String(e)); setContent(null); }
    }
  }

  // load git original for diff
  async function loadOriginal(fp: string) {
    const orig = await invoke<string>("git_file_original", { root: repoPath, path: fp }).catch(() => "");
    setOriginal(orig);
  }

  // load full git diff
  async function loadGitDiff() {
    const d = await invoke<string>("git_diff", { root: repoPath }).catch(() => "");
    setGitDiff(d);
  }

  useEffect(() => {
    if (!filePath) { setContent(null); setErr(""); setResolvedPath(""); return; }
    loadFile(filePath);
    loadOriginal(filePath);
  }, [filePath]);

  // auto-refresh content + diff when agent is running
  useEffect(() => {
    if (!agentRunning || !resolvedPath) return;
    const interval = setInterval(() => {
      loadFile(resolvedPath);
      if (view === "diff") loadOriginal(resolvedPath);
      if (view === "git-diff") loadGitDiff();
    }, 1500);
    return () => clearInterval(interval);
  }, [agentRunning, resolvedPath, view]);

  useEffect(() => {
    if (view === "git-diff") loadGitDiff();
  }, [view, repoPath]);

  async function pickFile() {
    const picked = await open({ title: "Open file" });
    if (picked && typeof picked === "string") onOpenFile(picked);
  }

  const relPath = resolvedPath ? resolvedPath.replace(repoPath + "/", "") : "";

  return (
    <div className="code-pane">
      <div className="code-editor-area">
        <div className="code-pane-header">
          {relPath
            ? <span className="code-pane-path">{relPath}</span>
            : <span className="code-pane-path dim">no file open</span>
          }
          <div className="view-tabs">
            {(["editor","diff","git-diff"] as ViewMode[]).map(v => (
              <button key={v} className={`view-tab ${view === v ? "active" : ""}`}
                onClick={() => setView(v)}>
                {v === "editor" ? "Editor" : v === "diff" ? "Diff" : "Git Diff"}
              </button>
            ))}
          </div>
          <button className="code-open-btn" onClick={pickFile}>open…</button>
        </div>
        {err && <div className="code-pane-err">{err}</div>}

        {!err && view === "editor" && (
          content !== null
            ? <Editor height="100%" theme="vs-dark" language={langFromPath(resolvedPath)}
                value={content}
                options={{ readOnly: false, minimap: { enabled: true }, fontSize: 12,
                  lineNumbers: "on", scrollBeyondLastLine: false, automaticLayout: true }} />
            : <div className="code-pane-empty">
                <span>Click a file in the tree</span>
                <span className="dim">or the agent will open one automatically</span>
              </div>
        )}

        {!err && view === "diff" && (
          content !== null
            ? <DiffEditor height="100%" theme="vs-dark" language={langFromPath(resolvedPath)}
                original={original} modified={content}
                options={{ readOnly: true, renderSideBySide: true, fontSize: 12, automaticLayout: true }} />
            : <div className="code-pane-empty"><span>Open a file to diff</span></div>
        )}

        {view === "git-diff" && (
          gitDiff
            ? <Editor height="100%" theme="vs-dark" language="diff"
                value={gitDiff}
                options={{ readOnly: true, minimap: { enabled: false }, fontSize: 12,
                  lineNumbers: "off", scrollBeyondLastLine: false, automaticLayout: true,
                  wordWrap: "off" }} />
            : <div className="code-pane-empty">
                <span>{agentRunning ? "Waiting for changes…" : "No uncommitted changes"}</span>
              </div>
        )}
      </div>
      <FileTree root={repoPath} onSelect={fp => onOpenFile(fp)} activeFile={resolvedPath} />
    </div>
  );
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

function MdItem({ item }: { item: Item }) {
  const [raw, setRaw] = useState(false);
  const [failed, setFailed] = useState(false);
  const text = item.text.replace(/^❯ /, "");
  return (
    <div className={`item ${item.kind} md`}>
      <button className="md-toggle" title={raw ? "Show preview" : "Show raw"} onClick={() => setRaw(r => !r)}>
        {raw ? "⬡" : "⬢"}
      </button>
      {raw || failed
        ? <pre className="md-raw">{text}</pre>
        : <MdRenderer text={text} onError={() => setFailed(true)} />
      }
    </div>
  );
}

class MdRenderer extends React.Component<{ text: string; onError: () => void }, { err: boolean }> {
  constructor(props: { text: string; onError: () => void }) {
    super(props);
    this.state = { err: false };
  }
  componentDidCatch() { this.props.onError(); }
  static getDerivedStateFromError() { return { err: true }; }
  render() {
    if (this.state.err) return <pre className="md-raw">{this.props.text}</pre>;
    return (
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
        {this.props.text}
      </ReactMarkdown>
    );
  }
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
  const [awake, setAwake] = useState(false);
  const [termOpen, setTermOpen] = useState(false);
  const [openedTerms, setOpenedTerms] = useState<{id: string; cwd: string}[]>([]);
  const [termHeight, setTermHeight] = useState(220);
  const [chatWidth, setChatWidth] = useState<number | null>(null); // null = 50/50 on first render
  const paneRef = useRef<HTMLDivElement>(null);

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
        const key = parsed.sessionId ?? sessId;
        setUsageMap(prev => ({ ...prev, [key]: [...(prev[key] ?? []), parsed.usage!] }));
      }
      // track most recently touched file for the editor pane
      const filePath = parsed.items.find(i => i.filePath)?.filePath;
      if (parsed.sessionId || parsed.items.length || filePath) {
        patchSession(sessId, s => ({
          sessionId: parsed.sessionId ?? s.sessionId,
          items: parsed.items.length ? [...s.items, ...parsed.items] : s.items,
          ...(filePath ? { activeFile: filePath } : {}),
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
        <div className="side-footer">
          <div className="side-footer-row">
            <div className="layout-presets side-presets">
              {([
                { label: "⬛▫", title: "Chat 2/3 · Code 1/3", chat: 2/3 },
                { label: "▪▪",  title: "50 / 50",              chat: 1/2 },
                { label: "▫⬛", title: "Chat 1/3 · Code 2/3", chat: 1/3 },
                { label: "⬛",  title: "Chat only",             chat: 1   },
                { label: "▫",  title: "Code only",              chat: 0   },
              ] as const).map(p => (
                <button key={p.label} className="layout-btn" title={p.title}
                  onClick={() => setChatWidth(Math.round((paneRef.current?.offsetWidth ?? 800) * p.chat))}>
                  {p.label}
                </button>
              ))}
            </div>
            <button
              className={`awake-btn ${awake ? "on" : ""}`}
              title={awake ? "Mac awake — click to allow sleep" : "Click to keep Mac awake"}
              onClick={() => {
                if (awake) { invoke("caffeinate_off").then(() => setAwake(false)); }
                else { invoke("caffeinate_on").then(() => setAwake(true)).catch(() => {}); }
              }}>
              {awake ? "☕" : "💤"}
            </button>
          </div>
          <SysBar />
        </div>
      </aside>

      {/* ---- main pane (chat + editor split) ---- */}
      <div className="pane" ref={paneRef}>
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

            <SplitPane chatWidth={chatWidth ?? Math.round((paneRef.current?.offsetWidth ?? 800) * 0.5)} onChatWidthChange={setChatWidth}>
            <div className="split-chat">
            <main className="transcript">
              {activeSession.items.length === 0 && (
                <div className="empty">
                  <b>{activeSession.agent}</b> on <b>{activeWt.branch}</b>. Type a prompt or <b>/</b> for commands.
                </div>
              )}
              {groupItems(activeSession.items).map((g, i) => {
                if (g.type === "thinking") return <ThinkingBlock key={i} text={g.items[0].text} />;
                if (g.type === "tools") return <ToolLoop key={i} items={g.items} />;
                const it = g.items[0];
                if (it.kind === "assistant" || it.kind === "text") {
                  return <MdItem key={i} item={it} />;
                }
                return <div key={i} className={`item ${it.kind}`}><pre>{it.text}</pre></div>;
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
            </div>{/* split-chat */}
            <CodePane
              filePath={activeSession.activeFile ?? ""}
              repoPath={activeWt.path}
              agentRunning={activeSession.running}
              onOpenFile={fp => patchSession(activeSession.id, () => ({ activeFile: fp }))}
            />
            </SplitPane>
            <TermPanel
              cwd={activeWt.path}
              open={termOpen}
              height={termHeight}
              onToggle={() => {
                if (!termOpen) {
                  setOpenedTerms(prev =>
                    prev.find(t => t.id === activeWt.id) ? prev : [...prev, { id: activeWt.id, cwd: activeWt.path }]
                  );
                }
                setTermOpen(o => !o);
              }}
              onResize={setTermHeight}
            >
              {/* all opened terminals stay mounted; only active one is visible */}
              {openedTerms.map(t => (
                <div key={t.id} style={{ width: "100%", height: "100%", display: t.id === activeWt.id ? "block" : "none" }}>
                  <Terminal id={t.id} cwd={t.cwd} visible={termOpen && t.id === activeWt.id} />
                </div>
              ))}
            </TermPanel>
          </>
        )}
      </div>
    </div>
  );
}

export default App;
