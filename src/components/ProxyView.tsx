import { createSignal, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { Settings, Shield, Loader, CheckCircle2, AlertTriangle } from "lucide-solid";

interface ProxyProps {
  serverId: string;
  showToast: (message: string, type?: "success" | "error" | "info") => void;
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

    } catch (err: any) {
      setErrorMsg(err.toString());
      setStatusMsg("");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div class="max-w-lg mx-auto glass-panel p-6">
      <div class="flex items-center gap-3 mb-6">
        <div class="p-2.5 rounded-lg bg-accent-cyan/10 text-accent-cyan shrink-0">
          <Settings size={22} />
        </div>
        <div>
          <h2 class="text-xl font-semibold">Reverse Proxy Configurator</h2>
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
          <span>Proxy block configured and web server reloaded successfully!</span>
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
  );
}
