import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  isPopupResponse,
  PROTOCOL_VERSION,
  createUncertainCommandOutcome,
  SIGN_IN_STATUS_METADATA,
  type AppSnapshot,
  type CommandOutcome,
  type PopupRequest,
  type PopupResponse,
  type PendingCommand,
  type SignInState,
  type SolveCorrectionCategory,
} from "../shared/protocol";
import { DISPLAY_NAME_MAX_LENGTH, stripDisplayNameControlCharacters } from "../worker/member-account";
import { PINNED_PROBLEM_SET_VERSION } from "../catalog/problem-set";
import { preserveSignedOutAuthState } from "./auth-state";
import { ConfirmationDialog } from "./ConfirmationDialog";
import { clearPopupDraft, PopupDraftStatus, usePopupDraft } from "./drafts";
import { GrovekinPresentation } from "./GrovekinPresentation";
import { deriveGrovekinTransition, type GrovekinTransition } from "./grovekin-motion";
import { commandKindForRequest, draftKindsForRequest, isDomainMutation } from "./request-metadata";

type LoadState =
  | { status: "loading" }
  | { status: "loaded"; snapshot: AppSnapshot }
  | { status: "unavailable"; message: string; pendingCommand?: PendingCommand | null; pendingRecovery?: boolean };

const defaultSignInState: SignInState = { status: "ready" };

async function sendRequest(request: PopupRequest): Promise<PopupResponse> {
  const response: unknown = await chrome.runtime.sendMessage(request);
  if (!isPopupResponse(response)) throw new Error("The worker returned an invalid response.");
  return response;
}

class SnapshotRequestError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "SnapshotRequestError";
  }
}

async function requestSnapshot(): Promise<{ snapshot: AppSnapshot; command?: CommandOutcome }> {
  const response = await sendRequest({ version: PROTOCOL_VERSION, type: "get_snapshot" });
  if (!response.ok || !response.snapshot) {
    throw new SnapshotRequestError(
      response.ok ? "The worker returned no current snapshot." : response.error.message,
      response.ok ? "internal" : response.error.code,
    );
  }
  return { snapshot: response.snapshot, ...(response.command ? { command: response.command } : {}) };
}

function SnapshotDetails({ snapshot }: { snapshot: AppSnapshot }) {
  return (
    <dl className="snapshot-details">
      <div>
        <dt>Connection</dt>
        <dd>{snapshot.backend.status}</dd>
      </div>
      <div>
        <dt>Worker boot</dt>
        <dd>{snapshot.worker.bootCount}</dd>
      </div>
      <div>
        <dt>Contract</dt>
        <dd>v{snapshot.contractVersion}</dd>
      </div>
    </dl>
  );
}

function signInStatusMessage(state: SignInState): string {
  return SIGN_IN_STATUS_METADATA[state.status].message;
}

function isCodeEntryState(status: SignInState["status"]): boolean {
  return SIGN_IN_STATUS_METADATA[status].codeEntry;
}

function cooldownSeconds(state: SignInState, now: number): number {
  if (!("resendAvailableAt" in state) || !state.resendAvailableAt) return 0;
  const remaining = Date.parse(state.resendAvailableAt) - now;
  return remaining > 0 ? Math.ceil(remaining / 1_000) : 0;
}

function pendingCommandOf(snapshot: AppSnapshot): PendingCommand | null | undefined {
  // For domain snapshots this is equivalent to
  // createUncertainCommandOutcome(snapshot.pendingCommand.idempotencyKey, snapshot.pendingCommand.kind).
  return "pendingCommand" in snapshot ? snapshot.pendingCommand : undefined;
}

