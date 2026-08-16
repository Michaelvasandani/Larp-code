import importedRecords from "./problem-set.json";

export const CATALOG_SOURCE_REPOSITORY = "https://github.com/neetcode-gh/leetcode" as const;
export const CATALOG_SOURCE_DATA_FILE = ".problemSiteData.json" as const;
export const CATALOG_SOURCE_COMMIT_SHA = "5f9dbb6030c8243c933b799f7999092183d258d1" as const;

/** The complete MIT notice required when distributing this catalog copy. */
export const CATALOG_LICENSE_NOTICE = `MIT License

Copyright (c) 2022 neetcode-gh

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.` as const;

export const NON_AFFILIATION_NOTICE = "larp-code is an independent product and is not affiliated with, endorsed by, or sponsored by NeetCode or LeetCode. NeetCode and LeetCode are referenced only to identify the third-party study list and problem destinations used by members." as const;

export type ProblemDifficulty = "Easy" | "Medium" | "Hard";

export type CatalogSourceRecord = {
  code: string;
  link: string;
  problem: string;
  pattern: string;
  difficulty: ProblemDifficulty;
  neetcode150: true;
  [key: string]: unknown;
};

export type Problem = Readonly<{
  /** Stable identity is the reviewed source code, never a title or list position. */
  id: string;
  sourceCode: string;
  slug: string;
  title: string;
  pattern: string;
  difficulty: ProblemDifficulty;
  listOrder: number;
  publicUrl: string;
}>;

export type ProblemSetVersion = Readonly<{
  id: string;
  source: Readonly<{
    repository: string;
    dataFile: string;
    commitSha: string;
  }>;
  importedAt: string;
  problems: readonly Problem[];
  licenseNotice: string;
  nonAffiliationNotice: string;
}>;

const PERMITTED_SOURCE_KEYS = new Set(["code", "link", "problem", "pattern", "difficulty", "neetcode150"]);
const PERMITTED_DIFFICULTIES = new Set<ProblemDifficulty>(["Easy", "Medium", "Hard"]);

function freezeProblem(problem: Problem): Problem {
  return Object.freeze(problem);
}

function normalizeSlug(link: string): string {
  const slug = link.trim().replace(/^\/+|\/+$/g, "");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error("Catalog link must be a plain problem slug.");
  return slug;
}

function isSourceRecord(value: CatalogSourceRecord): boolean {
  return typeof value === "object"
    && value !== null
    && typeof value.code === "string"
    && value.code.trim().length > 0
    && typeof value.link === "string"
    && typeof value.problem === "string"
    && value.problem.trim().length > 0
    && typeof value.pattern === "string"
    && value.pattern.trim().length > 0
    && value.neetcode150 === true
    && PERMITTED_DIFFICULTIES.has(value.difficulty);
}

function toProblem(source: CatalogSourceRecord, listOrder: number): Problem {
  if (!isSourceRecord(source)) throw new Error("Catalog record is malformed.");
  const unexpected = Object.keys(source).filter((key) => !PERMITTED_SOURCE_KEYS.has(key));
  if (unexpected.length > 0) throw new Error(`Catalog record contains excluded field: ${unexpected[0]}.`);
  const slug = normalizeSlug(source.link);
  return freezeProblem({
    id: `problem:${source.code.trim()}`,
    sourceCode: source.code.trim(),
    slug,
    title: source.problem.trim(),
    pattern: source.pattern.trim(),
    difficulty: source.difficulty,
    listOrder,
    publicUrl: `https://leetcode.com/problems/${slug}/`,
  });
}

export function importPinnedProblemSet(
  records: readonly CatalogSourceRecord[],
  input: { commitSha: string; versionId: string; importedAt?: string; repository?: string },
): ProblemSetVersion {
  if (!Array.isArray(records) || records.length !== 150) {
    throw new Error("A reviewed Problem Set Version must contain exactly 150 records.");
  }
  if (!input.commitSha.trim() || !input.versionId.trim()) throw new Error("Catalog provenance is required.");
  if (!/^[a-f0-9]{40}$/i.test(input.commitSha.trim())) {
    throw new Error("Catalog provenance requires a 40-character commit SHA.");
  }
  const repository = input.repository ?? CATALOG_SOURCE_REPOSITORY;
  if (repository !== CATALOG_SOURCE_REPOSITORY) {
    throw new Error("Catalog provenance repository is not the reviewed NeetCode source.");
  }
  const importedAt = input.importedAt ?? "2026-08-15T00:00:00.000Z";
  if (Number.isNaN(Date.parse(importedAt))) throw new Error("Catalog provenance requires a valid import timestamp.");
  const problems = records.map((record, index) => toProblem(record, index + 1));
  const ids = new Set(problems.map((problem) => problem.id));
  if (ids.size !== problems.length) throw new Error("Catalog records must have unique stable source codes.");
  const version: ProblemSetVersion = {
    id: input.versionId.trim(),
    source: Object.freeze({
      repository,
      dataFile: CATALOG_SOURCE_DATA_FILE,
      commitSha: input.commitSha.trim(),
    }),
    importedAt,
    problems: Object.freeze(problems),
    licenseNotice: CATALOG_LICENSE_NOTICE,
    nonAffiliationNotice: NON_AFFILIATION_NOTICE,
  };
  return Object.freeze(version);
}

/** This is a packaged, static import. No extension or backend path fetches this source at runtime. */
export const PINNED_PROBLEM_SET_VERSION = importPinnedProblemSet(
  importedRecords.map((record) => ({
    code: record.sourceCode,
    link: record.slug,
    problem: record.title,
    pattern: record.pattern,
    difficulty: record.difficulty,
    neetcode150: true,
  })) as CatalogSourceRecord[],
  {
    commitSha: CATALOG_SOURCE_COMMIT_SHA,
    versionId: "neetcode-150-2026-08-15",
  },
);
