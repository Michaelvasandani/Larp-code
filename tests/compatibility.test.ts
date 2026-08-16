import { describe, expect, it } from "vitest";

import { compareClientVersions, requiresClientUpdate } from "../src/shared/compatibility";

describe("client compatibility seam", () => {
  it("compares numeric client versions without using browser state", () => {
    expect(compareClientVersions("1.10.0", "1.9.9")).toBe(1);
    expect(compareClientVersions("1.0", "1.0.0")).toBe(0);
    expect(compareClientVersions("0.9.0", "1.0.0")).toBe(-1);
  });

  it("blocks only a client below the backend minimum", () => {
    expect(requiresClientUpdate({ minimumClientVersion: "0.2.0" }, "0.1.0")).toBe(true);
    expect(requiresClientUpdate({ minimumClientVersion: "0.1.0" }, "0.1.0")).toBe(false);
  });
});
