import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { Board, Pin, Relationship } from "@pinnables/shared";
import { describeChange } from "../packages/shared/src/perception.ts";
import { ChangePair } from "../packages/extension/src/sidepanel/ChangePreview.tsx";
import { PinList } from "../packages/extension/src/sidepanel/PinList.tsx";
import { Relationships } from "../packages/extension/src/sidepanel/Relationships.tsx";

const root = new URL("../", import.meta.url);
const source = (path: string) => readFileSync(new URL(path, root), "utf8");

function elementPin(
  id: string,
  name: string,
  order: number,
  computedStyles: Record<string, string>,
): Pin {
  return {
    id,
    schemaVersion: 1,
    boardId: "board-1",
    kind: "element",
    drawings: [],
    order,
    groupId: null,
    url: "http://localhost:5180/#/dashboard",
    route: "/dashboard",
    viewport: { width: 1280, height: 800 },
    elementSize: { width: 232, height: 98 },
    screenshotPath: `pins/${id}.png`,
    thumbnailPath: `pins/${id}.thumb.webp`,
    selector: `[data-pin="${id}"]`,
    domPath: `body > [data-pin="${id}"]`,
    outerHtml: `<div data-pin="${id}">${name}</div>`,
    classList: ["card"],
    elementText: name,
    componentName: "StatCard",
    name,
    sourceFile: "fixtures/demo-app/index.html:1",
    computedStyles,
    styleEdits: {},
    annotation: "",
    liveSends: [],
    captureState: "default",
    status: "todo",
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
  };
}

const sourcePin = elementPin("pin-source", "Revenue", 1, {
  "border-radius": "12px",
  "box-shadow": "rgba(0, 0, 0, 0.12) 0px 4px 12px 0px",
});
const targetA = elementPin("pin-target-a", "Open issues", 2, {
  "border-radius": "4px",
  "box-shadow": "none",
});
const targetB = elementPin("pin-target-b", "Integrations", 3, {
  "border-radius": "6px",
  "box-shadow": "none",
});

function board(relationship?: Relationship, pins: Pin[] = [sourcePin, targetA, targetB]): Board {
  return {
    id: "board-1",
    schemaVersion: 1,
    projectId: "local",
    title: "Dashboard review",
    globalInstruction: "",
    status: "draft",
    generatedAt: null,
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
    pins,
    relationships: relationship ? [relationship] : [],
  };
}

const relationship: Relationship = {
  id: "rel-1",
  boardId: "board-1",
  type: "match",
  sourcePinId: sourcePin.id,
  targetPinIds: [targetA.id, targetB.id],
  properties: ["border-radius", "box-shadow"],
  exception: "",
  instruction: "",
};

test("pin rows expand from the row itself and summon from the trailing slot", () => {
  const html = renderToStaticMarkup(
    <PinList board={board(undefined, [sourcePin])} onChanged={() => {}} />,
  );

  // The wide row target carries expansion, keyboard included.
  assert.match(html, /<div class="pin-row__hit"[^>]*role="button"/);
  assert.match(html, /<div class="pin-row__hit"[^>]*tabindex="0"/);
  assert.match(html, /<div class="pin-row__hit"[^>]*aria-expanded="false"/);
  assert.match(html, /aria-controls="pin-details-pin-source"/);
  assert.doesNotMatch(html, /<button class="pin-row__hit"/);
  // The trailing slot puts the capture on the page — no chevron.
  assert.match(html, /aria-label="Show Revenue on the page"/);
  assert.doesNotMatch(html, /pin-row__chevron/);
});

test("relationship group toggles expose pressed state without a check glyph", () => {
  const html = renderToStaticMarkup(<Relationships board={board(relationship)} onChanged={() => {}} />);
  const radius = [...html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].find(
    (match) => match[2].replace(/<[^>]+>/g, "").trim() === "radius",
  );

  assert.ok(radius, "radius group button should render");
  assert.match(radius[1], /aria-pressed="true"/);
  // The black fill already names the selected state; the checkmark was noise.
  assert.doesNotMatch(radius[2], /<svg/);

  const css = source("packages/extension/src/ui/ui.css");
  assert.match(css, /\.pin-group-grid\s*\{[\s\S]*grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\)/);
});

