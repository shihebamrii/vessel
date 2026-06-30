import { createSignal, createEffect, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import {
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  Plus,
  Trash2,
  RotateCw,
  Loader,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
} from "lucide-solid";

interface FirewallProps {
  serverId: string;
  showToast: (message: string, type?: "success" | "error" | "info") => void;
}

interface FirewallRule {
  num: number;
  to: string;
  action: string;
  from: string;
  ipv6: boolean;
}

interface RestoreParams {
  port?: number;
  port_range?: string;
  proto: string;
  policy: string;
  direction: string;
  from_ip: string;
}

interface DisabledRuleEntry {
  id: string;
  to: string;
  action: string;
  from: string;
  ipv6: boolean;
  displayOrder: number; // UFW rule number at time of disabling, used to keep row in place
  params: RestoreParams;
}

interface DefaultPolicies {
  incoming: string;
  outgoing: string;
}

const PRESETS = [
  { label: "SSH", port: "22", proto: "tcp" },
  { label: "HTTP", port: "80", proto: "tcp" },
  { label: "HTTPS", port: "443", proto: "tcp" },
  { label: "MySQL", port: "3306", proto: "tcp" },
  { label: "Postgres", port: "5432", proto: "tcp" },
  { label: "Redis", port: "6379", proto: "tcp" },
  { label: "MongoDB", port: "27017", proto: "tcp" },
];

const POLICY_DESCS: Record<string, string> = {
  allow: "Permit connections through",
  deny: "Block silently — no response sent to caller",
  reject: "Block and notify caller with an error message",
  limit: "Allow but block repeated attempts — anti brute-force",
};

function getPolicyStyle(action: string): { color: string; bg: string } {
  const a = action.toUpperCase();
  if (a.startsWith("ALLOW")) return { color: "var(--accent-success)", bg: "rgba(48,209,88,0.10)" };
  if (a.startsWith("LIMIT")) return { color: "var(--accent-warning)", bg: "rgba(255,159,10,0.12)" };
  return { color: "var(--accent-danger)", bg: "rgba(255,69,58,0.10)" };
}

function directionFromAction(action: string): "IN" | "OUT" | "FWD" | "" {
  if (action.includes("OUT")) return "OUT";
  if (action.includes("FWD")) return "FWD";
  if (action.includes("IN")) return "IN";
  return "";
}

// Reconstruct add_rule params from a live rule's display fields.
// Returns null if the "to" field is an app profile (e.g. "Nginx Full") we can't parse.
function parseRuleForRestore(rule: FirewallRule): RestoreParams | null {
  const toParts = rule.to.split("/");
  const portStr = toParts[0].trim();
  const proto = toParts[1]?.trim() || "any";

  let portParam: Pick<RestoreParams, "port" | "port_range">;
  if (/^\d+:\d+$/.test(portStr)) {
    portParam = { port_range: portStr };
  } else if (/^\d+$/.test(portStr)) {
    const n = parseInt(portStr, 10);
    if (n < 1 || n > 65535) return null;
    portParam = { port: n };
  } else {
    return null; // app profile — can't restore automatically
  }

  const parts = rule.action.toUpperCase().split(" ");
  const policy = parts[0].toLowerCase();
  const rawDir = parts[1]?.toLowerCase();
  // FWD rules can't be re-added via add_rule (not a supported direction)
  if (rawDir === "fwd") return null;
  const direction = rawDir ?? "both";
  const from_ip = rule.from === "Anywhere" ? "any" : rule.from;

  return { ...portParam, proto, policy, direction, from_ip };
}

// ── Toggle pill component ─────────────────────────────────────────────────
function RuleToggle(props: {
  enabled: boolean;
  canToggle: boolean;
  isLoading: boolean;
  onToggle: () => void;
}) {
  const title = () =>
    !props.canToggle
      ? "App-profile rules cannot be toggled — delete instead"
      : props.enabled
      ? "Enabled — click to disable"
      : "Disabled — click to enable";

  return (
    <button
      onClick={props.onToggle}
      disabled={props.isLoading || !props.canToggle}
      title={title()}
      style={{
        width: "32px",
        height: "17px",
        background: props.enabled
          ? "var(--accent-success)"
          : "rgba(255,255,255,0.10)",
        border: `1px solid ${props.enabled ? "var(--accent-success)" : "rgba(255,255,255,0.18)"}`,
        "border-radius": "9px",
        cursor: props.isLoading || !props.canToggle ? "not-allowed" : "pointer",
        position: "relative",
        padding: "0",
        opacity: !props.canToggle ? "0.35" : "1",
        "flex-shrink": "0",
        transition: "background 0.18s, border-color 0.18s",
      }}
    >
      <span
        style={{
          position: "absolute",
          top: "2px",
          left: "2px",
          width: "11px",
          height: "11px",
          background: props.enabled ? "white" : "rgba(255,255,255,0.45)",
          "border-radius": "50%",
          display: "block",
          transform: props.enabled ? "translateX(15px)" : "translateX(0)",
          transition: "transform 0.18s, background 0.18s",
        }}
      />
    </button>
  );
}

export default function FirewallView(props: FirewallProps) {
  const [status, setStatus] = createSignal<"active" | "inactive" | "unknown">("unknown");
  const [defaultPolicies, setDefaultPolicies] = createSignal<DefaultPolicies | null>(null);
  const [rules, setRules] = createSignal<FirewallRule[]>([]);
  const [disabledRules, setDisabledRules] = createSignal<DisabledRuleEntry[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [isChecking, setIsChecking] = createSignal(true);
  const [ufwInstalled, setUfwInstalled] = createSignal(true);
  const [showAddModal, setShowAddModal] = createSignal(false);
  const [isAdding, setIsAdding] = createSignal(false);

  // Form state
  const [formPort, setFormPort] = createSignal("");
  const [formProto, setFormProto] = createSignal("tcp");
  const [formPolicy, setFormPolicy] = createSignal("allow");
  const [formDirection, setFormDirection] = createSignal("in");
  const [formFromIp, setFormFromIp] = createSignal("any");

  // ── Disabled-rules localStorage helpers ──────────────────────────────────
  const storageKey = () => `vessel_fw_disabled_${props.serverId}`;

  const loadStoredDisabled = (): DisabledRuleEntry[] => {
    try {
      const raw = localStorage.getItem(storageKey());
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  };

  const persistDisabled = (entries: DisabledRuleEntry[]) => {
    localStorage.setItem(storageKey(), JSON.stringify(entries));
  };

  // ── Form helpers ─────────────────────────────────────────────────────────
  const resetForm = () => {
    setFormPort("");
    setFormProto("tcp");
    setFormPolicy("allow");
    setFormDirection("in");
    setFormFromIp("any");
  };

  const closeModal = () => {
    setShowAddModal(false);
    resetForm();
  };

  // ── Parsing ──────────────────────────────────────────────────────────────
  const parseRules = (stdout: string): FirewallRule[] => {
    const result: FirewallRule[] = [];
    for (const line of stdout.split("\n")) {
      const match = line.match(
        /^\[\s*(\d+)\]\s+(.+?)\s{2,}(ALLOW IN|DENY IN|REJECT IN|LIMIT IN|ALLOW OUT|DENY OUT|REJECT OUT|LIMIT OUT|ALLOW FWD|DENY FWD|ALLOW|DENY|REJECT|LIMIT)\s{2,}(.+)$/
      );
      if (match) {
        const to = match[2].trim();
        const ipv6 = to.includes("(v6)");
        result.push({
          num: parseInt(match[1], 10),
          to: to.replace(" (v6)", ""),
          action: match[3].trim(),
          from: match[4].trim().replace(" (v6)", ""),
          ipv6,
        });
      }
    }
    return result;
  };

  const parseDefaultPolicies = (stdout: string): DefaultPolicies | null => {
    const match = stdout.match(/Default:\s+(\w+)\s+\(incoming\),\s+(\w+)\s+\(outgoing\)/i);
    if (!match) return null;
    return { incoming: match[1].toLowerCase(), outgoing: match[2].toLowerCase() };
  };

  const parsePortInput = (input: string): { port?: number; port_range?: string } | null => {
    const trimmed = input.trim();
    if (/^\d+:\d+$/.test(trimmed)) {
      const [a, b] = trimmed.split(":").map(Number);
      if (a >= 1 && b >= 1 && a < b && b <= 65535) return { port_range: trimmed };
      return null;
    }
    const n = parseInt(trimmed, 10);
    if (!isNaN(n) && n >= 1 && n <= 65535) return { port: n };
    return null;
  };

  // ── Data fetching ─────────────────────────────────────────────────────────
  const fetchStatus = async () => {
    setLoading(true);
    try {
      const [numbered, verbose] = await Promise.all([
        invoke<any>("manage_ufw", { serverId: props.serverId, action: "status", params: null }),
        invoke<any>("manage_ufw", { serverId: props.serverId, action: "status_verbose", params: null }),
      ]);

      if (numbered.exit_code !== 0) {
        const combined = ((numbered.stderr ?? "") + (numbered.stdout ?? "")).toLowerCase();
        if (combined.includes("not found") || combined.includes("no such file")) {
          setUfwInstalled(false);
        }
        setIsChecking(false);
        return;
      }

      setUfwInstalled(true);
      setIsChecking(false);
      const firstLine = (numbered.stdout ?? "").trim().split("\n")[0].toLowerCase();
      setStatus(firstLine.includes("active") ? "active" : "inactive");
      setRules(parseRules(numbered.stdout ?? ""));
      setDefaultPolicies(parseDefaultPolicies(verbose.stdout ?? ""));
    } catch (e: any) {
      props.showToast(`Failed to check firewall: ${e.toString()}`, "error");
      setIsChecking(false);
    } finally {
      setLoading(false);
    }
  };

  // ── Firewall-level actions ────────────────────────────────────────────────
  const handleEnable = async () => {
    setLoading(true);
    try {
      const res: any = await invoke("manage_ufw", {
        serverId: props.serverId,
        action: "enable",
        params: null,
      });
      if (res.exit_code !== 0) {
        props.showToast(`Failed to enable firewall: ${res.stderr || res.stdout}`, "error");
      } else {
        props.showToast("Firewall enabled", "success");
        await fetchStatus();
      }
    } catch (e: any) {
      props.showToast(`Error: ${e.toString()}`, "error");
    } finally {
      setLoading(false);
    }
  };

  const handleDisableFirewall = async () => {
    if (!confirm("Disable the firewall? All ports will become accessible.")) return;
    setLoading(true);
    try {
      const res: any = await invoke("manage_ufw", {
        serverId: props.serverId,
        action: "disable",
        params: null,
      });
      if (res.exit_code !== 0) {
        props.showToast(`Failed to disable firewall: ${res.stderr || res.stdout}`, "error");
      } else {
        props.showToast("Firewall disabled", "success");
        await fetchStatus();
      }
    } catch (e: any) {
      props.showToast(`Error: ${e.toString()}`, "error");
    } finally {
      setLoading(false);
    }
  };

  // ── Per-rule CRUD ─────────────────────────────────────────────────────────
  const handleDeleteRule = async (num: number) => {
    if (!confirm(`Permanently delete rule #${num}?`)) return;
    setLoading(true);
    try {
      const res: any = await invoke("manage_ufw", {
        serverId: props.serverId,
        action: "delete_rule",
        params: { rule_num: num },
      });
      if (res.exit_code !== 0) {
        props.showToast(`Failed to delete rule: ${res.stderr || res.stdout}`, "error");
      } else {
        props.showToast(`Rule #${num} deleted`, "success");
        await fetchStatus();
      }
    } catch (e: any) {
      props.showToast(`Error: ${e.toString()}`, "error");
    } finally {
      setLoading(false);
    }
  };

  // Disable = remove from UFW + save to localStorage for later re-enabling
  const handleDisableRule = async (rule: FirewallRule) => {
    const params = parseRuleForRestore(rule);
    if (!params) {
      props.showToast(
        "This rule uses an app profile and can't be temporarily disabled — delete it instead.",
        "error"
      );
      return;
    }

    setLoading(true);
    try {
      const res: any = await invoke("manage_ufw", {
        serverId: props.serverId,
        action: "delete_rule",
        params: { rule_num: rule.num },
      });
      if (res.exit_code !== 0) {
        props.showToast(`Failed to disable rule: ${res.stderr || res.stdout}`, "error");
      } else {
        const entry: DisabledRuleEntry = {
          id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          to: rule.to,
          action: rule.action,
          from: rule.from,
          ipv6: rule.ipv6,
          displayOrder: rule.num,
          params,
        };
        const updated = [...disabledRules(), entry];
        persistDisabled(updated);
        setDisabledRules(updated);
        props.showToast(`Rule disabled: ${rule.to} — click Enable to restore it`, "info");
        await fetchStatus();
      }
    } catch (e: any) {
      props.showToast(`Error: ${e.toString()}`, "error");
    } finally {
      setLoading(false);
    }
  };

  // Enable = re-add to UFW + remove from localStorage
  const handleEnableRule = async (entry: DisabledRuleEntry) => {
    setLoading(true);
    try {
      const res: any = await invoke("manage_ufw", {
        serverId: props.serverId,
        action: "add_rule",
        params: entry.params,
      });
      if (res.exit_code !== 0) {
        props.showToast(`Failed to enable rule: ${res.stderr || res.stdout}`, "error");
      } else {
        const updated = disabledRules().filter((r) => r.id !== entry.id);
        persistDisabled(updated);
        setDisabledRules(updated);
        props.showToast(`Rule enabled: ${entry.to}`, "success");
        await fetchStatus();
      }
    } catch (e: any) {
      props.showToast(`Error: ${e.toString()}`, "error");
    } finally {
      setLoading(false);
    }
  };

  // Remove from the disabled list without re-adding
  const handleRemoveDisabledRule = (id: string) => {
    const updated = disabledRules().filter((r) => r.id !== id);
    persistDisabled(updated);
    setDisabledRules(updated);
  };

  // ── Add-rule form ─────────────────────────────────────────────────────────
  const handleAddRule = async (e: Event) => {
    e.preventDefault();
    const parsed = parsePortInput(formPort());
    if (!parsed) {
      props.showToast("Enter a valid port (22) or range (3000:4000)", "error");
      return;
    }
    setIsAdding(true);
    try {
      const res: any = await invoke("manage_ufw", {
        serverId: props.serverId,
        action: "add_rule",
        params: {
          ...parsed,
          proto: formProto(),
          policy: formPolicy(),
          direction: formDirection(),
          from_ip: formFromIp().trim() || "any",
        },
      });
      if (res.exit_code !== 0) {
        props.showToast(`Failed to add rule: ${res.stderr || res.stdout}`, "error");
      } else {
        props.showToast(
          `Rule added: ${formPolicy()} ${formDirection()} ${formPort()}/${formProto()}`,
          "success"
        );
        closeModal();
        await fetchStatus();
      }
    } catch (e: any) {
      props.showToast(`Error: ${e.toString()}`, "error");
    } finally {
      setIsAdding(false);
    }
  };

  const handleInstallUfw = async () => {
    setLoading(true);
    try {
      const res: any = await invoke("execute_command", {
        serverId: props.serverId,
        command: "sudo apt-get install -y ufw",
      });
      if (res.exit_code === 0) {
        props.showToast("UFW installed successfully!", "success");
        setUfwInstalled(true);
        await fetchStatus();
      } else {
        props.showToast(`Installation failed: ${res.stderr}`, "error");
      }
    } catch (e: any) {
      props.showToast(`Error: ${e.toString()}`, "error");
    } finally {
      setLoading(false);
    }
  };

  const applyPreset = (p: { port: string; proto: string }) => {
    setFormPort(p.port);
    setFormProto(p.proto);
    setFormDirection("in");
  };

  // ── Unified sorted display list ───────────────────────────────────────────
  // Merges active UFW rules and locally-saved disabled rules, sorted so each
  // disabled rule stays at its original position rather than jumping to the bottom.
  const displayItems = () => {
    type Item =
      | { kind: "active"; order: number; rule: FirewallRule }
      | { kind: "disabled"; order: number; entry: DisabledRuleEntry };

    const active: Item[] = rules().map((r) => ({ kind: "active", order: r.num, rule: r }));
    const disabled: Item[] = disabledRules().map((e) => ({
      kind: "disabled",
      order: e.displayOrder ?? 9999,
      entry: e,
    }));
    return [...active, ...disabled].sort((a, b) => a.order - b.order);
  };

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  createEffect(() => {
    props.serverId;
    setIsChecking(true);
    setRules([]);
    setStatus("unknown");
    setDefaultPolicies(null);
    setDisabledRules(loadStoredDisabled());
    fetchStatus();
  });

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div class="h-full flex flex-col min-h-0" style={{ height: "calc(100vh - 120px)" }}>

      {/* Header */}
      <div class="mb-3 flex flex-wrap justify-between items-center gap-2 pb-2 border-b">
        <div class="flex items-center gap-1.5">
          <ShieldAlert class="text-accent-cyan" size={13} />
          <h2 class="text-xs font-bold uppercase tracking-wider font-mono">
            Firewall Manager — UFW
          </h2>
        </div>
        <button class="btn-secondary text-xs py-1" onClick={fetchStatus} disabled={loading()}>
          <RotateCw size={12} />
          Refresh
        </button>
      </div>

      {/* Checking spinner */}
      <Show when={isChecking()}>
        <div class="flex-1 flex flex-col justify-center items-center py-12">
          <Loader class="animate-spin text-accent-cyan mb-2" size={24} />
          <span class="text-xs font-mono uppercase text-text-secondary">
            Checking UFW on remote host…
          </span>
        </div>
      </Show>

      <Show when={!isChecking()}>

        {/* UFW not installed */}
        <Show when={!ufwInstalled()}>
          <div
            class="max-w-xl mx-auto glass-panel p-6 flex flex-col gap-4"
            style={{ "margin-top": "32px" }}
          >
            <div class="flex items-start gap-4">
              <AlertTriangle class="text-accent-warning shrink-0" size={28} />
              <div>
                <h3 class="text-sm font-bold uppercase tracking-wider font-mono text-text-primary mb-1">
                  UFW Not Installed
                </h3>
                <p class="text-xs text-text-secondary leading-relaxed">
                  UFW (Uncomplicated Firewall) was not found on this server. It can be installed
                  via <span class="font-mono text-text-primary">apt</span> on Debian / Ubuntu
                  systems.
                </p>
              </div>
            </div>
            <div class="flex justify-end">
              <button
                class="btn-primary flex items-center gap-1.5 font-mono text-xs py-2 font-bold px-4 uppercase"
                onClick={handleInstallUfw}
                disabled={loading()}
              >
                <Show when={loading()} fallback={<Plus size={12} />}>
                  <Loader class="animate-spin" size={12} />
                </Show>
                Install UFW via apt
              </button>
            </div>
          </div>
        </Show>

        {/* Main firewall UI */}
        <Show when={ufwInstalled()}>
          <div class="flex-1 flex flex-col min-h-0 gap-3">

            {/* ── Status + Default Policy bar ── */}
            <div class="glass-panel p-3 flex flex-wrap items-center justify-between gap-3">
              <div class="flex flex-wrap items-center gap-4">

                {/* Active / Inactive status */}
                <div class="flex items-center gap-2">
                  <Show
                    when={status() === "active"}
                    fallback={<ShieldOff size={14} class="text-accent-warning" />}
                  >
                    <ShieldCheck size={14} class="text-accent-success" />
                  </Show>
                  <span class="text-xs font-mono font-bold uppercase">
                    Status:{" "}
                    <span
                      class={
                        status() === "active" ? "text-accent-success" : "text-accent-warning"
                      }
                    >
                      {status() === "active" ? "Active" : "Inactive"}
                    </span>
                  </span>
                  <Show when={status() === "active"}>
                    <span class="status-dot active animate-pulse" />
                  </Show>
                </div>

                {/* Default policy chips */}
                <Show when={defaultPolicies() !== null}>
                  <div
                    class="flex items-center gap-2 border-l pl-4"
                    style={{ "border-color": "var(--border-color)" }}
                  >
                    <span
                      class="text-text-muted font-mono uppercase"
                      style={{ "font-size": "9px", "letter-spacing": "0.08em" }}
                    >
                      Default
                    </span>

                    <div
                      class="flex items-center gap-1 px-2 py-0.5"
                      style={{
                        background:
                          defaultPolicies()!.incoming === "allow"
                            ? "rgba(48,209,88,0.10)"
                            : "rgba(255,69,58,0.10)",
                        "border-radius": "3px",
                      }}
                    >
                      <ArrowDown size={9} class="text-text-muted" />
                      <span
                        class="font-mono font-bold uppercase"
                        style={{
                          "font-size": "9px",
                          color:
                            defaultPolicies()!.incoming === "allow"
                              ? "var(--accent-success)"
                              : "var(--accent-danger)",
                        }}
                      >
                        {defaultPolicies()!.incoming} in
                      </span>
                    </div>

                    <div
                      class="flex items-center gap-1 px-2 py-0.5"
                      style={{
                        background:
                          defaultPolicies()!.outgoing === "allow"
                            ? "rgba(48,209,88,0.10)"
                            : "rgba(255,69,58,0.10)",
                        "border-radius": "3px",
                      }}
                    >
                      <ArrowUp size={9} class="text-text-muted" />
                      <span
                        class="font-mono font-bold uppercase"
                        style={{
                          "font-size": "9px",
                          color:
                            defaultPolicies()!.outgoing === "allow"
                              ? "var(--accent-success)"
                              : "var(--accent-danger)",
                        }}
                      >
                        {defaultPolicies()!.outgoing} out
                      </span>
                    </div>
                  </div>
                </Show>
              </div>

              {/* Action buttons */}
              <div class="flex gap-2">
                <Show when={status() !== "active"}>
                  <button
                    class="btn-primary text-xs py-1 px-3"
                    onClick={handleEnable}
                    disabled={loading()}
                  >
                    Enable Firewall
                  </button>
                </Show>
                <Show when={status() === "active"}>
                  <button
                    class="btn-secondary text-xs py-1 px-3 hover:border-accent-danger hover:text-accent-danger"
                    onClick={handleDisableFirewall}
                    disabled={loading()}
                  >
                    Disable
                  </button>
                </Show>
                <button
                  class="btn-primary text-xs py-1 px-3"
                  onClick={() => setShowAddModal(true)}
                >
                  <Plus size={11} />
                  Add Rule
                </button>
              </div>
            </div>

            {/* ── Rules table (active + disabled merged) ── */}
            <div class="glass-panel p-3 flex-1 overflow-hidden flex flex-col">
              <div
                class="text-text-muted font-mono uppercase mb-2 shrink-0"
                style={{ "font-size": "9px", "letter-spacing": "0.08em" }}
              >
                {rules().length} active · {disabledRules().length} disabled
              </div>

              <div class="flex-1 overflow-auto pr-1">
                <table class="dense-table">
                  <thead>
                    <tr>
                      <th class="text-left" style={{ width: "32px" }}>#</th>
                      <th class="text-left">Port / Service</th>
                      <th class="text-left" style={{ width: "48px" }}>Dir</th>
                      <th class="text-left">Action</th>
                      <th class="text-left">Source</th>
                      <th class="text-left" style={{ width: "40px" }}>IPv6</th>
                      <th style={{ width: "68px" }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    <Show when={loading() && rules().length === 0 && disabledRules().length === 0}>
                      <tr>
                        <td colspan="7" class="py-8 text-center text-text-secondary">
                          <Loader class="animate-spin inline mr-1.5 text-accent-cyan" size={12} />
                          Loading rules…
                        </td>
                      </tr>
                    </Show>

                    <Show when={!loading() && rules().length === 0 && disabledRules().length === 0}>
                      <tr>
                        <td colspan="7" class="py-12 text-center">
                          <div class="flex flex-col items-center gap-2">
                            <ShieldOff size={22} class="text-text-muted" style={{ opacity: "0.35" }} />
                            <span
                              class="text-text-muted font-mono font-bold uppercase"
                              style={{ "font-size": "10px", "letter-spacing": "0.08em" }}
                            >
                              No rules configured
                            </span>
                            <span class="text-text-muted font-mono" style={{ "font-size": "9px" }}>
                              Click "Add Rule" to start controlling traffic
                            </span>
                          </div>
                        </td>
                      </tr>
                    </Show>

                    {/* Unified list — active and disabled rules sorted by original position */}
                    <For each={displayItems()}>
                      {(item) => {
                        const isActive = item.kind === "active";
                        const to     = isActive ? item.rule.to     : item.entry.to;
                        const action = isActive ? item.rule.action  : item.entry.action;
                        const from   = isActive ? item.rule.from    : item.entry.from;
                        const ipv6   = isActive ? item.rule.ipv6    : item.entry.ipv6;
                        const num    = isActive ? item.rule.num     : null;

                        const pStyle    = getPolicyStyle(action);
                        const dir       = directionFromAction(action);
                        const canToggle = isActive ? parseRuleForRestore(item.rule) !== null : true;

                        return (
                          <tr style={{ opacity: isActive ? "1" : "0.4" }}>
                            <td class="text-text-muted font-mono">{num ?? "—"}</td>
                            <td
                              class="font-semibold font-mono"
                              style={{ color: isActive ? "var(--text-primary)" : "var(--text-secondary)" }}
                            >
                              {to}
                            </td>
                            <td>
                              <Show when={dir !== ""}>
                                <span
                                  class="font-mono font-bold"
                                  style={{
                                    "font-size": "9px",
                                    color: isActive && dir === "OUT" ? "var(--accent-cyan)"
                                         : isActive ? "var(--text-secondary)"
                                         : "var(--text-muted)",
                                    background: isActive && dir === "OUT" ? "rgba(0,145,255,0.10)"
                                              : "rgba(255,255,255,0.05)",
                                    padding: "2px 5px",
                                    "border-radius": "2px",
                                  }}
                                >
                                  {dir}
                                </span>
                              </Show>
                            </td>
                            <td>
                              <span
                                style={{
                                  color: isActive ? pStyle.color : "var(--text-muted)",
                                  background: isActive ? pStyle.bg : "rgba(255,255,255,0.04)",
                                  "font-size": "9px",
                                  "font-weight": "700",
                                  "text-transform": "uppercase",
                                  "font-family": "var(--font-mono)",
                                  "letter-spacing": "0.04em",
                                  padding: "2px 6px",
                                  "border-radius": "2px",
                                  display: "inline-block",
                                }}
                              >
                                {action}
                              </span>
                            </td>
                            <td
                              class="font-mono"
                              style={{ color: isActive ? "var(--text-secondary)" : "var(--text-muted)" }}
                            >
                              {from}
                            </td>
                            <td class="text-text-muted font-mono" style={{ "font-size": "10px" }}>
                              {ipv6 ? "yes" : "—"}
                            </td>
                            <td>
                              <div class="flex items-center justify-end gap-1.5">
                                <RuleToggle
                                  enabled={isActive}
                                  canToggle={canToggle}
                                  isLoading={loading()}
                                  onToggle={() =>
                                    isActive
                                      ? handleDisableRule(item.rule)
                                      : handleEnableRule(item.entry)
                                  }
                                />
                                <button
                                  class="btn-secondary p-1"
                                  onClick={() =>
                                    isActive
                                      ? handleDeleteRule(item.rule.num)
                                      : handleRemoveDisabledRule(item.entry.id)
                                  }
                                  title={isActive ? "Permanently delete rule" : "Remove from saved list"}
                                  disabled={loading()}
                                >
                                  <Trash2 size={11} class="text-accent-danger" />
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      }}
                    </For>
                  </tbody>
                </table>
              </div>
            </div>

          </div>
        </Show>
      </Show>

      {/* ── Add Rule Modal ── */}
      <Show when={showAddModal()}>
        <div class="modal-overlay" onClick={closeModal}>
          <div
            class="modal-content text-left"
            style={{ "max-width": "480px", width: "100%" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div class="flex justify-between items-center pb-3 mb-4 border-b">
              <div class="flex items-center gap-2">
                <ShieldAlert size={13} class="text-accent-cyan" />
                <h3 class="text-xs font-bold font-mono uppercase tracking-wider text-text-primary">
                  Add Firewall Rule
                </h3>
              </div>
              <button
                class="btn-secondary py-0.5 px-2 font-mono"
                style={{ "font-size": "10px" }}
                onClick={closeModal}
              >
                ✕
              </button>
            </div>

            {/* Quick presets */}
            <div class="mb-4">
              <p
                class="text-text-muted font-mono uppercase mb-2"
                style={{ "font-size": "9px", "letter-spacing": "0.08em" }}
              >
                Quick presets
              </p>
              <div class="flex flex-wrap gap-1.5">
                <For each={PRESETS}>
                  {(p) => (
                    <button
                      type="button"
                      class="btn-secondary font-mono"
                      style={{ "font-size": "10px", padding: "2px 10px" }}
                      onClick={() => applyPreset(p)}
                    >
                      {p.label}
                    </button>
                  )}
                </For>
              </div>
            </div>

            <form onSubmit={handleAddRule} class="space-y-3">
              {/* Port + Protocol */}
              <div class="grid grid-cols-2 gap-3">
                <div class="flex flex-col gap-1">
                  <label
                    class="text-text-secondary font-mono font-semibold uppercase"
                    style={{ "font-size": "9px", "letter-spacing": "0.08em" }}
                  >
                    Port or Range *
                  </label>
                  <input
                    type="text"
                    placeholder="22  or  3000:4000"
                    value={formPort()}
                    onInput={(e) => setFormPort(e.currentTarget.value)}
                    required
                    class="font-mono text-xs py-1 w-full"
                  />
                  <span class="text-text-muted font-mono" style={{ "font-size": "9px" }}>
                    Single port or start:end range
                  </span>
                </div>

                <div class="flex flex-col gap-1">
                  <label
                    class="text-text-secondary font-mono font-semibold uppercase"
                    style={{ "font-size": "9px", "letter-spacing": "0.08em" }}
                  >
                    Protocol
                  </label>
                  <select
                    value={formProto()}
                    onChange={(e) => setFormProto(e.currentTarget.value)}
                    class="font-mono text-xs py-1 w-full"
                  >
                    <option value="tcp">TCP — web, SSH, databases</option>
                    <option value="udp">UDP — DNS, VPN, game servers</option>
                    <option value="any">Any — TCP + UDP</option>
                  </select>
                </div>
              </div>

              {/* Policy + Direction */}
              <div class="grid grid-cols-2 gap-3">
                <div class="flex flex-col gap-1">
                  <label
                    class="text-text-secondary font-mono font-semibold uppercase"
                    style={{ "font-size": "9px", "letter-spacing": "0.08em" }}
                  >
                    Policy
                  </label>
                  <select
                    value={formPolicy()}
                    onChange={(e) => setFormPolicy(e.currentTarget.value)}
                    class="font-mono text-xs py-1 w-full"
                  >
                    <option value="allow">Allow</option>
                    <option value="deny">Deny</option>
                    <option value="reject">Reject</option>
                    <option value="limit">Limit — rate-limit</option>
                  </select>
                  <span
                    class="text-text-muted font-mono leading-relaxed"
                    style={{ "font-size": "9px" }}
                  >
                    {POLICY_DESCS[formPolicy()]}
                  </span>
                </div>

                <div class="flex flex-col gap-1">
                  <label
                    class="text-text-secondary font-mono font-semibold uppercase"
                    style={{ "font-size": "9px", "letter-spacing": "0.08em" }}
                  >
                    Direction
                  </label>
                  <select
                    value={formDirection()}
                    onChange={(e) => setFormDirection(e.currentTarget.value)}
                    class="font-mono text-xs py-1 w-full"
                  >
                    <option value="in">Inbound — traffic coming in</option>
                    <option value="out">Outbound — traffic going out</option>
                    <option value="both">Both directions</option>
                  </select>
                </div>
              </div>

              {/* Source IP */}
              <div class="flex flex-col gap-1">
                <label
                  class="text-text-secondary font-mono font-semibold uppercase"
                  style={{ "font-size": "9px", "letter-spacing": "0.08em" }}
                >
                  Source IP / CIDR
                  <span
                    class="text-text-muted ml-1"
                    style={{ "text-transform": "none", "font-weight": "400" }}
                  >
                    — leave blank to match all sources
                  </span>
                </label>
                <input
                  type="text"
                  placeholder="any   or   192.168.1.0/24"
                  value={formFromIp()}
                  onInput={(e) => setFormFromIp(e.currentTarget.value)}
                  class="font-mono text-xs py-1 w-full"
                />
              </div>

              <div class="flex justify-end gap-2 pt-3 border-t">
                <button type="button" class="btn-secondary text-xs" onClick={closeModal}>
                  Cancel
                </button>
                <button
                  type="submit"
                  class="btn-primary text-xs flex items-center gap-1.5 font-bold"
                  disabled={isAdding()}
                >
                  <Show when={isAdding()} fallback={<Plus size={11} />}>
                    <Loader class="animate-spin" size={11} />
                  </Show>
                  Add Rule
                </button>
              </div>
            </form>
          </div>
        </div>
      </Show>
    </div>
  );
}
