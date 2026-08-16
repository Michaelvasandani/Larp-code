import { describe, expect, it } from "vitest";

import {
  createDiagnosticId,
  isDiagnosticId,
} from "../src/shared/diagnostics";
import {
  createPrivacyFilteredLog,
  isPrivacySafeLog,
} from "../src/shared/security-logs";
import {
  createSlidingWindowLimiter,
} from "../src/worker/rate-limit";
import {
  TECHNICAL_ABUSE_REASONS,
  isTechnicalAbuseReason,
} from "../src/shared/technical-abuse";

describe("technical-abuse and diagnostic boundaries", () => {
  it("creates short non-identifying diagnostic identifiers", () => {
    const id = createDiagnosticId(() => "018f7c3d-54bf-7e75-9d95-123456789abc");

    expect(id).toBe("018F7C3D54");
    expect(isDiagnosticId(id)).toBe(true);
    expect(id).not.toContain("@");
  });

  it("keeps operational logs to privacy-safe fields", () => {
    const event = createPrivacyFilteredLog({
      event: "command_rejected",
      diagnosticId: "018F7C3D54",
      memberId: "member-1",
      email: "member@example.test",
      token: "123456",
      snapshot: { complete: "solve content" },
      partnerProgress: { total: 42 },
      petState: "sad",
      details: { code: "authorization_denied", safe: true },
    });

    expect(event).toEqual({
      event: "command_rejected",
      diagnosticId: "018F7C3D54",
      details: { code: "authorization_denied", safe: true },
    });
    expect(JSON.stringify(event)).not.toMatch(/member@example|123456|solve content|partnerProgress|petState|member-1/);
    expect(isPrivacySafeLog(event)).toBe(true);
    expect(isPrivacySafeLog({
      event: "diagnostic",
      details: { email: "member@example.test" },
    })).toBe(false);
    expect(isPrivacySafeLog({ event: "diagnostic", extra: "unexpected" })).toBe(false);
    const valueLeak = createPrivacyFilteredLog({ event: "diagnostic", details: { safe: "someone@example.test", digits: "123456" } });
    expect(valueLeak.details).toBeUndefined();
  });

  it("limits repeated requests by account and destination without retaining payloads", () => {
    let now = 1_000;
    const limiter = createSlidingWindowLimiter({
      maxAttempts: 2,
      windowMs: 10_000,
      now: () => now,
    });

    expect(limiter.allow("account-1", "destination-1")).toBe(true);
    expect(limiter.allow("account-1", "destination-1")).toBe(true);
    expect(limiter.allow("account-1", "destination-1")).toBe(false);
    expect(limiter.allow("account-2", "destination-1")).toBe(true);
    now = 11_001;
    expect(limiter.allow("account-1", "destination-1")).toBe(true);
    expect(limiter.entries()).toEqual([{ accountKey: "account-1", destinationKey: "destination-1", attempts: 1 }]);
  });

  it("defines technical abuse reasons without social moderation categories", () => {
    expect(TECHNICAL_ABUSE_REASONS).toEqual([
      "credential_stuffing",
      "token_replay",
      "authorization_bypass",
      "automated_request_flood",
      "security_vulnerability",
    ]);
    expect(isTechnicalAbuseReason("authorization_bypass")).toBe(true);
    expect(isTechnicalAbuseReason("interpersonal_conflict")).toBe(false);
    expect(isTechnicalAbuseReason("solve_truthfulness")).toBe(false);
    expect(isTechnicalAbuseReason("profanity")).toBe(false);
  });
});