test("partially selected relationship groups expose a mixed neutral state", () => {
  const spacingSource = elementPin("pin-spacing-source", "Source", 1, {
    "padding-top": "16px",
    "padding-right": "16px",
    "padding-bottom": "16px",
    "padding-left": "16px",
  });
  const spacingTarget = elementPin("pin-spacing-target", "Target", 2, {
    "padding-top": "8px",
    "padding-right": "8px",
    "padding-bottom": "8px",
    "padding-left": "8px",
  });
  const partial: Relationship = {
    ...relationship,
    sourcePinId: spacingSource.id,
    targetPinIds: [spacingTarget.id],
    properties: ["padding-top"],
  };
  const html = renderToStaticMarkup(
    <Relationships board={board(partial, [spacingSource, spacingTarget])} onChanged={() => {}} />,
  );
  const spacing = [...html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].find(
    (match) => match[2].replace(/<[^>]+>/g, "").trim() === "spacing",
  );

  assert.ok(spacing, "spacing group button should render");
  assert.match(spacing[1], /aria-pressed="mixed"/);
  assert.match(spacing[1], /data-partial="true"/);
  assert.doesNotMatch(spacing[2], /<svg/);

  const css = source("packages/extension/src/ui/ui.css");
  assert.match(css, /\.pin-chip\[data-partial="true"\][\s\S]*var\(--pin-paper-sunk\)/);
  assert.match(
    css,
    /button\.pin-chip:not\(:disabled\):not\(\[data-on="true"\]\):not\(\[data-partial="true"\]\):hover/,
  );
});

test("multi-target diffs keep repeated properties inside named target sections", () => {
  const html = renderToStaticMarkup(<Relationships board={board(relationship)} onChanged={() => {}} />);
  const sections = [...html.matchAll(/<section class="pin-change-group"[\s\S]*?<\/section>/g)].map(
    (match) => match[0],
  );

  assert.equal(sections.length, 2);
  assert.match(sections[0], /Open issues/);
  assert.match(sections[1], /Integrations/);
  for (const section of sections) {
    assert.equal((section.match(/>border-radius<\/span>/g) ?? []).length, 1);
    assert.equal((section.match(/>box-shadow<\/span>/g) ?? []).length, 1);
  }
});

test("none-to-shadow changes retain a concise positional summary", () => {
  const detail = describeChange({
    property: "box-shadow",
    from: "none",
    to: "rgba(0, 0, 0, 0.12) 0px 4px 12px 0px",
  });

  assert.equal(detail.summary, "y 0→4px · blur 0→12px");
});

test("shadow preview frames allow the rendered shadow to escape their bounds", () => {
  const detail = describeChange({
    property: "box-shadow",
    from: "none",
    to: "rgba(0, 0, 0, 0.12) 0px 4px 12px 0px",
  });
  const html = renderToStaticMarkup(<ChangePair detail={detail} />);

  assert.match(html, /overflow:visible/);
  assert.match(html, /box-shadow:rgba\(0, 0, 0, 0\.12\) 0px 4px 12px 0px/);
});

test("relationship lists containing shadow rows do not clip the preview", () => {
  const html = renderToStaticMarkup(
    <Relationships board={board(relationship)} onChanged={() => {}} />,
  );
  const css = source("packages/extension/src/ui/ui.css");

  assert.match(html, /class="pin-changes"[^>]*data-has-shadow="true"/);
  assert.match(html, /class="pin-change pin-change--stacked pin-change--shadow"/);
  assert.match(css, /\.pin-changes\[data-has-shadow="true"\]\s*\{[^}]*overflow:\s*visible/);
});

