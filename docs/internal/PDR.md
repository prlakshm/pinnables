# Product Requirements Document: Pinnables (v2)

> **v2 changelog.** Terminology moved from "visual brief" to "annotations." Handoff redesigned: MCP
> is the primary channel (pull, never push), with local file storage as the shared substrate and a
> no-install `brief.md` fallback. MCP server moved from Milestone 3 into Milestone 2 and cut from
> 9 tools to 4. Relationships promoted from P1 to P0 and from Milestone 4 to Milestone 2. Style-diff
> computation added as a core feature. Pin status cut 6 states → 3. Source mapping inverted to
> dev-plugin-first. Screenshot capture mechanism decided. Telemetry position stated. Data model gaps
> closed.
>
> The MCP server described here is **built and working** — see [README.md](README.md).
>
> Rationale for each in [PDR-REVIEW.md](PDR-REVIEW.md); handoff mechanics in [HANDOFF-DESIGN.md](HANDOFF-DESIGN.md).

---

## Product summary

Pinnables is a Chrome extension for **cross-page annotations for AI coding agents**.

Pin components and states from anywhere in your product, annotate them, describe how they should
relate to each other, and hand your coding agent one plan instead of twelve tickets.

**One-liner:**
> Annotations that describe how components relate — so your coding agent gets a diff, not a to-do list.

---

## Problem

UI review is rarely one issue at a time, and it is rarely absolute. It is *comparative*:

- This dashboard card should match the one in Settings.
- Mobile nav behaves differently across two routes.
- Loading, error, and empty states don't feel related.
- This component should borrow one aspect of a reference without copying everything.

Existing tools support two workflows: select one element and prompt immediately, or collect
independent annotations and send them as a list. Both **flatten the comparison**. Neither lets you
say:

> Make A use B's spacing, while preserving C's mobile behavior.

The user reconstructs that context manually — screenshots, long prompts, repeated agent turns.

## Hypothesis

If users can express *relationships* between annotations before the agent starts, they will
communicate intent more precisely, need fewer corrective prompts, and trust larger batches of
agent-generated UI changes.

The riskiest part of this hypothesis — and the thing Milestone 2 exists to test — is whether users
will actually author structured relationships, or just type the relationship into a plain annotation
and find that good enough.

---

## Competitive position

Cross-page annotation batching is **shipped, today**, by multiple products. This is not an emerging
capability to race toward; it is table stakes.

| Product | Already ships |
|---|---|
| Pointa | Cross-route annotations, batch to MCP agents, up to 200 per batch |
| Vibe Annotations | Multi-page pins, screenshots, structured context, batch via MCP, watch mode |
| Design Mode | Session change log → one agent-ready diff, MCP integration |
| Markagent | Numbered multi-annotation journeys, structured prompt export |
| UICuts | Components stay "picked" across refreshes, packaged as agent context |
| PocketUI | Component library across sites, exposed over MCP |
| Infa AI | Cross-page component tagging, design-system usage, links back to code |
| Yoink | Rich per-element capture for agents |

**What none of them do:** a relationship graph — one source, N targets, named properties, explicit
exceptions — resolved into a concrete style diff and sent as a single plan.

That is the entire differentiator. Everything else in P0 is necessary infrastructure to reach it.

**Positioning discipline:**
- **Category** (findability): "cross-page annotations for AI coding agents."
- **Claim** (why we exist): relationships, not lists.
- Never claim novelty on cross-page batching. Never say "the first tool that…".

---

## Target users

**Primary:** frontend developers using AI coding agents; design engineers; designers reviewing a
running localhost app; technical founders iterating on product UI.

**Secondary:** PMs writing implementation-ready feedback; QA documenting visual inconsistencies;
agencies reviewing client routes; design-system maintainers auditing drift.

---

## Product principles

1. Relationships matter more than isolated comments.
2. The running product is the source of truth.
3. Users control when the agent begins working.
4. Everything stays local by default.
5. Precision over pictures — ship the agent facts, not screenshots to interpret.
6. Agent-agnostic: work identically across Cursor, Codex, Claude Code, and Windsurf.

---

## Core workflow

**1. Activate.** User opens a localhost app and grants Pinnables access to that origin
(Chrome-enforced, per-origin).

**2. Pin an element.** Pinnables captures: element screenshot, URL and route, viewport, CSS selector
and DOM path, `outerHTML` (truncated) and class list, an allowlisted computed-style set, nearby DOM
context, element text, and — when the dev plugin is installed — source file and line.

**3. Annotate.** One instruction per pin: *"Reduce vertical padding and use the standard card radius."*

**4. Continue across the product.** Pins persist in the side panel across routes, reloads, tab
switches, and service-worker restarts.

