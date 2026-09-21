/**
 * Host global hardening (plan §5.4). Same-origin ESM plugins share the window
 * with the host, so true isolation is impossible; this module is the
 * "raise the bar + observable behavior" layer the plan explicitly scopes to:
 *
 * - `window.__TAURI_INTERNALS__.invoke` is wrapped so a direct Tauri IPC call
 *   made while plugin code is on the stack (activate, event callbacks,
 *   disposers — everything the runtime invokes via `runAsPlugin`) throws.
 * - Network needs no wrapper: CSP `connect-src 'self' ipc: …` already denies
 *   every non-self connection from the webview, host and plugin alike.
 *
 * Documented residual bypass surface (unchanged from the plan): React event
 * handlers and async continuations escape the depth counter; same-origin
 * iframes expose fresh globals; localStorage is directly reachable. Hard
 * boundaries come from marketplace review, the permission diff, the confirm
 * flow, one-click uninstall, and quarantine.
 */

let pluginDepth = 0;
let authorizedInvokeDepth: number | null = null;

/** Run `fn` marked as plugin code: direct Tauri IPC inside throws. */
export function runAsPlugin<T>(fn: () => T): T {
  pluginDepth += 1;
  try {
    return fn();
  } finally {
    pluginDepth -= 1;
  }
}

/** Authorize one synchronous IPC hop from a permission-checked host SDK path.
 * Keep pluginDepth intact: nested runAsPlugin calls must not inherit the grant.
 * The callback must only call the trusted transport; evaluate plugin arguments
 * (including spreads/getters) before entering. The invoke wrapper consumes the
 * grant before native serialization can execute plugin getters or toJSON.
 * This does not wrap/await the return value or authorize async continuations. */
export function withAuthorizedHostInvoke<T>(fn: () => T): T {
  const previous = authorizedInvokeDepth;
  authorizedInvokeDepth = pluginDepth;
  try {
    return fn();
  } finally {
    authorizedInvokeDepth = previous;
  }
}

interface TauriInternals {
  invoke?: (cmd: string, args?: unknown) => Promise<unknown>;
}
declare global {
  interface Window {
    __TAURI_INTERNALS__?: TauriInternals;
  }
}

let installed = false;
let reportedUnwrappable = false;

/** Wrap the Tauri IPC entry point with the plugin-execution guard. Idempotent;
 *  no-op outside the desktop webview (web bridge has no __TAURI_INTERNALS__).
 *
 *  The real desktop webview can expose `invoke` as a non-writable own property,
 *  and the assignment then throws. That throw used to escape into plugin
 *  bootstrap, surfacing as a failed first activation plus a delayed retry, so
 *  the wrap is best-effort: report once and keep running without the in-page
 *  guard (server-side permission checks are unaffected). A failed wrap leaves
 *  `installed` false so a later attempt can still install the guard, while the
 *  separate flag keeps the warning one-shot. */
export function installHardening(): void {
  if (installed) return;
  const internals = window.__TAURI_INTERNALS__;
  const original = internals?.invoke;
  if (!internals || !original) {
    installed = true;
    return;
  }
  const wrapped = (cmd: string, args?: unknown) => {
    if (pluginDepth > 0 && authorizedInvokeDepth !== pluginDepth) {
      return Promise.reject(
        new Error(
          `[plugins] direct Tauri invoke("${cmd}") is blocked inside plugin code; use the PluginContext APIs`,
        ),
      );
    }
    authorizedInvokeDepth = null;
    return original(cmd, args);
  };
  try {
    internals.invoke = wrapped;
    installed = true;
  } catch {
    if (reportedUnwrappable) return;
    reportedUnwrappable = true;
    console.warn(
      "[plugins] direct-IPC guard unavailable: __TAURI_INTERNALS__.invoke is not writable here",
    );
  }
}
