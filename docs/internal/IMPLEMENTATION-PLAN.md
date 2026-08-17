# Implementation Plan

Where the build stands, what gets built next, and the user flows the extension has to support.

Companion docs: [PDR.md](PDR.md) · [PDR-REVIEW.md](PDR-REVIEW.md) · [HANDOFF-DESIGN.md](HANDOFF-DESIGN.md)

---

## 1. Where things stand

| Package | State |
|---|---|
| `packages/shared` | **done** — schema, style allowlist, diff computation, storage, markdown rendering |
| `packages/mcp-server` | **done** — 4 tools over stdio, verified against a real MCP client |
| `fixtures/` | **done** — 5 pins, 4 routes, 1 relationship |
| `packages/extension` | not started |
| `packages/service` | not started |
| `packages/vite-plugin` | not started |

The handoff loop is already testable end to end against fixture data. Everything below is about
producing real board data instead of fixtures.

---

## 2. Architecture

```
┌─────────────────────── Chrome ───────────────────────┐
│                                                       │
│  content script (2-tier)          side panel (React)  │
│   ├ listener stub, always on       ├ shelf            │
│   └ picker bundle, lazy            ├ board            │
│       ├ hover highlight            └ relationships    │
│       ├ element capture                    ▲          │
│       ├ floating pin objects               │          │
│       └ toolbar                            │          │
│              ▲                             │          │
│              └──────────┬──────────────────┘          │
│                         │                             │
│                 service worker                        │
│                 (stateless router)                    │
└─────────────────────────┼─────────────────────────────┘
                          │ HTTP, localhost only
                          ▼
              ┌───────────────────────┐
              │  local service (Node) │
              │   board.json          │
              │   screenshots         │
              │   brief.md            │
              └───────────┬───────────┘
                          │ reads same board.json
                          ▼
              ┌───────────────────────┐
              │  MCP server (stdio)   │  ◄── Cursor / Codex / Claude Code
              └───────────────────────┘
```

**Non-negotiable constraints this encodes:**

- The service worker holds **no state**. MV3 terminates it when idle, so every mutation round-trips
  through `chrome.storage` or the local service. The panel and the worker are views, not owners.
- The content script is **two-tier**. A tiny always-resident listener satisfies the 200 ms
  capture-mode budget; the heavy picker loads lazily so "no background capture when inactive" stays
  honest.
- Screenshots never live in `chrome.storage.local` (10 MB cap). Thumbnails go to IndexedDB, full-res
  goes to the local service's disk.
- The local service owns the filesystem because extensions can't write arbitrary paths — and it's
  what lets the MCP server exist at all.

---

## 3. User flows

### Flow A — Activate and capture

```
localhost app open
   → click extension icon
   → Chrome permission prompt for this origin        [chrome.permissions.request]
   → grant
   → toolbar appears, capture mode on                [<200ms, lazy-load picker]
   → hover element, highlight follows pointer
   → click element
       ├ screenshot captured (viewport crop)
       ├ styles extracted (allowlist, non-default only)
       ├ source file read from data-pin-source, or fiber fallback
       └ pin created, floating object appears
   → type annotation in the pin's footer, ⌘↵
   → pin persists
```

**Failure branches:** origin not granted → toolbar never shows, extension icon explains why ·
element inside closed shadow root → "can't pin inside this component" · local service down → buffer
to IndexedDB, sync later.

### Flow B — Cross-page comparison

```
pin exists on /settings
   → navigate to /dashboard
       ├ SPA route change  → content script survives, floating pin persists
       └ full page load    → content script re-injected, pin re-rendered from storage
   → floating pin header still reads "/settings", which is the point
   → pin a second element on /dashboard
   → both pins on screen, from different routes
```

This is the flow the product exists for. Everything else supports it.

### Flow C — Relate two pins

```
two or more pins exist
   → open Board (side panel)
   → drag from pin A's edge anchor to pin B          [edge midpoints reserved for this]
   → relationship created: source A, target B
   → pick properties: radius / spacing / border / typography / …
   → style diff computes immediately and renders     ← the demo moment
       border-radius   4px         → 12px
       padding         32px 24px   → 16px 20px
   → type an exception: "preserve B's content hierarchy"
```

**The riskiest assumption in the product lives here.** If users skip this and type the relationship
into a plain annotation instead, the differentiator is dead. Instrument it: % of boards with ≥1
relationship is the metric that matters most.

