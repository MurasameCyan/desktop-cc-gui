import Settings from "lucide-react/dist/esm/icons/settings";
import Globe from "lucide-react/dist/esm/icons/globe";
import FolderSymlink from "lucide-react/dist/esm/icons/folder-symlink";
import Info from "lucide-react/dist/esm/icons/info";
import Smartphone from "lucide-react/dist/esm/icons/smartphone";
import ChartColumn from "lucide-react/dist/esm/icons/chart-column";
import i18n from "@/lib/i18n";
import type { SettingsNavItem } from "@/components/application/settings/settings-modal";
import { EngineIcon } from "@/components/foundations/icons/engine-icon";
import { CLI_DISPLAY_NAMES } from "@/components/foundations/icons/engine-brands";
import { settingsRegistry } from "@ccgui/plugin-sdk";
import { cx } from "@/utils/cx";
import { GeneralSection } from "./GeneralSection";
import { ProxySection } from "./ProxySection";
import { WorkspacesSection } from "./WorkspacesSection";
import { CliConfigSection } from "./CliConfigSection";
import { AboutSection } from "./AboutSection";
import { WebAccessSection } from "./WebAccessSection";
import { UsageSection } from "./UsageSection";
import { ENGINE_IDS, type EngineId } from "./providers";

/**
 * Builtin settings sections, registered through the same extension-point
 * registry plugins use (plan §4.2 #1 — the settings page is the dogfood
 * surface). Module-scope side effect, imported once by SettingsPage; the
 * registry's upsert semantics make HMR re-runs harmless.
 */

/** Nav-rail mark for one CLI engine: the rail passes size classes but the
 *  dsh mark is an <img> with an intrinsic px size, so pin it at the rail's
 *  md size. The rail colors every icon foreground-icon-secondary (gray);
 *  the monochrome brand glyphs (kimi/grok/codex/pi follow currentColor)
 *  read as disabled at that shade, so bump them to icon-primary. Image and
 *  gradient marks (claude/dsh/omp) carry their own colors and ignore the
 *  text color either way. */
const engineNavIcon = (engine: EngineId): SettingsNavItem["icon"] => {
  const EngineNavIcon = ({ className }: { className?: string }) => (
    <EngineIcon engine={engine} size={20} className={cx(className, "text-foreground-icon-primary")} />
  );
  return EngineNavIcon;
};

settingsRegistry.register({
  id: "general",
  key: "general",
  label: () => i18n.t("settings.general"),
  icon: Settings,
  group: "settings",
  order: 0,
  component: GeneralSection,
});
settingsRegistry.register({
  id: "proxy",
  key: "proxy",
  label: () => i18n.t("settings.proxy"),
  icon: Globe,
  group: "settings",
  order: 1,
  component: ProxySection,
});
settingsRegistry.register({
  id: "workspaces",
  key: "workspaces",
  label: () => i18n.t("settings.workspaces"),
  icon: FolderSymlink,
  group: "settings",
  order: 2,
  component: WorkspacesSection,
});
settingsRegistry.register({
  id: "webAccess",
  key: "webAccess",
  label: () => i18n.t("settings.webAccess"),
  icon: Smartphone,
  group: "settings",
  order: 3,
  component: WebAccessSection,
});
settingsRegistry.register({
  id: "usage",
  key: "usage",
  label: () => i18n.t("usage.title"),
  icon: ChartColumn,
  group: "settings",
  order: 4,
  component: UsageSection,
});
settingsRegistry.register({
  id: "about",
  key: "about",
  label: () => i18n.t("settings.about"),
  icon: Info,
  group: "settings",
  order: 4,
  component: AboutSection,
});
ENGINE_IDS.forEach((engine, index) => {
  settingsRegistry.register({
    id: `cli:${engine}`,
    key: `cli:${engine}`,
    label: () => CLI_DISPLAY_NAMES[engine],
    icon: engineNavIcon(engine),
    group: "cli",
    order: index,
    component: () => <CliConfigSection engine={engine} />,
  });
});
