import { Component, createElement, type ComponentType, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ModelEntryProps, PluginContext } from "@ccgui/plugin-sdk";
import { ProviderController } from "./controller";
import { Settings } from "./settings";
import { ModelEntry } from "./model-entry";
import { engines } from "./registry";
import "@ccgui/plugin-ui/styles.css";
import "./styles.css";

class PluginRootBoundary extends Component<{ onFailure: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { this.props.onFailure(); }
  render() { return this.state.failed ? null : this.props.children; }
}

/** The host boundary uses ctx.react; bundled plugin-ui and the plugin render in their own React root. */
function bridge<P extends object>(ctx: PluginContext, View: ComponentType<P>): ComponentType<P> {
  return function PluginBoundary(props: P) {
    const container = ctx.react.useRef<HTMLDivElement>(null);
    const root = ctx.react.useRef<Root | null>(null);
    const [failed, setFailed] = ctx.react.useState(false);
    ctx.react.useEffect(() => {
      if (!container.current) return;
      const mount = document.createElement("div");
      container.current.appendChild(mount);
      const mounted = createRoot(mount);
      root.current = mounted;
      return () => { root.current = null; mount.remove(); queueMicrotask(() => mounted.unmount()); };
    }, []);
    ctx.react.useEffect(() => { root.current?.render(createElement(PluginRootBoundary, { onFailure: () => setFailed(true), children: createElement(View, props) })); });
    if (failed) throw new Error("统一供应商界面加载失败，恢复宿主模型入口");
    return ctx.react.createElement("div", { ref: container, className: "unified-provider-root" });
  };
}

export default function activate(ctx: PluginContext): () => void {
  const PickerEntry = bridge<ModelEntryProps>(ctx, ModelEntry);
  const disposePicker = ctx.ui.registerModelEntry({ key: "unified-provider-picker", component: PickerEntry, engineIds: [...engines], order: 100 });
  if (ctx.host.isWeb) return disposePicker;
  const controller = new ProviderController(ctx);
  const SettingsEntry = bridge(ctx, () => createElement(Settings, { controller }));
  const disposers = [
    disposePicker,
    ctx.ui.registerSettingsSection({ key: "providers", label: () => "统一供应商", component: SettingsEntry }),
    ctx.ui.registerCommand({ key: "manage-providers", title: () => "管理统一供应商", keywords: () => ["供应商", "模型", "密钥", "原生", "导入", "provider", "model", "key", "native", "import"], run: () => ctx.ui.openSettings("providers") }),
  ];
  void controller.start();
  return () => { for (const dispose of disposers.reverse()) dispose(); controller.dispose(); };
}
