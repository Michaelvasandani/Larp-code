import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { validateNetworkTrace } from "../scripts/network-trace.mjs";
import { createDeterministicZip } from "../scripts/deterministic-zip.mjs";
import { validatePublishableKey } from "../scripts/publishable-key.mjs";
import { validatePublicationPackage } from "../scripts/check-publication-package.mjs";

const root = resolve(process.cwd());

function jwt(payload: Record<string, unknown>) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(payload)}.signature`;
}

describe("Ticket 40 publication hardening", () => {
  it("accepts only publishable JWT claims and rejects service-role claims without a marker", () => {
    expect(validatePublishableKey(jwt({ role: "anon", iss: "supabase" })).role).toBe("anon");
    expect(validatePublishableKey(jwt({ role: "publishable", iss: "supabase" })).role).toBe("publishable");
    expect(() => validatePublishableKey(jwt({ role: "service_role" }))).toThrow(/role/i);
    expect(() => validatePublishableKey("sb_publishable_unverified-format")).toThrow(/verified|JWT/i);
  });

  it("rejects traversal and symlink ZIP entries before extraction", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "larp-publication-archive-fixture-"));
    const rootDir = join(fixture, "root");
    execFileSync("mkdir", ["-p", join(rootDir, "assets")]);
    writeFileSync(join(rootDir, "manifest.json"), "{}");
    writeFileSync(join(rootDir, "assets", "safe.txt"), "safe");
    symlinkSync("/etc/passwd", join(rootDir, "assets", "escape"));
    const symlinkArchive = join(fixture, "symlink.zip");
    execFileSync("zip", ["-q", "-y", symlinkArchive, "manifest.json", "assets/safe.txt", "assets/escape"], { cwd: rootDir });
    await expect(validatePublicationPackage(symlinkArchive)).rejects.toThrow(/symlink|non-regular/i);

    const traversalRoot = join(fixture, "traversal");
    execFileSync("mkdir", ["-p", traversalRoot]);
    writeFileSync(join(traversalRoot, "../outside.txt"), "outside");
    const traversalArchive = join(fixture, "traversal.zip");
    execFileSync("zip", ["-q", traversalArchive, "../outside.txt"], { cwd: traversalRoot });
    await expect(validatePublicationPackage(traversalArchive)).rejects.toThrow(/absolute|traversal|parent/i);
  });

  it("creates a clean deterministic archive when stale members disappear", () => {
    const fixture = mkdtempSync(join(tmpdir(), "larp-publication-deterministic-"));
    const packageRoot = join(fixture, "package");
    execFileSync("mkdir", ["-p", packageRoot]);
    writeFileSync(join(packageRoot, "manifest.json"), "manifest");
    writeFileSync(join(packageRoot, "old.txt"), "stale");
    const archive = join(fixture, "candidate.zip");
    createDeterministicZip(packageRoot, archive);
    unlinkSync(join(packageRoot, "old.txt"));
    createDeterministicZip(packageRoot, archive);
    expect(execFileSync("unzip", ["-Z1", archive], { encoding: "utf8" })).not.toContain("old.txt");

    const secondRoot = join(fixture, "package-copy");
    execFileSync("mkdir", ["-p", secondRoot]);
    writeFileSync(join(secondRoot, "manifest.json"), "manifest");
    const secondArchive = join(fixture, "candidate-copy.zip");
    createDeterministicZip(secondRoot, secondArchive);
    expect(createHash("sha256").update(readFileSync(archive)).digest("hex"))
      .toBe(createHash("sha256").update(readFileSync(secondArchive)).digest("hex"));
  });

  it("validates controlled trace evidence and rejects platform or undeclared traffic", () => {
    const valid = {
      version: 1,
      environment: "local-controlled",
      productionEvidence: false,
      backendOrigin: "https://api.larp-code.example",
      requests: [
        { url: "https://api.larp-code.example/rest/v1/rpc/get_snapshot", type: "fetch" },
        { url: "wss://api.larp-code.example/realtime/v1/websocket", type: "websocket" },
      ],
    };
    expect(validateNetworkTrace(valid, { expectedOrigin: valid.backendOrigin })).toMatchObject({ requests: 2 });
    expect(() => validateNetworkTrace({ ...valid, requests: [{ url: "https://leetcode.com/api", type: "fetch" }] }, { expectedOrigin: valid.backendOrigin })).toThrow(/platform/i);
    expect(() => validateNetworkTrace({ ...valid, requests: [{ url: "https://analytics.example/collect", type: "fetch" }] }, { expectedOrigin: valid.backendOrigin })).toThrow(/origin/i);
  });

  it("provides disposable reviewer fixture setup and teardown without credentials", () => {
    const fixture = join(mkdtempSync(join(tmpdir(), "larp-review-fixture-")), "fixture.json");
    execFileSync(process.execPath, ["scripts/reviewer-fixture.mjs", "setup", fixture], { cwd: root, stdio: "pipe" });
    const descriptor = JSON.parse(readFileSync(fixture, "utf8"));
    expect(descriptor.credentials).toBe("none");
    expect(descriptor.states).toEqual(["Scheduled", "Active", "Active-behind", "Terminal"]);
    execFileSync(process.execPath, ["scripts/reviewer-fixture.mjs", "teardown", fixture], { cwd: root, stdio: "pipe" });
    expect(() => readFileSync(fixture)).toThrow();
  });

  it("keeps release qualification fail-closed for the checked-in draft", () => {
    expect(() => execFileSync("pnpm", ["release:check"], {
      cwd: root,
      env: { ...process.env, PUBLICATION_BACKEND_ORIGIN: "https://api.larp-code.example", PUBLICATION_ANON_KEY: "pk_live_larp_code_publication_placeholder" },
      stdio: "pipe",
    })).toThrow();
    expect(JSON.parse(readFileSync(resolve(root, "docs/release/gate5-attestation.json"), "utf8")).status).toBe("pending");
    expect(() => execFileSync("pnpm", ["publication:assemble"], {
      cwd: root,
      env: {
        ...process.env,
        PUBLICATION_MODE: "release",
        PUBLICATION_BACKEND_ORIGIN: "https://api.larp-code.example",
        PUBLICATION_ANON_KEY: "pk_live_larp_code_publication_placeholder",
      },
      stdio: "pipe",
    })).toThrow(/real public HTTPS origin|reserved|placeholder/i);
  });
});
