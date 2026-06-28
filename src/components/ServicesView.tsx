import { createSignal, createEffect, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { RotateCw, Play, Square, FileText, Activity, Loader, AlertTriangle, Terminal } from "lucide-solid";

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
      if (selectedService() === serviceName) {
        fetchLogs(serviceName);
      }
    } catch (e: any) {
      props.showToast(`Error: ${e.toString()}`, "error");
      fetchServices();
    }
  };

  // Fetch log buffer from journalctl
  const fetchLogs = async (serviceName: string) => {
    setSelectedService(serviceName);
    setServiceLogs("Fetching logs from journalctl...");
    try {
      const logs: string = await invoke("get_service_logs", { serverId: props.serverId, serviceName });
      setServiceLogs(logs || "No logs available.");
    } catch (e: any) {
      setServiceLogs(`Error: ${e.toString()}`);
      props.showToast(`Failed to fetch logs: ${e.toString()}`, "error");
    }
  };

  createEffect(() => {
    props.serverId; // Track serverId change
    fetchServices();
  });

  const filteredServices = () => {
    return services().filter((s) => 
      s.name.toLowerCase().includes(filterQuery().toLowerCase()) ||
      s.description.toLowerCase().includes(filterQuery().toLowerCase())
    );
  };

  return (
    <div class="h-full flex flex-col min-h-0" style={{ height: "calc(100vh - 120px)" }}>
      <div class="mb-3 flex flex-wrap justify-between items-center gap-2 pb-2 border-b">
        <div class="flex items-center gap-1.5">
          <Activity class="text-accent-cyan" size={13} />
          <h2 class="text-xs font-bold uppercase tracking-wider font-mono">SERVICE SUPERVISOR // SYSTEMD</h2>
        </div>
        <div class="flex gap-2 shrink-0">
          <input
            type="text"
            placeholder="Filter services..."
            value={filterQuery()}
            onInput={(e) => setFilterQuery(e.currentTarget.value)}
            class="text-xs py-1 w-40 font-mono"
          />
          <button class="btn-secondary text-xs py-1" onClick={fetchServices}>
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
        {/* Left Side: Services List Table */}
        <div class="split-pane-main glass-panel p-3 overflow-hidden h-full">
          <div class="flex-1 overflow-auto pr-1">
            <table class="dense-table">
              <thead>
                <tr>
                  <th class="text-left w-1/3">Service</th>
                  <th class="text-left">Status</th>
                  <th class="text-left w-1/3">Description</th>
                  <th class="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                <Show when={loading() && services().length === 0}>
                  <tr>
                    <td colspan="4" class="py-8 text-center text-text-secondary">
                      <Loader class="animate-spin inline mr-1.5 text-accent-cyan" size={12} /> Reading systemd states...
                    </td>
                  </tr>
                </Show>

                <Show when={!loading() && filteredServices().length === 0}>
                  <tr>
                    <td colspan="4" class="py-8 text-center text-text-muted uppercase font-bold tracking-wider text-[10px]">No Services Found</td>
                  </tr>
                </Show>

                <For each={filteredServices()}>
                  {(service) => (
                    <tr class={selectedService() === service.name ? "active" : ""}>
                      <td class="font-semibold text-text-primary truncate max-w-xs">
                        {service.name.replace(".service", "")}
                      </td>
                      <td>
                        <span class="flex items-center gap-1.5">
                          <span class={`status-dot shrink-0 ${service.sub === "running" ? "active" : service.active === "active" ? "inactive" : "error"}`} />
                          <span class="uppercase text-[9px] font-bold text-text-secondary font-mono">{service.sub}</span>
                        </span>
                      </td>
                      <td class="text-text-secondary truncate max-w-xs" title={service.description}>
                        {service.description}
                      </td>
                      <td class="text-right space-x-1">
                        {service.sub === "running" ? (
                          <button 
                            class="btn-secondary p-1"
                            onClick={() => handleServiceAction(service.name, "stop")}
                            title="Stop Service"
                          >
                            <Square size={11} class="text-accent-danger" />
                          </button>
                        ) : (
                          <button 
                            class="btn-secondary p-1"
                            onClick={() => handleServiceAction(service.name, "start")}
                            title="Start Service"
                          >
                            <Play size={11} class="text-accent-success" />
                          </button>
                        )}
                        <button 
                          class="btn-secondary p-1"
                          onClick={() => handleServiceAction(service.name, "restart")}
                          title="Restart Service"
                        >
                          <RotateCw size={11} class="text-accent-warning" />
                        </button>
                        <button 
                          class="btn-secondary p-1"
                          onClick={() => fetchLogs(service.name)}
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

        {/* Right Side: Log Observer Panel */}
        <div class="split-pane-side h-full">
          <div class="console-panel">
            <div class="console-header flex items-center justify-between">
              <span class="text-[10px] font-bold font-mono text-text-primary uppercase flex items-center gap-1.5">
                <Terminal size={12} class="text-accent-cyan" /> 
                {selectedService() ? `${selectedService()?.replace(".service", "")}.log` : "TELEMETRY.log"}
              </span>
              <Show when={selectedService()}>
                <button 
                  class="btn-secondary text-[10px] py-0.5 px-2 font-mono uppercase"
                  onClick={() => fetchLogs(selectedService()!)}
                >
                  Fetch
                </button>
              </Show>
            </div>
            <div class="console-body">
              <Show when={selectedService()} fallback={
                <div class="text-center py-12 text-text-muted uppercase font-bold text-[10px] tracking-wider">
                  Select a service to inspect journalctl console output
                </div>
              }>
                {serviceLogs()}
              </Show>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
