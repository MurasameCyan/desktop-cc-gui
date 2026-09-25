/** 任务工作台内部的 id 生成：浏览器/测试环境都有 crypto.randomUUID。 */
export function missionId(prefix: string): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replaceAll("-", "").slice(0, 12)
      : Math.random().toString(16).slice(2, 14);
  return `${prefix}-${random}`;
}
