# Selection Chrome Placement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One pure module places the annotation box and version rail around a selection so they never overlap the element or each other, with element-relative manual dragging for both.

**Architecture:** A new pure geometry module (`chrome-placement.ts`) owns the box ladder (below → above → docked, plus moved), orientation-aware rail rings with guaranteed seats, occupancy rejection, seam scoot, and hysteresis. `Overlay` measures the real box and rail, calls the module once per measure pass, and hands positions down; `SelectionDialog` and `VersionLayer` become consumers. Manual positions become element-relative offsets for both pieces.

**Tech Stack:** TypeScript, React 19, Chrome MV3 content script, node:test via tsx, esbuild harness for real-browser verification.

**Spec:** `docs/superpowers/specs/2026-08-14-selection-chrome-placement-design.md` — read it before starting any task.

## Global Constraints

- `mocks/toggle-redesign.html` is untouchable.
- Test runner: `npm test` from repo root runs `tests/*.test.ts tests/*.test.tsx` via tsx. Single file: `npx tsx --tsconfig packages/extension/tsconfig.json --test tests/<file>`.
- Typecheck gates: `npx tsc --noEmit -p packages/extension/tsconfig.json` and `npx tsc --noEmit -p packages/service/tsconfig.json`.
- Gutters and gaps (exact values, from the spec and shipped code): viewport gutter for box `12`, for rail `4`; box–element gap `12`; rail–element gap `10`; slot padding `8`; hysteresis tolerance `16`; `COMPOSER_WIDTH = 380` (import, do not redefine).
- The repo's working tree carries finished, uncommitted version-keys work in the same files this plan modifies. **Task 0 commits that work first** so task commits stay clean.
- Commit messages follow repo style (`Feat:`, `Fix:`, `Docs:`, `Test:` prefixes) and end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- No `data-*` or copy changes beyond what tasks state; meta-chips stay lowercase; UI copy never uses em dashes.

---

### Task 0: Commit the pending version-keys work

**Files:**
- Modify: none (git only)

**Interfaces:**
- Consumes: the existing working tree (222 tests green).
- Produces: a clean baseline so later task commits contain only placement work.

- [ ] **Step 1: Verify the tree is green before freezing it**

Run: `npm test 2>&1 | grep -E "ℹ tests|ℹ pass|ℹ fail"`
Expected: `tests 222 / pass 222 / fail 0`

- [ ] **Step 2: Commit everything outstanding except demos and scratch**

```bash
git add packages tests docs mocks/toggle-redesign.html
git commit -m "Feat: version keys, chapters, cross-board inheritance

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

(`demos/*.mov` and generated mp4s stay untracked on purpose.)

- [ ] **Step 3: Confirm only demos remain untracked**

Run: `git status --short | grep -v "^??"`
Expected: empty output.

---

### Task 1: Box ladder in the pure module

**Files:**
- Create: `packages/extension/src/content/chrome-placement.ts`
- Test: `tests/chrome-placement.test.ts`

**Interfaces:**
- Consumes: `COMPOSER_WIDTH` from `./overlay-geometry`.
- Produces (later tasks rely on these exact names):

```ts
export interface Box { x: number; y: number; width: number; height: number }
export interface Size { width: number; height: number }
export interface Offset { x: number; y: number }
export type BoxSeat = "below" | "above" | "docked" | "moved";
export type RailSeat =
  | "card-right" | "below" | "card-left" | "slot"
  | "top-right" | "top-left" | "box-side"
  | "moved";
export interface ChromeInput {
  element: Box;
  labelAbove: number;
  labelBelow: number;
  loneLeft: number | null;
  box: Size;
  rail: Size | null;
  manualBox: Offset | null;
  manualRail: Offset | null;
  preferred: { box: BoxSeat | null; rail: RailSeat | null };
  viewport: Size;
}
export interface ChromePlacement {
  box: { x: number; y: number; width: number; seat: BoxSeat };
  rail: { x: number; y: number; seat: RailSeat } | null;
  scoot: number;
}
export function placeSelectionChrome(input: ChromeInput): ChromePlacement;
export function intersects(a: Box, b: Box): boolean;
```

- [ ] **Step 1: Write the failing tests for the ladder**

Create `tests/chrome-placement.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import {
  placeSelectionChrome,
  type ChromeInput,
} from "../packages/extension/src/content/chrome-placement";

const VIEWPORT = { width: 1280, height: 800 };

function input(overrides: Partial<ChromeInput> = {}): ChromeInput {
  return {
    element: { x: 400, y: 200, width: 240, height: 160 },
    labelAbove: 48,
    labelBelow: 0,
    loneLeft: 400,
    box: { width: 380, height: 120 },
    rail: null,
    manualBox: null,
    manualRail: null,
    preferred: { box: null, rail: null },
    viewport: VIEWPORT,
    ...overrides,
  };
}

test("below: box sits 12px under the element, lone selections left-aligned", () => {
  const p = placeSelectionChrome(input());
  assert.equal(p.box.seat, "below");
  assert.equal(p.box.y, 200 + 160 + 0 + 12);
  assert.equal(p.box.x, 400);
  assert.equal(p.box.width, 380);
});

test("below honours the flipped-label allowance", () => {
  const p = placeSelectionChrome(input({ labelAbove: 0, labelBelow: 42 }));
  assert.equal(p.box.y, 200 + 160 + 42 + 12);
});

test("group selections center the box on the element span", () => {
  const p = placeSelectionChrome(input({ loneLeft: null }));
  assert.equal(p.box.x, Math.round(400 + 240 / 2 - 380 / 2));
});

test("above: bottom-anchored 12px over the element, clearing the label", () => {
  const element = { x: 400, y: 620, width: 240, height: 160 };
  const p = placeSelectionChrome(input({ element }));
  assert.equal(p.box.seat, "above");
  assert.equal(p.box.y + 120, 620 - 12 - 48, "bottom edge anchored");
});

test("above: growth shifts the top up, the anchor holds", () => {
  const element = { x: 400, y: 620, width: 240, height: 160 };
  const small = placeSelectionChrome(input({ element, box: { width: 380, height: 120 } }));
  const tall = placeSelectionChrome(input({ element, box: { width: 380, height: 200 } }));
  assert.equal(small.box.y + 120, tall.box.y + 200, "same bottom edge");
});

test("docked: element taller than the viewport pins the box to the bottom edge", () => {
  const element = { x: 100, y: -50, width: 1000, height: 900 };
  const p = placeSelectionChrome(input({ element, loneLeft: 100 }));
  assert.equal(p.box.seat, "docked");
  assert.equal(p.box.y + 120, VIEWPORT.height - 12);
});

test("moved: a manual box is an element-relative offset, clamped only", () => {
  const p = placeSelectionChrome(input({ manualBox: { x: -20, y: 300 } }));
  assert.equal(p.box.seat, "moved");
  assert.equal(p.box.x, 400 - 20);
  assert.equal(p.box.y, 200 + 300);
  const clamped = placeSelectionChrome(input({ manualBox: { x: 5000, y: 5000 } }));
  assert.ok(clamped.box.x + 380 <= VIEWPORT.width - 12);
  assert.ok(clamped.box.y + 120 <= VIEWPORT.height - 12);
});

test("hysteresis: a preferred seat survives while legal within 16px", () => {
  /* below legality boundary: element.bottom + 12 + 120 = 788 → height 456 */
  const element = { x: 400, y: 200, width: 240, height: 456 };
  const first = placeSelectionChrome(input({ element }));
  assert.equal(first.box.seat, "below");
  const nudged = { ...element, height: 466 };
  const kept = placeSelectionChrome(
    input({ element: nudged, preferred: { box: "below", rail: null } }),
  );
  assert.equal(kept.box.seat, "below", "10px past legal is inside tolerance");
  const far = { ...element, height: 560 };
  const flipped = placeSelectionChrome(
    input({ element: far, preferred: { box: "below", rail: null } }),
  );
  assert.equal(flipped.box.seat, "above", "past tolerance the ladder runs");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx --tsconfig packages/extension/tsconfig.json --test tests/chrome-placement.test.ts`
Expected: FAIL — cannot find module `chrome-placement`.

- [ ] **Step 3: Implement the ladder**

Create `packages/extension/src/content/chrome-placement.ts`:

```ts
import { COMPOSER_WIDTH } from "./overlay-geometry";

