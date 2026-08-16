import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { inflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(process.cwd());
const generatorPath = join(repositoryRoot, "art/grovekin/generate.mjs");
const generatedRoot = join(repositoryRoot, "art/grovekin/generated");

const stages = ["stage-1", "stage-2", "stage-3", "stage-4"] as const;
const conditions = ["healthy", "hungry", "sad", "deteriorated"] as const;

type Condition = (typeof conditions)[number];

type StillManifestEntry = {
  id: string;
  stage: string;
  condition: Condition;
  file: string;
  width: number;
  height: number;
  sha256: string;
  semanticFlags: string[];
};

type Manifest = {
  schemaVersion: number;
  generator: {
    revision: string;
    command: string;
    source: string;
    drawingSource: string;
    sourceSha256: string;
    generatorSha256: string;
  };
  canvas: { width: number; height: number; alpha: string };
  stills: StillManifestEntry[];
  spritesheet: { file: string; width: number; height: number; sha256: string };
  contactSheet: { file: string; width: number; height: number; sha256: string };
};

type ParsedPng = {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  pixels: Buffer;
};

function runGenerator(outputDirectory: string): void {
  execFileSync(process.execPath, [generatorPath, "--output-dir", outputDirectory], {
    cwd: repositoryRoot,
    stdio: "pipe",
  });
}

function listFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? listFiles(path).map((child) => join(entry.name, child))
      : [entry.name];
  }).sort();
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function parsePng(path: string): ParsedPng {
  const bytes = readFileSync(path);
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  expect(bytes.subarray(0, signature.length)).toEqual(signature);

  let offset = signature.length;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const imageData: Buffer[] = [];

  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const data = bytes.subarray(dataStart, dataEnd);

    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8] ?? -1;
      colorType = data[9] ?? -1;
      expect(data[10]).toBe(0);
      expect(data[11]).toBe(0);
      expect(data[12]).toBe(0);
    } else if (type === "IDAT") {
      imageData.push(data);
    } else if (type === "IEND") {
      break;
    }

    offset = dataEnd + 4;
  }

  const pixels = inflateSync(Buffer.concat(imageData));
  return { width, height, bitDepth, colorType, pixels };
}

function expectOpaqueOrTransparentPng(path: string, width: number, height: number): void {
  const png = parsePng(path);
  expect(png.width).toBe(width);
  expect(png.height).toBe(height);
  expect(png.bitDepth).toBe(8);
  expect(png.colorType).toBe(6);

  let transparentPixels = 0;
  for (let y = 0; y < png.height; y += 1) {
    const rowStart = y * (1 + png.width * 4);
    expect(png.pixels[rowStart]).toBe(0);
    for (let x = 0; x < png.width; x += 1) {
      const alpha = png.pixels[rowStart + 1 + x * 4 + 3];
      expect(alpha === 0 || alpha === 255).toBe(true);
      if (alpha === 0) transparentPixels += 1;
    }
  }
  expect(transparentPixels).toBeGreaterThan(0);
}

function readManifest(directory: string): Manifest {
  return JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8")) as Manifest;
}

function pixelAt(path: string, x: number, y: number): Buffer {
  const png = parsePng(path);
  const rowStart = y * (1 + png.width * 4) + 1;
  return png.pixels.subarray(rowStart + x * 4, rowStart + (x + 1) * 4);
}

function opaqueBounds(path: string): { top: number; opaquePixels: number } {
  const png = parsePng(path);
  let top = png.height;
  let opaquePixels = 0;
  for (let y = 0; y < png.height; y += 1) {
    const rowStart = y * (1 + png.width * 4) + 1;
    for (let x = 0; x < png.width; x += 1) {
      if (png.pixels[rowStart + x * 4 + 3] === 255) {
        top = Math.min(top, y);
        opaquePixels += 1;
      }
    }
  }
  return { top, opaquePixels };
}

