import { readFileSync, symlinkSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  auditQualificationRecord,
  findEarliestBlockedGate,
  validateQualificationRecord,
} from "../scripts/release-qualification.mjs";

const root = resolve(process.cwd());

function pendingRecord() {
  return JSON.parse(readFileSync(resolve(root, "artifacts/ticket41-qualification/release-qualification.json"), "utf8"));
}

describe("Ticket 41 release qualification", () => {
  it("fails closed for the checked-in record and enumerates external blockers", () => {
    const result = auditQualificationRecord(pendingRecord(), { root });

    expect(result.eligible).toBe(false);
    expect(result.earliestBlockedGate).toBe(5);
    expect(result.blockers).toEqual(expect.arrayContaining([
      expect.stringContaining("production Supabase"),
      expect.stringContaining("Resend"),
      expect.stringContaining("two-account end-to-end"),
      expect.stringContaining("publisher"),
      expect.stringContaining("residual"),
    ]));
    expect(pendingRecord().primarySourceRechecks.every((row: { result: string }) => row.result === "confirmed")).toBe(true);
  });

  it("reopens every later gate after the first failed gate", () => {
    const record = pendingRecord();
    record.gates[2].status = "blocked";
    record.gates[3].status = "passed";
    record.gates[4].status = "passed";
    record.gates[5].status = "passed";
    record.gates[6].status = "passed";

    expect(findEarliestBlockedGate(record.gates)).toBe(2);
    const result = auditQualificationRecord(record, { root });
    expect(result.earliestBlockedGate).toBe(2);
    expect(result.blockers).toContain("Gate 3 is passed after Gate 2 failed; cumulative gates must be blocked or reopened");
  });

  it("throws a useful aggregate error when strict validation is requested", () => {
    expect(() => validateQualificationRecord(pendingRecord(), { root })).toThrow(/Release qualification blocked/);
  });

  it("rejects production evidence attached to a local-controlled candidate", () => {
    const record = pendingRecord();
    record.candidate.productionEvidence = true;

    const result = auditQualificationRecord(record, { root });

    expect(result.blockers).toContain("candidate productionEvidence requires a release- or production-controlled environment");
  });

  it("accepts only first-party primary-source URLs for each authority", () => {
    const record = pendingRecord();
    record.primarySourceRechecks[0].url = "https://not-chrome.example/docs/mv3";

    const result = auditQualificationRecord(record, { root });

    expect(result.blockers).toContain("primary-source recheck 1 URL is not an allowlisted first-party source for chrome");
  });

  it("rejects an unallowlisted path on an otherwise first-party source host", () => {
    const record = pendingRecord();
    record.primarySourceRechecks[0].url = "https://developer.chrome.com/blog/mv3";

    const result = auditQualificationRecord(record, { root });

    expect(result.blockers).toContain("primary-source recheck 1 URL is not an allowlisted first-party source for chrome");
  });

  it("rejects nonstandard ports on first-party primary sources", () => {
    const record = pendingRecord();
    record.primarySourceRechecks[0].url = "https://developer.chrome.com:8443/docs/extensions/develop/migrate/what-is-mv3";

    const result = auditQualificationRecord(record, { root });

    expect(result.blockers).toContain("primary-source recheck 1 URL is not an allowlisted first-party source for chrome");
  });

  it("rejects a directory in place of a candidate artifact", () => {
    const record = pendingRecord();
    record.candidate.archivePath = "artifacts/ticket41-qualification";

    const result = auditQualificationRecord(record, { root });

    expect(result.blockers).toContain("candidate archive must be a regular non-symlink file");
  });

  it("rejects a symlink in place of a candidate artifact", () => {
    const link = resolve(root, "artifacts/ticket41-qualification/test-candidate-link.zip");
    symlinkSync(resolve(root, "artifacts/ticket40-publication/larp-code-0.1.0.zip"), link);
    try {
      const record = pendingRecord();
      record.candidate.archivePath = "artifacts/ticket41-qualification/test-candidate-link.zip";
      const result = auditQualificationRecord(record, { root });
      expect(result.blockers).toContain("candidate archive must be a regular non-symlink file: artifacts/ticket41-qualification/test-candidate-link.zip");
    } finally {
      unlinkSync(link);
    }
  });

  it("rejects remote URLs wherever local qualification evidence is required", () => {
    const candidate = pendingRecord();
    candidate.candidate.archivePath = "https://attacker.example/candidate.zip";
    const candidateResult = auditQualificationRecord(candidate, { root });
    expect(candidateResult.blockers).toContain("candidate archive path is missing or unsafe");

    const trace = pendingRecord();
    trace.candidate.networkTracePath = "https://attacker.example/trace.json";
    const traceResult = auditQualificationRecord(trace, { root });
    expect(traceResult.blockers).toContain("candidate network trace path is missing or unsafe");

    const metadata = pendingRecord();
    metadata.candidate.candidateBuildPath = "https://attacker.example/candidate-build.json";
    const metadataResult = auditQualificationRecord(metadata, { root });
    expect(metadataResult.blockers).toContain("candidate metadata path is missing or unsafe");

    const evidence = pendingRecord();
    evidence.evidence.infrastructure.evidenceRefs = ["https://attacker.example/evidence.json"];
    const evidenceResult = auditQualificationRecord(evidence, { root });
    expect(evidenceResult.blockers).toContain("infrastructure evidence reference must be a verifiable local artifact: https://attacker.example/evidence.json");

    const publisher = pendingRecord();
    publisher.publisherControls.developerAccount = {
      status: "confirmed",
      confirmedAt: publisher.recordedAt,
      evidenceRef: "https://attacker.example/publisher.json",
      evidenceSha256: "0".repeat(64),
    };
    const publisherResult = auditQualificationRecord(publisher, { root });
    expect(publisherResult.blockers).toContain("publisher control developerAccount reference must be a verifiable local artifact: https://attacker.example/publisher.json");
  });

  it("requires a candidate trace to be from the exact controlled environment", () => {
    const record = pendingRecord();
    const result = auditQualificationRecord(record, { root });

    expect(result.blockers).toContain("candidate network trace environment must be release- or production-controlled");
  });

  it("rejects unknown fields and sensitive values instead of preserving them", () => {
    const unknownField = pendingRecord();
    unknownField.unexpected = "value";
    const unknownResult = auditQualificationRecord(unknownField, { root });
    expect(unknownResult.blockers).toContain("record contains an unknown field: unexpected");

    const sensitiveField = pendingRecord();
    sensitiveField.notes.push("member@example.com");
    const sensitiveResult = auditQualificationRecord(sensitiveField, { root });
    expect(sensitiveResult.blockers).toContain("record.notes[3] contains prohibited sensitive material");

    const otpField = pendingRecord();
    otpField.notes.push("verification code 123456");
    const otpResult = auditQualificationRecord(otpField, { root });
    expect(otpResult.blockers).toContain("record.notes[3] contains prohibited sensitive material");
  });

  it("rejects opaque tokens and member-data assignments in free-form text", () => {
    const tokenRecord = pendingRecord();
    tokenRecord.notes.push("opaque-token: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const tokenResult = auditQualificationRecord(tokenRecord, { root });
    expect(tokenResult.blockers).toContain("record.notes[3] contains prohibited sensitive material");

    const shortTokenRecord = pendingRecord();
    shortTokenRecord.notes.push("token: abc123");
    const shortTokenResult = auditQualificationRecord(shortTokenRecord, { root });
    expect(shortTokenResult.blockers).toContain("record.notes[3] contains prohibited sensitive material");

    const memberRecord = pendingRecord();
    memberRecord.ownerResidualRisk.scope = "memberData: member-123";
    const memberResult = auditQualificationRecord(memberRecord, { root });
    expect(memberResult.blockers).toContain("record.ownerResidualRisk.scope contains prohibited sensitive material");
  });

  it("rejects impossible UTC dates instead of relying on Date.parse normalization", () => {
    const record = pendingRecord();
    record.primarySourceRechecks[0].checkedAt = "2026-02-30T15:32:32.000Z";

    const result = auditQualificationRecord(record, { root });

    expect(result.blockers).toContain("primary-source recheck 1 is missing a valid checkedAt timestamp");
  });

  it("binds the archive manifest identity to the candidate metadata", () => {
    const record = pendingRecord();
    record.candidate.extensionVersion = "9.9.9";

    const result = auditQualificationRecord(record, { root });

    expect(result.blockers).toContain("archive manifest version does not match candidate extensionVersion");
  });

  it("binds candidate origin and artifact filenames to candidate-build.json", () => {
    const originRecord = pendingRecord();
    originRecord.candidate.backendOrigin = "https://other-api.larp-code.example";
    expect(auditQualificationRecord(originRecord, { root }).blockers)
      .toContain("candidate backend origin disagrees with candidate-build.json");

    const archiveRecord = pendingRecord();
    archiveRecord.candidate.archivePath = "artifacts/ticket40-publication/candidate-build.json";
    expect(auditQualificationRecord(archiveRecord, { root }).blockers)
      .toContain("candidate archive filename disagrees with candidate-build.json");

    const traceRecord = pendingRecord();
    traceRecord.candidate.networkTracePath = "artifacts/ticket40-publication/candidate-build.json";
    expect(auditQualificationRecord(traceRecord, { root }).blockers)
      .toContain("candidate network trace filename disagrees with candidate-build.json");
  });

  it("requires the recorded source commit to exist as a commit object", () => {
    const record = pendingRecord();
    record.candidate.sourceCommit = "0000000000000000000000000000000000000000";

    const result = auditQualificationRecord(record, { root });

    expect(result.blockers).toContain("candidate source commit does not exist in the repository");
  });

  it("does not leave pending gates after the first failed cumulative gate", () => {
    const record = pendingRecord();
    record.gates[6].status = "pending";

    const result = auditQualificationRecord(record, { root });

    expect(result.blockers).toContain("Gate 6 is pending after Gate 5 failed; cumulative gates must be blocked or reopened");
  });

  it("requires local evidence references to resolve to real files", () => {
    const record = pendingRecord();
    record.evidence.infrastructure.evidenceRefs = ["docs/does-not-exist.json"];

    const result = auditQualificationRecord(record, { root });

    expect(result.blockers).toContain("infrastructure evidence reference is missing: docs/does-not-exist.json");
  });

  it("requires evidence bindings to match the observed artifact digest", () => {
    const record = pendingRecord();
    record.gates[0].evidenceBindings[0].sha256 = "0".repeat(64);

    const result = auditQualificationRecord(record, { root });

    expect(result.blockers).toContain("Gate 0 evidence binding digest does not match: docs/release/publication-dossier.md");
  });
});
