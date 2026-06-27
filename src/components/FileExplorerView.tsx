import { createSignal, onMount, onCleanup, createEffect, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { Folder, File, ArrowLeft, Save, Plus, Trash2, FileText, Lock, Loader } from "lucide-solid";
import { EditorView, basicSetup } from "codemirror";
import { EditorState } from "@codemirror/state";

interface FileExplorerProps {
  serverId: string;
  showToast: (message: string, type?: "success" | "error" | "info") => void;
}

interface FileInfo {
  name: string;
  is_dir: boolean;
  size: number;
  permissions: string;
  modified: number;
}

export default function FileExplorerView(props: FileExplorerProps) {
  const [currentPath, setCurrentPath] = createSignal("/");
  const [files, setFiles] = createSignal<FileInfo[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [activeFile, setActiveFile] = createSignal<string | null>(null);
  const [activeFileContent, setActiveFileContent] = createSignal("");
  const [activeFilePermissions, setActiveFilePermissions] = createSignal("");
  const [activeFileChmod, setActiveFileChmod] = createSignal("644");
  const [isEditorDirty, setIsEditorDirty] = createSignal(false);
  const [saveStatus, setSaveStatus] = createSignal("");
  const [newitemName, setNewitemName] = createSignal("");
  const [showNewItemInput, setShowNewItemInput] = createSignal<"file" | "folder" | null>(null);

  let editorContainer: HTMLDivElement | undefined;
  let editorView: EditorView | undefined;

  // Retrieve directory files
  const loadDirectory = async (path: string) => {
    setLoading(true);
    try {
      const list: FileInfo[] = await invoke("list_directory", { serverId: props.serverId, path });
      // Sort: folders first, then files alphabetically
      const sorted = list.sort((a, b) => {
        if (a.is_dir && !b.is_dir) return -1;
        if (!a.is_dir && b.is_dir) return 1;
        return a.name.localeCompare(b.name.toString());
      });
      setFiles(sorted);
      setCurrentPath(path);
    } catch (e: any) {
      props.showToast(`Error loading directory: ${e.toString()}`, "error");
    } finally {
      setLoading(false);
    }
  };



  // Open file in CodeMirror
  const openFile = async (item: FileInfo) => {
    const parent = currentPath() === "/" ? "" : currentPath();
    const filePath = `${parent}/${item.name}`;
    setLoading(true);
    try {
      const b64: string = await invoke("read_remote_file", { serverId: props.serverId, path: filePath });
      // Decode base64 to raw text supporting multi-byte UTF-8 characters
      const binaryString = atob(b64);
      const len = binaryString.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      const rawText = new TextDecoder().decode(bytes);
      
      setActiveFile(filePath);
      setActiveFileContent(rawText);
      setActiveFilePermissions(item.permissions);
      
      // Attempt to extract numerical permissions from octal/character maps
      // Standard chmod default is 644
      setActiveFileChmod("644");
      setIsEditorDirty(false);

      if (editorView) {
        editorView.dispatch({
          changes: { from: 0, to: editorView.state.doc.length, insert: rawText }
        });
      }
    } catch (e: any) {
      props.showToast(`Error reading file: ${e.toString()}`, "error");
    } finally {
      setLoading(false);
    }
  };

  // Save changes back to VPS
  const saveFile = async () => {
    if (!activeFile()) return;
    
    setSaveStatus("Saving...");
    const contentToSave = editorView ? editorView.state.doc.toString() : activeFileContent();
    const b64 = btoa(unescape(encodeURIComponent(contentToSave))); // Encode text cleanly to base64

    try {
      await invoke("write_remote_file", {
        serverId: props.serverId,
        path: activeFile(),
        base64Content: b64
      });
      
      setIsEditorDirty(false);
      setSaveStatus("Changes saved successfully!");
      setTimeout(() => setSaveStatus(""), 3000);
      
      // Reload directory to update file sizes
      loadDirectory(currentPath());
    } catch (e: any) {
      setSaveStatus(`Save failed: ${e.toString()}`);
    }
  };

  // Set file permissions via CLI chmod fallback
  const applyPermissions = async () => {
    const file = activeFile();
    if (!file) return;
    try {
      await invoke("chmod_file", { serverId: props.serverId, path: file, mode: activeFileChmod() });
      props.showToast("Permissions updated!", "success");
      loadDirectory(currentPath());
    } catch (e: any) {
      props.showToast(`Failed to update permissions: ${e.toString()}`, "error");
    }
  };

  // Go back to the parent directory
  const handleBack = () => {
    if (currentPath() === "/") return;
    const parts = currentPath().split("/");
    parts.pop();
    const parent = parts.join("/") || "/";
    loadDirectory(parent);
  };

  // Create new file or folder
  const createItem = async () => {
    if (!newitemName().trim()) return;
    const parent = currentPath() === "/" ? "" : currentPath();
    const targetPath = `${parent}/${newitemName().trim()}`;

    try {
      if (showNewItemInput() === "file") {
        // Write an empty base64 string to create empty file
        await invoke("write_remote_file", { serverId: props.serverId, path: targetPath, base64Content: "" });
      } else {
        // Create directory
        await invoke("create_directory", { serverId: props.serverId, path: targetPath });
      }
      setNewitemName("");
      setShowNewItemInput(null);
      loadDirectory(currentPath());
      props.showToast(`Item created: ${newitemName().trim()}`, "success");
    } catch (e: any) {
      props.showToast(`Error creating item: ${e.toString()}`, "error");
    }
  };

  // Delete file or folder
  const deleteItem = async (item: FileInfo) => {
    if (!confirm(`Are you sure you want to delete ${item.name}?`)) return;
    const parent = currentPath() === "/" ? "" : currentPath();
    const targetPath = `${parent}/${item.name}`;

    try {
      await invoke("delete_file_or_directory", { serverId: props.serverId, path: targetPath, isDir: item.is_dir });
      loadDirectory(currentPath());
      props.showToast(`Deleted ${item.name}`, "success");
    } catch (e: any) {
      props.showToast(`Delete failed: ${e.toString()}`, "error");
    }
  };

  // Initialize CodeMirror instance
  onMount(() => {
    if (editorContainer) {
      editorView = new EditorView({
        state: EditorState.create({
          doc: "",
          extensions: [
            basicSetup,
            EditorView.updateListener.of((update) => {
              if (update.docChanged) {
                setIsEditorDirty(true);
              }
            }),
            EditorView.theme({
              "&": {
                height: "100%",
                background: "#080c14",
                color: "#f8fafc",
              },
              ".cm-gutters": {
                background: "#0f172a",
                color: "#64748b",
                border: "none"
              }
            }, { dark: true })
          ]
        }),
        parent: editorContainer
      });
    }
    loadDirectory("/");
  });

  onCleanup(() => {
    if (editorView) editorView.destroy();
  });

  // Re-poll folder on mount server changes
  createEffect(() => {
    loadDirectory("/");
  });

  return (
    <div class="h-full flex flex-col" style={{ height: "calc(100vh - 120px)" }}>
      {/* File Explorer layout split */}
      <div class="flex-1 flex gap-6 overflow-hidden">
        {/* Left Side: Directory Tree browser */}
        <div class="w-1/3 flex flex-col glass-panel p-4 h-full overflow-hidden">
          <div class="mb-4 flex items-center justify-between">
            <h3 class="font-semibold text-lg flex items-center gap-2">
              <Folder class="text-accent-cyan" size={20} /> Browser
            </h3>
            <div class="flex gap-2">
              <button 
                class="p-1.5 rounded bg-white/5 hover:bg-accent-cyan/20 text-text-secondary hover:text-accent-cyan transition-colors"
                onClick={() => setShowNewItemInput(showNewItemInput() === "file" ? null : "file")}
                title="New File"
              >
                <Plus size={16} />
              </button>
              <button 
                class="p-1.5 rounded bg-white/5 hover:bg-accent-indigo/20 text-text-secondary hover:text-accent-indigo transition-colors"
                onClick={() => setShowNewItemInput(showNewItemInput() === "folder" ? null : "folder")}
                title="New Folder"
              >
                <Folder size={16} />
              </button>
            </div>
          </div>

          {/* Breadcrumb controls */}
          <div class="mb-3 flex gap-2 items-center text-sm bg-slate-900/40 p-2 rounded-lg border border-white/5">
            <button 
              class="p-1 rounded hover:bg-white/10 disabled:opacity-40"
              onClick={handleBack} 
              disabled={currentPath() === "/"}
            >
              <ArrowLeft size={16} />
            </button>
            <span class="truncate font-mono text-xs text-text-secondary">{currentPath()}</span>
          </div>

          {/* New Item creation textfield */}
          <Show when={showNewItemInput()}>
            <div class="mb-3 flex gap-2">
              <input
                type="text"
                placeholder={showNewItemInput() === "file" ? "file.txt" : "New Folder"}
                value={newitemName()}
                onInput={(e) => setNewitemName(e.currentTarget.value)}
                class="flex-1 text-xs py-1.5"
              />
              <button class="btn-primary py-1.5 px-3 text-xs" onClick={createItem}>Create</button>
            </div>
          </Show>

          {/* Directory Item List container */}
          <div class="flex-1 overflow-y-auto space-y-1 pr-1">
            <Show when={loading()}>
              <div class="py-8 flex justify-center items-center gap-2 text-text-secondary text-sm">
                <Loader class="animate-spin text-accent-cyan" size={16} /> Loading files...
              </div>
            </Show>
            
            <Show when={!loading() && files().length === 0}>
              <div class="py-8 text-center text-text-muted text-xs font-mono">Empty Directory</div>
            </Show>

            <Show when={!loading()}>
              <For each={files()}>
                {(item) => (
                  <div 
                    class="group flex justify-between items-center px-2 py-1.5 rounded-lg text-sm hover:bg-white/5 cursor-pointer border border-transparent hover:border-white/5 transition-all"
                    onDblClick={() => {
                      if (item.is_dir) {
                        const parent = currentPath() === "/" ? "" : currentPath();
                        loadDirectory(`${parent}/${item.name}`);
                      }
                    }}
                    onClick={() => {
                      if (!item.is_dir) {
                        openFile(item);
                      }
                    }}
                  >
                    <div class="flex items-center gap-2 truncate flex-1">
                      {item.is_dir ? (
                        <Folder size={16} class="text-accent-cyan shrink-0" />
                      ) : (
                        <File size={16} class="text-text-secondary shrink-0" />
                      )}
                      <span class="truncate font-mono text-xs">{item.name}</span>
                    </div>
                    
                    {/* Delete actions (on hover) */}
                    <button 
                      class="opacity-0 group-hover:opacity-100 p-1 text-text-muted hover:text-accent-danger transition-all duration-200"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteItem(item);
                      }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                )}
              </For>
            </Show>
          </div>
        </div>

        {/* Right Side: Code Editor Workspace */}
        <div class="flex-1 flex flex-col glass-panel overflow-hidden h-full">
          {/* File Selected Placeholder */}
          <div 
            class="flex-1 flex flex-col justify-center items-center text-center p-8"
            style={{ display: activeFile() === null ? "flex" : "none" }}
          >
            <FileText size={64} class="text-text-muted/20 mb-4" />
            <h3 class="text-lg font-semibold text-text-secondary">No File Selected</h3>
            <p class="text-sm text-text-muted mt-1 max-w-xs">Single-click a file in the directory browser to open it here for remote editing.</p>
          </div>

          {/* Active Editor Panel */}
          <div 
            class="flex-1 flex flex-col overflow-hidden h-full"
            style={{ display: activeFile() !== null ? "flex" : "none" }}
          >
            {/* Editor toolbar */}
            <div class="p-4 border-b border-white/5 flex justify-between items-center bg-slate-950/20">
              <div class="truncate flex-1 mr-4">
                <h4 class="font-mono text-xs font-semibold truncate text-accent-cyan">{activeFile()}</h4>
                <Show when={isEditorDirty()}>
                  <span class="text-[10px] text-accent-warning font-semibold font-mono">● UNSAVED CHANGES</span>
                </Show>
              </div>
              <div class="flex items-center gap-4">
                <span class="text-xs text-text-muted">{saveStatus()}</span>
                <button class="btn-primary py-1.5 px-3 text-xs" onClick={saveFile}>
                  <Save size={14} /> Save File
                </button>
              </div>
            </div>

            {/* CodeMirror element mount */}
            <div ref={editorContainer} class="flex-1 overflow-auto font-mono text-sm bg-[#080c14]" />

            {/* Visual Permissions toolbar */}
            <div class="p-3 border-t border-white/5 bg-slate-950/40 flex flex-wrap justify-between items-center gap-3 text-xs">
              <div class="flex items-center gap-2 text-text-secondary">
                <Lock size={14} class="text-accent-indigo" />
                <span>Current permissions: <strong class="font-mono text-text-primary">{activeFilePermissions()}</strong></span>
              </div>
              <div class="flex items-center gap-2">
                <span class="text-text-muted">Chmod:</span>
                <input
                  type="text"
                  value={activeFileChmod()}
                  onInput={(e) => setActiveFileChmod(e.currentTarget.value)}
                  class="w-16 text-center py-1 px-2 border border-white/10 rounded font-mono"
                  maxLength={4}
                />
                <button class="btn-secondary py-1 px-3" onClick={applyPermissions}>Apply</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