describe("Grovekin production still inventory", () => {
  it("emits the complete 16-pose matrix with condition semantics and stage growth metadata", () => {
    const outputDirectory = mkdtempSync(join(tmpdir(), "grovekin-inventory-"));
    try {
      runGenerator(outputDirectory);
      const manifest = readManifest(outputDirectory);
      const expectedIds = stages.flatMap((stage) => conditions.map((condition) => `${stage}-${condition}`));

      expect(manifest.schemaVersion).toBe(1);
      expect(manifest.canvas).toEqual({ width: 48, height: 48, alpha: "straight-rgba" });
      expect(manifest.stills).toHaveLength(16);
      expect(manifest.stills.map((still) => still.id)).toEqual(expectedIds);
      expect(new Set(manifest.stills.map((still) => still.sha256)).size).toBe(16);

      const requiredFlags: Record<Condition, string[]> = {
        healthy: ["upright", "open-eyes", "intact-growth"],
        hungry: ["forward-lean", "open-mouth", "food-cue"],
        sad: ["drooped", "lowered-eyes", "one-tear"],
        deteriorated: ["low-posture", "closed-eyes", "muted-growth", "broken-accent", "recoverable"],
      };

      for (const still of manifest.stills) {
        expect(still.width).toBe(48);
        expect(still.height).toBe(48);
        expect(still.semanticFlags).toEqual(expect.arrayContaining(requiredFlags[still.condition]));
        expect(still.file).toMatch(/^stills\/stage-[1-4]-(healthy|hungry|sad|deteriorated)\.png$/);
        expectOpaqueOrTransparentPng(join(outputDirectory, still.file), 48, 48);
        expect(sha256(join(outputDirectory, still.file))).toBe(still.sha256);
      }

      expect(new Set(manifest.stills.map((still) => still.stage)).size).toBe(4);
      expect(manifest.spritesheet.file).toBe("spritesheet/grovekin-stills.png");
      expect(manifest.contactSheet.file).toBe("contact-sheet.png");
      expectOpaqueOrTransparentPng(join(outputDirectory, manifest.spritesheet.file), 192, 192);
      expect(parsePng(join(outputDirectory, manifest.contactSheet.file)).width).toBe(manifest.contactSheet.width);
      expect(parsePng(join(outputDirectory, manifest.contactSheet.file)).height).toBe(manifest.contactSheet.height);

      const healthyPaths = stages.map((stage) => join(outputDirectory, `stills/${stage}-healthy.png`));
      expect(healthyPaths.map((path) => opaqueBounds(path).top)).toEqual([9, 6, 2, 0]);
      expect(opaqueBounds(healthyPaths[1]!).opaquePixels).toBeGreaterThan(opaqueBounds(healthyPaths[0]!).opaquePixels);
      expect(opaqueBounds(healthyPaths[2]!).opaquePixels).toBeGreaterThan(opaqueBounds(healthyPaths[1]!).opaquePixels);
      expect(opaqueBounds(healthyPaths[3]!).opaquePixels).toBeGreaterThan(opaqueBounds(healthyPaths[2]!).opaquePixels);

      expect(pixelAt(join(outputDirectory, "stills/stage-1-healthy.png"), 16, 29)).toEqual(Buffer.from([38, 56, 59, 255]));
      expect(pixelAt(join(outputDirectory, "stills/stage-1-hungry.png"), 24, 37)).toEqual(Buffer.from([38, 56, 59, 255]));
      expect(pixelAt(join(outputDirectory, "stills/stage-1-hungry.png"), 38, 39)).toEqual(Buffer.from([241, 196, 94, 255]));
      expect(pixelAt(join(outputDirectory, "stills/stage-1-sad.png"), 30, 38)).toEqual(Buffer.from([103, 184, 207, 255]));
      expect(pixelAt(join(outputDirectory, "stills/stage-1-deteriorated.png"), 16, 33)).toEqual(Buffer.from([38, 56, 59, 255]));
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true });
    }
  });

  it("produces byte-identical generated files and matching checksum inventory on every run", () => {
    const firstDirectory = mkdtempSync(join(tmpdir(), "grovekin-first-"));
    const secondDirectory = mkdtempSync(join(tmpdir(), "grovekin-second-"));
    try {
      runGenerator(firstDirectory);
      runGenerator(secondDirectory);

      const firstFiles = listFiles(firstDirectory);
      expect(firstFiles).toEqual(listFiles(secondDirectory));
      for (const file of firstFiles) {
        expect(readFileSync(join(firstDirectory, file))).toEqual(readFileSync(join(secondDirectory, file)));
      }

      const manifest = readManifest(firstDirectory);
      const checksumLines = readFileSync(join(firstDirectory, "checksums.sha256"), "utf8")
        .trim()
        .split("\n")
        .map((line) => line.split("  "));
      expect(checksumLines).toHaveLength(18);
      for (const [digest, file] of checksumLines) {
        expect(digest).toMatch(/^[0-9a-f]{64}$/);
        expect(file).toBeTruthy();
        expect(sha256(join(firstDirectory, file as string))).toBe(digest);
      }
      expect(manifest.stills.every((still) => checksumLines.some(([, file]) => file === still.file))).toBe(true);
    } finally {
      rmSync(firstDirectory, { recursive: true, force: true });
      rmSync(secondDirectory, { recursive: true, force: true });
    }
  });

  it("checks in the generated review artifacts and rights ledger for the foundation integration seam", () => {
    expect(existsSync(generatedRoot)).toBe(true);
    expect(existsSync(join(repositoryRoot, "art/grovekin/asset-rights-ledger.md"))).toBe(true);
    expect(existsSync(join(repositoryRoot, "art/grovekin/README.md"))).toBe(true);
    expect(existsSync(join(repositoryRoot, "art/grovekin/still-readability-review.md"))).toBe(true);
    const manifest = readManifest(generatedRoot);
    const ledger = readFileSync(join(repositoryRoot, "art/grovekin/asset-rights-ledger.md"), "utf8");

    expect(manifest.generator.revision).toMatch(/^grovekin-stills-v1\+source-[0-9a-f]{64}\+generator-[0-9a-f]{64}$/);
    expect(manifest.generator.command).toContain("node art/grovekin/generate.mjs");
    expect(manifest.generator.source).toBe("art/grovekin/generate.mjs");
    expect(manifest.generator.drawingSource).toBe("art/grovekin/source.mjs");
    expect(manifest.generator.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.generator.generatorSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(ledger).toContain("project-authored");
    expect(ledger).toContain("no third-party");
    expect(ledger).toContain("no image-generation-model output");
    expect(ledger).toContain("manifest.json");
    expect(ledger).toContain("checksums.sha256");
    expect(readFileSync(join(repositoryRoot, "art/grovekin/still-readability-review.md"), "utf8")).toContain("Matrix verdict");
  });
});
