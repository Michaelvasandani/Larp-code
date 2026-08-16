import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "..");

describe("public launch site", () => {
  it("publishes the canonical privacy policy and public support route", () => {
    const builder = join(repositoryRoot, "site/build.mjs");
    expect(existsSync(builder)).toBe(true);

    const output = mkdtempSync(join(tmpdir(), "larp-code-site-"));
    try {
      execFileSync("node", [builder, output], { cwd: repositoryRoot });

      expect(readFileSync(join(output, "privacy/index.html"), "utf8"))
        .toBe(readFileSync(join(repositoryRoot, "src/privacy.html"), "utf8"));
      expect(readFileSync(join(output, "legal/index.html"), "utf8"))
        .toBe(readFileSync(join(repositoryRoot, "src/legal.html"), "utf8"));
      expect(readFileSync(join(output, "support/index.html"), "utf8"))
        .toContain("https://github.com/Michaelvasandani/Larp-code/issues");
      expect(readFileSync(join(output, "index.html"), "utf8"))
        .toMatch(/href="\/(privacy|legal|support)"/);
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });
});