/**
 * Every piece of selection chrome, seated by one function.
 *
 * The box ladder is below, above, docked; the rail rings around whichever
 * orientation the box took. Reserved seats are shared knowledge: the box
 * makes room the rail can count on, which is why this is one module and not
 * two solvers agreeing by luck.
 */

export interface Box { x: number; y: number; width: number; height: number }
export interface Size { width: number; height: number }
export interface Offset { x: number; y: number }

export type BoxSeat = "below" | "above" | "docked" | "moved";
export type RailSeat =
  | "card-right" | "below" | "card-left" | "slot"
  | "top-right" | "top-left" | "box-side"
  | "moved";

export interface ChromeInput {
  element: Box;
  /** Height reserved above the element by the floating label (0 when the
      label is flipped below). */
  labelAbove: number;
  /** Allowance under the element when the label is flipped below. */
  labelBelow: number;
  /** Single selection: left-align the box to this x. Null = center. */
  loneLeft: number | null;
  box: Size;
  rail: Size | null;
  manualBox: Offset | null;
  manualRail: Offset | null;
  preferred: { box: BoxSeat | null; rail: RailSeat | null };
  viewport: Size;
}

export interface ChromePlacement {
  box: { x: number; y: number; width: number; seat: BoxSeat };
  rail: { x: number; y: number; seat: RailSeat } | null;
  scoot: number;
}

const BOX_GUTTER = 12;
const RAIL_GUTTER = 4;
const BOX_GAP = 12;
const RAIL_GAP = 10;
const SLOT_PAD = 8;
const TOLERANCE = 16;

