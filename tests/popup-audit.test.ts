import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const popupSource = [
  "App.tsx",
  "ConfirmationDialog.tsx",
  "drafts.tsx",
  "GrovekinPresentation.tsx",
  "grovekin-clips.ts",
].map((file) => readFileSync(new URL(`../src/popup/${file}`, import.meta.url), "utf8")).join("\n");
const popupStyles = readFileSync(new URL("../src/popup/popup.css", import.meta.url), "utf8");

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

describe("Accessible popup state seam", () => {
  it("exposes a focused state-page landmark and a real focus-restoration seam", () => {
    expect(popupSource).toContain('role="main"');
    expect(popupSource).toContain('tabIndex={-1}');
    expect(popupSource).toContain("document.activeElement");
    expect(popupSource).toContain("focus({ preventScroll: true })");
  });

  it("uses explicit confirmation dialogs for irreversible Challenge actions", () => {
    expect(popupSource).toContain('role="dialog"');
    expect(popupSource).toContain('aria-modal="true"');
    expect(popupSource).toContain("Confirm cancellation");
    expect(popupSource).toContain("Confirm abandonment");
    expect(popupSource).not.toContain("confirm(");
  });

  it("persists permitted unfinished drafts through the worker boundary", () => {
    expect(popupSource).toContain('type: "save_draft"');
    expect(popupSource).toContain('type: "get_drafts"');
    expect(popupSource).toContain('type: "clear_draft"');
    expect(popupSource).toContain("unfinished draft");
  });

  it("keeps Pet meaning explicit without requiring motion", () => {
    expect(popupSource).toContain("Static Grovekin presentation");
    expect(popupSource).toContain("Condition is explicit text");
  });

  it("keeps the selected popup surface readable at zoom and reduced motion", () => {
    expect(popupStyles).toContain("prefers-reduced-motion: reduce");
    expect(popupStyles).toContain("max-width: 800px");
    expect(popupStyles).toContain("overflow-y: auto");
    expect(popupStyles).toContain("button:focus-visible");
  });
});

describe("Grovekin production popup seam", () => {
  it("keeps the completion farewell transient while terminal content remains pet-free", () => {
    expect(popupSource).toContain("farewellRevision");
    expect(popupSource).toContain("setFarewellRevision(null)");
    expect(popupSource).toContain('transition="stage-4-farewell"');
    expect(popupSource).toContain("Grovekin completion farewell");
  });

  it("uses generated pixel assets and an explicit reduced-motion static fallback", () => {
    expect(popupSource).toContain("clip-registry.json");
    expect(popupSource).toContain("assets/grovekin/");
    expect(popupSource).toContain("prefers-reduced-motion: reduce");
    expect(popupStyles).toContain("image-rendering: pixelated");
    expect(popupStyles).toContain("width: 160px");
    expect(popupStyles).toContain("height: 160px");
  });
});
