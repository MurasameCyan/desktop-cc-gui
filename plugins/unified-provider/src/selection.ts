import type { ExecutionChoice, ExecutionSelectionInput, ModelSelection } from "@ccgui/plugin-sdk";

export function selectionIdentity(selection: ModelSelection): string {
  return selection.source === "native"
    ? JSON.stringify(["native", selection.engineId, selection.channelId ?? null, selection.modelId])
    : JSON.stringify(["contribution", selection.engineId, selection.sourceId, selection.profileKey, selection.modelKey]);
}
export function validateSelectionDraft(choice: ExecutionChoice | undefined, draft: ExecutionSelectionInput): ExecutionSelectionInput {
  if (!choice || choice.unavailableReason) throw new Error(choice?.unavailableReason ?? "该模型已不可用，请刷新后重新选择。");
  if (selectionIdentity(choice.modelSelection) !== selectionIdentity(draft.modelSelection)) throw new Error("草稿与该模型已不一致");
  if (draft.modelSelection.source === "contribution") {
    const credential = draft.modelSelection.credential;
    if (choice.credentials.length && (!credential || !choice.credentials.some((c) => c.credentialId === credential.credentialId && c.credentialRevision === credential.credentialRevision))) throw new Error("请明确选择一个可用 Key：它此前的代次已失效");
    if (!choice.credentials.length && credential) throw new Error("该执行配置不接受 Key");
  }
  const efforts = choice.capabilities.effortLevels;
  if (efforts.length ? draft.effort === null || !efforts.includes(draft.effort) : draft.effort !== null) throw new Error("请为该模型选择一个它明确支持的推理强度");
  return draft;
}