function SignedOut({
  snapshot,
  onRetry,
  authState,
  onAction,
}: {
  snapshot: AppSnapshot;
  onRetry: () => void;
  authState: SignInState;
  onAction: (request: PopupRequest) => Promise<PopupResponse | undefined>;
}) {
  const [signedOutDraft, setSignedOutDraft, signedOutDraftStatus, retrySignedOutDraft] = usePopupDraft("signed_out", {
    email: "",
    isSignInFormVisible: false,
  });
  const [codeEntryActive, setCodeEntryActive] = useState(false);
  const [token, setToken] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const { email, isSignInFormVisible } = signedOutDraft;
  const hasCode = codeEntryActive && (isCodeEntryState(authState.status) || authState.status === "requesting_code");
  const remaining = cooldownSeconds(authState, now);
  const isBusy = authState.status === "verifying" || authState.status === "requesting_code";

  useEffect(() => {
    if (isCodeEntryState(authState.status)) setCodeEntryActive(true);
  }, [authState.status]);

  useEffect(() => {
    if (!("resendAvailableAt" in authState) || !authState.resendAvailableAt) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [authState]);

  async function requestCode(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onAction({ version: PROTOCOL_VERSION, type: "request_email_otp", email });
  }

  async function verifyCode(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onAction({ version: PROTOCOL_VERSION, type: "verify_email_otp", email, token });
  }

  async function resendCode() {
    await onAction({ version: PROTOCOL_VERSION, type: "resend_email_otp", email });
  }

  return (
    <section className="state-card" aria-labelledby="signed-out-title">
      <p className="eyebrow">MEMBER ACCOUNT</p>
      <h2 id="signed-out-title">You’re signed out</h2>
      <PopupDraftStatus status={signedOutDraftStatus} onRetry={retrySignedOutDraft} />
      {!isSignInFormVisible && (
        <>
          <p>
            Sign in with your email to enter a shared NeetCode 150 Challenge.
            Your email remains your sole account and recovery authority.
          </p>
          <button type="button" className="primary-button" onClick={() => setSignedOutDraft((current) => ({ ...current, isSignInFormVisible: true }))}>
            Sign in with email
          </button>
        </>
      )}
      {isSignInFormVisible && (
        <>
          <p id="sign-in-help">
            We use a callback-free six-digit code. For privacy, larp-code does
            not reveal whether an email has a Member Account or claim that a
            code was delivered.
          </p>
          {!hasCode && (
            <form onSubmit={requestCode} aria-describedby="sign-in-help sign-in-status">
              <label htmlFor="member-email">Email address</label>
              <input
                id="member-email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setSignedOutDraft((current) => ({ ...current, email: event.target.value }))}
                required
              />
              <button type="submit" className="primary-button" disabled={isBusy}>
                Request sign-in code
              </button>
            </form>
          )}
          {hasCode && (
            <form onSubmit={verifyCode} aria-describedby="sign-in-help sign-in-status">
              <label htmlFor="member-code">Six-digit code</label>
              <input
                id="member-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                value={token}
                onChange={(event) => setToken(event.target.value.replace(/\D/g, "").slice(0, 6))}
                required
              />
              <button type="submit" className="primary-button" disabled={isBusy || token.length !== 6}>
                {isBusy ? "Verifying code…" : "Verify code"}
              </button>
              <button
                type="button"
                className="text-button"
                onClick={() => void resendCode()}
                disabled={isBusy || remaining > 0}
              >
                {remaining > 0 ? `Request another code in ${remaining}s` : "Request another code"}
              </button>
            </form>
          )}
          <p id="sign-in-status" className="auth-status" role="status" aria-live="polite">
            {signInStatusMessage(authState)}
          </p>
        </>
      )}
      <button type="button" className="text-button" onClick={onRetry}>
        Refresh connection
      </button>
      <SnapshotDetails snapshot={snapshot} />
    </section>
  );
}

function AuthenticatedPlaceholder({
  snapshot,
  onSignOut,
}: {
  snapshot: AppSnapshot;
  onSignOut: () => Promise<PopupResponse | undefined>;
}) {
  return (
    <section className="state-card" aria-labelledby="placeholder-title">
      <p className="eyebrow">MEMBER ACCOUNT</p>
      <h2 id="placeholder-title">Signed in</h2>
      <p>Your authenticated session is restored by the service worker.</p>
      <button type="button" className="text-button" onClick={() => void onSignOut()}>
        Sign out
      </button>
      <SnapshotDetails snapshot={snapshot} />
    </section>
  );
}

function SuspendedAccountView({
  snapshot,
  onSignOut,
}: {
  snapshot: Extract<AppSnapshot, { kind: "account" }>;
  onSignOut: () => Promise<PopupResponse | undefined>;
}) {
  return (
    <section className="state-card" role="alert" aria-labelledby="suspended-account-title">
      <p className="eyebrow">MEMBER ACCOUNT</p>
      <h2 id="suspended-account-title">Account access is unavailable</h2>
      <p>For security, this Member Account cannot access larp-code. If you contact support, include the short diagnostic identifier shown with any error.</p>
      <button type="button" className="primary-button" onClick={() => void onSignOut()}>Sign out</button>
      <SnapshotDetails snapshot={snapshot} />
    </section>
  );
}

function UpdateRequired({
  snapshot,
  onAction,
}: {
  snapshot: Extract<AppSnapshot, { kind: "update_required" }>;
  onAction: (request: PopupRequest) => Promise<PopupResponse | undefined>;
}) {
  const [confirmingErase, setConfirmingErase] = useState(false);
  const [updateFeedback, setUpdateFeedback] = useState<string>();
  async function requestUpdate() {
    if (snapshot.compatibility.updateUrl) {
      window.open(snapshot.compatibility.updateUrl, "_blank", "noopener,noreferrer");
      setUpdateFeedback("The update page was opened in a new tab. Follow the browser's update instructions, then reopen larp-code.");
      return;
    }
    const runtime = chrome.runtime as typeof chrome.runtime & {
      requestUpdateCheck?: () => Promise<{ status: "update_available" | "no_update" | "throttled" }>;
    };
    if (!runtime.requestUpdateCheck) {
      setUpdateFeedback("Automatic update checking is unavailable. Open your browser's extension updates and try again.");
      return;
    }
    setUpdateFeedback("Checking for an available update…");
    try {
      const result = await runtime.requestUpdateCheck();
      setUpdateFeedback(result.status === "update_available"
        ? "An update is available. Chrome will install it; reopen larp-code when it finishes."
        : result.status === "throttled"
          ? "Chrome is limiting update checks. Open extension updates and try again later."
          : "No update is available yet. Open extension updates and try again later.");
    } catch {
      setUpdateFeedback("Chrome could not check for an update. Open extension updates and try again.");
    }
  }

  async function eraseLocalData() {
    await onAction({ version: PROTOCOL_VERSION, type: "erase_local_data" });
  }

  async function signOut() {
    await onAction({ version: PROTOCOL_VERSION, type: "sign_out" });
  }

  return (
    <section className="state-card" role="alert" aria-labelledby="update-required-title">
      <p className="eyebrow">UPDATE REQUIRED</p>
      <h2 id="update-required-title">Update larp-code to continue</h2>
      <p>This version is no longer safe to use with the current service. Member data remains unavailable until the extension is updated.</p>
      <button type="button" className="primary-button" onClick={() => void requestUpdate()}>Request update</button>
      {updateFeedback && <p className="auth-status" role="status" aria-live="polite">{updateFeedback}</p>}
      <button type="button" className="text-button" onClick={() => void signOut()}>Sign out</button>
      <button type="button" className="text-button" onClick={() => setConfirmingErase(true)}>Erase local data</button>
      <ConfirmationDialog
        open={confirmingErase}
        title="Confirm local erasure"
        description="Erasing local data signs you out and removes this extension's stored session, draft, and recovery data. It does not delete the server-side Member Account or Challenge record."
        confirmLabel="Confirm local erasure"
        cancelLabel="Keep local data"
        onCancel={() => setConfirmingErase(false)}
        onConfirm={() => { setConfirmingErase(false); void eraseLocalData(); }}
      />
      <SnapshotDetails snapshot={snapshot} />
    </section>
  );
}

function SetupRequired({
  snapshot,
  onCreate,
  error,
}: {
  snapshot: Extract<AppSnapshot, { kind: "setup_required" }>;
  onCreate: (request: PopupRequest) => Promise<PopupResponse | undefined>;
  error?: string;
}) {
  const [setupDraft, setSetupDraft, setupDraftStatus, retrySetupDraft] = usePopupDraft("setup", {
    displayName: "",
    adultConfirmed: false,
    consentAccepted: false,
  });
  const { displayName, adultConfirmed, consentAccepted } = setupDraft;
  const [isSubmitting, setSubmitting] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!adultConfirmed || !consentAccepted || !displayName.trim()) return;
    setSubmitting(true);
    try {
      await onCreate({
        version: PROTOCOL_VERSION,
        type: "create_member_account",
        displayName,
        adultConfirmed,
        consentAccepted,
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="state-card" aria-labelledby="setup-title">
      <p className="eyebrow">MEMBER ACCOUNT</p>
      <h2 id="setup-title">Finish setting up your account</h2>
      <PopupDraftStatus status={setupDraftStatus} onRetry={retrySetupDraft} />
      <p>
        Your verified email is the only account and recovery authority. Before
        you continue, please review what larp-code keeps and why.
      </p>
      <div className="privacy-summary" aria-label="Data collection summary">
        <p><strong>Collected:</strong> your verified email, display name, and essential account and consent timestamps.</p>
        <p><strong>Used for:</strong> sign-in, the shared Challenge and Pet experience, service security, and diagnosing failures.</p>
        <p><strong>Not collected:</strong> birth date, browsing activity, page contents, contacts, advertising identifiers, or analytics.</p>
      </div>
      <p>
        larp-code is for adults 18 and older. We do not collect a birth date.
        Read the <a href="privacy.html" target="_blank" rel="noreferrer">public privacy policy</a> before accepting.
      </p>
      <form onSubmit={submit} aria-describedby="display-name-help">
        <p className="field-help">Your unfinished setup is a local draft. It is not a Member Account until the worker returns an authoritative result.</p>
        <label htmlFor="member-display-name">Display name</label>
        <input
          id="member-display-name"
          type="text"
          autoComplete="nickname"
          maxLength={DISPLAY_NAME_MAX_LENGTH}
          value={displayName}
          onChange={(event) => setSetupDraft((current) => ({ ...current, displayName: stripDisplayNameControlCharacters(event.target.value) }))}
          required
          aria-describedby="display-name-help"
        />
        <p id="display-name-help" className="field-help">
          1–{DISPLAY_NAME_MAX_LENGTH} characters. Names are not unique; control characters are removed.
        </p>
        <fieldset>
          <legend>Consent</legend>
          <label className="check-row">
            <input
              type="checkbox"
              checked={adultConfirmed}
              onChange={(event) => setSetupDraft((current) => ({ ...current, adultConfirmed: event.target.checked }))}
              required
            />
            <span>I confirm that I am at least 18 years old.</span>
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={consentAccepted}
              onChange={(event) => setSetupDraft((current) => ({ ...current, consentAccepted: event.target.checked }))}
              required
            />
            <span>I understand and affirmatively consent to the collection and uses described above and in the privacy policy.</span>
          </label>
        </fieldset>
        {error && <p id="setup-status" className="auth-status error-status" role="alert">{error}</p>}
        <button type="submit" className="primary-button" disabled={isSubmitting || !adultConfirmed || !consentAccepted || !displayName.trim()}>
          {isSubmitting ? "Creating account…" : "Create Member Account"}
        </button>
      </form>
      <SnapshotDetails snapshot={snapshot} />
    </section>
  );
}

function MemberAccountView({
  snapshot,
  onSignOut,
  onUpdate,
  onRetry,
  commandOutcome,
}: {
  snapshot: Extract<AppSnapshot, { kind: "account" }>;
  onSignOut: () => Promise<PopupResponse | undefined>;
  onUpdate: (request: PopupRequest) => Promise<PopupResponse | undefined>;
  onRetry: () => void;
  commandOutcome?: CommandOutcome;
}) {
  const [accountDraft, setAccountDraft, accountDraftStatus, retryAccountDraft] = usePopupDraft("account", {
    displayName: snapshot.account.displayName,
    invitedEmail: "",
    timeZone: "UTC",
    startDate: "",
    deadlineDate: "",
  });
  const { displayName, invitedEmail, timeZone, startDate, deadlineDate } = accountDraft;
  const [isSubmitting, setSubmitting] = useState(false);
  const [isInviting, setInviting] = useState(false);
  const [deletionOpen, setDeletionOpen] = useState(false);
  const [deletionCodeSent, setDeletionCodeSent] = useState(false);
  const [deletionConfirmation, setDeletionConfirmation] = useState("");
  const [deletionOtp, setDeletionOtp] = useState("");
  const [deletionBusy, setDeletionBusy] = useState(false);
  const [deletionError, setDeletionError] = useState<string | undefined>();
  const [confirmingDeletion, setConfirmingDeletion] = useState(false);
  const lastAuthoritativeDisplayName = useRef(snapshot.account.displayName);

  useEffect(() => {
    if (snapshot.account.displayName === lastAuthoritativeDisplayName.current) return;
    lastAuthoritativeDisplayName.current = snapshot.account.displayName;
    setAccountDraft((current) => ({ ...current, displayName: snapshot.account.displayName }));
  }, [snapshot.account.displayName, setAccountDraft]);

  const pending = Boolean(snapshot.pendingCommand) || commandOutcome?.status === "uncertain";
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !displayName.trim()) return;
    setSubmitting(true);
    try {
      await onUpdate({ version: PROTOCOL_VERSION, type: "update_display_name", displayName });
    } finally {
      setSubmitting(false);
    }
  }

  async function submitInvitation(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || isInviting) return;
    setInviting(true);
    try {
      await onUpdate({
        version: PROTOCOL_VERSION,
        type: "create_invitation",
        invitedEmail,
        timeZone,
        startDate,
        deadlineDate,
      });
    } finally {
      setInviting(false);
    }
  }

  async function requestDeletionCode() {
    setDeletionError(undefined);
    setDeletionBusy(true);
    try {
      const response = await onUpdate({ version: PROTOCOL_VERSION, type: "request_deletion_otp", email: snapshot.account.email });
      if (response?.ok && response.auth?.status === "code_sent") setDeletionCodeSent(true);
      else if (!response?.ok) setDeletionError(response?.error.message ?? "The deletion confirmation could not be requested.");
    } finally {
      setDeletionBusy(false);
    }
  }

  async function deleteAccount(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (deletionBusy || deletionConfirmation !== "DELETE MY ACCOUNT" || deletionOtp.length !== 6) return;
    setDeletionError(undefined);
    setDeletionBusy(true);
    try {
      const response = await onUpdate({
        version: PROTOCOL_VERSION,
        type: "delete_member_account",
        confirmation: deletionConfirmation,
        otp: deletionOtp,
      });
      if (!response?.ok) setDeletionError(response?.error.message ?? "The account could not be deleted.");
      else if (response.command?.status === "rejected") setDeletionError(response.command.message);
    } finally {
      setDeletionBusy(false);
    }
  }

  const invitationCommand = commandOutcome?.kind === "create_invitation" ? commandOutcome : undefined;

  async function beginAccountDeletion() {
    setConfirmingDeletion(false);
    setDeletionOpen(true);
    setDeletionError(undefined);
    await requestDeletionCode();
  }

  return (
    <section className="state-card" aria-labelledby="account-title">
      <p className="eyebrow">MEMBER ACCOUNT</p>
      <h2 id="account-title">Welcome, {snapshot.account.displayName}</h2>
      <PopupDraftStatus status={accountDraftStatus} onRetry={retryAccountDraft} />
      <dl className="account-details">
        <div>
          <dt>Display name</dt>
          <dd>{snapshot.account.displayName}</dd>
        </div>
        <div>
          <dt>Verified email</dt>
          <dd>{snapshot.account.email}</dd>
        </div>
      </dl>
      <form onSubmit={submit} aria-describedby="display-name-edit-status">
        <label htmlFor="member-display-name-edit">Edit display name</label>
        <input
          id="member-display-name-edit"
          type="text"
          autoComplete="nickname"
          maxLength={DISPLAY_NAME_MAX_LENGTH}
          value={displayName}
          onChange={(event) => setAccountDraft((current) => ({ ...current, displayName: stripDisplayNameControlCharacters(event.target.value) }))}
          required
          disabled={pending || isSubmitting}
        />
        <button type="submit" className="text-button" disabled={pending || isSubmitting || !displayName.trim()}>
          {isSubmitting ? "Saving display name…" : "Save display name"}
        </button>
        {commandOutcome?.status === "rejected" && (
          <p id="display-name-edit-status" className="auth-status error-status" role="alert">{commandOutcome.message}</p>
        )}
        {pending && (
          <p id="display-name-edit-status" className="auth-status" role="status" aria-live="polite">
            Checking whether this completed. Your display name will update when the worker receives the stored result.
            <button type="button" className="text-button" onClick={onRetry}>Check again</button>
          </p>
        )}
        {!pending && commandOutcome?.status !== "rejected" && <span id="display-name-edit-status" className="visually-hidden">No display name update is pending.</span>}
      </form>
      <p>Your email remains your sole sign-in and recovery authority.</p>
      <hr />
      <h3>Invite one Member</h3>
      <p className="field-help">
        One pending outgoing Invitation is allowed. It does not reserve Challenge capacity, and changing a term requires a replacement Invitation.
      </p>
      <form onSubmit={submitInvitation} aria-describedby="invitation-status invitation-help">
        <p className="field-help">Invitation fields remain a local draft until the worker returns an authoritative Invitation result.</p>
        <label htmlFor="invited-email">Invited email</label>
        <input
          id="invited-email"
          type="email"
          autoComplete="email"
          value={invitedEmail}
          onChange={(event) => setAccountDraft((current) => ({ ...current, invitedEmail: event.target.value }))}
          required
          disabled={pending || isInviting}
        />
        <label htmlFor="challenge-time-zone">Challenge Time Zone (IANA)</label>
        <input
          id="challenge-time-zone"
          type="text"
          list="iana-time-zones"
          value={timeZone}
          onChange={(event) => setAccountDraft((current) => ({ ...current, timeZone: event.target.value }))}
          required
          disabled={pending || isInviting}
          aria-describedby="invitation-help"
        />
        <datalist id="iana-time-zones">
          <option value="UTC" />
          <option value="America/Los_Angeles" />
          <option value="America/New_York" />
          <option value="Europe/London" />
          <option value="Asia/Tokyo" />
        </datalist>
        <p id="invitation-help" className="field-help">Start Date must be the next calendar day or later in this shared zone. Dates are inclusive.</p>
        <label htmlFor="challenge-start-date">Start Date</label>
        <input id="challenge-start-date" type="date" value={startDate} onChange={(event) => setAccountDraft((current) => ({ ...current, startDate: event.target.value }))} required disabled={pending || isInviting} />
        <label htmlFor="challenge-deadline-date">Deadline Date</label>
        <input id="challenge-deadline-date" type="date" value={deadlineDate} onChange={(event) => setAccountDraft((current) => ({ ...current, deadlineDate: event.target.value }))} required disabled={pending || isInviting} />
        {invitationCommand?.status === "rejected" && (
          <p id="invitation-status" className="auth-status error-status" role="alert">{invitationCommand.message}</p>
        )}
        {invitationCommand?.status === "uncertain" && (
          <p id="invitation-status" className="auth-status" role="status" aria-live="polite">
            Checking whether this completed. <button type="button" className="text-button" onClick={onRetry}>Check again</button>
          </p>
        )}
        {!invitationCommand || (invitationCommand.status !== "rejected" && invitationCommand.status !== "uncertain")
          ? <span id="invitation-status" className="visually-hidden">No Invitation result is pending.</span>
          : null}
        <button type="submit" className="primary-button" disabled={pending || isInviting || !invitedEmail.trim() || !timeZone.trim() || !startDate || !deadlineDate}>
          {isInviting ? "Creating Invitation…" : "Create Invitation"}
        </button>
      </form>
      <a className="text-button policy-link" href="legal.html" target="_blank" rel="noreferrer">Read Legal and About</a>
      <a className="text-button policy-link" href="privacy.html" target="_blank" rel="noreferrer">
        Read the public privacy policy
      </a>
      <hr />
      <section aria-labelledby="delete-account-title">
        <h3 id="delete-account-title">Delete Member Account</h3>
        <p className="field-help">
          This is irreversible. It ends any shared Challenge for both Members,
          removes your account and identity data, and briefly shows your partner
          a read-only “Deleted Member” record. Uninstalling the extension only
          clears this device; it does not delete the server account.
        </p>
        {!deletionOpen && (
          <button type="button" className="danger-button" onClick={() => setConfirmingDeletion(true)}>
            Start account deletion
          </button>
        )}
        <ConfirmationDialog
          open={confirmingDeletion}
          title="Confirm account deletion"
          description="Account deletion is irreversible. It ends shared Challenges, revokes Invitations and sessions, and erases your identity data after a fresh email confirmation. Uninstalling is different and does not delete your server account."
          confirmLabel="Email me a fresh confirmation code"
          cancelLabel="Keep my account"
          onCancel={() => setConfirmingDeletion(false)}
          onConfirm={() => { void beginAccountDeletion(); }}
        />
        {deletionOpen && !deletionCodeSent && (
          <button type="button" className="primary-button" onClick={() => void requestDeletionCode()} disabled={deletionBusy}>
            {deletionBusy ? "Requesting confirmation…" : "Email me a fresh confirmation code"}
          </button>
        )}
        {deletionOpen && deletionCodeSent && (
          <form onSubmit={deleteAccount} aria-label="Irreversible account deletion">
            <label htmlFor="delete-account-confirmation">Type DELETE MY ACCOUNT</label>
            <input
              id="delete-account-confirmation"
              value={deletionConfirmation}
              onChange={(event) => setDeletionConfirmation(event.target.value)}
              autoComplete="off"
              required
              disabled={deletionBusy}
            />
            <label htmlFor="delete-account-code">Fresh six-digit email code</label>
            <input
              id="delete-account-code"
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              value={deletionOtp}
              onChange={(event) => setDeletionOtp(event.target.value.replace(/\D/g, "").slice(0, 6))}
              autoComplete="one-time-code"
              required
              disabled={deletionBusy}
            />
            {deletionError && <p className="auth-status error-status" role="alert">{deletionError}</p>}
            <button type="submit" className="primary-button" disabled={deletionBusy || deletionConfirmation !== "DELETE MY ACCOUNT" || deletionOtp.length !== 6}>
              {deletionBusy ? "Deleting account…" : "Permanently delete account"}
            </button>
            <button type="button" className="text-button" onClick={() => setDeletionOpen(false)} disabled={deletionBusy}>Cancel</button>
          </form>
        )}
      </section>
      <button type="button" className="primary-button" onClick={() => void onSignOut()}>
        Sign out
      </button>
      <SnapshotDetails snapshot={snapshot} />
    </section>
  );
}

