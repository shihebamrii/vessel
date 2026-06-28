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
        background: "#040507",
        foreground: "#f5f6f8",
        cursor: "#0091ff",
        black: "#07080a",
        red: "#ff453a",
        green: "#30d158",
        yellow: "#ff9f0a",
        blue: "#5856d6",
        magenta: "#af52de",
        cyan: "#0091ff",
        white: "#f5f6f8",
      },
      fontFamily: "JetBrains Mono, Fira Code, Consolas, monospace",
      fontSize: 13,
      cursorBlink: true,
      lineHeight: 1.25,
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
      <div class="mb-3 flex justify-between items-center pb-2 border-b">
        <div class="flex items-center gap-2">
          <TermIcon class="text-accent-cyan" size={13} />
          <h2 class="text-xs font-bold uppercase tracking-wider font-mono">PTY TERMINAL // SSH CONNECTION</h2>
        </div>
        <button class="btn-secondary px-2.5 py-1 text-xs" onClick={initTerminal}>
          <RotateCcw size={11} /> Restart Session
        </button>
      </div>
      <div 
        class="flex-1 w-full p-2.5 rounded-sm border bg-[#040507] overflow-hidden" 
        style={{ height: "calc(100vh - 160px)" }}
      >
        <div ref={terminalContainer} class="w-full h-full font-mono" />
      </div>
    </div>
  );
}
