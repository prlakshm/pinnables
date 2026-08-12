import { z } from "zod";

export const SCHEMA_VERSION = 1;

export const ViewportSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

export const PinStatusSchema = z.enum(["todo", "done", "blocked"]);

/**
 * An element pin answers "which component". A region pin answers "which area" —
 * a crowded section, a gap between two things, a frame of an animation. The
 * picker can't express any of those, which is why both kinds exist.
 */
export const PinKindSchema = z.enum(["element", "region"]);

/**
 * What a mark is pinned to.
 *
 * Marks used to live on a frozen photograph of the viewport, which made them
 * durable by making them dead — nothing could move underneath them because
 * nothing was alive. Anchoring to an element instead keeps them durable *and*
 * alive: the page can reflow, the window can resize, and a circle drawn around
 * a card stays around that card because it is measured in fractions of that
 * card, not in pixels of the page.
 *
 * `rect` is the anchor's box at the moment of drawing. It is the fallback when
 * the element can no longer be found — better to put a mark roughly where it
 * was than to lose it.
 */
export const DrawAnchorSchema = z.object({
  selector: z.string(),
  domPath: z.string(),
  rect: z.object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
  }),
});

export const DrawShapeSchema = z.object({
  id: z.string(),
  kind: z.enum(["rect", "ellipse", "arrow", "freehand"]),
  /**
   * Fractions of whatever the shape is anchored to — never page pixels.
   *
   * With an anchor, they are fractions of that element's box, which is what lets
   * a mark reflow with the page: the element moves and resizes, the mark moves
   * and resizes with it. Values outside 0–1 are fine and expected, since a
   * circle drawn *around* something extends past its edges.
   *
   * Without an anchor, they are fractions of a captured frame.
   *
   * rect / ellipse / arrow use two points; freehand uses many.
   */
  points: z.array(z.object({ x: z.number(), y: z.number() })).min(2),
  color: z.string(),
  /**
   * Null means the points are fractions of a captured frame — the old frozen
   * model, still how a composited screenshot is described. Set means they are
   * fractions of the anchor element's box, and the mark follows that element.
   */
  anchor: DrawAnchorSchema.nullable().default(null),
  /**
   * The pin whose live conversation this stroke was drawn during, or null for
   * a page-level mark. Ownership is decided at draw time — a stroke made while
   * a component is selected illustrates what is being said about it, so it
   * travels with that pin's live send and is cleared once the message goes.
   * Deciding this later, at send time, would be inference; at draw time it is
   * a fact.
   */
  ownerPinId: z.string().nullable().default(null),
});

/**
 * One message already delivered to the agent, live, outside the board submit.
 * Kept apart from `annotation` so a later "Send to agent" can tell instruction
 * from history — re-issuing a delivered message as a fresh order would make
 * the agent do the work twice.
 */
export const LiveSendSchema = z.object({
  text: z.string(),
  at: z.string(),
  /** The service's run id, for tying an outcome back to this message. */
  messageId: z.string().nullable().default(null),
  /**
   * Where the run stands. New sends are written as "starting" (or "queued"
   * when Cursor already has an active run) and promoted to "working" only
   * once the service confirms the agent is running; the default covers
   * entries from before outcomes existed, which are long finished — "done"
   * keeps them out of the waiting list.
   */
  state: z.enum(["queued", "starting", "working", "done", "failed"]).default("done"),
});

export const BoardStatusSchema = z.enum(["draft", "ready", "in-progress", "done"]);

