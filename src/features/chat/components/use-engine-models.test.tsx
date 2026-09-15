import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineCatalog, EngineInfo } from "@/lib/ipc";
import { ipc } from "@/lib/ipc";
import { useEngineModels } from "./use-engine-models";

vi.mock("@/lib/ipc", () => ({
  ipc: {
    getCliConfig: vi.fn(async () => ({})),
    getAppSettings: vi.fn(async () => ({})),
    listEngineModels: vi.fn(async () => ({ models: [], authoritative: false })),
  },
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const ENGINE = { id: "omp", enabled: true, available: true } as EngineInfo;
// 模块级稳定引用:与应用内 zustand 提供的 engines 同形 —— 每 render 新建
// 数组会让探针 effect 反复触发(pending 中的引擎不在 catalogs 过滤条件里)。
const ENGINES = [ENGINE];
const WS_REMOTE = "//wsl$/Ubuntu/home/u/proj";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.mocked(ipc.listEngineModels).mockReset();
});

function Harness({
  models,
  pinModels,
  workspacePath,
}: {
  models: Record<string, string>;
  pinModels: (updates: Record<string, string>, persist?: boolean) => Promise<void>;
  workspacePath?: string;
}) {
  useEngineModels(ENGINES, models, pinModels, workspacePath);
  return null;
}

async function render(props: Parameters<typeof Harness>[0]) {
  await act(async () => {
    root.render(<Harness {...props} />);
    // 探针 promise 落地 + catalog 入 store 后的二次 effect 都跑完。
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useEngineModels pin effect", () => {
  it("远端(remote)catalog 只做展示:永不触发 pin,不污染全局 models / persisted 默认", async () => {
    vi.mocked(ipc.listEngineModels).mockResolvedValue({
      models: [{ id: "remote-m1", name: "Remote M1" }],
      authoritative: true,
      remote: true,
    } as unknown as EngineCatalog);
    const pinModels = vi.fn(async () => {});
    // stored 与远端 catalog 不相交 —— 修复前这里会 volatile pin,进而在
    // 切回本地工作区时被 persisted pin 覆盖用户保存的默认模型。
    await render({ models: { omp: "user-pick" }, pinModels, workspacePath: WS_REMOTE });
    expect(pinModels).not.toHaveBeenCalled();
  });

  it("本地 authoritative catalog 仍重置过期 stored pick(persist 默认值不变)", async () => {
    vi.mocked(ipc.listEngineModels).mockResolvedValue({
      models: [{ id: "m1", name: "M1" }],
      authoritative: true,
    } as unknown as EngineCatalog);
    const pinModels = vi.fn(async () => {});
    await render({ models: { omp: "stale-id" }, pinModels });
    expect(pinModels).toHaveBeenCalledWith({ omp: "m1" });
  });
});
