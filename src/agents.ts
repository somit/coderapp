// Per-agent adapters: normalize each CLI's streaming output into a common
// transcript item, and extract the session/thread id used to resume.

export type AgentId = "claude" | "codex" | "copilot";

export const AGENTS: { id: AgentId; label: string; resumeNote?: string }[] = [
  { id: "claude", label: "Claude" },
  { id: "codex", label: "Codex" },
  {
    id: "copilot",
    label: "Copilot",
    resumeNote: "Copilot resumes the most-recent session only (no per-id resume).",
  },
];

export type ItemKind =
  | "system"
  | "assistant"
  | "reasoning"
  | "tool"
  | "tool_result"
  | "result"
  | "text"
  | "stderr";

export interface Item {
  kind: ItemKind;
  text: string;
}

export interface Parsed {
  items: Item[];
  sessionId?: string; // set when this line reveals the session/thread id
  slashCommands?: string[]; // set when the stream reveals available slash commands
}

// Shown before the first turn populates the live list from the init event.
export const SEED_SLASH: Record<AgentId, string[]> = {
  claude: ["clear", "compact", "context", "init", "review", "usage", "help"],
  codex: [],
  copilot: [],
};

function clip(s: string, n = 800): string {
  return s.length > n ? s.slice(0, n) + " …" : s;
}

function summarizeInput(input: unknown): string {
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    if (typeof o.command === "string") return clip(o.command, 200);
    if (typeof o.file_path === "string") return o.file_path as string;
    if (typeof o.path === "string") return o.path as string;
    if (typeof o.pattern === "string") return o.pattern as string;
  }
  return clip(JSON.stringify(input ?? {}), 200);
}

// ---- Claude: rich NDJSON stream-json events ----
function parseClaude(line: string): Parsed {
  let ev: any;
  try {
    ev = JSON.parse(line);
  } catch {
    return { items: [] };
  }
  const items: Item[] = [];
  let sessionId: string | undefined;
  let slashCommands: string[] | undefined;

  if (ev.type === "system" && ev.subtype === "init") {
    sessionId = ev.session_id;
    if (Array.isArray(ev.slash_commands)) slashCommands = ev.slash_commands;
    items.push({ kind: "system", text: `session ${ev.session_id} · ${ev.model ?? ""}` });
  } else if (ev.type === "assistant") {
    for (const b of ev.message?.content ?? []) {
      if (b.type === "text" && b.text?.trim()) items.push({ kind: "assistant", text: b.text });
      else if (b.type === "thinking" && b.thinking?.trim())
        items.push({ kind: "reasoning", text: b.thinking });
      else if (b.type === "tool_use")
        items.push({ kind: "tool", text: `▶ ${b.name}  ${summarizeInput(b.input)}` });
    }
  } else if (ev.type === "user") {
    for (const b of ev.message?.content ?? []) {
      if (b.type === "tool_result") {
        const c = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
        items.push({ kind: "tool_result", text: clip(c) });
      }
    }
  } else if (ev.type === "result") {
    const cost = typeof ev.total_cost_usd === "number" ? `$${ev.total_cost_usd.toFixed(4)}` : "";
    items.push({ kind: "result", text: `✓ ${ev.subtype} · ${ev.num_turns ?? "?"} turns · ${cost}` });
  }
  return { items, sessionId, slashCommands };
}

// ---- Codex: JSONL events (thread.started / item.completed / turn.completed) ----
function parseCodex(line: string): Parsed {
  let ev: any;
  try {
    ev = JSON.parse(line);
  } catch {
    return { items: [] };
  }
  const items: Item[] = [];
  let sessionId: string | undefined;

  switch (ev.type) {
    case "thread.started":
      sessionId = ev.thread_id;
      items.push({ kind: "system", text: `thread ${ev.thread_id}` });
      break;
    case "item.completed": {
      const it = ev.item ?? {};
      if (it.type === "agent_message" && it.text) items.push({ kind: "assistant", text: it.text });
      else if (it.type === "reasoning" && it.text) items.push({ kind: "reasoning", text: it.text });
      else if (it.type === "command_execution")
        items.push({ kind: "tool", text: `▶ ${clip(it.command ?? "", 200)}` });
      else if (it.type === "file_change")
        items.push({ kind: "tool", text: `✎ ${it.path ?? JSON.stringify(it).slice(0, 120)}` });
      break;
    }
    case "turn.completed": {
      const u = ev.usage ?? {};
      items.push({
        kind: "result",
        text: `✓ in ${u.input_tokens ?? "?"} / out ${u.output_tokens ?? "?"} tokens`,
      });
      break;
    }
  }
  return { items, sessionId };
}

