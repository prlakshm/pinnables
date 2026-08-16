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
  /**
   * The version key this run earned when it finished — the numeral on the
   * chat row and on the rail. Null while the run is in flight, and null
   * forever for runs that failed or predate version keys.
   */
  versionNo: z.number().int().nullable().default(null),
  /**
   * The commit this message was written against — the chapter it belongs to.
   * A conversation lives from the moment it starts until the commit that
   * makes it true: rows from an earlier chapter keep their words in storage
   * but leave the box, the same way their keys stop being a way back. Null
   * on messages from before chapters existed, which always show.
   */
  head: z.string().nullable().default(null),
});

/**
 * One state of the working tree, named by a key.
 *
 * A completed run earns a number and the number is the whole interface:
 * it sits on the chat row that produced the state and on the floating rail
 * beside the component, and pressing it puts the files back. `no` is the
 * take's name, not its position — numbers climb 1..5 and then start over,
 * the newcomer evicting whoever wore that numeral before.
 */
export const PinVersionSchema = z.object({
  /** 1..5 — the key. */
  no: z.number().int(),
  /**
   * The run that made this state, and the name of its snapshot on the
   * service. Null for the original, whose snapshot is the board's baseline.
   */
  messageId: z.string().nullable(),
  /** The words that asked for it — the tooltip on the key. */
  label: z.string(),
  at: z.string(),
  /**
   * chrome.storage key of this state's picture, for the drag-out capture.
   * Taken opportunistically when the run lands while the pin is on screen;
   * null means the capture falls back to the pin's own screenshot.
   */
  screenshotKey: z.string().nullable().default(null),
  /**
   * The commit this state was snapshotted against. A patch only means
   * anything relative to the tree it was diffed from, so when HEAD moves —
   * a commit, a pull, a branch switch — the key goes quiet rather than
   * promising a restore it would butcher. Null on keys from before
   * chapters existed; they stay pressable and the service is the backstop.
   */
  head: z.string().nullable().default(null),
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
  /**
   * The states this pin's runs have produced, keyed 1..5 — see
   * `PinVersionSchema`. The original slips in as key 1 when the first run
   * in the chapter starts, so the rail can show during Working and done
   * only adds the take.
   */
  versions: z.array(PinVersionSchema).default([]),
  /**
   * Total versions ever minted for this pin, including the original. The ring
   * needs a monotonic count to know which numeral is next; the versions array
   * cannot supply it because evicted takes leave no trace there.
   */
  versionSeq: z.number().int().default(0),
  /**
   * Which key the working tree is wearing, as far as this pin knows. Null
   * until the first run in the chapter starts (original = 1). This is the
   * lit key on the rail, and the `fromMessageId` a restore reverses out of.
   */
  currentVersionNo: z.number().int().nullable().default(null),
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

/**
 * A version set down beside the live component — the drag-out comparison.
 *
 * A capture is its own surface rather than a fact about the pin: it has a
 * position, a rail, and a subset of the pin's keys. The main rail is the
 * remainder — every key lives in exactly one rail, which is what lets ⌥N
 * answer without any notion of focus.
 */
export const CaptureSchema = z.object({
  id: z.string(),
  pinId: z.string(),
  /** Version numbers this capture's rail holds. Never empty — the last key
      leaving destroys the capture. */
  keys: z.array(z.number().int()).min(1),
  /** The key this capture is showing. */
  current: z.number().int(),
  /** Viewport coordinates of the set-down card. */
  pos: z.object({ x: z.number(), y: z.number() }),
  /** The capture rail's dragged position; null while it auto-seats. */
  railPos: z.object({ x: z.number(), y: z.number() }).nullable().default(null),
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
  /** Versions set down for comparison — see `CaptureSchema`. */
  captures: z.array(CaptureSchema).default([]),
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

/** The rail never shows more than this many keys at once. */
export const VERSION_RING = 5;

/**
 * The numeral the nth take wears: 1..5 then back to 1. Assigned once, at
 * creation, and never recomputed — it is the take's name, not its position,
 * which is why the numbers can keep climbing while the rail stays five wide.
 */
export function versionKeyFor(seq: number): number {
  return ((seq - 1) % VERSION_RING) + 1;
}

/**
 * Whether a stored key still belongs to the open chapter.
 *
 * A null stamp (old data) or a null head (health not back yet) must not
 * hide keys that already exist — only a known, later chapter filters them.
 */
export function versionInChapter(
  version: { head?: string | null },
  projectHead: string | null,
): boolean {
  return version.head == null || projectHead == null || version.head === projectHead;
}

export type Viewport = z.infer<typeof ViewportSchema>;
export type PinStatus = z.infer<typeof PinStatusSchema>;
export type PinKind = z.infer<typeof PinKindSchema>;
export type DrawShape = z.infer<typeof DrawShapeSchema>;
export type LiveSend = z.infer<typeof LiveSendSchema>;
export type PinVersion = z.infer<typeof PinVersionSchema>;
export type Capture = z.infer<typeof CaptureSchema>;
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
