import { create } from "zustand";
import {
  ipc,
  type DirEntry,
  type FileContent,
  type FileTreeColor,
  type RepositorySummary,
} from "@/lib/ipc";
import { errorText } from "@/lib/errors";
import { writeStored } from "@/lib/storage";

export const FILES_ROOT_KEY = "ccgui-next.filesRoot";

/** Join a directory path and a child name. Backend paths are POSIX-style on
 * macOS/Linux; Rust's fs APIs also accept "/" separators on Windows. */
export function joinPath(dir: string, name: string): string {
  if (dir.endsWith("/") || dir.endsWith("\\")) return dir + name;
  return dir + "/" + name;
}

export function fileName(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx >= 0 ? path.slice(idx + 1) : path;
}
export function parentPath(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx >= 0 ? path.slice(0, idx) : path;
}

/** In-app copy/paste clipboard for tree items (path-based; paste copies). */
export interface TreeClipboard {
  path: string;
  isDir: boolean;
}

export interface OpenFileState {
  path: string;
  /** null while the first read is in flight. */
  content: FileContent | null;
  loading: boolean;
  error: string | null;
  /** Bumped on every successful (re)load so the editor resets its draft. */
  loadNonce: number;
}

interface FilesStore {
  /** Folder the tree is rooted at; "" = unset. Persisted to localStorage. */
  root: string;
  /** dirPath -> loaded children (dirs first; backend sorts). Missing = not fetched. */
  children: Record<string, DirEntry[]>;
  loadingDirs: Record<string, true>;
  dirErrors: Record<string, string>;
  expanded: Record<string, true>;
  /** Exact nested repository root -> compact Git status (branch + counts). */
  repositories: Record<string, RepositorySummary>;
  /** Loaded level -> per-file git color ("modified" / "untracked"). */
  fileColors: Record<string, Record<string, FileTreeColor>>;
  /** Currently selected tree node (file or dir). */
  selectedPath: string | null;
  /** Whether the selected tree node is a directory. */
  selectedIsDir: boolean;
  /** Open file tabs, in tab order. */
  openFiles: string[];
  /** Per-tab load state keyed by absolute path. */
  fileStates: Record<string, OpenFileState>;
  /** File tab shown in the center area; null = a chat tab is active. */
  activeFilePath: string | null;
  /** Paths with unsaved editor drafts (reported by EditorPane). */
  dirtyPaths: Record<string, true>;
  /** Tree item staged by the context menu's Copy; consumed by Paste. */
  clipboard: TreeClipboard | null;

  setRoot: (path: string) => void;
  ensureDir: (path: string) => Promise<void>;
  toggleDir: (path: string) => Promise<void>;
  /** Re-fetch a directory only if it has been loaded before. */
  invalidateDir: (path: string) => Promise<void>;
  /** Refresh compact Git status for the directories of one loaded level. */
  loadRepositories: (dirPath: string, entries: DirEntry[]) => Promise<void>;
  /** Re-fetch every loaded/expanded directory (titlebar refresh button). */
  refreshTree: () => Promise<void>;
  /** True while refreshTree is in flight. */
  refreshing: boolean;
  /** Refresh per-file git colors for the files of one loaded level. */
  loadFileColors: (dirPath: string, entries: DirEntry[]) => Promise<void>;
  selectPath: (path: string | null, isDir?: boolean) => void;
  /** Open a file as a center tab (or focus its existing tab). */
  openFile: (path: string) => Promise<void>;
  /** Switch the center area to an already-open file tab. */
  activateFile: (path: string) => void;
  /** Return the center area to the chat (a chat tab was selected). */
  clearActiveFile: () => void;
  /** Re-read a file from disk, resetting its editor draft. */
  reloadFile: (path: string) => Promise<void>;
  closeFile: (path: string) => void;
  /** Move an open file tab to a new position (drag-reorder in the tab strip). */
  moveOpenFile: (path: string, toIndex: number) => void;
  /** Re-point open tabs after a rename/move (content unchanged on disk). */
  remapOpenFiles: (from: string, to: string) => void;
  /** Stage a tree item for Paste. */
  setClipboard: (item: TreeClipboard | null) => void;
  /** Drop cached tree state at/under a removed path and close its tabs. */
  removeTreePath: (path: string) => void;
  /** Re-key cached tree state (and open tabs) after a rename/move. */
  remapTreePath: (from: string, to: string) => void;
  /** Close every tab at or under a removed path. */
  closeFilesUnder: (path: string) => void;
  setFileDirty: (path: string, dirty: boolean) => void;
}

