import { create } from "zustand";
import { ipc, type ComputerUsePermissionStatus } from "@/lib/ipc";
import { useChatStore } from "@/features/chat/store";

/**
 * Computer use feature state: OS permission status (polled by the surfaces
 * that show it) and Esc-to-stop arming for the one active run. The arming
 * mirrors the backend's global-Esc registration 1:1 — at most one run is
 * armed at a time, so a second send with computer use on replaces the first
 * (its Esc then interrupts the newer run, matching what the user is
 * watching).
 */

interface ComputerUseState {
  dialogOpen: boolean;
  status: ComputerUsePermissionStatus | null;
  /** Chat-store session key whose run Esc interrupts; null = disarmed. */
  armedKey: string | null;
  setDialogOpen: (open: boolean) => void;
  refreshStatus: () => Promise<void>;
  arm: (key: string) => void;
  disarm: () => void;
}

export const useComputerUseStore = create<ComputerUseState>((set, get) => ({
  dialogOpen: false,
  status: null,
  armedKey: null,
  setDialogOpen: (dialogOpen) => set({ dialogOpen }),
  refreshStatus: async () => {
    try {
      set({ status: await ipc.computerUsePermissionStatus() });
    } catch {
      // 查询失败保留旧值：权限卡片按上一次已知状态渲染，下轮轮询再试。
    }
  },
  arm: (key) => {
    // A run can settle before sendMessage resolves; never arm a dead one.
    if (!useChatStore.getState().streamingByKey[key]) return;
    watchSettle();
    set({ armedKey: key });
    void ipc.computerUseSetActive(true).catch(() => {});
  },
  disarm: () => {
    if (!get().armedKey) return;
    set({ armedKey: null });
    void ipc.computerUseSetActive(false).catch(() => {});
  },
}));

// Disarm as soon as the armed session stops streaming (done/error/interrupt
// all clear the flag), so Esc is never swallowed outside a run. Subscribed
// lazily on the first arm: a top-level subscribe would run while the chat
// store module is still initializing (circular import).
let watching = false;
function watchSettle() {
  if (watching) return;
  watching = true;
  useChatStore.subscribe((state) => {
    const { armedKey, disarm } = useComputerUseStore.getState();
    if (armedKey && !state.streamingByKey[armedKey]) disarm();
  });
}
