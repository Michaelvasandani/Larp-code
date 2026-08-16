import { describe, expect, it } from "vitest";

import { isPopupRequest, isPopupResponse } from "../src/shared/protocol";

describe("popup draft persistence seam", () => {
  it("accepts a permitted unfinished draft without treating it as a domain command", () => {
    expect(isPopupRequest({
      version: 1,
      type: "save_draft",
      draft: {
        kind: "active",
        values: {
          selectedProblemId: "two-sum",
          affirmed: false,
          correctionSolveId: "",
          correctionCategory: "reclassified",
          correctionReason: "",
          correctionStatus: "not_credited",
        },
      },
    })).toBe(true);
  });

  it("returns drafts as a separate worker-owned response", () => {
    expect(isPopupResponse({
      ok: true,
      drafts: {
        active: {
          selectedProblemId: "two-sum",
          affirmed: false,
          correctionSolveId: "",
          correctionCategory: "reclassified",
          correctionReason: "",
          correctionStatus: "not_credited",
        },
      },
    })).toBe(true);
  });

  it("requires a typed durable-write receipt", () => {
    expect(isPopupResponse({ ok: true, draft: { kind: "setup", status: "saved" } })).toBe(true);
    expect(isPopupResponse({ ok: true, draft: { kind: "setup", status: "failed" } })).toBe(false);
  });
});
