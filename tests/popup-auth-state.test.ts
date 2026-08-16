import { describe, expect, it } from "vitest";

import { preserveSignedOutAuthState } from "../src/popup/auth-state";

describe("popup signed-out auth state", () => {
  it("preserves an active code-entry state across an authoritative signed-out snapshot", () => {
    expect(preserveSignedOutAuthState({ status: "code_sent" }, "signed_out")).toEqual({
      status: "code_sent",
    });
    expect(preserveSignedOutAuthState({ status: "rate_limited", retryAfterSeconds: 30 }, "signed_out"))
      .toEqual({ status: "rate_limited", retryAfterSeconds: 30 });
  });

  it("resets auth state when the snapshot leaves the signed-out view", () => {
    expect(preserveSignedOutAuthState({ status: "code_sent" }, "account")).toEqual({ status: "ready" });
  });
});
