import Jimp from "jimp";
import { mkdir } from "node:fs/promises";

/**
 * Generate the extension's icon set from the app-icon render.
 *
 * The source has a wide transparent margin, which Chrome would render as extra
 * padding on top of its own — the tile would sit small and lost in the toolbar.
 * So autocrop to the artwork first, then resize.
 */

const SRC = "brand/app-icon-source.png";
const OUT = "packages/extension/public/icons";

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

for (const size of SIZES) {
  const icon = source.clone().resize(size, size, Jimp.RESIZE_BICUBIC);
  await icon.writeAsync(`${OUT}/icon-${size}.png`);
  console.log(`wrote      ${OUT}/icon-${size}.png`);
}
