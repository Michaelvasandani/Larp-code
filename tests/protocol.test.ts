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
