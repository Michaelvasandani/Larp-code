import { useCallback, useEffect, useState } from "react";

import {
  isPopupResponse,
  PROTOCOL_VERSION,
  createUncertainCommandOutcome,
  SIGN_IN_STATUS_METADATA,
  type AppSnapshot,
  type CommandOutcome,
  type PopupRequest,
  type PopupResponse,
  type SignInState,
  type SolveCorrectionCategory,
} from "../shared/protocol";
import { DISPLAY_NAME_MAX_LENGTH, stripDisplayNameControlCharacters } from "../worker/member-account";
import { PINNED_PROBLEM_SET_VERSION } from "../catalog/problem-set";
import { preserveSignedOutAuthState } from "./auth-state";

type LoadState =
  | { status: "loading" }
  | { status: "loaded"; snapshot: AppSnapshot }
  | { status: "error"; message: string };

const defaultSignInState: SignInState = { status: "ready" };

async function sendRequest(request: PopupRequest): Promise<PopupResponse> {
  const response: unknown = await chrome.runtime.sendMessage(request);
  if (!isPopupResponse(response)) throw new Error("The worker returned an invalid response.");
  return response;
}

async function requestSnapshot(): Promise<AppSnapshot> {
  const response = await sendRequest({ version: PROTOCOL_VERSION, type: "get_snapshot" });
  if (!response.ok || !response.snapshot) {
    throw new Error(response.ok ? "The worker returned no current snapshot." : response.error.message);
  }
  return response.snapshot;
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
  const [isSignInFormVisible, setSignInFormVisible] = useState(false);
  const [codeEntryActive, setCodeEntryActive] = useState(false);
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const [now, setNow] = useState(() => Date.now());
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
      {!isSignInFormVisible && (
        <>
          <p>
            Sign in with your email to enter a shared NeetCode 150 Challenge.
            Your email remains your sole account and recovery authority.
          </p>
          <button type="button" className="primary-button" onClick={() => setSignInFormVisible(true)}>
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
                onChange={(event) => setEmail(event.target.value)}
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
      <button type="button" className="primary-button" onClick={() => void onSignOut()}>
        Sign out
      </button>
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
  const [displayName, setDisplayName] = useState("");
  const [adultConfirmed, setAdultConfirmed] = useState(false);
  const [consentAccepted, setConsentAccepted] = useState(false);
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
        <label htmlFor="member-display-name">Display name</label>
        <input
          id="member-display-name"
          type="text"
          autoComplete="nickname"
          maxLength={DISPLAY_NAME_MAX_LENGTH}
          value={displayName}
          onChange={(event) => setDisplayName(stripDisplayNameControlCharacters(event.target.value))}
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
              onChange={(event) => setAdultConfirmed(event.target.checked)}
              required
            />
            <span>I confirm that I am at least 18 years old.</span>
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={consentAccepted}
              onChange={(event) => setConsentAccepted(event.target.checked)}
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
  const [displayName, setDisplayName] = useState(snapshot.account.displayName);
  const [invitedEmail, setInvitedEmail] = useState("");
  const [timeZone, setTimeZone] = useState("UTC");
  const [startDate, setStartDate] = useState("");
  const [deadlineDate, setDeadlineDate] = useState("");
  const [isSubmitting, setSubmitting] = useState(false);
  const [isInviting, setInviting] = useState(false);

  useEffect(() => setDisplayName(snapshot.account.displayName), [snapshot.account.displayName]);

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

  const invitationCommand = commandOutcome?.kind === "create_invitation" ? commandOutcome : undefined;

  return (
    <section className="state-card" aria-labelledby="account-title">
      <p className="eyebrow">MEMBER ACCOUNT</p>
      <h2 id="account-title">Welcome, {snapshot.account.displayName}</h2>
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
          onChange={(event) => setDisplayName(stripDisplayNameControlCharacters(event.target.value))}
          required
          disabled={pending || isSubmitting}
        />
        <button type="submit" className="primary-button" disabled={pending || isSubmitting || !displayName.trim()}>
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
      </form>
      <p>Your email remains your sole sign-in and recovery authority.</p>
      <hr />
      <h3>Invite one Member</h3>
      <p className="field-help">
        One pending outgoing Invitation is allowed. It does not reserve Challenge capacity, and changing a term requires a replacement Invitation.
      </p>
      <form onSubmit={submitInvitation} aria-describedby="invitation-status invitation-help">
        <label htmlFor="invited-email">Invited email</label>
        <input
          id="invited-email"
          type="email"
          autoComplete="email"
          value={invitedEmail}
          onChange={(event) => setInvitedEmail(event.target.value)}
          required
          disabled={pending || isInviting}
        />
        <label htmlFor="challenge-time-zone">Challenge Time Zone (IANA)</label>
        <input
          id="challenge-time-zone"
          type="text"
          list="iana-time-zones"
          value={timeZone}
          onChange={(event) => setTimeZone(event.target.value)}
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
        <input id="challenge-start-date" type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} required disabled={pending || isInviting} />
        <label htmlFor="challenge-deadline-date">Deadline Date</label>
        <input id="challenge-deadline-date" type="date" value={deadlineDate} onChange={(event) => setDeadlineDate(event.target.value)} required disabled={pending || isInviting} />
        {invitationCommand?.status === "rejected" && (
          <p id="invitation-status" className="auth-status error-status" role="alert">{invitationCommand.message}</p>
        )}
        {invitationCommand?.status === "uncertain" && (
          <p id="invitation-status" className="auth-status" role="status" aria-live="polite">
            Checking whether this completed. <button type="button" className="text-button" onClick={onRetry}>Check again</button>
          </p>
        )}
        <button type="submit" className="primary-button" disabled={pending || isInviting || !invitedEmail.trim() || !timeZone.trim() || !startDate || !deadlineDate}>
          {isInviting ? "Creating Invitation…" : "Create Invitation"}
        </button>
      </form>
      <a className="text-button policy-link" href="legal.html" target="_blank" rel="noreferrer">Read Legal and About</a>
      <a className="text-button policy-link" href="privacy.html" target="_blank" rel="noreferrer">
        Read the public privacy policy
      </a>
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
        <button type="button" className="primary-button" onClick={() => void onAction({ version: PROTOCOL_VERSION, type: "revoke_invitation", invitationId: invitation.id })}>
          Revoke Invitation
        </button>
      )}
      {canDecline && isPending && (
        <button type="button" className="primary-button" onClick={() => void onAction({ version: PROTOCOL_VERSION, type: "decline_invitation", invitationId: invitation.id })}>
          Decline Invitation
        </button>
      )}
      <a className="text-button policy-link" href="legal.html" target="_blank" rel="noreferrer">Read Legal and About</a>
      <a className="text-button policy-link" href="privacy.html" target="_blank" rel="noreferrer">Read the public privacy policy</a>
      <button type="button" className="primary-button" onClick={() => void onSignOut()}>Sign out</button>
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
      <div><dt>Members</dt><dd>{challenge.members.map((member) => `${member.displayName} (${member.email})`).join(" and ")}</dd></div>
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
    if (!confirming) {
      setConfirming(true);
      return;
    }
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
        <button type="button" className="primary-button" onClick={() => void cancel()}>
          {confirming ? "Confirm cancel for both Members" : "Cancel Challenge"}
        </button>
      )}
      <button type="button" className="primary-button" onClick={() => void onSignOut()}>Sign out</button>
      <SnapshotDetails snapshot={snapshot} />
    </section>
  );
}

