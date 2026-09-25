import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installHardening,
  resetHardeningForTests,
  runAsPlugin,
  withAuthorizedHostInvoke,
} from "./hardening";
import * as hardening from "./hardening";

describe("hardening", () => {
  const originalInternals = window.__TAURI_INTERNALS__;
  const nativeInvoke = vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => null);

  beforeAll(() => {
    window.__TAURI_INTERNALS__ = { invoke: nativeInvoke };
    installHardening();
  });
  beforeEach(() => nativeInvoke.mockClear());
  afterAll(() => {
    if (originalInternals) window.__TAURI_INTERNALS__ = originalInternals;
    else delete window.__TAURI_INTERNALS__;
  });

  // Production WebView2 defines `invoke` as a non-writable own property, so the
  // wrapper assignment throws. Bootstrap must survive it: the throw escaped into
  // plugin bootstrap and surfaced as a failed first activation plus a retry.
  it("installs without throwing where invoke cannot be wrapped", async () => {
    vi.resetModules();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const frozenInvoke = vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => null);
    const previous = window.__TAURI_INTERNALS__;
    window.__TAURI_INTERNALS__ = Object.freeze({ invoke: frozenInvoke });
    try {
      // Dynamic import on purpose: the module's `installed` flag is
      // per-instance, so exercising installHardening against this window state
      // requires a fresh module load.
      const fresh = await import("./hardening");
      expect(() => fresh.installHardening()).not.toThrow();
      expect(warn).toHaveBeenCalled();
      // The host path still reaches the native invoke.
      await window.__TAURI_INTERNALS__!.invoke!("host_cmd");
      expect(frozenInvoke).toHaveBeenCalledWith("host_cmd");
    } finally {
      window.__TAURI_INTERNALS__ = previous;
      warn.mockRestore();
      vi.resetModules();
    }
  });

  it("blocks direct Tauri IPC while plugin code is on the stack, allows host calls", async () => {
    const invoke = window.__TAURI_INTERNALS__!.invoke!;

    // Host context: passes through.
    await invoke("host_cmd");
    expect(nativeInvoke).toHaveBeenCalledWith("host_cmd", undefined);

    // Plugin context: rejected without reaching the real invoke.
    await expect(
      runAsPlugin(() => invoke("plugin_cmd")),
    ).rejects.toThrow(/blocked/);
    expect(nativeInvoke).toHaveBeenCalledTimes(1);
  });

  it("grants only the checked host hop, not a nested plugin call or a second invoke", async () => {
    const invoke = window.__TAURI_INTERNALS__!.invoke!;
    const requests = runAsPlugin(() => hardening.withAuthorizedHostInvoke(() => ({
      nested: runAsPlugin(() => invoke("nested_plugin")),
      allowed: invoke("checked_sdk_operation"),
      extra: invoke("unchecked_extra_operation"),
    })));
    await expect(requests.nested).rejects.toThrow(/blocked/);
    await expect(requests.allowed).resolves.toBeNull();
    await expect(requests.extra).rejects.toThrow(/blocked/);
  });

  it("runAsPlugin restores the host context even when plugin code throws", async () => {
    expect(() =>
      runAsPlugin(() => {
        throw new Error("plugin bug");
      }),
    ).toThrow("plugin bug");
    await window.__TAURI_INTERNALS__!.invoke!("after_crash");
  });

  it("authorizes only one synchronous host invoke without unmarking plugin code", async () => {
    const invoke = window.__TAURI_INTERNALS__!.invoke!;
    const requests = runAsPlugin(() => {
      const before = invoke("direct_before");
      const authorized = withAuthorizedHostInvoke(() => {
        const allowed = invoke("sdk_command");
        const extra = invoke("direct_extra");
        return { allowed, extra };
      });
      return { before, ...authorized, after: invoke("direct_after") };
    });

    await expect(requests.before).rejects.toThrow(/blocked/);
    await expect(requests.allowed).resolves.toBeNull();
    await expect(requests.extra).rejects.toThrow(/blocked/);
    await expect(requests.after).rejects.toThrow(/blocked/);
    expect(nativeInvoke.mock.calls.map(([cmd]) => cmd)).toEqual(["sdk_command"]);
  });

  it("does not lend a host authorization to a nested plugin callback", async () => {
    const invoke = window.__TAURI_INTERNALS__!.invoke!;
    const requests = runAsPlugin(() => withAuthorizedHostInvoke(() => ({
      nested: runAsPlugin(() => invoke("nested_plugin")),
      allowed: invoke("sdk_command"),
    })));

    await expect(requests.nested).rejects.toThrow(/blocked/);
    await expect(requests.allowed).resolves.toBeNull();
    expect(nativeInvoke.mock.calls.map(([cmd]) => cmd)).toEqual(["sdk_command"]);
  });

  it("consumes authorization before native argument serialization invokes getters", async () => {
    const invoke = window.__TAURI_INTERNALS__!.invoke!;
    let fromGetter: Promise<unknown> | undefined;
    let fromToJSON: Promise<unknown> | undefined;
    nativeInvoke.mockImplementationOnce(async (_cmd, args) => JSON.stringify(args));
    const result = runAsPlugin(() => withAuthorizedHostInvoke(() => invoke("sdk_command", {
      get value() {
        fromGetter = invoke("getter_command");
        return {
          toJSON() {
            fromToJSON = invoke("toJSON_command");
            return "saved";
          },
        };
      },
    })));

    await expect(result).resolves.toBe('{"value":"saved"}');
    await expect(fromGetter).rejects.toThrow(/blocked/);
    await expect(fromToJSON).rejects.toThrow(/blocked/);
    expect(nativeInvoke.mock.calls.map(([cmd]) => cmd)).toEqual(["sdk_command"]);
  });

  it("restores the guard after a host throw and does not retain grants for pending promises", async () => {
    const invoke = window.__TAURI_INTERNALS__!.invoke!;
    let resolve!: () => void;
    const pending = new Promise<void>((done) => { resolve = done; });
    const requests = runAsPlugin(() => {
      expect(() => withAuthorizedHostInvoke(() => {
        throw new Error("host failure");
      })).toThrow("host failure");
      const afterThrow = invoke("after_throw");
      expect(withAuthorizedHostInvoke(() => pending)).toBe(pending);
      return { afterThrow, whilePending: invoke("while_pending") };
    });

    await expect(requests.afterThrow).rejects.toThrow(/blocked/);
    await expect(requests.whilePending).rejects.toThrow(/blocked/);
    expect(nativeInvoke).not.toHaveBeenCalled();
    resolve();
    await pending;
    await invoke("host_afterward");
    expect(nativeInvoke.mock.calls.map(([cmd]) => cmd)).toEqual(["host_afterward"]);
  });

  it("does not throw when Tauri marks invoke non-writable", async () => {
    resetHardeningForTests();
    const calls: string[] = [];
    const invoke = async (cmd: string) => {
      calls.push(cmd);
      return null;
    };
    const internals = {};
    // Same descriptor Tauri 2.11 uses: defineProperty defaults to
    // writable:false, configurable:false. Assignment must not abort bootstrap.
    Object.defineProperty(internals, "invoke", { value: invoke });
    window.__TAURI_INTERNALS__ = internals as typeof window.__TAURI_INTERNALS__;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(() => installHardening()).not.toThrow();
      await window.__TAURI_INTERNALS__!.invoke!("still_works");
      expect(calls).toEqual(["still_works"]);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
