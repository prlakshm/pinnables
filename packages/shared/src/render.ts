import type { Board, Pin } from "./schema.js";
import { computeStyleDiff, formatStyles } from "./styles.js";
import { describeDrawings } from "./drawings.js";

/**
 * The compact manifest — what `get_board` returns and what `brief.md`
 * contains. Deliberately terse: a 20-pin board must stay under ~5k tokens so
 * the agent can hold the whole board and still have room to work. Full styles,
 * markup, and DOM context live behind `get_pin_context`.
 */
export function renderBoardManifest(board: Board): string {
  const lines: string[] = [];
  const pins = [...board.pins].sort((a, b) => a.order - b.order);

  lines.push(`# Board: ${board.title}`);
  lines.push(
    `${pins.length} pins · ${new Set(pins.map((p) => p.route)).size} routes · status: ${board.status}`,
  );

  if (board.globalInstruction.trim()) {
    lines.push("", `**Applies to every pin:** ${board.globalInstruction}`);
  }

  lines.push("", "## Pins", "");
  for (const pin of pins) {
    lines.push(`### ${pin.id} — ${describePin(pin)}  [${pin.status}]`);
    lines.push(
      `route \`${pin.route}\` · ${pin.viewport.width}×${pin.viewport.height}` +
        (pin.captureState && pin.captureState !== "default" ? ` · state: ${pin.captureState}` : ""),
    );
    if (pin.kind === "region") {
      // A region pin has no element identity by construction — it marks an
      // area, so the screenshot is the specification and the agent has to look.
      lines.push(`region · ${describeDrawings(pin.drawings) || "no marks"} · see screenshot`);
    } else {
      lines.push(pin.sourceFile ? `source \`${pin.sourceFile}\`` : "source unresolved");
    }
    lines.push(`> ${pin.annotation}`);
    lines.push("");
  }

  if (board.relationships.length > 0) {
    lines.push("## Relationships", "");
    for (const rel of board.relationships) {
      lines.push(renderRelationship(board, rel.id));
      lines.push("");
    }
  }

  lines.push(
    "---",
    `Call \`get_pin_context\` with a pin id for full styles, markup, DOM path, and screenshot path.`,
  );
  return lines.join("\n");
}

/**
 * A relationship rendered as an instruction the agent can act on — including
 * the computed before → after values, which is the whole point. "Make A match
 * B" is something the agent has to interpret; three concrete value changes are
 * something it can apply.
 */
export function renderRelationship(board: Board, relationshipId: string): string {
  const rel = board.relationships.find((r) => r.id === relationshipId);
  if (!rel) return `Relationship ${relationshipId} not found.`;

  const byId = new Map(board.pins.map((p) => [p.id, p]));
  const source = byId.get(rel.sourcePinId);
  if (!source) return `Relationship ${rel.id}: source pin ${rel.sourcePinId} is missing.`;

  const lines: string[] = [];
  lines.push(`### ${rel.id} — ${rel.type}`);
  lines.push(`source \`${rel.sourcePinId}\` ${describePin(source)}${sourceSuffix(source)}`);

  for (const targetId of rel.targetPinIds) {
    const target = byId.get(targetId);
    if (!target) {
      lines.push(`target \`${targetId}\` — pin missing from board`);
      continue;
    }
    lines.push(`target \`${targetId}\` ${describePin(target)}${sourceSuffix(target)}`);

    const diff = computeStyleDiff(source, target, rel.properties);
    if (diff.length === 0) {
      lines.push("  (no differences across the selected properties)");
      continue;
    }
    const width = Math.max(...diff.map((d) => d.property.length));
    for (const entry of diff) {
      lines.push(`  ${entry.property.padEnd(width)}  ${entry.from}  →  ${entry.to}`);
    }
  }

  if (rel.exception.trim()) lines.push(`except: ${rel.exception}`);
  if (rel.instruction.trim()) lines.push(`> ${rel.instruction}`);
  return lines.join("\n");
}

/**
 * Everything about one pin. Fetched on demand so the manifest stays small —
 * the agent asks for this only for pins it is actually about to edit.
 */
export function renderPinContext(
  board: Board,
  pin: Pin,
  /**
   * Absolute path to the pin's screenshot. Resolving it needs the filesystem,
   * which the extension bundle can't import — so callers that have a disk pass
   * it in and everyone else falls back to the stored relative path.
   */
  screenshotPath: string = pin.screenshotPath,
): string {
  const lines: string[] = [];

  lines.push(`# ${pin.id} — ${describePin(pin)}`);
  lines.push("");
  lines.push(`status      ${pin.status}`);
  lines.push(`url         ${pin.url}`);
  lines.push(`route       ${pin.route}`);
  lines.push(`viewport    ${pin.viewport.width}×${pin.viewport.height}`);
  lines.push(`state       ${pin.captureState}`);
  if (pin.kind === "region") {
    lines.push(`marks       ${describeDrawings(pin.drawings) || "none"}`);
    lines.push(`screenshot  ${screenshotPath}`);
    lines.push("");
    lines.push(`## Instruction`);
    lines.push(pin.annotation);
    lines.push("");
    lines.push(
      "This pin marks an *area*, not a component — it has no selector or source file. " +
        "The annotated screenshot is the specification; open it to see what was circled.",
    );
  } else {
    lines.push(`source      ${pin.sourceFile ?? "unresolved"}`);
    lines.push(`component   ${pin.componentName ?? "unknown"}`);
    lines.push(`selector    ${pin.selector}`);
    lines.push(`dom path    ${pin.domPath}`);
    lines.push(`screenshot  ${screenshotPath}`);
    lines.push("");
    lines.push(`## Instruction`);
    lines.push(pin.annotation);
    lines.push("");
    lines.push(`## Captured styles`);
    lines.push(formatStyles(pin.computedStyles));
    lines.push("");
    lines.push(`## Markup`);
    lines.push("```html");
    lines.push(pin.outerHtml);
    lines.push("```");
  }

  const related = board.relationships.filter(
    (r) => r.sourcePinId === pin.id || r.targetPinIds.includes(pin.id),
  );
  if (related.length > 0) {
    lines.push("", `## Relationships involving this pin`, "");
    for (const rel of related) lines.push(renderRelationship(board, rel.id), "");
  }

  return lines.join("\n");
}

function describePin(pin: Pin): string {
  if (pin.kind === "region") return pin.elementText.trim() || "marked region";
  const label = pin.componentName ?? pin.elementText.trim().slice(0, 40);
  return label || pin.selector;
}

function sourceSuffix(pin: Pin): string {
  return pin.sourceFile ? ` \`${pin.sourceFile}\`` : "";
}
