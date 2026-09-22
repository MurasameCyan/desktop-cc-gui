import type { DocumentStorage, DocumentStorageLocationKind } from "@ccgui/plugin-sdk";
import { isWeb } from "@/lib/transport";
import { pickDirectory } from "@/lib/platform";
import type { PluginContextBackend } from "./context";
import { withAuthorizedHostInvoke } from "./hardening";

export class DocumentStorageConflictError extends Error {
  readonly code = "DOCUMENT_STORAGE_CONFLICT";

  constructor(readonly currentVersion: string | null) {
    super(`document storage version conflict (current: ${currentVersion ?? "missing"})`);
    this.name = "DocumentStorageConflictError";
  }
}

type LocationResponse = { kind: DocumentStorageLocationKind; displayPath: string; writable: boolean };
type Conflict = { status: "conflict"; currentVersion: string | null };

/** Uses the compatibility line's IPC/CAS contract, with no business schema. */
export function createDocumentStorage(
  pluginId: string,
  backend: PluginContextBackend,
  requirePermission: (permission: string) => void,
): DocumentStorage {
  async function invoke<T>(command: string, args: Record<string, unknown>): Promise<T> {
    requirePermission("plugin.storage");
    if (isWeb) throw new Error("plugin.storage: desktop operation only");
    const ownedArgs = { ...args, pluginId };
    return withAuthorizedHostInvoke(() => backend.bridgeInvoke(command, ownedArgs)) as Promise<T>;
  }

  return {
    async getLocation() {
      const location = await invoke<LocationResponse>("plugin_document_storage_get_location", {});
      return { kind: location.kind, path: location.displayPath };
    },
    async selectLocation(kind) {
      requirePermission("plugin.storage");
      if (isWeb) throw new Error("plugin.storage: desktop operation only");
      let customPath: string | null = null;
      if (kind === "custom") {
        customPath = await withAuthorizedHostInvoke(() => pickDirectory("Plugin document storage"));
        if (customPath === null) throw new Error("document storage directory selection cancelled");
      }
      const location = await invoke<LocationResponse>("plugin_document_storage_select_location", { kind, customPath });
      return { kind: location.kind, path: location.displayPath };
    },
    readText(relativePath) {
      return invoke("plugin_document_storage_read_text", { relativePath });
    },
    async writeTextAtomic(relativePath, content, expectedVersion) {
      const result = await invoke<{ status: "written"; version: string } | Conflict>(
        "plugin_document_storage_write_text_atomic", { relativePath, content, expectedVersion },
      );
      if (result.status === "conflict") throw new DocumentStorageConflictError(result.currentVersion);
      return { version: result.version };
    },
    async remove(relativePath, expectedVersion) {
      const result = await invoke<{ status: "removed" } | Conflict>(
        "plugin_document_storage_remove", { relativePath, expectedVersion: expectedVersion ?? null },
      );
      if (result.status === "conflict") throw new DocumentStorageConflictError(result.currentVersion);
    },
    list(prefix) {
      return invoke("plugin_document_storage_list", { prefix: prefix ?? null });
    },
  };
}
