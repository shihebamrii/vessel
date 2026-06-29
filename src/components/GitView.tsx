import { createSignal, createMemo, createEffect, onCleanup, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  Plus,
  Trash2,
  GitBranch,
  RotateCw,
  Loader,
  Play,
  Check,
  X,
  ArrowDown,
  ChevronRight,
  Folder
} from "lucide-solid";

interface GitViewProps {
  serverId: string;
  showToast: (message: string, type?: "success" | "error" | "info") => void;
}

interface GitRepo {
  id: string;
  name: string;
  path: string;
  deployAction?: {
    type: "service" | "container" | "command";
    target: string;
  };
}

interface CommitInfo {
  hash: string;
  author: string;
  message: string;
  relativeDate: string;
  date: string;
  graphChars: string;
  isGraphOnly: boolean;
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

// ─── Tree view helpers ────────────────────────────────────────────────────────

interface TreeNode {
  name: string;
  fullPath: string;
  filePath?: string;
  xy?: string;
  type: "dir" | "file";
  children: TreeNode[];
  fileCount: number;
}

interface FlatTreeItem {
  type: "dir" | "file";
  name: string;
  fullPath: string;
  filePath?: string;
  xy?: string;
  depth: number;
  fileCount: number;
  isCollapsed: boolean;
}

function buildFileTree(files: FileStatus[]): TreeNode[] {
  type DirMap = { dirs: Record<string, DirMap>; files: FileStatus[] };
  const root: DirMap = { dirs: {}, files: [] };

  for (const file of files) {
    const treePath = file.path.includes(" → ")
      ? file.path.split(" → ")[1]
      : file.path;
    const parts = treePath.replace(/^\//, "").split("/");
    let curr = root;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!curr.dirs[parts[i]]) curr.dirs[parts[i]] = { dirs: {}, files: [] };
      curr = curr.dirs[parts[i]];
    }
    curr.files.push(file);
  }

  function countFiles(dir: DirMap): number {
    let n = dir.files.length;
    for (const sub of Object.values(dir.dirs)) n += countFiles(sub);
    return n;
  }

  function toNodes(dir: DirMap, prefix: string): TreeNode[] {
    const nodes: TreeNode[] = [];
    for (const [name, sub] of Object.entries(dir.dirs).sort((a, b) => a[0].localeCompare(b[0]))) {
      const fullPath = prefix ? `${prefix}/${name}` : name;
      nodes.push({ name, fullPath, type: "dir", children: toNodes(sub, fullPath), fileCount: countFiles(sub) });
    }
    for (const file of [...dir.files].sort((a, b) => {
      const aName = (a.path.includes(" → ") ? a.path.split(" → ")[1] : a.path).split("/").pop()!;
      const bName = (b.path.includes(" → ") ? b.path.split(" → ")[1] : b.path).split("/").pop()!;
      return aName.localeCompare(bName);
    })) {
      const treePath = file.path.includes(" → ") ? file.path.split(" → ")[1] : file.path;
      const name = treePath.split("/").pop()!;
      nodes.push({ name, fullPath: file.path, filePath: file.path, xy: file.xy, type: "file", children: [], fileCount: 1 });
    }
    return nodes;
  }

  return toNodes(root, "");
}

function flattenTree(nodes: TreeNode[], depth: number, collapsed: Set<string>): FlatTreeItem[] {
  const result: FlatTreeItem[] = [];
  for (const node of nodes) {
    const isColl = node.type === "dir" && collapsed.has(node.fullPath);
    result.push({ type: node.type, name: node.name, fullPath: node.fullPath, filePath: node.filePath, xy: node.xy, depth, fileCount: node.fileCount, isCollapsed: isColl });
    if (node.type === "dir" && !isColl) {
      for (const item of flattenTree(node.children, depth + 1, collapsed)) result.push(item);
    }
  }
  return result;
}

function isStaged(xy: string): boolean {
  if (!xy || xy === "??") return false;
  return ["M", "A", "D", "R", "C", "T"].includes(xy[0]);
}

function isUnstaged(xy: string): boolean {
  if (!xy) return false;
  if (xy === "??") return true;
  const x = xy[0], y = xy.length > 1 ? xy[1] : ".";
  if (x === "U" || y === "U") return true;
  if (x === "A" && y === "A") return true;
  if (x === "D" && y === "D") return true;
  return y !== "." && y !== "?";
}

