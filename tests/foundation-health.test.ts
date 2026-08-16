import { describe, expect, it } from "vitest";

import { isFoundationHealth } from "../src/worker/foundation-health";

describe("foundation health negotiation metadata", () => {
  it("accepts future contract versions as negotiation data", () => {
    expect(isFoundationHealth({
      service: "larp-code",
      schemaVersion: 13,
      serverTime: "2026-08-16T00:00:00.000Z",
      minimumClientVersion: "0.1.0",
      snapshotContractVersion: 3,
      commandContractVersion: 3,
      supportedSnapshotContractVersions: [2, 3],
      supportedCommandContractVersions: [2, 3],
    })).toBe(true);
  });

  it("still rejects malformed future metadata before the minimum-client gate", () => {
    expect(isFoundationHealth({
      service: "larp-code",
      schemaVersion: 13,
      serverTime: "not-a-date",
      snapshotContractVersion: 3,
      supportedSnapshotContractVersions: [2, "3"],
    })).toBe(false);
  });

  it("accepts the safe recovery phase metadata used to surface managed outage state", () => {
    expect(isFoundationHealth({
      service: "larp-code",
      schemaVersion: 14,
      serverTime: "2026-08-16T00:00:00.000Z",
      recoveryPhase: "frozen",
    })).toBe(true);
    expect(isFoundationHealth({
      service: "larp-code",
      schemaVersion: 14,
      serverTime: "2026-08-16T00:00:00.000Z",
      recoveryPhase: "paused",
    })).toBe(false);
  });
});
