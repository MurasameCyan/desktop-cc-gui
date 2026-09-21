import { startDrag } from "@crabnebula/tauri-plugin-drag";
import { ipc } from "@/lib/ipc";
import { isWeb } from "@/lib/transport";

let inFlight = false;

/**
 * Start an OS drag carrying the app itself: dropping it onto a System
 * Settings permission list (Accessibility / Screen Recording) authorizes the
 * app without typing anything. Failures are swallowed — the "去授权" button
 * path covers every case this one misses (unsupported platform, dev quirks).
 */
export async function startAppDrag() {
  if (isWeb || inFlight) return;
  inFlight = true;
  try {
    const source = await ipc.computerUseDragSource();
    await startDrag({ item: [source.path], icon: source.icon });
  } catch {
    // 平台不支持或拖拽被打断：授权按钮路径仍然可用。
  } finally {
    inFlight = false;
  }
}
