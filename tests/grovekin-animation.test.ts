import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(process.cwd());
const generatorPath = join(repositoryRoot, "art/grovekin/generate.mjs");

type AnimationFrame = {
  id: string;
  file: string;
  width: number;
  height: number;
  sha256: string;
  stage?: string;
  condition?: string;
};

type AnimationClip = {
  id: string;
  kind: string;
  loop: boolean;
  frames: { frameId: string; durationMs: number }[];
  totalDurationMs: number;
  variants?: { stage: number; fromStage: number; toStage: number; frames: { frameId: string; durationMs: number }[] }[];
};

type Manifest = {
  schemaVersion: number;
  frames: AnimationFrame[];
  clips: AnimationClip[];
  animationSpritesheet: { file: string; width: number; height: number; sha256: string };
  animationChecksums: string;
};

function runGenerator(outputDirectory: string): void {
  execFileSync(process.execPath, [generatorPath, "--output-dir", outputDirectory], {
    cwd: repositoryRoot,
    stdio: "pipe",
  });
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readManifest(directory: string): Manifest {
  return JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8")) as Manifest;
}

describe("Grovekin production animation inventory", () => {
  it("emits the required idle, condition, reaction, evolution, and farewell clips", () => {
    const outputDirectory = mkdtempSync(join(tmpdir(), "grovekin-animation-"));
    try {
      runGenerator(outputDirectory);
      const manifest = readManifest(outputDirectory);
      const clipsById = new Map(manifest.clips.map((clip) => [clip.id, clip]));
      const expectedIds = [
        "stage-1-idle",
        "stage-2-idle",
        "stage-3-idle",
        "stage-4-idle",
        "hungry-accent",
        "sad-accent",
        "deteriorated-accent",
        "solve-reaction",
        "evolution-transition",
        "stage-4-farewell",
      ];

      expect(manifest.schemaVersion).toBe(1);
      expect(manifest.clips.length).toBeGreaterThanOrEqual(10);
      expect(expectedIds.every((id) => clipsById.has(id))).toBe(true);
      for (const stage of [1, 2, 3, 4]) {
        const clip = clipsById.get(`stage-${stage}-idle`)!;
        expect(clip.kind).toBe("idle");
        expect(clip.loop).toBe(true);
        expect(clip.frames).toHaveLength(2);
        expect(clip.frames.every((frame) => frame.durationMs > 0)).toBe(true);
        expect(clip.totalDurationMs).toBe(clip.frames.reduce((sum, frame) => sum + frame.durationMs, 0));
      }
      expect(clipsById.get("solve-reaction")?.loop).toBe(false);
      expect(clipsById.get("evolution-transition")?.loop).toBe(false);
      expect(clipsById.get("stage-4-farewell")?.loop).toBe(false);
      for (const id of ["hungry-accent", "sad-accent", "deteriorated-accent", "solve-reaction"]) {
        const variants = clipsById.get(id)?.variants ?? [];
        expect(variants.map((variant) => variant.stage)).toEqual([1, 2, 3, 4]);
        expect(variants.every((variant) => variant.frames.every((frame) => frame.frameId.includes(`stage-${variant.stage}-`)))).toBe(true);
      }
      const evolutionVariants = clipsById.get("evolution-transition")?.variants ?? [];
      expect(evolutionVariants.map((variant) => [variant.fromStage, variant.toStage])).toEqual([[1, 2], [2, 3], [3, 4]]);

      expect(manifest.frames.length).toBeGreaterThanOrEqual(20);
      for (const frame of manifest.frames) {
        expect(frame.file).toMatch(/^frames\/.+\.png$/);
        expect(frame.width).toBe(48);
        expect(frame.height).toBe(48);
        expect(frame.sha256).toBe(sha256(join(outputDirectory, frame.file)));
      }
      expect(existsSync(join(outputDirectory, manifest.animationSpritesheet.file))).toBe(true);
      expect(existsSync(join(outputDirectory, manifest.animationChecksums))).toBe(true);
      expect(sha256(join(outputDirectory, manifest.animationSpritesheet.file))).toBe(manifest.animationSpritesheet.sha256);
      const checksumLines = readFileSync(join(outputDirectory, manifest.animationChecksums), "utf8")
        .trim()
        .split("\n")
        .map((line) => line.split("  "));
      expect(checksumLines).toHaveLength(manifest.frames.length + 1);
      for (const [digest, file] of checksumLines) {
        expect(digest).toMatch(/^[0-9a-f]{64}$/);
        expect(sha256(join(outputDirectory, file!))).toBe(digest);
      }
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true });
    }
  });

  it("produces byte-identical animation frames and clip timing on every run", () => {
    const firstDirectory = mkdtempSync(join(tmpdir(), "grovekin-animation-first-"));
    const secondDirectory = mkdtempSync(join(tmpdir(), "grovekin-animation-second-"));
    try {
      runGenerator(firstDirectory);
      runGenerator(secondDirectory);
      const first = readManifest(firstDirectory);
      const second = readManifest(secondDirectory);
      expect(first.frames).toEqual(second.frames);
      expect(first.clips).toEqual(second.clips);
      expect(first.animationSpritesheet).toEqual(second.animationSpritesheet);
      expect(readFileSync(join(firstDirectory, first.animationChecksums))).toEqual(
        readFileSync(join(secondDirectory, second.animationChecksums)),
      );
    } finally {
      rmSync(firstDirectory, { recursive: true, force: true });
      rmSync(secondDirectory, { recursive: true, force: true });
    }
  });
});
