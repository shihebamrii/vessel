import { createSignal, onMount, For, Show, ErrorBoundary } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./App.css";
import { Plus, Trash2, Settings, Server, Power, LogOut, Terminal, Folder, Activity, Cpu, Play, ShieldAlert, Key, Loader, GitBranch } from "lucide-solid";
import DashboardView from "./components/DashboardView";
import TerminalView from "./components/TerminalView";
import FileExplorerView from "./components/FileExplorerView";
import ServicesView from "./components/ServicesView";
import DockerView from "./components/DockerView";
import ProxyView from "./components/ProxyView";
import GitView from "./components/GitView";
import FirewallView from "./components/FirewallView";

interface ServerProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authType: "password" | "private_key";
}

interface ToastMessage {
  id: string;
  message: string;
  type: "success" | "error" | "info";
}

export default function App() {
  const [profiles, setProfiles] = createSignal<ServerProfile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = createSignal<string | null>(null);
  const [activeServerId, setActiveServerId] = createSignal<string | null>(null);
  const [connectionState, setConnectionState] = createSignal<"disconnected" | "connecting" | "connected">("disconnected");
  const [activeTab, setActiveTab] = createSignal<"dashboard" | "explorer" | "terminal" | "services" | "docker" | "proxy" | "git" | "firewall">("dashboard");
  const [errorMessage, setErrorMessage] = createSignal("");

  // Server Form State
  const [showForm, setShowForm] = createSignal(false);
  const [formName, setFormName] = createSignal("");
  const [formHost, setFormHost] = createSignal("");
  const [formPort, setFormPort] = createSignal(22);
  const [formUsername, setFormUsername] = createSignal("");
  const [formAuthType, setFormAuthType] = createSignal<"password" | "private_key">("password");
  const [formSecret, setFormSecret] = createSignal(""); // temporary for creation

  // Password Prompt Modal State
  const [showPromptModal, setShowPromptModal] = createSignal(false);
  const [promptModalTitle, setPromptModalTitle] = createSignal("");
  const [promptModalSecret, setPromptModalSecret] = createSignal("");
  const [promptModalType, setPromptModalType] = createSignal<"password" | "private_key">("password");
  const [pendingProfile, setPendingProfile] = createSignal<ServerProfile | null>(null);

  // Host Key Confirmation Modal State
  const [showHostKeyModal, setShowHostKeyModal] = createSignal(false);
  const [pendingHostKey, setPendingHostKey] = createSignal<{
    host: string;
    port: number;
    fingerprint: string;
    isMismatch: boolean;
  } | null>(null);

  // Toast System State
  const [toasts, setToasts] = createSignal<ToastMessage[]>([]);

  const showToast = (message: string, type: "success" | "error" | "info" = "info") => {
    const id = `toast-${Date.now()}-${Math.random()}`;
    setToasts((prev) => [...prev, { id, message, type }]);
    
    // Auto-remove after 4 seconds
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  };

  // Load configured profiles on startup
  const loadProfiles = async () => {
    try {
      const data: string = await invoke("load_profiles");
      const list = JSON.parse(data);
      setProfiles(list);
    } catch (e) {
      console.error("Failed to load profiles:", e);
    }
  };

  // Save profile definitions
  const saveProfiles = async (list: ServerProfile[]) => {
    try {
      await invoke("save_profiles", { jsonData: JSON.stringify(list) });
      setProfiles(list);
    } catch (e) {
      console.error("Failed to save profiles:", e);
    }
  };

  // Add a new VPS configuration profile
  const handleAddProfile = async (e: Event) => {
    e.preventDefault();
    if (!formName() || !formHost() || !formUsername()) {
      showToast("Please fill in all required fields.", "error");
      return;
    }

    const id = `server-${Date.now()}`;
    const newProfile: ServerProfile = {
      id,
      name: formName(),
      host: formHost(),
      port: formPort(),
      username: formUsername(),
      authType: formAuthType(),
    };

    // 1. Save password/private key securely in OS Keyring
    if (formSecret()) {
      try {
        await invoke("save_server_credential", {
          serverId: id,
          credentialType: formAuthType(),
          secret: formSecret(),
        });
      } catch (err) {
        showToast(`Failed to save credential securely: ${err}`, "error");
        return;
      }
    }

    // 2. Save public profiles JSON locally
    const updated = [...profiles(), newProfile];
    await saveProfiles(updated);

    // Reset Form
    setFormName("");
    setFormHost("");
    setFormPort(22);
    setFormUsername("");
    setFormAuthType("password");
    setFormSecret("");
    setShowForm(false);
  };

  // Delete a profile and scrub its keyring values
  const handleDeleteProfile = async (id: string, e: Event) => {
    e.stopPropagation();
    if (!confirm("Are you sure you want to delete this server profile?")) return;

    try {
      // Wipes OS vault values
      await invoke("delete_server_credential", { serverId: id, credentialType: "password" });
      await invoke("delete_server_credential", { serverId: id, credentialType: "private_key" });
    } catch (err) {
      console.warn("Failed to scrub keyring credentials:", err);
    }

    const updated = profiles().filter((p) => p.id !== id);
    await saveProfiles(updated);

    if (selectedProfileId() === id) {
      setSelectedProfileId(null);
    }
  };

  // Establish standard SSH tunnel using credentials retrieved from the Keyring
  const handleConnect = async (profile: ServerProfile) => {
    setConnectionState("connecting");
    setErrorMessage("");
    
    try {
      // 1. Fetch credentials securely from OS vault
      let secretValue = "";
      try {
        secretValue = await invoke("get_server_credential", {
          serverId: profile.id,
          credentialType: profile.authType,
        });
      } catch (err) {
        // If password is not found, show custom modal prompt
        setPendingProfile(profile);
        setPromptModalType(profile.authType);
        setPromptModalTitle(`Enter ${profile.authType === "password" ? "Password" : "SSH Private Key"} for ${profile.name}`);
        setPromptModalSecret("");
        setShowPromptModal(true);
        setConnectionState("disconnected");
        return;
      }

      // 2. Open SSH connection
      await executeConnection(profile, secretValue);
    } catch (err: any) {
      setConnectionState("disconnected");
      const errStr = `Connection failed: ${err.toString()}`;
      setErrorMessage(errStr);
      showToast(errStr, "error");
    }
  };

  const executeConnection = async (profile: ServerProfile, secret: string) => {
    setConnectionState("connecting");
    setErrorMessage("");
    try {
      await invoke("connect_session", {
        serverId: profile.id,
        host: profile.host,
        port: profile.port,
        username: profile.username,
        password: profile.authType === "password" ? secret : null,
        privateKey: profile.authType === "private_key" ? secret : null,
      });

      setActiveServerId(profile.id);
      setConnectionState("connected");
      setActiveTab("dashboard");
      showToast(`Successfully connected to ${profile.name}!`, "success");
    } catch (err: any) {
      setConnectionState("disconnected");
      const errStr = `Connection failed: ${err.toString()}`;
      setErrorMessage(errStr);
      showToast(errStr, "error");
    }
  };

  const handlePromptSubmit = (e: Event) => {
    e.preventDefault();
    const profile = pendingProfile();
    const secret = promptModalSecret();
    if (!profile || !secret) return;

    setShowPromptModal(false);
    setPromptModalSecret("");
    executeConnection(profile, secret);
  };

  const handleHostKeyConfirm = async (accept: boolean) => {
    const info = pendingHostKey();
    if (!info) return;

    setShowHostKeyModal(false);
    setPendingHostKey(null);

    try {
      await invoke("confirm_host_key", {
        host: info.host,
        port: info.port,
        accept,
      });
    } catch (err) {
      console.error("Failed to confirm host key:", err);
    }
  };

  // Terminate active SSH handle
  const handleDisconnect = async () => {
    if (!activeServerId()) return;
    try {
      await invoke("disconnect_session", { serverId: activeServerId()! });
    } catch (e) {
      console.warn(e);
    }
    setActiveServerId(null);
    setConnectionState("disconnected");
  };

  onMount(() => {
    loadProfiles();
    
    listen<{ host: string; port: number; fingerprint: string; is_mismatch: boolean }>(
      "ssh-host-key-confirm",
      (event) => {
        setPendingHostKey({
          host: event.payload.host,
          port: event.payload.port,
          fingerprint: event.payload.fingerprint,
          isMismatch: event.payload.is_mismatch,
        });
        setShowHostKeyModal(true);
      }
    );
  });

  return (
    <div class="app-container">
      {/* Sidebar Workspace */}
      <div class="sidebar">
        <div class="flex items-center gap-2 mb-4 pb-2 border-b">
          <Server size={14} class="text-accent-cyan" />
          <h1 class="text-xs font-bold tracking-wider font-mono uppercase text-text-primary">
            VESSEL // VPS
          </h1>
        </div>

        <div class="mb-3">
          <button 
            class="btn-secondary w-full py-1.5 text-xs flex justify-center items-center gap-1.5"
            onClick={() => {
              setSelectedProfileId(null);
              setShowForm(true);
            }}
          >
            <Plus size={12} /> Add Server
          </button>
        </div>

        {/* Server Profiles list */}
        <div class="flex-1 overflow-y-auto mb-4 pr-1">
          <p class="text-[9px] uppercase font-bold text-text-muted mb-2 tracking-wider font-mono">Server Catalog</p>
          <For each={profiles()}>
            {(profile) => (
              <div 
                class={`profile-item group ${selectedProfileId() === profile.id ? "active" : ""}`}
                onClick={() => {
                  setSelectedProfileId(profile.id);
                  setShowForm(false);
                }}
              >
                <div class="flex items-center gap-2 truncate">
                  <span class={`status-dot shrink-0 ${activeServerId() === profile.id ? "active animate-pulse" : "inactive"}`} />
                  <div class="truncate text-left">
                    <p class="text-xs font-semibold text-text-primary truncate">{profile.name}</p>
                    <p class="text-[10px] text-text-muted font-mono truncate">{profile.host}</p>
                  </div>
                </div>
                
                <button 
                  class="btn-secondary p-1"
                  onClick={(e) => handleDeleteProfile(profile.id, e)}
                  title="Remove Server"
                >
                  <Trash2 size={11} />
                </button>
              </div>
            )}
          </For>
        </div>

        {/* Navigation Selector Tabs (when connected) */}
        <Show when={connectionState() === "connected"}>
          <div class="border-t border-white/5 pt-3 space-y-1">
            <p class="text-[9px] uppercase font-bold text-text-muted mb-2 tracking-wider font-mono">Control plane</p>
            <button 
              class={`tab-button ${activeTab() === "dashboard" ? "active" : ""}`}
              onClick={() => setActiveTab("dashboard")}
            >
              <Cpu size={13} /> Dashboard
            </button>
            <button 
              class={`tab-button ${activeTab() === "explorer" ? "active" : ""}`}
              onClick={() => setActiveTab("explorer")}
            >
              <Folder size={13} /> File Explorer
            </button>
            <button 
              class={`tab-button ${activeTab() === "terminal" ? "active" : ""}`}
              onClick={() => setActiveTab("terminal")}
            >
              <Terminal size={13} /> Terminal
            </button>
            <button 
              class={`tab-button ${activeTab() === "services" ? "active" : ""}`}
              onClick={() => setActiveTab("services")}
            >
              <Activity size={13} /> Services
            </button>
            <button 
              class={`tab-button ${activeTab() === "docker" ? "active" : ""}`}
              onClick={() => setActiveTab("docker")}
            >
              <Play size={13} /> Docker Containers
            </button>
            <button 
              class={`tab-button ${activeTab() === "proxy" ? "active" : ""}`}
              onClick={() => setActiveTab("proxy")}
            >
              <Settings size={13} /> Proxy Manager
            </button>
            <button
              class={`tab-button ${activeTab() === "git" ? "active" : ""}`}
              onClick={() => setActiveTab("git")}
            >
              <GitBranch size={13} /> Git Control Plane
            </button>
            <button
              class={`tab-button ${activeTab() === "firewall" ? "active" : ""}`}
              onClick={() => setActiveTab("firewall")}
            >
              <ShieldAlert size={13} /> Firewall
            </button>
          </div>
        </Show>
      </div>

      {/* Main Workspace content */}
      <div class="main-content">
        {errorMessage() && (
          <div class="glass-panel p-3 mb-4 border-accent-danger bg-red-950/20 text-accent-danger text-xs">
            <span>⚠️ {errorMessage()}</span>
          </div>
        )}

        {/* Dynamic component routing based on state */}
        <Show when={showForm() || profiles().length === 0}>
          {/* Create Server Form container */}
          <div class="max-w-md mx-auto glass-panel p-5 mt-8">
            <h3 class="text-sm font-semibold mb-3 pb-1.5 border-b text-text-primary uppercase tracking-wider font-mono">Add Server Profile</h3>
            <form onSubmit={handleAddProfile} class="space-y-3">
              <div class="flex flex-col gap-1">
                <label class="text-[10px] text-text-secondary uppercase font-semibold font-mono">Profile Name</label>
                <input
                  type="text"
                  placeholder="e.g. Production API"
                  value={formName()}
                  onInput={(e) => setFormName(e.currentTarget.value)}
                  required
                />
              </div>
              <div class="grid grid-cols-3 gap-2">
                <div class="col-span-2 flex flex-col gap-1" style={{ "grid-column": "span 2" }}>
                  <label class="text-[10px] text-text-secondary uppercase font-semibold font-mono">Host / IP</label>
                  <input
                    type="text"
                    placeholder="192.168.1.100"
                    value={formHost()}
                    onInput={(e) => setFormHost(e.currentTarget.value)}
                    required
                    class="font-mono text-xs"
                  />
                </div>
                <div class="flex flex-col gap-1">
                  <label class="text-[10px] text-text-secondary uppercase font-semibold font-mono">Port</label>
                  <input
                    type="number"
                    value={formPort()}
                    onInput={(e) => setFormPort(parseInt(e.currentTarget.value) || 22)}
                    required
                    class="font-mono text-xs"
                  />
                </div>
              </div>
              <div class="flex flex-col gap-1">
                <label class="text-[10px] text-text-secondary uppercase font-semibold font-mono">Username</label>
                <input
                  type="text"
                  placeholder="root"
                  value={formUsername()}
                  onInput={(e) => setFormUsername(e.currentTarget.value)}
                  required
                  class="font-mono text-xs"
                />
              </div>
              <div class="flex flex-col gap-1">
                <label class="text-[10px] text-text-secondary uppercase font-semibold font-mono">Authentication Type</label>
                <select
                  value={formAuthType()}
                  onChange={(e) => setFormAuthType(e.currentTarget.value as any)}
                  class="w-full text-xs py-1.5 px-3"
                >
                  <option value="password">Password</option>
                  <option value="private_key">SSH Private Key</option>
                </select>
              </div>

              <div class="flex flex-col gap-1">
                <label class="text-[10px] text-text-secondary uppercase font-semibold font-mono">
                  {formAuthType() === "password" ? "Password" : "Private Key PEM String"}
                </label>
                {formAuthType() === "password" ? (
                  <input
                    type="password"
                    placeholder="••••••••"
                    value={formSecret()}
                    onInput={(e) => setFormSecret(e.currentTarget.value)}
                  />
                ) : (
                  <textarea
                    placeholder="-----BEGIN OPENSSH PRIVATE KEY-----..."
                    value={formSecret()}
                    onInput={(e) => setFormSecret(e.currentTarget.value)}
                    class="h-28 text-xs font-mono"
                  />
                )}
                <p class="text-[9px] text-text-muted mt-0.5">Credentials will be stored securely in the native OS Keychain vault.</p>
              </div>

              <div class="pt-3 flex gap-2">
                <button type="submit" class="btn-primary flex-1">Save Profile</button>
                <Show when={profiles().length > 0}>
                  <button 
                    type="button" 
                    class="btn-secondary" 
                    onClick={() => setShowForm(false)}
                  >
                    Cancel
                  </button>
                </Show>
              </div>
            </form>
          </div>
        </Show>

        <Show when={!showForm() && profiles().length > 0 && activeServerId() === null}>
          {/* Server details card (disconnected state) */}
          <div class="max-w-md mx-auto glass-panel p-5 mt-12">
            <div class="text-center pb-4 mb-4 border-b">
              <Server size={36} class="mx-auto text-text-secondary mb-2" />
              <h3 class="text-sm font-semibold text-text-primary uppercase tracking-wider font-mono">Server Workspace</h3>
            </div>
            
            <For each={profiles()}>
              {(p) => (
                <Show when={p.id === selectedProfileId() || selectedProfileId() === null}>
                  <div class="bg-dark-panel p-3 border rounded mb-4 font-mono text-xs">
                    <div class="telemetry-item">
                      <span class="telemetry-label">Alias</span>
                      <span class="telemetry-value text-accent-cyan">{p.name}</span>
                    </div>
                    <div class="telemetry-item">
                      <span class="telemetry-label">Socket</span>
                      <span class="telemetry-value">{p.username}@{p.host}:{p.port}</span>
                    </div>
                    <div class="telemetry-item">
                      <span class="telemetry-label">Auth Type</span>
                      <span class="telemetry-value">{p.authType === "password" ? "password" : "private_key"}</span>
                    </div>
                  </div>
                  
                  <div class="flex gap-2">
                    <button 
                      class="btn-primary w-full py-2 flex items-center justify-center gap-1.5" 
                      onClick={() => handleConnect(p)}
                      disabled={connectionState() === "connecting"}
                    >
                      <Show when={connectionState() === "connecting"}>
                        <Loader size={12} class="animate-spin" /> Connecting...
                      </Show>
                      <Show when={connectionState() !== "connecting"}>
                        <Power size={12} /> Connect Server
                      </Show>
                    </button>
                  </div>
                </Show>
              )}
            </For>
          </div>
        </Show>

        <Show when={connectionState() === "connected" && activeServerId() !== null}>
          {/* Sub-component views linked to current selection */}
          <div class="h-full flex flex-col min-h-0">
            <div class="flex justify-between items-center mb-4 pb-2 border-b">
              <div class="flex items-center gap-2">
                <span class="status-dot active animate-pulse" />
                <span class="text-xs font-mono uppercase tracking-wider text-text-secondary">
                  CONNECTED // {profiles().find(p => p.id === activeServerId())?.username}@{profiles().find(p => p.id === activeServerId())?.host}
                </span>
              </div>
              <button 
                class="btn-secondary text-[11px] py-1 px-2.5 flex items-center gap-1.5 hover:border-accent-danger hover:text-accent-danger" 
                onClick={handleDisconnect}
              >
                <LogOut size={11} /> Disconnect
              </button>
            </div>

            <ErrorBoundary fallback={(err) => (
              <div class="glass-panel p-4 border-accent-danger bg-red-950/20 text-accent-danger">
                <h3 class="text-xs font-semibold mb-2 flex items-center gap-1.5 uppercase font-mono">⚠️ Telemetry Exception</h3>
                <p class="text-xs font-mono select-text mb-4">{err.toString()}</p>
                <button class="btn-secondary text-xs" onClick={() => window.location.reload()}>Reload App</button>
              </div>
            )}>
              <Show when={activeTab() === "dashboard"}>
                <DashboardView serverId={activeServerId()!} showToast={showToast} />
              </Show>
              <Show when={activeTab() === "explorer"}>
                <FileExplorerView serverId={activeServerId()!} showToast={showToast} />
              </Show>
              <Show when={activeTab() === "terminal"}>
                <TerminalView serverId={activeServerId()!} showToast={showToast} />
              </Show>
              <Show when={activeTab() === "services"}>
                <ServicesView serverId={activeServerId()!} showToast={showToast} />
              </Show>
              <Show when={activeTab() === "docker"}>
                <DockerView serverId={activeServerId()!} showToast={showToast} />
              </Show>
              <Show when={activeTab() === "proxy"}>
                <ProxyView serverId={activeServerId()!} showToast={showToast} />
              </Show>
              <Show when={activeTab() === "git"}>
                <GitView serverId={activeServerId()!} showToast={showToast} />
              </Show>
              <Show when={activeTab() === "firewall"}>
                <FirewallView serverId={activeServerId()!} showToast={showToast} />
              </Show>
            </ErrorBoundary>
          </div>
        </Show>
      </div>

      {/* Password Prompt Modal */}
      <Show when={showPromptModal()}>
        <div class="modal-overlay flex items-center justify-center">
          <div class="glass-panel p-5 max-w-sm w-full mx-4">
            <h3 class="text-xs font-semibold mb-3 pb-1 text-text-primary uppercase tracking-wider font-mono border-b">{promptModalTitle()}</h3>
            <form onSubmit={handlePromptSubmit} class="space-y-3">
              <div class="flex flex-col gap-1">
                <label class="text-[10px] text-text-secondary uppercase font-semibold font-mono">
                  {promptModalType() === "password" ? "Password" : "Private Key PEM String"}
                </label>
                {promptModalType() === "password" ? (
                  <input
                    type="password"
                    placeholder="••••••••"
                    value={promptModalSecret()}
                    onInput={(e) => setPromptModalSecret(e.currentTarget.value)}
                    required
                    class="w-full"
                    autofocus
                  />
                ) : (
                  <textarea
                    placeholder="-----BEGIN OPENSSH PRIVATE KEY-----..."
                    value={promptModalSecret()}
                    onInput={(e) => setPromptModalSecret(e.currentTarget.value)}
                    required
                    class="w-full h-28 text-xs font-mono"
                    autofocus
                  />
                )}
              </div>
              <div class="pt-2 flex gap-2">
                <button type="submit" class="btn-primary flex-1">Connect</button>
                <button 
                  type="button" 
                  class="btn-secondary" 
                  onClick={() => {
                    setShowPromptModal(false);
                    setPendingProfile(null);
                  }}
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      </Show>

      {/* Host Key Confirmation Modal */}
      <Show when={showHostKeyModal() && pendingHostKey()}>
        <div class="modal-overlay flex items-center justify-center z-50">
          <div class="glass-panel p-5 max-w-md w-full mx-4 border-accent-cyan">
            <h3 class="text-xs font-semibold mb-2 text-text-primary flex items-center gap-1.5 uppercase font-mono">
              <Show when={pendingHostKey()?.isMismatch} fallback={<span class="text-accent-cyan flex items-center gap-1.5"><Key size={14} /> New SSH Host Key</span>}>
                <span class="text-accent-danger flex items-center gap-1.5"><ShieldAlert size={14} /> WARNING: Host Key Mismatch!</span>
              </Show>
            </h3>
            
            <p class="text-xs text-text-secondary mb-3 leading-normal">
              <Show when={pendingHostKey()?.isMismatch} fallback={
                <>The server at <strong class="text-text-primary font-mono">{pendingHostKey()?.host}:{pendingHostKey()?.port}</strong> has presented a key fingerprint that is not in your database. Do you trust this key?</>
              }>
                <>
                  THE REMOTE HOST IDENTIFICATION FOR <strong class="text-text-primary font-mono">{pendingHostKey()?.host}:{pendingHostKey()?.port}</strong> HAS CHANGED! 
                  This could indicate a Man-in-the-Middle attack or a legitimate server reinstall. Do you want to trust the new key?
                </>
              </Show>
            </p>

            <div class="bg-dark-panel p-2 rounded border mb-3 text-xs font-mono break-all select-all text-slate-300">
              <div class="text-[9px] text-text-secondary uppercase mb-1 font-semibold">SHA256 Fingerprint</div>
              {pendingHostKey()?.fingerprint}
            </div>

            <div class="flex gap-2">
              <button 
                class={`flex-1 py-1.5 rounded font-medium transition-all text-xs ${pendingHostKey()?.isMismatch ? 'bg-accent-danger hover:bg-accent-danger/80 text-white' : 'btn-primary'}`} 
                onClick={() => handleHostKeyConfirm(true)}
              >
                Accept & Connect
              </button>
              <button 
                class="btn-secondary flex-1 py-1.5" 
                onClick={() => handleHostKeyConfirm(false)}
              >
                Reject / Cancel
              </button>
            </div>
          </div>
        </div>
      </Show>

      {/* Toast Notifications */}
      <div class="toast-container">
        <For each={toasts()}>
          {(t) => (
            <div class={`toast-item ${t.type}`}>
              <div class="toast-content">{t.message}</div>
              <button class="toast-close" onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}>×</button>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}
