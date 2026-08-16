#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

import {
  CANVAS_SIZE,
  CONDITIONS,
  PALETTE,
  STAGES,
  drawContactFrame,
  drawContactLabel,
  drawStill,
} from "./source.mjs";

const SOURCE_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUTPUT_DIRECTORY = join(SOURCE_DIRECTORY, "generated");
const GENERATOR_PATH = fileURLToPath(import.meta.url);

function usage() {
  return "Usage: node art/grovekin/generate.mjs [--output-dir <directory>]";
}

function parseOutputDirectory(args) {
  let outputDirectory = DEFAULT_OUTPUT_DIRECTORY;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--output-dir") {
      const value = args[index + 1];
      if (!value) throw new Error(`${usage()}\n--output-dir requires a directory`);
      outputDirectory = resolve(value);
      index += 1;
    } else if (argument === "--help" || argument === "-h") {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`${usage()}\nUnknown argument: ${argument}`);
    }
  }
  return outputDirectory;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const checksumInput = Buffer.concat([typeBytes, data]);
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(checksumInput), data.length + 8);
  return chunk;
}

function encodePng(width, height, pixels) {
  const scanlines = Buffer.alloc(height * (width * 4 + 1));
  for (let row = 0; row < height; row += 1) {
    const scanlineStart = row * (width * 4 + 1);
    scanlines[scanlineStart] = 0;
    Buffer.from(pixels.buffer, pixels.byteOffset + row * width * 4, width * 4)
      .copy(scanlines, scanlineStart + 1);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines, { level: 9, strategy: 3 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function blit(source, target, targetWidth, x, y, sourceWidth = CANVAS_SIZE) {
  for (let row = 0; row < CANVAS_SIZE; row += 1) {
    const sourceStart = row * sourceWidth * 4;
    const targetStart = ((y + row) * targetWidth + x) * 4;
    target.set(source.subarray(sourceStart, sourceStart + sourceWidth * 4), targetStart);
  }
}

function makeSpritesheet(stills) {
  const pixels = new Uint8Array(CANVAS_SIZE * 4 * CANVAS_SIZE * 4 * 4);
  stills.forEach((still, index) => {
    const column = index % 4;
    const row = Math.floor(index / 4);
    blit(still.pixels, pixels, 192, column * CANVAS_SIZE, row * CANVAS_SIZE);
  });
  return encodePng(192, 192, pixels);
}

function makeContactSheet(stills) {
  const size = 216;
  const pixels = new Uint8Array(size * size * 4);
  for (let index = 0; index < pixels.length; index += 4) {
    pixels[index] = 244;
    pixels[index + 1] = 241;
    pixels[index + 2] = 217;
    pixels[index + 3] = 255;
  }
  stills.forEach((still, index) => {
    const column = index % 4;
    const row = Math.floor(index / 4);
    const x = 16 + column * 50;
    const y = 16 + row * 50;
    drawContactFrame(pixels, x, y);
    blit(still.pixels, pixels, size, x, y);
  });
  ["H", "U", "S", "D"].forEach((glyph, index) => drawContactLabel(pixels, 35 + index * 50, 5, glyph, "ink"));
  ["1", "2", "3", "4"].forEach((glyph, index) => drawContactLabel(pixels, 5, 23 + index * 50, glyph, "ink"));
  return encodePng(size, size, pixels);
}

function cleanOutputDirectory(outputDirectory) {
  mkdirSync(outputDirectory, { recursive: true });
  ["stills", "spritesheet", "manifest.json", "checksums.sha256", "contact-sheet.png"].forEach((entry) => {
    rmSync(join(outputDirectory, entry), { recursive: true, force: true });
  });
  mkdirSync(join(outputDirectory, "stills"), { recursive: true });
  mkdirSync(join(outputDirectory, "spritesheet"), { recursive: true });
}

function writeGenerated(outputDirectory) {
  cleanOutputDirectory(outputDirectory);
  const sourceSha256 = sha256(readFileSync(join(SOURCE_DIRECTORY, "source.mjs")));
  const generatorSha256 = sha256(readFileSync(GENERATOR_PATH));
  const generatorRevision = `grovekin-stills-v1+source-${sourceSha256}+generator-${generatorSha256}`;
  const stillPixels = [];
  const stills = STAGES.flatMap((stage, stageIndex) => CONDITIONS.map((condition) => {
    const id = `${stage.id}-${condition.id}`;
    const pixels = drawStill({ stageIndex, conditionId: condition.id });
    const bytes = encodePng(CANVAS_SIZE, CANVAS_SIZE, pixels);
    const file = `stills/${id}.png`;
    writeFileSync(join(outputDirectory, file), bytes);
    stillPixels.push(pixels);
    return {
      id,
      stage: stage.id,
      stageLabel: stage.label,
      condition: condition.id,
      conditionLabel: condition.label,
      file,
      width: CANVAS_SIZE,
      height: CANVAS_SIZE,
      sha256: sha256(bytes),
      semanticFlags: condition.semanticFlags,
    };
  }));

  const spritesheetBytes = makeSpritesheet(stillPixels.map((pixels) => ({ pixels })));
  const contactSheetBytes = makeContactSheet(stillPixels.map((pixels) => ({ pixels })));
  const spritesheetFile = "spritesheet/grovekin-stills.png";
  const contactSheetFile = "contact-sheet.png";
  writeFileSync(join(outputDirectory, spritesheetFile), spritesheetBytes);
  writeFileSync(join(outputDirectory, contactSheetFile), contactSheetBytes);

  const manifest = {
    schemaVersion: 1,
    generator: {
      revision: generatorRevision,
      command: "node art/grovekin/generate.mjs --output-dir <output-dir>",
      source: "art/grovekin/generate.mjs",
      drawingSource: "art/grovekin/source.mjs",
      sourceSha256,
      generatorSha256,
    },
    canvas: { width: CANVAS_SIZE, height: CANVAS_SIZE, alpha: "straight-rgba" },
    palette: {
      name: "Grovekin project-authored palette v1",
      colors: PALETTE,
    },
    stages: STAGES,
    conditions: CONDITIONS,
    stills,
    spritesheet: {
      file: spritesheetFile,
      width: 192,
      height: 192,
      layout: { columns: 4, rows: 4, order: "stage-major, condition order healthy/hungry/sad/deteriorated" },
      sha256: sha256(spritesheetBytes),
    },
    contactSheet: {
      file: contactSheetFile,
      width: 216,
      height: 216,
      layout: { rows: "Evolution Stage 1 through 4", columns: "Healthy, Hungry, Sad, Deteriorated" },
      sha256: sha256(contactSheetBytes),
    },
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  writeFileSync(join(outputDirectory, "manifest.json"), manifestBytes);

  const checksumFiles = stills.map((still) => still.file).concat([spritesheetFile, contactSheetFile]).sort();
  const checksumText = `${checksumFiles.map((file) => `${sha256(readFileSync(join(outputDirectory, file)))}  ${file}`).join("\n")}\n`;
  writeFileSync(join(outputDirectory, "checksums.sha256"), checksumText);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("/generate.mjs")) {
  try {
    writeGenerated(parseOutputDirectory(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

export { writeGenerated };
