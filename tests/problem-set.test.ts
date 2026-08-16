import { describe, expect, it } from "vitest";

import {
  CATALOG_SOURCE_COMMIT_SHA,
  CATALOG_SOURCE_REPOSITORY,
  CATALOG_LICENSE_NOTICE,
  NON_AFFILIATION_NOTICE,
  PINNED_PROBLEM_SET_VERSION,
  importPinnedProblemSet,
  type CatalogSourceRecord,
} from "../src/catalog/problem-set";

describe("immutable pinned Problem Set Version", () => {
  const records = (title = "Two Sum"): CatalogSourceRecord[] => Array.from({ length: 150 }, (_, index) => ({
    code: String(index + 1).padStart(4, "0"),
    link: `problem-${index + 1}`,
    problem: index === 0 ? title : `Problem ${index + 1}`,
    pattern: "Arrays & Hashing",
    difficulty: "Easy" as const,
    neetcode150: true as const,
  }));

  it("contains exactly the reviewed 150 records and only permitted fields", () => {
    expect(PINNED_PROBLEM_SET_VERSION.problems).toHaveLength(150);
    expect(PINNED_PROBLEM_SET_VERSION.source.repository).toBe(CATALOG_SOURCE_REPOSITORY);
    expect(PINNED_PROBLEM_SET_VERSION.source.commitSha).toBe(CATALOG_SOURCE_COMMIT_SHA);
    expect(PINNED_PROBLEM_SET_VERSION.problems[0]!).toEqual({
      id: "problem:0217-contains-duplicate",
      sourceCode: "0217-contains-duplicate",
      slug: "contains-duplicate",
      title: "Contains Duplicate",
      pattern: "Arrays & Hashing",
      difficulty: "Easy",
      listOrder: 1,
      publicUrl: "https://leetcode.com/problems/contains-duplicate/",
    });
    expect(Object.keys(PINNED_PROBLEM_SET_VERSION.problems[0]!).sort()).toEqual([
      "difficulty", "id", "listOrder", "pattern", "publicUrl", "slug", "sourceCode", "title",
    ]);
  });

  it("rejects excluded source fields and malformed list membership", () => {
    const source = records();
    source[0] = { ...source[0]!, video: "must not be imported" };
    expect(() => importPinnedProblemSet(source, { commitSha: "a".repeat(40), versionId: "v-test" }))
      .toThrow("excluded field");
    expect(() => importPinnedProblemSet(records().slice(0, 149), { commitSha: "a".repeat(40), versionId: "v-test" }))
      .toThrow("exactly 150");
    expect(() => importPinnedProblemSet(records().map((record, index) => index === 0 ? { ...record, neetcode150: false } as unknown as CatalogSourceRecord : record), { commitSha: "a".repeat(40), versionId: "v-test" }))
      .toThrow("malformed");
  });

  it("creates a new frozen version without mutating the prior version", () => {
    const first = importPinnedProblemSet(records(), { commitSha: "a".repeat(40), versionId: "version-a" });
    const second = importPinnedProblemSet(records("Renamed display title"), { commitSha: "b".repeat(40), versionId: "version-b" });

    expect(first.problems[0]!.title).toBe("Two Sum");
    expect(second.problems[0]!.title).toBe("Renamed display title");
    expect(first.problems[0]!.id).toBe(second.problems[0]!.id);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.problems)).toBe(true);
  });

  it("publishes the full attribution and exact non-affiliation boundary", () => {
    expect(CATALOG_LICENSE_NOTICE).toContain("MIT License");
    expect(CATALOG_LICENSE_NOTICE).toContain("Copyright (c) 2022 neetcode-gh");
    expect(NON_AFFILIATION_NOTICE).toBe(
      "larp-code is an independent product and is not affiliated with, endorsed by, or sponsored by NeetCode or LeetCode. NeetCode and LeetCode are referenced only to identify the third-party study list and problem destinations used by members.",
    );
  });
});
