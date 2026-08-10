import potrace from "potrace";
import { writeFile } from "node:fs/promises";

const SRC = "brand/wordmark-source.png";
const OUT_GLOSS = "brand/wordmark.svg";
const OUT_FLAT = "brand/wordmark-flat.svg";

const INK = "#292C33";
const RED = "#ED1C24";
// Measured mean of the lit band is #E96A61, but that average includes the
// transition pixels and reads pink next to the base. Pulled back toward the
// brand red so it stays a lighter *red*, not a tint.
const LIT = "#F4564B";
const GLOSS = "#FFFFFF";

/**
 * Tittle geometry, measured off the source render by `analyse-tittle.mjs`
 * rather than eyeballed. Each region is a PCA fit over its tone band inside the
 * disc: centre from the centroid, radii from two standard deviations along the
 * eigenvectors, angle from the principal axis.
 *
 * The specular matters most. It is not an axis-aligned oval — it is a 1.7:1
 * sliver raked 38° counterclockwise, and getting that tilt wrong is the
 * difference between light sitting on a sphere and a sticker stuck to a circle.
 * Angles are in SVG's y-down space, where negative reads counterclockwise.
 */
/*
 * The disc is drawn as a true circle rather than the traced outline — the trace
 * is faithful to the render's antialiasing, which means faintly lumpy. Centre
 * and radius come from the traced bbox (x 296–353, y 58–117).
 */
const DISC = { cx: 324.5, cy: 87.5, r: 28.5 };

/*
 * Both tones are the same shape: a curved worm.
 *
 * The measurements pointed here. The specular's fitted centre sits 19.9px from
 * the disc centre, and the tangent to the circle at that point is −36.6° —
 * within a degree of its own measured −37.7° rake. A highlight lying along the
 * tangent at fixed radius *is* an arc, curving with the surface.
 *
 * A stroked arc with round caps gives the curve, the rounded ends, and the
 * concave inner dent from one primitive. Curvature is separated from position
 * so a worm can be tightly curved without being dragged toward the centre:
 * `orbit` places its midpoint, `curveRadius` sets how hard it bends.
 *
 * The shoulder is the same construction, just fatter and set further back —
 * one light source, one shape language, two scales.
 */
// The shoulder bends more gently than the specular, which is right: it sits
// further out on the ball, and concentric arcs flatten as their radius grows.
// Visible length is arc length plus the two round caps, so span and curveRadius
// have to move together to hold length constant.
const SHOULDER = { orbit: 18.5, midAngle: -126.6, curveRadius: 17, span: 60, width: 13 };
/*
 * `dx` nudges the whole worm off its polar position. The specular carries a
 * hand-set +0.407, which is a 1px shift right at the 150px review size — the
 * mark renders 61 viewBox units into 150px, so one screen pixel is 61/150 of a
 * unit. Kept as an offset rather than folded into midAngle because rotating
 * about the disc centre would swing it along an arc, not move it right.
 */
const SPECULAR = { orbit: 19.9, midAngle: -126.6, curveRadius: 7.5, span: 78, width: 5, dx: 0.407 };

function worm({ orbit, midAngle, curveRadius, span, width, dx = 0, dy = 0 }, fill) {
  const rad = (deg) => (deg * Math.PI) / 180;
  // Bow away from the disc centre, so the centre of curvature sits inboard of
  // the worm's midpoint.
  const cx = DISC.cx + (orbit - curveRadius) * Math.cos(rad(midAngle)) + dx;
  const cy = DISC.cy + (orbit - curveRadius) * Math.sin(rad(midAngle)) + dy;

  const at = (deg) => [
    (cx + curveRadius * Math.cos(rad(deg))).toFixed(2),
    (cy + curveRadius * Math.sin(rad(deg))).toFixed(2),
  ];
  const [x1, y1] = at(midAngle - span / 2);
  const [x2, y2] = at(midAngle + span / 2);
  const largeArc = span > 180 ? 1 : 0;

  // sweep=1: angle increases, which in SVG's y-down space runs clockwise.
  return (
    `<path d="M${x1} ${y1}A${curveRadius} ${curveRadius} 0 ${largeArc} 1 ${x2} ${y2}" fill="none" ` +
    `stroke="${fill}" stroke-width="${width}" stroke-linecap="round"/>`
  );
}

const svg = await new Promise((resolve, reject) => {
  potrace.trace(
    SRC,
    { threshold: 170, turdSize: 4, alphaMax: 1, optCurve: true, optTolerance: 0.18, turnPolicy: potrace.Potrace.TURNPOLICY_MINORITY },
    (err, out) => (err ? reject(err) : resolve(out)),
  );
});

