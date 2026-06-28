import { onCleanup, createEffect } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { Terminal as TermIcon, RotateCcw } from "lucide-solid";

interface TerminalProps {
  serverId: string;
  showToast: (message: string, type?: "success" | "error" | "info") => void;
}

export default function TerminalView(props: TerminalProps) {
  let terminalContainer: HTMLDivElement | undefined;
  let term: Terminal | undefined;
  let fitAddon: FitAddon | undefined;
  let unlisten: (() => void) | undefined;
  let resizeListener: (() => void) | undefined;
  let terminalId = `term-${props.serverId}-${Math.floor(Math.random() * 1000)}`;

  const initTerminal = async () => {
    if (!terminalContainer) return;

    // Clean up if already initialized
    if (term) {
      term.dispose();
      term = undefined;
    }
    if (unlisten) {
      unlisten();
      unlisten = undefined;
    }
    if (resizeListener) {
      resizeListener();
      resizeListener = undefined;
    }

    try {
      await invoke("close_terminal_session", { terminalId });
    } catch (err) {
      console.warn("Failed to close old terminal session:", err);
    }

    // Configure xterm
    term = new Terminal({
      theme: {
        background: "#080c14",
        foreground: "#f1f5f9",
        cursor: "#38bdf8",
        black: "#020617",
        red: "#ef4444",
        green: "#22c55e",
        yellow: "#eab308",
        blue: "#3b82f6",
        magenta: "#a855f7",
        cyan: "#06b6d4",
        white: "#f8fafc",
      },
      fontFamily: "Fira Code, SFMono-Regular, Consolas, monospace",
      fontSize: 14,
      cursorBlink: true,
      lineHeight: 1.2,
    });

    fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(terminalContainer);
    fitAddon.fit();

    term.write("Connecting to interactive terminal session...\r\n");

    try {
      // 1. Start the PTY session on the backend
      await invoke("start_terminal_session", {
        serverId: props.serverId,
        terminalId: terminalId,
      });

      // 2. Listen to output events from the backend PTY
      unlisten = await listen<string>(`terminal-data:${terminalId}`, (event) => {
        if (term) {
          term.write(event.payload);
        }
      });

      // 3. Send inputs from xterm keystrokes back to the backend
      term.onData((data) => {
        invoke("write_terminal_data", {
          terminalId: terminalId,
          data: data,
        }).catch((err) => {
          if (term) term.write(`\r\n[Error writing terminal input: ${err}]\r\n`);
        });
      });

      // Handle terminal resizing
      const handleResize = () => {
        if (fitAddon && term) {
          fitAddon.fit();
          invoke("resize_terminal_session", {
            terminalId: terminalId,
            cols: term.cols,
            rows: term.rows,
          }).catch((err) => {
            console.warn("Failed to notify backend of terminal resize:", err);
          });
        }
      };
      window.addEventListener("resize", handleResize);
      setTimeout(handleResize, 200);
      resizeListener = () => window.removeEventListener("resize", handleResize);

    } catch (e: any) {
      term.write(`\r\nFailed to start terminal session: ${e.toString()}\r\n`);
    }
  };

  // Re-run connection when server ID changes
  createEffect(() => {
    initTerminal();
  });

  onCleanup(() => {
    if (term) term.dispose();
    if (unlisten) unlisten();
    if (resizeListener) resizeListener();
    invoke("close_terminal_session", { terminalId }).catch(console.error);
  });

  return (
    <div class="h-full flex flex-col">
      <div class="mb-4 flex justify-between items-center">
        <div class="flex items-center gap-2">
          <TermIcon class="text-accent-cyan" size={22} />
          <h2 class="text-xl font-semibold">Interactive Shell</h2>
        </div>
        <button class="btn-secondary px-3 py-1.5 text-sm" onClick={initTerminal}>
          <RotateCcw size={14} /> Restart Session
        </button>
      </div>
      <div 
        class="flex-1 w-full p-4 rounded-xl border border-white/5 bg-dark-panel overflow-hidden" 
        style={{ height: "calc(100vh - 180px)" }}
      >
        <div ref={terminalContainer} class="w-full h-full" />
      </div>
    </div>
  );
}
