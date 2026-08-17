# Pinnables PDR — Pressure Test

A critique of the spec as an engineering contract. Organized as: what holds up, what breaks,
what MV3 will not let you do, what to cut, and answers to the seven open decisions.

---

## 1. What holds up

Short section on purpose — these are settled, don't relitigate them.

- **Layered element identifiers.** Storing selector + DOM path + text + component metadata +
  nearby content + screenshot + route + viewport is the correct answer to selector rot. Most
  tools in this space store one selector and break on the first refactor.
- **Manifest-first, detail-on-demand agent context.** Right instinct, and it maps cleanly onto
  how MCP tools actually get called. See §5 for the concrete shape.
- **Snapshots over live clones.** Live DOM clones of a running app are a tar pit (stylesheet
  resolution, cross-origin assets, hydration state). Snapshot + explicit refresh is correct.
- **Local-first.** This is a real differentiator, not just a privacy checkbox — it's what makes
  the product usable at companies that would never approve an extension that uploads screenshots
  of internal dashboards. Protect it. See §2.4 for the one place it's in tension with the spec.
- **Relationships as first-class objects.** Agreed, and it is genuinely the interesting idea here.
  Which is why §6 argues it's sequenced wrong.

---

## 2. Blocking issues

These break the MVP *as written* — not risks to monitor, but things where the spec describes
something that cannot be built the way it's described.

### 2.1 MCP is pull-based. "Send to an agent" is not a thing you can build.

The core workflow says:

> **7. Send to an agent** — The complete brief is sent through MCP.

And acceptance criterion #7:

> Send the complete board to Cursor or Codex through MCP.

MCP servers do not push to clients. The agent is the MCP *client*; it calls tools on your server
when it decides to. There is no primitive in MCP that injects a prompt into a running Cursor or
Claude Code conversation. Your local server cannot make the agent start working.

The real handoff is necessarily:

1. User finishes the board in the side panel.
2. Pinnables marks the board `ready` and copies a short pointer to the clipboard —
   e.g. `Review Pinnables board "dashboard-cards"`.
3. User pastes that into their agent.
4. The agent calls `list_boards` / `get_board` and pulls the brief.

This is a **one-step-worse UX than the PDR implies**, and it needs to be designed rather than
discovered during implementation. Two things follow:

- The "Send" button is really a **"Ready for agent"** button. Name it honestly in the UI; a button
  labeled "Send to Cursor" that actually copies a string to the clipboard will read as broken.
- The pointer string is now a **first-class product surface**. It is the entire interface between
  your product and the agent. It should be short, unambiguous, and stable, and the board should be
  findable by name so the user can type it from memory.

The "Copy as prompt" fallback listed in the PDR is not a fallback. It is closer to the primary path
than the MCP push you've described. Reframe: MCP is what makes the *context* rich; the clipboard is
what makes the *handoff* happen.

**Rewrite acceptance criterion #7 as:** "Start a session in Cursor or Claude Code and have the agent
retrieve the complete board through the Pinnables MCP server."

### 2.2 There is no chosen screenshot mechanism, and all three options cost something

The PDR requires per-element screenshots and asserts "Adding a pin should feel instantaneous."
It never says how the capture works. This is the single highest-leverage unmade decision, because
it determines your permission set, your privacy story, and your performance ceiling.

| Approach | Gets you | Costs you |
|---|---|---|
| `chrome.tabs.captureVisibleTab` + crop to bounding rect | No scary permissions; works with `activeTab` | Viewport-only. Elements taller than the fold need scroll-and-stitch, and the API is quota-limited to **2 calls/sec** — a 5-viewport-tall element takes ~2.5s. Directly contradicts "instantaneous." |
| `chrome.debugger` → CDP `Page.captureScreenshot` with `clip` + `captureBeyondViewport` | Exact element rect, full height, one call, no scrolling | Requires the `debugger` permission and shows Chrome's yellow *"Pinnables started debugging this browser"* banner for the whole session. Contradicts "minimal Chrome permissions." |
| DOM→canvas serialization in the content script (html2canvas-style) | Zero extra permissions, element-scoped by construction | Notoriously lossy — cross-origin images taint the canvas, many CSS features render wrong, shadow DOM is a problem. Your screenshots become *approximations of* the UI, which undermines "the running product is the source of truth." |