function InvitationView({
  snapshot,
  onSignOut,
  onAccept,
  commandOutcome,
  onAction,
}: {
  snapshot: Extract<AppSnapshot, { kind: "invitation" }>;
  onSignOut: () => Promise<PopupResponse | undefined>;
  onAccept: (request: PopupRequest) => Promise<PopupResponse | undefined>;
  onAction: (request: PopupRequest) => Promise<PopupResponse | undefined>;
  commandOutcome?: CommandOutcome;
}) {
  const { invitation } = snapshot;
  const [isAccepting, setAccepting] = useState(false);
  const [confirmingAction, setConfirmingAction] = useState<"revoke" | "decline" | null>(null);
  const isPending = invitation.status === "pending";
  const canAccept = snapshot.actions?.includes("accept") ?? false;
  const canRevoke = snapshot.actions?.includes("revoke") ?? false;
  const canDecline = snapshot.actions?.includes("decline") ?? false;
  async function accept() {
    if (!isPending || isAccepting) return;
    setAccepting(true);
    try {
      await onAccept({ version: PROTOCOL_VERSION, type: "accept_invitation", invitationId: invitation.id });
    } finally {
      setAccepting(false);
    }
  }
  return (
    <section className="state-card" aria-labelledby="invitation-title">
      <p className="eyebrow">INVITATION</p>
      <h2 id="invitation-title">Invitation terms</h2>
      <p>
        Authenticate with the invited email to view these complete terms. The invitation email is privacy-minimal and does not include Challenge details.
      </p>
      <dl className="account-details">
        <div><dt>From</dt><dd>{invitation.inviterDisplayName}</dd></div>
        <div><dt>Invited email</dt><dd>{invitation.invitedEmail}</dd></div>
        <div><dt>Challenge Time Zone</dt><dd>{invitation.timeZone}</dd></div>
        <div><dt>Start Date</dt><dd>{invitation.startDate}</dd></div>
        <div><dt>Deadline Date</dt><dd>{invitation.deadlineDate}</dd></div>
        <div><dt>Problem Set Version</dt><dd>{invitation.problemSetVersionId}</dd></div>
      </dl>
      {snapshot.details && (
        <>
          <dl className="account-details">
            <div><dt>Pinned catalog commit</dt><dd>{snapshot.details.problemSetVersion.sourceCommitSha}</dd></div>
            <div><dt>Pinned problem count</dt><dd>{snapshot.details.problemSetVersion.problemCount}</dd></div>
            <div><dt>Partner identity</dt><dd>{snapshot.details.partner.displayName} ({snapshot.details.partner.email})</dd></div>
            <div><dt>Shared record</dt><dd>{snapshot.details.sharedRecord.visibility === "both_members" ? "Visible to both Members" : "Private"}</dd></div>
            <div><dt>Authority</dt><dd>{snapshot.details.sharedRecord.authority === "equal" ? "Equal" : snapshot.details.sharedRecord.authority}</dd></div>
          </dl>
        </>
      )}
      <p>Both Members will have equal authority after acceptance. Either Member can end the shared Challenge.</p>
      {commandOutcome?.status === "rejected" && (
        <p className="auth-status error-status" role="alert">{commandOutcome.message}</p>
      )}
      {commandOutcome?.status === "uncertain" && (
        <p className="auth-status" role="status" aria-live="polite">Checking whether acceptance completed. Refresh to reconcile the authoritative Challenge state.</p>
      )}
      {canAccept && isPending && (
        <button type="button" className="primary-button" onClick={() => void accept()} disabled={isAccepting || commandOutcome?.status === "uncertain"}>
          {isAccepting ? "Accepting Invitation…" : "Accept Invitation"}
        </button>
      )}
      {!isPending && <p role="status">This Invitation is {invitation.status} and cannot be changed or accepted.</p>}
      {canRevoke && isPending && (
        <button type="button" className="danger-button" onClick={() => setConfirmingAction("revoke")}>
          Revoke Invitation
        </button>
      )}
      {canDecline && isPending && (
        <button type="button" className="text-button" onClick={() => setConfirmingAction("decline")}>
          Decline Invitation
        </button>
      )}
      <ConfirmationDialog
        open={confirmingAction !== null}
        title={confirmingAction === "revoke" ? "Confirm revocation" : "Confirm decline"}
        description={confirmingAction === "revoke"
          ? "Revoking withdraws this Invitation before acceptance. It cannot be reactivated, and no Challenge will be created."
          : "Declining ends this Invitation before acceptance. It cannot be reactivated, and no Challenge will be created."}
        confirmLabel={confirmingAction === "revoke" ? "Confirm revocation" : "Confirm decline"}
        cancelLabel="Keep this Invitation"
        onCancel={() => setConfirmingAction(null)}
        onConfirm={() => {
          const action = confirmingAction;
          setConfirmingAction(null);
          if (action) void onAction({ version: PROTOCOL_VERSION, type: action === "revoke" ? "revoke_invitation" : "decline_invitation", invitationId: invitation.id });
        }}
      />
      <a className="text-button policy-link" href="legal.html" target="_blank" rel="noreferrer">Read Legal and About</a>
      <a className="text-button policy-link" href="privacy.html" target="_blank" rel="noreferrer">Read the public privacy policy</a>
      <button type="button" className="text-button" onClick={() => void onSignOut()}>Sign out</button>
    </section>
  );
}