export const PinSchema = z.object({
  id: z.string(),
  schemaVersion: z.number().int(),
  boardId: z.string(),
  kind: PinKindSchema.default("element"),
  /**
   * Marks drawn on this route. Empty for element pins.
   *
   * A route has at most one region pin, and these are its contents — drawing on
   * /dashboard adds to the /dashboard pin rather than making a new one, which is
   * why the marks are still there when you navigate back.
   */
  drawings: z.array(DrawShapeSchema).default([]),
  /** Fractional index — reordering touches one pin, not the whole list. */
  order: z.number(),
  groupId: z.string().nullable(),
  /**
   * True until the selection speaks. A click captures fully — screenshot,
   * styles, the receipt — but the pin reaches the shelf only once the user
   * commits an act: a message, a stash, a drawing, a relationship, a rename.
   * Silent provisionals are discarded on dismissal; the shelf records what
   * was said, not what was touched.
   */
  provisional: z.boolean().default(false),
  url: z.string(),
  route: z.string(),
  viewport: ViewportSchema,
  /**
   * The element's own size in CSS pixels at capture.
   *
   * Not cosmetic. Screenshots are cut at device pixels, so on a 2x display a
   * 264px element becomes a 529px PNG — and an <img> with no size renders a
   * bitmap at its pixel count, which drew every pinned card at twice the size of
   * the thing it was a picture of. This is what puts it back to life size, and
   * what lets the corner radius be scaled to match.
   */
  elementSize: z
    .object({ width: z.number(), height: z.number() })
    .default({ width: 0, height: 0 }),
  /**
   * The visible screenshot's offset and size inside `elementSize`, in CSS px.
   * Omitted by older pins whose screenshot covered the full element.
   */
  screenshotFrame: z
    .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
    .optional(),
  screenshotPath: z.string(),
  thumbnailPath: z.string(),
  selector: z.string(),
  domPath: z.string(),
  outerHtml: z.string(),
  classList: z.array(z.string()),
  elementText: z.string(),
  componentName: z.string().nullable(),
  /**
   * The best name the element could give for itself when the build gave none —
   * its `aria-label`, its heading, its landmark, and at the bottom the picker's
   * own words for it. Read `describeElement` for the ladder.
   *
   * Captured rather than derived, because the panel only ever holds the pin: by
   * the time a row needs a name the DOM it came from may be a tab away, or on a
   * site nobody has open. Null on pins written before this existed.
   */
  elementLabel: z.string().nullable().default(null),
  /**
   * What the user calls this pin. Null means "work it out from the element",
   * which is right almost always — a name only needs typing when two pins on a
   * board are the same component and the content does not tell them apart.
   */
  name: z.string().nullable().default(null),
  /** "src/components/StatCard.tsx:12" — from the dev plugin, or null. */
  sourceFile: z.string().nullable(),
  /** Allowlisted properties only. See styles.ts. */
  computedStyles: z.record(z.string(), z.string()),
  /**
   * Values the user typed over the captured ones in the inspector — the wanted
   * state, not the current one. Kept apart from `computedStyles` on purpose:
   * merging them would destroy the before/after pair, and the pair is the whole
   * instruction. An empty object means "no numbers requested, read the note."
   */
  styleEdits: z.record(z.string(), z.string()).default({}),
  annotation: z.string(),
  /** Messages already delivered live — see `LiveSendSchema`. */
  liveSends: z.array(LiveSendSchema).default([]),
  captureState: z.string(),
  status: PinStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const RelationshipSchema = z.object({
  id: z.string(),
  boardId: z.string(),
  type: z.literal("match"),
  /** One source, many targets. Deliberately not many-to-many. */
  sourcePinId: z.string(),
  targetPinIds: z.array(z.string()).min(1),
  /** Group names ("spacing") or bare CSS properties ("border-radius"). */
  properties: z.array(z.string()),
  exception: z.string(),
  instruction: z.string(),
});

export const BoardSchema = z.object({
  id: z.string(),
  schemaVersion: z.number().int(),
  projectId: z.string(),
  title: z.string(),
  globalInstruction: z.string(),
  status: BoardStatusSchema,
  generatedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  pins: z.array(PinSchema),
  relationships: z.array(RelationshipSchema),
});

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  origins: z.array(z.string()),
  repositoryPath: z.string().nullable(),
  createdAt: z.string(),
  lastOpenedAt: z.string(),
});

/** Pins carry a fractional index, so ordering is always explicit. */
export function sortedByOrder<T extends { order: number }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.order - b.order);
}

export type Viewport = z.infer<typeof ViewportSchema>;
export type PinStatus = z.infer<typeof PinStatusSchema>;
export type PinKind = z.infer<typeof PinKindSchema>;
export type DrawShape = z.infer<typeof DrawShapeSchema>;
export type LiveSend = z.infer<typeof LiveSendSchema>;
export type DrawAnchor = z.infer<typeof DrawAnchorSchema>;
export type BoardStatus = z.infer<typeof BoardStatusSchema>;
export type Pin = z.infer<typeof PinSchema>;
export type Relationship = z.infer<typeof RelationshipSchema>;
export type Board = z.infer<typeof BoardSchema>;
export type Project = z.infer<typeof ProjectSchema>;

/**
 * What to call a pin on screen.
 *
 * A name is a label the user talks in, not a fact about the code. The component
 * name is right until a board holds two of the same component — and that is
 * exactly when a relationship is most likely, because "make this StatCard match
 * that StatCard" is a sentence with no subject.
 *
 * So duplicates get a number, in the order they were pinned: StatCard 1, then
 * StatCard 2. Numbering beats describing. An earlier version built the label out
 * of the element's own text and produced "StatCard · Open issues 37", which is
 * longer than the row it sits in and changes the moment the page does.
 *
 * A typed name always wins. Nothing derived should outrank something chosen.
 *
 * Below the component name sits whatever the element could say for itself. That
 * used to be its text and nothing else, which left every icon-only component
 * anonymous — a row of logos has no text, so a pinned banner arrived on the
 * board called "element". `elementLabel` carries the full ladder, worked out at
 * capture time while the DOM was still there; `elementText` remains for pins
 * captured before it existed.
 */
export function pinLabel(pin: Pin, siblings: readonly Pin[] = []): string {
  if (pin.name?.trim()) return pin.name.trim();
  const described = pin.elementLabel?.trim() || pin.elementText.trim().slice(0, 24);
  const base = pin.componentName ?? described;
  if (!pin.componentName) return base || "element";

  const family = siblings
    .filter((p) => p.componentName === pin.componentName)
    .sort((a, b) => a.order - b.order);
  if (family.length < 2) return base;

  const index = family.findIndex((p) => p.id === pin.id);
  return index === -1 ? base : `${base} ${index + 1}`;
}