export function intersects(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function clamp(value: number, lo: number, hi: number): number {
  if (hi < lo) return lo;
  return Math.min(hi, Math.max(lo, value));
}

function boxX(input: ChromeInput, width: number): number {
  const { element, loneLeft, viewport } = input;
  const centered = Math.round(element.x + element.width / 2 - width / 2);
  const x = loneLeft !== null ? loneLeft : centered;
  return clamp(x, BOX_GUTTER, viewport.width - BOX_GUTTER - width);
}

function placeBox(input: ChromeInput): { x: number; y: number; width: number; seat: BoxSeat } {
  const { element, viewport, box, labelAbove, labelBelow, manualBox, preferred } = input;
  const width = Math.max(0, Math.min(COMPOSER_WIDTH, viewport.width - BOX_GUTTER * 2));

  if (manualBox) {
    return {
      x: clamp(element.x + manualBox.x, BOX_GUTTER, viewport.width - BOX_GUTTER - width),
      y: clamp(element.y + manualBox.y, BOX_GUTTER, viewport.height - BOX_GUTTER - box.height),
      width,
      seat: "moved",
    };
  }

  const belowY = element.y + element.height + labelBelow + BOX_GAP;
  const aboveY = element.y - BOX_GAP - labelAbove - box.height;
  const legal: Record<"below" | "above", (slack: number) => boolean> = {
    below: (slack) => belowY + box.height <= viewport.height - BOX_GUTTER + slack,
    above: (slack) => aboveY >= BOX_GUTTER - slack,
  };
  const position: Record<"below" | "above" | "docked", number> = {
    below: belowY,
    above: aboveY,
    docked: viewport.height - BOX_GUTTER - box.height,
  };

  /* Seats are sticky: the current one survives while tolerably legal. */
  const kept =
    preferred.box === "below" || preferred.box === "above"
      ? legal[preferred.box](TOLERANCE)
        ? preferred.box
        : null
      : null;
  const seat: BoxSeat =
    kept ?? (legal.below(0) ? "below" : legal.above(0) ? "above" : "docked");
  return { x: boxX(input, width), y: position[seat], width, seat };
}

export function placeSelectionChrome(input: ChromeInput): ChromePlacement {
  const box = placeBox(input);
  return { box, rail: null, scoot: 0 };
}
```

- [ ] **Step 4: Run to verify the ladder tests pass**

Run: `npx tsx --tsconfig packages/extension/tsconfig.json --test tests/chrome-placement.test.ts`
Expected: all Task 1 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/content/chrome-placement.ts tests/chrome-placement.test.ts
git commit -m "Feat: box ladder in chrome-placement module

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Rail rings, guaranteed seats, seam scoot

**Files:**
- Modify: `packages/extension/src/content/chrome-placement.ts`
- Test: `tests/chrome-placement.test.ts` (append)

**Interfaces:**
- Consumes: Task 1's types and `placeBox` internals.
- Produces: `placeSelectionChrome` now fills `rail` and `scoot`. Orientation rule later tasks rely on: box seat `below`/`moved-below-ish` → ring `card-right, below, card-left, slot`; box seat `above`/`docked` → ring `top-right, top-left, box-side`.

- [ ] **Step 1: Append failing rail tests**

```ts
test("rail ring below: card-right bottom-aligned beside the element", () => {
  const p = placeSelectionChrome(input({ rail: { width: 140, height: 27 } }));
  assert.ok(p.rail);
  assert.equal(p.rail!.seat, "card-right");
  assert.equal(p.rail!.x, 400 + 240 + 10);
  assert.equal(p.rail!.y, 200 + 160 - 27);
  assert.equal(p.scoot, 0);
});

test("rail ring above: top-right beside the element, top-aligned", () => {
  const element = { x: 400, y: 620, width: 240, height: 160 };
  const p = placeSelectionChrome(input({ element, rail: { width: 140, height: 27 } }));
  assert.equal(p.box.seat, "above");
  assert.equal(p.rail!.seat, "top-right");
  assert.equal(p.rail!.x, 400 + 240 + 10);
  assert.equal(p.rail!.y, 620);
});

test("slot: nothing fits around a low full-width element in below orientation", () => {
  /* Full width kills card-right/left; y=430 puts the below seat past the
     fold (box bottom 762 + 10 + 27 > 796) while the box itself still fits. */
  const element = { x: 0, y: 430, width: 1280, height: 200 };
  const p = placeSelectionChrome(input({ element, loneLeft: 0, rail: { width: 140, height: 27 } }));
  assert.equal(p.box.seat, "below");
  assert.equal(p.rail!.seat, "slot");
  assert.equal(p.rail!.y, 430 + 200 + 8, "rail tucked just under the element");
  assert.equal(p.rail!.x, p.box.x + p.box.width - 140, "right-aligned to the box");
  assert.equal(p.scoot, 27 + 16, "box steps down by the shipped ceiling");
});

test("box-side: full-width element at the bottom edge, rail beside the box", () => {
  const element = { x: 0, y: 700, width: 1280, height: 100 };
  const p = placeSelectionChrome(input({ element, loneLeft: 0, rail: { width: 140, height: 27 } }));
  assert.equal(p.box.seat, "above");
  assert.equal(p.rail!.seat, "box-side");
  assert.equal(p.rail!.y, p.box.y + 120 - 27, "flush with the anchored bottom edge");
  assert.ok(
    p.rail!.x === p.box.x + p.box.width + 8 || p.rail!.x === p.box.x - 8 - 140,
    "beside the box, right first then left",
  );
  assert.equal(p.scoot, 0);
});

test("box-side stays put while the box grows", () => {
  const element = { x: 0, y: 700, width: 1280, height: 100 };
  const short = placeSelectionChrome(
    input({ element, loneLeft: 0, rail: { width: 140, height: 27 }, box: { width: 380, height: 120 } }),
  );
  const tall = placeSelectionChrome(
    input({ element, loneLeft: 0, rail: { width: 140, height: 27 }, box: { width: 380, height: 200 } }),
  );
  assert.equal(short.rail!.y, tall.rail!.y, "anchored edge, growth is upward");
});

test("a manual rail is an element-relative offset and drives the seam scoot", () => {
  const p = placeSelectionChrome(
    input({ rail: { width: 140, height: 27 }, manualRail: { x: 60, y: 172 } }),
  );
  assert.equal(p.rail!.seat, "moved");
  assert.equal(p.rail!.x, 460);
  assert.equal(p.rail!.y, 372, "12px past the element bottom");
  assert.ok(p.scoot > 0, "the box steps down for a rail on its doorstep");
  assert.ok(p.scoot <= 27 + 16, "never past the ceiling");
});

test("occupancy: a rail candidate never intersects the placed box", () => {
  const element = { x: 900, y: 200, width: 240, height: 160 };
  const p = placeSelectionChrome(
    input({ element, loneLeft: 900, rail: { width: 140, height: 27 } }),
  );
  assert.ok(p.rail);
  const railBox = { x: p.rail!.x, y: p.rail!.y, width: 140, height: 27 };
  const boxBox = { x: p.box.x, y: p.box.y + p.scoot, width: p.box.width, height: 120 };
  assert.equal(intersects(railBox, boxBox), false);
});
```

Also add `intersects` to the import at the top of the test file.

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx tsx --tsconfig packages/extension/tsconfig.json --test tests/chrome-placement.test.ts`
Expected: Task 1 tests PASS, Task 2 tests FAIL (`p.rail` is null).

- [ ] **Step 3: Implement rails**

Replace `placeSelectionChrome` in `chrome-placement.ts` and add the helpers:

```ts
type Orientation = "below" | "above";

function orientationOf(seat: BoxSeat, element: Box, boxY: number): Orientation {
  if (seat === "below") return "below";
  if (seat === "above" || seat === "docked") return "above";
  /* moved: whichever side of the element the box actually sits on */
  return boxY >= element.y + element.height / 2 ? "below" : "above";
}

interface RailCandidate { seat: RailSeat; x: number; y: number }

function railCandidates(
  orientation: Orientation,
  input: ChromeInput,
  boxRect: Box,
  rail: Size,
): RailCandidate[] {
  const { element } = input;
  if (orientation === "below") {
    return [
      { seat: "card-right", x: element.x + element.width + RAIL_GAP, y: element.y + element.height - rail.height },
      { seat: "below", x: element.x + element.width - rail.width, y: boxRect.y + boxRect.height + RAIL_GAP },
      { seat: "card-left", x: element.x - RAIL_GAP - rail.width, y: element.y + element.height - rail.height },
    ];
  }
  return [
    { seat: "top-right", x: element.x + element.width + RAIL_GAP, y: element.y },
    { seat: "top-left", x: element.x - RAIL_GAP - rail.width, y: element.y },
  ];
}

function legalRail(c: RailCandidate, rail: Size, input: ChromeInput, boxRect: Box, slack = 0): boolean {
  const { viewport, element } = input;
  const r: Box = { x: c.x, y: c.y, width: rail.width, height: rail.height };
  const inViewport =
    r.x >= RAIL_GUTTER - slack &&
    r.y >= RAIL_GUTTER - slack &&
    r.x + r.width <= viewport.width - RAIL_GUTTER + slack &&
    r.y + r.height <= viewport.height - RAIL_GUTTER + slack;
  return inViewport && !intersects(r, boxRect) && !intersects(r, element);
}

/**
 * The seam formula, shared by the reserved slot and a hand-dragged rail:
 * how far the box steps away so the rail can sit against the element's
 * box-facing edge. Positive pushes a below-box down; negative lifts an
 * above-box up. The ceiling is the shipped `8 + rail + 8`.
 */
function seamScoot(railRect: Box, element: Box, noteRect: Box, orientation: Orientation): number {
  const ceiling = SLOT_PAD + railRect.height + SLOT_PAD;
  const across = railRect.x < noteRect.x + noteRect.width && railRect.x + railRect.width > noteRect.x;
  if (!across) return 0;
  if (orientation === "below") {
    const hangs = railRect.y + railRect.height - (element.y + element.height);
    if (hangs <= 0) return 0;
    const above = Math.max(0, railRect.y - (element.y + element.height));
    return Math.min(ceiling, Math.max(SLOT_PAD, hangs + above));
  }
  const rises = element.y - railRect.y;
  if (rises <= 0) return 0;
  const gap = Math.max(0, element.y - (railRect.y + railRect.height));
  return -Math.min(ceiling, Math.max(SLOT_PAD, rises + gap));
}

export function placeSelectionChrome(input: ChromeInput): ChromePlacement {
  const box = placeBox(input);
  const { rail, element, viewport, manualRail, preferred } = input;
  if (!rail) return { box, rail: null, scoot: 0 };

  const boxRect: Box = { x: box.x, y: box.y, width: box.width, height: input.box.height };
  const orientation = orientationOf(box.seat, element, box.y);

  if (manualRail) {
    const x = clamp(element.x + manualRail.x, RAIL_GUTTER, viewport.width - RAIL_GUTTER - rail.width);
    const y = clamp(element.y + manualRail.y, RAIL_GUTTER, viewport.height - RAIL_GUTTER - rail.height);
    const scoot = seamScoot({ x, y, width: rail.width, height: rail.height }, element, boxRect, orientation);
    return { box, rail: { x, y, seat: "moved" }, scoot };
  }

  const ring = railCandidates(orientation, input, boxRect, rail);
  const kept = ring.find((c) => c.seat === preferred.rail && legalRail(c, rail, input, boxRect, TOLERANCE));
  const chosen = kept ?? ring.find((c) => legalRail(c, rail, input, boxRect));
  if (chosen) return { box, rail: { x: chosen.x, y: chosen.y, seat: chosen.seat }, scoot: 0 };

  /* Guaranteed seats. Below orientation: the slot the box opens above
     itself (the shipped scoot ceiling). Above orientation: beside the box,
     flush with its anchored bottom edge, right side first. */
  if (orientation === "below") {
    const scoot = SLOT_PAD + rail.height + SLOT_PAD;
    return {
      box,
      rail: {
        x: clamp(box.x + box.width - rail.width, RAIL_GUTTER, viewport.width - RAIL_GUTTER - rail.width),
        y: element.y + element.height + SLOT_PAD,
        seat: "slot",
      },
      scoot,
    };
  }
  /* Beside the box, right side first, flush with the anchored bottom edge.
     Narrow viewports can fit neither side of a 380px box; the guarantee
     outranks the side preference, so the rail then rides the box's outer
     top edge instead — still seat "box-side", still growth-immune because
     it re-derives from the box rect placement returns. */
  const rightX = box.x + box.width + SLOT_PAD;
  const leftX = box.x - SLOT_PAD - rail.width;
  const flushY = box.y + input.box.height - rail.height;
  if (rightX + rail.width <= viewport.width - RAIL_GUTTER) {
    return { box, rail: { x: rightX, y: flushY, seat: "box-side" }, scoot: 0 };
  }
  if (leftX >= RAIL_GUTTER) {
    return { box, rail: { x: leftX, y: flushY, seat: "box-side" }, scoot: 0 };
  }
  return {
    box,
    rail: {
      x: clamp(box.x + box.width - rail.width, RAIL_GUTTER, viewport.width - RAIL_GUTTER - rail.width),
      y: Math.max(RAIL_GUTTER, box.y - SLOT_PAD - rail.height),
      seat: "box-side",
    },
    scoot: 0,
  };
}
```

Delete the Task 1 placeholder `placeSelectionChrome` (this replaces it).

- [ ] **Step 4: Run the whole file**

Run: `npx tsx --tsconfig packages/extension/tsconfig.json --test tests/chrome-placement.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/content/chrome-placement.ts tests/chrome-placement.test.ts
git commit -m "Feat: rail rings, guaranteed seats, seam scoot

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Invariant sweep and the footer regression

**Files:**
- Test: `tests/chrome-placement.test.ts` (append)

**Interfaces:**
- Consumes: `placeSelectionChrome`, `intersects` from Tasks 1–2.
- Produces: the safety net every later wiring change runs against.

- [ ] **Step 1: Append the sweep**

```ts
test("invariant sweep: no auto seat ever overlaps, everything stays on screen", () => {
  const viewports = [
    { width: 1280, height: 800 },
    { width: 900, height: 600 },
    { width: 420, height: 700 },
  ];
  const railSize = { width: 140, height: 27 };
  for (const viewport of viewports) {
    for (let ex = -100; ex <= viewport.width; ex += 120) {
      for (let ey = -100; ey <= viewport.height; ey += 120) {
        for (const size of [
          { width: 240, height: 160 },
          { width: viewport.width, height: 120 },
          { width: 300, height: viewport.height + 200 },
        ]) {
          const element = { x: ex, y: ey, ...size };
          const p = placeSelectionChrome({
            element,
            labelAbove: 48,
            labelBelow: 0,
            loneLeft: ex,
            box: { width: 380, height: 150 },
            rail: railSize,
            manualBox: null,
            manualRail: null,
            preferred: { box: null, rail: null },
            viewport,
          });
          const label = `element ${ex},${ey} ${size.width}x${size.height} in ${viewport.width}x${viewport.height}`;
          const boxRect = { x: p.box.x, y: p.box.y + Math.max(0, p.scoot), width: p.box.width, height: 150 };
          assert.ok(p.rail, `rail exists — ${label}`);
          const railRect = { x: p.rail!.x, y: p.rail!.y, width: railSize.width, height: railSize.height };
          if (p.box.seat !== "docked") {
            assert.equal(intersects(boxRect, element), false, `box clear of element — ${label}`);
          }
          assert.equal(intersects(railRect, boxRect), false, `rail clear of box — ${label}`);
          if (p.rail!.seat !== "slot") {
            assert.equal(intersects(railRect, element), false, `rail clear of element — ${label}`);
          }
          assert.ok(p.box.x >= 12 && p.box.x + p.box.width <= viewport.width - 12, `box inside gutters — ${label}`);
          assert.ok(railRect.x >= 4 && railRect.x + railRect.width <= viewport.width - 4, `rail inside gutters — ${label}`);
        }
      }
    }
  }
});

test("regression: the film-set footer at the bottom edge", () => {
  const viewport = { width: 1440, height: 900 };
  const footer = { x: 0, y: 830, width: 1440, height: 120 };
  const p = placeSelectionChrome({
    element: footer,
    labelAbove: 48,
    labelBelow: 0,
    loneLeft: 0,
    box: { width: 380, height: 180 },
    rail: { width: 100, height: 27 },
    manualBox: null,
    manualRail: null,
    preferred: { box: null, rail: null },
    viewport,
  });
  assert.equal(p.box.seat, "above", "box flips over the footer");
  assert.equal(p.rail!.seat, "box-side", "full width leaves only the box's side");
  assert.equal(p.rail!.y, p.box.y + 180 - 27, "flush with the anchored edge");
});
```

Note: the slot seat intentionally sits inside the element's strip below its
bottom edge — that is the seam the box vacated — so the element-overlap
invariant exempts `slot` exactly as the spec's invariant table says `moved`
is exempt.

- [ ] **Step 2: Run and fix until green**

Run: `npx tsx --tsconfig packages/extension/tsconfig.json --test tests/chrome-placement.test.ts`
Expected: PASS. If the sweep finds a hole (it exists to), fix the module — never weaken an assertion. Typical first failures: clamp order in guaranteed seats; tolerate them by fixing clamps, not tests.

- [ ] **Step 3: Commit**

```bash
git add tests/chrome-placement.test.ts packages/extension/src/content/chrome-placement.ts
git commit -m "Test: placement invariant sweep and footer regression

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Schema — `boxPos` beside `railPos`, both element-relative

**Files:**
- Modify: `packages/shared/src/schema.ts` (PinSchema, next to `railPos`)
- Modify: `packages/extension/src/lib/messages.ts` (pin/update patch allowlist)
- Modify: `packages/extension/src/background/index.ts` (two pin construction sites)
- Modify: `tests/version-keys.test.ts`, `tests/version-chapters.test.ts`, `tests/version-ui.test.tsx` (pin fixtures gain the field)

**Interfaces:**
- Produces: `PinSchema.boxPos: {x,y} | null` (element-relative offset), `railPos` redocumented as element-relative. `pin/update` accepts `boxPos` in its patch.

- [ ] **Step 1: Schema field**

In `packages/shared/src/schema.ts`, replace the `railPos` block inside `PinSchema` with:

```ts
  /**
   * Where the user parked the rail — an offset from the element's top-left,
   * so the arrangement travels with the component through scroll and
   * reflow. Null until dragged; after that it is the only thing that
   * decides where the rail sits. (Values written before 2026-08-14 were
   * viewport coordinates; they are reinterpreted as offsets and heal on the
   * next drag.)
   */
  railPos: z.object({ x: z.number(), y: z.number() }).nullable().default(null),
  /**
   * Where the user parked the annotation box, same offset rule as railPos.
   * The box drags by its body (no grip); a dragged box is manual forever.
   */
  boxPos: z.object({ x: z.number(), y: z.number() }).nullable().default(null),
```

- [ ] **Step 2: Allowlist + construction sites**

In `packages/extension/src/lib/messages.ts`, the pin/update patch type gains `"boxPos"`:

```ts
      patch: Partial<
        Pick<Pin, "annotation" | "status" | "order" | "groupId" | "styleEdits" | "name" | "railPos" | "boxPos">
      >;
```

In `packages/extension/src/background/index.ts`, both pin literals (element capture and region capture) gain `boxPos: null,` directly after `railPos: null,`.

- [ ] **Step 3: Rebuild shared, fix fixture fallout**

Run: `npm run build --workspace @pinnables/shared && npx tsc --noEmit -p packages/extension/tsconfig.json`
Expected: errors in the three test files' `pinWith` fixtures. Add `boxPos: null,` after `railPos: null,` in each.

- [ ] **Step 4: Full suite**

Run: `npm test 2>&1 | grep -E "ℹ tests|ℹ pass|ℹ fail"`
Expected: all pass (223+ after Task 3).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/schema.ts packages/extension/src/lib/messages.ts packages/extension/src/background/index.ts tests/version-keys.test.ts tests/version-chapters.test.ts tests/version-ui.test.tsx
git commit -m "Feat: element-relative boxPos and railPos on pins

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Overlay wires the module; the dialog consumes it

**Files:**
- Modify: `packages/extension/src/content/Overlay.tsx`
- Modify: `packages/extension/src/content/SelectionDialog.tsx`

**Interfaces:**
- Consumes: `placeSelectionChrome`, `ChromePlacement`, `Offset` (Task 1–2); `pin.boxPos`/`pin.railPos` (Task 4).
- Produces for Task 6: Overlay state `chrome: ChromePlacement | null`; `SelectionDialog` props gain `onRootEl?: (el: HTMLDivElement | null) => void` and `onBodyPointerDown?: (e: React.PointerEvent) => void`. The old `dialogPlacement` IIFE is deleted; `placeGroupComposer` remains only for the card-group composer (`groupBox`).

- [ ] **Step 1: Measure the box and rail in Overlay**

In `OverlayRoot`, next to the existing version state, add:

```ts
  /** Live measurements of the chrome, fed to the placement module. */
  const dialogEl = useRef<HTMLDivElement | null>(null);
  const [boxSize, setBoxSize] = useState<{ width: number; height: number } | null>(null);
  const [railSize, setRailSize] = useState<{ width: number; height: number } | null>(null);
  const [preferredSeats, setPreferredSeats] = useState<{
    box: BoxSeat | null;
    rail: RailSeat | null;
  }>({ box: null, rail: null });
  /** Transient viewport position while the user drags the box. */
  const [boxDragPos, setBoxDragPos] = useState<{ x: number; y: number } | null>(null);

  const onDialogRootEl = useCallback((el: HTMLDivElement | null) => {
    dialogEl.current = el;
    if (!el) {
      setBoxSize(null);
      return;
    }
    const measure = () =>
      setBoxSize((prev) => {
        const next = { width: el.offsetWidth, height: el.offsetHeight };
        return prev && prev.width === next.width && prev.height === next.height ? prev : next;
      });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    (el as HTMLDivElement & { __pinRo?: ResizeObserver }).__pinRo?.disconnect();
    (el as HTMLDivElement & { __pinRo?: ResizeObserver }).__pinRo = ro;
  }, []);
```

Import `placeSelectionChrome` plus the types at the top:

```ts
import {
  placeSelectionChrome,
  type BoxSeat,
  type ChromePlacement,
  type RailSeat,
} from "./chrome-placement";
```

- [ ] **Step 2: Replace `dialogPlacement` with the module call**

Delete the whole `const dialogPlacement = (() => { ... })()` IIFE and put in its place:

```ts
  /*
   * One placement call seats the box and the rail together. The old
   * per-piece solvers are gone: the module owns the ladder, the rings, the
   * reserved seats, and the promise that nothing it places overlaps.
   */
  const chrome: ChromePlacement | null = (() => {
    if (drawing || liveSelectedPins.length === 0) return null;
    const entries = liveSelected
      .map((pinId, index) => ({ rect: liveRects[pinId]?.rect, full: index === 0 }))
      .filter((entry): entry is { rect: DOMRect; full: boolean } => entry.rect !== undefined);
    if (entries.length === 0) return null;
    const rects = entries.map((entry) => entry.rect);
    const left = Math.min(...rects.map((rect) => rect.left));
    const right = Math.max(...rects.map((rect) => rect.right));
    const top = Math.min(...rects.map((rect) => rect.top));
    const bottom = Math.max(...rects.map((rect) => rect.bottom));
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const flipped = entries.filter(
      (entry) => entry.rect.top < 60 && entry.rect.bottom >= bottom - 1,
    );
    const labelBelow =
      flipped.length === 0 ? 0 : Math.max(...flipped.map((entry) => (entry.full ? 42 : 26)));
    const labelAbove = flipped.length === 0 ? 48 : 0;
    const primary = liveSelectedPins[0];
    const measuredBox = boxSize ?? { width: 380, height: 96 };
    const dragOffset = boxDragPos
      ? { x: boxDragPos.x - left, y: boxDragPos.y - top }
      : null;
    return placeSelectionChrome({
      element: { x: left, y: top, width: right - left, height: bottom - top },
      labelAbove,
      labelBelow,
      loneLeft: rects.length === 1 ? rects[0].left : null,
      box: measuredBox,
      rail: railSize,
      manualBox: dragOffset ?? primary.boxPos ?? null,
      manualRail: primary.railPos ?? null,
      preferred: preferredSeats,
      viewport,
    });
  })();

  useEffect(() => {
    if (!chrome) return;
    setPreferredSeats((prev) =>
      prev.box === chrome.box.seat && prev.rail === (chrome.rail?.seat ?? null)
        ? prev
        : { box: chrome.box.seat, rail: chrome.rail?.seat ?? null },
    );
  }, [chrome?.box.seat, chrome?.rail?.seat]);
```

- [ ] **Step 3: Pass it to the dialog**

Replace the `dialogPlacement && board && ...` render condition and props:

```tsx
      {chrome && board && liveSelectedPins.length > 0 && (
        <SelectionDialog
          pins={liveSelectedPins}
          board={board}
          position={{ x: chrome.box.x, y: chrome.box.y, width: chrome.box.width }}
          scoot={chrome.scoot}
          onRootEl={onDialogRootEl}
          onBodyPointerDown={beginBoxDrag}
          versionBusy={versionBusy}
          onVersionBusy={setVersionBusy}
          projectHead={projectHead}
```

then the remaining existing props (`targetOf`, `relationshipId`, `drawingSummary`, `onLiveSent`, `onAddToBoard`, `onRelate`, `onDismiss`) stay exactly as they are today — reproduce them verbatim from the current call site.

(`beginBoxDrag` arrives in Task 7 — until then pass `undefined`; the prop is optional.) Delete `setRailScoot` usage from this path only if unused after Task 6; `railScoot` state is replaced by `chrome.scoot` — remove the `railScoot` state and the `scoot={railScoot}` wiring, using `chrome.scoot` directly.

- [ ] **Step 4: Dialog accepts the ref and body-drag hooks**

In `SelectionDialogProps` add:

```ts
  /** Reports the root element so the overlay can measure the box. */
  onRootEl?: (el: HTMLDivElement | null) => void;
  /** Body pointerdown that did not hit an interactive child — a drag. */
  onBodyPointerDown?: (event: React.PointerEvent) => void;
```

On the root div:

```tsx
    <div
      ref={(el) => {
        rootRef.current = el;
        onRootEl?.(el);
      }}
      className="pin-note pin-note--floating pin-live-note"
      style={{ left: position.x, top: position.y, width: position.width, marginTop: scoot }}
      data-no-drag
      onPointerDown={(event) => {
        const target = event.target as Element;
        if (target.closest("textarea, button, a, .pin-key, .pin-kbd")) return;
        onBodyPointerDown?.(event);
      }}
    >
```

- [ ] **Step 5: Typecheck, full suite**

Run: `npx tsc --noEmit -p packages/extension/tsconfig.json && npm test 2>&1 | grep -E "ℹ pass|ℹ fail"`
Expected: types clean; suite green (the SSR dialog tests pass — new props optional).

- [ ] **Step 6: Commit**

```bash
git add packages/extension/src/content/Overlay.tsx packages/extension/src/content/SelectionDialog.tsx
git commit -m "Feat: overlay seats the box through chrome-placement

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: VersionLayer consumes its seat; drags store offsets

**Files:**
- Modify: `packages/extension/src/content/VersionRail.tsx`
- Modify: `packages/extension/src/content/Overlay.tsx` (props at the VersionLayer call site)
- Modify: `tests/version-ui.test.tsx` (layer render helpers)

**Interfaces:**
- Consumes: `chrome` from Task 5; `Box`, `intersects` from the module.
- Produces: `VersionLayerProps` changes — removes `scoot`, `onScoot` stays (live-drag transient), adds:

```ts
  /** The main rail's seat, computed by the placement module. Null hides it. */
  mainRail: { x: number; y: number; seat: RailSeat } | null;
  /** The box's rect, for capture-rail occupancy and drag seam math. */
  boxRect: Box | null;
  /** Reports the rail's rendered size so placement can seat it. */
  onRailSize: (size: { width: number; height: number } | null) => void;
```

- [ ] **Step 1: Main rail renders where it is told**

In `VersionRail.tsx`:
- Delete the `mainSeat` state and the whole main-rail `useLayoutEffect` seating block (the one calling `seatRail` + `composerScoot` + `onScoot`), and the `scoot` prop.
- Render the main rail at the prop:

```tsx
      {showMain && mainRail && (
        <div
          ref={mainRailRef}
          className="pin-versions"
          data-rail="main"
          data-armed={armed ? "true" : "false"}
          data-busy={busy ? "true" : "false"}
          data-placed={mainRail.seat}
          role="group"
          aria-label="Versions"
          style={{ left: mainRail.x, top: mainRail.y }}
        >
```

- Report size (place after `mainRailRef` definition):

```ts
  useLayoutEffect(() => {
    const el = mainRailRef.current;
    if (!showMain || !el) {
      onRailSize(null);
      return;
    }
    onRailSize({ width: el.offsetWidth || 140, height: el.offsetHeight || 27 });
  }, [showMain, mainKeys.length, enteringNo, onRailSize]);
```

- `showMain` drops its `liveRect !== null` requirement only if `mainRail` is present; keep `visible && versionsOk && versions.length >= 2`.

- [ ] **Step 2: Rail drag persists an offset; live drag keeps the transient scoot**

In `railDown`'s `finish` for `railId === "main"`, replace the persist:

```ts
        if (railId === "main") {
          setRailDragPos(null);
          if (d.at && liveRect) {
            void send("pin/update", {
              pinId: pin.id,
              patch: { railPos: { x: d.at.x - liveRect.x, y: d.at.y - liveRect.y } },
            }).catch(() => {});
          }
        }
```

During `move`, keep writing `railEl.style.left/top` directly and keep calling the existing live seam callback: replace the old `clearComposer`-style call with `onScoot(seamScootLive(...))` — import `composerScoot` is already exported from this file; the live transient path keeps using it against `boxRect`:

```ts
        if (railId === "main" && boxRect && liveRect) {
          onScoot(
            composerScoot(
              { x: d.at.x, y: d.at.y, width: railEl.offsetWidth, height: railEl.offsetHeight },
              { x: liveRect.x, y: liveRect.y, width: liveRect.width, height: liveRect.height },
              boxRect,
            ),
          );
        }
```

On `finish`, call `onScoot(0)` so the module's resting scoot takes over.

- [ ] **Step 3: Captures gain occupancy**

`seatRail` signature gains an optional last parameter:

```ts
export function seatRail(
  rail: { width: number; height: number },
  card: RailBox,
  foot: RailBox | null,
  manual: { x: number; y: number } | null,
  viewport: { width: number; height: number },
  occupied: RailBox[] = [],
): { x: number; y: number; placed: string } {
```

Replace the whole `fits` function inside `seatRail` with:

```ts
  const fits = (where: string) => {
    const s = spots[where];
    const rect = { x: s.x, y: s.y, width: w, height: h };
    const clear = occupied.every(
      (zone) =>
        !(
          rect.x < zone.x + zone.width &&
          rect.x + rect.width > zone.x &&
          rect.y < zone.y + zone.height &&
          rect.y + rect.height > zone.y
        ),
    );
    return clear && s.x > 4 && s.x + w < vw - 4 && s.y > 4 && s.y + h < vh - 4;
  };
```

`CaptureCard` passes `occupied`: the box rect and the main rail rect (new prop `occupied: RailBox[]` threaded from `VersionLayer`, built as `[boxRect, mainRailRect].filter(Boolean)`).

- [ ] **Step 4: Overlay call site**

```tsx
        <VersionLayer
          board={board}
          pin={liveSelectedPins[0]}
          liveRect={liveRects[liveSelectedPins[0].id]?.rect ?? null}
          visible={true}
          versionsOk={versionsOk}
          projectHead={projectHead}
          busy={versionBusy}
          onBusy={setVersionBusy}
          mainRail={chrome?.rail ?? null}
          boxRect={
            chrome && boxSize
              ? { x: chrome.box.x, y: chrome.box.y + Math.max(0, chrome.scoot), width: chrome.box.width, height: boxSize.height }
              : null
          }
          onRailSize={setRailSize}
          onScoot={setLiveScoot}
        />
```

`liveScoot` is a new state declared beside `versionBusy` in `OverlayRoot`:

```ts
  /** Seam scoot while a rail drag is live; the module's value takes over at rest. */
  const [liveScoot, setLiveScoot] = useState(0);
```

and the dialog's `scoot` prop becomes `liveScoot !== 0 ? liveScoot : chrome.scoot` (live drag wins while it runs).

- [ ] **Step 5: Update SSR tests**

In `tests/version-ui.test.tsx`, `renderLayer`/`renderLayerWithHead` drop `scoot`, gain:

```tsx
      mainRail={{ x: 450, y: 280, seat: "card-right" }}
      boxRect={{ x: 100, y: 400, width: 380, height: 120 }}
      onRailSize={() => {}}
```

- [ ] **Step 6: Typecheck + suite + build**

Run: `npx tsc --noEmit -p packages/extension/tsconfig.json && npm test 2>&1 | grep -E "ℹ pass|ℹ fail" && npm run build 2>&1 | tail -1`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add packages/extension/src/content/VersionRail.tsx packages/extension/src/content/Overlay.tsx tests/version-ui.test.tsx
git commit -m "Feat: rail seats from placement, drags store offsets

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: The box drags by its body

**Files:**
- Modify: `packages/extension/src/content/Overlay.tsx` (`beginBoxDrag`)
- Modify: `packages/extension/src/ui/ui.css`

**Interfaces:**
- Consumes: `onBodyPointerDown` prop (Task 5), `boxDragPos` state (Task 5), `pin/update` with `boxPos` (Task 4).
- Produces: the finished drag behaviour; nothing later depends on it.

- [ ] **Step 1: The drag handler**

In `OverlayRoot`, after the chrome placement block:

```ts
  /*
   * The box drags by its body — no grip, same discovery as pin cards and
   * the floating label. What a drag stores is an offset from the element,
   * so the arrangement travels with the component. pointercancel abandons:
   * an interrupted drag must never half-move the thing you type into.
   */
  const beginBoxDrag = useCallback(
    (event: React.PointerEvent) => {
      if (!chrome || event.button !== 0) return;
      const primary = liveSelectedPins[0];
      if (!primary) return;
      const start = { x: event.clientX, y: event.clientY };
      const origin = { x: chrome.box.x, y: chrome.box.y };
      let moved = false;
      const move = (ev: PointerEvent) => {
        if (!moved && Math.abs(ev.clientX - start.x) < 5 && Math.abs(ev.clientY - start.y) < 5) return;
        moved = true;
        setBoxDragPos({ x: origin.x + (ev.clientX - start.x), y: origin.y + (ev.clientY - start.y) });
      };
      const done = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", cancel);
      };
      const up = (ev: PointerEvent) => {
        done();
        if (!moved) return;
        const rect = liveRects[primary.id]?.rect;
        setBoxDragPos(null);
        if (!rect) return;
        const pos = { x: origin.x + (ev.clientX - start.x), y: origin.y + (ev.clientY - start.y) };
        void send("pin/update", {
          pinId: primary.id,
          patch: { boxPos: { x: pos.x - rect.left, y: pos.y - rect.top } },
        }).catch(() => {});
      };
      const cancel = () => {
        done();
        setBoxDragPos(null);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", cancel);
    },
    [chrome, liveSelectedPins, liveRects],
  );
```

Wire `onBodyPointerDown={beginBoxDrag}` at the dialog call site (replacing the Task 5 `undefined`).

- [ ] **Step 2: Cursor affordance**

Append to `ui.css` (children keep their own cursors — textarea text, buttons pointer):

```css
/* The box is grabbable by its body, like pin cards and the floating label.
   No grip icon: the cursor is the whole announcement. */
.pin-live-note { cursor: grab; }
```

- [ ] **Step 3: Typecheck + tokens + suite**

Run: `npx tsc --noEmit -p packages/extension/tsconfig.json && node scripts/check-tokens.mjs && npm test 2>&1 | grep -E "ℹ pass|ℹ fail"`
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add packages/extension/src/content/Overlay.tsx packages/extension/src/ui/ui.css
git commit -m "Feat: annotation box drags by its body

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Real-browser verification on the harness and the accession page

**Files:**
- Modify: scratchpad harness (`/private/tmp/claude-501/-Users-pranavi-Documents-GitHub-pinnables/29c9b636-4e06-4ab8-82f7-297fb8b744e5/scratchpad/harness/harness.tsx` — rebuild with `node build.mjs`; if the scratchpad is gone, recreate from Task 8 notes in the session or re-derive: esbuild bundle of VersionLayer + SelectionDialog + chrome stub, alias `@ext` → `packages/extension/src`, `nodePaths` → repo `node_modules`)

**Interfaces:**
- Consumes: everything.
- Produces: screenshots and DOM probes proving the spec's scenarios.

- [ ] **Step 1: Update the harness for the new props**

The harness `Harness` component mirrors Task 5–6 wiring: it computes `placeSelectionChrome` the same way Overlay does (import from `@ext/content/chrome-placement`), passes `position`/`scoot`/`onRootEl`/`onBodyPointerDown` to the dialog and `mainRail`/`boxRect`/`onRailSize` to the layer. The fake background's `pin/update` handler logs `pin:railPos`/`pin:boxPos` with the offsets.

- [ ] **Step 2: Drive the four scenarios**

Serve the harness (`node serve.mjs`, port 4644), open in the Browser pane, and verify by DOM probe + screenshot:

1. Element mid-page → box `below`, rail `card-right` (the classic).
2. Element pinned to the bottom edge (`.variety` at `top: calc(100vh - 120px)`) → box `above` with fixed 12px gap, rail `top-right`; add history rows via the fixture and confirm the box top rises while the gap holds.
3. Full-width footer strip → rail `box-side`, flush with the box's bottom edge; grow history, rail does not move.
4. Drag the box body 100px → `pin:boxPos` logged with element-relative offset; drag near the element seam with the rail manual → scoot animates; scroll the page (`window.scrollTo`) → dragged pieces keep their offsets to the element.

- [ ] **Step 3: The accession page footer — the original bug**

Inject the harness bundle into `fixtures/film-set/index.html` (the `accession.html` pattern), select the footer wordmark strip, and screenshot: box above the footer, rail beside the box, nothing overlapping. This is the screenshot that started this spec — keep it as proof.

- [ ] **Step 4: Full gates**

Run: `npm test 2>&1 | grep -E "ℹ tests|ℹ pass|ℹ fail" && npx tsc --noEmit -p packages/extension/tsconfig.json && npx tsc --noEmit -p packages/service/tsconfig.json && npm run build 2>&1 | tail -1`
Expected: everything green.

- [ ] **Step 5: Commit any harness-driven fixes**

```bash
git add -A packages tests
git commit -m "Fix: placement fixes from browser verification

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

(Skip if the harness surfaced nothing — do not create an empty commit.)
