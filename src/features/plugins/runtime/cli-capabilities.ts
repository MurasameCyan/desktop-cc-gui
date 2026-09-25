import type { CliCapabilities, CliChange, Disposer, RuntimeMaterialRequest } from "@ccgui/plugin-sdk";
import { isWeb } from "@/lib/transport";
import type { PluginContextBackend } from "./context";
import { withAuthorizedHostInvoke } from "./hardening";
import { subscribeCapabilityEvent } from "./capability-events";

/** Typed SDK egress: each operation has its own permission and client boundary.
 * Native code repeats these checks and owns confirmation and source isolation. */
export function createCliCapabilities(
  pluginId: string,
  backend: PluginContextBackend,
  requirePermission: (permission: string) => void,
  track: (disposer: Disposer) => Disposer,
): CliCapabilities {
  async function invoke<T>(permission: string, command: string, args: Record<string, unknown>, desktop = false): Promise<T> {
    requirePermission(permission);
    if (desktop && isWeb) throw new Error(`${permission}: desktop operation only`);
    const ownedArgs = { ...args, pluginId };
    return withAuthorizedHostInvoke(() => backend.bridgeInvoke(command, ownedArgs)) as Promise<T>;
  }

  return {
    publishSource(request) {
      return invoke("cli.contributions.write", "plugin_cli_publish_source", { request }, true);
    },
    getSource(sourceId) {
      return invoke("cli.read", "plugin_cli_get_source", { sourceId });
    },
    unpublishSource(sourceId, expectedPublicationRevision) {
      return invoke("cli.contributions.write", "plugin_cli_unpublish_source", { sourceId, expectedRevision: expectedPublicationRevision }, true);
    },
    listSources() {
      return invoke("cli.read", "plugin_cli_list_sources", {});
    },
    onChanged(callback) {
      requirePermission("cli.read");
      return track(subscribeCapabilityEvent<CliChange>("cli://changed", callback));
    },
    requestTargetGrant(request) {
      return invoke("network.targets.request", "plugin_cli_request_target_grant", { request }, true);
    },
    listTargetGrants() {
      return invoke("network.targets.request", "plugin_cli_list_target_grants", {}, true);
    },
    revokeTargetGrant(grantId) {
      return invoke("network.targets.request", "plugin_cli_revoke_target_grant", { grantId }, true);
    },
    registerRuntimeMaterial(request) {
      return invoke("cli.runtime.sensitive", "plugin_cli_register_runtime_material", { request }, true);
    },
    onMaterialRequested(callback) {
      requirePermission("cli.runtime.sensitive");
      if (isWeb) throw new Error("cli.runtime.sensitive: desktop operation only");
      return track(subscribeCapabilityEvent<RuntimeMaterialRequest>("cli://material-requested", (request) => {
        if (request.use.sourceId.startsWith(`plugin:${pluginId}:`)) callback(request);
      }));
    },
    getCredentialUses(sourceId) {
      return invoke("cli.runtime.sensitive", "plugin_cli_get_credential_uses", { sourceId }, true);
    },
    listModels(request) {
      return invoke("cli.read", "plugin_cli_list_models", { request }, true);
    },
    listConfigTargets() {
      return invoke("cli.config.read", "plugin_cli_list_config_targets", {}, true);
    },
    previewConfigImport(targetId) {
      return invoke("cli.config.read", "plugin_cli_preview_config_import", { targetId }, true);
    },
    confirmConfigImport(previewId, candidateIds) {
      return invoke("cli.config.read", "plugin_cli_confirm_config_import", { previewId, candidateIds }, true);
    },
    previewConfigPatch(targetId, selection) {
      return invoke("cli.config.apply", "plugin_cli_preview_config_patch", { targetId, selection }, true);
    },
    applyConfigPatch(previewId) {
      return invoke("cli.config.apply", "plugin_cli_apply_config_patch", { previewId }, true);
    },
    restoreConfigPatch(receiptId) {
      return invoke("cli.config.apply", "plugin_cli_restore_config_patch", { receiptId }, true);
    },
  };
}
