import type { PopupDraftKind, PopupRequest, TransactionCommandKind } from "../shared/protocol";

type RequestMetadata = Readonly<{
  commandKind?: TransactionCommandKind;
  draftKinds?: readonly PopupDraftKind[];
}>;

export const POPUP_REQUEST_METADATA: Partial<Record<PopupRequest["type"], RequestMetadata>> = {
  create_member_account: { draftKinds: ["setup"] },
  update_display_name: { commandKind: "update_display_name", draftKinds: ["account"] },
  create_invitation: { commandKind: "create_invitation", draftKinds: ["account", "terminal"] },
  accept_invitation: { commandKind: "accept_invitation" },
  revoke_invitation: { commandKind: "revoke_invitation" },
  decline_invitation: { commandKind: "decline_invitation" },
  cancel_challenge: { commandKind: "cancel_challenge" },
  abandon_challenge: { commandKind: "abandon_challenge" },
  credit_solve: { commandKind: "create_solve", draftKinds: ["active"] },
  correct_solve: { commandKind: "correct_solve", draftKinds: ["active"] },
};

export function commandKindForRequest(request: PopupRequest): TransactionCommandKind | undefined {
  return POPUP_REQUEST_METADATA[request.type]?.commandKind;
}

export function draftKindsForRequest(request: PopupRequest): readonly PopupDraftKind[] {
  return POPUP_REQUEST_METADATA[request.type]?.draftKinds ?? [];
}

export function isDomainMutation(request: PopupRequest): boolean {
  return request.type === "create_member_account" || commandKindForRequest(request) !== undefined;
}
