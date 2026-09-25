import type { Disposer } from "@ccgui/plugin-sdk";
import { listen } from "@/lib/transport";
import { runAsPlugin, withAuthorizedHostInvoke } from "./hardening";

/** Own the async listener installation as well as its eventual unlisten. */
export function subscribeCapabilityEvent<T>(topic: string, callback: (payload: T) => void): Disposer {
  let disposed = false;
  let unlisten: Disposer | undefined;
  const subscribed = withAuthorizedHostInvoke(() => listen<T>(topic, ({ payload }) => {
    if (disposed) return;
    try {
      const result = runAsPlugin(() => callback(payload));
      void Promise.resolve(result).catch(() => {
        console.error(`[plugins] ${topic} callback failed`);
      });
    } catch {
      console.error(`[plugins] ${topic} callback failed`);
    }
  }));
  void subscribed.then((stop) => {
    if (disposed) stop();
    else unlisten = stop;
  }).catch(() => {
    if (!disposed) console.error(`[plugins] ${topic} subscription failed`);
  });
  return () => {
    disposed = true;
    unlisten?.();
    unlisten = undefined;
  };
}
