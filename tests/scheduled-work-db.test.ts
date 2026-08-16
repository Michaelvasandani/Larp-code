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
const scheduledWorkDb = describe.skipIf(!credentials)("scheduled lifecycle work", () => {
  let admin: SupabaseClient;

  async function user(label: string) {
    const email = `ticket38-${label}-${crypto.randomUUID().slice(0, 8)}@example.test`;
    const created = await admin.auth.admin.createUser({ email, password: "pass-12345", email_confirm: true });
    expect(created.error).toBeNull();
    return { id: created.data.user!.id, email };
  }

  it("reconciles lifecycle and retention through one idempotent service seam", async () => {
    admin = createClient(credentials!.url, credentials!.serviceKey);
    const firstMember = await user("first");
    const secondMember = await user("second");
    const invitation = await admin.from("invitations").insert({
      inviter_id: firstMember.id,
      invited_email: secondMember.email,
      challenge_time_zone: "UTC",
      start_date: "2000-01-01",
      deadline_date: "2000-01-30",
      problem_set_version_id: "neetcode-150-2026-08-15",
      status: "accepted",
    }).select("id").single();
    expect(invitation.error).toBeNull();
    const challenge = await admin.from("challenges").insert({
      invitation_id: invitation.data!.id,
      inviter_id: firstMember.id,
      invited_member_id: secondMember.id,
      challenge_time_zone: "UTC",
      start_date: "2000-01-01",
      deadline_date: "2000-01-30",
      problem_set_version_id: "neetcode-150-2026-08-15",
      status: "active",
    }).select("id").single();
    expect(challenge.error).toBeNull();
    const members = await admin.from("challenge_members").insert([
      { challenge_id: challenge.data!.id, member_id: firstMember.id, member_email: firstMember.email, display_name: "First" },
      { challenge_id: challenge.data!.id, member_id: secondMember.id, member_email: secondMember.email, display_name: "Second" },
    ]);
    expect(members.error).toBeNull();
    const commitments = await admin.from("member_commitments").insert([
      { member_id: firstMember.id, challenge_id: challenge.data!.id },
      { member_id: secondMember.id, challenge_id: challenge.data!.id },
    ]);
    expect(commitments.error).toBeNull();

    const result = await admin.rpc("reconcile_scheduled_work_at_v1", {
      p_authoritative_now: "2000-02-01T00:00:00.000Z",
      p_batch_size: 10,
    });
    expect(result.error).toBeNull();
    expect(result.data).toMatchObject({
      invitationsExpired: 0,
      challengesReconciled: 1,
      noticesQueued: 0,
      cleanup: expect.objectContaining({
        invitationsDeleted: 0,
        challengesDeleted: 0,
      }),
    });
    const secondRun = await admin.rpc("reconcile_scheduled_work_at_v1", {
      p_authoritative_now: "2000-02-01T00:00:00.000Z",
      p_batch_size: 10,
    });
    expect(secondRun.error).toBeNull();
    expect(secondRun.data).toMatchObject({ challengesReconciled: 0 });
    const persisted = await admin.from("challenges")
      .select("status,terminal_at").eq("id", challenge.data!.id).single();
    expect(persisted.error).toBeNull();
    expect(persisted.data).toMatchObject({ status: "incomplete", terminal_at: "2000-02-01T00:00:00+00:00" });
    const remainingCommitments = await admin.from("member_commitments")
      .select("member_id").eq("challenge_id", challenge.data!.id);
    expect(remainingCommitments.error).toBeNull();
    expect(remainingCommitments.data).toHaveLength(0);
    const history = await admin.from("lifecycle_history")
      .select("status").eq("aggregate_id", challenge.data!.id).order("effective_at");
    expect(history.error).toBeNull();
    expect(history.data?.map((row) => row.status).sort()).toEqual(["active", "incomplete"]);
  });

  it("records only privacy-filtered cleanup failures", async () => {
    admin = createClient(credentials!.url, credentials!.serviceKey);
    const result = await admin.rpc("run_retention_cleanup_at_v1", {
      p_authoritative_now: "2000-01-01T00:00:00.000Z",
      p_batch_size: 0,
    });
    expect(result.error).toBeNull();
    expect(result.data).toMatchObject({ ok: false, alertCode: "retention_cleanup_failed" });

    const alerts = await admin.from("operational_alerts")
      .select("code,privacy_filtered,details")
      .eq("code", "retention_cleanup_failed")
      .order("created_at", { ascending: false })
      .limit(1);
    expect(alerts.error).toBeNull();
    expect(alerts.data?.[0]).toMatchObject({ code: "retention_cleanup_failed", privacy_filtered: true });
    expect(JSON.stringify(alerts.data?.[0]?.details)).not.toMatch(/timestamp|member|email|token|snapshot|solve|pet/i);
  });

  it("derives a terminal read outcome when the scheduler was delayed", async () => {
    admin = createClient(credentials!.url, credentials!.serviceKey);
    const inviter = await user("delayed-inviter");
    const invitee = await user("delayed-invitee");
    const invitation = await admin.from("invitations").insert({
      inviter_id: inviter.id,
      invited_email: invitee.email,
      challenge_time_zone: "UTC",
      start_date: "2000-01-01",
      deadline_date: "2000-01-30",
      problem_set_version_id: "neetcode-150-2026-08-15",
      status: "accepted",
    }).select("id").single();
    expect(invitation.error).toBeNull();
    const challenge = await admin.from("challenges").insert({
      invitation_id: invitation.data!.id,
      inviter_id: inviter.id,
      invited_member_id: invitee.id,
      challenge_time_zone: "UTC",
      start_date: "2000-01-01",
      deadline_date: "2000-01-30",
      problem_set_version_id: "neetcode-150-2026-08-15",
      status: "active",
    }).select("id").single();
    expect(challenge.error).toBeNull();
    const members = await admin.from("challenge_members").insert([
      { challenge_id: challenge.data!.id, member_id: inviter.id, member_email: inviter.email, display_name: "Inviter" },
      { challenge_id: challenge.data!.id, member_id: invitee.id, member_email: invitee.email, display_name: "Invitee" },
    ]);
    expect(members.error).toBeNull();

    const viewer = createClient(credentials!.url, credentials!.anonKey);
    const signedIn = await viewer.auth.signInWithPassword({ email: invitee.email, password: "pass-12345" });
    expect(signedIn.error).toBeNull();
    const status = await viewer.rpc("get_challenge_effective_status_at_v1", {
      p_challenge_id: challenge.data!.id,
      p_authoritative_now: "2000-02-01T00:00:00.000Z",
    });
    expect(status.error).toBeNull();
    expect(status.data).toBe("incomplete");
    const persisted = await admin.from("challenges").select("status,terminal_at").eq("id", challenge.data!.id).single();
    expect(persisted.error).toBeNull();
    expect(persisted.data).toMatchObject({ status: "incomplete", terminal_at: "2000-02-01T00:00:00+00:00" });
    const earlierStatus = await viewer.rpc("get_challenge_effective_status_at_v1", {
      p_challenge_id: challenge.data!.id,
      p_authoritative_now: "2000-01-15T00:00:00.000Z",
    });
    expect(earlierStatus.error).toBeNull();
    expect(earlierStatus.data).toBe("active");
  });

  it("resumes cleanup without deleting a parent that still has batched children", async () => {
    admin = createClient(credentials!.url, credentials!.serviceKey);
    const retainedUntil = "2000-01-01T00:00:00.000Z";
    const record = await admin.from("deleted_member_records").insert({
      original_member_id: crypto.randomUUID(),
      deleted_at: retainedUntil,
      invitation_retention_until: retainedUntil,
      challenge_retention_until: retainedUntil,
      diagnostic_retention_until: retainedUntil,
      security_audit_retention_until: retainedUntil,
      backup_retention_until: retainedUntil,
    }).select("id").single();
    expect(record.error).toBeNull();
    const childRows = Array.from({ length: 3 }, () => ({
      inviter_id: record.data!.id,
      invited_email: `retained-${crypto.randomUUID()}@example.test`,
      challenge_time_zone: "UTC",
      start_date: "2000-01-01",
      deadline_date: "2000-01-30",
      problem_set_version_id: "neetcode-150-2026-08-15",
      status: "expired",
      terminal_at: retainedUntil,
      deleted_member_record_id: record.data!.id,
      retention_expires_at: retainedUntil,
      created_at: retainedUntil,
      updated_at: retainedUntil,
    }));
    const invitations = await admin.from("invitations").insert(childRows).select("id");
    expect(invitations.error).toBeNull();
    const challenges = await admin.from("challenges").insert(invitations.data!.map((invitation) => ({
      invitation_id: invitation.id,
      inviter_id: record.data!.id,
      invited_member_id: crypto.randomUUID(),
      challenge_time_zone: "UTC",
      start_date: "2000-01-01",
      deadline_date: "2000-01-30",
      problem_set_version_id: "neetcode-150-2026-08-15",
      status: "incomplete",
      terminal_at: retainedUntil,
      retention_expires_at: retainedUntil,
      deleted_member_record_id: record.data!.id,
      created_at: retainedUntil,
      updated_at: retainedUntil,
    }))).select("id");
    expect(challenges.error).toBeNull();

    const run = async () => admin.rpc("run_retention_cleanup_at_v1", {
      p_authoritative_now: "2000-02-01T00:00:00.000Z",
      p_batch_size: 1,
    });
    const first = await run();
    expect(first.error).toBeNull();
    expect(first.data).toMatchObject({ ok: true, challengesDeleted: 1, invitationsDeleted: 1 });
    const afterFirst = await admin.from("deleted_member_records").select("id").eq("id", record.data!.id).single();
    expect(afterFirst.error).toBeNull();
    const second = await run();
    expect(second.error).toBeNull();
    expect(second.data).toMatchObject({ ok: true, challengesDeleted: 1, invitationsDeleted: 1 });
    const third = await run();
    expect(third.error).toBeNull();
    expect(third.data).toMatchObject({ ok: true, challengesDeleted: 1, invitationsDeleted: 1, deletedMemberRecords: 1 });
    const afterThird = await admin.from("deleted_member_records").select("id").eq("id", record.data!.id).maybeSingle();
    expect(afterThird.error).toBeNull();
    expect(afterThird.data).toBeNull();
  });
});

void scheduledWorkDb;
