/** Source only: a distributable manifest is generated after Main assigns the final SDK patch. */
export function manifest(sdkVersion) {
  if (!/^0\.3\.\d+$/.test(sdkVersion ?? "")) throw new Error("Set CCGUI_PLUGIN_SDK_VERSION to the exact approved SDK 0.3 patch before building");
  return {
    id: "unified-provider",
    name: "统一供应商",
    version: "0.1.1",
    sdkVersion,
    description: "统一私有供应商配置，每个会话独立选择模型、Key 与推理强度",
    tier: "js",
    permissions: [
      "plugin.storage", "ui:settings-section", "ui:command", "ui:model-entry", "host:session",
      "cli.read", "cli.contributions.write", "cli.runtime.sensitive", "network.targets.request",
      "cli.config.read", "cli.config.apply",
    ],
  };
}
