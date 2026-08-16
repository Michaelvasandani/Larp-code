import { execFileSync } from "node:child_process";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { TRANSACTIONAL_NOTICE_MATRIX } from "../src/shared/transactional-notices";

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
const noticesDb = describe.skipIf(!credentials)("Transactional Notice outbox against local Supabase", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  let admin: SupabaseClient;

  async function profile(name: string): Promise<Profile> {
    const email = `ticket33-${name}-${suffix}@example.test`;
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
    // Supabase's local JWT verifier can briefly observe a just-issued token as
    // future-dated while the API container clock catches up after startup.
    if (account.error?.code === "PGRST303") {
      await new Promise((resolve) => setTimeout(resolve, 1100));
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

  async function createInvitation(inviter: Profile, invitee: Profile): Promise<string> {
    const result = await inviter.client.rpc("create_invitation_v1", {
      p_idempotency_key: crypto.randomUUID(),
      p_command_version: 1,
      p_command_kind: "create_invitation",
      p_member_id: inviter.id,
      p_member_email: inviter.email,
      p_invited_email: invitee.email,
      p_challenge_time_zone: "UTC",
      p_start_date: "2099-01-01",
      p_deadline_date: "2099-01-30",
      p_problem_set_version_id: "neetcode-150-2026-08-15",
    });
    expect(result.error).toBeNull();
    return (result.data as { id: string }).id;
  }

  async function notices(eventKey: string): Promise<Array<Record<string, unknown>>> {
    const result = await admin.from("transactional_notices")
      .select("event_key,source_event_key,notice_type,recipient_email,recipient_member_id,actor_member_id,invitation_id,challenge_id,delivery_state")
      .eq("source_event_key", eventKey);
    expect(result.error).toBeNull();
    return result.data ?? [];
  }

  it("captures each permitted Invitation recipient once and leaves terminal expiry silent", async () => {
    admin = createClient(credentials!.url, credentials!.serviceKey);
    const inviter = await profile("Inviter");
    const invitee = await profile("Invitee");

    const acceptedId = await createInvitation(inviter, invitee);
    const created = await notices(`invitation:${acceptedId}:created`);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      notice_type: "invitation",
      recipient_email: invitee.email.toLowerCase(),
      recipient_member_id: invitee.id,
      actor_member_id: inviter.id,
      invitation_id: acceptedId,
      delivery_state: "queued",
    });
    const accepted = await invitee.client.rpc("accept_invitation_v1", {
      p_idempotency_key: crypto.randomUUID(), p_command_version: 1, p_command_kind: "accept_invitation",
      p_member_id: invitee.id, p_member_email: invitee.email, p_invitation_id: acceptedId,
    });
    expect(accepted.error).toBeNull();
    const acceptedNotice = await notices(`invitation:${acceptedId}:accepted`);
    expect(acceptedNotice).toHaveLength(1);
    expect(acceptedNotice[0]).toMatchObject({ notice_type: "invitation_accepted", recipient_email: inviter.email.toLowerCase(), actor_member_id: invitee.id });
    expect(acceptedNotice[0]?.recipient_member_id).toBe(inviter.id);

    const declinedInvitee = await profile("Declined");
    const declinedId = await createInvitation(inviter, declinedInvitee);
    const declined = await declinedInvitee.client.rpc("decline_invitation_v1", {
      p_idempotency_key: crypto.randomUUID(), p_command_version: 1, p_command_kind: "decline_invitation",
      p_member_id: declinedInvitee.id, p_member_email: declinedInvitee.email, p_invitation_id: declinedId,
    });
    expect(declined.error).toBeNull();
    const declinedNotice = await notices(`invitation:${declinedId}:declined`);
    expect(declinedNotice).toHaveLength(1);
    expect(declinedNotice[0]).toMatchObject({
      notice_type: "invitation_declined",
      recipient_email: inviter.email.toLowerCase(),
      recipient_member_id: inviter.id,
      actor_member_id: declinedInvitee.id,
    });

    const revokedInvitee = await profile("Revoked");
    const revokedId = await createInvitation(inviter, revokedInvitee);
    const revoked = await inviter.client.rpc("revoke_invitation_v1", {
      p_idempotency_key: crypto.randomUUID(), p_command_version: 1, p_command_kind: "revoke_invitation",
      p_member_id: inviter.id, p_member_email: inviter.email, p_invitation_id: revokedId,
    });
    expect(revoked.error).toBeNull();
    const revokedNotice = await notices(`invitation:${revokedId}:revoked`);
    expect(revokedNotice).toHaveLength(1);
    expect(revokedNotice[0]).toMatchObject({
      notice_type: "invitation_revoked",
      recipient_email: revokedInvitee.email.toLowerCase(),
      recipient_member_id: revokedInvitee.id,
      actor_member_id: inviter.id,
    });

    const expired = await admin.from("invitations").insert({
      inviter_id: inviter.id,
      invited_email: revokedInvitee.email,
      challenge_time_zone: "UTC",
      start_date: "2000-01-01",
      deadline_date: "2000-01-30",
      problem_set_version_id: "neetcode-150-2026-08-15",
    }).select("id").single();
    expect(expired.error).toBeNull();
    const expiredResult = await admin.from("invitations").update({
      status: "expired", terminal_at: new Date().toISOString(),
    }).eq("id", expired.data!.id);
    expect(expiredResult.error).toBeNull();
    expect(await notices(`invitation:${expired.data!.id}:expired`)).toHaveLength(0);
  });

  it("keeps the SQL notice metadata derived from the canonical application matrix", async () => {
    admin = createClient(credentials!.url, credentials!.serviceKey);
    const metadata = await admin.from("transactional_notice_types")
      .select("notice_type,recipient_role,delivery_source,product_email")
      .order("notice_type");
    expect(metadata.error).toBeNull();
    expect(metadata.data).toEqual(TRANSACTIONAL_NOTICE_MATRIX.map((entry) => ({
      notice_type: entry.type,
      recipient_role: entry.recipient,
      delivery_source: entry.source,
      product_email: entry.source === "product_outbox",
    })).sort((left, right) => left.notice_type.localeCompare(right.notice_type)));
  });

  it("claims a product email once and records no product email for an actor-only or forbidden event", async () => {
    admin = createClient(credentials!.url, credentials!.serviceKey);
    const inviter = await profile("CancelInviter");
    const invitee = await profile("CancelInvitee");
    const invitationId = await createInvitation(inviter, invitee);
    const accepted = await invitee.client.rpc("accept_invitation_v1", {
      p_idempotency_key: crypto.randomUUID(), p_command_version: 1, p_command_kind: "accept_invitation",
      p_member_id: invitee.id, p_member_email: invitee.email, p_invitation_id: invitationId,
    });
    expect(accepted.error).toBeNull();
    const challengeId = (accepted.data as { id: string }).id;
    const canceled = await invitee.client.rpc("cancel_challenge_v1", {
      p_idempotency_key: crypto.randomUUID(), p_command_version: 1, p_command_kind: "cancel_challenge",
      p_member_id: invitee.id, p_member_email: invitee.email, p_challenge_id: challengeId,
    });
    expect(canceled.error).toBeNull();
    const canceledNotices = await notices(`challenge:${challengeId}:canceled`);
    expect(canceledNotices).toHaveLength(1);
    expect(canceledNotices[0]).toMatchObject({
      notice_type: "challenge_canceled",
      recipient_email: inviter.email.toLowerCase(),
      recipient_member_id: inviter.id,
      actor_member_id: invitee.id,
      challenge_id: challengeId,
      delivery_state: "queued",
    });

    const firstClaim = await admin.rpc("claim_transactional_notice_v1", { p_event_key: `challenge:${challengeId}:canceled` });
    expect(firstClaim.error).toBeNull();
    expect(firstClaim.data).toMatchObject({ delivery_state: "claimed" });
    const replayClaim = await admin.rpc("claim_transactional_notice_v1", { p_event_key: `challenge:${challengeId}:canceled` });
    expect(replayClaim.error).toBeNull();
    expect(replayClaim.data).toBeNull();
    expect(await notices(`challenge:${challengeId}:completed`)).toHaveLength(0);
    expect(await notices(`challenge:${challengeId}:incomplete`)).toHaveLength(0);

    const abandonedInvitation = await admin.from("invitations").insert({
      inviter_id: inviter.id,
      invited_email: invitee.email,
      challenge_time_zone: "UTC",
      start_date: "2000-01-01",
      deadline_date: "2000-01-30",
      problem_set_version_id: "neetcode-150-2026-08-15",
      status: "accepted",
    }).select("id").single();
    expect(abandonedInvitation.error).toBeNull();
    const abandonedChallenge = await admin.from("challenges").insert({
      invitation_id: abandonedInvitation.data!.id,
      inviter_id: inviter.id,
      invited_member_id: invitee.id,
      challenge_time_zone: "UTC",
      start_date: "2000-01-01",
      deadline_date: "2000-01-30",
      problem_set_version_id: "neetcode-150-2026-08-15",
      status: "active",
    }).select("id").single();
    expect(abandonedChallenge.error).toBeNull();
    expect((await admin.from("challenge_members").insert([
      { challenge_id: abandonedChallenge.data!.id, member_id: inviter.id, member_email: inviter.email, display_name: "CancelInviter" },
      { challenge_id: abandonedChallenge.data!.id, member_id: invitee.id, member_email: invitee.email, display_name: "CancelInvitee" },
    ])).error).toBeNull();
    const abandoned = await admin.from("challenges").update({
      status: "abandoned", terminal_actor_id: inviter.id, terminal_at: new Date().toISOString(),
    }).eq("id", abandonedChallenge.data!.id);
    expect(abandoned.error).toBeNull();
    const abandonedNotice = await notices(`challenge:${abandonedChallenge.data!.id}:abandoned`);
    expect(abandonedNotice).toHaveLength(1);
    expect(abandonedNotice[0]).toMatchObject({
      notice_type: "challenge_abandoned",
      recipient_member_id: invitee.id,
      recipient_email: invitee.email.toLowerCase(),
      actor_member_id: inviter.id,
    });

  });
});

void noticesDb;
