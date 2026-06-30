import { createSignal, createMemo, createEffect, onCleanup, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  Plus,
  Minus,
  Trash2,
  GitBranch,
  RotateCw,
  RotateCcw,
  Loader,
  Play,
  Check,
  X,
  ArrowDown,
  ArrowUp,
  ChevronRight,
  Folder,
  RefreshCw,
} from "lucide-solid";

// ─── Prop / domain types ───────────────────────────────────────────────────────

interface GitViewProps {
  serverId: string;
  showToast: (message: string, type?: "success" | "error" | "info") => void;
}

interface GitRepo {
  id: string;
  name: string;
  path: string;
  deployAction?: { type: "service" | "container" | "command"; target: string };
}

interface CommitInfo {
  hash: string;
  parents: string[];   // space-split parent hashes from %P
  author: string;
  message: string;
  relativeDate: string;
  date: string;
  refs: string[];      // parsed from %D
}

interface BranchInfo {
  name: string;
  isCurrent: boolean;
  upstream: string;
}

interface FileStatus {
  xy: string;
  path: string;
}

// ─── Graph layout types ────────────────────────────────────────────────────────

interface GraphEdge {
  fromCol: number;
  toCol:   number;
  fromY:   "top" | "mid";
  toY:     "mid" | "bot";
  color:   string;
}

interface LayoutRow {
  commit:    CommitInfo;
  lane:      number;     // column of the commit node
  nodeColor: string;
  edges:     GraphEdge[];
  totalCols: number;     // SVG width in lane units
}

// ─── Graph layout algorithm ────────────────────────────────────────────────────

const LANE_COLORS = [
  "#0091ff", // blue  (primary / main)
  "#30d158", // green
  "#ff9f0a", // orange
  "#af52de", // purple
  "#ff453a", // red
  "#5856d6", // indigo
  "#64d2ff", // sky
  "#ffd60a", // yellow
  "#ff6b9d", // pink
  "#4ecdc4", // teal
];

const laneColor = (i: number) => LANE_COLORS[Math.abs(i) % LANE_COLORS.length];

function computeGraphLayout(commits: CommitInfo[]): LayoutRow[] {
  // lanes[i] = hash that lane i is currently tracking (expecting to appear next)
  //            null = lane is empty / available
  let lanes: (string | null)[] = [];

  return commits.map(commit => {
    const prevLanes = [...lanes];

    // ── Find this commit's lane ────────────────────────────────────────────
    let myLane = lanes.findIndex(h => h === commit.hash);
    const isNewTip = myLane === -1;
    if (isNewTip) {
      // Not yet tracked — open first empty slot, or append
      myLane = lanes.findIndex(h => h === null);
      if (myLane === -1) { myLane = lanes.length; }
    }

    // ── Compute next lanes state ───────────────────────────────────────────
    const nextLanes = [...lanes];
    while (nextLanes.length <= myLane) nextLanes.push(null);
    nextLanes[myLane] = null; // consume this commit from its lane

    const parentLanes: number[] = []; // which lane each parent goes to
    const [p1, ...pRest] = commit.parents;

    if (p1) {
      // First parent continues in the same lane (straight line)
      nextLanes[myLane] = p1;
      parentLanes.push(myLane);
    }

    for (const p of pRest) {
      // Additional parents: reuse an existing lane if already tracked, else open new
      let pLane = nextLanes.findIndex(h => h === p);
      if (pLane === -1) {
        pLane = nextLanes.findIndex(h => h === null);
        if (pLane === -1) { pLane = nextLanes.length; nextLanes.push(null); }
        nextLanes[pLane] = p;
      }
      parentLanes.push(pLane);
    }

    // Trim trailing nulls so lane count stays compact
    while (nextLanes.length > 0 && nextLanes[nextLanes.length - 1] === null) nextLanes.pop();

    const totalCols = Math.max(prevLanes.length, nextLanes.length, myLane + 1);

    // ── Build edge list for this row's SVG ────────────────────────────────
    const edges: GraphEdge[] = [];

    // 1. Incoming line to this commit (top → mid), only if it was already tracked
    if (!isNewTip) {
      edges.push({ fromCol: myLane, toCol: myLane, fromY: "top", toY: "mid", color: laneColor(myLane) });
    }

    // 2. Pass-through for every other active lane (top → bot, straight vertical)
    for (let i = 0; i < totalCols; i++) {
      if (i === myLane) continue;
      if ((prevLanes[i] ?? null) !== null) {
        edges.push({ fromCol: i, toCol: i, fromY: "top", toY: "bot", color: laneColor(i) });
      }
    }

    // 3. Outgoing lines from commit node to each parent lane (mid → bot)
    for (const pLane of parentLanes) {
      edges.push({ fromCol: myLane, toCol: pLane, fromY: "mid", toY: "bot", color: laneColor(pLane) });
    }

    lanes = [...nextLanes];

    return {
      commit,
      lane: myLane,
      nodeColor: laneColor(myLane),
      edges,
      totalCols,
    };
  });
}

// ─── Graph SVG renderer ────────────────────────────────────────────────────────

const ROW_H  = 38;  // px — height of each commit row
const LANE_W = 16;  // px — width per lane column
const NODE_R = 4;   // px — node circle radius
const MID_Y  = ROW_H / 2;
const cx     = (col: number) => col * LANE_W + LANE_W / 2;

function EdgePath(p: { edge: GraphEdge }) {
  const { edge } = p;
  const x1 = cx(edge.fromCol);
  const x2 = cx(edge.toCol);
  const y1 = edge.fromY === "top" ? 0 : MID_Y;
  const y2 = edge.toY  === "bot" ? ROW_H : MID_Y;

  const d = x1 === x2
    ? `M ${x1},${y1} L ${x2},${y2}`                              // straight vertical
    : `M ${x1},${y1} C ${x1},${(y1+y2)/2} ${x2},${(y1+y2)/2} ${x2},${y2}`; // bezier

  return (
    <path
      d={d}
      stroke={edge.color}
      stroke-width="1.5"
      fill="none"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  );
}

// ─── Ref badge helpers ─────────────────────────────────────────────────────────

interface ParsedRef { name: string; kind: "head" | "branch" | "remote" | "tag" }

const REF_STYLES: Record<string, { bg: string; fg: string; border: string }> = {
  head:   { bg: "rgba(48,209,88,0.15)",  fg: "#30d158", border: "rgba(48,209,88,0.4)" },
  branch: { bg: "rgba(0,145,255,0.13)",  fg: "#0091ff", border: "rgba(0,145,255,0.35)" },
  remote: { bg: "rgba(142,142,147,0.1)", fg: "#8e8e93", border: "rgba(142,142,147,0.25)" },
  tag:    { bg: "rgba(255,159,10,0.13)", fg: "#ff9f0a", border: "rgba(255,159,10,0.35)" },
};

const REF_FALLBACK = REF_STYLES["branch"];

function classifyRef(r: string): ParsedRef {
  if (r === "HEAD")             return { name: "HEAD",     kind: "head" };
  if (r.startsWith("HEAD -> ")) return { name: r.slice(8), kind: "branch" };
  if (r.startsWith("tag: "))    return { name: r.slice(5), kind: "tag" };
  // "origin/HEAD -> origin/main" and any other remote pointer
  if (r.includes(" -> "))       return { name: r.split(" -> ")[1] ?? r, kind: "remote" };
  if (r.includes("/"))          return { name: r, kind: "remote" };
  return { name: r, kind: "branch" };
}


function RefBadge(p: { ref: ParsedRef }) {
  const s = REF_STYLES[p.ref.kind] ?? REF_FALLBACK;
  return (
    <span style={{
      "font-size": "10px", "font-family": "var(--font-mono)", "font-weight": "600",
      background: s.bg, color: s.fg, border: `1px solid ${s.border}`,
      "border-radius": "3px", padding: "1px 5px", "white-space": "nowrap", "flex-shrink": "0",
    }}>
      {p.ref.name}
    </span>
  );
}

// ─── File tree helpers ─────────────────────────────────────────────────────────

interface TreeNode {
  name: string; fullPath: string; filePath?: string; xy?: string;
  type: "dir" | "file"; children: TreeNode[]; fileCount: number;
}
interface FlatItem {
  type: "dir" | "file"; name: string; fullPath: string; filePath?: string; xy?: string;
  depth: number; fileCount: number; isCollapsed: boolean;
}

