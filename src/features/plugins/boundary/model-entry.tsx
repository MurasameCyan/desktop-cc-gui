import { Component, type ReactNode } from "react";
import { compareByOrder, modelEntryRegistry, pluginIdFromRegistryKey, useRegistry, type ModelEntryProps } from "@ccgui/plugin-sdk";
import { notePluginRenderOk, reportPluginCrash } from "../runtime/loader";

class ModelEntryErrorBoundary extends Component<{ pluginId: string; fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override componentDidCatch(error: unknown) { reportPluginCrash(this.props.pluginId, error); }
  override componentDidMount() { notePluginRenderOk(this.props.pluginId); }
  override render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

/** Replacement, never additive. SDK props are plain DTOs and controlled
 * callbacks; plugins receive neither host stores nor internal tab objects. */
export function ModelEntry({ fallback, ...props }: ModelEntryProps & { fallback: ReactNode }) {
  const definitions = useRegistry(modelEntryRegistry);
  const entry = definitions.filter((item) => item.engineIds.includes(props.context.target.engineId)).sort(compareByOrder)[0];
  if (!entry) return fallback;
  const Entry = entry.component;
  return <ModelEntryErrorBoundary key={entry.id} pluginId={pluginIdFromRegistryKey(entry.id)} fallback={fallback}>
    <Entry {...props} />
  </ModelEntryErrorBoundary>;
}
