import Jimp from "jimp";
import { mkdir } from "node:fs/promises";

/**
 * Generate the extension's icon set from the app-icon render.
 *
 * The source has a wide transparent margin, which Chrome would render as extra
 * padding on top of its own — the tile would sit small and lost in the toolbar.
 * So autocrop to the artwork first, then resize.
 *
 * Cropping the margin is not enough on its own. In the source the pushpin fills
 * only half the tile's width, and the pale glass around it is what a 16px
 * toolbar slot mostly shows — the icon reads as a blue-white smudge. So the
 * artwork is scaled past the canvas and centre-cropped: the tile bleeds off the
 * edges, the pin grows by the same factor, and the identity survives being
 * small. The rounded corners are then cut back in, because the crop squares
 * them off and an app tile with hard corners stops looking like an app tile.
 */

const SRC = "brand/app-icon-source.png";
const OUT = "packages/extension/public/icons";

/**
 * How far past the canvas the tile is pushed. 1.18 is the most the pin can grow
 * before its needle and head start touching the edges; the wasted margin is
 * already gone by then.
 */
const BLEED = 1.18;

/** Corner radius as a fraction of the icon's side, matching the source tile. */
const RADIUS = 0.2;

// 16 and 32 are the toolbar; 48 is the extensions page; 128 is the store listing
// and the install dialog.
const SIZES = [16, 32, 48, 128];

await mkdir(OUT, { recursive: true });

const source = await Jimp.read(SRC);
console.log(`source     ${source.bitmap.width}×${source.bitmap.height}`);

source.autocrop({ tolerance: 0.002, cropOnlyFrames: false });
console.log(`autocropped ${source.bitmap.width}×${source.bitmap.height}`);

// The artwork's glow isn't symmetric, so the crop comes out slightly taller
// than it is wide. Pad back to square before scaling — resizing a non-square
// source into a square icon would squash the tile.
const side = Math.max(source.bitmap.width, source.bitmap.height);
source.contain(side, side, Jimp.HORIZONTAL_ALIGN_CENTER | Jimp.VERTICAL_ALIGN_MIDDLE);
console.log(`squared     ${source.bitmap.width}×${source.bitmap.height}`);

// Grow past the canvas, then take the middle back: the pin gets bigger while
// the tile's outer band — the part that reads as empty white — goes off-edge.
const bled = Math.round(side * BLEED);
source.resize(bled, bled, Jimp.RESIZE_BICUBIC);
const inset = Math.round((bled - side) / 2);
source.crop(inset, inset, side, side);
console.log(`bled ${BLEED}× ${source.bitmap.width}×${source.bitmap.height}`);

/**
 * Round the corners off at the new edge.
 *
 * Done at full resolution rather than per size, so the downscale to 16px does
 * the antialiasing for free; the half-pixel band here only keeps the full-size
 * edge from looking sawn. Distance is the standard rounded-rect one: how far
 * outside the corner arc a pixel sits, negative while still inside.
 */
const half = side / 2;
const r = side * RADIUS;
source.scan(0, 0, side, side, function scanPixel(x, y, idx) {
  const qx = Math.abs(x + 0.5 - half) - (half - r);
  const qy = Math.abs(y + 0.5 - half) - (half - r);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const distance = outside + Math.min(Math.max(qx, qy), 0) - r;
  const coverage = Math.min(Math.max(0.5 - distance, 0), 1);
  this.bitmap.data[idx + 3] = Math.round(this.bitmap.data[idx + 3] * coverage);
});
console.log(`rounded     r=${RADIUS * 100}% of ${side}px`);

for (const size of SIZES) {
  const icon = source.clone().resize(size, size, Jimp.RESIZE_BICUBIC);
  await icon.writeAsync(`${OUT}/icon-${size}.png`);
  console.log(`wrote      ${OUT}/icon-${size}.png`);
}
