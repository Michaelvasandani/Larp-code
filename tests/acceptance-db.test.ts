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
      const result = await inviter.client.rpc("get_challenge_at_v1", {
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
    expect(progressOf(snapshot)).toMatchObject({ pairProgress: 150, petCondition: "healthy", currentEvolutionStage: 4, highestEvolutionStage: 4 });
    expect(progressOf(snapshot).members.map((member) => member.paceGap.copy)).toEqual([
      "Today's pace met; 0 at the target.",
      "Today's pace met; 0 at the target.",
    ]);

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
    expect(afterDeadline).toMatchObject({ status: "active", progress: { day: 4, expectedProgress: 150, pairProgress: 150 } });
  });
});

void acceptanceDb;
