/**
 * Trace the toolbar glyphs out of the reference render.
 *
 * The reference is a JPEG screenshot, so nothing about it is authoritative at
 * the pixel — but its *geometry* is, and geometry is what hand-drawing keeps
 * getting wrong. Each glyph is cropped, thresholded, and traced; the resulting
 * outlines are then measured (bounds, stroke width, angles) so the icon
 * components can be rebuilt to match rather than approximated by eye.
 */
import jimp from "jimp";
import potrace from "potrace";
import { writeFileSync, mkdirSync } from "node:fs";

const Jimp = jimp.Jimp ?? jimp;
const intToRGBA = jimp.intToRGBA ?? Jimp.intToRGBA;

const SRC = process.argv[2];
const OUT = process.argv[3];
mkdirSync(OUT, { recursive: true });

/** Glyph boxes, read off the horizontal scan in _probe-navbar.mjs. */
const GLYPHS = {
  grip:   { box: [225, 415, 295, 510], mode: "dark" },
  cursor: { box: [435, 410, 525, 525], mode: "dark" },
  pin:    { box: [590, 400, 730, 540], mode: "blue" },
  pencil: { box: [810, 410, 905, 520], mode: "dark" },
  close:  { box: [1495, 435, 1575, 510], mode: "dark" },
};

const trace = (path, opts) =>
  new Promise((resolve, reject) =>
    potrace.trace(path, opts, (err, svg) => (err ? reject(err) : resolve(svg))),
  );

for (const [name, { box, mode }] of Object.entries(GLYPHS)) {
  const [x0, y0, x1, y1] = box;
  const w = x1 - x0;
  const h = y1 - y0;
  const src = await Jimp.read(SRC);
  const crop = src.clone().crop(x0, y0, w, h);

  // Flatten to a hard mask before tracing. "blue" keeps only the deep glyph and
  // drops the pale disc behind it; "dark" keeps ink and drops the page.
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const c = intToRGBA(crop.getPixelColor(x, y));
      const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
      const ink = mode === "blue" ? lum < 140 : lum < 165;
      crop.setPixelColor(ink ? 0x000000ff : 0xffffffff, x, y);
    }
  }

  const maskPath = `${OUT}/${name}-mask.png`;
  await crop.writeAsync(maskPath);
  const svg = await trace(maskPath, { threshold: 128, turdSize: 12, optCurve: true, alphaMax: 1 });
  writeFileSync(`${OUT}/${name}.svg`, svg);

  // Ink bounds inside the crop, so the glyph can be re-centred on a 20 grid.
  let minX = w, maxX = 0, minY = h, maxY = 0, n = 0;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (intToRGBA(crop.getPixelColor(x, y)).r > 128) continue;
      n += 1;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
  }
  console.log(
    `${name.padEnd(7)} ink ${String(maxX - minX + 1).padStart(3)}×${String(maxY - minY + 1).padStart(3)}` +
      `  at (${minX},${minY})  ${n} px  paths ${(svg.match(/<path/g) ?? []).length}`,
  );
}