function buildTree(files: FileStatus[]): TreeNode[] {
  type DirMap = { dirs: Record<string, DirMap>; files: FileStatus[] };
  const root: DirMap = { dirs: {}, files: [] };
  for (const f of files) {
    const tp = f.path.includes(" → ") ? f.path.split(" → ")[1] : f.path;
    const parts = tp.replace(/^\//, "").split("/");
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!cur.dirs[parts[i]]) cur.dirs[parts[i]] = { dirs: {}, files: [] };
      cur = cur.dirs[parts[i]];
    }
    cur.files.push(f);
  }
  const count = (d: DirMap): number => d.files.length + Object.values(d.dirs).reduce((s, s2) => s + count(s2), 0);
  function toNodes(d: DirMap, prefix: string): TreeNode[] {
    const nodes: TreeNode[] = [];
    for (const [name, sub] of Object.entries(d.dirs).sort((a,b) => a[0].localeCompare(b[0]))) {
      const fp = prefix ? `${prefix}/${name}` : name;
      nodes.push({ name, fullPath: fp, type: "dir", children: toNodes(sub, fp), fileCount: count(sub) });
    }
    for (const f of [...d.files].sort((a,b) => {
      const an = (a.path.includes(" → ") ? a.path.split(" → ")[1] : a.path).split("/").pop()!;
      const bn = (b.path.includes(" → ") ? b.path.split(" → ")[1] : b.path).split("/").pop()!;
      return an.localeCompare(bn);
    })) {
      const tp = f.path.includes(" → ") ? f.path.split(" → ")[1] : f.path;
      nodes.push({ name: tp.split("/").pop()!, fullPath: f.path, filePath: f.path, xy: f.xy, type: "file", children: [], fileCount: 1 });
    }
    return nodes;
  }
  return toNodes(root, "");
}

function flatten(nodes: TreeNode[], depth: number, collapsed: Set<string>): FlatItem[] {
  const out: FlatItem[] = [];
  for (const n of nodes) {
    const isColl = n.type === "dir" && collapsed.has(n.fullPath);
    out.push({ type: n.type, name: n.name, fullPath: n.fullPath, filePath: n.filePath, xy: n.xy, depth, fileCount: n.fileCount, isCollapsed: isColl });
    if (n.type === "dir" && !isColl) flatten(n.children, depth + 1, collapsed).forEach(i => out.push(i));
  }
  return out;
}

function isStaged(xy: string)   { if (!xy || xy === "??") return false; return ["M","A","D","R","C","T"].includes(xy[0]); }
function isUnstaged(xy: string) { if (!xy) return false; if (xy==="??") return true; const x=xy[0],y=xy.length>1?xy[1]:"."; if(x==="U"||y==="U") return true; if(x==="A"&&y==="A") return true; if(x==="D"&&y==="D") return true; return y!=="."&&y!=="?"; }
function effectiveCode(xy: string, ctx: "staged"|"unstaged") { if(!xy||xy==="??") return xy||"??"; const x=xy[0],y=xy.length>1?xy[1]:"."; if(ctx==="staged") return `${x}.`; if(x==="U"||y==="U"||(x==="A"&&y==="A")||(x==="D"&&y==="D")) return "UU"; return `.${y}`; }
function statusLetter(xy: string) { const c=xy.trim().toUpperCase(); if(c==="??"||c===".?") return "U"; if(c.includes("U")||c==="AA"||c==="DD") return "!"; const x=c[0],y=c.length>1?c[1]:"."; if(x!=="."&&x!=="?") return x; if(y!=="."&&y!=="?") return y; return "?"; }
function statusColor(xy: string)  { const c=xy.trim().toUpperCase(); if(c==="??"||c===".?") return "var(--accent-success)"; if(c==="UU"||c.includes("U")) return "var(--accent-danger)"; if(c.startsWith("A")||c.endsWith("A")) return "var(--accent-success)"; if(c.startsWith("D")||c.endsWith("D")) return "var(--accent-danger)"; if(c.startsWith("R")||c.endsWith("R")) return "var(--accent-warning)"; if(c.startsWith("M")||c.endsWith("M")) return "var(--accent-warning)"; return "var(--text-secondary)"; }

