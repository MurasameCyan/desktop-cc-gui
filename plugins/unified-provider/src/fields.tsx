import { Input, Select } from "@ccgui/plugin-ui";
import type { TokenPolicy } from "@ccgui/plugin-sdk";
import { policyKeys, type PolicyOverrides, type RegistryView } from "./registry";
import { resolvePolicy } from "./projection";

/** 三个 token 策略字段的中文名（键名本身是契约，不翻译，只用于展示）。 */
const POLICY_LABELS: Record<(typeof policyKeys)[number], string> = {
  contextWindowTokens: "上下文窗口 token",
  autoCompactionThresholdTokens: "自动压缩阈值 token",
  maxOutputTokens: "最大输出 token",
};

export type UpdateDraft = (change: (draft: RegistryView) => void) => void;
export function PolicyEditor({ value, onChange, official = {}, shared = {}, scope }: { value: PolicyOverrides; onChange: (value: PolicyOverrides) => void; official?: TokenPolicy; shared?: PolicyOverrides; scope: string }) {
  let effective: TokenPolicy = {};
  let error = "";
  try { effective = resolvePolicy(official, shared, value).tokenPolicy; } catch (e) { error = e instanceof Error ? e.message : "策略无效"; }
  return <fieldset className="up-policy"><legend>{scope}</legend>
    {policyKeys.map((key) => {
      const override = value[key];
      const source = override && override.kind !== "inherit" ? override.kind === "clear" ? "已显式清空" : scope : shared[key] && shared[key]?.kind !== "inherit" ? "共享策略" : official[key] === undefined ? "未知 · 不注入" : "官方模板";
      return <div className="up-policy-row" key={key}><label>{POLICY_LABELS[key]}<Select value={override?.kind ?? "inherit"} onChange={(event) => {
        const next = { ...value };
        if (event.target.value === "inherit") delete next[key];
        else next[key] = event.target.value === "clear" ? { kind: "clear" } : { kind: "value", value: effective[key] ?? 1 };
        onChange(next);
      }}><option value="inherit">继承</option><option value="clear">清空 · 不注入</option><option value="value">覆盖</option></Select></label>
      {override?.kind === "value" && <label>token 数<Input type="number" min={1} step={1} value={override.value} onChange={(event) => onChange({ ...value, [key]: { kind: "value", value: Number(event.target.value) } })} /></label>}
      <span className="up-muted">{source} · {effective[key]?.toLocaleString() ?? "不注入"}</span></div>;
    })}{error && <p role="alert" className="up-error">{error}</p>}
  </fieldset>;
}
