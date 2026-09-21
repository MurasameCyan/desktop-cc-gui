import { useEffect } from "react";
import { useComputerUseStore } from "./store";

/**
 * Live permission status while a surface shows it (enable dialog, settings
 * section). Polls every second — TCC grants land when the user flips them in
 * System Settings, and the badge must notice without a relaunch.
 */
export function usePermissionStatus(active: boolean) {
  const status = useComputerUseStore((s) => s.status);
  const refreshStatus = useComputerUseStore((s) => s.refreshStatus);
  useEffect(() => {
    if (!active) return;
    void refreshStatus();
    const timer = setInterval(() => void refreshStatus(), 1000);
    return () => clearInterval(timer);
  }, [active, refreshStatus]);
  return status;
}
