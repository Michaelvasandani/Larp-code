import { useCallback, useEffect, useState } from "react";

import {
  PROTOCOL_VERSION,
  type AppSnapshot,
  type PopupResponse,
} from "../shared/protocol";

type LoadState =
  | { status: "loading" }
  | { status: "loaded"; snapshot: AppSnapshot }
  | { status: "error"; message: string };

async function requestSnapshot(): Promise<AppSnapshot> {
  const response = await chrome.runtime.sendMessage({
    version: PROTOCOL_VERSION,
    type: "get_snapshot",
  });
  const typedResponse = response as PopupResponse;
  if (!typedResponse.ok) throw new Error(typedResponse.error.message);
  return typedResponse.snapshot;
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

function SignedOut({ snapshot, onRetry }: { snapshot: AppSnapshot; onRetry: () => void }) {
  return (
    <section className="state-card" aria-labelledby="signed-out-title">
      <p className="eyebrow">MEMBER ACCOUNT</p>
      <h2 id="signed-out-title">You’re signed out</h2>
      <p>
        Sign in with your email to enter a shared NeetCode 150 Challenge. Your
        email remains your sole account and recovery authority.
      </p>
      <button type="button" className="primary-button" disabled>
        Email sign-in arrives next
      </button>
      <button type="button" className="text-button" onClick={onRetry}>
        Refresh connection
      </button>
      <SnapshotDetails snapshot={snapshot} />
    </section>
  );
}

function AuthenticatedPlaceholder({ snapshot }: { snapshot: AppSnapshot }) {
  return (
    <section className="state-card" aria-labelledby="placeholder-title">
      <p className="eyebrow">LARP-CODE</p>
      <h2 id="placeholder-title">Foundation connected</h2>
      <p>The authenticated Challenge states will be added behind this contract.</p>
      <SnapshotDetails snapshot={snapshot} />
    </section>
  );
}

export function App() {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  const loadSnapshot = useCallback(() => {
    setState({ status: "loading" });
    void requestSnapshot()
      .then((snapshot) => setState({ status: "loaded", snapshot }))
      .catch((error: unknown) => {
        setState({
          status: "error",
          message: error instanceof Error ? error.message : "The connection is unavailable.",
        });
      });
  }, []);

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
        <SignedOut snapshot={state.snapshot} onRetry={loadSnapshot} />
      )}

      {state.status === "loaded" && state.snapshot.kind !== "signed_out" && (
        <AuthenticatedPlaceholder snapshot={state.snapshot} />
      )}

      <footer>
        <span>Fresh worker snapshot</span>
        {state.status === "loaded" && <span>{state.snapshot.authoritativeServerTime}</span>}
      </footer>
    </main>
  );
}
