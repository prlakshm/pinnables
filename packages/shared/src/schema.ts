import { z } from "zod";

export const SCHEMA_VERSION = 1;

export const ViewportSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

export const PinStatusSchema = z.enum(["todo", "done", "blocked"]);

export const BoardStatusSchema = z.enum(["draft", "ready", "in-progress", "done"]);

export const PinSchema = z.object({
  id: z.string(),
  schemaVersion: z.number().int(),
  boardId: z.string(),
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

export type Viewport = z.infer<typeof ViewportSchema>;
export type PinStatus = z.infer<typeof PinStatusSchema>;
export type BoardStatus = z.infer<typeof BoardStatusSchema>;
export type Pin = z.infer<typeof PinSchema>;
export type Relationship = z.infer<typeof RelationshipSchema>;
export type Board = z.infer<typeof BoardSchema>;
export type Project = z.infer<typeof ProjectSchema>;
