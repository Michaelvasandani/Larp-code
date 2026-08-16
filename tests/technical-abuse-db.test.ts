import { execFileSync } from "node:child_process";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

if (!("WebSocket" in globalThis)) {
  class TestWebSocket {
    close(): void { /* no realtime assertions in this test */ }
    send(): void { /* no realtime assertions in this test */ }
    addEventListener(): void { /* no realtime assertions in this test */ }
    removeEventListener(): void { /* no realtime assertions in this test */ }
  }
  Object.assign(globalThis, { WebSocket: TestWebSocket });
}

type Credentials = { url: string; anonKey: string; serviceKey: string };
type Profile = { id: string; email: string; client: SupabaseClient };

function localCredentials(): Credentials | null {
  try {
    const output = execFileSync("pnpm", ["exec", "supabase", "status", "-o", "env"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
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
const abuseDb = describe.skipIf(!credentials)("technical-abuse boundary against local Supabase", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  let admin: SupabaseClient;

  async function profile(name: string): Promise<Profile> {
    const email = `ticket34-${name}-${suffix}@example.test`;
    const created = await admin.auth.admin.createUser({ email, password: "pass-12345", email_confirm: true });
    expect(created.error).toBeNull();
    const client = createClient(credentials!.url, credentials!.anonKey);
    const signedIn = await client.auth.signInWithPassword({ email, password: "pass-12345" });
    expect(signedIn.error).toBeNull();
    let account = await client.rpc("create_member_account_v1", {
      p_display_name: name,
      p_adult_confirmed: true,
      p_consent_accepted: true,
      p_consent_version: "PRIV-031-v1",
    });
    for (let retry = 0; retry < 3 && account.error?.code === "PGRST303"; retry += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      account = await client.rpc("create_member_account_v1", {
        p_display_name: name,
        p_adult_confirmed: true,
        p_consent_accepted: true,
        p_consent_version: "PRIV-031-v1",
      });
    }
    expect(account.error).toBeNull();
    return { id: created.data.user!.id, email, client };
  }

  it("suspends only for technical abuse and ends all shared access atomically", async () => {
    admin = createClient(credentials!.url, credentials!.serviceKey);
    const target = await profile("Target");
    const partner = await profile("Partner");
    const invitation = await admin.from("invitations").insert({
      inviter_id: target.id,
      invited_email: partner.email,
      challenge_time_zone: "UTC",
      start_date: "2099-01-01",
      deadline_date: "2099-01-30",
      problem_set_version_id: "neetcode-150-2026-08-15",
    }).select("id").single();
    expect(invitation.error).toBeNull();

    const challenge = await admin.from("challenges").insert({
      invitation_id: invitation.data!.id,
      inviter_id: target.id,
      invited_member_id: partner.id,
      challenge_time_zone: "UTC",
      start_date: "2020-01-01",
      deadline_date: "2030-01-30",
      problem_set_version_id: "neetcode-150-2026-08-15",
      status: "scheduled",
    }).select("id").single();
    expect(challenge.error).toBeNull();
    expect((await admin.from("challenge_members").insert([
      { challenge_id: challenge.data!.id, member_id: target.id, member_email: target.email, display_name: "Target" },
      { challenge_id: challenge.data!.id, member_id: partner.id, member_email: partner.email, display_name: "Partner" },
    ])).error).toBeNull();
    expect((await admin.from("member_commitments").insert([
      { member_id: target.id, challenge_id: challenge.data!.id },
      { member_id: partner.id, challenge_id: challenge.data!.id },
    ])).error).toBeNull();
    const outsider = await profile("Outsider");
    const outsiderChallenge = await outsider.client.rpc("get_challenge_v1", { p_challenge_id: challenge.data!.id });
    expect(outsiderChallenge.error).toBeNull();
    expect(outsiderChallenge.data).toBeNull();
    const outsiderRows = await outsider.client.from("challenge_members").select("member_id").eq("challenge_id", challenge.data!.id);
    expect(outsiderRows.error).toBeNull();
    expect(outsiderRows.data).toEqual([]);

    const rejectedReason = await admin.rpc("suspend_member_account_v1", {
      p_member_id: target.id,
      p_reason: "interpersonal_conflict",
      p_operator_id: "operator-test",
    });
    expect(rejectedReason.error?.code).toBe("22023");

    const suspended = await admin.rpc("suspend_member_account_v1", {
      p_member_id: target.id,
      p_reason: "authorization_bypass",
      p_operator_id: "operator-test",
    });
    expect(suspended.error).toBeNull();
    expect(suspended.data).toMatchObject({ status: "suspended", memberId: target.id });

    expect((await admin.from("member_accounts").select("status").eq("id", target.id).single()).data?.status).toBe("suspended");
    const refreshedTarget = await target.client.auth.refreshSession();
    expect(refreshedTarget.data.session).toBeNull();
    expect(refreshedTarget.error).not.toBeNull();
    expect((await admin.from("invitations").select("status").eq("id", invitation.data!.id).single()).data?.status).toBe("revoked");
    expect((await admin.from("member_commitments").select("member_id").eq("challenge_id", challenge.data!.id)).data).toHaveLength(0);
    expect((await admin.from("challenges").select("status,terminal_reason,terminal_at").eq("id", challenge.data!.id).single()).data).toMatchObject({
      status: "abandoned",
      terminal_reason: "member_suspended",
    });
    const accountEndedNotice = await admin.from("transactional_notices").select("notice_type,recipient_member_id,recipient_email")
      .eq("source_event_key", `challenge:${challenge.data!.id}:account-ended`);
    expect(accountEndedNotice.error).toBeNull();
    expect(accountEndedNotice.data).toEqual([expect.objectContaining({
      notice_type: "challenge_account_ended",
      recipient_member_id: partner.id,
      recipient_email: partner.email.toLowerCase(),
    })]);
    const partnerView = await partner.client.rpc("get_challenge_v1", { p_challenge_id: challenge.data!.id });
    expect(partnerView.error).toBeNull();
    expect(partnerView.data).toMatchObject({ status: "abandoned" });
    expect(partnerView.data.progress).toBeUndefined();
    expect(partnerView.data.members).toEqual(expect.arrayContaining([
      expect.objectContaining({ memberId: target.id, email: "Suspended Member", displayName: "Suspended Member" }),
    ]));

    const staleChallengeRows = await target.client.from("challenges").select("id").eq("id", challenge.data!.id);
    const staleMemberRows = await target.client.from("challenge_members").select("member_id").eq("challenge_id", challenge.data!.id);
    const staleSolveRows = await target.client.from("solves").select("id").eq("challenge_id", challenge.data!.id);
    expect(staleChallengeRows.error).toBeNull();
    expect(staleMemberRows.error).toBeNull();
    expect(staleSolveRows.error).toBeNull();
    expect(staleChallengeRows.data).toEqual([]);
    expect(staleMemberRows.data).toEqual([]);
    expect(staleSolveRows.data).toEqual([]);
    const staleSnapshot = await target.client.rpc("get_challenge_v1", { p_challenge_id: challenge.data!.id });
    expect(staleSnapshot.error).toBeNull();
    expect(staleSnapshot.data).toBeNull();

    const staleSolve = await admin.from("solves").insert({
      member_id: target.id, challenge_id: challenge.data!.id, problem_id: "problem:0217-contains-duplicate",
    }).select("id").single();
    expect(staleSolve.error).toBeNull();
    const staleSolveAfterInsert = await target.client.from("solves").select("id").eq("id", staleSolve.data!.id);
    expect(staleSolveAfterInsert.error).toBeNull();
    expect(staleSolveAfterInsert.data).toEqual([]);

    const staleCorrection = await target.client.rpc("correct_solve_v1", {
      p_idempotency_key: crypto.randomUUID(), p_command_version: 1, p_command_kind: "correct_solve",
      p_member_id: target.id, p_member_email: target.email, p_challenge_id: challenge.data!.id,
      p_solve_id: staleSolve.data!.id, p_category: "retracted", p_reason: "stale token", p_resulting_credit_status: "not_credited",
    });
    expect(staleCorrection.error?.code).toBe("42501");

    const targetMutation = await target.client.rpc("create_invitation_v1", {
      p_idempotency_key: crypto.randomUUID(), p_command_version: 1, p_command_kind: "create_invitation",
      p_member_id: target.id, p_member_email: target.email, p_invited_email: "another@example.test",
      p_challenge_time_zone: "UTC", p_start_date: "2099-01-01", p_deadline_date: "2099-01-30",
      p_problem_set_version_id: "neetcode-150-2026-08-15",
    });
    expect(targetMutation.error?.code).toBe("42501");
  });

  it("keeps diagnostic support disabled until a bounded least-privilege grant exists", async () => {
    admin = createClient(credentials!.url, credentials!.serviceKey);
    const member = await profile("Support");
    const safe = await admin.rpc("record_security_event_v1", {
      p_event_key: `diagnostic:${member.id}`,
      p_event_type: "diagnostic",
      p_diagnostic_id: "018F7C3D54",
      p_subject_member_id: member.id,
      p_details: { code: "connection_unavailable" },
    });
    expect(safe.error).toBeNull();
    const unsafe = await admin.rpc("record_security_event_v1", {
      p_event_key: `diagnostic-unsafe:${member.id}`,
      p_event_type: "diagnostic",
      p_subject_member_id: member.id,
      p_details: { email: member.email, token: "123456" },
    });
    expect(unsafe.error?.code).toBe("22023");
    const valueUnsafe = await admin.rpc("record_security_event_v1", {
      p_event_key: `diagnostic-value-unsafe:${member.id}`,
      p_event_type: "diagnostic",
      p_subject_member_id: member.id,
      p_details: { note: member.email },
    });
    expect(valueUnsafe.error?.code).toBe("22023");
    const embeddedUnsafe = await admin.rpc("record_security_event_v1", {
      p_event_key: `diagnostic-embedded:${member.id}`,
      p_event_type: "diagnostic",
      p_subject_member_id: member.id,
      p_details: { code: `OTP 123456 for ${member.email}` },
    });
    expect(embeddedUnsafe.error?.code).toBe("22023");
    const nestedEmbeddedUnsafe = await admin.rpc("record_security_event_v1", {
      p_event_key: `diagnostic-nested-embedded:${member.id}`,
      p_event_type: "diagnostic",
      p_subject_member_id: member.id,
      p_details: { code: [`OTP 123456 for ${member.email}`] },
    });
    expect(nestedEmbeddedUnsafe.error?.code).toBe("22023");
    const rawEventKey = await admin.rpc("record_security_event_v1", {
      p_event_key: `diagnostic:${member.email}`,
      p_event_type: "diagnostic",
      p_subject_member_id: member.id,
    });
    expect(rawEventKey.error?.code).toBe("22023");

    const denied = await member.client.rpc("get_support_diagnostics_v1", {
      p_operator_id: "operator-test",
      p_grant_id: crypto.randomUUID(),
    });
    expect(denied.error?.code).toBe("42501");

    const unbounded = await admin.rpc("grant_support_diagnostic_access_v1", {
      p_operator_id: "operator-test",
      p_member_id: member.id,
      p_expires_at: "2099-01-01T00:00:00Z",
    });
    expect(unbounded.error?.code).toBe("22023");

    const grant = await admin.rpc("grant_support_diagnostic_access_v1", {
      p_operator_id: "operator-test",
      p_member_id: member.id,
      p_expires_at: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
    });
    expect(grant.error).toBeNull();
    const diagnostics = await admin.rpc("get_support_diagnostics_v1", {
      p_operator_id: "operator-test",
      p_grant_id: grant.data,
    });
    expect(diagnostics.error).toBeNull();
    expect(diagnostics.data).toEqual([
      expect.objectContaining({ eventType: "diagnostic", diagnosticId: "018F7C3D54", details: { code: "connection_unavailable" } }),
    ]);
    const revoked = await admin.rpc("revoke_support_diagnostic_access_v1", {
      p_operator_id: "operator-test",
      p_grant_id: grant.data,
    });
    expect(revoked.error).toBeNull();
    expect(revoked.data).toBe(true);
    const afterRevoke = await admin.rpc("get_support_diagnostics_v1", {
      p_operator_id: "operator-test",
      p_grant_id: grant.data,
    });
    expect(afterRevoke.error?.code).toBe("42501");
  });

  it("shares the OTP account and destination buckets across browser clients", async () => {
    admin = createClient(credentials!.url, credentials!.serviceKey);
    const member = await profile("OtpShared");
    const secondBrowser = createClient(credentials!.url, credentials!.anonKey);
    const signedIn = await secondBrowser.auth.signInWithPassword({ email: member.email, password: "pass-12345" });
    expect(signedIn.error).toBeNull();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const allowed = await member.client.rpc("claim_email_otp_request_v1", { p_destination_email: member.email });
      expect(allowed.error).toBeNull();
    }
    const blocked = await secondBrowser.rpc("claim_email_otp_request_v1", { p_destination_email: member.email });
    expect(blocked.error?.code).toBe("P0002");
  });
});

void abuseDb;
