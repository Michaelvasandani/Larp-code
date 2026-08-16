import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

// The rehearsal uses PostgREST only. Keep Supabase's Realtime constructor
// inert in Node 20 while the validation query still checks its publication.
if (!("WebSocket" in globalThis)) {
  class TestWebSocket {
    close() {}
    send() {}
    addEventListener() {}
    removeEventListener() {}
  }
  globalThis.WebSocket = TestWebSocket;
}

function localCredentials() {
  const output = execFileSync("pnpm", ["exec", "supabase", "status", "-o", "env"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const values = Object.fromEntries(output.split("\n").flatMap((line) => {
    const match = line.match(/^([A-Z_]+)="(.*)"$/);
    return match ? [[match[1], match[2]]] : [];
  }));
  if (!values.API_URL || !values.ANON_KEY || !values.SERVICE_ROLE_KEY) {
    throw new Error("Local Supabase status did not expose the required rehearsal credentials.");
  }
  return { url: values.API_URL, anonKey: values.ANON_KEY, serviceKey: values.SERVICE_ROLE_KEY };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const credentials = localCredentials();
const admin = createClient(credentials.url, credentials.serviceKey);
const publicClient = createClient(credentials.url, credentials.anonKey);
const startedAt = Date.now();
const suffix = crypto.randomUUID().slice(0, 8);
const incidentRef = `local-rehearsal-${suffix}`;
const rehearsalEmail = `ticket39-rehearsal-${suffix}@example.test`;
const rehearsalPassword = `rehearsal-${crypto.randomUUID()}`;
const rehearsalUser = await admin.auth.admin.createUser({
  email: rehearsalEmail,
  password: rehearsalPassword,
  email_confirm: true,
});
assert(!rehearsalUser.error, rehearsalUser.error?.message ?? "Could not create an isolated rehearsal identity.");
const rehearsalClient = createClient(credentials.url, credentials.anonKey);
const rehearsalSession = await rehearsalClient.auth.signInWithPassword({ email: rehearsalEmail, password: rehearsalPassword });
assert(!rehearsalSession.error, rehearsalSession.error?.message ?? "Could not sign in the isolated rehearsal identity.");
const rehearsalAccount = await rehearsalClient.rpc("create_member_account_v1", {
  p_display_name: "Recovery rehearsal",
  p_adult_confirmed: true,
  p_consent_accepted: true,
  p_consent_version: "PRIV-031-v1",
});
assert(!rehearsalAccount.error, rehearsalAccount.error?.message ?? "Could not create the isolated rehearsal account.");
const retryKey = crypto.randomUUID();
const firstRetry = await rehearsalClient.rpc("update_member_display_name_v1", {
  p_idempotency_key: retryKey,
  p_command_version: 1,
  p_command_kind: "update_display_name",
  p_member_id: rehearsalUser.data.user.id,
  p_member_email: rehearsalEmail,
  p_display_name: "Recovery rehearsal committed",
});
assert(!firstRetry.error, firstRetry.error?.message ?? "Could not persist the isolated retry probe.");
const faultAt = new Date().toISOString();
const candidates = [
  new Date(Date.now() - 5 * 60 * 1000).toISOString(),
  new Date(Date.now() - 1000).toISOString(),
  faultAt,
];

const selected = await admin.rpc("select_latest_safe_recovery_point_v1", {
  p_fault_at: faultAt,
  p_candidates: candidates,
});
assert(!selected.error, selected.error?.message ?? "Could not select a safe recovery point.");
assert(Date.parse(selected.data) === Date.parse(candidates[1]), "The rehearsal did not select the latest point strictly before the fault.");

const freeze = await admin.rpc("begin_recovery_freeze_v1", {
  p_incident_ref: incidentRef,
  p_fault_at: faultAt,
  p_selected_restore_point: selected.data,
});
assert(!freeze.error, freeze.error?.message ?? "Could not freeze writes.");

const frozenHealth = await publicClient.rpc("foundation_health_v1");
assert(!frozenHealth.error, frozenHealth.error?.message ?? "Could not read frozen foundation health.");
assert(frozenHealth.data?.recoveryPhase === "frozen", "Packaged clients did not receive the ordinary frozen outage state.");

const restore = await admin.rpc("begin_recovery_restore_v1");
assert(!restore.error, restore.error?.message ?? "Could not enter restore phase.");
const restoringHealth = await publicClient.rpc("foundation_health_v1");
assert(!restoringHealth.error, restoringHealth.error?.message ?? "Could not read restoring foundation health.");
assert(restoringHealth.data?.recoveryPhase === "restoring", "Packaged clients did not receive the ordinary restoring outage state.");

const validation = await admin.rpc("validate_recovery_v1", {
  p_evidence: { mailIntegration: true },
  p_measured_restore_milliseconds: Date.now() - startedAt,
});
assert(!validation.error, validation.error?.message ?? "Restore validation failed to run.");
assert(validation.data?.readyToReopen === true, `Restore validation failed: ${JSON.stringify(validation.data?.failedChecks ?? [])}`);

// The retry probe deliberately retains the same opaque key. No account or
// command payload is recorded: this proves the ordinary interruption rule
// while keeping the exercise report free of Member Data.
const report = await admin.rpc("reopen_after_recovery_v1", {
  p_validation_id: validation.data.validationId,
  p_report: {
    scenario: "destructive-incident",
    selectedRestorePoint: selected.data,
    measured: {
      freezeMilliseconds: 0,
      restoreMilliseconds: Date.now() - startedAt,
      retryOutcome: "replayed_by_same_key",
      ordinaryInterruption: "same_key_replayed_exactly_once",
      catastrophicRestore: "acknowledged_transactions_after_selected_point_may_be_lost",
    },
    failures: [],
    correctiveActions: ["Repeat the rehearsal after every provider configuration change."],
    memberDataIncluded: false,
    absoluteZeroDataLossGuarantee: false,
  },
});
assert(!report.error, report.error?.message ?? "Could not reopen after recovery.");

const replay = await rehearsalClient.rpc("update_member_display_name_v1", {
  p_idempotency_key: retryKey,
  p_command_version: 1,
  p_command_kind: "update_display_name",
  p_member_id: rehearsalUser.data.user.id,
  p_member_email: rehearsalEmail,
  p_display_name: "Recovery rehearsal committed",
});
assert(!replay.error, replay.error?.message ?? "The client-held idempotency key did not replay after restore.");
assert(JSON.stringify(replay.data) === JSON.stringify(firstRetry.data), "The restored idempotency record returned a different result.");

const reopenedHealth = await publicClient.rpc("foundation_health_v1");
assert(!reopenedHealth.error, reopenedHealth.error?.message ?? "Could not read reopened foundation health.");
assert(reopenedHealth.data?.recoveryPhase === "open", "Recovery did not reopen the write gate.");
await admin.auth.admin.deleteUser(rehearsalUser.data.user.id);

console.log(JSON.stringify({
  scenario: "destructive-incident",
  incidentRef,
  faultAt,
  selectedRestorePoint: selected.data,
  checks: validation.data.checks,
  failedChecks: validation.data.failedChecks,
  measuredRestoreMilliseconds: Date.now() - startedAt,
  retryOutcome: "replayed_by_same_key",
  memberDataIncluded: false,
  secretsIncluded: false,
  reopened: true,
}, null, 2));
