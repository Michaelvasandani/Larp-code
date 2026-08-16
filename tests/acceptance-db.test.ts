import { execFileSync } from "node:child_process";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { PINNED_PROBLEM_SET_VERSION } from "../src/catalog/problem-set";

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
    let account = await client.rpc("create_member_account_v1", {
      p_display_name: name,
      p_adult_confirmed: true,
      p_consent_accepted: true,
      p_consent_version: "PRIV-031-v1",
    });
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

  async function freshEmailConfirmation(member: Profile): Promise<void> {
    const link = await admin.auth.admin.generateLink({ type: "magiclink", email: member.email });
    expect(link.error).toBeNull();
    expect(link.data.properties).not.toBeNull();
    const verified = await member.client.auth.verifyOtp({ token_hash: link.data.properties!.hashed_token, type: "magiclink" });
    expect(verified.error).toBeNull();
  }

  async function deleteMember(member: Profile) {
    await freshEmailConfirmation(member);
    return member.client.rpc("delete_member_account_v1", {
      p_idempotency_key: crypto.randomUUID(), p_command_version: 1, p_command_kind: "delete_member_account",
      p_member_id: member.id, p_member_email: member.email,
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

  it("credits one pinned self-attested Solve per Member, retries idempotently, and rejects time-window violations", async () => {
    admin = createClient(credentials!.url, credentials!.serviceKey);
    const inviter = await profile("SolveInviter");
    const invitee = await profile("SolveInvitee");
    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.parse(`${today}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10);
    const yesterday = new Date(Date.parse(`${today}T00:00:00.000Z`) - 86_400_000).toISOString().slice(0, 10);

    async function seededChallenge(startDate: string, deadlineDate: string, status: "scheduled" | "active") {
      const invitation = await admin.from("invitations").insert({
        inviter_id: inviter.id,
        invited_email: invitee.email,
        challenge_time_zone: "UTC",
        start_date: startDate,
        deadline_date: deadlineDate,
        problem_set_version_id: "neetcode-150-2026-08-15",
        status: "accepted",
      }).select("id").single();
      expect(invitation.error).toBeNull();
      const challenge = await admin.from("challenges").insert({
        invitation_id: invitation.data!.id,
        inviter_id: inviter.id,
        invited_member_id: invitee.id,
        challenge_time_zone: "UTC",
        start_date: startDate,
        deadline_date: deadlineDate,
        problem_set_version_id: "neetcode-150-2026-08-15",
        status,
      }).select("id").single();
      expect(challenge.error).toBeNull();
      const members = await admin.from("challenge_members").insert([
        { challenge_id: challenge.data!.id, member_id: inviter.id, member_email: inviter.email, display_name: "SolveInviter" },
        { challenge_id: challenge.data!.id, member_id: invitee.id, member_email: invitee.email, display_name: "SolveInvitee" },
      ]);
      expect(members.error).toBeNull();
      return challenge.data!.id as string;
    }

    const activeChallengeId = await seededChallenge(today, tomorrow, "active");
    const firstKey = crypto.randomUUID();
    const first = await inviter.client.rpc("create_solve_v1", {
      p_idempotency_key: firstKey,
      p_command_version: 1,
      p_command_kind: "create_solve",
      p_member_id: inviter.id,
      p_member_email: inviter.email,
      p_challenge_id: activeChallengeId,
      p_problem_id: "problem:0217-contains-duplicate",
      p_affirmed: true,
    });
    expect(first.error).toBeNull();
    expect(first.data).toMatchObject({ memberId: inviter.id, challengeId: activeChallengeId, creditStatus: "credited" });
    const replay = await inviter.client.rpc("create_solve_v1", {
      p_idempotency_key: firstKey,
      p_command_version: 1,
      p_command_kind: "create_solve",
      p_member_id: inviter.id,
      p_member_email: inviter.email,
      p_challenge_id: activeChallengeId,
      p_problem_id: "problem:0217-contains-duplicate",
      p_affirmed: true,
    });
    expect(replay.error).toBeNull();
    expect(replay.data).toEqual(first.data);
    const duplicate = await inviter.client.rpc("create_solve_v1", {
      p_idempotency_key: crypto.randomUUID(), p_command_version: 1, p_command_kind: "create_solve",
      p_member_id: inviter.id, p_member_email: inviter.email, p_challenge_id: activeChallengeId,
      p_problem_id: "problem:0217-contains-duplicate", p_affirmed: true,
    });
    expect(duplicate.error?.code).toBe("P0003");
    const partner = await invitee.client.rpc("create_solve_v1", {
      p_idempotency_key: crypto.randomUUID(), p_command_version: 1, p_command_kind: "create_solve",
      p_member_id: invitee.id, p_member_email: invitee.email, p_challenge_id: activeChallengeId,
      p_problem_id: "problem:0217-contains-duplicate", p_affirmed: true,
    });
    expect(partner.error).toBeNull();
    const active = await inviter.client.rpc("get_challenge_v1", { p_challenge_id: activeChallengeId });
    expect(active.error).toBeNull();
    expect(active.data.progress).toMatchObject({ pairProgress: 1, petCondition: "hungry" });
    expect(active.data.progress.members.map((member: { creditedTotal: number }) => member.creditedTotal).sort()).toEqual([1, 1]);

    const scheduledChallengeId = await seededChallenge(tomorrow, tomorrow, "scheduled");
    const beforeStart = await inviter.client.rpc("create_solve_v1", {
      p_idempotency_key: crypto.randomUUID(), p_command_version: 1, p_command_kind: "create_solve",
      p_member_id: inviter.id, p_member_email: inviter.email, p_challenge_id: scheduledChallengeId,
      p_problem_id: "problem:0242-valid-anagram", p_affirmed: true,
    });
    expect(beforeStart.error?.code).toBe("P0003");

    const expiredChallengeId = await seededChallenge(yesterday, yesterday, "active");
    const afterDeadline = await inviter.client.rpc("create_solve_v1", {
      p_idempotency_key: crypto.randomUUID(), p_command_version: 1, p_command_kind: "create_solve",
      p_member_id: inviter.id, p_member_email: inviter.email, p_challenge_id: expiredChallengeId,
      p_problem_id: "problem:0242-valid-anagram", p_affirmed: true,
    });
    expect(afterDeadline.error?.code).toBe("P0003");
  });

  it("covers controlled-time pace, carry, fractional Pair Progress, Pet bands, and evolution high-water marks", async () => {
    admin = createClient(credentials!.url, credentials!.serviceKey);
    const inviter = await profile("ControlledInviter");
    const invitee = await profile("ControlledInvitee");
    const version = "neetcode-150-2026-08-15";
    const controlledNow = "2030-01-03T12:00:00.000Z";
    type ControlledSnapshot = {
      status: string;
      progress?: {
        day: number;
        expectedProgress: number;
        previousExpectedProgress: number;
        earlierExpectedProgress: number;
        pairProgress: number;
        petCondition: string;
        currentEvolutionStage: number;
        highestEvolutionStage: number;
        members: Array<{ paceStatus: string; paceGap: { copy: string } }>;
      };
    };
    const problemIds = PINNED_PROBLEM_SET_VERSION.problems.map((problem) => problem.id);
    expect(problemIds).toHaveLength(150);

    async function seededChallenge(startDate: string, deadlineDate: string): Promise<string> {
      const invitation = await admin.from("invitations").insert({
        inviter_id: inviter.id,
        invited_email: invitee.email,
        challenge_time_zone: "UTC",
        start_date: startDate,
        deadline_date: deadlineDate,
        problem_set_version_id: version,
        status: "accepted",
      }).select("id").single();
      expect(invitation.error).toBeNull();
      const challenge = await admin.from("challenges").insert({
        invitation_id: invitation.data!.id,
        inviter_id: inviter.id,
        invited_member_id: invitee.id,
        challenge_time_zone: "UTC",
        start_date: startDate,
        deadline_date: deadlineDate,
        problem_set_version_id: version,
        status: "scheduled",
      }).select("id").single();
      expect(challenge.error).toBeNull();
      const members = await admin.from("challenge_members").insert([
        { challenge_id: challenge.data!.id, member_id: inviter.id, member_email: inviter.email, display_name: "ControlledInviter" },
        { challenge_id: challenge.data!.id, member_id: invitee.id, member_email: invitee.email, display_name: "ControlledInvitee" },
      ]);
      expect(members.error).toBeNull();
      return challenge.data!.id as string;
    }

    async function addSolves(challengeId: string, member: Profile, start: number, count: number): Promise<void> {
      const rows = problemIds.slice(start, start + count).map((problemId) => ({
        member_id: member.id,
        challenge_id: challengeId,
        problem_id: problemId,
      }));
      if (rows.length === 0) return;
      const inserted = await admin.from("solves").insert(rows);
      expect(inserted.error).toBeNull();
    }

    async function readAt(challengeId: string, authoritativeNow: string): Promise<ControlledSnapshot> {
      const result = await admin.rpc("get_challenge_at_v1", {
        p_challenge_id: challengeId,
        p_authoritative_now: authoritativeNow,
      });
      expect(result.error).toBeNull();
      return result.data as ControlledSnapshot;
    }

    function progressOf(snapshot: ControlledSnapshot): NonNullable<ControlledSnapshot["progress"]> {
      if (!snapshot.progress) throw new Error("Controlled-time read did not return progress.");
      return snapshot.progress;
    }

    const bandsChallenge = await seededChallenge("2030-01-01", "2030-01-03");
    let snapshot = await readAt(bandsChallenge, controlledNow);
    expect(snapshot).toMatchObject({ status: "active", progress: {
      day: 3, expectedProgress: 150, previousExpectedProgress: 100, earlierExpectedProgress: 50,
      pairProgress: 0, petCondition: "deteriorated", currentEvolutionStage: 1, highestEvolutionStage: 1,
    }});
    await addSolves(bandsChallenge, inviter, 0, 7);
    await addSolves(bandsChallenge, invitee, 0, 8);
    snapshot = await readAt(bandsChallenge, controlledNow);
    expect(progressOf(snapshot).pairProgress).toBe(7.5);
    expect(progressOf(snapshot).petCondition).toBe("deteriorated");
    await addSolves(bandsChallenge, inviter, 7, 43);
    await addSolves(bandsChallenge, invitee, 8, 42);
    snapshot = await readAt(bandsChallenge, controlledNow);
    expect(progressOf(snapshot)).toMatchObject({ pairProgress: 50, petCondition: "sad", currentEvolutionStage: 2, highestEvolutionStage: 2 });
    await addSolves(bandsChallenge, inviter, 50, 50);
    await addSolves(bandsChallenge, invitee, 50, 50);
    snapshot = await readAt(bandsChallenge, controlledNow);
    expect(progressOf(snapshot)).toMatchObject({ pairProgress: 100, petCondition: "hungry", currentEvolutionStage: 3, highestEvolutionStage: 3 });
    expect(progressOf(snapshot).members.every((member) => member.paceStatus === "on_pace_today")).toBe(true);
    await addSolves(bandsChallenge, inviter, 100, 50);
    await addSolves(bandsChallenge, invitee, 100, 50);
    snapshot = await readAt(bandsChallenge, controlledNow);
    expect(snapshot).toMatchObject({ status: "completed", finalTotals: expect.arrayContaining([
      { memberId: inviter.id, creditedTotal: 150 },
      { memberId: invitee.id, creditedTotal: 150 },
    ]) });

    const carryChallenge = await seededChallenge("2030-01-02", "2030-01-04");
    await addSolves(carryChallenge, inviter, 0, 101);
    await addSolves(carryChallenge, invitee, 0, 100);
    const carrySnapshot = await readAt(carryChallenge, controlledNow);
    expect(progressOf(carrySnapshot)).toMatchObject({ day: 2, expectedProgress: 100, previousExpectedProgress: 50, pairProgress: 100.5, petCondition: "healthy" });
    expect(progressOf(carrySnapshot).members.map((member) => member.paceGap.copy).sort()).toEqual([
      "Today's pace met; 0 at the target.",
      "Today's pace met; 1 ahead of the target.",
    ]);

    const beforeStart = await readAt(bandsChallenge, "2029-12-31T23:59:59.000Z");
    expect(beforeStart).not.toHaveProperty("progress");
    const afterDeadline = await readAt(bandsChallenge, "2030-01-04T00:00:00.000Z");
    expect(afterDeadline).toMatchObject({ status: "completed", finalTotals: expect.arrayContaining([
      { memberId: inviter.id, creditedTotal: 150 },
      { memberId: invitee.id, creditedTotal: 150 },
    ]) });
  });

  it("keeps ordered correction history shared, authorizes only the owner, and serializes concurrent retries", async () => {
    admin = createClient(credentials!.url, credentials!.serviceKey);
    const inviter = await profile("CorrectionInviter");
    const invitee = await profile("CorrectionInvitee");
    const problemIds = PINNED_PROBLEM_SET_VERSION.problems.map((problem) => problem.id);
    const invitation = await admin.from("invitations").insert({
      inviter_id: inviter.id,
      invited_email: invitee.email,
      challenge_time_zone: "UTC",
      start_date: "2030-01-01",
      deadline_date: "2030-01-03",
      problem_set_version_id: "neetcode-150-2026-08-15",
      status: "accepted",
    }).select("id").single();
    expect(invitation.error).toBeNull();
    const challenge = await admin.from("challenges").insert({
      invitation_id: invitation.data!.id,
      inviter_id: inviter.id,
      invited_member_id: invitee.id,
      challenge_time_zone: "UTC",
      start_date: "2030-01-01",
      deadline_date: "2030-01-03",
      problem_set_version_id: "neetcode-150-2026-08-15",
      status: "active",
    }).select("id").single();
    expect(challenge.error).toBeNull();
    const challengeId = challenge.data!.id as string;
    const members = await admin.from("challenge_members").insert([
      { challenge_id: challengeId, member_id: inviter.id, member_email: inviter.email, display_name: "CorrectionInviter" },
      { challenge_id: challengeId, member_id: invitee.id, member_email: invitee.email, display_name: "CorrectionInvitee" },
    ]);
    expect(members.error).toBeNull();
    const seeded = await admin.from("solves").insert([
      ...problemIds.slice(0, 50).map((problemId) => ({ member_id: inviter.id, challenge_id: challengeId, problem_id: problemId })),
      ...problemIds.slice(50, 100).map((problemId) => ({ member_id: invitee.id, challenge_id: challengeId, problem_id: problemId })),
    ]).select("id, problem_id");
    expect(seeded.error).toBeNull();
    const solveId = seeded.data!.find((row) => row.problem_id === problemIds[0])!.id as string;

    async function correct(member: Profile, solve: string, key: string, status: "credited" | "not_credited") {
      return member.client.rpc("correct_solve_v1", {
        p_idempotency_key: key,
        p_command_version: 1,
        p_command_kind: "correct_solve",
        p_member_id: member.id,
        p_member_email: member.email,
        p_challenge_id: challengeId,
        p_solve_id: solve,
        p_category: "reclassified",
        p_reason: "Correcting my self-attestation.",
        p_resulting_credit_status: status,
      });
    }

    const unauthorized = await correct(invitee, solveId, crypto.randomUUID(), "not_credited");
    expect(unauthorized.error?.code).toBe("42501");

    const first = await correct(inviter, solveId, crypto.randomUUID(), "credited");
    expect(first.error).toBeNull();
    expect(first.data).toMatchObject({ solveId, actorId: inviter.id, sequence: 1, resultingCreditStatus: "credited" });
    const firstKey = crypto.randomUUID();
    const firstRetry = await correct(inviter, solveId, firstKey, "not_credited");
    expect(firstRetry.error).toBeNull();
    const firstReplay = await correct(inviter, solveId, firstKey, "not_credited");
    expect(firstReplay.error).toBeNull();
    expect(firstReplay.data).toEqual(firstRetry.data);

    const concurrent = await Promise.all([
      correct(inviter, solveId, crypto.randomUUID(), "not_credited"),
      correct(inviter, solveId, crypto.randomUUID(), "not_credited"),
    ]);
    expect(concurrent.every((result) => result.error === null)).toBe(true);
    expect(new Set(concurrent.map((result) => (result.data as { sequence: number }).sequence)).size).toBe(2);

    const deteriorated = await admin.rpc("get_challenge_at_v1", { p_challenge_id: challengeId, p_authoritative_now: "2030-01-03T12:00:00.000Z" });
    expect(deteriorated.error).toBeNull();
    expect(deteriorated.data).toMatchObject({ progress: { pairProgress: 49.5, petCondition: "deteriorated", highestEvolutionStage: 2 } });
    const restored = await correct(inviter, solveId, crypto.randomUUID(), "credited");
    expect(restored.error).toBeNull();
    expect(restored.data).toMatchObject({ solveId, sequence: 5, resultingCreditStatus: "credited" });

    const [ownerView, partnerView] = await Promise.all([
      admin.rpc("get_challenge_at_v1", { p_challenge_id: challengeId, p_authoritative_now: "2030-01-03T12:00:00.000Z" }),
      admin.rpc("get_challenge_at_v1", { p_challenge_id: challengeId, p_authoritative_now: "2030-01-03T12:00:00.000Z" }),
    ]);
    expect(ownerView.error).toBeNull();
    expect(partnerView.error).toBeNull();
    expect(ownerView.data).toMatchObject({
      progress: { pairProgress: 50, petCondition: "sad", highestEvolutionStage: 2 },
      solveHistory: expect.arrayContaining([expect.objectContaining({ id: solveId, creditStatus: "credited", originalCreditStatus: "credited" })]),
    });
    const history = (ownerView.data as { solveHistory: Array<{ id: string; corrections: Array<{ sequence: number }> }> }).solveHistory.find((entry) => entry.id === solveId)!;
    expect(history.corrections.map((correction) => correction.sequence)).toEqual([1, 2, 3, 4, 5]);
    const partnerHistory = (partnerView.data as { solveHistory: Array<{ id: string; corrections: Array<{ sequence: number }> }> }).solveHistory.find((entry) => entry.id === solveId)!;
    expect(partnerHistory.corrections.map((correction) => correction.sequence)).toEqual([1, 2, 3, 4, 5]);
  });

  it("ends success, deadline incomplete, and abandonment atomically, then keeps restart fresh", async () => {
    admin = createClient(credentials!.url, credentials!.serviceKey);
    const owner = await profile("TerminalOwner");
    const partner = await profile("TerminalPartner");
    const problemIds = PINNED_PROBLEM_SET_VERSION.problems.map((problem) => problem.id);

    async function seededChallenge(name: string, status: "active" | "scheduled" = "active", deadlineDate = "2030-01-03", startDate = "2030-01-01") {
      const invitation = await admin.from("invitations").insert({
        inviter_id: owner.id,
        invited_email: partner.email,
        challenge_time_zone: "UTC",
        start_date: startDate,
        deadline_date: deadlineDate,
        problem_set_version_id: "neetcode-150-2026-08-15",
        status: "accepted",
      }).select("id").single();
      expect(invitation.error).toBeNull();
      const challenge = await admin.from("challenges").insert({
        invitation_id: invitation.data!.id,
        inviter_id: owner.id,
        invited_member_id: partner.id,
        challenge_time_zone: "UTC",
        start_date: startDate,
        deadline_date: deadlineDate,
        problem_set_version_id: "neetcode-150-2026-08-15",
        status,
      }).select("id").single();
      expect(challenge.error).toBeNull();
      const challengeId = challenge.data!.id as string;
      expect((await admin.from("challenge_members").insert([
        { challenge_id: challengeId, member_id: owner.id, member_email: owner.email, display_name: name },
        { challenge_id: challengeId, member_id: partner.id, member_email: partner.email, display_name: "TerminalPartner" },
      ])).error).toBeNull();
      expect((await admin.from("member_commitments").insert([
        { member_id: owner.id, challenge_id: challengeId },
        { member_id: partner.id, challenge_id: challengeId },
      ])).error).toBeNull();
      return challengeId;
    }

    async function addSolves(challengeId: string, memberId: string, count: number, claimedAt: string, offset = 0, creditStatus = "credited") {
      const rows = problemIds.slice(offset, offset + count).map((problemId) => ({
        member_id: memberId,
        challenge_id: challengeId,
        problem_id: problemId,
        claimed_at: claimedAt,
        credit_status: creditStatus,
      }));
      expect((await admin.from("solves").insert(rows)).error).toBeNull();
    }

    const completedId = await seededChallenge("TerminalOwner");
    await addSolves(completedId, owner.id, 150, "2030-01-02T12:00:00Z");
    await addSolves(completedId, partner.id, 150, "2030-01-02T12:00:00Z");
    const completed = await admin.rpc("get_challenge_at_v1", { p_challenge_id: completedId, p_authoritative_now: "2030-01-02T12:00:00Z" });
    expect(completed.error).toBeNull();
    expect(completed.data).toMatchObject({ status: "completed", completionFarewellAt: expect.any(String) });
    const farewellAt = (completed.data as { completionFarewellAt: string }).completionFarewellAt;
    expect((await admin.from("member_commitments").select("member_id").in("member_id", [owner.id, partner.id])).data).toHaveLength(0);
    const completedSolve = (await admin.from("solves").select("id").eq("challenge_id", completedId).eq("member_id", owner.id).limit(1).single()).data!.id as string;
    const correction = await owner.client.rpc("correct_solve_v1", {
      p_idempotency_key: crypto.randomUUID(), p_command_version: 1, p_command_kind: "correct_solve",
      p_member_id: owner.id, p_member_email: owner.email, p_challenge_id: completedId, p_solve_id: completedSolve,
      p_category: "retracted", p_reason: "Post-terminal correction", p_resulting_credit_status: "not_credited",
    });
    expect(correction.error).toBeNull();
    const correctedCompleted = await owner.client.rpc("get_challenge_v1", { p_challenge_id: completedId });
    expect(correctedCompleted.data).toMatchObject({ status: "incomplete", completionFarewellAt: farewellAt });
    expect((await admin.from("challenges").select("highest_evolution_stage").eq("id", completedId).single()).data?.highest_evolution_stage).toBe(4);
    const correctedAgain = await admin.rpc("get_challenge_at_v1", { p_challenge_id: completedId, p_authoritative_now: "2030-01-03T12:00:00Z" });
    expect((correctedAgain.data as { completionFarewellAt: string }).completionFarewellAt).toBe(farewellAt);

    const abandonedId = await seededChallenge("TerminalOwner");
    const abandoned = await admin.rpc("abandon_challenge_at_v1", {
      p_idempotency_key: crypto.randomUUID(), p_command_version: 1, p_command_kind: "abandon_challenge",
      p_member_id: partner.id, p_member_email: partner.email, p_challenge_id: abandonedId,
      p_authoritative_now: "2030-01-01T00:00:00Z",
    });
    expect(abandoned.error).toBeNull();
    expect(abandoned.data).toMatchObject({ status: "abandoned", terminalActorId: partner.id });
    expect((await admin.from("member_commitments").select("member_id").in("member_id", [owner.id, partner.id])).data).toHaveLength(0);

    const ownerAbandonedId = await seededChallenge("TerminalOwner");
    const ownerAbandoned = await owner.client.rpc("abandon_challenge_v1", {
      p_idempotency_key: crypto.randomUUID(), p_command_version: 1, p_command_kind: "abandon_challenge",
      p_member_id: owner.id, p_member_email: owner.email, p_challenge_id: ownerAbandonedId,
    });
    expect(ownerAbandoned.error).toBeNull();
    expect(ownerAbandoned.data).toMatchObject({ status: "abandoned", terminalActorId: owner.id });

    const lateSolveId = await seededChallenge("TerminalOwner", "active", "2020-01-03", "2020-01-01");
    const lateSolve = await owner.client.rpc("create_solve_v1", {
      p_idempotency_key: crypto.randomUUID(), p_command_version: 1, p_command_kind: "create_solve",
      p_member_id: owner.id, p_member_email: owner.email, p_challenge_id: lateSolveId,
      p_problem_id: problemIds[0], p_affirmed: true,
    });
    expect(lateSolve.error?.code).toBe("P0003");
    expect((await admin.rpc("get_challenge_at_v1", { p_challenge_id: lateSolveId, p_authoritative_now: "2020-01-04T00:00:00Z" })).data).toMatchObject({ status: "incomplete" });
    expect((await admin.from("challenges").select("status").eq("id", lateSolveId).single()).data?.status).toBe("incomplete");
    expect((await admin.from("member_commitments").select("member_id").eq("challenge_id", lateSolveId)).data).toHaveLength(0);

    const incompleteId = await seededChallenge("TerminalOwner");
    await addSolves(incompleteId, owner.id, 149, "2030-01-02T12:00:00Z");
    await addSolves(incompleteId, partner.id, 149, "2030-01-02T12:00:00Z");
    await addSolves(incompleteId, owner.id, 1, "2030-01-04T00:00:00Z", 149);
    const incomplete = await admin.rpc("get_challenge_at_v1", { p_challenge_id: incompleteId, p_authoritative_now: "2030-01-04T00:00:00Z" });
    expect(incomplete.error).toBeNull();
    expect(incomplete.data).toMatchObject({ status: "incomplete" });
    expect((await admin.from("member_commitments").select("member_id").in("member_id", [owner.id, partner.id])).data).toHaveLength(0);

    const restartInvitation = await owner.client.rpc("create_invitation_v1", {
      p_idempotency_key: crypto.randomUUID(), p_command_version: 1, p_command_kind: "create_invitation",
      p_member_id: owner.id, p_member_email: owner.email, p_invited_email: partner.email,
      p_challenge_time_zone: "UTC", p_start_date: "2099-01-01", p_deadline_date: "2099-01-30",
      p_problem_set_version_id: "neetcode-150-2026-08-15",
    });
    expect(restartInvitation.error).toBeNull();
    const restarted = await partner.client.rpc("accept_invitation_v1", {
      p_idempotency_key: crypto.randomUUID(), p_command_version: 1, p_command_kind: "accept_invitation",
      p_member_id: partner.id, p_member_email: partner.email, p_invitation_id: (restartInvitation.data as { id: string }).id,
    });
    expect(restarted.error).toBeNull();
    expect(restarted.data).toMatchObject({ status: "scheduled" });
    expect(restarted.data.id).not.toBe(completedId);
    expect((await admin.from("member_commitments").select("member_id").in("member_id", [owner.id, partner.id])).data).toHaveLength(2);
    expect((await admin.from("solves").select("id").eq("challenge_id", restarted.data.id)).data).toHaveLength(0);
    expect((await admin.from("challenges").select("status, completion_farewell_at").eq("id", completedId).single()).data).toMatchObject({ status: "incomplete", completion_farewell_at: farewellAt });
    expect((await admin.from("challenges").select("highest_evolution_stage").eq("id", restarted.data.id).single()).data?.highest_evolution_stage).toBe(1);
  });

  it("deletes one Member atomically, preserves a bounded Deleted Member view, and isolates re-registration", async () => {
    admin = createClient(credentials!.url, credentials!.serviceKey);
    const deleting = await profile("DeleteMe");
    const partner = await profile("DeletePartner");
    expect((await admin.from("member_preferences").insert({ member_id: deleting.id, preferences: { theme: "private" } })).error).toBeNull();
    const invitation = await admin.from("invitations").insert({
      inviter_id: deleting.id, invited_email: partner.email, challenge_time_zone: "UTC",
      start_date: "2026-08-01", deadline_date: "2026-08-30", problem_set_version_id: "neetcode-150-2026-08-15", status: "accepted",
    }).select("id").single();
    expect(invitation.error).toBeNull();
    const challenge = await admin.from("challenges").insert({
      invitation_id: invitation.data!.id, inviter_id: deleting.id, invited_member_id: partner.id,
      challenge_time_zone: "UTC", start_date: "2026-08-01", deadline_date: "2026-08-30",
      problem_set_version_id: "neetcode-150-2026-08-15", status: "active",
    }).select("id").single();
    expect(challenge.error).toBeNull();
    const challengeId = challenge.data!.id as string;
    expect((await admin.from("challenge_members").insert([
      { challenge_id: challengeId, member_id: deleting.id, member_email: deleting.email, display_name: "DeleteMe" },
      { challenge_id: challengeId, member_id: partner.id, member_email: partner.email, display_name: "DeletePartner" },
    ])).error).toBeNull();
    expect((await admin.from("member_commitments").insert([
      { member_id: deleting.id, challenge_id: challengeId }, { member_id: partner.id, challenge_id: challengeId },
    ])).error).toBeNull();
    expect((await admin.from("solves").insert({
      member_id: deleting.id, challenge_id: challengeId, problem_id: "problem:0217-contains-duplicate",
    })).error).toBeNull();

    const deleted = await deleteMember(deleting);
    expect(deleted.error).toBeNull();
    expect(deleted.data).toMatchObject({ deletedMemberId: expect.any(String) });
    const accountEndedNotice = await admin.from("transactional_notices")
      .select("notice_type,recipient_email,recipient_member_id,actor_member_id,challenge_id,delivery_state")
      .eq("source_event_key", `challenge:${challengeId}:account-ended`)
      .maybeSingle();
    expect(accountEndedNotice.error).toBeNull();
    expect(accountEndedNotice.data).toMatchObject({
      notice_type: "challenge_account_ended",
      recipient_email: partner.email.toLowerCase(),
      recipient_member_id: partner.id,
      actor_member_id: deleted.data.deletedMemberId,
      challenge_id: challengeId,
      delivery_state: "queued",
    });
    const partnerView = await partner.client.rpc("get_challenge_v1", { p_challenge_id: challengeId });
    expect(partnerView.error).toBeNull();
    expect(partnerView.data).toMatchObject({ status: "abandoned", terminalActorId: deleted.data.deletedMemberId, members: expect.arrayContaining([
      expect.objectContaining({ memberId: deleted.data.deletedMemberId, email: "Deleted Member", displayName: "Deleted Member" }),
    ]) });
    const expired = await admin.rpc("get_challenge_at_v1", { p_challenge_id: challengeId, p_authoritative_now: "2027-08-17T00:00:00Z" });
    expect(expired.error).toBeNull();
    expect(expired.data).toBeNull();
    const cleanup = await admin.rpc("cleanup_deleted_member_records_at_v1", { p_authoritative_now: "2027-08-17T00:00:00Z" });
    expect(cleanup.error).toBeNull();
    expect(cleanup.data).toBe(1);

    const scheduledOwner = await profile("ScheduledDelete");
    const scheduledPartner = await profile("ScheduledPartner");
    const scheduledInvitation = await admin.from("invitations").insert({
      inviter_id: scheduledOwner.id, invited_email: scheduledPartner.email, challenge_time_zone: "UTC",
      start_date: "2099-01-01", deadline_date: "2099-01-30", problem_set_version_id: "neetcode-150-2026-08-15", status: "accepted",
    }).select("id").single();
    expect(scheduledInvitation.error).toBeNull();
    const scheduled = await admin.from("challenges").insert({
      invitation_id: scheduledInvitation.data!.id, inviter_id: scheduledOwner.id, invited_member_id: scheduledPartner.id,
      challenge_time_zone: "UTC", start_date: "2099-01-01", deadline_date: "2099-01-30",
      problem_set_version_id: "neetcode-150-2026-08-15", status: "scheduled",
    }).select("id").single();
    expect(scheduled.error).toBeNull();
    const scheduledChallengeId = scheduled.data!.id as string;
    expect((await admin.from("challenge_members").insert([
      { challenge_id: scheduledChallengeId, member_id: scheduledOwner.id, member_email: scheduledOwner.email, display_name: "ScheduledDelete" },
      { challenge_id: scheduledChallengeId, member_id: scheduledPartner.id, member_email: scheduledPartner.email, display_name: "ScheduledPartner" },
    ])).error).toBeNull();
    expect((await admin.from("member_commitments").insert([
      { member_id: scheduledOwner.id, challenge_id: scheduledChallengeId }, { member_id: scheduledPartner.id, challenge_id: scheduledChallengeId },
    ])).error).toBeNull();
    const scheduledDeleted = await deleteMember(scheduledOwner);
    expect(scheduledDeleted.error).toBeNull();
    expect((await scheduledPartner.client.rpc("get_challenge_v1", { p_challenge_id: scheduledChallengeId })).data).toMatchObject({ status: "canceled" });

    // A terminal Challenge has already released its commitments. Deleting a
    // participant only anonymizes that historical row; it does not create a
    // misleading account-ended lifecycle notice.
    const terminalOwner = await profile("TerminalDelete");
    const terminalPartner = await profile("TerminalDeletePartner");
    const terminalInvitation = await admin.from("invitations").insert({
      inviter_id: terminalOwner.id, invited_email: terminalPartner.email, challenge_time_zone: "UTC",
      start_date: "2099-01-01", deadline_date: "2099-01-30", problem_set_version_id: "neetcode-150-2026-08-15", status: "accepted",
    }).select("id").single();
    expect(terminalInvitation.error).toBeNull();
    const terminalChallenge = await admin.from("challenges").insert({
      invitation_id: terminalInvitation.data!.id, inviter_id: terminalOwner.id, invited_member_id: terminalPartner.id,
      challenge_time_zone: "UTC", start_date: "2099-01-01", deadline_date: "2099-01-30",
      problem_set_version_id: "neetcode-150-2026-08-15", status: "completed", terminal_at: new Date().toISOString(),
    }).select("id").single();
    expect(terminalChallenge.error).toBeNull();
    const terminalChallengeId = terminalChallenge.data!.id as string;
    expect((await admin.from("challenge_members").insert([
      { challenge_id: terminalChallengeId, member_id: terminalOwner.id, member_email: terminalOwner.email, display_name: "TerminalDelete" },
      { challenge_id: terminalChallengeId, member_id: terminalPartner.id, member_email: terminalPartner.email, display_name: "TerminalPartner" },
    ])).error).toBeNull();
    expect((await deleteMember(terminalOwner)).error).toBeNull();
    const terminalNotice = await admin.from("transactional_notices")
      .select("id")
      .eq("source_event_key", `challenge:${terminalChallengeId}:account-ended`)
      .maybeSingle();
    expect(terminalNotice.error).toBeNull();
    expect(terminalNotice.data).toBeNull();

    const empty = await profile("NoChallengeDelete");
    const emptyDeleted = await deleteMember(empty);
    expect(emptyDeleted.error).toBeNull();
    expect((await admin.auth.admin.getUserById(empty.id)).data.user).toBeNull();
    expect((await admin.from("member_preferences").select("member_id").eq("member_id", deleting.id)).data).toHaveLength(0);

    const reRegistered = await admin.auth.admin.createUser({ email: deleting.email, password: "new-pass-12345", email_confirm: true });
    expect(reRegistered.error).toBeNull();
    expect(reRegistered.data.user?.id).not.toBe(deleting.id);
  });

  it("anonymizes an incoming Invitation, denies stale/outsider access, and expires each retention ledger window", async () => {
    admin = createClient(credentials!.url, credentials!.serviceKey);
    const inviter = await profile("IncomingInviteOwner");
    const invitee = await profile("IncomingInvitee");
    const outsider = await profile("IncomingOutsider");
    const invitationId = await invitation(inviter, invitee, crypto.randomUUID());

    const noticeBefore = await admin.from("transactional_notices")
      .select("recipient_member_id, inviter_member_id, recipient_email")
      .eq("source_event_key", `invitation:${invitationId}:created`).single();
    expect(noticeBefore.error).toBeNull();
    expect(noticeBefore.data).toMatchObject({ recipient_member_id: invitee.id, inviter_member_id: inviter.id });

    const deleted = await deleteMember(invitee);
    expect(deleted.error).toBeNull();
    const deletedMemberId = (deleted.data as { deletedMemberId: string }).deletedMemberId;
    const invitationRow = await admin.from("invitations")
      .select("status, invited_email, deleted_member_record_id, retention_expires_at")
      .eq("id", invitationId).single();
    expect(invitationRow.error).toBeNull();
    expect(invitationRow.data).toMatchObject({
      status: "revoked", deleted_member_record_id: deletedMemberId,
      invited_email: expect.stringMatching(/^deleted\+[0-9a-f]+@invalid\.larp-code\.example$/),
    });
    const inviterView = await inviter.client.rpc("get_invitation_v1", { p_invitation_id: invitationId });
    expect(inviterView.error).toBeNull();
    expect(inviterView.data).toMatchObject({ invitedEmail: "Deleted Member", status: "revoked" });
    const noticeAfter = await admin.from("transactional_notices")
      .select("recipient_member_id, inviter_member_id, recipient_email, inviter_display_name")
      .eq("source_event_key", `invitation:${invitationId}:created`).single();
    expect(noticeAfter.data).toMatchObject({
      recipient_member_id: deletedMemberId, inviter_member_id: inviter.id,
      recipient_email: expect.stringMatching(/^deleted\+[0-9a-f]+@invalid\.larp-code\.example$/),
    });

    const staleAccount = await invitee.client.rpc("get_member_account_v1");
    expect(staleAccount.error).toBeNull();
    expect(staleAccount.data).toBeNull();
    const staleInvitation = await invitee.client.rpc("get_invitation_v1", { p_invitation_id: invitationId });
    expect(staleInvitation.error?.code).toBe("42501");
    const outsiderInvitation = await outsider.client.rpc("get_invitation_v1", { p_invitation_id: invitationId });
    expect(outsiderInvitation.error?.code).toBe("42501");

    const retention = await admin.rpc("get_deleted_member_retention_v1", { p_deleted_member_record_id: deletedMemberId });
    expect(retention.error).toBeNull();
    expect(retention.data).toMatchObject({
      invitation: expect.any(String), challenge: expect.any(String),
      diagnostic: expect.any(String), securityAudit: expect.any(String), backup: expect.any(String),
      ledger: expect.arrayContaining([
        expect.objectContaining({ category: "diagnostic", source: "repository_ledger" }),
        expect.objectContaining({ category: "security_audit", source: "repository_ledger" }),
        expect.objectContaining({ category: "backup", source: "managed_backup" }),
      ]),
    });
    const invitationAtExpiry = await admin.rpc("get_invitation_at_v1", {
      p_invitation_id: invitationId,
      p_authoritative_now: "2026-09-16T00:00:00Z",
    });
    expect(invitationAtExpiry.error).toBeNull();
    expect(invitationAtExpiry.data).toBeNull();

    const monthCleanup = await admin.rpc("cleanup_deleted_member_records_at_v1", { p_authoritative_now: "2026-09-16T00:00:00Z" });
    expect(monthCleanup.error).toBeNull();
    const monthRetention = await admin.rpc("get_deleted_member_retention_v1", { p_deleted_member_record_id: deletedMemberId });
    expect(monthRetention.data?.ledger).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: "security_audit" }),
    ]));
    expect(monthRetention.data?.ledger).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ category: "diagnostic" }),
      expect.objectContaining({ category: "backup" }),
    ]));
    await admin.rpc("cleanup_deleted_member_records_at_v1", { p_authoritative_now: "2026-11-15T00:00:00Z" });
    const securityRetention = await admin.rpc("get_deleted_member_retention_v1", { p_deleted_member_record_id: deletedMemberId });
    expect(securityRetention.data?.ledger).toEqual([]);
    const finalCleanup = await admin.rpc("cleanup_deleted_member_records_at_v1", { p_authoritative_now: "2027-08-17T00:00:00Z" });
    expect(finalCleanup.data).toBeGreaterThanOrEqual(1);
    expect((await admin.from("invitations").select("id").eq("id", invitationId)).data).toHaveLength(0);
  });
});

void acceptanceDb;
