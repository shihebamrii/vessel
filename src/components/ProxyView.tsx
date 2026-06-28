import { createSignal, Show, For, createEffect } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { Settings, Shield, Loader, CheckCircle2, AlertTriangle, Trash2, RefreshCw, Eye, EyeOff, Globe, Search, ExternalLink } from "lucide-solid";

interface ProxyProps {
  serverId: string;
  showToast: (message: string, type?: "success" | "error" | "info") => void;
}

interface ProxyConfig {
  domain: string;
  server_type: string;
  enabled: boolean;
  port: number;
}

export default function ProxyView(props: ProxyProps) {
  const [serverType, setServerType] = createSignal<"nginx" | "caddy">("nginx");
  const [domain, setDomain] = createSignal("");
  const [port, setPort] = createSignal(3000);
  const [enableSSL, setEnableSSL] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  const [statusMsg, setStatusMsg] = createSignal("");
  const [errorMsg, setErrorMsg] = createSignal("");
  const [success, setSuccess] = createSignal(false);

  // Active proxies management state
  const [proxies, setProxies] = createSignal<ProxyConfig[]>([]);
  const [loadingProxies, setLoadingProxies] = createSignal(false);
  const [searchQuery, setSearchQuery] = createSignal("");

  const filteredProxies = () => {
    const q = searchQuery().trim().toLowerCase();
    if (!q) return proxies();
    return proxies().filter(
      (p) =>
        p.domain.toLowerCase().includes(q) ||
        p.port.toString().includes(q) ||
        p.server_type.toLowerCase().includes(q)
    );
  };

  const fetchProxies = async () => {
    setLoadingProxies(true);
    try {
      const list: ProxyConfig[] = await invoke("list_proxies", { serverId: props.serverId });
      setProxies(list);
    } catch (err) {
      console.error("Failed to fetch proxies:", err);
    } finally {
      setLoadingProxies(false);
    }
  };

  createEffect(() => {
    props.serverId;
    fetchProxies();
  });

  const handleDeleteProxy = async (proxy: ProxyConfig) => {
    if (!confirm(`Are you sure you want to delete the proxy configuration for ${proxy.domain}?`)) return;
    try {
      setLoadingProxies(true);
      await invoke("delete_proxy", {
        serverId: props.serverId,
        serverType: proxy.server_type,
        domain: proxy.domain,
      });
      props.showToast(`Deleted proxy config for ${proxy.domain}`, "success");
      fetchProxies();
    } catch (err: any) {
      props.showToast(`Delete failed: ${err.toString()}`, "error");
    } finally {
      setLoadingProxies(false);
    }
  };

  const handleToggleProxy = async (proxy: ProxyConfig) => {
    try {
      setLoadingProxies(true);
      const newStatus = !proxy.enabled;
      await invoke("toggle_proxy_status", {
        serverId: props.serverId,
        serverType: proxy.server_type,
        domain: proxy.domain,
        enable: newStatus,
      });
      props.showToast(`${newStatus ? 'Enabled' : 'Disabled'} proxy config for ${proxy.domain}`, "success");
      fetchProxies();
    } catch (err: any) {
      props.showToast(`Toggle failed: ${err.toString()}`, "error");
    } finally {
      setLoadingProxies(false);
    }
  };

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    if (!domain().trim()) return;

    setLoading(true);
    setStatusMsg("Deploying configuration...");
    setErrorMsg("");
    setSuccess(false);

    const targetDomain = domain().trim().toLowerCase();
    const proxyPort = port();

    try {
      await invoke("configure_proxy", {
        serverId: props.serverId,
        serverType: serverType(),
        domain: targetDomain,
        port: proxyPort,
        enableSsl: enableSSL(),
      });

      setSuccess(true);
      setStatusMsg("");
      setDomain("");
      setPort(3000);
      setEnableSSL(false);
      fetchProxies();

    } catch (err: any) {
      setErrorMsg(err.toString());
      setStatusMsg("");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div class="h-full flex flex-col min-h-0" style={{ height: "calc(100vh - 120px)" }}>
      {/* View Header */}
      <div class="mb-3 flex items-center justify-between pb-2 border-b">
        <div class="flex items-center gap-1.5">
          <Settings class="text-accent-cyan" size={13} />
          <h2 class="text-xs font-bold uppercase tracking-wider font-mono">REVERSE PROXY CONTROL PLANE</h2>
        </div>
      </div>

      <div class="split-pane">
        {/* Left Column: Deploy Form */}
        <div class="w-5/12 glass-panel p-4 overflow-y-auto flex flex-col justify-between">
          <div class="space-y-4">
            <div>
              <h3 class="text-xs font-bold uppercase tracking-wider font-mono text-text-primary">Proxy Configurator</h3>
              <p class="text-[11px] text-text-secondary mt-1">Route public domain names to local server processes with automatic SSL configuration.</p>
            </div>

            <Show when={errorMsg()}>
              <div class="glass-panel p-3 border-accent-danger bg-red-950/20 text-accent-danger text-xs flex gap-2">
                <AlertTriangle size={13} class="shrink-0" />
                <span>{errorMsg()}</span>
              </div>
            </Show>

            <Show when={success()}>
              <div class="glass-panel p-3 border-accent-success bg-green-950/10 text-accent-success text-xs flex gap-2">
                <CheckCircle2 size={13} class="shrink-0" />
                <span>Proxy block deployed successfully!</span>
              </div>
            </Show>

            <form onSubmit={handleSubmit} class="space-y-3">
              {/* Segmented Web Server Selector */}
              <div class="flex flex-col gap-1.5">
                <label class="text-[10px] text-text-secondary uppercase font-semibold font-mono">Web Server Daemon</label>
                <div class="tab-segment-container">
                  <button
                    type="button"
                    onClick={() => !loading() && setServerType("nginx")}
                    class={`tab-segment-button ${serverType() === "nginx" ? "active text-accent-cyan" : ""}`}
                    disabled={loading()}
                  >
                    Nginx
                  </button>
                  <button
                    type="button"
                    onClick={() => !loading() && setServerType("caddy")}
                    class={`tab-segment-button ${serverType() === "caddy" ? "active text-accent-indigo" : ""}`}
                    disabled={loading()}
                  >
                    Caddy
                  </button>
                </div>
              </div>

              {/* Domain Name */}
              <div class="flex flex-col gap-1.5">
                <label class="text-[10px] text-text-secondary uppercase font-semibold font-mono">Domain Name</label>
                <div class="relative flex items-center">
                  <span class="absolute left-3 text-text-muted select-none">
                    <Globe size={12} />
                  </span>
                  <input
                    type="text"
                    placeholder="api.domain.com"
                    value={domain()}
                    onInput={(e) => setDomain(e.currentTarget.value)}
                    required
                    disabled={loading()}
                    class="w-full pl-8 font-mono text-xs"
                  />
                </div>
              </div>

              {/* Local Port */}
              <div class="flex flex-col gap-1.5">
                <label class="text-[10px] text-text-secondary uppercase font-semibold font-mono">Local Port Offset</label>
                <div class="relative flex items-center">
                  <span class="absolute left-3 text-text-muted select-none font-mono text-[9px] uppercase tracking-wider font-semibold">
                    Port
                  </span>
                  <input
                    type="number"
                    placeholder="3000"
                    value={port()}
                    onInput={(e) => setPort(parseInt(e.currentTarget.value) || 3000)}
                    required
                    disabled={loading()}
                    class="w-full pl-12 font-mono text-xs"
                  />
                </div>
              </div>

              {/* Visual Route Flow Diagram */}
              <div class="bg-dark-panel p-3 border rounded flex flex-col gap-1.5 font-mono">
                <span class="text-[8px] uppercase font-bold text-text-muted tracking-wider">Routing Topology Map</span>
                <div class="flex items-center justify-between text-[10px] py-1">
                  <div class="flex flex-col items-center gap-0.5 w-1/3 text-center">
                    <Globe size={12} class="text-accent-indigo shrink-0" />
                    <span class="text-text-primary truncate w-full font-semibold" title={domain() || "domain.com"}>
                      {domain() || "domain.com"}
                    </span>
                    <span class="text-[8px] text-text-muted">Public Web</span>
                  </div>
                  <div class="flex-1 flex items-center justify-center px-1 text-text-muted">
                    <div class="h-[1px] flex-1 bg-gradient-to-r from-accent-indigo/20 via-accent-cyan to-accent-success/20 relative">
                      <div class="absolute -top-2 left-1/2 -translate-x-1/2 px-1 bg-slate-950 text-[7px] border rounded uppercase tracking-wide scale-90 font-bold">
                        {serverType()}
                      </div>
                    </div>
                  </div>
                  <div class="flex flex-col items-center gap-0.5 w-1/3 text-center">
                    <div class="text-accent-success shrink-0 flex items-center justify-center">
                      <Settings size={10} />
                    </div>
                    <span class="text-text-primary font-semibold">
                      :{port() || "3000"}
                    </span>
                    <span class="text-[8px] text-text-muted">127.0.0.1</span>
                  </div>
                </div>
              </div>

              {/* Nginx SSL Checkbox */}
              <Show when={serverType() === "nginx"}>
                <label class="flex items-center gap-2.5 py-2 px-3 rounded bg-slate-900/40 border hover:border-white/10 cursor-pointer transition-all">
                  <input
                    type="checkbox"
                    id="enableSsl"
                    checked={enableSSL()}
                    onChange={(e) => setEnableSSL(e.currentTarget.checked)}
                    class="w-3.5 h-3.5 cursor-pointer outline-none shrink-0"
                    disabled={loading()}
                  />
                  <div class="flex flex-col">
                    <span class="text-xs text-text-primary font-semibold select-none">
                      Enable automatic SSL certificate
                    </span>
                    <span class="text-[9px] text-text-muted select-none leading-normal">
                      Requests and registers a free Let's Encrypt TLS certificate via Certbot.
                    </span>
                  </div>
                </label>
              </Show>

              <div class="pt-2 flex flex-col gap-2">
                <button type="submit" class="btn-primary w-full" disabled={loading()}>
                  <Show when={loading()} fallback={<><Shield size={12} /> Deploy Configuration</>}>
                    <Loader class="animate-spin" size={12} /> {statusMsg()}
                  </Show>
                </button>
              </div>
            </form>
          </div>
        </div>

        {/* Right Column: Active Proxies List */}
        <div class="w-7/12 glass-panel p-4 flex flex-col h-full overflow-hidden">
          <div class="flex flex-col gap-3 mb-4">
            <div class="flex justify-between items-center">
              <div class="flex items-center gap-1.5">
                <Globe class="text-accent-indigo" size={13} />
                <h3 class="font-bold text-xs uppercase tracking-wider font-mono">Active Proxy Routes</h3>
                <Show when={proxies().length > 0}>
                  <span class="px-1.5 py-0.5 text-[9px] font-bold bg-[#14161c] border rounded text-text-secondary font-mono">
                    {filteredProxies().length} / {proxies().length}
                  </span>
                </Show>
              </div>
              <button 
                class="btn-secondary text-xs py-1" 
                onClick={fetchProxies}
                disabled={loadingProxies()}
              >
                <RefreshCw size={11} class={loadingProxies() ? "animate-spin mr-1" : "mr-1"} />
                Refresh
              </button>
            </div>

            <Show when={proxies().length > 0}>
              <div class="relative flex items-center">
                <span class="absolute left-3 text-text-muted select-none">
                  <Search size={12} class="opacity-50" />
                </span>
                <input
                  type="text"
                  placeholder="Search proxy host, local port..."
                  value={searchQuery()}
                  onInput={(e) => setSearchQuery(e.currentTarget.value)}
                  class="w-full text-xs pl-8 font-mono"
                />
              </div>
            </Show>
          </div>

          <div class="flex-1 overflow-auto pr-1">
            <table class="dense-table">
              <thead>
                <tr>
                  <th class="text-left w-2/5">Domain</th>
                  <th class="text-left">Target</th>
                  <th class="text-left">Engine</th>
                  <th class="text-left">Status</th>
                  <th class="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                <Show when={loadingProxies() && proxies().length === 0}>
                  <tr>
                    <td colspan="5" class="py-8 text-center text-text-secondary">
                      <Loader class="animate-spin inline mr-1.5 text-accent-cyan" size={12} /> Reading proxy configurations...
                    </td>
                  </tr>
                </Show>

                <Show when={!loadingProxies() && filteredProxies().length === 0}>
                  <tr>
                    <td colspan="5" class="py-8 text-center text-text-muted uppercase font-bold tracking-wider text-[10px]">
                      {searchQuery().trim() === "" ? "No active proxy configurations" : "No matching routes found"}
                    </td>
                  </tr>
                </Show>

                <For each={filteredProxies()}>
                  {(proxy) => (
                    <tr>
                      <td class="font-semibold text-text-primary truncate max-w-xs">
                        <a 
                          href={`http://${proxy.domain}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          class="hover:text-accent-cyan hover:underline flex items-center gap-1 inline-flex"
                          title={`Visit http://${proxy.domain}`}
                        >
                          {proxy.domain}
                          <ExternalLink size={10} class="opacity-50 shrink-0" />
                        </a>
                      </td>
                      <td class="text-text-secondary">127.0.0.1:{proxy.port}</td>
                      <td>
                        <span class={`uppercase text-[9px] font-bold px-1.5 py-0.5 rounded border ${
                          proxy.server_type === "nginx" 
                            ? "bg-accent-success/10 text-accent-success border-accent-success/20" 
                            : "bg-accent-indigo/10 text-accent-indigo border-accent-indigo/20"
                        }`}>
                          {proxy.server_type}
                        </span>
                      </td>
                      <td>
                        <span class="flex items-center gap-1.5">
                          <span class={`status-dot shrink-0 ${proxy.enabled ? "active" : "inactive"}`} />
                          <span class="uppercase text-[9px] font-bold text-text-secondary font-mono">
                            {proxy.enabled ? "active" : "disabled"}
                          </span>
                        </span>
                      </td>
                      <td class="text-right space-x-1">
                        <Show when={proxy.server_type === "nginx"}>
                          <button 
                            class="btn-secondary p-1"
                            onClick={() => handleToggleProxy(proxy)}
                            title={proxy.enabled ? "Disable Route" : "Enable Route"}
                          >
                            {proxy.enabled ? <EyeOff size={11} /> : <Eye size={11} />}
                          </button>
                        </Show>
                        <button 
                          class="btn-secondary p-1"
                          onClick={() => handleDeleteProxy(proxy)}
                          title="Delete Config"
                        >
                          <Trash2 size={11} class="text-accent-danger" />
                        </button>
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
