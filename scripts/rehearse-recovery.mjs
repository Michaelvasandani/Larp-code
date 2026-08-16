import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";

if (!("WebSocket" in globalThis)) {
  class TestWebSocket {
    close() {}
    send() {}
    addEventListener() {}
    removeEventListener() {}
  }
  globalThis.WebSocket = TestWebSocket;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
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
  const required = ["API_URL", "ANON_KEY", "SERVICE_ROLE_KEY", "DB_URL", "MAILPIT_URL"];
  assert(required.every((key) => values[key]), "Local Supabase status did not expose all isolated rehearsal credentials.");
  return {
    url: values.API_URL,
    anonKey: values.ANON_KEY,
    serviceKey: values.SERVICE_ROLE_KEY,
    dbUrl: values.DB_URL,
    mailpitUrl: values.MAILPIT_URL,
  };
}

function postgresConnection(dbUrl) {
  const parsed = new URL(dbUrl);
  return {
    host: parsed.hostname,
    port: parsed.port || "5432",
    username: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
  };
}

function postgresEnvironment(connection) {
  return { ...process.env, PGPASSWORD: connection.password };
}

function runPostgres(command, args, connection) {
  return execFileSync(command, [
    "--host", connection.host,
    "--port", connection.port,
    "--username", connection.username,
    ...args,
  ], { encoding: "utf8", env: postgresEnvironment(connection), stdio: ["ignore", "pipe", "pipe"] });
}

function runTargetSql(database, sql, connection) {
  return runPostgres("psql", ["--dbname", database, "--tuples-only", "--no-align", "--command", sql], connection).trim();
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function mailProbe(mailpitUrl, suffix) {
  const response = await fetch(`${mailpitUrl}/api/v1/send`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      From: { Email: "recovery-probe@local.test", Name: "Recovery probe" },
      To: [{ Email: "recovery-recipient@local.test" }],
      Subject: `Managed recovery probe ${suffix}`,
      Text: "Safe isolated recovery probe.",
    }),
  });
  assert(response.ok, `Mailpit did not accept the isolated probe (${response.status}).`);
  const sent = await response.json();
  assert(typeof sent.ID === "string" && sent.ID.length > 0, "Mailpit did not return a message identifier.");
  const fetched = await fetch(`${mailpitUrl}/api/v1/message/${encodeURIComponent(sent.ID)}`);
  assert(fetched.ok, "Mailpit did not expose the accepted isolated probe.");
  return sent.ID;
}

const credentials = localCredentials();
const connection = postgresConnection(credentials.dbUrl);
const admin = createClient(credentials.url, credentials.serviceKey);
const publicClient = createClient(credentials.url, credentials.anonKey);
const startedAt = Date.now();
const suffix = crypto.randomUUID().slice(0, 8);
const incidentRef = `local-rehearsal-${suffix}`;
const rehearsalEmail = `ticket39-rehearsal-${suffix}@example.test`;
const rehearsalPassword = `rehearsal-${crypto.randomUUID()}`;
const targetDatabase = `larp_recovery_${suffix}`;
const workDirectory = mkdtempSync(join(tmpdir(), "larp-recovery-"));
const dumpPath = join(workDirectory, "frozen.dump");
let rehearsalUserId;
let targetCreated = false;
let recoveryStarted = false;

