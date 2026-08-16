import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const popupSource = readFileSync(new URL("../src/popup/App.tsx", import.meta.url), "utf8");

describe("Solve history popup seam", () => {
  it("distinguishes the preserved original self-attestation from later corrections", () => {
    expect(popupSource).toContain("Original self-attestation");
    expect(popupSource).toContain("Correction {correction.sequence}");
    expect(popupSource).toContain("Later corrections are shown underneath and remain visible to both Members.");
    expect(popupSource).toContain("createUncertainCommandOutcome(snapshot.pendingCommand.idempotencyKey, snapshot.pendingCommand.kind)");
  });

  it("does not expose partner approval, dispute, reporting, hiding, or moderation controls", () => {
    for (const forbiddenControl of ["Approve partner Solve", "Reject partner Solve", "Dispute Solve", "Report Solve", "Hide Solve", "Moderate Solve"]) {
      expect(popupSource).not.toContain(forbiddenControl);
    }
  });
});
