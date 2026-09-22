import type { ExecutionChoice, ExecutionSelectionInput, ModelSelection } from "@ccgui/plugin-sdk";

export function selectionIdentity(selection: ModelSelection): string {
  return selection.source === "native"
    ? JSON.stringify(["native", selection.engineId, selection.channelId ?? null, selection.modelId])
    : JSON.stringify(["contribution", selection.engineId, selection.sourceId, selection.profileKey, selection.modelKey]);
}
export function validateSelectionDraft(choice: ExecutionChoice | undefined, draft: ExecutionSelectionInput): ExecutionSelectionInput {
  if (!choice || choice.unavailableReason) throw new Error(choice?.unavailableReason ?? "This model is no longer available. Refresh and choose again.");
  if (selectionIdentity(choice.modelSelection) !== selectionIdentity(draft.modelSelection)) throw new Error("The draft no longer matches this model");
  if (draft.modelSelection.source === "contribution") {
    const credential = draft.modelSelection.credential;
    if (choice.credentials.length && (!credential || !choice.credentials.some((c) => c.credentialId === credential.credentialId && c.credentialRevision === credential.credentialRevision))) throw new Error("Explicitly choose an available Key; its previous revision is no longer valid");
    if (!choice.credentials.length && credential) throw new Error("This profile does not accept a Key");
  }
  const efforts = choice.capabilities.effortLevels;
  if (efforts.length ? draft.effort === null || !efforts.includes(draft.effort) : draft.effort !== null) throw new Error("Choose an explicitly supported effort for this model");
  return draft;
}
