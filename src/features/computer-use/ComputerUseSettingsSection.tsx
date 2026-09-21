import { useTranslation } from "react-i18next";
import {
  SettingsCard,
  SettingsRow,
  SettingsSectionLabel,
} from "@/components/application/settings/settings-rows";
import { isWeb } from "@/lib/transport";
import { usePermissionStatus } from "./use-permission-status";
import { ComputerUsePermissionCard } from "./ComputerUsePermissionCard";

/**
 * Settings → 操作电脑: live OS-grant state plus how enabling works. There is
 * deliberately no master switch here — the per-session composer toggle is
 * the switch, and TCC is the authority on grants.
 */
export function ComputerUseSettingsSection() {
  const { t } = useTranslation();
  const status = usePermissionStatus(true);
  if (isWeb) return null;

  return (
    <div className="flex w-full flex-col gap-2">
      <SettingsSectionLabel>{t("settings.computerUse")}</SettingsSectionLabel>
      {status && <ComputerUsePermissionCard status={status} />}
      <SettingsCard>
        <SettingsRow label="Esc" description={t("computerUse.riskEsc")} />
      </SettingsCard>
      <p className="px-3 text-body-2-regular text-text-tertiary">
        {t("computerUse.settingsHint")} {t("computerUse.engineNote")}
      </p>
    </div>
  );
}
