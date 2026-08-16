import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { validatePublicationPackage } from "../scripts/check-publication-package.mjs";

const root = resolve(process.cwd());

describe("Ticket 40 publication packet", () => {
  it("records the exact disclosure and reviewer surfaces", () => {
    const dossier = readFileSync(resolve(root, "docs/release/publication-dossier.md"), "utf8");
    const listing = readFileSync(resolve(root, "docs/release/store-listing.md"), "utf8");
    const reviewer = readFileSync(resolve(root, "docs/release/reviewer-instructions.md"), "utf8");
    expect(dossier).toContain("publication:assemble");
    expect(dossier).toContain("human visual review");
    expect(listing).toContain("Limited Use");
    expect(listing).toContain("webRequest");
    expect(listing).toContain("does not read pages");
    expect(listing).toContain("not affiliated with, endorsed by, or sponsored by NeetCode or LeetCode");
    expect(listing).toContain("MIT License");
    expect(listing).toContain("Copyright (c) 2022 neetcode-gh");
    expect(reviewer).toContain("No reusable production credentials");
    expect(reviewer).toContain("DELETE MY ACCOUNT");
  });

  it("generates the Store icon and listing asset inventory", () => {
    const generated = mkdtempSync(join(tmpdir(), "larp-store-assets-"));
    execFileSync(process.execPath, ["art/store/generate.mjs", `--output=${generated}`], { cwd: root, stdio: "pipe" });
    for (const [file, width, height] of [["icon-16.png", 16, 16], ["icon-48.png", 48, 48], ["icon-128.png", 128, 128], ["promo-small.png", 440, 280]] as const) {
      const bytes = readFileSync(resolve(generated, file));
      expect(bytes).toEqual(readFileSync(resolve(root, "art/store/generated", file)));
      expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(bytes.readUInt32BE(16)).toBe(width);
      expect(bytes.readUInt32BE(20)).toBe(height);
    }
    expect(readFileSync(resolve(generated, "screenshots/active-stage-3-healthy.png")))
      .toEqual(readFileSync(resolve(root, "art/store/generated/screenshots/active-stage-3-healthy.png")));
  });

  it("validates the committed draft archive and its digest metadata", async () => {
    const output = resolve(root, "artifacts/ticket40-publication");
    const metadata = JSON.parse(readFileSync(join(output, "candidate-build.json"), "utf8"));
    const archive = resolve(output, metadata.archive);
    const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
    expect(metadata.qualification).toBe("draft");
    expect(metadata.releaseEligible).toBe(false);
    expect(metadata.archiveSha256).toBe(digest);
    expect(readFileSync(join(output, "candidate.sha256"), "utf8")).toContain(`${digest}  ${metadata.archive}`);
    const tracePath = join(output, metadata.networkTrace);
    expect(createHash("sha256").update(readFileSync(tracePath)).digest("hex")).toBe(metadata.networkTraceSha256);
    expect(JSON.parse(readFileSync(tracePath, "utf8")).productionEvidence).toBe(false);
    await expect(validatePublicationPackage(archive, { expectedOrigin: metadata.backendOrigin })).resolves.toMatchObject({ files: 89 });
  });
});
