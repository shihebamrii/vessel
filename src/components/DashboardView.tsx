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
        
        // Quick approximate CPU percentage
        // In a true implementation, we compare this poll's state with the previous poll's state.
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

  // Trigger fetch immediately on mount or serverId change, then poll
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

  return (
    <div class="dashboard-view">
      <div class="mb-6 flex justify-between items-center">
        <div>
          <h2 class="text-2xl font-semibold flex items-center gap-2">
            <Server class="text-accent-cyan" size={24} /> {hostname()}
          </h2>
          <p class="text-sm text-text-secondary mt-1">{osRelease()}</p>
        </div>
        <div class="glass-panel px-4 py-2 flex items-center gap-2 text-sm text-text-secondary">
          <Clock size={16} class="text-accent-indigo" />
          <span>Uptime: <strong class="text-text-primary">{uptime()}</strong></span>
        </div>
      </div>

      {errorMsg() && (
        <div class="glass-panel p-4 mb-6 border-accent-danger bg-red-950/20 text-accent-danger text-sm flex items-center gap-2">
          <span>⚠️ {errorMsg()}</span>
        </div>
      )}

      {/* Grid Layout of indicators */}
      <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* CPU Panel */}
        <div class="glass-panel p-6 flex flex-col justify-between">
          <div class="flex justify-between items-start mb-4">
            <div>
              <p class="text-sm font-semibold text-text-secondary">CPU Usage</p>
              <h3 class="text-3xl font-bold mt-1 text-text-primary">{cpuUsage()}%</h3>
            </div>
            <div class="p-3 rounded-lg bg-accent-cyan/10 text-accent-cyan">
              <Cpu size={24} />
            </div>
          </div>
          <div class="w-full bg-slate-800/80 h-2.5 rounded-full overflow-hidden">
            <div 
              class="h-full bg-gradient-to-r from-accent-cyan to-accent-indigo transition-all duration-500"
              style={{ width: `${cpuUsage()}%` }}
            />
          </div>
        </div>

        {/* Memory Panel */}
        <div class="glass-panel p-6 flex flex-col justify-between">
          <div class="flex justify-between items-start mb-4">
            <div>
              <p class="text-sm font-semibold text-text-secondary">Memory Usage</p>
              <h3 class="text-3xl font-bold mt-1 text-text-primary">
                {memUsed()} <span class="text-lg font-normal text-text-muted">/ {memTotal()} MB</span>
              </h3>
            </div>
            <div class="p-3 rounded-lg bg-accent-indigo/10 text-accent-indigo">
              <MemIcon size={24} />
            </div>
          </div>
          <div class="w-full bg-slate-800/80 h-2.5 rounded-full overflow-hidden">
            <div 
              class="h-full bg-gradient-to-r from-accent-indigo to-accent-purple transition-all duration-500"
              style={{ width: `${memTotal() > 0 ? (memUsed() / memTotal()) * 100 : 0}%` }}
            />
          </div>
        </div>

        {/* Disk Panel */}
        <div class="glass-panel p-6 flex flex-col justify-between">
          <div class="flex justify-between items-start mb-4">
            <div>
              <p class="text-sm font-semibold text-text-secondary">Disk Usage (Root)</p>
              <h3 class="text-3xl font-bold mt-1 text-text-primary">
                {diskUsed()} <span class="text-lg font-normal text-text-muted">/ {diskTotal()}</span>
              </h3>
            </div>
            <div class="p-3 rounded-lg bg-accent-purple/10 text-accent-purple">
              <HardDrive size={24} />
            </div>
          </div>
          <div class="w-full bg-slate-800/80 h-2.5 rounded-full overflow-hidden">
            <div 
              class="h-full bg-gradient-to-r from-accent-purple to-pink-500 transition-all duration-500"
              style={{ width: `${diskPercent()}%` }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