const width = Number(/width="(\d+)"/.exec(svg)[1]);
const height = Number(/height="(\d+)"/.exec(svg)[1]);
const d = /<path[^>]*\sd="([^"]+)"/.exec(svg)[1];

/** Split the single traced path into its closed subpaths. */
const subpaths = d.split(/(?=M)/).map((s) => s.trim()).filter(Boolean);

function bbox(sub) {
  const nums = sub.match(/-?\d*\.?\d+/g)?.map(Number) ?? [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i + 1 < nums.length; i += 2) {
    const x = nums[i], y = nums[i + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

const measured = subpaths.map((sub) => ({ sub, box: bbox(sub) }));

/**
 * The tittle is the one subpath that is small, roughly square, and sits
 * entirely above every letter's x-height. Ascenders on b/l reach higher than
 * the dot's baseline, so height alone is not enough — require squareness too.
 */
const dotIndex = measured
  .map((m, i) => ({ i, ...m.box }))
  .filter((m) => m.w > 8 && m.h > 8 && Math.abs(m.w / m.h - 1) < 0.35)
  .sort((a, b) => a.w * a.h - b.w * b.h)[0]?.i;

/**
 * The source dot is a rendered glossy sphere, so it traces with a specular
 * highlight nested inside it. Anything falling entirely within the tittle's
 * bounds is that highlight — kept for the glossy variant, dropped for the flat
 * one.
 */
const dotBox = dotIndex === undefined ? null : measured[dotIndex].box;
const isGloss = (m, i) =>
  dotBox !== null &&
  i !== dotIndex &&
  m.box.minX >= dotBox.minX &&
  m.box.maxX <= dotBox.maxX &&
  m.box.minY >= dotBox.minY &&
  m.box.maxY <= dotBox.maxY;

console.log(`traced ${subpaths.length} subpaths from ${width}×${height}`);
measured.forEach((m, i) => {
  const tag = i === dotIndex ? "  ← tittle" : isGloss(m, i) ? "  ← specular highlight" : "";
  console.log(
    `  [${String(i).padStart(2)}] x ${m.box.minX.toFixed(0).padStart(5)}–${m.box.maxX.toFixed(0).padStart(5)}  ` +
      `y ${m.box.minY.toFixed(0).padStart(4)}–${m.box.maxY.toFixed(0).padStart(4)}  ` +
      `${m.box.w.toFixed(0)}×${m.box.h.toFixed(0)}${tag}`,
  );
});

const letters = measured
  .filter((m, i) => i !== dotIndex && !isGloss(m, i))
  .map((m) => m.sub)
  .join(" ");
const dot = dotIndex === undefined ? "" : measured[dotIndex].sub;

// The traced highlight blob is discarded entirely — the threshold captures the
// whole bright *region* with an antialiasing tail, not the hot spot. Geometry
// comes from the PCA fit above instead.

const head = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" fill="none">`;

/**
 * Flat — two tones. Base red plus the specular, no lit shoulder.
 *
 * For small sizes: the shoulder is a soft tonal step that needs enough pixels
 * to read as shading, whereas the hard-edged specular still resolves at a few
 * pixels across.
 */
const disc = `<circle cx="${DISC.cx}" cy="${DISC.cy}" r="${DISC.r}"`;

const flat = `${head}
  <path d="${letters}" fill="${INK}" fill-rule="evenodd"/>
  ${disc} fill="${RED}"/>
  ${worm(SPECULAR, GLOSS)}
</svg>
`;

/**
 * Three tones, no gradient: base red, a lit shoulder toward the upper left, and
 * the true-white specular on top.
 *
 * Flat bands rather than a radial gradient — three hard steps read as a sphere
 * just as well at this scale, survive being rasterised by anything, and keep
 * the mark consistent with a flat interface. The shoulder is clipped to the
 * disc so it can be drawn as a plain ellipse and still terminate on the edge.
 */
const glossy = `${head}
  <defs>
    <clipPath id="pin-disc">
      ${disc}/>
    </clipPath>
  </defs>
  <path d="${letters}" fill="${INK}" fill-rule="evenodd"/>
  ${disc} fill="${RED}"/>
  <g clip-path="url(#pin-disc)">
    ${worm(SHOULDER, LIT)}
  </g>
  ${worm(SPECULAR, GLOSS)}
</svg>
`;

await writeFile(OUT_GLOSS, glossy, "utf8");
await writeFile(OUT_FLAT, flat, "utf8");
console.log(`\nwrote ${OUT_GLOSS} — ${(glossy.length / 1024).toFixed(1)} kB  (highlight + sphere shading)`);
console.log(`wrote ${OUT_FLAT}  — ${(flat.length / 1024).toFixed(1)} kB  (highlight, solid red body)`);
