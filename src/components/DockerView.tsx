import { createSignal, createEffect, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { RotateCw, Play, Square, FileText, Activity, Loader, AlertTriangle, Terminal } from "lucide-solid";

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
    <div class="h-full flex flex-col min-h-0" style={{ height: "calc(100vh - 120px)" }}>
      <div class="mb-3 flex flex-wrap justify-between items-center gap-2 pb-2 border-b">
        <div class="flex items-center gap-1.5">
          <Activity class="text-accent-cyan" size={13} />
          <h2 class="text-xs font-bold uppercase tracking-wider font-mono">CONTAINER SUPERVISOR // DOCKER DAEMON</h2>
        </div>
        <div class="flex gap-2 shrink-0">
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
        </div>
      </div>

      <Show when={errorMsg()}>
        <div class="glass-panel p-3 mb-3 border-accent-danger bg-red-950/20 text-accent-danger text-xs flex gap-2">
          <AlertTriangle size={13} class="shrink-0" />
          <span>{errorMsg()}</span>
        </div>
      </Show>

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
    </div>
  );
}