// ---- Copilot: plain text on stdout, no structured session id ----
function parseCopilot(line: string): Parsed {
  if (!line.trim()) return { items: [] };
  return { items: [{ kind: "text", text: line }] };
}

export function parseLine(agent: AgentId, stream: "stdout" | "stderr", line: string): Parsed {
  if (stream === "stderr") {
    return line.trim() ? { items: [{ kind: "stderr", text: line }] } : { items: [] };
  }
  switch (agent) {
    case "claude":
      return parseClaude(line);
    case "codex":
      return parseCodex(line);
    case "copilot":
      return parseCopilot(line);
  }
}

// ---- Codex transcript parser (~/.codex/sessions/…/rollout-*.jsonl) ----

export function parseCodexTranscriptLine(line: string): Parsed {
  let ev: any;
  try { ev = JSON.parse(line); } catch { return { items: [] }; }
  const items: Item[] = [];
  const p = ev.payload ?? {};

  if (ev.type === "event_msg") {
    if (p.type === "user_message" && typeof p.message === "string") {
      // strip IDE context header if present (everything before "## My request for Codex:")
      const marker = "## My request for Codex:\n";
      const idx = p.message.indexOf(marker);
      const text = idx >= 0 ? p.message.slice(idx + marker.length).trim() : p.message.trim();
      if (text) items.push({ kind: "text", text: `❯ ${text}` });
    } else if (p.type === "agent_message" && typeof p.message === "string" && p.message.trim()) {
      items.push({ kind: "assistant", text: p.message.trim() });
    } else if (p.type === "agent_reasoning" && typeof p.text === "string" && p.text.trim()) {
      items.push({ kind: "reasoning", text: p.text.trim() });
    }
  } else if (ev.type === "response_item") {
    if (p.type === "function_call" && p.name) {
      let args = "";
      try { const a = JSON.parse(p.arguments ?? "{}"); args = a.command ?? a.path ?? ""; } catch {}
      items.push({ kind: "tool", text: `▶ ${p.name}  ${clip(args)}` });
    } else if (p.type === "function_call_output" && p.output) {
      items.push({ kind: "tool_result", text: clip(p.output) });
    }
  }
  return { items };
}

// ---- Transcript file parser (internal .jsonl format, different from stream-json) ----
// Used when replaying history from ~/.claude/projects/<dir>/<id>.jsonl

export function parseTranscriptLine(line: string): Parsed {
  let ev: any;
  try { ev = JSON.parse(line); } catch { return { items: [] }; }
  const items: Item[] = [];

  if (ev.type === "user" && ev.message?.content) {
    const content = ev.message.content;
    if (typeof content === "string" && content.trim()) {
      // plain string = actual user prompt
      items.push({ kind: "text", text: `❯ ${content.trim()}` });
    } else if (Array.isArray(content)) {
      // array = mixed blocks; show text blocks as user prompts, skip tool_results
      // (tool_results are internal and shown via the preceding tool_use in the assistant turn)
      for (const b of content) {
        if (b.type === "text" && b.text?.trim()) {
          items.push({ kind: "text", text: `❯ ${b.text.trim()}` });
        }
      }
    }
  } else if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
    for (const b of ev.message.content) {
      if (b.type === "text" && b.text?.trim()) items.push({ kind: "assistant", text: b.text });
      else if (b.type === "thinking" && b.thinking?.trim()) items.push({ kind: "reasoning", text: b.thinking });
      else if (b.type === "tool_use") items.push({ kind: "tool", text: `▶ ${b.name}  ${summarizeInput(b.input)}` });
    }
  }
  return { items };
}
