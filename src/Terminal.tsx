import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";

interface Props {
  id: string;   // unique per worktree tab
  cwd: string;
  visible: boolean;
}

export function Terminal({ id, cwd, visible }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const createdRef = useRef(false);

  useEffect(() => {
    if (!containerRef.current || createdRef.current) return;
    createdRef.current = true;

    const term = new XTerm({
      theme: {
        background: "#0d1117",
        foreground: "#e6edf3",
        cursor: "#e6edf3",
        selectionBackground: "#264f78",
        black: "#0d1117", brightBlack: "#6e7681",
        red: "#f85149", brightRed: "#f85149",
        green: "#3fb950", brightGreen: "#3fb950",
        yellow: "#d29922", brightYellow: "#e3b341",
        blue: "#388bfd", brightBlue: "#79c0ff",
        magenta: "#bc8cff", brightMagenta: "#d2a8ff",
        cyan: "#39c5cf", brightCyan: "#56d364",
        white: "#b1bac4", brightWhite: "#f0f6fc",
      },
      fontFamily: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace",
      fontSize: 13,
      lineHeight: 1.4,
      cursorBlink: true,
      scrollback: 5000,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);
    fit.fit();

    termRef.current = term;
    fitRef.current = fit;

    const { cols, rows } = term;
    invoke("pty_create", { id, cwd, cols, rows }).catch(e => {
      term.write(`\r\n\x1b[31mFailed to start terminal: ${e}\x1b[0m\r\n`);
    });

    // send keystrokes to PTY
    term.onData(data => { invoke("pty_write", { id, data }).catch(() => {}); });

    // receive PTY output
    const unlisten = listen<string>(`pty-output-${id}`, e => {
      term.write(e.payload);
    });

    // resize observer
    const ro = new ResizeObserver(() => {
      fit.fit();
      invoke("pty_resize", { id, cols: term.cols, rows: term.rows }).catch(() => {});
    });
    if (containerRef.current) ro.observe(containerRef.current);

    return () => {
      unlisten.then(f => f());
      ro.disconnect();
      term.dispose();
      invoke("pty_kill", { id }).catch(() => {});
      createdRef.current = false;
    };
  }, [id, cwd]);

  // refit when visibility changes
  useEffect(() => {
    if (visible && fitRef.current) {
      setTimeout(() => fitRef.current?.fit(), 50);
    }
  }, [visible]);

  return (
    <div
      ref={containerRef}
      style={{ width: "100%", height: "100%", display: visible ? "block" : "none" }}
    />
  );
}