function ActiveView({ snapshot, onSignOut, onAction, commandOutcome }: {
  snapshot: Extract<AppSnapshot, { kind: "active" }>;
  onSignOut: () => Promise<PopupResponse | undefined>;
  onAction: (request: PopupRequest) => Promise<PopupResponse | undefined>;
  commandOutcome?: CommandOutcome;
}) {
  const progress = snapshot.progress;
  const [selectedProblemId, setSelectedProblemId] = useState("");
  const [affirmed, setAffirmed] = useState(false);
  const [isSubmitting, setSubmitting] = useState(false);
  const [confirmingAbandon, setConfirmingAbandon] = useState(false);
  const pending = Boolean(snapshot.pendingCommand) || commandOutcome?.status === "uncertain";
  const canCreditSolve = snapshot.actions?.includes("solve") ?? false;
  const canAbandon = snapshot.actions?.includes("abandon") ?? false;
  const selectedProblem = PINNED_PROBLEM_SET_VERSION.problems.find((problem) => problem.id === selectedProblemId);
  const solveHistory = snapshot.challenge.solveHistory ?? [];
  const [correctionSolveId, setCorrectionSolveId] = useState<string | null>(null);
  const [correctionCategory, setCorrectionCategory] = useState<SolveCorrectionCategory>("reclassified");
  const [correctionReason, setCorrectionReason] = useState("");
  const [correctionStatus, setCorrectionStatus] = useState<"credited" | "not_credited">("not_credited");

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
        setSelectedProblemId("");
        setAffirmed(false);
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
      setCorrectionSolveId(null);
      setCorrectionReason("");
    }
  }

  async function abandonChallenge() {
    if (!confirmingAbandon) {
      setConfirmingAbandon(true);
      return;
    }
    await onAction({ version: PROTOCOL_VERSION, type: "abandon_challenge", challengeId: snapshot.challenge.id });
  }

  return (
    <section className="state-card" aria-labelledby="active-title">
      <p className="eyebrow">ACTIVE CHALLENGE · PET</p>
      <h2 id="active-title">Your Grovekin is {progress.petCondition}</h2>
      <div className={`pet-panel pet-${progress.petCondition}`} aria-label="Pet state">
        <p className="pet-condition">{progress.petCondition}</p>
        <p className="pet-stage">Evolution Stage {progress.currentEvolutionStage}</p>
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
        <p id="solve-help" className="field-help">Choose one Problem from pinned version {progress.problemSetVersionId}, then affirm that you completed or recompleted it during this Active Challenge.</p>
        <label htmlFor="solve-problem">Problem</label>
        <select id="solve-problem" value={selectedProblemId} onChange={(event) => setSelectedProblemId(event.target.value)} disabled={pending || isSubmitting} required>
          <option value="">Select a pinned Problem</option>
          {PINNED_PROBLEM_SET_VERSION.id === progress.problemSetVersionId && PINNED_PROBLEM_SET_VERSION.problems.map((problem) => (
            <option key={problem.id} value={problem.id}>{problem.listOrder}. {problem.title}</option>
          ))}
        </select>
        <label className="check-row">
          <input type="checkbox" checked={affirmed} onChange={(event) => setAffirmed(event.target.checked)} disabled={pending || isSubmitting} required />
          <span>I completed or recompleted this Problem during the Active Challenge.</span>
        </label>
        {selectedProblem && <a href={selectedProblem.publicUrl} target="_blank" rel="noreferrer">Open ordinary public Problem link</a>}
        {commandOutcome?.status === "rejected" && <p id="solve-status" className="auth-status error-status" role="alert">{commandOutcome.message}</p>}
        {pending && <p id="solve-status" className="auth-status" role="status">Checking whether this completed. Refresh to reconcile the authoritative Snapshot.</p>}
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
                setCorrectionSolveId(solve.id);
                setCorrectionStatus(solve.creditStatus);
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
            <select id="correction-category" value={correctionCategory} onChange={(event) => setCorrectionCategory(event.target.value as SolveCorrectionCategory)} disabled={correctionPending}>
              <option value="reclassified">Reclassified</option>
              <option value="retracted">Retracted</option>
              <option value="restored">Restored</option>
            </select>
            <label htmlFor="correction-status">Resulting credit state</label>
            <select id="correction-status" value={correctionStatus} onChange={(event) => setCorrectionStatus(event.target.value as "credited" | "not_credited")} disabled={correctionPending}>
              <option value="credited">Credited</option>
              <option value="not_credited">Not credited</option>
            </select>
            <label htmlFor="correction-reason">Reason</label>
            <input id="correction-reason" value={correctionReason} onChange={(event) => setCorrectionReason(event.target.value)} maxLength={500} disabled={correctionPending} required />
            {commandOutcome?.status === "rejected" && commandOutcome.kind === "correct_solve" && <p className="auth-status error-status" role="alert">{commandOutcome.message}</p>}
            {correctionPending && <p className="auth-status" role="status">Checking whether this correction completed. Refresh to reconcile the authoritative history.</p>}
            <button type="submit" className="primary-button" disabled={correctionPending || !correctionReason.trim()}>Save correction</button>
            <button type="button" className="text-button" onClick={() => setCorrectionSolveId(null)} disabled={correctionPending}>Close</button>
          </form>
        )}
      </section>
      <ChallengeTerms challenge={snapshot.challenge} />
      {canAbandon && commandOutcome?.status !== "uncertain" && (
        <section aria-labelledby="abandon-title">
          <h3 id="abandon-title">End this shared Challenge</h3>
          <p className="field-help">Abandoning ends the Challenge for both Members, releases both commitments, and removes the Pet. The read-only record is preserved.</p>
          <button type="button" className="primary-button" onClick={() => void abandonChallenge()} disabled={pending}>
            {confirmingAbandon ? "Confirm abandonment for both Members" : "Abandon Challenge"}
          </button>
        </section>
      )}
      <button type="button" className="primary-button" onClick={() => void onSignOut()}>Sign out</button>
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
  const [restartStartDate, setRestartStartDate] = useState("");
  const [restartDeadlineDate, setRestartDeadlineDate] = useState("");
  const [restartSubmitting, setRestartSubmitting] = useState(false);
  const challenge = snapshot.challenge;
  if (!challenge) return null;
  const partner = challenge.viewerMemberId
    ? challenge.members.find((member) => member.memberId !== challenge.viewerMemberId)
    : undefined;
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
      <ChallengeTerms challenge={challenge} />
      {challenge.status === "completed" && challenge.completionFarewellAt && (
        <p role="status">Both Members reached 150. Your Grovekin has completed its farewell and the Pet is now gone.</p>
      )}
      {challenge.status === "incomplete" && <p role="status">The hard deadline passed before both Members reached 150. The Pet ended gently without penalty.</p>}
      {challenge.status === "abandoned" && <p role="status">A Member ended the shared Challenge. The Pet ended gently and both Members are free to commit again.</p>}
      {challenge.finalTotals && <p>Final credited totals: {challenge.finalTotals.map((total) => `${total.memberId} ${total.creditedTotal} / 150`).join(" · ")}</p>}
      <p>This Challenge is read-only and cannot be reactivated. Restart creates a new Invitation and a new Challenge.</p>
      {partner && <form onSubmit={restart} aria-label="Restart Challenge">
        <h3>Restart with this partner</h3>
        <p className="field-help">This creates a distinct Invitation with zero progress. Choose fresh dates; the prior Challenge remains closed.</p>
        <label htmlFor="restart-start-date">New Start Date</label>
        <input id="restart-start-date" type="date" value={restartStartDate} onChange={(event) => setRestartStartDate(event.target.value)} required disabled={restartSubmitting} />
        <label htmlFor="restart-deadline-date">New Deadline Date</label>
        <input id="restart-deadline-date" type="date" value={restartDeadlineDate} onChange={(event) => setRestartDeadlineDate(event.target.value)} required disabled={restartSubmitting} />
        {commandOutcome?.status === "rejected" && commandOutcome.kind === "create_invitation" && <p className="auth-status error-status" role="alert">{commandOutcome.message}</p>}
        {commandOutcome?.status === "uncertain" && commandOutcome.kind === "create_invitation" && <p className="auth-status" role="status">Checking whether the fresh Invitation completed. Refresh to reconcile both Members.</p>}
        <button type="submit" className="primary-button" disabled={restartSubmitting || !restartStartDate || !restartDeadlineDate}>
          {restartSubmitting ? "Creating fresh Invitation…" : "Restart Challenge"}
        </button>
      </form>}
      <button type="button" className="primary-button" onClick={() => void onSignOut()}>Sign out</button>
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

  const loadSnapshot = useCallback(() => {
    // Keep an already-rendered view mounted during invalidation/focus refetches
    // so local form state is not reset by a background Snapshot refresh.
    setState((current) => current.status === "loaded" ? current : { status: "loading" });
    void requestSnapshot()
      .then((snapshot) => {
        setAuthState((current) => preserveSignedOutAuthState(current, snapshot.kind));
        setSetupError(undefined);
        setCommandOutcome(snapshot.pendingCommand
          ? createUncertainCommandOutcome(snapshot.pendingCommand.idempotencyKey, snapshot.pendingCommand.kind)
          : undefined);
        setState({ status: "loaded", snapshot });
      })
      .catch((error: unknown) => {
        setState({
          status: "error",
          message: error instanceof Error ? error.message : "The connection is unavailable.",
        });
      });
  }, []);

  const sendAuthAction = useCallback(async (request: PopupRequest): Promise<PopupResponse | undefined> => {
    if (request.type === "verify_email_otp") setAuthState({ status: "verifying" });
    if (request.type === "request_email_otp" || request.type === "resend_email_otp") {
      setAuthState({ status: "requesting_code" });
    }
    if (request.type === "create_member_account") setSetupError(undefined);
    if (request.type === "update_display_name"
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
        if (response.error.code === "connection_unavailable") setAuthState({ status: "service_unavailable" });
        if (request.type === "create_member_account") setSetupError(response.error.message);
        return response;
      }
      if (response.auth) setAuthState(response.auth);
      if ("command" in response && response.command && !response.snapshot) {
        setCommandOutcome(response.command);
      }
      if (response.snapshot) {
        setState({ status: "loaded", snapshot: response.snapshot });
        if ("command" in response && response.command) setCommandOutcome(response.command);
        else if (!response.snapshot.pendingCommand) setCommandOutcome(undefined);
        if (response.snapshot.kind === "signed_out") setAuthState(defaultSignInState);
      } else if (request.type === "sign_out") {
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
      }
      return response;
    } catch {
      if (request.type === "update_display_name"
        || request.type === "accept_invitation"
        || request.type === "revoke_invitation"
        || request.type === "decline_invitation"
        || request.type === "cancel_challenge"
        || request.type === "abandon_challenge"
        || request.type === "credit_solve"
        || request.type === "correct_solve") {
        setCommandOutcome(createUncertainCommandOutcome(
          "pending-recovery",
          request.type === "correct_solve"
            ? "correct_solve"
            : request.type === "credit_solve"
              ? "create_solve"
              : request.type === "abandon_challenge"
                ? "abandon_challenge"
                : undefined,
        ));
        void requestSnapshot().then((snapshot) => {
          setState({ status: "loaded", snapshot });
          if (snapshot.pendingCommand) {
            setCommandOutcome(createUncertainCommandOutcome(snapshot.pendingCommand.idempotencyKey, snapshot.pendingCommand.kind));
          } else {
            setCommandOutcome(undefined);
          }
        }).catch(() => undefined);
      }
      setAuthState({ status: "service_unavailable" });
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
    <main>
      <header className="app-header">
        <div>
          <p className="eyebrow">LARP-CODE</p>
          <h1>Shared progress, made visible.</h1>
        </div>
        <span className="version">v{__CLIENT_VERSION__}</span>
      </header>

      {state.status === "loading" && (
        <section className="state-card" aria-live="polite">
          <p className="eyebrow">CHECKING FOUNDATION</p>
          <h2>Loading current state…</h2>
          <p>The popup waits for a fresh worker response before showing account data.</p>
        </section>
      )}

      {state.status === "error" && (
        <section className="state-card" role="alert">
          <p className="eyebrow">CONNECTION UNAVAILABLE</p>
          <h2>We couldn’t reach larp-code.</h2>
          <p>{state.message}</p>
          <button type="button" className="primary-button" onClick={loadSnapshot}>
            Retry
          </button>
        </section>
      )}

      {state.status === "loaded" && state.snapshot.kind === "signed_out" && (
        <SignedOut snapshot={state.snapshot} onRetry={loadSnapshot} authState={authState} onAction={sendAuthAction} />
      )}

      {state.status === "loaded" && state.snapshot.kind === "setup_required" && (
        <SetupRequired snapshot={state.snapshot} onCreate={sendAuthAction} error={setupError} />
      )}

      {state.status === "loaded" && state.snapshot.kind === "account" && (
        <MemberAccountView
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
        <ActiveView snapshot={state.snapshot} onSignOut={signOut} onAction={sendAuthAction} commandOutcome={commandOutcome} />
      )}

      {state.status === "loaded" && state.snapshot.kind === "terminal" && (
        <TerminalChallengeView snapshot={state.snapshot} onSignOut={signOut} onAction={sendAuthAction} commandOutcome={commandOutcome} />
      )}

      {state.status === "loaded"
        && state.snapshot.kind !== "signed_out"
        && state.snapshot.kind !== "setup_required"
        && state.snapshot.kind !== "account"
        && state.snapshot.kind !== "invitation"
        && state.snapshot.kind !== "scheduled"
        && state.snapshot.kind !== "active"
        && state.snapshot.kind !== "terminal" && (
        <AuthenticatedPlaceholder snapshot={state.snapshot} onSignOut={signOut} />
      )}

      <footer>
        <span>Fresh worker snapshot</span>
        {realtimeStatus !== "subscribed" && <span role="status">Live updates paused</span>}
        {state.status === "loaded" && <span>{state.snapshot.authoritativeServerTime}</span>}
      </footer>
    </main>
  );
}