const esc      = (v: string) => "'" + v.replace(/'/g, "'\\''") + "'";
const destPath = (p: string) => p.includes(" → ") ? p.split(" → ")[1].trim() : p;

// ─── Component ─────────────────────────────────────────────────────────────────

export default function GitView(props: GitViewProps) {
  // — Repos —
  const [allRepos, setAllRepos] = createSignal<Record<string, GitRepo[]>>({});
  const [repos, setRepos]       = createSignal<GitRepo[]>([]);
  const [activeRepo, setActiveRepo] = createSignal<GitRepo | null>(null);
  const [showAddForm, setShowAddForm] = createSignal(false);
  const [newPath, setNewPath]   = createSignal("");
  const [newName, setNewName]   = createSignal("");
  const [addingRepo, setAddingRepo] = createSignal(false);
  const [scanning, setScanning] = createSignal(false);

  // — Tabs —
  const [activeTab, setActiveTab] = createSignal<"status"|"log"|"branches"|"deploy">("status");

  // — Status —
  const [branchName, setBranchName] = createSignal("");
  const [upstream, setUpstream]     = createSignal("");
  const [ahead, setAhead]           = createSignal(0);
  const [behind, setBehind]         = createSignal(0);
  const [files, setFiles]           = createSignal<FileStatus[]>([]);
  const [statusLoading, setStatusLoading] = createSignal(false);
  const [commitMessage, setCommitMessage] = createSignal("");
  const [committing, setCommitting] = createSignal(false);
  const [collapsedDirs, setCollapsedDirs] = createSignal<Set<string>>(new Set());
  const [stagedCollapsed, setStagedCollapsed]   = createSignal(false);
  const [changesCollapsed, setChangesCollapsed] = createSignal(false);
  const [incomingCollapsed, setIncomingCollapsed] = createSignal(false);
  const [incomingCommits, setIncomingCommits] = createSignal<CommitInfo[]>([]);
  const [incomingFiles, setIncomingFiles]     = createSignal<FileStatus[]>([]);

  // — Log —
  const [commits, setCommits]     = createSignal<CommitInfo[]>([]);
  const [logLoading, setLogLoading] = createSignal(false);
  const layoutRows = createMemo<LayoutRow[]>(() => computeGraphLayout(commits()));

  // — Branches —
  const [branches, setBranches]   = createSignal<BranchInfo[]>([]);
  const [branchesLoading, setBranchesLoading] = createSignal(false);
  const [showNewBranch, setShowNewBranch]     = createSignal(false);
  const [newBranchName, setNewBranchName]     = createSignal("");
  const [creatingBranch, setCreatingBranch]   = createSignal(false);

  // — Deploy —
  const [deployType, setDeployType]     = createSignal<"service"|"container"|"command">("service");
  const [deployTarget, setDeployTarget] = createSignal("");
  const [deployDirty, setDeployDirty]   = createSignal(false);

  // — Console —
  const [consoleOut, setConsoleOut] = createSignal("");
  const [streaming, setStreaming]   = createSignal(false);
  const [streamLabel, setStreamLabel] = createSignal("");
  let streamId = "";
  let unlisten: (() => void) | undefined;
  let consoleRef: HTMLDivElement | undefined;

  // — Memos —
  const staged   = createMemo(() => files().filter(f => isStaged(f.xy)));
  const unstaged = createMemo(() => files().filter(f => isUnstaged(f.xy)));
  const flatStaged    = createMemo(() => flatten(buildTree(staged()),   0, collapsedDirs()));
  const flatUnstaged  = createMemo(() => flatten(buildTree(unstaged()), 0, collapsedDirs()));
  const flatIncoming  = createMemo(() => flatten(buildTree(incomingFiles()), 0, collapsedDirs()));

  createEffect(() => { activeRepo(); setCollapsedDirs(new Set<string>()); });

  const toggleDir = (p: string) =>
    setCollapsedDirs(prev => { const n = new Set(prev); n.has(p) ? n.delete(p) : n.add(p); return n; });

  // ─── Repo management ──────────────────────────────────────────────────────

  const loadRepos = async () => {
    try {
      const data: string = await invoke("load_git_repos");
      const parsed = JSON.parse(data) || {};
      setAllRepos(parsed);
      const list = (parsed[props.serverId] || []) as GitRepo[];
      setRepos(list);
      const cur = activeRepo();
      if (cur) { const found = list.find(r => r.id === cur.id); setActiveRepo(found ?? list[0] ?? null); }
      else setActiveRepo(list[0] ?? null);
    } catch { props.showToast("Failed to load repositories", "error"); }
  };

  const saveRepos = async (updated: GitRepo[]) => {
    const all = { ...allRepos(), [props.serverId]: updated };
    setAllRepos(all); setRepos(updated);
    await invoke("save_git_repos", { jsonData: JSON.stringify(all) });
  };

  createEffect(() => { if (props.serverId) { setActiveRepo(null); loadRepos(); } });

  createEffect(() => {
    const repo = activeRepo(), tab = activeTab();
    if (!repo) { setBranchName(""); setUpstream(""); setAhead(0); setBehind(0); setFiles([]); setCommits([]); setBranches([]); return; }
    if (tab === "status")   fetchStatus();
    else if (tab === "log") fetchLog();
    else if (tab === "branches") fetchBranches();
    else if (tab === "deploy") { setDeployType(repo.deployAction?.type ?? "service"); setDeployTarget(repo.deployAction?.target ?? ""); setDeployDirty(false); }
  });

  onCleanup(() => {
    if (unlisten) { unlisten(); unlisten = undefined; }
    if (streaming() && streamId) invoke("stop_container_logs_stream", { streamId }).catch(() => {});
  });

  // ─── Repo CRUD ─────────────────────────────────────────────────────────────

  const handleAutoScan = async () => {
    if (scanning()) return;
    setScanning(true); props.showToast("Scanning for repositories…", "info");
    try {
      const res: any = await invoke("execute_command", { serverId: props.serverId, command: "find ~ /var/www -maxdepth 4 -name node_modules -prune -o -name .venv -prune -o -name .git -type d -print 2>/dev/null" });
      if (res.exit_code !== 0) { props.showToast(`Scan failed: ${res.stderr}`, "error"); return; }
      const found = res.stdout.split("\n").map((l: string) => l.trim()).filter((l: string) => l.endsWith("/.git"));
      const clean = (p: string) => p.endsWith("/") ? p.slice(0,-1) : p;
      const cur = repos(); let added = 0; const updated = [...cur];
      for (const raw of found) {
        const rp = raw.slice(0,-5);
        if (!cur.some(r => clean(r.path) === clean(rp))) { updated.push({ id: `repo-${Date.now()}-${Math.random()*1000|0}`, name: rp.split("/").pop()||"Unnamed", path: rp }); added++; }
      }
      if (added > 0) { await saveRepos(updated); if (!activeRepo()) setActiveRepo(updated[0]); props.showToast(`${added} repositor${added===1?"y":"ies"} found.`, "success"); }
      else props.showToast("No new repositories found.", "info");
    } catch (e: any) { props.showToast(e.toString(), "error"); }
    finally { setScanning(false); }
  };

  const handleAddRepo = async (e: Event) => {
    e.preventDefault();
    const path = newPath().trim(), name = newName().trim();
    if (!path || !name) return;
    setAddingRepo(true);
    try {
      const res: any = await invoke("execute_command", { serverId: props.serverId, command: `git -C ${esc(path)} rev-parse --is-inside-work-tree` });
      if (res.exit_code === 0 && res.stdout.trim() === "true") {
        const repo: GitRepo = { id: `repo-${Date.now()}`, name, path };
        await saveRepos([...repos(), repo]); setActiveRepo(repo); setShowAddForm(false); setNewPath(""); setNewName("");
        props.showToast(`"${name}" added.`, "success");
      } else props.showToast("Not a valid Git repository.", "error");
    } catch (e: any) { props.showToast(e.toString(), "error"); }
    finally { setAddingRepo(false); }
  };

  const handleDeleteRepo = async (id: string, name: string, e: Event) => {
    e.stopPropagation(); if (!confirm(`Remove "${name}"?`)) return;
    const updated = repos().filter(r => r.id !== id); await saveRepos(updated);
    if (activeRepo()?.id === id) setActiveRepo(updated[0] ?? null);
  };

  // ─── Data fetching ─────────────────────────────────────────────────────────

  const fetchStatus = async () => {
    const repo = activeRepo(); if (!repo) return;
    setStatusLoading(true);
    try { await invoke("execute_command", { serverId: props.serverId, command: `git -C ${esc(repo.path)} fetch 2>/dev/null` }); } catch {}
    try {
      const res: any = await invoke("execute_command", { serverId: props.serverId, command: `git -C ${esc(repo.path)} status --porcelain=v2 --branch` });
      if (res.exit_code !== 0) { props.showToast(`git status failed: ${res.stderr}`, "error"); return; }
      const lines = res.stdout.split("\n"); let br="",up="",ah=0,bh=0; const fs: FileStatus[] = [];
      const off = (s: string, n: number) => { let c=0; for(let i=0;i<s.length;i++) if(s[i]===" "&&++c===n) return i+1; return s.length; };
      for (const line of lines) {
        if      (line.startsWith("# branch.head "))     br = line.slice(14).trim();
        else if (line.startsWith("# branch.upstream ")) up = line.slice(18).trim();
        else if (line.startsWith("# branch.ab "))       { const p=line.slice(12).trim().split(" "); ah=parseInt(p[0])||0; bh=parseInt(p[1])||0; }
        else if (line.startsWith("1 "))                 { const c=line.slice(2); fs.push({xy:c.split(" ")[0], path:c.slice(off(c,7))}); }
        else if (line.startsWith("2 "))                 { const c=line.slice(2),xy=c.split(" ")[0],ps=c.slice(off(c,8)),ti=ps.indexOf("\t"); fs.push({xy,path:ti!==-1?`${ps.slice(ti+1)} → ${ps.slice(0,ti)}`:ps}); }
        else if (line.startsWith("? "))                 { fs.push({xy:"??",path:line.slice(2).trim()}); }
      }
      setBranchName(br); setUpstream(up); setAhead(ah); setBehind(bh); setFiles(fs);
      if (bh > 0 && up) {
        try {
          const cr: any = await invoke("execute_command", { serverId: props.serverId, command: `git -C ${esc(repo.path)} log HEAD..${esc(up)} --format="%H%x1F%P%x1F%an%x1F%s%x1F%ar%x1F%ad%x1F" --date=short` });
          if (cr.exit_code === 0) setIncomingCommits(cr.stdout.split("\n").filter(Boolean).map((l:string) => { const p=l.split("\x1f"); return p.length>=6?{hash:p[0],parents:p[1]?p[1].split(" "):[],author:p[2],message:p[3],relativeDate:p[4],date:p[5],refs:[]}:null; }).filter(Boolean) as CommitInfo[]);
          const fr: any = await invoke("execute_command", { serverId: props.serverId, command: `git -C ${esc(repo.path)} diff --name-status HEAD..${esc(up)}` });
          if (fr.exit_code === 0) setIncomingFiles(fr.stdout.split("\n").filter(Boolean).map((l:string)=>{const p=l.trim().split(/\s+/);return p.length>=2?{xy:p[0]+".",path:p.slice(1).join(" ")}:null;}).filter(Boolean) as FileStatus[]);
        } catch {}
      } else { setIncomingCommits([]); setIncomingFiles([]); }
    } catch (e: any) { props.showToast(`Status error: ${e}`, "error"); }
    finally { setStatusLoading(false); }
  };

  const fetchLog = async () => {
    const repo = activeRepo(); if (!repo) return;
    setLogLoading(true);
    try {
      // %H=hash  %P=parents  %an=author  %s=subject  %ar=rel-date  %ad=abs-date  %D=refs
      const res: any = await invoke("execute_command", {
        serverId: props.serverId,
        command: `git -C ${esc(repo.path)} log --all --topo-order --format="%H%x1F%P%x1F%an%x1F%s%x1F%ar%x1F%ad%x1F%D" --date=short -120`
      });
      if (res.exit_code !== 0) { props.showToast(`git log failed: ${res.stderr}`, "error"); return; }
      setCommits(
        res.stdout.split("\n").filter(Boolean).map((l: string) => {
          const p = l.split("\x1f");
          if (p.length < 7) return null;
          return {
            hash:         p[0].trim(),
            parents:      p[1].trim() ? p[1].trim().split(" ") : [],
            author:       p[2].trim(),
            message:      p[3].trim(),
            relativeDate: p[4].trim(),
            date:         p[5].trim(),
            refs:         p[6].trim() ? p[6].trim().split(", ") : [],
          } satisfies CommitInfo;
        }).filter(Boolean) as CommitInfo[]
      );
    } catch (e: any) { props.showToast(`Log error: ${e}`, "error"); }
    finally { setLogLoading(false); }
  };

  const fetchBranches = async () => {
    const repo = activeRepo(); if (!repo) return;
    setBranchesLoading(true);
    try {
      const res: any = await invoke("execute_command", { serverId: props.serverId, command: `git -C ${esc(repo.path)} branch -a --format="%(refname:short)|%(HEAD)|%(upstream:short)"` });
      if (res.exit_code !== 0) { props.showToast(`git branch failed: ${res.stderr}`, "error"); return; }
      setBranches(res.stdout.split("\n").filter(Boolean).map((l:string)=>{const p=l.split("|");return p.length>=2?{name:p[0],isCurrent:p[1]==="*",upstream:p[2]||""}:null;}).filter(Boolean) as BranchInfo[]);
    } catch (e: any) { props.showToast(`Branches error: ${e}`, "error"); }
    finally { setBranchesLoading(false); }
  };

  // ─── Git operations ─────────────────────────────────────────────────────────

  const stageFile    = async (p: string) => { const r=activeRepo();if(!r)return; const res:any=await invoke("execute_command",{serverId:props.serverId,command:`git -C ${esc(r.path)} add ${esc(destPath(p))}`}); if(res.exit_code===0)fetchStatus();else props.showToast(`Stage failed: ${res.stderr}`,"error"); };
  const unstageFile  = async (p: string) => { const r=activeRepo();if(!r)return; const res:any=await invoke("execute_command",{serverId:props.serverId,command:`git -C ${esc(r.path)} restore --staged ${esc(destPath(p))}`}); if(res.exit_code===0)fetchStatus();else props.showToast(`Unstage failed: ${res.stderr}`,"error"); };
  const discardFile  = async (p: string, untracked: boolean) => {
    if(!confirm(`Discard changes to "${p}"? This cannot be undone.`)) return;
    const r=activeRepo();if(!r)return;
    const cmd=untracked?`git -C ${esc(r.path)} clean -f ${esc(p)}`:`git -C ${esc(r.path)} restore ${esc(destPath(p))}`;
    const res:any=await invoke("execute_command",{serverId:props.serverId,command:cmd});
    if(res.exit_code===0){props.showToast("Discarded.","success");fetchStatus();}else props.showToast(`Discard failed: ${res.stderr}`,"error");
  };
  const stageAll   = async () => { const r=activeRepo();if(!r)return; const res:any=await invoke("execute_command",{serverId:props.serverId,command:`git -C ${esc(r.path)} add -A`}); if(res.exit_code===0){props.showToast("All staged.","success");fetchStatus();}else props.showToast(`Stage all failed: ${res.stderr}`,"error"); };
  const unstageAll = async () => { const r=activeRepo();if(!r)return; const res:any=await invoke("execute_command",{serverId:props.serverId,command:`git -C ${esc(r.path)} restore --staged .`}); if(res.exit_code===0){props.showToast("All unstaged.","success");fetchStatus();}else props.showToast(`Unstage all failed: ${res.stderr}`,"error"); };

  const handleCommit = async () => {
    const r=activeRepo();if(!r)return;
    const msg=commitMessage().trim();if(!msg){props.showToast("Enter a commit message.","error");return;}
    if(staged().length===0){props.showToast("No staged changes.","error");return;}
    setCommitting(true);
    try {
      const res:any=await invoke("execute_command",{serverId:props.serverId,command:`git -C ${esc(r.path)} commit -m ${esc(msg)}`});
      if(res.exit_code===0){props.showToast("Commit created.","success");setCommitMessage("");fetchStatus();}
      else props.showToast(`Commit failed: ${res.stderr||res.stdout}`,"error");
    } catch(e:any){props.showToast(e.toString(),"error");}
    finally{setCommitting(false);}
  };

  const handleCreateBranch = async (e: Event) => {
    e.preventDefault(); const r=activeRepo();if(!r)return;
    const name=newBranchName().trim();if(!name)return;
    setCreatingBranch(true);
    try {
      const res:any=await invoke("execute_command",{serverId:props.serverId,command:`git -C ${esc(r.path)} checkout -b ${esc(name)}`});
      if(res.exit_code===0){props.showToast(`Branch "${name}" created.`,"success");setNewBranchName("");setShowNewBranch(false);fetchBranches();fetchStatus();}
      else props.showToast(`Create failed: ${res.stderr}`,"error");
    } catch(e:any){props.showToast(e.toString(),"error");}
    finally{setCreatingBranch(false);}
  };

  const handleDeleteBranch = async (name: string) => {
    if(!confirm(`Delete branch "${name}"?`)) return; const r=activeRepo();if(!r)return;
    const res:any=await invoke("execute_command",{serverId:props.serverId,command:`git -C ${esc(r.path)} branch -d ${esc(name)}`});
    if(res.exit_code===0){props.showToast(`Branch "${name}" deleted.`,"success");fetchBranches();}
    else props.showToast(`Delete failed (unmerged?): ${res.stderr}`,"error");
  };

  const handleCheckout = async (branch: string) => {
    const r=activeRepo();if(!r)return;
    let target=branch;if(branch.startsWith("remotes/")){const c=branch.slice(8);target=c.startsWith("origin/")?c.slice(7):c;}
    const res:any=await invoke("execute_command",{serverId:props.serverId,command:`git -C ${esc(r.path)} checkout ${esc(target)}`});
    if(res.exit_code===0){props.showToast(`Checked out: ${target}`,"success");setActiveTab("status");fetchStatus();}
    else{const fb:any=await invoke("execute_command",{serverId:props.serverId,command:`git -C ${esc(r.path)} checkout ${esc(branch)}`});if(fb.exit_code===0){props.showToast(`Checked out: ${branch}`,"success");setActiveTab("status");fetchStatus();}else props.showToast(`Checkout failed: ${fb.stderr||res.stderr}`,"error");}
  };

  // ─── Streaming ─────────────────────────────────────────────────────────────

  const runStream = async (label: string, cmd: string, onDone?: (ok: boolean) => void) => {
    if(streaming()){props.showToast("Another command is running.","info");return;}
    if(unlisten){unlisten();unlisten=undefined;}
    setStreaming(true);setStreamLabel(label);setConsoleOut(`$ ${cmd}\n`);
    const sid=`git-${props.serverId}-${Math.random()*100000|0}`;streamId=sid;
    try {
      unlisten=await listen<string>(`command-stream:${sid}`,ev=>{
        setConsoleOut(p=>p+ev.payload);if(consoleRef)consoleRef.scrollTop=consoleRef.scrollHeight;
        if(ev.payload.includes("[Exit Code:")){const ok=ev.payload.includes("[Exit Code: 0]");setStreaming(false);if(unlisten){unlisten();unlisten=undefined;}onDone?.(ok);}
      });
      await invoke("start_command_stream",{serverId:props.serverId,streamId:sid,command:cmd});
    } catch(e:any){setStreaming(false);setConsoleOut(p=>p+`\nError: ${e}\n`);if(unlisten){unlisten();unlisten=undefined;}}
  };

  const handleFetch = () => { const r=activeRepo();if(!r)return; runStream("FETCH",`git -C ${esc(r.path)} fetch --all --prune 2>&1`,ok=>{if(ok){props.showToast("Fetch done.","success");fetchStatus();}else props.showToast("Fetch failed.","error");}); };
  const handlePull  = () => { const r=activeRepo();if(!r)return; runStream("PULL", `git -C ${esc(r.path)} pull 2>&1`,           ok=>{if(ok){props.showToast("Pull done.","success");fetchStatus();}else props.showToast("Pull failed.","error");}); };
  const handlePush  = () => { const r=activeRepo();if(!r)return; runStream("PUSH", `git -C ${esc(r.path)} push 2>&1`,           ok=>{if(ok){props.showToast("Push done.","success");fetchStatus();}else props.showToast("Push failed.","error");}); };
  const handleStash = async () => {
    const r=activeRepo();if(!r)return;
    const res:any=await invoke("execute_command",{serverId:props.serverId,command:`git -C ${esc(r.path)} stash`});
    const c=`${res.stdout} ${res.stderr}`;
    if(c.includes("No local changes"))props.showToast("Nothing to stash.","info");
    else if(res.exit_code===0){props.showToast("Changes stashed.","success");fetchStatus();}
    else props.showToast(`Stash failed: ${res.stderr||res.stdout}`,"error");
  };
  const handlePopStash = async () => {
    const r=activeRepo();if(!r)return;
    const res:any=await invoke("execute_command",{serverId:props.serverId,command:`git -C ${esc(r.path)} stash pop`});
    const c=`${res.stdout} ${res.stderr}`;
    if(c.toLowerCase().includes("no stash"))props.showToast("No stash entries.","info");
    else if(res.exit_code===0){props.showToast("Stash popped.","success");fetchStatus();}
    else props.showToast(`Pop failed: ${res.stderr||res.stdout}`,"error");
  };

  // — Deploy —
  const deployActionCmd = () => { const t=deployTarget().trim();if(!t)return"";if(deployType()==="service")return`sudo systemctl restart ${t}`;if(deployType()==="container")return`sudo docker restart ${t}`;return t; };
  const deployFullCmd   = () => { const r=activeRepo();if(!r)return"";const pull=`git -C ${esc(r.path)} pull 2>&1`;const a=deployActionCmd();return a?`${pull} && echo "--- DEPLOY ---" && ${a} 2>&1`:pull; };
  const deployPreview   = () => { const r=activeRepo();const path=r?.path||"/path/to/repo";const a=deployActionCmd();return a?`git -C '${path}' pull 2>&1 &&\necho "--- DEPLOY ---" &&\n${a} 2>&1`:`git -C '${path}' pull 2>&1`; };
  const saveDeployConfig = async () => { const r=activeRepo();if(!r)return;const upd:GitRepo={...r,deployAction:{type:deployType(),target:deployTarget().trim()}};await saveRepos(repos().map(x=>x.id===r.id?upd:x));setActiveRepo(upd);setDeployDirty(false);props.showToast("Deploy config saved.","success"); };
  const handleDeploy    = () => { const cmd=deployFullCmd();if(!cmd)return;runStream("DEPLOY",cmd,ok=>{if(ok){props.showToast("Deployment done!","success");fetchStatus();}else props.showToast("Deployment failed.","error");}); };

  const copyHash = (h: string) => { navigator.clipboard.writeText(h); props.showToast("Copied.", "success"); };
  const refresh  = () => { if(activeTab()==="status")fetchStatus();else if(activeTab()==="log")fetchLog();else if(activeTab()==="branches")fetchBranches(); };

  // ─── File row renderer ─────────────────────────────────────────────────────

  const FileRow = (p: { item: FlatItem; section: "staged"|"unstaged" }) => {
    const { item, section } = p;
    const code   = () => effectiveCode(item.xy!, section);
    const letter = () => statusLetter(code());
    const color  = () => statusColor(code());
    const indent = item.depth * 12 + (item.type === "dir" ? 8 : 22);
    if (item.type === "dir") return (
      <div class="scm-file-row" style={{"padding-left":`${indent-14}px`}} onClick={()=>toggleDir(item.fullPath)}>
        <ChevronRight size={11} style={{"transition":"transform 0.12s","transform":item.isCollapsed?"rotate(0deg)":"rotate(90deg)","color":"var(--text-muted)","flex-shrink":"0","margin-right":"4px"}}/>
        <Folder size={13} style={{"color":"var(--accent-cyan)","flex-shrink":"0","margin-right":"5px"}}/>
        <span style={{"font-size":"13px","color":"var(--text-secondary)","flex":"1","overflow":"hidden","text-overflow":"ellipsis","white-space":"nowrap"}}>{item.name}</span>
        <span style={{"font-size":"11px","color":"var(--text-muted)","font-family":"var(--font-mono)","margin-left":"8px","flex-shrink":"0"}}>{item.fileCount}</span>
      </div>
    );
    return (
      <div class="scm-file-row" style={{"padding-left":`${indent}px`}} title={item.filePath}>
        <span style={{"font-size":"13px","color":"var(--text-primary)","flex":"1","overflow":"hidden","text-overflow":"ellipsis","white-space":"nowrap"}}>{item.name}</span>
        <Show when={item.filePath?.includes(" → ")}>
          <span style={{"font-size":"10px","color":"var(--text-muted)","font-family":"var(--font-mono)","margin-right":"4px","flex-shrink":"0"}}>{item.filePath!.split(" → ")[0].split("/").pop()}</span>
        </Show>
        <Show when={section==="staged"}>
          <button class="scm-icon-btn unstage" title="Unstage" onClick={e=>{e.stopPropagation();unstageFile(item.filePath!);}}><Minus size={11}/></button>
        </Show>
        <Show when={section==="unstaged"}>
          <button class="scm-icon-btn stage"   title="Stage"   onClick={e=>{e.stopPropagation();stageFile(item.filePath!);}}><Plus size={11}/></button>
          <button class="scm-icon-btn discard" title="Discard" onClick={e=>{e.stopPropagation();discardFile(item.filePath!,item.xy==="??");}}><RotateCcw size={11}/></button>
        </Show>
        <span style={{"font-size":"12px","font-weight":"700","width":"14px","text-align":"right","flex-shrink":"0","margin-left":"4px","color":color(),"font-family":"var(--font-mono)"}}>{letter()}</span>
      </div>
    );
  };

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div class="split-pane h-full flex-1">

      {/* ── Left: Repo list ─────────────────────────────────────────────────── */}
      <div style={{"flex":"0 0 210px",display:"flex","flex-direction":"column",background:"var(--bg-card)",border:"1px solid var(--border-color)","border-radius":"4px",overflow:"hidden"}}>
        <div style={{padding:"10px 12px 8px","border-bottom":"1px solid var(--border-color)",background:"var(--bg-secondary)",display:"flex","align-items":"center",gap:"6px"}}>
          <span style={{"font-size":"10px","font-weight":"700","text-transform":"uppercase","letter-spacing":"0.08em",color:"var(--text-muted)","font-family":"var(--font-mono)",flex:"1"}}>Repositories</span>
          <button class="git-header-btn" onClick={handleAutoScan} disabled={scanning()} title="Auto-scan">
            <Show when={scanning()} fallback={<RefreshCw size={12}/>}><Loader size={12} class="animate-spin"/></Show>
          </button>
          <button class="git-header-btn" onClick={()=>setShowAddForm(v=>!v)} title="Add manually"><Plus size={13}/></button>
        </div>
        <div style={{flex:"1","overflow-y":"auto",padding:"6px"}}>
          <For each={repos()}>
            {repo=>(
              <div class={`scm-repo-item group ${activeRepo()?.id===repo.id?"active":""}`} onClick={()=>{setActiveRepo(repo);setShowAddForm(false);}}>
                <span class={`status-dot shrink-0 ${activeRepo()?.id===repo.id?"active":"inactive"}`}/>
                <div style={{flex:"1","min-width":"0"}}>
                  <p class="scm-repo-name" style={{"font-size":"12px","font-weight":"600",color:"var(--text-primary)",overflow:"hidden","text-overflow":"ellipsis","white-space":"nowrap"}}>{repo.name}</p>
                  <p style={{"font-size":"10px",color:"var(--text-muted)","font-family":"var(--font-mono)",overflow:"hidden","text-overflow":"ellipsis","white-space":"nowrap"}}>{repo.path}</p>
                </div>
                <button class="scm-icon-btn discard scm-show-on-hover" onClick={e=>handleDeleteRepo(repo.id,repo.name,e)} title="Remove" style={{opacity:"0"}}><Trash2 size={11}/></button>
              </div>
            )}
          </For>
          <Show when={repos().length===0&&!showAddForm()}>
            <p style={{"font-size":"11px",color:"var(--text-muted)","text-align":"center",padding:"24px 8px","font-family":"var(--font-mono)"}}>No repositories.</p>
          </Show>
        </div>
        <Show when={showAddForm()}>
          <div style={{"border-top":"1px solid var(--border-color)",padding:"10px 12px",background:"var(--bg-secondary)"}}>
            <p style={{"font-size":"10px","font-weight":"700","text-transform":"uppercase",color:"var(--text-muted)","letter-spacing":"0.07em","margin-bottom":"8px"}}>Add Repository</p>
            <form onSubmit={handleAddRepo} style={{display:"flex","flex-direction":"column",gap:"6px"}}>
              <input type="text" placeholder="Server path" value={newPath()} onInput={e=>setNewPath(e.currentTarget.value)} style={{"font-size":"11px"}} required/>
              <input type="text" placeholder="Display name" value={newName()} onInput={e=>setNewName(e.currentTarget.value)} style={{"font-size":"11px"}} required/>
              <div style={{display:"flex",gap:"6px"}}>
                <button type="submit" class="btn-primary" style={{flex:"1","font-size":"11px",padding:"5px 8px"}} disabled={addingRepo()}>
                  <Show when={addingRepo()} fallback={<Check size={11}/>}><Loader size={11} class="animate-spin"/></Show> Add
                </button>
                <button type="button" class="btn-secondary" style={{"font-size":"11px",padding:"5px 8px"}} onClick={()=>{setShowAddForm(false);setNewPath("");setNewName("");}}>
                  <X size={11}/>
                </button>
              </div>
            </form>
          </div>
        </Show>
      </div>

      {/* ── Right: Main workspace ────────────────────────────────────────────── */}
      <div style={{flex:"1",display:"flex","flex-direction":"column",background:"var(--bg-card)",border:"1px solid var(--border-color)","border-radius":"4px",overflow:"hidden","min-width":"0"}}>

        <Show when={!activeRepo()}>
          <div style={{flex:"1",display:"flex","flex-direction":"column","align-items":"center","justify-content":"center",gap:"16px",padding:"40px"}}>
            <GitBranch size={44} style={{color:"var(--text-muted)"}}/>
            <div style={{"text-align":"center"}}>
              <p style={{"font-size":"13px","font-weight":"600",color:"var(--text-primary)","margin-bottom":"6px"}}>No Repository Selected</p>
              <p style={{"font-size":"12px",color:"var(--text-secondary)","max-width":"260px","line-height":"1.5"}}>Add a repository manually or let Vessel scan your server.</p>
            </div>
            <div style={{display:"flex",gap:"8px"}}>
              <button class="btn-primary" style={{"font-size":"12px",padding:"7px 14px",display:"flex","align-items":"center",gap:"6px"}} onClick={handleAutoScan} disabled={scanning()}>
                <Show when={scanning()} fallback={<RefreshCw size={12}/>}><Loader size={12} class="animate-spin"/></Show> Auto Scan
              </button>
              <button class="btn-secondary" style={{"font-size":"12px",padding:"7px 14px",display:"flex","align-items":"center",gap:"6px"}} onClick={()=>setShowAddForm(true)}>
                <Plus size={12}/> Add Manually
              </button>
            </div>
          </div>
        </Show>

        <Show when={activeRepo()}>
          {/* ── Toolbar ── */}
          <div style={{display:"flex","align-items":"center",gap:"6px",padding:"0 12px",height:"40px","border-bottom":"1px solid var(--border-color)",background:"var(--bg-secondary)","flex-shrink":"0"}}>
            <GitBranch size={13} style={{color:"var(--accent-cyan)","flex-shrink":"0"}}/>
            <span style={{"font-size":"13px","font-weight":"600",color:"var(--text-primary)","font-family":"var(--font-mono)"}}>{activeRepo()?.name}</span>
            <Show when={branchName()}>
              <div style={{display:"flex","align-items":"center",gap:"4px",background:"var(--bg-active)",border:"1px solid var(--border-color)","border-radius":"3px",padding:"2px 7px"}}>
                <span style={{"font-size":"11px","font-family":"var(--font-mono)",color:"var(--text-secondary)"}}>{branchName()}</span>
              </div>
            </Show>
            <Show when={upstream()}>
              <span style={{"font-size":"11px",color:"var(--text-muted)","font-family":"var(--font-mono)"}}>{upstream()}</span>
            </Show>
            <Show when={ahead()>0||behind()>0}>
              <div style={{display:"flex","align-items":"center",gap:"4px","font-size":"11px","font-family":"var(--font-mono)","font-weight":"700"}}>
                <Show when={ahead()>0}><span style={{color:"var(--accent-cyan)"}}>↑{ahead()}</span></Show>
                <Show when={behind()>0}><span style={{color:"var(--accent-warning)"}}>↓{behind()}</span></Show>
              </div>
            </Show>
            <div style={{flex:"1"}}/>
            <button class="git-header-btn" onClick={refresh} disabled={statusLoading()||logLoading()||branchesLoading()} title="Refresh"><RotateCw size={13} class={(statusLoading()||logLoading()||branchesLoading())?"animate-spin":""}/></button>
            <button class="git-header-btn" onClick={handleFetch} disabled={streaming()} title="Fetch"><RefreshCw size={13}/></button>
            <button class="git-header-btn" onClick={handlePull}  disabled={streaming()} title="Pull"><ArrowDown size={13}/></button>
            <button class="git-header-btn" onClick={handlePush}  disabled={streaming()} title="Push"><ArrowUp size={13}/></button>
            <div style={{width:"1px",height:"16px",background:"var(--border-color)",margin:"0 2px"}}/>
            <button class="git-header-btn" onClick={handleStash}    disabled={streaming()} title="Stash"><span style={{"font-size":"10px","font-family":"var(--font-mono)","font-weight":"700",color:"var(--text-secondary)",padding:"0 2px"}}>SH</span></button>
            <button class="git-header-btn" onClick={handlePopStash} disabled={streaming()} title="Pop stash"><span style={{"font-size":"10px","font-family":"var(--font-mono)","font-weight":"700",color:"var(--text-secondary)",padding:"0 2px"}}>POP</span></button>
          </div>

          {/* ── Tab bar ── */}
          <div class="scm-tab-bar">
            {(["status","log","branches","deploy"] as const).map(t=>(
              <button class={`scm-tab-btn ${activeTab()===t?"active":""}`} onClick={()=>setActiveTab(t)}>
                {t==="status"?"Source Control":t==="log"?"Commit Graph":t==="branches"?"Branches":"Deploy"}
              </button>
            ))}
          </div>

          {/* ── Tab content ── */}
          <div style={{flex:"1","min-height":"0",overflow:"hidden",display:"flex","flex-direction":"column"}}>

            {/* ══ SOURCE CONTROL ══════════════════════════════════════════════ */}
            <Show when={activeTab()==="status"}>
              <div style={{display:"flex","flex-direction":"column",flex:"1","min-height":"0",overflow:"hidden"}}>
                {/* Commit area */}
                <div style={{padding:"10px 12px","border-bottom":"1px solid var(--border-color)",background:"var(--bg-secondary)","flex-shrink":"0"}}>
                  <textarea
                    style={{width:"100%","font-size":"12px",resize:"none",padding:"7px 10px","border-radius":"3px","font-family":"var(--font-sans)","line-height":"1.5","box-sizing":"border-box"}}
                    placeholder="Message (Ctrl+Enter to commit)"
                    rows={3}
                    value={commitMessage()}
                    onInput={e=>setCommitMessage(e.currentTarget.value)}
                    onKeyDown={e=>{if(e.key==="Enter"&&(e.ctrlKey||e.metaKey))handleCommit();}}
                  />
                  <div style={{display:"flex",gap:"6px","margin-top":"8px"}}>
                    <button class="btn-primary" style={{flex:"1","font-size":"12px",padding:"6px 10px",display:"flex","align-items":"center","justify-content":"center",gap:"6px"}} onClick={handleCommit} disabled={committing()||!commitMessage().trim()||staged().length===0}>
                      <Show when={committing()} fallback={<Check size={12}/>}><Loader size={12} class="animate-spin"/></Show>
                      <Show when={staged().length>0} fallback="Commit">Commit {staged().length} file{staged().length!==1?"s":""}</Show>
                    </button>
                    <Show when={unstaged().length>0}>
                      <button class="btn-secondary" style={{"font-size":"12px",padding:"6px 10px",display:"flex","align-items":"center",gap:"5px"}} onClick={stageAll} title="Stage all"><Plus size={11}/> All</button>
                    </Show>
                  </div>
                </div>
                {/* File tree */}
                <div style={{flex:"1","overflow-y":"auto","min-height":"0"}}>
                  <Show when={statusLoading()}>
                    <div style={{padding:"32px","text-align":"center","font-size":"12px",color:"var(--text-muted)"}}>
                      <Loader class="animate-spin inline" size={12} style={{"margin-right":"6px",color:"var(--accent-cyan)"}}/> Loading…
                    </div>
                  </Show>
                  <Show when={!statusLoading()&&files().length===0&&incomingFiles().length===0}>
                    <div style={{padding:"40px","text-align":"center"}}>
                      <Check size={24} style={{color:"var(--accent-success)",margin:"0 auto 10px"}}/>
                      <p style={{"font-size":"12px",color:"var(--text-muted)","font-family":"var(--font-mono)"}}>Working directory clean</p>
                    </div>
                  </Show>
                  {/* Incoming */}
                  <Show when={!statusLoading()&&incomingFiles().length>0}>
                    <div class="scm-section-header" onClick={()=>setIncomingCollapsed(v=>!v)}>
                      <ChevronRight size={12} style={{"flex-shrink":"0","transition":"transform 0.12s","transform":incomingCollapsed()?"rotate(0deg)":"rotate(90deg)",color:"var(--accent-cyan)","margin-right":"4px"}}/>
                      <span style={{"font-size":"10px","font-weight":"700","text-transform":"uppercase","letter-spacing":"0.07em",color:"var(--accent-cyan)","font-family":"var(--font-mono)",flex:"1"}}>Incoming Changes</span>
                      <span style={{"font-size":"11px",color:"var(--accent-cyan)","font-family":"var(--font-mono)","margin-right":"6px"}}>{incomingFiles().length}</span>
                    </div>
                    <Show when={!incomingCollapsed()}>
                      <Show when={incomingCommits().length>0}>
                        <div style={{margin:"6px 12px",padding:"8px 10px",background:"var(--bg-secondary)",border:"1px solid var(--border-color)","border-radius":"3px",display:"flex","flex-direction":"column",gap:"5px"}}>
                          <p style={{"font-size":"10px","font-weight":"700","text-transform":"uppercase","letter-spacing":"0.06em",color:"var(--text-muted)","margin-bottom":"2px"}}>Incoming commits</p>
                          <For each={incomingCommits()}>{c=>(
                            <div style={{display:"flex",gap:"8px","align-items":"baseline"}}>
                              <span style={{"font-size":"11px","font-family":"var(--font-mono)",color:"var(--accent-cyan)","flex-shrink":"0"}}>{c.hash.slice(0,7)}</span>
                              <span style={{"font-size":"12px",color:"var(--text-secondary)",flex:"1",overflow:"hidden","text-overflow":"ellipsis","white-space":"nowrap"}}>{c.message}</span>
                              <span style={{"font-size":"10px",color:"var(--text-muted)","flex-shrink":"0"}}>{c.relativeDate}</span>
                            </div>
                          )}</For>
                        </div>
                      </Show>
                      <For each={flatIncoming()}>{item=><FileRow item={item} section="unstaged"/>}</For>
                    </Show>
                  </Show>
                  {/* Staged */}
                  <Show when={!statusLoading()&&staged().length>0}>
                    <div class="scm-section-header" onClick={()=>setStagedCollapsed(v=>!v)}>
                      <ChevronRight size={12} style={{"flex-shrink":"0","transition":"transform 0.12s","transform":stagedCollapsed()?"rotate(0deg)":"rotate(90deg)",color:"var(--text-muted)","margin-right":"4px"}}/>
                      <span style={{"font-size":"10px","font-weight":"700","text-transform":"uppercase","letter-spacing":"0.07em",color:"var(--accent-success)","font-family":"var(--font-mono)",flex:"1"}}>Staged Changes</span>
                      <span style={{"font-size":"11px",color:"var(--text-muted)","font-family":"var(--font-mono)","margin-right":"6px"}}>{staged().length}</span>
                      <button style={{"font-size":"10px",color:"var(--text-muted)",background:"transparent",border:"none",cursor:"pointer",padding:"0 4px","border-radius":"2px","font-family":"var(--font-sans)"}} onClick={e=>{e.stopPropagation();unstageAll();}} onMouseEnter={e=>{(e.target as HTMLElement).style.color="var(--accent-warning)";}} onMouseLeave={e=>{(e.target as HTMLElement).style.color="var(--text-muted)";}}>Unstage All</button>
                    </div>
                    <Show when={!stagedCollapsed()}><For each={flatStaged()}>{item=><FileRow item={item} section="staged"/>}</For></Show>
                  </Show>
                  {/* Changes */}
                  <Show when={!statusLoading()&&unstaged().length>0}>
                    <div class="scm-section-header" onClick={()=>setChangesCollapsed(v=>!v)}>
                      <ChevronRight size={12} style={{"flex-shrink":"0","transition":"transform 0.12s","transform":changesCollapsed()?"rotate(0deg)":"rotate(90deg)",color:"var(--text-muted)","margin-right":"4px"}}/>
                      <span style={{"font-size":"10px","font-weight":"700","text-transform":"uppercase","letter-spacing":"0.07em",color:"var(--text-muted)","font-family":"var(--font-mono)",flex:"1"}}>Changes</span>
                      <span style={{"font-size":"11px",color:"var(--text-muted)","font-family":"var(--font-mono)","margin-right":"6px"}}>{unstaged().length}</span>
                      <button style={{"font-size":"10px",color:"var(--text-muted)",background:"transparent",border:"none",cursor:"pointer",padding:"0 4px","border-radius":"2px","font-family":"var(--font-sans)"}} onClick={e=>{e.stopPropagation();stageAll();}} onMouseEnter={e=>{(e.target as HTMLElement).style.color="var(--accent-success)";}} onMouseLeave={e=>{(e.target as HTMLElement).style.color="var(--text-muted)";}}>Stage All</button>
                    </div>
                    <Show when={!changesCollapsed()}><For each={flatUnstaged()}>{item=><FileRow item={item} section="unstaged"/>}</For></Show>
                  </Show>
                </div>
              </div>
            </Show>

            {/* ══ COMMIT GRAPH ════════════════════════════════════════════════ */}
            <Show when={activeTab()==="log"}>
              <div style={{display:"flex","flex-direction":"column",flex:"1","min-height":"0",overflow:"hidden"}}>
                {/* Header */}
                <div style={{display:"flex","align-items":"center",padding:"7px 16px","border-bottom":"1px solid var(--border-color)",background:"var(--bg-secondary)","flex-shrink":"0",gap:"10px"}}>
                  <span style={{"font-size":"12px","font-weight":"600",color:"var(--text-primary)",flex:"1"}}>Commit Graph</span>
                  {/* Legend */}
                  <div style={{display:"flex","align-items":"center",gap:"10px"}}>
                    <For each={LANE_COLORS.slice(0,5)}>
                      {c=><div style={{width:"8px",height:"8px","border-radius":"50%",background:c,"flex-shrink":"0"}}/>}
                    </For>
                  </div>
                  <span style={{"font-size":"10px",color:"var(--text-muted)","font-family":"var(--font-mono)"}}>last 120 · all branches</span>
                </div>

                {/* Graph body */}
                <div style={{flex:"1","overflow-y":"auto","min-height":"0"}}>
                  <Show when={logLoading()}>
                    <div style={{padding:"32px","text-align":"center","font-size":"12px",color:"var(--text-muted)"}}>
                      <Loader class="animate-spin inline" size={12} style={{"margin-right":"6px",color:"var(--accent-cyan)"}}/> Computing graph…
                    </div>
                  </Show>
                  <Show when={!logLoading()&&commits().length===0}>
                    <div style={{padding:"40px","text-align":"center","font-size":"12px",color:"var(--text-muted)"}}>No commits found.</div>
                  </Show>

                  <For each={layoutRows()}>
                    {row=>{
                      // refs in CommitInfo are already pre-split by ", " from %D — classify directly
                      const refs = () => row.commit.refs
                        .filter(r => r && r.trim().length > 0)
                        .map(r => classifyRef(r.trim()))
                        .filter(r => r.kind in REF_STYLES);
                      const svgW = () => Math.max(row.totalCols, 1) * LANE_W + LANE_W;
                      return (
                        <div
                          class="git-commit-row"
                          style={{padding:"0",gap:"0",height:`${ROW_H}px`,"align-items":"stretch"}}
                          onClick={()=>copyHash(row.commit.hash)}
                          title="Click to copy full hash"
                        >
                          {/* SVG graph cell */}
                          <div style={{"flex-shrink":"0",width:`${svgW()}px`,position:"relative"}}>
                            <svg
                              width={svgW()}
                              height={ROW_H}
                              style={{display:"block","overflow":"visible"}}
                            >
                              {/* Edges */}
                              <For each={row.edges}>{edge=><EdgePath edge={edge}/>}</For>
                              {/* Node ring (outer glow) */}
                              <circle
                                cx={cx(row.lane)}
                                cy={MID_Y}
                                r={NODE_R + 2}
                                fill={row.nodeColor}
                                opacity="0.2"
                              />
                              {/* Node */}
                              <circle
                                cx={cx(row.lane)}
                                cy={MID_Y}
                                r={NODE_R}
                                fill={row.nodeColor}
                                stroke="var(--bg-card)"
                                stroke-width="1.5"
                              />
                            </svg>
                          </div>

                          {/* Commit info */}
                          <div style={{flex:"1","min-width":"0",display:"flex","align-items":"center",gap:"8px",padding:"0 10px 0 6px"}}>
                            {/* Ref badges */}
                            <Show when={refs().length>0}>
                              <div style={{display:"flex",gap:"4px","flex-shrink":"0","align-items":"center","max-width":"40%",overflow:"hidden"}}>
                                <For each={refs().slice(0,3)}>{ref=><RefBadge ref={ref}/>}</For>
                                <Show when={refs().length>3}>
                                  <span style={{"font-size":"10px",color:"var(--text-muted)","flex-shrink":"0"}}>+{refs().length-3}</span>
                                </Show>
                              </div>
                            </Show>
                            {/* Message */}
                            <span style={{"font-size":"12px",color:"var(--text-primary)","font-weight":"500",flex:"1",overflow:"hidden","text-overflow":"ellipsis","white-space":"nowrap"}}>
                              {row.commit.message}
                            </span>
                            {/* Hash */}
                            <span style={{"font-size":"10px","font-family":"var(--font-mono)",color:`${row.nodeColor}cc`,"flex-shrink":"0"}}>
                              {row.commit.hash.slice(0,7)}
                            </span>
                            {/* Author */}
                            <span style={{"font-size":"11px",color:"var(--text-muted)","flex-shrink":"0","max-width":"90px",overflow:"hidden","text-overflow":"ellipsis","white-space":"nowrap"}}>
                              {row.commit.author}
                            </span>
                            {/* Date */}
                            <span style={{"font-size":"10px",color:"var(--text-muted)","flex-shrink":"0","white-space":"nowrap"}} title={row.commit.date}>
                              {row.commit.relativeDate}
                            </span>
                          </div>
                        </div>
                      );
                    }}
                  </For>
                </div>
              </div>
            </Show>

            {/* ══ BRANCHES ════════════════════════════════════════════════════ */}
            <Show when={activeTab()==="branches"}>
              <div style={{display:"flex","flex-direction":"column",flex:"1","min-height":"0",overflow:"hidden"}}>
                <div style={{display:"flex","align-items":"center",padding:"0 12px",height:"38px","border-bottom":"1px solid var(--border-color)",background:"var(--bg-secondary)","flex-shrink":"0"}}>
                  <span style={{"font-size":"10px","font-weight":"700","text-transform":"uppercase","letter-spacing":"0.07em",color:"var(--text-muted)","font-family":"var(--font-mono)",flex:"1"}}>LOCAL BRANCHES</span>
                  <button style={{"font-size":"11px",color:"var(--text-secondary)",background:"transparent",border:"1px solid var(--border-color)","border-radius":"3px",padding:"3px 8px",cursor:"pointer",display:"flex","align-items":"center",gap:"4px",transition:"all 0.1s"}} onClick={()=>setShowNewBranch(v=>!v)} onMouseEnter={e=>{(e.target as HTMLElement).style.color="var(--accent-cyan)";(e.target as HTMLElement).style.borderColor="var(--accent-cyan)";}} onMouseLeave={e=>{(e.target as HTMLElement).style.color="var(--text-secondary)";(e.target as HTMLElement).style.borderColor="var(--border-color)";}}>
                    <Plus size={10}/> New Branch
                  </button>
                </div>
                <div style={{flex:"1","overflow-y":"auto","min-height":"0"}}>
                  <Show when={showNewBranch()}>
                    <form onSubmit={handleCreateBranch} style={{padding:"8px 12px","border-bottom":"1px solid var(--border-color)",background:"var(--bg-secondary)",display:"flex",gap:"6px","align-items":"center"}}>
                      <GitBranch size={12} style={{color:"var(--text-muted)","flex-shrink":"0"}}/>
                      <input type="text" placeholder="branch-name" value={newBranchName()} onInput={e=>setNewBranchName(e.currentTarget.value)} style={{flex:"1","font-size":"12px","font-family":"var(--font-mono)",padding:"4px 8px"}} autofocus required/>
                      <button type="submit" class="btn-primary" style={{"font-size":"11px",padding:"4px 10px",display:"flex","align-items":"center",gap:"4px"}} disabled={creatingBranch()}>
                        <Show when={creatingBranch()} fallback={<Check size={10}/>}><Loader size={10} class="animate-spin"/></Show> Create
                      </button>
                      <button type="button" class="btn-secondary" style={{"font-size":"11px",padding:"4px 8px"}} onClick={()=>{setShowNewBranch(false);setNewBranchName("");}}><X size={10}/></button>
                    </form>
                  </Show>
                  <Show when={branchesLoading()}>
                    <div style={{padding:"24px","text-align":"center","font-size":"12px",color:"var(--text-muted)"}}><Loader class="animate-spin inline" size={12} style={{color:"var(--accent-cyan)"}}/></div>
                  </Show>
                  <Show when={!branchesLoading()}>
                    <For each={branches().filter(b=>!b.name.startsWith("remotes/"))}>
                      {branch=>(
                        <div class={`git-branch-row ${branch.isCurrent?"current":""}`}>
                          <Show when={branch.isCurrent} fallback={<div style={{width:"8px","flex-shrink":"0"}}/>}>
                            <Check size={11} style={{color:"var(--accent-success)","flex-shrink":"0"}}/>
                          </Show>
                          <span style={{"font-size":"13px","font-family":"var(--font-mono)",color:branch.isCurrent?"var(--accent-cyan)":"var(--text-primary)","font-weight":branch.isCurrent?"600":"400",flex:"1",overflow:"hidden","text-overflow":"ellipsis","white-space":"nowrap"}}>{branch.name}</span>
                          <Show when={branch.upstream}>
                            <span style={{"font-size":"10px",color:"var(--text-muted)","font-family":"var(--font-mono)","flex-shrink":"0","margin-right":"8px"}}>{branch.upstream}</span>
                          </Show>
                          <Show when={!branch.isCurrent}>
                            <button class="btn-secondary" style={{"font-size":"10px",padding:"2px 8px"}} onClick={()=>handleCheckout(branch.name)}>Checkout</button>
                            <button class="git-header-btn" title="Delete" onClick={()=>handleDeleteBranch(branch.name)} style={{color:"var(--text-muted)"}} onMouseEnter={e=>{(e.target as HTMLElement).style.color="var(--accent-danger)";}} onMouseLeave={e=>{(e.target as HTMLElement).style.color="var(--text-muted)";}}>
                              <Trash2 size={12}/>
                            </button>
                          </Show>
                        </div>
                      )}
                    </For>
                    <Show when={branches().some(b=>b.name.startsWith("remotes/"))}>
                      <div style={{display:"flex","align-items":"center",padding:"0 12px",height:"32px","border-bottom":"1px solid var(--border-color)","border-top":"1px solid var(--border-color)",background:"var(--bg-secondary)","margin-top":"4px"}}>
                        <span style={{"font-size":"10px","font-weight":"700","text-transform":"uppercase","letter-spacing":"0.07em",color:"var(--text-muted)","font-family":"var(--font-mono)"}}>REMOTE BRANCHES</span>
                      </div>
                      <For each={branches().filter(b=>b.name.startsWith("remotes/"))}>
                        {branch=>(
                          <div class="git-branch-row">
                            <div style={{width:"8px","flex-shrink":"0"}}/>
                            <span style={{"font-size":"13px","font-family":"var(--font-mono)",color:"var(--text-secondary)",flex:"1",overflow:"hidden","text-overflow":"ellipsis","white-space":"nowrap"}}>{branch.name}</span>
                            <button class="btn-secondary" style={{"font-size":"10px",padding:"2px 8px"}} onClick={()=>handleCheckout(branch.name)}>Checkout</button>
                          </div>
                        )}
                      </For>
                    </Show>
                  </Show>
                </div>
              </div>
            </Show>

            {/* ══ DEPLOY ══════════════════════════════════════════════════════ */}
            <Show when={activeTab()==="deploy"}>
              <div style={{flex:"1","overflow-y":"auto",padding:"20px"}}>
                <div style={{"margin-bottom":"16px"}}>
                  <p style={{"font-size":"12px","font-weight":"700","text-transform":"uppercase","letter-spacing":"0.06em",color:"var(--text-primary)","margin-bottom":"4px","font-family":"var(--font-mono)"}}>Deploy Pipeline</p>
                  <p style={{"font-size":"12px",color:"var(--text-secondary)","line-height":"1.5"}}>Define a post-pull action. Runs automatically after a successful git pull.</p>
                </div>
                <div style={{padding:"16px",border:"1px solid var(--border-color)","border-radius":"3px",background:"var(--bg-secondary)",display:"flex","flex-direction":"column",gap:"14px","margin-bottom":"16px"}}>
                  <div>
                    <p style={{"font-size":"10px","font-weight":"600","text-transform":"uppercase","letter-spacing":"0.06em",color:"var(--text-muted)","margin-bottom":"8px"}}>Action Type</p>
                    <div style={{display:"grid","grid-template-columns":"repeat(3, 1fr)",gap:"8px"}}>
                      {(["service","container","command"] as const).map(type=>(
                        <div style={{border:`1px solid ${deployType()===type?"var(--accent-cyan)":"var(--border-color)"}`,  "border-radius":"3px",padding:"10px",cursor:"pointer",background:deployType()===type?"rgba(0,145,255,0.05)":"transparent",transition:"all 0.1s",display:"flex","flex-direction":"column",gap:"3px"}} onClick={()=>{setDeployType(type);setDeployDirty(true);}}>
                          <span style={{"font-size":"12px","font-weight":"600",color:deployType()===type?"var(--accent-cyan)":"var(--text-primary)"}}>{type==="service"?"systemd Service":type==="container"?"Docker Container":"Custom Script"}</span>
                          <span style={{"font-size":"10px",color:"var(--text-muted)"}}>{type==="service"?"Restart via systemctl":type==="container"?"Restart container":"Shell command"}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div>
                    <p style={{"font-size":"10px","font-weight":"600","text-transform":"uppercase","letter-spacing":"0.06em",color:"var(--text-muted)","margin-bottom":"6px"}}>{deployType()==="service"?"Service Name":deployType()==="container"?"Container Name / ID":"Shell Command"}</p>
                    <input type="text" placeholder={deployType()==="service"?"e.g. nginx":deployType()==="container"?"e.g. my-app":"e.g. npm run build && pm2 reload app"} value={deployTarget()} onInput={e=>{setDeployTarget(e.currentTarget.value);setDeployDirty(true);}} style={{width:"100%","font-family":"var(--font-mono)","font-size":"12px"}}/>
                  </div>
                  <div style={{display:"flex","justify-content":"flex-end"}}>
                    <button class="btn-primary" style={{"font-size":"12px"}} onClick={saveDeployConfig} disabled={!deployDirty()||!deployTarget().trim()}>Save Config</button>
                  </div>
                </div>
                <div style={{"margin-bottom":"16px"}}>
                  <p style={{"font-size":"10px","font-weight":"700","text-transform":"uppercase","letter-spacing":"0.06em",color:"var(--text-muted)","margin-bottom":"6px","font-family":"var(--font-mono)"}}>Command Preview</p>
                  <pre style={{background:"var(--bg-secondary)",border:"1px solid var(--border-color)","border-radius":"3px",padding:"10px 12px","font-size":"11px","font-family":"var(--font-mono)",color:"var(--text-secondary)","line-height":"1.6","white-space":"pre-wrap","user-select":"all"}}>{deployPreview()}</pre>
                </div>
                <button class="btn-primary" style={{width:"100%","font-size":"13px",padding:"10px","font-weight":"700",display:"flex","align-items":"center","justify-content":"center",gap:"8px"}} onClick={handleDeploy} disabled={streaming()}>
                  <Play size={13}/> Deploy Now
                </button>
              </div>
            </Show>

          </div>

          {/* ── Console ── */}
          <Show when={streaming()||consoleOut().length>0}>
            <div style={{"flex-shrink":"0",height:"190px",display:"flex","flex-direction":"column",background:"#040507","border-top":"1px solid var(--border-color)"}}>
              <div style={{display:"flex","align-items":"center",gap:"8px",padding:"6px 12px",background:"var(--bg-secondary)","border-bottom":"1px solid var(--border-color)","flex-shrink":"0"}}>
                <span class={`status-dot ${streaming()?"active animate-pulse":"inactive"}`}/>
                <span style={{"font-size":"10px","font-weight":"700","text-transform":"uppercase","letter-spacing":"0.07em",color:"var(--text-primary)","font-family":"var(--font-mono)",flex:"1"}}>
                  {streamLabel()}
                  <Show when={!streaming()}><span style={{color:"var(--text-muted)","font-weight":"400"}}> · done</span></Show>
                </span>
                <button class="git-header-btn" onClick={()=>setConsoleOut("")} title="Clear"><X size={12}/></button>
              </div>
              <div ref={consoleRef} style={{flex:"1","overflow-y":"auto",padding:"10px 14px","font-family":"var(--font-mono)","font-size":"11px",color:"#a5b4fc","line-height":"1.5","white-space":"pre-wrap","user-select":"text"}}>
                {consoleOut()}
              </div>
            </div>
          </Show>
        </Show>

      </div>
    </div>
  );
}
