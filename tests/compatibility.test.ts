import { describe, expect, it } from "vitest";

import {
  compareClientVersions,
  requiresClientUpdate,
  CURRENT_COMMAND_CONTRACT_VERSION,
  CURRENT_SNAPSHOT_CONTRACT_VERSION,
  PREVIOUS_COMMAND_CONTRACT_VERSION,
  PREVIOUS_SNAPSHOT_CONTRACT_VERSION,
  SUPPORTED_COMMAND_CONTRACT_VERSIONS,
  SUPPORTED_SNAPSHOT_CONTRACT_VERSIONS,
  isSupportedCommandContractVersion,
  isSupportedSnapshotContractVersion,
  updateRequiredCapabilities,
  COMPATIBILITY_BACKFILL_VERSION,
  advanceBackfill,
} from "../src/shared/compatibility";

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

  it("publishes exactly the current and immediately preceding contract versions", () => {
    expect(CURRENT_SNAPSHOT_CONTRACT_VERSION).toBe(1);
    expect(PREVIOUS_SNAPSHOT_CONTRACT_VERSION).toBe(0);
    expect(CURRENT_COMMAND_CONTRACT_VERSION).toBe(1);
    expect(PREVIOUS_COMMAND_CONTRACT_VERSION).toBe(0);
    expect(SUPPORTED_SNAPSHOT_CONTRACT_VERSIONS).toEqual([0, 1]);
    expect(SUPPORTED_COMMAND_CONTRACT_VERSIONS).toEqual([0, 1]);
    expect(isSupportedSnapshotContractVersion(0)).toBe(true);
    expect(isSupportedSnapshotContractVersion(1)).toBe(true);
    expect(isSupportedSnapshotContractVersion(2)).toBe(false);
    expect(isSupportedCommandContractVersion(0)).toBe(true);
    expect(isSupportedCommandContractVersion(1)).toBe(true);
    expect(isSupportedCommandContractVersion(2)).toBe(false);
  });

  it("exposes only safe actions on the update-required boundary", () => {
    expect(updateRequiredCapabilities()).toEqual({
      canRequestUpdate: true,
      canSignOut: true,
      canEraseLocalData: true,
      canReadMemberData: false,
      canMutateMemberData: false,
    });
  });

  it("advances a version-marked backfill cursor idempotently and resumably", () => {
    const initial = { migrationVersion: COMPATIBILITY_BACKFILL_VERSION, cursor: null, processedRows: 0, completed: false };
    const first = advanceBackfill(initial, ["member-a", "member-b", "member-c"], 2);
    expect(first).toEqual({ migrationVersion: COMPATIBILITY_BACKFILL_VERSION, cursor: "member-b", processedRows: 2, completed: false });
    const resumed = advanceBackfill(first, ["member-a", "member-b", "member-c"], 2);
    expect(resumed).toEqual({ migrationVersion: COMPATIBILITY_BACKFILL_VERSION, cursor: "member-c", processedRows: 3, completed: true });
    expect(advanceBackfill(resumed, ["member-a", "member-b", "member-c"], 2)).toEqual(resumed);
  });
});
