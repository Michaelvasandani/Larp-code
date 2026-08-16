import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

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
    expect(reviewer).toContain("No reusable production credentials");
    expect(reviewer).toContain("DELETE MY ACCOUNT");
  });

  it("generates the Store icon and listing asset inventory", () => {
    execFileSync(process.execPath, ["art/store/generate.mjs"], { cwd: root, stdio: "pipe" });
    for (const [file, width, height] of [["icon-16.png", 16, 16], ["icon-48.png", 48, 48], ["icon-128.png", 128, 128], ["promo-small.png", 440, 280]] as const) {
      const bytes = readFileSync(resolve(root, "art/store/generated", file));
      expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(bytes.readUInt32BE(16)).toBe(width);
      expect(bytes.readUInt32BE(20)).toBe(height);
    }
    expect(existsSync(resolve(root, "art/store/generated/screenshots/active-stage-3-healthy.png"))).toBe(true);
  });

  it("can validate a built release package when one is present", () => {
    if (!existsSync(resolve(root, "dist/manifest.json"))) return;
    execFileSync(process.execPath, ["scripts/check-publication-package.mjs", "dist"], {
      cwd: root,
      env: { ...process.env, ALLOW_LOCAL_PUBLICATION: "1" },
      stdio: "pipe",
    });
  });
});