function ChallengeTerms({ challenge }: { challenge: Extract<AppSnapshot, { kind: "scheduled" | "active" | "terminal" }>['challenge'] }) {
  if (!challenge) return null;
  return (
    <dl className="account-details">
      <div><dt>Challenge Time Zone</dt><dd>{challenge.timeZone}</dd></div>
      <div><dt>Start Date</dt><dd>{challenge.startDate}</dd></div>
      <div><dt>Deadline Date</dt><dd>{challenge.deadlineDate}</dd></div>
      <div><dt>Problem Set Version</dt><dd>{challenge.problemSetVersionId}</dd></div>
      <div><dt>Members</dt><dd>{challenge.members.map((member) => member.displayName).join(" and ")}</dd></div>
    </dl>
  );
}

function ScheduledView({ snapshot, onSignOut, onCancel, commandOutcome }: {
  snapshot: Extract<AppSnapshot, { kind: "scheduled" }>;
  onSignOut: () => Promise<PopupResponse | undefined>;
  onCancel: (request: PopupRequest) => Promise<PopupResponse | undefined>;
  commandOutcome?: CommandOutcome;
}) {
  const [confirming, setConfirming] = useState(false);
  const canCancel = snapshot.actions?.includes("cancel") ?? false;
  async function cancel() {
    await onCancel({ version: PROTOCOL_VERSION, type: "cancel_challenge", challengeId: snapshot.challenge.id });
  }
  return (
    <section className="state-card" aria-labelledby="scheduled-title">
      <p className="eyebrow">SCHEDULED CHALLENGE</p>
      <h2 id="scheduled-title">Your shared Challenge is scheduled</h2>
      <ChallengeTerms challenge={snapshot.challenge} />
      <p>Both Members have equal authority, see the shared record, and can end the Challenge.</p>
      {commandOutcome?.status === "rejected" && <p className="auth-status error-status" role="alert">{commandOutcome.message}</p>}
      {commandOutcome?.status === "uncertain" && <p className="auth-status" role="status">Checking whether cancellation completed. Refresh to reconcile both Members.</p>}
      {canCancel && commandOutcome?.status !== "uncertain" && (
        <button type="button" className="danger-button" onClick={() => setConfirming(true)}>
          Cancel Challenge
        </button>
      )}
      <ConfirmationDialog
        open={confirming}
        title="Confirm cancellation"
        description="Canceling ends this Scheduled Challenge for both Members, releases both commitments, and keeps a read-only Canceled record. This cannot be undone."
        confirmLabel="Confirm cancellation"
        cancelLabel="Keep this Scheduled Challenge"
        onCancel={() => setConfirming(false)}
        onConfirm={() => { setConfirming(false); void cancel(); }}
      />
      <button type="button" className="text-button" onClick={() => void onSignOut()}>Sign out</button>
      <SnapshotDetails snapshot={snapshot} />
    </section>
  );
}