**Recommendation:** ship `captureVisibleTab` + crop, and cap pinnable elements at viewport height
for MVP (capture what's visible, note the clip). Scroll-and-stitch is a P1 refinement, not an MVP
requirement. Revisit `chrome.debugger` only if users complain about tall elements — and if you do
adopt it, make it an explicit opt-in mode, because the banner will generate support tickets.

Note the upside of the `captureVisibleTab` path: with `activeTab`, the permission is granted by the
user's click and doesn't require declaring broad host access up front. That's worth a lot in §4.3.

### 2.3 "Percentage of pins correctly mapped to source code" is a primary metric for an optional capability

The PDR lists this under **Primary metrics**, and separately mitigates the framework-metadata risk with:

> Make framework metadata optional. Provide an optional development plugin for stronger source mapping.

You cannot have a primary success metric on a capability you've defined as optional and best-effort.
One of the two has to move.

The technical reality makes this worse. Fiber-based source extraction (walking `__reactFiber$*` up to
a component with `_debugSource`) depends on undocumented dev-only internals that have already changed
across React versions — `_debugSource` was removed in React 19. Vue, Svelte, and Angular each expose
something different, or nothing. Static HTML exposes nothing at all. Best-effort DOM introspection will
land somewhere well under a rate you'd want to publish as a headline metric.

**Recommendation:** invert the priority. Make the **build-time plugin the primary path**, not the
optional one. A small Vite plugin that stamps `data-pin-source="src/Card.tsx:42:7"` onto elements during
dev gives you near-100% accuracy, works across frameworks, is ~100 lines, and is fully under your control.
Fiber introspection becomes the *fallback* for users who haven't installed it.

That also gives you a cleaner metric: **"% of sessions with the dev plugin installed"** (an adoption
number you control) × **"% of pins with a source file"** (near-deterministic once installed). Both are
measurable and both are actionable. "% correctly mapped" via heuristics is neither.

### 2.4 Every primary metric requires telemetry the privacy section appears to forbid

The privacy requirements say all project data stays local and nothing is uploaded without consent.
The metrics section then asks for median time-to-brief, boards per active user, corrective prompts
after implementation, and completion rates.

There is no analytics section, no consent model, and no statement of what — if anything — leaves
the machine. Right now the document promises local-only in one section and assumes a telemetry
pipeline in another.

This is resolvable, but only if you decide it deliberately:

- Opt-in, off by default, with a visible toggle.
- Event counts and durations only. **Never** URLs, routes, selectors, annotation text, element text,
  or screenshots — those are exactly the things that make localhost data sensitive.
- Say so in the PDR, in the store listing, and in the onboarding. The privacy promise is a
  competitive asset; an undisclosed analytics call discovered by one security-minded user costs
  more than the metrics are worth.

Note that "average corrective prompts required after implementation" is probably not measurable at all
from your side — it happens inside the agent's conversation, which you have no visibility into. Either
drop it or convert it into a qualitative signal.

---

## 3. MV3 realities the spec assumes away

### 3.1 The service worker will die mid-session

> A service worker for board and session coordination.

MV3 extension service workers are terminated when idle. Any in-memory state — the active board, the
capture-mode flag, a partially built pin — is gone without warning, and the next event restarts the
worker cold.

Consequences for this design:
- **No board state in service-worker memory.** Every mutation round-trips through `chrome.storage`
  or the local service. Treat the SW as a stateless router.
- Capture-mode on/off must be persisted, or the user toggles capture mode, tabs away for a minute,
  comes back, and the extension has silently forgotten it's active. That also violates
  "Clear indication when capture mode is active."
- Any "session coordination" that assumes continuity across a user's review session needs a
  persistence story. The PDR's word "session" is doing unexamined work here.

### 3.2 The side panel re-mounts, so it can't own state either

`chrome.sidePanel` (Chrome 114+) gives you cross-navigation persistence essentially for free when
registered globally rather than per-tab — which is genuinely most of P0's "pins survive route
navigation" requirement, and a good reason to prefer it over a content-script-injected shelf.

But the panel document does re-mount (tab switches, disabled origins, panel close/reopen). So it
renders state, it doesn't own it. Same rule as the SW: storage is the source of truth, the panel
is a view. Given the React choice, this means the panel should hydrate from storage on mount and
subscribe to `chrome.storage.onChanged` — not hold a long-lived in-memory store.

Also: `sidePanel.open()` must be called from a user gesture. You can't auto-open the shelf when the
user hits a localhost origin. Onboarding needs to account for that.

### 3.3 Localhost host permissions are narrower than you think

`http://localhost/*` does **not** cover `http://127.0.0.1`, `http://[::1]`, `*.localhost` custom
domains, or HTTPS dev servers. (Ports are fine — match patterns ignore them, so one localhost
pattern covers every port.) A dev running Vite on `127.0.0.1:5173` would find the extension silently
inert, which is the worst possible first-run experience.

**Recommendation:** declare `optional_host_permissions` and request per-origin at activation via
`chrome.permissions.request()`. This simultaneously:
- satisfies "explicit per-origin activation" (a stated principle) *with an actual Chrome-enforced
  mechanism* rather than an app-level convention,
- satisfies "minimal Chrome permissions,"
- lets a power user add a staging origin later without you declaring `<all_urls>` in the manifest,
- and materially reduces Chrome Web Store review friction (see §7.6).

### 3.4 Shadow DOM and iframes are listed as edge cases; they're closer to baseline

The PDR files these under Edge Cases. For a tool whose users are frontend developers, that's
optimistic — component libraries and embedded tooling put shadow roots and iframes on the page
routinely.

- **Open shadow roots** need recursive `elementFromPoint` descent plus `composedPath()`, and your
  "CSS selector" field becomes meaningless — you need a path *through* host boundaries, not a
  querySelector string.
- **Closed shadow roots** are not piercable. That's a hard stop; make sure the failure is a clear
  "can't pin inside this component" message, not a mystery.
- **Iframes** need `all_frames: true`, per-frame content scripts, and coordinate translation between
  frame and top-level viewport for the overlay to draw in the right place.

None of this is exotic, but it is real work that isn't in any milestone. Either budget it into
Milestone 1 or explicitly declare shadow/iframe pinning out of MVP scope so it isn't discovered
as a surprise.

### 3.5 Screenshot redaction is not DOM redaction

> Password fields always redacted. Sensitive inputs excluded from capture.

Excluding a password field from the *captured DOM* is trivial. Redacting it from a *pixel screenshot*
is not — the screenshot shows whatever was on screen. Doing this correctly means mutating the page
(overlaying opaque rects over sensitive elements), capturing, then restoring — all without a visible
flicker and without the user's app reacting to the DOM change. It's racy and it's fiddly.

Also worth confronting: localhost apps are frequently seeded with production data dumps. The sensitive
content is often not in a password field at all — it's customer names in a table. "Configurable text and
screenshot redaction" is listed as a P0-adjacent requirement but is a substantial feature in its own
right.

**Recommendation for MVP:** redact `input[type="password"]` via pre-capture overlay (the one case you
promised), and ship a **manual redaction tool** on the pin — drag a box over the screenshot to black it
out — instead of trying to auto-detect sensitive content. Manual is honest, cheap, and doesn't create a
false sense of safety the way a leaky auto-detector would.

### 3.6 "Enter capture mode within 200ms" fights "no background capture when inactive"

If the picker bundle is injected on activation, you pay injection + parse before the overlay appears.
If it's declared in the manifest, it's always resident on every localhost page — which is in tension
with the no-background-activity promise (and with users who will inspect what you're running).

**Resolution:** pre-inject a minimal listener-only script (a few KB, no DOM observation, no capture
capability) and lazily inject the heavy picker/overlay on activation. States the promise honestly and
hits the budget.

---

## 4. Cut list

P0 as written is three surfaces — MV3 extension, local Node service, and a 9-tool MCP server. Here's
what I'd remove to get to something shippable without losing the thesis.

### 4.1 MCP surface: 9 tools → 4

The current list has real overlap, and **more tools measurably degrades agent tool selection**. Every
tool you add is another chance for the model to call the wrong one.

| Current | Verdict |
|---|---|
| `list_boards` | **Keep.** Entry point. |
| `get_board` | **Keep, and absorb the others.** Returns board metadata, global instruction, relationships, and a compact pin manifest (id, route, viewport, annotation, status, thumbnail path). |
| `get_pins` | **Cut.** A board contains its pins. Redundant with `get_board`. |
| `get_relationships` | **Cut.** Relationships are board-scoped and small; fold into `get_board`. Also: it's listed as P0 while relationships themselves are P1 — see §6. |
| `get_board_screenshot_manifest` | **Cut.** Screenshot paths belong in the `get_board` manifest. A separate call to learn where images are is a wasted round-trip. |
| `get_pin_context` | **Keep.** The on-demand detail path: full computed styles, DOM context, outerHTML, full-res screenshot path. |
| `set_pin_status` | **Keep.** |
| `mark_pin_resolved` | **Cut.** It's `set_pin_status(id, "resolved")`. |
| `add_agent_note` | **Defer to P1.** Nice, but nothing in the MVP acceptance criteria needs it. |

**Return paths, not base64.** Cursor and Claude Code both have filesystem access; handing them
`/Users/…/boards/x/pin-3.png` lets them read the image only if they actually need to look at it.
Inlining base64 forces every screenshot into context whether or not it's relevant.

The token math is worth internalizing: image tokens ≈ `(width × height) / 750`. A 1024×768 screenshot is
~1,050 tokens, so a 20-pin board is ~21k tokens of pure image if you inline everything. The same board
with 320×240 thumbnails is ~2k. **Thumbnails in the manifest, full-res paths on demand** is the right
default, and it's a stronger version of the mitigation the PDR already proposes.

### 4.2 Pin status: 6 states → 3

`To do / In progress / Implemented / Needs review / Resolved / Blocked` has no defined transitions
and no defined owner — it's unspecified whether the agent or the user sets "In progress," what
distinguishes "Implemented" from "Needs review," or who can set "Blocked." Meanwhile P0 only requires
"allows pins to be marked resolved."

Ship `todo` → `done`, plus `blocked` for the agent to signal it couldn't complete something. Add
states when a user asks for one.

### 4.3 Things to move out of P0

- **Scroll-and-stitch tall screenshots** → P1 (§2.2).
- **Shadow DOM / iframe pinning** → P1, explicitly declared (§3.4).
- **Configurable redaction** → replace with manual box redaction (§3.5).
- **Auto framework detection as the source-mapping path** → replaced by the dev plugin (§2.3).

---

## 5. Data model gaps

Concrete omissions that will cause a migration if not fixed now.

- **No ordering field on Pin.** P0 requires "pins can be reordered." Add `order: number` (or a
  fractional index — much better for drag-and-drop, since reordering touches one row instead of N).
- **No grouping field.** P1 grouping has nowhere to live. Add `groupId: string | null` now even if
  unused; it's free.
- **No `schemaVersion` anywhere.** This is a local-storage-first app that will iterate fast on its
  own data shapes. Version Board and Pin from day one and write the migration harness before you
  need it — retrofitting migrations onto users' existing local boards is genuinely painful.
- **Relationship cardinality is undecided.** The schema says `Source pin IDs` and `Target pin IDs`
  (both plural, implying many-to-many); the worked example is strictly 1→1. Many-to-many makes the
  connection UI dramatically harder. **Recommend one source → many targets** for MVP, which covers
  "replace every instance with this preferred version" — the most valuable listed case — without
  the full graph.
- **Board `Status` has no defined values.** Given §2.1, it probably wants to be
  `draft | ready | in-progress | done`, where `ready` is what the "Ready for agent" button sets.
- **Agent notes have no home.** `add_agent_note` exists as a tool with no corresponding entity.
  If you keep it in P1, it needs `{ noteId, pinId?, boardId, body, createdAt }`.
- **`Project.repositoryPath` has no acquisition story.** The extension cannot read the filesystem.
  Realistically the local service is launched from within the repo and reports its own `cwd`. Say
  so, because it constrains how the service is started and shipped.
- **`Pin.screenshotPath` assumes the local service is running.** Define the degradation: if the
  service is down, does capture fail loudly, or buffer to IndexedDB and sync later? Both are
  defensible; leaving it undefined means it'll be decided by whoever writes the error handler.

**One more, on route capture:** SPA route changes are `history.pushState` with no page load. To keep
`Pin.route` accurate you need to hook the History API in the content script (or use
`chrome.webNavigation.onHistoryStateUpdated`). Worth naming explicitly, since "route" is a field the
whole cross-page thesis depends on.

---

## 6. The milestone sequence buries the differentiator

Relationships are, per the PDR itself, the primary differentiator, the launch positioning, and the
mitigation for the "crowded annotation market" risk. They are scheduled for **Milestone 4** — after
capture, board, and agent handoff.

That means:
- The **demo narrative cannot be run until M4** (step 4 is literally "Connect the references").
- Everything demoable before M4 is a multi-page annotation queue — which, per the competitive scan
  in §9, is **already shipped by at least four products**. Milestones 1–3 produce nothing a
  competitor can't already do today.
- The riskiest assumption in the whole document — *that users will actually author structured
  relationships instead of just typing the relationship into an annotation* — is the last thing you test.

That last point is the one to sit with. If users won't author relationships — if they just type
"make this match the settings card" into a plain annotation and it works fine — then the entire
differentiator collapses and you've built a fourth annotation queue. That's a cheap experiment to
run early and an expensive one to discover in month four.

**Recommendation:** pull a minimal relationship into Milestone 2. One type (`match`), one source, N
targets, a property list, and a free-text exception. Data model plus the simplest possible UI. That
gets the differentiator into the export and the MCP payload early, and lets you learn whether people
use it while the product is still cheap to change.

Push "Refresh pin from source page" and "before/after captures" back to pay for it — both are
polish on a workflow whose core premise you haven't validated yet.

---

## 7. The seven open decisions, answered

**7.1 Side panel or floating shelf?**
**Side panel.** Agrees with your recommendation, and the reasoning is stronger than "simpler": a
globally-registered `chrome.sidePanel` survives tab navigation for free, which *is* the core P0
requirement. A native macOS helper means IPC, code signing, notarization, a separate update channel,
and a second distribution artifact — to solve a problem the side panel already solves. Keep the
floating shelf as the signature follow-up.

**7.2 Snapshots or live previews?**
**Snapshots** — but capture `outerHTML` plus the scoped style set alongside the image. Two payoffs:
"refresh" becomes a diff rather than a blind re-shoot, and the agent can read the element's markup
without spending vision tokens. That second one matters more than it sounds.

**7.3 Plan or implement immediately?**
**Plan first — but it's the agent's plan, not yours.** P1 lists "Generate an implementation plan
before editing," which reads as Pinnables generating the plan. It shouldn't. The agent has the
codebase; Pinnables has the intent. Emit a well-structured brief, let the agent plan against real
files. This deletes a feature from your scope and produces a better plan.

**7.4 Boards by task, feature, or repository?**
Already answered by your own schema — Project owns a repo path, Board belongs to a Project. So:
**Project = repository, Board = review session.** Just commit to it and drop the question.

**7.5 How much computed style?**
`getComputedStyle` returns ~340 properties in Chrome, nearly all resolved defaults. Capturing them
all is enormous and actively harmful to agent context — it buries the ~10 properties that matter.

Use an allowlist of ~30, and **store only values that differ from the element's inherited or initial
value**. Roughly: box model (`display`, `position`, `width`, `height`, `padding*`, `margin*`), typography
(`font-family`, `font-size`, `font-weight`, `line-height`, `letter-spacing`, `text-align`), color
(`color`, `background-color`), border (`border-*`, `border-radius`, `box-shadow`), and layout
(`flex-direction`, `justify-content`, `align-items`, `gap`, `grid-template-*`).

That covers essentially every relationship type in your examples — radius, spacing, border, typography,
layout — at a tiny fraction of the size.

**7.6 Production/staging origins in the first public release?**
**No — and this isn't primarily a product decision.** Declaring broad host permissions materially
increases Chrome Web Store review scrutiny and time-to-listing. Localhost-only is a faster, cleaner
path to being published. Then use `optional_host_permissions` (§3.3) so a user who genuinely needs a
staging origin can grant it themselves without you shipping `<all_urls>`. You get the capability
without the review burden.

**7.7 Is "Pinnables" the final name?**
**Keep it.** This was a live tension when the positioning was "visual brief" — the name described the
inputs while the pitch described the output. Moving the vocabulary to "annotations" / "annotation
board" (§10) resolves it: pins are the items, the board is the surface, Pinnables is the thing that
makes pins. That's now internally consistent. Stop spending cycles here.

---

## 8. Revised MVP acceptance criteria

Rewritten so every line is actually verifiable. Changes marked.

1. Open a localhost React application in Chrome and grant Pinnables access to that origin. *(added: explicit grant)*
2. Pin five elements across at least three routes.
3. All five pins persist across route navigation, tab switches, **and a service-worker restart**. *(added: SW restart — the failure mode that will actually bite)*
4. Add an independent instruction to every pin.
5. Connect two pins with one relationship (`match`, with a property list and an exception).
6. Add one board-level instruction.
7. Mark the board ready, paste the pointer into Cursor or Claude Code, and have the agent retrieve the board through the Pinnables MCP server. *(rewritten per §2.1)*
8. The agent retrieves full context for an individual pin **on demand**, without the board manifest exceeding ~5k tokens. *(added: a number, so "controls context size" is testable)*
9. Return to each captured route from the board, with the original element highlighted **or a clear "element not found" state showing the screenshot**. *(added: the failure path, since it's the common one after edits)*
10. Mark pins resolved after implementation, and see the status reflected in the agent's next `get_board`. *(added: round-trip)*
11. Complete the entire workflow with no network requests to any non-localhost origin — verifiable in DevTools. *(rewritten: "without uploading project data" isn't testable; this is)*

---

## 9. Competitive landscape — the PDR understates this risk

The PDR lists "Crowded annotation market" as a risk to be mitigated by positioning. Based on your own
research pass, it's stronger than that: cross-page annotation batching is not an emerging capability,
it is **shipped, today, by multiple products**.

| Product | What it already does | Overlaps Pinnables at |
|---|---|---|
| **Pointa** | Annotations across routes and pages, batch send to MCP agents; advertises up to 200 annotations per batch | Essentially all of P0 |
| **Vibe Annotations** | Multi-page pins, persistent inspect mode, screenshots, structured context, batch implementation via MCP, agent watch mode | Essentially all of P0 |
| **Design Mode** (designmode.app) | Session-wide change log collapsed into one agent-ready diff; MCP integration exposing changes, screenshots, comments, statuses | P0 + the status workflow |
| **Markagent** | Numbered multi-annotation journeys, structured prompt export | P0 minus MCP |
| **UICuts** | Keeps selected components "picked" across page refreshes, packages them as agent context | Cross-page persistence |
| **PocketUI** | Saves components + screenshots into a searchable visual library, exposes it to agents over MCP | Board + MCP surface |
| **Infa AI** | Tags components across pages and products, design-system usage, FigJam export, links findings back to code | Cross-page component capture |
| **Yoink** | Rich per-element capture — screenshot, HTML, selectors, styles, a11y context — for agents | The pin capture payload |

Read the right-hand column: **effectively all of P0 exists in shipped products.** The element picker,
the cross-page persistence, the screenshots, the structured element context, the batch, the MCP
handoff, even the status round-trip — all of it has a competitor.

The one column nobody fills is the **relationship graph**: one source, N targets, named properties,
explicit exceptions, sent as a single plan rather than N independent tasks.

Two consequences, and they're the most important conclusions in this document:

1. **Milestone 4 is the product.** Milestones 1–3 are table stakes — necessary, but not differentiating.
   Sequencing the only novel thing last means three milestones of work before you learn whether the
   thesis is true. See §6.
2. **Do not claim novelty on cross-page batching.** Pointa advertises exactly that. A launch post
   leading with "annotate across pages and send in one batch" gets a link to Pointa as the first reply.
   Your claim has to be relational or it isn't a claim.

The framing you and Codex already landed on is the right one, and it survives this table:

> Annotation tools collect a list. Pinnables lets you say *how the items relate* — match this to that,
> borrow the spacing but not the content hierarchy — and hands the agent one plan instead of N tasks.

Also worth keeping honest: avoid "the first tool that…" anywhere in the case study. "I couldn't find a
tool that let me compare components from different routes and describe their relationships" is both
safer and, because it's a personal account rather than a market claim, more persuasive.

---

## 10. Terminology: "annotations" over "visual brief"

You've decided against "visual brief" in favor of "annotations." Applying that throughout — with one
caveat that changes how it should be applied.

**The caveat:** "annotations" is precisely the word the PDR's #1 risk tells you to avoid, and §9 shows
why — Vibe Annotations, Pointa, and Markagent already own it. So the fix isn't a global find-and-replace.
It's a split between vocabulary and claim:

| Surface | Use | Why |
|---|---|---|
| **UI verbs and nouns** | Annotate, pin, annotation board, resolve | Familiar, zero learning cost, describes the literal behavior. Codex is right that "visual brief" sounds like a heavier, separate artifact than what this actually is. |
| **Category** (how you're findable) | "Cross-page annotations for AI coding agents" | This is how people search. Being findable in a crowded category beats being unfindable in an invented one. |
| **Claim** (why you exist) | "Annotations that describe *relationships*, not just a list" | This sentence cannot be about annotations alone — that sentence is already true of three shipped products. |

The failure mode to avoid is letting the category sentence become the claim sentence. "Annotate across
pages and batch to your agent" is a category description that reads like a claim, and it's a claim
you'd lose.

A launch hook that holds both:

> Annotation tools give your agent a to-do list. But UI problems are relational — this card should
> match that one, this flow should keep its mobile behavior. So I built cross-page annotations where
> you link the pins, and the agent gets one plan instead of twelve tickets.

**Doc-wide implication:** wherever this review says "brief," read it as "the annotation board payload."
The mechanics in §2.1, §4.1, and §5 are unaffected — the payload is the same object regardless of what
it's called. Only the naming of the user-facing surfaces and the positioning language changes.

---

## 11. Summary of recommended changes

| # | Change | Why |
|---|---|---|
| 1 | Reframe agent handoff as ready-state + clipboard pointer; agent pulls | MCP has no push primitive (§2.1) |
| 2 | Choose `captureVisibleTab` + crop; cap at viewport height for MVP | Only option that satisfies both the permission and speed budgets (§2.2) |
| 3 | Make the dev-time Vite plugin the primary source-mapping path | Fiber introspection can't support a headline metric (§2.3) |
| 4 | Add an explicit opt-in telemetry section, or drop the metrics | Currently contradicts the local-first promise (§2.4) |
| 5 | Treat SW and side panel as stateless views over storage | MV3 terminates both (§3.1, §3.2) |
| 6 | `optional_host_permissions` + per-origin grant | Covers 127.0.0.1 gap, enforces per-origin activation, eases CWS review (§3.3) |
| 7 | Declare shadow DOM / iframes in or out of MVP explicitly | Too common to leave as an unbudgeted edge case (§3.4) |
| 8 | Manual box redaction instead of configurable auto-redaction | Auto-detection gives false confidence on dev data (§3.5) |
| 9 | MCP surface 9 tools → 4; thumbnails in manifest, paths on demand | Tool count degrades selection; token math (§4.1) |
| 10 | Pin status 6 states → 3 | No defined transitions or owners (§4.2) |
| 11 | Add `order`, `groupId`, `schemaVersion`; fix relationship cardinality | Otherwise these are migrations later (§5) |
| 12 | Pull minimal relationships into Milestone 2 | Differentiator and riskiest assumption are currently tested last (§6, §9) |
| 13 | Treat M1–M3 as table stakes, not milestones that produce a demo | All of P0 is shipped by existing competitors (§9) |
| 14 | Split "annotations" (vocabulary, category) from relationships (the claim) | The preferred word is the one the #1 risk warns against (§10) |

---

## 12. What I'd do next

In priority order, and none of these require writing extension code yet:

1. **Resolve §2.1** — redesign the handoff step around ready-state + clipboard pointer. It changes a
   core workflow step and an acceptance criterion, so it should be settled before anything is built.
2. **Resolve §2.3 and §2.4** — the source-mapping path and whether telemetry exists. Both are stated
   as commitments in the PDR that the rest of the document contradicts.
3. **Re-sequence per §6** — move a minimal relationship model into M2. This is the cheapest change on
   the list and it de-risks the most.
4. **Write the relationship schema first**, before the picker. It's the differentiator, it's small,
   and every other data decision (pin ordering, grouping, MCP payload shape) is downstream of it.

Then scaffold Vite + React + TS with the four-tool MCP surface from §4.1.
