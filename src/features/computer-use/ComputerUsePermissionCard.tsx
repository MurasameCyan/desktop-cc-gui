import { useTranslation } from "react-i18next";
import Keyboard from "lucide-react/dist/esm/icons/keyboard";
import Monitor from "lucide-react/dist/esm/icons/monitor";
import Check from "lucide-react/dist/esm/icons/check";
import { cx } from "@/utils/cx";
import { ipc, type ComputerUsePermissionStatus } from "@/lib/ipc";
import { startAppDrag } from "./start-app-drag";

/**
 * The two macOS grants computer use needs, plus the drag accessory: drop the
 * app onto a System Settings permission list and TCC authorizes it on the
 * spot — the same outcome as clicking 去授权 and toggling the switch by
 * hand. Rendered inside the enable dialog and the settings section; hidden
 * entirely on platforms with no OS grant flow.
 */

function PermissionRow({
  icon: Icon,
  name,
  desc,
  granted,
  onAuthorize,
}: {
  icon: typeof Keyboard;
  name: string;
  desc: string;
  granted: boolean;
  onAuthorize: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-3 py-2.5">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-background-tertiary-default">
        <Icon className="size-4 text-foreground-icon-secondary" aria-hidden />
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <p className="text-body-regular text-text-primary">{name}</p>
        <p className="truncate text-body-2-regular text-text-secondary">{desc}</p>
      </div>
      {granted ? (
        <span className="flex shrink-0 items-center gap-1 rounded-full bg-status-green-background px-2 py-0.5 text-body-2-medium text-status-green-text">
          <Check className="size-3" aria-hidden />
          {t("computerUse.granted")}
        </span>
      ) : (
        <button
          type="button"
          onClick={onAuthorize}
          className="shrink-0 cursor-pointer rounded-full border border-border-button-default px-2.5 py-1 text-body-2-medium text-text-primary transition-colors hover:bg-background-secondary-hover"
        >
          {t("computerUse.authorize")}
        </button>
      )}
    </div>
  );
}

export function ComputerUsePermissionCard({
  status,
}: {
  status: ComputerUsePermissionStatus | null;
}) {
  const { t } = useTranslation();
  if (status && !status.osPermissionsRequired) {
    return (
      <p className="rounded-xl bg-background-secondary-default px-3 py-2.5 text-body-2-regular text-text-secondary">
        {t("computerUse.noPermissionNeeded")}
      </p>
    );
  }
  return (
    <div className="flex flex-col rounded-xl bg-background-secondary-default px-3 py-1.5">
      <PermissionRow
        icon={Keyboard}
        name={t("computerUse.permAccessibility")}
        desc={t("computerUse.permAccessibilityDesc")}
        granted={status?.accessibility ?? false}
        onAuthorize={() => {
          void ipc.computerUseOpenPermissionSettings("accessibility").catch(() => {});
        }}
      />
      <div aria-hidden className="h-px bg-separator-border" />
      <PermissionRow
        icon={Monitor}
        name={t("computerUse.permScreenRecording")}
        desc={t("computerUse.permScreenRecordingDesc")}
        granted={status?.screenRecording ?? false}
        onAuthorize={() => {
          void ipc.computerUseOpenPermissionSettings("screenRecording").catch(() => {});
        }}
      />
      <div aria-hidden className="h-px bg-separator-border" />
      <div className="flex items-center gap-3 py-2.5">
        <button
          type="button"
          // mousedown, not click: an OS drag starts with the press and the
          // plugin takes the gesture over from there.
          onMouseDown={() => void startAppDrag()}
          className={cx(
            "flex shrink-0 cursor-grab items-center gap-2 rounded-xl border border-dashed border-border-button-default px-2.5 py-1.5",
            "transition-colors hover:bg-background-secondary-hover active:cursor-grabbing",
          )}
        >
          <img src="/app-icon.png" alt="" className="size-6 rounded-md" draggable={false} />
          <span className="text-body-2-medium text-text-primary">{t("computerUse.dragCard")}</span>
        </button>
        <p className="min-w-0 flex-1 text-body-2-regular text-text-secondary">
          {t("computerUse.dragHint")}
        </p>
      </div>
    </div>
  );
}
