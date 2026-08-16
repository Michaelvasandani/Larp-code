import { describe, expect, it } from "vitest";

import {
  CREATE_SOLVE_COMMAND_KIND,
  createSolveCommandAdapter,
  parseSolve,
} from "../src/worker/solve";
import { PENDING_COMMAND_KEY, type PendingCommandStorage } from "../src/worker/command-recovery";

function storageWith(values: Record<string, unknown> = {}): PendingCommandStorage & { values: Record<string, unknown> } {
  return {
    values,
    async get(key) { return this.values[key] ?? null; },
    async set(key, value) { this.values[key] = value; },
    async remove(key) { delete this.values[key]; },
  };
}

const identity = { memberId: "member-1", memberEmail: "member@example.test" };

describe("recoverable Challenge Solve seam", () => {
  it("requires explicit self-attestation and keeps a stable solve identity", () => {
    expect(parseSolve({
      id: "solve-1",
      memberId: "member-1",
      challengeId: "challenge-1",
      problemId: "problem:0001-two-sum",
      claimedAt: "2026-08-01T00:01:00.000Z",
      creditStatus: "credited",
    })).toMatchObject({ problemId: "problem:0001-two-sum", creditStatus: "credited" });
    expect(() => parseSolve({ id: "solve-1", challengeId: "challenge-1" })).toThrow();
  });

  it("persists one command key before dispatch and retries it after an uncertain response", async () => {
    const storage = storageWith();
    let attempts = 0;
    const adapter = createSolveCommandAdapter({
      storage,
      randomIdempotencyKey: () => "solve-key",
      rpc: {
        async createSolve(input) {
          expect(input.commandKind).toBe(CREATE_SOLVE_COMMAND_KIND);
          expect(storage.values[PENDING_COMMAND_KEY]).toMatchObject({
            kind: CREATE_SOLVE_COMMAND_KIND,
            intent: { challengeId: "challenge-1", problemId: "problem:0001-two-sum", affirmed: true },
          });
          attempts += 1;
          if (attempts === 1) throw new Error("network timeout");
          return {
            id: "solve-1",
            memberId: "member-1",
            challengeId: "challenge-1",
            problemId: "problem:0001-two-sum",
            claimedAt: "2026-08-01T00:01:00.000Z",
            creditStatus: "credited" as const,
          };
        },
      },
    });
    await expect(adapter.createSolve({ challengeId: "challenge-1", problemId: "problem:0001-two-sum", affirmed: true }, identity))
      .resolves.toMatchObject({ status: "uncertain", idempotencyKey: "solve-key" });
    await expect(adapter.recover(identity)).resolves.toMatchObject({ status: "applied", solve: { id: "solve-1" } });
    expect(await adapter.readPending()).toBeNull();
  });

  it("rejects duplicate and boundary failures as known validation outcomes", async () => {
    const adapter = createSolveCommandAdapter({
      storage: storageWith(),
      rpc: { async createSolve() { throw { code: "P0003", message: "The Problem is already credited for this Challenge Member." }; } },
    });
    await expect(adapter.createSolve({ challengeId: "challenge-1", problemId: "problem:0001-two-sum", affirmed: true }, identity))
      .resolves.toMatchObject({ status: "rejected", kind: CREATE_SOLVE_COMMAND_KIND, code: "validation" });
  });

  it("keeps the uncertain command key and refuses a new Problem until recovery", async () => {
    const storage = storageWith();
    let calls = 0;
    const adapter = createSolveCommandAdapter({
      storage,
      randomIdempotencyKey: () => "first-key",
      rpc: {
        async createSolve() {
          calls += 1;
          throw new Error("transport timeout");
        },
      },
    });
    await expect(adapter.createSolve({ challengeId: "challenge-1", problemId: "problem:0001-two-sum", affirmed: true }, identity))
      .resolves.toMatchObject({ status: "uncertain", idempotencyKey: "first-key" });
    await expect(adapter.createSolve({ challengeId: "challenge-1", problemId: "problem:0002-add-two-numbers", affirmed: true }, identity))
      .resolves.toMatchObject({ status: "uncertain", idempotencyKey: "first-key" });
    expect(calls).toBe(1);
    expect(await adapter.readPending()).toMatchObject({ idempotencyKey: "first-key", intent: { problemId: "problem:0001-two-sum" } });
  });
});