test("inapplicable differences are present but quiet — never amber, never silent", () => {
  const blockedSource = elementPin("pin-blocked-source", "Borderless source", 1, {
    "border-width": "0px",
    "border-style": "none",
    "border-color": "rgb(28, 30, 34)",
  });
  const blockedTarget = elementPin("pin-blocked-target", "Borderless target", 2, {
    "border-width": "0px",
    "border-style": "none",
    "border-color": "rgb(230, 228, 224)",
  });
  const blockedRelationship: Relationship = {
    ...relationship,
    sourcePinId: blockedSource.id,
    targetPinIds: [blockedTarget.id],
    properties: [],
  };
  const html = renderToStaticMarkup(
    <Relationships
      board={board(blockedRelationship, [blockedSource, blockedTarget])}
      onChanged={() => {}}
    />,
  );

  // The difference is listed with its reason — hiding it let a visible
  // difference read as "already matches" — but it offers no checkbox.
  assert.match(html, /pin-change--blocked/);
  assert.match(html, /border-color/);
  assert.match(html, /can(&#x27;|')t apply/);
  const blockedRow = html.slice(html.indexOf("pin-change--blocked"), html.indexOf("can"));
  assert.doesNotMatch(blockedRow, /checkbox/);

  // Quiet ink, not amber: a fact about the source, not a warning to the user.
  const css = source("packages/extension/src/ui/ui.css");
  const ruleStart = css.indexOf(".pin-change--blocked {");
  const rule = css.slice(ruleStart, css.indexOf(".pin-section-label", ruleStart));
  assert.doesNotMatch(rule, /amber/);
  assert.match(rule, /var\(--pin-ink-faint\)/);
});

test("pin and relationship trash controls share the danger modifier", () => {
  const pins = renderToStaticMarkup(
    <PinList board={board(undefined, [sourcePin])} onChanged={() => {}} />,
  );
  const relationships = renderToStaticMarkup(
    <Relationships board={board(relationship)} onChanged={() => {}} />,
  );

  assert.match(
    pins,
    /class="pin-icon-btn pin-icon-btn--danger"[^>]*aria-label="Delete Revenue"/,
  );
  assert.match(
    relationships,
    /class="pin-icon-btn pin-icon-btn--danger"[^>]*aria-label="Delete relationship"/,
  );

  const css = source("packages/extension/src/ui/ui.css");
  // Trash hovers gray like every other icon button — no red pre-warning.
  const dangerStart = css.indexOf(".pin-icon-btn--danger:is(:hover, :focus-visible)");
  const danger = css.slice(dangerStart, css.indexOf("}", dangerStart) + 1);
  assert.match(danger, /var\(--pin-paper-sunk\)/);
  assert.doesNotMatch(danger, /var\(--pin-red/);
});

test("bulk clear uses the same danger semantics only on hover or keyboard focus", () => {
  const css = source("packages/extension/src/ui/ui.css");
  const idleStart = css.indexOf(".pin-tab-action {");
  const idle = css.slice(idleStart, css.indexOf("}", idleStart) + 1);

  assert.doesNotMatch(idle, /var\(--pin-red/);
  assert.match(
    css,
    /\.pin-tab-action:is\(:hover, :focus-visible\)[\s\S]*background:\s*var\(--pin-red-tint\)[\s\S]*color:\s*var\(--pin-red\)/,
  );
});

test("non-styleable region targets do not advertise a pick action", () => {
  const pinList = source("packages/extension/src/sidepanel/PinList.tsx");

  assert.match(
    pinList,
    /isSource\s*\?\s*\([\s\S]*?\)\s*:\s*!selectable\s*\?\s*\([\s\S]*?aria-disabled="true"[\s\S]*?no styles/,
  );
});

test("region reveal names the marks it navigates to", () => {
  const pinList = source("packages/extension/src/sidepanel/PinList.tsx");

  assert.match(pinList, /pin\.kind === "region" \? "Go to marks" : "Go to pin"/);
});

test("rapid relationship toggles compose from the immediately previous selection", async () => {
  const module = (await import(
    "../packages/extension/src/sidepanel/Relationships.tsx"
  )) as unknown as Record<string, unknown>;
  assert.equal(typeof module.applySelectionToggle, "function");
  const applySelectionToggle = module.applySelectionToggle as (
    selected: ReadonlySet<string>,
    properties: readonly string[],
    on: boolean,
  ) => Set<string>;
  let selected = new Set<string>();
  selected = applySelectionToggle(selected, ["padding-top", "padding-right"], true);
  selected = applySelectionToggle(selected, ["border-radius"], true);

  assert.deepEqual([...selected], ["padding-top", "padding-right", "border-radius"]);

  const relationships = source("packages/extension/src/sidepanel/Relationships.tsx");
  assert.match(relationships, /selectionRef\.current/);
  assert.match(relationships, /writeQueue\.current/);
});

test("diff rows expose exact values even when their visible cells truncate", () => {
  const html = renderToStaticMarkup(<Relationships board={board(relationship)} onChanged={() => {}} />);

  assert.match(
    html,
    /title="box-shadow: none → rgba\(0, 0, 0, 0\.12\) 0px 4px 12px 0px"/,
  );
  assert.match(
    html,
    /aria-label="Match box-shadow on every target: none → rgba\(0, 0, 0, 0\.12\) 0px 4px 12px 0px"/,
  );
});

test("annotation textareas have stable accessible names independent of placeholders", () => {
  const pinList = source("packages/extension/src/sidepanel/PinList.tsx");
  const relationships = source("packages/extension/src/sidepanel/Relationships.tsx");

  assert.match(pinList, /aria-label=\{`Annotation for \$\{title/);
  assert.match(relationships, /aria-label=\{`Relationship annotation for \$\{/);
});

test("creating a relationship takes the user directly to its style diff", () => {
  const app = source("packages/extension/src/sidepanel/App.tsx");
  const pinList = source("packages/extension/src/sidepanel/PinList.tsx");

  assert.match(
    app,
    /<PinList[\s\S]{0,180}onRelationshipCreated=\{\(\) => setTab\("relationships"\)\}/,
  );
  const confirm = pinList.slice(
    pinList.indexOf("const confirmRelationship"),
    // Anchored after the start: an effect cleanup's `return () => {` earlier
    // in the file must not collapse this slice to nothing.
    pinList.indexOf("return (", pinList.indexOf("const confirmRelationship")),
  );
  assert.match(confirm, /await send\("relationship\/create"/);
  assert.match(confirm, /onRelationshipCreated\?\.\(\)/);
});

test("the inline rename field is labelled and Escape cannot commit its draft", () => {
  const rename = source("packages/extension/src/sidepanel/RenamableTitle.tsx");

  assert.match(rename, /aria-label=\{`Rename \$\{shown\}`\}/);
  assert.match(rename, /if \(cancelCommit\.current\) \{[\s\S]*cancelCommit\.current = false[\s\S]*return/);
  assert.match(rename, /if \(e\.key === "Escape"\) \{[\s\S]*cancelCommit\.current = true[\s\S]*setEditing\(false\)/);
});

test("a cleared or newly created board returns to the Pins tab", () => {
  const app = source("packages/extension/src/sidepanel/App.tsx");
  const clear = app.slice(app.indexOf("const clearBoard"), app.indexOf("const toggleCapture"));

  assert.match(clear, /await send\("board\/clear"[\s\S]*setTab\("pins"\)/);
  assert.match(app, /useEffect\(\(\) => \{[\s\S]{0,120}setTab\("pins"\)[\s\S]{0,120}\}, \[board\?\.id\]\)/);
});

test("side-panel tabs and target picks expose their selected state", () => {
  const app = source("packages/extension/src/sidepanel/App.tsx");
  const pinList = source("packages/extension/src/sidepanel/PinList.tsx");

  assert.match(app, /role="tablist"/);
  assert.match(app, /role="tab"[\s\S]{0,160}aria-selected=\{tab === "pins"\}/);
  assert.match(app, /role="tabpanel"/);
  assert.match(pinList, /aria-pressed=\{pickable \? isTarget : undefined\}/);
});

test("hard failures use red while offline and blocked guidance stays amber", () => {
  const app = source("packages/extension/src/sidepanel/App.tsx");
  const css = source("packages/extension/src/ui/ui.css");

  assert.match(app, /captureIssue[\s\S]*className="pin-banner pin-banner--error"/);
  assert.match(app, /submitError[\s\S]*className="pin-banner pin-banner--error"/);
  assert.match(css, /\.pin-banner--error\s*\{[\s\S]*var\(--pin-red-tint\)[\s\S]*var\(--pin-red\)/);
});

test("identity labels keep one fixed plate in both schemes", () => {
  const css = source("packages/extension/src/ui/ui.css");

  /*
   * Panels follow the browser's preference; labels do not. They sit on
   * someone else's page, so they use fixed tokens rather than --pin-ink /
   * --pin-paper, which invert. A machine set to dark used to put white
   * labels on light websites, and made recordings depend on the recorder's
   * OS setting.
   */
  for (const selector of [".pin-live-label", ".pin-object__label"]) {
    const start = css.indexOf(`${selector} {`);
    const rule = css.slice(start, css.indexOf("}", start) + 1);
    assert.match(rule, /background: var\(--pin-label-fill\)/, `${selector} plate is fixed`);
    assert.match(rule, /color: var\(--pin-label-ink\)/, `${selector} text is fixed`);
  }

  // The picker's hover label becomes the selected label, so it is fixed too.
  const picker = css.slice(css.indexOf(".pin-highlight__label"), css.indexOf(".pin-highlight[data-label"));
  assert.match(picker, /--pin-label-fill/);
  assert.match(picker, /color: var\(--pin-label-ink\)/);

  // The invariant behind all of it: the dark block must not redefine them.
  const dark = css.slice(css.indexOf('.pin-root[data-scheme="dark"]'));
  const darkBlock = dark.slice(0, dark.indexOf("}"));
  assert.doesNotMatch(darkBlock, /--pin-label-fill/, "label plate must not invert");
  assert.doesNotMatch(darkBlock, /--pin-label-ink/, "label ink must not invert");
});

test("essential small text uses readable muted ink instead of faint disabled ink", () => {
  const css = source("packages/extension/src/ui/ui.css");

  for (const selector of [
    ".pin-row__route",
    ".pin-diff__from",
    ".pin-change__from",
    ".pin-change__caption",
    ".pin-metric__was",
    ".pin-field::placeholder",
    ".pin-note__input::placeholder",
  ]) {
    const start = css.indexOf(`${selector} {`);
    const rule = css.slice(start, css.indexOf("}", start) + 1);
    assert.match(rule, /color:\s*var\(--pin-ink-muted\)/, `${selector} should be readable`);
    assert.doesNotMatch(rule, /pin-ink-faint/);
  }
});

test("multi-target relationships say that selections apply to every target", () => {
  const html = renderToStaticMarkup(<Relationships board={board(relationship)} onChanged={() => {}} />);

  assert.match(html, />Selected source styles apply to every target in this relationship\.<\/p>/);
  assert.match(html, /aria-label="Match border-radius on every target:/);
});

test("clear all is one click with an undo toast instead of a pre-confirm", () => {
  const app = source("packages/extension/src/sidepanel/App.tsx");
  const css = source("packages/extension/src/ui/ui.css");

  assert.doesNotMatch(app, /clearArmed/);
  assert.match(app, /await send\("board\/clear", \{ boardId: board\.id \}\)/);
  assert.match(app, /setUndoClear\(\{ boardId: board\.id \}\)/);
  assert.match(app, /send\("board\/undoClear", \{ boardId: undoClear\.boardId \}\)/);
  assert.match(app, /className="pin-toast"/);

  // The control hovers gray like every quiet action — red pre-warning went
  // with the confirm step it belonged to.
  const hover = css.slice(
    css.indexOf(".pin-tab-action:is(:hover, :focus-visible)"),
    css.indexOf("}", css.indexOf(".pin-tab-action:is(:hover, :focus-visible)")) + 1,
  );
  assert.doesNotMatch(hover, /pin-red/);
});

test("late side-panel reloads cannot overwrite newer board state", () => {
  const app = source("packages/extension/src/sidepanel/App.tsx");

  assert.match(app, /const reloadGeneration = useRef\(0\)/);
  assert.match(app, /const generation = \+\+reloadGeneration\.current/);
  assert.match(app, /if \(generation !== reloadGeneration\.current\) return/);
});

test("go to pin reports navigation or delivery failures in the shelf", () => {
  const pinList = source("packages/extension/src/sidepanel/PinList.tsx");

  assert.match(pinList, /const \[revealIssue, setRevealIssue\] = useState<string \| null>\(null\)/);
  assert.match(pinList, /const result = await send\("pin\/revealSource"/);
  assert.match(pinList, /if \(!result\.ok\) setRevealIssue/);
  assert.match(pinList, /revealIssue[\s\S]*role="alert"/);
});

test("a failed relationship property write rolls optimistic controls back and explains why", () => {
  const relationships = source("packages/extension/src/sidepanel/Relationships.tsx");

  assert.match(relationships, /const \[writeIssue, setWriteIssue\] = useState<string \| null>\(null\)/);
  assert.match(relationships, /catch \{[\s\S]*selectionRef\.current = new Set\(incomingRef\.current\)/);
  assert.match(relationships, /writeIssue[\s\S]*className="pin-banner pin-banner--error"[\s\S]*role="alert"/);
});

test("relationship creation has a pending guard and a visible failure state", () => {
  const pinList = source("packages/extension/src/sidepanel/PinList.tsx");

  assert.match(pinList, /if \(!source \|\| targets\.size === 0 \|\| relationshipBusy\) return/);
  assert.match(pinList, /disabled=\{targets\.size === 0 \|\| relationshipBusy\}/);
  assert.match(pinList, /relationshipIssue[\s\S]*pin-banner--error[\s\S]*role="alert"/);
});

test("side-panel tabs support the expected arrow-key interaction", () => {
  const app = source("packages/extension/src/sidepanel/App.tsx");

  assert.match(app, /const onTabKeyDown = \(event: React\.KeyboardEvent<HTMLButtonElement>\)/);
  assert.match(app, /event\.key !== "ArrowLeft"\s*&&\s*event\.key !== "ArrowRight"/);
  assert.match(app, /document\.getElementById\(`pin-tab-\$\{next\}`\)\?\.focus\(\)/);
  assert.match(app, /onKeyDown=\{onTabKeyDown\}/);
  assert.match(app, /tabIndex=\{tab === "pins" \? 0 : -1\}/);
  assert.match(app, /tabIndex=\{tab === "relationships" \? 0 : -1\}/);
});

test("submitting explicitly saves the current global instruction first", () => {
  const app = source("packages/extension/src/sidepanel/App.tsx");
  const submit = app.slice(app.indexOf("const submit"), app.indexOf("/**\n   * The board clears"));

  const saveAt = submit.indexOf("setInstruction(instructionDraft)");
  const readyAt = submit.indexOf('send("board/markReady"');
  assert.ok(saveAt >= 0 && saveAt < readyAt);
  assert.match(submit, /instructionDraft !== board\.globalInstruction/);
});

test("post-submit recovery reuses the draft-board invariant instead of creating duplicate sheets", () => {
  const app = source("packages/extension/src/sidepanel/App.tsx");
  const reset = app.slice(app.indexOf("if (phase !== \"submitted\")"), app.indexOf("const pinCount"));

  assert.doesNotMatch(reset, /send\("board\/create"/);
  assert.match(reset, /if \(!uncopied\) \{\s*await reload\(\)/);
});

test("submission broadcasts cannot replace the submitted board before clipboard recovery", () => {
  const app = source("packages/extension/src/sidepanel/App.tsx");

  assert.match(app, /const phaseRef = useRef<Phase>\("idle"\)/);
  assert.match(app, /if \(phaseRef\.current !== "idle"\) \{[\s\S]*?return;\s*\}/);
  assert.match(app, /phaseRef\.current = "submitting"[\s\S]*setPhase\("submitting"\)/);
  assert.match(app, /phaseRef\.current = "submitted"[\s\S]*setPhase\("submitted"\)/);
});

test("clipboard fallback offers an explicit path to a new draft instead of editable ready controls", () => {
  const app = source("packages/extension/src/sidepanel/App.tsx");

  assert.match(app, /const startNewBoard = useCallback/);
  assert.match(app, /setUncopied\(null\)[\s\S]*await reload\(\)[\s\S]*setPhase\("idle"\)/);
  assert.match(app, /uncopied \? \([\s\S]*Start a new board[\s\S]*\) : \(\s*<>/);
});

test("the wordmark keeps its red mark while its lettering adapts to dark chrome", () => {
  const wordmark = source("packages/extension/src/ui/wordmark-flat.svg");

  assert.match(wordmark, /@media \(prefers-color-scheme: dark\)/);
  assert.match(wordmark, /path\[fill="#292C33"\] \{ fill: #f6f5f3; \}/);
  assert.match(wordmark, /<circle[^>]*fill="#ED1C24"/);
});

test("an empty Relationships tab shows relationship guidance, not the Pins empty state", () => {
  const app = source("packages/extension/src/sidepanel/App.tsx");
  const body = app.slice(app.indexOf('className="pin-panel__body"'), app.indexOf("{board && pinCount > 0"));

  assert.doesNotMatch(body, /:\s*pinCount === 0 \?\s*\(/);
  assert.match(body, /:\s*tab === "pins" \?\s*\(\s*pinCount === 0/);
  assert.match(body, /:\s*\(\s*<Relationships/);
});
