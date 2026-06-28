import { createSignal, createEffect, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { RotateCw, Play, Square, FileText, Loader, Activity, AlertTriangle } from "lucide-solid";

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
    } catch (e: any) {
      props.showToast(`Error: ${e.toString()}`, "error");
      fetchContainers();
    }
  };

  // Fetch docker logs
  const fetchLogs = async (name: string) => {
    setSelectedContainer(name);

    setContainerLogs("Fetching container logs...");
    try {
      const logs: string = await invoke("get_container_logs", { serverId: props.serverId, name });
      setContainerLogs(logs || "No logs available.");
    } catch (e: any) {
      setContainerLogs(`Error: ${e.toString()}`);
      props.showToast(`Failed to fetch logs: ${e.toString()}`, "error");
    }
  };

  createEffect(() => {
    props.serverId; // Track serverId change
    fetchContainers();
  });

  const filteredContainers = () => {
    return containers().filter((c) => 
      c.name.toLowerCase().includes(filterQuery().toLowerCase()) ||
      c.image.toLowerCase().includes(filterQuery().toLowerCase())
    );
  };

  return (
    <div class="h-full flex flex-col" style={{ height: "calc(100vh - 120px)" }}>
      <div class="mb-4 flex flex-wrap justify-between items-center gap-3">
        <div class="flex items-center gap-2">
          <Activity class="text-accent-cyan" size={22} />
          <h2 class="text-xl font-semibold">Docker Containers</h2>
        </div>
        <div class="flex gap-2">
          <input
            type="text"
            placeholder="Filter containers..."
            value={filterQuery()}
            onInput={(e) => setFilterQuery(e.currentTarget.value)}
            class="text-xs max-w-xs"
          />
          <button class="btn-secondary text-xs" onClick={fetchContainers}>
            <RotateCw size={14} /> Refresh
          </button>
        </div>
      </div>

      <Show when={errorMsg()}>
        <div class="glass-panel p-4 mb-4 border-accent-danger bg-red-950/20 text-accent-danger text-xs flex gap-2">
          <AlertTriangle size={16} class="shrink-0" />
          <span>{errorMsg()}</span>
        </div>
      </Show>

      <div class="flex-1 flex gap-6 overflow-hidden">
        {/* Container list */}
        <div class="flex-1 glass-panel p-4 overflow-hidden h-full flex flex-col">
          <div class="flex-1 overflow-auto pr-1">
            <table class="w-full text-left text-xs border-collapse">
              <thead>
                <tr class="border-b border-white/5 text-text-muted font-semibold">
                  <th class="pb-2">ID</th>
                  <th class="pb-2">Name</th>
                  <th class="pb-2">Image</th>
                  <th class="pb-2">Status</th>
                  <th class="pb-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-white/5 font-mono">
                <Show when={loading() && containers().length === 0}>
                  <tr>
                    <td colspan="5" class="py-8 text-center text-text-secondary">
                      <Loader class="animate-spin inline mr-2 text-accent-cyan" size={14} /> Loading containers...
                    </td>
                  </tr>
                </Show>

                <Show when={!loading() && filteredContainers().length === 0}>
                  <tr>
                    <td colspan="5" class="py-8 text-center text-text-muted">No containers running or match query.</td>
                  </tr>
                </Show>

                <For each={filteredContainers()}>
                  {(container) => (
                    <tr class="hover:bg-white/5 transition-colors">
                      <td class="py-3 text-text-muted truncate max-w-[80px]">{container.id}</td>
                      <td class="py-3 font-semibold text-text-primary truncate max-w-xs pr-4">{container.name}</td>
                      <td class="py-3 text-text-secondary truncate max-w-xs pr-4" title={container.image}>{container.image}</td>
                      <td class="py-3">
                        <span 
                          class={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                            container.status.startsWith("Up") 
                              ? "bg-accent-success/15 text-accent-success" 
                              : "bg-white/5 text-text-muted"
                          }`}
                        >
                          {container.status.split(" ")[0]}
                        </span>
                      </td>
                      <td class="py-3 text-right space-x-1 shrink-0">
                        {container.status.startsWith("Up") ? (
                          <button 
                            class="p-1 text-text-muted hover:text-accent-danger bg-white/5 rounded"
                            onClick={() => handleContainerAction(container.name, "stop")}
                            title="Stop Container"
                          >
                            <Square size={12} />
                          </button>
                        ) : (
                          <button 
                            class="p-1 text-text-muted hover:text-accent-success bg-white/5 rounded"
                            onClick={() => handleContainerAction(container.name, "start")}
                            title="Start Container"
                          >
                            <Play size={12} />
                          </button>
                        )}
                        <button 
                          class="p-1 text-text-muted hover:text-accent-warning bg-white/5 rounded"
                          onClick={() => handleContainerAction(container.name, "restart")}
                          title="Restart Container"
                        >
                          <RotateCw size={12} />
                        </button>
                        <button 
                          class="p-1 text-text-muted hover:text-accent-cyan bg-white/5 rounded"
                          onClick={() => fetchLogs(container.name)}
                          title="View Logs"
                        >
                          <FileText size={12} />
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
        <Show when={selectedContainer()}>
          <div class="w-1/3 glass-panel p-4 flex flex-col h-full overflow-hidden">
            <div class="mb-3 flex justify-between items-center">
              <h3 class="font-semibold text-sm truncate text-accent-cyan">{selectedContainer()} Logs</h3>
              <button 
                class="text-xs text-text-muted hover:text-text-primary"
                onClick={() => fetchLogs(selectedContainer()!)}
              >
                Refresh
              </button>
            </div>
            <div class="flex-1 p-3 rounded-lg bg-dark-panel border border-white/5 font-mono text-[10px] leading-relaxed overflow-auto select-text whitespace-pre-wrap text-slate-300">
              {containerLogs()}
            </div>
          </div>
        </Show>
      </div>
    </div>
  );
}
