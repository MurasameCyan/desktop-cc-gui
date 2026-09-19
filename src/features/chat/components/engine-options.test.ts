import { describe, expect, it } from "vitest";
import { filterEngineOptions } from "./engine-options";
import type { EngineInfo } from "@/lib/ipc";

function engine(id: string, over: Partial<EngineInfo> = {}): EngineInfo {
  return { id, enabled: true, available: true, ...over } as EngineInfo;
}

const t = (key: string) => key;

describe("filterEngineOptions", () => {
  it("drops disabled engines entirely", () => {
    const out = filterEngineOptions(
      [engine("omp"), engine("claude", { enabled: false })],
      null,
      t,
    );
    expect(out.map((o) => o.id)).toEqual(["omp"]);
  });

  it("drops engines the local binary probe marks uninstalled", () => {
    const out = filterEngineOptions(
      [engine("omp", { available: false }), engine("claude")],
      null,
      t,
    );
    expect(out.map((o) => o.id)).toEqual(["claude"]);
  });

  it("WSL 工作区:只列发行版内探到的引擎,可用态按探针而非本机", () => {
    const out = filterEngineOptions(
      // 本机都没装(available=false),但发行版里探到 omp
      [engine("omp", { available: false }), engine("claude", { available: false })],
      ["omp"],
      t,
    );
    expect(out.map((o) => o.id)).toEqual(["omp"]);
    expect(out[0]?.available).toBe(true);
    expect(out[0]?.disabled).toBe(false);
  });
});
