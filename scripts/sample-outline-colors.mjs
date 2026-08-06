import Jimp from "jimp";

/**
 * Pull the selection-outline colours out of a Design Mode screenshot.
 *
 * The outlines are the only strongly chromatic pixels in the frame — the app
 * underneath is greys, near-white and near-black — so filtering on saturation
 * isolates them. Antialiasing smears each stroke across dozens of near-identical
 * values, so hits are snapped to a coarse grid and then merged by proximity;
 * without that you get two hundred "colours" that are all the same blue.
 */

const SRC = process.argv[2] ?? "/Users/pranavi/Downloads/browser-screenshot.png";

const image = await Jimp.read(SRC);
const { width, height } = image.bitmap;

function hsl(r, g, b) {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return { s, l };
}

const buckets = new Map();
for (let y = 0; y < height; y += 1) {
  for (let x = 0; x < width; x += 1) {
    const { r, g, b, a } = Jimp.intToRGBA(image.getPixelColor(x, y));
    if (a < 200) continue;
    const { s, l } = hsl(r, g, b);
    // Stroke pixels: strongly chromatic and mid-lightness. Fills are far paler
    // and the page chrome is essentially neutral, so both drop out here.
    if (s < 0.45 || l < 0.25 || l > 0.72) continue;
    const key = `${r >> 3}|${g >> 3}|${b >> 3}`;
    const hit = buckets.get(key) ?? { r: 0, g: 0, b: 0, n: 0 };
    hit.r += r;
    hit.g += g;
    hit.b += b;
    hit.n += 1;
    buckets.set(key, hit);
  }
}

const peaks = [...buckets.values()]
  .filter((h) => h.n > 150)
  .map((h) => ({ r: h.r / h.n, g: h.g / h.n, b: h.b / h.n, n: h.n }))
  .sort((a, b) => b.n - a.n);

/** Merge anything within a small RGB distance — one stroke, one colour. */
const merged = [];
for (const peak of peaks) {
  const near = merged.find(
    (m) => Math.hypot(m.r - peak.r, m.g - peak.g, m.b - peak.b) < 42,
  );
  if (near) {
    const total = near.n + peak.n;
    near.r = (near.r * near.n + peak.r * peak.n) / total;
    near.g = (near.g * near.n + peak.g * peak.n) / total;
    near.b = (near.b * near.n + peak.b * peak.n) / total;
    near.n = total;
  } else {
    merged.push({ ...peak });
  }
}

const hex = (c) =>
  "#" + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");

console.log(`${merged.length} distinct outline colours in ${SRC}\n`);
for (const c of merged.sort((a, b) => b.n - a.n)) {
  console.log(`  ${hex(c)}   ${String(c.n).padStart(6)} px`);
}
