import type { DocumentStorage } from "@ccgui/plugin-sdk";
import { isWeb } from "@/lib/transport";
import type { PluginContextBackend } from "./context";
import { withAuthorizedHostInvoke } from "./hardening";

export class DocumentStorageConflictError extends Error {
  readonly code = "DOCUMENT_STORAGE_CONFLICT";

  constructor(readonly currentVersion: string | null) {
    super(`document storage version conflict (current: ${currentVersion ?? "missing"})`);
    this.name = "DocumentStorageConflictError";
  }
}


/** Uses the compatibility line's IPC/CAS contract, with no business schema. */
export function createDocumentStorage(
  pluginId: string,
  backend: PluginContextBackend,
  requirePermission: (permission: string) => void,
): DocumentStorage {
  async function invoke<T>(operation: () => Promise<T>): Promise<T> {
    requirePermission("plugin.storage");
    if (isWeb) throw new Error("plugin.storage: desktop operation only");
    return withAuthorizedHostInvoke(operation);
  }

  return {
    async getLocation() {
      const location = await invoke(() => backend.documentStorageGetLocation(pluginId));
      return { kind: location.kind, path: location.displayPath };
    },
    async selectLocation(kind) {
      const customPath = kind === "custom" ? await invoke(() => backend.pickDirectory()) : null;
      if (kind === "custom" && customPath === null) throw new Error("document storage directory selection cancelled");
      const location = await invoke(() => backend.documentStorageSelectLocation(pluginId, kind, customPath));
      return { kind: location.kind, path: location.displayPath };
    },
    readText(relativePath) {
      return invoke(() => backend.documentStorageReadText(pluginId, relativePath));
    },
    async writeTextAtomic(relativePath, content, expectedVersion) {
      const result = await invoke(() => backend.documentStorageWriteTextAtomic(pluginId, relativePath, content, expectedVersion));
      if (result.status === "conflict") throw new DocumentStorageConflictError(result.currentVersion);
      return { version: result.version };
    },
    async remove(relativePath, expectedVersion) {
      const result = await invoke(() => backend.documentStorageRemove(pluginId, relativePath, expectedVersion ?? null));
      if (result.status === "conflict") throw new DocumentStorageConflictError(result.currentVersion);
    },
    list(prefix) {
      return invoke(() => backend.documentStorageList(pluginId, prefix));
    },
  };
}
