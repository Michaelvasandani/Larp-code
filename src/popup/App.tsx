import { useCallback, useEffect, useState } from "react";

import {
  isPopupResponse,
  PROTOCOL_VERSION,
  SIGN_IN_STATUS_METADATA,
  type AppSnapshot,
  type PopupRequest,
  type PopupResponse,
  type SignInState,
} from "../shared/protocol";

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
  onAction: (request: PopupRequest) => Promise<void>;
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
  onSignOut: () => Promise<void>;
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

export function App() {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [authState, setAuthState] = useState<SignInState>(defaultSignInState);

  const loadSnapshot = useCallback(() => {
    setState({ status: "loading" });
    void requestSnapshot()
      .then((snapshot) => {
        setAuthState(defaultSignInState);
        setState({ status: "loaded", snapshot });
      })
      .catch((error: unknown) => {
        setState({
          status: "error",
          message: error instanceof Error ? error.message : "The connection is unavailable.",
        });
      });
  }, []);

  const sendAuthAction = useCallback(async (request: PopupRequest) => {
    if (request.type === "verify_email_otp") setAuthState({ status: "verifying" });
    if (request.type === "request_email_otp" || request.type === "resend_email_otp") {
      setAuthState({ status: "requesting_code" });
    }
    try {
      const response = await sendRequest(request);
      if (!response.ok) {
        if (response.error.code === "connection_unavailable") setAuthState({ status: "service_unavailable" });
        return;
      }
      if (response.auth) setAuthState(response.auth);
      if (response.snapshot) {
        setState({ status: "loaded", snapshot: response.snapshot });
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
    } catch {
      setAuthState({ status: "service_unavailable" });
    }
  }, []);

  const signOut = useCallback(
    () => sendAuthAction({ version: PROTOCOL_VERSION, type: "sign_out" }),
    [sendAuthAction],
  );

  useEffect(() => {
    const port = chrome.runtime.connect({ name: `larp-code-popup-v${PROTOCOL_VERSION}` });
    loadSnapshot();
    return () => port.disconnect();
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

      {state.status === "loaded" && state.snapshot.kind !== "signed_out" && (
        <AuthenticatedPlaceholder snapshot={state.snapshot} onSignOut={signOut} />
      )}

      <footer>
        <span>Fresh worker snapshot</span>
        {state.status === "loaded" && <span>{state.snapshot.authoritativeServerTime}</span>}
      </footer>
    </main>
  );
}
