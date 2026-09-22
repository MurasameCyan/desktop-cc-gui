import { Input, Select } from "@ccgui/plugin-ui";
import type { TokenPolicy } from "@ccgui/plugin-sdk";
import { policyKeys, type PolicyOverrides, type RegistryView } from "./registry";
import { resolvePolicy } from "./projection";

export type UpdateDraft = (change: (draft: RegistryView) => void) => void;
export function PolicyEditor({ value, onChange, official = {}, shared = {}, scope }: { value: PolicyOverrides; onChange: (value: PolicyOverrides) => void; official?: TokenPolicy; shared?: PolicyOverrides; scope: string }) {
  let effective: TokenPolicy = {};
  let error = "";
  try { effective = resolvePolicy(official, shared, value).tokenPolicy; } catch (e) { error = e instanceof Error ? e.message : "Invalid policy"; }
  return <fieldset className="up-policy"><legend>{scope}</legend>
    {policyKeys.map((key) => {
      const override = value[key];
      const source = override && override.kind !== "inherit" ? override.kind === "clear" ? "Explicitly cleared" : scope : shared[key] && shared[key]?.kind !== "inherit" ? "Shared policy" : official[key] === undefined ? "Unknown / not injected" : "Official template";
      return <div className="up-policy-row" key={key}><label>{key}<Select value={override?.kind ?? "inherit"} onChange={(event) => {
        const next = { ...value };
        if (event.target.value === "inherit") delete next[key];
        else next[key] = event.target.value === "clear" ? { kind: "clear" } : { kind: "value", value: effective[key] ?? 1 };
        onChange(next);
      }}><option value="inherit">Inherit</option><option value="clear">Clear · do not inject</option><option value="value">Override</option></Select></label>
      {override?.kind === "value" && <label>Token count<Input type="number" min={1} step={1} value={override.value} onChange={(event) => onChange({ ...value, [key]: { kind: "value", value: Number(event.target.value) } })} /></label>}
      <span className="up-muted">{source} · {effective[key]?.toLocaleString() ?? "not injected"}</span></div>;
    })}{error && <p role="alert" className="up-error">{error}</p>}
  </fieldset>;
}
