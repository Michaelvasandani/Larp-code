/**
 * Canonical, project-authored Grovekin source definitions.
 *
 * This module is intentionally dependency-free: generated pixels are made from
 * these palette, pose, and timing definitions during development/release and
 * are never drawn by the extension at runtime.
 */

export const CANVAS_SIZE = 48;

export const PALETTE = Object.freeze({
  transparent: "#00000000",
  ink: "#26383b",
  outline: "#395556",
  bodyHealthy: "#b8dc97",
  bodyLight: "#d8edb4",
  bodyShadow: "#79ad7e",
  bodyHungry: "#e4c481",
  bodyHungryLight: "#f2dba0",
  bodySad: "#9fc4c0",
  bodySadLight: "#c6e0d2",
  bodyDeteriorated: "#899b86",
  bodyDeterioratedLight: "#a9b69a",
  leaf: "#63b878",
  leafBright: "#91d88a",
  leafDark: "#34745d",
  leafMuted: "#718d72",
  flower: "#e69a84",
  flowerLight: "#f4c09a",
  berry: "#e7a55f",
  tear: "#67b8cf",
  food: "#f1c45e",
  paper: "#f4f1d9",
  grid: "#aab99b",
});

export const STAGES = Object.freeze([
  Object.freeze({ id: "stage-1", label: "Seedling", growth: "single-sprout" }),
  Object.freeze({ id: "stage-2", label: "Branchling", growth: "side-leaves" }),
  Object.freeze({ id: "stage-3", label: "Blooming", growth: "flower-crown" }),
  Object.freeze({ id: "stage-4", label: "Canopy", growth: "wide-canopy" }),
]);

export const CONDITIONS = Object.freeze([
  Object.freeze({
    id: "healthy",
    label: "Healthy",
    semanticFlags: ["upright", "open-eyes", "intact-growth"],
  }),
  Object.freeze({
    id: "hungry",
    label: "Hungry",
    semanticFlags: ["forward-lean", "open-mouth", "food-cue"],
  }),
  Object.freeze({
    id: "sad",
    label: "Sad",
    semanticFlags: ["drooped", "lowered-eyes", "one-tear"],
  }),
  Object.freeze({
    id: "deteriorated",
    label: "Deteriorated",
    semanticFlags: ["low-posture", "closed-eyes", "muted-growth", "broken-accent", "recoverable"],
  }),
]);

const colors = Object.fromEntries(Object.entries(PALETTE).map(([name, hex]) => [name, hex.slice(0, 7)]));

