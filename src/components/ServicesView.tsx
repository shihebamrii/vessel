import { createSignal, createEffect, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { RotateCw, Play, Square, FileText, Activity, Loader, AlertTriangle } from "lucide-solid";

interface ServicesProps {
  serverId: string;
  showToast: (message: string, type?: "success" | "error" | "info") => void;
}

interface ServiceInfo {
  name: string;
  load: string;
  active: string;
  sub: string;
  description: string;
}

export default function ServicesView(props: ServicesProps) {
  const [services, setServices] = createSignal<ServiceInfo[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [filterQuery, setFilterQuery] = createSignal("");
  const [selectedService, setSelectedService] = createSignal<string | null>(null);
  const [serviceLogs, setServiceLogs] = createSignal("");
  const [errorMsg, setErrorMsg] = createSignal("");


  // Poll systemd services list
  const fetchServices = async () => {
    setLoading(true);
    setErrorMsg("");
    try {
      const cmd = "systemctl list-units --type=service --no-legend --no-pager --all";
      const res: any = await invoke("execute_command", { serverId: props.serverId, command: cmd });
      
      if (res.exit_code !== 0) {
        console.error(`Failed to fetch services: ${res.stderr}`);
        setErrorMsg(`Failed to fetch services: ${res.stderr}`);
        return;
      }

      const list: ServiceInfo[] = [];
      for (const line of res.stdout.split("\n")) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 5 && parts[0].endsWith(".service")) {
          // Reconstruct description from index 4 onwards
          const description = parts.slice(4).join(" ");
          list.push({
            name: parts[0],
            load: parts[1],
            active: parts[2],
            sub: parts[3],
            description,
          });
        }
      }
      setServices(list);
    } catch (e: any) {
      console.error(`Error: ${e.toString()}`);
      setErrorMsg(`Connection error: ${e.toString()}`);
    } finally {
      setLoading(false);
    }
  };

  // Perform service operations (Start, Stop, Restart)
  const handleServiceAction = async (serviceName: string, action: "start" | "stop" | "restart") => {
    try {
      setLoading(true);
      await invoke("control_service", { serverId: props.serverId, serviceName, action });
      props.showToast(`Service ${serviceName} ${action}ed successfully!`, "success");
      fetchServices();
    } catch (e: any) {
      props.showToast(`Error: ${e.toString()}`, "error");
      fetchServices();
    }
  };

  // Fetch log buffer from journalctl
  const fetchLogs = async (serviceName: string) => {
    setSelectedService(serviceName);

    setServiceLogs("Fetching logs...");
    try {
      const logs: string = await invoke("get_service_logs", { serverId: props.serverId, serviceName });
      setServiceLogs(logs || "No logs available.");
    } catch (e: any) {
      setServiceLogs(`Error: ${e.toString()}`);
      props.showToast(`Failed to fetch logs: ${e.toString()}`, "error");
    }
  };

  // Load services on mount or serverId change
  createEffect(() => {
    props.serverId; // Track serverId change
    fetchServices();
  });

  // Filter service names
  const filteredServices = () => {
    return services().filter((s) => 
      s.name.toLowerCase().includes(filterQuery().toLowerCase()) ||
      s.description.toLowerCase().includes(filterQuery().toLowerCase())
    );
  };

  return (
    <div class="h-full flex flex-col" style={{ height: "calc(100vh - 120px)" }}>
      <div class="mb-4 flex flex-wrap justify-between items-center gap-3">
        <div class="flex items-center gap-2">
          <Activity class="text-accent-cyan" size={22} />
          <h2 class="text-xl font-semibold">Service Supervisor</h2>
        </div>
        <div class="flex gap-2">
          <input
            type="text"
            placeholder="Filter services..."
            value={filterQuery()}
            onInput={(e) => setFilterQuery(e.currentTarget.value)}
            class="text-xs max-w-xs"
          />
          <button class="btn-secondary text-xs" onClick={fetchServices}>
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
        {/* Left Side: Services List Table */}
        <div class="flex-1 glass-panel p-4 overflow-hidden h-full flex flex-col">
          <div class="flex-1 overflow-auto pr-1">
            <table class="w-full text-left text-xs border-collapse">
              <thead>
                <tr class="border-b border-white/5 text-text-muted font-semibold">
                  <th class="pb-2 w-1/3">Service</th>
                  <th class="pb-2">Status</th>
                  <th class="pb-2 w-1/3">Description</th>
                  <th class="pb-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-white/5 font-mono">
                <Show when={loading() && services().length === 0}>
                  <tr>
                    <td colspan="4" class="py-8 text-center text-text-secondary">
                      <Loader class="animate-spin inline mr-2 text-accent-cyan" size={14} /> Loading services...
                    </td>
                  </tr>
                </Show>

                <Show when={!loading() && filteredServices().length === 0}>
                  <tr>
                    <td colspan="4" class="py-8 text-center text-text-muted">No services matching query.</td>
                  </tr>
                </Show>

                <For each={filteredServices()}>
                  {(service) => (
                    <tr class="hover:bg-white/5 transition-colors">
                      <td class="py-3 font-semibold text-text-primary truncate max-w-xs pr-4">
                        {service.name.replace(".service", "")}
                      </td>
                      <td class="py-3">
                        <span 
                          class={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                            service.sub === "running" 
                              ? "bg-accent-success/15 text-accent-success" 
                              : service.active === "active" 
                              ? "bg-accent-indigo/15 text-accent-indigo" 
                              : "bg-white/5 text-text-muted"
                          }`}
                        >
                          {service.sub}
                        </span>
                      </td>
                      <td class="py-3 text-text-secondary truncate max-w-xs pr-4" title={service.description}>
                        {service.description}
                      </td>
                      <td class="py-3 text-right space-x-1 shrink-0">
                        {service.sub === "running" ? (
                          <button 
                            class="p-1 text-text-muted hover:text-accent-danger bg-white/5 rounded"
                            onClick={() => handleServiceAction(service.name, "stop")}
                            title="Stop Service"
                          >
                            <Square size={12} />
                          </button>
                        ) : (
                          <button 
                            class="p-1 text-text-muted hover:text-accent-success bg-white/5 rounded"
                            onClick={() => handleServiceAction(service.name, "start")}
                            title="Start Service"
                          >
                            <Play size={12} />
                          </button>
                        )}
                        <button 
                          class="p-1 text-text-muted hover:text-accent-warning bg-white/5 rounded"
                          onClick={() => handleServiceAction(service.name, "restart")}
                          title="Restart Service"
                        >
                          <RotateCw size={12} />
                        </button>
                        <button 
                          class="p-1 text-text-muted hover:text-accent-cyan bg-white/5 rounded"
                          onClick={() => fetchLogs(service.name)}
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

        {/* Right Side: Log display Panel */}
        <Show when={selectedService()}>
          <div class="w-1/3 glass-panel p-4 flex flex-col h-full overflow-hidden">
            <div class="mb-3 flex justify-between items-center">
              <h3 class="font-semibold text-sm truncate text-accent-cyan">{selectedService()?.replace(".service", "")} Logs</h3>
              <button 
                class="text-xs text-text-muted hover:text-text-primary"
                onClick={() => fetchLogs(selectedService()!)}
              >
                Refresh
              </button>
            </div>
            <div class="flex-1 p-3 rounded-lg bg-dark-panel border border-white/5 font-mono text-[10px] leading-relaxed overflow-auto select-text whitespace-pre-wrap text-slate-300">
              {serviceLogs()}
            </div>
          </div>
        </Show>
      </div>
    </div>
  );
}
