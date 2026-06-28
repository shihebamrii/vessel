import { createSignal, onCleanup, createEffect } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { Cpu, HardDrive, Cpu as MemIcon, Server, Clock } from "lucide-solid";

interface DashboardProps {
  serverId: string;
  showToast: (message: string, type?: "success" | "error" | "info") => void;
}

export default function DashboardView(props: DashboardProps) {
  const cpuHistory = new Map<string, { total: number; idle: number }>();
  const [cpuUsage, setCpuUsage] = createSignal(0);
  const [memTotal, setMemTotal] = createSignal(0);
  const [memUsed, setMemUsed] = createSignal(0);
  const [diskTotal, setDiskTotal] = createSignal("0G");
  const [diskUsed, setDiskUsed] = createSignal("0G");
  const [diskPercent, setDiskPercent] = createSignal(0);
  const [hostname, setHostname] = createSignal("Loading...");
  const [osRelease, setOsRelease] = createSignal("Loading...");
  const [uptime, setUptime] = createSignal("Loading...");
  const [errorMsg, setErrorMsg] = createSignal("");

  let timerId: any = null;
  let active = true;

  const fetchStats = async () => {
    try {
      // Gather system details in one go to minimize network overhead
      const cmd = `hostname && uname -snrv && uptime -p && free -m && df -h / | tail -n 1 && cat /proc/stat | head -n 1`;
      const res: any = await invoke("execute_command", { serverId: props.serverId, command: cmd });
      
      if (res.exit_code !== 0) {
        setErrorMsg(`Failed to poll server stats: ${res.stderr}`);
        return;
      }

      setErrorMsg("");
      const lines = res.stdout.split("\n");
      if (lines.length < 5) return;

      // Line 0: Hostname
      setHostname(lines[0].trim());

      // Line 1: OS Release
      setOsRelease(lines[1].trim());

      // Line 2: Uptime
      setUptime(lines[2].trim().replace("up ", ""));

      // Find free output and df output from lines
      let freeLine = "";
      let dfLine = "";
      let statLine = "";

      for (const line of lines) {
        if (line.startsWith("Mem:")) {
          freeLine = line;
        } else if (line.includes("/") && (line.includes("G") || line.includes("M") || line.includes("%"))) {
          dfLine = line;
        } else if (line.startsWith("cpu ")) {
          statLine = line;
        }
      }

      // Parse Memory
      if (freeLine) {
        const memParts = freeLine.split(/\s+/);
        const total = parseInt(memParts[1]);
        const used = parseInt(memParts[2]);
        if (!isNaN(total) && !isNaN(used)) {
          setMemTotal(total);
          setMemUsed(used);
        }
      }

      // Parse Disk
      if (dfLine) {
        const diskParts = dfLine.split(/\s+/);
        if (diskParts.length >= 5) {
          setDiskTotal(diskParts[1]);
          setDiskUsed(diskParts[2]);
          setDiskPercent(parseInt(diskParts[4].replace("%", "")) || 0);
        }
      }

      // Parse CPU (using a simple delta system)
      if (statLine) {
        const cpuParts = statLine.split(/\s+/).slice(1).map(Number);
        const idle = cpuParts[3] || 0;
        const total = cpuParts.reduce((a, b) => a + b, 0);
        
        const prev = cpuHistory.get(props.serverId) || { total: 0, idle: 0 };
        const prevTotal = prev.total;
        const prevIdle = prev.idle;

        const totalDiff = total - prevTotal;
        const idleDiff = idle - prevIdle;

        if (totalDiff > 0) {
          const usage = Math.round((1.0 - (idleDiff / totalDiff)) * 100);
          setCpuUsage(Math.max(0, Math.min(100, usage)));
        }

        cpuHistory.set(props.serverId, { total, idle });
      }

    } catch (e: any) {
      setErrorMsg(`Connection error: ${e.toString()}`);
    }
  };

  const pollStats = async () => {
    if (!active) return;
    await fetchStats();
    if (active) {
      timerId = setTimeout(pollStats, 3000);
    }
  };

  createEffect(() => {
    props.serverId; // Track serverId change explicitly
    active = true;
    if (timerId) {
      clearTimeout(timerId);
      timerId = null;
    }
    pollStats();
  });

  onCleanup(() => {
    active = false;
    if (timerId) clearTimeout(timerId);
  });

  // Visual helper to generate terminal-like progress indicators: [████░░░░]
  const renderVisualBar = (pct: number, activeClass: string) => {
    const barsCount = 20;
    const filled = Math.round((pct / 100) * barsCount);
    
    let filledStr = "";
    for (let i = 0; i < filled; i++) {
      filledStr += "█";
    }
    
    let unfilledStr = "";
    for (let i = filled; i < barsCount; i++) {
      unfilledStr += "░";
    }
    
    return (
      <span class="font-mono text-xs select-none">
        <span class={activeClass}>{filledStr}</span>
        <span class="text-text-muted opacity-25">{unfilledStr}</span>
      </span>
    );
  };

  return (
    <div class="dashboard-view flex-1 flex flex-col min-h-0">
      <div class="mb-4 flex flex-col md:flex-row justify-between items-start md:items-center gap-3 pb-3 border-b border-white/5">
        <div>
          <h2 class="text-sm font-bold flex items-center gap-2 uppercase font-mono">
            <Server class="text-accent-cyan" size={14} /> SYSTEM HOSTNAME: {hostname()}
          </h2>
          <p class="text-xs text-text-secondary font-mono mt-0.5">{osRelease()}</p>
        </div>
        <div class="bg-dark-panel border px-3 py-1.5 flex items-center gap-2 text-xs font-mono">
          <Clock size={13} class="text-accent-indigo" />
          <span>UPTIME: <strong class="text-text-primary">{uptime()}</strong></span>
        </div>
      </div>

      {errorMsg() && (
        <div class="glass-panel p-3 mb-4 border-accent-danger bg-red-950/20 text-accent-danger text-xs flex items-center gap-2">
          <span>⚠️ {errorMsg()}</span>
        </div>
      )}

      {/* Grid Layout of indicators */}
      <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
        {/* CPU Panel */}
        <div class="glass-panel p-4 flex flex-col justify-between">
          <div class="flex justify-between items-start mb-3">
            <div>
              <p class="text-xs font-bold text-text-secondary uppercase font-mono">CPU Core Load</p>
              <h3 class="text-xl font-bold mt-1 text-text-primary font-mono">{cpuUsage()}%</h3>
            </div>
            <div class="text-accent-cyan shrink-0 flex items-center">
              <Cpu size={14} />
            </div>
          </div>
          <div class="mt-2 flex justify-between items-center bg-[#040507] border p-2 rounded-sm">
            {renderVisualBar(cpuUsage(), "text-accent-cyan")}
            <span class="text-accent-cyan font-mono text-xs font-semibold">{cpuUsage()}%</span>
          </div>
        </div>

        {/* Memory Panel */}
        <div class="glass-panel p-4 flex flex-col justify-between">
          <div class="flex justify-between items-start mb-3">
            <div>
              <p class="text-xs font-bold text-text-secondary uppercase font-mono">Physical RAM</p>
              <h3 class="text-xl font-bold mt-1 text-text-primary font-mono">
                {memUsed()} <span class="text-xs font-normal text-text-muted">/ {memTotal()} MB</span>
              </h3>
            </div>
            <div class="text-accent-indigo shrink-0 flex items-center">
              <MemIcon size={14} />
            </div>
          </div>
          <div class="mt-2 flex justify-between items-center bg-[#040507] border p-2 rounded-sm">
            {renderVisualBar(memTotal() > 0 ? (memUsed() / memTotal()) * 100 : 0, "text-accent-indigo")}
            <span class="text-accent-indigo font-mono text-xs font-semibold">
              {memTotal() > 0 ? Math.round((memUsed() / memTotal()) * 100) : 0}%
            </span>
          </div>
        </div>

        {/* Disk Panel */}
        <div class="glass-panel p-4 flex flex-col justify-between">
          <div class="flex justify-between items-start mb-3">
            <div>
              <p class="text-xs font-bold text-text-secondary uppercase font-mono">Storage Root (df /)</p>
              <h3 class="text-xl font-bold mt-1 text-text-primary font-mono">
                {diskUsed()} <span class="text-xs font-normal text-text-muted">/ {diskTotal()}</span>
              </h3>
            </div>
            <div class="text-accent-purple shrink-0 flex items-center">
              <HardDrive size={14} />
            </div>
          </div>
          <div class="mt-2 flex justify-between items-center bg-[#040507] border p-2 rounded-sm">
            {renderVisualBar(diskPercent(), "text-accent-purple")}
            <span class="text-accent-purple font-mono text-xs font-semibold">{diskPercent()}%</span>
          </div>
        </div>
      </div>

      {/* Detailed Technical Inventory */}
      <div class="glass-panel p-4 flex-1 overflow-y-auto">
        <h4 class="text-[10px] uppercase font-bold text-text-secondary tracking-wider font-mono mb-3 pb-1 border-b">
          SYSTEM TELEMETRY SUMMARY
        </h4>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-1 font-mono text-xs">
          <div class="telemetry-item">
            <span class="telemetry-label">Hostname</span>
            <span class="telemetry-value">{hostname()}</span>
          </div>
          <div class="telemetry-item">
            <span class="telemetry-label">OS Kernel Release</span>
            <span class="telemetry-value">{osRelease()}</span>
          </div>
          <div class="telemetry-item">
            <span class="telemetry-label">Total Allocated RAM</span>
            <span class="telemetry-value">{memTotal()} MB</span>
          </div>
          <div class="telemetry-item">
            <span class="telemetry-label">Free RAM Space</span>
            <span class="telemetry-value">{memTotal() - memUsed()} MB</span>
          </div>
          <div class="telemetry-item">
            <span class="telemetry-label">Mount Storage Capacity</span>
            <span class="telemetry-value">{diskTotal()}</span>
          </div>
          <div class="telemetry-item">
            <span class="telemetry-label">Mount Storage Utilized</span>
            <span class="telemetry-value">{diskUsed()} ({diskPercent()}%)</span>
          </div>
        </div>
      </div>
    </div>
  );
}
