import Jimp from "jimp";

/**
 * Measure the tittle's tone regions straight from the source render.
 *
 * Eyeballing an ellipse onto a rendered sphere gets the size roughly right and
 * the orientation wrong — the specular is a tilted sliver, not an axis-aligned
 * oval. So classify the pixels by tone, then fit each region with PCA: the
 * principal axis gives the tilt, the eigenvalue spread gives the aspect.
 */

const SRC = "brand/wordmark-source.png";

/**
 * The disc, from the trace diagnostics (bbox x 296–353, y 58–117). Sampling is
 * masked to just inside it: the antialiased rim blends red into the white page
 * and produces bright, moderately-red pixels all the way around, which is
 * enough to drag a naive fit off the actual specular.
 */
const DISC = { cx: 324.5, cy: 87.5, r: 26 };

const image = await Jimp.read(SRC);

/** Sort every disc pixel into a tone band. */
const bands = { white: [], light: [], base: [] };

for (let y = Math.floor(DISC.cy - DISC.r); y <= Math.ceil(DISC.cy + DISC.r); y += 1) {
  for (let x = Math.floor(DISC.cx - DISC.r); x <= Math.ceil(DISC.cx + DISC.r); x += 1) {
    if (Math.hypot(x - DISC.cx, y - DISC.cy) > DISC.r) continue;

    const { r, g, b } = Jimp.intToRGBA(image.getPixelColor(x, y));
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    // The specular washes out toward white, so it is the *desaturated* region,
    // not merely the brightest — the lit red shoulder is bright but saturated.
    const sat = Math.max(r, g, b) - Math.min(r, g, b);

    if (lum > 195 && sat < 70) bands.white.push({ x, y });
    else if (lum > 120) bands.light.push({ x, y });
    else bands.base.push({ x, y });
  }
}

/**
 * Fit an oriented ellipse to a point cloud. Covariance eigenvectors give the
 * principal axis; two standard deviations along each covers the visible extent
 * without chasing stray antialiased pixels.
 */
function fitEllipse(points, sigma = 2) {
  const n = points.length;
  if (n < 12) return null;

  const cx = points.reduce((s, p) => s + p.x, 0) / n;
  const cy = points.reduce((s, p) => s + p.y, 0) / n;

  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const p of points) {
    const dx = p.x - cx;
    const dy = p.y - cy;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  sxx /= n;
  syy /= n;
  sxy /= n;

  const mid = (sxx + syy) / 2;
  const diff = Math.sqrt(((sxx - syy) / 2) ** 2 + sxy ** 2);
  const l1 = mid + diff;
  const l2 = Math.max(mid - diff, 1e-6);

  // Screen space is y-down, so a positive angle here reads as counterclockwise.
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy) * (180 / Math.PI);

  return {
    n,
    cx: +cx.toFixed(1),
    cy: +cy.toFixed(1),
    rx: +(sigma * Math.sqrt(l1)).toFixed(1),
    ry: +(sigma * Math.sqrt(l2)).toFixed(1),
    angle: +angle.toFixed(1),
  };
}

for (const [name, points] of Object.entries(bands)) {
  const fit = fitEllipse(points);
  console.log(
    `${name.padEnd(6)} ${String(points.length).padStart(5)} px  ` +
      (fit
        ? `cx=${fit.cx} cy=${fit.cy} rx=${fit.rx} ry=${fit.ry} angle=${fit.angle}°  ratio=${(fit.rx / fit.ry).toFixed(2)}`
        : "too few to fit"),
  );
}

// Mean colour per band, so the three-tone build uses the render's own reds.
for (const [name, points] of Object.entries(bands)) {
  if (points.length === 0) continue;
  let r = 0;
  let g = 0;
  let b = 0;
  for (const p of points) {
    const c = Jimp.intToRGBA(image.getPixelColor(p.x, p.y));
    r += c.r;
    g += c.g;
    b += c.b;
  }
  const hex = (v) => Math.round(v / points.length).toString(16).padStart(2, "0");
  console.log(`${name.padEnd(6)} mean #${hex(r)}${hex(g)}${hex(b)}`);
}