### Flow D — Handoff

```
board composed
   → write board-level instruction
   → "Ready for agent"
       ├ local service writes ~/.pinnables/boards/<id>/
       │    board.json · brief.md · pins/pin-NN.{png,json}
       ├ board.status = "ready"
       └ clipboard gets the pointer
   → paste into Cursor / Codex / Claude Code
   → agent calls get_board                            [~525 tokens for 5 pins]
   → agent calls get_pin_context for pins it will edit
   → agent edits source files
```

Note what this flow does **not** contain: a send. MCP cannot push. The button label is
"Ready for agent" and the clipboard pointer is the actual interface between the product and the agent.

### Flow E — Resolve

```
agent finishes a pin
   → set_pin_status(pin, "done" | "blocked", note)
   → board.json updated, board.status recomputed
   → side panel reflects it
   → user clicks pin → returns to its source route
       ├ element found     → highlight it
       └ element not found → show screenshot + "element no longer matches"
   → user marks resolved, or reopens with a new annotation
```

---

## 4. Build sequence

### M1 — Capture

1. **Extension scaffold** — Vite + CRXJS, MV3 manifest, React side panel, TS across the board.
   Manifest permissions: `activeTab`, `storage`, `sidePanel`, `scripting`; `optional_host_permissions`
   for origins. No `<all_urls>`.
2. **Message protocol** — a typed union in `shared` for every content ↔ worker ↔ panel message.
   Define it once, before any of the three surfaces exist, or they drift.
3. **Content script tier 1** — listener stub. Responds to activate, injects tier 2.
4. **Element picker** — hover highlight tracking `elementFromPoint`, click to select, Esc layering
   (annotation → picker → capture mode, never a bare global handler).
5. **Capture pipeline** — `captureVisibleTab` → crop to `getBoundingClientRect` → allowlisted
   `getComputedStyle` → `outerHTML` truncated → `data-pin-source` lookup.
6. **Password redaction** — overlay opaque rects on `input[type=password]` before capture, restore
   after, within one frame.
7. **Storage** — `chrome.storage.local` for pin metadata, IndexedDB for thumbnails.
8. **Local service** — Express or plain `node:http`, localhost-bound, writes screenshots and
   `board.json` under `~/.pinnables`. Reuses `packages/shared` storage functions.
9. **Toolbar** — grip · browse / pin / draw · divider · Board + count · divider · ×. Bottom-center
   default, draggable. Outline icons, accent-tinted active state.
10. **Floating pin object** — header (dot, route, viewport, ×) / screenshot / annotation footer.
    Cursor is `grab`, not `pointer` — it's an image, not live UI.
11. **Side panel shelf** — compact rows, expand to reveal the screenshot. Virtualized.

### M2 — Board, relationships, MCP wiring

12. **Board view** — reorder (fractional index), board-level instruction, delete.
13. **Relationship authoring** — edge-anchor drag, property picker, exception field.
14. **Style diff surfaced in UI** — already computed in `shared`; render it on relationship cards.
15. **`brief.md` writer** — in the local service, using `renderBoardManifest`.
16. **Ready for agent** — materialize + clipboard pointer + status transition.
17. **MCP registration detection** — branch the clipboard string.

### M3 — Loop

18. `set_pin_status` reflected live in the panel · agent notes surfaced on pins · return-to-source
    with element re-finding and the not-found state.

### M4+ — Depth

Responsive and state variants, refresh from source, before/after, drawing tool, scroll-and-stitch,
shadow DOM, additional relationship types. Then the macOS floating shelf.

---

## 5. Decide during M1

Small things that will otherwise get decided by whoever writes the error handler:

- **Element re-finding order.** Selector → DOM path → component name + text → text alone. Return a
  confidence score, and show the not-found state below a threshold rather than highlighting the
  wrong element.
- **Service-down behavior.** Buffer to IndexedDB and sync, or fail loudly? Buffering is friendlier
  but risks silent divergence between extension state and disk.
- **Multiple tabs on the same origin.** Two tabs, one board — does the floating pin appear in both?
  Probably yes, but the storage listener has to be per-tab aware.
- **Board switching mid-session.** If a user switches boards while pins float on the page, the
  floating objects have to swap. Cheapest answer: floating pins belong to the active board only.