export const useFilesStore = create<FilesStore>((set, get) => ({
  root: localStorage.getItem(FILES_ROOT_KEY) ?? "",
  children: {},
  loadingDirs: {},
  dirErrors: {},
  expanded: {},
  repositories: {},
  fileColors: {},
  selectedPath: null,
  selectedIsDir: false,
  refreshing: false,
  openFiles: [],
  fileStates: {},
  activeFilePath: null,
  dirtyPaths: {},
  clipboard: null,

  setRoot: (path) => {
    const root = path.trim();
    if (root === get().root) return;
    if (root) {
      writeStored(FILES_ROOT_KEY, root);
    } else {
      localStorage.removeItem(FILES_ROOT_KEY);
    }
    // Open file tabs survive root (workspace) switches — they are absolute
    // paths and stay editable regardless of which tree is shown.
    set({
      root,
      children: {},
      loadingDirs: {},
      dirErrors: {},
      expanded: {},
      repositories: {},
      fileColors: {},
      selectedPath: null,
      selectedIsDir: false,
    });
    if (root) void get().ensureDir(root);
  },

  ensureDir: async (path) => {
    const s = get();
    if (s.children[path] || s.loadingDirs[path]) return;
    set((s) => ({ loadingDirs: { ...s.loadingDirs, [path]: true } }));
    try {
      const entries = await ipc.listDir(path);
      set((s) => {
        const loadingDirs = { ...s.loadingDirs };
        const dirErrors = { ...s.dirErrors };
        delete loadingDirs[path];
        delete dirErrors[path];
        return {
          children: { ...s.children, [path]: entries },
          loadingDirs,
          dirErrors,
        };
      });
      void get().loadRepositories(path, entries);
      void get().loadFileColors(path, entries);
    } catch (e) {
      set((s) => {
        const loadingDirs = { ...s.loadingDirs };
        delete loadingDirs[path];
        return {
          loadingDirs,
          dirErrors: { ...s.dirErrors, [path]: errorText(e) },
        };
      });
    }
  },

  loadRepositories: async (dirPath, entries) => {
    // dirPath itself may be the workspace root repository (the 截图 case:
    // `open-reverselab main M1 ?12` on the tree's top row), so query it
    // alongside its child directories.
    const paths = [dirPath, ...entries.filter((e) => e.isDir).map((e) => joinPath(dirPath, e.name))];
    try {
      const summaries = await ipc.gitRepositorySummaries(paths);
      // Non-repos are dropped: a stale entry must not survive a refresh.
      const fresh: Record<string, RepositorySummary> = {};
      for (const summary of summaries) fresh[summary.path] = summary;
      set((s) => ({ repositories: { ...s.repositories, ...fresh } }));
    } catch {
      // File browsing stays usable when the batch status call fails.
    }
  },

  loadFileColors: async (dirPath, entries) => {
    // Ask about files AND folders: the backend aggregates directory colors
    // from everything beneath them, so parents light up without expanding.
    const files = entries
      .filter((entry) => !entry.name.startsWith("."))
      .map((entry) => entry.name);
    if (files.length === 0) return;
    try {
      const colors = await ipc.gitFileColors(dirPath, files);
      set((s) => ({ fileColors: { ...s.fileColors, [dirPath]: colors } }));
    } catch {
      // Colors are cosmetic; keep the tree usable when the walk fails.
    }
  },

  toggleDir: async (path) => {
    const s = get();
    if (s.expanded[path]) {
      const expanded = { ...s.expanded };
      delete expanded[path];
      set({ expanded });
      return;
    }
    set((s) => ({ expanded: { ...s.expanded, [path]: true } }));
    await get().ensureDir(path);
  },

  invalidateDir: async (path) => {
    if (!get().children[path]) return;
    try {
      const entries = await ipc.listDir(path);
      set((s) => ({ children: { ...s.children, [path]: entries } }));
      void get().loadRepositories(path, entries);
    } catch {
      // Keep stale listing on refresh failure; the user can retry by toggling.
    }
  },
  refreshTree: async () => {
    const s = get();
    if (!s.root || s.refreshing) return;
    set({ refreshing: true });
    try {
      const dirs = new Set([...Object.keys(s.children), ...Object.keys(s.expanded)]);
      await Promise.all(
        [...dirs].map((dir) =>
          get().children[dir] ? get().invalidateDir(dir) : get().ensureDir(dir),
        ),
      );
      // Local listDir is near-instant; hold the spinner long enough for the
      // animation to read as feedback instead of an imperceptible flicker.
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 500);
      await promise;
    } finally {
      set({ refreshing: false });
    }
  },

  selectPath: (path, isDir = false) => set({ selectedPath: path, selectedIsDir: isDir }),

  openFile: async (path) => {
    if (get().fileStates[path]) {
      set({ activeFilePath: path, selectedPath: path, selectedIsDir: false });
      return;
    }
    set((s) => ({
      openFiles: [...s.openFiles, path],
      fileStates: {
        ...s.fileStates,
        [path]: { path, content: null, loading: true, error: null, loadNonce: 0 },
      },
      activeFilePath: path,
      selectedPath: path,
      selectedIsDir: false,
    }));
    await get().reloadFile(path);
  },

  activateFile: (path) => {
    if (get().fileStates[path]) set({ activeFilePath: path });
  },

  clearActiveFile: () => set({ activeFilePath: null }),

  reloadFile: async (path) => {
    set((s) => {
      const st = s.fileStates[path];
      if (!st) return s;
      return {
        fileStates: { ...s.fileStates, [path]: { ...st, loading: true, error: null } },
      };
    });
    try {
      const content = await ipc.readFile(path);
      set((s) => {
        const st = s.fileStates[path];
        if (!st) return s; // tab closed mid-load
        return {
          fileStates: {
            ...s.fileStates,
            [path]: { ...st, content, loading: false, loadNonce: st.loadNonce + 1 },
          },
        };
      });
    } catch (e) {
      const message = errorText(e);
      set((s) => {
        const st = s.fileStates[path];
        if (!st) return s;
        return {
          fileStates: { ...s.fileStates, [path]: { ...st, loading: false, error: message } },
        };
      });
    }
  },

  closeFile: (path) =>
    set((s) => {
      if (!s.fileStates[path]) return s;
      const openFiles = s.openFiles.filter((p) => p !== path);
      const fileStates = { ...s.fileStates };
      delete fileStates[path];
      const dirtyPaths = { ...s.dirtyPaths };
      delete dirtyPaths[path];
      let activeFilePath = s.activeFilePath;
      if (activeFilePath === path) {
        const idx = s.openFiles.indexOf(path);
        // Focus the tab that slid into the closed one's slot (or the last).
        activeFilePath = openFiles[Math.min(idx, openFiles.length - 1)] ?? null;
      }
      return { openFiles, fileStates, dirtyPaths, activeFilePath };
    }),
  moveOpenFile: (path, toIndex) =>
    set((s) => {
      const from = s.openFiles.indexOf(path);
      if (from < 0) return s;
      const openFiles = [...s.openFiles];
      openFiles.splice(from, 1);
      openFiles.splice(Math.max(0, Math.min(toIndex, openFiles.length)), 0, path);
      return { openFiles };
    }),

  remapOpenFiles: (from, to) =>
    set((s) => {
      const mapPath = (p: string) =>
        p === from ? to : p.startsWith(from + "/") ? to + p.slice(from.length) : p;
      if (!s.openFiles.some((p) => mapPath(p) !== p)) return s;
      const fileStates: Record<string, OpenFileState> = {};
      for (const [p, st] of Object.entries(s.fileStates)) {
        const np = mapPath(p);
        fileStates[np] = np === p ? st : { ...st, path: np };
      }
      const dirtyPaths: Record<string, true> = {};
      for (const p of Object.keys(s.dirtyPaths)) dirtyPaths[mapPath(p)] = true;
      return {
        openFiles: s.openFiles.map(mapPath),
        fileStates,
        dirtyPaths,
        activeFilePath: s.activeFilePath ? mapPath(s.activeFilePath) : null,
      };
    }),

  closeFilesUnder: (path) => {
    for (const p of [...get().openFiles]) {
      if (p === path || p.startsWith(path + "/")) get().closeFile(p);
    }
  },
  setClipboard: (item) => set({ clipboard: item }),

  removeTreePath: (path) => {
    const prune = <T,>(map: Record<string, T>) => {
      const next: Record<string, T> = {};
      for (const [k, v] of Object.entries(map)) {
        if (k !== path && !k.startsWith(path + "/")) next[k] = v;
      }
      return next;
    };
    set((s) => ({
      children: prune(s.children),
      expanded: prune(s.expanded),
      loadingDirs: prune(s.loadingDirs),
      dirErrors: prune(s.dirErrors),
      repositories: prune(s.repositories),
      fileColors: prune(s.fileColors),
      selectedPath:
        s.selectedPath && (s.selectedPath === path || s.selectedPath.startsWith(path + "/"))
          ? null
          : s.selectedPath,
      clipboard:
        s.clipboard && (s.clipboard.path === path || s.clipboard.path.startsWith(path + "/"))
          ? null
          : s.clipboard,
    }));
    get().closeFilesUnder(path);
  },

  remapTreePath: (from, to) => {
    const mapPath = (p: string) =>
      p === from ? to : p.startsWith(from + "/") ? to + p.slice(from.length) : p;
    const remap = <T,>(map: Record<string, T>) => {
      const next: Record<string, T> = {};
      for (const [k, v] of Object.entries(map)) next[mapPath(k)] = v;
      return next;
    };
    set((s) => ({
      children: remap(s.children),
      expanded: remap(s.expanded),
      loadingDirs: remap(s.loadingDirs),
      dirErrors: remap(s.dirErrors),
      selectedPath: s.selectedPath ? mapPath(s.selectedPath) : s.selectedPath,
      clipboard: s.clipboard ? { ...s.clipboard, path: mapPath(s.clipboard.path) } : s.clipboard,
      repositories: remap(s.repositories),
      fileColors: remap(s.fileColors),
    }));
    get().remapOpenFiles(from, to);
  },

  setFileDirty: (path, dirty) =>
    set((s) => {
      const has = !!s.dirtyPaths[path];
      if (dirty === has) return s;
      const dirtyPaths = { ...s.dirtyPaths };
      if (dirty) dirtyPaths[path] = true;
      else delete dirtyPaths[path];
      return { dirtyPaths };
    }),
}));