function rgb(name) {
  const hex = colors[name];
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

function writePixel(canvas, canvasSize, x, y, colorName) {
  if (x < 0 || y < 0 || x >= canvasSize || y >= canvasSize) return;
  const index = (y * canvasSize + x) * 4;
  const [red, green, blue] = rgb(colorName);
  canvas[index] = red;
  canvas[index + 1] = green;
  canvas[index + 2] = blue;
  canvas[index + 3] = 255;
}

function fillRectangle(canvas, canvasSize, x, y, width, height, colorName) {
  for (let row = y; row < y + height; row += 1) {
    for (let column = x; column < x + width; column += 1) {
      writePixel(canvas, canvasSize, column, row, colorName);
    }
  }
}

function fillRect(canvas, x, y, width, height, colorName) {
  fillRectangle(canvas, CANVAS_SIZE, x, y, width, height, colorName);
}

function fillRows(canvas, centerX, startY, rows, colorName) {
  rows.forEach((width, offset) => {
    fillRect(canvas, centerX - Math.floor(width / 2), startY + offset, width, 1, colorName);
  });
}

function drawLeaf(canvas, x, y, direction, colorName) {
  const sign = direction < 0 ? -1 : 1;
  fillRect(canvas, x, y, 2, 2, colorName);
  fillRect(canvas, x + sign * 2, y - 1, 3, 3, colorName);
  fillRect(canvas, x + sign * 5, y - 2, 3, 3, colorName);
  fillRect(canvas, x + sign * 8, y - 1, 2, 2, colorName);
}

function drawFlower(canvas, x, y, colorName) {
  fillRect(canvas, x + 2, y, 3, 2, colorName);
  fillRect(canvas, x, y + 2, 7, 3, colorName);
  fillRect(canvas, x + 2, y + 5, 3, 2, colorName);
  fillRect(canvas, x + 2, y + 2, 3, 3, "food");
}

function drawGrowth(canvas, pose) {
  const { stageIndex, conditionId } = pose;
  const muted = conditionId === "deteriorated";
  const leaf = muted ? "leafMuted" : "leaf";
  const brightLeaf = muted ? "leafMuted" : "leafBright";
  const darkLeaf = muted ? "leafMuted" : "leafDark";

  if (stageIndex === 0) {
    fillRect(canvas, 23, 11, 2, 10, darkLeaf);
    drawLeaf(canvas, 22, 14, -1, brightLeaf);
    drawLeaf(canvas, 25, 11, 1, leaf);
    if (muted) fillRect(canvas, 23, 11, 2, 3, "outline");
    return;
  }

  if (stageIndex === 1) {
    fillRect(canvas, 23, 8, 2, 14, darkLeaf);
    fillRect(canvas, 19, 13, 9, 2, darkLeaf);
    drawLeaf(canvas, 20, 13, -1, brightLeaf);
    drawLeaf(canvas, 26, 12, 1, leaf);
    drawLeaf(canvas, 21, 8, -1, brightLeaf);
    if (muted) fillRect(canvas, 23, 8, 2, 4, "outline");
    return;
  }

  if (stageIndex === 2) {
    fillRect(canvas, 23, 5, 2, 18, darkLeaf);
    fillRect(canvas, 17, 13, 14, 2, darkLeaf);
    drawLeaf(canvas, 18, 13, -1, brightLeaf);
    drawLeaf(canvas, 28, 12, 1, leaf);
    drawFlower(canvas, 20, 2, muted ? "leafMuted" : "flower");
    if (muted) fillRect(canvas, 23, 5, 2, 5, "outline");
    return;
  }

  fillRect(canvas, 22, 4, 3, 20, darkLeaf);
  fillRect(canvas, 13, 11, 21, 2, darkLeaf);
  drawLeaf(canvas, 15, 11, -1, brightLeaf);
  drawLeaf(canvas, 31, 10, 1, leaf);
  drawLeaf(canvas, 18, 6, -1, brightLeaf);
  drawLeaf(canvas, 28, 6, 1, leaf);
  drawFlower(canvas, 20, 0, muted ? "leafMuted" : "flower");
  if (!muted) drawFlower(canvas, 27, 3, "flowerLight");
  if (muted) {
    fillRect(canvas, 22, 4, 3, 6, "outline");
    fillRect(canvas, 31, 14, 3, 2, "leafMuted");
  }
}

function drawFace(canvas, centerX, bodyTop, conditionId) {
  const eyeY = bodyTop + (conditionId === "deteriorated" ? 7 : 9);
  if (conditionId === "deteriorated") {
    fillRect(canvas, centerX - 8, eyeY, 5, 1, "ink");
    fillRect(canvas, centerX + 4, eyeY, 5, 1, "ink");
    fillRect(canvas, centerX - 4, eyeY + 6, 8, 1, "outline");
    return;
  }

  if (conditionId === "sad") {
    fillRect(canvas, centerX - 8, eyeY + 2, 3, 2, "ink");
    fillRect(canvas, centerX + 5, eyeY + 2, 3, 2, "ink");
    fillRect(canvas, centerX + 8, eyeY + 6, 2, 4, "tear");
    fillRect(canvas, centerX - 3, eyeY + 8, 6, 1, "outline");
    return;
  }

  fillRect(canvas, centerX - 8, eyeY, 4, 4, "ink");
  fillRect(canvas, centerX + 4, eyeY, 4, 4, "ink");
  fillRect(canvas, centerX - 7, eyeY, 1, 1, "bodyLight");
  fillRect(canvas, centerX + 5, eyeY, 1, 1, "bodyLight");
  if (conditionId === "hungry") {
    fillRect(canvas, centerX - 3, eyeY + 7, 7, 4, "ink");
    fillRect(canvas, centerX - 1, eyeY + 9, 3, 1, "flower");
    fillRect(canvas, centerX + 11, eyeY + 9, 4, 4, "food");
    fillRect(canvas, centerX + 12, eyeY + 8, 2, 1, "leafDark");
  } else {
    fillRect(canvas, centerX - 3, eyeY + 8, 7, 1, "outline");
  }
}

function drawBody(canvas, pose) {
  const { stageIndex, conditionId } = pose;
  const posture = {
    healthy: { centerX: 24, top: 20, rows: [12, 18, 22, 26, 28, 30, 30, 28, 26, 22, 18, 12] },
    hungry: { centerX: 27, top: 21, rows: [11, 17, 22, 26, 29, 31, 31, 29, 26, 21, 16, 10] },
    sad: { centerX: 22, top: 23, rows: [12, 18, 22, 26, 29, 31, 31, 29, 26, 22, 17, 12] },
    deteriorated: { centerX: 24, top: 26, rows: [13, 19, 24, 28, 31, 33, 33, 31, 28, 24, 19, 13] },
  }[conditionId];
  const stageWidthAdjustment = Math.min(stageIndex, 2);
  const rows = posture.rows.map((width, index) => width + (index > 1 && index < 10 ? stageWidthAdjustment : 0));
  const outlineRows = rows.map((width) => width + 2);
  const outlineTop = posture.top - 1;
  const bodyColor = {
    healthy: "bodyHealthy",
    hungry: "bodyHungry",
    sad: "bodySad",
    deteriorated: "bodyDeteriorated",
  }[conditionId];
  const lightColor = {
    healthy: "bodyLight",
    hungry: "bodyHungryLight",
    sad: "bodySadLight",
    deteriorated: "bodyDeterioratedLight",
  }[conditionId];

  fillRows(canvas, posture.centerX, outlineTop, outlineRows, "outline");
  fillRows(canvas, posture.centerX, posture.top, rows, bodyColor);
  fillRows(canvas, posture.centerX - 2, posture.top + 2, rows.slice(2, 7), lightColor);
  fillRect(canvas, posture.centerX - 12, posture.top + 10, 4, 4, "bodyShadow");
  fillRect(canvas, posture.centerX + 8, posture.top + 11, 4, 4, "bodyShadow");
  drawFace(canvas, posture.centerX, posture.top, conditionId);
  drawGrowth(canvas, pose);
}

/** Draw one of the accepted 16 static stills into a straight-alpha RGBA buffer. */
export function drawStill(pose) {
  const canvas = new Uint8Array(CANVAS_SIZE * CANVAS_SIZE * 4);
  drawBody(canvas, Object.freeze(pose));
  return canvas;
}

function clearPixel(canvas, x, y) {
  if (x < 0 || y < 0 || x >= CANVAS_SIZE || y >= CANVAS_SIZE) return;
  const index = (y * CANVAS_SIZE + x) * 4;
  canvas[index] = 0;
  canvas[index + 1] = 0;
  canvas[index + 2] = 0;
  canvas[index + 3] = 0;
}

function animationPixel(canvas, x, y, colorName) {
  writePixel(canvas, CANVAS_SIZE, x, y, colorName);
}

/** Draw one deterministic animation frame from the canonical source. */
export function drawAnimationFrame({ clipId, frameIndex, stageIndex = 0, targetStageIndex = stageIndex, conditionId = "healthy" }) {
  const canvas = drawStill({ stageIndex, conditionId });

  if (clipId.endsWith("-idle") && frameIndex === 1) {
    const eyeY = 29;
    for (const x of [16, 17, 18, 19, 28, 29, 30, 31]) {
      clearPixel(canvas, x, eyeY);
      clearPixel(canvas, x, eyeY + 1);
      clearPixel(canvas, x, eyeY + 2);
      clearPixel(canvas, x, eyeY + 3);
    }
    animationPixel(canvas, 16, eyeY + 2, "ink");
    animationPixel(canvas, 28, eyeY + 2, "ink");
  }

  if (clipId === "hungry-accent" && frameIndex === 1) {
    animationPixel(canvas, 39, 39, "food");
    animationPixel(canvas, 40, 38, "food");
    animationPixel(canvas, 41, 39, "food");
  }
  if (clipId === "sad-accent" && frameIndex === 1) {
    animationPixel(canvas, 32, 38, "tear");
    animationPixel(canvas, 32, 39, "tear");
    animationPixel(canvas, 32, 40, "tear");
  }
  if (clipId === "deteriorated-accent" && frameIndex === 1) {
    animationPixel(canvas, 14, 41, "leafMuted");
    animationPixel(canvas, 15, 42, "leafMuted");
    animationPixel(canvas, 16, 41, "outline");
  }

  if (clipId === "solve-reaction" && frameIndex === 1) {
    animationPixel(canvas, 12, 20, "flowerLight");
    animationPixel(canvas, 35, 20, "flowerLight");
    animationPixel(canvas, 10, 24, "food");
    animationPixel(canvas, 37, 24, "food");
  }

  if (clipId === "evolution-transition") {
    if (frameIndex === 1) {
      animationPixel(canvas, 20, 8, "leafBright");
      animationPixel(canvas, 27, 8, "leaf");
      animationPixel(canvas, 19, 9, "leafBright");
      animationPixel(canvas, 28, 9, "leaf");
    }
    if (frameIndex === 2) return drawStill({ stageIndex: targetStageIndex, conditionId: "healthy" });
  }

  if (clipId === "stage-4-farewell") {
    if (frameIndex === 1) {
      for (let x = 13; x < 35; x += 1) animationPixel(canvas, x, 39, "bodyShadow");
    }
    if (frameIndex === 2) {
      for (let y = 22; y < 42; y += 1) {
        for (let x = 10; x < 39; x += 1) clearPixel(canvas, x, y);
      }
    }
  }

  return canvas;
}

export function drawContactLabel(canvas, x, y, glyph, colorName) {
  const glyphs = {
    "1": ["111", "010", "110", "010", "111"],
    "2": ["110", "001", "010", "100", "111"],
    "3": ["110", "001", "010", "001", "110"],
    "4": ["101", "101", "111", "001", "001"],
    H: ["101", "101", "111", "101", "101"],
    U: ["101", "101", "101", "101", "010"],
    S: ["111", "100", "111", "001", "111"],
    D: ["110", "101", "101", "101", "110"],
  };
  const rows = glyphs[glyph];
  if (!rows) return;
  rows.forEach((row, rowIndex) => {
    [...row].forEach((value, columnIndex) => {
      if (value === "1") {
        writePixel(canvas, 216, x + columnIndex, y + rowIndex, colorName);
      }
    });
  });
}

export function drawContactFrame(canvas, x, y) {
  fillRectangle(canvas, 216, x - 1, y - 1, 50, 50, "grid");
}