function ActiveView({ snapshot, onSignOut, onAction, commandOutcome, grovekinTransition }: {
  snapshot: Extract<AppSnapshot, { kind: "active" }>;
  onSignOut: () => Promise<PopupResponse | undefined>;
  onAction: (request: PopupRequest) => Promise<PopupResponse | undefined>;
  commandOutcome?: CommandOutcome;
  grovekinTransition: GrovekinTransition;
}) {
  const progress = snapshot.progress;
  const [activeDraft, setActiveDraft, activeDraftStatus, retryActiveDraft] = usePopupDraft("active", {
    selectedProblemId: "",
    affirmed: false,
    correctionSolveId: "",
    correctionCategory: "reclassified",
    correctionReason: "",
    correctionStatus: "not_credited",
  });
  const { selectedProblemId, affirmed } = activeDraft;
  const [isSubmitting, setSubmitting] = useState(false);
  const [confirmingAbandon, setConfirmingAbandon] = useState(false);
  const pending = Boolean(snapshot.pendingCommand) || commandOutcome?.status === "uncertain";
  const canCreditSolve = snapshot.actions?.includes("solve") ?? false;
  const canAbandon = snapshot.actions?.includes("abandon") ?? false;
  const selectedProblem = PINNED_PROBLEM_SET_VERSION.problems.find((problem) => problem.id === selectedProblemId);
  const solveHistory = snapshot.challenge.solveHistory ?? [];
  const correctionSolveId = activeDraft.correctionSolveId || null;
  const correctionCategory = activeDraft.correctionCategory;
  const correctionReason = activeDraft.correctionReason;
  const correctionStatus = activeDraft.correctionStatus;

  async function creditSolve(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!progress || !selectedProblem || !affirmed || pending || isSubmitting) return;
    setSubmitting(true);
    try {
      const response = await onAction({
        version: PROTOCOL_VERSION,
        type: "credit_solve",
        challengeId: snapshot.challenge.id,
        problemId: selectedProblem.id,
        affirmed: true,
      });
      if (response?.ok && (!response.command || response.command.status === "applied")) {
        setActiveDraft((current) => ({ ...current, selectedProblemId: "", affirmed: false }));
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (!progress) {
    return <section className="state-card" role="alert"><h2>Active state is unavailable</h2><p>Refresh to receive a complete authoritative Snapshot.</p></section>;
  }

  const memberName = (memberId: string) => progress.members.find((member) => member.memberId === memberId)?.displayName ?? "Member";
  const correctionPending = pending && commandOutcome?.kind === "correct_solve";

  async function correctSolve(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!correctionSolveId || !correctionReason.trim() || correctionPending) return;
    const response = await onAction({
      version: PROTOCOL_VERSION,
      type: "correct_solve",
      challengeId: snapshot.challenge.id,
      solveId: correctionSolveId,
      category: correctionCategory,
      reason: correctionReason,
      resultingCreditStatus: correctionStatus,
    });
    if (response?.ok && (!response.command || response.command.status === "applied")) {
      setActiveDraft((current) => ({ ...current, correctionSolveId: "", correctionReason: "" }));
    }
  }

  async function abandonChallenge() {
    await onAction({ version: PROTOCOL_VERSION, type: "abandon_challenge", challengeId: snapshot.challenge.id });
  }

  return (
    <section className="state-card" aria-labelledby="active-title">
      <p className="eyebrow">ACTIVE CHALLENGE · PET</p>
      <h2 id="active-title">Your Grovekin is {progress.petCondition}</h2>
      <PopupDraftStatus status={activeDraftStatus} onRetry={retryActiveDraft} />
      <div className={`pet-panel pet-${progress.petCondition}`} aria-label="Pet state">
        <GrovekinPresentation condition={progress.petCondition} stage={progress.currentEvolutionStage} transition={grovekinTransition} />
        <p className="pet-condition">{progress.petCondition}</p>
        <p className="pet-stage"><strong>Evolution Stage {progress.currentEvolutionStage}</strong> · highest attained Stage {progress.highestEvolutionStage}</p>
        <p className="pair-progress">Pair Progress {progress.pairProgress} / 150</p>
      </div>
      <h3>Both Members’ pace</h3>
      <div className="member-progress-list">
        {progress.members.map((member) => (
          <article key={member.memberId} className="member-progress">
            <h4>{member.displayName}</h4>
            <p className="member-total">{member.creditedTotal} / 150</p>
            <p>{member.paceStatus === "behind" ? "Behind" : member.paceStatus === "on_pace_today" ? "On Pace Today" : "Today’s Pace Met"}</p>
            <p className="field-help">{member.paceGap.copy}</p>
          </article>
        ))}
      </div>
      <p className="field-help">Current shared target: {progress.expectedProgress} / 150. Evidence is self-reported and self-attested; no platform access or independent check is used.</p>
      {canCreditSolve ? <form onSubmit={creditSolve} aria-describedby="solve-help solve-status">
        <h3>Credit my solve</h3>
        <p className="field-help">This unfinished selection is a local draft. It becomes a self-reported Solve only after the authoritative result returns.</p>
        <p id="solve-help" className="field-help">Choose one Problem from pinned version {progress.problemSetVersionId}, then affirm that you completed or recompleted it during this Active Challenge.</p>
        <label htmlFor="solve-problem">Problem</label>
        <select id="solve-problem" value={selectedProblemId} onChange={(event) => setActiveDraft((current) => ({ ...current, selectedProblemId: event.target.value }))} disabled={pending || isSubmitting} required>
          <option value="">Select a pinned Problem</option>
          {PINNED_PROBLEM_SET_VERSION.id === progress.problemSetVersionId && PINNED_PROBLEM_SET_VERSION.problems.map((problem) => (
            <option key={problem.id} value={problem.id}>{problem.listOrder}. {problem.title}</option>
          ))}
        </select>
        <label className="check-row">
          <input type="checkbox" checked={affirmed} onChange={(event) => setActiveDraft((current) => ({ ...current, affirmed: event.target.checked }))} disabled={pending || isSubmitting} required />
          <span>I completed or recompleted this Problem during the Active Challenge.</span>
        </label>
        {selectedProblem && <a href={selectedProblem.publicUrl} target="_blank" rel="noreferrer">Open ordinary public Problem link</a>}
        {commandOutcome?.status === "rejected" && <p id="solve-status" className="auth-status error-status" role="alert">{commandOutcome.message}</p>}
        {pending && <p id="solve-status" className="auth-status" role="status">Checking whether this completed. Refresh to reconcile the authoritative Snapshot.</p>}
        {!pending && !(commandOutcome?.status === "rejected" && commandOutcome.kind === "create_solve")
          && <span id="solve-status" className="visually-hidden">No Solve result is pending.</span>}
        <button type="submit" className="primary-button" disabled={pending || isSubmitting || !selectedProblemId || !affirmed}>
          {isSubmitting ? "Crediting solve…" : "Credit my solve"}
        </button>
      </form> : <p role="status">The Challenge deadline has passed. New Solves are no longer accepted.</p>}
      <section className="solve-history" aria-labelledby="solve-history-title">
        <h3 id="solve-history-title">Solve history</h3>
        <p className="field-help">Original claims are self-attested. Later corrections are shown underneath and remain visible to both Members.</p>
        {solveHistory.length === 0 && <p className="field-help">No Solves have been recorded yet.</p>}
        {solveHistory.map((solve) => (
          <article key={solve.id} className="solve-history-entry">
            <p className="solve-history-original">
              <strong>{memberName(solve.memberId)} · {solve.problemId}</strong><br />
              Original self-attestation · {solve.originalCreditStatus === "credited" ? "credited" : "not credited"} · {solve.claimedAt}
            </p>
            {solve.corrections.map((correction) => (
              <p key={correction.id} className="solve-history-correction">
                Correction {correction.sequence} by {memberName(correction.actorId)} · {correction.category} · {correction.resultingCreditStatus === "credited" ? "credited" : "not credited"}<br />
                {correction.reason} · {correction.correctedAt}
              </p>
            ))}
            {solve.canCorrect && !correctionPending && (
              <button type="button" className="text-button" onClick={() => {
                setActiveDraft((current) => ({ ...current, correctionSolveId: solve.id, correctionStatus: solve.creditStatus }));
              }}>
                Correct my Solve
              </button>
            )}
          </article>
        ))}
        {correctionSolveId && (
          <form onSubmit={correctSolve} aria-label="Correct my Solve">
            <h4>Correct my Solve</h4>
            <p className="field-help">This records your reason and resulting credit state. It does not delete the original self-attestation.</p>
            <label htmlFor="correction-category">Correction category</label>
            <select id="correction-category" value={correctionCategory} onChange={(event) => setActiveDraft((current) => ({ ...current, correctionCategory: event.target.value as SolveCorrectionCategory }))} disabled={correctionPending}>
              <option value="reclassified">Reclassified</option>
              <option value="retracted">Retracted</option>
              <option value="restored">Restored</option>
            </select>
            <label htmlFor="correction-status">Resulting credit state</label>
            <select id="correction-status" value={correctionStatus} onChange={(event) => setActiveDraft((current) => ({ ...current, correctionStatus: event.target.value as "credited" | "not_credited" }))} disabled={correctionPending}>
              <option value="credited">Credited</option>
              <option value="not_credited">Not credited</option>
            </select>
            <label htmlFor="correction-reason">Reason</label>
            <input id="correction-reason" value={correctionReason} onChange={(event) => setActiveDraft((current) => ({ ...current, correctionReason: event.target.value }))} maxLength={500} disabled={correctionPending} required />
            {commandOutcome?.status === "rejected" && commandOutcome.kind === "correct_solve" && <p className="auth-status error-status" role="alert">{commandOutcome.message}</p>}
            {correctionPending && <p className="auth-status" role="status">Checking whether this correction completed. Refresh to reconcile the authoritative history.</p>}
            <button type="submit" className="text-button" disabled={correctionPending || !correctionReason.trim()}>Save correction</button>
            <button type="button" className="text-button" onClick={() => setActiveDraft((current) => ({ ...current, correctionSolveId: "" }))} disabled={correctionPending}>Close</button>
          </form>
        )}
      </section>
      <ChallengeTerms challenge={snapshot.challenge} />
      {canAbandon && commandOutcome?.status !== "uncertain" && (
        <section aria-labelledby="abandon-title">
          <h3 id="abandon-title">End this shared Challenge</h3>
          <p className="field-help">Abandoning ends the Challenge for both Members, releases both commitments, and removes the Pet. The read-only record is preserved.</p>
          <button type="button" className="danger-button" onClick={() => setConfirmingAbandon(true)} disabled={pending}>
            Abandon Challenge
          </button>
        </section>
      )}
      <ConfirmationDialog
        open={confirmingAbandon}
        title="Confirm abandonment"
        description="Abandoning ends this Active Challenge for both Members, releases both commitments, removes the Pet, and preserves a read-only Abandoned record. This cannot be undone."
        confirmLabel="Confirm abandonment"
        cancelLabel="Keep this Active Challenge"
        onCancel={() => setConfirmingAbandon(false)}
        onConfirm={() => { setConfirmingAbandon(false); void abandonChallenge(); }}
      />
      <button type="button" className="text-button" onClick={() => void onSignOut()}>Sign out</button>
      <SnapshotDetails snapshot={snapshot} />
    </section>
  );
}

function TerminalChallengeView({ snapshot, onSignOut, onAction, commandOutcome }: {
  snapshot: Extract<AppSnapshot, { kind: "terminal" }>;
  onSignOut: () => Promise<PopupResponse | undefined>;
  onAction: (request: PopupRequest) => Promise<PopupResponse | undefined>;
  commandOutcome?: CommandOutcome;
}) {
  const [terminalDraft, setTerminalDraft, terminalDraftStatus, retryTerminalDraft] = usePopupDraft("terminal", {
    restartStartDate: "",
    restartDeadlineDate: "",
  });
  const { restartStartDate, restartDeadlineDate } = terminalDraft;
  const [restartSubmitting, setRestartSubmitting] = useState(false);
  const challenge = snapshot.challenge;
  if (!challenge) return null;
  const partner = challenge.viewerMemberId
    ? challenge.members.find((member) => member.memberId !== challenge.viewerMemberId)
    : undefined;
  const memberName = (memberId: string) => challenge.members.find((member) => member.memberId === memberId)?.displayName ?? "Member";
  const challengeTimeZone = challenge.timeZone;
  async function restart(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!partner || !restartStartDate || !restartDeadlineDate || restartSubmitting) return;
    setRestartSubmitting(true);
    try {
      await onAction({
        version: PROTOCOL_VERSION,
        type: "create_invitation",
        invitedEmail: partner.email,
        timeZone: challengeTimeZone,
        startDate: restartStartDate,
        deadlineDate: restartDeadlineDate,
      });
    } finally {
      setRestartSubmitting(false);
    }
  }
  const title = challenge.status === "completed"
    ? "Challenge complete"
    : challenge.status === "incomplete"
      ? "Challenge incomplete"
      : challenge.status === "abandoned"
        ? "Challenge abandoned"
        : "This Challenge was canceled";
  return (
    <section className="state-card" aria-labelledby="terminal-title">
      <p className="eyebrow">CHALLENGE ENDED</p>
      <h2 id="terminal-title">{title}</h2>
      <PopupDraftStatus status={terminalDraftStatus} onRetry={retryTerminalDraft} />
      <ChallengeTerms challenge={challenge} />
      {challenge.status === "completed" && challenge.completionFarewellAt && (
        <p role="status">Both Members reached 150. Your Grovekin has completed its farewell and the Pet is now gone.</p>
      )}
      {challenge.status === "incomplete" && <p role="status">The hard deadline passed before both Members reached 150. The Pet ended gently without penalty.</p>}
      {challenge.status === "abandoned" && <p role="status">A Member ended the shared Challenge. The Pet ended gently and both Members are free to commit again.</p>}
      {challenge.finalTotals && <p>Final credited totals: {challenge.finalTotals.map((total) => `${memberName(total.memberId)} ${total.creditedTotal} / 150`).join(" · ")}</p>}
      <p>This Challenge is read-only and cannot be reactivated. Restart creates a new Invitation and a new Challenge.</p>
      {partner && <form onSubmit={restart} aria-label="Restart Challenge">
        <h3>Restart with this partner</h3>
        <p className="field-help">New dates remain a local draft until a fresh Invitation is returned. This creates a distinct Invitation with zero progress; the prior Challenge stays closed.</p>
        <label htmlFor="restart-start-date">New Start Date</label>
        <input id="restart-start-date" type="date" value={restartStartDate} onChange={(event) => setTerminalDraft((current) => ({ ...current, restartStartDate: event.target.value }))} required disabled={restartSubmitting} />
        <label htmlFor="restart-deadline-date">New Deadline Date</label>
        <input id="restart-deadline-date" type="date" value={restartDeadlineDate} onChange={(event) => setTerminalDraft((current) => ({ ...current, restartDeadlineDate: event.target.value }))} required disabled={restartSubmitting} />
        {commandOutcome?.status === "rejected" && commandOutcome.kind === "create_invitation" && <p className="auth-status error-status" role="alert">{commandOutcome.message}</p>}
        {commandOutcome?.status === "uncertain" && commandOutcome.kind === "create_invitation" && <p className="auth-status" role="status">Checking whether the fresh Invitation completed. Refresh to reconcile both Members.</p>}
        <button type="submit" className="primary-button" disabled={restartSubmitting || !restartStartDate || !restartDeadlineDate}>
          {restartSubmitting ? "Creating fresh Invitation…" : "Restart Challenge"}
        </button>
      </form>}
      <button type="button" className="text-button" onClick={() => void onSignOut()}>Sign out</button>
      <SnapshotDetails snapshot={snapshot} />
    </section>
  );
}

