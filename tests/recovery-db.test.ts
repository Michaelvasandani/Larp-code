import { execFileSync } from "node:child_process";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it } from "vitest";

if (!("WebSocket" in globalThis)) {
  class TestWebSocket {
    close(): void { /* PostgREST-only recovery assertions. */ }
    send(): void { /* PostgREST-only recovery assertions. */ }
    addEventListener(): void { /* PostgREST-only recovery assertions. */ }
    removeEventListener(): void { /* PostgREST-only recovery assertions. */ }
  }
  Object.assign(globalThis, { WebSocket: TestWebSocket });
}

type Credentials = { url: string; anonKey: string; serviceKey: string };

function localCredentials(): Credentials | null {
  try {
    const output = execFileSync("pnpm", ["exec", "supabase", "status", "-o", "env"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const values = Object.fromEntries(output.split("\n").flatMap((line) => {
      const match = line.match(/^([A-Z_]+)="(.*)"$/);
      return match ? [[match[1], match[2]]] : [];
    }));
    if (!values.API_URL || !values.ANON_KEY || !values.SERVICE_ROLE_KEY) return null;
    return { url: values.API_URL, anonKey: values.ANON_KEY, serviceKey: values.SERVICE_ROLE_KEY };
  } catch {
    return null;
  }
}

const credentials = localCredentials();
// This suite changes a singleton write gate and is intentionally opt-in. The
// production-shaped rehearsal command runs after the ordinary parallel DB
// suite in `pnpm verify`; running it concurrently would freeze unrelated tests.
const recoveryDb = describe.skipIf(!credentials || process.env.RUN_RECOVERY_DB !== "1")("managed recovery database seam", () => {
  let admin: SupabaseClient;
  let memberId: string | undefined;

  afterAll(async () => {
    if (memberId) await admin.auth.admin.deleteUser(memberId);
  });

  it("freezes authenticated writes, validates every Gate 4 check, and reopens with a safe report", async () => {
    admin = createClient(credentials!.url, credentials!.serviceKey);
    const publicClient = createClient(credentials!.url, credentials!.anonKey);
    const email = `ticket39-${crypto.randomUUID().slice(0, 8)}@example.test`;
    const created = await admin.auth.admin.createUser({ email, password: "pass-12345", email_confirm: true });
    expect(created.error).toBeNull();
    memberId = created.data.user!.id;
    const memberClient = createClient(credentials!.url, credentials!.anonKey);
    const signedIn = await memberClient.auth.signInWithPassword({ email, password: "pass-12345" });
    expect(signedIn.error).toBeNull();

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
    expect(selected.error).toBeNull();
    expect(Date.parse(selected.data)).toBe(Date.parse(candidates[1]!));

    const incidentRef = `ticket39-${crypto.randomUUID().slice(0, 8)}`;
    const freeze = await admin.rpc("begin_recovery_freeze_v1", {
      p_incident_ref: incidentRef,
      p_fault_at: faultAt,
      p_selected_restore_point: selected.data,
    });
    expect(freeze.error).toBeNull();
    expect(freeze.data).toMatchObject({ phase: "frozen", writesBlocked: true });
    const frozenHealth = await publicClient.rpc("foundation_health_v1");
    expect(frozenHealth.error).toBeNull();
    expect(frozenHealth.data).toMatchObject({ recoveryPhase: "frozen" });

    const blockedMutation = await memberClient.rpc("create_member_account_v1", {
      p_display_name: "Blocked during recovery",
      p_adult_confirmed: true,
      p_consent_accepted: true,
      p_consent_version: "PRIV-031-v1",
    });
    expect(blockedMutation.error).not.toBeNull();
    expect(blockedMutation.error?.code).toBe("57P01");

    const restoring = await admin.rpc("begin_recovery_restore_v1");
    expect(restoring.error).toBeNull();
    const restoringHealth = await publicClient.rpc("foundation_health_v1");
    expect(restoringHealth.error).toBeNull();
    expect(restoringHealth.data).toMatchObject({ recoveryPhase: "restoring" });
    const validation = await admin.rpc("validate_recovery_v1", { p_evidence: { mailIntegration: true } });
    expect(validation.error).toBeNull();
    expect(validation.data).toMatchObject({ readyToReopen: true, failedChecks: [] });
    expect(Object.values(validation.data.checks)).toEqual(expect.arrayContaining([true]));

    const report = await admin.rpc("reopen_after_recovery_v1", {
      p_validation_id: validation.data.validationId,
      p_report: {
        scenario: "destructive-incident",
        selectedRestorePoint: selected.data,
        measured: {
          freezeMilliseconds: 10,
          restoreMilliseconds: 20,
          retryOutcome: "replayed_by_same_key",
          ordinaryInterruption: "same_key_replayed_exactly_once",
          catastrophicRestore: "acknowledged_transactions_after_selected_point_may_be_lost",
        },
        failures: [],
        correctiveActions: ["Re-run after managed provider configuration changes."],
        memberDataIncluded: false,
        absoluteZeroDataLossGuarantee: false,
      },
    });
    expect(report.error).toBeNull();
    expect(report.data).toMatchObject({ phase: "open", writesBlocked: false });
    const reopenedHealth = await publicClient.rpc("foundation_health_v1");
    expect(reopenedHealth.error).toBeNull();
    expect(reopenedHealth.data).toMatchObject({ recoveryPhase: "open", schemaVersion: 14 });

    const reportRow = await admin.from("recovery_reports")
      .select("scenario,selected_restore_point,validation_checks,member_data_included,absolute_zero_data_loss_guarantee,measured,failures,corrective_actions")
      .eq("incident_ref", incidentRef)
      .single();
    expect(reportRow.error).toBeNull();
    expect(reportRow.data).toMatchObject({
      scenario: "destructive-incident",
      member_data_included: false,
      absolute_zero_data_loss_guarantee: false,
    });
    expect(Object.keys(reportRow.data?.validation_checks ?? {})).toHaveLength(12);
    expect(JSON.stringify(reportRow.data)).not.toMatch(/email|token|secret|password|otp/i);
  });
});

void recoveryDb;
