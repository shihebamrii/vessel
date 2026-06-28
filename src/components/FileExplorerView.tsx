import { createSignal, onMount, onCleanup, createEffect, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { Folder, File, ArrowLeft, Save, Plus, Trash2, FileText, Lock, Loader, Upload } from "lucide-solid";
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

const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "ico", "webp", "bmp", "tiff",
  "exe", "dll", "so", "dylib", "bin", "elf", "out", "app",
  "zip", "tar", "gz", "xz", "bz2", "7z", "rar", "jar", "war", "deb", "rpm",
  "mp4", "mp3", "wav", "ogg", "mkv", "avi", "mov", "flv", "webm",
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "epub",
  "db", "sqlite", "pyc", "o", "a", "class"
]);

function isBinaryFile(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase();
  return ext ? BINARY_EXTENSIONS.has(ext) : false;
}

export default function FileExplorerView(props: FileExplorerProps) {
  const [isBinary, setIsBinary] = createSignal(false);
  const [binaryMetadata, setBinaryMetadata] = createSignal<FileInfo | null>(null);
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

  const [uploading, setUploading] = createSignal(false);
  const [isDragging, setIsDragging] = createSignal(false);
  let fileInputRef: HTMLInputElement | undefined;

  const readFileAsBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const arrayBuffer = e.target?.result as ArrayBuffer;
        const bytes = new Uint8Array(arrayBuffer);
        let binary = "";
        const len = bytes.byteLength;
        for (let i = 0; i < len; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        resolve(btoa(binary));
      };
      reader.onerror = () => reject(new Error("Failed to read local file"));
      reader.readAsArrayBuffer(file);
    });
  };

  const uploadMultipleFiles = async (selectedFilesList: FileList | File[]) => {
    const selectedFiles = Array.from(selectedFilesList);
    if (selectedFiles.length === 0) return;

    const maxSizeBytes = 15 * 1024 * 1024; // 15MB limit

    // Validate size of each file
    for (const file of selectedFiles) {
      if (file.size > maxSizeBytes) {
        props.showToast(`"${file.name}" is too large (${(file.size / (1024 * 1024)).toFixed(2)}MB). Max size is 15MB.`, "error");
        if (fileInputRef) fileInputRef.value = "";
        return;
      }
    }

    setUploading(true);
    props.showToast(`Starting upload of ${selectedFiles.length} file(s)...`, "info");

    for (let i = 0; i < selectedFiles.length; i++) {
      const file = selectedFiles[i];
      try {
        let cleanName = file.name.replace(/[\/\\]/g, "_").replace(/\0/g, "");
        if (!cleanName || cleanName === "." || cleanName === "..") {
          cleanName = `uploaded_file_${Date.now()}_${i}`;
        }

        const parent = currentPath() === "/" ? "" : currentPath();
        const targetPath = `${parent}/${cleanName}`;

        props.showToast(`Uploading ${cleanName} (${i + 1}/${selectedFiles.length})...`, "info");

        const b64 = await readFileAsBase64(file);

        await invoke("write_remote_file", {
          serverId: props.serverId,
          path: targetPath,
          base64Content: b64
        });
      } catch (err: any) {
        props.showToast(`Upload failed for "${file.name}": ${err.toString()}`, "error");
        break;
      }
    }

    props.showToast("All uploads completed successfully.", "success");
    if (fileInputRef) fileInputRef.value = "";
    setUploading(false);
    loadDirectory(currentPath());
  };

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
      uploadMultipleFiles(e.dataTransfer.files);
    }
  };

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

    if (isBinaryFile(item.name)) {
      setIsBinary(true);
      setBinaryMetadata(item);
      setActiveFile(filePath);
      setActiveFilePermissions(item.permissions);
      setActiveFileChmod("644");
      setIsEditorDirty(false);
      return;
    }

    setIsBinary(false);
    setBinaryMetadata(null);
    setLoading(true);
    try {
      const b64: string = await invoke("read_remote_file", { serverId: props.serverId, path: filePath });
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
    const b64 = btoa(unescape(encodeURIComponent(contentToSave)));

    try {
      await invoke("write_remote_file", {
        serverId: props.serverId,
        path: activeFile(),
        base64Content: b64
      });
      
      setIsEditorDirty(false);
      setSaveStatus("Saved successfully");
      setTimeout(() => setSaveStatus(""), 3000);
      
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
        await invoke("write_remote_file", { serverId: props.serverId, path: targetPath, base64Content: "" });
      } else {
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
                background: "#040507",
                color: "#f5f6f8",
              },
              ".cm-gutters": {
                background: "#0c0d10",
                color: "#545456",
                border: "none",
                borderRight: "1px solid #1e2026"
              },
              ".cm-activeLine": {
                backgroundColor: "#101217"
              },
              ".cm-activeLineGutter": {
                backgroundColor: "#101217"
              }
            }, { dark: true })
          ]
        }),
        parent: editorContainer
      });
    }
  });

  onCleanup(() => {
    if (editorView) editorView.destroy();
  });

  createEffect(() => {
    loadDirectory("/");
  });

  return (
    <div class="h-full flex flex-col min-h-0" style={{ height: "calc(100vh - 120px)" }}>
      {/* File Explorer layout split */}
      <div class="flex-1 flex gap-4 overflow-hidden min-h-0">
        {/* Left Side: Directory Tree browser */}
        <div 
          class={`w-1/3 flex flex-col glass-panel p-3 h-full overflow-hidden transition-all duration-200 ${isDragging() ? 'border-2 border-dashed border-accent-cyan bg-accent-cyan/5 scale-[0.99]' : ''}`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <input
            type="file"
            ref={fileInputRef}
            onChange={(e) => {
              if (e.currentTarget.files) {
                uploadMultipleFiles(e.currentTarget.files);
              }
            }}
            style={{ display: "none" }}
            multiple
          />
          <div class="mb-3 flex items-center justify-between">
            <h3 class="font-bold text-xs uppercase tracking-wider font-mono flex items-center gap-1.5">
              <Folder class="text-accent-cyan" size={13} /> Directories
            </h3>
            <div class="flex gap-1.5">
              <button 
                class="btn-secondary p-1 text-[11px]"
                onClick={() => setShowNewItemInput(showNewItemInput() === "file" ? null : "file")}
                title="New File"
              >
                <Plus size={12} />
              </button>
              <button 
                class="btn-secondary p-1 text-[11px]"
                onClick={() => setShowNewItemInput(showNewItemInput() === "folder" ? null : "folder")}
                title="New Folder"
              >
                <Folder size={12} />
              </button>
              <button 
                class="btn-secondary p-1 text-[11px] relative"
                onClick={() => fileInputRef?.click()}
                title="Upload Files (Max 15MB each)"
                disabled={uploading()}
              >
                <Show when={uploading()}>
                  <Loader class="animate-spin text-accent-cyan" size={12} />
                </Show>
                <Show when={!uploading()}>
                  <Upload size={12} />
                </Show>
              </button>
            </div>
          </div>

          {/* Breadcrumb controls */}
          <div class="mb-3 flex gap-2 items-center bg-slate-950/40 p-1.5 rounded border">
            <button 
              class="btn-secondary p-1 disabled:opacity-40"
              onClick={handleBack} 
              disabled={currentPath() === "/"}
            >
              <ArrowLeft size={12} />
            </button>
            <span class="truncate font-mono text-[10px] text-text-secondary select-all" title={currentPath()}>
              {currentPath()}
            </span>
          </div>

          {/* New Item creation textfield */}
          <Show when={showNewItemInput()}>
            <div class="mb-3 flex gap-2">
              <input
                type="text"
                placeholder={showNewItemInput() === "file" ? "filename.txt" : "Folder Name"}
                value={newitemName()}
                onInput={(e) => setNewitemName(e.currentTarget.value)}
                class="flex-1 text-xs py-1"
                autofocus
              />
              <button class="btn-primary py-1 px-3 text-xs" onClick={createItem}>Create</button>
            </div>
          </Show>

          {/* Directory Item List container */}
          <div class="flex-1 overflow-y-auto space-y-0.5 pr-1 font-mono">
            <Show when={loading()}>
              <div class="py-8 flex justify-center items-center gap-2 text-text-secondary text-xs">
                <Loader class="animate-spin text-accent-cyan" size={12} /> Loading directory...
              </div>
            </Show>
            
            <Show when={!loading() && files().length === 0}>
              <div class="py-8 text-center text-text-muted text-[10px] uppercase font-bold tracking-wider">Empty Directory</div>
            </Show>

            <Show when={!loading()}>
              <For each={files()}>
                {(item) => (
                  <div 
                    class="group flex justify-between items-center px-2 py-1 rounded text-xs hover:bg-[#14161c] cursor-pointer transition-all"
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
                        <Folder size={13} class="text-accent-cyan shrink-0" />
                      ) : (
                        <File size={13} class="text-text-secondary shrink-0" />
                      )}
                      <span class="truncate text-[11px] text-text-primary">{item.name}</span>
                    </div>
                    
                    <button 
                      class="btn-secondary p-1"
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteItem(item);
                      }}
                    >
                      <Trash2 class="text-accent-danger btn-secondary p-1" size={11} />
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
            class="flex-1 flex flex-col justify-center items-center text-center p-8 bg-[#040507]"
            style={{ display: activeFile() === null ? "flex" : "none" }}
          >
            <FileText size={48} class="text-text-muted/10 mb-3" />
            <h3 class="text-xs font-semibold text-text-secondary uppercase tracking-wider font-mono">No Active Resource</h3>
            <p class="text-xs text-text-muted mt-1.5 max-w-xs">Double-click folders to navigate, single-click files to load into the text editor.</p>
          </div>

          {/* Active Editor Panel */}
          <div 
            class="flex-1 flex flex-col overflow-hidden h-full"
            style={{ display: activeFile() !== null ? "flex" : "none" }}
          >
            {/* Editor Toolbar & CodeMirror Container (hidden when binary) */}
            <div 
              class="flex-1 flex flex-col overflow-hidden h-full"
              style={{ display: isBinary() ? "none" : "flex" }}
            >
              {/* Editor toolbar */}
              <div class="p-3 border-b flex justify-between items-center bg-slate-950/20">
                <div class="truncate flex-1 mr-4">
                  <h4 class="font-mono text-xs font-bold truncate text-accent-cyan">{activeFile()}</h4>
                  <Show when={isEditorDirty()}>
                    <span class="text-[9px] text-accent-warning font-bold font-mono uppercase">● Modified</span>
                  </Show>
                </div>
                <div class="flex items-center gap-3 shrink-0">
                  <span class="text-xs text-text-muted font-mono">{saveStatus()}</span>
                  <button class="btn-primary py-1 px-3 text-xs" onClick={saveFile}>
                    <Save size={12} /> Save File
                  </button>
                </div>
              </div>

              {/* CodeMirror element mount */}
              <div ref={editorContainer} class="flex-1 overflow-auto font-mono text-xs bg-[#040507]" />
            </div>

            {/* Binary File Metadata Panel (shown when binary) */}
            <Show when={isBinary()}>
              <div class="flex-1 flex flex-col justify-center items-center text-center p-6 bg-[#040507]">
                <File size={48} class="text-accent-indigo/20 mb-3 animate-pulse" />
                <h3 class="text-xs font-bold font-mono text-text-secondary truncate max-w-md uppercase">BINARY FILE: {activeFile()?.split('/').pop()}</h3>
                <p class="text-xs text-text-muted mt-1.5">Direct editor viewing is disabled for binary assets.</p>
                <div class="mt-4 bg-dark-panel border p-3 max-w-xs w-full text-left space-y-1.5 text-xs font-mono">
                  <div class="flex justify-between"><span class="text-text-muted">Size:</span> <span>{(binaryMetadata()?.size || 0).toLocaleString()} B</span></div>
                  <div class="flex justify-between"><span class="text-text-muted">Modified:</span> <span>{binaryMetadata()?.modified ? new Date(binaryMetadata()!.modified * 1000).toLocaleString() : "Unknown"}</span></div>
                  <div class="flex justify-between"><span class="text-text-muted">Mode:</span> <span>{binaryMetadata()?.permissions}</span></div>
                </div>
              </div>
            </Show>

            {/* Visual Permissions toolbar */}
            <div class="p-2 border-t bg-[#0c0d10] flex flex-wrap justify-between items-center gap-2 text-xs">
              <div class="flex items-center gap-1.5 text-text-secondary">
                <Lock size={12} class="text-accent-indigo" />
                <span>Permissions: <strong class="font-mono text-text-primary">{activeFilePermissions()}</strong></span>
              </div>
              <div class="flex items-center gap-1.5">
                <span class="text-text-muted font-mono">Mode:</span>
                <input
                  type="text"
                  value={activeFileChmod()}
                  onInput={(e) => setActiveFileChmod(e.currentTarget.value)}
                  class="w-12 text-center py-0.5 px-1 font-mono text-xs"
                  maxLength={4}
                />
                <button class="btn-secondary py-0.5 px-2 text-xs" onClick={applyPermissions}>Chmod</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
