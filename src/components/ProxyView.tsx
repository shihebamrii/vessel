import { createSignal, Show, For, createEffect } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { Settings, Shield, Loader, CheckCircle2, AlertTriangle, Trash2, RefreshCw, Eye, EyeOff, Globe } from "lucide-solid";

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
    <div class="h-full flex flex-col md:flex-row gap-6 overflow-hidden" style={{ height: "calc(100vh - 120px)" }}>
      {/* Left Column: Deploy Form */}
      <div class="w-full md:w-5/12 glass-panel p-6 overflow-y-auto flex flex-col h-full">
        <div class="flex items-center gap-3 mb-6">
          <div class="p-2.5 rounded-lg bg-accent-cyan/10 text-accent-cyan shrink-0">
            <Settings size={22} />
          </div>
          <div>
            <h2 class="text-xl font-semibold">Proxy Configurator</h2>
            <p class="text-xs text-text-secondary mt-0.5">Route public domain names to local server processes with automatic SSL.</p>
          </div>
        </div>

        <Show when={errorMsg()}>
          <div class="glass-panel p-4 mb-5 border-accent-danger bg-red-950/20 text-accent-danger text-xs flex gap-2">
            <AlertTriangle size={16} class="shrink-0" />
            <span>{errorMsg()}</span>
          </div>
        </Show>

        <Show when={success()}>
          <div class="glass-panel p-4 mb-5 border-accent-success bg-green-950/10 text-accent-success text-xs flex gap-2">
            <CheckCircle2 size={16} class="shrink-0" />
            <span>Proxy block deployed successfully!</span>
          </div>
        </Show>

        <form onSubmit={handleSubmit} class="space-y-4">
          <div class="flex flex-col gap-1">
            <label class="text-xs text-text-secondary font-medium">Web Server</label>
            <select
              value={serverType()}
              onChange={(e) => setServerType(e.currentTarget.value as any)}
              class="w-full bg-slate-900/60 text-xs py-2 px-3 border rounded border-white/10"
              disabled={loading()}
            >
              <option value="nginx">Nginx (Traditional site files)</option>
              <option value="caddy">Caddy (Automatic HTTPS, simple file syntax)</option>
            </select>
          </div>

          <div class="flex flex-col gap-1">
            <label class="text-xs text-text-secondary font-medium">Domain Name</label>
            <input
              type="text"
              placeholder="api.example.com"
              value={domain()}
              onInput={(e) => setDomain(e.currentTarget.value)}
              required
              disabled={loading()}
            />
          </div>

          <div class="flex flex-col gap-1">
            <label class="text-xs text-text-secondary font-medium">Local Port</label>
            <input
              type="number"
              placeholder="3000"
              value={port()}
              onInput={(e) => setPort(parseInt(e.currentTarget.value) || 3000)}
              required
              disabled={loading()}
            />
            <p class="text-[10px] text-text-muted mt-0.5 font-mono">Routes incoming traffic to http://127.0.0.1:port</p>
          </div>

          {/* Nginx SSL Checkbox */}
          <Show when={serverType() === "nginx"}>
            <div class="flex items-center gap-3 py-2 border-t border-b border-white/5">
              <input
                type="checkbox"
                id="enableSsl"
                checked={enableSSL()}
                onChange={(e) => setEnableSSL(e.currentTarget.checked)}
                class="w-4 h-4 rounded border-white/10 bg-slate-900/60 cursor-pointer"
                disabled={loading()}
              />
              <label for="enableSsl" class="text-xs text-text-primary cursor-pointer select-none">
                Enable SSL (Auto-request Let's Encrypt certificate via Certbot)
              </label>
            </div>
          </Show>

          <div class="pt-4 flex flex-col gap-3">
            <button type="submit" class="btn-primary w-full" disabled={loading()}>
              <Show when={loading()}>
                <Loader class="animate-spin" size={14} /> {statusMsg()}
              </Show>
              <Show when={!loading()}>
                <Shield size={14} /> Deploy Configuration
              </Show>
            </button>
          </div>
        </form>
      </div>

      {/* Right Column: Active Proxies List */}
      <div class="flex-1 glass-panel p-6 flex flex-col h-full overflow-hidden">
        <div class="flex justify-between items-center mb-6">
          <div class="flex items-center gap-2">
            <Globe class="text-accent-indigo" size={20} />
            <h3 class="font-semibold text-lg">Active Proxy Routes</h3>
          </div>
          <button 
            class="btn-secondary text-xs py-1.5 px-3 flex items-center gap-1.5" 
            onClick={fetchProxies}
            disabled={loadingProxies()}
          >
            <RefreshCw size={12} class={loadingProxies() ? "animate-spin" : ""} />
            Refresh
          </button>
        </div>

        <div class="flex-1 overflow-auto">
          <table class="w-full text-left text-xs border-collapse">
            <thead>
              <tr class="border-b border-white/5 text-text-muted font-semibold">
                <th class="pb-2">Domain</th>
                <th class="pb-2">Target Port</th>
                <th class="pb-2">Server</th>
                <th class="pb-2">Status</th>
                <th class="pb-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-white/5 font-mono">
              <Show when={loadingProxies() && proxies().length === 0}>
                <tr>
                  <td colspan="5" class="py-8 text-center text-text-secondary">
                    <Loader class="animate-spin inline mr-2 text-accent-cyan" size={14} /> Loading proxy list...
                  </td>
                </tr>
              </Show>

              <Show when={!loadingProxies() && proxies().length === 0}>
                <tr>
                  <td colspan="5" class="py-8 text-center text-text-muted">No reverse proxy configurations active.</td>
                </tr>
              </Show>

              <For each={proxies()}>
                {(proxy) => (
                  <tr class="hover:bg-white/5 transition-colors">
                    <td class="py-3 font-semibold text-text-primary truncate max-w-xs">{proxy.domain}</td>
                    <td class="py-3 text-text-secondary">127.0.0.1:{proxy.port}</td>
                    <td class="py-3">
                      <span class="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-white/5 text-text-muted">
                        {proxy.server_type}
                      </span>
                    </td>
                    <td class="py-3">
                      <span 
                        class={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                          proxy.enabled 
                            ? "bg-accent-success/15 text-accent-success" 
                            : "bg-white/5 text-text-muted"
                        }`}
                      >
                        {proxy.enabled ? "Active" : "Disabled"}
                      </span>
                    </td>
                    <td class="py-3 text-right space-x-1 shrink-0">
                      <Show when={proxy.server_type === "nginx"}>
                        <button 
                          class="p-1 text-text-muted hover:text-accent-cyan bg-white/5 rounded"
                          onClick={() => handleToggleProxy(proxy)}
                          title={proxy.enabled ? "Disable Site" : "Enable Site"}
                        >
                          {proxy.enabled ? <EyeOff size={12} /> : <Eye size={12} />}
                        </button>
                      </Show>
                      <button 
                        class="p-1 text-text-muted hover:text-accent-danger bg-white/5 rounded"
                        onClick={() => handleDeleteProxy(proxy)}
                        title="Delete Config"
                      >
                        <Trash2 size={12} />
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
  );
}
