import { listenComputerUseEscape } from "@/lib/events";
import { useTauriEvent } from "@/hooks/use-tauri-event";
import { useChatStore } from "@/features/chat/store";
import { sessionKey } from "@/features/chat/store/persistence";
import { useComputerUseStore } from "./store";

/**
 * Esc-to-stop while a computer-use run is armed. The backend only emits the
 * event while armed, so this fires at most once per run; we interrupt the
 * active session only when it IS the armed one — killing a different tab's
 * run because the user pressed Esc elsewhere would be worse than no hotkey.
 */
export function useComputerUseEscapeHandler() {
  useTauriEvent(() =>
    listenComputerUseEscape(() => {
      const { armedKey, disarm } = useComputerUseStore.getState();
      const chat = useChatStore.getState();
      const active = chat.active;
      if (
        armedKey &&
        active &&
        sessionKey(active.engine, active.sessionId, active.workspacePath) === armedKey
      ) {
        void chat.interrupt();
      }
      disarm();
    }),
  );
}