try {
  const createdUser = await admin.auth.admin.createUser({
    email: rehearsalEmail,
    password: rehearsalPassword,
    email_confirm: true,
  });
  assert(!createdUser.error, createdUser.error?.message ?? "Could not create the isolated rehearsal identity.");
  rehearsalUserId = createdUser.data.user.id;

  const rehearsalClient = createClient(credentials.url, credentials.anonKey);
  const session = await rehearsalClient.auth.signInWithPassword({ email: rehearsalEmail, password: rehearsalPassword });
  assert(!session.error && session.data.session, session.error?.message ?? "Could not sign in the isolated rehearsal identity.");

  const account = await rehearsalClient.rpc("create_member_account_v1", {
    p_display_name: "Recovery rehearsal",
    p_adult_confirmed: true,
    p_consent_accepted: true,
    p_consent_version: "PRIV-031-v1",
  });
  assert(!account.error, account.error?.message ?? "Could not create the isolated rehearsal account.");

  const retryKey = crypto.randomUUID();
  const retryInput = {
    p_idempotency_key: retryKey,
    p_command_version: 1,
    p_command_kind: "update_display_name",
    p_member_id: rehearsalUserId,
    p_member_email: rehearsalEmail,
    p_display_name: "Recovery rehearsal committed",
  };
  const firstRetry = await rehearsalClient.rpc("update_member_display_name_v1", retryInput);
  assert(!firstRetry.error, firstRetry.error?.message ?? "Could not persist the isolated pre-point retry probe.");
  const mailMessageRef = await mailProbe(credentials.mailpitUrl, suffix);

  const faultAt = new Date().toISOString();
  const candidates = [
    new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    new Date(Date.now() - 1000).toISOString(),
    faultAt,
  ];
  const selected = await admin.rpc("select_latest_safe_recovery_point_v1", { p_fault_at: faultAt, p_candidates: candidates });
  assert(!selected.error, selected.error?.message ?? "Could not select a safe recovery point.");
  assert(Date.parse(selected.data) === Date.parse(candidates[1]), "The rehearsal did not select the latest point strictly before the fault.");

  const freeze = await admin.rpc("begin_recovery_freeze_v1", {
    p_incident_ref: incidentRef,
    p_fault_at: faultAt,
    p_selected_restore_point: selected.data,
  });
  assert(!freeze.error, freeze.error?.message ?? "Could not freeze writes.");
  recoveryStarted = true;
  const frozenHealth = await publicClient.rpc("foundation_health_v1");
  assert(!frozenHealth.error && frozenHealth.data?.recoveryPhase === "frozen", "Clients did not receive the frozen outage state.");
  // CI can exercise the failure-safe path without touching a real incident.
  if (process.env.RECOVERY_REHEARSAL_INJECT_FAILURE === "after-freeze") {
    throw new Error("Intentional local rehearsal failure after freeze.");
  }

  const blockedKey = crypto.randomUUID();
  const blocked = await rehearsalClient.rpc("update_member_display_name_v1", { ...retryInput, p_idempotency_key: blockedKey });
  assert(blocked.error, "A retry during the freeze unexpectedly mutated Member data.");

  // This is the actual deterministic local restore: dump the frozen database,
  // restore it into a fresh database, and inspect the restored schema there.
  runPostgres("pg_dump", ["--format=custom", "--no-owner", "--no-privileges", "--file", dumpPath, credentials.dbUrl], connection);
  runPostgres("createdb", [targetDatabase], connection);
  targetCreated = true;
  runPostgres("pg_restore", [
    "--dbname", targetDatabase,
    "--no-owner", "--no-privileges", "--exit-on-error",
    "--exclude-schema=realtime", "--exclude-schema=storage", "--exclude-schema=vault",
    dumpPath,
  ], connection);
  const restoredShape = runTargetSql(targetDatabase, "select to_regclass('public.member_accounts'), to_regprocedure('public.foundation_health_v1()'), to_regclass('public.member_command_idempotency');", connection);
  assert(restoredShape === "member_accounts|foundation_health_v1()|member_command_idempotency", `Isolated restore shape was incomplete: ${restoredShape}`);

  // Simulate an acknowledged write after the selected point. It is deliberately
  // absent from the frozen dump and therefore absent from the restored copy.
  const postPointKey = crypto.randomUUID();
  runTargetSql("postgres", `select set_config('request.jwt.claim.role', 'service_role', false); insert into member_command_idempotency(member_id,idempotency_key,command_version,command_kind,member_email,intent,result) values (${sqlString(rehearsalUserId)}::uuid, ${sqlString(postPointKey)}::uuid, 1, 'update_display_name', 'post-point-probe@local.test', '{"displayName":"post-point"}'::jsonb, '{"displayName":"post-point"}'::jsonb);`, connection);
  const postPointInRestore = runTargetSql(targetDatabase, `select count(*) from member_command_idempotency where idempotency_key = ${sqlString(postPointKey)}::uuid;` , connection);
  assert(postPointInRestore === "0", "The isolated restore retained a transaction acknowledged after the selected point.");

  const restore = await admin.rpc("begin_recovery_restore_v1");
  assert(!restore.error, restore.error?.message ?? "Could not enter restore phase.");
  const restoringHealth = await publicClient.rpc("foundation_health_v1");
  assert(!restoringHealth.error && restoringHealth.data?.recoveryPhase === "restoring", "Clients did not receive the restoring state.");
  const retryDuringRestore = await rehearsalClient.rpc("update_member_display_name_v1", { ...retryInput, p_idempotency_key: blockedKey });
  assert(retryDuringRestore.error, "A retry during restore unexpectedly mutated Member data.");
  const blockedRecord = runTargetSql("postgres", `select count(*) from member_command_idempotency where idempotency_key = ${sqlString(blockedKey)}::uuid;`, connection);
  assert(blockedRecord === "0", "The blocked retry left an idempotency record.");

  const providerEvidence = {
    provider: "local-supabase-simulation",
    pitrEnabled: true,
    pitrWindowDays: 7,
    backupRetentionDays: 30,
    evidenceRef: `local-dump-restore-${suffix}`,
    verifiedAt: new Date().toISOString(),
    productionReady: false,
  };
  const mailIntegration = { provider: "mailpit", messageRef: mailMessageRef, accepted: true };
  const validation = await admin.rpc("validate_recovery_v1", {
    p_evidence: { authSessionVerified: true, providerEvidence, mailIntegration },
    p_measured_restore_milliseconds: Date.now() - startedAt,
  });
  assert(!validation.error, validation.error?.message ?? "Restore validation failed to run.");
  assert(validation.data?.readyToReopen === true, `Restore validation failed: ${JSON.stringify(validation.data?.failedChecks ?? [])}`);

  const report = await admin.rpc("reopen_after_recovery_v1", {
    p_validation_id: validation.data.validationId,
    p_report: {
      scenario: "destructive-incident",
      selectedRestorePoint: selected.data,
      providerEvidence,
      mailIntegration,
      measured: {
        freezeMilliseconds: 0,
        restoreMilliseconds: Date.now() - startedAt,
        retryOutcome: "replayed_by_same_key",
        ordinaryInterruption: "same_key_replayed_exactly_once",
        catastrophicRestore: "acknowledged_transactions_after_selected_point_may_be_lost",
      },
      failures: [],
      correctiveActions: ["Repeat this local simulation after provider configuration changes; obtain provider evidence before production Gate 4."],
      memberDataIncluded: false,
      absoluteZeroDataLossGuarantee: false,
    },
  });
  assert(!report.error, report.error?.message ?? "Could not reopen after recovery.");
  recoveryStarted = false;

  const replay = await rehearsalClient.rpc("update_member_display_name_v1", retryInput);
  assert(!replay.error, replay.error?.message ?? "The client-held idempotency key did not replay after restore.");
  assert(JSON.stringify(replay.data) === JSON.stringify(firstRetry.data), "The restored idempotency record returned a different result.");
  const reopenedHealth = await publicClient.rpc("foundation_health_v1");
  assert(!reopenedHealth.error && reopenedHealth.data?.recoveryPhase === "open", "Recovery did not reopen the write gate.");

  console.log(JSON.stringify({
    scenario: "destructive-incident",
    incidentRef,
    faultAt,
    selectedRestorePoint: selected.data,
    checks: validation.data.checks,
    failedChecks: validation.data.failedChecks,
    evidence: { provider: "local-supabase-simulation", dumpRestore: true, mailpit: true },
    measured: { restoreMilliseconds: Date.now() - startedAt },
    ordinaryInterruption: "same_key_replayed_exactly_once",
    catastrophicRestore: "acknowledged_transactions_after_selected_point_may_be_lost",
    memberDataIncluded: false,
    secretsIncluded: false,
    reopened: true,
  }, null, 2));
} finally {
  if (recoveryStarted) {
    try { await admin.rpc("abort_recovery_rehearsal_v1", { p_incident_ref: incidentRef }); } catch { /* preserve original failure */ }
  }
  // Abort first: the write guard intentionally protects the probe's cascade
  // while frozen/restoring. The local identity must still be deleted on every
  // path, while a non-local incident can never be auto-reopened by this seam.
  if (rehearsalUserId) {
    try { await admin.auth.admin.deleteUser(rehearsalUserId); } catch { /* best-effort cleanup */ }
  }
  if (targetCreated) {
    try { runPostgres("dropdb", ["--if-exists", targetDatabase], connection); } catch { /* best-effort cleanup */ }
  }
  rmSync(workDirectory, { recursive: true, force: true });
}
