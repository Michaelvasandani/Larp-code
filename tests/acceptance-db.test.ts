import { execFileSync } from "node:child_process";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

// Supabase initializes its Realtime transport even though this test only uses
// REST/RPC. Node 20 has no native WebSocket; a never-used constructor keeps
// the integration test runnable on the repository's supported test runtime.
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
const acceptanceDb = describe.skipIf(!credentials)("acceptance invariants against local Supabase", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  let admin: SupabaseClient;
  const profiles = new Map<string, Profile>();

  async function profile(name: string): Promise<Profile> {
    const email = `ticket25-${name}-${suffix}@example.test`;
    const created = await admin.auth.admin.createUser({ email, password: "pass-12345", email_confirm: true });
    expect(created.error).toBeNull();
    const client = createClient(credentials!.url, credentials!.anonKey);
    const signedIn = await client.auth.signInWithPassword({ email, password: "pass-12345" });
    expect(signedIn.error).toBeNull();
    const account = await client.rpc("create_member_account_v1", {
      p_display_name: name,
      p_adult_confirmed: true,
      p_consent_accepted: true,
      p_consent_version: "PRIV-031-v1",
    });
    expect(account.error).toBeNull();
    const result = { id: created.data.user!.id, email, client };
    profiles.set(name, result);
    return result;
  }

  async function invitation(inviter: Profile, invited: Profile, key: string, startDate?: string): Promise<string> {
    const result = await inviter.client.rpc("create_invitation_v1", {
      p_idempotency_key: key,
      p_command_version: 1,
      p_command_kind: "create_invitation",
      p_member_id: inviter.id,
      p_member_email: inviter.email,
      p_invited_email: invited.email,
      p_challenge_time_zone: "UTC",
      p_start_date: startDate ?? "2099-01-01",
      p_deadline_date: startDate ? startDate : "2099-01-30",
      p_problem_set_version_id: "neetcode-150-2026-08-15",
    });
    expect(result.error).toBeNull();
    return (result.data as { id: string }).id;
  }

  async function accept(member: Profile, invitationId: string, key: string) {
    return member.client.rpc("accept_invitation_v1", {
      p_idempotency_key: key,
      p_command_version: 1,
      p_command_kind: "accept_invitation",
      p_member_id: member.id,
      p_member_email: member.email,
      p_invitation_id: invitationId,
    });
  }

  async function cancel(member: Profile, challengeId: string, key: string) {
    return member.client.rpc("cancel_challenge_v1", {
      p_idempotency_key: key,
      p_command_version: 1,
      p_command_kind: "cancel_challenge",
      p_member_id: member.id,
      p_member_email: member.email,
      p_challenge_id: challengeId,
    });
  }

  it("covers two-profile conflicts, boundary rejection, rollback, replay, cleanup, and equal authority", async () => {
    admin = createClient(credentials!.url, credentials!.serviceKey);
    const inviterC = await profile("C");
    const invitedD = await profile("D");
    const inviterE = await profile("E");
    const inviterA = await profile("A");
    const invitedB = await profile("B");

    const competingOneKey = crypto.randomUUID();
    const competingTwoKey = crypto.randomUUID();
    const competingOne = await invitation(inviterC, invitedD, competingOneKey);
    const competingTwo = await invitation(inviterE, invitedD, competingTwoKey);
    const details = await invitedD.client.rpc("get_pending_invitation_details_for_member_v1");
    expect(details.error).toBeNull();
    expect(details.data.problemSetVersion).toMatchObject({
      sourceDataFile: ".problemSiteData.json",
      licenseNotice: expect.stringContaining("MIT License"),
      nonAffiliationNotice: expect.stringContaining("independent product"),
      problemCount: 150,
    });

    const wrongEmail = await accept(inviterA, competingOne, crypto.randomUUID());
    expect(wrongEmail.error?.code).toBe("42501");

    const acceptOneKey = crypto.randomUUID();
    const acceptTwoKey = crypto.randomUUID();
    const [first, second] = await Promise.all([
      accept(invitedD, competingOne, acceptOneKey),
      accept(invitedD, competingTwo, acceptTwoKey),
    ]);
    expect([first.error, second.error].filter(Boolean)).toHaveLength(1);
    expect([first.data, second.data].filter(Boolean)).toHaveLength(1);

    const challenges = await admin.from("challenges").select("id, invitation_id, status").in("invitation_id", [competingOne, competingTwo]);
    expect(challenges.error).toBeNull();
    expect(challenges.data).toHaveLength(1);
    const committedChallengeId = challenges.data![0]!.id as string;
    const members = await admin.from("challenge_members").select("member_id, authority").eq("challenge_id", committedChallengeId);
    expect(members.error).toBeNull();
    expect(members.data).toHaveLength(2);
    expect(members.data!.every((member) => member.authority === "equal")).toBe(true);
    const commitments = await admin.from("member_commitments").select("member_id").eq("challenge_id", committedChallengeId);
    expect(commitments.error).toBeNull();
    expect(commitments.data).toHaveLength(2);
    const statuses = await admin.from("invitations").select("id, status").in("id", [competingOne, competingTwo]);
    expect(statuses.data?.map((row) => row.status).sort()).toEqual(["accepted", "revoked"]);

    const winner = (statuses.data ?? []).find((row) => row.status === "accepted")!.id as string;
    const winnerKey = winner === competingOne ? acceptOneKey : acceptTwoKey;
    const replayKey = winnerKey;
    const replay = await accept(invitedD, winner, replayKey);
    expect(replay.error).toBeNull();
    const replayAgain = await accept(invitedD, winner, replayKey);
    expect(replayAgain.error).toBeNull();
    expect(replayAgain.data).toEqual(replay.data);

    const today = new Date().toISOString().slice(0, 10);
    const boundaryInvitation = await admin.from("invitations").insert({
      inviter_id: inviterA.id,
      invited_email: invitedB.email,
      challenge_time_zone: "UTC",
      start_date: today,
      deadline_date: today,
      problem_set_version_id: "neetcode-150-2026-08-15",
    }).select("id").single();
    expect(boundaryInvitation.error).toBeNull();
    const boundaryAttempt = await accept(invitedB, boundaryInvitation.data!.id as string, crypto.randomUUID());
    expect(boundaryAttempt.error?.code).toBe("P0003");
    const noBoundaryChallenge = await admin.from("challenges").select("id").eq("invitation_id", boundaryInvitation.data!.id);
    expect(noBoundaryChallenge.data).toHaveLength(0);
    await admin.from("invitations").update({ status: "revoked" }).eq("id", boundaryInvitation.data!.id);

    const rollbackInvitation = await invitation(inviterA, invitedB, crypto.randomUUID());
    const acceptedPair = await accept(invitedB, rollbackInvitation, crypto.randomUUID());
    expect(acceptedPair.error).toBeNull();
    const conflicting = await invitation(inviterE, invitedB, crypto.randomUUID());
    const rollback = await accept(invitedB, conflicting, crypto.randomUUID());
    expect(rollback.error?.code).toBe("P0003");
    const rollbackRows = await admin.from("challenges").select("id").eq("invitation_id", conflicting);
    expect(rollbackRows.data).toHaveLength(0);
    const rollbackInvitationRow = await admin.from("invitations").select("status").eq("id", conflicting).single();
    expect(rollbackInvitationRow.data?.status).toBe("pending");
  });

  it("cancels a Scheduled Challenge for both Members, releases capacity, and retries idempotently", async () => {
    admin = createClient(credentials!.url, credentials!.serviceKey);
    const inviter = await profile("CancelInviter");
    const invitee = await profile("CancelInvitee");
    const invitationId = await invitation(inviter, invitee, crypto.randomUUID());
    const accepted = await accept(invitee, invitationId, crypto.randomUUID());
    expect(accepted.error).toBeNull();
    const challengeId = (accepted.data as { id: string }).id;
    const [inviterView, inviteeView] = await Promise.all([
      inviter.client.rpc("get_committed_challenge_for_member_v1"),
      invitee.client.rpc("get_committed_challenge_for_member_v1"),
    ]);
    expect(inviterView.error).toBeNull();
    expect(inviteeView.error).toBeNull();
    expect(inviterView.data).toMatchObject({ id: challengeId, status: "scheduled" });
    expect(inviteeView.data).toMatchObject({ id: challengeId, status: "scheduled" });
    const earlySolve = await admin.from("challenges").update({ status: "active" }).eq("id", challengeId);
    expect(earlySolve.error?.code).toBe("P0003");
    const key = crypto.randomUUID();
    const canceled = await cancel(invitee, challengeId, key);
    expect(canceled.error).toBeNull();
    expect(canceled.data).toMatchObject({ id: challengeId, status: "canceled", terminalActorId: invitee.id });
    const retry = await cancel(invitee, challengeId, key);
    expect(retry.error).toBeNull();
    expect(retry.data).toEqual(canceled.data);
    const commitments = await admin.from("member_commitments").select("member_id").in("member_id", [inviter.id, invitee.id]);
    expect(commitments.error).toBeNull();
    expect(commitments.data).toHaveLength(0);
    const readOnly = await invitee.client.rpc("get_challenge_v1", { p_challenge_id: challengeId });
    expect(readOnly.error).toBeNull();
    expect(readOnly.data).toMatchObject({ id: challengeId, status: "canceled" });
    const latest = await invitee.client.rpc("get_latest_canceled_challenge_for_member_v1");
    expect(latest.error).toBeNull();
    expect(latest.data).toMatchObject({ id: challengeId, status: "canceled" });
    const inviterLatest = await inviter.client.rpc("get_latest_canceled_challenge_for_member_v1");
    expect(inviterLatest.error).toBeNull();
    expect(inviterLatest.data).toMatchObject({ id: challengeId, status: "canceled" });

    const replacementInvitation = await invitation(inviter, invitee, crypto.randomUUID());
    const replacement = await accept(invitee, replacementInvitation, crypto.randomUUID());
    expect(replacement.error).toBeNull();
    expect(replacement.data).toMatchObject({ status: "scheduled" });
  });

  it("uses the SQL authoritative boundary and rejects cancellation once Active", async () => {
    admin = createClient(credentials!.url, credentials!.serviceKey);
    const inviter = await profile("BoundaryInviter");
    const invitee = await profile("BoundaryInvitee");
    const invitationId = await invitation(inviter, invitee, crypto.randomUUID());
    const today = new Date().toISOString().slice(0, 10);
    const inserted = await admin.from("challenges").insert({
      invitation_id: invitationId,
      inviter_id: inviter.id,
      invited_member_id: invitee.id,
      challenge_time_zone: "UTC",
      start_date: today,
      deadline_date: today,
      problem_set_version_id: "neetcode-150-2026-08-15",
    }).select("id").single();
    expect(inserted.error).toBeNull();
    const challengeId = inserted.data!.id as string;
    const members = await admin.from("challenge_members").insert([
      { challenge_id: challengeId, member_id: inviter.id, member_email: inviter.email, display_name: "BoundaryInviter" },
      { challenge_id: challengeId, member_id: invitee.id, member_email: invitee.email, display_name: "BoundaryInvitee" },
    ]);
    expect(members.error).toBeNull();
    const commitments = await admin.from("member_commitments").insert([
      { member_id: inviter.id, challenge_id: challengeId },
      { member_id: invitee.id, challenge_id: challengeId },
    ]);
    expect(commitments.error).toBeNull();

    const start = `${today}T00:00:00.000Z`;
    const before = new Date(Date.parse(start) - 1).toISOString();
    const [beforeStatus, atStatus, read] = await Promise.all([
      invitee.client.rpc("get_challenge_effective_status_at_v1", { p_challenge_id: challengeId, p_authoritative_now: before }),
      invitee.client.rpc("get_challenge_effective_status_at_v1", { p_challenge_id: challengeId, p_authoritative_now: start }),
      invitee.client.rpc("get_challenge_v1", { p_challenge_id: challengeId }),
    ]);
    expect(beforeStatus.error).toBeNull();
    expect(beforeStatus.data).toBe("scheduled");
    expect(atStatus.error).toBeNull();
    expect(atStatus.data).toBe("active");
    expect(read.error).toBeNull();
    expect(read.data).toMatchObject({ id: challengeId, status: "active" });

    const tooLate = await cancel(inviter, challengeId, crypto.randomUUID());
    expect(tooLate.error?.code).toBe("P0003");
    const stillCommitted = await admin.from("member_commitments").select("member_id").eq("challenge_id", challengeId);
    expect(stillCommitted.error).toBeNull();
    expect(stillCommitted.data).toHaveLength(2);
  });
});

void acceptanceDb;