export function App() {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [authState, setAuthState] = useState<SignInState>(defaultSignInState);
  const [setupError, setSetupError] = useState<string | undefined>();
  const [commandOutcome, setCommandOutcome] = useState<CommandOutcome | undefined>();
  const [realtimeStatus, setRealtimeStatus] = useState<"connecting" | "subscribed" | "closed" | "error">("connecting");
  const [refreshing, setRefreshing] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  const [farewellRevision, setFarewellRevision] = useState<string | null>(null);
  const farewellTriggerRef = useRef<string | null>(null);
  const farewellTimerRef = useRef<number | undefined>(undefined);
  const previousSnapshotRef = useRef<AppSnapshot | undefined>(undefined);
  const stateKey = state.status === "loaded"
    ? `${state.snapshot.kind}:${state.snapshot.freshness.revision}`
    : state.status;
  const grovekinTransition = state.status === "loaded"
    ? deriveGrovekinTransition(previousSnapshotRef.current, state.snapshot)
    : "none";
  useEffect(() => {
    if (state.status === "loaded") previousSnapshotRef.current = state.snapshot;
  }, [state]);
  useEffect(() => {
    if (state.status !== "loaded" || state.snapshot.kind !== "terminal" || grovekinTransition !== "stage-4-farewell") return undefined;
    const revision = state.snapshot.freshness.revision;
    if (farewellTriggerRef.current === revision) return undefined;
    farewellTriggerRef.current = revision;
    if (farewellTimerRef.current !== undefined) window.clearTimeout(farewellTimerRef.current);
    setFarewellRevision(revision);
    farewellTimerRef.current = window.setTimeout(() => {
      setFarewellRevision(null);
      farewellTimerRef.current = undefined;
    }, 1_420);
    return undefined;
  }, [grovekinTransition, state]);
  useLayoutEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const target = previous?.isConnected && previous !== document.body && previous !== document.documentElement
      ? previous
      : mainRef.current;
    target?.focus({ preventScroll: true });
  }, [stateKey]);

  const loadSnapshot = useCallback(() => {
    // Hide an already-rendered domain view during invalidation/focus refetches;
    // keeping it mounted preserves permitted OTP drafts without displaying
    // stale Member or Challenge truth.
    setRefreshing(true);
    setState((current) => current.status === "loaded" ? current : { status: "loading" });
    void requestSnapshot()
      .then(({ snapshot, command }) => {
        setRefreshing(false);
        setAuthState((current) => preserveSignedOutAuthState(current, snapshot.kind));
        setSetupError(undefined);
        const pendingCommand = pendingCommandOf(snapshot);
        setCommandOutcome(command ?? (pendingCommand
          ? createUncertainCommandOutcome(pendingCommand.idempotencyKey, pendingCommand.kind)
          : undefined));
        setState({ status: "loaded", snapshot });
      })
      .catch((error: unknown) => {
        setRefreshing(false);
        if (error instanceof SnapshotRequestError && error.code === "connection_unavailable") {
          setState((current) => ({
            status: "unavailable",
            message: error.message,
            pendingCommand: current.status === "loaded" ? pendingCommandOf(current.snapshot) : undefined,
          }));
          setRefreshing(false);
          return;
        }
        setState((current) => ({
          status: "unavailable",
          message: error instanceof Error ? error.message : "The connection is unavailable.",
          pendingCommand: current.status === "loaded" ? pendingCommandOf(current.snapshot) : undefined,
        }));
      });
  }, []);

  const sendAuthAction = useCallback(async (request: PopupRequest): Promise<PopupResponse | undefined> => {
    if (request.type === "verify_email_otp") setAuthState({ status: "verifying" });
    if (request.type === "request_email_otp" || request.type === "resend_email_otp") {
      setAuthState({ status: "requesting_code" });
    }
    if (request.type === "create_member_account") setSetupError(undefined);
    if (request.type === "update_display_name"
      || request.type === "delete_member_account"
      || request.type === "accept_invitation"
      || request.type === "revoke_invitation"
      || request.type === "decline_invitation"
      || request.type === "cancel_challenge"
      || request.type === "abandon_challenge"
      || request.type === "credit_solve"
      || request.type === "correct_solve") setCommandOutcome(undefined);
    try {
      const response = await sendRequest(request);
      if (!response.ok) {
        if (response.error.code === "connection_unavailable") {
          setRefreshing(false);
          setAuthState({ status: "service_unavailable" });
          setState((current) => ({
            status: "unavailable",
            message: response.error.message,
            pendingCommand: current.status === "loaded" ? pendingCommandOf(current.snapshot) : undefined,
            pendingRecovery: response.error.code !== "connection_unavailable" && isDomainMutation(request),
          }));
        }
        if (request.type === "create_member_account") setSetupError(response.error.message);
        return response;
      }
      if (response.auth) setAuthState(response.auth);
      if (response.ok && request.type === "create_member_account") clearPopupDraft("setup");
      if (response.ok && response.command?.status === "applied") {
        for (const kind of draftKindsForRequest(request)) clearPopupDraft(kind);
      }
      if ("command" in response && response.command && !response.snapshot) {
        setCommandOutcome(response.command);
      }
      if (response.snapshot) {
        setRefreshing(false);
        setState({ status: "loaded", snapshot: response.snapshot });
        if ("command" in response && response.command) setCommandOutcome(response.command);
        else if (!pendingCommandOf(response.snapshot)) setCommandOutcome(undefined);
        if (response.snapshot.kind === "signed_out") setAuthState(defaultSignInState);
      } else if (request.type === "delete_member_account" && response.auth?.status === "ready") {
        setRefreshing(false);
        setAuthState(defaultSignInState);
        setState((current) => current.status === "loaded"
          ? { status: "loaded", snapshot: { ...current.snapshot, kind: "signed_out", worker: { ...current.snapshot.worker, sessionRestoredFromStorage: false } } }
          : current);
      } else if (request.type === "sign_out") {
        setRefreshing(false);
        setState((current) => current.status === "loaded"
          ? {
              status: "loaded",
              snapshot: {
                ...current.snapshot,
                kind: "signed_out",
                worker: { ...current.snapshot.worker, sessionRestoredFromStorage: false },
              },
            }
          : current);
      } else if (request.type === "erase_local_data") {
        setRefreshing(false);
        setAuthState(defaultSignInState);
        setState((current) => current.status === "loaded"
          ? { status: "loaded", snapshot: { ...current.snapshot, kind: "signed_out", worker: { ...current.snapshot.worker, sessionRestoredFromStorage: false } } }
          : current);
      }
      return response;
    } catch {
      const commandKind = commandKindForRequest(request);
      if (commandKind) {
        setCommandOutcome(createUncertainCommandOutcome("pending-recovery", commandKind));
        void requestSnapshot().then(({ snapshot, command }) => {
          setState({ status: "loaded", snapshot });
          const pendingCommand = pendingCommandOf(snapshot);
          if (command) {
            setCommandOutcome(command);
          } else if (pendingCommand) {
            setCommandOutcome(createUncertainCommandOutcome(pendingCommand.idempotencyKey, pendingCommand.kind));
          } else {
            setCommandOutcome(undefined);
          }
        }).catch(() => undefined);
      }
      setAuthState({ status: "service_unavailable" });
      setRefreshing(false);
      setState((current) => ({
        status: "unavailable",
        message: "The larp-code connection is unavailable.",
        pendingCommand: current.status === "loaded" ? pendingCommandOf(current.snapshot) : undefined,
        pendingRecovery: isDomainMutation(request),
      }));
      if (request.type === "create_member_account") setSetupError("The larp-code connection is unavailable.");
      return undefined;
    }
  }, []);

  const signOut = useCallback(
    () => sendAuthAction({ version: PROTOCOL_VERSION, type: "sign_out" }),
    [sendAuthAction],
  );

  useEffect(() => {
    const port = chrome.runtime.connect({ name: `larp-code-popup-v${PROTOCOL_VERSION}` });
    loadSnapshot();
    const onWorkerEvent = (message: unknown) => {
      if (!message || typeof message !== "object") return;
      const event = message as { version?: number; type?: string; status?: typeof realtimeStatus };
      if (event.version !== PROTOCOL_VERSION) return;
      if (event.type === "snapshot_invalidated") loadSnapshot();
      if (event.type === "snapshot_unavailable") {
        setState((current) => ({
          status: "unavailable",
          message: "The larp-code connection is unavailable.",
          pendingCommand: current.status === "loaded" ? pendingCommandOf(current.snapshot) : undefined,
        }));
      }
      if (event.type === "realtime_status" && event.status) setRealtimeStatus(event.status);
    };
    port.onMessage.addListener(onWorkerEvent);
    const onFocus = () => loadSnapshot();
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      port.onMessage.removeListener(onWorkerEvent);
      port.disconnect();
    };
  }, [loadSnapshot]);

  return (
     <main ref={mainRef} role="main" tabIndex={-1} aria-labelledby="app-title">
      <header className="app-header">
        <div>
          <p className="eyebrow">LARP-CODE</p>
           <h1 id="app-title">Shared progress, made visible.</h1>
        </div>
        <span className="version">v{__CLIENT_VERSION__}</span>
      </header>

      {(state.status === "loading" || (state.status === "loaded" && refreshing)) && (
        <section className="state-card" aria-live="polite">
          <p className="eyebrow">CHECKING FOUNDATION</p>
          <h2>Loading current state…</h2>
          <p>The popup waits for a fresh worker response before showing account data.</p>
        </section>
      )}

      {state.status === "unavailable" && (
        <section className="state-card" role="alert" aria-labelledby="unavailable-title">
          <p className="eyebrow">CONNECTION UNAVAILABLE</p>
          <h2 id="unavailable-title">Current state is unavailable</h2>
          <p>{state.message}</p>
          {(state.pendingCommand || state.pendingRecovery) && <p role="status">Checking whether this completed. Retry when the connection is available; no new action will be sent under a different key.</p>}
          <button type="button" className="primary-button" onClick={loadSnapshot}>Retry</button>
        </section>
      )}

      <div style={{ display: refreshing ? "none" : undefined }} aria-hidden={refreshing}>
      {state.status === "loaded" && state.snapshot.kind === "terminal" && farewellRevision === state.snapshot.freshness.revision && (
        <div className="grovekin-farewell-overlay" role="status" aria-label="Grovekin completion farewell">
          <GrovekinPresentation condition="healthy" stage={4} transition="stage-4-farewell" />
        </div>
      )}
      {state.status === "loaded" && state.snapshot.kind === "signed_out" && (
        <SignedOut snapshot={state.snapshot} onRetry={loadSnapshot} authState={authState} onAction={sendAuthAction} />
      )}

      {state.status === "loaded" && state.snapshot.kind === "setup_required" && (
        <SetupRequired snapshot={state.snapshot} onCreate={sendAuthAction} error={setupError} />
      )}

      {state.status === "loaded" && state.snapshot.kind === "account" && (
        state.snapshot.account.status === "suspended"
          ? <SuspendedAccountView snapshot={state.snapshot} onSignOut={signOut} />
          : <MemberAccountView
              snapshot={state.snapshot}
              onSignOut={signOut}
              onUpdate={sendAuthAction}
              onRetry={loadSnapshot}
              commandOutcome={commandOutcome}
            />
      )}

      {state.status === "loaded" && state.snapshot.kind === "invitation" && (
        <InvitationView snapshot={state.snapshot} onSignOut={signOut} onAccept={sendAuthAction} onAction={sendAuthAction} commandOutcome={commandOutcome} />
      )}

      {state.status === "loaded" && state.snapshot.kind === "scheduled" && (
        <ScheduledView snapshot={state.snapshot} onSignOut={signOut} onCancel={sendAuthAction} commandOutcome={commandOutcome} />
      )}

      {state.status === "loaded" && state.snapshot.kind === "active" && (
        <ActiveView snapshot={state.snapshot} onSignOut={signOut} onAction={sendAuthAction} commandOutcome={commandOutcome} grovekinTransition={grovekinTransition} />
      )}

      {state.status === "loaded" && state.snapshot.kind === "terminal" && (
        <TerminalChallengeView snapshot={state.snapshot} onSignOut={signOut} onAction={sendAuthAction} commandOutcome={commandOutcome} />
      )}

      {state.status === "loaded" && state.snapshot.kind === "update_required" && (
        <UpdateRequired snapshot={state.snapshot} onAction={sendAuthAction} />
      )}

      {state.status === "loaded"
        && state.snapshot.kind !== "signed_out"
        && state.snapshot.kind !== "setup_required"
        && state.snapshot.kind !== "account"
        && state.snapshot.kind !== "invitation"
        && state.snapshot.kind !== "scheduled"
        && state.snapshot.kind !== "active"
        && state.snapshot.kind !== "terminal"
        && state.snapshot.kind !== "update_required" && (
        <AuthenticatedPlaceholder snapshot={state.snapshot} onSignOut={signOut} />
      )}
      </div>

      <footer>
        <span>Fresh worker snapshot</span>
        {realtimeStatus !== "subscribed" && <span role="status">Live updates paused</span>}
        {state.status === "loaded" && !refreshing && <span>{state.snapshot.authoritativeServerTime}</span>}
      </footer>
    </main>
  );
}
