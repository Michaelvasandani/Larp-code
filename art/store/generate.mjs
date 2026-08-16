import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { deflateSync } from "node:zlib";

const root = resolve(new URL("../..", import.meta.url).pathname);
const outputArgument = process.argv.find((argument) => argument.startsWith("--output="))?.slice("--output=".length)
  ?? process.env.STORE_ART_OUTPUT;
const output = resolve(outputArgument ?? resolve(root, "art/store/generated"));

function chunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBytes, data]);
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 0);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  return Buffer.concat([length, body, checksum]);
}

function png(width, height, paint) {
  const pixels = Buffer.alloc(width * height * 4, 0);
  const set = (x, y, color) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const offset = (y * width + x) * 4;
    pixels.set(color, offset);
  };
  const rect = (x, y, w, h, color) => {
    for (let yy = y; yy < y + h; yy += 1) for (let xx = x; xx < x + w; xx += 1) set(xx, yy, color);
  };
  paint({ set, rect });
  const rows = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    rows[y * (1 + width * 4)] = 0;
    pixels.copy(rows, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const colors = {
  paper: [244, 241, 217, 255],
  ink: [38, 56, 59, 255],
  leaf: [99, 184, 120, 255],
  light: [184, 220, 151, 255],
  flower: [230, 154, 132, 255],
  gold: [241, 196, 94, 255],
  sky: [159, 196, 192, 255],
};

function grovekin({ rect }) {
  rect(13, 14, 22, 21, colors.light);
  rect(10, 20, 28, 13, colors.light);
  rect(15, 30, 18, 9, colors.leaf);
  rect(19, 8, 10, 9, colors.leaf);
  rect(8, 25, 8, 5, colors.leaf);
  rect(32, 23, 8, 5, colors.leaf);
  rect(16, 21, 4, 4, colors.ink);
  rect(28, 21, 4, 4, colors.ink);
  rect(21, 27, 6, 3, colors.ink);
  rect(19, 9, 3, 3, colors.flower);
  rect(26, 9, 3, 3, colors.flower);
}

function write(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

mkdirSync(output, { recursive: true });
for (const [name, size] of [["icon-16.png", 16], ["icon-48.png", 48], ["icon-128.png", 128]]) {
  write(resolve(output, name), png(size, size, ({ rect }) => {
    rect(0, 0, size, size, colors.paper);
    const scale = Math.max(1, Math.floor(size / 48));
    const offset = Math.floor((size - 48 * scale) / 2);
    grovekin({ rect: (x, y, w, h, color) => rect(offset + x * scale, offset + y * scale, w * scale, h * scale, color) });
  }));
}

write(resolve(output, "promo-small.png"), png(440, 280, ({ rect }) => {
  rect(0, 0, 440, 280, colors.paper);
  rect(18, 18, 404, 244, [255, 253, 249, 255]);
  rect(34, 34, 372, 5, colors.leaf);
  rect(34, 235, 372, 5, colors.ink);
  for (const [x, y, color] of [[80, 78, colors.light], [180, 78, colors.gold], [280, 78, colors.sky]]) {
    grovekin({ rect: (px, py, w, h, c) => rect(x + px * 3, y + py * 3, w * 3, h * 3, c ?? color) });
  }
  rect(115, 203, 210, 8, colors.ink);
  rect(145, 217, 150, 5, colors.leaf);
}));

const screenshots = [
  ["active-stage-3-healthy.png", "../../artifacts/ticket36-grovekin/screenshots/active-stage-3-healthy.png"],
  ["playback-solve-stage-3.png", "../../artifacts/ticket36-grovekin/screenshots/playback-solve-stage-3.png"],
  ["reduced-motion-stage-4-deteriorated-static.png", "../../artifacts/ticket36-grovekin/screenshots/reduced-motion-stage-4-deteriorated-static.png"],
];
mkdirSync(resolve(output, "screenshots"), { recursive: true });
for (const [name, source] of screenshots) {
  writeFileSync(resolve(output, "screenshots", name), readFileSync(resolve(root, "art/store", source)));
}
