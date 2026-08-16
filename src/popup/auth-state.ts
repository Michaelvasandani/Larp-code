import type { AppSnapshot, SignInState } from "../shared/protocol";

/**
 * Snapshot refetches are authoritative for domain state, but they do not
 * answer the local question of which sign-in form the Member is completing.
 * Preserve that local code-entry state while the signed-out view remains
 * mounted; clear it only when the snapshot moves to another view.
 */
export function preserveSignedOutAuthState(
  current: SignInState,
  snapshotKind: AppSnapshot["kind"],
): SignInState {
  return snapshotKind === "signed_out" ? current : { status: "ready" };
}