**5. Relate.** Connect pins with a typed relationship — one source, N targets, a property list, and a
free-text exception. Pinnables computes the **style diff** between source and targets automatically.

**6. Compose.** Reorder, group, delete. Add one board-level instruction.

**7. Hand off.** "Ready for agent" materializes the board to disk and copies a one-line pointer. The
user pastes it into their agent. The agent reads the summary and pulls per-pin detail on demand.

**8. Resolve.** The agent reports status back over MCP; the user reopens source routes to verify.

---

## The handoff (decided)

MCP is pull-based. A server cannot push a board into a running Cursor or Claude Code conversation.
No amount of MCP makes "Send to Cursor" a real button. The handoff is therefore:

**Store** → local service owns `~/.pinnables/boards/<id>/` containing `board.json`, `brief.md`, and
`pins/pin-NN.{png,json}`. Never inside the user's repo unless they opt in (and then Pinnables writes
the `.gitignore` entry). *This is the substrate, not a transport* — the MCP server reads the same
`board.json`, so the storage layer serves both paths and neither is redundant.

**Trigger** → extension copies a pointer to the clipboard; the user pastes it into their agent:

```
Load Pinnables board "dashboard-cards" and implement it.
```

**Pull (primary)** → the agent calls `get_board`, works from the manifest, and calls
`get_pin_context` only for pins it's about to edit. Screenshots are returned as absolute paths so
the agent reads them with its own file tools — which sidesteps every MCP client image-support
question, notably Cursor's.

**Pull (fallback)** → if the MCP server isn't registered, the pointer becomes
`Read ~/.pinnables/boards/dashboard-cards/brief.md and implement it.` Same content, same
manifest-first shape, zero install. Degraded only in that the agent can't write status back.

**Write back** → `set_pin_status` closes the loop and is the reason MCP is the primary path rather
than a nicety. Without it, resolution is manual.

The UI label is **"Ready for agent,"** never "Send to Cursor." The button does not send.

---

## MVP scope

### P0 — required

**Capture**
- Localhost only, explicit per-origin activation via `chrome.permissions.request()`.
- Element picker with hover highlight.
- Element screenshot via `chrome.tabs.captureVisibleTab` + crop to bounding rect. Elements taller
  than the viewport are captured clipped, with the clip noted.
- Structured context capture (see workflow step 2).
- Allowlisted computed styles — a fixed ~30-property set, storing only values that differ from
  inherited/initial. **The allowlist is identical across all pins**; style diffing depends on it.
- Password fields redacted via pre-capture overlay. Manual box redaction on any screenshot.

**Board**
- Pins persist across routes, reloads, tab switches, and service-worker restarts.
- Persistent side panel, registered globally so it survives navigation.
- One annotation per pin; edit and delete.
- Reorder pins (fractional index).
- One board-level instruction.
- Separate boards per project.
- Return to a pin's source route; highlight the original element, or show a clear
  "element not found" state with the screenshot preserved.
- One-click delete of a board and all its assets.

**Relationships** *(promoted from P1 — this is the differentiator)*
- Connect pins: one source → N targets.
- Type: `match` (only type in MVP).
- Included property list + free-text exception.
- **Automatic style diff** between source and target computed styles, rendered as concrete
  before → after value pairs.

**Handoff**
- Materialize board to `~/.pinnables/boards/<id>/` as `brief.md` + `board.json` + per-pin files.
- "Ready for agent" copies the clipboard pointer.
- MCP server exposing **four** tools:

| Tool | Returns |
|---|---|
| `list_boards` | Board ids, titles, project, pin counts, status |
| `get_board` | Metadata, global instruction, relationships with style diffs, and a compact pin manifest (id, route, viewport, annotation, source file, status, thumbnail path) |
| `get_pin_context` | Full detail for one pin: computed styles, `outerHTML`, DOM path, nearby context, full-res screenshot path |
| `set_pin_status` | Write-back |

Return **paths, not base64**. Thumbnails in the manifest, full-res on demand. A 20-pin board must
stay under ~5k tokens at manifest level.

**Status** — three states only: `todo`, `done`, `blocked`.

### P1
- Additional relationship types beyond `match`.
- Group pins into sections.
- Capture hover, focus, loading, empty, error states.
- Responsive variants of the same component.
- Refresh a pin from its source page.
- Before/after captures.
- Scroll-and-stitch for tall elements.
- Shadow DOM and iframe pinning.
- `add_agent_note`.
- Agent reports which files it touched per pin.

### P2
- Native macOS always-on-top reference shelf (`NSWindow.level = .floating`, via Native Messaging).
  Chrome's `windows` API exposes `alwaysOnTop` as read-only on desktop and the `panel` type is
  deprecated, so this genuinely requires a native helper.
