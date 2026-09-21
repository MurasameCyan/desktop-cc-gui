import { useTranslation } from "react-i18next";
import Eye from "lucide-react/dist/esm/icons/eye";
import MousePointerClick from "lucide-react/dist/esm/icons/mouse-pointer-click";
import OctagonAlert from "lucide-react/dist/esm/icons/octagon-alert";
import { ModalShell } from "@/components/dialogs";
import { Button } from "@/components/base/buttons/button";
import { useChatStore } from "@/features/chat/store";
import { useComputerUseStore } from "./store";
import { usePermissionStatus } from "./use-permission-status";
import { ComputerUsePermissionCard } from "./ComputerUsePermissionCard";

/**
 * Enable flow for computer use: what it does, the risks, the two macOS
 * grants (with the drag shortcut), then the armed toggle. Opened from the
 * composer toggle; 开启 stays disabled until every OS grant is in place.
 */
export function ComputerUseDialog() {
  const { t } = useTranslation();
  const open = useComputerUseStore((s) => s.dialogOpen);
  const setDialogOpen = useComputerUseStore((s) => s.setDialogOpen);
  const setComputerUse = useChatStore((s) => s.setComputerUse);
  const status = usePermissionStatus(open);
  if (!open) return null;

  const ready = status
    ? !status.osPermissionsRequired || (status.accessibility && status.screenRecording)
    : false;

  const risks = [
    { icon: Eye, text: t("computerUse.riskScreen") },
    { icon: MousePointerClick, text: t("computerUse.riskControl") },
    { icon: OctagonAlert, text: t("computerUse.riskEsc") },
  ];

  return (
    <ModalShell
      onClose={() => setDialogOpen(false)}
      className="w-[26rem]"
      label={t("computerUse.dialogTitle")}
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-title-3-medium text-text-primary">{t("computerUse.dialogTitle")}</h2>
          <p className="text-body-2-regular text-text-secondary">{t("computerUse.dialogDesc")}</p>
        </div>

        <div className="flex flex-col gap-2 rounded-xl bg-background-secondary-default px-3 py-2.5">
          <p className="text-body-2-medium text-text-secondary">{t("computerUse.riskTitle")}</p>
          {risks.map(({ icon: Icon, text }) => (
            <div key={text} className="flex items-start gap-2">
              <Icon className="mt-0.5 size-3.5 shrink-0 text-foreground-icon-secondary" aria-hidden />
              <p className="text-body-2-regular text-text-secondary">{text}</p>
            </div>
          ))}
        </div>

        {status ? (
          <ComputerUsePermissionCard status={status} />
        ) : (
          <p className="px-1 text-body-2-regular text-text-secondary">{t("computerUse.checking")}</p>
        )}

        <p className="px-1 text-body-2-regular text-text-tertiary">{t("computerUse.engineNote")}</p>

        <div className="flex items-center justify-end gap-2 pt-1">
          {!ready && status && (
            <p className="mr-auto text-body-2-regular text-text-tertiary">
              {t("computerUse.needPermissions")}
            </p>
          )}
          <Button variant="secondary" onClick={() => setDialogOpen(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={!ready}
            onClick={() => {
              setComputerUse(true);
              setDialogOpen(false);
            }}
          >
            {t("computerUse.enable")}
          </Button>
        </div>
      </div>
    </ModalShell>
  );
}
