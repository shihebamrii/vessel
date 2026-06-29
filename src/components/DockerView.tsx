import { createSignal, createEffect, For, Show, onCleanup } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { RotateCw, Play, Square, FileText, Activity, Loader, AlertTriangle, Terminal, Pause, Search, Trash2 } from "lucide-solid";


interface DockerProps {
  serverId: string;
  showToast: (message: string, type?: "success" | "error" | "info") => void;
}

interface ContainerInfo {
  id: string;
  name: string;
  status: string;
  image: string;
}

export default function DockerView(props: DockerProps) {
  const [containers, setContainers] = createSignal<ContainerInfo[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [filterQuery, setFilterQuery] = createSignal("");
  const [selectedContainer, setSelectedContainer] = createSignal<string | null>(null);
  const [containerLogs, setContainerLogs] = createSignal("");
  const [errorMsg, setErrorMsg] = createSignal("");

  const [viewMode, setViewMode] = createSignal<"list" | "multilogs">("list");
  const [selectedForLogs, setSelectedForLogs] = createSignal<string[]>([]);
  const [isTailing, setIsTailing] = createSignal(false);
  const [searchQuery, setSearchQuery] = createSignal("");

  interface LogEntry {
    id: number;
    container: string;
    text: string;
  }
  const [logEntries, setLogEntries] = createSignal<LogEntry[]>([]);
  const [autoScroll, setAutoScroll] = createSignal(true);

  // New Docker installation and creation states
  const [isDockerInstalled, setIsDockerInstalled] = createSignal(true);
  const [isCheckingDocker, setIsCheckingDocker] = createSignal(true);
  const [isInstalling, setIsInstalling] = createSignal(false);
  const [installLogs, setInstallLogs] = createSignal("");

  const [showRunModal, setShowRunModal] = createSignal(false);
  const [newContainerName, setNewContainerName] = createSignal("");
  const [newContainerImage, setNewContainerImage] = createSignal("");
  const [newContainerPorts, setNewContainerPorts] = createSignal("");
  const [newContainerEnv, setNewContainerEnv] = createSignal("");
  const [newContainerRestart, setNewContainerRestart] = createSignal("unless-stopped");
  const [isCreating, setIsCreating] = createSignal(false);

  const checkDockerInstalled = async () => {
    setIsCheckingDocker(true);
    try {
      const res: any = await invoke("execute_command", { 
        serverId: props.serverId, 
        command: "which docker" 
      });
      const installed = res.exit_code === 0 && res.stdout.trim().length > 0;
      setIsDockerInstalled(installed);
      return installed;
    } catch (e) {
      console.error("Docker check error:", e);
      setIsDockerInstalled(false);
      return false;
    } finally {
      setIsCheckingDocker(false);
    }
  };

  let unlistenInstall: (() => void) | undefined;

  const handleInstallDocker = async () => {
    setIsInstalling(true);
    setInstallLogs("Initializing Docker installation script...\n");

    const installStreamId = `install-${props.serverId}-${Math.floor(Math.random() * 1000)}`;
    const cmd = "curl -fsSL https://get.docker.com -o get-docker.sh && sudo sh get-docker.sh && sudo usermod -aG docker $USER && rm get-docker.sh";

    try {
      unlistenInstall = await listen<string>(`command-stream:${installStreamId}`, (event) => {
        setInstallLogs((prev) => prev + event.payload);

        // Auto-scroll the install logs console
        if (logsConsoleRef) {
          logsConsoleRef.scrollTop = logsConsoleRef.scrollHeight;
        }

        if (event.payload.includes("[Exit Code:")) {
          const success = event.payload.includes("[Exit Code: 0]");
          setTimeout(async () => {
            setIsInstalling(false);
            if (unlistenInstall) {
              unlistenInstall();
              unlistenInstall = undefined;
            }
            if (success) {
              props.showToast("Docker installed successfully!", "success");
              const installed = await checkDockerInstalled();
              if (installed) {
                fetchContainers();
              }
            } else {
              props.showToast("Docker installation failed. Please check the logs.", "error");
            }
          }, 1000);
        }
      });

      await invoke("start_command_stream", {
        serverId: props.serverId,
        streamId: installStreamId,
        command: cmd,
      });

    } catch (e: any) {
      setIsInstalling(false);
      setInstallLogs((prev) => prev + `\nInstallation Error: ${e.toString()}\n`);
      props.showToast(`Installation startup failed: ${e.toString()}`, "error");
      if (unlistenInstall) {
        unlistenInstall();
        unlistenInstall = undefined;
      }
    }
  };

  const escapeShellArg = (val: string) => {
    return "'" + val.replace(/'/g, "'\\''") + "'";
  };

  const handleRunContainer = async (e: Event) => {
    e.preventDefault();
    if (!newContainerImage().trim()) {
      props.showToast("Image name is required", "error");
      return;
    }

    setIsCreating(true);
    try {
      let runCmd = "docker run -d";

      const name = newContainerName().trim();
      if (name) {
        if (!/^[a-zA-Z0-9_.-]+$/.test(name)) {
          props.showToast("Invalid container name (alphanumeric, dots, hyphens, underscores only)", "error");
          setIsCreating(false);
          return;
        }
        runCmd += ` --name ${escapeShellArg(name)}`;
      }

      const ports = newContainerPorts().trim();
      if (ports) {
        if (!/^[0-9:a-zA-Z/.-]+$/.test(ports)) {
          props.showToast("Invalid port mapping format", "error");
          setIsCreating(false);
          return;
        }
        runCmd += ` -p ${escapeShellArg(ports)}`;
      }

      const restart = newContainerRestart();
      runCmd += ` --restart ${escapeShellArg(restart)}`;

      const envLines = newContainerEnv().split("\n");
      for (const line of envLines) {
        const trimmed = line.trim();
        if (trimmed) {
          const eqIndex = trimmed.indexOf("=");
          if (eqIndex > 0) {
            const key = trimmed.substring(0, eqIndex).trim();
            const val = trimmed.substring(eqIndex + 1).trim();
            if (!/^[a-zA-Z0-9_]+$/.test(key)) {
              props.showToast(`Invalid env variable name: ${key}`, "error");
              setIsCreating(false);
              return;
            }
            runCmd += ` -e ${key}=${escapeShellArg(val)}`;
          } else {
            props.showToast(`Env variable must be in KEY=VALUE format: ${trimmed}`, "error");
            setIsCreating(false);
            return;
          }
        }
      }

      const image = newContainerImage().trim();
      if (!/^[a-zA-Z0-9_/.:-]+$/.test(image)) {
        props.showToast("Invalid image name", "error");
        setIsCreating(false);
        return;
      }
      runCmd += ` ${escapeShellArg(image)}`;

      const res: any = await invoke("execute_command", {
        serverId: props.serverId,
        command: runCmd,
      });

      if (res.exit_code === 0) {
        props.showToast(`Container started successfully!`, "success");
        setShowRunModal(false);
        setNewContainerName("");
        setNewContainerImage("");
        setNewContainerPorts("");
        setNewContainerEnv("");
        setNewContainerRestart("unless-stopped");
        fetchContainers();
      } else {
        props.showToast(`Failed to run container: ${res.stderr}`, "error");
      }
    } catch (e: any) {
      props.showToast(`Error: ${e.toString()}`, "error");
    } finally {
      setIsCreating(false);
    }
  };

  let currentStreamId = `logs-${props.serverId}-${Math.floor(Math.random() * 1000)}`;
  let unlistenLogs: (() => void) | undefined;
  let logsConsoleRef: HTMLDivElement | undefined;

  const colorMap = [
    "text-accent-cyan",
    "text-accent-indigo",
    "text-accent-purple",
    "text-accent-success",
    "text-accent-warning",
  ];

  const getContainerColor = (name: string) => {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    const index = Math.abs(hash) % colorMap.length;
    return colorMap[index];
  };

  const selectAllContainers = () => {
    const active = containers().filter(c => c.status.startsWith("Up")).map(c => c.name);
    setSelectedForLogs(active);
  };

  const selectNoContainers = () => {
    setSelectedForLogs([]);
  };

  const toggleContainerSelection = (name: string) => {
    if (selectedForLogs().includes(name)) {
      setSelectedForLogs((prev) => prev.filter((n) => n !== name));
    } else {
      setSelectedForLogs((prev) => [...prev, name]);
    }
  };

  let partialLine = "";
  const appendLogChunk = (chunk: string) => {
    const rawLines = (partialLine + chunk).split("\n");
    partialLine = rawLines.pop() || "";

    const newEntries: LogEntry[] = [];
    let nextId = Date.now() + Math.random();

    for (const rawLine of rawLines) {
      const line = rawLine.trim();
      if (!line) continue;

      const match = line.match(/^\[([^\]]+)\] (.*)$/);
      if (match) {
        newEntries.push({
          id: nextId++,
          container: match[1],
          text: match[2],
        });
      } else {
        newEntries.push({
          id: nextId++,
          container: "system",
          text: line,
        });
      }
    }

    if (newEntries.length > 0) {
      setLogEntries((prev) => {
        const combined = [...prev, ...newEntries];
        if (combined.length > 1000) {
          return combined.slice(combined.length - 1000);
        }
        return combined;
      });
    }
  };

  const startTailing = async () => {
    if (selectedForLogs().length === 0) {
      props.showToast("Please select at least one container", "info");
      return;
    }

    await stopTailing();

    setIsTailing(true);
    setLogEntries([]);
    partialLine = "";

    currentStreamId = `logs-${props.serverId}-${Math.floor(Math.random() * 1000)}`;

    try {
      unlistenLogs = await listen<string>(`container-logs:${currentStreamId}`, (event) => {
        appendLogChunk(event.payload);
      });

      await invoke("start_container_logs_stream", {
        serverId: props.serverId,
        streamId: currentStreamId,
        containers: selectedForLogs(),
      });

      props.showToast("Started tailing container logs", "success");
    } catch (e: any) {
      console.error("Failed to start tailing logs:", e);
      props.showToast(`Error: ${e.toString()}`, "error");
      setIsTailing(false);
      if (unlistenLogs) {
        unlistenLogs();
        unlistenLogs = undefined;
      }
    }
  };

  const stopTailing = async () => {
    setIsTailing(false);
    if (unlistenLogs) {
      unlistenLogs();
      unlistenLogs = undefined;
    }
    try {
      await invoke("stop_container_logs_stream", { streamId: currentStreamId });
    } catch (e) {
      console.warn("Failed to stop logs stream:", e);
    }
  };

  const filteredLogEntries = () => {
    const query = searchQuery().toLowerCase().trim();
    if (!query) return logEntries();
    return logEntries().filter(
      (entry) =>
        entry.text.toLowerCase().includes(query) ||
        entry.container.toLowerCase().includes(query)
    );
  };

  const escapeRegExp = (string: string) => {
    return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  };

  const renderLogText = (text: string, query: string) => {
    if (!query) return text;
    const parts = text.split(new RegExp(`(${escapeRegExp(query)})`, "gi"));
    return (
      <For each={parts}>
        {(part) =>
          part.toLowerCase() === query.toLowerCase() ? (
            <mark class="bg-yellow-500/30 text-white rounded px-0.5">{part}</mark>
          ) : (
            part
          )
        }
      </For>
    );
  };

  createEffect(() => {
    if (autoScroll() && logsConsoleRef && logEntries().length > 0) {
      logsConsoleRef.scrollTop = logsConsoleRef.scrollHeight;
    }
  });

  onCleanup(() => {
    stopTailing();
  });

  // Fetch docker container stats
  const fetchContainers = async () => {
    setLoading(true);
    setErrorMsg("");
    try {
      const cmd = "docker ps -a --format '{{.ID}}\\t{{.Names}}\\t{{.Status}}\\t{{.Image}}'";
      const res: any = await invoke("execute_command", { serverId: props.serverId, command: cmd });
      
      if (res.exit_code !== 0) {
        console.error(`Failed to fetch Docker containers: ${res.stderr}`);
        setErrorMsg(`Failed to fetch Docker containers: ${res.stderr}`);
        return;
      }

      const list: ContainerInfo[] = [];
      for (const line of res.stdout.split("\n")) {
        const parts = line.trim().split("\t");
        if (parts.length >= 4) {
          list.push({
            id: parts[0],
            name: parts[1],
            status: parts[2],
            image: parts[3],
          });
        }
      }
      setContainers(list);
    } catch (e: any) {
      console.error(`Docker error: ${e.toString()}`);
      setErrorMsg(`Docker error: ${e.toString()}`);
    } finally {
      setLoading(false);
    }
  };

  // Run docker start/stop/restart
  const handleContainerAction = async (name: string, action: "start" | "stop" | "restart") => {
    try {
      setLoading(true);
      await invoke("control_container", { serverId: props.serverId, name, action });
      props.showToast(`Container ${name} ${action}ed!`, "success");
      fetchContainers();
      if (selectedContainer() === name) {
        fetchLogs(name);
      }
    } catch (e: any) {
      props.showToast(`Error: ${e.toString()}`, "error");
      fetchContainers();
    }
  };

  // Fetch docker logs
  const fetchLogs = async (name: string) => {
    setSelectedContainer(name);
    setContainerLogs("Fetching container stdout/stderr...");
    try {
      const logs: string = await invoke("get_container_logs", { serverId: props.serverId, name });
      setContainerLogs(logs || "No container logs output.");
    } catch (e: any) {
      setContainerLogs(`Error: ${e.toString()}`);
      props.showToast(`Failed to fetch logs: ${e.toString()}`, "error");
    }
  };

  createEffect(async () => {
    props.serverId; // Track serverId change
    stopTailing();
    setLogEntries([]);
    setSelectedForLogs([]);
    setViewMode("list");
    const installed = await checkDockerInstalled();
    if (installed) {
      fetchContainers();
    }
  });

  const filteredContainers = () => {
    return containers().filter((c) => 
      c.name.toLowerCase().includes(filterQuery().toLowerCase()) ||
      c.image.toLowerCase().includes(filterQuery().toLowerCase())
    );
  };

  return (
    <div class="h-full flex flex-col min-h-0" style={{ height: "calc(100vh - 120px)" }}>
      <div class="mb-3 flex flex-wrap justify-between items-center gap-2 pb-2 border-b">
        <div class="flex items-center gap-1.5">
          <Activity class="text-accent-cyan" size={13} />
          <h2 class="text-xs font-bold uppercase tracking-wider font-mono">CONTAINER SUPERVISOR // DOCKER DAEMON</h2>
        </div>
        <div class="flex gap-2 shrink-0 items-center">
          <div class="tab-segment-container w-48 mr-2">
            <button 
              class={`tab-segment-button ${viewMode() === "list" ? "active" : ""}`}
              onClick={() => { stopTailing(); setViewMode("list"); }}
            >
              List View
            </button>
            <button 
              class={`tab-segment-button ${viewMode() === "multilogs" ? "active" : ""}`}
              onClick={() => { setViewMode("multilogs"); selectAllContainers(); }}
            >
              Live Logs
            </button>
          </div>
          <Show when={viewMode() === "list"}>
            <input
              type="text"
              placeholder="Filter containers..."
              value={filterQuery()}
              onInput={(e) => setFilterQuery(e.currentTarget.value)}
              class="text-xs py-1 w-40 font-mono"
            />
            <button class="btn-secondary text-xs py-1" onClick={fetchContainers}>
              <RotateCw size={12} /> Refresh
            </button>
            <button class="btn-primary text-xs py-1 px-3" onClick={() => setShowRunModal(true)}>
              + Run Container
            </button>
          </Show>
        </div>
      </div>

      <Show when={errorMsg()}>
        <div class="glass-panel p-3 mb-3 border-accent-danger bg-red-950/20 text-accent-danger text-xs flex gap-2">
          <AlertTriangle size={13} class="shrink-0" />
          <span>{errorMsg()}</span>
        </div>
      </Show>

      <Show when={!isCheckingDocker()} fallback={
        <div class="flex-1 flex flex-col justify-center items-center py-12">
          <Loader class="animate-spin text-accent-cyan mb-2" size={24} />
          <span class="text-xs font-mono uppercase text-text-secondary">Probing remote host for Docker runtime...</span>
        </div>
      }>
        <Show when={isDockerInstalled()} fallback={
          <div class="flex-1 flex flex-col min-h-0">
            <Show when={isInstalling()} fallback={
              <div class="max-w-xl mx-auto glass-panel p-6 mt-8 flex flex-col gap-4 select-text">
                <div class="flex items-start gap-4">
                  <AlertTriangle class="text-accent-warning shrink-0" size={32} />
                  <div>
                    <h3 class="text-sm font-bold uppercase tracking-wider font-mono text-text-primary mb-1">Docker Daemon Not Found</h3>
                    <p class="text-xs text-text-secondary leading-relaxed">
                      Vessel requires Docker to be installed on your VPS to supervise containers.
                      We can automatically install the official Docker community edition and dependencies for you.
                    </p>
                  </div>
                </div>
                
                <div class="border-t border-b py-3 my-1 space-y-2 text-xs font-mono text-text-secondary">
                  <div class="flex items-center gap-2">
                    <span class="status-dot shrink-0 active" />
                    <span>Downloads & runs the official Docker install script</span>
                  </div>
                  <div class="flex items-center gap-2">
                    <span class="status-dot shrink-0 active" />
                    <span>Installs Docker engine (`docker-ce`) and Compose CLI</span>
                  </div>
                  <div class="flex items-center gap-2">
                    <span class="status-dot shrink-0 active" />
                    <span>Adds current login user to `docker` security group</span>
                  </div>
                </div>
                
                <div class="flex justify-end gap-2 mt-2">
                  <button class="btn-primary flex items-center gap-1.5 uppercase font-mono text-xs py-2 font-bold px-4" onClick={handleInstallDocker}>
                    <Play size={12} /> Install Docker & Compose
                  </button>
                </div>
              </div>
            }>
              <div class="flex-1 flex flex-col min-h-0">
                <div class="glass-panel p-4 mb-3 flex items-center justify-between border-accent-warning bg-accent-warning/5">
                  <div class="flex items-center gap-3">
                    <Loader class="animate-spin text-accent-warning shrink-0" size={16} />
                    <div>
                      <h4 class="text-xs font-bold font-mono text-accent-warning uppercase">Docker Installation In Progress</h4>
                      <p class="text-[11px] text-text-secondary mt-1">Please wait while Docker and Compose are installed on your VPS host. Do not disconnect.</p>
                    </div>
                  </div>
                </div>
                
                <div class="console-panel flex-1 min-h-0">
                  <div class="console-header flex justify-between items-center">
                    <span class="text-[10px] font-bold font-mono text-text-primary uppercase flex items-center gap-1.5">
                      <Terminal size={12} class="text-accent-warning" /> INSTALLER.stdout
                    </span>
                  </div>
                  <div ref={logsConsoleRef} class="console-body flex-1 overflow-y-auto bg-[#040507] p-3 text-[10px] font-mono whitespace-pre-wrap select-text text-slate-300">
                    {installLogs()}
                  </div>
                </div>
              </div>
            </Show>
          </div>
        }>
          <Show when={viewMode() === "list"} fallback={
            <div class="flex-1 flex flex-col min-h-0">
              <div class="grid grid-cols-1 md:grid-cols-4 gap-3 flex-1 min-h-0">
                {/* Sidebar: Checklist of containers */}
                <div class="glass-panel p-3 flex flex-col h-full overflow-hidden">
                  <div class="flex items-center justify-between mb-2 pb-1 border-b">
                    <span class="text-[10px] font-bold font-mono text-text-secondary uppercase">Select Containers</span>
                    <div class="flex gap-1.5">
                      <button class="text-[9px] font-mono px-1.5 py-0.5 btn-secondary uppercase" onClick={selectAllContainers}>All</button>
                      <button class="text-[9px] font-mono px-1.5 py-0.5 btn-secondary uppercase" onClick={selectNoContainers}>None</button>
                    </div>
                  </div>
                  <div class="flex-1 overflow-y-auto space-y-1.5 pr-1">
                    <For each={containers()}>
                      {(c) => (
                        <label class="flex items-center gap-2 p-1.5 rounded hover:bg-bg-hover cursor-pointer text-xs font-mono">
                          <input
                            type="checkbox"
                            checked={selectedForLogs().includes(c.name)}
                            onChange={() => toggleContainerSelection(c.name)}
                          />
                          <span class="truncate flex-1" title={c.name}>{c.name}</span>
                          <span class={`status-dot shrink-0 ${c.status.startsWith("Up") ? "active" : c.status.startsWith("Exited") ? "error" : "inactive"}`} />
                        </label>
                      )}
                    </For>
                  </div>
                </div>

                {/* Console panel: Streaming output */}
                <div class="md:col-span-3 flex flex-col min-h-0 h-full">
                  <div class="console-panel h-full flex flex-col">
                    <div class="console-header flex items-center justify-between flex-wrap gap-2">
                      <div class="flex items-center gap-2">
                        <Terminal size={12} class="text-accent-cyan" />
                        <span class="text-[10px] font-bold font-mono text-text-primary uppercase">MULTIPLE_CONTAINERS.log</span>
                      </div>

                      <div class="flex items-center gap-2">
                        <div class="relative flex items-center">
                          <input
                            type="text"
                            placeholder="Search logs..."
                            value={searchQuery()}
                            onInput={(e) => setSearchQuery(e.currentTarget.value)}
                            class="text-[10px] py-0.5 pl-6 w-36 font-mono"
                          />
                          <Search size={10} class="absolute left-2 text-text-secondary" />
                        </div>

                        <button
                          class={`btn-secondary text-[10px] py-1 font-mono uppercase flex items-center gap-1 ${isTailing() ? "border-accent-danger text-accent-danger" : ""}`}
                          onClick={isTailing() ? stopTailing : startTailing}
                        >
                          {isTailing() ? (
                            <>
                              <Pause size={10} /> Stop
                            </>
                          ) : (
                            <>
                              <Play size={10} /> Tail Logs
                            </>
                          )}
                        </button>

                        <button
                          class="btn-secondary text-[10px] py-1 font-mono uppercase flex items-center gap-1"
                          onClick={() => setLogEntries([])}
                          title="Clear Logs Panel"
                        >
                          <Trash2 size={10} /> Clear
                        </button>

                        <label class="flex items-center gap-1.5 text-[10px] font-mono text-text-secondary select-none cursor-pointer">
                          <input
                            type="checkbox"
                            checked={autoScroll()}
                            onChange={(e) => setAutoScroll(e.currentTarget.checked)}
                          />
                          Auto-scroll
                        </label>
                      </div>
                    </div>

                    <div ref={logsConsoleRef} class="console-body flex-1 overflow-y-auto font-mono text-[10px] bg-[#040507] p-3 space-y-1 select-text">
                      <Show when={logEntries().length === 0}>
                        <div class="text-center py-12 text-text-muted uppercase font-bold text-[10px] tracking-wider">
                          {isTailing() ? "Waiting for logs stream..." : "Select containers and click Tail Logs to start"}
                        </div>
                      </Show>

                      <For each={filteredLogEntries()}>
                        {(entry) => (
                          <div class="flex items-start gap-2 hover:bg-bg-hover/30 py-0.5 rounded px-1">
                            <span class={`shrink-0 font-bold ${getContainerColor(entry.container)} min-w-[70px] select-none text-right`}>
                              [{entry.container}]
                            </span>
                            <span class="text-text-primary whitespace-pre-wrap break-all flex-1">
                              {renderLogText(entry.text, searchQuery())}
                            </span>
                          </div>
                        )}
                      </For>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          }>
            <div class="split-pane">
              {/* Container list */}
              <div class="split-pane-main glass-panel p-3 overflow-hidden h-full">
                <div class="flex-1 overflow-auto pr-1">
                  <table class="dense-table">
                    <thead>
                      <tr>
                        <th class="text-left w-16">ID</th>
                        <th class="text-left w-1/3">Name</th>
                        <th class="text-left w-1/3">Image</th>
                        <th class="text-left">Status</th>
                        <th class="text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      <Show when={loading() && containers().length === 0}>
                        <tr>
                          <td colspan="5" class="py-8 text-center text-text-secondary">
                            <Loader class="animate-spin inline mr-1.5 text-accent-cyan" size={12} /> Reading containers...
                          </td>
                        </tr>
                      </Show>

                      <Show when={!loading() && filteredContainers().length === 0}>
                        <tr>
                          <td colspan="5" class="py-8 text-center text-text-muted uppercase font-bold tracking-wider text-[10px]">No Containers Found</td>
                        </tr>
                      </Show>

                      <For each={filteredContainers()}>
                        {(container) => (
                          <tr class={selectedContainer() === container.name ? "active" : ""}>
                            <td class="text-text-muted truncate max-w-[80px]">{container.id}</td>
                            <td class="font-semibold text-text-primary truncate max-w-xs">{container.name}</td>
                            <td class="text-text-secondary truncate max-w-xs" title={container.image}>{container.image}</td>
                            <td>
                              <span class="flex items-center gap-1.5">
                                <span class={`status-dot shrink-0 ${container.status.startsWith("Up") ? "active" : container.status.startsWith("Exited") ? "error" : "inactive"}`} />
                                <span class="uppercase text-[9px] font-bold text-text-secondary font-mono">{container.status.split(" ")[0]}</span>
                              </span>
                            </td>
                            <td class="text-right space-x-1">
                              {container.status.startsWith("Up") ? (
                                <button 
                                  class="btn-secondary p-1"
                                  onClick={() => handleContainerAction(container.name, "stop")}
                                  title="Stop Container"
                                >
                                  <Square size={11} class="text-accent-danger" />
                                </button>
                              ) : (
                                <button 
                                  class="btn-secondary p-1"
                                  onClick={() => handleContainerAction(container.name, "start")}
                                  title="Start Container"
                                >
                                  <Play size={11} class="text-accent-success" />
                                </button>
                              )}
                              <button 
                                class="btn-secondary p-1"
                                onClick={() => handleContainerAction(container.name, "restart")}
                                title="Restart Container"
                              >
                                <RotateCw size={11} class="text-accent-warning" />
                              </button>
                              <button 
                                class="btn-secondary p-1"
                                onClick={() => fetchLogs(container.name)}
                                title="View Logs"
                              >
                                <FileText size={11} class="text-accent-cyan" />
                              </button>
                            </td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Logs */}
              <div class="split-pane-side h-full">
                <div class="console-panel">
                  <div class="console-header flex items-center justify-between">
                    <span class="text-[10px] font-bold font-mono text-text-primary uppercase flex items-center gap-1.5">
                      <Terminal size={12} class="text-accent-cyan" /> 
                      {selectedContainer() ? `${selectedContainer()}.log` : "STDOUT.log"}
                    </span>
                    <Show when={selectedContainer()}>
                      <button 
                        class="btn-secondary text-[10px] py-0.5 px-2 font-mono uppercase"
                        onClick={() => fetchLogs(selectedContainer()!)}
                      >
                        Fetch
                      </button>
                    </Show>
                  </div>
                  <div class="console-body">
                    <Show when={selectedContainer()} fallback={
                      <div class="text-center py-12 text-text-muted uppercase font-bold text-[10px] tracking-wider">
                        Select a container to read Docker socket outputs
                      </div>
                    }>
                      {containerLogs()}
                    </Show>
                  </div>
                </div>
              </div>
            </div>
          </Show>
        </Show>
      </Show>

      {/* Run Container Modal Overlay */}
      <Show when={showRunModal()}>
        <div class="modal-overlay" onClick={() => setShowRunModal(false)}>
          <div class="modal-content text-left select-text" onClick={(e) => e.stopPropagation()}>
            <div class="flex justify-between items-center pb-2 border-b">
              <h3 class="text-xs font-bold font-mono uppercase tracking-wider text-text-primary">Run New Container</h3>
              <button class="btn-secondary py-0.5 px-2 text-[10px] font-mono" onClick={() => setShowRunModal(false)}>Close</button>
            </div>
            
            <form onSubmit={handleRunContainer} class="space-y-3">
              <div class="flex flex-col gap-1">
                <label class="text-[10px] text-text-secondary uppercase font-semibold font-mono">Container Name</label>
                <input
                  type="text"
                  placeholder="e.g. web-app"
                  value={newContainerName()}
                  onInput={(e) => setNewContainerName(e.currentTarget.value)}
                  class="font-mono text-xs py-1 w-full"
                />
              </div>
              
              <div class="flex flex-col gap-1">
                <label class="text-[10px] text-text-secondary uppercase font-semibold font-mono">Docker Image *</label>
                <input
                  type="text"
                  placeholder="e.g. nginx:alpine"
                  value={newContainerImage()}
                  onInput={(e) => setNewContainerImage(e.currentTarget.value)}
                  required
                  class="font-mono text-xs py-1 w-full"
                />
              </div>
              
              <div class="flex flex-col gap-1">
                <label class="text-[10px] text-text-secondary uppercase font-semibold font-mono">Port Mappings</label>
                <input
                  type="text"
                  placeholder="e.g. 8080:80"
                  value={newContainerPorts()}
                  onInput={(e) => setNewContainerPorts(e.currentTarget.value)}
                  class="font-mono text-xs py-1 w-full"
                />
              </div>
              
              <div class="flex flex-col gap-1">
                <label class="text-[10px] text-text-secondary uppercase font-semibold font-mono">Environment Variables (KEY=VALUE, line separated)</label>
                <textarea
                  placeholder="e.g.&#10;PORT=80&#10;NODE_ENV=production"
                  value={newContainerEnv()}
                  onInput={(e) => setNewContainerEnv(e.currentTarget.value)}
                  rows="3"
                  class="font-mono text-xs py-1.5 w-full bg-[#040507] border border-border-color rounded-sm text-text-primary outline-none focus:border-accent-cyan p-2"
                />
              </div>
              
              <div class="flex flex-col gap-1">
                <label class="text-[10px] text-text-secondary uppercase font-semibold font-mono">Restart Policy</label>
                <select
                  value={newContainerRestart()}
                  onChange={(e) => setNewContainerRestart(e.currentTarget.value)}
                  class="font-mono text-xs py-1 w-full"
                >
                  <option value="no">no</option>
                  <option value="always">always</option>
                  <option value="unless-stopped">unless-stopped</option>
                  <option value="on-failure">on-failure</option>
                </select>
              </div>
              
              <div class="flex justify-end gap-2 pt-3 border-t">
                <button type="button" class="btn-secondary text-xs" onClick={() => setShowRunModal(false)}>
                  Cancel
                </button>
                <button type="submit" class="btn-primary text-xs flex items-center gap-1.5 font-bold" disabled={isCreating()}>
                  <Show when={isCreating()}>
                    <Loader class="animate-spin" size={11} />
                  </Show>
                  Run Container
                </button>
              </div>
            </form>
          </div>
        </div>
      </Show>
    </div>
  );
}