- Shared team boards, cloud sync, comments, GitHub/Figma integration, visual regression,
  automatic token detection, automatic inconsistency discovery.

### Explicit non-goals
Replacing Figma. A general visual CSS editor. Editing production sites by default. Pinning
third-party desktop windows. Changing source code without approval. Cloud-hosted screenshots. A
general-purpose issue tracker. Real-time multiplayer.

---

## Data model

**Project** — `id`, `name`, `origins[]`, `repositoryPath`, `createdAt`, `lastOpenedAt`
*(`repositoryPath` comes from the local service's `cwd`; the extension cannot read the filesystem.)*

**Board** — `id`, `schemaVersion`, `projectId`, `title`, `globalInstruction`,
`status: draft | ready | in-progress | done`, `generatedAt`, `createdAt`, `updatedAt`

**Pin** — `id`, `schemaVersion`, `boardId`, `order` *(fractional index)*, `groupId | null`, `url`,
`route`, `viewport`, `screenshotPath`, `thumbnailPath`, `selector`, `domPath`, `outerHtml`,
`classList`, `elementText`, `componentName`, `sourceFile`, `computedStyles`, `annotation`,
`captureState`, `status: todo | done | blocked`, `createdAt`, `updatedAt`

**Relationship** — `id`, `boardId`, `type: match`, `sourcePinId` *(one)*, `targetPinIds[]` *(many)*,
`properties[]`, `exception`, `instruction`, `computedDiff`

> Cardinality is deliberately **one source → many targets**, not many-to-many. It covers the highest-
> value case ("replace every instance with this preferred version") without the graph UI.

---

## Technical approach

**Extension** (Manifest V3, Vite + React + TypeScript)
- Content script: element selection and overlay. A minimal listener-only script is pre-injected; the
  heavy picker bundle is injected lazily on activation, satisfying both the 200 ms budget and the
  no-background-activity promise.
- Side panel: `chrome.sidePanel`, registered globally.
- Service worker: **stateless router only**. MV3 terminates service workers when idle, so no board
  state lives in memory — every mutation round-trips through storage.
- Side panel and service worker are both *views* over storage, never owners of state.
- SPA route changes detected via History API hook / `chrome.webNavigation.onHistoryStateUpdated`.
- Permissions: `activeTab`, `storage`, `sidePanel`, `scripting`, plus `optional_host_permissions`
  requested per origin. No `<all_urls>` in the manifest.

**Local service** (Node) — board persistence, screenshot storage, project detection, board
materialization, MCP server. If the service is unavailable the extension buffers to IndexedDB and
syncs when it returns.

**Dev plugin** (Vite) — stamps `data-pin-source="src/Card.tsx:42:7"` at build time. **This is the
primary source-mapping path**, not an optional extra: fiber introspection depends on undocumented
dev-only internals that have already changed across React versions (`_debugSource` was removed in
React 19). Fiber walking is the fallback for users without the plugin.

**Install** — ship a real global install, not `npx -y` on every agent start.

---

## Privacy, security, telemetry

- Localhost only by default; Chrome-enforced per-origin grants.
- All project data local. No screenshots uploaded, ever, in MVP.
- Visible indicator whenever capture mode is active.
- Password fields redacted pre-capture; manual box redaction available on any screenshot.
  *We do not attempt automatic sensitive-content detection* — localhost apps are often seeded with
  production data, and a leaky auto-detector creates false confidence.
- One-click deletion of a board and its assets.

**Telemetry** — opt-in, off by default, with a visible toggle. Event counts and durations only.
**Never** URLs, routes, selectors, annotation text, element text, or screenshots. If the user declines,
the product is fully functional and we collect nothing.

> This is a real constraint on the metrics below, and it is the right trade. The local-first promise
> is a competitive asset with exactly the users we want.

---

## Performance requirements

- Enter capture mode within 200 ms.
- Element highlight tracks the pointer smoothly.
- Adding a pin feels instantaneous (viewport-crop capture; no scroll-and-stitch in MVP).
- Shelf handles 100+ pins without lag — virtualized list, WebP thumbnails, full-res on disk.
- Route changes never destroy the active board.
- Agent manifest for a 20-pin board stays under ~5k tokens.

---

## Edge cases

Element disappears after navigation · selector invalidated by hot reload · multiple selector matches ·
iframe or shadow root (declared out of MVP scope; must fail with a clear message, not silently) ·
closed shadow roots are unpierceable · authentication-gated routes · route state not reproducible from
URL · sensitive content in a capture · no source mapping available · component differs across
breakpoints · agent edits invalidate pins · several pins referencing one reusable component ·
materialized brief is stale relative to the live code.

---

## Success metrics

**Activation** — user creates a board, captures 3+ pins across 2+ routes, creates 1 relationship, and
hands off once.

**Primary**
- % of sessions with the dev plugin installed *(adoption, fully in our control)*
- % of pins with a resolved source file *(near-deterministic once the plugin is installed)*
- % of boards containing at least one relationship *(the core hypothesis, measured directly)*
- % of boards completed in one agent run
- Median time from first pin to handoff
- Weekly boards created per active user

> Dropped from v1: "% of pins correctly mapped to source code" (replaced by the two measurable
> metrics above) and "average corrective prompts after implementation" (occurs inside the agent's
> conversation; not observable from our side — demoted to a qualitative signal).

**Qualitative** — users rely on relationships rather than working around them; users capture multiple
states or routes per board; agents can explain which files correspond to each pin; users report fewer
context-reconstruction prompts.

---

## Milestones

**M1 — Capture.** Style allowlist locked first. Element picker, viewport-crop screenshot, annotation,
local storage, persistent side panel, per-origin activation.

**M2 — Board, relationships, and the MCP server.** Route persistence, return-to-source, reorder,
board-level instruction, **relationships with automatic style diff**, the `brief.md` writer, and the
**local MCP server (4 tools)**.

> **The full demo narrative is runnable at the end of M2**, including the handoff. The MCP server can
> be built and tested against fixture board data *before the extension exists* — which is the right
> order, because it validates the riskiest assumption (does an agent actually do good work from this
> payload?) while capture is still cheap to change.

**M3 — Agent loop.** `set_pin_status` wired into the side panel, MCP-registration detection to branch
the clipboard string, resolution workflow, agent notes surfaced on pins.

**M4 — Depth.** States and responsive variants, refresh from source, before/after, additional
relationship types, scroll-and-stitch, shadow DOM.

**M5 — Floating shelf.** macOS helper via Native Messaging, always-on-top board, floating component
references, global pin shortcut.

---

## Acceptance criteria

The MVP is ready when a user can:

1. Open a localhost React app and grant Pinnables access to that origin.
2. Pin five elements across at least three routes.
3. Have all five pins survive route navigation, tab switches, **and a service-worker restart**.
4. Add an independent instruction to every pin.
5. Connect two pins with a `match` relationship and see the computed style diff.
6. Add one board-level instruction.
7. Mark the board ready, paste the pointer into Cursor, Codex, or Claude Code, and have the agent
   retrieve the board.
8. Have the agent pull full context for an individual pin on demand, with the manifest under ~5k tokens.
9. Return to each captured route, with the element highlighted or a clear not-found state.
10. Mark pins resolved and see it reflected in the agent's next `get_board`.
11. Complete the workflow with **zero network requests to any non-localhost origin** — verifiable in
    DevTools.

---

## Launch

**Do not position as:** another annotation extension for AI coding tools.

**Position as:** annotations that carry relationships, so the agent gets a plan instead of a list.

**Demo (≈20s):** pin a dashboard card → navigate to Settings, pin the preferred card → connect them
with `match` → show the computed style diff appearing → add "preserve the dashboard's content
hierarchy" as the exception → hand off → agent edits the correct file → resolve the pins.

> The style diff appearing automatically is the moment worth building the demo around. It's the one
> beat no competitor can show.

**Hook:**
> Annotation tools give your coding agent a to-do list. But UI problems are relational — this card
> should match that one, this flow should keep its mobile behavior. So I built cross-page annotations
> where you link the pins, and the agent gets one plan with the exact diffs.

---

## Resolved decisions

| Question | Decision |
|---|---|
| Side panel or floating shelf? | Side panel. It survives tab navigation for free, which *is* the core requirement. Native helper is the M5 follow-up. |
| Snapshots or live previews? | Snapshots — plus `outerHTML` and scoped styles, so refresh is a diff and the agent can read markup without vision. |
| Plan or implement immediately? | Plan first — but the **agent's** plan. Pinnables supplies intent; the agent has the codebase. This removes a feature from our scope. |
| Boards by task, feature, or repo? | Project = repository. Board = review session. Already implied by the schema. |
| How much computed style? | ~30-property allowlist, only non-default values. Full `getComputedStyle` is ~340 properties of mostly defaults and buries the ones that matter. |
| Production/staging origins? | Not in the first release — broad host permissions materially increase Chrome Web Store review scrutiny. `optional_host_permissions` lets power users add origins themselves. |
| Is "Pinnables" the final name? | Yes. With "annotation board" as the surface, "pins" as the items, and Pinnables as the tool, the vocabulary is now internally consistent. |
