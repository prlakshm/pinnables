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

export const DrawShapeSchema = z.object({
  id: z.string(),
  kind: z.enum(["rect", "ellipse", "arrow", "freehand"]),
  /**
   * Normalised 0–1 against the frozen frame, never page pixels. The frame is
   * immutable once captured, so a drawing can never drift the way a
   * coordinate-anchored overlay on a live page would — and it stays correct at
   * whatever size the image is later displayed.
   *
   * rect / ellipse / arrow use two points; freehand uses many.
   */
  points: z.array(z.object({ x: z.number(), y: z.number() })).min(2),
  color: z.string(),
});

export const BoardStatusSchema = z.enum(["draft", "ready", "in-progress", "done"]);

export const PinSchema = z.object({
  id: z.string(),
  schemaVersion: z.number().int(),
  boardId: z.string(),
  kind: PinKindSchema.default("element"),
  /** Annotations drawn over the frozen frame. Empty for element pins. */
  drawings: z.array(DrawShapeSchema).default([]),
  /** Fractional index — reordering touches one pin, not the whole list. */
  order: z.number(),
  groupId: z.string().nullable(),
  url: z.string(),
  route: z.string(),
  viewport: ViewportSchema,
  screenshotPath: z.string(),
  thumbnailPath: z.string(),
  selector: z.string(),
  domPath: z.string(),
  outerHtml: z.string(),
  classList: z.array(z.string()),
  elementText: z.string(),
  componentName: z.string().nullable(),
  /** "src/components/StatCard.tsx:12" — from the dev plugin, or null. */
  sourceFile: z.string().nullable(),
  /** Allowlisted properties only. See styles.ts. */
  computedStyles: z.record(z.string(), z.string()),
  annotation: z.string(),
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
export type BoardStatus = z.infer<typeof BoardStatusSchema>;
export type Pin = z.infer<typeof PinSchema>;
export type Relationship = z.infer<typeof RelationshipSchema>;
export type Board = z.infer<typeof BoardSchema>;
export type Project = z.infer<typeof ProjectSchema>;
