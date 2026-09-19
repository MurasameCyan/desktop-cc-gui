/**
 * SDK 兼容模式：允许「声明更早 0.x 契约」的插件在更新的 0.x 宿主上加载。
 *
 * 契约的 0.x 线里次版本就是破坏性位，`^0.3` 按 semver 只覆盖 0.3.x；宿主一旦
 * 升到 0.4（本仓的 CCB 扩展），为官方构建（SDK 0.3.x）编写的市场插件会被
 * 版本握手整个拒载——即使它们用到的接口一个都没变。开启本开关后，声明区间
 * 的主版本为 0 且次版本低于宿主的那类 `^` / `~` 声明按可兼容处理：插件正常
 * 加载，而在插件列表里标注「兼容模式」，鼠标悬停给出原始声明与宿主版本。
 *
 * 默认关闭（保持 semver 的严格判定）；精确版本号（`0.3.11`）不参与放宽——
 * 那是有意的钉死，放宽等于改写作者的声明。
 */
import { readStoredBool, writeStored } from "@/lib/storage";

const SDK_COMPAT_KEY = "ccgui-next.pluginCompatSdk";

export function compatSdkEnabled(): boolean {
  return readStoredBool(SDK_COMPAT_KEY, false);
}

export function setCompatSdkEnabled(enabled: boolean): void {
  writeStored(SDK_COMPAT_KEY, enabled ? "1" : "0");
}

/**
 * `^0.N` / `~0.N`（含补丁段）声明，N 低于宿主次版本，且宿主仍在 0.x 线。
 * 只认带 `^`/`~` 的区间声明；`*`、精确版本、`>=`、非 0 主版本一律返回 false
 * （那些要么已被严格判定放行，要么不该被放宽）。
 */
export function isLegacySdkRange(range: string | undefined, version: string): boolean {
  const host = version.split(".").map(Number);
  const hostMinor = host[1] ?? 0;
  if (host[0] !== 0) return false;
  const match = (range ?? "").trim().match(/^(\^|~)\s*0\.(\d+)(?:\.\d+)?$/);
  if (!match) return false;
  return Number(match[2]) < hostMinor;
}
