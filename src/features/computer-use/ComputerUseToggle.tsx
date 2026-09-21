import { useTranslation } from "react-i18next";
import MonitorCog from "lucide-react/dist/esm/icons/monitor-cog";
import { cx } from "@/utils/cx";
import { Tooltip, TooltipContent } from "@/components/base/tooltip/tooltip";
import { isWeb } from "@/lib/transport";
import { useChatStore } from "@/features/chat/store";
import { useComputerUseStore } from "./store";

/**
 * Composer toolbar toggle for computer use. Hidden for engines that cannot
 * mount the driver and in the web build (no local screen to drive). Turning
 * it on always goes through the enable dialog: permission state decides
 * whether 开启 is armed.
 */
export function ComputerUseToggle() {
  const { t } = useTranslation();
  const engine = useChatStore((s) => s.active?.engine);
  const supported = useChatStore(
    (s) => s.engines.find((e) => e.id === engine)?.supportsComputerUse ?? false,
  );
  const computerUse = useChatStore((s) => s.computerUse);
  const setComputerUse = useChatStore((s) => s.setComputerUse);
  const setDialogOpen = useComputerUseStore((s) => s.setDialogOpen);

  if (isWeb || !supported) return null;

  return (
    <Tooltip>
      <button
        type="button"
        aria-pressed={computerUse}
        onClick={() => (computerUse ? setComputerUse(false) : setDialogOpen(true))}
        className={cx(
          "flex cursor-pointer items-center gap-1.5 rounded-full px-2.5 py-1.5 text-body-2-medium transition-colors",
          computerUse
            ? "bg-background-secondary-default text-text-primary"
            : "text-text-tertiary hover:bg-background-secondary-hover hover:text-text-secondary",
        )}
      >
        <MonitorCog className="size-4" aria-hidden />
        {t("computerUse.title")}
      </button>
      <TooltipContent>{t("computerUse.toggleTooltip")}</TooltipContent>
    </Tooltip>
  );
}
