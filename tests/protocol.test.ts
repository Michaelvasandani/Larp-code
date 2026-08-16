import { describe, expect, it } from "vitest";

import {
  PROTOCOL_VERSION,
  isPopupRequest,
  isPopupResponse,
  type AppSnapshot,
  type PopupRequest,
} from "../src/shared/protocol";

const signedOutSnapshot: AppSnapshot = {
  contractVersion: PROTOCOL_VERSION,
  kind: "signed_out",
  authoritativeServerTime: "2026-08-15T00:00:00.000Z",
  freshness: { revision: "foundation-1", fetchedAt: "2026-08-15T00:00:00.000Z" },
  compatibility: { minimumClientVersion: "0.1.0" },
  backend: { status: "reachable", schemaVersion: 1 },
  worker: { bootId: "boot-1", bootCount: 1, sessionRestoredFromStorage: false },
};

const accountSnapshot: AppSnapshot = {
  ...signedOutSnapshot,
  kind: "account",
  account: {
    id: "member-1",
    email: "member@example.test",
    displayName: "Ada",
    status: "active",
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
    adultConfirmedAt: "2026-08-15T00:00:00.000Z",
    consentAcceptedAt: "2026-08-15T00:00:00.000Z",
    consentVersion: "PRIV-031-v1",
  },
};

