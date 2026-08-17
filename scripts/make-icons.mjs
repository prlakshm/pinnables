import Jimp from "jimp";
import { mkdir } from "node:fs/promises";

/**
 * Generate the extension's icon set from the app-icon render.
 *
 * The source floats the tile in a wide transparent margin, which Chrome renders
 * as padding on top of its own — the icon sits small in the toolbar, ringed by
 * what reads as white. So the tile is lifted out of that margin and fills the
 * icon edge to edge, glass rim and rounded corners intact.
 *
 * Two details do the work. The crop ignores the faint haze the render leaves
 * outside the rim: cropping to the last visible pixel keeps ~30px of it, and at
 * 16px that haze is pure cost. And the tile is a shade taller than it is wide,
 * so the square comes from trimming the long axis rather than padding the short
 * one — padding puts the margin straight back, which is what it used to do.
 */

const SRC = "brand/app-icon-source.png";
const OUT = "packages/extension/public/icons";

// 16 and 32 are the toolbar; 48 is the extensions page; 128 is the store listing
// and the install dialog.
const SIZES = [16, 32, 48, 128];

/**
 * The alpha at which the tile counts as having started: above the render's
 * outer haze, below the antialiased edge of the rim, so the crop is tight
 * without sawing that edge flat.
 */
const EDGE_ALPHA = 60;

await mkdir(OUT, { recursive: true });

const source = await Jimp.read(SRC);
console.log(`source      ${source.bitmap.width}×${source.bitmap.height}`);

let left = source.bitmap.width;
let top = source.bitmap.height;
let right = 0;
let bottom = 0;
source.scan(0, 0, source.bitmap.width, source.bitmap.height, function findEdges(x, y, idx) {
  if (this.bitmap.data[idx + 3] < EDGE_ALPHA) return;
  if (x < left) left = x;
  if (x > right) right = x;
  if (y < top) top = y;
  if (y > bottom) bottom = y;
});
source.crop(left, top, right - left + 1, bottom - top + 1);
console.log(`cropped     ${source.bitmap.width}×${source.bitmap.height}`);

const side = Math.min(source.bitmap.width, source.bitmap.height);
source.crop(
  Math.round((source.bitmap.width - side) / 2),
  Math.round((source.bitmap.height - side) / 2),
  side,
  side,
);
console.log(`squared     ${source.bitmap.width}×${source.bitmap.height}`);

for (const size of SIZES) {
  const icon = source.clone().resize(size, size, Jimp.RESIZE_BICUBIC);
  await icon.writeAsync(`${OUT}/icon-${size}.png`);
  console.log(`wrote       ${OUT}/icon-${size}.png`);
}
