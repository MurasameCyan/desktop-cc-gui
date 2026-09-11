import { ipc, type AppSettings } from "@/lib/ipc";

/** Persist one app-settings patch; callers have already applied the in-memory
 * value, so a persist failure is non-fatal. */
export async function persistSettings(
  patch: (settings: AppSettings) => Partial<AppSettings>,
) {
  try {
    const settings = await ipc.getAppSettings();
    await ipc.updateAppSettings({ ...settings, ...patch(settings) });
  } catch {
    // Persist failure is non-fatal: the in-memory value still applies.
  }
}
