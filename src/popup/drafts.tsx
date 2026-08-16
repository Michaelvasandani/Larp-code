import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";

import {
  isPopupResponse,
  PROTOCOL_VERSION,
  type PopupDraftKind,
  type PopupDraft,
  type PopupDraftValues,
  type PopupRequest,
} from "../shared/protocol";

export type PopupDraftSaveState = "idle" | "loading" | "saving" | "saved" | "error";

export function PopupDraftStatus({ status, onRetry }: { status: PopupDraftSaveState; onRetry: () => void }) {
  if (status === "idle") return null;
  if (status === "loading" || status === "saving") {
    return <p className="field-help" role="status" aria-live="polite">Saving unfinished draft…</p>;
  }
  if (status === "error") {
    return <p className="auth-status error-status" role="alert">Your unfinished draft could not be saved. <button type="button" className="text-button" onClick={onRetry}>Retry draft save</button></p>;
  }
  return <p className="field-help" role="status" aria-live="polite">Unfinished draft saved on this device.</p>;
}

async function sendDraftRequest(request: PopupRequest) {
  const response: unknown = await chrome.runtime.sendMessage(request);
  if (!isPopupResponse(response)) throw new Error("The worker returned an invalid response.");
  return response;
}

export function usePopupDraft<K extends PopupDraftKind>(
  kind: K,
  initial: PopupDraftValues[K],
): readonly [
  PopupDraftValues[K],
  Dispatch<SetStateAction<PopupDraftValues[K]>>,
  PopupDraftSaveState,
  () => void,
] {
  const [values, setValues] = useState<PopupDraftValues[K]>(initial);
  const [saveState, setSaveState] = useState<PopupDraftSaveState>("loading");
  const [retryNumber, setRetryNumber] = useState(0);
  const dirtyRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void sendDraftRequest({ version: PROTOCOL_VERSION, type: "get_drafts" })
      .then((response) => {
        if (cancelled) return;
        const saved = response.ok ? response.drafts?.[kind] : undefined;
        if (saved && !dirtyRef.current) setValues((current) => ({ ...current, ...saved } as PopupDraftValues[K]));
        setSaveState("idle");
      })
      .catch(() => {
        if (!cancelled) setSaveState("error");
      });
    return () => { cancelled = true; };
  }, [kind]);

  useEffect(() => {
    if (!dirtyRef.current) return undefined;
    let cancelled = false;
    setSaveState("saving");
    const draft = { kind, values } as PopupDraft<K>;
    void sendDraftRequest({ version: PROTOCOL_VERSION, type: "save_draft", draft })
      .then((response) => {
        if (cancelled) return;
        if (!response.ok || !response.draft || response.draft.kind !== kind || response.draft.status !== "saved") {
          throw new Error("The worker did not acknowledge this draft write.");
        }
        setSaveState("saved");
      })
      .catch(() => {
        if (!cancelled) setSaveState("error");
      });
    return () => { cancelled = true; };
  }, [kind, retryNumber, values]);

  const setDraftValues = useCallback<Dispatch<SetStateAction<PopupDraftValues[K]>>>((next) => {
    dirtyRef.current = true;
    setValues(next);
  }, []);
  const retry = useCallback(() => setRetryNumber((current) => current + 1), []);
  return [values, setDraftValues, saveState, retry];
}

export function clearPopupDraft(kind: PopupDraftKind): void {
  // Clearing is best effort after a committed transaction; durable saves are
  // acknowledged and retriable while input is unfinished.
  void sendDraftRequest({ version: PROTOCOL_VERSION, type: "clear_draft", kind });
}