describe("versioned popup/worker protocol", () => {
  it("accepts a current snapshot request", () => {
    const request: PopupRequest = { version: PROTOCOL_VERSION, type: "get_snapshot" };

    expect(isPopupRequest(request)).toBe(true);
  });

  it("rejects requests from another contract version", () => {
    expect(isPopupRequest({ version: PROTOCOL_VERSION + 1, type: "get_snapshot" })).toBe(false);
    expect(isPopupRequest({ version: PROTOCOL_VERSION, type: "unknown" })).toBe(false);
  });

  it("accepts a successful complete snapshot response", () => {
    expect(isPopupResponse({ ok: true, snapshot: signedOutSnapshot })).toBe(true);
    expect(isPopupResponse({ ok: true, snapshot: accountSnapshot })).toBe(true);
  });

  it("rejects partial or malformed success responses", () => {
    expect(isPopupResponse({ ok: true, snapshot: { kind: "signed_out" } })).toBe(false);
    expect(isPopupResponse({ ok: true, snapshot: signedOutSnapshot, stale: true })).toBe(false);
    expect(isPopupResponse({
      ok: true,
      snapshot: { ...accountSnapshot, account: { ...accountSnapshot.account, displayName: "" } },
    })).toBe(false);
  });

  it("accepts typed errors without allowing arbitrary response shapes", () => {
    expect(
      isPopupResponse({
        ok: false,
        error: { code: "connection_unavailable", message: "Supabase is unavailable." },
      }),
    ).toBe(true);
    expect(isPopupResponse({ ok: false, error: "not typed" })).toBe(false);
  });

  it("accepts the email OTP request and verification messages", () => {
    expect(isPopupRequest({
      version: PROTOCOL_VERSION,
      type: "request_email_otp",
      email: "member@example.test",
    })).toBe(true);
    expect(isPopupRequest({
      version: PROTOCOL_VERSION,
      type: "verify_email_otp",
      email: "member@example.test",
      token: "123456",
    })).toBe(true);
    expect(isPopupRequest({
      version: PROTOCOL_VERSION,
      type: "resend_email_otp",
      email: "member@example.test",
    })).toBe(true);
    expect(isPopupRequest({ version: PROTOCOL_VERSION, type: "sign_out" })).toBe(true);
    expect(isPopupRequest({ version: PROTOCOL_VERSION, type: "request_update" })).toBe(true);
    expect(isPopupRequest({ version: PROTOCOL_VERSION, type: "erase_local_data" })).toBe(true);
    expect(isPopupRequest({ version: PROTOCOL_VERSION, type: "request_deletion_otp", email: "member@example.test" })).toBe(true);
    expect(isPopupRequest({ version: PROTOCOL_VERSION, type: "delete_member_account", confirmation: "DELETE MY ACCOUNT", otp: "123456" })).toBe(true);
    expect(isPopupRequest({
      version: PROTOCOL_VERSION,
      type: "create_member_account",
      displayName: "Ada",
      adultConfirmed: true,
      consentAccepted: true,
    })).toBe(true);
    expect(isPopupRequest({
      version: PROTOCOL_VERSION,
      type: "update_display_name",
      displayName: "Grace",
    })).toBe(true);
    expect(isPopupRequest({
      version: PROTOCOL_VERSION,
      type: "create_invitation",
      invitedEmail: "friend@example.test",
      timeZone: "America/Los_Angeles",
      startDate: "2026-08-16",
      deadlineDate: "2026-09-14",
    })).toBe(true);
    expect(isPopupRequest({
      version: PROTOCOL_VERSION,
      type: "accept_invitation",
      invitationId: "invitation-1",
    })).toBe(true);
    expect(isPopupResponse({
      ok: true,
      auth: { status: "ready" },
      command: { status: "applied", kind: "delete_member_account", idempotencyKey: "delete-1" },
    })).toBe(true);
  });

  it("accepts a complete Invitation Snapshot and rejects omitted terms", () => {
    const { account: _account, ...accountMetadata } = accountSnapshot;
    expect(_account).toBeDefined();
    const invitationSnapshot = {
      ...accountMetadata,
      kind: "invitation" as const,
      invitation: {
        id: "invitation-1",
        inviterId: "member-1",
        inviterDisplayName: "Ada",
        invitedEmail: "friend@example.test",
        timeZone: "America/Los_Angeles",
        startDate: "2026-08-16",
        deadlineDate: "2026-09-14",
        problemSetVersionId: "version-a",
        status: "pending" as const,
        createdAt: "2026-08-15T00:00:00.000Z",
      },
    };
    expect(isPopupResponse({ ok: true, snapshot: invitationSnapshot })).toBe(true);
    expect(isPopupResponse({ ok: true, snapshot: { ...invitationSnapshot, invitation: undefined } })).toBe(false);
  });

  it("requires authoritative Active progress and accepts an explicit solve affirmation", () => {
    const progress = {
      problemSetVersionId: "version-a",
      day: 1,
      durationDays: 30,
      expectedProgress: 5,
      previousExpectedProgress: 0,
      earlierExpectedProgress: 0,
      pairProgress: 0,
      petCondition: "hungry" as const,
      currentEvolutionStage: 1 as const,
      highestEvolutionStage: 1 as const,
      members: [
        {
          memberId: "member-1", email: "ada@example.test", displayName: "Ada", authority: "equal" as const,
          creditedTotal: 0, paceStatus: "on_pace_today" as const,
          paceGap: { previousTarget: 0, currentTarget: 5, gapToPreviousTarget: 0, amountNeededToday: 5, amountAhead: 0, copy: "5 more needed for today's target." },
        },
        {
          memberId: "member-2", email: "grace@example.test", displayName: "Grace", authority: "equal" as const,
          creditedTotal: 0, paceStatus: "on_pace_today" as const,
          paceGap: { previousTarget: 0, currentTarget: 5, gapToPreviousTarget: 0, amountNeededToday: 5, amountAhead: 0, copy: "5 more needed for today's target." },
        },
      ],
    };
    const active = {
      ...signedOutSnapshot,
      kind: "active" as const,
      challenge: {
        id: "challenge-1", invitationId: "invitation-1", timeZone: "UTC", startDate: "2026-08-16", deadlineDate: "2026-09-14",
        problemSetVersionId: "version-a", status: "active" as const, createdAt: "2026-08-15T00:00:00.000Z",
        members: [
          { memberId: "member-1", email: "ada@example.test", displayName: "Ada", authority: "equal" as const },
          { memberId: "member-2", email: "grace@example.test", displayName: "Grace", authority: "equal" as const },
        ],
      },
      progress,
      actions: ["solve"] as const,
    };
    expect(isPopupResponse({ ok: true, snapshot: active })).toBe(true);
    expect(isPopupResponse({ ok: true, snapshot: { ...active, progress: undefined } })).toBe(false);
    expect(isPopupRequest({ version: PROTOCOL_VERSION, type: "credit_solve", challengeId: "challenge-1", problemId: "problem:1", affirmed: true })).toBe(true);
    expect(isPopupRequest({ version: PROTOCOL_VERSION, type: "credit_solve", challengeId: "challenge-1", problemId: "problem:1", affirmed: false })).toBe(false);
  });

  it("accepts complete ordered Solve and correction history in an authoritative Challenge Snapshot", () => {
    const history = [{
      id: "solve-1",
      memberId: "member-1",
      challengeId: "challenge-1",
      problemId: "problem:1",
      claimedAt: "2026-08-16T00:01:00.000Z",
      creditStatus: "not_credited" as const,
      originalCreditStatus: "credited" as const,
      corrections: [{
        id: "correction-1",
        solveId: "solve-1",
        challengeId: "challenge-1",
        actorId: "member-1",
        correctedAt: "2026-08-16T00:02:00.000Z",
        category: "reclassified",
        reason: "Completed before this Challenge.",
        resultingCreditStatus: "not_credited" as const,
        sequence: 1,
      }],
    }];
    const snapshot = {
      ...signedOutSnapshot,
      kind: "active" as const,
      challenge: {
        id: "challenge-1", invitationId: "invitation-1", timeZone: "UTC", startDate: "2026-08-16", deadlineDate: "2026-09-14",
        problemSetVersionId: "version-a", status: "active" as const, createdAt: "2026-08-15T00:00:00.000Z",
        members: [
          { memberId: "member-1", email: "ada@example.test", displayName: "Ada", authority: "equal" as const },
          { memberId: "member-2", email: "grace@example.test", displayName: "Grace", authority: "equal" as const },
        ],
        solveHistory: history,
      },
      progress: {
        problemSetVersionId: "version-a", day: 1, durationDays: 30, expectedProgress: 5,
        previousExpectedProgress: 0, earlierExpectedProgress: 0, pairProgress: 0, petCondition: "hungry" as const,
        currentEvolutionStage: 1 as const, highestEvolutionStage: 1 as const,
        members: [
          { memberId: "member-1", email: "ada@example.test", displayName: "Ada", authority: "equal" as const, creditedTotal: 0, paceStatus: "on_pace_today" as const, paceGap: { previousTarget: 0, currentTarget: 5, gapToPreviousTarget: 0, amountNeededToday: 5, amountAhead: 0, copy: "5 more needed for today's target." } },
          { memberId: "member-2", email: "grace@example.test", displayName: "Grace", authority: "equal" as const, creditedTotal: 0, paceStatus: "on_pace_today" as const, paceGap: { previousTarget: 0, currentTarget: 5, gapToPreviousTarget: 0, amountNeededToday: 5, amountAhead: 0, copy: "5 more needed for today's target." } },
        ],
      },
    };
    expect(isPopupResponse({ ok: true, snapshot })).toBe(true);
  });

  it("accepts authenticated Invitation details and a complete scheduled Challenge", () => {
    const details = {
      problemSetVersion: {
        id: "version-a",
        sourceRepository: "https://github.com/neetcode-gh/leetcode",
        sourceDataFile: ".problemSiteData.json",
        sourceCommitSha: "a".repeat(40),
        licenseNotice: "MIT License",
        nonAffiliationNotice: "Independent product.",
        importedAt: "2026-08-15T00:00:00.000Z",
        problemCount: 150,
      },
      partner: { memberId: "member-1", email: "ada@example.test", displayName: "Ada" },
      sharedRecord: { visibility: "both_members" as const, authority: "equal" as const, canEitherMemberEnd: true as const },
    };
    const snapshot = {
      ...signedOutSnapshot,
      kind: "invitation" as const,
      invitation: {
        id: "invitation-1",
        inviterId: "member-1",
        inviterDisplayName: "Ada",
        invitedEmail: "friend@example.test",
        timeZone: "America/Los_Angeles",
        startDate: "2026-08-16",
        deadlineDate: "2026-09-14",
        problemSetVersionId: "version-a",
        status: "pending" as const,
        createdAt: "2026-08-15T00:00:00.000Z",
      },
      details,
    };
    expect(isPopupResponse({ ok: true, snapshot })).toBe(true);
    expect(isPopupResponse({ ok: true, snapshot: {
      ...signedOutSnapshot,
      kind: "scheduled" as const,
      challenge: {
        id: "challenge-1",
        invitationId: "invitation-1",
        timeZone: "America/Los_Angeles",
        startDate: "2026-08-16",
        deadlineDate: "2026-09-14",
        problemSetVersionId: "version-a",
        status: "scheduled" as const,
        createdAt: "2026-08-15T00:00:00.000Z",
        members: [
          { memberId: "member-1", email: "ada@example.test", displayName: "Ada", authority: "equal" as const },
          { memberId: "member-2", email: "friend@example.test", displayName: "Grace", authority: "equal" as const },
        ],
      },
    }})).toBe(true);
  });

  it("accepts an update-required Snapshot without permitting Member Data", () => {
    const updateRequired = {
      ...signedOutSnapshot,
      kind: "update_required" as const,
      compatibility: {
        minimumClientVersion: "2.0.0",
        clientVersion: "0.1.0",
        updateUrl: "https://chromewebstore.google.com/detail/larp-code",
      },
    };
    expect(isPopupResponse({ ok: true, snapshot: updateRequired })).toBe(true);
    expect(isPopupResponse({ ok: true, snapshot: { ...updateRequired, account: accountSnapshot.account } })).toBe(false);
  });

  it("accepts an account-bound pending command and typed command outcome", () => {
    const pending = {
      version: 1,
      kind: "update_display_name",
      idempotencyKey: "key-1",
      memberId: "member-1",
      memberEmail: "member@example.test",
      intent: { displayName: "Grace" },
      requestedAt: "2026-08-15T00:00:00.000Z",
    };
    const snapshot = { ...accountSnapshot, pendingCommand: pending };
    expect(isPopupResponse({ ok: true, snapshot })).toBe(true);
    expect(isPopupResponse({
      ok: true,
      snapshot,
      command: { status: "uncertain", kind: "update_display_name", idempotencyKey: "key-1", message: "Checking whether this completed." },
    })).toBe(true);
    expect(isPopupResponse({
      ok: true,
      snapshot,
      command: { status: "rejected", kind: "update_display_name", code: "validation", message: "Display name is required." },
    })).toBe(true);
    expect(isPopupResponse({
      ok: true,
      command: { status: "uncertain", kind: "update_display_name", idempotencyKey: "key-1", message: "Checking whether this completed." },
    })).toBe(true);
    expect(isPopupRequest({ version: PROTOCOL_VERSION, type: "update_display_name", displayName: "Grace", extra: true })).toBe(false);
  });

  it("rejects incomplete account setup requests", () => {
    expect(isPopupRequest({
      version: PROTOCOL_VERSION,
      type: "create_member_account",
      displayName: "Ada",
      adultConfirmed: false,
      consentAccepted: true,
    })).toBe(true);
    expect(isPopupRequest({
      version: PROTOCOL_VERSION,
      type: "create_member_account",
      displayName: "Ada",
      adultConfirmed: true,
    })).toBe(false);
    expect(isPopupRequest({
      version: PROTOCOL_VERSION,
      type: "create_member_account",
      displayName: "Ada",
      adultConfirmed: true,
      consentAccepted: true,
      email: "outsider@example.test",
    })).toBe(false);
  });

  it("accepts distinct, credential-free sign-in states", () => {
    for (const status of [
      "ready",
      "requesting_code",
      "code_sent",
      "resend_cooldown",
      "verifying",
      "invalid_code",
      "expired_code",
      "rate_limited",
      "service_unavailable",
    ] as const) {
      expect(isPopupResponse({ ok: true, auth: { status } })).toBe(true);
    }
    expect(isPopupResponse({
      ok: true,
      auth: { status: "code_sent", resendAvailableAt: "2026-08-15T00:00:30.000Z" },
    })).toBe(true);
    expect(isPopupResponse({ ok: true, auth: { status: "invalid_code", token: "123456" } })).toBe(false);
  });
});