export default function GitView(props: GitViewProps) {
  // — Repo management —
  const [allRepos, setAllRepos] = createSignal<Record<string, GitRepo[]>>({});
  const [repos, setRepos] = createSignal<GitRepo[]>([]);
  const [activeRepo, setActiveRepo] = createSignal<GitRepo | null>(null);
  const [showAddForm, setShowAddForm] = createSignal(false);
  const [newPath, setNewPath] = createSignal("");
  const [newName, setNewName] = createSignal("");
  const [addingRepo, setAddingRepo] = createSignal(false);
  const [scanning, setScanning] = createSignal(false);

  // — Tab routing —
  const [activeTab, setActiveTab] = createSignal<"status" | "log" | "branches" | "deploy">("status");

  // — Status tab —
  const [branchName, setBranchName] = createSignal("");
  const [upstream, setUpstream] = createSignal("");
  const [ahead, setAhead] = createSignal(0);
  const [behind, setBehind] = createSignal(0);
  const [changedFiles, setChangedFiles] = createSignal<FileStatus[]>([]);
  const [statusLoading, setStatusLoading] = createSignal(false);

  // — Log tab —
  const [commits, setCommits] = createSignal<CommitInfo[]>([]);
  const [logLoading, setLogLoading] = createSignal(false);

  // — Branches tab —
  const [branches, setBranches] = createSignal<BranchInfo[]>([]);
  const [branchesLoading, setBranchesLoading] = createSignal(false);

  // — Deploy tab —
  const [deployType, setDeployType] = createSignal<"service" | "container" | "command">("service");
  const [deployTarget, setDeployTarget] = createSignal("");
  const [deployConfigDirty, setDeployConfigDirty] = createSignal(false);

  // — Streaming console —
  const [consoleOutput, setConsoleOutput] = createSignal("");
  const [isStreaming, setIsStreaming] = createSignal(false);
  const [streamLabel, setStreamLabel] = createSignal("");
  let currentStreamId = "";
  let unlistenStream: (() => void) | undefined;
  let consoleRef: HTMLDivElement | undefined;

  // — Tree view state —
  const [collapsedDirs, setCollapsedDirs] = createSignal<Set<string>>(new Set());
  const [stagedCollapsed, setStagedCollapsed] = createSignal(false);
  const [changesCollapsed, setChangesCollapsed] = createSignal(false);
  const [incomingCollapsed, setIncomingCollapsed] = createSignal(false);

  const [incomingCommits, setIncomingCommits] = createSignal<CommitInfo[]>([]);
  const [incomingFiles, setIncomingFiles] = createSignal<FileStatus[]>([]);
  const [incomingLoading, setIncomingLoading] = createSignal(false);

  // Reset collapsed dirs whenever active repo changes
  createEffect(() => {
    activeRepo();
    setCollapsedDirs(new Set<string>());
  });

  const stagedFiles = createMemo(() => changedFiles().filter(f => isStaged(f.xy)));
  const unstagedFiles = createMemo(() => changedFiles().filter(f => isUnstaged(f.xy)));
  const flatStaged = createMemo(() => flattenTree(buildFileTree(stagedFiles()), 0, collapsedDirs()));
  const flatUnstaged = createMemo(() => flattenTree(buildFileTree(unstagedFiles()), 0, collapsedDirs()));
  const flatIncoming = createMemo(() => flattenTree(buildFileTree(incomingFiles()), 0, collapsedDirs()));

  const toggleDir = (path: string) => {
    setCollapsedDirs(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  };

  // Returns the "effective" xy for a file within a section (staged or unstaged)
  const getEffectiveCode = (xy: string, ctx: "staged" | "unstaged"): string => {
    if (!xy || xy === "??") return xy || "??";
    const x = xy[0], y = xy.length > 1 ? xy[1] : ".";
    if (ctx === "staged") return `${x}.`;
    if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) return "UU";
    return `.${y}`;
  };

  // Single VS Code-style letter indicator (M / A / D / R / U / !)
  const getStatusLetter = (xy: string): string => {
    const code = xy.trim().toUpperCase();
    if (code === "??" || code === ".?") return "U";
    if (code.includes("U") || code === "AA" || code === "DD") return "!";
    const x = code[0], y = code.length > 1 ? code[1] : ".";
    if (x !== "." && x !== "?") return x;
    if (y !== "." && y !== "?") return y;
    return "?";
  };

  // Escape single quotes in shell parameters
  const escapeShellArg = (val: string) => {
    return "'" + val.replace(/'/g, "'\\''") + "'";
  };

  // Load configured repositories
  const loadRepositories = async () => {
    try {
      const data: string = await invoke("load_git_repos");
      const parsed = JSON.parse(data) || {};
      setAllRepos(parsed);
      const serverRepos = (parsed[props.serverId] || []) as GitRepo[];
      setRepos(serverRepos);
      
      // Auto-select first repo if none selected, or restore active repo
      const currentActive = activeRepo();
      if (currentActive) {
        const found = serverRepos.find((r: GitRepo) => r.id === currentActive.id);
        if (found) {
          setActiveRepo(found);
        } else {
          setActiveRepo(serverRepos[0] || null);
        }
      } else {
        setActiveRepo(serverRepos[0] || null);
      }
    } catch (e: any) {
      console.error("Failed to load git repositories:", e);
      props.showToast("Failed to load Git repository list", "error");
    }
  };

  // Save repositories list to backend config file
  const saveRepositories = async (updatedRepos: GitRepo[]) => {
    try {
      const currentAll = allRepos();
      const updatedAll = {
        ...currentAll,
        [props.serverId]: updatedRepos
      };
      setAllRepos(updatedAll);
      setRepos(updatedRepos);
      await invoke("save_git_repos", { jsonData: JSON.stringify(updatedAll) });
    } catch (e: any) {
      console.error("Failed to save git repositories:", e);
      props.showToast("Failed to save Git repository list", "error");
    }
  };

  // Watch for serverId changes to reload lists (also runs on mount)
  createEffect(() => {
    if (props.serverId) {
      setActiveRepo(null);
      loadRepositories();
    }
  });

  // Watch activeRepo and activeTab changes to load proper data
  createEffect(() => {
    const repo = activeRepo();
    const tab = activeTab();
    if (repo) {
      if (tab === "status") {
        fetchStatus();
      } else if (tab === "log") {
        fetchLog();
      } else if (tab === "branches") {
        fetchBranches();
      } else if (tab === "deploy") {
        setDeployType(repo.deployAction?.type || "service");
        setDeployTarget(repo.deployAction?.target || "");
        setDeployConfigDirty(false);
      }
    } else {
      setBranchName("");
      setUpstream("");
      setAhead(0);
      setBehind(0);
      setChangedFiles([]);
      setCommits([]);
      setBranches([]);
      setDeployTarget("");
      setDeployConfigDirty(false);
    }
  });

  onCleanup(() => {
    if (unlistenStream) {
      unlistenStream();
      unlistenStream = undefined;
    }
    if (isStreaming() && currentStreamId) {
      invoke("stop_container_logs_stream", { streamId: currentStreamId }).catch(console.warn);
    }
  });

  // Auto-scan server for git repositories
  const handleAutoScan = async () => {
    if (scanning()) return;
    setScanning(true);
    props.showToast("Scanning VPS for Git repositories... This might take a few seconds.", "info");

    try {
      // Find command to locate .git dirs while pruning node_modules, virtual environments and cargo cache for speed
      const cmd = "find ~ /var/www -maxdepth 4 -name node_modules -prune -o -name .venv -prune -o -name venv -prune -o -name .git -type d -print 2>/dev/null";
      const res: any = await invoke("execute_command", {
        serverId: props.serverId,
        command: cmd
      });

      if (res.exit_code !== 0) {
        props.showToast(`Scan failed: ${res.stderr}`, "error");
        return;
      }

      const paths = res.stdout
        .split("\n")
        .map((line: string) => line.trim())
        .filter((line: string) => line.length > 0 && line.endsWith("/.git"));

      const cleanPath = (p: string) => p.endsWith("/") ? p.slice(0, -1) : p;

      let discoveredCount = 0;
      const currentRepos = [...repos()];
      const updatedRepos = [...currentRepos];

      for (const rawPath of paths) {
        // Strip the trailing "/.git" to get the repo root path
        const repoPath = rawPath.substring(0, rawPath.length - 5);
        
        // Skip if this path is already added
        const exists = currentRepos.some(r => cleanPath(r.path) === cleanPath(repoPath));
        if (!exists) {
          // Extract the folder name to use as a display name
          const pathParts = repoPath.split("/");
          const folderName = pathParts[pathParts.length - 1] || "Unnamed Repo";
          
          updatedRepos.push({
            id: `repo-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
            name: folderName,
            path: repoPath
          });
          discoveredCount++;
        }
      }

      if (discoveredCount > 0) {
        await saveRepositories(updatedRepos);
        // Select the first newly added repo if none was active
        if (!activeRepo() && updatedRepos.length > 0) {
          setActiveRepo(updatedRepos[0]);
        }
        props.showToast(`Auto-scan complete. Discovered and added ${discoveredCount} repository/repositories.`, "success");
      } else {
        props.showToast("Auto-scan complete. No new repositories discovered.", "info");
      }
    } catch (err: any) {
      props.showToast(`Error scanning repositories: ${err.toString()}`, "error");
    } finally {
      setScanning(false);
    }
  };

  // Add repository with remote verification
  const handleAddRepo = async (e: Event) => {
    e.preventDefault();
    const path = newPath().trim();
    const name = newName().trim();
    if (!path || !name) {
      props.showToast("Please enter path and display name.", "error");
      return;
    }

    setAddingRepo(true);
    try {
      const res: any = await invoke("execute_command", {
        serverId: props.serverId,
        command: `git -C ${escapeShellArg(path)} rev-parse --is-inside-work-tree`
      });

      if (res.exit_code === 0 && res.stdout.trim() === "true") {
        const newRepo: GitRepo = {
          id: `repo-${Date.now()}`,
          name,
          path
        };
        const updated = [...repos(), newRepo];
        await saveRepositories(updated);
        setActiveRepo(newRepo);
        setShowAddForm(false);
        setNewPath("");
        setNewName("");
        props.showToast(`Repository "${name}" added.`, "success");
      } else {
        const stderrMsg = res.stderr ? `: ${res.stderr.trim()}` : "";
        props.showToast(`Path is not a valid Git repository${stderrMsg}`, "error");
      }
    } catch (err: any) {
      props.showToast(`Failed to validate path: ${err.toString()}`, "error");
    } finally {
      setAddingRepo(false);
    }
  };

  // Delete repository from catalog
  const handleDeleteRepo = async (id: string, name: string, e: Event) => {
    e.stopPropagation();
    if (!confirm(`Are you sure you want to remove repository "${name}"?`)) return;

    const updated = repos().filter(r => r.id !== id);
    await saveRepositories(updated);
    if (activeRepo()?.id === id) {
      setActiveRepo(updated[0] || null);
    }
    props.showToast(`Repository "${name}" removed.`, "success");
  };

  // Fetch status info
  const fetchStatus = async () => {
    const repo = activeRepo();
    if (!repo) return;
    setStatusLoading(true);

    // Background fetch remote tracking state
    try {
      await invoke("execute_command", {
        serverId: props.serverId,
        command: `git -C ${escapeShellArg(repo.path)} fetch 2>/dev/null`
      });
    } catch (e) {
      console.warn("Auto fetch failed:", e);
    }

    try {
      const res: any = await invoke("execute_command", {
        serverId: props.serverId,
        command: `git -C ${escapeShellArg(repo.path)} status --porcelain=v2 --branch`
      });

      if (res.exit_code !== 0) {
        props.showToast(`Failed to get git status: ${res.stderr}`, "error");
        return;
      }

      const lines = res.stdout.split("\n");
      let currentBranch = "";
      let trackingBranch = "";
      let aheadCount = 0;
      let behindCount = 0;
      const files: FileStatus[] = [];

      // Helper: find the start of field N (0-based) in a space-separated string
      const fieldOffset = (s: string, n: number) => {
        let count = 0;
        for (let i = 0; i < s.length; i++) {
          if (s[i] === " ") {
            count++;
            if (count === n) return i + 1;
          }
        }
        return s.length;
      };

      for (const line of lines) {
        if (line.startsWith("# branch.head ")) {
          currentBranch = line.substring(14).trim();
        } else if (line.startsWith("# branch.upstream ")) {
          trackingBranch = line.substring(18).trim();
        } else if (line.startsWith("# branch.ab ")) {
          const parts = line.substring(12).trim().split(" ");
          if (parts.length >= 2) {
            aheadCount = parseInt(parts[0].replace("+", "")) || 0;
            behindCount = parseInt(parts[1].replace("-", "")) || 0;
          }
        } else if (line.startsWith("1 ")) {
          // format: 1 <xy> <sub> <mH> <mI> <mW> <hH> <hI> <path>  (7 spaces before path)
          const content = line.substring(2);
          const xy = content.split(" ")[0];
          const path = content.substring(fieldOffset(content, 7));
          files.push({ xy, path });
        } else if (line.startsWith("2 ")) {
          // format: 2 <xy> <sub> <mH> <mI> <mW> <hH> <hI> <score> <newPath>\t<origPath>  (8 spaces)
          const content = line.substring(2);
          const xy = content.split(" ")[0];
          const pathSection = content.substring(fieldOffset(content, 8));
          const tabIdx = pathSection.indexOf("\t");
          if (tabIdx !== -1) {
            const newPath = pathSection.substring(0, tabIdx);
            const oldPath = pathSection.substring(tabIdx + 1);
            files.push({ xy, path: `${oldPath} → ${newPath}` });
          } else {
            files.push({ xy, path: pathSection });
          }
        } else if (line.startsWith("? ")) {
          const path = line.substring(2).trim();
          files.push({ xy: "??", path });
        }
      }

      setBranchName(currentBranch);
      setUpstream(trackingBranch);
      setAhead(aheadCount);
      setBehind(behindCount);
      setChangedFiles(files);

      // Retrieve incoming changes if repository is behind upstream tracking branch
      if (behindCount > 0 && trackingBranch) {
        setIncomingLoading(true);
        try {
          const commsRes: any = await invoke("execute_command", {
            serverId: props.serverId,
            command: `git -C ${escapeShellArg(repo.path)} log HEAD..${escapeShellArg(trackingBranch)} --format="%H%x1F%an%x1F%s%x1F%ar%x1F%ad" --date=short`
          });
          if (commsRes.exit_code === 0) {
            const commsLines = commsRes.stdout.split("\n");
            const commsList: CommitInfo[] = [];
            for (const line of commsLines) {
              const trimmed = line.trim();
              if (!trimmed) continue;
              const parts = trimmed.split("\x1f");
              if (parts.length >= 5) {
                commsList.push({
                  hash: parts[0],
                  author: parts[1],
                  message: parts[2],
                  relativeDate: parts[3],
                  date: parts[4],
                  graphChars: "",
                  isGraphOnly: false
                });
              }
            }
            setIncomingCommits(commsList);
          }

          const filesRes: any = await invoke("execute_command", {
            serverId: props.serverId,
            command: `git -C ${escapeShellArg(repo.path)} diff --name-status HEAD..${escapeShellArg(trackingBranch)}`
          });
          if (filesRes.exit_code === 0) {
            const filesLines = filesRes.stdout.split("\n");
            const filesList: FileStatus[] = [];
            for (const line of filesLines) {
              const trimmed = line.trim();
              if (!trimmed) continue;
              const parts = trimmed.split(/\s+/);
              if (parts.length >= 2) {
                filesList.push({
                  xy: parts[0] + ".",
                  path: parts.slice(1).join(" ")
                });
              }
            }
            setIncomingFiles(filesList);
          }
        } catch (err) {
          console.warn("Failed to fetch incoming changes:", err);
        } finally {
          setIncomingLoading(false);
        }
      } else {
        setIncomingCommits([]);
        setIncomingFiles([]);
      }
    } catch (err: any) {
      props.showToast(`Error fetching status: ${err.toString()}`, "error");
    } finally {
      setStatusLoading(false);
    }
  };

  // Fetch commits log
  const fetchLog = async () => {
    const repo = activeRepo();
    if (!repo) return;
    setLogLoading(true);
    try {
      const res: any = await invoke("execute_command", {
        serverId: props.serverId,
        command: `git -C ${escapeShellArg(repo.path)} log --graph --all --format="%H%x1F%an%x1F%s%x1F%ar%x1F%ad" --date=short -30`
      });

      if (res.exit_code !== 0) {
        props.showToast(`Failed to get commit log: ${res.stderr}`, "error");
        return;
      }

      const lines = res.stdout.split("\n");
      const list: CommitInfo[] = [];
      for (const line of lines) {
        if (!line.trim()) continue;
        const parts = line.split("\x1f");
        if (parts.length >= 5) {
          const firstPart = parts[0];
          const match = firstPart.match(/([0-9a-fA-F]{40})$/);
          let hash = "";
          let graphChars = firstPart;
          if (match) {
            hash = match[1];
            graphChars = firstPart.substring(0, firstPart.length - 40);
          }
          list.push({
            hash: hash,
            author: parts[1],
            message: parts[2],
            relativeDate: parts[3],
            date: parts[4],
            graphChars: graphChars,
            isGraphOnly: false
          });
        } else {
          list.push({
            hash: "",
            author: "",
            message: "",
            relativeDate: "",
            date: "",
            graphChars: line,
            isGraphOnly: true
          });
        }
      }
      setCommits(list);
    } catch (err: any) {
      props.showToast(`Error fetching log: ${err.toString()}`, "error");
    } finally {
      setLogLoading(false);
    }
  };

  // Fetch branches
  const fetchBranches = async () => {
    const repo = activeRepo();
    if (!repo) return;
    setBranchesLoading(true);
    try {
      const res: any = await invoke("execute_command", {
        serverId: props.serverId,
        command: `git -C ${escapeShellArg(repo.path)} branch -a --format="%(refname:short)|%(HEAD)|%(upstream:short)"`
      });

      if (res.exit_code !== 0) {
        props.showToast(`Failed to get branches: ${res.stderr}`, "error");
        return;
      }

      const lines = res.stdout.split("\n");
      const list: BranchInfo[] = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const parts = trimmed.split("|");
        if (parts.length >= 2) {
          list.push({
            name: parts[0],
            isCurrent: parts[1] === "*",
            upstream: parts[2] || ""
          });
        }
      }
      setBranches(list);
    } catch (err: any) {
      props.showToast(`Error fetching branches: ${err.toString()}`, "error");
    } finally {
      setBranchesLoading(false);
    }
  };

  // Run command as stream and direct output to console panel
  const runStreamedCommand = async (label: string, cmd: string, onComplete?: (success: boolean) => void) => {
    if (isStreaming()) {
      props.showToast("Another streamed Git command is currently running.", "info");
      return;
    }

    if (unlistenStream) {
      unlistenStream();
      unlistenStream = undefined;
    }

    setIsStreaming(true);
    setStreamLabel(label);
    setConsoleOutput(`$ ${cmd}\n`);

    const streamId = `git-stream-${props.serverId}-${Math.floor(Math.random() * 100000)}`;
    currentStreamId = streamId;

    try {
      unlistenStream = await listen<string>(`command-stream:${streamId}`, (event) => {
        setConsoleOutput((prev) => prev + event.payload);

        // Auto scroll console logs
        if (consoleRef) {
          consoleRef.scrollTop = consoleRef.scrollHeight;
        }

        if (event.payload.includes("[Exit Code:")) {
          const success = event.payload.includes("[Exit Code: 0]");
          setIsStreaming(false);
          if (unlistenStream) {
            unlistenStream();
            unlistenStream = undefined;
          }
          if (onComplete) {
            onComplete(success);
          }
        }
      });

      await invoke("start_command_stream", {
        serverId: props.serverId,
        streamId: streamId,
        command: cmd
      });

    } catch (err: any) {
      setIsStreaming(false);
      setConsoleOutput((prev) => prev + `\nExecution Error: ${err.toString()}\n`);
      props.showToast(`Failed to start stream: ${err.toString()}`, "error");
      if (unlistenStream) {
        unlistenStream();
        unlistenStream = undefined;
      }
    }
  };

  const handleFetch = () => {
    const repo = activeRepo();
    if (!repo) return;
    runStreamedCommand("FETCH", `git -C ${escapeShellArg(repo.path)} fetch --all --prune 2>&1`, (success) => {
      if (success) {
        props.showToast("Fetch completed.", "success");
        fetchStatus();
      } else {
        props.showToast("Fetch failed.", "error");
      }
    });
  };

  const handlePull = () => {
    const repo = activeRepo();
    if (!repo) return;
    runStreamedCommand("PULL", `git -C ${escapeShellArg(repo.path)} pull 2>&1`, (success) => {
      if (success) {
        props.showToast("Pull completed.", "success");
        fetchStatus();
      } else {
        props.showToast("Pull failed.", "error");
      }
    });
  };

  const handleStash = async () => {
    const repo = activeRepo();
    if (!repo) return;
    try {
      const res: any = await invoke("execute_command", {
        serverId: props.serverId,
        command: `git -C ${escapeShellArg(repo.path)} stash`
      });
      const combined = `${res.stdout} ${res.stderr}`;
      if (combined.includes("No local changes to save")) {
        props.showToast("Working tree is already clean — nothing to stash.", "info");
        return;
      }
      if (res.exit_code === 0) {
        props.showToast("Changes stashed.", "success");
        fetchStatus();
      } else {
        props.showToast(`Stash failed: ${res.stderr || res.stdout}`, "error");
      }
    } catch (err: any) {
      props.showToast(`Error: ${err.toString()}`, "error");
    }
  };

  const handlePopStash = async () => {
    const repo = activeRepo();
    if (!repo) return;
    try {
      const res: any = await invoke("execute_command", {
        serverId: props.serverId,
        command: `git -C ${escapeShellArg(repo.path)} stash pop`
      });
      const combined = `${res.stdout} ${res.stderr}`;
      if (combined.toLowerCase().includes("no stash entries")) {
        props.showToast("No stash entries to pop.", "info");
        return;
      }
      if (res.exit_code === 0) {
        props.showToast("Stash popped successfully.", "success");
        fetchStatus();
      } else {
        props.showToast(`Pop stash failed: ${res.stderr || res.stdout}`, "error");
      }
    } catch (err: any) {
      props.showToast(`Error: ${err.toString()}`, "error");
    }
  };

  const handleCheckout = async (branch: string) => {
    const repo = activeRepo();
    if (!repo) return;

    let checkoutTarget = branch;
    if (branch.startsWith("remotes/")) {
      const cleanBranch = branch.substring(8); // remove "remotes/"
      if (cleanBranch.startsWith("origin/")) {
        checkoutTarget = cleanBranch.substring(7); // remove "origin/" to checkout local branch matching remote
      } else {
        checkoutTarget = cleanBranch;
      }
    }

    try {
      const res: any = await invoke("execute_command", {
        serverId: props.serverId,
        command: `git -C ${escapeShellArg(repo.path)} checkout ${escapeShellArg(checkoutTarget)}`
      });

      if (res.exit_code === 0) {
        props.showToast(`Checked out branch: ${checkoutTarget}`, "success");
        setActiveTab("status");
        fetchStatus();
      } else {
        // Fallback checkout target (original)
        const fallbackRes: any = await invoke("execute_command", {
          serverId: props.serverId,
          command: `git -C ${escapeShellArg(repo.path)} checkout ${escapeShellArg(branch)}`
        });
        if (fallbackRes.exit_code === 0) {
          props.showToast(`Checked out branch: ${branch}`, "success");
          setActiveTab("status");
          fetchStatus();
        } else {
          props.showToast(`Checkout failed: ${fallbackRes.stderr || res.stderr}`, "error");
        }
      }
    } catch (err: any) {
      props.showToast(`Checkout Error: ${err.toString()}`, "error");
    }
  };

  // Deploy target configurator
  const getDeployActionCommand = () => {
    const target = deployTarget().trim();
    if (!target) return "";
    if (deployType() === "service") {
      return `sudo systemctl restart ${target}`;
    } else if (deployType() === "container") {
      return `sudo docker restart ${target}`;
    } else {
      return target;
    }
  };

  const getDeployFullCommand = () => {
    const repo = activeRepo();
    if (!repo) return "";
    const pullCmd = `git -C ${escapeShellArg(repo.path)} pull 2>&1`;
    const actionCmd = getDeployActionCommand();
    if (actionCmd) {
      return `${pullCmd} && echo "--- DEPLOY ---" && ${actionCmd} 2>&1`;
    }
    return pullCmd;
  };

  const handleSaveDeployConfig = async () => {
    const repo = activeRepo();
    if (!repo) return;

    const updatedRepo: GitRepo = {
      ...repo,
      deployAction: {
        type: deployType(),
        target: deployTarget().trim()
      }
    };

    const updated = repos().map(r => r.id === repo.id ? updatedRepo : r);
    await saveRepositories(updated);
    setActiveRepo(updatedRepo);
    setDeployConfigDirty(false);
    props.showToast("Deploy configuration saved.", "success");
  };

  const handleDeployNow = () => {
    const fullCmd = getDeployFullCommand();
    if (!fullCmd) return;
    runStreamedCommand("DEPLOY", fullCmd, (success) => {
      if (success) {
        props.showToast("Deployment finished successfully!", "success");
        fetchStatus();
      } else {
        props.showToast("Deployment failed. Check console outputs.", "error");
      }
    });
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    props.showToast("Copied to clipboard", "success");
  };

  const getStatusColorClass = (xy: string) => {
    const code = xy.trim().toUpperCase();
    if (code === "??") return "text-accent-cyan border-accent-cyan";
    if (code.includes("U")) return "text-accent-danger border-accent-danger";
    if (code.includes("A")) return "text-accent-success border-accent-success";
    if (code.includes("D")) return "text-accent-danger border-accent-danger";
    if (code.includes("R")) return "text-accent-indigo border-accent-indigo";
    if (code.includes("M")) return "text-accent-warning border-accent-warning";
    return "text-text-secondary";
  };

  const getStatusLabel = (xy: string) => {
    const code = xy.trim().toUpperCase();
    if (code === "??") return "Untracked";
    if (code.includes("U")) return "Conflict";
    if (code.includes("A")) return "Added";
    if (code.includes("D")) return "Deleted";
    if (code.includes("R")) return "Renamed";
    if (code.includes("C")) return "Copied";
    if (code.includes("M")) return xy === "MM" ? "Staged+Modified" : xy === "M." ? "Staged" : "Modified";
    return code;
  };

  const deployPreviewText = () => {
    const repo = activeRepo();
    const path = repo?.path || "/path/to/repo";
    const pull = `git -C '${path}' pull 2>&1`;
    const action = getDeployActionCommand();
    return action
      ? `${pull} &&\necho "--- DEPLOY ---" &&\n${action} 2>&1`
      : pull;
  };

  const handleRefresh = () => {
    const tab = activeTab();
    if (tab === "status") fetchStatus();
    else if (tab === "log") fetchLog();
    else if (tab === "branches") fetchBranches();
  };

  return (
    <div class="split-pane h-full flex-1">
      {/* Left panel — Repo selector */}
      <div style={{ flex: "0 0 260px" }} class="glass-panel p-3 flex flex-col min-w-0 h-full overflow-hidden">
        <div class="flex justify-between items-center mb-3 pb-1 border-b">
          <p class="text-[9px] uppercase font-bold text-text-muted tracking-wider font-mono">REPOSITORIES</p>
          <div class="flex gap-1 items-center">
            <button 
              class="btn-secondary px-1.5 py-0.5 text-[9px] font-mono flex items-center gap-1 hover:border-accent-cyan hover:text-accent-cyan"
              onClick={handleAutoScan}
              disabled={scanning()}
              title="Automatically discover Git repositories on VPS"
            >
              <Show when={scanning()} fallback={<RotateCw size={9} />}>
                <Loader size={9} class="animate-spin text-accent-cyan" />
              </Show>
              Auto Scan
            </button>
            <button 
              class="btn-secondary p-1 text-xs" 
              title="Add repository"
              onClick={() => setShowAddForm(!showAddForm())}
            >
              <Plus size={11} />
            </button>
          </div>
        </div>

        <div class="flex-1 overflow-y-auto space-y-1 mb-2 pr-1">
          <For each={repos()}>
            {(repo) => (
              <div 
                class={`profile-item group ${activeRepo()?.id === repo.id ? "active" : ""}`}
                onClick={() => {
                  setActiveRepo(repo);
                  setShowAddForm(false);
                }}
              >
                <div class="flex items-center gap-2 truncate">
                  <span class={`status-dot shrink-0 ${activeRepo()?.id === repo.id ? "active" : "inactive"}`} />
                  <div class="truncate text-left">
                    <p class="text-xs font-semibold text-text-primary truncate">{repo.name}</p>
                    <p class="text-[10px] text-text-muted font-mono truncate">{repo.path}</p>
                  </div>
                </div>
                
                <button 
                  class="btn-secondary p-1 opacity-0 group-hover:opacity-100 transition-opacity hover:border-accent-danger hover:text-accent-danger"
                  onClick={(e) => handleDeleteRepo(repo.id, repo.name, e)}
                  title="Remove repository"
                >
                  <Trash2 size={11} />
                </button>
              </div>
            )}
          </For>

          <Show when={repos().length === 0 && !showAddForm()}>
            <p class="text-xs text-text-muted font-mono py-4 text-center">No repositories added.</p>
          </Show>
        </div>

        {/* Add Repo Form */}
        <Show when={showAddForm()}>
          <div class="border-t pt-3 mt-auto space-y-3 p-2 rounded" style={{ "background-color": "var(--bg-secondary)" }}>
            <h4 class="text-[10px] font-bold text-text-primary uppercase tracking-wider font-mono">Add Repository</h4>
            <form onSubmit={handleAddRepo} class="space-y-2">
              <div class="flex flex-col gap-1">
                <label class="text-[9px] text-text-secondary uppercase font-semibold font-mono">Server Path</label>
                <input
                  type="text"
                  placeholder="/var/www/myapp"
                  value={newPath()}
                  onInput={(e) => setNewPath(e.currentTarget.value)}
                  class="w-full text-xs py-1"
                  required
                />
              </div>
              <div class="flex flex-col gap-1">
                <label class="text-[9px] text-text-secondary uppercase font-semibold font-mono">Display Name</label>
                <input
                  type="text"
                  placeholder="My App"
                  value={newName()}
                  onInput={(e) => setNewName(e.currentTarget.value)}
                  class="w-full text-xs py-1"
                  required
                />
              </div>
              <div class="flex gap-2 pt-1">
                <button type="submit" class="btn-primary py-1 text-xs flex-1" disabled={addingRepo()}>
                  <Show when={addingRepo()} fallback={<Check size={11} />}>
                    <Loader size={11} class="animate-spin" />
                  </Show>
                  Save
                </button>
                <button 
                  type="button" 
                  class="btn-secondary py-1 text-xs" 
                  onClick={() => {
                    setShowAddForm(false);
                    setNewPath("");
                    setNewName("");
                  }}
                >
                  <X size={11} />
                </button>
              </div>
            </form>
          </div>
        </Show>
      </div>

      {/* Right panel — Workspace */}
      <div class="split-pane-main min-h-0 flex-1 flex flex-col gap-4">
        <Show when={activeRepo()} fallback={
          <div class="glass-panel p-8 text-center flex-1 flex flex-col justify-center items-center gap-4">
            <GitBranch size={40} class="text-text-muted" />
            <div>
              <h3 class="text-sm font-bold uppercase tracking-wider font-mono text-text-primary mb-1">No Repository Selected</h3>
              <p class="text-xs text-text-secondary max-w-sm leading-relaxed">
                Add a repository path manually or let Vessel scan your VPS automatically.
              </p>
            </div>
            <div class="flex gap-2">
              <button
                class="btn-primary text-xs py-1.5 px-4 flex items-center gap-1.5"
                onClick={handleAutoScan}
                disabled={scanning()}
              >
                <Show when={scanning()} fallback={<RotateCw size={12} />}>
                  <Loader size={12} class="animate-spin" />
                </Show>
                Auto Scan VPS
              </button>
              <button
                class="btn-secondary text-xs py-1.5 px-4 flex items-center gap-1.5"
                onClick={() => setShowAddForm(true)}
              >
                <Plus size={12} /> Add Manually
              </button>
            </div>
          </div>
        }>
          {/* Header bar */}
          <div class="glass-panel p-3 flex justify-between items-center gap-4 flex-wrap">
            <div class="flex flex-col">
              <div class="flex items-center gap-2">
                <span class="text-xs uppercase font-mono font-bold text-accent-cyan">GIT //</span>
                <h2 class="text-sm font-bold text-text-primary font-mono">{activeRepo()?.name}</h2>
                <Show when={branchName()}>
                  <span class="border text-text-secondary text-[10px] font-mono px-1.5 py-0.5 rounded flex items-center gap-1" style={{ "background-color": "var(--bg-active)" }}>
                    <GitBranch size={10} /> {branchName()}
                  </span>
                </Show>
                <Show when={upstream()}>
                  <span class="text-[10px] text-text-muted font-mono">{upstream()}</span>
                </Show>
                <Show when={ahead() > 0 || behind() > 0}>
                  <span class="text-[9px] font-bold font-mono px-1.5 py-0.5 rounded border text-accent-indigo border-accent-indigo bg-accent-indigo\/5">
                    ↑{ahead()} ↓{behind()}
                  </span>
                </Show>
              </div>
              <p class="text-[10px] text-text-secondary font-mono mt-0.5">{activeRepo()?.path}</p>
            </div>
            
            <button class="btn-secondary text-xs py-1" onClick={handleRefresh} disabled={statusLoading() || logLoading() || branchesLoading()}>
              <RotateCw size={11} class={(statusLoading() || logLoading() || branchesLoading()) ? "animate-spin" : ""} /> Refresh
            </button>
          </div>

          {/* Tab bar */}
          <div class="tab-segment-container">
            <button 
              class={`tab-segment-button ${activeTab() === "status" ? "active" : ""}`}
              onClick={() => setActiveTab("status")}
            >
              Status
            </button>
            <button 
              class={`tab-segment-button ${activeTab() === "log" ? "active" : ""}`}
              onClick={() => setActiveTab("log")}
            >
              Log
            </button>
            <button 
              class={`tab-segment-button ${activeTab() === "branches" ? "active" : ""}`}
              onClick={() => setActiveTab("branches")}
            >
              Branches
            </button>
            <button 
              class={`tab-segment-button ${activeTab() === "deploy" ? "active" : ""}`}
              onClick={() => setActiveTab("deploy")}
            >
              Deploy
            </button>
          </div>

          {/* Workspace Tabs Body */}
          <div class="flex-1 min-h-0 overflow-y-auto">
            {/* Status tab — VS Code-style working tree */}
            <Show when={activeTab() === "status"}>
              <div class="glass-panel flex flex-col min-h-full">

                {/* Action bar */}
                <div class="flex items-center gap-1.5 px-3 py-2 border-b flex-wrap">
                  <span class="text-[9px] uppercase font-mono font-bold text-text-muted tracking-wider mr-auto">
                    {changedFiles().length} change{changedFiles().length !== 1 ? "s" : ""}
                  </span>
                  <button class="btn-primary text-[10px] py-0.5 px-2.5 flex items-center gap-1" onClick={handlePull} disabled={isStreaming()}>
                    <ArrowDown size={10} /> Pull
                  </button>
                  <button class="btn-secondary text-[10px] py-0.5 px-2.5" onClick={handleFetch} disabled={isStreaming()}>
                    Fetch
                  </button>
                  <button class="btn-secondary text-[10px] py-0.5 px-2" onClick={handleStash} disabled={isStreaming()} title="Stash current local changes">
                    Stash
                  </button>
                  <button class="btn-secondary text-[10px] py-0.5 px-2" onClick={handlePopStash} disabled={isStreaming()} title="Pop last stash entry">
                    Pop
                  </button>
                </div>

                {/* Tree body */}
                <div class="flex-1">

                  {/* Loading */}
                  <Show when={statusLoading()}>
                    <div class="py-8 text-center text-text-secondary text-xs">
                      <Loader class="animate-spin inline mr-1.5 text-accent-cyan" size={11} /> Loading...
                    </div>
                  </Show>

                  {/* Clean state */}
                  <Show when={!statusLoading() && changedFiles().length === 0}>
                    <div class="py-12 text-center text-text-muted font-mono uppercase font-bold tracking-wider text-[10px]">
                      Working directory clean
                    </div>
                  </Show>

                  {/* ── Incoming Changes (Not Pulled Yet) ───────────── */}
                  <Show when={!statusLoading() && incomingFiles().length > 0}>
                    {/* Section header */}
                    <div
                      class="flex items-center gap-1.5 px-2 py-1 cursor-pointer hover:bg-bg-hover select-none border-b"
                      onClick={() => setIncomingCollapsed(c => !c)}
                    >
                      <ChevronRight
                        size={10}
                        style={{ "flex-shrink": "0", "transition": "transform 0.15s", "transform": incomingCollapsed() ? "rotate(0deg)" : "rotate(90deg)" }}
                        class="text-accent-cyan"
                      />
                      <span class="text-[9px] uppercase font-bold font-mono text-accent-cyan tracking-wider flex items-center gap-1.5">
                        Incoming Changes (Will be pulled)
                        <Show when={incomingLoading()}>
                          <Loader size={9} class="animate-spin text-accent-cyan" />
                        </Show>
                      </span>
                      <span class="ml-auto text-[9px] font-mono text-accent-cyan">{incomingFiles().length}</span>
                    </div>

                    <Show when={!incomingCollapsed()}>
                      {/* Incoming commits summary */}
                      <Show when={incomingCommits().length > 0}>
                        <div class="mx-3 my-2 p-2 rounded bg-dark-panel border border-white/5 text-[10px] space-y-1 font-mono">
                          <p class="font-bold text-text-muted uppercase text-[9px] mb-1">Incoming Commits:</p>
                          <For each={incomingCommits()}>
                            {(c) => (
                              <div class="flex gap-2">
                                <span class="text-accent-cyan">{c.hash.substring(0, 7)}</span>
                                <span class="text-text-secondary truncate flex-1">{c.message}</span>
                                <span class="text-text-muted text-[9px]">{c.relativeDate}</span>
                              </div>
                            )}
                          </For>
                        </div>
                      </Show>
                      <For each={flatIncoming()}>
                        {(item) => item.type === "dir" ? (
                          <div
                            class="flex items-center gap-1 py-0.5 pr-3 cursor-pointer hover:bg-bg-hover select-none"
                            style={{ "padding-left": `${item.depth * 12 + 8}px` }}
                            onClick={() => toggleDir(item.fullPath)}
                          >
                            <ChevronRight
                              size={9}
                              style={{ "flex-shrink": "0", "transition": "transform 0.15s", "transform": item.isCollapsed ? "rotate(0deg)" : "rotate(90deg)" }}
                              class="text-text-muted"
                            />
                            <Folder size={12} class="text-accent-cyan" style={{ "flex-shrink": "0" }} />
                            <span class="text-text-secondary text-xs font-mono flex-1">{item.name}</span>
                            <span class="text-[9px] text-text-muted font-mono">{item.fileCount}</span>
                          </div>
                        ) : (
                          <div
                            class="flex items-center gap-2 py-0.5 pr-3 hover:bg-bg-hover group"
                            style={{ "padding-left": `${item.depth * 12 + 22}px` }}
                            title={item.filePath}
                          >
                            <span class="text-text-primary text-xs font-mono flex-1" style={{ "overflow": "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}>
                              {item.name}
                            </span>
                            <span
                              class={`text-[11px] font-bold font-mono ${getStatusColorClass(getEffectiveCode(item.xy!, "unstaged")).split(" ")[0]}`}
                              style={{ "flex-shrink": "0", "min-width": "10px", "text-align": "right" }}
                              title={getStatusLabel(getEffectiveCode(item.xy!, "unstaged"))}
                            >
                              {getStatusLetter(getEffectiveCode(item.xy!, "unstaged"))}
                            </span>
                          </div>
                        )}
                      </For>
                    </Show>
                  </Show>

                  {/* ── Staged Changes ────────────────────────────── */}
                  <Show when={!statusLoading() && stagedFiles().length > 0}>
                    {/* Section header */}
                    <div
                      class="flex items-center gap-1.5 px-2 py-1 cursor-pointer hover:bg-bg-hover select-none border-b"
                      onClick={() => setStagedCollapsed(c => !c)}
                    >
                      <ChevronRight
                        size={10}
                        style={{ "flex-shrink": "0", "transition": "transform 0.15s", "transform": stagedCollapsed() ? "rotate(0deg)" : "rotate(90deg)" }}
                        class="text-text-muted"
                      />
                      <span class="text-[9px] uppercase font-bold font-mono text-text-muted tracking-wider">Staged Changes</span>
                      <span class="ml-auto text-[9px] font-mono text-text-muted">{stagedFiles().length}</span>
                    </div>

                    <Show when={!stagedCollapsed()}>
                      <For each={flatStaged()}>
                        {(item) => item.type === "dir" ? (
                          /* Directory row */
                          <div
                            class="flex items-center gap-1 py-0.5 pr-3 cursor-pointer hover:bg-bg-hover select-none"
                            style={{ "padding-left": `${item.depth * 12 + 8}px` }}
                            onClick={() => toggleDir(item.fullPath)}
                          >
                            <ChevronRight
                              size={9}
                              style={{ "flex-shrink": "0", "transition": "transform 0.15s", "transform": item.isCollapsed ? "rotate(0deg)" : "rotate(90deg)" }}
                              class="text-text-muted"
                            />
                            <Folder size={12} class="text-accent-cyan" style={{ "flex-shrink": "0" }} />
                            <span class="text-text-secondary text-xs font-mono flex-1">{item.name}</span>
                            <span class="text-[9px] text-text-muted font-mono">{item.fileCount}</span>
                          </div>
                        ) : (
                          /* File row */
                          <div
                            class="flex items-center gap-2 py-0.5 pr-3 hover:bg-bg-hover group"
                            style={{ "padding-left": `${item.depth * 12 + 22}px` }}
                            title={item.filePath}
                          >
                            <span class="text-text-primary text-xs font-mono flex-1" style={{ "overflow": "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}>
                              {item.name}
                            </span>
                            <Show when={item.filePath?.includes(" → ")}>
                              <span class="text-text-muted text-[10px] font-mono opacity-0 group-hover:opacity-100 transition-opacity" style={{ "flex-shrink": "0" }}>
                                ← {item.filePath!.split(" → ")[0].split("/").pop()}
                              </span>
                            </Show>
                            <span
                              class={`text-[11px] font-bold font-mono ${getStatusColorClass(getEffectiveCode(item.xy!, "staged")).split(" ")[0]}`}
                              style={{ "flex-shrink": "0", "min-width": "10px", "text-align": "right" }}
                              title={getStatusLabel(getEffectiveCode(item.xy!, "staged"))}
                            >
                              {getStatusLetter(getEffectiveCode(item.xy!, "staged"))}
                            </span>
                          </div>
                        )}
                      </For>
                    </Show>
                  </Show>

                  {/* ── Changes (unstaged + untracked) ───────────── */}
                  <Show when={!statusLoading() && unstagedFiles().length > 0}>
                    {/* Section header */}
                    <div
                      class="flex items-center gap-1.5 px-2 py-1 cursor-pointer hover:bg-bg-hover select-none border-b"
                      onClick={() => setChangesCollapsed(c => !c)}
                    >
                      <ChevronRight
                        size={10}
                        style={{ "flex-shrink": "0", "transition": "transform 0.15s", "transform": changesCollapsed() ? "rotate(0deg)" : "rotate(90deg)" }}
                        class="text-text-muted"
                      />
                      <span class="text-[9px] uppercase font-bold font-mono text-text-muted tracking-wider">Changes</span>
                      <span class="ml-auto text-[9px] font-mono text-text-muted">{unstagedFiles().length}</span>
                    </div>

                    <Show when={!changesCollapsed()}>
                      <For each={flatUnstaged()}>
                        {(item) => item.type === "dir" ? (
                          <div
                            class="flex items-center gap-1 py-0.5 pr-3 cursor-pointer hover:bg-bg-hover select-none"
                            style={{ "padding-left": `${item.depth * 12 + 8}px` }}
                            onClick={() => toggleDir(item.fullPath)}
                          >
                            <ChevronRight
                              size={9}
                              style={{ "flex-shrink": "0", "transition": "transform 0.15s", "transform": item.isCollapsed ? "rotate(0deg)" : "rotate(90deg)" }}
                              class="text-text-muted"
                            />
                            <Folder size={12} class="text-accent-cyan" style={{ "flex-shrink": "0" }} />
                            <span class="text-text-secondary text-xs font-mono flex-1">{item.name}</span>
                            <span class="text-[9px] text-text-muted font-mono">{item.fileCount}</span>
                          </div>
                        ) : (
                          <div
                            class="flex items-center gap-2 py-0.5 pr-3 hover:bg-bg-hover group"
                            style={{ "padding-left": `${item.depth * 12 + 22}px` }}
                            title={item.filePath}
                          >
                            <span class="text-text-primary text-xs font-mono flex-1" style={{ "overflow": "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}>
                              {item.name}
                            </span>
                            <span
                              class={`text-[11px] font-bold font-mono ${getStatusColorClass(getEffectiveCode(item.xy!, "unstaged")).split(" ")[0]}`}
                              style={{ "flex-shrink": "0", "min-width": "10px", "text-align": "right" }}
                              title={getStatusLabel(getEffectiveCode(item.xy!, "unstaged"))}
                            >
                              {getStatusLetter(getEffectiveCode(item.xy!, "unstaged"))}
                            </span>
                          </div>
                        )}
                      </For>
                    </Show>
                  </Show>

                </div>
              </div>
            </Show>

            {/* Log tab */}
            <Show when={activeTab() === "log"}>
              <div class="glass-panel p-4 flex flex-col gap-4 min-h-full">
                <div class="border-b pb-2">
                  <span class="text-xs uppercase font-mono font-bold text-text-primary">Commit Log</span>
                  <span class="text-[10px] text-text-secondary font-mono ml-2">showing last 30 commits</span>
                </div>

                <div class="flex-1 overflow-x-auto min-h-0">
                  <Show when={logLoading()}>
                    <div class="py-8 text-center text-text-secondary">
                      <Loader class="animate-spin inline mr-1.5 text-accent-cyan" size={12} /> Loading commits...
                    </div>
                  </Show>

                  <Show when={!logLoading() && commits().length === 0}>
                    <div class="py-12 text-center text-text-muted font-mono uppercase font-bold tracking-wider text-[10px]">
                      No Commits Found
                    </div>
                  </Show>

                  <Show when={!logLoading() && commits().length > 0}>
                    <table class="dense-table">
                      <thead>
                        <tr>
                          <th class="text-left w-24">Graph</th>
                          <th class="text-left w-20">Hash</th>
                          <th class="text-left w-32">Author</th>
                          <th class="text-left">Message</th>
                          <th class="text-left w-28">Date</th>
                        </tr>
                      </thead>
                      <tbody>
                        <For each={commits()}>
                          {(commit) => (
                            <Show when={commit.isGraphOnly} fallback={
                              <tr 
                                class="cursor-pointer"
                                title="Click to copy commit hash"
                                onClick={() => copyToClipboard(commit.hash)}
                              >
                                <td class="font-mono text-accent-indigo whitespace-pre select-none text-[10px]" style={{ "line-height": "1.2" }}>
                                  {commit.graphChars}
                                </td>
                                <td class="text-accent-cyan hover:underline font-mono">
                                  {commit.hash.substring(0, 7)}
                                </td>
                                <td class="text-text-secondary truncate max-w-[120px] font-sans">
                                  {commit.author}
                                </td>
                                <td class="text-text-primary font-semibold truncate max-w-md font-sans">
                                  {commit.message}
                                </td>
                                <td class="text-text-muted text-[10px] whitespace-nowrap" title={commit.date}>
                                  {commit.relativeDate}
                                </td>
                              </tr>
                            }>
                              <tr>
                                <td colspan="5" class="font-mono text-accent-indigo whitespace-pre select-none text-[10px] py-0.5 border-none" style={{ "line-height": "1.2" }}>
                                  {commit.graphChars}
                                </td>
                              </tr>
                            </Show>
                          )}
                        </For>
                      </tbody>
                    </table>
                  </Show>
                </div>
              </div>
            </Show>

            {/* Branches tab */}
            <Show when={activeTab() === "branches"}>
              <div class="glass-panel p-4 flex flex-col gap-6 min-h-full">
                <Show when={branchesLoading()}>
                  <div class="py-8 text-center text-text-secondary">
                    <Loader class="animate-spin inline mr-1.5 text-accent-cyan" size={12} /> Loading branches...
                  </div>
                </Show>

                <Show when={!branchesLoading()}>
                  {/* Local Branches */}
                  <div class="flex flex-col gap-2">
                    <div class="border-b pb-1.5">
                      <span class="text-xs uppercase font-mono font-bold text-text-primary">Local Branches</span>
                    </div>

                    <table class="dense-table">
                      <thead>
                        <tr>
                          <th class="text-left">Branch Name</th>
                          <th class="text-left w-48">Tracking Remote</th>
                          <th class="text-right w-24">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        <For each={branches().filter(b => !b.name.startsWith("remotes/"))}>
                          {(branch) => (
                            <tr class={branch.isCurrent ? "active font-bold" : ""}>
                              <td>
                                <span class="flex items-center gap-2">
                                  <Show when={branch.isCurrent} fallback={<span class="w-3" />}>
                                    <span class="status-dot active inline-block" />
                                  </Show>
                                  <span class={branch.isCurrent ? "text-accent-cyan font-mono font-semibold" : "text-text-primary font-mono"}>
                                    {branch.name}
                                  </span>
                                </span>
                              </td>
                              <td class="text-text-muted font-mono text-[10px]">
                                {branch.upstream}
                              </td>
                              <td class="text-right">
                                <Show when={!branch.isCurrent}>
                                  <button 
                                    class="btn-secondary text-[10px] py-0.5 px-2 hover:border-accent-cyan hover:text-accent-cyan" 
                                    onClick={() => handleCheckout(branch.name)}
                                  >
                                    Checkout
                                  </button>
                                </Show>
                              </td>
                            </tr>
                          )}
                        </For>
                      </tbody>
                    </table>
                  </div>

                  {/* Remote Branches */}
                  <div class="flex flex-col gap-2 mt-4">
                    <div class="border-b pb-1.5">
                      <span class="text-xs uppercase font-mono font-bold text-text-primary">Remote Branches</span>
                    </div>

                    <table class="dense-table">
                      <thead>
                        <tr>
                          <th class="text-left">Remote Branch Name</th>
                          <th class="text-right w-24">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        <For each={branches().filter(b => b.name.startsWith("remotes/"))}>
                          {(branch) => (
                            <tr>
                              <td class="text-text-secondary font-mono">
                                {branch.name}
                              </td>
                              <td class="text-right">
                                <button 
                                  class="btn-secondary text-[10px] py-0.5 px-2 hover:border-accent-cyan hover:text-accent-cyan" 
                                  onClick={() => handleCheckout(branch.name)}
                                >
                                  Checkout
                                </button>
                              </td>
                            </tr>
                          )}
                        </For>
                      </tbody>
                    </table>
                  </div>
                </Show>
              </div>
            </Show>

            {/* Deploy tab */}
            <Show when={activeTab() === "deploy"}>
              <div class="glass-panel p-4 flex flex-col gap-6 min-h-full">
                <div>
                  <h3 class="text-xs uppercase font-mono font-bold text-text-primary mb-1">DEPLOY PIPELINE CONFIGURATOR</h3>
                  <p class="text-[11px] text-text-secondary leading-normal font-sans">
                    Define a post-pull operation (e.g. restart service/container or custom build execution). 
                    Vessel will automatically run this command block after a successful git pull.
                  </p>
                </div>

                <div class="p-4 border rounded space-y-4" style={{ "background-color": "var(--bg-secondary)" }}>
                  <div class="flex flex-col gap-2">
                    <label class="text-[10px] text-text-secondary uppercase font-semibold font-mono">Post-Pull Action Type</label>
                    <div class="grid grid-cols-3 gap-2">
                      <div 
                        class={`border rounded p-2.5 flex flex-col gap-1 cursor-pointer transition-all ${deployType() === "service" ? "border-accent-cyan bg-accent-cyan/5" : "border-white/5 hover:border-white/10"}`}
                        onClick={() => { setDeployType("service"); setDeployConfigDirty(true); }}
                      >
                        <span class="text-xs font-semibold text-text-primary font-sans">systemd Service</span>
                        <span class="text-[9px] text-text-muted font-sans">Restart a system daemon via systemctl</span>
                      </div>
                      
                      <div 
                        class={`border rounded p-2.5 flex flex-col gap-1 cursor-pointer transition-all ${deployType() === "container" ? "border-accent-cyan bg-accent-cyan/5" : "border-white/5 hover:border-white/10"}`}
                        onClick={() => { setDeployType("container"); setDeployConfigDirty(true); }}
                      >
                        <span class="text-xs font-semibold text-text-primary font-sans">Docker Container</span>
                        <span class="text-[9px] text-text-muted font-sans">Restart docker container instance</span>
                      </div>

                      <div 
                        class={`border rounded p-2.5 flex flex-col gap-1 cursor-pointer transition-all ${deployType() === "command" ? "border-accent-cyan bg-accent-cyan/5" : "border-white/5 hover:border-white/10"}`}
                        onClick={() => { setDeployType("command"); setDeployConfigDirty(true); }}
                      >
                        <span class="text-xs font-semibold text-text-primary font-sans">Custom Script</span>
                        <span class="text-[9px] text-text-muted font-sans">Execute shell command or compiler</span>
                      </div>
                    </div>
                  </div>

                  <div class="flex flex-col gap-1">
                    <label class="text-[10px] text-text-secondary uppercase font-semibold font-mono">
                      {deployType() === "service" && "Systemd Service Name"}
                      {deployType() === "container" && "Docker Container Name / ID"}
                      {deployType() === "command" && "Shell command (e.g. npm run build)"}
                    </label>
                    <input
                      type="text"
                      placeholder={
                        deployType() === "service" ? "e.g. nginx" :
                        deployType() === "container" ? "e.g. my-app-container" :
                        "e.g. npm run build && pm2 reload app"
                      }
                      value={deployTarget()}
                      onInput={(e) => { setDeployTarget(e.currentTarget.value); setDeployConfigDirty(true); }}
                      class="w-full text-xs font-mono py-1.5 px-3"
                    />
                  </div>

                  <div class="flex justify-end pt-1">
                    <button 
                      class="btn-primary py-1 px-4 text-xs font-semibold" 
                      onClick={handleSaveDeployConfig}
                      disabled={!deployConfigDirty() || !deployTarget().trim()}
                    >
                      Save Deploy Config
                    </button>
                  </div>
                </div>

                <div class="space-y-2">
                  <h4 class="text-[10px] text-text-secondary uppercase font-bold font-mono tracking-wider">DEPLOY COMMAND PREVIEW</h4>
                  <pre class="bg-dark-panel border rounded p-3 text-[10px] font-mono text-text-secondary leading-normal select-all whitespace-pre-wrap">{deployPreviewText()}</pre>
                </div>

                <div class="pt-2">
                  <button 
                    class="btn-primary w-full py-2 flex items-center justify-center gap-1.5 text-xs font-bold uppercase tracking-wider font-mono"
                    onClick={handleDeployNow}
                    disabled={isStreaming()}
                  >
                    <Play size={12} /> Deploy Now
                  </button>
                </div>
              </div>
            </Show>
          </div>

          {/* Console panel — fixed height so it doesn't crowd the tab content */}
          <Show when={isStreaming() || consoleOutput().length > 0}>
            <div class="console-panel flex flex-col shrink-0" style={{ height: "208px" }}>
              <div class="console-header flex items-center justify-between">
                <div class="flex items-center gap-2">
                  <span class={`status-dot ${isStreaming() ? "active animate-pulse" : "inactive"}`} />
                  <span class="text-[9px] uppercase font-bold tracking-wider font-mono text-text-primary">
                    {streamLabel()} STDOUT / STDERR
                    <Show when={!isStreaming()}><span class="text-text-muted font-normal ml-1">(done)</span></Show>
                  </span>
                </div>
                <button
                  class="btn-secondary text-[9px] py-0.5 px-1.5 font-mono"
                  onClick={() => setConsoleOutput("")}
                >
                  Clear
                </button>
              </div>
              <div ref={consoleRef} class="console-body flex-1 overflow-y-auto">
                {consoleOutput()}
              </div>
            </div>
          </Show>
        </Show>
      </div>
    </div>
  );
}
